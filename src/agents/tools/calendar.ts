import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import type { Tool, ToolResult } from '../types.js'
import { assertInNodeContext }   from '../ToolGuard.js'

const ARIA_DIR  = path.join(os.homedir(), '.aria')
const CAL_QUEUE = path.join(ARIA_DIR, 'calendar_queue.jsonl')

function ensureDir(): void {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

export const calendarSchedule: Tool = {
  name: 'calendar.schedule',
  description: 'Schedule a calendar event (logged to ~/.aria/calendar_queue.jsonl)',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    assertInNodeContext('calendar.schedule')
    const title     = typeof input['title']    === 'string' ? input['title']    : 'Untitled Event'
    const datetime  = typeof input['datetime'] === 'string' ? input['datetime'] : ''
    const attendees = Array.isArray(input['attendees'])
      ? (input['attendees'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : []
    const notes     = typeof input['notes']    === 'string' ? input['notes']    : ''

    const entry = {
      id:       `cal_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      title, datetime, attendees, notes, ts: Date.now(), status: 'queued',
    }

    try {
      ensureDir()
      fs.appendFileSync(CAL_QUEUE, JSON.stringify(entry) + '\n')
      console.log(`[CALENDAR] scheduled — "${title}" at ${datetime || 'TBD'}`)
      return { success: true, data: { id: entry.id, scheduled: true } }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
