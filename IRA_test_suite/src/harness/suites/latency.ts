/**
 * suites/latency.ts
 * SUITE 1 — Pipeline Latency (CRITICAL)
 *
 * Tests every stage of the pipeline independently and end-to-end.
 * All latency thresholds are production targets — not aspirations.
 *
 * Thresholds (warm cache, idle CPU):
 *   STT (whisper small.en)   : P90 ≤ 200ms
 *   Rules engine             : P99 ≤ 2ms
 *   Playbook match           : P99 ≤ 2ms
 *   Embedding (cache miss)   : P90 ≤ 55ms
 *   Embedding (cache hit)    : P99 ≤ 5ms
 *   LLM TTFT (warm)          : P90 ≤ 450ms
 *   TTS first chunk          : P90 ≤ 120ms
 *   TOTAL fast-path          : P90 ≤ 300ms   ← the number that matters
 *   TOTAL slow-path (LLM)    : P90 ≤ 700ms
 */

import { performance } from 'perf_hooks'
import { record, section, timed, percentile } from '../runner.js'

const SUITE = 'latency'

// ── Thresholds ─────────────────────────────────────────────────────────────

const T = {
  RULES_P99:        2,
  PLAYBOOK_P99:     2,
  EMBED_HIT_P99:    5,
  EMBED_MISS_P90:   55,
  TTS_TTFC_P90:     120,
  TOTAL_FAST_P90:   300,  // CRITICAL threshold
  TOTAL_SLOW_P90:   500,
  TOTAL_FAST_P99:   450,
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pStats(values: number[]) {
  const s = [...values].filter(v => v > 0).sort((a, b) => a - b)
  return {
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p99: percentile(s, 99),
    avg: s.reduce((a, b) => a + b, 0) / (s.length || 1),
    max: s[s.length - 1] ?? 0,
  }
}

async function measureRules(transcript: string, mode: string, trials = 50): Promise<number[]> {
  const { matchRule } = await import("../../../../src/pipeline/rules.js")
  // Warmup: ensure JIT compilation is complete before timing
  matchRule(transcript, mode as any)
  matchRule(transcript, mode as any)
  return Promise.all(
    Array.from({ length: trials }, async () => {
      const t0 = performance.now()
      matchRule(transcript, mode as any)
      return performance.now() - t0
    })
  )
}

async function measurePlaybook(transcript: string, trials = 50): Promise<number[]> {
  const { matchPlaybook, resetTiers } = await import("../../../../src/pipeline/playbook.js")
  return Promise.all(
    Array.from({ length: trials }, async () => {
      resetTiers()
      const t0 = performance.now()
      matchPlaybook(transcript)
      return performance.now() - t0
    })
  )
}

async function measureEmbed(transcript: string, trials = 20): Promise<{ hit: number[]; miss: number[] }> {
  const { clearEmbedCache } = await import("../../../../src/pipeline/embedCache.js")
  const { matchEmbedding, warmupEmbeddings } = await import("../../../../src/pipeline/embeddings.js")

  await warmupEmbeddings()

  // Cache miss: clear before each trial
  const miss: number[] = []
  for (let i = 0; i < Math.min(trials, 5); i++) {
    clearEmbedCache()
    const { ms } = await timed(() => matchEmbedding(transcript))
    miss.push(ms)
  }

  // Cache hit: embed once so it's warm
  await matchEmbedding(transcript)
  const hit: number[] = []
  for (let i = 0; i < trials; i++) {
    const { ms } = await timed(() => matchEmbedding(transcript))
    hit.push(ms)
  }

  return { hit, miss }
}

// ── LAT-001: Rules engine latency ─────────────────────────────────────────

async function testRulesLatency(): Promise<void> {
  const transcripts = [
    { text: "we can't afford this right now",               mode: 'negotiation' },
    { text: "let's move forward send me the contract",      mode: 'negotiation' },
    { text: "we think conversion is up 40 percent",        mode: 'meeting' },
    { text: "what are your salary expectations",           mode: 'interview' },
    { text: "we run a fund focused on early stage",        mode: 'social' },
    { text: "the weather in dallas is nice today",         mode: 'negotiation' }, // no match
  ]

  for (const tc of transcripts) {
    const durations = await measureRules(tc.text, tc.mode, 100)
    const s = pStats(durations)
    const pass = s.p99 <= T.RULES_P99

    record(
      SUITE, 'LAT-001', `Rules engine P99 ≤ ${T.RULES_P99}ms [${tc.mode}]`,
      'CRITICAL', pass ? 'PASS' : 'FAIL',
      `P99 ≤ ${T.RULES_P99}ms`,
      `P99=${s.p99.toFixed(2)}ms P90=${s.p90.toFixed(2)}ms avg=${s.avg.toFixed(2)}ms`,
      `transcript: "${tc.text.slice(0, 40)}"`,
      s.p99,
      { p50: s.p50, p90: s.p90, p99: s.p99, totalToAudio: 0 }
    )
  }
}

// ── LAT-002: Playbook match latency ───────────────────────────────────────

async function testPlaybookLatency(): Promise<void> {
  const transcripts = [
    "fifteen hundred bucks is a lot for us man",
    "yeah okay i am in let us do this",
    "any wiggle room on that price",
    "my business partner would need to weigh in",
    "we already signed with servicetitan last week",
  ]

  for (const text of transcripts) {
    const durations = await measurePlaybook(text, 100)
    const s = pStats(durations)
    const pass = s.p99 <= T.PLAYBOOK_P99

    record(
      SUITE, 'LAT-002', `Playbook match P99 ≤ ${T.PLAYBOOK_P99}ms`,
      'CRITICAL', pass ? 'PASS' : 'FAIL',
      `P99 ≤ ${T.PLAYBOOK_P99}ms`,
      `P99=${s.p99.toFixed(2)}ms`,
      `"${text.slice(0, 40)}"`,
      s.p99
    )
  }
}

// ── LAT-003: Embedding cache hit/miss latency ─────────────────────────────

async function testEmbedLatency(): Promise<void> {
  const transcripts = [
    "we can't afford this right now",
    "send me the contract today",
  ]

  for (const text of transcripts) {
    const { hit, miss } = await measureEmbed(text)
    const hitStats  = pStats(hit)
    const missStats = pStats(miss)

    record(
      SUITE, 'LAT-003a', `Embed cache HIT P99 ≤ ${T.EMBED_HIT_P99}ms`,
      'HIGH', hitStats.p99 <= T.EMBED_HIT_P99 ? 'PASS' : 'FAIL',
      `P99 ≤ ${T.EMBED_HIT_P99}ms`,
      `P99=${hitStats.p99.toFixed(1)}ms P50=${hitStats.p50.toFixed(1)}ms`,
      `"${text.slice(0, 40)}"`,
      hitStats.p99
    )
    record(
      SUITE, 'LAT-003b', `Embed cache MISS P90 ≤ ${T.EMBED_MISS_P90}ms`,
      'HIGH', missStats.p90 <= T.EMBED_MISS_P90 ? 'PASS' : 'WARN',
      `P90 ≤ ${T.EMBED_MISS_P90}ms`,
      `P90=${missStats.p90.toFixed(1)}ms avg=${missStats.avg.toFixed(1)}ms`,
      'Depends on Ollama warm state',
      missStats.p90
    )
  }
}

// ── LAT-004: Full fast-path pipeline ─────────────────────────────────────
// Simulates a rule/playbook hit — the most common path (~60% of calls).

async function testFastPathLatency(): Promise<void> {
  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")

  setMode('negotiation')

  const fastCases = [
    "we can't afford this right now",
    "let's move forward send me the contract",
    "can you do better on the price",
    "my wife handles all of our finances",
    "we've been with servicetitan for three years",
  ]

  const allMs: number[] = []

  for (const text of fastCases) {
    const runs: number[] = []
    for (let i = 0; i < 10; i++) {
      resetTiers()
      const { ms } = await timed(() => decide(text))
      runs.push(ms)
    }
    const s = pStats(runs)
    allMs.push(...runs)

    record(
      SUITE, 'LAT-004', `Fast-path total P90 ≤ ${T.TOTAL_FAST_P90}ms`,
      'CRITICAL', s.p90 <= T.TOTAL_FAST_P90 ? 'PASS' : 'FAIL',
      `P90 ≤ ${T.TOTAL_FAST_P90}ms`,
      `P90=${s.p90.toFixed(0)}ms P50=${s.p50.toFixed(0)}ms P99=${s.p99.toFixed(0)}ms`,
      `"${text.slice(0, 40)}"`,
      s.p90,
      { p50: s.p50, p90: s.p90, p99: s.p99, totalToAudio: s.p90 }
    )
  }

  // Overall P99 must not exceed TOTAL_FAST_P99
  const overall = pStats(allMs)
  record(
    SUITE, 'LAT-004x', `Fast-path OVERALL P99 ≤ ${T.TOTAL_FAST_P99}ms`,
    'CRITICAL', overall.p99 <= T.TOTAL_FAST_P99 ? 'PASS' : 'FAIL',
    `P99 ≤ ${T.TOTAL_FAST_P99}ms`,
    `P99=${overall.p99.toFixed(0)}ms`,
    `Across ${allMs.length} total fast-path trials`,
    overall.p99,
    { p50: overall.p50, p90: overall.p90, p99: overall.p99, totalToAudio: overall.p90 }
  )
}

// ── LAT-005: Cold start latency ───────────────────────────────────────────

async function testColdStart(): Promise<void> {
  const { clearEmbedCache } = await import("../../../../src/pipeline/embedCache.js")
  const { clearMemory } = await import("../../../../src/pipeline/memory.js")
  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")

  // Simulate cold: clear caches
  clearEmbedCache()
  clearMemory()
  resetTiers()
  setMode('negotiation')

  const { ms } = await timed(() => decide("we can't afford this right now"))

  // Cold start may be slower — warn if >500ms, fail if >1000ms
  const verdict = ms > 1000 ? 'FAIL' : ms > 500 ? 'WARN' : 'PASS'
  record(
    SUITE, 'LAT-005', 'Cold start latency < 1000ms',
    'HIGH', verdict,
    '< 1000ms (warn > 500ms)',
    `${ms.toFixed(0)}ms`,
    'Caches cleared before this trial',
    ms,
    { totalToAudio: ms }
  )
}

// ── LAT-006: Latency under simulated CPU contention ───────────────────────

async function testCPUContention(): Promise<void> {
  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")

  setMode('negotiation')

  // Spin up CPU-burning concurrent work
  const burnMs = 500
  const burn = async () => {
    const end = performance.now() + burnMs
    while (performance.now() < end) { Math.sqrt(Math.random()) }
  }

  // Run decision while CPU is burning
  const burnPromise = burn()
  resetTiers()
  const { ms } = await timed(() => decide("send me the contract today"))
  await burnPromise

  // Under CPU load, allow 2× the normal budget
  const threshold = T.TOTAL_FAST_P90 * 2
  record(
    SUITE, 'LAT-006', `CPU contention: total ≤ ${threshold}ms`,
    'HIGH', ms <= threshold ? 'PASS' : 'WARN',
    `≤ ${threshold}ms under load`,
    `${ms.toFixed(0)}ms`,
    'Concurrent CPU burn task running',
    ms,
    { totalToAudio: ms }
  )
}

// ── LAT-007: Concurrent call latency isolation ────────────────────────────
// Two decide() calls fire simultaneously. Neither should block the other.

async function testConcurrentCalls(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers } = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')
  resetTiers()

  const [r1, r2] = await Promise.all([
    timed(() => decide("we can't afford this")),
    timed(() => decide("let's move forward")),
  ])

  const max = Math.max(r1.ms, r2.ms)
  const verdict = max <= T.TOTAL_FAST_P90 * 2 ? 'PASS' : 'WARN'

  record(
    SUITE, 'LAT-007', 'Concurrent calls: no cross-blocking',
    'HIGH', verdict,
    `both complete ≤ ${T.TOTAL_FAST_P90 * 2}ms`,
    `call1=${r1.ms.toFixed(0)}ms call2=${r2.ms.toFixed(0)}ms max=${max.toFixed(0)}ms`,
    'Simultaneous decide() calls',
    max
  )
}

