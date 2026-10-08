/**
 * 渲染公共件（B3 L1 第 2 步）：类型层 + 颜色板、显示宽度、行画布、工具输入摘要。
 * renderer.ts（inline）与 live.ts（活区）共用，两者都不直接碰 process.stdout，
 * 一切输出经注入的 write —— 测试可全量捕获。类型放本层是为了让两种实现互不依赖。
 */

/** 与 agent_loop 的回调 payload 结构一致（回合渲染层的事实接口） */
export type ToolStartInfo = { toolUseId: string; toolName: string; input: unknown; index: number; total: number }
export type ToolResultInfo = { toolUseId: string; toolName: string; ok: boolean; durationMs: number; index: number; total: number }

export type TuiMode = 'inline' | 'live'

/** 回合渲染器统一接口：runTurn 把 agentloop 回调接到这里，回合内在 stdout 的发言权归它一家 */
export type TurnRenderer = {
  onModelStart(step: number): void
  onThinking(content: string): void
  onProgress(content: string): void
  onAssistant(content: string): void
  onToolStart(info: ToolStartInfo): void
  onToolResult(info: ToolResultInfo): void
  notice(message: string): void
  /** 模态/外部输出要进场：放弃活区所有权，行落为历史 */
  commitForModal(): void
  finish(info: { kind: string; elapsedMs: number; toolCalls: number }): void
  /** Ctrl+C 打断：静默收尾（停 timer、放手），不写新内容 */
  abortCleanup(): void
}

/** 工厂解析后的依赖：所有环境交互都是可注入缝 */
export type ResolvedDeps = {
  write: (data: string) => void
  tty: boolean
  palette: Palette
  columns: () => number
  rows: () => number
  statusLine: () => string
  setTimer: (fn: () => void, ms: number) => () => void
  onResize: (fn: () => void) => () => void
  now: () => number
}

/** 工厂入参：全部可注入，缺省走 process 真实环境 */
export type RendererDeps = {
  mode?: TuiMode
  write?: (data: string) => void
  isTTY?: boolean
  color?: boolean
  columns?: () => number
  rows?: () => number
  statusLine?: () => string
  setTimer?: (fn: () => void, ms: number) => () => void
  onResize?: (fn: () => void) => () => void
  now?: () => number
}

// ── 颜色板：disable 后全部恒等（非 TTY / NO_COLOR / TERM=dumb） ──
export type Palette = {
  dim(s: string): string
  red(s: string): string
  green(s: string): string
  yellow(s: string): string
  bold(s: string): string
  italic(s: string): string
  cyan(s: string): string
}

export function createPalette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      dim: s => s,
      red: s => s,
      green: s => s,
      yellow: s => s,
      bold: s => s,
      italic: s => s,
      cyan: s => s,
    }
  }
  return {
    dim: s => `\u001b[2m${s}\u001b[0m`,
    red: s => `\u001b[31m${s}\u001b[0m`,
    green: s => `\u001b[32m${s}\u001b[0m`,
    yellow: s => `\u001b[33m${s}\u001b[0m`,
    bold: s => `\u001b[1m${s}\u001b[0m`,
    italic: s => `\u001b[3m${s}\u001b[0m`,
    cyan: s => `\u001b[36m${s}\u001b[0m`,
  }
}

const ANSI_RE = /\u001b\[[0-9;]*m/g

/** 逐码点显示宽度：CJK/全角=2，emoji=2，其余=1；ANSI 序列计 0 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text.replace(ANSI_RE, '')) {
    const cp = ch.codePointAt(0)!
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    ) {
      width += 2
    } else if (cp >= 0x1f000) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/** 按显示宽度截断，超出补 …；带 ANSI 的整行由调用方保证色码闭合 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text
  let out = ''
  let width = 0
  for (const ch of text.replace(ANSI_RE, '')) {
    const w = displayWidth(ch)
    if (width + w > maxWidth - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]
}

function inputText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.replace(/\s+/g, ' ').trim() : undefined
}

/** 工具 input 的一行摘要：常用工具认字段，其余取第一个短字符串值或 JSON 截断 */
export function summarizeToolInput(toolName: string, input: unknown, max = 100): string {
  const obj = (input ?? {}) as Record<string, unknown>
  const text = inputText
  const base = (value: string | undefined) => (value ? truncateToWidth(value, max) : undefined)

  if (toolName === 'bash') return base(text(obj.command)) ?? fallbackSummary(obj, max)
  if (toolName === 'read' || toolName === 'edit' || toolName === 'write') {
    return base(text(obj.filePath)) ?? fallbackSummary(obj, max)
  }
  if (toolName === 'glob' || toolName === 'grep') {
    const pattern = base(text(obj.pattern)) ?? ''
    const pathPart = text(obj.path)
    return base(pathPart ? `${pattern} @ ${pathPart}` : pattern) ?? fallbackSummary(obj, max)
  }
  if (toolName === 'webfetch') return base(text(obj.url)) ?? fallbackSummary(obj, max)
  if (toolName === 'question') return base(text(obj.question)) ?? fallbackSummary(obj, max)
  return fallbackSummary(obj, max)
}

function fallbackSummary(obj: Record<string, unknown>, max: number): string {
  for (const value of Object.values(obj)) {
    const asText = inputText(value)
    if (asText && asText.length <= 120) return truncateToWidth(asText, max)
  }
  return truncateToWidth(JSON.stringify(obj), max)
}

/**
 * 行画布：管理屏幕底部一块"自己拥有的行"（transient block）。
 *  - paint(lines)：首次 append 出块并记所有权；再次调用逐行差分，只重写变化行。
 *  - append(text)：历史输出——先放手（块落为历史），再原样写出。
 *  - commit()/detach()：放手所有权，屏幕内容不动（弹审批卡 / 转永久行时用）。
 * 非 TTY 下 paint 退化为普通 append，绝不产生回写——管道安全。
 * 所有权期间约定：除本画布外无人向其后写内容（由 onModalChange/onExternalWrite 广播兜底）。
 */
export class LineCanvas {
  private prev: string[] = []

  constructor(
    private readonly write: (data: string) => void,
    readonly tty: boolean,
    private readonly fit: (line: string) => string,
  ) {}

  get armed(): boolean {
    return this.prev.length > 0
  }

  paint(lines: string[]): void {
    const fitted = lines.map(line => this.fit(line))
    if (!this.tty) {
      this.write(fitted.join('\n') + '\n')
      this.prev = []
      return
    }
    if (this.prev.length === 0) {
      // 首帧纯 append，不依赖任何回写
      this.write(fitted.join('\n') + '\n')
      this.prev = fitted
      return
    }
    // 前缀与正文合并为单次 write：一次 syscall，原子重画
    let out = `\u001b[${this.prev.length}A` // 回到自有块首行行首
    const max = Math.max(this.prev.length, fitted.length)
    for (let i = 0; i < max; i++) {
      const next = fitted[i]
      if (next !== undefined && next === this.prev[i]) {
        out += '\u001b[1E' // 未变化：只下移，不重写（差分核心）
        continue
      }
      out += `\u001b[2K${next ?? ''}`
      out += i < max - 1 ? '\u001b[1E' : '\n'
    }
    this.write(out)
    this.prev = fitted
  }

  append(text: string): void {
    this.detach()
    this.write(text.endsWith('\n') ? text : text + '\n')
  }

  /** 落为历史：放弃所有权但不改屏幕内容 */
  commit(): void {
    this.detach()
  }

  detach(): void {
    this.prev = []
  }
}
