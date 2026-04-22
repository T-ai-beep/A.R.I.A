// ── ExecutionAgent — pure node executor ──────────────────────────────────────
//
// Does exactly one thing: execute a single plan node using the mapped tool.
// NOT an Agent (does not implement canHandle/execute(Input)).
// Only callable from Coordinator._runGoal().
// Sets ToolGuard active node before every tool call, clears it after.
// Enforces per-node timeout via Promise.race.
// Injects __idempotencyKey into tool input so tools can pass it to ToolCache.

import type { PlanNode, ExecutionContext, NodeResult } from './types.js'
import { getTool }       from './tools/index.js'
import { setActiveNode } from './ToolGuard.js'

const DEFAULT_TIMEOUT_MS = 30_000

export class ExecutionAgent {
  async executeNode(node: PlanNode, ctx: ExecutionContext): Promise<NodeResult> {
    const tool = getTool(node.toolName)
    if (!tool) {
      return { nodeId: node.id, success: false, error: `Unknown tool: "${node.toolName}"` }
    }

    const input      = this._resolveInput(node, ctx)
    const timeoutMs  = node.timeoutMs ?? DEFAULT_TIMEOUT_MS
    console.log(`[EXEC] node=${node.id} tool=${node.toolName} timeout=${timeoutMs}ms input=${JSON.stringify(input).slice(0, 120)}`)

    setActiveNode(node.id)
    let toolResult
    try {
      toolResult = await Promise.race([
        tool.execute(input),
        this._timeout(timeoutMs, node.toolName),
      ])
    } catch (e) {
      // Timeout or unexpected tool throw — return failure NodeResult, never re-throw
      return { nodeId: node.id, success: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      setActiveNode(null)
    }

    if (!toolResult.success) {
      return { nodeId: node.id, success: false, error: toolResult.error }
    }
    return { nodeId: node.id, success: true, data: toolResult.data }
  }

  private _timeout(ms: number, toolName: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`[EXEC] tool "${toolName}" timed out after ${ms}ms`)), ms)
    )
  }

  private _resolveInput(node: PlanNode, ctx: ExecutionContext): Record<string, unknown> {
    const input = { ...node.toolInput }

    // Inject idempotency key so tools can cache results independently
    input['__idempotencyKey'] = node.idempotencyKey

    if (node.toolName === 'browser.scrape' && !input['url'] && ctx.lastUrl) {
      input['url'] = ctx.lastUrl
    }
    if (node.toolName === 'file.write') {
      if (!input['content'] && ctx.lastResult) {
        input['content']  = ctx.lastResult
        input['filename'] = `plan_${node.goalId}_${node.id}.txt`
      }
    }
    if (node.toolName === 'email.send') {
      if (!input['body'] && ctx.draft)           input['body'] = ctx.draft
      else if (!input['body'] && ctx.lastResult) input['body'] = ctx.lastResult
    }

    return input
  }
}
