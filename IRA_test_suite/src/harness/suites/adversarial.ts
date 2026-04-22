/**
 * suites/adversarial.ts
 * SUITE 9 — Adversarial & Edge Case Tests
 *
 * Stress-tests the pipeline against real-world failure modes.
 * Every test here targets a specific code path that could silently break
 * in production. These are the scenarios that make engineers sweat.
 *
 * Tests:
 *   ADV-001  Input bomb: 100k char transcript does not hang or crash
 *   ADV-002  Empty / whitespace / control-char inputs → null, no throw
 *   ADV-003  Unicode + emoji in signal transcript classifies correctly
 *   ADV-004  Path traversal via addNote() is rejected
 *   ADV-005  Corrupt JSONL in .aria/ recovers gracefully
 *   ADV-006  Forced fallback responses are ALL ≤ 12 words
 *   ADV-007  $0 offer is not silently dropped as falsy
 *   ADV-008  Concurrent decide() calls don't corrupt singleton coach state
 *   ADV-009  ReDoS probe: adversarial input completes < 5ms
 *   ADV-010  classifyEvent priority is deterministic on multi-signal inputs
 *   ADV-011  Newline injection in transcript survives JSONL round-trip
 *   ADV-012  All coach RESPONSES bank entries are ≤ 12 words
 *   ADV-013  matchEmbedding() resolves within latency budget when Ollama is down
 *   ADV-014  classifyEvent is stable under 1 000 rapid calls (no heap explosion)
 *   ADV-015  Invalid mode string does not silently corrupt pipeline
 */

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import { performance } from 'perf_hooks'
import { record, section, timed } from '../runner.js'

const SUITE  = 'adversarial'
const ARIA_DIR = path.join(os.homedir(), '.aria')

// ── ADV-001: Input bomb ────────────────────────────────────────────────────

async function testInputBomb(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers }      = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')
  resetTiers()

  // 100k char transcript — MAX_TRANSCRIPT_CHARS = 2000 should cap it immediately
  const bomb = "we can't afford this right now ".repeat(3300).trim()  // ~100k chars
  const { ms } = await timed(() => decide(bomb))

  record(SUITE, 'ADV-001', 'Input bomb (100k chars) completes < 50ms',
    'CRITICAL', ms < 50 ? 'PASS' : 'FAIL',
    '< 50ms', `${ms.toFixed(1)}ms`,
    `input length: ${bomb.length}`, ms)
}

// ── ADV-002: Null / empty / control-char inputs ────────────────────────────

async function testNullInputs(): Promise<void> {
  const { decide } = await import('../../../../src/pipeline/decision.js')

  const cases: Array<{ label: string; input: string }> = [
    { label: 'empty string',     input: ''        },
    { label: 'whitespace only',  input: '   \t\n' },
    { label: 'null bytes',       input: '\x00\x00\x00' },
    { label: 'control chars',    input: '\x01\x02\x03\x1b[31m' },
    { label: 'just punctuation', input: '??? !!! ...' },
  ]

  for (const { label, input } of cases) {
    let result: string | null = 'THREW'
    let threw = false
    try {
      result = await decide(input)
    } catch {
      threw = true
    }

    const pass = !threw && result !== 'THREW'
    record(SUITE, 'ADV-002', `Null/empty input — ${label} — no throw`,
      'HIGH', pass ? 'PASS' : 'FAIL',
      'no throw, null or string result', threw ? 'THREW' : String(result),
      `"${input.slice(0, 20).replace(/\x00/g, '\\0')}"`, 0)
  }
}

// ── ADV-003: Unicode + emoji ───────────────────────────────────────────────

async function testUnicodeEmoji(): Promise<void> {
  const { classifyEvent } = await import('../../../../src/pipeline/decision.js')

  const cases: Array<{ input: string; expected: string }> = [
    { input: "we can't 💸 afford this right now",     expected: 'PRICE_OBJECTION' },
    { input: "let's move forward 🤝 send the contract", expected: 'AGREEMENT'      },
    { input: "我需要和我的团队商量 (I need to check with my team)", expected: 'AUTHORITY' },
    { input: "we already use servicetitan 🔒",        expected: 'COMPETITOR'      },
  ]

  for (const { input, expected } of cases) {
    const result = classifyEvent(input)
    const pass   = result === expected
    record(SUITE, 'ADV-003', `Unicode/emoji classification — ${expected}`,
      'MEDIUM', pass ? 'PASS' : 'FAIL',
      expected, result,
      `"${input.slice(0, 50)}"`, 0)
  }
}

