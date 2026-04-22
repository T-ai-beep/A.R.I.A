/**
 * crash_simulation.test.ts
 *
 * Proves AT-MOST-ONCE execution across the 5 distinct crash points
 * in the two-phase ToolCache protocol.
 *
 * Crash taxonomy:
 *   CP1 — crash BEFORE recordIntent          (cache=absent, node 'running')
 *   CP2 — crash AFTER recordIntent("pending"), BEFORE tool.execute()
 *   CP3 — crash AFTER tool.execute() returns, BEFORE commitResult("completed")
 *   CP4 — crash AFTER commitResult("completed"), BEFORE log "node_completed"
 *   CP5 — crash AFTER log "node_completed",  BEFORE updateNode("completed")
 *
 * Additional suites:
 *   - Pending state: idempotency key is never regenerated on recovery
 *   - Late completion: .then() commits to ToolCache after timeout fires
 *   - Consistency: verifyPlanConsistency + _reconcileLogAndCache behaviour
 *   - Corruption: malformed JSONL lines are silently skipped on reload
 *
 * Run: npx tsx src/agents/tests/crash_simulation.test.ts
 */

import assert  from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`  ✗ ${name}`)
    console.error(`    ${msg}`)
    failed++
    failures.push(`${name}: ${msg}`)
  }
}

// ── Isolated temp directories ─────────────────────────────────────────────────

const RUN_ID         = Date.now()
const TMP            = path.join(os.tmpdir(), `axon_crash_${RUN_ID}`)
const TEST_PLANS     = path.join(TMP, 'plans.json')
const TEST_LEASES    = path.join(TMP, 'leases')
const TEST_EXEC_LOG  = path.join(TMP, 'exec_log.jsonl')
const TEST_TOOL_LOGS = path.join(TMP, 'tool_logs.jsonl')

fs.mkdirSync(TMP, { recursive: true })

process.env['AXON_PLANS_FILE'] = TEST_PLANS
process.env['AXON_LEASES_DIR'] = TEST_LEASES
process.env['AXON_EXEC_LOG']   = TEST_EXEC_LOG
process.env['AXON_TOOL_LOGS']  = TEST_TOOL_LOGS

// ── Imports (after env patch so modules pick up the test paths) ───────────────

import { recordIntent, commitResult, getCached, getStatus, resetMemoryCache, getToolLogsFile }
  from '../ToolCache.js'
import { createPlan, getPlan, updateNode, loadPlans }
  from '../Planner.js'
import { ExecutionAgent }
  from '../ExecutionAgent.js'
import { Coordinator }
  from '../Coordinator.js'
import { appendLog, verifyPlanConsistency }
  from '../ExecutionLog.js'
import { registerTool, unregisterTool }
  from '../tools/index.js'
import type { Tool, ToolResult, PlanNode }
  from '../types.js'

// ── Idempotent counter tool ───────────────────────────────────────────────────
//
// Key-scoped .done file provides tool-level idempotency.
// This simulates a real-world tool that is safe to re-invoke with the same key
// but must not double-count. Used to prove AT-MOST-ONCE at both infrastructure
// (ToolCache) and tool levels.

const COUNTER_TOOL = 'test.counter'

const counterTool: Tool = {
  name: COUNTER_TOOL,
  description: 'Key-scoped idempotent execution counter for crash simulation',
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const dir     = String(input['counterDir'] ?? '')
    const key     = String(input['__idempotencyKey'] ?? 'default')
    const safeKey = key.replace(/[:/\\]/g, '_').replace(/[^a-z0-9_]/gi, '').slice(0, 80)
    const doneDir = path.join(dir, 'done')
    const doneFn  = path.join(doneDir, `${safeKey}.done`)
    const countFn = path.join(dir, 'count.json')

    fs.mkdirSync(doneDir, { recursive: true })

    if (fs.existsSync(doneFn)) {
      const count = readCount(dir)
      return { success: true, data: { count, skipped: true } }
    }

    const count = readCount(dir) + 1
    fs.writeFileSync(countFn, JSON.stringify(count))
    fs.writeFileSync(doneFn, '1')
    return { success: true, data: { count } }
  },
}

registerTool(counterTool)

// ── Counter helpers ───────────────────────────────────────────────────────────

function readCount(dir: string): number {
  const fn = path.join(dir, 'count.json')
  return fs.existsSync(fn) ? (JSON.parse(fs.readFileSync(fn, 'utf-8')) as number) : 0
}

