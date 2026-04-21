/**
 * Planner — creates structured execution plans for goals.
 *
 * Plans are created ONCE per goal and persisted to disk.
 * Subsequent calls for the same goal return the existing plan.
 * No replanning on failure — the Coordinator drives retry at the node level.
 *
 * Storage: ~/.aria/plans.json  (Record<planId, Plan>)
 */

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'
import { Plan, PlanNode } from './types.js'
import { selectTool }     from '../execution/AgentManager.js'
import { CONFIG }         from '../config.js'
import { writeAtomic }    from '../world/atomicWrite.js'

const ARIA_DIR    = path.join(os.homedir(), '.aria')
const PLANS_FILE  = path.join(ARIA_DIR, 'plans.json')
const MAX_NODES   = 6

// ── Persistence ────────────────────────────────────────────────────────────

type PlanStore = Record<string, Plan>

let _cache:     PlanStore | null = null
let _cacheTime: number           = 0
const CACHE_TTL = 500

function loadStore(): PlanStore {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache
  if (!fs.existsSync(PLANS_FILE)) {
    _cache = {}; _cacheTime = Date.now(); return _cache
  }
  try {
    _cache     = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf-8')) as PlanStore
    _cacheTime = Date.now()
    return _cache
  } catch {
    _cache = {}; _cacheTime = Date.now(); return _cache
  }
}

function saveStore(store: PlanStore): void {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
  writeAtomic(PLANS_FILE, JSON.stringify(store, null, 2))
  _cache     = store
  _cacheTime = Date.now()
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// ── Plan queries ───────────────────────────────────────────────────────────

export function getPlan(planId: string): Plan | null {
  return loadStore()[planId] ?? null
}

export function getPlanForGoal(goalId: string): Plan | null {
  const store = loadStore()
  return Object.values(store).find(p => p.goalId === goalId) ?? null
}

// ── Plan mutations ─────────────────────────────────────────────────────────

export function updateNode(
  planId: string,
  nodeId: string,
  updates: Partial<PlanNode>
): Plan | null {
  const store = loadStore()
  const plan  = store[planId]
  if (!plan) return null

  const idx = plan.nodes.findIndex(n => n.id === nodeId)
  if (idx === -1) return null

  plan.nodes[idx] = { ...plan.nodes[idx], ...updates }
  saveStore(store)
  return plan
}

export function completePlan(planId: string): void {
  const store = loadStore()
  if (store[planId]) { store[planId].status = 'complete'; saveStore(store) }
}

export function blockPlan(planId: string): void {
  const store = loadStore()
  if (store[planId]) { store[planId].status = 'blocked'; saveStore(store) }
}

// ── LLM plan generation ────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a task decomposition engine for an AI agent.
Break the goal into a JSON array of concrete, sequential steps.
Each step must be a single sentence describing exactly ONE action.
Each step MUST map to one of these tools: browser.search, browser.scrape, email.send, calendar.schedule, file.write, api.call.
Rules:
- Maximum ${MAX_NODES} steps
- Steps must be ordered: gather data first, then act on it
- Be specific: "search for HVAC contractors in Seattle" not "do research"
- Return ONLY a valid JSON array of strings — no explanation, no markdown
Example: ["search for HVAC businesses in Austin TX", "scrape contact details from top 5 results", "write contacts to file hvac_leads.txt", "send email with leads summary"]`

async function generateSteps(description: string): Promise<string[]> {
  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    CONFIG.OLLAMA_MODEL,
        stream:   false,
        messages: [
          { role: 'system', content: PLAN_SYSTEM },
          { role: 'user',   content: `Goal: ${description}` },
        ],
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_SUMMARY_TIMEOUT_MS),
    })

    const data    = await res.json() as { message?: { content?: string } }
    const content = (data.message?.content ?? '').trim()
    const match   = content.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('no JSON array in LLM response')

    const parsed = JSON.parse(match[0]) as unknown[]
    const steps  = parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    if (steps.length === 0) throw new Error('empty step list')

    return steps.slice(0, MAX_NODES)

  } catch (err) {
    console.warn(`[PLANNER] LLM plan failed (${err}) — using rule-based fallback`)
    return ruleBasedPlan(description)
  }
}

function ruleBasedPlan(description: string): string[] {
  const d     = description.toLowerCase()
  const steps: string[] = []
  if (/find|search|research|look up|leads?|competitors?/.test(d)) steps.push(`search for: ${description}`)
  if (/website|url|page|scrape|extract|contact/.test(d))          steps.push(`scrape contact information from search results`)
  if (/email|send|contact|outreach|message/.test(d))              steps.push(`send email with collected results`)
  if (/schedule|calendar|book|meeting|appointment/.test(d))       steps.push(`schedule meeting: ${description}`)
  if (/save|write|store|file|export|report/.test(d))              steps.push(`write results to file`)
  if (steps.length === 0) {
    steps.push(`search for: ${description}`, `write results to file axon_output.txt`)
  }
  return steps
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Create a plan for goalId. Returns the existing plan if one already exists.
 * Plans are immutable once created — no regeneration per cycle.
 */
export async function createPlan(goalId: string, description: string): Promise<Plan> {
  // Return existing plan for this goal — create ONCE, reuse always
  const existing = getPlanForGoal(goalId)
  if (existing) {
    console.log(`[PLANNER] reusing existing plan ${existing.id} for goal ${goalId}`)
    return existing
  }

  console.log(`[PLANNER] creating plan for goal ${goalId}: "${description.slice(0, 60)}"`)

  const steps = await generateSteps(description)

  const nodes: PlanNode[] = steps.map((step, i) => ({
    id:          genId(`node${i}`),
    description: step,
    tool:        selectTool(step),
    status:      'pending',
    attempts:    0,
    maxAttempts: 3,
  }))

  const plan: Plan = {
    id:        genId('plan'),
    goalId,
    nodes,
    edges:     nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
    status:    'active',
    createdAt: Date.now(),
  }

  const store      = loadStore()
  store[plan.id]   = plan
  saveStore(store)

  console.log(`[PLANNER] plan ${plan.id} created — ${nodes.length} nodes: ${nodes.map((n, i) => `\n  ${i + 1}. [${n.tool}] ${n.description}`).join('')}`)
  return plan
}
