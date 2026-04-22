/**
 * suites/scenarios.ts
 * SUITE 8 — End-to-End Scenario Replays
 *
 * Simulates realistic multi-turn negotiation conversations and verifies
 * that the decision pipeline classifies and responds correctly at each turn.
 *
 * Tests:
 *   SCN-001  Price objection → escalation → close
 *   SCN-002  Authority objection → reframe → agreement
 *   SCN-003  Stalling → urgency injection → follow-up
 *   SCN-004  Competitor mention → differentiation response
 *   SCN-005  Cold open → discovery → proposal flow
 */

import { record, section, timed } from '../runner.js'

const SUITE = 'scenarios'

// ── Scenario turn type ─────────────────────────────────────────────────────

interface Turn {
  transcript:    string
  expectIntent:  string
  expectReply:   RegExp | null   // null = just check non-null
  expectWords:   number          // max word count in reply
}

interface Scenario {
  id:   string
  name: string
  mode: string
  turns: Turn[]
}

// ── Helper ─────────────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<void> {
  const { decide, setMode, classifyEvent } = await import('../../../../src/pipeline/decision.js')
  const { resetTiers }                     = await import('../../../../src/pipeline/playbook.js')

  setMode(scenario.mode)
  resetTiers()

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn   = scenario.turns[i]
    const turnId = `${scenario.id}-T${i + 1}`

    // Classify
    const intent   = classifyEvent(turn.transcript)
    const intentOk = intent === turn.expectIntent

    // Decide (timed)
    const { result, ms } = await timed(() => decide(turn.transcript))

    const hasReply   = typeof result === 'string' && result.length > 0
    const wordCount  = result ? result.split(/\s+/).filter(Boolean).length : 0
    const wordsOk    = hasReply ? wordCount <= turn.expectWords : true
    const patternOk  = turn.expectReply ? (result ? turn.expectReply.test(result) : false) : hasReply

    const pass = intentOk && (hasReply || result === null) && wordsOk && patternOk

    record(
      SUITE,
      turnId,
      `${scenario.name} — turn ${i + 1} (${turn.expectIntent})`,
      i === 0 ? 'HIGH' : 'MEDIUM',
      pass ? 'PASS' : 'FAIL',
      `intent=${turn.expectIntent} ≤${turn.expectWords}w${turn.expectReply ? ` match:/${turn.expectReply.source}/` : ''}`,
      `intent=${intent} words=${wordCount} reply="${(result ?? 'null').slice(0, 50)}"`,
      `"${turn.transcript.slice(0, 50)}" in ${ms.toFixed(0)}ms`,
      ms,
    )
  }
}

// ── SCN-001: Price objection → escalation → close ─────────────────────────

async function testPriceToClose(): Promise<void> {
  await runScenario({
    id:   'SCN-001',
    name: 'Price objection → close',
    mode: 'negotiation',
    turns: [
      {
        transcript:   "we can't afford this right now",
        expectIntent: 'PRICE_OBJECTION',
        expectReply:  /budget|invest|value|cost|afford/i,
        expectWords:  15,
      },
      {
        transcript:   "the price is just too high for our budget",
        expectIntent: 'PRICE_OBJECTION',
        expectReply:  /flexible|plan|option|work|payment|roi/i,
        expectWords:  15,
      },
      {
        transcript:   "ok let's move forward, send me the contract",
        expectIntent: 'AGREEMENT',
        expectReply:  null,
        expectWords:  20,
      },
    ],
  })
}

// ── SCN-002: Authority objection → reframe → agreement ────────────────────

async function testAuthorityToAgreement(): Promise<void> {
  await runScenario({
    id:   'SCN-002',
    name: 'Authority objection → agreement',
    mode: 'negotiation',
    turns: [
      {
        transcript:   "i need to check with my business partner first",
        expectIntent: 'AUTHORITY',
        expectReply:  /partner|together|decision|team|involve/i,
        expectWords:  15,
      },
      {
        transcript:   "my wife handles our finances so she needs to be involved",
        expectIntent: 'AUTHORITY',
        expectReply:  /include|invite|loop|reach|call/i,
        expectWords:  15,
      },
      {
        transcript:   "sounds good let's do it",
        expectIntent: 'AGREEMENT',
        expectReply:  null,
        expectWords:  20,
      },
    ],
  })
}

// ── SCN-003: Stalling → urgency → follow-up capture ───────────────────────

async function testStallToUrgency(): Promise<void> {
  await runScenario({
    id:   'SCN-003',
    name: 'Stalling → urgency injection',
    mode: 'negotiation',
    turns: [
      {
        transcript:   "i need to think about it",
        expectIntent: 'STALLING',
        expectReply:  /think|concern|hesitat|hold|back/i,
        expectWords:  15,
      },
      {
        transcript:   "let me get back to you next week",
        expectIntent: 'STALLING',
        expectReply:  /deadline|spot|limited|available|today/i,
        expectWords:  15,
      },
    ],
  })
}

// ── SCN-004: Competitor mention → differentiation ─────────────────────────

async function testCompetitorDifferentiation(): Promise<void> {
  await runScenario({
    id:   'SCN-004',
    name: 'Competitor mention → differentiation',
    mode: 'negotiation',
    turns: [
      {
        transcript:   "we already use servicetitan and it works fine",
        expectIntent: 'COMPETITOR',
        expectReply:  /differ|unique|offer|feature|switch|compan|better/i,
        expectWords:  15,
      },
      {
        transcript:   "why would i switch from jobber",
        expectIntent: 'COMPETITOR',
        expectReply:  /reason|advantage|value|support|migrat/i,
        expectWords:  15,
      },
    ],
  })
}

// ── SCN-005: Question → discovery → proposal ──────────────────────────────

async function testDiscoveryToProposal(): Promise<void> {
  await runScenario({
    id:   'SCN-005',
    name: 'Question → discovery → proposal',
    mode: 'negotiation',
    turns: [
      {
        transcript:   "what is the pricing for your service?",
        expectIntent: 'QUESTION',
        expectReply:  null,
        expectWords:  20,
      },
      {
        transcript:   "how does it work exactly?",
        expectIntent: 'QUESTION',
        expectReply:  null,
        expectWords:  20,
      },
      {
        transcript:   "that sounds interesting, we might be open to it",
        expectIntent: 'AGREEMENT',
        expectReply:  null,
        expectWords:  20,
      },
    ],
  })
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  section('SUITE 8 — End-to-End Scenario Replays')

  await testPriceToClose()
  await testAuthorityToAgreement()
  await testStallToUrgency()
  await testCompetitorDifferentiation()
  await testDiscoveryToProposal()
}
