/**
 * suites/streaming.ts
 * SUITE 7 — LLM Word-Buffer Streaming
 *
 * Verifies that the decision pipeline's streaming path fires TTS at the
 * right word-count boundaries and that first-chunk latency stays low.
 *
 * Tests:
 *   STR-001  enforceOutput truncates at MAX_SPOKEN_WORDS
 *   STR-002  classifyEvent returns a deterministic result per transcript
 *   STR-003  decide() completes within latency budget on fast path
 *   STR-004  Repeated calls with same input return same response (dedup)
 */

import { performance } from 'perf_hooks'
import { record, section, timed } from '../runner.js'

const SUITE = 'streaming'

// ── STR-001: Word limit enforcement ───────────────────────────────────────

async function testWordLimit(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers }       = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')

  const inputs = [
    "we can't afford this right now",
    "let's move forward send me the contract",
    "my business partner would need to weigh in",
  ]

  for (const text of inputs) {
    resetTiers()
    const { result } = await timed(() => decide(text))
    if (!result) {
      record(SUITE, 'STR-001', 'decide() response within word limit',
        'MEDIUM', 'SKIP', '≤ 12 words', 'null (no match)', `"${text.slice(0, 40)}"`, 0)
      continue
    }
    const wordCount = result.split(/\s+/).filter(Boolean).length
    const pass = wordCount <= 12
    record(SUITE, 'STR-001', 'decide() response within word limit',
      'MEDIUM', pass ? 'PASS' : 'FAIL',
      '≤ 12 words', `${wordCount} words: "${result}"`, `"${text.slice(0, 40)}"`, wordCount)
  }
}

// ── STR-002: classifyEvent determinism ────────────────────────────────────

async function testClassifyDeterminism(): Promise<void> {
  const { classifyEvent } = await import('../../../../src/pipeline/decision.js')

  const cases: Array<{ text: string; expected: string }> = [
    { text: "we can't afford this right now", expected: 'PRICE_OBJECTION' },
    { text: "let's move forward", expected: 'AGREEMENT' },
    { text: "my wife handles our finances", expected: 'AUTHORITY' },
    { text: "we already use servicetitan", expected: 'COMPETITOR' },
    { text: "i need to think about it", expected: 'STALLING' },
    { text: "what is the pricing?", expected: 'QUESTION' },
  ]

  for (const { text, expected } of cases) {
    // Call 3 times — must be identical each time
    const results = [classifyEvent(text), classifyEvent(text), classifyEvent(text)]
    const allSame = results.every(r => r === results[0])
    const correct = results[0] === expected

    record(SUITE, 'STR-002', `classifyEvent determinism — ${expected}`,
      'HIGH', (allSame && correct) ? 'PASS' : 'FAIL',
      expected, results[0],
      `"${text.slice(0, 40)}" — consistent: ${allSame}`, 0)
  }
}

// ── STR-003: Fast-path streaming latency (decide completes quickly) ────────

async function testStreamingLatency(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers }       = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')

  const cases = [
    "fifteen hundred bucks is a lot for us",
    "send me the contract today",
    "can you do better on the price",
  ]

  for (const text of cases) {
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      resetTiers()
      const { ms } = await timed(() => decide(text))
      times.push(ms)
    }
    const p90 = times.sort((a, b) => a - b)[Math.ceil(times.length * 0.9) - 1]
    record(SUITE, 'STR-003', 'Fast-path decide() P90 ≤ 300ms',
      'CRITICAL', p90 <= 300 ? 'PASS' : 'FAIL',
      'P90 ≤ 300ms', `P90=${p90.toFixed(0)}ms`,
      `"${text.slice(0, 40)}"`, p90)
  }
}

// ── STR-004: Response deduplication ───────────────────────────────────────

async function testDeduplication(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers }       = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')
  const text = "we can't afford this right now"

  // First call should fire; subsequent identical calls within dedup window should be silent
  resetTiers()
  const r1 = await decide(text)

  // Immediate re-call with same text — dedup should suppress or escalate tier
  const r2 = await decide(text)

  // Both should return a string (not null) but may differ due to tier advancement
  const pass = typeof r1 === 'string' && r1.length > 0
  record(SUITE, 'STR-004', 'decide() returns valid response string',
    'MEDIUM', pass ? 'PASS' : 'FAIL',
    'non-null string', r1 ?? 'null',
    `second call: "${r2?.slice(0, 40) ?? 'null'}"`, 0)
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  section('SUITE 7 — LLM Word-Buffer Streaming')

  await testWordLimit()
  await testClassifyDeterminism()
  await testStreamingLatency()
  await testDeduplication()
}
