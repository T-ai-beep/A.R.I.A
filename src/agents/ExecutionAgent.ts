// ── ExecutionAgent — pure node executor ──────────────────────────────────────
//
// Does exactly one thing: execute a single plan node using the mapped tool.
// NOT an Agent (does not implement canHandle/execute(Input)).
// Only callable from Coordinator._runGoal().
// Sets ToolGuard active node before every tool call, clears it after.

import type { PlanNode, ExecutionContext, NodeResult } from './types.js'
import { getTool }       from './tools/index.js'
import { setActiveNode } from './ToolGuard.js'

export class ExecutionAgent {
  async executeNode(node: PlanNode, ctx: ExecutionContext): Promise<NodeResult> {
    const tool = getTool(node.toolName)
    if (!tool) {
      return { nodeId: node.id, success: false, error: `Unknown tool: "${node.toolName}"` }
    }

    const input = this._resolveInput(node, ctx)
    console.log(`[EXEC] node=${node.id} tool=${node.toolName} input=${JSON.stringify(input).slice(0, 120)}`)

    setActiveNode(node.id)
    let toolResult
    try {
      toolResult = await tool.execute(input)
    } finally {
      setActiveNode(null)   // always clear, even on throw
    }

    if (!toolResult.success) {
      return { nodeId: node.id, success: false, error: toolResult.error }
    }
    return { nodeId: node.id, success: true, data: toolResult.data }
  }

  // Injects execution context into fields left empty by Planner (e.g. URL, body).
  private _resolveInput(node: PlanNode, ctx: ExecutionContext): Record<string, unknown> {
    const input = { ...node.toolInput }

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
      if (!input['body'] && ctx.draft)      input['body'] = ctx.draft
      else if (!input['body'] && ctx.lastResult) input['body'] = ctx.lastResult
    }

    return input
  }
}
