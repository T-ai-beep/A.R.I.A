import { CONFIG }  from '../config.js'
import type { SubAgent, Tool, ToolResult } from './types.js'
import { getTool }  from './tools/index.js'

// ── Plan generation ───────────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT =
  'Break this goal into 3-6 concrete executable steps. ' +
  'Return ONLY a JSON array of strings. No other text. ' +
  'Example: ["search for X", "extract key info", "write summary to file", "send email"]'

function ruleBasedPlan(goal: string): string[] {
  const steps: string[] = []

  if (/search|find|look up|research|competitor/i.test(goal)) {
    steps.push(`search for ${goal}`)
  }
  if (/scrape|extract|read.*page|fetch.*url/i.test(goal)) {
    steps.push('scrape and extract key info from results')
  }
  if (/summarize|summary|write|draft/i.test(goal)) {
    steps.push('write summary to file')
  }
  if (/email|send|message/i.test(goal)) {
    const toMatch = goal.match(/(?:to|email)\s+([a-zA-Z@.\s]+?)(?:\s|$)/i)
    const to = toMatch?.[1]?.trim() ?? 'recipient@example.com'
    steps.push(`send email to ${to} with summary`)
  }
  if (/schedule|book|calendar|meeting/i.test(goal)) {
    steps.push(`schedule meeting: ${goal}`)
  }
  if (/\bapi\b|http|endpoint/i.test(goal)) {
    steps.push(`api call for: ${goal}`)
  }

  if (steps.length === 0) steps.push(`search for ${goal}`)
  return steps
}

// ── Tool → step mapping ───────────────────────────────────────────────────────

interface MappedStep {
  tool:  Tool
  input: Record<string, unknown>
}

function mapStepToTool(step: string, context: Record<string, unknown> = {}): MappedStep | null {
  const s = step.toLowerCase()

  if (/email|send\s+(?:an?\s+)?(?:email|message)/.test(s)) {
    const tool = getTool('email.send')
    if (!tool) return null
    const toMatch = step.match(/(?:to|email)\s+([^\s,]+@[^\s,]+)/i)
    return {
      tool,
      input: {
        to:      toMatch?.[1] ?? (context['inferredEmail'] as string | undefined) ?? 'pending@axon.local',
        subject: (context['emailSubject'] as string | undefined) ?? `Re: ${step.slice(0, 60)}`,
        body:    (context['draft'] as string | undefined) ?? step,
      },
    }
  }

  if (/scrape|extract|fetch.*url/.test(s)) {
    const tool = getTool('browser.scrape')
    if (!tool) return null
    return { tool, input: { url: (context['lastUrl'] as string | undefined) ?? '' } }
  }

  if (/search|find|look up|research/.test(s)) {
    const tool = getTool('browser.search')
    if (!tool) return null
    const query = step.replace(/^(search for|find|look up|research)\s+/i, '').trim()
    return { tool, input: { query: query || step } }
  }

  if (/schedule|book|calendar|meeting/.test(s)) {
    const tool = getTool('calendar.schedule')
    if (!tool) return null
    return { tool, input: { title: step, datetime: '', notes: step } }
  }

  if (/write|save|store|summary|draft/.test(s)) {
    const tool = getTool('file.write')
    if (!tool) return null
    return {
      tool,
      input: {
        filename: `agent_${Date.now()}.txt`,
        content:  (context['lastResult'] as string | undefined) ?? step,
      },
    }
  }

  if (/\bapi\b|https?:\/\/|endpoint/.test(s)) {
    const tool = getTool('api.call')
    if (!tool) return null
    const urlMatch = step.match(/https?:\/\/[^\s]+/i)
    return { tool, input: { url: urlMatch?.[0] ?? '', method: 'GET' } }
  }

  // Fallback: search
  const fallback = getTool('browser.search')
  if (!fallback) return null
  return { tool: fallback, input: { query: step } }
}

// ── AgentManager ──────────────────────────────────────────────────────────────

type OnCompleteCallback = (agent: SubAgent) => void

export class AgentManager {
  private agents    = new Map<string, SubAgent>()
  private onComplete: OnCompleteCallback | null = null

  setOnCompleteCallback(cb: OnCompleteCallback): void {
    this.onComplete = cb
  }

