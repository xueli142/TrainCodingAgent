import type { ChatMessage } from '../type.js'
import type { ToolDefinition } from '../tool.js'
import { standardTools } from './tool/index.js'

/**
 * tools设计原则：精选原子化的11个标准工具（opencode同名集）。
 *
 * 渐进式披露状态机：
 *  - 初始化：role:'tool' 目录消息进 messages，只含 name+一句话总结（buildToolCatalogMessage）
 *  - 调用：完整 input_schema 走 API tools 参数（getToolSchemas），供 provider 约束结构化输出
 *  - 正文：skill/task 等大内容工具被调用后才进入 tool_result
 */

const registry = new Map<string, ToolDefinition<any>>()

const NOT_WIRED_TOOLS = new Set(['task', 'question'])

function firstLine(description: string): string {
  return description.split('\n')[0].replace(/^[-\s]+/, '').trim()
}

export function initRegistry(): void {
  registry.clear()
  for (const tool of standardTools) {
    registerTool(tool)
  }
}

export function registerTool<T>(tool: ToolDefinition<T>): void {
  registry.set(tool.name, tool)
}

export function getTool(name: string): ToolDefinition<any> | undefined {
  return registry.get(name)
}

export function getAllTool(): ToolDefinition<any>[] {
  return Array.from(registry.values())
}

export function getToolSchemas(): Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> {
  return getAllTool().map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

export function getToolSummaries(): Array<{ name: string; summary: string }> {
  return getAllTool().map(tool => ({
    name: tool.name,
    summary: firstLine(tool.description),
  }))
}

export function buildToolCatalogMessage(): ChatMessage {
  const lines = getToolSummaries().map(entry => `- ${entry.name}: ${entry.summary}`)

  const wiring = getAllTool()
    .filter(tool => NOT_WIRED_TOOLS.has(tool.name))
    .map(tool => tool.name)

  const content = [
    '<tool_registry>',
    [
      'You have the tools listed below. The full parameter schemas arrive in the structured',
      'tools section of this request; invoke a tool by emitting a tool_use block with its',
      'exact name and a JSON input matching that schema.',
    ].join(' '),
    lines.join('\n'),
    'Usage basics:',
    '- Read a file with the read tool before modifying it with edit or write.',
    '- For file search prefer glob/grep; use bash only for terminal operations.',
    '- Keep exactly one todowrite item in_progress at a time.',
    ...(wiring.length > 0
      ? [
          `- ${wiring.join(' and ')} may report "not wired" if the host has no handler registered; ask in plain text instead.`,
        ]
      : []),
    '</tool_registry>',
  ].join('\n')

  return { role: 'tool', content }
}

initRegistry()
