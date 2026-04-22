/**
 * steering.ts
 * ARIA stops reacting. ARIA controls.
 *
 * 1. Predict intent trajectory from last N turns
 * 2. Pre-load counter actions
 * 3. Output a steering directive before the person finishes
 */

import { getRecentTranscripts } from './memory.js'
import { CONFIG } from '../config.js'

export type PredictedIntent =
  | 'stall'
  | 'lowball'
  | 'interest'
  | 'authority_block'
  | 'competitor_pivot'
  | 'closing'
  | 'info_seeking'
  | 'unknown'

export interface SteeringDirective {
  predictedIntent: PredictedIntent
  confidence: number         // 0–1
  counterAction: string      // what ARIA should do
  rationale: string          // why (for logging, not spoken)
  preloadMessage: string | null  // speak this if confidence > 0.8
}

// ── Rule-based intent prediction (fast path) ──────────────────────────────

interface IntentSignal {
  pattern: RegExp
  intent: PredictedIntent
  weight: number
}

const SIGNALS: IntentSignal[] = [
  // stall signals
  { pattern: /think about it|not sure|maybe|get back|later|next quarter/i, intent: 'stall', weight: 0.8 },
  { pattern: /need time|busy|check my schedule|not right now/i,           intent: 'stall', weight: 0.7 },

  // lowball signals
  { pattern: /budget|expensive|too much|afford|price|cost|discount/i,   intent: 'lowball', weight: 0.75 },
  { pattern: /can you do better|any flexibility|negotiate/i,              intent: 'lowball', weight: 0.9 },

  // interest signals
  { pattern: /how does it work|tell me more|what's included|walk me through/i, intent: 'interest', weight: 0.85 },
  { pattern: /sounds (good|interesting)|like that|love it|excited/i,          intent: 'interest', weight: 0.80 },

  // authority block
  { pattern: /my boss|my team|need approval|run it by|not my call|check with/i, intent: 'authority_block', weight: 0.9 },

  // competitor pivot
  { pattern: /servicetitan|jobber|housecall|competitor|already use|current system/i, intent: 'competitor_pivot', weight: 0.9 },

  // closing signals
  { pattern: /move forward|let's do it|sign|contract|next steps|onboard/i, intent: 'closing', weight: 0.95 },
  { pattern: /when can we start|how do we proceed|what's next/i,            intent: 'closing', weight: 0.85 },

  // info seeking
  { pattern: /what is|how does|can you explain|tell me about|what are/i, intent: 'info_seeking', weight: 0.7 },
]

// ── Counter actions per predicted intent ──────────────────────────────────

const COUNTER_ACTIONS: Record<PredictedIntent, { action: string; preload: string | null }> = {
  stall:            { action: 'Ask — what changes',    preload: 'Ask — what changes' },
  lowball:          { action: 'Anchor — hold price',   preload: 'Anchor — ROI' },
  interest:         { action: 'Push — close now',      preload: 'Push — close now' },
  authority_block:  { action: 'Ask — who decides',     preload: null },
  competitor_pivot: { action: 'Challenge — what\'s missing', preload: null },
  closing:          { action: 'Accept — confirm terms',preload: 'Accept — confirm terms' },
  info_seeking:     { action: 'Clarify — key benefit', preload: null },
  unknown:          { action: 'Wait — observe',        preload: null },
}

// ── Fast rule-based prediction ─────────────────────────────────────────────

function predictFast(transcripts: string[]): { intent: PredictedIntent; confidence: number } | null {
  const combined = transcripts.join(' ')
  const scores: Record<PredictedIntent, number> = {
    stall: 0, lowball: 0, interest: 0,
    authority_block: 0, competitor_pivot: 0,
    closing: 0, info_seeking: 0, unknown: 0,
  }

  for (const signal of SIGNALS) {
    if (signal.pattern.test(combined)) {
      scores[signal.intent] += signal.weight
    }
  }

  const best = (Object.entries(scores) as [PredictedIntent, number][])
    .sort((a, b) => b[1] - a[1])[0]

  if (!best || best[1] === 0) return null

  const total = Object.values(scores).reduce((a, b) => a + b, 0)
  const confidence = Math.min(0.99, best[1] / (total || 1))

  return { intent: best[0], confidence }
}

// ── LLM-powered prediction (for complex / ambiguous signals) ──────────────

async function predictLLM(transcripts: string[]): Promise<{ intent: PredictedIntent; confidence: number } | null> {
  const recent = transcripts.slice(-3).join('\n')

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          {
            role: 'system',
            content: `Predict conversation intent from recent turns.
Return ONLY valid JSON: {"intent":"<stall|lowball|interest|authority_block|competitor_pivot|closing|info_seeking|unknown>","confidence":<0.0-1.0>}
No other text.`,
          },
          { role: 'user', content: `Recent conversation:\n${recent}` },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_STEERING_TIMEOUT_MS),
    })
    const data = await res.json() as { message: { content: string } }
    const raw = data.message.content.trim().replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(raw) as { intent: PredictedIntent; confidence: number }
    return parsed
  } catch {
    return null
  }
}

// ── Main steer ────────────────────────────────────────────────────────────

export async function steer(
  transcript: string,
  useLLM = false
): Promise<SteeringDirective> {
  const recent = getRecentTranscripts(5)
  const all = [...recent, transcript]

  // always try fast path first
  const fast = predictFast(all)

  let predicted: { intent: PredictedIntent; confidence: number } | null = fast

  // LLM only if fast confidence is low and caller opts in
  if (useLLM && (!fast || fast.confidence < 0.65)) {
    const llmResult = await predictLLM(all)
    if (llmResult && llmResult.confidence > (fast?.confidence ?? 0)) {
      predicted = llmResult
    }
  }

  const intent = predicted?.intent ?? 'unknown'
  const confidence = predicted?.confidence ?? 0

  const counter = COUNTER_ACTIONS[intent]

  const directive: SteeringDirective = {
    predictedIntent: intent,
    confidence,
    counterAction: counter.action,
    rationale: `${intent} detected @ ${(confidence * 100).toFixed(0)}% confidence`,
    preloadMessage: confidence >= 0.80 ? counter.preload : null,
  }

  console.log(`[STEER] intent=${intent} conf=${(confidence * 100).toFixed(0)}% → ${counter.action}`)
  return directive
}

// ── Trajectory summary (last N turns) ────────────────────────────────────

export function getTrajectoryContext(): string {
  const recent = getRecentTranscripts(5)
  if (!recent.length) return ''
  const fast = predictFast(recent)
  if (!fast || fast.confidence < 0.5) return ''
  return `Predicted trajectory: ${fast.intent} (${(fast.confidence * 100).toFixed(0)}% conf)`
}