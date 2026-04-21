/**
 * index.ts — ARIA streaming pipeline (updated)
 *
 * Changes from previous version:
 *   1. VAD now emits { audio, speaker, confidence } on speechEnd
 *   2. Pipeline skips if speaker === 'self' (already filtered in VAD, but double-checked here)
 *   3. Session manager is updated with transcript + intent + offer on each turn
 *   4. Session context injected into ariaRespond prompt
 *   5. 'selfSpeech' event handled (HUD indicator only, no pipeline)
 *   6. Session auto-closes on SIGINT with summary logged
 *   7. setMode() also updates session manager mode
 */

const ACTIVE_MODE_TIMEOUT_MS = 12_000
const PRESSURE_POLL_MS       = 30_000
const MAX_SPOKEN_WORDS       = 12

function enforceOutput(text: string): string {
  const words = text.trim().split(/\s+/)
  return words.length > MAX_SPOKEN_WORDS ? words.slice(0, MAX_SPOKEN_WORDS).join(' ') : text.trim()
}

type ARSignal = 'RED' | 'YELLOW' | 'GREEN'
function emitARSignal(signal: ARSignal, reason: string) {
  console.log(`[AR] ${signal} — ${reason}`)
}
function urgencyToARSignal(urgency: string): ARSignal {
  if (urgency === 'CRITICAL' || urgency === 'FORCED' || urgency === 'HIGH') return 'RED'
  if (urgency === 'MEDIUM') return 'YELLOW'
  return 'GREEN'
}

