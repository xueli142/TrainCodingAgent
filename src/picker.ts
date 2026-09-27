import type { Key } from 'node:readline'
import { discardQueuedInput, flushTypedInput, pushModal } from './tty-prompt.js'

/**
 * 决策模态选择器（B3 L1 第 1 步）——审批卡 / question 等"需要人判断"处的直观单选。
 *
 * 键盘模型：
 *  - ↑/↓（含 j/k、Home/End）移动高亮，Enter 确认高亮项
 *  - 数字 1-9 一步选第 n 项；带 key 字段的项可按其 key（如审批 y/a/n/d）一步选
 *  - Esc / Ctrl+C（由 interruptWaiters 触发 onClose）= 取消
 *  - Ctrl+O 展开/折叠当前项的 detail（如 edit 的 diff）
 *
 * 输入通道：全程走 onKey（导航/选择/Esc 都不回车）。settle 里 discard 队列 + flush 残字，
 * 因此 Enter/Esc 偶发的 line 事件、y/a/1-9 漏进 readline 缓冲的字符都被就地抹除，
 * 不污染栈外的 readLine（结构性防抢答，比弹卡前洗队列更彻底）。
 */

export type PickerOption = {
  /** 单键直达（审批卡的 y/a/n/d）；省略则仅用数字/方向键选 */
  key?: string
  label: string
  /** 右侧灰色提示（如 decision 值、id） */
  hint?: string
  danger?: boolean
  /** Ctrl+O 展开的多行明细（edit 审批塞 diff） */
  detail?: string[]
}

export type PickerSpec = {
  title: string
  options: PickerOption[]
  /** 初始高亮下标 */
  initial?: number
  /** 页脚按键说明，默认为通用文案 */
  footer?: string
}

const DIM = '\u001b[2m'
const RED = '\u001b[31m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'
const RESET = '\u001b[0m'
const MAX_VISIBLE_DETAIL = 16

/** 输出缝（测试可注入静默 sink，别去猴补丁 process.stdout——会吞掉测试报告器） */
let writeOut: (data: string) => void = data => {
  process.stdout.write(data)
}
export function setPickerWriter(writer: ((data: string) => void) | null): void {
  writeOut = writer ?? (data => process.stdout.write(data))
}
//一次pick调用，压栈一次
export function pick(spec: PickerSpec): Promise<number | null> {
  return new Promise(resolve => {
    if (spec.options.length === 0) {
      resolve(null)
      return
    }
    discardQueuedInput()

    let cursor = clamp(spec.initial ?? 0, 0, spec.options.length - 1)
    let expanded = false
    let drawnLines = 0
    let done = false

    const pop = pushModal({ name: 'picker', onKey, onClose: () => settle(null) })

    function settle(value: number | null): void {
      if (done) return
      done = true
      // 延后一个微任务再拆栈：Enter/Esc 与 keypress 同批到达的 line 事件会在"模态仍在栈顶
      // 且不接线"时被路由层丢弃；同步 pop 反而会让那条线漏给等待中的 readLine（抢答）
      queueMicrotask(() => {
        pop()
        discardQueuedInput()
        flushTypedInput()
        erase()
        resolve(value)
      })
    }

    function render(): void {
      erase()
      const body: string[] = ['', `${YELLOW}⚠ ${spec.title}${RESET}`]
      spec.options.forEach((opt, i) => {
        const marker = i === cursor ? `${GREEN}❯${RESET}` : ' '
        const slot = opt.key ? `${DIM}[${opt.key}]${RESET}` : `${DIM}${i + 1}${RESET}`
        const label = opt.danger && i === cursor ? `${RED}${opt.label}${RESET}` : opt.label
        const hint = opt.hint ? ` ${DIM}${opt.hint}${RESET}` : ''
        body.push(`  ${marker} ${slot} ${label}${hint}`)
        if (i === cursor && expanded && opt.detail?.length) {
          const shown = opt.detail.slice(0, MAX_VISIBLE_DETAIL)
          for (const line of shown) body.push(`      ${DIM}${line}${RESET}`)
          if (opt.detail.length > MAX_VISIBLE_DETAIL) {
            body.push(`      ${DIM}… (${opt.detail.length - MAX_VISIBLE_DETAIL} more, Ctrl+O toggles)${RESET}`)
          }
        }
      })
      body.push(`${DIM}${spec.footer ?? '↑/↓ select · Enter confirm · 1-9/y-key quick pick · Ctrl+O detail · Esc cancel'}${RESET}`)
      drawnLines = body.length
      writeOut(body.join('\n') + '\n')
    }

    function erase(): void {
      if (drawnLines > 0) {
        // 上移到本块首行，清到屏幕末尾，原地重画
        writeOut(`\u001b[${drawnLines}A\u001b[0J`)
        drawnLines = 0
      }
    }

    function move(delta: number): void {
      cursor = clamp(cursor + delta, 0, spec.options.length - 1)
      expanded = false
      render()
    }

    function onKey(_str: string, key: Key): boolean {
      const name = key.name ?? ''
      if (name === 'up' || name === 'k' || (key.ctrl && name === 'p')) {
        move(-1)
        return true
      }
      if (name === 'down' || name === 'j' || (key.ctrl && name === 'n')) {
        move(1)
        return true
      }
      if (name === 'home') {
        cursor = 0
        render()
        return true
      }
      if (name === 'end') {
        cursor = spec.options.length - 1
        render()
        return true
      }
      if (key.ctrl && name === 'o') {
        expanded = !expanded
        render()
        return true
      }
      if (name === 'escape') {
        settle(null)
        return true
      }
      if (name === 'return' || name === 'enter') {
        settle(cursor)
        return true
      }
      // 单键直达：先看 option.key（如 y/a/n/d），再看数字序号
      const byKey = spec.options.findIndex(o => o.key && o.key.toLowerCase() === name.toLowerCase())
      if (byKey >= 0) {
        settle(byKey)
        return true
      }
      if (/^[1-9]$/.test(name)) {
        const idx = Number(name) - 1
        if (idx < spec.options.length) settle(idx)
        return true
      }
      return false
    }

    render()
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
