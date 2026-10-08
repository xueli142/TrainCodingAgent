/**
 * 回合渲染器工厂 + inline 实现（路线 A）。
 * runTurn 每回合 new 一个，把 agentloop 的全部回调接到这里：回合内 stdout 的发言权归渲染器一家，
 * 外部要说话（审批卡/question/resume 提示）先经 commitForModal 落历史（接线见 repl/turn.ts）。
 * 模式：inline=追加式 + transient 单行回写；live=底部活区差分重绘（src/repl/live.ts）。
 * 非 TTY 一律退化：无 spinner、无工具卡片、无 ANSI——与改造前的管道行为一致。
 */
import process from 'node:process'
import {
  LineCanvas,
  createPalette,
  formatDuration,
  spinnerFrame,
  summarizeToolInput,
  truncateToWidth,
  type RendererDeps,
  type ResolvedDeps,
  type ToolResultInfo,
  type ToolStartInfo,
  type TuiMode,
  type TurnRenderer,
} from './ui-kit.js'
import { createLiveRenderer } from './live.js'
import { renderTerminalMarkdown } from './md.js'

let defaultMode: TuiMode = 'inline'

export function setTuiMode(mode: TuiMode): void {
  defaultMode = mode
}
export function getTuiMode(): TuiMode {
  return defaultMode
}

type DisposableRenderer = TurnRenderer & { dispose(): void }

let activeRenderer: DisposableRenderer | null = null

export function createTurnRenderer(deps: RendererDeps = {}): DisposableRenderer {
  const tty = deps.isTTY ?? Boolean(process.stdout.isTTY)
  const color = deps.color ?? (tty && process.env.TERM !== 'dumb' && !process.env.NO_COLOR)
  const resolved: ResolvedDeps = {
    write: deps.write ?? (data => { process.stdout.write(data) }),
    tty,
    palette: createPalette(color),
    columns: deps.columns ?? (() => process.stdout.columns ?? 80),
    rows: deps.rows ?? (() => process.stdout.rows ?? 24),
    statusLine: deps.statusLine ?? (() => ''),
    setTimer: deps.setTimer ?? ((fn, ms) => {
      const timer = setInterval(fn, ms)
      return () => clearInterval(timer)
    }),
    onResize: deps.onResize ?? (fn => {
      process.stdout.on('resize', fn)
      return () => process.stdout.off('resize', fn)
    }),
    now: deps.now ?? (() => Date.now()),
  }
  const mode: TuiMode = tty ? (deps.mode ?? defaultMode) : 'inline'
  const renderer = mode === 'live' ? createLiveRenderer(resolved) : createInlineRenderer(resolved)
  activeRenderer = renderer
  return renderer
}

/** Ctrl+C 打断用：静默收尾当前回合渲染器（不落新内容，[interrupt] 日志由调用方接续） */
export function abortActiveTurnRenderer(): void {
  const renderer = activeRenderer
  activeRenderer = null
  if (renderer) {
    renderer.abortCleanup()
    renderer.dispose()
  }
}

/** 回合结束释放环境订阅（resize/timer）；activeRenderer 指针由 finish 流程统一清 */
export function disposeActiveTurnRenderer(): void {
  const renderer = activeRenderer
  activeRenderer = null
  renderer?.dispose()
}

// ── inline：一切走追加，只有一条 transient 状态行（Thinking…/工具 running）享受原地回写特权 ──
function createInlineRenderer(deps: ResolvedDeps): DisposableRenderer {
  const canvas = new LineCanvas(deps.write, deps.tty, line =>
    truncateToWidth(line, (deps.columns() || 80) - 1),
  )
  const offResize = deps.onResize(() => canvas.commit())

  let busySince: number | null = null
  let tick = 0
  let stopTimer: (() => void) | null = null
  const running = new Map<string, { toolName: string; summary: string; index: number; total: number }>()

  function startBusy(): void {
    busySince = deps.now()
    if (!deps.tty) return
    canvas.paint([busyLine()])
    if (!stopTimer) {
      stopTimer = deps.setTimer(() => {
        tick++
        if (busySince !== null && canvas.armed) canvas.paint([busyLine()])
      }, 120)
    }
  }

  function stopBusy(): void {
    busySince = null
  }

  function busyLine(): string {
    const sec = busySince === null ? 0 : Math.floor((deps.now() - busySince) / 1000)
    return deps.palette.dim(`${spinnerFrame(tick)} Thinking… ${sec}s`)
  }

  function doneLine(toolName: string, summary: string, info: ToolResultInfo): string {
    const marker = info.ok ? deps.palette.green('✔') : deps.palette.red('✖')
    const progress = info.total > 1 ? ` (${info.index}/${info.total})` : ''
    return `${marker} ${toolName}: ${summary}${progress} ${formatDuration(info.durationMs)}`
  }

  return {
    onModelStart() {
      startBusy()
    },
    onThinking(content) {
      stopBusy()
      const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content
      canvas.append(deps.palette.dim(`[thinking] ${renderTerminalMarkdown(preview, deps.palette).replace(/\n/g, '\n\u001b[2m')}`))
    },
    onProgress(content) {
      canvas.append(`[progress] ${renderTerminalMarkdown(content, deps.palette)}`)
    },
    onAssistant(content) {
      stopBusy()
      canvas.append(`\n${renderTerminalMarkdown(content, deps.palette)}`)
    },
    onToolStart(info: ToolStartInfo) {
      stopBusy()
      const summary = summarizeToolInput(info.toolName, info.input)
      running.set(info.toolUseId, {
        toolName: info.toolName,
        summary,
        index: info.index,
        total: info.total,
      })
      if (!deps.tty) return
      const progress = info.total > 1 ? ` (${info.index}/${info.total})` : ''
      canvas.paint([deps.palette.yellow(`▸ ${info.toolName}: ${summary}${progress}…`)])
    },
    onToolResult(info: ToolResultInfo) {
      const card = running.get(info.toolUseId)
      running.delete(info.toolUseId)
      if (!deps.tty) return
      const line = doneLine(card?.toolName ?? info.toolName, card?.summary ?? '', info)
      // armed=▸ 行还在屏底且没人插话 → 原地改写；弹过审批卡 → 新起一行
      if (canvas.armed) canvas.paint([line])
      else canvas.append(line)
      canvas.commit()
    },
    notice(message) {
      canvas.append(deps.palette.dim(message))
    },
    commitForModal() {
      canvas.commit()
    },
    finish(info) {
      stopBusy()
      running.clear()
      canvas.commit()
      if (deps.tty && info.toolCalls > 0) {
        canvas.append(deps.palette.dim(`⏱ ${formatDuration(info.elapsedMs)} · ${info.toolCalls} tool calls`))
      }
    },
    abortCleanup() {
      stopBusy()
      running.clear()
      canvas.commit()
    },
    dispose() {
      offResize()
      stopTimer?.()
      stopTimer = null
    },
  }
}
