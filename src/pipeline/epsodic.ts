/**
 * episodic.ts
 * Structured episodic memory — real events, not just signals.
 *
 * Schema: EpisodicEvent
 *   object   — what was discussed (deal, idea, task, meeting...)
 *   person   — who was involved
 *   time     — when it happened
 *   context  — raw transcript / note
 *   outcome  — what resulted
 *   links    — IDs of related events
 *   tags     — semantic labels
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { CONFIG } from '../config.js'

const ARIA_DIR     = path.join(os.homedir(), '.aria')
const EPISODIC_FILE = path.join(ARIA_DIR, 'episodic.jsonl')

// ── Schema ─────────────────────────────────────────────────────────────────

export type EpisodicType =
  | 'deal'       // sales interaction
  | 'meeting'    // scheduled sync
  | 'commitment' // verbal promise made
  | 'objection'  // objection raised
  | 'agreement'  // deal/agreement reached
  | 'followup'   // follow-up action
  | 'insight'    // learned something important
  | 'conflict'   // disagreement
  | 'social'     // casual interaction
  | 'note'       // manually added memory

export type EpisodicOutcome =
  | 'pending'
  | 'won'
  | 'lost'
  | 'deferred'
  | 'completed'
  | 'ignored'

export interface EpisodicEvent {
  id: string
  type: EpisodicType
  object: string            // what: "price negotiation", "intro meeting", "demo request"
  person: string | null     // who
  time: number              // epoch ms
  context: string           // raw transcript or note (up to 300 chars)
  outcome: EpisodicOutcome
  links: string[]           // IDs of related EpisodicEvents
  tags: string[]            // e.g. ['investor', 'TTC', 'price']
  embedding?: number[]      // for semantic recall
  importance: number        // 0–1 score
  updatedAt: number
}

// ── Storage ────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): EpisodicEvent[] {
  ensureDir()
  if (!fs.existsSync(EPISODIC_FILE)) return []
  try {
    return fs.readFileSync(EPISODIC_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as EpisodicEvent)
  } catch { return [] }
}

function saveAll(events: EpisodicEvent[]) {
  ensureDir()
  fs.writeFileSync(EPISODIC_FILE, events.map(e => JSON.stringify(e)).join('\n') + '\n')
}

function genId(): string {
  return `ep_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
}

// ── Embedding ─────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  try {
    const res = await fetch(`${CONFIG.OLLAMA_URL.replace('/api/chat', '/api/embed')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_EMBED_TIMEOUT_MS),
    })
    const data = await res.json() as { embeddings: number[][] }
    return data.embeddings[0] ?? []
  } catch (e) { console.error('[EPISODIC] embed fetch failed:', e); return [] }
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── Type detection from transcript ────────────────────────────────────────

function detectType(transcript: string): EpisodicType {
  const t = transcript.toLowerCase()
  if (/price|budget|cost|afford|expensive/.test(t)) return 'objection'
  if (/deal|close|contract|sign|agree|move forward/.test(t)) return 'agreement'
  if (/meeting|call|demo|lunch|sync|schedule/.test(t)) return 'meeting'
  if (/follow up|send|email|reach out|ping/.test(t)) return 'followup'
  if (/promise|commit|will do|guarantee|by friday/.test(t)) return 'commitment'
  if (/learned|realize|understand|insight|turns out/.test(t)) return 'insight'
  if (/disagree|problem|issue|conflict|wrong/.test(t)) return 'conflict'
  return 'note'
}

function detectImportance(transcript: string, type: EpisodicType, person: string | null): number {
  let score = 0.3
  const t = transcript.toLowerCase()

  // type boosts
  if (type === 'agreement') score += 0.4
  if (type === 'objection') score += 0.25
  if (type === 'commitment') score += 0.3
  if (type === 'deal') score += 0.35

  // person boosts
  if (person) score += 0.1

  // signal words
  if (/urgent|asap|critical|important|now/.test(t)) score += 0.2
  if (/investor|ceo|cfo|founder/.test(t)) score += 0.2
  if (/\$[\d,]+/.test(t)) score += 0.15

  return Math.min(1.0, parseFloat(score.toFixed(2)))
}

// ── Find links — events involving same person / overlapping tags ──────────

function findLinks(event: EpisodicEvent, all: EpisodicEvent[]): string[] {
  const links: string[] = []
  const recent = all.slice(-50) // search last 50

  for (const e of recent) {
    if (e.id === event.id) continue
    const samePerson = event.person && e.person &&
      e.person.toLowerCase() === event.person.toLowerCase()
    const tagOverlap = (event.tags ?? []).some(t => (e.tags ?? []).includes(t))
    if (samePerson || tagOverlap) {
      links.push(e.id)
    }
  }
  return links.slice(0, 5) // cap at 5 links
}

// ── Tag extraction ─────────────────────────────────────────────────────────

function extractTags(transcript: string, type: EpisodicType): string[] {
  const t = transcript.toLowerCase()
  const tags: Set<string> = new Set([type])

  if (/ttc|tech to customer/.test(t)) tags.add('TTC')
  if (/aria/.test(t)) tags.add('ARIA')
  if (/boring solutions/.test(t)) tags.add('BoringS')
  if (/investor|fund|raise|capital/.test(t)) tags.add('investor')
  if (/servicetitan|jobber|housecall/.test(t)) tags.add('competitor')
  if (/\$|price|cost|budget/.test(t)) tags.add('money')
  if (/college|sat|school|ap/.test(t)) tags.add('school')

  return Array.from(tags)
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function storeEpisode(
  transcript: string,
  person: string | null,
  overrides?: Partial<EpisodicEvent>
): Promise<EpisodicEvent> {
  const type = overrides?.type ?? detectType(transcript)
  const tags = extractTags(transcript, type)
  const importance = detectImportance(transcript, type, person)

  const all = loadAll()

  const event: EpisodicEvent = {
    id: genId(),
    type,
    object: transcript.slice(0, 80).trim(),
    person,
    time: Date.now(),
    context: transcript.slice(0, 300),
    outcome: 'pending',
    links: [],
    tags,
    importance,
    updatedAt: Date.now(),
    ...overrides,
  }

  // link to related past events
  event.links = findLinks(event, all)

  // embed async — don't block pipeline
  embed(`${event.object} ${event.tags.join(' ')}`).then(vec => {
    if (!vec.length) return
    const events = loadAll()
    const target = events.find(e => e.id === event.id)
    if (target) {
      target.embedding = vec
      saveAll(events)
    }
  }).catch(() => {})

  all.push(event)
  saveAll(all)

  console.log(`[EPISODIC] stored ${type} — importance=${importance}${person ? ` re: ${person}` : ''} links=${event.links.length}`)
  return event
}

export function updateEpisode(id: string, updates: Partial<EpisodicEvent>): void {
  const all = loadAll()
  const target = all.find(e => e.id === id)
  if (!target) return
  Object.assign(target, updates, { updatedAt: Date.now() })
  saveAll(all)
  console.log(`[EPISODIC] updated ${id}`)
}

export function getEpisode(id: string): EpisodicEvent | null {
  return loadAll().find(e => e.id === id) ?? null
}

// ── Semantic recall ────────────────────────────────────────────────────────

export async function recallEpisodes(
  query: string,
  topK = 5,
  filter?: Partial<{ person: string; type: EpisodicType; minImportance: number }>
): Promise<EpisodicEvent[]> {
  let all = loadAll()

  // apply filters
  if (filter?.person && filter.person.length) {
    all = all.filter(e => e.person?.toLowerCase().includes(filter.person!.toLowerCase()))
  }
  if (filter?.type) {
    all = all.filter(e => e.type === filter.type)
  }
  if (filter?.minImportance !== undefined) {
    all = all.filter(e => e.importance >= filter.minImportance!)
  }

  // semantic search over events that have embeddings
  const embedded = all.filter(e => e.embedding?.length)
  const unembedded = all.filter(e => !e.embedding?.length)

  if (embedded.length > 0) {
    const qVec = await embed(query)
    if (qVec.length) {
      const scored = embedded.map(e => ({
        event: e,
        score: cosine(qVec, e.embedding!),
      }))
      scored.sort((a, b) => b.score - a.score)
      const topEmbedded = scored.slice(0, topK).filter(r => r.score > 0.5).map(r => r.event)
      if (topEmbedded.length) return topEmbedded
    }
  }

  // keyword fallback
  const words = query.toLowerCase().split(/\s+/)
  const matched = [...embedded, ...unembedded].filter(e =>
    words.some(w => e.context.toLowerCase().includes(w) || (e.tags ?? []).some(t => t.toLowerCase().includes(w)))
  )
  return matched.sort((a, b) => b.importance - a.importance).slice(0, topK)
}

// ── Get linked events ──────────────────────────────────────────────────────

export function getLinkedEvents(id: string): EpisodicEvent[] {
  const event = getEpisode(id)
  if (!event || !event.links.length) return []
  const all = loadAll()
  return event.links
    .map(lid => all.find(e => e.id === lid))
    .filter(Boolean) as EpisodicEvent[]
}

// ── Context string for ARIA prompt ────────────────────────────────────────

export async function getEpisodicContext(transcript: string): Promise<string> {
  const episodes = await recallEpisodes(transcript, 3, { minImportance: 0.4 })
  if (!episodes.length) return ''

  const lines = episodes.map(e => {
    const when = new Date(e.time).toLocaleDateString()
    const who  = e.person ? ` with ${e.person}` : ''
    const outcome = e.outcome !== 'pending' ? ` → ${e.outcome}` : ''
    return `[${when}${who}] ${e.object}${outcome}`
  })

  return `Relevant past events:\n${lines.join('\n')}`
}

// ── Summary ────────────────────────────────────────────────────────────────

export function getEpisodicSummary(): string {
  const all = loadAll()
  if (!all.length) return 'No episodic memory yet.'
  const byType = all.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1; return acc
  }, {} as Record<string, number>)
  const breakdown = Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' ')
  return `Episodic: ${all.length} events — ${breakdown}`
}