/**
 * loop.ts — the AXON autonomy loop.
 *
 * Two parallel tracks per cycle:
 *
 *   GOALS  → coordinator.acceptGoal(id)
 *             Structured, stateful execution via Planner + Coordinator.
 *             Plans are created once; nodes execute one-per-cycle.
 *             Lease system prevents duplicate execution across cycles.
 *
 *   TASKS  → evaluateState([], tasks) → dispatch() → axonRoute()
 *             Overdue task follow-ups via the existing evaluator path.
 *
 * Non-blocking guarantees:
 *   - Re-entrant guard: slow cycles are skipped, not queued
 *   - Promise.allSettled: one failure never kills another
 *   - Errors caught and logged, never propagated to setInterval
 *
 * Tunable via env:
 *   AXON_LOOP_INTERVAL_MS   default 5000
 *   AXON_MAX_ACTIONS        default 2   (task evaluator cap)
 */

import { getActiveGoals }                  from './goals.js'
import { getOpenTasks }                    from '../pipeline/tasks.js'
import { evaluateState, AutonomyAction }   from './evaluator.js'
import { axonRoute, makeInput }            from '../agents/AXONCore.js'
import { isGoalLocked, clearExpiredLeases } from '../world/WorldState.js'
import { coordinator }                     from '../agents/Coordinator.js'

const LOOP_INTERVAL_MS = parseInt(process.env.AXON_LOOP_INTERVAL_MS ?? '5000', 10)

let _timer:     NodeJS.Timeout | null = null
let _running    = false
let _cycleCount = 0

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

export function isLoopRunning(): boolean { return _timer !== null }
export function getCycleCount(): number  { return _cycleCount }

// ── Core cycle ────────────────────────────────────────────────────────────────

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

    const hasWork = goals.length > 0 ||
      tasks.some(t => t.resurfaceAt !== null && t.resurfaceAt < Date.now())

    if (!hasWork) return

    console.log(
      `[LOOP] cycle ${cycle} — ${goals.length} active goal(s) | ` +
      `${tasks.filter(t => t.status === 'open').length} open task(s)`
    )

    // ── Goal track: Coordinator handles structured plan execution ────────────
    const goalWork = goals.map(goal => {
      if (isGoalLocked(goal.id)) {
        console.log(`[LOOP] goal ${goal.id.slice(-8)} locked — skipping`)
        return Promise.resolve()
      }
      return coordinator.acceptGoal(goal.id).catch(err =>
        console.error(`[LOOP] coordinator error for goal ${goal.id}:`, err)
      )
    })

    // ── Task track: evaluator handles overdue task follow-ups ────────────────
    // Pass empty goals array — evaluator is only used for task actions now
    const taskActions = await evaluateState([], tasks)
    const taskWork = taskActions.map(a => dispatch(a, cycle))

    await Promise.allSettled([...goalWork, ...taskWork])

  } catch (err) {
    console.error(`[LOOP] cycle ${cycle} unhandled error:`, err)
  } finally {
    _running = false
  }
}

// ── Task dispatch (legacy path for overdue task follow-ups) ──────────────────

async function dispatch(action: AutonomyAction, cycle: number): Promise<void> {
  const tag = action.taskId ? `task:${action.taskId.slice(-8)}` : 'adhoc'

  console.log(`[LOOP] ↳ [${tag}] "${action.input.slice(0, 80)}" — ${action.reason}`)

  const input = makeInput(action.input, 'system_trigger', action.type, {
    ...(action.taskId ? { taskId: action.taskId } : {}),
    loopCycle: cycle,
  })

  try {
    await axonRoute(input)
  } catch (err) {
    console.error(`[LOOP] dispatch error [${tag}]:`, err)
  }
}
