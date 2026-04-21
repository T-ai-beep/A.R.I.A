// ── ToolGuard — runtime enforcement of tool call isolation ────────────────────
//
// All tool.execute() calls MUST happen inside Coordinator → ExecutionAgent.executeNode().
// ExecutionAgent sets the active node before calling a tool and clears it after.
// Every tool calls assertInNodeContext() as its first statement.

let _activeNodeId: string | null = null

export function setActiveNode(nodeId: string | null): void {
  _activeNodeId = nodeId
}

export function getActiveNode(): string | null {
  return _activeNodeId
}

export function assertInNodeContext(toolName: string): void {
  if (_activeNodeId === null) {
    throw new Error(
      `[TOOL_GUARD] "${toolName}" called outside Coordinator node execution. ` +
      `Tools must only be called via Coordinator → ExecutionAgent.executeNode().`
    )
  }
}
