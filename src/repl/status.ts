import { MODEL } from '../config.js'
import { getMcpStatus } from '../mcp.js'
import { computeContextStats, formatTokens, getModelContextWindow } from '../utils/token-estimator.js'
import type { ReplContext } from './context.js'

// 进度条粒度：每格 2 万 token；格数随窗口自适应（1M 窗口 ≈ 53 格）
const STATUS_TOKENS_PER_CELL = 20_000

export function statusLine(ctx: ReplContext): string {
  const stats = computeContextStats(ctx.messages, MODEL)
  // 展示口径：分母用完整上下文窗口（"最大的端"），直观反映当前上下文占用百分比
  const contextWindow = getModelContextWindow(MODEL).contextWindow
  const cells = Math.max(1, Math.ceil(contextWindow / STATUS_TOKENS_PER_CELL))
  const ratio = Math.min(1, stats.totalTokens / contextWindow)
  const filled = Math.round(ratio * cells)
  const bar = '▓'.repeat(filled) + '░'.repeat(cells - filled)
  const statuses = getMcpStatus()
  const ready = statuses.filter(s => s.status === 'connected').length
  const approx = stats.source === 'estimate_only' ? '~' : ''
  const pct = Math.round(ratio * 100)
  return `\u001b[2m[${ctx.sessionId.slice(0, 8)}] ${MODEL} · 已消耗 ${approx}${formatTokens(stats.totalTokens)}  ${bar} ${pct}% / ${formatTokens(contextWindow)}  · mcp ${ready}/${statuses.length}\u001b[0m`
}
