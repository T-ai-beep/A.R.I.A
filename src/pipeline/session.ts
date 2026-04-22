/**
 * session.ts — Conversation session boundaries for ARIA
 *
 * Tracks explicit conversation sessions so episodic memory stores
 * "the TTC call with Marcus on April 18" as one coherent unit,
 * not a blob of TTL-expiring turns.
 *
 * Session lifecycle:
 *   IDLE → ACTIVE (first speech detected)
 *   ACTIVE → CLOSING (silence > SESSION_END_SILENCE_MS)
 *   CLOSING → IDLE (summary generated, episode stored)
 *
 * On session close:
 *   - Auto-generates a structured summary via Ollama
 *   - Stores as EpisodicEvent with rich metadata
 *   - Resets working memory (clearMemory)
 *   - Emits 'sessionEnd' event with summary for HUD display
 *
 * Session boundary heuristic:
 *   - Silence > 2 minutes = new session
 *   - Explicit close via endSession() (e.g. SIGINT, mode change)
 *   - VAD reports speech after SESSION_END_SILENCE_MS of nothing = new session
 */

import { EventEmitter } from 'events'
import { CONFIG } from '../config.js'
import { clearMemory, getContext, getRecentTranscripts } from './memory.js'
import { storeEpisode } from './epsodic.js'
import { saveToHistory } from './rag.js'

// ── Config (sourced from central CONFIG) ────────────────────────────────────

const SESSION_END_SILENCE_MS = CONFIG.SESSION_END_SILENCE_MS
const MIN_SESSION_TURNS      = CONFIG.MIN_SESSION_TURNS
const MAX_SUMMARY_CHARS      = CONFIG.MAX_SUMMARY_CHARS

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionState = 'idle' | 'active' | 'closing'

export interface SessionTurn {
  ts:         number
  transcript: string
  speaker:    'self' | 'other' | 'unknown'
  intent:     string | null
  offer:      number | null
}

export interface SessionSummary {
  sessionId:    string
  startTs:      number
  endTs:        number
  durationMs:   number
  turnCount:    number
  people:       string[]
  topIntent:    string | null
  lastOffer:    number | null
  outcome:      string
  summary:      string           // 3-5 sentence narrative
  nextStep:     string | null    // extracted next action
  mode:         string
}

// ── Session manager ──────────────────────────────────────────────────────────

export class SessionManager extends EventEmitter {
  private state:          SessionState = 'idle'
  private sessionId:      string       = ''
  private startTs:        number       = 0
  private lastSpeechTs:   number       = 0
  private turns:          SessionTurn[] = []
  private silenceTimer:   NodeJS.Timeout | null = null
  private mode:           string       = 'negotiation'

  // ── Start / update ──────────────────────────────────────────────────────

  onSpeech(transcript: string, speaker: 'self' | 'other' | 'unknown', intent: string | null, offer: number | null): void {
    const now = Date.now()

    if (this.state === 'idle') {
      this.startSession(now)
    }

    // New speech resets the silence timer
    this.resetSilenceTimer()
    this.lastSpeechTs = now

    this.turns.push({ ts: now, transcript, speaker, intent, offer })

    console.log(`[SESSION] ${this.sessionId} turn=${this.turns.length} speaker=${speaker} intent=${intent ?? 'none'}`)
  }