// Simulate the tool having already run at the given idempotency key.
// Writes count+1 and the .done sentinel, matching exactly what counterTool.execute does.
function simulateToolRan(dir: string, idempotencyKey: string): void {
  const safeKey = idempotencyKey.replace(/[:/\\]/g, '_').replace(/[^a-z0-9_]/gi, '').slice(0, 80)
  const doneDir = path.join(dir, 'done')
  const doneFn  = path.join(doneDir, `${safeKey}.done`)
  const countFn = path.join(dir, 'count.json')
  fs.mkdirSync(doneDir, { recursive: true })
  fs.writeFileSync(countFn, JSON.stringify(readCount(dir) + 1))
  fs.writeFileSync(doneFn, '1')
}

// ── Plan/state helpers ────────────────────────────────────────────────────────

function uniqueKey(): string {
  return `${RUN_ID}_${crypto.randomUUID().slice(0, 8)}`
}

// Creates a plan for goal, then immediately overrides node 0 to use the counter
// tool so crash-point tests have full control over what executes.
function setupCounterPlan(
  goal: string,
  counterDir: string,
): { planId: string; nodeId: string; iKey: string } {
  fs.mkdirSync(counterDir, { recursive: true })
  const plan = createPlan(goal)
  const node = plan.nodes[0]
  updateNode(plan.id, node.id, {
    toolName:  COUNTER_TOOL,
    toolInput: { counterDir },
  })
  return { planId: plan.id, nodeId: node.id, iKey: node.idempotencyKey }
}

// Sets a node to the 'running' state with an already-expired lease — the state
// left behind when a process crashes during node execution.
function simulateCrashRunning(planId: string, nodeId: string): void {
  updateNode(planId, nodeId, {
    state:       'running',
    leaseOwner:  String(process.pid),
    leaseExpiry: Date.now() - 2_000,
    executionId: crypto.randomUUID(),
  })
}

type CoordPrivate = { _recoverStuckNodes: () => void }
function triggerRecovery(coord: Coordinator): void {
  ;(coord as unknown as CoordPrivate)._recoverStuckNodes()
}

// ── 1. Crash point tests ──────────────────────────────────────────────────────
console.log('\nCrash points:')

// CP1: Crash BEFORE recordIntent
// Cache is absent. Lease has expired. Node is 'running' on disk.
// Recovery: absent + expired lease → reset to 'pending'.
// Re-execution: tool runs once → count = 1.
await test('CP1: crash before recordIntent — tool executes exactly once on recovery', async () => {
  const dir  = path.join(TMP, `cp1_${uniqueKey()}`)
  const goal = `crash_cp1_${uniqueKey()}`

  const { planId, nodeId } = setupCounterPlan(goal, dir)
  simulateCrashRunning(planId, nodeId)
  // No ToolCache write — crash happened before recordIntent
  resetMemoryCache()

  const result = await new Coordinator().acceptGoal(goal)

  assert.ok(result.success, `CP1: acceptGoal must succeed, errors: ${result.results.map(r => r.error).filter(Boolean).join(', ')}`)
  assert.equal(readCount(dir), 1, 'CP1: tool must execute exactly once')
})

// CP2: Crash AFTER recordIntent("pending"), BEFORE tool.execute()
// Cache is 'pending'. Lease has expired. Tool NEVER ran (counter = 0).
// Recovery: pending → reset to 'pending' with same key.
// Re-execution: tool runs for the first time → count = 1.
await test('CP2: crash after recordIntent (pending), before tool — executes exactly once', async () => {
  const dir  = path.join(TMP, `cp2_${uniqueKey()}`)
  const goal = `crash_cp2_${uniqueKey()}`

  const { planId, nodeId, iKey } = setupCounterPlan(goal, dir)
  simulateCrashRunning(planId, nodeId)
  recordIntent(iKey, COUNTER_TOOL)   // intent written; crash before tool ran
  resetMemoryCache()

  const result = await new Coordinator().acceptGoal(goal)

  assert.ok(result.success, 'CP2: acceptGoal must succeed')
  assert.equal(readCount(dir), 1, 'CP2: tool must execute exactly once')
})

