// ── Coordinator — single execution authority ──────────────────────────────────
//
// Implements Agent so AXONCore can route to it uniformly.
// Serialises all plan execution via a promise lock — no concurrent runs.
// Uses LeaseManager (file-based mkdir CAS) for multi-process crash safety.
// Checks ToolCache + in-memory idempotency before every node.
// Logs every state transition to ExecutionLog (append-only JSONL).
// Recovers stuck 'running' nodes on startup via _recoverStuckNodes().
// TTS is NOT invoked here — output is returned in AgentResult for index.ts to speak.

import { randomUUID }   from 'node:crypto'
import * as fsSync      from 'node:fs'
import type { Agent, AgentResult, Input, CoordinatorResult, NodeResult, ExecutionContext, PlanNode, ExecutionLogEvent } from './types.js'
import { createPlan, getPlan, updateNode, loadPlans } from './Planner.js'
import { ExecutionAgent }                   from './ExecutionAgent.js'
import { acquireLease, releaseLease, isLeaseExpired } from './LeaseManager.js'
import { appendLog }                        from './ExecutionLog.js'
import { getCached }                        from './ToolCache.js'

const ACTION_VERBS = /\b(send|email|search|find|research|browse|book|call|fetch|scrape|schedule|draft|write|look up)\b/gi

export class Coordinator implements Agent {
  readonly id = 'coordinator'

  private static _instance: Coordinator | null = null
  private _lock: Promise<void>                  = Promise.resolve()
  private _executedKeys                         = new Set<string>()
  private _executor                             = new ExecutionAgent()
  private _recovered                            = false

  static getInstance(): Coordinator {
    if (!Coordinator._instance) Coordinator._instance = new Coordinator()
    return Coordinator._instance
  }

  canHandle(input: Input): boolean {
    if (input.source === 'command' || input.source === 'system_trigger') return true
    if (input.source === 'transcript') {
      const matches = input.text.match(ACTION_VERBS)
      return (matches?.length ?? 0) >= 2
    }
    return false
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0     = Date.now()
    const result = await this.acceptGoal(input.text)

    const stepWord = result.results.length === 1 ? 'step' : 'steps'
    const output   = result.success
      ? `Done. ${result.results.length} ${stepWord} completed.`
      : `Failed on step ${(result.results.findIndex(r => !r.success) + 1)}.`

    return {
      agentId:    this.id,
      inputId:    input.id,
      success:    result.success,
      output,
      data:       result,
      durationMs: Date.now() - t0,
    }
  }

  // Public entry point — serialised via lock, safe to call concurrently.
  async acceptGoal(goal: string): Promise<CoordinatorResult> {
    let release!: () => void
    const prev = this._lock
    this._lock = new Promise<void>(r => { release = r })

    try {
      await prev
      await this._ensureRecovered()
      return await this._runGoal(goal)
    } finally {
      release()
    }
  }

  // ── Crash recovery — runs once per instance on first acceptGoal ──────────────

  private async _ensureRecovered(): Promise<void> {
    if (this._recovered) return
    this._recovered = true
    this._recoverStuckNodes()
  }

  private _recoverStuckNodes(): void {
    for (const plan of loadPlans()) {
      if (plan.state !== 'active') continue
      for (const node of plan.nodes) {
        if (node.state !== 'running') continue

        const cached = getCached(node.idempotencyKey)
        if (cached !== null) {
          if (cached.success) {
            console.log(`[COORDINATOR] recovery: node ${node.id} has cached success — marking completed`)
            updateNode(plan.id, node.id, { state: 'completed', result: cached.data, completedAt: Date.now() })
            this._log(plan.id, node.id, node.executionId ?? 'unknown', 'node_recovered', node.toolName, true)
          } else {
            console.log(`[COORDINATOR] recovery: node ${node.id} has cached failure — marking failed`)
            updateNode(plan.id, node.id, { state: 'failed', error: cached.error ?? 'cached failure' })
            this._log(plan.id, node.id, node.executionId ?? 'unknown', 'node_recovered', node.toolName, false, cached.error)
          }
          releaseLease(node.idempotencyKey)
        } else if (!node.leaseExpiry || node.leaseExpiry < Date.now() || isLeaseExpired(node.idempotencyKey)) {
          // No tool result + lease expired → tool never ran, safe to retry
          console.log(`[COORDINATOR] recovery: node ${node.id} lease expired without result — resetting to pending`)
          updateNode(plan.id, node.id, { state: 'pending', leaseOwner: undefined, leaseExpiry: undefined, executionId: undefined })
          releaseLease(node.idempotencyKey)
          this._log(plan.id, node.id, node.executionId ?? 'unknown', 'lease_reclaimed', node.toolName)
        }
        // If lease is still held by another live process, leave it alone
      }
    }
  }

