/**
 * evaluator.ts — state evaluation for the AXON autonomy loop.
 *
 * evaluateState() is called every loop cycle. It inspects active goals
 * and overdue tasks, then returns a prioritized list of AutonomyActions
 * capped at MAX_ACTIONS_PER_CYCLE to prevent agent overload.
 *
 * Decision rules (in priority order):
 *   1. Goal has a queued nextAction  → dispatch it immediately
 *   2. Goal is brand-new (never run) → derive and dispatch first step
 *   3. Goal is stale (no activity)   → derive and dispatch next step
 *   4. Task is overdue               → trigger follow-up execution
 */

import { Goal, updateGoal } from './goals.js'
import { Task } from '../pipeline/tasks.js'
import { CONFIG } from '../config.js'

export interface AutonomyAction {
  input: string
  type: 'execution_request' | 'task_creation'
  goalId?: string
  taskId?: string
  reason: string
}

const STALE_THRESHOLD_MS   = parseInt(process.env.AXON_STALE_MS   ?? String(5 * 60_000), 10)
const MAX_ACTIONS_PER_CYCLE = parseInt(process.env.AXON_MAX_ACTIONS ?? '2', 10)

// ── Main entry point ─────────────────────────────────────────────────────────

export async function evaluateState(
  goals: Goal[],
  tasks: Task[]
): Promise<AutonomyAction[]> {
  const actions: AutonomyAction[] = []

  for (const goal of sortByPriority(goals)) {
    if (actions.length >= MAX_ACTIONS_PER_CYCLE) break
    const action = await evaluateGoal(goal)
    if (action) actions.push(action)
  }

  if (actions.length < MAX_ACTIONS_PER_CYCLE) {
    appendOverdueTasks(tasks, actions)
  }

  return actions
}

// ── Goal evaluation ──────────────────────────────────────────────────────────

async function evaluateGoal(goal: Goal): Promise<AutonomyAction | null> {
  // 1. Consume queued next action
  if (goal.nextAction) {
    const queued = goal.nextAction
    updateGoal(goal.id, { nextAction: undefined })   // consume before dispatch to prevent double-fire
    return {
      input:  queued,
      type:   'execution_request',
      goalId: goal.id,
      reason: `queued next action`,
    }
  }

  // 2. Brand-new goal — never acted on
  const neverRun = goal.progress === 0 && goal.completedSteps.length === 0
  if (neverRun) {
    const step = await deriveNextStep(goal)
    if (!step) return null
    return {
      input:  step,
      type:   'execution_request',
      goalId: goal.id,
      reason: `new goal — initial execution`,
    }
  }

  // 3. Incomplete goal gone quiet past stale threshold
  const msSinceActivity = Date.now() - goal.lastActivityAt
  if (msSinceActivity > STALE_THRESHOLD_MS && goal.progress < 1) {
    const step = await deriveNextStep(goal)
    if (!step) return null
    return {
      input:  step,
      type:   'execution_request',
      goalId: goal.id,
      reason: `stale ${Math.round(msSinceActivity / 60_000)}min, progress=${Math.round(goal.progress * 100)}%`,
    }
  }

  return null
}

// ── LLM-driven step derivation ────────────────────────────────────────────────

async function deriveNextStep(goal: Goal): Promise<string | null> {
  const pct        = Math.round(goal.progress * 100)
  const doneCtx    = goal.completedSteps.length > 0
    ? `Completed steps: ${goal.completedSteps.slice(-3).join('; ')}.`
    : 'No steps completed yet.'

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          {
            role:    'system',
            content: [
              'You are an autonomous agent planner.',
              'Given a goal and its current state, output exactly ONE concrete next step.',
              'The step must map to one of: browser.search, browser.scrape, email.send,',
              'calendar.schedule, file.write, api.call.',
              'Output only the step sentence — no explanation, no numbering, no quotes.',
            ].join(' '),
          },
          {
            role:    'user',
            content: `Goal: ${goal.description}\nProgress: ${pct}%\n${doneCtx}`,
          },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_SUMMARY_TIMEOUT_MS),
    })

    const data = await res.json() as { message?: { content?: string } }
    const step = data.message?.content?.trim() ?? ''
    return step.length > 5 ? step.slice(0, 200) : null

  } catch {
    // LLM down: fall back to heuristic
    if (goal.progress === 0)   return `search for: ${goal.description}`
    if (goal.progress < 0.5)  return `write progress report to file for: ${goal.description}`
    return null
  }
}

// ── Overdue tasks ─────────────────────────────────────────────────────────────

function appendOverdueTasks(tasks: Task[], actions: AutonomyAction[]): void {
  const now     = Date.now()
  const overdue = tasks
    .filter(t => t.status === 'open' && t.resurfaceAt !== null && t.resurfaceAt < now)
    .sort((a, b) => (a.resurfaceAt ?? 0) - (b.resurfaceAt ?? 0))

  for (const task of overdue) {
    if (actions.length >= MAX_ACTIONS_PER_CYCLE) break
    const overdueMin = Math.round((now - (task.resurfaceAt ?? now)) / 60_000)
    actions.push({
      input:  `Follow up on overdue task: ${task.description}`,
      type:   'execution_request',
      taskId: task.id,
      reason: `overdue by ${overdueMin}min`,
    })
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortByPriority(goals: Goal[]): Goal[] {
  const rank: Record<Goal['priority'], number> = { high: 0, medium: 1, low: 2 }
  return [...goals].sort((a, b) => rank[a.priority] - rank[b.priority])
}
