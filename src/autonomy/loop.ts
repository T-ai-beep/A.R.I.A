/**
 * loop.ts — the AXON autonomy loop.
 *
 * Runs continuously independent of user input.
 * Each cycle:
 *   1. Load active goals + open tasks
 *   2. evaluateState() → ranked list of AutonomyActions
 *   3. Dispatch each action through axonRoute() concurrently
 *
 * Non-blocking guarantees:
 *   - Re-entrant guard: slow cycles are skipped, not queued
 *   - All dispatches use Promise.allSettled — one failure never kills another
 *   - Errors are caught and logged, never propagated to setInterval
 *
 * Tunable via env:
 *   AXON_LOOP_INTERVAL_MS   default 5000
 *   AXON_STALE_MS           default 300000 (5min) — in evaluator.ts
 *   AXON_MAX_ACTIONS        default 2       — in evaluator.ts
 */

import { getActiveGoals } from './goals.js'
import { getOpenTasks }   from '../pipeline/tasks.js'
import { evaluateState, AutonomyAction } from './evaluator.js'
import { axonRoute, makeInput } from '../agents/AXONCore.js'
import { isGoalLocked, clearExpiredLeases } from '../world/WorldState.js'

const LOOP_INTERVAL_MS = parseInt(process.env.AXON_LOOP_INTERVAL_MS ?? '5000', 10)

let _timer:      NodeJS.Timeout | null = null
let _running     = false
let _cycleCount  = 0

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function startAutonomyLoop(): void {
  if (_timer) return
  console.log(`[LOOP] starting — interval ${LOOP_INTERVAL_MS}ms`)
  runCycle().catch(console.error)
  _timer = setInterval(() => { runCycle().catch(console.error) }, LOOP_INTERVAL_MS)
}

export function stopAutonomyLoop(): void {
  if (!_timer) return
  clearInterval(_timer)
  _timer = null
  console.log('[LOOP] stopped')
}

export function isLoopRunning():  boolean { return _timer !== null }
export function getCycleCount():  number  { return _cycleCount }

// ── Core cycle ───────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  if (_running) {
    console.log('[LOOP] skipped — previous cycle still running')
    return
  }

  _running = true
  const cycle = ++_cycleCount

  try {
    clearExpiredLeases()

    const goals = getActiveGoals()
    const tasks = getOpenTasks()

    // Skip quietly if nothing is actionable
    const hasOverdue = tasks.some(t => t.resurfaceAt !== null && t.resurfaceAt < Date.now())
    if (goals.length === 0 && !hasOverdue) return

    console.log(`[LOOP] cycle ${cycle} — ${goals.length} active goal(s) | ${tasks.filter(t => t.status === 'open').length} open task(s)`)

    const actions = await evaluateState(goals, tasks)

    if (actions.length === 0) {
      console.log(`[LOOP] cycle ${cycle} — nothing to dispatch`)
      return
    }

    console.log(`[LOOP] cycle ${cycle} — ${actions.length} action(s) to dispatch`)

    await Promise.allSettled(
      actions.map(a => dispatch(a, cycle))
    )

  } catch (err) {
    console.error(`[LOOP] cycle ${cycle} unhandled error:`, err)
  } finally {
    _running = false
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(action: AutonomyAction, cycle: number): Promise<void> {
  const tag = action.goalId
    ? `goal:${action.goalId.slice(-8)}`
    : action.taskId
    ? `task:${action.taskId.slice(-8)}`
    : 'adhoc'

  // Skip if this goal is currently being executed by another agent
  if (action.goalId && isGoalLocked(action.goalId)) {
    console.log(`[LOOP] skipped [${tag}] — goal locked by active agent`)
    return
  }

  console.log(`[LOOP] ↳ [${tag}] "${action.input.slice(0, 80)}" — ${action.reason}`)

  const input = makeInput(action.input, 'system_trigger', action.type, {
    ...(action.goalId ? { goalId: action.goalId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    loopCycle: cycle,
  })

  try {
    await axonRoute(input)
  } catch (err) {
    // Log and continue — a failed dispatch must never crash the loop
    console.error(`[LOOP] dispatch error [${tag}]:`, err)
  }
}