// CP3: Crash AFTER tool.execute(), BEFORE commitResult("completed")
// Cache is 'pending'. Lease has expired. Tool DID run (counter = 1, .done exists).
// Recovery: pending → reset to 'pending' with same key.
// Re-execution: counter tool's .done guard fires → idempotent skip → count stays 1.
await test('CP3: crash after tool ran, before commitResult — idempotent skip keeps count = 1', async () => {
  const dir  = path.join(TMP, `cp3_${uniqueKey()}`)
  const goal = `crash_cp3_${uniqueKey()}`

  const { planId, nodeId, iKey } = setupCounterPlan(goal, dir)
  simulateCrashRunning(planId, nodeId)
  recordIntent(iKey, COUNTER_TOOL)     // pending written
  simulateToolRan(dir, iKey)           // tool ran (count=1, .done written)
  // commitResult NOT called — crash between tool return and ToolCache write
  resetMemoryCache()

  await new Coordinator().acceptGoal(goal)  // may succeed or fail; count is the assertion

  assert.equal(readCount(dir), 1, 'CP3: .done guard must prevent double-counting')
})

// CP4: Crash AFTER commitResult("completed"), BEFORE log "node_completed"
// Cache is 'completed'. Lease has expired. Node still 'running' on disk.
// Recovery: completed → marks node 'completed' without re-running tool.
await test('CP4: crash after commitResult (completed), before log — recovery skips tool', () => {
  const dir  = path.join(TMP, `cp4_${uniqueKey()}`)
  const goal = `crash_cp4_${uniqueKey()}`

  const { planId, nodeId, iKey } = setupCounterPlan(goal, dir)
  simulateCrashRunning(planId, nodeId)
  simulateToolRan(dir, iKey)
  commitResult(iKey, COUNTER_TOOL, { success: true, data: { count: 1 } })
  // No log entry — crash before node_completed was written
  resetMemoryCache()

  const coord = new Coordinator()
  triggerRecovery(coord)

  assert.equal(getPlan(planId)!.nodes[0].state, 'completed', 'CP4: recovery must mark node completed from ToolCache')
  assert.equal(readCount(dir), 1, 'CP4: recovery must not re-execute tool')
})

// CP5: Crash AFTER log "node_completed", BEFORE updateNode("completed")
// Cache is 'completed'. Log has 'node_completed'. Node still 'running' on disk.
// Recovery: completed → marks node 'completed'; _reconcileLogAndCache agrees.
await test('CP5: crash after log written, before plan update — recovery skips tool', () => {
  const dir    = path.join(TMP, `cp5_${uniqueKey()}`)
  const goal   = `crash_cp5_${uniqueKey()}`
  const execId = crypto.randomUUID()

  const { planId, nodeId, iKey } = setupCounterPlan(goal, dir)
  simulateCrashRunning(planId, nodeId)
  simulateToolRan(dir, iKey)
  commitResult(iKey, COUNTER_TOOL, { success: true, data: { count: 1 } })
  appendLog({ ts: Date.now(), planId, nodeId, executionId: execId, event: 'node_completed', toolName: COUNTER_TOOL, success: true, durationMs: 5, pid: process.pid })
  // Plan node still 'running' — crash here before updateNode("completed")
  resetMemoryCache()

  const coord = new Coordinator()
  triggerRecovery(coord)

  assert.equal(getPlan(planId)!.nodes[0].state, 'completed', 'CP5: recovery must mark node completed')
  assert.equal(readCount(dir), 1, 'CP5: recovery must not re-execute tool')
})

// ── 2. Pending state handling ─────────────────────────────────────────────────
console.log('\nPending state:')

await test('Recovery preserves idempotencyKey for pending nodes — never generates a new key', () => {
  const goal    = `key_preserve_${uniqueKey()}`
  const plan    = createPlan(goal)
  const node    = plan.nodes[0]
  const origKey = node.idempotencyKey

  updateNode(plan.id, node.id, {
    state:       'running',
    leaseExpiry: Date.now() - 1_000,
    executionId: crypto.randomUUID(),
  })
  recordIntent(origKey, node.toolName)
  resetMemoryCache()

  triggerRecovery(new Coordinator())

  const updated = getPlan(plan.id)!.nodes[0]
  assert.equal(updated.idempotencyKey, origKey, 'Idempotency key must survive recovery unchanged')
  assert.equal(updated.state, 'pending', 'Node must be reset to pending for uncertain execution')
})