async function init() {
  const { CONFIG }            = await import('./config.js')
  const { transcribe }        = await import('./audio/whisper.js')
  const { decide, setMode, getTaskContext, getPeopleContext, getFollowUpContext, getTrajectoryContext, getEpisodicContext, getIdentityContext }
                              = await import('./pipeline/decision.js')
  const { AXONCore }          = await import('./agents/AXONCore.js')
  const { Coordinator }       = await import('./agents/Coordinator.js')
  const { ConversationAgent } = await import('./agents/ConversationAgent.js')
  const { TaskAgent }         = await import('./agents/TaskAgent.js')
  const { ResearchAgent }     = await import('./agents/ResearchAgent.js')
  type AxonInput              = import('./agents/types.js').Input
  const { warmupEmbeddings }  = await import('./pipeline/embeddings.js')
  const { speak }             = await import('./pipeline/tts.js')
  const { clearMemory, getContext, getLastTurn } = await import('./pipeline/memory.js')
  const { loadKnowledgeBase, ragQuery, saveToHistory } = await import('./pipeline/rag.js')
  const { getDueItems, getForcedItems, fireItem } = await import('./pipeline/pressure.js')
  const { pruneOldPlays } = await import('./pipeline/playbook.js')
  const { getSessionManager } = await import('./pipeline/session.js')
  type SessionSummary = import('./pipeline/session.js').SessionSummary
  const { VAD } = await import('./audio/vad.js')

  type Mode = 'negotiation' | 'meeting' | 'interview' | 'social'

  const modeArg = process.argv.find(a => a.startsWith('--mode='))
  const mode    = (modeArg?.split('=')[1] ?? 'negotiation') as Mode

  const sessionMgr = getSessionManager()
  sessionMgr.setMode(mode)

  setMode(mode)

  // ── ariaRespond: streaming LLM → TTS ─────────────────────────────────────

  async function ariaRespond(transcript: string): Promise<string> {
    const ctx = getContext()
    const memLine = ctx.lastOffer
      ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
      : ctx.lastIntent ? `Last intent: ${ctx.lastIntent}.` : ''

    const [ragContext, episodic] = await Promise.all([
      ragQuery(transcript, { useWeb: true, useHistory: true, useKB: true }),
      getEpisodicContext(transcript),
    ])
    const ragLine      = ragContext ? `\n\nContext:\n${ragContext}` : ''
    const sessionCtx   = sessionMgr.getSessionContext()
    const leverageLine = [
      getTaskContext(), getFollowUpContext(), getPeopleContext(transcript),
      getTrajectoryContext(), episodic,
      getIdentityContext(transcript), sessionCtx,
    ].filter(Boolean).join('\n\n')

    const systemPrompt = `You are ARIA, a real-time personal AI in an earpiece.
Max ${MAX_SPOKEN_WORDS} words. Format: ACTION — phrase. Example: "Wait — unclear intent"
Use ONLY context provided. If not in context say "not in context".
${memLine}${ragLine}${leverageLine ? '\n\n' + leverageLine : ''}`

    let fullResponse = ''
    let buffer       = ''
    let firstToken   = true
    const t0         = Date.now()

    try {
      const res = await fetch(CONFIG.OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: transcript },
          ],
          stream: true,
        }),
        signal: AbortSignal.timeout(CONFIG.OLLAMA_STREAM_TIMEOUT_MS),
      })

      if (!res.body) throw new Error('no body')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let parsed: { message?: { content?: string }; done?: boolean }
          try { parsed = JSON.parse(trimmed) } catch { continue }
          if (parsed.done) break

          const token = parsed.message?.content ?? ''
          if (!token) continue

          if (firstToken) {
            console.log(`[ARIA] first token @ ${Date.now() - t0}ms`)
            firstToken = false
          }

          buffer       += token
          fullResponse += token

          const wordCount = buffer.trim().split(/\s+/).filter(Boolean).length
          if (wordCount >= 3) {
            const clean = enforceOutput(buffer.trim())
            if (clean) speak(clean)
            buffer = ''
          }
        }
      }

      const tail = enforceOutput(buffer.trim())
      if (tail) speak(tail)

    } catch (e) {
      console.error('[ARIA] stream error', e)
      if (fullResponse.trim()) speak(enforceOutput(fullResponse.trim()))
    }

    const raw = enforceOutput(fullResponse.trim())
    saveToHistory({ ts: Date.now(), transcript, intent: getContext().lastIntent, response: raw })
    console.log(`[ARIA] "${raw}" total=${Date.now() - t0}ms`)
    return raw
  }

  // ── Pressure poll ─────────────────────────────────────────────────────────
  function startPressureLoop(speakFn: (t: string) => void, isActive: () => boolean): NodeJS.Timeout {
    return setInterval(() => {
      if (isActive()) return

      const forced = getForcedItems()
      if (forced.length > 0) {
        const result = fireItem(forced[0].id)
        if (result) { emitARSignal('RED', result.message); speakFn(enforceOutput(result.message)) }
        return
      }

      const due = getDueItems(false)
      if (!due.length) return
      const result = fireItem(due[0].id)
      if (result) { emitARSignal(urgencyToARSignal(result.state), result.message); speakFn(enforceOutput(result.message)) }
    }, PRESSURE_POLL_MS)
  }

  // ── Startup maintenance ───────────────────────────────────────────────────
  pruneOldPlays(CONFIG.PLAYS_RETENTION_DAYS)

  // ── Warmup (parallel) ────────────────────────────────────────────────────
  console.log('[INIT] warming up whisper, embeddings, and knowledge base in parallel...')
  await Promise.all([
    transcribe(Buffer.alloc(CONFIG.SAMPLE_RATE * 2)),
    warmupEmbeddings(),
    loadKnowledgeBase(),
  ])
  console.log('[INIT] all systems ready')

  // ── Agent orchestration setup ─────────────────────────────────────────────
  // All execution flows: AXONCore → Coordinator → ExecutionAgent → tool
  const axon = AXONCore.getInstance()
  axon.registerAgent(new ResearchAgent())
  axon.registerAgent(new TaskAgent())
  axon.registerAgent(Coordinator.getInstance())
  axon.registerAgent(new ConversationAgent())

  speak('online')

  const vad = new VAD()

  let processingChunk = false
  let ariaActive      = false
  let activeTimeout:  ReturnType<typeof setTimeout> | null = null

  function activateAria() {
    ariaActive = true
    if (activeTimeout) clearTimeout(activeTimeout)
    activeTimeout = setTimeout(() => {
      ariaActive = false
      console.log('[MODE] passive — timeout')
    }, ACTIVE_MODE_TIMEOUT_MS)
    console.log('[MODE] active')
    speak('yes')
  }

  function deactivateAria() {
    ariaActive = false
    if (activeTimeout) clearTimeout(activeTimeout)
    console.log('[MODE] passive')
  }

  const isActive = () => ariaActive || processingChunk

  const pressureTimer = startPressureLoop(speak, isActive)

  // ── Audio processing ───────────────────────────────────────────────────────

  async function processAudio(audio: Buffer, label: string, speaker: 'self' | 'other' | 'unknown' = 'other') {
    // Double-check: never process self-speech through the decision pipeline
    if (speaker === 'self' && !ariaActive) {
      console.log(`[SKIP] ${label} — self speech`)
      return
    }

    if (processingChunk) {
      console.log(`[SKIP] ${label} — already processing`)
      return
    }

    processingChunk = true

    try {
      const transcript = await transcribe(audio)
      if (!transcript) return

      if (/^\[.*\]$/.test(transcript.trim())) {
        console.log(`[SKIP] ${label} — noise token "${transcript}"`)
        return
      }

      console.log(`[${label}] speaker=${speaker} — "${transcript}"`)
      saveToHistory({ ts: Date.now(), transcript, intent: null, response: null })

      // Update session manager with the real transcript + intent
      const memCtx = getContext()
      sessionMgr.onSpeech(transcript, speaker, memCtx.lastIntent, memCtx.lastOffer)

      // Handle re-enroll voice command
      if (/re.?enroll (my )?voice|reset voice|new voice/i.test(transcript)) {
        await vad.reenrollVoice()
        speak('re-enrolling your voice now, please speak for a few seconds')
        return
      }

      // Active mode: ARIA answers directly
      if (ariaActive) {
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      // Passive mode: route through AXONCore
      const axonInput: AxonInput = {
        id:      `inp_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        source:  'transcript',
        text:    transcript,
        ts:      Date.now(),
        speaker,
      }

      const result = await AXONCore.getInstance().route(axonInput)

      // ConversationAgent: decide() already called speak() internally — do NOT re-speak
      // All other agents: speak their output if present
      if (result.output && result.agentId !== 'conversation') {
        const enforced = enforceOutput(result.output)
        if (enforced) {
          speak(enforced)
          emitARSignal('RED', enforced)
          saveToHistory({ ts: Date.now(), transcript, intent: null, response: enforced })
        }
      }

      // Preserve ARIA_QUERY sentinel from ConversationAgent
      if (result.output === 'ARIA_QUERY') {
        activateAria()
        await ariaRespond(transcript)
        deactivateAria()
        return
      }

      // Preserve QUESTION fallback for null decisions from ConversationAgent
      if (!result.output && result.agentId === 'conversation') {
        const last = getLastTurn()
        if (last?.intent === 'QUESTION') {
          console.log('[QUESTION] routing to ariaRespond')
          await ariaRespond(transcript)
        }
      }

    } catch (err) {
      console.error(`[ERROR] ${label}`, err)
    } finally {
      processingChunk = false
    }
  }

  // ── VAD event handlers ─────────────────────────────────────────────────────

  function normalizeSpeaker(s: string | undefined): 'self' | 'other' | 'unknown' {
    if (s === 'self') return 'self'
    if (s === 'other') return 'other'
    return 'unknown'
  }

  vad.on('speechStart', () => console.log('\n[VAD] ▶ speech start'))
  vad.on('misfire',     () => console.log('[VAD] ✗ misfire'))

  vad.on('selfSpeech', ({ speechMs }: { audio: Buffer; speechMs: number }) => {
    // Self-speech: just log / HUD indicator. No pipeline.
    console.log(`[VAD] 🎤 self (${speechMs}ms)`)
    // Emit AR signal so HUD shows mic icon
    emitARSignal('GREEN', 'self speaking')
  })

  vad.on('snapDetected', () => ariaActive ? deactivateAria() : activateAria())

  vad.on('speechChunk', async ({ audio, speaker }: { audio: Buffer; speaker: string }) => {
    const sp = normalizeSpeaker(speaker)
    if (!processingChunk && sp !== 'self') {
      processAudio(audio, 'CHUNK', sp)
    }
  })

  vad.on('speechEnd', async ({ audio, speaker, confidence }: { audio: Buffer; speaker: string; confidence: number }) => {
    const ms = (audio.length / 2 / CONFIG.SAMPLE_RATE * 1000).toFixed(0)
    console.log(`[VAD] ■ speech end — ${ms}ms speaker=${speaker} conf=${confidence.toFixed(2)}`)
    processAudio(audio, 'END', normalizeSpeaker(speaker))
  })

  vad.on('error', (err: Error) => {
    console.error('[VAD ERROR]', err)
    process.exit(1)
  })

  // ── Session events ─────────────────────────────────────────────────────────

  sessionMgr.on('sessionStart', ({ sessionId }: { sessionId: string; ts: number }) => {
    console.log(`\n[SESSION] ▶ new conversation — ${sessionId}`)
    emitARSignal('GREEN', `session started`)
  })

  sessionMgr.on('sessionEnd', (summary: SessionSummary) => {
    console.log(`\n[SESSION] ■ conversation ended`)
    console.log(`  Duration: ${Math.round(summary.durationMs / 1000)}s`)
    console.log(`  Outcome:  ${summary.outcome}`)
    console.log(`  Summary:  ${summary.summary}`)
    if (summary.nextStep) console.log(`  Next:     ${summary.nextStep}`)
    if (summary.lastOffer) console.log(`  Offer:    $${summary.lastOffer}`)
  })

  vad.start()
  console.log(`\nARIA online — mode: ${mode} — double snap to activate\n`)
  console.log(`Diarizer status: ${(await vad.getDiarizerStatus())?.enrolled ? 'enrolled' : 'will auto-enroll on first speech'}\n`)

  process.on('SIGINT', async () => {
    console.log('\nshutting down...')
    clearInterval(pressureTimer)
    vad.stop()

    // Close session and save summary
    const summary = await sessionMgr.closeSession()
    if (summary) {
      console.log(`[SESSION] final summary saved — ${summary.outcome}`)
    }

    clearMemory()
    process.exit(0)
  })
}

init()