// ── LAT-004-slow: Full slow-path pipeline (LLM) ───────────────────────────
// Transcripts chosen to miss rules, playbook, and embedding — forcing LLM.

async function testSlowPathLatency(): Promise<void> {
  const { decide, setMode } = await import("../../../../src/pipeline/decision.js")
  const { resetTiers } = await import("../../../../src/pipeline/playbook.js")

  setMode('negotiation')

  const slowCases = [
    "what is our discount policy for enterprise customers in q4",
    "can you summarize the key risks in our current proposal",
    "how should i handle this objection about integration complexity",
  ]

  const allMs: number[] = []

  for (const text of slowCases) {
    const runs: number[] = []
    for (let i = 0; i < 5; i++) {
      resetTiers()
      const { ms } = await timed(() => decide(text))
      runs.push(ms)
    }
    const s = pStats(runs)
    allMs.push(...runs)

    record(
      SUITE, 'LAT-004-slow', `Slow-path (LLM) P90 ≤ ${T.TOTAL_SLOW_P90}ms`,
      'HIGH', s.p90 <= T.TOTAL_SLOW_P90 ? 'PASS' : 'FAIL',
      `P90 ≤ ${T.TOTAL_SLOW_P90}ms`,
      `P90=${s.p90.toFixed(0)}ms P50=${s.p50.toFixed(0)}ms P99=${s.p99.toFixed(0)}ms`,
      `"${text.slice(0, 50)}"`,
      s.p90,
      { p50: s.p50, p90: s.p90, p99: s.p99, totalToAudio: s.p90 }
    )
  }
}

