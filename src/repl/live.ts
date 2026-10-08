/**
 * 活区渲染器（路线 B-lite）：屏幕底部维护一块"本回合正在发生"的帧——
 * 工具卡片行（▸ running → ✔/✖ done，原地差分重绘）+ Thinking 计时行 + statusLine 常驻尾条。
 * 不进 alt-screen、不接管输入：readline/picker/question 全部照常，
 * 阶段切换时活区落成普通历史行，readline 下一轮照常。
 *
 * 所有权纪律：画布 armed 期间约定没人往块后面写；
 * onModalChange/onExternalWrite 广播 → commitForModal 放手，本批后续更新转 append-only，
 * 杜绝光标回写撞上别人刚画出来的行。
 */
import {
  LineCanvas,
  formatDuration,
  spinnerFrame,
  summarizeToolInput,
  truncateToWidth,
  type ResolvedDeps,
  type ToolResultInfo,
  type ToolStartInfo,
  type TurnRenderer,
} from './ui-kit.js'
import { renderTerminalMarkdown } from './md.js'

type Card = {
  toolUseId: string
  toolName: string
  summary: string
  index: number
  total: number
  status: 'running' | 'done' | 'error'
  startedAt: number
  durationMs?: number
}

export function createLiveRenderer(deps: ResolvedDeps): TurnRenderer & { dispose(): void } {
  const canvas = new LineCanvas(deps.write, deps.tty, line =>
    truncateToWidth(line, (deps.columns() || 80) - 1),
  )
  const offResize = deps.onResize(() => canvas.commit())

  let cards: Card[] = []
  let busySince: number | null = null
  let batchLive = false // 本批工具是否还允许原地重绘（审批弹出后置 false）
  let tick = 0
  let stopTimer: (() => void) | null = null

  function ensureTimer(): void {
    const animating = busySince !== null || cards.some(c => c.status === 'running')
    if (animating && deps.tty && !stopTimer) {
      stopTimer = deps.setTimer(() => {
        tick++
        if (batchLive && canvas.armed) paintFrame()
      }, 200)
    } else if (!animating && stopTimer) {
      stopTimer()
      stopTimer = null
    }
  }

  function cardLine(card: Card): string {
    const p = deps.palette
    const time =
      card.status === 'running'
        ? `… ${formatDuration(Math.max(0, deps.now() - card.startedAt))}`
        : ` ${formatDuration(card.durationMs ?? 0)}`
    const marker =
      card.status === 'running' ? p.yellow('▸') : card.status === 'done' ? p.green('✔') : p.red('✖')
    const progress = card.total > 1 ? ` (${card.index}/${card.total})` : ''
    return `${marker} ${card.toolName}: ${card.summary}${progress}${time}`
  }

  function busyLine(): string {
    const sec = busySince === null ? 0 : Math.floor((deps.now() - busySince) / 1000)
    return deps.palette.dim(`${spinnerFrame(tick)} Thinking… ${sec}s`)
  }

  function frameLines(): string[] {
    const lines = cards.map(cardLine)
    if (busySince !== null) lines.push(busyLine())
    const footer = deps.statusLine()
    if (footer) lines.push(footer)
    return lines
  }

  function paintFrame(): void {
    const lines = frameLines()
    if (lines.length === 0) {
      canvas.commit()
      return
    }
    canvas.paint(lines)
    ensureTimer()
  }

  return {
    onModelStart() {
      canvas.commit()
      cards = []
      busySince = deps.now()
      batchLive = true
      paintFrame()
    },
    onThinking(content) {
      busySince = null
      const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content
      canvas.append(deps.palette.dim(`[thinking] ${renderTerminalMarkdown(preview, deps.palette).replace(/\n/g, '\n\u001b[2m')}`))
      ensureTimer()
    },
    onProgress(content) {
      canvas.append(`[progress] ${renderTerminalMarkdown(content, deps.palette)}`)
    },
    onAssistant(content) {
      busySince = null
      canvas.append(`\n${renderTerminalMarkdown(content, deps.palette)}`)
      ensureTimer()
    },
    onToolStart(info: ToolStartInfo) {
      busySince = null
      const card: Card = {
        toolUseId: info.toolUseId,
        toolName: info.toolName,
        summary: summarizeToolInput(info.toolName, info.input),
        index: info.index,
        total: info.total,
        status: 'running',
        startedAt: deps.now(),
      }
      cards.push(card)
      if (batchLive) paintFrame()
      else canvas.append(cardLine(card))
      ensureTimer()
    },
    onToolResult(info: ToolResultInfo) {
      const card = cards.find(c => c.toolUseId === info.toolUseId)
      if (!card) return
      card.status = info.ok ? 'done' : 'error'
      card.durationMs = info.durationMs
      if (batchLive) {
        paintFrame()
      } else {
        canvas.append(cardLine(card))
        cards = cards.filter(c => c !== card)
      }
      ensureTimer()
    },
    notice(message) {
      canvas.append(deps.palette.dim(message))
    },
    commitForModal() {
      canvas.commit()
      batchLive = false
    },
    finish(info) {
      busySince = null
      canvas.commit()
      // 悬挂的 running 卡片（abort/max_steps 时结果没回）盖个 ✖ 收尾
      for (const card of cards) {
        if (card.status === 'running') canvas.append(cardLine({ ...card, status: 'error' }))
      }
      cards = []
      if (deps.tty && info.toolCalls > 0) {
        canvas.append(deps.palette.dim(`⏱ ${formatDuration(info.elapsedMs)} · ${info.toolCalls} tool calls`))
      }
      ensureTimer()
    },
    abortCleanup() {
      busySince = null
      canvas.commit()
      stopTimer?.()
      stopTimer = null
    },
    dispose() {
      offResize()
      stopTimer?.()
      stopTimer = null
    },
  }
}
