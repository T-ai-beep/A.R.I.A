// ── ToolCache — tool-level idempotency cache ──────────────────────────────────
//
// Before a tool executes, check: did we already successfully run this idempotency key?
// After a tool executes, persist: key → result so any future run skips it.
//
// Two layers:
//   1. In-memory Map  — O(1) lookup, survives restarts only via disk
//   2. JSONL file     — persisted, append-only, loaded once at first access
//
// Cache key = node.idempotencyKey (unique per goal+node combination).
// An entry is only cached on SUCCESS — failures are not cached so they can retry.

import * as fs   from 'node:fs'
import * as path from 'node:path'
import * as os   from 'node:os'
import type { ToolResult } from './types.js'

const TOOL_LOGS_FILE = process.env['AXON_TOOL_LOGS'] ?? path.join(os.homedir(), '.aria', 'tool_logs.jsonl')

interface CacheEntry {
  key:      string
  toolName: string
  result:   ToolResult
  ts:       number
  pid:      number
}

// Loaded lazily on first access
let _cache: Map<string, CacheEntry> | null = null

function ensureDir(): void {
  const dir = path.dirname(TOOL_LOGS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function getCache(): Map<string, CacheEntry> {
  if (_cache !== null) return _cache

  _cache = new Map()
  try {
    if (!fs.existsSync(TOOL_LOGS_FILE)) return _cache
    const lines = fs.readFileSync(TOOL_LOGS_FILE, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CacheEntry
        if (entry.result.success) {
          // Last write wins per key — allows overwrite if re-run after partial corruption
          _cache.set(entry.key, entry)
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File missing or unreadable — start empty
  }

  return _cache
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getCached(key: string): ToolResult | null {
  const entry = getCache().get(key)
  return entry?.result ?? null
}

export function cacheResult(key: string, toolName: string, result: ToolResult): void {
  if (!result.success) return   // only cache successes

  ensureDir()

  const entry: CacheEntry = { key, toolName, result, ts: Date.now(), pid: process.pid }

  // Persist to disk first (fsync for durability)
  const line = JSON.stringify(entry) + '\n'
  const buf  = Buffer.from(line)
  const fd   = fs.openSync(TOOL_LOGS_FILE, 'a')
  try {
    fs.writeSync(fd, buf)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  // Update in-memory cache
  getCache().set(key, entry)
}

export function hasCached(key: string): boolean {
  return getCache().has(key)
}

// Clears in-memory cache only — does not delete the file.
// Useful in tests to force a fresh load from disk.
export function resetMemoryCache(): void {
  _cache = null
}

export function getToolLogsFile(): string {
  return TOOL_LOGS_FILE
}
