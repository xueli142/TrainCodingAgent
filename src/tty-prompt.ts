import type { Interface } from 'node:readline'

/** 单读者 + 模态分发：readline 是唯一 stdin 读者，所有"读一行"需求排队 */

const queue: string[] = []
let waiters: Array<(line: string | null) => void> = []
let closed = false

/** 在主 rl 创建后调用一次，把 rl 的 line/close 事件接到分发器 */
export function attachInputSource(rl: Interface): void {
  rl.on('line', line => {
    if (closed) {
      return
    }
    const waiter = waiters.shift()
    if (waiter) {
      waiter(line)
    } else {
      queue.push(line)
    }
  })
  // EOF（管道结束 / Ctrl+D）：唤醒所有等待者，调用方按 null 走拒绝/退出兜底，
  // 否则 readLine 会永远悬挂——旧 CONIN$ 版本的 null 路径就是干这个的
  rl.on('close', () => {
    closed = true
    if (waiters.length > 0) {
      const pending = waiters
      waiters = []
      for (const waiter of pending) {
        waiter(null)
      }
    }
  })
}

/** 读一行；返回 null 表示输入流已关闭（不可再交互）。同一时刻多个 pending 也安全 */
export function readLine(prompt?: string): Promise<string | null> {
  if (prompt) {
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