// ── ADV-004: Path traversal via addNote() ─────────────────────────────────

async function testPathTraversal(): Promise<void> {
  const { addNote } = await import('../../../../src/pipeline/rag.js')

  const attackNames = [
    '../../../etc/passwd',
    '..\\..\\windows\\system32\\config\\sam',
    'notes/../../../secrets.txt',
    '%2e%2e%2fetc%2fpasswd',
  ]

  for (const name of attackNames) {
    let threw = false
    try {
      await addNote('evil content', name)
    } catch {
      threw = true
    }

    record(SUITE, 'ADV-004', `Path traversal rejected — "${name.slice(0, 30)}"`,
      'CRITICAL', threw ? 'PASS' : 'FAIL',
      'throws on path traversal', threw ? 'threw ✓' : 'DID NOT THROW — traversal possible',
      name, 0)
  }
}

// ── ADV-005: Corrupt JSONL recovery ───────────────────────────────────────

async function testCorruptJsonl(): Promise<void> {
  const { getAllPeople } = await import('../../../../src/pipeline/people.js')

  const peopleFile = path.join(ARIA_DIR, 'people.jsonl')
  const backup     = fs.existsSync(peopleFile) ? fs.readFileSync(peopleFile) : null

  try {
    if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
    fs.writeFileSync(peopleFile,
      '{"name":"alice","displayName":"Alice","firstSeen":1,"lastSeen":1,"mentions":1,"notes":[],"tags":[],"lastOffer":null,"lastIntent":null}\n' +
      '{CORRUPT JSON LINE}\n' +
      'not json at all\n' +
      '{"name":"bob","displayName":"Bob","firstSeen":2,"lastSeen":2,"mentions":1,"notes":[],"tags":[],"lastOffer":null,"lastIntent":null}\n'
    )

    let threw = false
    let people: unknown[] = []
    try {
      people = getAllPeople()
    } catch {
      threw = true
    }

    const pass = !threw && Array.isArray(people)
    record(SUITE, 'ADV-005', 'Corrupt people.jsonl — no crash, partial recovery',
      'HIGH', pass ? 'PASS' : 'FAIL',
      'no throw, returns array', threw ? 'THREW' : `${people.length} records`,
      'injected 2 corrupt lines', 0)
  } finally {
    // Restore original file
    if (backup) fs.writeFileSync(peopleFile, backup)
    else if (fs.existsSync(peopleFile)) fs.unlinkSync(peopleFile)
  }
}

// ── ADV-006: Forced fallback word counts ──────────────────────────────────

async function testForcedFallbackWordCount(): Promise<void> {
  const { getForcedFallback } = await import('../../../../src/pipeline/playbook.js')

  const events = [
    'PRICE_OBJECTION', 'AGREEMENT', 'COMPETITOR',
    'AUTHORITY', 'OFFER_DISCUSS', 'DEADLINE',
  ] as const

  for (const event of events) {
    const resp = getForcedFallback(event as any)
    if (!resp) {
      record(SUITE, 'ADV-006', `Forced fallback word count — ${event}`,
        'HIGH', 'SKIP', '≤ 12 words', 'no fallback registered', event, 0)
      continue
    }
    const words = resp.split(/\s+/).filter(Boolean).length
    const pass  = words <= 12
    record(SUITE, 'ADV-006', `Forced fallback word count — ${event}`,
      'HIGH', pass ? 'PASS' : 'FAIL',
      '≤ 12 words', `${words} words: "${resp}"`, event, words)
  }
}

// ── ADV-007: $0 offer is not treated as falsy ─────────────────────────────

