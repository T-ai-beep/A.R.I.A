/**
 * dailyRecap.ts — End-of-day intelligence summary
 *
 * Pulls all captures + sessions from the last 24h (or a specific date),
 * synthesizes patterns, surfaces what needs follow-up, and gives
 * a narrative of the day.
 *
 * Output:
 *   - Day narrative (what happened, who you talked to, key moments)
 *   - Unresolved items (stalls, pending decisions, follow-ups due)
 *   - Win/loss signals (agreements, lost deals)
 *   - Offer summary (what dollar amounts came up)
 *   - People summary (who showed up most)
 *   - Pressure items due
 *   - Suggested next actions
 *
 * Run on-demand or schedule via cron:
 *   npx tsx src/memory/dailyRecap.ts
 *   npx tsx src/memory/dailyRecap.ts --date=2025-04-17
 */

import { CONFIG }                          from '../config.js'
import { getByDate, getCaptureSummaryForDate } from '../capture/captureStore.js'
import { recallEpisodes }                  from '../pipeline/epsodic.js'
import { getDueFollowUps }                 from '../pipeline/followup.js'
import { getDueItems }                     from '../pipeline/pressure.js'
import { getAllPeople }                    from '../pipeline/people.js'
import { getStats }                        from '../pipeline/decisionLog.js'
import * as fs                             from 'fs'
import * as path                           from 'path'
import * as os                             from 'os'

const ARIA_DIR     = path.join(os.homedir(), '.aria')
const RECAPS_FILE  = path.join(ARIA_DIR, 'recaps.jsonl')

// ── Types ──────────────────────────────────────────────────────────────────

export interface DayStats {
  date:          string
  totalCaptures: number
  totalWords:    number
  uniquePeople:  string[]
  topIntents:    { intent: string; count: number }[]
  offers:        number[]
  agreements:    number
  stalls:        number
  competitors:   number
  activeHours:   number[]
}

export interface RecapItem {
  priority: 'urgent' | 'high' | 'medium' | 'low'
  type:     'followup' | 'pressure' | 'decision' | 'deal'
  text:     string
  person:   string | null
}

export interface DailyRecap {
  date:           string
  generatedAt:    number
  narrative:      string
  stats:          DayStats
  unresolvedItems: RecapItem[]
  wins:           string[]
  losses:         string[]
  topPeople:      { name: string; mentions: number; lastIntent: string | null }[]
  suggestedActions: string[]
  rawSummary:     string        // one-liner for quick display
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getDateString(date?: Date): string {
  const d = date ?? new Date()
  return d.toISOString().slice(0, 10)
}

function getDateRange(date: string): { start: number; end: number } {
  const start = new Date(date + 'T00:00:00').getTime()
  const end   = new Date(date + 'T23:59:59').getTime()
  return { start, end }
}

// ── Build day stats ────────────────────────────────────────────────────────

async function buildDayStats(date: string): Promise<DayStats> {
  const captures  = getByDate(date)
  const { start, end } = getDateRange(date)

  // Intents from episodic
  const episodes = await recallEpisodes('', 100, { minImportance: 0.0 })
  const dayEps   = episodes.filter(e => e.time >= start && e.time <= end)

  // Count intents
  const intentCounts: Record<string, number> = {}
  for (const ep of dayEps) {
    for (const tag of ep.tags) {
      intentCounts[tag] = (intentCounts[tag] ?? 0) + 1
    }
  }
  const topIntents = Object.entries(intentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([intent, count]) => ({ intent, count }))

  // People mentioned
  const people       = getAllPeople()
  const recentPeople = people.filter(p => p.lastSeen >= start && p.lastSeen <= end)
  const uniquePeople = recentPeople.map(p => p.displayName)

  // Offers from captures
  const offerPattern = /\$\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|million|m\b)?/gi
  const offers: number[] = []
  for (const cap of captures) {
    let m: RegExpExecArray | null
    while ((m = offerPattern.exec(cap.transcript)) !== null) {
      const raw  = parseFloat(m[1].replace(/,/g, ''))
      const unit = (m[2] ?? '').toLowerCase()
      let val    = raw
      if (unit === 'k' || unit === 'thousand') val = raw * 1000
      if (unit === 'million' || unit === 'm')  val = raw * 1_000_000
      if (val >= 100) offers.push(val) // filter out noise
    }
  }

  // Count signal types
  const agreements  = dayEps.filter(e => e.tags.includes('agreement') || e.type === 'agreement').length
  const stalls      = captures.filter(c => /circle back|need to think|get back|not ready/i.test(c.transcript)).length
  const competitors = captures.filter(c => /servicetitan|jobber|housecall|competitor/i.test(c.transcript)).length

