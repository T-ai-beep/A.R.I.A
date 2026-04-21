import { Tool } from '../../agents/types.js'
import { BrowserSearchTool, BrowserScrapeTool } from './browser.js'
import { EmailSendTool } from './email.js'
import { CalendarScheduleTool } from './calendar.js'
import { FileWriteTool } from './file.js'
import { ApiCallTool } from './api.js'

const TOOLS: Tool[] = [
  new BrowserSearchTool(),
  new BrowserScrapeTool(),
  new EmailSendTool(),
  new CalendarScheduleTool(),
  new FileWriteTool(),
  new ApiCallTool(),
]

let _registry: Map<string, Tool> | null = null

export function getToolRegistry(): Map<string, Tool> {
  if (!_registry) {
    _registry = new Map(TOOLS.map(t => [t.name, t]))
  }
  return _registry
}

export function getTool(name: string): Tool | undefined {
  return getToolRegistry().get(name)
}

export function listTools(): string[] {
  return TOOLS.map(t => t.name)
}