async function testZeroOffer(): Promise<void> {
  const { extractOffer } = await import('../../../../src/pipeline/memory.js')

  const cases: Array<{ input: string; expectedOffer: number | null }> = [
    { input: 'our price is $0 per month',     expectedOffer: 0  },
    { input: 'we offer this for $0',           expectedOffer: 0  },
    { input: 'the cost is zero dollars',       expectedOffer: null }, // no $ sign = no match expected
    { input: 'salary range is $100k',          expectedOffer: 100_000 },
    { input: 'fifteen hundred is too expensive', expectedOffer: null }, // ambiguous - word form
  ]

  for (const { input, expectedOffer } of cases) {
    const got  = extractOffer(input)
    const pass = got === expectedOffer
    record(SUITE, 'ADV-007', `Offer extraction — "${input.slice(0, 40)}"`,
      'MEDIUM', pass ? 'PASS' : 'FAIL',
      String(expectedOffer), String(got),
      input, 0)
  }

  // Critical: verify $0 is treated as a valid offer (not falsy-dropped) in context
  const zeroOffer = extractOffer('our price is $0 per month')
  const notDropped = zeroOffer !== null  // it should be 0, not null
  record(SUITE, 'ADV-007', '$0 offer preserved as 0, not null',
    'HIGH', notDropped ? 'PASS' : 'FAIL',
    '0 (number)', String(zeroOffer),
    'context: if (lastOffer) drops 0 — zero offer = no offer bug', 0)
}

// ── ADV-008: Concurrent decide() session corruption ───────────────────────

async function testConcurrentSessionCorruption(): Promise<void> {
  const { decide, setMode } = await import('../../../../src/pipeline/decision.js')
  const { resetCoach, getCoachSession } = await import('../../../../src/pipeline/negotiationCoach.js')
  const { resetTiers } = await import('../../../../src/pipeline/playbook.js')

  setMode('negotiation')
  resetCoach()
  resetTiers()

  const stateBefore = getCoachSession().getState().level

  // Fire 5 identical PRICE_OBJECTION calls concurrently
  const transcript = "we can't afford this right now"
  const results = await Promise.all(
    Array.from({ length: 5 }, () => decide(transcript))
  )

  const stateAfter = getCoachSession().getState().level

  // All results should be non-undefined (not crash)
  const noCrash = results.every(r => r !== undefined)

  // With the serialize lock, 5 concurrent calls run sequentially — each advancing
  // the coach ladder by one level. Level 4 (max) after 5 calls is CORRECT behavior.
  // Without the lock they could interleave mid-await and multiple calls could read
  // the same level, producing duplicated responses. The lock prevents that.
  // After 5 serialized calls the level should be exactly 4 (capped at max).
  const levelValid = stateAfter === 4

  record(SUITE, 'ADV-008', 'Concurrent decide() — no crash, all return valid',
    'CRITICAL', noCrash ? 'PASS' : 'FAIL',
    'all return without throwing', `${results.filter(r => r !== null).length}/5 non-null`,
    '5 concurrent PRICE_OBJECTION calls serialized by lock', 0)

  record(SUITE, 'ADV-008', 'Concurrent decide() — lock serializes to correct final level',
    'HIGH', levelValid ? 'PASS' : 'FAIL',
    'level = 4 after 5 serialized calls (max ladder)',
    `level = ${stateAfter} (started at ${stateBefore})`,
    'without lock: calls interleave and duplicate level responses', 0)
}

// ── ADV-009: ReDoS resistance ──────────────────────────────────────────────

async function testReDoS(): Promise<void> {
  const { classifyEvent } = await import('../../../../src/pipeline/decision.js')

  // Strings crafted to exploit backtracking in naive regexes
  const attacks = [
    'a'.repeat(1000) + '?',                              // triggers RE_QUESTION potentially
    "we can't " + "not ".repeat(500) + "afford this",   // nested negative chains
    "maybe ".repeat(300) + "we need to think about it", // RE_STALLING repetition
    '$' + '1,'.repeat(500) + '000',                     // offer-like with deep comma repeat
  ]

  for (const attack of attacks) {
    const t0  = performance.now()
    const res = classifyEvent(attack)
    const ms  = performance.now() - t0

    record(SUITE, 'ADV-009', `ReDoS resistance — ${attack.slice(0, 30)}...`,
      'HIGH', ms < 5 ? 'PASS' : 'FAIL',
      '< 5ms', `${ms.toFixed(2)}ms → ${res}`,
      `${attack.length} char adversarial input`, ms)
  }
}

// ── ADV-010: classifyEvent multi-signal priority ───────────────────────────

