/**
 * AgentManager — sub-agent lifecycle management.
 *
 * Responsibilities:
 *   createAgent(goal)      — LLM-plan generation + SubAgent record
 *   executeAgent(agentId)  — sequential step execution with retries
 *   runAll()               — concurrent execution of all pending agents
 *
 * All agents are stored in-memory and fully observable (logs + state).
 */

import { SubAgent, StepResult, Tool } from '../agents/types.js'
import { CONFIG } from '../config.js'
import { getToolRegistry } from './tools/index.js'
import { acquireLease, releaseLease } from '../world/WorldState.js'

// ── In-memory agent store ────────────────────────────────────────────────────

const agentStore = new Map<string, SubAgent>()

function genId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function log(agent: SubAgent, message: string): void {
  agent.logs.push(`[${new Date().toISOString()}] ${message}`)
}

// ── Plan generation ──────────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a task decomposition engine for an AI agent.
Break the goal into a JSON array of concrete, sequential steps.
Each step must be a single sentence describing exactly ONE action.
Each step MUST map to one of these tools: browser.search, browser.scrape, email.send, calendar.schedule, file.write, api.call.
Rules:
- Maximum 6 steps
- Steps must be ordered: gather data first, then act on it
- Be specific: "search for HVAC contractors in Seattle" not "do research"
- Return ONLY a valid JSON array of strings — no explanation, no markdown
Example: ["search for HVAC businesses in Austin TX", "scrape contact details from top 5 results", "write contacts to file hvac_leads.txt", "send email with leads summary"]`

export async function generatePlan(goal: string): Promise<string[]> {
  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          { role: 'system', content: PLAN_SYSTEM },
          { role: 'user', content: `Goal: ${goal}` },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_SUMMARY_TIMEOUT_MS),
    })

    const data = await res.json() as { message?: { content?: string } }
    const content = (data.message?.content ?? '').trim()

    // Extract JSON array — LLM may wrap it in markdown or prose
    const match = content.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('no JSON array in response')

    const parsed = JSON.parse(match[0]) as unknown[]
    const steps = parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    if (steps.length === 0) throw new Error('empty plan')

    console.log(`[AGENT_MGR] plan generated for "${goal.slice(0, 60)}": ${steps.length} steps`)
    return steps.slice(0, 6)

  } catch (err) {
    console.warn(`[AGENT_MGR] LLM plan failed (${err}), using rule-based fallback`)
    return ruleBasedPlan(goal)
  }
}

function ruleBasedPlan(goal: string): string[] {
  const g = goal.toLowerCase()
  const steps: string[] = []

  if (/find|search|research|look up|leads?|competitors?/.test(g))  steps.push(`search for: ${goal}`)
  if (/website|url|page|scrape|extract|contact/.test(g))            steps.push(`scrape contact information from search results`)
  if (/email|send|contact|outreach|message/.test(g))               steps.push(`send email with collected results`)
  if (/schedule|calendar|book|meeting|appointment/.test(g))        steps.push(`schedule meeting: ${goal}`)
  if (/save|write|store|file|export|report/.test(g))               steps.push(`write results to file`)

  if (steps.length === 0) {
    steps.push(`search for: ${goal}`, `write results to file axon_output.txt`)
  }

  return steps
}

// ── Tool selection ────────────────────────────────────────────────────────────

export function selectTool(step: string): string {
  const s = step.toLowerCase()
  if (/\b(search for|find|look up|google|web search|research|browse)\b/.test(s)) return 'browser.search'
  if (/\b(scrape|extract from|fetch content|read page|get content|parse)\b/.test(s)) return 'browser.scrape'
  if (/\b(email|send email|mail|outreach|message|contact via email)\b/.test(s)) return 'email.send'
  if (/\b(calendar|schedule|book|appointment|meeting invite)\b/.test(s)) return 'calendar.schedule'
  if (/\b(save|write to file|store|export|create file|output)\b/.test(s)) return 'file.write'
  if (/\b(api|http request|call endpoint|fetch data|post to|get from)\b/.test(s)) return 'api.call'
  return 'browser.search'
}

function buildToolInput(
  step: string,
  toolName: string,
  previousResults: StepResult[],
  goal: string
): unknown {
  const lastSuccess = previousResults.filter(r => r.success).pop()
  const lastOutput  = lastSuccess?.output ?? null

  switch (toolName) {
    case 'browser.search':
      return {
        query: step
          .replace(/^(search for:?|find|look up|research)\s*/i, '')
          .trim() || goal,
      }

    case 'browser.scrape': {
      // Pull URL from previous search result if available
      const sr = lastOutput as { results?: Array<{ url?: string }> } | null
      const url = sr?.results?.[0]?.url ?? null
      return url ? { url } : { content: String(lastOutput ?? step) }
    }

    case 'email.send': {
      const bodyContent = lastOutput
        ? JSON.stringify(lastOutput, null, 2).slice(0, 2000)
        : `No prior results available.\n\nGoal: ${goal}`
      return {
        to:      process.env.AXON_EMAIL_TO ?? 'user@example.com',
        subject: `AXON Report: ${goal.slice(0, 60)}`,
        body:    `AXON Execution Report\n${'─'.repeat(40)}\nGoal: ${goal}\n\n${bodyContent}`,
      }
    }

    case 'calendar.schedule':
      return {
        title:    step.replace(/^(schedule|book|calendar):?\s*/i, '').trim() || goal,
        date:     'tomorrow',
        duration: 60,
        notes:    String(lastOutput ?? ''),
      }

    case 'file.write': {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      return {
        filename: `axon_${timestamp}.txt`,
        content: [
          `AXON Execution Output`,
          `Generated: ${new Date().toISOString()}`,
          `Goal: ${goal}`,
          ``,
          String(typeof lastOutput === 'object'
            ? JSON.stringify(lastOutput, null, 2)
            : (lastOutput ?? step)),
        ].join('\n'),
      }
    }

    case 'api.call':
      return {
        url:    String(lastOutput ?? 'https://api.example.com'),
        method: 'GET',
      }

    default:
      return { query: step }
  }
}

// ── Weak-result detection ─────────────────────────────────────────────────────
// A step result is "weak" if it produced no usable output for downstream steps.

function isWeakResult(result: StepResult): boolean {
  if (!result.success) return true
  if (result.output === null || result.output === undefined) return true
  if (typeof result.output === 'string' && result.output.trim().length < 10) return true
  if (typeof result.output === 'object' && result.output !== null) {
    const o = result.output as Record<string, unknown>
    if (Array.isArray(o['results']) && (o['results'] as unknown[]).length === 0) return true
    if (typeof o['wordCount'] === 'number' && o['wordCount'] < 20) return true
  }
  return false
}

// ── Adaptive replanning ───────────────────────────────────────────────────────
// Called when a step produces a weak result. Regenerates the remaining plan
// using what has succeeded so far as context.

async function replanRemaining(
  goal: string,
  remainingSteps: string[],
  completedResults: StepResult[]
): Promise<string[]> {
  const successCtx = completedResults
    .filter(r => r.success)
    .map(r => `- ${r.step} → ${JSON.stringify(r.output).slice(0, 100)}`)
    .join('\n') || 'none'

  const failCtx = completedResults
    .filter(r => !r.success)
    .map(r => `- ${r.step} → FAILED: ${r.error}`)
    .join('\n') || 'none'

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        messages: [
          {
            role:    'system',
            content: PLAN_SYSTEM +
              '\nIMPORTANT: Adapt the plan based on what has already succeeded and failed. ' +
              'If a step failed, try a different approach. Return ONLY a JSON array.',
          },
          {
            role:    'user',
            content: [
              `Goal: ${goal}`,
              `Succeeded:\n${successCtx}`,
              `Failed:\n${failCtx}`,
              `Original remaining steps: ${JSON.stringify(remainingSteps)}`,
              'Generate a revised plan for the remaining steps.',
            ].join('\n\n'),
          },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_SUMMARY_TIMEOUT_MS),
    })

    const data    = await res.json() as { message?: { content?: string } }
    const content = (data.message?.content ?? '').trim()
    const match   = content.match(/\[[\s\S]*\]/)
    if (!match) return remainingSteps

    const parsed  = JSON.parse(match[0]) as unknown[]
    const revised = parsed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    return revised.length > 0 ? revised.slice(0, 4) : remainingSteps

  } catch {
    return remainingSteps   // keep original on LLM error — do not stall execution
  }
}

// ── Step execution with retry ────────────────────────────────────────────────

const MAX_RETRIES = 2
const RETRY_BASE_MS = 500

async function executeStep(
  step: string,
  tools: Map<string, Tool>,
  previousResults: StepResult[],
  goal: string
): Promise<StepResult> {
  const toolName  = selectTool(step)
  const tool      = tools.get(toolName)
  const t0        = Date.now()

  if (!tool) {
    return {
      step, tool: toolName, input: null, output: null,
      success: false, error: `tool not registered: ${toolName}`, durationMs: 0,
    }
  }

  const toolInput = buildToolInput(step, toolName, previousResults, goal)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const output = await tool.execute(toolInput)
      return { step, tool: toolName, input: toolInput, output, success: true, durationMs: Date.now() - t0 }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt)
        console.warn(`[AGENT_MGR] step retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms — ${err}`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        return {
          step, tool: toolName, input: toolInput, output: null,
          success: false, error: String(err), durationMs: Date.now() - t0,
        }
      }
    }
  }

  // TypeScript requires this — unreachable in practice
  return { step, tool: toolName, input: toolInput, output: null, success: false, error: 'unreachable', durationMs: 0 }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createAgent(goal: string, goalId?: string): Promise<SubAgent> {
  const plan = await generatePlan(goal)
  const agent: SubAgent = {
    id:          genId(),
    goal,
    plan,
    state:       'pending',
    currentStep: 0,
    logs:        [],
    goalId,
  }
  log(agent, `created — ${plan.length} steps: ${plan.map((s, i) => `\n  ${i + 1}. ${s}`).join('')}`)
  agentStore.set(agent.id, agent)
  console.log(`[AGENT_MGR] ${agent.id} created for: "${goal.slice(0, 60)}"${goalId ? ` (goal=${goalId})` : ''}`)
  return agent
}

export async function executeAgent(agentId: string): Promise<SubAgent> {
  const agent = agentStore.get(agentId)
  if (!agent) throw new Error(`[AGENT_MGR] agent not found: ${agentId}`)

  // Acquire lease for linked world goal — prevents duplicate execution
  if (agent.goalId) {
    const acquired = acquireLease(agent.goalId, agent.id)
    if (!acquired) {
      agent.state = 'failed'
      log(agent, `failed to acquire lease — goal ${agent.goalId} already locked`)
      console.warn(`[AGENT_MGR] ${agent.id} aborted — goal ${agent.goalId} locked by another agent`)
      return agent
    }
  }

  agent.state     = 'running'
  agent.startedAt = Date.now()
  log(agent, 'execution started')

  const tools        = getToolRegistry()
  const stepResults: StepResult[] = []

  for (let i = 0; i < agent.plan.length; i++) {
    agent.currentStep = i
    const step = agent.plan[i]

    log(agent, `step ${i + 1}/${agent.plan.length}: ${step}`)
    console.log(`[AGENT_MGR] ${agent.id} step ${i + 1}: ${step}`)

    const result = await executeStep(step, tools, stepResults, agent.goal)
    stepResults.push(result)

    if (result.success) {
      log(agent, `step ${i + 1} ✓ tool=${result.tool} (${result.durationMs}ms)`)
    } else {
      log(agent, `step ${i + 1} ✗ ${result.error}`)
    }

    // Adaptive replanning: if this step was weak and more steps remain, regenerate
    const hasMoreSteps = i < agent.plan.length - 1
    if (isWeakResult(result) && hasMoreSteps) {
      log(agent, `step ${i + 1} produced weak result — replanning remaining steps`)
      const revised = await replanRemaining(
        agent.goal,
        agent.plan.slice(i + 1),
        stepResults
      )
      if (revised.join() !== agent.plan.slice(i + 1).join()) {
        agent.plan = [...agent.plan.slice(0, i + 1), ...revised]
        log(agent, `replanned: ${revised.map((s, j) => `\n  ${i + 2 + j}. ${s}`).join('')}`)
        console.log(`[AGENT_MGR] ${agent.id} replanned — ${revised.length} new step(s) from position ${i + 2}`)
      }
    }
  }

  const succeeded = stepResults.filter(r => r.success).length
  agent.state       = succeeded > 0 ? 'completed' : 'failed'
  agent.result      = stepResults
  agent.completedAt = Date.now()

  const elapsed = agent.completedAt - agent.startedAt!
  log(agent, `${agent.state} — ${succeeded}/${agent.plan.length} steps succeeded in ${elapsed}ms`)
  console.log(`[AGENT_MGR] ${agent.id} ${agent.state} (${succeeded}/${agent.plan.length} steps, ${elapsed}ms)`)

  // Release lease regardless of outcome
  if (agent.goalId) releaseLease(agent.goalId, agent.id)

  return agent
}

export function getAgent(id: string): SubAgent | undefined {
  return agentStore.get(id)
}

export function getAllAgents(): SubAgent[] {
  return Array.from(agentStore.values())
}

export function getAgentsByState(state: SubAgent['state']): SubAgent[] {
  return getAllAgents().filter(a => a.state === state)
}

/** Run all pending agents concurrently. */
export async function runAll(): Promise<SubAgent[]> {
  const pending = getAgentsByState('pending')
  if (pending.length === 0) return []
  console.log(`[AGENT_MGR] running ${pending.length} pending agents concurrently`)
  return Promise.all(pending.map(a => executeAgent(a.id)))
}