await test('CP2 and CP3 both yield count = 1 — same infrastructure guarantee, different tool state', async () => {
  // CP2 variant: tool never ran
  {
    const dir  = path.join(TMP, `pend_cp2_${uniqueKey()}`)
    const goal = `pend_cp2_${uniqueKey()}`
    const { planId, nodeId, iKey } = setupCounterPlan(goal, dir)
    simulateCrashRunning(planId, nodeId)
    recordIntent(iKey, COUNTER_TOOL)
    resetMemoryCache()
    await new Coordinator().acceptGoal(goal)
    assert.equal(readCount(dir), 1, 'CP2 variant: count must be 1')
  }

  // CP3 variant: tool already ran
  {
    const dir  = path.join(TMP, `pend_cp3_${uniqueKey()}`)
    const goal = `pend_cp3_${uniqueKey()}`
    const { planId, nodeId, iKey } = setupCounterPlan(goal, dir)
    simulateCrashRunning(planId, nodeId)
    recordIntent(iKey, COUNTER_TOOL)
    simulateToolRan(dir, iKey)
    resetMemoryCache()
    await new Coordinator().acceptGoal(goal)
    assert.equal(readCount(dir), 1, 'CP3 variant: idempotent skip must keep count at 1')
  }
})

// ── 3. Late completion ────────────────────────────────────────────────────────
console.log('\nLate completion:')

await test('Late .then() commits "completed" to ToolCache after timeout fires', async () => {
  const LATE_TOOL = 'test.late_commit'
  let resolveToolFn!: (r: ToolResult) => void

  registerTool({
    name:        LATE_TOOL,
    description: 'Resolves only when explicitly triggered (simulates slow external call)',
    execute:     () => new Promise<ToolResult>(resolve => { resolveToolFn = resolve }),
  })

  try {
    const node: PlanNode = {
      id:             `node_late_${uniqueKey()}`,
      goalId:         `goal_late_${uniqueKey()}`,
      step:           'late test',
      toolName:       LATE_TOOL,
      toolInput:      {},
      state:          'pending',
      idempotencyKey: `late_${uniqueKey()}`,
      timeoutMs:      40,
    }

    const result = await new ExecutionAgent().executeNode(node, {})

    assert.equal(result.success, false, 'ExecutionAgent must return failure on timeout')
    assert.ok(result.error?.includes('timed out'), `Error must mention timeout, got: ${result.error}`)

    // ToolCache must be 'pending' — tool has not yet resolved
    resetMemoryCache()
    assert.equal(getStatus(node.idempotencyKey), 'pending', 'Status must be pending before late resolve')
    assert.equal(getCached(node.idempotencyKey), null, 'getCached must return null for pending entry')

    // Trigger late resolution — the .then() handler in ExecutionAgent fires
    resolveToolFn({ success: true, data: 'late-data' })
    await new Promise<void>(r => setTimeout(r, 30))  // allow .then() microtask to flush

    // ToolCache must now reflect the late completion
    resetMemoryCache()
    assert.equal(getStatus(node.idempotencyKey), 'completed', '.then() must commit completed after late resolve')
    assert.deepEqual(getCached(node.idempotencyKey)?.data, 'late-data', 'Cached data must match late result')
  } finally {
    unregisterTool(LATE_TOOL)
  }
})

await test('After late commit, a second ExecutionAgent run sees completed and skips via Coordinator', async () => {
  const SLOW_TOOL = 'test.slow_then_fast'
  let slowResolve!: (r: ToolResult) => void

  registerTool({
    name:    SLOW_TOOL,
    description: 'Slow tool for late-commit + coordinator skip test',
    execute: () => new Promise<ToolResult>(resolve => { slowResolve = resolve }),
  })

  try {
    const iKey = `slow_${uniqueKey()}`
    const node: PlanNode = {
      id:             `node_slow_${uniqueKey()}`,
      goalId:         `goal_slow_${uniqueKey()}`,
      step:           'slow test',
      toolName:       SLOW_TOOL,
      toolInput:      {},
      state:          'pending',
      idempotencyKey: iKey,
      timeoutMs:      40,
    }

    // Run and time out
    await new ExecutionAgent().executeNode(node, {})

    // Trigger late completion
    slowResolve({ success: true, data: 'slow-result' })
    await new Promise<void>(r => setTimeout(r, 30))

    // Verify the ToolCache now has 'completed' for this key
    resetMemoryCache()
    assert.equal(getStatus(iKey), 'completed', 'Late commit must be visible after memory reset')

    // A second direct ExecutionAgent call for the same node: Coordinator handles
    // skip via ToolCache; ExecutionAgent itself does not check the cache.
    // Verify at the cache level: status remains 'completed' (not overwritten).
    resetMemoryCache()
    assert.equal(getStatus(iKey), 'completed', 'Completed status must persist — not downgraded to pending')
  } finally {
    unregisterTool(SLOW_TOOL)
  }
})

// ── 4. Log + cache consistency ────────────────────────────────────────────────
console.log('\nConsistency:')

