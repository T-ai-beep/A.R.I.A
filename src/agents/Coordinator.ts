// ── Coordinator — single execution authority ──────────────────────────────────
//
// Strict write order enforced (each step fsynced):
//   1. ExecutionLog "node_started"
//   2. → ExecutionAgent (which writes ToolCache "pending" then "completed")
//   3. ExecutionLog "node_completed" / "node_failed"
//
// Recovery logic for stuck 'running' nodes:
//   ToolCache "completed"  → reuse result, never re-execute
//   ToolCache "pending"    → execution uncertain (crashed between intent and commit)
//                            Reset to pending with SAME idempotencyKey so any
//                            late ToolCache commit is detected on next attempt.
//   ToolCache absent       → tool never started, reset to pending
//
// Consistency validation: ExecutionLog "completed" ↔ ToolCache "completed" must
// agree. Divergence is auto-corrected deterministically (ToolCache wins).
// TTS is NOT called here — output is returned in AgentResult for index.ts.

import { randomUUID }   from 'node:crypto'
import * as fsSync      from 'node:fs'
import type { Agent, AgentResult, Input, CoordinatorResult, NodeResult, ExecutionContext, PlanNode, ExecutionLogEvent } from './types.js'
import { createPlan, updateNode, loadPlans } from './Planner.js'
import { ExecutionAgent }                    from './ExecutionAgent.js'
import { acquireLease, releaseLease, isLeaseExpired } from './LeaseManager.js'
import { appendLog, replayStateFromLog }     from './ExecutionLog.js'
import { getCached, getStatus, commitResult } from './ToolCache.js'

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

  // ── Crash recovery ────────────────────────────────────────────────────────────

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

        const cacheStatus = getStatus(node.idempotencyKey)
        const cached      = getCached(node.idempotencyKey)  // only returns if status=completed

        if (cacheStatus === 'completed' && cached !== null) {
          // Tool ran and result is committed — reconcile.
          if (cached.success) {
            console.log(`[COORDINATOR] recovery: node ${node.id} cache=completed/ok — marking completed`)
            updateNode(plan.id, node.id, { state: 'completed', result: cached.data, completedAt: Date.now() })
            this._log(plan.id, node.id, node.executionId ?? 'unknown', 'node_recovered', node.toolName, true)
          } else {
            console.log(`[COORDINATOR] recovery: node ${node.id} cache=completed/fail — marking failed`)
            updateNode(plan.id, node.id, { state: 'failed', error: cached.error ?? 'cached failure' })
            this._log(plan.id, node.id, node.executionId ?? 'unknown', 'node_recovered', node.toolName, false, cached.error)
          }
          releaseLease(node.idempotencyKey)

        } else if (cacheStatus === 'pending') {
          // Execution uncertain — crash between intent and commit.
          // DO NOT re-execute with a new key. Reset to pending with the SAME
          // idempotencyKey so the next _acquireLease attempt will check the
          // ToolCache again before running and detect any late commit.
          console.log(`[COORDINATOR] recovery: node ${node.id} cache=pending — uncertain execution, resetting to pending (same key)`)
          updateNode(plan.id, node.id, {
            state:       'pending',
            leaseOwner:  undefined,
            leaseExpiry: undefined,
            // CRITICAL: keep executionId and idempotencyKey — NEVER generate new ones
          })
          releaseLease(node.idempotencyKey)
          this._log(plan.id, node.id, node.executionId ?? 'unknown', 'node_recovered', node.toolName)

        } else {
          // No ToolCache entry at all.
          if (!node.leaseExpiry || node.leaseExpiry < Date.now() || isLeaseExpired(node.idempotencyKey)) {
            // Lease expired, no intent recorded → tool definitely never ran
            console.log(`[COORDINATOR] recovery: node ${node.id} cache=absent, lease expired — resetting to pending`)
            updateNode(plan.id, node.id, { state: 'pending', leaseOwner: undefined, leaseExpiry: undefined, executionId: undefined })
            releaseLease(node.idempotencyKey)
            this._log(plan.id, node.id, node.executionId ?? 'unknown', 'lease_reclaimed', node.toolName)
          }
          // If lease still live and no cache entry → another process holds it, leave alone
        }
      }
    }

    // Consistency validation: reconcile any ExecutionLog vs ToolCache divergence
    this._reconcileLogAndCache()
  }

  // If ExecutionLog says "completed" but ToolCache has no "completed" entry,
  // the ToolCache must have been lost (partial write). Auto-correct by trusting
  // the log and writing a synthetic "completed" to ToolCache.
  private _reconcileLogAndCache(): void {
    for (const plan of loadPlans()) {
      const logState = replayStateFromLog(plan.id)
      for (const node of plan.nodes) {
        const ls = logState.get(node.id)
        if (!ls) continue
        if (ls.lastEvent === 'node_completed' && ls.success === true) {
          const cacheStatus = getStatus(node.idempotencyKey)
          if (cacheStatus !== 'completed') {
            // Log says done but cache is missing or pending — synthesize completed entry
            // using whatever result the plan has on disk (best available truth)
            console.log(`[COORDINATOR] reconcile: node ${node.id} log=completed but cache=${cacheStatus ?? 'absent'} — writing synthetic cache entry`)
            commitResult(node.idempotencyKey, node.toolName ?? 'unknown', {
              success: true,
              data:    node.result ?? 'recovered',
            })
          }
        }
      }
    }
  }

  // ── Main execution loop ───────────────────────────────────────────────────────

  private async _runGoal(goal: string): Promise<CoordinatorResult> {
    const plan    = createPlan(goal)
    const context: ExecutionContext = {}
    const results: NodeResult[]    = []

    for (const node of plan.nodes) {
      // ── Check ToolCache (2-phase: only "completed" counts as done) ─────────
      const cacheStatus = getStatus(node.idempotencyKey)

      if (cacheStatus === 'completed') {
        const cached = getCached(node.idempotencyKey)
        if (cached?.success) {
          console.log(`[COORDINATOR] cache hit (completed): ${node.idempotencyKey} — skipping`)
          this._executedKeys.add(node.idempotencyKey)
          results.push({ nodeId: node.id, success: true, data: cached.data })
          this._threadContext(context, node, plan.nodes, cached.data)
          continue
        }
        // Completed but failed — fall through to failure handling below
        results.push({ nodeId: node.id, success: false, error: cached?.error ?? 'cached failure' })
        break
      }

      if (cacheStatus === 'pending') {
        // Previous execution is uncertain. We MUST NOT execute with a new key.
        // The same idempotencyKey is preserved — if the tool committed late,
        // the ToolCache file has the completed entry and we'll see it on next run.
        // For now, treat pending as not-yet-known and attempt to re-acquire lease.
        console.log(`[COORDINATOR] cache=pending for ${node.idempotencyKey} — checking for late commit then proceeding cautiously`)
        // Refresh from disk to catch any late ToolCache commits
        const { resetMemoryCache } = await import('./ToolCache.js')
        resetMemoryCache()
        const freshStatus = getStatus(node.idempotencyKey)
        if (freshStatus === 'completed') {
          const cached = getCached(node.idempotencyKey)
          if (cached?.success) {
            console.log(`[COORDINATOR] late commit detected for ${node.idempotencyKey} — skipping`)
            this._executedKeys.add(node.idempotencyKey)
            results.push({ nodeId: node.id, success: true, data: cached.data })
            this._threadContext(context, node, plan.nodes, cached.data)
            continue
          }
        }
        // Still pending — will attempt execution with same key (recordIntent is idempotent)
      }

      // ── File-based idempotency ─────────────────────────────────────────────
      if (node.state === 'completed') {
        console.log(`[COORDINATOR] node ${node.id} already completed on disk — skipping`)
        continue
      }

      // ── In-memory idempotency ──────────────────────────────────────────────
      if (this._executedKeys.has(node.idempotencyKey)) {
        console.log(`[COORDINATOR] in-memory idempotency: ${node.idempotencyKey} — skipping`)
        continue
      }

      // ── Lease acquisition ──────────────────────────────────────────────────
      const executionId = randomUUID()
      if (!this._acquireLease(plan.id, node, executionId)) {
        console.log(`[COORDINATOR] lease conflict on node ${node.id} — skipping`)
        continue
      }

      // ── Step 1: Log "node_started" (fsynced) ──────────────────────────────
      this._log(plan.id, node.id, executionId, 'node_started', node.toolName)

      // ── Steps 2–4 inside ExecutionAgent (pending → execute → completed) ────
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
        // ── Step 5: Log "node_completed" (fsynced) ─────────────────────────
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

  // ── Helpers ───────────────────────────────────────────────────────────────────

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
    } catch { /* log failures are non-fatal */ }
  }
}
