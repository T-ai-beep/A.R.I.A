/**
 * TaskAgent — creates and tracks tasks, follow-ups, and pressure items.
 *
 * Integrates: tasks.ts · followup.ts · pressure.ts
 *
 * Outputs structured TaskRecord objects stored to ~/.aria/tasks.jsonl
 * and follow-ups to ~/.aria/followups.jsonl.
 */

import { Agent, AgentResult, Input, TaskRecord } from './types.js'
import { extractTaskFromTranscript, addTask, Task } from '../pipeline/tasks.js'
import { detectFollowUp, createFollowUp } from '../pipeline/followup.js'
import { createPressureItem } from '../pipeline/pressure.js'

export class TaskAgent implements Agent {
  readonly id = 'task'

  canHandle(input: Input): boolean {
    return input.type === 'task_creation'
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()
    try {
      const created: TaskRecord[] = []

      if (input.source === 'agent_feedback' && input.metadata?.originalGoal) {
        // Execution follow-on: create a tracking task for the completed work
        const task = addTask({
          description: `Review and follow up: ${String(input.metadata.originalGoal).slice(0, 100)}`,
          person: null,
          context: input.raw,
          dueHint: 'tomorrow',
          resurfaceAt: Date.now() + 24 * 3_600_000,
          priority: 'medium',
        })
        createPressureItem(task.id, 'task', task.description, null, task.priority, 24 * 3_600_000)
        created.push(toRecord(task))
      } else {
        // NLP extraction from raw input
        const extracted = extractTaskFromTranscript(input.raw)
        if (extracted) {
          const task = addTask(extracted)
          createPressureItem(
            task.id, 'task', task.description, task.person, task.priority,
            (task.resurfaceAt ?? Date.now() + 3_600_000) - Date.now()
          )
          created.push(toRecord(task))
        }

        // Follow-up detection runs in parallel with task extraction
        const fuSignal = detectFollowUp(input.raw)
        if (fuSignal) {
          const fu = await createFollowUp(input.raw, fuSignal)
          createPressureItem(
            fu.id, 'followup', fu.suggestedAction,
            fu.person, fu.priority, fuSignal.delayHours * 3_600_000
          )
        }
      }

      return {
        agentId: this.id,
        success: true,
        output: created.length > 0
          ? `Created ${created.length} task(s): ${created.map(t => t.description).join('; ')}`
          : 'No actionable tasks found',
        data: created,
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      return {
        agentId: this.id,
        success: false,
        output: null,
        error: String(err),
        durationMs: Date.now() - t0,
      }
    }
  }
}

function toRecord(task: Task): TaskRecord {
  return {
    id: task.id,
    description: task.description,
    priority: task.priority === 'high' ? 'high'
            : task.priority === 'low'  ? 'low'
            : 'medium',
    dueDate: task.resurfaceAt ?? undefined,
    status: 'pending',
    createdAt: task.created,
  }
}
