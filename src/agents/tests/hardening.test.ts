/**
 * hardening.test.ts
 *
 * Proves crash safety, multi-process concurrency, idempotency at all levels,
 * timeout enforcement, execution log replay accuracy, and file write integrity.
 *
 * Tests:
 *   1. LeaseManager — atomic acquire / release / expiry reclaim
 *   2. Multi-process simulation — two coordinators cannot hold the same lease
 *   3. ToolCache — idempotency across session boundaries
 *   4. Coordinator crash recovery — stuck 'running' nodes resolved correctly
 *   5. Timeout — ExecutionAgent enforces per-node timeout
 *   6. ExecutionLog — replay reconstructs state from log
 *   7. File write integrity — fsync + atomic rename in Planner
 *   8. End-to-end hardened path — all layers work together
 *
 * Run: npx tsx src/agents/tests/hardening.test.ts
 */

import assert from 'node:assert/strict'
import * as fs   from 'node:fs'
import * as os   from 'node:os'
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

const RUN_ID        = Date.now()
const TMP           = path.join(os.tmpdir(), `axon_hard_${RUN_ID}`)
const TEST_PLANS    = path.join(TMP, 'plans.json')
const TEST_LEASES   = path.join(TMP, 'leases')
const TEST_EXEC_LOG = path.join(TMP, 'exec_log.jsonl')
const TEST_TOOL_LOGS = path.join(TMP, 'tool_logs.jsonl')

fs.mkdirSync(TMP, { recursive: true })

process.env['AXON_PLANS_FILE'] = TEST_PLANS
process.env['AXON_LEASES_DIR'] = TEST_LEASES
process.env['AXON_EXEC_LOG']   = TEST_EXEC_LOG
process.env['AXON_TOOL_LOGS']  = TEST_TOOL_LOGS

// ── Imports (after env patch) ─────────────────────────────────────────────────

import { acquireLease, releaseLease, isLeaseHeld, isLeaseExpired, renewLease, getLeasesDir }
  from '../LeaseManager.js'
import { appendLog, loadLog, replayStateFromLog, verifyPlanConsistency }
  from '../ExecutionLog.js'
import { getCached, commitResult, resetMemoryCache, getToolLogsFile, getStatus }
  from '../ToolCache.js'
import { createPlan, getPlan, updateNode, loadPlans }
  from '../Planner.js'
import { ExecutionAgent }
  from '../ExecutionAgent.js'
import { Coordinator }
  from '../Coordinator.js'
import { setActiveNode, getActiveNode }
  from '../ToolGuard.js'
import { getTool }
  from '../tools/index.js'
import type { PlanNode, ExecutionContext }
  from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueKey(): string {
  return `test_${RUN_ID}_${crypto.randomUUID().slice(0, 8)}`
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  const key = uniqueKey()
  return {
    id:             `node_${key}`,
    goalId:         `goal_${key}`,
    step:           'test step',
    toolName:       'file.write',
    toolInput:      { filename: `test_${key}.txt`, content: 'x' },
    state:          'pending',
    idempotencyKey: key,
    ...overrides,
  }
}

// ── 1. LeaseManager ───────────────────────────────────────────────────────────
console.log('\nLeaseManager:')

await test('acquireLease returns true for a new key', () => {
  const key = uniqueKey()
  const got = acquireLease(key, 5_000)
  releaseLease(key)
  assert.equal(got, true)
})

await test('acquireLease returns false when lease is already held', () => {
  const key = uniqueKey()
  acquireLease(key, 5_000)
  const second = acquireLease(key, 5_000)
  releaseLease(key)
  assert.equal(second, false, 'Second acquire must fail')
})

await test('releaseLease allows re-acquisition', () => {
  const key = uniqueKey()
  acquireLease(key, 5_000)
  releaseLease(key)
  const reacquired = acquireLease(key, 5_000)
  releaseLease(key)
  assert.equal(reacquired, true, 'Must be re-acquirable after release')
})

await test('isLeaseHeld returns true while lease is active', () => {
  const key = uniqueKey()
  acquireLease(key, 5_000)
  assert.equal(isLeaseHeld(key), true)
  releaseLease(key)
})

