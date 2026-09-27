import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import readline from 'node:readline'
import type { Interface } from 'node:readline'
import { attachInputSource, pushModal } from '../src/tty-prompt.js'

/**
 * 回归锁：keypress 事件由 readline 对 TTY 的自动解析发在 **input 流**上，
 * 接口对象（rl）并不转发——路由器必须订阅流本身（曾因听错对象导致 picker 全键失效）。
 * 这里用伪 TTY PassThrough + 真 readline Interface 走一遍生产同款链路。
 */
test('真 readline + 伪 TTY：转义字节驱动 stdin keypress 路由', async () => {
  const input = new PassThrough() as unknown as PassThrough & { isTTY: boolean; setRawMode?: (v: boolean) => void }
  ;(input as any).isTTY = true
  ;(input as any).setRawMode = () => input
  const output = new PassThrough()
  const rl = readline.createInterface({ input: input as any, output, terminal: true })

  const names: string[] = []
  attachInputSource(rl, input as any)
  const pop = pushModal({ name: 'probe', onKey: (_s, k) => (names.push(k.name ?? '?'), true) })

  input.write('\x1b[A') // ↑
  input.write('\x1b[B') // ↓
  input.write('j')
  await new Promise(resolve => setImmediate(resolve))
  pop()
  assert.deepEqual(names, ['up', 'down', 'j'])
  rl.close()
})

test('真 readline：无模态时同一链路喂全局键表', async () => {
  const input = new PassThrough() as any
  input.isTTY = true
  input.setRawMode = () => input
  const output = new PassThrough()
  const rl = readline.createInterface({ input, output, terminal: true })
  attachInputSource(rl, input)

  const { onGlobalKey } = await import('../src/tty-prompt.js')
  let hits = 0
  const off = onGlobalKey((_s, k) => (k.ctrl && k.name === 'g' ? ((hits += 1), true) : false))
  input.write('\x07') // Ctrl+G
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hits, 1)
  off()
  rl.close()
})