  // Active hours
  const activeHours = [...new Set(captures.map(c => c.hour))].sort((a, b) => a - b)

  return {
    date,
    totalCaptures: captures.length,
    totalWords:    captures.reduce((s, c) => s + c.wordCount, 0),
    uniquePeople,
    topIntents,
    offers:        [...new Set(offers)],
    agreements,
    stalls,
    competitors,
    activeHours,
  }
}

// ── Build unresolved items ────────────────────────────────────────────────

async function buildUnresolvedItems(): Promise<RecapItem[]> {
  const items: RecapItem[] = []

  // Due follow-ups
  const followUps = getDueFollowUps()
  for (const fu of followUps.slice(0, 5)) {
    items.push({
      priority: fu.priority === 'hot' ? 'urgent' : fu.priority === 'warm' ? 'high' : 'medium',
      type:     'followup',
      text:     fu.suggestedAction,
      person:   fu.person,
    })
  }

  // Pressure items
  const pressureItems = getDueItems(true)
  for (const p of pressureItems.slice(0, 5)) {
    items.push({
      priority: p.priority === 'hot' || p.priority === 'high' ? 'urgent' : 'high',
      type:     'pressure',
      text:     p.description,
      person:   p.person,
    })
  }

  return items.sort((a, b) => {
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 }
    return rank[a.priority] - rank[b.priority]
  })
}

// ── Build wins and losses ─────────────────────────────────────────────────

async function buildWinsLosses(date: string): Promise<{ wins: string[]; losses: string[] }> {
  const { start, end } = getDateRange(date)
  const episodes = await recallEpisodes('agreement deal close', 20)
  const dayEps   = episodes.filter(e => e.time >= start && e.time <= end)

  const wins:   string[] = []
  const losses: string[] = []

  for (const ep of dayEps) {
    if (ep.outcome === 'won' || ep.type === 'agreement') {
      wins.push(ep.object.slice(0, 80) + (ep.person ? ` (${ep.person})` : ''))
    }
    if (ep.outcome === 'lost') {
      losses.push(ep.object.slice(0, 80) + (ep.person ? ` (${ep.person})` : ''))
    }
  }

  return { wins, losses }
}

// ── LLM narrative ─────────────────────────────────────────────────────────

async function generateNarrative(
  date:   string,
  stats:  DayStats,
  unresolved: RecapItem[]
): Promise<{ narrative: string; actions: string[] }> {

  const captureSummary = getCaptureSummaryForDate(date)

  const prompt = `
Date: ${date}
Captures: ${stats.totalCaptures}, Words: ${stats.totalWords}
People: ${stats.uniquePeople.join(', ') || 'none recorded'}
Offers discussed: ${stats.offers.length ? stats.offers.map(o => '$' + o.toLocaleString()).join(', ') : 'none'}
Agreements: ${stats.agreements}, Stalls: ${stats.stalls}, Competitor mentions: ${stats.competitors}
Active hours: ${stats.activeHours.map(h => `${h}:00`).join(', ') || 'n/a'}
Top topics: ${stats.topIntents.map(t => `${t.intent}(${t.count})`).join(', ') || 'general'}
Unresolved: ${unresolved.slice(0, 3).map(i => i.text).join('; ') || 'none'}
${captureSummary}
`.trim()

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  CONFIG.OLLAMA_MODEL,
        stream: false,
        messages: [
          {
            role:    'system',
            content: `You are generating a daily recap for Tanay's ARIA system.
Return ONLY valid JSON:
{
  "narrative": "<3-4 sentence narrative of the day: what happened, key moments, patterns>",
  "actions": ["<action 1>", "<action 2>", "<action 3>"]
}
Be specific. Use names, dollar amounts, and intents from the data. No preamble. Just JSON.`,
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_RECAP_TIMEOUT_MS),
    })
    const data  = await res.json() as { message: { content: string } }
    const raw   = data.message.content.trim().replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(raw)
    return {
      narrative: parsed.narrative ?? 'No narrative generated.',
      actions:   parsed.actions   ?? [],
    }
  } catch {
    // Fallback narrative
    const narrative = stats.totalCaptures === 0
      ? `Quiet day on ${date} — no captures recorded.`
      : `${date}: ${stats.totalCaptures} captures across ${stats.activeHours.length} hours. ` +
        `${stats.uniquePeople.length ? `Talked with ${stats.uniquePeople.slice(0, 2).join(' and ')}.` : ''}` +
        `${stats.agreements ? ` ${stats.agreements} agreement signal(s).` : ''}` +
        `${stats.stalls ? ` ${stats.stalls} stall(s) detected.` : ''}`
    return {
      narrative,
      actions: unresolved.slice(0, 3).map(i => i.text),
    }
  }
}