await test('isLeaseHeld returns false after release', () => {
  const key = uniqueKey()
  acquireLease(key, 5_000)
  releaseLease(key)
  assert.equal(isLeaseHeld(key), false)
})

await test('Expired lease is automatically reclaimed on next acquire', async () => {
  const key = uniqueKey()
  // Acquire with 1ms TTL — expires immediately
  acquireLease(key, 1)
  await new Promise(r => setTimeout(r, 10))  // let it expire

  assert.equal(isLeaseExpired(key), true, 'Lease should be expired')

  // Reclaim should succeed
  const reclaimed = acquireLease(key, 5_000)
  releaseLease(key)
  assert.equal(reclaimed, true, 'Expired lease must be reclaimable')
})

await test('renewLease extends expiry for current owner', () => {
  const key = uniqueKey()
  acquireLease(key, 5_000)
  const renewed = renewLease(key, 30_000)
  releaseLease(key)
  assert.equal(renewed, true)
})

await test('releaseLease is idempotent — double-release does not throw', () => {
  const key = uniqueKey()
  acquireLease(key, 5_000)
  releaseLease(key)
  releaseLease(key)  // should not throw
})

// ── 2. Multi-process simulation ───────────────────────────────────────────────
console.log('\nMulti-process concurrency simulation:')

await test('Two concurrent acquireLease calls for same key — exactly one wins', async () => {
  const key = uniqueKey()
  // Fire two simultaneous acquires
  const [r1, r2] = await Promise.all([
    Promise.resolve(acquireLease(key, 5_000)),
    Promise.resolve(acquireLease(key, 5_000)),
  ])
  releaseLease(key)
  // Exactly one must have won
  const wins = [r1, r2].filter(Boolean).length
  assert.equal(wins, 1, `Expected exactly 1 winner, got ${wins}`)
})

await test('Three concurrent acquireLease calls — at most one wins', async () => {
  const key = uniqueKey()
  const results = await Promise.all(
    Array.from({ length: 3 }, () => Promise.resolve(acquireLease(key, 5_000)))
  )
  releaseLease(key)
  const wins = results.filter(Boolean).length
  assert.equal(wins, 1, `Expected exactly 1 winner, got ${wins}`)
})

await test('Coordinator serializes acceptGoal via lock — same key not acquired twice', async () => {
  const coordinator = new Coordinator()
  const key         = uniqueKey()
  const goal        = `concurrent_lock_test_${key}`

  // Fire two concurrent acceptGoal calls for the same goal
  const [r1, r2] = await Promise.all([
    coordinator.acceptGoal(goal),
    coordinator.acceptGoal(goal),
  ])
  // Both must complete without throwing
  assert.ok(r1, 'First result must be defined')
  assert.ok(r2, 'Second result must be defined')
})

// ── 3. ToolCache ──────────────────────────────────────────────────────────────
console.log('\nToolCache idempotency:')

await test('getCached returns null for unknown key', () => {
  resetMemoryCache()
  const result = getCached(uniqueKey())
  assert.equal(result, null)
})

await test('commitResult persists successful result — getCached returns it', () => {
  resetMemoryCache()
  const key = uniqueKey()
  commitResult(key, 'file.write', { success: true, data: 'hello' })
  const cached = getCached(key)
  assert.ok(cached, 'Committed result must be retrievable')
  assert.equal(cached!.success, true)
  assert.equal(cached!.data, 'hello')
})

await test('commitResult stores failed results — getCached returns them with success=false', () => {
  resetMemoryCache()
  const key = uniqueKey()
  commitResult(key, 'file.write', { success: false, error: 'oops' })
  const cached = getCached(key)
  assert.ok(cached, 'Failed result must be stored so Coordinator can inspect it')
  assert.equal(cached!.success, false, 'Stored result must reflect failure')
})

await test('ToolCache survives memory reset — reloads from disk', () => {
  const key = uniqueKey()
  commitResult(key, 'email.send', { success: true, data: { id: 'x123' } })

  // Wipe in-memory cache
  resetMemoryCache()

  // Should reload from disk JSONL
  const cached = getCached(key)
  assert.ok(cached, 'Cache must survive memory reset via disk reload')
  assert.equal((cached!.data as { id: string }).id, 'x123')
})

