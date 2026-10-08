import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Interface } from 'node:readline'
import {
  attachInputSource,
  deliverLine,
  flushTypedInput,
  interruptWaiters,
  modalDepth,
  onExternalWrite,
  onGlobalKey,
  onModalChange,
  pushModal,
  readLine,
} from '../src/tty-prompt.js'

/** 假 readline：只需要 on/write；测试手动 emit line/keypress/close */
class FakeRl extends EventEmitter {
  writes: unknown[][] = []
  write(...args: unknown[]): void {
    this.writes.push(args)
  }
}

const rl = new FakeRl()
attachInputSource(rl as unknown as Interface, rl as any)

const emitLine = (line: string) => rl.emit('line', line)
const emitKey = (str: string, key: unknown) => rl.emit('keypress', str, key)

async function rejectAfter<T>(promise: Promise<T>, ms: number): Promise<'pending' | T> {
  return Promise.race([promise, new Promise<'pending'>(r => setTimeout(() => r('pending'), ms))])
}

test('无模态：line 按 FIFO 给等待者（旧行为保持）', async () => {
  const first = readLine()
  const second = readLine()
  emitLine('a')
  emitLine('b')
  assert.equal(await first, 'a')
  assert.equal(await second, 'b')
  assert.equal(modalDepth(), 0)
})

test('模态 onLine 截胡：栈顶拿线，readLine 等待者不受影响', async () => {
  const got: string[] = []
  const pendingRepl = readLine()
  const pop = pushModal({ name: 'picker', onLine: line => got.push(line) })
  emitLine('modal-line')
  assert.deepEqual(got, ['modal-line'])
  assert.equal(await rejectAfter(pendingRepl, 20), 'pending')
  pop()
  emitLine('for-repl')
  assert.equal(await pendingRepl, 'for-repl')
})

test('纯快捷键模态：不接 onLine 的栈顶丢弃线事件，杜绝抢答残余', async () => {
  const pop = pushModal({ name: 'hotkeys', onKey: () => true })
  emitLine('should-be-dropped')
  pop()
  const probe = readLine()
  assert.equal(await rejectAfter(probe, 20), 'pending')
  emitLine('fresh')
  assert.equal(await probe, 'fresh')
})

test('keypress 只投递栈顶', async () => {
  const log: string[] = []
  const popA = pushModal({ name: 'A', onKey: (_s, k) => (log.push(`A:${(k as any).name}`), true) })
  const popB = pushModal({ name: 'B', onKey: (_s, k) => (log.push(`B:${(k as any).name}`), true) })
  emitKey('', { name: 'up' })
  popB()
  emitKey('', { name: 'down' })
  popA()
  assert.deepEqual(log, ['B:up', 'A:down'])
})

test('interruptWaiters：关模态(onClose) + null 唤醒挂着的 readLine', async () => {
  let closedByInterrupt = 0
  pushModal({ name: 'confirm', onClose: () => (closedByInterrupt += 1) })
  const hung = readLine()
  const woken = interruptWaiters()
  assert.equal(closedByInterrupt, 1)
  assert.equal(modalDepth(), 0)
  assert.ok(woken >= 1)
  assert.equal(await hung, null)
})

test('onGlobalKey：无模态时 keypress 走全局表，有模态时被栈顶截胡', () => {
  let hits = 0
  const off = onGlobalKey((_s, k) => (k.name === 'g' ? ((hits += 1), true) : false))
  emitKey('', { name: 'g' })
  assert.equal(hits, 1)
  const pop = pushModal({ name: 'block', onKey: () => true })
  emitKey('', { name: 'g' })
  assert.equal(hits, 1) // 模态在顶，全局表收不到
  pop()
  off()
  emitKey('', { name: 'g' })
  assert.equal(hits, 1) // 注销后不再计
})

test('deliverLine：把行注入等待中的 readLine（快捷键模态交还 REPL）', async () => {
  const waiter = readLine()
  deliverLine('/resume abc')
  assert.equal(await waiter, '/resume abc')
})

test('flushTypedInput：向 readline 注入 Ctrl+U 清残字（单 key 对象，非数组）', () => {
  const before = rl.writes.length
  flushTypedInput()
  assert.equal(rl.writes.length, before + 1)
  const args = rl.writes[before]
  assert.equal(args[0], null)
  assert.deepEqual(args[1], { ctrl: true, name: 'u' })
})

test('EOF(close)：模态与等待者全部结算为 null/关闭', async () => {
  let onClose = 0
  pushModal({ name: 'x', onClose: () => (onClose += 1) })
  const hung = readLine()
  rl.emit('close')
  assert.equal(onClose, 1)
  assert.equal(await hung, null)
  assert.equal(await readLine(), null)
})

test('onModalChange：push/close/interruptWaiters 广播模态深度', () => {
  const depths: number[] = []
  const off = onModalChange(depth => depths.push(depth))
  const pop = pushModal({ name: 'm' })
  pushModal({ name: 'm2' })
  pop()
  interruptWaiters()
  off
  assert.deepEqual(depths.slice(0, 4), [1, 2, 1, 0])
})

test('onExternalWrite：readLine 带 prompt 时在写提示符前广播', () => {
  const order: string[] = []
  let promptWrite = 0
  const off = onExternalWrite(() => order.push('notify'))
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((data: unknown) => { promptWrite += 1; order.push('write'); return true }) as typeof process.stdout.write
  try {
    void readLine('x')
  } finally {
    process.stdout.write = origWrite
  }
  off
  assert.deepEqual(order.slice(0, 2), ['notify', 'write'])
  assert.equal(promptWrite, 1)
})