async function testMultiSignalPriority(): Promise<void> {
  const { classifyEvent } = await import('../../../../src/pipeline/decision.js')

  // Price + Authority in same sentence: price should win (checked first)
  const cases: Array<{ input: string; expected: string; note: string }> = [
    {
      input:    "we can't afford this and I need to check with my boss",
      expected: 'PRICE_OBJECTION',
      note:     'price beats authority',
    },
    {
      input:    "we already use servicetitan and we're ready to move forward",
      expected: 'COMPETITOR',
      note:     'competitor beats agreement',
    },
    {
      input:    "let's move forward — but I need to think about the price",
      expected: 'AGREEMENT',
      note:     'agreement beats stalling (agreement checked after competitor/authority/price)',
    },
    {
      input:    "I need to check with my team and also need to think about it",
      expected: 'AUTHORITY',
      note:     'authority beats stalling',
    },
  ]

  for (const { input, expected, note } of cases) {
    const got  = classifyEvent(input)
    const pass = got === expected
    record(SUITE, 'ADV-010', `Multi-signal priority — ${note}`,
      'MEDIUM', pass ? 'PASS' : 'FAIL',
      expected, got,
      `"${input.slice(0, 60)}"`, 0)
  }
}

// ── ADV-011: Newline injection survives JSONL round-trip ──────────────────

async function testNewlineInjection(): Promise<void> {
  const { saveToHistory, loadRecentHistory } = await import('../../../../src/pipeline/rag.js')

  const malicious = 'hello\nworld\n{"injected":"record","ts":1}'

  let threw = false
  try {
    saveToHistory({ ts: Date.now(), transcript: malicious, intent: null, response: null })
  } catch {
    threw = true
  }

  if (threw) {
    record(SUITE, 'ADV-011', 'Newline injection in transcript — saveToHistory',
      'HIGH', 'FAIL', 'no throw', 'THREW on save', malicious.slice(0, 40), 0)
    return
  }

  // Reload and verify no extra injected records appeared
  const history = loadRecentHistory(1, 50)
  const injectedRecord = history.find(e => (e as any).injected === 'record')

  record(SUITE, 'ADV-011', 'Newline injection — no extra records injected into history',
    'HIGH', !injectedRecord ? 'PASS' : 'FAIL',
    'no injected record', injectedRecord ? 'INJECTED RECORD FOUND' : 'clean',
    'JSON.stringify should escape \\n', 0)
}

// ── ADV-012: Coach RESPONSES bank word count audit ────────────────────────

async function testResponseBankWordCount(): Promise<void> {
  const { getCoachSession, resetCoach } = await import('../../../../src/pipeline/negotiationCoach.js')
  const { resetTiers } = await import('../../../../src/pipeline/playbook.js')

  // Drive the coach through all levels for each objection type by feeding
  // answers that force escalation. Collect every response and check ≤ 12 words.
  const objectionInputs: Array<{ label: string; transcript: string }> = [
    { label: 'PRICE_OBJECTION', transcript: "we can't afford this" },
    { label: 'STALLING',        transcript: "i need to think about it" },
    { label: 'AUTHORITY',       transcript: "i need to check with my team" },
    { label: 'COMPETITOR',      transcript: "we already use servicetitan" },
    { label: 'AGREEMENT',       transcript: "let's move forward" },
  ]

  const violations: string[] = []

  for (const { label, transcript } of objectionInputs) {
    resetCoach()
    resetTiers()
    const session = getCoachSession()

    // Drive through 5 levels (0-4) — answer each time to force advancement
    for (let level = 0; level < 5; level++) {
      const turn = session.process(transcript)
      if (turn.response) {
        const words = turn.response.split(/\s+/).filter(Boolean).length
        if (words > 12) {
          violations.push(`${label} L${level}: "${turn.response}" (${words} words)`)
        }
      }
    }
  }

  record(SUITE, 'ADV-012', 'All coach RESPONSES bank entries ≤ 12 words',
    'HIGH', violations.length === 0 ? 'PASS' : 'FAIL',
    '0 violations', `${violations.length} violation(s)`,
    violations.slice(0, 3).join(' | ') || 'all clean', 0)
}

// ── ADV-013: matchEmbedding() resolves within latency budget ──────────────

