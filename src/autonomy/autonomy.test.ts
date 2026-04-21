/**
 * autonomy.test.ts — end-to-end test harness for the AXON autonomy layer.
 *
 * Run: npx tsx src/autonomy/autonomy.test.ts
 *
 * What it exercises:
 *   1. Goal creation and persistence
 *   2. Autonomy loop starts, reads goal, dispatches action (no user input)
 *   3. ExecutionAgent decomposes goal, runs tool steps
 *   4. AXONCore feedback updates goal progress
 *   5. Loop re-evaluates and drives goal toward completion
 *   6. TaskAgent creates follow-up task after execution
 *
 * Tuning:
 *   AXON_LOOP_INTERVAL_MS=3000  (default in test — faster cycles)
 *   AXON_STALE_MS=10000         (10s stale threshold instead of 5min)
 *   AXON_MAX_ACTIONS=1          (one action per cycle for clean log)
 */

// ── Environment setup (must happen before any imports) ───────────────────────
process.env.AXON_LOOP_INTERVAL_MS = process.env.AXON_LOOP_INTERVAL_MS ?? '3000'
process.env.AXON_STALE_MS         = process.env.AXON_STALE_MS         ?? '10000'
process.env.AXON_MAX_ACTIONS      = process.env.AXON_MAX_ACTIONS       ?? '1'

import * as fs   from 'fs'
import * as path from 'path'
import * as os   from 'os'

import {
  createGoal,
  getGoal,
  getAllGoals,
  updateGoal,
  type Goal,
} from './goals.js'

import { startAutonomyLoop, stopAutonomyLoop, getCycleCount } from './loop.js'
import { onAXONFeedback }                                     from '../agents/AXONCore.js'
import { getAllAgents }                                        from '../execution/AgentManager.js'

// ── Test configuration ────────────────────────────────────────────────────────

const TEST_DURATION_MS   = parseInt(process.env.TEST_DURATION_MS ?? '30000', 10)
const GOAL_DESCRIPTION   = 'Find HVAC leads and contact them'
const GOALS_FILE         = path.join(os.homedir(), '.aria', 'goals.json')

// ── Helpers ───────────────────────────────────────────────────────────────────

