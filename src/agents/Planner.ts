// ── Planner — sole authority for plan creation ────────────────────────────────
//
// Creates and persists deterministic plans for goals.
// Rule-based decomposition only — NO LLM calls.
// Plans are stored at ~/.aria/plans.json and reused for identical goals.

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import type { Plan, PlanNode } from './types.js'

const PLANS_FILE = process.env['AXON_PLANS_FILE'] ?? path.join(os.homedir(), '.aria', 'plans.json')

// ── Rule-based goal decomposition ────────────────────────────────────────────

interface StepSpec {
  step:      string
  toolName:  string
  toolInput: Record<string, unknown>
}

function decomposeGoal(goal: string): StepSpec[] {
  const specs: StepSpec[] = []

  if (/search|find|look up|research|competitor/i.test(goal)) {
    const query = goal.replace(/^(search for|find|look up|research)\s+/i, '').trim() || goal
    specs.push({ step: `search for ${query}`, toolName: 'browser.search', toolInput: { query } })
  }

  if (/scrape|extract|read.*page|fetch.*url/i.test(goal)) {
    specs.push({
      step:      'scrape and extract key info from results',
      toolName:  'browser.scrape',
      toolInput: { url: '' },   // resolved from context at execution time
    })
  }

  if (/summarize|summary|write|draft/i.test(goal)) {
    specs.push({
      step:      'write summary to file',
      toolName:  'file.write',
      toolInput: { filename: `plan_${Date.now()}.txt`, content: '' },
    })
  }

  if (/email|send|message/i.test(goal)) {
    const toMatch = goal.match(/(?:to|email)\s+([^\s,]+@[^\s,]+)/i)
    const to      = toMatch?.[1]?.trim() ?? 'pending@axon.local'
    specs.push({
      step:      `send email to ${to}`,
      toolName:  'email.send',
      toolInput: { to, subject: `Re: ${goal.slice(0, 60)}`, body: '' },
    })
  }

  if (/schedule|book|calendar|meeting/i.test(goal)) {
    specs.push({
      step:      `schedule: ${goal}`,
      toolName:  'calendar.schedule',
      toolInput: { title: goal, datetime: '', notes: goal },
    })
  }

  if (/\bapi\b|https?:\/\/|endpoint/i.test(goal)) {
    const urlMatch = goal.match(/https?:\/\/[^\s]+/i)
    specs.push({
      step:      `api call for: ${goal}`,
      toolName:  'api.call',
      toolInput: { url: urlMatch?.[0] ?? '', method: 'GET' },
    })
  }

  // Fallback: always have at least one step
  if (specs.length === 0) {
    specs.push({ step: `search for ${goal}`, toolName: 'browser.search', toolInput: { query: goal } })
  }

  return specs
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadPlans(): Plan[] {
  try {
    if (!fs.existsSync(PLANS_FILE)) return []
    return JSON.parse(fs.readFileSync(PLANS_FILE, 'utf-8')) as Plan[]
  } catch {
    return []
  }
}

function savePlans(plans: Plan[]): void {
  const dir = path.dirname(PLANS_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  // Atomic-ish write: write to tmp then rename
  const tmp = PLANS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(plans, null, 2), 'utf-8')
  fs.renameSync(tmp, PLANS_FILE)
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createPlan(goal: string): Plan {
  const plans = loadPlans()

  // Idempotent: reuse existing active plan for same goal text
  const existing = plans.find(p => p.goal === goal && p.state === 'active')
  if (existing) {
    console.log(`[PLANNER] reusing plan ${existing.id} — ${existing.nodes.length} nodes for goal="${goal}"`)
    return existing
  }

  const goalId  = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const specs   = decomposeGoal(goal)

  const nodes: PlanNode[] = specs.map((s, i) => ({
    id:             `node_${i}`,
    goalId,
    step:           s.step,
    toolName:       s.toolName,
    toolInput:      s.toolInput,
    state:          'pending',
    idempotencyKey: `${goalId}:node_${i}`,
  }))

  const plan: Plan = { id: goalId, goal, createdAt: Date.now(), state: 'active', nodes }

  plans.push(plan)
  savePlans(plans)
  console.log(`[PLANNER] created plan ${goalId} — ${nodes.length} nodes for goal="${goal}"`)
  return plan
}

export function getPlan(planId: string): Plan | null {
  return loadPlans().find(p => p.id === planId) ?? null
}

export function updateNode(planId: string, nodeId: string, updates: Partial<PlanNode>): void {
  const plans = loadPlans()
  const plan  = plans.find(p => p.id === planId)
  if (!plan) return
  const node  = plan.nodes.find(n => n.id === nodeId)
  if (!node) return

  Object.assign(node, updates)

  // Promote plan state once all nodes are terminal
  if (plan.nodes.every(n => n.state === 'completed' || n.state === 'failed')) {
    plan.state = plan.nodes.every(n => n.state === 'completed') ? 'completed' : 'failed'
  }

  savePlans(plans)
}
