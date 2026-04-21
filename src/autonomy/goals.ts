/**
 * goals.ts — persistent goal tracking for the AXON autonomy layer.
 *
 * Goals survive process restarts. They are the unit of long-term intent.
 * The autonomy loop reads active goals every cycle and generates actions
 * until progress reaches 1.0 and the goal is marked completed.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const GOALS_FILE = path.join(os.homedir(), '.aria', 'goals.json')

export interface Goal {
  id: string
  description: string
  status: 'active' | 'paused' | 'completed' | 'failed'
  priority: 'low' | 'medium' | 'high'
  progress: number       // 0–1
  nextAction?: string    // pre-queued step for next loop cycle
  createdAt: number
  lastUpdated: number
  lastActivityAt: number // 0 = never acted on (triggers first-cycle dispatch)
  completedSteps: string[]
  linkedAgentIds: string[]
}

// ── Persistence ──────────────────────────────────────────────────────────────

function ensureDir(): void {
  const dir = path.dirname(GOALS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadAll(): Goal[] {
  ensureDir()
  if (!fs.existsSync(GOALS_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8')) as Goal[]
  } catch { return [] }
}

function saveAll(goals: Goal[]): void {
  ensureDir()
  fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2), 'utf-8')
}

function genId(): string {
  return `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// ── Public API ───────────────────────────────────────────────────────────────

export function createGoal(
  description: string,
  priority: Goal['priority'] = 'medium',
  nextAction?: string
): Goal {
  const now = Date.now()
  const goal: Goal = {
    id: genId(),
    description: description.trim(),
    status: 'active',
    priority,
    progress: 0,
    nextAction,
    createdAt: now,
    lastUpdated: now,
    lastActivityAt: 0,  // signals "never acted on" → first loop cycle picks it up immediately
    completedSteps: [],
    linkedAgentIds: [],
  }
  const all = loadAll()
  all.push(goal)
  saveAll(all)
  console.log(`[GOAL] created — "${goal.description.slice(0, 60)}" id=${goal.id}`)
  return goal
}

export function updateGoal(
  id: string,
  updates: Partial<Omit<Goal, 'id' | 'createdAt'>>
): Goal | null {
  const all = loadAll()
  const idx = all.findIndex(g => g.id === id)
  if (idx === -1) return null
  all[idx] = { ...all[idx], ...updates, lastUpdated: Date.now() }
  saveAll(all)
  return all[idx]
}

export function getGoal(id: string): Goal | null {
  return loadAll().find(g => g.id === id) ?? null
}

export function getActiveGoals(): Goal[] {
  return loadAll().filter(g => g.status === 'active')
}

export function getAllGoals(): Goal[] {
  return loadAll()
}

export function completeGoal(id: string): void {
  updateGoal(id, { status: 'completed', progress: 1, lastActivityAt: Date.now() })
  console.log(`[GOAL] completed — id=${id}`)
}

export function failGoal(id: string): void {
  updateGoal(id, { status: 'failed', lastActivityAt: Date.now() })
  console.log(`[GOAL] failed — id=${id}`)
}

export function pauseGoal(id: string): void {
  updateGoal(id, { status: 'paused' })
}

export function resumeGoal(id: string): void {
  updateGoal(id, { status: 'active', lastActivityAt: 0 })
}

/**
 * Called by AXONCore after ExecutionAgent completes a cycle linked to this goal.
 * Advances progress, logs the step, and auto-completes when progress >= 1.
 */
export function recordGoalActivity(
  goalId: string,
  stepDescription: string,
  progressIncrement: number,
  agentId?: string
): void {
  const goal = getGoal(goalId)
  if (!goal) return

  const newProgress      = Math.min(1, goal.progress + progressIncrement)
  const completedSteps   = [...goal.completedSteps, stepDescription]
  const linkedAgentIds   = agentId
    ? [...new Set([...goal.linkedAgentIds, agentId])]
    : goal.linkedAgentIds

  updateGoal(goalId, {
    progress: newProgress,
    completedSteps,
    linkedAgentIds,
    lastActivityAt: Date.now(),
    nextAction: undefined,   // consumed — evaluator will derive the next one
  })

  console.log(
    `[GOAL] progress ${Math.round(goal.progress * 100)}% → ${Math.round(newProgress * 100)}%` +
    ` — "${stepDescription.slice(0, 60)}"`
  )

  if (newProgress >= 1) completeGoal(goalId)
}

/**
 * Queue a specific next action. The loop will dispatch it on the next cycle
 * without calling the LLM for step derivation.
 */
export function queueNextAction(goalId: string, action: string): void {
  updateGoal(goalId, { nextAction: action })
}
