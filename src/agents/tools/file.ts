import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import type { Tool, ToolResult } from '../types.js'
import { assertInNodeContext } from '../ToolGuard.js'
import { getCached, cacheResult } from '../ToolCache.js'

const ARIA_DIR  = path.join(os.homedir(), '.aria')
const FILES_DIR = path.join(ARIA_DIR, 'agent_files')

function ensureDir(): void {
  if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true })
}

function safeFilename(raw: string): string | null {
  const base = path.basename(raw)
  if (base !== raw || /[\\%]/.test(base)) return null
  return base
}

export const fileWrite: Tool = {
  name: 'file.write',
  description: 'Write content to a file in ~/.aria/agent_files/',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    assertInNodeContext('file.write')
    const iKey    = typeof input['__idempotencyKey'] === 'string' ? input['__idempotencyKey'] : null
    const rawName = typeof input['filename'] === 'string' ? input['filename'] : `note_${Date.now()}.txt`
    const content = typeof input['content']  === 'string' ? input['content']  : ''

    // ToolCache idempotency check
    if (iKey) {
      const cached = getCached(iKey)
      if (cached?.success) return cached
    }

    const safe = safeFilename(rawName)
    if (!safe) return { success: false, error: `Invalid filename: "${rawName}"` }

    let result: ToolResult
    try {
      ensureDir()
      const filepath = path.join(FILES_DIR, safe)
      fs.writeFileSync(filepath, content, 'utf-8')
      console.log(`[FILE] written — ${safe} (${content.length} chars)`)
      result = { success: true, data: { path: filepath, bytes: content.length } }
    } catch (e) {
      result = { success: false, error: e instanceof Error ? e.message : String(e) }
    }

    if (iKey) cacheResult(iKey, 'file.write', result)
    return result
  },
}

export const fileRead: Tool = {
  name: 'file.read',
  description: 'Read content from a file in ~/.aria/agent_files/',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    assertInNodeContext('file.read')
    const rawName = typeof input['filename'] === 'string' ? input['filename'] : ''
    if (!rawName) return { success: false, error: 'filename is required' }

    const safe = safeFilename(rawName)
    if (!safe) return { success: false, error: `Invalid filename: "${rawName}"` }

    try {
      ensureDir()
      const filepath = path.join(FILES_DIR, safe)
      if (!fs.existsSync(filepath)) return { success: false, error: `File not found: ${safe}` }
      return { success: true, data: fs.readFileSync(filepath, 'utf-8') }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
