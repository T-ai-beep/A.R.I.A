/**
 * recall.ts — Natural language query interface over all episodic memory
 *
 * Answers questions like:
 *   "Who did I talk to last Tuesday about the deal?"
 *   "What was the offer Marcus mentioned?"
 *   "Show me all conversations where someone stalled"
 *   "What happened with ServiceTitan last week?"
 *
 * Strategy:
 *   1. Parse query for time signals, person names, intent keywords
 *   2. Filter episodic events by time + person + tags
 *   3. Semantic search over remaining events
 *   4. Re-rank by recency + importance
 *   5. Return structured results with context
 *
 * Also handles: capture store search (raw transcripts) for exact quotes
 */

import { CONFIG }            from '../config.js'
import { recallEpisodes, EpisodicEvent } from '../pipeline/epsodic.js'
import { searchCaptures, CaptureEntry }  from '../capture/captureStore.js'
import { lookupPerson, getAllPeople }     from '../pipeline/people.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface RecallResult {
  type:      'episodic' | 'capture' | 'person'
  ts:        number
  date:      string
  snippet:   string        // what was said / what happened
  person:    string | null
  intent:    string | null
  source:    string        // episodic:id | capture:id | person:name
  relevance: number        // 0-1
  context:   string        // surrounding context
}

export interface RecallQuery {
  raw:        string
  timeFilter: { start?: Date; end?: Date; label?: string } | null
  persons:    string[]
  intents:    string[]
  keywords:   string[]
  topK:       number
}

export interface RecallResponse {
  query:    RecallQuery
  results:  RecallResult[]
  summary:  string
  empty:    boolean
}

// ── Time expression parser ─────────────────────────────────────────────────

function parseTimeExpression(query: string): { start?: Date; end?: Date; label?: string } | null {
  const q    = query.toLowerCase()
  const now  = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  if (/\btoday\b/.test(q)) {
    return { start: today, end: now, label: 'today' }
  }

  if (/\byesterday\b/.test(q)) {
    const start = new Date(today)
    start.setDate(start.getDate() - 1)
    const end = new Date(today)
    return { start, end, label: 'yesterday' }
  }

  if (/\blast\s+week\b/.test(q)) {
    const start = new Date(today)
    start.setDate(start.getDate() - 7)
    return { start, end: now, label: 'last week' }
  }

  if (/\bthis\s+week\b/.test(q)) {
    const start = new Date(today)
    start.setDate(start.getDate() - start.getDay())
    return { start, end: now, label: 'this week' }
  }

  if (/\blast\s+month\b/.test(q)) {
    const start = new Date(today)
    start.setMonth(start.getMonth() - 1)
    return { start, end: now, label: 'last month' }
  }

  // "last Tuesday", "last Monday", etc.
  const dayMatch = q.match(/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)
  if (dayMatch) {
    const days    = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
    const target  = days.indexOf(dayMatch[1].toLowerCase())
    const diff    = (now.getDay() - target + 7) % 7 || 7
    const start   = new Date(today)
    start.setDate(start.getDate() - diff)
    const end = new Date(start)
    end.setHours(23, 59, 59, 999)
    return { start, end, label: `last ${dayMatch[1]}` }
  }

  // "N days ago"
  const daysAgoMatch = q.match(/(\d+)\s+days?\s+ago/i)
  if (daysAgoMatch) {
    const n = parseInt(daysAgoMatch[1])
    const start = new Date(today)
    start.setDate(start.getDate() - n)
    return { start, end: now, label: `${n} days ago` }
  }

  // Specific date patterns: "April 15", "4/15", etc.
  const monthMatch = q.match(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})/i)
  if (monthMatch) {
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    const monthStr   = monthMatch[0].slice(0, 3).toLowerCase()
    const month      = monthNames.indexOf(monthStr)
    const day        = parseInt(monthMatch[1])
    const year       = now.getFullYear()
    const start      = new Date(year, month, day)
    const end        = new Date(year, month, day, 23, 59, 59)
    return { start, end, label: `${monthMatch[0]}` }
  }

  return null
}

// ── Intent keyword parser ──────────────────────────────────────────────────

