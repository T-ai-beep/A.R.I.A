import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import type { Tool, ToolResult } from '../types.js'
import { assertInNodeContext }    from '../ToolGuard.js'
import { getCached, cacheResult } from '../ToolCache.js'

const ARIA_DIR    = path.join(os.homedir(), '.aria')
const EMAIL_QUEUE = path.join(ARIA_DIR, 'email_queue.jsonl')

function ensureDir(): void {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function genId(): string {
  return `email_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export interface QueuedEmail {
  id:      string
  to:      string
  subject: string
  body:    string
  ts:      number
  status:  'queued' | 'sent' | 'failed'
}

export const emailSend: Tool = {
  name: 'email.send',
  description: 'Queue an email for sending (logged to ~/.aria/email_queue.jsonl)',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    assertInNodeContext('email.send')
    const iKey    = typeof input['__idempotencyKey'] === 'string' ? input['__idempotencyKey'] : null
    const to      = typeof input['to']      === 'string' ? input['to']      : ''
    const subject = typeof input['subject'] === 'string' ? input['subject'] : '(no subject)'
    const body    = typeof input['body']    === 'string' ? input['body']    : ''

    if (!to)   return { success: false, error: 'to is required' }
    if (!body) return { success: false, error: 'body is required' }

    // ToolCache idempotency check — prevents duplicate emails on retry
    if (iKey) {
      const cached = getCached(iKey)
      if (cached?.success) return cached
    }

    const entry: QueuedEmail = { id: genId(), to, subject, body, ts: Date.now(), status: 'queued' }

    let result: ToolResult
    try {
      ensureDir()
      fs.appendFileSync(EMAIL_QUEUE, JSON.stringify(entry) + '\n')
      console.log(`[EMAIL] queued → ${to} | "${subject}"`)
      result = { success: true, data: { queued: true, id: entry.id } }
    } catch (e) {
      result = { success: false, error: e instanceof Error ? e.message : String(e) }
    }

    if (iKey) cacheResult(iKey, 'email.send', result)
    return result
  },
}
