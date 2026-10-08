import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

// config.ts 模块加载即读 env，必须先指到临时目录再动态 import 任何 src 模块
process.env.ICEFOX_CODE_HOME = mkdtempSync(path.join(os.tmpdir(), 'icefox-test-'))

const { agentloop, LOOP_GUARD_AFTER_REPEATS } = await import('../src/agent_loop.js')
const { registerTool } = await import('../src/tools/index.js')
const {
  replaceLargeToolResult,
  applyToolResultBudget,
  createContentReplacementState,
} = await import('../src/utils/tool-result.js')

function stubTool(name: string, onRun?: () => void) {
  registerTool({
    name,
    description: 'test stub',
    inputSchema: { type: 'object' },
    schema: z.unknown(),
    async run() {
      onRun?.()
      return { ok: true, output: `stub:${name} ran` }
    },
  })
}

function scriptModel(steps: unknown[]) {
  const queue = [...steps]
  return {
    async next(): Promise<any> {
      if (queue.length === 0) {
        return { type: 'assistant', content: 'fallback done', kind: 'final' }
      }
      return queue.shift()
    },
  }
}

function toolCallStep(id: string, toolName: string, input: unknown) {
  return { type: 'tool_calls', calls: [{ id, toolName, input }] }
}

function baseMessages() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'tool', content: 'catalog' },
    { role: 'user', content: 'hi', id: 'u1' },
  ] as any[]
}

test('agentloop 收据合约：addedCount 与 messages 增量一致且无双推', async () => {
  stubTool('t_receipt')
  const messages = baseMessages()
  const before = messages.length
  const receipt = await agentloop({
    model: scriptModel([
      toolCallStep('call_1', 't_receipt', {}),
      { type: 'assistant', content: 'all done', kind: 'final' },
    ]),
    messages,
    cwd: process.cwd(),
  })

  assert.equal(receipt.kind, 'final')
  assert.equal(receipt.addedCount, messages.length - before)
  // 无双推：每个消息对象在数组里只出现一次（对象身份唯一）
  assert.equal(new Set(messages).size, messages.length)
  // tool_use/tool_result 配对存在于上下文
  const roles = messages.map(m => m.role)
  assert.ok(roles.includes('assistant_tool_call'))
  assert.ok(roles.includes('tool_result'))
  assert.equal(messages.at(-1).role, 'assistant')
})

test('loop-guard：相同调用第 N 次注入警告且只注入一次', async () => {
  let runs = 0
  stubTool('t_guard', () => { runs += 1 })
  const steps = []
  for (let i = 0; i < LOOP_GUARD_AFTER_REPEATS + 1; i++) {
    steps.push(toolCallStep(`g_${i}`, 't_guard', { same: true }))
  }
  steps.push({ type: 'assistant', content: 'stop repeating', kind: 'final' })

  const messages = baseMessages()
  const receipt = await agentloop({
    model: scriptModel(steps),
    messages,
    cwd: process.cwd(),
    maxSteps: 20,
  })

  assert.equal(runs, LOOP_GUARD_AFTER_REPEATS + 1)
  assert.equal(receipt.kind, 'final')
  const guarded = messages.filter(
    m => m.role === 'tool_result' && String(m.content).includes('[loop-guard]'),
  )
  assert.equal(guarded.length, 1)
})

test('tool-result 双层预算：单条替换 + 字节级稳定复放 + 批量总闸', async () => {
  const state = createContentReplacementState()
  const big = 'x'.repeat(60_000)
  const payload = { role: 'tool_result' as const, toolUseId: 'tu_stable', toolName: 'stub', isError: false }

  const first = await replaceLargeToolResult({ ...payload, content: big }, state)
  assert.ok(first.content.length < big.length, '超阈值应被替换')
  assert.ok(String(first.content).includes('<persisted-output>'))

  const second = await replaceLargeToolResult({ ...payload, content: big }, state)
  assert.equal(second.content, first.content, '同 toolUseId 跨请求必须字节级一致')

  // 批量层：每条都低于单条阈值，但总量超 200k → 应触发按大小降序替换
  const batch = []
  for (let i = 0; i < 5; i++) {
    batch.push({
      role: 'tool_result',
      toolUseId: `tu_batch_${i}`,
      toolName: 'stub',
      isError: false,
      content: String.fromCharCode(97 + i).repeat(49_000),
    } as any)
  }
  const budgeted = await applyToolResultBudget(batch, state)
  const total = budgeted.results.reduce((sum, r) => sum + String(r.content).length, 0)
  assert.ok(total < 200_000, `批量预算后总量应回落到 200k 内，实际 ${total}`)
  assert.ok(budgeted.newlyReplaced.length > 0)

  // 预算复放同样字节级稳定
  const replay = await applyToolResultBudget(batch, state)
  for (let i = 0; i < replay.results.length; i++) {
    assert.equal(replay.results[i].content, budgeted.results[i].content)
  }
})

