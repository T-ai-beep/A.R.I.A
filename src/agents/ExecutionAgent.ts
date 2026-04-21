/**
 * ExecutionAgent — transforms high-level goals into real-world actions.
 *
 * Flow:
 *   Input (execution_request)
 *     → createAgent(goal)     — LLM plan generation in AgentManager
 *     → executeAgent(id)      — sequential step execution via tool system
 *     → buildSummary()        — aggregate results into human-readable output
 *     → return AgentResult    — with full step log, plans, and outputs
 *
 * Example:
 *   Input: "research competitors and send summary email"
 *   Plan:  ["search for competitors", "scrape their sites", "write summary", "send email"]
 *   Each step maps to: browser.search → browser.scrape → file.write → email.send
 */

import { Agent, AgentResult, Input, StepResult } from './types.js'
import { createAgent, executeAgent } from '../execution/AgentManager.js'

export class ExecutionAgent implements Agent {
  readonly id = 'execution'

  canHandle(input: Input): boolean {
    return input.type === 'execution_request'
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()

    try {
      console.log(`[EXECUTION] goal received: "${input.raw}"`)

      const goalId   = input.metadata?.goalId as string | undefined
      const subAgent = await createAgent(input.raw, goalId)

      console.log(`[EXECUTION] ${subAgent.id} plan:`)
      subAgent.plan.forEach((step, i) => console.log(`  ${i + 1}. ${step}`))

      const completed = await executeAgent(subAgent.id)

      const steps      = (completed.result ?? []) as StepResult[]
      const succeeded  = steps.filter(r => r.success)
      const failed     = steps.filter(r => !r.success)
      const summary    = buildSummary(input.raw, steps)
      const durationMs = (completed.completedAt ?? Date.now()) - (completed.startedAt ?? t0)

      if (failed.length > 0) {
        console.log(`[EXECUTION] ${failed.length} step(s) failed:`)
        failed.forEach(f => console.log(`  ✗ [${f.tool}] ${f.step}: ${f.error}`))
      }

      return {
        agentId:   this.id,
        success:   completed.state === 'completed',
        output:    summary,
        data: {
          subAgentId: subAgent.id,
          plan:       subAgent.plan,
          steps,
          logs:       completed.logs,
          durationMs,
          succeeded:  succeeded.length,
          failed:     failed.length,
        },
        durationMs: Date.now() - t0,
      }

    } catch (err) {
      console.error(`[EXECUTION] fatal error:`, err)
      return {
        agentId:   this.id,
        success:   false,
        output:    null,
        error:     String(err),
        durationMs: Date.now() - t0,
      }
    }
  }
}

function buildSummary(goal: string, steps: StepResult[]): string {
  const succeeded = steps.filter(r => r.success)
  if (succeeded.length === 0) {
    const errors = steps.map(s => s.error).filter(Boolean).join('; ')
    return `Execution failed for: "${goal}". Errors: ${errors || 'unknown'}`
  }

  const lastSuccess = succeeded[succeeded.length - 1]
  const outputStr   = formatOutput(lastSuccess.output)

  const lines = [
    `Completed: ${goal}`,
    `Steps: ${succeeded.length}/${steps.length} succeeded`,
    ``,
    `Last result (${lastSuccess.tool}):`,
    outputStr,
  ]

  if (steps.some(r => !r.success)) {
    const failedSteps = steps.filter(r => !r.success).map(r => r.step)
    lines.push(``, `Partial failures: ${failedSteps.join(', ')}`)
  }

  return lines.join('\n')
}

function formatOutput(output: unknown): string {
  if (output === null || output === undefined) return '(no output)'
  if (typeof output === 'string') return output.slice(0, 500)
  try {
    return JSON.stringify(output, null, 2).slice(0, 500)
  } catch {
    return String(output).slice(0, 500)
  }
}
