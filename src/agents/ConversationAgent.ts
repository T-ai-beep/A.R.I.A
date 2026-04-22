import type { Agent, AgentResult, Input } from './types.js'
import { decide } from '../pipeline/decision.js'
import { CONFIG } from '../config.js'

export class ConversationAgent implements Agent {
  readonly id = 'conversation'

  canHandle(input: Input): boolean {
    return input.source === 'transcript' && input.speaker !== 'self'
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()
    let result: string | null = null

    try {
      // Race decide() against the latency budget
      result = await Promise.race([
        decide(input.text),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('latency budget exceeded')), CONFIG.LATENCY_BUDGET_MS)
        ),
      ])
    } catch (e) {
      // Timeout — silence is a valid decision
      console.warn(`[CONVERSATION] ${e instanceof Error ? e.message : e}`)
      return {
        agentId:    this.id,
        inputId:    input.id,
        success:    true,
        output:     undefined,
        durationMs: Date.now() - t0,
      }
    }

    // IMPORTANT: decide() already called speak() internally.
    // output is returned for logging/history only — index.ts must NOT re-speak it.
    return {
      agentId:    this.id,
      inputId:    input.id,
      success:    true,
      output:     result ?? undefined,
      durationMs: Date.now() - t0,
    }
  }
}
