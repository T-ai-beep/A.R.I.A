import { Tool } from '../../agents/types.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const OUTPUT_DIR = path.join(os.homedir(), '.aria', 'outputs')

interface FileWriteInput {
  filename: string
  content: string
  append?: boolean
}

export interface FileWriteResult {
  path: string
  bytes: number
  appended: boolean
}

export class FileWriteTool implements Tool {
  readonly name = 'file.write'

  async execute(input: unknown): Promise<FileWriteResult> {
    const { filename, content, append = false } = input as FileWriteInput

    if (!filename?.trim())             throw new Error('file.write: "filename" is required')
    if (content === undefined || content === null) throw new Error('file.write: "content" is required')

    const safe = sanitize(filename)
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

    const filepath = path.join(OUTPUT_DIR, safe)

    if (append) {
      fs.appendFileSync(filepath, content, 'utf-8')
    } else {
      fs.writeFileSync(filepath, content, 'utf-8')
    }

    const bytes = Buffer.byteLength(content, 'utf-8')
    console.log(`[TOOL:file.write] ${filepath} (${bytes} bytes${append ? ', append' : ''})`)
    return { path: filepath, bytes, appended: append }
  }
}

function sanitize(name: string): string {
  const base = path.basename(name)
  // Reject path traversal and dangerous characters
  if (base !== name || /[\\%<>:"|?*\x00-\x1f]/.test(base) || base.startsWith('.')) {
    throw new Error(`file.write: invalid filename "${name}"`)
  }
  return base
}
