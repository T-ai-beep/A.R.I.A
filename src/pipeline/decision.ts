/**
 * decision.ts — ARIA decision pipeline (refactored)
 *
 * Architecture: coach is the single decision authority for negotiation.
 *
 * Flow:
 *   transcript
 *     → remember()              — memory update + intent/offer extraction
 *     → classifyEvent()         — single source of truth for event type
 *     → steer()                 — trajectory prediction (feeds coach context)
 *     → processSideEffects()    — tasks, follow-ups, people, episodic (async)
 *     → [negotiation] CoachSession.process(transcript, ctx)
 *         if response           → speak + log + return
 *         if wait + forced      → getForcedFallback()
 *         if wait + high-impact → matchEmbedding() → llmFallback()
 *         if wait + low-impact  → steering.preloadMessage → null
 *     → [other modes] matchRule() → llmFallback()
 */

import { CONFIG } from '../config.js'
import { matchEmbedding } from './embeddings.js'
import { matchRule } from './rules.js'
import { remember, getContext } from './memory.js'
import { extractTaskFromTranscript, addTask, getTaskContext } from './tasks.js'
import { updatePeopleFromTranscript, getPeopleContext } from './people.js'
import { detectFollowUp, createFollowUp, getFollowUpContext } from './followup.js'
import { logDecision, getPatternContext } from './decisionLog.js'
import { recordSuccess, recordIgnored } from './adaptiveWeights.js'
import { steer, getTrajectoryContext } from './steering.js'
import { storeEpisode, getEpisodicContext } from '../pipeline/epsodic.js'
import { getIdentityContext, getHighImportancePeople } from './identityScore.js'
import { createPressureItem } from './pressure.js'
import { FORCED_RESPONSE_EVENTS, getForcedFallback } from './playbook.js'
import { speak } from './tts.js'
import { getCoachSession, CoachContext } from './negotiationCoach.js'

export type Mode = 'negotiation' | 'meeting' | 'interview' | 'social'

export type EventType =
  | 'PRICE_OBJECTION'
  | 'STALLING'
  | 'AUTHORITY'
  | 'COMPETITOR'
  | 'AGREEMENT'
  | 'QUESTION'
  | 'OFFER_DISCUSS'
  | 'DEADLINE'
  | 'UNKNOWN'

let currentMode: Mode = 'negotiation'

// ── Dedup guard ───────────────────────────────────────────────────────────
let lastSpoken: string | null = null

export function setMode(mode: Mode): void {
  currentMode = mode
  console.log(`[MODE] ${mode}`)
}

export function getMode(): Mode {
  return currentMode
}

// ── Event classification — compiled regexes (module-level, allocated once) ──

const RE_PRICE_OBJECTION = [
  /can't afford|too expensive|too much|no budget|price is|can't spend/i,
  /fifteen hundred.*too|upfront.*too|valuation.*high|switching cost/i,
  /that is a lot\b|that's a lot\b|a lot for.*company|a lot for.*(size|operation)/i,
  /was not expecting that number|sticker shock|feels like a stretch/i,
  /not sure.*get that value|not sure.*would get.*value/i,
  /fifteen hundred bucks is a lot|lot for us man|feels like too much/i,
]
const RE_AUTHORITY = [
  /check with|my team|my boss|need approval|not my call|run it by/i,
  /my wife|my husband|my business partner|she handles|he handles/i,
  /partner.*weigh in|our team would need to align|team.*align on/i,
]
const RE_COMPETITOR = [
  /already use|currently use|we have|service.?titan|jobber|housecall/i,
  /competitor|went with|signed with|chose.*instead/i,
  /signed the paperwork with them|already signed with/i,
  /happy with.*current/i,
]
const RE_AGREEMENT = [
  /sounds good|we're in|let's do it|i'll take it|deal|move forward/i,
  /i'm in\b|when do we start|ready to sign|close this week/i,
  /could really work for us|this could really work/i,
  /yeah.*i am in|alright.*let's.*do this/i,
]
const RE_STALLING = [
  /need to think|get back|not sure|maybe|not ready/i,
  /circle back|be in touch|will be in touch/i,
  /sounds interesting.*we will|this is interesting.*we will/i,
]
const RE_QUESTION    = /\?$/
const RE_OFFER       = /\$|per month|a year|annually|pricing|cost|budget|range of|salary|compensation/i
const RE_DEADLINE    = /deadline|by friday|by monday|end of week|next week|asap/i

