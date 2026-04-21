/**
 * planner.test.ts — Coordinator + Planner integration tests
 *
 * Tests:
 *   1. Plan created once and reused across coordinator cycles
 *   2. Execution progresses node-by-node (one node per acceptGoal call)
 *   3. Goal completes correctly when all nodes succeed
 *   4. No duplicate execution — lease prevents two concurrent acceptGoal calls
 *   5. All-fail path → goal blocked, not crashed
 *   6. email.send blocked without autoApprove
 *
 * Run: npx tsx src/agents/planner.test.ts
 *
 * Uses a temp HOME dir so tests don't pollute ~/.aria
 * Mocks global.fetch to avoid requiring live Ollama
 * Mocks tool registry to return controlled results
 */

import * as os   from 'os'
import * as fs   from 'fs'
import * as path from 'path'

// ── Temp HOME so tests write to isolated dir ───────────────────────────────

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-test-'))
process.env.HOME = TEST_HOME

// ── Colour helpers ─────────────────────────────────────────────────────────

const C = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
}

// ── Test result tracking ───────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; note?: string }
const results: TestResult[] = []

function assert(name: string, condition: boolean, note?: string): void {
  results.push({ name, passed: condition, note })
  const icon = condition ? C.green('✓') : C.red('✗')
  console.log(`  ${icon}  ${name}${note ? C.dim(` — ${note}`) : ''}`)
}

function section(title: string): void {
  console.log(`\n${C.bold(title)}`)
}

// ── fetch mock — returns a 2-step plan from "Ollama" ──────────────────────

