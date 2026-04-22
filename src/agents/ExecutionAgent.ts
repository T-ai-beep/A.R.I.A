// ── ExecutionAgent — pure node executor with strict write ordering ─────────────
//
// Guaranteed execution order (each step fsynced before the next):
//   1. ExecutionLog  "node_started"    → fsync
//   2. ToolCache     "pending"         → fsync   ← intent recorded BEFORE tool runs
//   3. Tool executes (with timeout)
//   4. ToolCache     "completed"       → fsync   ← result committed AFTER tool runs
//   5. ExecutionLog  "node_completed"  → fsync   ← (written by Coordinator after return)
//
// If the process crashes between steps 2 and 4 (intent written, result not yet):
//   Recovery sees status="pending" → treats execution as "uncertain" → does NOT
//   re-execute blindly. Coordinator verifies before retrying with the SAME key.
//
// If the process crashes after step 4 but before step 5:
//   Recovery sees completed ToolCache entry → returns cached result, no re-execution.
//
// Late completion: if tool finishes AFTER timeout, the Promise.race has already
//   rejected, but the tool's then-callback still commits "completed" to ToolCache.
//   Any retry detects this and skips execution.

import type { PlanNode, ExecutionContext, NodeResult } from './types.js'
import { getTool }                           from './tools/index.js'
import { setActiveNode }                     from './ToolGuard.js'
import { appendLog }                         from './ExecutionLog.js'
import { recordIntent, commitResult }        from './ToolCache.js'

const DEFAULT_TIMEOUT_MS = 30_000

export class ExecutionAgent {
  async executeNode(node: PlanNode, ctx: ExecutionContext): Promise<NodeResult> {
    const tool = getTool(node.toolName)
    if (!tool) {
      return { nodeId: node.id, success: false, error: `Unknown tool: "${node.toolName}"` }
    }

    const input      = this._resolveInput(node, ctx)
    const timeoutMs  = node.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const executionId = node.executionId ?? node.idempotencyKey
    const planId      = node.goalId  // goalId is the planId

    console.log(`[EXEC] node=${node.id} tool=${node.toolName} timeout=${timeoutMs}ms input=${JSON.stringify(input).slice(0, 120)}`)

    // ── Step 1: ExecutionLog "node_started" (written by Coordinator before calling us)
    //    We receive control here after the log entry is already fsynced.

    // ── Step 2: ToolCache intent (pending) — BEFORE tool runs ─────────────────
    try {
      recordIntent(node.idempotencyKey, node.toolName)
    } catch (e) {
      return { nodeId: node.id, success: false, error: `Failed to record intent: ${e instanceof Error ? e.message : e}` }
    }

    // ── Step 3: Execute tool (with timeout) ───────────────────────────────────
    setActiveNode(node.id)

    // Create the tool call promise separately so we can attach a then() for late-commit
    const toolCallPromise = tool.execute(input)

    // After timeout fires, the tool may still complete — if it does, commit the result
    // to ToolCache so the next recovery sees "completed" and skips re-execution.
    toolCallPromise.then(
      (lateResult) => commitResult(node.idempotencyKey, node.toolName, lateResult),
      () => { /* tool threw after timeout — nothing to commit */ }
    )

    let toolResult
    try {
      toolResult = await Promise.race([
        toolCallPromise,
        this._timeout(timeoutMs, node.toolName),
      ])
    } catch (e) {
      // Timeout or unexpected throw.
      // The then() above handles late completion for the timeout case.
      setActiveNode(null)
      // Do NOT commit here — the then() above will fire if/when the tool ever resolves.
      // The pending intent stays, which is correct: execution is "uncertain".
      return { nodeId: node.id, success: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      setActiveNode(null)
    }

    // ── Step 4: ToolCache "completed" — AFTER tool returns ────────────────────
    // We also call commitResult in the then() handler above, which means for the
    // non-timeout path we may call it twice. The JSONL append-only log handles
    // this correctly: last-write-wins in getCache(), and the in-memory map is
    // updated by the direct call below first (synchronously).
    commitResult(node.idempotencyKey, node.toolName, toolResult)

    // ── Step 5: Return to Coordinator (which writes ExecutionLog "completed") ──

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

    // Idempotency key is passed through so tools can use it independently
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