// ── Event classification — single source of truth ─────────────────────────
// Runs once per transcript. Result feeds coach, memory context, and LLM.

export function classifyEvent(transcript: string): EventType {
  // Strip non-ASCII (emoji, CJK, etc.) and collapse runs of spaces so
  // "can't 💸 afford" normalizes to "can't afford" before regex matching
  const t = transcript.slice(0, CONFIG.MAX_TRANSCRIPT_CHARS)
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()

  if (RE_PRICE_OBJECTION.some(r => r.test(t))) return 'PRICE_OBJECTION'
  if (RE_AUTHORITY.some(r => r.test(t)))        return 'AUTHORITY'
  if (RE_COMPETITOR.some(r => r.test(t)))       return 'COMPETITOR'
  if (RE_AGREEMENT.some(r => r.test(t)))        return 'AGREEMENT'
  if (RE_STALLING.some(r => r.test(t)))         return 'STALLING'
  if (RE_QUESTION.test(t.trim()))               return 'QUESTION'
  if (RE_OFFER.test(t))                         return 'OFFER_DISCUSS'
  if (RE_DEADLINE.test(t))                      return 'DEADLINE'

  return 'UNKNOWN'
}

const HIGH_IMPACT: EventType[] = [
  'PRICE_OBJECTION', 'AUTHORITY', 'COMPETITOR', 'AGREEMENT', 'QUESTION', 'OFFER_DISCUSS',
]

function isHighImpact(event: EventType): boolean {
  return HIGH_IMPACT.includes(event)
}

// ── Dedup helper ──────────────────────────────────────────────────────────

function speakDeduped(message: string): void {
  if (message === lastSpoken) {
    console.log(`[DEDUP] suppressed — "${message}"`)
    return
  }
  lastSpoken = message
  speak(message)
}

// ── Side effects (async, non-blocking) ────────────────────────────────────

function processSideEffects(
  transcript: string,
  intent: string | null,
  offer: number | null,
  person: string | null
): void {
  setImmediate(() => {
    updatePeopleFromTranscript(transcript, intent, offer)

    const fuDetected = detectFollowUp(transcript)
    if (fuDetected) {
      const pCtx = getPeopleContext(transcript)
      createFollowUp(transcript, fuDetected, pCtx ?? undefined)
        .then(fu => {
          createPressureItem(
            fu.id, 'followup', fu.suggestedAction,
            fu.person, fu.priority, fuDetected.delayHours * 3600_000
          )
        })
        .catch(console.error)
    }

    const taskData = extractTaskFromTranscript(transcript)
    if (taskData) {
      const task = addTask(taskData)
      createPressureItem(
        task.id, 'task', task.description,
        task.person, task.priority,
        (task.resurfaceAt ?? Date.now() + 3_600_000) - Date.now()
      )
    }

    storeEpisode(transcript, person).catch(console.error)
  })
}

// ── LLM fallback — last resort only ──────────────────────────────────────
// Called when coach is waiting on a high-impact event and embedding missed.
// Includes full context: tasks, follow-ups, patterns.

const TIGHT_PROMPT = `You are ARIA, a real-time decision coach in an earpiece.
Output ONE line only: ACTION — phrase
ACTION must be one of: Reject Accept Ask Push Wait Challenge Clarify Delay Anchor Exit
phrase is 2–3 words MAX. Total output: 4–6 words.
Examples: "Anchor — hold the number" / "Ask — what changed" / "Push — close now"
If nothing actionable: PASS
No punctuation. No explanation. No quotes.`

