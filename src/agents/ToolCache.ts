// ── ToolCache — two-phase idempotency cache ────────────────────────────────────
//
// Guarantees: a tool side-effect executes AT MOST ONCE across crashes/retries.
//
// Two-phase protocol (must be followed in order):
//   Phase 1 — recordIntent(key, toolName)
//             Writes { status: "pending" } → fsync  ← BEFORE tool runs
//   Phase 2 — commitResult(key, toolName, result)
//             Writes { status: "completed", result } → fsync  ← AFTER tool runs
//
// Recovery semantics (read by Coordinator._recoverStuckNodes):
//   "completed"  → tool ran and result is known  → reuse result, skip re-execution
//   "pending"    → execution uncertain (crash between intent and commit)
//                  → treat as "may have run" — DO NOT blindly retry with new key
//                  → Coordinator marks node needs_verification, then retries with
//                    SAME idempotencyKey so any late completion is detected
//   absent       → tool definitely never ran → safe to run
//
// Storage: single JSONL file, one record per line.
// In-memory index built lazily from disk; last-write-wins per key.

import * as fs   from 'node:fs'
import * as path from 'node:path'
import * as os   from 'node:os'
import type { ToolResult } from './types.js'

export type CacheStatus = 'pending' | 'completed'

export interface CacheEntry {
  key:        string
  toolName:   string
  status:     CacheStatus
  ts:         number
  pid:        number
  result?:    ToolResult   // only present when status = "completed"
}

const TOOL_LOGS_FILE = process.env['AXON_TOOL_LOGS'] ?? path.join(os.homedir(), '.aria', 'tool_logs.jsonl')

let _cache: Map<string, CacheEntry> | null = null

function ensureDir(): void {
  const dir = path.dirname(TOOL_LOGS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function appendLine(entry: CacheEntry): void {
  ensureDir()
  const buf = Buffer.from(JSON.stringify(entry) + '\n')
  const fd  = fs.openSync(TOOL_LOGS_FILE, 'a')
  try {
    fs.writeSync(fd, buf)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function getCache(): Map<string, CacheEntry> {
  if (_cache !== null) return _cache
  _cache = new Map()
  try {
    if (!fs.existsSync(TOOL_LOGS_FILE)) return _cache
    for (const line of fs.readFileSync(TOOL_LOGS_FILE, 'utf-8').split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as CacheEntry
        // Last write wins per key — completed always wins over pending for same key
        const existing = _cache.get(entry.key)
        if (!existing || entry.status === 'completed' || existing.status === 'pending') {
          _cache.set(entry.key, entry)
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file missing — start empty */ }
  return _cache
}

// ── Phase 1: Write INTENT before tool executes ────────────────────────────────

export function recordIntent(key: string, toolName: string): void {
  const entry: CacheEntry = { key, toolName, status: 'pending', ts: Date.now(), pid: process.pid }
  appendLine(entry)
  getCache().set(key, entry)
}

// ── Phase 2: Commit RESULT after tool executes ────────────────────────────────
// Always call this, even on tool failure — a failed result is still a known result.
// Failures are stored so recovery knows execution completed (just unsuccessfully).

export function commitResult(key: string, toolName: string, result: ToolResult): void {
  const entry: CacheEntry = { key, toolName, status: 'completed', ts: Date.now(), pid: process.pid, result }
  appendLine(entry)
  getCache().set(key, entry)
}

// ── Read API ──────────────────────────────────────────────────────────────────

export function getEntry(key: string): CacheEntry | null {
  return getCache().get(key) ?? null
}

export function getCached(key: string): ToolResult | null {
  const entry = getCache().get(key)
  if (!entry || entry.status !== 'completed') return null
  return entry.result ?? null
}

export function getStatus(key: string): CacheStatus | null {
  return getCache().get(key)?.status ?? null
}

export function hasCached(key: string): boolean {
  const entry = getCache().get(key)
  return entry?.status === 'completed' && entry.result?.success === true
}

// Clears in-memory index only — does not delete the file. Use in tests.
export function resetMemoryCache(): void {
  _cache = null
}

export function getToolLogsFile(): string {
  return TOOL_LOGS_FILE
}

// ── Consistency check (used by Coordinator) ───────────────────────────────────
// Returns all keys that have a "pending" entry with no subsequent "completed".
// These are the "uncertain" executions that need verification on recovery.

export function getPendingKeys(): string[] {
  const pending: string[] = []
  for (const [key, entry] of getCache()) {
    if (entry.status === 'pending') pending.push(key)
  }
  return pending
}