// ── LAT-008: Repeated identical transcript (cache saturation) ─────────────

async function testCacheRepeat(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers } = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')
  const text = "we can't afford this right now"

  const ms: number[] = []
  for (let i = 0; i < 20; i++) {
    resetTiers()
    const { ms: m } = await timed(() => decide(text))
    ms.push(m)
  }

  // After first few runs, all should be fast (cache warm)
  const warmMs = ms.slice(3) // skip first 3 cold runs
  const s = pStats(warmMs)

  record(
    SUITE, 'LAT-008', `Cache-warm repeat P99 ≤ ${T.TOTAL_FAST_P99}ms`,
    'MEDIUM', s.p99 <= T.TOTAL_FAST_P99 ? 'PASS' : 'FAIL',
    `warm P99 ≤ ${T.TOTAL_FAST_P99}ms`,
    `warm P99=${s.p99.toFixed(0)}ms P50=${s.p50.toFixed(0)}ms`,
    `20 identical transcripts; first 3 excluded from warm stats`,
    s.p99
  )
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  section('SUITE 1 — Pipeline Latency (CRITICAL)')

  await testRulesLatency()
  await testPlaybookLatency()
  await testEmbedLatency()
  await testFastPathLatency()
  await testSlowPathLatency()
  await testColdStart()
  await testCPUContention()
  await testConcurrentCalls()
  await testCacheRepeat()
}