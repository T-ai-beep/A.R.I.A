/**
 * ExecutionAgent — single-node executor.
 *
 * Responsibilities (ONLY):
 *   - Select the correct tool for a PlanNode
 *   - Build typed tool input from context
 *   - Execute the tool (retry handled by AgentManager.runStep)
 *   - Return a typed result
 *
 * ExecutionAgent does NOT:
 *   - Create plans
 *   - Loop over steps
 *   - Make decisions about what to execute next
 *
 * The Coordinator owns the lifecycle. ExecutionAgent is a pure executor.
 *
 * execute(input) remains for backward-compat with axonRoute routing
 * (direct user commands that aren't part of a goal plan). It creates
 * a synthetic single-node from the input and calls executeNode.
 */

import { Agent, AgentResult, Input, PlanNode } from './types.js'
import { selectTool, buildToolInput, runStep } from '../execution/AgentManager.js'

export interface NodeContext {
  goal:            string
  previousOutputs: unknown[]
  autoApprove?:    boolean
}

export interface NodeResult {
  success:   boolean
  output?:   unknown
  error?:    string
  durationMs: number
}

export class ExecutionAgent implements Agent {
  readonly id = 'execution'

  canHandle(input: Input): boolean {
    return input.type === 'execution_request'
  }

  // ── Single-node execution ─────────────────────────────────────────────────

  async executeNode(node: PlanNode, ctx: NodeContext): Promise<NodeResult> {
    const t0       = Date.now()
    const toolName = node.tool || selectTool(node.description)

    const toolInput = buildToolInput(
      node.description,
      toolName,
      ctx.previousOutputs,
      ctx.goal
    )

    const result = await runStep(toolName, toolInput, node.description.slice(0, 50))

    return {
      success:    result.success,
      output:     result.output,
      error:      result.error,
      durationMs: Date.now() - t0,
    }
  }

  // ── Backward-compat: direct execution_request routing via axonRoute ───────

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()

    try {
      console.log(`[EXECUTION] direct goal: "${input.raw.slice(0, 80)}"`)

      const toolName = selectTool(input.raw)
      const syntheticNode: PlanNode = {
        id:          `direct_${Date.now()}`,
        description: input.raw,
        tool:        toolName,
        status:      'pending',
        attempts:    0,
        maxAttempts: 3,
      }

      const result = await this.executeNode(syntheticNode, {
        goal:            input.raw,
        previousOutputs: [],
        autoApprove:     input.metadata?.autoApprove as boolean | undefined,
      })

      return {
        agentId:    this.id,
        success:    result.success,
        output:     result.output != null ? String(result.output).slice(0, 500) : null,
        data:       { tool: toolName, output: result.output },
        error:      result.error,
        durationMs: Date.now() - t0,
      }

    } catch (err) {
      console.error(`[EXECUTION] fatal:`, err)
      return {
        agentId:    this.id,
        success:    false,
        output:     null,
        error:      String(err),
        durationMs: Date.now() - t0,
      }
    }
  }
}