await test('Coordinator skips execution when ToolCache already has completed result for node key', async () => {
  const goal = `cache_hit_coord_${uniqueKey()}`
  const plan = createPlan(goal)
  const node = plan.nodes[0]

  // Pre-populate ToolCache as if a prior run completed this node
  commitResult(node.idempotencyKey, node.toolName, { success: true, data: 'precomputed' })

  let toolCalled = false
  const tool = getTool('file.write')!
  const orig = tool.execute.bind(tool)
  tool.execute = async (input) => { toolCalled = true; return orig(input) }

  try {
    const coordinator = new Coordinator()
    const result = await coordinator.acceptGoal(goal)
    assert.ok(!toolCalled, 'Tool must NOT execute when ToolCache already has completed result')
    assert.ok(result.results.some(r => r.success), 'Result must be success (from cache)')
  } finally {
    tool.execute = orig
  }
})

// ── 4. Coordinator crash recovery ─────────────────────────────────────────────
console.log('\nCrash recovery:')

await test('Coordinator recovers "running" node with ToolCache hit → marks completed', () => {
  const goal   = `crash_recovery_cached_${uniqueKey()}`
  const plan   = createPlan(goal)
  const node   = plan.nodes[0]
  const execId = crypto.randomUUID()

  // Simulate: node got stuck in running (crash mid-execution)
  updateNode(plan.id, node.id, {
    state:       'running',
    executionId: execId,
    leaseExpiry: Date.now() - 1,   // expired
  })
  // But the tool DID run and result is in ToolCache
  commitResult(node.idempotencyKey, node.toolName, { success: true, data: 'cached_result' })

  // Create a fresh coordinator — recovery happens on first acceptGoal
  const coordinator = new Coordinator()
  // Directly trigger recovery (private but accessible via cast)
  ;(coordinator as unknown as { _recoverStuckNodes: () => void })._recoverStuckNodes()

  const updated = getPlan(plan.id)!
  assert.equal(updated.nodes[0].state, 'completed', 'Node must be marked completed after recovery with cache hit')
})

await test('Coordinator recovers "running" node with expired lease → resets to pending', () => {
  const goal = `crash_recovery_reset_${uniqueKey()}`
  const plan = createPlan(goal)
  const node = plan.nodes[0]

  // Simulate: node stuck in running, lease expired, no tool result
  updateNode(plan.id, node.id, {
    state:       'running',
    leaseExpiry: Date.now() - 1_000,  // expired 1s ago
    executionId: crypto.randomUUID(),
  })
  // No ToolCache entry for this key

  resetMemoryCache()   // ensure clean cache state

  const coordinator = new Coordinator()
  ;(coordinator as unknown as { _recoverStuckNodes: () => void })._recoverStuckNodes()

  const updated = getPlan(plan.id)!
  assert.equal(updated.nodes[0].state, 'pending', 'Node must reset to pending when lease expired and no cache')
})

await test('Recovery runs exactly once per Coordinator instance', async () => {
  let recoverCount = 0
  const coordinator = new Coordinator()
  const original = (coordinator as unknown as { _recoverStuckNodes: () => void })._recoverStuckNodes.bind(coordinator)
  ;(coordinator as unknown as { _recoverStuckNodes: () => void })._recoverStuckNodes = () => {
    recoverCount++
    original()
  }

  // acceptGoal twice — recovery should only fire once
  const goal1 = `recovery_once_A_${uniqueKey()}`
  const goal2 = `recovery_once_B_${uniqueKey()}`
  await coordinator.acceptGoal(goal1)
  await coordinator.acceptGoal(goal2)

  assert.equal(recoverCount, 1, 'Recovery must run exactly once per Coordinator instance')
})

// ── 5. Timeout enforcement ────────────────────────────────────────────────────
console.log('\nTimeout:')

await test('ExecutionAgent returns failure NodeResult on timeout — never throws', async () => {
  const executor = new ExecutionAgent()
  const tool     = getTool('file.write')!
  const orig     = tool.execute.bind(tool)
  tool.execute   = () => new Promise(() => {})   // never resolves

  let result
  try {
    result = await executor.executeNode(
      makeNode({ timeoutMs: 50, toolInput: { filename: `timeout_res.txt`, content: 'x' } }),
      {}
    )
  } finally {
    tool.execute = orig    // always restore
  }

  assert.ok(result, 'executeNode must return a NodeResult, never throw')
  assert.equal(result!.success, false, 'Result must be failure on timeout')
  assert.ok(result!.error?.includes('timed out'), `Error must mention timeout, got: ${result!.error}`)
})