function mockFetchWithPlan(steps: string[]): typeof fetch {
  return async () => {
    await new Promise(r => setTimeout(r, 5))  // simulate network
    return new Response(
      JSON.stringify({ message: { content: JSON.stringify(steps) } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

// ── Tool registry mock — inject controllable tools ────────────────────────

async function mockToolRegistry(tools: Record<string, (input: unknown) => Promise<unknown>>) {
  const { getToolRegistry } = await import('../execution/tools/index.js')
  const registry = getToolRegistry()
  for (const [name, fn] of Object.entries(tools)) {
    registry.set(name, { name, execute: fn })
  }
}

// ── Goal helpers ──────────────────────────────────────────────────────────

async function createTestGoal(
  description: string,
  autoApprove = false
) {
  const { createGoal, updateGoal } = await import('../autonomy/goals.js')
  const goal = createGoal(description, 'high')
  if (autoApprove) updateGoal(goal.id, { autoApprove: true })
  return goal
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function test1_planCreatedOnceAndReused(): Promise<void> {
  section('TEST 1 — Plan created once and reused')

  global.fetch = mockFetchWithPlan([
    'search for test data',
    'write results to file',
  ])

  const goal = await createTestGoal('find and store test data')
  const { coordinator }     = await import('./Coordinator.js')
  const { getPlanForGoal }  = await import('./Planner.js')

  // First acceptGoal → creates plan
  await coordinator.acceptGoal(goal.id)
  const plan1 = getPlanForGoal(goal.id)
  assert('Plan created on first acceptGoal', plan1 !== null, `id=${plan1?.id?.slice(-6)}`)

  // Second acceptGoal → reuses same plan
  await coordinator.acceptGoal(goal.id)
  const plan2 = getPlanForGoal(goal.id)
  assert('Same plan reused on second acceptGoal', plan1?.id === plan2?.id,
    `plan1=${plan1?.id?.slice(-6)} plan2=${plan2?.id?.slice(-6)}`)

  // Third acceptGoal → still same plan
  await coordinator.acceptGoal(goal.id)
  const plan3 = getPlanForGoal(goal.id)
  assert('Same plan reused on third acceptGoal', plan1?.id === plan3?.id)
}

async function test2_executionProgressesNodeByNode(): Promise<void> {
  section('TEST 2 — Execution progresses node-by-node')

  const executedTools: string[] = []

  global.fetch = mockFetchWithPlan([
    'search for leads in Seattle',
    'write results to file leads.txt',
  ])

  await mockToolRegistry({
    'browser.search': async (input) => {
      executedTools.push('browser.search')
      return { results: [{ url: 'https://example.com', title: 'Test' }] }
    },
    'file.write': async (input) => {
      executedTools.push('file.write')
      return { filename: 'leads.txt', written: true }
    },
  })

  const goal = await createTestGoal('find leads in Seattle and write to file')
  const { coordinator }    = await import('./Coordinator.js')
  const { getPlanForGoal } = await import('./Planner.js')

  // Cycle 1 — should execute node 0 (search)
  await coordinator.acceptGoal(goal.id)
  const plan = getPlanForGoal(goal.id)!
  const after1 = plan.nodes.map(n => n.status)
  assert('After cycle 1: first node is done', after1[0] === 'done', `statuses=${after1.join(',')}`)
  assert('After cycle 1: second node is still pending', after1[1] === 'pending', `statuses=${after1.join(',')}`)
  assert('After cycle 1: only one tool executed', executedTools.length === 1, `executed=${executedTools.join(',')}`)

  // Cycle 2 — should execute node 1 (write)
  await coordinator.acceptGoal(goal.id)
  const plan2   = getPlanForGoal(goal.id)!
  const after2  = plan2.nodes.map(n => n.status)
  assert('After cycle 2: both nodes are done', after2.every(s => s === 'done'), `statuses=${after2.join(',')}`)
  assert('After cycle 2: both tools executed in order',
    executedTools[0] === 'browser.search' && executedTools[1] === 'file.write',
    `order=${executedTools.join(',')}`)
}

async function test3_goalCompletesCorrectly(): Promise<void> {
  section('TEST 3 — Goal completes when all nodes succeed')

  global.fetch = mockFetchWithPlan(['search for something'])

  await mockToolRegistry({
    'browser.search': async () => ({ results: [{ title: 'Result' }] }),
  })

  const goal = await createTestGoal('search for something and complete')
  const { coordinator } = await import('./Coordinator.js')
  const { getGoal }     = await import('../autonomy/goals.js')

  await coordinator.acceptGoal(goal.id)   // executes the node
  await coordinator.acceptGoal(goal.id)   // finalizes plan (all terminal)

  const finalGoal = getGoal(goal.id)
  assert('Goal status is completed', finalGoal?.status === 'completed', `status=${finalGoal?.status}`)
  assert('Goal progress is 1', finalGoal?.progress === 1, `progress=${finalGoal?.progress}`)
  assert('Goal has planId attached', !!finalGoal?.planId, `planId=${finalGoal?.planId?.slice(-6)}`)
}

async function test4_noduplicateExecution(): Promise<void> {
  section('TEST 4 — No duplicate execution (concurrent acceptGoal calls)')

  let execCount = 0

  global.fetch = mockFetchWithPlan(['search for concurrent test'])

  await mockToolRegistry({
    'browser.search': async () => {
      execCount++
      await new Promise(r => setTimeout(r, 50))  // simulate slow tool
      return { results: [] }
    },
  })

  const goal = await createTestGoal('concurrent execution test')
  const { coordinator } = await import('./Coordinator.js')

  // Fire two acceptGoal calls concurrently
  await Promise.allSettled([
    coordinator.acceptGoal(goal.id),
    coordinator.acceptGoal(goal.id),
  ])

  assert(
    'Tool executed exactly once despite two concurrent calls',
    execCount === 1,
    `execCount=${execCount}`
  )
}

async function test5_allFailsBlocksGoal(): Promise<void> {
  section('TEST 5 — All-fail path blocks goal (no crash)')

  global.fetch = mockFetchWithPlan(['search for failing data'])

  await mockToolRegistry({
    'browser.search': async () => { throw new Error('network error') },
  })

  const goal = await createTestGoal('test all-fail scenario')
  const { coordinator } = await import('./Coordinator.js')
  const { getGoal }     = await import('../autonomy/goals.js')
  const { getPlanForGoal } = await import('./Planner.js')

  // Exhaust all retries (maxAttempts=3 → 3 acceptGoal calls)
  await coordinator.acceptGoal(goal.id)   // attempt 1
  await coordinator.acceptGoal(goal.id)   // attempt 2
  await coordinator.acceptGoal(goal.id)   // attempt 3 → exhausted → finalize

  // After exhaustion, one more cycle to trigger finalize
  await coordinator.acceptGoal(goal.id)

  const finalGoal = getGoal(goal.id)
  const plan      = getPlanForGoal(goal.id)

  assert('Goal is failed/blocked (not crashed)', finalGoal?.status === 'failed', `status=${finalGoal?.status}`)
  assert('Plan is blocked', plan?.status === 'blocked', `planStatus=${plan?.status}`)
}

async function test6_emailBlockedWithoutApproval(): Promise<void> {
  section('TEST 6 — email.send blocked without autoApprove')

  global.fetch = mockFetchWithPlan(['send email with results'])

  let emailSent = false
  await mockToolRegistry({
    'email.send': async () => { emailSent = true; return { sent: true } },
  })

  const goal = await createTestGoal('send email without approval')  // autoApprove = false
  const { coordinator } = await import('./Coordinator.js')
  const { getGoal }     = await import('../autonomy/goals.js')
  const { getPlanForGoal } = await import('./Planner.js')

  await coordinator.acceptGoal(goal.id)

  assert('Email tool was NOT called without autoApprove', !emailSent, `emailSent=${emailSent}`)

  const plan = getPlanForGoal(goal.id)
  const node = plan?.nodes[0]
  assert('Email node marked failed (safety gate)', node?.status === 'failed', `nodeStatus=${node?.status}`)
}

// ── Main runner ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(C.bold('\n═══ AXON Planner/Coordinator Tests ═══'))
  console.log(C.dim(`  Isolated HOME: ${TEST_HOME}`))

  try {
    await test1_planCreatedOnceAndReused()
    await test2_executionProgressesNodeByNode()
    await test3_goalCompletesCorrectly()
    await test4_noduplicateExecution()
    await test5_allFailsBlocksGoal()
    await test6_emailBlockedWithoutApproval()
  } catch (err) {
    console.error(C.red('\n[FATAL] test runner threw:'), err)
    results.push({ name: 'RUNNER', passed: false, note: String(err) })
  }

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  console.log('\n' + '═'.repeat(50))
  console.log(C.bold(`  ${passed} passed  ${failed > 0 ? C.red(`${failed} failed`) : C.green('0 failed')}`))
  console.log('═'.repeat(50) + '\n')

  // Cleanup
  try { fs.rmSync(TEST_HOME, { recursive: true }) } catch {}

  if (failed > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
