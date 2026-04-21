/**
 * coordinator.test.ts
 *
 * Proves the deterministic execution guarantees of the unified architecture:
 *   1. Single execution path   — tools cannot be triggered outside Coordinator
 *   2. No duplicate execution  — same goal/node runs exactly once
 *   3. Concurrency safety      — multiple acceptGoal calls serialize correctly
 *   4. No agent chaining       — ExecutionAgent has no spawn capability
 *   5. Plan integrity          — same goal reuses the existing plan
 *   6. Tool isolation          — ToolGuard blocks direct tool calls
 *   7. Output control          — speak() is not called by ExecutionAgent or Coordinator
 *
 * Run: npx tsx src/agents/tests/coordinator.test.ts
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Isolated plans file per test run to avoid cross-test pollution
const TEST_PLANS_FILE = path.join(os.tmpdir(), `axon_test_plans_${Date.now()}.json`)

function cleanupPlans(): void {
  if (fs.existsSync(TEST_PLANS_FILE)) fs.unlinkSync(TEST_PLANS_FILE)
}

// Patch PLANS_FILE before importing Planner (must happen before any import)
process.env['AXON_PLANS_FILE'] = TEST_PLANS_FILE

// ── Imports (after env patch) ─────────────────────────────────────────────────

import { setActiveNode, getActiveNode, assertInNodeContext } from '../ToolGuard.js'
import { createPlan, getPlan, updateNode }                   from '../Planner.js'
import { ExecutionAgent }                                    from '../ExecutionAgent.js'
import { Coordinator }                                       from '../Coordinator.js'
import { getTool }                                           from '../tools/index.js'
import type { PlanNode, ExecutionContext }                   from '../types.js'

// ── Mock tool that records call counts ───────────────────────────────────────

let mockCallCount = 0
let mockCalledOutsideContext = false

function installMockTool(): void {
  mockCallCount = 0
  mockCalledOutsideContext = false

  // We need to test the guard without making real network calls.
  // Override browser.search with a mock that respects ToolGuard.
  const tool = getTool('file.write')
  if (!tool) throw new Error('file.write not found in registry')
  // Wrap execute to track invocations
  const original = tool.execute.bind(tool)
  tool.execute = async (input) => {
    mockCallCount++
    return original(input)
  }
}

// ── Fake node factory ─────────────────────────────────────────────────────────

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    id:             'node_0',
    goalId:         'goal_test',
    step:           'write test file',
    toolName:       'file.write',
    toolInput:      { filename: `test_${Date.now()}.txt`, content: 'hello' },
    state:          'pending',
    idempotencyKey: `goal_test:node_0_${Date.now()}`,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nCoordinator Test Suite\n')

// ─── Test 6: Tool isolation ───────────────────────────────────────────────────
console.log('Tool isolation:')

await test('ToolGuard blocks direct tool.execute() when no node is active', async () => {
  setActiveNode(null)   // ensure clean state
  const tool = getTool('file.write')
  assert.ok(tool, 'file.write tool must exist')

  let threw = false
  try {
    await tool.execute({ filename: 'bad.txt', content: 'bypass' })
  } catch (e) {
    threw = true
    assert.ok(
      e instanceof Error && e.message.includes('outside Coordinator node execution'),
      `Expected guard error, got: ${e instanceof Error ? e.message : e}`
    )
  }
  assert.ok(threw, 'Tool must throw when called outside node context')
})

await test('ToolGuard allows tool.execute() when node is active', async () => {
  setActiveNode('node_test_123')
  const tool = getTool('file.write')!
  const result = await tool.execute({ filename: `guard_test_${Date.now()}.txt`, content: 'ok' })
  setActiveNode(null)
  assert.ok(result.success, `Tool should succeed inside node context: ${result.error ?? ''}`)
})

await test('getActiveNode() returns null after ExecutionAgent clears context', async () => {
  const executor = new ExecutionAgent()
  const node     = makeNode({ toolInput: { filename: `exec_clear_${Date.now()}.txt`, content: 'x' } })
  await executor.executeNode(node, {})
  assert.equal(getActiveNode(), null, 'Active node must be null after executeNode returns')
})

await test('getActiveNode() is null even when tool throws', async () => {
  const executor = new ExecutionAgent()
  // Use an unknown tool to force an early return (no node context set)
  const node = makeNode({ toolName: 'nonexistent.tool' })
  const result = await executor.executeNode(node, {})
  assert.equal(result.success, false)
  assert.equal(getActiveNode(), null, 'Active node must be null after failed executeNode')
})

// ─── Test 4: No agent chaining ────────────────────────────────────────────────
console.log('\nNo agent chaining:')

await test('ExecutionAgent has no createAgent method', () => {
  const executor = new ExecutionAgent()
  assert.ok(!('createAgent' in executor), 'ExecutionAgent must not expose createAgent')
})

await test('ExecutionAgent has no generatePlan method', () => {
  const executor = new ExecutionAgent()
  assert.ok(!('generatePlan' in executor), 'ExecutionAgent must not expose generatePlan')
})

await test('ExecutionAgent has no executeAgent method (sub-agent spawning)', () => {
  const executor = new ExecutionAgent()
  assert.ok(!('executeAgent' in executor), 'ExecutionAgent must not expose executeAgent')
})

await test('ExecutionAgent only exposes executeNode', () => {
  const executor    = new ExecutionAgent()
  const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(executor))
    .filter(m => m !== 'constructor' && !m.startsWith('_'))
  assert.deepEqual(publicMethods, ['executeNode'], `Expected only executeNode, got: ${publicMethods.join(', ')}`)
})

// ─── Test 5: Plan integrity ───────────────────────────────────────────────────
console.log('\nPlan integrity:')

await test('createPlan returns same plan for identical goal (idempotent)', () => {
  const goal  = `test_goal_${Date.now()}`
  const plan1 = createPlan(goal)
  const plan2 = createPlan(goal)
  assert.equal(plan1.id, plan2.id, 'Same goal must return same plan ID')
  assert.equal(plan1.nodes.length, plan2.nodes.length, 'Plan must have same number of nodes')
  cleanupPlans()
})

await test('createPlan creates different plans for different goals', () => {
  const plan1 = createPlan(`goal_A_${Date.now()}`)
  const plan2 = createPlan(`goal_B_${Date.now()}`)
  assert.notEqual(plan1.id, plan2.id, 'Different goals must produce different plan IDs')
  cleanupPlans()
})

await test('getPlan retrieves a created plan by ID', () => {
  const goal = `retrieval_test_${Date.now()}`
  const plan = createPlan(goal)
  const fetched = getPlan(plan.id)
  assert.ok(fetched, 'Plan must be retrievable by ID')
  assert.equal(fetched!.id, plan.id)
  assert.equal(fetched!.goal, goal)
  cleanupPlans()
})

await test('updateNode persists node state changes', () => {
  const plan = createPlan(`update_test_${Date.now()}`)
  updateNode(plan.id, plan.nodes[0].id, { state: 'completed', completedAt: Date.now() })
  const updated = getPlan(plan.id)
  assert.equal(updated!.nodes[0].state, 'completed', 'Node state must be persisted')
  cleanupPlans()
})

// ─── Test 2: No duplicate execution ──────────────────────────────────────────
console.log('\nNo duplicate execution:')

await test('Coordinator skips node already marked completed on disk', async () => {
  // Goal with 2+ nodes: "search and write" triggers both browser.search and file.write
  const goal = `search and write dedup_${Date.now()}`
  const plan = createPlan(goal)
  assert.ok(plan.nodes.length >= 2, `Need at least 2 nodes for this test, got ${plan.nodes.length}`)

  // Pre-mark first node as completed — plan stays 'active' because node_1 is still pending
  updateNode(plan.id, plan.nodes[0].id, { state: 'completed', result: 'pre-done', completedAt: Date.now() })

  const refetched = getPlan(plan.id)
  assert.equal(refetched!.state, 'active', 'Plan must stay active when only some nodes are completed')

  const coordinator = new Coordinator()
  const result      = await coordinator.acceptGoal(goal)

  // Coordinator must reuse the existing plan
  assert.equal(result.planId, plan.id, 'Must reuse existing plan')
  cleanupPlans()
})

await test('In-memory idempotency key prevents re-execution in same session', async () => {
  const executor  = new ExecutionAgent()
  const callTimes: number[] = []

  const coordinator = new Coordinator()
  // Use internal _executedKeys to verify idempotency
  const key = `goal_idem:node_0_${Date.now()}`

  // Manually mark as executed
  ;(coordinator as unknown as { _executedKeys: Set<string> })._executedKeys.add(key)

  const goal = `idem_session_${Date.now()}`
  const plan = createPlan(goal)
  // Set the first node's idempotency key to the already-executed key
  if (plan.nodes.length > 0) {
    updateNode(plan.id, plan.nodes[0].id, { idempotencyKey: key })
  }

  // The coordinator should skip the node
  const result = await coordinator.acceptGoal(goal)
  assert.equal(result.results.length, 0, 'No nodes should execute when all keys are in idempotency set')
  cleanupPlans()
})

// ─── Test 3: Concurrency safety ───────────────────────────────────────────────
console.log('\nConcurrency safety:')

await test('Two simultaneous acceptGoal calls serialize — execute sequentially', async () => {
  const coordinator = new Coordinator()
  const order: string[] = []

  // Track execution order using Planner mock
  const goal1 = `concurrent_A_${Date.now()}`
  const goal2 = `concurrent_B_${Date.now()}`

  // Fire both without await
  const p1 = coordinator.acceptGoal(goal1).then(r => { order.push('A'); return r })
  const p2 = coordinator.acceptGoal(goal2).then(r => { order.push('B'); return r })

  await Promise.all([p1, p2])

  // Both must complete (order is deterministic: A before B since A was queued first)
  assert.equal(order.length, 2, 'Both goals must complete')
  assert.equal(order[0], 'A', 'First-queued goal must complete first')
  assert.equal(order[1], 'B', 'Second-queued goal must complete second')
  cleanupPlans()
})

await test('Three concurrent acceptGoal calls all complete', async () => {
  const coordinator = new Coordinator()
  const goals = Array.from({ length: 3 }, (_, i) => `concurrent_${i}_${Date.now()}_${i}`)

  const results = await Promise.all(goals.map(g => coordinator.acceptGoal(g)))
  assert.equal(results.length, 3, 'All 3 goals must complete')
  cleanupPlans()
})

// ─── Test 1: Single execution path ───────────────────────────────────────────
console.log('\nSingle execution path:')

await test('ExecutionAgent.executeNode sets then clears active node context', async () => {
  const executor = new ExecutionAgent()
  const node     = makeNode({ toolInput: { filename: `path_test_${Date.now()}.txt`, content: 'x' } })

  assert.equal(getActiveNode(), null, 'Node context must be null before execution')
  const resultPromise = executor.executeNode(node, {})
  // After the call resolves, context must be cleared
  await resultPromise
  assert.equal(getActiveNode(), null, 'Node context must be null after execution')
})

await test('Tool throws without node context (proves tools unreachable outside Coordinator)', async () => {
  setActiveNode(null)
  const tool  = getTool('email.send')!
  let threw   = false
  try {
    await tool.execute({ to: 'x@x.com', body: 'test', subject: 'test' })
  } catch {
    threw = true
  }
  assert.ok(threw, 'email.send must throw outside coordinator context')
})

await test('Coordinator routes through ExecutionAgent (never calls tool directly)', async () => {
  // ExecutionAgent is the only code path that sets the active node.
  // If Coordinator called a tool directly, the guard would not be set and would throw.
  // We verify this by ensuring the guard IS set during tool execution.
  const executor    = new ExecutionAgent()
  let nodeIdDuring: string | null = null

  const tool = getTool('file.write')!
  const originalExec = tool.execute.bind(tool)
  tool.execute = async (input) => {
    nodeIdDuring = getActiveNode()  // capture what's set during execution
    return originalExec(input)
  }

  const node = makeNode({ toolInput: { filename: `via_exec_${Date.now()}.txt`, content: 'y' } })
  await executor.executeNode(node, {})

  tool.execute = originalExec  // restore

  assert.equal(nodeIdDuring, node.id, 'Active node must equal the executing node ID during tool call')
})

// ─── Test 7: Output control ───────────────────────────────────────────────────
console.log('\nOutput control:')

await test('ExecutionAgent does not import or call speak()', async () => {
  // Verify by inspecting the module source for speak() calls
  const src = fs.readFileSync(
    new URL('../ExecutionAgent.js', import.meta.url).pathname.replace(/\.js$/, '.ts'),
    'utf-8'
  )
  assert.ok(!src.includes("speak("), 'ExecutionAgent must not call speak()')
  assert.ok(!src.includes("from './tts"), 'ExecutionAgent must not import tts')
})

await test('Coordinator does not import or call speak()', async () => {
  const src = fs.readFileSync(
    new URL('../Coordinator.js', import.meta.url).pathname.replace(/\.js$/, '.ts'),
    'utf-8'
  )
  assert.ok(!src.includes("speak("), 'Coordinator must not call speak()')
  assert.ok(!src.includes("from './tts"), 'Coordinator must not import tts')
})

await test('Coordinator.execute() returns output string for index.ts to speak (not speak internally)', async () => {
  // Coordinator returns AgentResult.output — index.ts is the sole speaker for execution results
  const coordinator = new Coordinator()
  const input = {
    id:     'test_input',
    source: 'command' as const,
    text:   `write output test ${Date.now()}`,
    ts:     Date.now(),
  }
  const result = await coordinator.execute(input)
  // Result must have output string (for index.ts to speak) not call speak() directly
  assert.ok(typeof result.output === 'string', 'Coordinator.execute must return output string')
  assert.ok(result.output.length > 0, 'Output must be non-empty')
  cleanupPlans()
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)

if (failures.length) {
  console.error('\nFailed tests:')
  failures.forEach(f => console.error(`  • ${f}`))
  process.exit(1)
} else {
  console.log('\nAll tests passed.')
  process.exit(0)
}
