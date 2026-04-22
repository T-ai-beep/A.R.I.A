import type { Agent, AgentResult, Input } from './types.js'
import { extractTaskFromTranscript, addTask } from '../pipeline/tasks.js'
import { detectFollowUp, createFollowUp }     from '../pipeline/followup.js'
import { createPressureItem }                  from '../pipeline/pressure.js'
import { getPeopleContext }                    from '../pipeline/people.js'

const TASK_PATTERNS =
  /\b(remind(er)?|follow[\s-]?up|add task|create task|track|schedule|set a|don't forget|make sure to|i need to|note to self)\b/i

export class TaskAgent implements Agent {
  readonly id = 'task'

  canHandle(input: Input): boolean {
    return TASK_PATTERNS.test(input.text)
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0      = Date.now()
    const results: string[] = []

    // 1. Task extraction
    const taskData = extractTaskFromTranscript(input.text)
    if (taskData) {
      const task = addTask(taskData)
      createPressureItem(
        task.id,
        'task',
        task.description,
        task.person,
        task.priority,
        (task.resurfaceAt ?? Date.now() + 3_600_000) - Date.now()
      )
      results.push(`Task: "${task.description}"`)
      console.log(`[TASK_AGENT] created task — "${task.description}"`)
    }

    // 2. Follow-up detection (async — draft generation is non-blocking)
    const fuDetected = detectFollowUp(input.text)
    if (fuDetected) {
      const pCtx = getPeopleContext(input.text)
      createFollowUp(input.text, fuDetected, pCtx ?? undefined)
        .then(fu => {
          createPressureItem(
            fu.id,
            'followup',
            fu.suggestedAction,
            fu.person,
            fu.priority,
            fuDetected.delayHours * 3_600_000
          )
        })
        .catch(console.error)

      results.push(`Follow-up: "${fuDetected.action}"`)
      console.log(`[TASK_AGENT] follow-up detected — "${fuDetected.action}"`)
    }

    return {
      agentId:    this.id,
      inputId:    input.id,
      success:    true,
      output:     results.length > 0 ? results.join(' | ') : undefined,
      data:       { taskCreated: !!taskData, followUpDetected: !!fuDetected },
      durationMs: Date.now() - t0,
    }
  }
}