function parseIntentKeywords(query: string): string[] {
  const q       = query.toLowerCase()
  const intents: string[] = []

  if (/price|cost|budget|afford|expensive/i.test(q)) intents.push('PRICE_OBJECTION')
  if (/stall|delay|later|not ready|circle back/i.test(q)) intents.push('STALLING')
  if (/agree|move forward|contract|deal|close/i.test(q)) intents.push('AGREEMENT')
  if (/competitor|servicetitan|jobber/i.test(q)) intents.push('COMPETITOR')
  if (/approve|boss|partner|team|authority/i.test(q)) intents.push('AUTHORITY')
  if (/meeting|agenda|standup/i.test(q)) intents.push('meeting')
  if (/investor|fund|raise|pitch/i.test(q)) intents.push('investor')
  if (/offer|amount|\$/i.test(q)) intents.push('money')

  return intents
}

// ── Person name parser ─────────────────────────────────────────────────────

function parsePersonNames(query: string): string[] {
  // Known people from the people store
  try {
    const all   = getAllPeople()
    const names = all.map(p => p.displayName.toLowerCase())
    const found = names.filter(n => query.toLowerCase().includes(n))
    return found.map(n => n.charAt(0).toUpperCase() + n.slice(1))
  } catch {
    // Fallback: extract capitalized words
    const matches = query.match(/\b[A-Z][a-z]{2,14}\b/g) ?? []
    const stopwords = new Set(['Who','What','When','Where','How','Did','Was','Were','The','That','This'])
    return matches.filter(m => !stopwords.has(m))
  }
}

// ── Parse query ────────────────────────────────────────────────────────────

export function parseRecallQuery(raw: string, topK = 10): RecallQuery {
  const timeFilter  = parseTimeExpression(raw)
  const persons     = parsePersonNames(raw)
  const intents     = parseIntentKeywords(raw)

  // Extract remaining keywords (remove time/person/intent tokens)
  const stopwords = new Set([
    'who','what','when','where','how','did','was','were','the','that','this',
    'about','with','from','talk','talked','talking','mention','mentioned','say','said',
    'show','me','all','conversations','last','week','month','today','yesterday',
    'a','an','and','or','in','on','at','to','of','for','is','are',
  ])
  const keywords = raw.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w))

  return { raw, timeFilter, persons, intents, keywords, topK }
}

// ── Recall from episodic ───────────────────────────────────────────────────

async function recallFromEpisodic(q: RecallQuery): Promise<RecallResult[]> {
  const filter: Parameters<typeof recallEpisodes>[2] = {}

  if (q.persons.length) filter.person = q.persons[0]
  if (q.intents.some(i => i === 'money')) filter.minImportance = 0.3

  const episodes = await recallEpisodes(q.raw, q.topK * 2, filter)

  // Apply time filter
  let filtered = episodes
  if (q.timeFilter?.start) {
    filtered = filtered.filter(e => e.time >= q.timeFilter!.start!.getTime())
  }
  if (q.timeFilter?.end) {
    filtered = filtered.filter(e => e.time <= q.timeFilter!.end!.getTime())
  }

  return filtered.slice(0, q.topK).map(e => ({
    type:      'episodic' as const,
    ts:        e.time,
    date:      new Date(e.time).toLocaleDateString(),
    snippet:   e.object,
    person:    e.person,
    intent:    e.tags.join(', ') || null,
    source:    `episodic:${e.id}`,
    relevance: e.importance,
    context:   e.context.slice(0, 200),
  }))
}

// ── Recall from capture store ──────────────────────────────────────────────

function recallFromCaptures(q: RecallQuery): RecallResult[] {
  const opts: Parameters<typeof searchCaptures>[0] = {
    limit: q.topK,
  }

  if (q.timeFilter?.start) {
    opts.startDate = q.timeFilter.start.toISOString().slice(0, 10)
  }
  if (q.timeFilter?.end) {
    opts.endDate = q.timeFilter.end.toISOString().slice(0, 10)
  }
  if (q.intents.length) {
    // Map intent to tag
    const tagMap: Record<string, string> = {
      'PRICE_OBJECTION': 'negotiation',
      'AGREEMENT':       'negotiation',
      'meeting':         'meeting',
      'investor':        'investor',
    }
    const tags = q.intents.map(i => tagMap[i]).filter(Boolean)
    if (tags.length) opts.tags = tags
  }

  // Use keyword search
  if (q.keywords.length) {
    opts.query = q.keywords.slice(0, 3).join(' ')
  }

  const captures = searchCaptures(opts)

  return captures.map(c => ({
    type:      'capture' as const,
    ts:        c.ts,
    date:      c.date,
    snippet:   c.transcript.slice(0, 120),
    person:    null,
    intent:    c.tags.join(', ') || null,
    source:    `capture:${c.id}`,
    relevance: 0.5,
    context:   c.transcript,
  }))
}

