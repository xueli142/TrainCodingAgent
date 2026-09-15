import type { ChatMessage, ModelAdapter } from './type.js'

/**
 * 简易上下文压缩（对齐 MiniCode 分层的最低一档 autocompact）：
 *  - 估算：Σ chars / 3.5
 *  - 触发：占上下文窗口 ≥ 85%
 *  - 动作：固定头部（system/tool）+ 尾部 KEEP_RECENT 保留，中间段渲染成 transcript 让小上下文 summarize
 *  - 产出：context_summary 消息（作为事件持久化；projectMessages 从最后一条 summary 截断起播）
 *  - 失败即放弃本轮压缩，绝不丢消息（盘上事实永远全量，投影截断只发生在 summary 已生成之后）
 */

export const COMPACT_CONFIG = {
  contextWindowTokens:256_000,
  triggerUtilization: 0.85,
  keepRecentMessages: 10,
  minMiddleMessages: 6,
}

const COMPRESSOR_SYSTEM = [
  '你是会话压缩器。下面是一段编码 agent 的对话记录。',
  '输出紧凑摘要，必须保留：任务目标与当前意图、关键决策及理由、改动/读过/跑过的文件与命令结论、',
  '用户明确给出的约束、尚未完成的待办与悬置问题。用中文，直接输出摘要正文，不要客套。',
].join(' ')

function messageText(message: ChatMessage): string {
  switch (message.role) {
    case 'system':
    case 'tool':
    case 'user':
    case 'assistant':
    case 'assistant_progress':
    case 'context_summary':
      return message.content
    case 'snip_boundary':
      return `[snip: 已剪裁 ${message.removedCount} 条]`
    case 'assistant_thinking':
      return ''
    case 'assistant_tool_call':
      return `> ${message.toolName} ${JSON.stringify(message.input).slice(0, 200)}`
    case 'tool_result':
      return message.content.slice(0, 1000)
    default:
      return ''
  }
}

function messageChars(message: ChatMessage): number {
  if (message.role === 'assistant_thinking') {
    return JSON.stringify(message.blocks).length
  }
  return messageText(message).length
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += messageChars(message) + 8
  }
  return Math.ceil(chars / 3.5)
}

function renderTranscript(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = messageText(message)
    if (!text.trim()) {
      continue
    }
    const speaker =
      message.role === 'tool_result'
        ? 'tool'
        : message.role === 'context_summary'
          ? 'summary'
          : message.role.startsWith('assistant')
            ? 'assistant'
            : message.role
    lines.push(`${speaker}: ${text}`)
  }
  return lines.join('\n\n')
}

export type CompactOutcome = {
  compacted: boolean
  messages: ChatMessage[]
  removedCount: number
  tokensBefore: number
  tokensAfter: number
}

export async function maybeCompactContext(input: {
  model: ModelAdapter
  messages: ChatMessage[]
  config?: Partial<typeof COMPACT_CONFIG>
}): Promise<CompactOutcome> {
  const config = { ...COMPACT_CONFIG, ...input.config }
  const messages = input.messages
  const before = estimateTokens(messages)
  const threshold = config.contextWindowTokens * config.triggerUtilization

  const untouched: CompactOutcome = {
    compacted: false,
    messages,
    removedCount: 0,
    tokensBefore: before,
    tokensAfter: before,
  }

  if (before < threshold) {
    return untouched
  }

  const headEnd = (() => {
    let i = 0
    while (i < messages.length && (messages[i]?.role === 'system' || messages[i]?.role === 'tool')) {
      i++
    }
    return i
  })()

  let tailStart = Math.max(headEnd, messages.length - config.keepRecentMessages)
  while (tailStart > headEnd && messages[tailStart]?.role === 'tool_result') {
    tailStart -= 1
  }

  const middle = messages.slice(headEnd, tailStart)
  if (middle.length < config.minMiddleMessages) {
    return untouched
  }

  try {
    const step = await input.model.next([
      { role: 'system', content: COMPRESSOR_SYSTEM },
      { role: 'user', content: renderTranscript(middle) },
    ])
    const summaryText = step.type === 'assistant' ? step.content.trim() : ''
    if (!summaryText) {
      return untouched
    }
    const summary: ChatMessage = {
      role: 'context_summary',
      content: summaryText,
      compressedCount: middle.length,
      timestamp: Date.now(),
    }
    const nextMessages = [
      ...messages.slice(0, headEnd),
      summary,
      ...messages.slice(tailStart),
    ]
    return {
      compacted: true,
      messages: nextMessages,
      removedCount: middle.length,
      tokensBefore: before,
      tokensAfter: estimateTokens(nextMessages),
    }
  } catch {
    return untouched
  }
}