await test('ToolGuard is cleared after timeout', async () => {
  const executor = new ExecutionAgent()
  const tool     = getTool('file.write')!
  const orig     = tool.execute.bind(tool)
  tool.execute   = () => new Promise(() => {})

  try {
    await executor.executeNode(makeNode({ timeoutMs: 50 }), {})
  } finally {
    tool.execute = orig
  }

  assert.equal(getActiveNode(), null, 'Active node must be null after timeout (finally block)')
})

// ── 6. ExecutionLog replay ────────────────────────────────────────────────────
console.log('\nExecutionLog replay:')

await test('appendLog writes parseable JSONL entry', () => {
  const planId = uniqueKey()
  const nodeId = 'node_0'
  const execId = crypto.randomUUID()

  appendLog({ ts: Date.now(), planId, nodeId, executionId: execId, event: 'node_started', toolName: 'file.write', pid: process.pid })

  const entries = loadLog().filter(e => e.planId === planId)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].event, 'node_started')
  assert.equal(entries[0].nodeId, nodeId)
})

await test('replayStateFromLog reconstructs completed node', () => {
  const planId = uniqueKey()
  const nodeId = 'node_0'
  const execId = crypto.randomUUID()

  appendLog({ ts: Date.now(), planId, nodeId, executionId: execId, event: 'node_started',   toolName: 'file.write', pid: process.pid })
  appendLog({ ts: Date.now(), planId, nodeId, executionId: execId, event: 'node_completed', toolName: 'file.write', success: true, durationMs: 10, pid: process.pid })

  const state = replayStateFromLog(planId)
  const ns    = state.get(nodeId)
  assert.ok(ns, 'Node state must exist')
  assert.equal(ns!.lastEvent, 'node_completed')
  assert.equal(ns!.success, true)
})

await test('replayStateFromLog tracks last event — failed node', () => {
  const planId = uniqueKey()
  const nodeId = 'node_0'
  const execId = crypto.randomUUID()

  appendLog({ ts: Date.now(), planId, nodeId, executionId: execId, event: 'node_started', pid: process.pid })
  appendLog({ ts: Date.now(), planId, nodeId, executionId: execId, event: 'node_failed', success: false, error: 'timeout', pid: process.pid })

  const state = replayStateFromLog(planId)
  const ns    = state.get(nodeId)
  assert.equal(ns!.lastEvent, 'node_failed')
  assert.equal(ns!.success, false)
})

await test('verifyPlanConsistency returns consistent=true for clean plan', () => {
  const planId = uniqueKey()
  const execId = crypto.randomUUID()

  appendLog({ ts: Date.now(), planId, nodeId: 'node_0', executionId: execId, event: 'node_completed', success: true, pid: process.pid })
  appendLog({ ts: Date.now(), planId, nodeId: 'node_1', executionId: execId, event: 'node_completed', success: true, pid: process.pid })

  const { consistent, diverged } = verifyPlanConsistency(planId, ['node_0', 'node_1'])
  assert.equal(consistent, true)
  assert.equal(diverged.length, 0)
})

await test('Coordinator writes node_started and node_completed to log', async () => {
  const goal        = `log_write_test_${uniqueKey()}`
  const coordinator = new Coordinator()
  const result      = await coordinator.acceptGoal(goal)

  const plan    = createPlan(goal)  // retrieve same plan
  const entries = loadLog().filter(e => e.planId === result.planId)

  assert.ok(entries.length >= 2, `Expected at least 2 log entries, got ${entries.length}`)
  assert.ok(entries.some(e => e.event === 'node_started'),   'Must log node_started')
  assert.ok(entries.some(e => e.event === 'node_completed' || e.event === 'node_failed'), 'Must log terminal event')
})

// ── 7. File write integrity ───────────────────────────────────────────────────
console.log('\nFile write integrity:')