async function llmFallback(
  transcript: string,
  event: EventType,
  deadline: number
): Promise<string | null> {
  const remaining = deadline - Date.now()
  if (remaining <= 50) {
    console.log('[LLM] skipped — latency budget exhausted')
    return null
  }

  const ctx = getContext()
  const contextLine = ctx.lastOffer
    ? `Last offer: $${ctx.lastOffer}. Last intent: ${ctx.lastIntent}.`
    : ''

  // Full context passed to LLM — tasks, follow-ups, patterns
  const taskCtx     = getTaskContext()
  const followUpCtx = getFollowUpContext()
  const patternCtx  = getPatternContext()
  const extraCtx    = [taskCtx, followUpCtx, patternCtx].filter(Boolean).join('\n')

  const t0 = Date.now()

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        keep_alive: '10m',
        messages: [
          { role: 'system', content: TIGHT_PROMPT },
          {
            role: 'user',
            content: `Event: ${event}\n${contextLine}${extraCtx ? '\n' + extraCtx : ''}\nTranscript: "${transcript}"`,
          },
        ],
        stream: true,
      }),
      signal: AbortSignal.timeout(remaining),
    })

    if (!res.body) return null

    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    const CHUNK_WORDS = 3

    let wordBuffer = ''
    let fullOutput = ''
    let firstSpeak = true
    let firstToken = true

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      const raw = decoder.decode(value, { stream: true })

      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let parsed: { message?: { content?: string }; done?: boolean }
        try { parsed = JSON.parse(trimmed) } catch { continue }
        if (parsed.done) break

        const token = parsed.message?.content ?? ''
        if (!token) continue

        if (firstToken) {
          console.log(`[LLM] first token @ ${Date.now() - t0}ms`)
          firstToken = false
        }

        wordBuffer += token
        fullOutput += token

        const words = wordBuffer.trim().split(/\s+/).filter(Boolean)
        if (words.length >= CHUNK_WORDS) {
          const chunk = wordBuffer.trim()
          if (chunk && chunk.toUpperCase() !== 'PASS') {
            if (firstSpeak) {
              console.log(`[LLM] first speak @ ${Date.now() - t0}ms`)
              firstSpeak = false
            }
            speakDeduped(chunk)
          }
          wordBuffer = ''
        }
      }
    }

    const tail = wordBuffer.trim()
    if (tail && tail.toUpperCase() !== 'PASS' && tail.length > 1) {
      speakDeduped(tail)
    }

    const result = fullOutput.trim().replace(/['"`.]/g, '').trim()
    console.log(`[LLM] total=${Date.now() - t0}ms — "${result}"`)

    if (!result || result.toUpperCase() === 'PASS') return null

    const actions = ['Reject','Accept','Ask','Push','Wait','Challenge','Clarify','Delay','Anchor','Exit']
    if (!actions.some(a => result.startsWith(a))) return null

    return result.split(/\s+/).slice(0, 6).join(' ')

  } catch {
    console.log('[LLM] timeout or error')
    return null
  }
}

// ── Non-negotiation modes — rules as authority ────────────────────────────

async function decideNonNegotiation(
  transcript: string,
  event: EventType,
  deadline: number,
  modeAtCall: Mode,
  person: string | null,
  offer: number | null
): Promise<string | null> {
  const ruleHit = matchRule(transcript, modeAtCall)
  if (ruleHit) {
    console.log(`[RULE/${modeAtCall}] "${ruleHit}"`)
    logDecision(transcript, event, ruleHit, 'rule', modeAtCall, person, offer)
    speakDeduped(ruleHit)
    return ruleHit
  }

  if (isHighImpact(event) && Date.now() < deadline - 200) {
    const llmResult = await llmFallback(transcript, event, deadline)
    if (llmResult) {
      logDecision(transcript, event, llmResult, 'llm', modeAtCall, person, offer)
      return llmResult
    }
  }

  return null
}

// ── decide() — single entry point ─────────────────────────────────────────
// Serialized via a lock: concurrent calls queue up rather than corrupting the
// stateful CoachSession singleton. In production speech is serial anyway.

let _decideLock: Promise<void> = Promise.resolve()

export function decide(transcript: string): Promise<string | null> {
  const waitFor = _decideLock
  let release!: () => void
  _decideLock = new Promise<void>(r => { release = r })
  return waitFor
    .then(() => _decideImpl(transcript))
    .finally(() => release())
}

