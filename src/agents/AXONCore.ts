import type { Agent, AgentResult, Input, IntentClass, IntentScore, SubAgent } from './types.js'

// ── Intent classifier — keyword scoring (no LLM, must be <5ms) ───────────────

const KEYWORD_BANKS: Record<Exclude<IntentClass, 'unknown'>, readonly string[]> = {
  conversation: ['price', 'objection', 'stall', 'agreement', 'competitor', 'meeting', 'interview', 'negotiate', 'offer', 'deal', 'afford'],
  task:         ['remind', 'schedule', 'follow up', 'follow-up', 'add task', 'create task', 'track', "don't forget", 'note to self', 'i need to'],
  execution:    ['send', 'email', 'search', 'find', 'research', 'browse', 'book', 'call', 'fetch', 'scrape'],
  research:     ['who', 'what happened', 'recall', 'remember', 'history', 'find out', 'did i', 'did we', 'told me', 'mentioned'],
}

export function classifyIntent(text: string): IntentScore {
  const lower = text.toLowerCase()

  const scores: Record<Exclude<IntentClass, 'unknown'>, number> = {
    conversation: 0, task: 0, execution: 0, research: 0,
  }
  const matched: Record<Exclude<IntentClass, 'unknown'>, string[]> = {
    conversation: [], task: [], execution: [], research: [],
  }

  for (const [intent, keywords] of Object.entries(KEYWORD_BANKS) as [Exclude<IntentClass, 'unknown'>, readonly string[]][]) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        scores[intent]++
        matched[intent].push(kw)
      }
    }
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0)
  if (total === 0) return { intent: 'conversation', score: 0.5, matched: [] }

  let best: Exclude<IntentClass, 'unknown'> = 'conversation'
  let bestScore = 0
  for (const [intent, raw] of Object.entries(scores) as [Exclude<IntentClass, 'unknown'>, number][]) {
    const norm = raw / total
    if (norm > bestScore) { bestScore = norm; best = intent }
  }

  return { intent: best, score: bestScore, matched: matched[best] }
}

// ── Priority table — lower number = higher priority ───────────────────────────

const AGENT_PRIORITY: Record<string, number> = {
  research:     1,
  task:         2,
  execution:    3,
  conversation: 99,
}

// ── AXONCore singleton ────────────────────────────────────────────────────────

export class AXONCore {
  private static _instance: AXONCore | null = null
  private agents: Agent[] = []

  private constructor() {}

  static getInstance(): AXONCore {
    if (!AXONCore._instance) AXONCore._instance = new AXONCore()
    return AXONCore._instance
  }

  registerAgent(agent: Agent): void {
    this.agents.push(agent)
    console.log(`[AXON] registered agent — ${agent.id}`)
  }

  async route(input: Input): Promise<AgentResult> {
    const t0 = Date.now()
    console.log(`[AXON] routing id=${input.id} source=${input.source} text="${input.text.slice(0, 80)}"`)

    const candidates = this.agents
      .filter(a => a.canHandle(input))
      .sort((a, b) => (AGENT_PRIORITY[a.id] ?? 50) - (AGENT_PRIORITY[b.id] ?? 50))

    if (!candidates.length) {
      return {
        agentId:    'axon',
        inputId:    input.id,
        success:    false,
        error:      'No agent could handle this input',
        durationMs: Date.now() - t0,
      }
    }

    const agent = candidates[0]
    console.log(`[AXON] dispatching to agent=${agent.id}`)

    try {
      const result = await agent.execute(input)
      console.log(
        `[AXON] agent=${agent.id} success=${result.success} duration=${result.durationMs}ms` +
        (result.spawnedAgents?.length ? ` spawned=${result.spawnedAgents.join(',')}` : '')
      )
      return result
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      console.error(`[AXON] agent=${agent.id} threw: ${err}`)
      return {
        agentId:    agent.id,
        inputId:    input.id,
        success:    false,
        error:      err,
        durationMs: Date.now() - t0,
      }
    }
  }

  onAgentComplete(agent: SubAgent): void {
    console.log(`[AXON] sub-agent ${agent.id} ${agent.state} — ${agent.plan.length} steps`)
    if (agent.state === 'completed') {
      console.log(`[AXON] result: ${JSON.stringify(agent.result).slice(0, 100)}`)
    } else if (agent.state === 'failed') {
      console.error(`[AXON] sub-agent ${agent.id} failed`)
    }
  }
}
