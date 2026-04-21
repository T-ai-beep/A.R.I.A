// ── Coordinator — single execution authority ──────────────────────────────────
//
// Implements Agent so AXONCore can route to it uniformly.
// Serialises all plan execution via a promise lock — no concurrent runs.
// Acquires a lease (pending → running) before each node.
// Checks both in-memory and file-based idempotency before every node.
// ExecutionAgent is the ONLY code allowed to call tools.
// TTS is NOT invoked here — output is returned in AgentResult for index.ts to speak.

import type { Agent, AgentResult, Input, CoordinatorResult, NodeResult, ExecutionContext, PlanNode } from './types.js'
import { createPlan, updateNode } from './Planner.js'
import { ExecutionAgent }         from './ExecutionAgent.js'

const ACTION_VERBS = /\b(send|email|search|find|research|browse|book|call|fetch|scrape|schedule|draft|write|look up)\b/gi

export class Coordinator implements Agent {
  readonly id = 'coordinator'

  private static _instance: Coordinator | null = null
  private _lock: Promise<void>                  = Promise.resolve()
  private _executedKeys                         = new Set<string>()
  private _executor                             = new ExecutionAgent()

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
      return await this._runGoal(goal)
    } finally {
      release()
    }
  }

  private async _runGoal(goal: string): Promise<CoordinatorResult> {
    const plan    = createPlan(goal)
    const context: ExecutionContext = {}
    const results: NodeResult[]    = []

    for (const node of plan.nodes) {
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
      if (!this._acquireLease(plan.id, node)) {
        console.log(`[COORDINATOR] lease conflict on node ${node.id} (state=${node.state}) — skipping`)
        continue
      }

      // ── Execute ────────────────────────────────────────────────────────────
      let result: NodeResult
      try {
        result = await this._executor.executeNode(node, context)
      } catch (e) {
        result = { nodeId: node.id, success: false, error: e instanceof Error ? e.message : String(e) }
      }

      results.push(result)

      if (result.success) {
        // Thread result into context for downstream nodes
        if (typeof result.data === 'string') {
          context.lastResult = result.data
          if (/^https?:\/\//.test(result.data)) context.lastUrl = result.data
          // Penultimate step result becomes email draft body
          if (plan.nodes.indexOf(node) === plan.nodes.length - 2) context.draft = result.data
        }
        this._executedKeys.add(node.idempotencyKey)
        updateNode(plan.id, node.id, { state: 'completed', result: result.data, completedAt: Date.now() })
      } else {
        updateNode(plan.id, node.id, { state: 'failed', error: result.error })
        break // abort plan on first failure
      }
    }

    return {
      planId:      plan.id,
      success:     results.length > 0 && results.every(r => r.success),
      results,
      lastResult:  [...results].reverse().find(r => r.success)?.data,
    }
  }

  // Atomic lease: node must be 'pending'. Writes 'running' + lease metadata.
  private _acquireLease(planId: string, node: PlanNode): boolean {
    if (node.state !== 'pending') return false
    updateNode(planId, node.id, {
      state:       'running',
      leaseOwner:  String(process.pid),
      leaseExpiry: Date.now() + 30_000,
    })
    // Mutate the in-memory reference so subsequent checks in this loop see 'running'
    node.state = 'running'
    return true
  }
}