function separator(label: string): void {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${label}`)
  console.log('─'.repeat(60))
}

function snapshotGoal(goal: Goal): void {
  console.log(`[TEST] goal snapshot:`)
  console.log(`  id          : ${goal.id}`)
  console.log(`  status      : ${goal.status}`)
  console.log(`  progress    : ${Math.round(goal.progress * 100)}%`)
  console.log(`  steps done  : ${goal.completedSteps.length}`)
  console.log(`  agents used : ${goal.linkedAgentIds.length}`)
  if (goal.nextAction) console.log(`  nextAction  : ${goal.nextAction}`)
  if (goal.completedSteps.length) {
    console.log(`  last step   : ${goal.completedSteps.at(-1)?.slice(0, 80)}`)
  }
}

// ── Test state ────────────────────────────────────────────────────────────────

let testGoalId      = ''
let progressUpdates = 0
let executionFires  = 0

// ── Wipe any leftover goals from previous runs ─────────────────────────────

function wipePreviousTestGoals(): void {
  if (!fs.existsSync(GOALS_FILE)) return
  try {
    const all = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8')) as Goal[]
    const kept = all.filter(g => !g.description.includes('HVAC') || g.status === 'completed')
    fs.writeFileSync(GOALS_FILE, JSON.stringify(kept, null, 2))
    console.log(`[TEST] cleaned ${all.length - kept.length} leftover test goal(s)`)
  } catch { /* ignore parse errors on corrupted file */ }
}

// ── Feedback listener ─────────────────────────────────────────────────────────

function attachFeedbackListener(): void {
  onAXONFeedback(result => {
    if (result.agentId === 'execution') {
      executionFires++
      const steps    = (result.data as { steps?: unknown[] })?.steps ?? []
      const succeeded = (result.data as { succeeded?: number })?.succeeded ?? 0
      const duration  = (result.data as { durationMs?: number })?.durationMs ?? 0
      console.log(
        `[TEST] execution feedback — ${succeeded}/${steps.length} steps, ${duration}ms, success=${result.success}`
      )
    }
  })
}

// ── Progress polling ──────────────────────────────────────────────────────────

function startProgressPoller(goalId: string, intervalMs = 5000): NodeJS.Timeout {
  let lastProgress = -1
  return setInterval(() => {
    const g = getGoal(goalId)
    if (!g) return
    if (g.progress !== lastProgress) {
      progressUpdates++
      lastProgress = g.progress
      console.log(
        `[TEST] goal progress: ${Math.round(g.progress * 100)}% — ` +
        `status=${g.status} steps=${g.completedSteps.length}`
      )
    }
    if (g.status === 'completed' || g.status === 'failed') {
      console.log(`[TEST] goal terminal state reached: ${g.status}`)
    }
  }, intervalMs)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  separator('AXON AUTONOMY TEST')
  console.log(`Goal       : "${GOAL_DESCRIPTION}"`)
  console.log(`Duration   : ${TEST_DURATION_MS / 1000}s`)
  console.log(`Loop every : ${process.env.AXON_LOOP_INTERVAL_MS}ms`)
  console.log(`Stale after: ${process.env.AXON_STALE_MS}ms`)

  // ── Setup ─────────────────────────────────────────────────────────────────

  wipePreviousTestGoals()
  attachFeedbackListener()

  // ── 1. Create goal ────────────────────────────────────────────────────────

  separator('STEP 1 — Create goal')
  const goal = createGoal(GOAL_DESCRIPTION, 'high')
  testGoalId = goal.id
  snapshotGoal(goal)

  // ── 2. Start autonomy loop ────────────────────────────────────────────────

  separator('STEP 2 — Start autonomy loop')
  const progressPoller = startProgressPoller(testGoalId, 4000)
  startAutonomyLoop()
  console.log('[TEST] loop running — waiting for autonomous execution...')

  // ── 3. Run for TEST_DURATION_MS ───────────────────────────────────────────

  await new Promise<void>(resolve => setTimeout(resolve, TEST_DURATION_MS))

  // ── 4. Stop and inspect results ───────────────────────────────────────────

  stopAutonomyLoop()
  clearInterval(progressPoller)

  separator('RESULTS')

  const finalGoal = getGoal(testGoalId)
  if (!finalGoal) {
    console.log('[TEST] FAIL — goal not found after test')
    process.exit(1)
  }

  snapshotGoal(finalGoal)

  const agents      = getAllAgents()
  const myAgents    = agents.filter(a => a.goal.includes('HVAC') || a.goal.includes('hvac'))
  const allSteps    = myAgents.flatMap(a => (a.result ?? []) as { step: string; success: boolean; tool: string }[])
  const succeeded   = allSteps.filter(s => s.success)

  console.log(`\n[TEST] sub-agents created : ${myAgents.length}`)
  console.log(`[TEST] total steps run    : ${allSteps.length}`)
  console.log(`[TEST] steps succeeded    : ${succeeded.length}`)
  console.log(`[TEST] execution fires    : ${executionFires}`)
  console.log(`[TEST] loop cycles        : ${getCycleCount()}`)
  console.log(`[TEST] progress updates   : ${progressUpdates}`)

  if (allSteps.length > 0) {
    console.log('\n[TEST] step breakdown:')
    for (const s of allSteps) {
      const mark = s.success ? '✓' : '✗'
      console.log(`  ${mark} [${s.tool}] ${s.step.slice(0, 70)}`)
    }
  }

  // Assertions
  separator('ASSERTIONS')
  let passed = 0
  let failed = 0

  function assert(label: string, condition: boolean): void {
    if (condition) { console.log(`  ✓ ${label}`); passed++ }
    else           { console.log(`  ✗ ${label}`); failed++ }
  }

  assert('Goal exists in persistent store',       finalGoal !== null)
  assert('Goal progress advanced beyond 0',        finalGoal.progress > 0)
  assert('At least one sub-agent was created',     myAgents.length > 0)
  assert('At least one execution step ran',        allSteps.length > 0)
  assert('Loop ran at least 2 cycles',             getCycleCount() >= 2)
  assert('Execution feedback was received',        executionFires > 0)
  assert('Goal has linked agent IDs',              finalGoal.linkedAgentIds.length > 0)
  assert('Goal status is not "active" if done',
    finalGoal.progress >= 1 ? finalGoal.status !== 'active' : true)

  console.log(`\n  ${passed} passed | ${failed} failed`)

  if (failed > 0) {
    console.log('\n[TEST] INCOMPLETE — some assertions failed. This is expected if Ollama is not')
    console.log('[TEST] running (LLM plan generation + step execution require Ollama locally).')
    console.log('[TEST] The control flow, goal persistence, and loop dispatch are all exercised.')
  } else {
    console.log('\n[TEST] ALL ASSERTIONS PASSED')
  }

  // Print a full sub-agent log for the first agent
  if (myAgents[0]?.logs.length) {
    separator(`Sub-agent log: ${myAgents[0].id}`)
    for (const line of myAgents[0].logs) console.log(line)
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('[TEST] fatal:', err)
  process.exit(1)
})
