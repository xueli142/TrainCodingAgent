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

function makeContextWindow(contextWindow: number, outputReserve: number): ModelContextWindow {
  // reserve 必须小于窗口，否则 effectiveInput 归零会让利用率恒为 Infinity
  const reserve = Math.max(0, Math.min(outputReserve, contextWindow - 1))
  return { contextWindow, outputReserve: reserve, effectiveInput: contextWindow - reserve }
}

// 兜底窗口：不猜模型——拿不到真值就统一 1M（输入预留 100K），并在启动日志里明说
const FALLBACK_WINDOW = makeContextWindow(1_000_000, 100_000)

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
}

// ── 真实窗口：启动时强制问 provider 的模型列表接口，命中即缓存 ──
// 缓存后 getModelContextWindow 保持同步（状态行/compact 都在同步路径上调它）。
const REMOTE_WINDOWS = new Map<string, ModelContextWindow>()

const CONTEXT_FIELDS = ['context_window', 'context_length', 'max_context_length']
const OUTPUT_FIELDS = ['max_output_tokens', 'max_completion_tokens']

export function getModelContextWindow(model: string): ModelContextWindow {
  return REMOTE_WINDOWS.get(normalizeModel(model)) ?? FALLBACK_WINDOW
}

/**
 * 展示格式：一律 /1000 四舍五入；≥1M 用 M（一位小数，整值省小数点），<1M 用 K。
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = Math.round(tokens / 100_000) / 10
    return `${m % 1 === 0 ? Math.round(m) : m}M`
  }
  if (tokens < 1000) return String(tokens)
  return `${Math.round(tokens / 1000)}K`
}

/** 注入远端窗口（hydrate 内部用；测试可直接调用） */
export function setRemoteModelContextWindow(model: string, window: ModelContextWindow): void {
  REMOTE_WINDOWS.set(normalizeModel(model), makeContextWindow(window.contextWindow, window.outputReserve))
}

export function clearRemoteModelContextWindows(): void {
  REMOTE_WINDOWS.clear()
}

export type ModelWindowFetchOptions = {
  baseUrl: string
  apiKey?: string
  /** 显式指定模型列表地址（env MODELS_URL），优先于 BASE_URL 推导 */
  modelsUrl?: string
  timeoutMs?: number
}

/**
 * 向 provider 的模型列表接口要真实窗口（启动时强制执行一次）：成功写入缓存并返回；
 * 所有候选地址失败返回 undefined，调用方使用 1M 兜底并在日志里明说。
 * 候选顺序：MODELS_URL → `${BASE_URL}/models` → 去掉 /anthropic|/v1 后缀的根 → origin。
 */
export async function hydrateModelContextWindow(
  model: string,
  options: ModelWindowFetchOptions,
): Promise<ModelContextWindow | undefined> {
  const fallback = FALLBACK_WINDOW
  for (const url of candidateModelsUrls(options)) {
    try {
      const entry = await fetchModelEntry(url, model, options)
      if (!entry) continue
      const contextWindow = numberField(entry, CONTEXT_FIELDS)
      if (!contextWindow) continue
      const window = makeContextWindow(
        contextWindow,
        numberField(entry, OUTPUT_FIELDS) ?? fallback.outputReserve,
      )
      setRemoteModelContextWindow(model, window)
      return window
    } catch {
      // 网络/超时/非 JSON：换下一个候选；全败则回退内置表
    }
  }
  return undefined
}

function candidateModelsUrls(options: ModelWindowFetchOptions): string[] {
  const base = options.baseUrl?.replace(/\/+$/, '')
  const urls: string[] = []
  if (options.modelsUrl) urls.push(options.modelsUrl)
  if (base) {
    urls.push(`${base}/models`)
    urls.push(`${base.replace(/\/(anthropic|v1)$/, '')}/models`)
    try {
      urls.push(`${new URL(base).origin}/models`)
    } catch {
      // BASE_URL 不是合法 URL：跳过
    }
  }
  return [...new Set(urls)]
}

async function fetchModelEntry(
  url: string,
  model: string,
  options: ModelWindowFetchOptions,
): Promise<Record<string, unknown> | undefined> {
  const response = await fetch(url, {
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  })
  if (!response.ok) return undefined
  return findModelEntry(await response.json(), model)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function modelEntries(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter(isRecord)
  if (isRecord(data)) {
    if (Array.isArray(data.data)) return data.data.filter(isRecord)   // openai / 多数网关
    if (Array.isArray(data.models)) return data.models.filter(isRecord)
    return [data]                                                     // 单模型详情
  }
  return []
}

function findModelEntry(data: unknown, model: string): Record<string, unknown> | undefined {
  const key = normalizeModel(model)
  const entries = modelEntries(data)
  const idOf = (entry: Record<string, unknown>): string =>
    normalizeModel(typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : '')
  return entries.find(entry => idOf(entry) === key) ?? entries.find(entry => idOf(entry).includes(key))
}

function numberField(entry: Record<string, unknown>, fields: string[]): number | undefined {
  for (const source of [entry, entry.top_provider]) {
    if (!isRecord(source)) continue
    for (const field of fields) {
      const value = source[field]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    }
  }
  return undefined
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
/**
totalTokens      // 当前已用 token（精确锚点 + 尾部估算）
effectiveInput   // 输入上限 = contextWindow - outputReserve（界面分母）
utilization      // 已用 / 上限，0~1 的比值（界面显示的百分比）
warningLevel     // 告警档：normal / warning / critical / blocked
source           // 数值可信度：provider_usage / provider_usage_plus_estimate / estimate_only
 *
 * @param messages 当前完整对话历史
 * @param model    模型名（用于查上下文窗口规则，支持子串匹配）
 */
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
