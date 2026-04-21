/**
 * AXONCore — central router for the AXON agent system.
 *
 * Flow:
 *   Input (transcript | command | system_trigger | agent_feedback)
 *     → maybeCreateGoal()    — detects long-term intent, persists a Goal record
 *     → classifyIntent()     — conversation | task_creation | execution_request | research_query
 *     → route to agent       — ExecutionAgent | ResearchAgent | TaskAgent | ConversationAgent
 *     → onAgentResult()      — episodic storage + goal progress + follow-on TaskAgent
 */

import { Input, InputType, Agent, AgentResult, StepResult } from './types.js'
import { storeEpisode } from '../pipeline/epsodic.js'

// ── Agent chain (lazy-loaded to prevent circular deps) ───────────────────────

let _agents: Agent[] | null = null

async function getAgentChain(): Promise<Agent[]> {
  if (_agents) return _agents
  const [
    { ConversationAgent },
    { TaskAgent },
    { ExecutionAgent },
    { ResearchAgent },
  ] = await Promise.all([
    import('./ConversationAgent.js'),
    import('./TaskAgent.js'),
    import('./ExecutionAgent.js'),
    import('./ResearchAgent.js'),
  ])
  _agents = [
    new ExecutionAgent(),
    new ResearchAgent(),
    new TaskAgent(),
    new ConversationAgent(),   // catch-all
  ]
  return _agents
}

// ── Intent classification ────────────────────────────────────────────────────

const RE_EXEC_CHAIN  = /\b(find|search|research).{0,60}(email|send|contact|schedule|post)\b/i
const RE_EXEC_AND    = /\band\s+(email|send|contact|message|post|submit|schedule)\b/i
const RE_TASK        = /\b(remind me|add task|todo|follow up|don't forget|set reminder)\b/i
const RE_TASK_DATE   = /\b(by|before|on)\s+(friday|monday|tomorrow|today|next week|end of week)\b.*\b(call|email|send|submit|review)\b/i
const RE_RESEARCH    = /\b(what is|who is|tell me about|explain|summarize|overview of|background on|research|look up|find out about)\b/i
const RE_EXEC_SINGLE = /\b(find leads?|scrape|send email|search for|book a|schedule a|post to|call the api|fetch data)\b/i

export function classifyIntent(raw: string): InputType {
  if (RE_EXEC_CHAIN.test(raw) || RE_EXEC_AND.test(raw)) return 'execution_request'
  if (RE_TASK.test(raw) || RE_TASK_DATE.test(raw))       return 'task_creation'
  if (RE_RESEARCH.test(raw))                             return 'research_query'
  if (RE_EXEC_SINGLE.test(raw))                          return 'execution_request'
  return 'conversation'
}

// ── Goal creation trigger ────────────────────────────────────────────────────
// Detects long-form intent from human input and persists a Goal automatically.
// Only fires on human-sourced input — not on system triggers or agent feedback.

const RE_GOAL_CREATE = /\b(i want to|we should|our goal is|the goal is|i'm trying to|we need to build|let's build|i'm going to|we're going to)\b/i

async function maybeCreateGoal(input: Input): Promise<void> {
  if (input.source === 'system_trigger' || input.source === 'agent_feedback') return
  if (!RE_GOAL_CREATE.test(input.raw)) return

  try {
    const { createGoal } = await import('../autonomy/goals.js')
    createGoal(
      input.raw.slice(0, 200),
      'medium'
    )
  } catch (err) {
    console.error('[AXON] maybeCreateGoal failed:', err)
  }
}

// ── Feedback handlers ────────────────────────────────────────────────────────

type FeedbackHandler = (result: AgentResult) => void
const feedbackHandlers: FeedbackHandler[] = []

export function onAXONFeedback(handler: FeedbackHandler): void {
  feedbackHandlers.push(handler)
}

async function onAgentResult(result: AgentResult, input: Input): Promise<void> {
  // 1. Episodic memory
  if (result.success && result.output) {
    storeEpisode(
      `[AXON/${input.type}] "${input.raw.slice(0, 200)}" → ${result.output.slice(0, 200)}`,
      null
    ).catch(console.error)
  }

  // 2. Subscriber callbacks
  for (const h of feedbackHandlers) {
    try { h(result) } catch {}
  }

  if (result.agentId !== 'execution') return

  // 3. Goal progress update
  const goalId = input.metadata?.goalId as string | undefined
  if (goalId && result.success) {
    try {
      const { recordGoalActivity, getGoal } = await import('../autonomy/goals.js')
      const goal = getGoal(goalId)
      if (goal) {
        const steps       = ((result.data as { steps?: StepResult[] })?.steps ?? []) as StepResult[]
        const succeeded   = steps.filter(s => s.success).length
        const total       = steps.length
        const increment   = total > 0 ? (succeeded / total) * 0.5 : 0.2
        const lastStep    = steps.filter(s => s.success).pop()?.step
                         ?? result.output
                         ?? 'execution cycle'
        const agentId     = (result.data as { subAgentId?: string })?.subAgentId
        recordGoalActivity(goalId, lastStep, increment, agentId)
      }
    } catch (err) {
      console.error('[AXON] goal progress update failed:', err)
    }
  }

  // 4. TaskAgent follow-on (async, non-blocking)
  if (result.success && result.data) {
    try {
      const { TaskAgent } = await import('./TaskAgent.js')
      const taskAgent = new TaskAgent()
      const followOn: Input = {
        raw:    `execution completed: ${result.output ?? ''}`,
        type:   'task_creation',
        source: 'agent_feedback',
        ts:     Date.now(),
        metadata: { executionResult: result.data, originalGoal: input.raw },
      }
      if (taskAgent.canHandle(followOn)) {
        taskAgent.execute(followOn).catch(console.error)
      }
    } catch (err) {
      console.error('[AXON] follow-on task creation failed:', err)
    }
  }
}

// ── Main router ──────────────────────────────────────────────────────────────

export async function axonRoute(input: Input): Promise<AgentResult> {
  const type       = input.type ?? classifyIntent(input.raw)
  const typedInput = { ...input, type }

  console.log(`[AXON] route type=${type} source=${input.source} "${input.raw.slice(0, 80)}"`)

  // Side-effect: persist goal if human expressed long-term intent
  maybeCreateGoal(typedInput).catch(console.error)

  const agents = await getAgentChain()
  let result: AgentResult | null = null

  for (const agent of agents) {
    if (agent.canHandle(typedInput)) {
      result = await agent.execute(typedInput)
      break
    }
  }

  if (!result) {
    result = {
      agentId:   'axon',
      success:   false,
      output:    null,
      error:     'no agent could handle input',
      durationMs: 0,
    }
  }

  onAgentResult(result, typedInput).catch(console.error)
  return result
}

// ── Input factory ─────────────────────────────────────────────────────────────

export function makeInput(
  raw:      string,
  source:   Input['source']  = 'transcript',
  type?:    InputType,
  metadata?: Record<string, unknown>
): Input {
  return { raw, source, ts: Date.now(), type, metadata }
}