// ── LLM summary of recall results ─────────────────────────────────────────

async function summarizeRecallResults(
  query:   string,
  results: RecallResult[]
): Promise<string> {
  if (!results.length) return 'Nothing found matching that query.'

  const context = results.slice(0, 5).map((r, i) =>
    `[${i + 1}] ${r.date}${r.person ? ` (${r.person})` : ''}: ${r.snippet}`
  ).join('\n')

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:   CONFIG.OLLAMA_MODEL,
        stream:  false,
        messages: [
          {
            role:    'system',
            content: 'You answer recall queries based on conversation history. Be concise. 2-3 sentences max. Use names and dates when available.',
          },
          {
            role:    'user',
            content: `Query: "${query}"\n\nRelevant memories:\n${context}\n\nAnswer the query based on these memories.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_RECALL_TIMEOUT_MS),
    })
    const data = await res.json() as { message: { content: string } }
    return data.message.content.trim()
  } catch {
    // Fallback: just format results
    if (results.length === 1) {
      return `Found 1 match: ${results[0].date} — ${results[0].snippet}`
    }
    return `Found ${results.length} matches. Most recent: ${results[0].date} — ${results[0].snippet}`
  }
}

// ── Main recall function ───────────────────────────────────────────────────

export async function recall(rawQuery: string, topK = 10): Promise<RecallResponse> {
  const q = parseRecallQuery(rawQuery, topK)

  console.log(`[RECALL] query="${rawQuery}" time=${q.timeFilter?.label ?? 'all'} persons=[${q.persons}] intents=[${q.intents}]`)

  const [episodicResults, captureResults] = await Promise.all([
    recallFromEpisodic(q),
    Promise.resolve(recallFromCaptures(q)),
  ])

  // Merge and deduplicate
  const allResults = [...episodicResults, ...captureResults]
    .sort((a, b) => b.relevance - a.relevance || b.ts - a.ts)
    .slice(0, topK)

  const summary = await summarizeRecallResults(rawQuery, allResults)

  return {
    query:   q,
    results: allResults,
    summary,
    empty:   allResults.length === 0,
  }
}

// ── Convenience query functions ────────────────────────────────────────────

export async function recallByPerson(name: string, limit = 10): Promise<RecallResponse> {
  return recall(`conversations with ${name}`, limit)
}

export async function recallByDate(date: string, limit = 20): Promise<RecallResponse> {
  return recall(`everything on ${date}`, limit)
}

export async function recallByIntent(intent: string, limit = 10): Promise<RecallResponse> {
  const intentQueries: Record<string, string> = {
    'PRICE_OBJECTION': 'price objections and budget concerns',
    'AGREEMENT':       'agreements and deals closed',
    'STALLING':        'stalls and delays',
    'COMPETITOR':      'competitor mentions',
    'AUTHORITY':       'approval blocks and authority issues',
  }
  return recall(intentQueries[intent] ?? intent, limit)
}

export async function recallRecentDeals(limit = 5): Promise<RecallResponse> {
  return recall('deals and agreements from the last two weeks', limit)
}

// ── Format for ARIA prompt ─────────────────────────────────────────────────

export async function getRecallContext(transcript: string): Promise<string> {
  // Only do recall if the transcript is a question about the past
  const isRecallQuery = /who|what|when|where|last (week|month|tuesday|call)|did (i|we)|remember|told me|mentioned|said/i.test(transcript)
  if (!isRecallQuery) return ''

  const response = await recall(transcript, 3)
  if (response.empty) return ''

  return `Memory recall for "${transcript}":\n${response.summary}`
} 