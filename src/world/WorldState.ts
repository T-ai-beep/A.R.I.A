/**
 * WorldState.ts — minimal coordination layer.
 *
 * Single source of truth for goal state + lease ownership.
 *
 * Design:
 *   - Goals stored in ~/.aria/world_goals.json via writeAtomic
 *   - version field enables optimistic concurrency (stale writes throw)
 *   - Lease map is in-memory only — intentionally not persisted
 *     (leases expire on restart, which is the correct behaviour)
 *   - LEASE_TIMEOUT_MS: lease auto-expires if holder crashes
 *
 * Key exports:
 *   getGoal(id)            — throws if missing
 *   getGoalOrNull(id)      — null if missing
 *   saveGoal(goal)         — increments version, throws on stale write
 *   createGoalInWorld(...) — create new goal with version=0
 *   listActiveGoals()      — sorted by priority
 *   acquireLease(goalId, agentId) → boolean
 *   releaseLease(goalId)
 *   isGoalLocked(goalId)   → boolean (respects timeout)
 *   clearExpiredLeases()
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { writeAtomic } from './atomicWrite.js'

const ARIA_DIR         = path.join(os.homedir(), '.aria')
const GOALS_FILE       = path.join(ARIA_DIR, 'world_goals.json')
const LEASE_TIMEOUT_MS = 5 * 60 * 1_000   // 5 minutes
const CACHE_TTL_MS     = 500              // re-read disk at most every 500ms

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorldGoal {
  id:             string
  description:    string
  status:         'active' | 'paused' | 'completed' | 'failed'
  priority:       'low' | 'medium' | 'high'
  progress:       number           // 0–1
  version:        number           // incremented on every save
  createdAt:      number
  updatedAt:      number
  lastActivityAt: number           // 0 = never acted on
  nextAction?:    string
  completedSteps: string[]
  linkedAgentIds: string[]
}

interface LeaseEntry {
  agentId:    string
  acquiredAt: number
}

// ── In-memory state ────────────────────────────────────────────────────────

const _leases = new Map<string, LeaseEntry>()

let _cache:     WorldGoal[] | null = null
let _cacheTime: number             = 0

// ── Persistence ────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): WorldGoal[] {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS) return _cache

  ensureDir()
  if (!fs.existsSync(GOALS_FILE)) {
    _cache = []; _cacheTime = Date.now(); return _cache
  }
  try {
    _cache     = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8')) as WorldGoal[]
    _cacheTime = Date.now()
    return _cache
  } catch (e) {
    console.error('[WORLD] goals parse failed:', e)
    _cache = []; _cacheTime = Date.now(); return _cache
  }
}

function persistAll(goals: WorldGoal[]): void {
  ensureDir()
  writeAtomic(GOALS_FILE, JSON.stringify(goals, null, 2))
  _cache     = goals
  _cacheTime = Date.now()
}

// ── Goal queries ───────────────────────────────────────────────────────────

/** Throws if goal does not exist. Use for code paths that must have a valid goal. */
export function getGoal(goalId: string): WorldGoal {
  const goal = loadAll().find(g => g.id === goalId)
  if (!goal) throw new Error(`WorldState: goal not found: ${goalId}`)
  return { ...goal }
}

export function getGoalOrNull(goalId: string): WorldGoal | null {
  return loadAll().find(g => g.id === goalId) ?? null
}

export function listActiveGoals(): WorldGoal[] {
  const rank: Record<WorldGoal['priority'], number> = { high: 0, medium: 1, low: 2 }
  return loadAll()
    .filter(g => g.status === 'active')
    .sort((a, b) => rank[a.priority] - rank[b.priority])
}

export function getAllGoalsFromWorld(): WorldGoal[] {
  return [...loadAll()]
}

// ── Goal mutations ─────────────────────────────────────────────────────────

