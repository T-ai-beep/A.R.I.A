/**
 * ConversationAgent — wraps the existing decide() pipeline.
 *
 * Constraints:
 *   - <300ms latency (enforced by decide() internal budget)
 *   - NO task execution, NO long-running logic
 *   - Handles all transcript-sourced input as fallback
 */

import { Agent, AgentResult, Input } from './types.js'
import { decide } from '../pipeline/decision.js'

export class ConversationAgent implements Agent {
  readonly id = 'conversation'

  canHandle(input: Input): boolean {
    // Handles any conversation-typed input, and is the catch-all for transcripts
    return input.type === 'conversation' || input.source === 'transcript'
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()
    try {
      const response = await decide(input.raw)
      return {
        agentId: this.id,
        success: true,
        output: response,
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
