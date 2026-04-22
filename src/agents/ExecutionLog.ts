// ── ExecutionLog — append-only JSONL execution event log ─────────────────────
//
// Every state transition (node_started, node_completed, node_failed …) is
// appended to a single JSONL file.  The log is the authoritative audit trail.
// replayStateFromLog() reconstructs in-memory state from the log for crash recovery.
// Writes use fsync to survive power loss.

import * as fs   from 'node:fs'
import * as path from 'node:path'
import * as os   from 'node:os'
import type { ExecutionLogEntry, ExecutionLogEvent } from './types.js'

const LOG_FILE = process.env['AXON_EXEC_LOG'] ?? path.join(os.homedir(), '.aria', 'execution_log.jsonl')

function ensureDir(): void {
  const dir = path.dirname(LOG_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function appendLog(entry: ExecutionLogEntry): void {
  ensureDir()
  const line = JSON.stringify(entry) + '\n'
  const buf  = Buffer.from(line)
  const fd   = fs.openSync(LOG_FILE, 'a')
  try {
    fs.writeSync(fd, buf)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function loadLog(): ExecutionLogEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    return fs.readFileSync(LOG_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as ExecutionLogEntry)
  } catch {
    return []
  }
}

// ── Replay ────────────────────────────────────────────────────────────────────

export interface ReplayedNodeState {
  nodeId:         string
  planId:         string
  lastEvent:      ExecutionLogEvent
  lastExecutionId: string
  success?:       boolean
  error?:         string
  completedAt?:   number
}

export function replayStateFromLog(planId: string): Map<string, ReplayedNodeState> {
  const entries = loadLog().filter(e => e.planId === planId)
  const state   = new Map<string, ReplayedNodeState>()

  for (const entry of entries) {
    const prev = state.get(entry.nodeId)
    state.set(entry.nodeId, {
      nodeId:          entry.nodeId,
      planId:          entry.planId,
      lastEvent:       entry.event,
      lastExecutionId: entry.executionId,
      success:         entry.success ?? prev?.success,
      error:           entry.error   ?? prev?.error,
      completedAt:     entry.event === 'node_completed' ? entry.ts : prev?.completedAt,
    })
  }

  return state
}

export function verifyPlanConsistency(
  planId: string,
  nodeIds: string[],
): { consistent: boolean; diverged: string[] } {
  const logState = replayStateFromLog(planId)
  const diverged: string[] = []

  for (const nodeId of nodeIds) {
    const ls = logState.get(nodeId)
    if (!ls) continue
    if (ls.lastEvent === 'node_completed' && ls.success !== true) {
      diverged.push(nodeId)
    }
  }

  return { consistent: diverged.length === 0, diverged }
}

export function getLogFile(): string {
  return LOG_FILE
}