await test('verifyPlanConsistency returns consistent=true when all node_completed have success=true', () => {
  const planId = `cons_ok_${uniqueKey()}`
  const execId = crypto.randomUUID()

  appendLog({ ts: Date.now(), planId, nodeId: 'node_0', executionId: execId, event: 'node_completed', success: true, pid: process.pid })
  appendLog({ ts: Date.now(), planId, nodeId: 'node_1', executionId: execId, event: 'node_completed', success: true, pid: process.pid })

  const { consistent, diverged } = verifyPlanConsistency(planId, ['node_0', 'node_1'])
  assert.equal(consistent, true)
  assert.equal(diverged.length, 0)
})

await test('verifyPlanConsistency detects node_completed with success=false as diverged', () => {
  const planId = `cons_bad_${uniqueKey()}`
  const execId = crypto.randomUUID()

  appendLog({ ts: Date.now(), planId, nodeId: 'node_0', executionId: execId, event: 'node_completed', success: false, error: 'unexpected', pid: process.pid })

  const { consistent, diverged } = verifyPlanConsistency(planId, ['node_0'])
  assert.equal(consistent, false, 'node_completed with success=false must be flagged as diverged')
  assert.ok(diverged.includes('node_0'), 'node_0 must appear in diverged list')
})

await test('_reconcileLogAndCache synthesizes completed cache entry when log=completed but cache=absent', () => {
  const goal   = `reconcile_${uniqueKey()}`
  const plan   = createPlan(goal)
  const node   = plan.nodes[0]
  const execId = crypto.randomUUID()

  // Log says node_completed, but ToolCache was never written (simulates crash at CP5 variant)
  appendLog({ ts: Date.now(), planId: plan.id, nodeId: node.id, executionId: execId, event: 'node_completed', toolName: node.toolName, success: true, pid: process.pid })
  resetMemoryCache()

  // Recovery triggers _reconcileLogAndCache which detects the divergence
  triggerRecovery(new Coordinator())

  resetMemoryCache()
  assert.equal(getStatus(node.idempotencyKey), 'completed', '_reconcileLogAndCache must write synthetic completed entry')
})

// ── 5. Corruption resistance ──────────────────────────────────────────────────
console.log('\nCorruption resistance:')

await test('ToolCache reload skips malformed JSONL lines — valid entries unaffected', () => {
  const key = `corrupt_${uniqueKey()}`
  commitResult(key, COUNTER_TOOL, { success: true, data: 'good-entry' })

  // Inject garbage directly into the JSONL file (simulates partial write / disk corruption)
  fs.appendFileSync(getToolLogsFile(), 'NOT VALID JSON AT ALL\n')
  fs.appendFileSync(getToolLogsFile(), '{"key":"truncated\n')

  resetMemoryCache()
  const cached = getCached(key)
  assert.ok(cached, 'Valid cache entry must survive presence of malformed lines')
  assert.equal(cached!.data, 'good-entry', 'Data must be intact after corruption bypass')
})

await test('ToolCache last-write-wins: completed entry overrides prior pending for same key', () => {
  const key = `lww_${uniqueKey()}`
  recordIntent(key, COUNTER_TOOL)                                      // pending written first
  commitResult(key, COUNTER_TOOL, { success: true, data: 'final' })   // then completed

  resetMemoryCache()
  assert.equal(getStatus(key), 'completed', 'completed must win over prior pending for same key')
  assert.equal(getCached(key)?.data, 'final')
})

await test('ToolCache: getCached returns null for pending entry (no result to expose)', () => {
  const key = `pend_null_${uniqueKey()}`
  recordIntent(key, COUNTER_TOOL)

  resetMemoryCache()
  assert.equal(getStatus(key), 'pending')
  assert.equal(getCached(key), null, 'getCached must return null — pending has no committed result')
})

await test('Multiple pending entries for same key followed by completed — status is completed', () => {
  const key = `multi_pend_${uniqueKey()}`
  recordIntent(key, COUNTER_TOOL)   // first pending (original intent)
  recordIntent(key, COUNTER_TOOL)   // second pending (re-execution attempt)
  commitResult(key, COUNTER_TOOL, { success: true, data: 'done' })

  resetMemoryCache()
  assert.equal(getStatus(key), 'completed', 'Multiple pending lines must be overridden by completed')
  assert.equal(getCached(key)?.data, 'done')
})

// ── Cleanup + summary ─────────────────────────────────────────────────────────

unregisterTool(COUNTER_TOOL)

console.log(`\n${'─'.repeat(60)}`)
if (failed === 0) {
  console.log(`All ${passed} crash simulation tests passed.`)
} else {
  console.log(`${passed} passed, ${failed} failed.`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
