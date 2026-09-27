import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Interface } from 'node:readline'
import { attachInputSource, interruptWaiters } from '../src/tty-prompt.js'
import { pick, setPickerWriter } from '../src/picker.js'

class FakeRl extends EventEmitter {
  write(): void {}
}
const rl = new FakeRl()
attachInputSource(rl as unknown as Interface, rl as any)

// picker 的 ANSI 块导到静默 sink（不动 process.stdout，避免吞掉测试报告器）
setPickerWriter(() => {})

const key = (name: string, extra: object = {}) =>
  rl.emit('keypress', '', { name, ...extra })

const options = [
  { key: 'y', label: 'allow once' },
  { key: 'a', label: 'allow always' },
  { label: 'deny once', danger: true },
]

test('picker: Enter 选高亮项（初始 0）', async () => {
  const p = pick({ title: 't', options })
  key('return')
  assert.equal(await p, 0)
})

test('picker: ↓ 后 Enter 选第二项', async () => {
  const p = pick({ title: 't', options })
  key('down')
  key('return')
  assert.equal(await p, 1)
})

test('picker: 单键直达 option.key（a→index 1）', async () => {
  const p = pick({ title: 't', options })
  key('a')
  assert.equal(await p, 1)
})

test('picker: 数字键一步选（3→index 2）', async () => {
  const p = pick({ title: 't', options })
  key('3')
  assert.equal(await p, 2)
})

test('picker: Esc 取消 → null', async () => {
  const p = pick({ title: 't', options })
  key('escape')
  assert.equal(await p, null)
})

test('picker: 越界方向键被夹住（连按↑仍停在 0）', async () => {
  const p = pick({ title: 't', options })
  key('up')
  key('up')
  key('return')
  assert.equal(await p, 0)
})

test('picker: interruptWaiters（Ctrl+C）经 onClose 结算为 null', async () => {
  const p = pick({ title: 't', options })
  interruptWaiters()
  assert.equal(await p, null)
})

test('picker: Enter 伴生的 line 不会漏给后续 readLine（微任务拆栈竞态）', async () => {
  const { readLine } = await import('../src/tty-prompt.js')
  const p = pick({ title: 't', options })
  key('return')
  // 真实 readline 在 Enter 时 keypress 与 line 同批到达：line 到达时模态必须仍在栈顶并丢弃它
  rl.emit('line', '')
  assert.equal(await p, 0)
  const probe = readLine()
  const raced = await Promise.race([
    probe.then(() => 'resolved'),
    new Promise(r => setImmediate(() => r('pending'))),
  ])
  assert.equal(raced, 'pending')
})