async function _decideImpl(transcript: string): Promise<string | null> {
  if (!transcript || !transcript.trim()) return null

  const t0         = Date.now()
  const deadline   = t0 + CONFIG.LATENCY_BUDGET_MS
  const modeAtCall = currentMode

  // ── 1. Memory update ──────────────────────────────────────────────────
  const turn = remember(transcript)
  const ctx  = getContext()

  // ── 2. Event classification — single source of truth ─────────────────
  const event = classifyEvent(transcript)
  console.log(`[EVENT] ${event} [MODE] ${modeAtCall}`)

  // ── 3. Person extraction for side effects ─────────────────────────────
  const person = transcript.match(/([A-Z][a-z]{1,14})/)?.[1] ?? null

  // ── 4. Side effects (non-blocking) ────────────────────────────────────
  processSideEffects(transcript, turn.intent, turn.offer, person)

  // ── 5. Trajectory prediction ──────────────────────────────────────────
  const steering = await steer(transcript, false)

  // ── 6. Non-negotiation modes ──────────────────────────────────────────
  if (modeAtCall !== 'negotiation') {
    return decideNonNegotiation(transcript, event, deadline, modeAtCall, person, turn.offer)
  }

  // ── 7. Build coach context ────────────────────────────────────────────
  const coachCtx: CoachContext = {
    event:      event,
    lastIntent: ctx.lastIntent,
    lastOffer:  ctx.lastOffer,
    trajectory: steering.predictedIntent ?? null,
  }

  // ── 8. Coach — single decision authority (negotiation) ────────────────
  const coachTurn = getCoachSession().process(transcript, coachCtx)

  console.log(
    `[COACH] L${coachTurn.level}/${coachTurn.levelName}` +
    ` type=${coachTurn.objectionType}` +
    ` wait=${coachTurn.wait}` +
    ` escalated=${coachTurn.escalated}` +
    `${coachTurn.reclassified ? ' [RECLASSIFIED]' : ''}` +
    ` — "${coachTurn.response ?? 'SILENCE'}"`
  )

  // ── 9. Coach has a response — done ───────────────────────────────────
  if (!coachTurn.wait && coachTurn.response) {
    const totalMs = Date.now() - t0
    console.log(`[DECIDE] ${totalMs}ms — "${coachTurn.response}"`)

    const highImportance = getHighImportancePeople(transcript)
    if (highImportance.length) {
      console.log(`[IDENTITY] ${highImportance[0].urgencyLabel}`)
    }

    logDecision(transcript, event, coachTurn.response, 'rule', modeAtCall, person, turn.offer)
    speakDeduped(coachTurn.response)
    return coachTurn.response
  }

  // ── 10. Coach is waiting — fallback chain ─────────────────────────────

  // 10a. Forced events never go silent
  if (FORCED_RESPONSE_EVENTS.has(event)) {
    const fallback = getForcedFallback(event)
    if (fallback) {
      console.log(`[FORCED] ${event} — coach silent, firing fallback`)
      logDecision(transcript, event, fallback, 'rule', modeAtCall, person, turn.offer)
      speakDeduped(fallback)
      return fallback
    }
  }

  // 10b. Embedding — second-chance before LLM
  if (Date.now() < deadline - 10) {
    const embedMatch = await Promise.race([
      matchEmbedding(transcript),
      new Promise<null>(r => setTimeout(() => r(null), 150)),
    ])
    if (embedMatch) {
      console.log(`[EMBED] ${Date.now() - t0}ms — "${embedMatch.action}" @ ${embedMatch.score.toFixed(3)}`)
      logDecision(transcript, event, embedMatch.action, 'embedding', modeAtCall, person, turn.offer)
      speakDeduped(embedMatch.action)
      return embedMatch.action
    }
  }

  // 10c. LLM — last resort for high-impact events
  if (isHighImpact(event) && Date.now() < deadline - 200) {
    const llmResult = await llmFallback(transcript, event, deadline)
    if (llmResult) {
      logDecision(transcript, event, llmResult, 'llm', modeAtCall, person, turn.offer)
      return llmResult
    }
  }

  // 10d. Steering preload — low-impact events with a predicted trajectory
  if (!isHighImpact(event) && steering.preloadMessage) {
    console.log(`[STEER] preload — "${steering.preloadMessage}"`)
    logDecision(transcript, event, steering.preloadMessage, 'rule', modeAtCall, person, turn.offer)
    speakDeduped(steering.preloadMessage)
    return steering.preloadMessage
  }

  console.log(`[PASS] ${Date.now() - t0}ms`)
  return null
}

// ── Outcome reporting ─────────────────────────────────────────────────────

export function reportOutcome(message: string, outcome: 'success' | 'ignored' | 'lost'): void {
  if (outcome === 'success') recordSuccess(message)
  else recordIgnored(message)
}

// ── Re-exports for index.ts ───────────────────────────────────────────────

export {
  getTaskContext,
  getPeopleContext,
  getFollowUpContext,
  getPatternContext,
  getTrajectoryContext,
  getEpisodicContext,
  getIdentityContext,
}