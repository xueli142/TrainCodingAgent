import {MODEL,API_KEY,BASE_URL} from "./config.js"

import type {
  AgentStep,
  ChatMessage,
  ModelAdapter,
  ProviderThinkingBlock,
  ProviderUsage,
  StepDiagnostics,
  ToolCall,
} from './type.js'
import { traceRequest } from './context-tracer.js'


type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function isTextBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'text'
}> {
  return block.type === 'text' && typeof block.text === 'string'
}

function isToolUseBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'tool_use'
}> {
  return (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string'
  )
}

function isThinkingBlock(block: AnthropicContentBlock): block is ProviderThinkingBlock {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

function parseAssistantText(content: string): {
  content: string
  kind?: 'final' | 'progress'
} {
  const trimmed = content.trim()
  if (!trimmed) {
    return { content: '' }
  }

  const markers: Array<{
    prefix: string
    kind: 'final' | 'progress'
  }> = [
    { prefix: '<final>', kind: 'final' },
    { prefix: '[FINAL]', kind: 'final' },
    { prefix: '<progress>', kind: 'progress' },
    { prefix: '[PROGRESS]', kind: 'progress' },
  ]

  for (const marker of markers) {
    if (trimmed.startsWith(marker.prefix)) {
      const rawContent = trimmed.slice(marker.prefix.length).trim()
      const closingTag =
        marker.kind === 'progress'
          ? /<\/progress>/gi
          : /<\/final>/gi
      return {
        content: rawContent.replace(closingTag, '').trim(),
        kind: marker.kind,
      }
    }
  }

  return { content: trimmed }
}

function toTextBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text }
}

function normalizeAnthropicUsage(usage: AnthropicUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const outputTokens = usage.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'anthropic',
  }
}

function toAssistantText(message: Extract<ChatMessage, {
  role: 'assistant' | 'assistant_progress'
}>): string {
  if (message.role === 'assistant_progress') {
    return `<progress>\n${message.content}\n</progress>`
  }
  return message.content
}

function pushAnthropicMessage(
  messages: AnthropicMessage[],
  role: 'user' | 'assistant',
  block: AnthropicContentBlock,
): void {
  const last = messages.at(-1)
  if (last?.role === role) {
    last.content.push(block)
    return
  }
  messages.push({ role, content: [block] })
}

export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const system = messages
    .filter(message => message.role === 'system' || message.role === 'tool')
    .map(message => message.content)
    .join('\n\n')

  const converted: AnthropicMessage[] = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue

    if (message.role === 'user') {
      pushAnthropicMessage(converted, 'user', toTextBlock(message.content))
      continue
    }

    if (message.role === 'assistant_thinking') {
      for (const block of message.blocks) {
        pushAnthropicMessage(converted, 'assistant', block)
      }
      continue
    }

    if (message.role === 'assistant' || message.role === 'assistant_progress') {
      pushAnthropicMessage(converted, 'assistant', toTextBlock(toAssistantText(message)))
      continue
    }

    if (message.role === 'assistant_tool_call') {
      pushAnthropicMessage(converted, 'assistant', {
        type: 'tool_use',
        id: message.toolUseId,
        name: message.toolName,
        input: message.input,
      })
      continue
    }

    if (message.role === 'context_summary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        `[Context Summary from earlier conversation]\n${message.content}`,
      ))
      continue
    }

    if (message.role === 'snip_boundary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        `[Boundary between conversation segments]\n${message.content}`,
      ))
      continue
    }

    pushAnthropicMessage(converted, 'user', {
      type: 'tool_result',
      tool_use_id: message.toolUseId,
      content: message.content,
      is_error: message.isError,
    })
  }

  return { system, messages: converted }
}

export class AnthropicModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }>,
  ) {}

//next 是最小的对话单位，调用llm的原子化操作
  async next(messages: ChatMessage[]): Promise<AgentStep> {
    const payload = toAnthropicMessages(messages)
    //return 返回一个轨迹记录
    traceRequest({
      model: MODEL,
      system: payload.system,
      messages: payload.messages,
      tools: this.tools,
    })
    const url = `${BASE_URL.replace(/\/$/, '')}/v1/messages`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2026-06-01',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        system: payload.system,
        messages: payload.messages,
        tools: this.tools,
        max_tokens: 4096,
      }),
    })

    const data = (await readJsonBody(response)) as {
      stop_reason?: string
      content?: AnthropicContentBlock[]
      usage?: AnthropicUsage
      error?: { message?: string }
    }

    if (!response.ok) {
      throw new Error(extractErrorMessage(data, response.status))
    }

    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()

    for (const block of data.content ?? []) {
      blockTypes.push(block.type)

      if (isTextBlock(block)) {
        textParts.push(block.text)
        continue
      }

      if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          input: block.input,
        })
        continue
      }

      if (isThinkingBlock(block)) {
        thinkingBlocks.push(block)
        continue
      }

      ignoredBlockTypes.add(block.type)
    }

    const parsedText = parseAssistantText(textParts.join('\n').trim())
    const diagnostics: StepDiagnostics = {
      stopReason: data.stop_reason,
      blockTypes,
      ignoredBlockTypes: [...ignoredBlockTypes],
    }
    const usage = normalizeAnthropicUsage(data.usage)

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls' as const,
        calls: toolCalls,
        content: parsedText.content || undefined,
        contentKind:
          parsedText.kind === 'progress'
            ? ('progress' as const)
            : undefined,
        thinkingBlocks,
        diagnostics,
        usage,
      }
    }

    return {
      type: 'assistant' as const,
      content: parsedText.content,
      kind: parsedText.kind,
      thinkingBlocks,
      diagnostics,
      usage,
    }
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'string' && data.trim()) {
    return data.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'object' &&
    data.error !== null &&
    'message' in data.error &&
    typeof data.error.message === 'string' &&
    data.error.message.trim()
  ) {
    return data.error.message.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string' &&
    data.error.trim()
  ) {
    return data.error.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim()
  ) {
    return data.message.trim()
  }

  return `Model request failed: ${status}`
}
