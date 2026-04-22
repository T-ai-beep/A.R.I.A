/**
 * runner.ts — ARIA Master Test Harness
 * Orchestrates all test suites, collects metrics, produces scorecard.
 *
 * Run: npx tsx src/harness/runner.ts
 *      npx tsx src/harness/runner.ts --suite=latency
 *      npx tsx src/harness/runner.ts --suite=all --report=json
 */

import { performance } from 'perf_hooks'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── Types ──────────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'WARN' | 'SKIP'
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface TestCase {
  id: string
  suite: string
  name: string
  severity: Severity
  verdict: Verdict
  durationMs: number
  expected: string
  got: string | null
  note: string
  metrics?: Record<string, number>
}

export interface SuiteResult {
  suite: string
  pass: number
  fail: number
  warn: number
  skip: number
  total: number
  criticalFails: number
  durationMs: number
  cases: TestCase[]
}

export interface RunReport {
  meta: {
    version: string
    ts: string
    host: string
    nodeVersion: string
    totalDurationMs: number
    goNoGo: boolean
  }
  suites: SuiteResult[]
  latencyP50: number
  latencyP90: number
  latencyP99: number
  overallScore: number
  redFlags: string[]
}

// ── Global result store ────────────────────────────────────────────────────

const allCases: TestCase[] = []
const redFlags: string[] = []

// ── Recording helpers ──────────────────────────────────────────────────────

export function record(
  suite: string,
  id: string,
  name: string,
  severity: Severity,
  verdict: Verdict,
  expected: string,
  got: string | null,
  note = '',
  durationMs = 0,
  metrics?: Record<string, number>
): void {
  const tc: TestCase = { id, suite, name, severity, verdict, durationMs, expected, got, note, metrics }
  allCases.push(tc)

  const icon = verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : verdict === 'WARN' ? '⚠️' : '⏭'
  const sev  = severity === 'CRITICAL' ? ' [CRITICAL]' : ''
  console.log(`  ${icon}${sev} [${id}] ${name}`)

  if (verdict !== 'PASS' && verdict !== 'SKIP') {
    console.log(`       expected : ${expected}`)
    console.log(`       got      : ${got ?? '(null)'}`)
    if (note) console.log(`       note     : ${note}`)
    if (metrics) console.log(`       metrics  : ${JSON.stringify(metrics)}`)
  }

  if (verdict === 'FAIL' && severity === 'CRITICAL') {
    redFlags.push(`[${id}] ${name} — CRITICAL FAIL`)
  }
}

