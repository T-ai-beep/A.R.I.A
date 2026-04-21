export type InputType = 'conversation' | 'task_creation' | 'execution_request' | 'research_query'
export type InputSource = 'transcript' | 'command' | 'system_trigger' | 'agent_feedback'

export interface Input {
  raw: string
  type?: InputType
  source: InputSource
  ts: number
  metadata?: Record<string, unknown>
}

export interface AgentResult {
  agentId: string
  success: boolean
  output: string | null
  data?: unknown
  error?: string
  durationMs: number
}

export interface Agent {
  id: string
  canHandle(input: Input): boolean
  execute(input: Input): Promise<AgentResult>
}

export interface PlanNode {
  id:          string
  description: string
  tool:        string
  status:      'pending' | 'running' | 'done' | 'failed'
  attempts:    number
  maxAttempts: number
  result?:     unknown
}

export interface Plan {
  id:        string
  goalId:    string
  nodes:     PlanNode[]
  edges:     { from: string; to: string }[]
  status:    'active' | 'blocked' | 'complete'
  createdAt: number
}

export interface SubAgent {
  id: string
  goal: string
  plan: string[]
  state: 'pending' | 'running' | 'completed' | 'failed'
  currentStep: number
  result?: unknown
  logs: string[]
  startedAt?: number
  completedAt?: number
  goalId?: string    // linked WorldState goal — enables lease management
}

export interface Tool {
  name: string
  execute(input: unknown): Promise<unknown>
}

export interface TaskRecord {
  id: string
  description: string
  priority: 'high' | 'medium' | 'low'
  dueDate?: number
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdAt: number
  source?: string
}

export interface StepResult {
  step: string
  tool: string
  input: unknown
  output: unknown
  success: boolean
  error?: string
  durationMs: number
}
