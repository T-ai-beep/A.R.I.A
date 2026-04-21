import { Tool } from '../../agents/types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const CALENDAR_FILE = path.join(os.homedir(), '.aria', 'calendar.jsonl')

interface CalendarInput {
  title: string
  date: string       // ISO 8601 or human-readable
  duration?: number  // minutes, default 60
  notes?: string
  attendees?: string[]
}

export interface CalendarEntry {
  id: string
  title: string
  date: string
  duration: number
  notes: string
  attendees: string[]
  createdAt: number
}

export class CalendarScheduleTool implements Tool {
  readonly name = 'calendar.schedule'

  async execute(input: unknown): Promise<CalendarEntry> {
    const { title, date, duration = 60, notes = '', attendees = [] } = input as CalendarInput

    if (!title?.trim()) throw new Error('calendar.schedule: "title" is required')
    if (!date?.trim())  throw new Error('calendar.schedule: "date" is required')

    const d = parseDate(date)
    if (!d) throw new Error(`calendar.schedule: cannot parse date: "${date}"`)

    const entry: CalendarEntry = {
      id: `cal_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      title: title.trim(),
      date: d.toISOString(),
      duration,
      notes,
      attendees,
      createdAt: Date.now(),
    }

    ensureDir()
    fs.appendFileSync(CALENDAR_FILE, JSON.stringify(entry) + '\n', 'utf-8')
    console.log(`[TOOL:calendar.schedule] "${title}" @ ${d.toLocaleString()} (${duration}min)`)
    return entry
  }
}

function ensureDir(): void {
  const dir = path.dirname(CALENDAR_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function parseDate(raw: string): Date | null {
  // ISO / standard parse
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return d

  // Relative shortcuts
  const t = raw.toLowerCase().trim()
  const now = new Date()
  if (t === 'tomorrow') {
    now.setDate(now.getDate() + 1); now.setHours(9, 0, 0, 0); return now
  }
  if (t === 'today') {
    now.setHours(14, 0, 0, 0); return now
  }
  if (t === 'next week') {
    now.setDate(now.getDate() + 7); now.setHours(9, 0, 0, 0); return now
  }
  if (/^in (\d+) days?$/.test(t)) {
    const m = t.match(/^in (\d+) days?$/)!
    now.setDate(now.getDate() + parseInt(m[1], 10)); now.setHours(9, 0, 0, 0); return now
  }

  return null
}