test('abort：信号在 step 前已置起 → 零执行直接收据收尾', async () => {
  let runs = 0
  stubTool('t_pre', () => { runs += 1 })
  const controller = new AbortController()
  controller.abort()

  const messages = baseMessages()
  const receipt = await agentloop({
    model: scriptModel([toolCallStep('p1', 't_pre', {})]),
    messages,
    cwd: process.cwd(),
    signal: controller.signal,
  })

  assert.equal(receipt.kind, 'aborted')
  assert.equal(receipt.addedCount, 0)
  assert.equal(runs, 0)
})

test('abort：批中途取消 → 剩余调用补配对 cancelled 结果，无孤儿 tool_use', async () => {
  const controller = new AbortController()
  let runs = 0
  registerTool({
    name: 't_mid',
    description: 'aborting stub',
    inputSchema: { type: 'object' },
    schema: z.unknown(),
    async run() {
      runs += 1
      controller.abort()
      return { ok: true, output: 'first ran then user hit Ctrl+C' }
    },
  })

  const messages = baseMessages()
  const receipt = await agentloop({
    model: scriptModel([
      {
        type: 'tool_calls',
        calls: [
          { id: 'm1', toolName: 't_mid', input: {} },
          { id: 'm2', toolName: 't_mid', input: {} },
        ],
      },
    ]),
    messages,
    cwd: process.cwd(),
    signal: controller.signal,
  })

  assert.equal(receipt.kind, 'aborted')
  assert.equal(runs, 1)
  const callIds = messages.filter(m => m.role === 'assistant_tool_call').map(m => (m as any).toolUseId)
  const results = messages.filter(m => m.role === 'tool_result')
  assert.deepEqual([...callIds].sort(), results.map(m => (m as any).toolUseId).sort())
  assert.ok(results.some(m => m.isError && String(m.content).includes('aborted')))
})

test('工具回调事件流：start/result 成对有序、字段齐全、批内 index/total 正确', async () => {
  stubTool('t_events')
  const events: Array<{ type: string; id?: string; [k: string]: unknown }> = []
  const messages = baseMessages()
  await agentloop({
    model: scriptModel([
      {
        type: 'tool_calls',
        calls: [
          { id: 'e1', toolName: 't_events', input: { a: 1 } },
          { id: 'e2', toolName: 't_events', input: { a: 2 } },
        ],
      },
      { type: 'assistant', content: 'done', kind: 'final' },
    ]),
    messages,
    cwd: process.cwd(),
    onModelStart: step => events.push({ type: 'model', step }),
    onToolStart: info => events.push({ type: 'start', ...info }),
    onToolResult: info => events.push({ type: 'result', ...info }),
  })

  const starts = events.filter(e => e.type === 'start') as any[]
  const results = events.filter(e => e.type === 'result') as any[]
  assert.deepEqual(starts.map(s => s.toolUseId), ['e1', 'e2'])
  assert.deepEqual(results.map(r => r.toolUseId), ['e1', 'e2'])
  assert.deepEqual(starts.map(s => [s.index, s.total]), [[1, 2], [2, 2]])
  // start 严格先于同名 result
  assert.ok(events[1]?.type === 'start' && events[2]?.type === 'result')
  assert.equal(starts[0].toolName, 't_events')
  assert.deepEqual(starts[0].input, { a: 1 })
  assert.ok(results.every(r => r.ok === true && typeof r.durationMs === 'number' && r.durationMs >= 0))
  // model 回调在每步最前（step0 首发、step1 收尾前）
  assert.deepEqual(events.filter(e => e.type === 'model').map(e => (e as any).step), [0, 1])
})

test('工具回调：abort 后跳过的调用不发 start 也不发 result', async () => {
  const controller = new AbortController()
  registerTool({
    name: 't_skipcb',
    description: 'aborting stub',
    inputSchema: { type: 'object' },
    schema: z.unknown(),
    async run() {
      controller.abort()
      return { ok: true, output: 'ran once' }
    },
  })
  const seen: string[] = []
  await agentloop({
    model: scriptModel([
      {
        type: 'tool_calls',
        calls: [
          { id: 's1', toolName: 't_skipcb', input: {} },
          { id: 's2', toolName: 't_skipcb', input: {} },
        ],
      },
    ]),
    messages: baseMessages(),
    cwd: process.cwd(),
    signal: controller.signal,
    onToolStart: info => seen.push(`start:${info.toolUseId}`),
    onToolResult: info => seen.push(`result:${info.toolUseId}:${info.ok}`),
  })
  assert.deepEqual(seen, ['start:s1', 'result:s1:true'])
})
