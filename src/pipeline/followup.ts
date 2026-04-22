import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { CONFIG } from '../config.js'

const ARIA_DIR = path.join(os.homedir(), '.aria')
const FOLLOWUPS_FILE = path.join(ARIA_DIR, 'followups.jsonl')

export type FollowUpStatus = 'pending' | 'sent' | 'dismissed'
export type FollowUpPriority = 'hot' | 'warm' | 'cold'

export interface FollowUpDraft {
  email: string | null
  text: string | null
}

export interface FollowUp {
  id: string
  created: number
  updated: number
  status: FollowUpStatus
  priority: FollowUpPriority
  trigger: string              // raw transcript that created this
  person: string | null        // who to follow up with
  suggestedAction: string      // e.g. "Follow up — send details"
  draft: FollowUpDraft | null  // auto-generated draft
  resurfaceAt: number
  resurfaced: number
  context: string | null
}

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): FollowUp[] {
  ensureDir()
  if (!fs.existsSync(FOLLOWUPS_FILE)) return []
  try {
    return fs.readFileSync(FOLLOWUPS_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as FollowUp)
  } catch (e) { console.error('[FOLLOWUP] loadAll failed:', e); return [] }
}

function saveAll(items: FollowUp[]) {
  ensureDir()
  fs.writeFileSync(FOLLOWUPS_FILE, items.map(i => JSON.stringify(i)).join('\n') + '\n')
}

