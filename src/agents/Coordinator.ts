/**
 * Coordinator — owns the goal execution lifecycle.
 *
 * Single entry point: coordinator.acceptGoal(goalId)
 *
 * Flow per cycle:
 *   1. Load goal → bail if not active
 *   2. Load or create plan via Planner (plans created ONCE, reused)
 *   3. Attach planId to goal on first creation
 *   4. Find next pending node (skip running nodes — re-entrant safe)
 *   5. Acquire lease — prevents duplicate execution across cycles
 *   6. Mark node 'running', delegate to ExecutionAgent.executeNode()
 *   7. Update node status + goal progress
 *   8. Auto-complete or auto-block goal when all nodes are terminal
 *
 * Safety rules:
 *   - email.send is blocked unless goal.autoApprove === true
 *   - Node failure beyond maxAttempts → mark 'failed', continue (no crash)
 *   - All nodes failed → goal status = 'failed', plan status = 'blocked'
 */

import { PlanNode } from './types.js'
import { getGoal, updateGoal, completeGoal, failGoal } from '../autonomy/goals.js'
import { createPlan, getPlanForGoal, updateNode, completePlan, blockPlan, getPlan } from './Planner.js'
import { acquireLease, releaseLease, isGoalLocked } from '../world/WorldState.js'

// Lazy import to avoid circular deps (ExecutionAgent ← Coordinator ← loop)
async function getExecutionAgent() {
  const { ExecutionAgent } = await import('./ExecutionAgent.js')
  return new ExecutionAgent()
}

// ── Coordinator ─────────────────────────────────────────────────────────────

class CoordinatorImpl {

  /**
   * Called by the autonomy loop once per cycle per active goal.
   * Safe to call concurrently — lease system prevents double-execution.
   */
  async acceptGoal(goalId: string): Promise<void> {
    // ── 1. Load goal ────────────────────────────────────────────────────────
    const goal = getGoal(goalId)
    if (!goal || goal.status !== 'active') return

    // ── 2. Get or create plan ───────────────────────────────────────────────
    let plan = goal.planId
      ? (getPlan(goal.planId) ?? getPlanForGoal(goalId))   // planId → direct lookup
      : getPlanForGoal(goalId)

    if (!plan) {
      try {
        plan = await createPlan(goalId, goal.description)
        // Attach planId to goal so future lookups are O(1)
        updateGoal(goalId, { planId: plan.id })
      } catch (err) {
        console.error(`[COORDINATOR] plan creation failed for goal ${goalId}:`, err)
        return
      }
    }

    // ── 3. Terminal plan states ─────────────────────────────────────────────
    if (plan.status === 'complete' || plan.status === 'blocked') return

    // ── 4. Find next actionable node ────────────────────────────────────────
    const runningNode = plan.nodes.find(n => n.status === 'running')
    if (runningNode) {
      // Another cycle is mid-execution — skip
      return
    }

    const nextNode = plan.nodes.find(n => n.status === 'pending')
    if (!nextNode) {
      // All nodes are terminal — evaluate plan completion
      this.finalizePlan(plan.id, goalId, plan.nodes)
      return
    }

    // ── 5. Email safety gate ────────────────────────────────────────────────
    if (nextNode.tool === 'email.send' && !goal.autoApprove) {
      console.log(
        `[COORDINATOR] email.send blocked for goal ${goalId} — ` +
        `set goal.autoApprove=true to allow autonomous email dispatch`
      )
      // Mark node failed so execution continues past it
      updateNode(plan.id, nextNode.id, { status: 'failed', attempts: nextNode.maxAttempts })
      this.finalizePlan(plan.id, goalId, this.reloadNodes(plan.id))
      return
    }

    // ── 6. Acquire lease ────────────────────────────────────────────────────
    if (!acquireLease(goalId, `coordinator:${nextNode.id}`)) {
      console.log(`[COORDINATOR] goal ${goalId} locked — skipping this cycle`)
      return
    }

    // ── 7. Mark running + execute ───────────────────────────────────────────
    updateNode(plan.id, nextNode.id, { status: 'running', attempts: nextNode.attempts + 1 })

    const previousOutputs = plan.nodes
      .filter(n => n.status === 'done')
      .map(n => n.result)

    console.log(
      `[COORDINATOR] goal=${goalId} executing node ${nextNode.id.slice(-6)} ` +
      `[${nextNode.tool}]: "${nextNode.description.slice(0, 60)}"`
    )

    try {
      const agent  = await getExecutionAgent()
      const result = await agent.executeNode(nextNode, {
        goal:            goal.description,
        previousOutputs,
        autoApprove:     goal.autoApprove ?? false,
      })

      // ── 8. Update node status ─────────────────────────────────────────────
      if (result.success) {
        updateNode(plan.id, nextNode.id, { status: 'done', result: result.output })
        console.log(`[COORDINATOR] node ${nextNode.id.slice(-6)} ✓ [${nextNode.tool}]`)
      } else {
        const exhausted = nextNode.attempts >= nextNode.maxAttempts
        updateNode(plan.id, nextNode.id, {
          status:   exhausted ? 'failed' : 'pending',
          attempts: nextNode.attempts,          // already incremented above
        })
        console.log(
          `[COORDINATOR] node ${nextNode.id.slice(-6)} ✗ [${nextNode.tool}] ` +
          `attempt ${nextNode.attempts}/${nextNode.maxAttempts} — ${result.error}`
        )
      }

      // ── 9. Update goal progress ───────────────────────────────────────────
      const freshNodes = this.reloadNodes(plan.id)
      const done       = freshNodes.filter(n => n.status === 'done').length
      const progress   = freshNodes.length > 0 ? done / freshNodes.length : 0
      updateGoal(goalId, { progress, lastActivityAt: Date.now() })

      // ── 10. Finalize if all terminal ──────────────────────────────────────
      this.finalizePlan(plan.id, goalId, freshNodes)

    } finally {
      releaseLease(goalId)
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private reloadNodes(planId: string): PlanNode[] {
    return getPlan(planId)?.nodes ?? []
  }

  private finalizePlan(planId: string, goalId: string, nodes: PlanNode[]): void {
    const allTerminal = nodes.every(n => n.status === 'done' || n.status === 'failed')
    if (!allTerminal) return

    const anySuccess = nodes.some(n => n.status === 'done')
    if (anySuccess) {
      completePlan(planId)
      completeGoal(goalId)
      console.log(`[COORDINATOR] goal ${goalId} COMPLETED`)
    } else {
      blockPlan(planId)
      failGoal(goalId)
      console.log(`[COORDINATOR] goal ${goalId} BLOCKED — all nodes failed`)
    }
  }
}

export const coordinator = new CoordinatorImpl()