  private async _runGoal(goal: string): Promise<CoordinatorResult> {
    const plan    = createPlan(goal)
    const context: ExecutionContext = {}
    const results: NodeResult[]    = []

    for (const node of plan.nodes) {
      // ── ToolCache idempotency (cross-process, persisted) ───────────────────
      const cached = getCached(node.idempotencyKey)
      if (cached !== null && cached.success) {
        console.log(`[COORDINATOR] tool cache hit: ${node.idempotencyKey} — skipping`)
        this._executedKeys.add(node.idempotencyKey)
        results.push({ nodeId: node.id, success: true, data: cached.data })
        this._threadContext(context, node, plan.nodes, cached.data)
        continue
      }

      // ── File-based idempotency (plan state on disk) ────────────────────────
      if (node.state === 'completed') {
        console.log(`[COORDINATOR] node ${node.id} already completed on disk — skipping`)
        continue
      }

      // ── In-memory idempotency (same session) ───────────────────────────────
      if (this._executedKeys.has(node.idempotencyKey)) {
        console.log(`[COORDINATOR] in-memory idempotency: ${node.idempotencyKey} — skipping`)
        continue
      }

      // ── Lease acquisition (multi-process CAS) ─────────────────────────────
      const executionId = randomUUID()
      if (!this._acquireLease(plan.id, node, executionId)) {
        console.log(`[COORDINATOR] lease conflict on node ${node.id} (state=${node.state}) — skipping`)
        continue
      }

      this._log(plan.id, node.id, executionId, 'node_started', node.toolName)

      // ── Execute ────────────────────────────────────────────────────────────
      const t0 = Date.now()
      let result: NodeResult
      try {
        result = await this._executor.executeNode(node, context)
      } catch (e) {
        result = { nodeId: node.id, success: false, error: e instanceof Error ? e.message : String(e) }
      }

      const durationMs = Date.now() - t0

      // ── Outcome validation ─────────────────────────────────────────────────
      if (result.success && node.expectedOutcome && !this._validateOutcome(node, result)) {
        result = { nodeId: node.id, success: false, error: `outcome validation failed: expected ${node.expectedOutcome}` }
      }

      results.push(result)

      if (result.success) {
        this._threadContext(context, node, plan.nodes, result.data)
        this._executedKeys.add(node.idempotencyKey)
        updateNode(plan.id, node.id, { state: 'completed', result: result.data, completedAt: Date.now() })
        releaseLease(node.idempotencyKey)
        this._log(plan.id, node.id, executionId, 'node_completed', node.toolName, true, undefined, durationMs)
      } else {
        updateNode(plan.id, node.id, { state: 'failed', error: result.error })
        releaseLease(node.idempotencyKey)
        this._log(plan.id, node.id, executionId, 'node_failed', node.toolName, false, result.error, durationMs)
        break
      }
    }

    return {
      planId:      plan.id,
      success:     results.length > 0 && results.every(r => r.success),
      results,
      lastResult:  [...results].reverse().find(r => r.success)?.data,
    }
  }

  // Atomic lease: acquire via file-based CAS, write executionId to node.
  private _acquireLease(planId: string, node: PlanNode, executionId: string): boolean {
    if (node.state !== 'pending') return false

    const ttlMs = node.timeoutMs ?? 30_000
    if (!acquireLease(node.idempotencyKey, ttlMs + 5_000)) return false

    updateNode(planId, node.id, {
      state:              'running',
      leaseOwner:         String(process.pid),
      leaseExpiry:        Date.now() + ttlMs + 5_000,
      executionId,
      executionStartedAt: Date.now(),
    })
    node.state              = 'running'
    node.executionId        = executionId
    node.executionStartedAt = Date.now()
    return true
  }

  private _threadContext(ctx: ExecutionContext, node: PlanNode, nodes: PlanNode[], data: unknown): void {
    if (typeof data === 'string') {
      ctx.lastResult = data
      if (/^https?:\/\//.test(data)) ctx.lastUrl = data
      if (nodes.indexOf(node) === nodes.length - 2) ctx.draft = data
    }
  }

  private _validateOutcome(node: PlanNode, result: NodeResult): boolean {
    switch (node.expectedOutcome) {
      case 'truthy':      return !!result.data
      case 'has_data':    return result.data !== undefined && result.data !== null && result.data !== ''
      case 'file_exists': return typeof result.data === 'string' && fsSync.existsSync(result.data)
      default:            return true
    }
  }

  private _log(
    planId: string, nodeId: string, executionId: string,
    event: ExecutionLogEvent,
    toolName?: string, success?: boolean, error?: string, durationMs?: number,
  ): void {
    try {
      appendLog({ ts: Date.now(), planId, nodeId, executionId, event, toolName, success, error, durationMs, pid: process.pid })
    } catch {
      // Log failures are non-fatal
    }
  }
}
