import type { Agent, AgentResult, Input } from './types.js'
import type { AgentManager }               from './AgentManager.js'

const ACTION_VERBS =
  /\b(send|email|search|find|research|browse|book|call|fetch|scrape|schedule|draft|write|look up)\b/gi

export class ExecutionAgent implements Agent {
  readonly id = 'execution'

  constructor(private readonly manager: AgentManager) {}

  canHandle(input: Input): boolean {
    if (input.source === 'command' || input.source === 'system_trigger') return true
    if (input.source === 'transcript') {
      // Require 2+ action verbs to avoid intercepting single-verb conversation turns
      const matches = input.text.match(ACTION_VERBS)
      return (matches?.length ?? 0) >= 2
    }
    return false
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0   = Date.now()
    const goal = input.text.trim()

    const subAgent  = this.manager.createAgent(goal)
    subAgent.plan   = await this.manager.generatePlan(goal)

    // Non-blocking: execution continues in the background
    this.manager.executeAgent(subAgent.id)

    const output = `On it. ${this.summarizeGoal(goal)}.`

    return {
      agentId:       this.id,
      inputId:       input.id,
      success:       true,
      output,
      data:          { subAgentId: subAgent.id, plan: subAgent.plan },
      spawnedAgents: [subAgent.id],
      durationMs:    Date.now() - t0,
    }
  }

  private summarizeGoal(goal: string): string {
    const words = goal.trim().split(/\s+/)
    if (words.length <= 5) return goal.trim()
    return words.slice(0, 5).join(' ')
  }
}