export function createGoalInWorld(
  id:          string,
  description: string,
  priority:    WorldGoal['priority'] = 'medium',
  nextAction?: string
): WorldGoal {
  const now: number = Date.now()
  const goal: WorldGoal = {
    id,
    description,
    status:         'active',
    priority,
    progress:       0,
    version:        0,
    createdAt:      now,
    updatedAt:      now,
    lastActivityAt: 0,
    nextAction,
    completedSteps: [],
    linkedAgentIds: [],
  }
  const all = loadAll()
  if (all.some(g => g.id === id)) {
    throw new Error(`WorldState: goal already exists: ${id}`)
  }
  all.push(goal)
  persistAll(all)
  console.log(`[WORLD] goal created — id=${id} priority=${priority}`)
  return goal
}

/**
 * Persist a goal update. Increments version automatically.
 * Throws on stale write (optimistic concurrency).
 */
export function saveGoal(goal: WorldGoal): WorldGoal {
  const all = loadAll()
  const idx = all.findIndex(g => g.id === goal.id)

  if (idx === -1) {
    // New goal inserted without createGoalInWorld — allow it
    const saved: WorldGoal = { ...goal, version: 0, updatedAt: Date.now() }
    all.push(saved)
    persistAll(all)
    return saved
  }

  const current = all[idx]
  if (current.version !== goal.version) {
    throw new Error(
      `WorldState: stale write for goal ${goal.id} ` +
      `(disk version=${current.version}, write version=${goal.version})`
    )
  }

  const saved: WorldGoal = { ...goal, version: goal.version + 1, updatedAt: Date.now() }
  all[idx] = saved
  persistAll(all)
  return saved
}

// ── Lease system ───────────────────────────────────────────────────────────

/**
 * Acquire exclusive execution rights for a goal.
 * Returns true on success. Returns false if already locked by a different agent.
 * Expired leases (> LEASE_TIMEOUT_MS old) are reclaimed automatically.
 */
export function acquireLease(goalId: string, agentId: string): boolean {
  const existing = _leases.get(goalId)
  const now      = Date.now()

  if (existing) {
    const age = now - existing.acquiredAt
    if (age < LEASE_TIMEOUT_MS) {
      // Same agent re-acquiring = ok (idempotent)
      if (existing.agentId === agentId) return true
      // Different agent within timeout = deny
      return false
    }
    // Expired — log and reclaim
    console.warn(
      `[WORLD] lease for goal=${goalId} expired after ${Math.round(age / 1000)}s ` +
      `(was held by ${existing.agentId}) — reclaiming for ${agentId}`
    )
  }

  _leases.set(goalId, { agentId, acquiredAt: now })
  console.log(`[WORLD] lease acquired — goal=${goalId} agent=${agentId}`)
  return true
}

export function releaseLease(goalId: string, agentId?: string): void {
  const existing = _leases.get(goalId)
  if (!existing) return
  if (agentId && existing.agentId !== agentId) {
    console.warn(`[WORLD] releaseLease ignored — goal=${goalId} held by ${existing.agentId}, not ${agentId}`)
    return
  }
  _leases.delete(goalId)
  console.log(`[WORLD] lease released — goal=${goalId}`)
}

export function isGoalLocked(goalId: string): boolean {
  const entry = _leases.get(goalId)
  if (!entry) return false
  if (Date.now() - entry.acquiredAt >= LEASE_TIMEOUT_MS) {
    _leases.delete(goalId)
    return false
  }
  return true
}

export function getLeaseHolder(goalId: string): string | null {
  const entry = _leases.get(goalId)
  if (!entry) return null
  if (Date.now() - entry.acquiredAt >= LEASE_TIMEOUT_MS) {
    _leases.delete(goalId)
    return null
  }
  return entry.agentId
}

export function clearExpiredLeases(): void {
  const now = Date.now()
  for (const [goalId, entry] of _leases.entries()) {
    if (now - entry.acquiredAt >= LEASE_TIMEOUT_MS) {
      console.log(`[WORLD] expired lease cleared — goal=${goalId} (was held by ${entry.agentId})`)
      _leases.delete(goalId)
    }
  }
}

export function getLeaseCount(): number {
  clearExpiredLeases()
  return _leases.size
}
