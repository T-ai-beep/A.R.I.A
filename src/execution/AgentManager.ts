/**
 * AgentManager — single-step execution utilities.
 *
 * After the Planner/Coordinator refactor this module no longer owns
 * plan generation or multi-step orchestration. Its sole job is
 * deterministic, retriable execution of ONE tool step.
 *
 * Exports used by ExecutionAgent and Coordinator:
 *   selectTool(step)        — map step text → tool name
 *   buildToolInput(...)     — build typed tool input from step context
 *   runStep(...)            — execute one tool with retry + timing
 *   isWeakResult(output)    — decide if output is usable downstream
 */

import { Tool } from '../agents/types.js'
import { getToolRegistry } from './tools/index.js'

// ── Tool selection ─────────────────────────────────────────────────────────

export function selectTool(step: string): string {
  const s = step.toLowerCase()
  if (/\b(search for|find|look up|google|web search|research|browse)\b/.test(s))  return 'browser.search'
  if (/\b(scrape|extract from|fetch content|read page|get content|parse)\b/.test(s)) return 'browser.scrape'
  if (/\b(email|send email|mail|outreach|message|contact via email)\b/.test(s))    return 'email.send'
  if (/\b(calendar|schedule|book|appointment|meeting invite)\b/.test(s))           return 'calendar.schedule'
  if (/\b(save|write to file|store|export|create file|output)\b/.test(s))          return 'file.write'
  if (/\b(api|http request|call endpoint|fetch data|post to|get from)\b/.test(s))  return 'api.call'
  return 'browser.search'
}

// ── Tool input builder ─────────────────────────────────────────────────────

/**
 * Build typed input for a tool from the step description and prior outputs.
 * previousOutputs — ordered results of already-completed plan nodes.
 */
export function buildToolInput(
  step:            string,
  toolName:        string,
  previousOutputs: unknown[],
  goal:            string
): unknown {
  const lastOutput = previousOutputs[previousOutputs.length - 1] ?? null

  switch (toolName) {
    case 'browser.search':
      return {
        query: step
          .replace(/^(search for:?|find|look up|research)\s*/i, '')
          .trim() || goal,
      }

    case 'browser.scrape': {
      const sr  = lastOutput as { results?: Array<{ url?: string }> } | null
      const url = sr?.results?.[0]?.url ?? null
      return url ? { url } : { content: String(lastOutput ?? step) }
    }

    case 'email.send': {
      const body = lastOutput
        ? JSON.stringify(lastOutput, null, 2).slice(0, 2000)
        : `No prior results available.\n\nGoal: ${goal}`
      return {
        to:      process.env.AXON_EMAIL_TO ?? 'user@example.com',
        subject: `AXON Report: ${goal.slice(0, 60)}`,
        body:    `AXON Execution Report\n${'─'.repeat(40)}\nGoal: ${goal}\n\n${body}`,
      }
    }

    case 'calendar.schedule':
      return {
        title:    step.replace(/^(schedule|book|calendar):?\s*/i, '').trim() || goal,
        date:     'tomorrow',
        duration: 60,
        notes:    String(lastOutput ?? ''),
      }

    case 'file.write': {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      return {
        filename: `axon_${timestamp}.txt`,
        content: [
          `AXON Execution Output`,
          `Generated: ${new Date().toISOString()}`,
          `Goal: ${goal}`,
          ``,
          typeof lastOutput === 'object'
            ? JSON.stringify(lastOutput, null, 2)
            : String(lastOutput ?? step),
        ].join('\n'),
      }
    }

    case 'api.call':
      return {
        url:    String(lastOutput ?? 'https://api.example.com'),
        method: 'GET',
      }

    default:
      return { query: step }
  }
}

// ── Weak result detection ──────────────────────────────────────────────────

export function isWeakResult(output: unknown, success: boolean): boolean {
  if (!success || output === null || output === undefined) return true
  if (typeof output === 'string' && output.trim().length < 10)  return true
  if (typeof output === 'object' && output !== null) {
    const o = output as Record<string, unknown>
    if (Array.isArray(o['results']) && (o['results'] as unknown[]).length === 0) return true
    if (typeof o['wordCount'] === 'number' && o['wordCount'] < 20)               return true
  }
  return false
}

// ── Single-step execution with retry ──────────────────────────────────────

const MAX_RETRIES    = 2
const RETRY_BASE_MS  = 500

export interface StepRunResult {
  output:    unknown
  success:   boolean
  error?:    string
  durationMs: number
}

/**
 * Execute one tool by name with up to MAX_RETRIES retries.
 * Never throws — all errors are captured in the return value.
 */
export async function runStep(
  toolName: string,
  input:    unknown,
  label:    string     // for logging
): Promise<StepRunResult> {
  const tools: Map<string, Tool> = getToolRegistry()
  const tool  = tools.get(toolName)
  const t0    = Date.now()

  if (!tool) {
    console.warn(`[AGENT_MGR] tool not registered: ${toolName}`)
    return { output: null, success: false, error: `tool not registered: ${toolName}`, durationMs: 0 }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const output = await tool.execute(input)
      console.log(`[AGENT_MGR] ✓ ${label} [${toolName}] (${Date.now() - t0}ms)`)
      return { output, success: true, durationMs: Date.now() - t0 }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt)
        console.warn(`[AGENT_MGR] retry ${attempt + 1}/${MAX_RETRIES} [${toolName}] in ${delay}ms — ${err}`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        console.warn(`[AGENT_MGR] ✗ ${label} [${toolName}] failed after ${MAX_RETRIES + 1} attempts: ${err}`)
        return { output: null, success: false, error: String(err), durationMs: Date.now() - t0 }
      }
    }
  }

  return { output: null, success: false, error: 'unreachable', durationMs: Date.now() - t0 }
}

// ── Compatibility stub ─────────────────────────────────────────────────────
// The old multi-step SubAgent store was removed in the Planner/Coordinator
// refactor. This stub keeps existing code that imports getAllAgents compiling.

import { SubAgent } from '../agents/types.js'
export function getAllAgents(): SubAgent[] { return [] }
