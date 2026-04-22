/**
 * playbook.ts
 * Execution engine. Pressure system with 4-tier escalation per play.
 *
 * Tier 0 = probe     — soft, open question
 * Tier 1 = isolate   — narrow the objection
 * Tier 2 = pressure  — remove exits
 * Tier 3 = corner    — binary, commit or walk
 *
 * Key invariants:
 *   - Tier state is ISOLATED per play key (firing stall doesn't advance price)
 *   - Tier 0 ALWAYS ends with a question mark (probe = soft/open)
 *   - Tier 3 ALWAYS has binary=true (corners the prospect)
 *   - FORCED_RESPONSE_EVENTS never return null
 *   - resetTiers() restores ALL play states to tier 0
 *
 * Perf: SIGNALS array is pre-sorted by priority descending at module load.
 * matchPlaybook() iterates the pre-sorted array directly — no per-call sort.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { EventType } from './decision.js'

// ── Types ──────────────────────────────────────────────────────────────────

export type PlaybookKey =
  | 'PRICE_OBJECTION'
  | 'DISCOUNT_REQUEST'
  | 'COMPETITOR_LOCKIN'
  | 'MANUAL_TRACKING'
  | 'AUTHORITY_BLOCK'
  | 'STALL_GENERIC'
  | 'TIMING_DEFLECTION'
  | 'BUDGET_FROZEN'
  | 'INFO_REQUEST'
  | 'AGREEMENT_SIGNAL'
  | 'PANIC_LOSING'
  | 'COMP_ANCHOR'
  | 'WEAK_ANSWER'

export type EscalationTier = 0 | 1 | 2 | 3

export type PressureLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface EscalationStep {
  tier: EscalationTier
  label: string        // probe | isolate | pressure | corner
  response: string     // what ARIA says
  silence: boolean     // true = stop talking after this line
  binary: boolean      // true = forces yes/no from prospect
}

export interface Play {
  key: PlaybookKey
  pressureLevel: PressureLevel
  mustRespond: boolean
  steps: EscalationStep[]
}

// ── Instrumentation ────────────────────────────────────────────────────────

const ARIA_DIR   = path.join(os.homedir(), '.aria')
const PLAYS_FILE = path.join(ARIA_DIR, 'plays.jsonl')

interface PlayFire {
  ts: number
  key: PlaybookKey
  tier: EscalationTier
  response: string
  silence: boolean
  binary: boolean
}

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function logPlayFire(fire: PlayFire) {
  ensureDir()
  try {
    fs.appendFileSync(PLAYS_FILE, JSON.stringify(fire) + '\n')
  } catch (e) { console.error('[PLAYBOOK] logPlayFire failed:', e) }
}

// ── Escalation tier tracking ───────────────────────────────────────────────
// CRITICAL: Each play has its OWN isolated fire counter.
// Firing STALL_GENERIC 3x does NOT advance PRICE_OBJECTION tier.

const tierState: Map<PlaybookKey, number> = new Map()

export function getNextTier(key: PlaybookKey): EscalationTier {
  const current = tierState.get(key) ?? 0
  tierState.set(key, current + 1)
  // Cap at 3 — stays at tier 3 (FORCED corner) until reset
  return Math.min(current, 3) as EscalationTier
}

export function resetTiers(): void {
  tierState.clear()
}

export function getTierState(): Record<string, number> {
  const out: Record<string, number> = {}
  tierState.forEach((v, k) => { out[k] = v })
  return out
}

// ── The Playbook ──────────────────────────────────────────────────────────

export const PLAYBOOK: Record<PlaybookKey, Play> = {

  // ── Price objection ───────────────────────────────────────────────────────
  PRICE_OBJECTION: {
    key: 'PRICE_OBJECTION',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        // Tier 0 MUST end with "?" — it's a soft open probe
        response: 'What part of the price concerns you most — the total or the monthly?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'So if the price was not the issue, you would move forward today?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Every week without this costs you more than the monthly fee. That math does not get better.',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Simple question — is price the real reason, or is there something else stopping you?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Discount / trial request ──────────────────────────────────────────────
  DISCOUNT_REQUEST: {
    key: 'DISCOUNT_REQUEST',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'Price is not flexible. What value are you not seeing that makes this feel like too much?',
        silence: false,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'If I could show you this pays for itself in thirty days, would that change things?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'We do not discount. What we do is solve the problem at the price that reflects what it is worth.',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Are you negotiating price because you want a deal, or because you are not convinced this works? Tell me which.',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Competitor lock-in ────────────────────────────────────────────────────
  COMPETITOR_LOCKIN: {
    key: 'COMPETITOR_LOCKIN',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'What is the one thing your current system does not handle well?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'So the system works — but that one problem has been there how long?',
        silence: true,
        binary: false,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Three years with the same gap is not loyalty. It is the cost of inertia.',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Honest question — are you staying because it works, or because switching feels like work?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Manual tracking ───────────────────────────────────────────────────────
  MANUAL_TRACKING: {
    key: 'MANUAL_TRACKING',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'When did something last slip through doing it manually?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'How much did that slip cost you — in time, money, or the customer?',
        silence: true,
        binary: false,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Manual works until it does not. And when it breaks, it breaks at the worst moment.',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Is "it works fine" true, or is it just what you say because fixing it feels like effort?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Authority block ───────────────────────────────────────────────────────
  AUTHORITY_BLOCK: {
    key: 'AUTHORITY_BLOCK',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'What does she need to see to feel good about this?',
        silence: false,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'If she says yes, are you ready to move forward this week?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Can we get her on a call for fifteen minutes? I want to answer her questions directly.',
        silence: false,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Is this actually about her approval, or are you still deciding yourself?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Stall ─────────────────────────────────────────────────────────────────
  STALL_GENERIC: {
    key: 'STALL_GENERIC',
    pressureLevel: 'MEDIUM',
    mustRespond: false,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'What specifically needs to happen before you can decide?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'Is the delay about the decision itself, or something about the offer?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'The problem you have right now does not pause while you think. What is the cost of another week?',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Are you going to move forward, yes or no? I would rather know now.',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Timing deflection ─────────────────────────────────────────────────────
  TIMING_DEFLECTION: {
    key: 'TIMING_DEFLECTION',
    pressureLevel: 'MEDIUM',
    mustRespond: false,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'What changes next quarter that does not exist right now?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'If timing is the only issue, can we agree on terms now and start then?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Every month you delay this is a month your competitor is not delaying.',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Next quarter is not a plan. Give me a specific date or tell me this is a no.',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Budget frozen ─────────────────────────────────────────────────────────
  BUDGET_FROZEN: {
    key: 'BUDGET_FROZEN',
    pressureLevel: 'MEDIUM',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'When exactly does the budget reset?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'If we lock in terms now and start billing when it resets, does that work?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'What is the cost of the problem continuing until the budget opens?',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Budget is a reason, not a wall. Who has the authority to make an exception for something that pays for itself?',
        silence: true,
        binary: false,
      },
    ],
  },

  // ── Info request ──────────────────────────────────────────────────────────
  INFO_REQUEST: {
    key: 'INFO_REQUEST',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'I will send it today. When specifically can you review it — Thursday morning?',
        silence: false,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'What in the info will make or break the decision for you?',
        silence: true,
        binary: false,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Info goes out today. If it answers your questions, are you ready to move that same week?',
        silence: true,
        binary: true,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Is requesting info the path to yes, or the path to a polite no?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Agreement signal ──────────────────────────────────────────────────────
  AGREEMENT_SIGNAL: {
    key: 'AGREEMENT_SIGNAL',
    pressureLevel: 'CRITICAL',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'Good. What does your timeline look like to get started?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'Contract goes out today. Who signs on your end?',
        silence: false,
        binary: false,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'I can have everything ready by end of day. What do you need from me to make that happen?',
        silence: false,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Let us close this now. I will send the contract, you sign this week — yes?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Panic — deal collapsing ───────────────────────────────────────────────
  PANIC_LOSING: {
    key: 'PANIC_LOSING',
    pressureLevel: 'CRITICAL',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'Before you close this out — what was the deciding factor?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'Is this final, or is there one thing I could address that reopens it?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'You signed with them — but the problem that brought you here still exists. When does that matter?',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'I respect it. One last question — if their solution does not work in ninety days, will you call me?',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Comp anchor ───────────────────────────────────────────────────────────
  COMP_ANCHOR: {
    key: 'COMP_ANCHOR',
    pressureLevel: 'HIGH',
    mustRespond: true,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'Is that number based on base only, or total package including equity?',
        silence: true,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'If the total comp hit your number including equity and upside, would base matter less?',
        silence: true,
        binary: true,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Here is what the role is worth and why. The number is built around what you will actually produce.',
        silence: true,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Are you negotiating because the number is wrong, or because you always negotiate? Tell me which.',
        silence: true,
        binary: true,
      },
    ],
  },

  // ── Weak answer ───────────────────────────────────────────────────────────
  WEAK_ANSWER: {
    key: 'WEAK_ANSWER',
    pressureLevel: 'MEDIUM',
    mustRespond: false,
    steps: [
      {
        tier: 0,
        label: 'probe',
        response: 'Lead with the result. What was the specific outcome?',
        silence: false,
        binary: false,
      },
      {
        tier: 1,
        label: 'isolate',
        response: 'Give me one number that proves that point.',
        silence: true,
        binary: false,
      },
      {
        tier: 2,
        label: 'pressure',
        response: 'Vague answers lose. State the conclusion first, then the story.',
        silence: false,
        binary: false,
      },
      {
        tier: 3,
        label: 'corner',
        response: 'Say it in one sentence. If you cannot, you do not own the answer yet.',
        silence: false,
        binary: false,
      },
    ],
  },
}

// ── Timeline control plays ────────────────────────────────────────────────

export interface TimelinePlay {
  key: string
  trigger: RegExp
  response: string
  silence: boolean
}

export const TIMELINE_PLAYS: TimelinePlay[] = [
  {
    key: 'RISK_REVERSAL',
    trigger: /not sure|taking a risk|worried|nervous|guarantee/i,
    response: 'If this does not pay for itself in thirty days, tell me and we fix it. That is the deal.',
    silence: false,
  },
  {
    key: 'LOSS_FRAMING',
    trigger: /maybe later|next month|think about it|not urgent/i,
    response: 'Every week this sits costs you X. The delay is not free.',
    silence: true,
  },
  {
    key: 'DEADLINE_COMPRESSION',
    trigger: /whenever|no rush|whenever works|take your time/i,
    response: 'If we do not start this week, your next realistic window is months out. That is the real timeline.',
    silence: true,
  },
  {
    key: 'MICRO_COMMITMENT',
    trigger: /i guess|maybe|probably|might/i,
    response: 'Before we go further — are you open to solving this problem, yes or no?',
    silence: true,
  },
  {
    key: 'OPPORTUNITY_COST',
    trigger: /not a priority|other things|busy right now/i,
    response: 'What is the cost of your current problem at the end of this quarter if nothing changes?',
    silence: true,
  },
]

// ── Signal detection ──────────────────────────────────────────────────────
// Pre-sorted by priority descending at module load.
// matchPlaybook() iterates directly — no per-call sort overhead.

interface PlaybookSignal {
  pattern: RegExp
  key: PlaybookKey
  priority: number
}

const SIGNALS_RAW: PlaybookSignal[] = [
  // Closing / panic — highest priority
  { pattern: /let's do it|send me the contract|we're ready|we're in|i'll take it|i'm in\b|when do we start|move forward|could really work for us|yeah.*i am in|ready to sign|close this week/i,   key: 'AGREEMENT_SIGNAL',   priority: 12 },
  { pattern: /already signed|signed with them|went with|decided.*instead|chose.*over you|decided to go with.*instead/i,                                                                             key: 'PANIC_LOSING',       priority: 12 },

  // Money — second highest
  { pattern: /too expensive|can't afford|too much|out of budget|not worth|switching cost|fifteen hundred.*too|upfront.*too|too much for a small|that is a lot\b|that's a lot\b|a lot for.*company|a lot for.*size|was not expecting that number|sticker shock|feels like a stretch|a stretch for.*budget|not sure.*get that value|fifteen hundred bucks is a lot|lot for us man|feels like too much/i,   key: 'PRICE_OBJECTION',    priority: 11 },
  { pattern: /discount|lower the price|any flexibility|can you do better|trial period|lower upfront|work with us on the price|come in lower|wiggle room|any chance.*wiggle|come down at all/i,     key: 'DISCOUNT_REQUEST',   priority: 11 },
  { pattern: /looking for.*range|in the range of|\$[\d,]+k? to \$[\d,]+k?|salary expectations|expecting.*\$[\d,]+|something in the range/i,                                                       key: 'COMP_ANCHOR',        priority: 11 },

  // Competitor / manual
  { pattern: /track.*manually|do it manually|works fine.*manual|we track everything manually|pen and paper|spreadsheet for that/i,                                                                  key: 'MANUAL_TRACKING',    priority: 10 },
  { pattern: /happy with.*current|been using.*\d+ years|already (use|have)|service.?titan|jobber|went with|signed with|chose.*instead|signed the paperwork with them/i,                           key: 'COMPETITOR_LOCKIN',  priority: 10 },

  // Authority
  { pattern: /talk to my (wife|husband|spouse)|she handles|he handles|my (wife|husband) (handles|manages)/i,                                                                                       key: 'AUTHORITY_BLOCK',    priority: 10 },
  { pattern: /check with my (team|boss|manager|ceo|cfo|partner|business partner)|need approval|not my (call|decision)|run it by|my business partner would need|partner.*weigh in|our team would need to align/i,   key: 'AUTHORITY_BLOCK',    priority: 10 },

  // Budget / timing
  { pattern: /budget is (frozen|gone|tight|limited)|no budget|budget.*doesn't allow|when budget resets|budget is tight/i,                                                                           key: 'BUDGET_FROZEN',      priority: 10 },
  { pattern: /next (quarter|year|month)|not right now|bad timing|reconnect next/i,                                                                                                                  key: 'TIMING_DEFLECTION',  priority: 9  },

  // Info / stall
  { pattern: /send me (more )?info|send.*details|email me|can you send|more information about what you offer|send me more/i,                                                                        key: 'INFO_REQUEST',       priority: 9  },
  { pattern: /need to think|think about it|get back to you|not (sure|ready)|let me consider|another offer|circle back|be in touch/i,                                                               key: 'STALL_GENERIC',      priority: 8  },

  // Weak answer
  { pattern: /i don't know|i guess|kind of|sort of|it depends|not really sure/i,                                                                                                                   key: 'WEAK_ANSWER',        priority: 6  },
]

// Pre-sort once at module load — highest priority first.
const SIGNALS: PlaybookSignal[] = [...SIGNALS_RAW].sort((a, b) => b.priority - a.priority)

// ── Match transcript to play ──────────────────────────────────────────────

export function matchPlaybook(transcript: string): Play | null {
  for (const signal of SIGNALS) {
    if (signal.pattern.test(transcript)) {
      return PLAYBOOK[signal.key]
    }
  }
  return null
}

// ── Execute play at current escalation tier ───────────────────────────────

export function executePlay(play: Play): string {
  const tier  = getNextTier(play.key)
  const step  = play.steps[tier]

  const fire: PlayFire = {
    ts:       Date.now(),
    key:      play.key,
    tier,
    response: step.response,
    silence:  step.silence,
    binary:   step.binary,
  }
  logPlayFire(fire)

  const silenceMarker = step.silence ? ' [SILENCE]' : ''
  console.log(`[PLAY] ${play.key} tier=${tier}/${step.label} binary=${step.binary}${silenceMarker}`)

  return step.response
}

// ── Match timeline play ───────────────────────────────────────────────────

export function matchTimelinePlay(transcript: string): TimelinePlay | null {
  for (const play of TIMELINE_PLAYS) {
    if (play.trigger.test(transcript)) return play
  }
  return null
}

// ── Forced response events — null never allowed ───────────────────────────

export const FORCED_RESPONSE_EVENTS: Set<EventType> = new Set([
  'PRICE_OBJECTION',
  'AGREEMENT',
  'COMPETITOR',
  'AUTHORITY',
  'OFFER_DISCUSS',
  'DEADLINE',
])

// ── Fallback responses for forced events with no play match ───────────────

const FORCED_FALLBACKS: Partial<Record<EventType, string>> = {
  PRICE_OBJECTION: 'What part of the price concerns you most?',
  AGREEMENT:       'Good. Who signs and what is the timeline?',
  COMPETITOR:      'What is the one thing your current system does not handle?',
  AUTHORITY:       'Who decides — can we get them on a call?',
  OFFER_DISCUSS:   'What would make this number feel right to you?',
  DEADLINE:        'What needs to happen before that date?',
}

export function getForcedFallback(event: EventType): string | null {
  return FORCED_FALLBACKS[event] ?? null
}

// ── Playbook analytics ────────────────────────────────────────────────────

export function getPlayStats(): Record<string, { fires: number; tiers: number[] }> {
  if (!fs.existsSync(PLAYS_FILE)) return {}
  try {
    const lines = fs.readFileSync(PLAYS_FILE, 'utf-8').trim().split('\n').filter(Boolean)
    const stats: Record<string, { fires: number; tiers: number[] }> = {}
    for (const line of lines) {
      const fire = JSON.parse(line) as PlayFire
      if (!stats[fire.key]) stats[fire.key] = { fires: 0, tiers: [] }
      stats[fire.key].fires++
      stats[fire.key].tiers.push(fire.tier)
    }
    return stats
  } catch (e) { console.error('[PLAYBOOK] getPlayStats failed:', e); return {} }
}

// ── Retention: prune plays older than maxAgeDays ──────────────────────────

export function pruneOldPlays(maxAgeDays = 30): void {
  if (!fs.existsSync(PLAYS_FILE)) return
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const lines = fs.readFileSync(PLAYS_FILE, 'utf-8').trim().split('\n').filter(Boolean)
    const kept = lines.filter(l => {
      try { return (JSON.parse(l) as PlayFire).ts > cutoff }
      catch { return false }
    })
    if (kept.length < lines.length) {
      fs.writeFileSync(PLAYS_FILE, kept.join('\n') + (kept.length ? '\n' : ''))
      console.log(`[PLAYBOOK] pruned ${lines.length - kept.length} old play records`)
    }
  } catch (e) { console.error('[PLAYBOOK] pruneOldPlays failed:', e) }
}