export function section(title: string): void {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(70)}`)
}

// ── Utility ────────────────────────────────────────────────────────────────

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now()
  const result = await fn()
  return { result, ms: performance.now() - t0 }
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// ── Suite aggregation ──────────────────────────────────────────────────────

function aggregateSuites(): SuiteResult[] {
  const suiteNames = [...new Set(allCases.map(c => c.suite))]
  return suiteNames.map(suite => {
    const cases = allCases.filter(c => c.suite === suite)
    const t0 = performance.now()
    return {
      suite,
      pass: cases.filter(c => c.verdict === 'PASS').length,
      fail: cases.filter(c => c.verdict === 'FAIL').length,
      warn: cases.filter(c => c.verdict === 'WARN').length,
      skip: cases.filter(c => c.verdict === 'SKIP').length,
      total: cases.length,
      criticalFails: cases.filter(c => c.verdict === 'FAIL' && c.severity === 'CRITICAL').length,
      durationMs: cases.reduce((a, c) => a + c.durationMs, 0),
      cases,
    }
  })
}

// ── Scoring ────────────────────────────────────────────────────────────────

function computeScore(suites: SuiteResult[]): number {
  // Weighted: latency (30%), accuracy (25%), edge (20%), memory (15%), failure (10%)
  const weights: Record<string, number> = {
    latency:  0.30,
    accuracy: 0.25,
    edge:     0.20,
    memory:   0.15,
    failure:  0.10,
  }

  let totalWeight = 0
  let weightedScore = 0

  for (const suite of suites) {
    const w = weights[suite.suite] ?? 0.10
    const passRate = suite.total > 0 ? suite.pass / suite.total : 0
    const criticalPenalty = suite.criticalFails * 0.15
    const score = Math.max(0, passRate - criticalPenalty)
    weightedScore += score * w
    totalWeight += w
  }

  return totalWeight > 0 ? Math.round((weightedScore / totalWeight) * 100) : 0
}

// ── Scorecard printer ──────────────────────────────────────────────────────

function printScorecard(report: RunReport): void {
  const sep = '═'.repeat(70)
  console.log(`\n${sep}`)
  console.log('  ARIA ADVERSARIAL TEST SCORECARD')
  console.log(sep)

  for (const suite of report.suites) {
    const pct = Math.round((suite.pass / suite.total) * 100)
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
    const icon = suite.criticalFails > 0 ? '🔴' : suite.fail === 0 ? '✅' : pct >= 75 ? '🟡' : '❌'
    console.log(
      `  ${icon} ${suite.suite.padEnd(14)} ${bar} ${pct}%` +
      `  (${suite.pass}/${suite.total}` +
      `${suite.warn ? ` ⚠${suite.warn}` : ''}` +
      `${suite.criticalFails ? ` 🔴${suite.criticalFails}crit` : ''})` +
      `  ${Math.round(suite.durationMs)}ms`
    )
  }

  console.log(`${'─'.repeat(70)}`)
  console.log(`  OVERALL SCORE  : ${report.overallScore}%`)
  console.log(`  LATENCY  P50   : ${Math.round(report.latencyP50)}ms`)
  console.log(`  LATENCY  P90   : ${Math.round(report.latencyP90)}ms`)
  console.log(`  LATENCY  P99   : ${Math.round(report.latencyP99)}ms`)
  console.log(`  TOTAL TIME     : ${Math.round(report.meta.totalDurationMs)}ms`)

  if (report.redFlags.length) {
    console.log(`\n${'─'.repeat(70)}`)
    console.log('  🚨 RED FLAGS (CRITICAL FAILURES):')
    for (const flag of report.redFlags) {
      console.log(`    • ${flag}`)
    }
  }

  const goNoGo = report.meta.goNoGo
  console.log(`\n${'─'.repeat(70)}`)
  console.log(`  DEPLOYMENT VERDICT: ${goNoGo ? '✅ GO' : '🔴 NO-GO'}`)
  if (!goNoGo) {
    console.log(`  Fix all CRITICAL failures and achieve ≥80% overall before deploying.`)
  }
  console.log(sep)
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const suiteArg   = process.argv.find(a => a.startsWith('--suite='))?.split('=')[1]  ?? 'all'
  const reportArg  = process.argv.find(a => a.startsWith('--report='))?.split('=')[1] ?? 'console'
  const globalT0   = performance.now()

  console.log(`\nARIA ADVERSARIAL TEST SUITE`)
  console.log(`Running: ${suiteArg}   Output: ${reportArg}`)
  console.log(`Host: ${os.cpus()[0].model}   Node: ${process.version}`)
  console.log('═'.repeat(70))

  // Import and run suites
  const suiteMap: Record<string, () => Promise<void>> = {
    latency:     () => import('./suites/latency.js').then(m => m.run()),
    accuracy:    () => import('./suites/accuracy.js').then(m => m.run()),
    edge:        () => import('./suites/edge.js').then(m => m.run()),
    memory:      () => import('./suites/memory.js').then(m => m.run()),
    streaming:   () => import('./suites/streaming.js').then(m => m.run()),
    failure:     () => import('./suites/failure.js').then(m => m.run()),
    scenarios:   () => import('./suites/scenarios.js').then(m => m.run()),
    adversarial: () => import('./suites/adversarial.js').then(m => m.run()),
  }

  const toRun = suiteArg === 'all' ? Object.keys(suiteMap) : [suiteArg]
  for (const s of toRun) {
    if (suiteMap[s]) await suiteMap[s]()
    else console.warn(`Unknown suite: ${s}`)
  }

  const totalMs = performance.now() - globalT0
  const suites  = aggregateSuites()

  // Collect latency metrics from latency suite cases
  const latencyMs = allCases
    .filter(c => c.suite === 'latency' && c.metrics?.totalToAudio)
    .map(c => c.metrics!.totalToAudio)
    .sort((a, b) => a - b)

  const report: RunReport = {
    meta: {
      version: '4.0.0',
      ts: new Date().toISOString(),
      host: os.cpus()[0].model,
      nodeVersion: process.version,
      totalDurationMs: totalMs,
      goNoGo: (
        redFlags.length === 0 &&
        computeScore(suites) >= 80 &&
        percentile(latencyMs, 90) < 300
      ),
    },
    suites,
    latencyP50: percentile(latencyMs, 50),
    latencyP90: percentile(latencyMs, 90),
    latencyP99: percentile(latencyMs, 99),
    overallScore: computeScore(suites),
    redFlags,
  }

  printScorecard(report)

  if (reportArg === 'json') {
    const outPath = path.join(process.cwd(), `aria_test_report_${Date.now()}.json`)
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
    console.log(`\nReport saved → ${outPath}`)
  }

  process.exit(report.meta.goNoGo ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })

export { allCases, redFlags }