// ── Build top people ───────────────────────────────────────────────────────

function buildTopPeople(date: string): { name: string; mentions: number; lastIntent: string | null }[] {
  const { start, end } = getDateRange(date)
  const people = getAllPeople()
    .filter(p => p.lastSeen >= start && p.lastSeen <= end)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 5)

  return people.map(p => ({
    name:       p.displayName,
    mentions:   p.mentions,
    lastIntent: p.lastIntent,
  }))
}

// ── Main recap builder ────────────────────────────────────────────────────

export async function buildDailyRecap(date?: string): Promise<DailyRecap> {
  const targetDate = date ?? getDateString()

  console.log(`[RECAP] building recap for ${targetDate}...`)

  const [stats, unresolved, { wins, losses }] = await Promise.all([
    buildDayStats(targetDate),
    buildUnresolvedItems(),
    buildWinsLosses(targetDate),
  ])

  const { narrative, actions } = await generateNarrative(targetDate, stats, unresolved)

  const topPeople = buildTopPeople(targetDate)

  const rawSummary = stats.totalCaptures === 0
    ? `${targetDate}: quiet day`
    : `${targetDate}: ${stats.totalCaptures} captures, ${stats.uniquePeople.length} people, ` +
      `${wins.length} wins, ${unresolved.filter(i => i.priority === 'urgent').length} urgent items`

  const recap: DailyRecap = {
    date:             targetDate,
    generatedAt:      Date.now(),
    narrative,
    stats,
    unresolvedItems:  unresolved,
    wins,
    losses,
    topPeople,
    suggestedActions: actions,
    rawSummary,
  }

  // Persist
  saveRecap(recap)

  return recap
}

// ── Persistence ────────────────────────────────────────────────────────────

function saveRecap(recap: DailyRecap): void {
  try {
    if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
    fs.appendFileSync(RECAPS_FILE, JSON.stringify(recap) + '\n')
  } catch (e) { console.error('[RECAP] saveRecap failed:', e) }
}

export function loadRecaps(limit = 30): DailyRecap[] {
  if (!fs.existsSync(RECAPS_FILE)) return []
  try {
    return fs.readFileSync(RECAPS_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as DailyRecap)
      .slice(-limit)
      .reverse()
  } catch (e) { console.error('[RECAP] loadRecaps parse failed:', e); return [] }
}

export function getRecapForDate(date: string): DailyRecap | null {
  return loadRecaps(60).find(r => r.date === date) ?? null
}

// ── Pretty print ───────────────────────────────────────────────────────────

export function printRecap(recap: DailyRecap): void {
  const sep = '═'.repeat(60)
  console.log(`\n${sep}`)
  console.log(`  DAILY RECAP — ${recap.date}`)
  console.log(sep)

  console.log(`\n  ${recap.narrative}\n`)

  if (recap.stats.uniquePeople.length) {
    console.log(`  PEOPLE: ${recap.stats.uniquePeople.join(', ')}`)
  }
  if (recap.stats.offers.length) {
    console.log(`  OFFERS: ${recap.stats.offers.map(o => '$' + o.toLocaleString()).join(', ')}`)
  }

  console.log(`  STATS:  ${recap.stats.totalCaptures} captures · ${recap.stats.agreements} agreements · ${recap.stats.stalls} stalls · ${recap.stats.competitors} competitor mentions`)

  if (recap.wins.length) {
    console.log(`\n  ✅ WINS:`)
    recap.wins.forEach(w => console.log(`    — ${w}`))
  }
  if (recap.losses.length) {
    console.log(`\n  ❌ LOSSES:`)
    recap.losses.forEach(l => console.log(`    — ${l}`))
  }

  if (recap.unresolvedItems.length) {
    console.log(`\n  🔴 UNRESOLVED (${recap.unresolvedItems.length}):`)
    recap.unresolvedItems.slice(0, 5).forEach(i => {
      const icon = i.priority === 'urgent' ? '🔴' : i.priority === 'high' ? '🟠' : '🟡'
      console.log(`    ${icon} ${i.text}${i.person ? ` — ${i.person}` : ''}`)
    })
  }

  if (recap.suggestedActions.length) {
    console.log(`\n  NEXT ACTIONS:`)
    recap.suggestedActions.forEach((a, i) => console.log(`    ${i + 1}. ${a}`))
  }

  console.log(`\n${sep}\n`)
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

async function main() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  const recap   = await buildDailyRecap(dateArg)
  printRecap(recap)
}

if (process.argv[1]?.endsWith('dailyRecap.ts') || process.argv[1]?.endsWith('dailyRecap.js')) {
  main().catch(e => { console.error(e); process.exit(1) })
}