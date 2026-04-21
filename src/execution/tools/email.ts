import { Tool } from '../../agents/types.js'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const OUTBOX_DIR = path.join(os.homedir(), '.aria', 'outbox')

interface EmailInput {
  to: string
  subject: string
  body: string
  from?: string
  cc?: string
}

export interface EmailResult {
  to: string
  subject: string
  delivered: boolean
  method: 'sendmail' | 'file_log'
  path?: string
}

export class EmailSendTool implements Tool {
  readonly name = 'email.send'

  async execute(input: unknown): Promise<EmailResult> {
    const {
      to,
      subject,
      body,
      from = process.env.AXON_EMAIL_FROM ?? 'axon@local',
      cc,
    } = input as EmailInput

    if (!to?.trim())      throw new Error('email.send: "to" is required')
    if (!subject?.trim()) throw new Error('email.send: "subject" is required')
    if (!body?.trim())    throw new Error('email.send: "body" is required')

    const mimeMessage = buildMime(from, to, cc ?? null, subject, body)

    if (await isSendmailAvailable()) {
      const ok = await sendViaSendmail(mimeMessage)
      if (ok) {
        console.log(`[TOOL:email.send] delivered → ${to} via sendmail`)
        return { to, subject, delivered: true, method: 'sendmail' }
      }
    }

    // Fallback: persist to outbox file so nothing is silently dropped
    const filepath = writeToOutbox(mimeMessage)
    console.log(`[TOOL:email.send] queued → ${filepath}`)
    return { to, subject, delivered: false, method: 'file_log', path: filepath }
  }
}

function buildMime(
  from: string,
  to: string,
  cc: string | null,
  subject: string,
  body: string
): string {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ]
  return lines.join('\n')
}

function isSendmailAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn('which', ['sendmail'], { stdio: 'ignore' })
    p.on('close', code => resolve(code === 0))
    p.on('error', () => resolve(false))
  })
}

function sendViaSendmail(mime: string): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn('sendmail', ['-t'], { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', () => resolve(false))
    p.on('close', code => resolve(code === 0))
    p.stdin.write(mime, 'utf-8')
    p.stdin.end()
  })
}

function writeToOutbox(mime: string): string {
  if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true })
  const filepath = path.join(OUTBOX_DIR, `mail_${Date.now()}.eml`)
  fs.writeFileSync(filepath, mime, 'utf-8')
  return filepath
}