  createAgent(goal: string): SubAgent {
    const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const agent: SubAgent = {
      id,
      goal,
      plan:        [],
      state:       'pending',
      currentStep: 0,
      result:      undefined,
      logs:        [],
      createdAt:   Date.now(),
      updatedAt:   Date.now(),
    }
    this.agents.set(id, agent)
    console.log(`[AGENT] created — ${id} goal="${goal}"`)
    return agent
  }

  async generatePlan(goal: string): Promise<string[]> {
    try {
      const res = await fetch(CONFIG.OLLAMA_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:    CONFIG.OLLAMA_MODEL,
          stream:   false,
          messages: [
            { role: 'system', content: PLAN_SYSTEM_PROMPT },
            { role: 'user',   content: goal },
          ],
        }),
        signal: AbortSignal.timeout(CONFIG.OLLAMA_DRAFT_TIMEOUT_MS),
      })

      const data   = await res.json() as { message: { content: string } }
      const raw    = data.message.content.trim().replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(raw) as unknown

      if (
        Array.isArray(parsed) &&
        parsed.length >= 1 &&
        parsed.every((s): s is string => typeof s === 'string')
      ) {
        console.log(`[AGENT] LLM plan: [${parsed.join(', ')}]`)
        return parsed
      }
    } catch (e) {
      console.warn('[AGENT] LLM plan failed, using rule-based fallback:', e instanceof Error ? e.message : e)
    }

    const fallback = ruleBasedPlan(goal)
    console.log(`[AGENT] rule-based plan: [${fallback.join(', ')}]`)
    return fallback
  }

  executeAgent(agentId: string): void {
    void this._runAgent(agentId)
  }

  private async _runAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return

    agent.state     = 'running'
    agent.updatedAt = Date.now()

    if (!agent.plan.length) {
      agent.plan = await this.generatePlan(agent.goal)
    }

    const context: Record<string, unknown> = {}

    for (let i = 0; i < agent.plan.length; i++) {
      agent.currentStep = i
      agent.updatedAt   = Date.now()
      const step        = agent.plan[i]

      agent.logs.push(`[STEP ${i}] ${step}`)
      console.log(`[AGENT] ${agentId} step ${i}/${agent.plan.length - 1}: "${step}"`)

      const mapped = mapStepToTool(step, context)
      if (!mapped) {
        agent.logs.push(`[STEP ${i}] no tool mapped — skipping`)
        continue
      }

      let result: ToolResult

      try {
        result = await mapped.tool.execute(mapped.input)
      } catch (e) {
        result = { success: false, error: e instanceof Error ? e.message : String(e) }
      }

      // One retry on failure
      if (!result.success) {
        agent.logs.push(`[STEP ${i}] retry — ${result.error ?? 'unknown error'}`)
        try {
          result = await mapped.tool.execute(mapped.input)
        } catch (e) {
          result = { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      }

      if (!result.success) {
        const msg = `[STEP ${i}] failed after retry — ${result.error ?? 'unknown error'}`
        agent.logs.push(msg)
        console.error(`[AGENT] ${agentId} ${msg}`)
        agent.state     = 'failed'
        agent.result    = { failedStep: i, error: result.error }
        agent.updatedAt = Date.now()
        this.onComplete?.(agent)
        return
      }

      const logMsg = `[STEP ${i}] ok — ${JSON.stringify(result.data).slice(0, 80)}`
      agent.logs.push(logMsg)
      console.log(`[AGENT] ${agentId} ${logMsg}`)

      if (typeof result.data === 'string') {
        context['lastResult'] = result.data
        if (/^https?:\/\//.test(result.data)) {
          context['lastUrl'] = result.data
        }
        // Penultimate step result becomes email draft body
        if (i === agent.plan.length - 2) {
          context['draft'] = result.data
        }
      }
    }

    agent.state     = 'completed'
    agent.result    = context['lastResult']
    agent.updatedAt = Date.now()
    console.log(`[AGENT] ${agentId} completed — ${agent.plan.length} steps`)
    this.onComplete?.(agent)
  }

  getAgent(id: string): SubAgent | null {
    return this.agents.get(id) ?? null
  }

  getAllAgents(): SubAgent[] {
    return Array.from(this.agents.values())
  }

  getRunningAgents(): SubAgent[] {
    return Array.from(this.agents.values()).filter(a => a.state === 'running')
  }
}
