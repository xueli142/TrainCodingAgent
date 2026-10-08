import type { Interface, Key } from 'node:readline'

/**
 * 单读者 + 模态栈路由：
 * readline 是唯一 stdin 读者。无模态时按键走 readline 原生编辑（历史↑↓/Tab），
 * line 事件按 FIFO 分给 readLine() 等待者，没人等就排队（旧行为不变）。
 * 模态栈非空时：
 *  - keypress 只投递栈顶（返回 true = 已消费；键仍会漏进 readline 缓冲区，
 *    消费方可用 flushTypedInput() 清残字）
 *  - line 事件交给栈顶 onLine；栈顶没注册 onLine 则直接丢弃——排队即抢答，
 *    路由层从结构上杜绝，不再依赖弹卡后 discardQueuedInput 的事后清洗
 *  - 系统级关闭（EOF/Ctrl+C 取消回合）先关全部模态（onClose 唤醒悬挂 promise），
 *    再以 null 结算等待者
 */

export type ModalSpec = {
  name?: string
  onKey?: (str: string, key: Key) => boolean
  onLine?: (line: string) => void
  /** 被系统关闭（EOF/interruptWaiters）时回调：owner 借此把未决 promise 结算为 null */
  onClose?: () => void
}

type Modal = ModalSpec & { closed: boolean }

const queue: string[] = []
let waiters: Array<(line: string | null) => void> = []
let closed = false
let modals: Modal[] = []
let source: Interface | null = null
let globalKeyHandlers: Array<(str: string, key: Key) => boolean> = []

/** 无模态时的全局快捷键表（Ctrl+G 之类）；返回 true=消费。printable 键务必返回 false 放行 */
export function onGlobalKey(handler: (str: string, key: Key) => boolean): () => void {
  globalKeyHandlers.push(handler)
  return () => {
    globalKeyHandlers = globalKeyHandlers.filter(h => h !== handler)
  }
}

/** 把一行"注入"给正在等待的 readLine（快捷键模态把结果交还 REPL 用） */
export function deliverLine(line: string): void {
  const waiter = waiters.shift()
  if (waiter) {
    waiter(line)
  } else {
    queue.push(line)
  }
}

/** 模态深度变化广播（渲染器借此在弹卡前把自己画的行落成历史）；返回退订函数 */
let modalChangeListeners: Array<(depth: number) => void> = []
export function onModalChange(listener: (depth: number) => void): () => void {
  modalChangeListeners.push(listener)
  return () => {
    modalChangeListeners = modalChangeListeners.filter(l => l !== listener)
  }
}

function notifyModalChange(): void {
  for (const listener of modalChangeListeners) {
    listener(modals.length)
  }
}

/** 回合内"别人要往 stdout 写东西/弹提示"的广播（readLine 带 prompt 时触发）；返回退订函数 */
let externalWriteListeners: Array<() => void> = []
export function onExternalWrite(listener: () => void): () => void {
  externalWriteListeners.push(listener)
  return () => {
    externalWriteListeners = externalWriteListeners.filter(l => l !== listener)
  }
}

/** 压入模态，返回弹出函数（owner 自行结算后必须调用返回值） */
export function pushModal(spec: ModalSpec): () => void {
  const modal: Modal = { ...spec, closed: false }
  modals.push(modal)
  notifyModalChange()
  return () => closeModal(modal)
}

function closeModal(modal: Modal, bySystem = false): void {
  if (modal.closed) return
  modal.closed = true
  modals = modals.filter(m => m !== modal)
  notifyModalChange()
  if (bySystem) {
    modal.onClose?.()
  }
}

function closeAllModals(): number {
  const count = modals.length
  for (const modal of [...modals]) {
    closeModal(modal, true)
  }
  return count
}

export function modalDepth(): number {
  return modals.length
}

/** 模态消费了可打印键后，清掉该行在 readline 编辑缓冲里的残留 */
export function flushTypedInput(): void {
  try {
    // 注意：readline 的 write(data, key) 第二参是**单个 key 对象**，不是数组——
    // 传数组会被 _ttyWrite 静默忽略，导致残字没清、后续 Enter 把残字挤成
    // 排队消息（幽灵输入）。类型定义里 key?: Key，这里按运行时契约传单对象。
    const rlLike = source as unknown as {
      write: (data: string | null, key: object) => void
    } | null
    rlLike?.write(null, { ctrl: true, name: 'u' })
  } catch {
    /* 非 TTY 或 readline 已关闭 */
  }
}

/** 在主 rl 创建后调用一次，把 rl 的 line/close 事件接到分发器。
 *  keypress 必须听 **stdin 流本身**（readline 对 TTY 自动启用 keypress 解析，事件发在 input 上，
 *  rl 接口对象不发 keypress——实测 rl.on('keypress') 永不触发）。切勿再手动 emitKeypressEvents，会翻倍。
 *  keyStream 参数仅供测试注入假流；生产默认 process.stdin。 */
export function attachInputSource(
  rl: Interface,
  keyStream: { on: (event: string, listener: (...args: any[]) => void) => unknown } = process.stdin,
): void {
  source = rl
  rl.on('line', line => {
    if (closed) {
      return
    }
    const top = modals[modals.length - 1]
    if (top) {
      top.onLine?.(line)
      return // 栈顶不接线的模态（纯快捷键型）：丢弃，不留抢答残余
    }
    const waiter = waiters.shift()
    if (waiter) {
      waiter(line)
    } else {
      queue.push(line)
    }
  })
  keyStream.on('keypress', (str: string, key: Key) => {
    const top = modals[modals.length - 1]
    if (top) {
      top.onKey?.(str, key)
      return
    }
    for (const handler of globalKeyHandlers) {
      if (handler(str, key)) break
    }
  })
  // EOF（管道结束 / Ctrl+D）：先关模态再唤醒所有等待者，调用方按 null 走拒绝/退出兜底
  rl.on('close', () => {
    closed = true
    closeAllModals()
    if (waiters.length > 0) {
      const pending = waiters
      waiters = []
      for (const waiter of pending) {
        waiter(null)
      }
    }
  })
}

/** 读一行；返回 null 表示输入流已关闭（不可再交互）。模态激活期间请不要用本函数拿线，用 onLine */
export function readLine(prompt?: string): Promise<string | null> {
  if (prompt) {
    // 有回合内渲染器订阅时：先让它把活区落成历史，再把提示符打在干净位置
    for (const listener of externalWriteListeners) listener()
    process.stdout.write(prompt)
  }
  if (queue.length > 0) {
    return Promise.resolve(queue.shift()!)
  }
  if (closed) {
    return Promise.resolve(null)
  }
  return new Promise(resolve => {
    waiters.push(resolve)
  })
}

/**
 * 非模态消费方的防抢答兜底（question 等还没迁移到模态的路径用）：
 * 弹卡前洗掉排队中的旧行，返回丢弃行数。
 */
export function discardQueuedInput(): number {
  const dropped = queue.length
  queue.length = 0
  return dropped
}

/**
 * 回合取消时调用：先关全部模态（onClose 结算 picker 类 promise），
 * 再以 null 唤醒挂在 readLine 上的等待者（审批卡按拒绝处理）。
 */
export function interruptWaiters(): number {
  const wokenModals = closeAllModals()
  const pending = waiters
  waiters = []
  for (const waiter of pending) {
    waiter(null)
  }
  return wokenModals + pending.length
}
