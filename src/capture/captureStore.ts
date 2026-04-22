/**
 * captureStore.ts — Permanent raw capture storage
 *
 * Every transcript chunk gets written here BEFORE any processing.
 * This is the ground truth — episodic memory is derived from this.
 *
 * Schema: CaptureEntry
 *   ts         — epoch ms
 *   transcript — raw whisper output
 *   speaker    — self | other | unknown
 *   sessionId  — which daemon session this belongs to
 *   durationMs — audio chunk duration
 *   source     — mic | file | stream
 *   processed  — has this been pushed to episodic?
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const ARIA_DIR      = path.join(os.homedir(), '.aria')
const CAPTURE_FILE  = path.join(ARIA_DIR, 'capture.jsonl')
const INDEX_FILE    = path.join(ARIA_DIR, 'capture_index.json')

export type CaptureSource  = 'mic' | 'file' | 'stream'
export type CaptureStatus  = 'raw' | 'processed' | 'skipped'

export interface CaptureEntry {
  id:          string
  ts:          number
  date:        string          // YYYY-MM-DD for easy day filtering
  hour:        number          // 0-23 for time-of-day filtering
  transcript:  string
  speaker:     'self' | 'other' | 'unknown'
  sessionId:   string
  durationMs:  number
  source:      CaptureSource
  status:      CaptureStatus
  wordCount:   number
  tags:        string[]        // auto-inferred: 'meeting', 'phone', 'negotiation', etc
}

export interface CaptureIndex {
  totalEntries:    number
  totalWords:      number
  firstCapture:    number
  lastCapture:     number
  dayIndex:        Record<string, number[]>   // date → line offsets
  sessionIndex:    Record<string, number[]>   // sessionId → line offsets
  speakerStats:    { self: number; other: number; unknown: number }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function genId(): string {
  return `cap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function getDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function getHour(ts: number): number {
  return new Date(ts).getHours()
}

function inferTags(transcript: string): string[] {
  const t = transcript.toLowerCase()
  const tags: string[] = []
  if (/meeting|agenda|standup|sync|call/i.test(t))          tags.push('meeting')
  if (/price|cost|budget|afford|deal|contract|\$/i.test(t)) tags.push('negotiation')
  if (/interview|salary|hire|position|resume/i.test(t))     tags.push('interview')
  if (/investor|fund|raise|pitch|equity/i.test(t))          tags.push('investor')
  if (/\?/.test(t))                                          tags.push('question')
  if (/thank|thanks|appreciate|great|awesome/i.test(t))     tags.push('positive')
  if (/sorry|apologize|mistake|wrong|issue/i.test(t))       tags.push('friction')
  if (/tomorrow|next week|schedule|calendar|remind/i.test(t)) tags.push('planning')
  return tags
}

// ── Index management ────────────────────────────────────────────────────────

function loadIndex(): CaptureIndex {
  ensureDir()
  if (!fs.existsSync(INDEX_FILE)) {
    return {
      totalEntries: 0,
      totalWords:   0,
      firstCapture: 0,
      lastCapture:  0,
      dayIndex:     {},
      sessionIndex: {},
      speakerStats: { self: 0, other: 0, unknown: 0 },
    }
  }
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')) as CaptureIndex
  } catch (e) {
    console.error('[CAPTURE] loadIndex parse failed:', e)
    return {
      totalEntries: 0,
      totalWords:   0,
      firstCapture: 0,
      lastCapture:  0,
      dayIndex:     {},
      sessionIndex: {},
      speakerStats: { self: 0, other: 0, unknown: 0 },
    }
  }
}

function saveIndex(index: CaptureIndex) {
  ensureDir()
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2))
}

// ── Write ──────────────────────────────────────────────────────────────────

export function writeCapture(
  transcript: string,
  speaker:    'self' | 'other' | 'unknown',
  sessionId:  string,
  durationMs: number,
  source:     CaptureSource = 'mic'
): CaptureEntry {
  ensureDir()

  const now = Date.now()
  const entry: CaptureEntry = {
    id:         genId(),
    ts:         now,
    date:       getDate(now),
    hour:       getHour(now),
    transcript: transcript.trim(),
    speaker,
    sessionId,
    durationMs,
    source,
    status:     'raw',
    wordCount:  transcript.trim().split(/\s+/).filter(Boolean).length,
    tags:       inferTags(transcript),
  }

  // Append to JSONL
  const line = JSON.stringify(entry) + '\n'
  fs.appendFileSync(CAPTURE_FILE, line)

  // Update index
  const index = loadIndex()
  const lineOffset = index.totalEntries

  index.totalEntries++
  index.totalWords += entry.wordCount
  if (!index.firstCapture) index.firstCapture = now
  index.lastCapture = now

  if (!index.dayIndex[entry.date]) index.dayIndex[entry.date] = []
  index.dayIndex[entry.date].push(lineOffset)

  if (!index.sessionIndex[sessionId]) index.sessionIndex[sessionId] = []
  index.sessionIndex[sessionId].push(lineOffset)

  index.speakerStats[speaker]++

  saveIndex(index)

  return entry
}

// ── Read ───────────────────────────────────────────────────────────────────

function loadAll(): CaptureEntry[] {
  ensureDir()
  if (!fs.existsSync(CAPTURE_FILE)) return []
  try {
    return fs.readFileSync(CAPTURE_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as CaptureEntry)
  } catch { return [] }
}

export function getByDate(date: string): CaptureEntry[] {
  return loadAll().filter(e => e.date === date)
}

export function getByDateRange(startDate: string, endDate: string): CaptureEntry[] {
  return loadAll().filter(e => e.date >= startDate && e.date <= endDate)
}

export function getBySession(sessionId: string): CaptureEntry[] {
  return loadAll().filter(e => e.sessionId === sessionId)
}

export function getToday(): CaptureEntry[] {
  return getByDate(getDate(Date.now()))
}

export function getUnprocessed(): CaptureEntry[] {
  return loadAll().filter(e => e.status === 'raw')
}

export function markProcessed(id: string): void {
  // We can't efficiently update JSONL in place — use a sidecar status file
  const statusFile = path.join(ARIA_DIR, 'capture_status.json')
  let statuses: Record<string, CaptureStatus> = {}
  try {
    if (fs.existsSync(statusFile)) {
      statuses = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    }
  } catch (e) { console.error('[CAPTURE] load statuses failed:', e) }
  statuses[id] = 'processed'
  fs.writeFileSync(statusFile, JSON.stringify(statuses))
}

// ── Search ─────────────────────────────────────────────────────────────────

export interface CaptureSearchOpts {
  query?:      string
  date?:       string
  startDate?:  string
  endDate?:    string
  speaker?:    'self' | 'other' | 'unknown'
  sessionId?:  string
  tags?:       string[]
  limit?:      number
  offset?:     number
}

export function searchCaptures(opts: CaptureSearchOpts): CaptureEntry[] {
  let entries = loadAll()

  if (opts.date)      entries = entries.filter(e => e.date === opts.date)
  if (opts.startDate) entries = entries.filter(e => e.date >= opts.startDate!)
  if (opts.endDate)   entries = entries.filter(e => e.date <= opts.endDate!)
  if (opts.speaker)   entries = entries.filter(e => e.speaker === opts.speaker)
  if (opts.sessionId) entries = entries.filter(e => e.sessionId === opts.sessionId)
  if (opts.tags?.length) {
    entries = entries.filter(e => opts.tags!.some(t => e.tags.includes(t)))
  }
  if (opts.query) {
    const q = opts.query.toLowerCase()
    entries = entries.filter(e => e.transcript.toLowerCase().includes(q))
  }

  // Most recent first
  entries.sort((a, b) => b.ts - a.ts)

  const offset = opts.offset ?? 0
  const limit  = opts.limit  ?? 50
  return entries.slice(offset, offset + limit)
}

// ── Stats ──────────────────────────────────────────────────────────────────

export function getCaptureStats(): {
  total:      number
  today:      number
  thisWeek:   number
  totalWords: number
  speakers:   { self: number; other: number; unknown: number }
  daysActive: number
} {
  const index = loadIndex()
  const today = getDate(Date.now())
  const weekAgo = getDate(Date.now() - 7 * 24 * 3600 * 1000)

  const todayCount    = index.dayIndex[today]?.length ?? 0
  const weekDays      = Object.keys(index.dayIndex).filter(d => d >= weekAgo)
  const weekCount     = weekDays.reduce((sum, d) => sum + (index.dayIndex[d]?.length ?? 0), 0)
  const daysActive    = Object.keys(index.dayIndex).length

  return {
    total:      index.totalEntries,
    today:      todayCount,
    thisWeek:   weekCount,
    totalWords: index.totalWords,
    speakers:   index.speakerStats,
    daysActive,
  }
}

export function getCaptureSummaryForDate(date: string): string {
  const entries = getByDate(date)
  if (!entries.length) return `No captures for ${date}.`

  const words   = entries.reduce((s, e) => s + e.wordCount, 0)
  const others  = entries.filter(e => e.speaker === 'other').length
  const tags    = [...new Set(entries.flatMap(e => e.tags))]
  const hours   = [...new Set(entries.map(e => e.hour))].sort((a, b) => a - b)

  const hourRange = hours.length
    ? `${hours[0]}:00 – ${hours[hours.length - 1]}:59`
    : 'unknown'

  return `${date}: ${entries.length} captures, ${words} words, ${others} from others. ` +
         `Active hours: ${hourRange}. Topics: ${tags.slice(0, 5).join(', ') || 'general'}.`
}

export { CAPTURE_FILE, ARIA_DIR }