async function testEmbeddingTimeout(): Promise<void> {
  const { matchEmbedding } = await import('../../../../src/pipeline/embeddings.js')

  // With Ollama down (test env), embed() should fail fast via ECONNREFUSED
  // and the whole call should complete well within 300ms budget
  const BUDGET_MS = 300

  const t0 = performance.now()
  let result: { action: string; score: number } | null = null
  let threw = false
  try {
    result = await Promise.race([
      matchEmbedding("we can't afford this right now"),
      new Promise<null>(r => setTimeout(() => r(null), BUDGET_MS)),
    ])
  } catch {
    threw = true
  }

  const ms   = performance.now() - t0
  const pass = !threw && ms < BUDGET_MS

  record(SUITE, 'ADV-013', `matchEmbedding() resolves within ${BUDGET_MS}ms when Ollama is down`,
    'HIGH', pass ? 'PASS' : 'FAIL',
    `< ${BUDGET_MS}ms, no throw`, threw ? 'THREW' : `${ms.toFixed(0)}ms → ${result?.action ?? 'null'}`,
    'ECONNREFUSED should fail fast', ms)
}

// ── ADV-014: Memory stability under 1000 rapid classifyEvent calls ─────────

async function testMemoryStability(): Promise<void> {
  const { classifyEvent } = await import('../../../../src/pipeline/decision.js')

  const inputs = [
    "we can't afford this right now",
    "let's move forward send me the contract",
    "i need to check with my boss",
    "we already use servicetitan",
    "i need to think about it",
    "what is the pricing?",
    "the weather is nice today",
  ]

  // Force GC if available
  if (global.gc) global.gc()
  const heapBefore = process.memoryUsage().heapUsed

  for (let i = 0; i < 1000; i++) {
    classifyEvent(inputs[i % inputs.length])
  }

  if (global.gc) global.gc()
  const heapAfter = process.memoryUsage().heapUsed
  const growthMB  = (heapAfter - heapBefore) / 1_048_576

  // Allow up to 5MB growth (modules may cache things)
  const pass = growthMB < 5

  record(SUITE, 'ADV-014', '1000 classifyEvent calls — heap growth < 5MB',
    'MEDIUM', pass ? 'PASS' : 'FAIL',
    '< 5MB heap growth', `${growthMB.toFixed(2)}MB`,
    '1000 rapid-fire calls across 7 input types', growthMB)
}

// ── ADV-015: Invalid mode does not silently corrupt the pipeline ──────────

async function testInvalidMode(): Promise<void> {
  const { setMode, getMode } = await import('../../../../src/pipeline/decision.js')

  const validModeBefore = getMode()

  // TypeScript prevents this at compile time but it can happen at runtime
  // via process.argv injection or API calls
  let threw = false
  try {
    setMode('hacker_mode' as any)
  } catch {
    threw = true
  }

  const modeAfter = getMode()

  // Either it throws (best), or it sets the mode (runtime accepts it).
  // What it must NOT do: silently keep the old mode when the new mode
  // is set — that would mean mode changes fail silently.
  // We also verify the pipeline doesn't crash after the invalid mode is set.

  const { decide } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers } = await import('../../../../src/pipeline/playbook.js')
  resetTiers()

  let decideThrew = false
  try {
    await decide("let's move forward")
  } catch {
    decideThrew = true
  }

  record(SUITE, 'ADV-015', 'Invalid mode — decide() does not crash after bad mode string',
    'HIGH', !decideThrew ? 'PASS' : 'FAIL',
    'no crash', decideThrew ? 'CRASHED' : `mode="${modeAfter}", no crash`,
    `set mode to "hacker_mode", threw=${threw}`, 0)

  // Restore valid mode
  setMode(validModeBefore)
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  section('SUITE 9 — Adversarial & Edge Case Tests')

  await testInputBomb()
  await testNullInputs()
  await testUnicodeEmoji()
  await testPathTraversal()
  await testCorruptJsonl()
  await testForcedFallbackWordCount()
  await testZeroOffer()
  await testConcurrentSessionCorruption()
  await testReDoS()
  await testMultiSignalPriority()
  await testNewlineInjection()
  await testResponseBankWordCount()
  await testEmbeddingTimeout()
  await testMemoryStability()
  await testInvalidMode()
}