  setMode(mode: string): void {
    this.mode = mode
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  private startSession(ts: number): void {
    this.state     = 'active'
    this.sessionId = `sess_${ts}_${Math.random().toString(36).slice(2, 5)}`
    this.startTs   = ts
    this.turns     = []
    console.log(`[SESSION] started — ${this.sessionId}`)
    this.emit('sessionStart', { sessionId: this.sessionId, ts })
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      if (this.state === 'active') {
        console.log(`[SESSION] silence threshold reached — closing ${this.sessionId}`)
        this.closeSession()
      }
    }, SESSION_END_SILENCE_MS)
  }

  async closeSession(): Promise<SessionSummary | null> {
    if (this.state !== 'active') return null
    if (this.turns.length < MIN_SESSION_TURNS) {
      console.log(`[SESSION] too short to summarize (${this.turns.length} turns)`)
      this.resetState()
      return null
    }

    this.state = 'closing'
    if (this.silenceTimer) clearTimeout(this.silenceTimer)

    const summary = await this.buildSummary()
    if (summary) {
      await this.persistSummary(summary)
      this.emit('sessionEnd', summary)
      console.log(`[SESSION] closed — ${summary.durationMs}ms, ${summary.turnCount} turns, outcome: ${summary.outcome}`)
    }

    this.resetState()
    clearMemory()
    return summary
  }

  private resetState(): void {
    this.state      = 'idle'
    this.sessionId  = ''
    this.startTs    = 0
    this.turns      = []
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = null
  }

  // ── Summary generation ──────────────────────────────────────────────────

  private async buildSummary(): Promise<SessionSummary | null> {
    const ctx       = getContext()
    const endTs     = Date.now()
    const durationMs = endTs - this.startTs

    // Extract people from turns
    const people = [...new Set(
      this.turns
        .map(t => t.transcript.match(/([A-Z][a-z]{2,14})/g) ?? [])
        .flat()
        .filter(n => !['ARIA', 'The', 'This', 'That', 'Monday', 'Tuesday'].includes(n))
    )].slice(0, 5)

    // Top intent = most frequent non-null intent
    const intentCounts: Record<string, number> = {}
    for (const t of this.turns) {
      if (t.intent) intentCounts[t.intent] = (intentCounts[t.intent] ?? 0) + 1
    }
    const topIntent = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    // Build transcript for LLM
    const transcriptText = this.turns
      .slice(-30)  // last 30 turns max
      .map(t => `[${t.speaker}] ${t.transcript}`)
      .join('\n')

    // Generate summary via Ollama
    let narrative    = 'Conversation summary unavailable.'
    let nextStep: string | null = null
    let outcome      = 'unknown'

    try {
      const res = await fetch(CONFIG.OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.OLLAMA_MODEL,
          messages: [
            {
              role: 'system',
              content: `You are summarizing a conversation for ARIA's memory.
Return ONLY valid JSON, no other text:
{
  "summary": "<3-5 sentence narrative of what happened>",
  "outcome": "<one of: agreement|objection|stalled|info_request|lost|unknown>",
  "next_step": "<single actionable next step, or null>"
}
Be concrete. Use names if present. Include dollar amounts if relevant.`,
            },
            {
              role: 'user',
              content: `Mode: ${this.mode}\nDuration: ${Math.round(durationMs / 1000)}s\nTurns:\n${transcriptText}`,
            },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(CONFIG.OLLAMA_SUMMARY_TIMEOUT_MS),
      })

      const data = await res.json() as { message: { content: string } }
      const raw  = data.message.content.trim().replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(raw)

      narrative = (parsed.summary ?? narrative).slice(0, MAX_SUMMARY_CHARS)
      outcome   = parsed.outcome ?? outcome
      nextStep  = parsed.next_step ?? null

    } catch (e) {
      console.error('[SESSION] summary generation failed:', e)
      // Fallback summary from turns
      const otherTurns = this.turns.filter(t => t.speaker === 'other').map(t => t.transcript)
      narrative = otherTurns.slice(0, 3).join(' ').slice(0, MAX_SUMMARY_CHARS) || 'Conversation occurred.'
    }

    return {
      sessionId:  this.sessionId,
      startTs:    this.startTs,
      endTs,
      durationMs,
      turnCount:  this.turns.length,
      people,
      topIntent,
      lastOffer:  ctx.lastOffer,
      outcome,
      summary:    narrative,
      nextStep,
      mode:       this.mode,
    }
  }

  private async persistSummary(summary: SessionSummary): Promise<void> {
    // Store as episodic event
    const episodicText = [
      summary.summary,
      summary.nextStep ? `Next step: ${summary.nextStep}` : '',
      summary.lastOffer ? `Offer: $${summary.lastOffer}` : '',
    ].filter(Boolean).join(' ')

    const person = summary.people[0] ?? null

    await storeEpisode(episodicText, person, {
      type:       mapOutcomeToType(summary.outcome),
      object:     summary.summary.slice(0, 80),
      outcome:    mapOutcomeToEpisodicOutcome(summary.outcome),
      tags:       buildTags(summary),
      importance: computeImportance(summary),
      context:    summary.summary,
    })

    // Also save to history for RAG
    saveToHistory({
      ts:         summary.endTs,
      transcript: `[SESSION SUMMARY] ${summary.summary}`,
      intent:     summary.topIntent,
      response:   summary.nextStep,
    })

    console.log(`[SESSION] persisted to episodic memory — outcome=${summary.outcome}`)
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  getState():     SessionState  { return this.state }
  getSessionId(): string        { return this.sessionId }
  getTurnCount(): number        { return this.turns.length }
  isActive():     boolean       { return this.state === 'active' }

  getSessionContext(): string {
    if (this.state !== 'active' || !this.turns.length) return ''
    const dur = Math.round((Date.now() - this.startTs) / 1000)
    return `Current session: ${this.turns.length} turns, ${dur}s, mode=${this.mode}`
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapOutcomeToType(outcome: string) {
  const map: Record<string, any> = {
    agreement:    'agreement',
    objection:    'objection',
    stalled:      'followup',
    info_request: 'followup',
    lost:         'deal',
    unknown:      'note',
  }
  return map[outcome] ?? 'note'
}

function mapOutcomeToEpisodicOutcome(outcome: string) {
  const map: Record<string, any> = {
    agreement:    'won',
    lost:         'lost',
    stalled:      'deferred',
    objection:    'pending',
    info_request: 'pending',
    unknown:      'pending',
  }
  return map[outcome] ?? 'pending'
}

function buildTags(summary: SessionSummary): string[] {
  const tags: string[] = [summary.mode]
  if (summary.topIntent)           tags.push(summary.topIntent.toLowerCase())
  if (summary.lastOffer)           tags.push('money')
  if (summary.outcome === 'agreement') tags.push('close')
  if (summary.outcome === 'lost')      tags.push('lost')
  return tags
}

function computeImportance(summary: SessionSummary): number {
  let score = 0.3
  if (summary.outcome === 'agreement')      score += 0.4
  if (summary.outcome === 'lost')           score += 0.3
  if (summary.lastOffer)                    score += 0.15
  if (summary.people.length)               score += 0.1
  if (summary.topIntent === 'AGREEMENT')   score += 0.1
  if (summary.durationMs > 5 * 60 * 1000) score += 0.1  // > 5 min
  return Math.min(1.0, parseFloat(score.toFixed(2)))
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _session: SessionManager | null = null

export function getSessionManager(): SessionManager {
  if (!_session) _session = new SessionManager()
  return _session
}