import type { ChatMessage, ProviderUsage } from '../type.js'

/**
 * token 感知（B1 ⭐，思路参考 MiniCode/claude-code 的"锚点+增量"，按 icefox 风格裁剪）：
 *  - provider 回来的 usage.inputTokens 是唯一精确真相，挂在其产生位置的 assistant 系消息上
 *  - 总量 = 最近一条新鲜 usage.inputTokens + 锚点之后消息的字符估算
 *  - 压缩/重排后必须把旧 usage 标脏（markUsagesStale），否则锚点悬空
 *  - 字符率分角色：代码/JSON 密（tool 2.0），自然语言疏（3.5）
 */

const CHARS_PER_TOKEN: Record<string, number> = {
  system: 3.5,
  tool: 3.5,
  user: 3.0,
  assistant: 3.5,
  assistant_progress: 3.5,
  assistant_thinking: 3.0,
  assistant_tool_call: 2.5,
  tool_result: 2.0,
  context_summary: 3.5,
  snip_boundary: 3.5,
}

export type ModelContextWindow = {
  contextWindow: number
  outputReserve: number
  effectiveInput: number
}

const MODEL_RULES: Array<{ patterns: string[]; contextWindow: number; outputReserve: number }> = [
  { patterns: ['claude'], contextWindow: 200_000, outputReserve: 16_000 },
  { patterns: ['deepseek-chat', 'deepseek-reasoner'], contextWindow: 128_000, outputReserve: 8_000 },
  { patterns: ['gpt-4.1'], contextWindow: 1_000_000, outputReserve: 16_000 },
  { patterns: ['gpt-4o', 'gpt-5'], contextWindow: 128_000, outputReserve: 16_000 },
  { patterns: ['gemini-2.5'], contextWindow: 1_048_576, outputReserve: 16_000 },
  { patterns: ['qwen'], contextWindow: 131_072, outputReserve: 8_000 },
]

const UNKNOWN_MODEL: ModelContextWindow = {
  contextWindow: 128_000,
  outputReserve: 8_000,
  effectiveInput: 120_000,
}

export function getModelContextWindow(model: string): ModelContextWindow {
  const normalized = model.trim().toLowerCase()
  for (const rule of MODEL_RULES) {
    if (rule.patterns.some(p => normalized.includes(p))) {
      return {
        contextWindow: rule.contextWindow,
        outputReserve: rule.outputReserve,
        effectiveInput: rule.contextWindow - rule.outputReserve,
      }
    }
  }
  return UNKNOWN_MODEL
}

function messageLength(message: ChatMessage): number {
  if (message.role === 'assistant_thinking') {
    try {
      return JSON.stringify(message.blocks).length
    } catch {
      return 0
    }
  }
  if (message.role === 'assistant_tool_call') {
    return JSON.stringify(message.input).length
  }
  return message.content.length
}

export function estimateMessageTokens(message: ChatMessage): number {
  const ratio = CHARS_PER_TOKEN[message.role] ?? 3.0
  return Math.ceil((messageLength(message) + 8) / ratio)
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

function anchorUsage(message: ChatMessage): ProviderUsage | undefined {
  if (
    (message.role === 'assistant' ||
      message.role === 'assistant_progress' ||
      message.role === 'assistant_tool_call') &&
    message.providerUsage &&
    !message.usageStale
  ) {
    return message.providerUsage
  }
  return undefined
}

export type TokenAccounting = {
  totalTokens: number
  estimatedTokens: number
  source: 'provider_usage' | 'provider_usage_plus_estimate' | 'estimate_only'
}

/** 从后往前找最近的新鲜 usage 作锚点，只估锚点之后的增量 */
export function tokenCountWithEstimation(messages: ChatMessage[]): TokenAccounting {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = anchorUsage(messages[i])
    if (!usage) continue
    const tail = messages.slice(i + 1)
    const estimated = estimateMessagesTokens(tail)
    return {
      totalTokens: usage.inputTokens + estimated,
      estimatedTokens: estimated,
      source: estimated > 0 ? 'provider_usage_plus_estimate' : 'provider_usage',
    }
  }
  const estimated = estimateMessagesTokens(messages)
  return { totalTokens: estimated, estimatedTokens: estimated, source: 'estimate_only' }
}

export type WarningLevel = 'normal' | 'warning' | 'critical' | 'blocked'

export type ContextStats = {
  totalTokens: number
  effectiveInput: number
  utilization: number
  warningLevel: WarningLevel
  source: TokenAccounting['source']
}

export function computeContextStats(messages: ChatMessage[], model: string): ContextStats {
  const window = getModelContextWindow(model)
  const accounting = tokenCountWithEstimation(messages)
  const utilization = accounting.totalTokens / window.effectiveInput
  let warningLevel: WarningLevel = 'normal'
  if (utilization >= 0.95) warningLevel = 'blocked'
  else if (utilization >= 0.85) warningLevel = 'critical'
  else if (utilization >= 0.5) warningLevel = 'warning'
  return {
    totalTokens: accounting.totalTokens,
    effectiveInput: window.effectiveInput,
    utilization,
    warningLevel,
    source: accounting.source,
  }
}

/** 上下文被压缩/重排后，锚点所指的前缀已不存在——整批标脏 */
export function markUsagesStale(messages: ChatMessage[]): ChatMessage[] {
  for (const message of messages) {
    if (anchorUsage(message)) {
      ;(message as { usageStale?: boolean }).usageStale = true
    }
  }
  return messages
}
