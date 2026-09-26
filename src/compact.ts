import type { ChatMessage, ModelAdapter } from './type.js'
import { computeContextStats, estimateMessagesTokens, markUsagesStale } from './utils/token-estimator.js'
import { MODEL } from './config.js'

/**
 * 上下文压缩两层（B1 后）：
 *  - microcompact：利用率过半时，旧 tool_result 内容就地清成 [cleared] 占位（便宜、无损事实——盘上仍是全量）
 *  - autocompact：≥85% effectiveInput 时，中段 summarize 成 context_summary；压缩后旧 usage 锚点整批标脏
 * 触发计数用 token-estimator 的"锚点+增量"，不再依赖纯字符估算。
 */

export const COMPACT_CONFIG = {
  triggerUtilization: 0.85,
  microcompactUtilization: 0.5,
  keepRecentMessages: 10,
  minMiddleMessages: 6,
  microkeepRecent: 8,
  microMinChars: 200,
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

export function estimateTokens(messages: ChatMessage[]): number {
  return estimateMessagesTokens(messages)
}

/** 便宜层：只清旧的大块 tool_result 内容，消息骨架与盘上事实不动 */
export function microcompactToolResults(
  messages: ChatMessage[],
  keepRecent = COMPACT_CONFIG.microkeepRecent,
  minChars = COMPACT_CONFIG.microMinChars,
): number {
  let cleared = 0
  const keepFrom = Math.max(0, messages.length - keepRecent)
  for (let i = 0; i < keepFrom; i++) {
    const message = messages[i]
    if (message.role === 'tool_result' && !message.isError && message.content.length > minChars) {
      message.content = '[cleared]'
      cleared += 1
    }
  }
  return cleared
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
  force?: boolean
  config?: Partial<typeof COMPACT_CONFIG>
}): Promise<CompactOutcome> {
  const config = { ...COMPACT_CONFIG, ...input.config }
  const messages = input.messages

  //便宜层先行：过半就清旧大块 tool_result（只改内存投影，盘上全量事实不动）
  let cleared = 0
  let stats = computeContextStats(messages, MODEL)
  if (stats.utilization >= config.microcompactUtilization) {
    cleared = microcompactToolResults(messages)
    if (cleared > 0) {
      stats = computeContextStats(messages, MODEL)
    }
  }

  const before = stats.totalTokens
  const untouched: CompactOutcome = {
    compacted: false,
    messages,
    removedCount: cleared,
    tokensBefore: before,
    tokensAfter: before,
  }

  if (!input.force && stats.utilization < config.triggerUtilization) {
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
    const nextMessages = markUsagesStale([
      ...messages.slice(0, headEnd),
      summary,
      ...messages.slice(tailStart),
    ])
    return {
      compacted: true,
      messages: nextMessages,
      removedCount: middle.length + cleared,
      tokensBefore: before,
      tokensAfter: estimateTokens(nextMessages),
    }
  } catch {
    return untouched
  }
}