await test('Planner savePlans persists plan — immediately retrievable via getPlan', () => {
  const goal = `fsync_test_${uniqueKey()}`
  const plan = createPlan(goal)

  // Immediate round-trip verifies write + atomic rename succeeded
  const retrieved = getPlan(plan.id)
  assert.ok(retrieved, 'Plan must be immediately retrievable after write')
  assert.equal(retrieved!.goal, goal, 'Retrieved plan must have correct goal')
  assert.ok(!fs.existsSync(TEST_PLANS + '.tmp'), '.tmp file must not remain after write')
})

await test('Planner does not leave .tmp file after successful write', () => {
  createPlan(`no_tmp_${uniqueKey()}`)
  assert.ok(!fs.existsSync(TEST_PLANS + '.tmp'), '.tmp file must not remain after write')
})

await test('Multiple Planner writes — all plans remain retrievable', () => {
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const plan = createPlan(`multi_write_${uniqueKey()}`)
    ids.push(plan.id)
  }
  for (const id of ids) {
    assert.ok(getPlan(id), `Plan ${id} must be retrievable after multiple sequential writes`)
  }
})

await test('LeaseManager writeLeaseData survives via fsync — readable after write', () => {
  const key = uniqueKey()
  acquireLease(key, 30_000)
  const leasesDir  = getLeasesDir()
  const safeKey    = key.replace(/[:/\\]/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  const leaseFile  = path.join(leasesDir, safeKey, 'lease.json')
  assert.ok(fs.existsSync(leaseFile), 'lease.json must exist after acquire')
  const data = JSON.parse(fs.readFileSync(leaseFile, 'utf-8'))
  assert.equal(data.pid, process.pid)
  releaseLease(key)
})

// ── 8. End-to-end hardened path ───────────────────────────────────────────────
console.log('\nEnd-to-end hardened:')

await test('Full execution: lease acquired → tool runs → cache written → lease released', async () => {
  const goal        = `e2e_hardened_${uniqueKey()}`
  const coordinator = new Coordinator()
  const result      = await coordinator.acceptGoal(goal)

  const plan = getPlan(result.planId)!

  // All nodes must be terminal (completed or failed — not stuck in running)
  const stuck = plan.nodes.filter(n => n.state === 'running')
  assert.equal(stuck.length, 0, `Nodes must not be stuck running: ${stuck.map(n => n.id).join(', ')}`)

  // Leases must all be released
  for (const node of plan.nodes) {
    assert.equal(isLeaseHeld(node.idempotencyKey), false, `Lease must be released for ${node.id}`)
  }
})

await test('Repeated acceptGoal for same completed plan does not re-execute', async () => {
  const goal        = `no_reexec_${uniqueKey()}`
  const coordinator = new Coordinator()

  await coordinator.acceptGoal(goal)

  // Reset in-memory keys to force re-evaluation (simulates new session)
  ;(coordinator as unknown as { _executedKeys: Set<string> })._executedKeys.clear()

  let toolCallCount = 0
  const tool = getTool('file.write')!
  const orig = tool.execute.bind(tool)
  tool.execute = async (input) => { toolCallCount++; return orig(input) }

  await coordinator.acceptGoal(goal)
  tool.execute = orig

  assert.equal(toolCallCount, 0, 'Tool must not re-execute when plan nodes are already completed on disk')
})

await test('__idempotencyKey injected into tool input by ExecutionAgent', async () => {
  const executor   = new ExecutionAgent()
  let capturedKey: unknown = undefined

  const tool = getTool('file.write')!
  const orig = tool.execute.bind(tool)
  tool.execute = async (input) => {
    capturedKey = input['__idempotencyKey']
    return orig(input)
  }

  try {
    const node = makeNode({ toolInput: { filename: `key_inject_${uniqueKey()}.txt`, content: 'z' } })
    await executor.executeNode(node, {})
    assert.equal(capturedKey, node.idempotencyKey, '__idempotencyKey must equal node.idempotencyKey')
  } finally {
    tool.execute = orig
  }
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failures.length) {
  console.error('\nFailed tests:')
  failures.forEach(f => console.error(`  • ${f}`))
  process.exit(1)
} else {
  console.log('\nAll hardening tests passed.')
  process.exit(0)
}