function genId(): string {
  return `fu_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

// ── Detection signals ──────────────────────────────────────────────────────

interface FollowUpSignal {
  pattern: RegExp
  action: string
  delayHours: number
  priority: FollowUpPriority
}

const SIGNALS: FollowUpSignal[] = [
  // HOT — needs same-day follow-up
  { pattern: /(?:let's|let us)\s+(?:do it|move forward|get started|sign|close)/i,
    action: 'Follow up — confirm deal', delayHours: 2, priority: 'hot' },
  { pattern: /(?:sounds good|we're in|i'll take it|we're interested|move forward)/i,
    action: 'Follow up — confirm terms', delayHours: 2, priority: 'hot' },
  { pattern: /(?:email me|send me an?\s+(?:invite|calendar|meeting|contract|proposal))/i,
    action: 'Follow up — send invite', delayHours: 1, priority: 'hot' },
  { pattern: /(?:send (?:me|us|over|that|the)?\s*(?:more )?(?:info|details|pricing|proposal|contract|deck|link))/i,
    action: 'Follow up — send details', delayHours: 2, priority: 'hot' },
  { pattern: /(?:what(?:'s| is) (?:the )?(?:price|cost|pricing|rate))/i,
    action: 'Follow up — send pricing', delayHours: 2, priority: 'hot' },
  { pattern: /(?:can you (?:send|share|forward|drop))/i,
    action: 'Follow up — send requested info', delayHours: 2, priority: 'hot' },

  // WARM — 24-48h window
  { pattern: /(?:let's|let us|we should|we'll|we will)\s+(?:reconnect|connect|talk|chat|catch up|sync)/i,
    action: 'Follow up — schedule call', delayHours: 24, priority: 'warm' },
  { pattern: /(?:i'll|i will|we'll|we will)\s+get back (?:to you|with you)?/i,
    action: 'Follow up — check in', delayHours: 48, priority: 'warm' },
  { pattern: /(?:i'll|i will|we'll|we will)\s+(?:think about it|consider|review|look into|check)/i,
    action: 'Follow up — check in', delayHours: 48, priority: 'warm' },
  { pattern: /(?:need to (?:think|talk|discuss|review|check))/i,
    action: 'Follow up — re-engage', delayHours: 48, priority: 'warm' },
  { pattern: /(?:call|email|ping|reach out|talk)\s+(?:next week|tomorrow|friday|monday|in a few days)/i,
    action: 'Follow up — call scheduled', delayHours: 24, priority: 'warm' },
  { pattern: /(?:set up|schedule|book)\s+(?:a\s+)?(?:meeting|call|demo|lunch)/i,
    action: 'Follow up — schedule meeting', delayHours: 24, priority: 'warm' },
  { pattern: /(?:interested but|sounds interesting|could work|might work)/i,
    action: 'Follow up — re-engage', delayHours: 36, priority: 'warm' },
  { pattern: /(?:check with my|run it by|need approval from|ask my)/i,
    action: 'Follow up — decision pending', delayHours: 48, priority: 'warm' },

  // COLD — longer window, lower urgency
  { pattern: /(?:not (?:sure|ready) yet|need (?:more )?time|maybe later)/i,
    action: 'Follow up — re-engage', delayHours: 72, priority: 'cold' },
  { pattern: /(?:next (?:quarter|month|year)|not right now|bad timing)/i,
    action: 'Follow up — re-engage later', delayHours: 168, priority: 'cold' },
  { pattern: /(?:keep in touch|stay in touch|let's stay connected)/i,
    action: 'Follow up — nurture', delayHours: 96, priority: 'cold' },
  { pattern: /(?:we'll see|we'll think about it|no promises)/i,
    action: 'Follow up — re-engage', delayHours: 72, priority: 'cold' },
  { pattern: /(?:budget (?:is )?(?:tight|frozen|limited|gone))/i,
    action: 'Follow up — when budget resets', delayHours: 168, priority: 'cold' },
  { pattern: /(?:not my (?:call|decision)|have to ask)/i,
    action: 'Follow up — decision pending', delayHours: 72, priority: 'cold' },
  { pattern: /(?:send|forward|email)\s+(?:me|us|over)?\s*(?:the\s+)?(?:contract|proposal|agreement)/i,
    action: 'Follow up — send contract', delayHours: 1, priority: 'hot' },
]

// ── Extract person ─────────────────────────────────────────────────────────

function extractPerson(transcript: string): string | null {
  const m = transcript.match(
    /(?:with|to|for|from|email|call|ping|message)\s+([A-Z][a-z]{1,14}(?:\s+[A-Z][a-z]{1,14})?)/
  )
  return m?.[1] ?? null
}

// ── Draft generation via Ollama ────────────────────────────────────────────

async function generateDraft(
  transcript: string,
  action: string,
  person: string | null,
  priority: FollowUpPriority
): Promise<FollowUpDraft> {
  const personLine = person ? `The person to follow up with is ${person}.` : ''
  const urgencyLine = priority === 'hot' ? 'This is urgent — same day.' : priority === 'warm' ? 'This should go out within 48 hours.' : 'No rush — within the week.'

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          {
            role: 'system',
            content: `You are ARIA, a personal AI assistant. Generate a follow-up message draft.
Return ONLY valid JSON in this exact format, nothing else:
{"email":"<email body, 3-5 sentences, professional but direct, no subject line>","text":"<text/SMS version, 1-2 sentences, casual>"}
No preamble. No explanation. Just the JSON.`,
          },
          {
            role: 'user',
            content: `Context: "${transcript.slice(0, 200)}"
Action needed: ${action}
${personLine}
${urgencyLine}
Generate the draft.`,
          },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_DRAFT_TIMEOUT_MS),
    })

    const data = await res.json() as { message: { content: string } }
    const raw = data.message.content.trim().replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(raw) as FollowUpDraft
    return parsed
  } catch (e) {
    console.error('[FOLLOWUP] generateDraft failed, using template fallback:', e)
    // fallback — basic template
    const name = person ?? 'there'
    return {
      email: `Hi ${name},\n\nFollowing up from our conversation. ${action.replace('Follow up — ', '')} — wanted to make sure this doesn't fall through the cracks.\n\nLet me know how you'd like to proceed.\n\nTanay`,
      text: `Hey ${name}, following up from earlier. ${action.replace('Follow up — ', '')} — let me know!`,
    }
  }
}

// ── Detect ─────────────────────────────────────────────────────────────────

export interface DetectedFollowUp {
  action: string
  delayHours: number
  priority: FollowUpPriority
  person: string | null
}

export function detectFollowUp(transcript: string): DetectedFollowUp | null {
  const t = transcript.slice(0, CONFIG.MAX_TRANSCRIPT_CHARS)
  for (const signal of SIGNALS) {
    if (signal.pattern.test(t)) {
      return {
        action: signal.action,
        delayHours: signal.delayHours,
        priority: signal.priority,
        person: extractPerson(transcript),
      }
    }
  }
  return null
}

// ── Create ─────────────────────────────────────────────────────────────────

export async function createFollowUp(
  transcript: string,
  detected: DetectedFollowUp,
  context?: string
): Promise<FollowUp> {
  // Create and save immediately — no draft yet
  const fu: FollowUp = {
    id: genId(),
    created: Date.now(),
    updated: Date.now(),
    status: 'pending',
    priority: detected.priority,
    trigger: transcript,
    person: detected.person,
    suggestedAction: detected.action,
    draft: null,  // start null
    resurfaceAt: Date.now() + detected.delayHours * 3600 * 1000,
    resurfaced: 0,
    context: context ?? null,
  }

  const all = loadAll()
  all.push(fu)
  saveAll(all)

  // Generate draft async — don't block
  generateDraft(transcript, detected.action, detected.person, detected.priority)
    .then(draft => {
      const latest = loadAll()
      const target = latest.find(f => f.id === fu.id)
      if (target) { target.draft = draft; saveAll(latest) }
    })
    .catch(() => {})

  console.log(`[FOLLOWUP] ${detected.priority.toUpperCase()} — "${fu.suggestedAction}"${fu.person ? ` re: ${fu.person}` : ''} — draft generating async — resurface in ${detected.delayHours}h`)
  return fu
}

// ── Resurface ──────────────────────────────────────────────────────────────

const MAX_RESURFACES = 3

export function getDueFollowUps(): FollowUp[] {
  const now = Date.now()
  return loadAll()
    .filter(f => f.status === 'pending' && f.resurfaceAt <= now && f.resurfaced < MAX_RESURFACES)
    .sort((a, b) => {
      const p = { hot: 0, warm: 1, cold: 2 }
      return p[a.priority] - p[b.priority]
    })
}

export function markFollowUpResurfaced(id: string): void {
  const all = loadAll()
  const f = all.find(f => f.id === id)
  if (f) {
    f.resurfaced += 1
    // hot resurfaces faster
    const intervalH = f.priority === 'hot' ? 2 : f.priority === 'warm' ? 8 : 24
    f.resurfaceAt = Date.now() + intervalH * 3600 * 1000
    f.updated = Date.now()
  }
  saveAll(all)
}

export function dismissFollowUp(id: string): void {
  const all = loadAll()
  const f = all.find(f => f.id === id)
  if (f) { f.status = 'dismissed'; f.updated = Date.now() }
  saveAll(all)
}

export function markFollowUpSent(id: string): void {
  const all = loadAll()
  const f = all.find(f => f.id === id)
  if (f) { f.status = 'sent'; f.updated = Date.now() }
  saveAll(all)
}

// ── Get draft by person or latest ─────────────────────────────────────────

export function getDraft(personOrId?: string): FollowUp | null {
  const all = loadAll().filter(f => f.status === 'pending' && f.draft)
  if (!all.length) return null
  if (!personOrId) return all[all.length - 1]
  return all.find(f =>
    f.id === personOrId ||
    f.person?.toLowerCase().includes(personOrId.toLowerCase())
  ) ?? all[all.length - 1]
}

// ── Resurface announcement (hot = read draft, warm/cold = announce only) ──

export function getResurfaceMessage(fu: FollowUp): string {
  const person = fu.person ? ` — ${fu.person}` : ''
  if (fu.priority === 'hot' && fu.draft?.text) {
    return `${fu.suggestedAction}${person}. Draft: ${fu.draft.text}`
  }
  return `${fu.suggestedAction}${person}. Draft ready.`
}

// ── Context for ARIA prompt ───────────────────────────────────────────────

export function getFollowUpContext(): string {
  const pending = loadAll()
    .filter(f => f.status === 'pending')
    .sort((a, b) => { const p = { hot: 0, warm: 1, cold: 2 }; return p[a.priority] - p[b.priority] })
    .slice(0, 5)
  if (!pending.length) return ''
  return `Pending follow-ups:\n${pending.map(f =>
    `- [${f.priority.toUpperCase()}] ${f.suggestedAction}${f.person ? ` (re: ${f.person})` : ''}${f.draft ? ' — draft ready' : ''}`
  ).join('\n')}`
}