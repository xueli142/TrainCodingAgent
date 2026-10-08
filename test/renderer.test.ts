import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineCanvas, displayWidth, summarizeToolInput, truncateToWidth } from '../src/repl/ui-kit.js'
import { createTurnRenderer } from '../src/repl/renderer.js'
import type { ToolResultInfo, ToolStartInfo, TurnRenderer } from '../src/repl/ui-kit.js'

function startInfo(over: Partial<ToolStartInfo> = {}): ToolStartInfo {
  return { toolUseId: 't1', toolName: 'bash', input: { command: 'ls -al' }, index: 1, total: 1, ...over }
}
function resultInfo(over: Partial<ToolResultInfo> = {}): ToolResultInfo {
  return { toolUseId: 't1', toolName: 'bash', ok: true, durationMs: 1500, index: 1, total: 1, ...over }
}

type Harness = {
  ui: TurnRenderer
  chunks: string[]
  all: () => string
  advance: (ms: number) => void
  tick: () => void
  last: () => string
}

function makeHarness(
  mode: 'inline' | 'live',
  opts: { tty?: boolean } = {},
): Harness {
  const chunks: string[] = []
  const timers: Array<() => void> = []
  let clock = 1_000
  const ui = createTurnRenderer({
    mode,
    write: data => { chunks.push(data) },
    isTTY: opts.tty ?? true,
    color: false,
    columns: () => 80,
    rows: () => 24,
    statusLine: () => 'FOOTER',
    setTimer: fn => {
      timers.push(fn)
      return () => {
        const i = timers.indexOf(fn)
        if (i >= 0) timers.splice(i, 1)
      }
    },
    now: () => clock,
    onResize: () => () => {},
  })
  return {
    ui,
    chunks,
    all: () => chunks.join(''),
    advance: ms => { clock += ms },
    tick: () => { for (const fn of [...timers]) fn() },
    last: () => chunks[chunks.length - 1] ?? '',
  }
}

// ── LineCanvas：差分回写的核心语义，逐 escape 断言 ──

test('LineCanvas：首帧纯 append，二次 paint 只重写变化行', () => {
  const chunks: string[] = []
  const canvas = new LineCanvas(data => chunks.push(data), true, s => s)
  canvas.paint(['A', 'B'])
  assert.equal(chunks[0], 'A\nB\n')
  canvas.paint(['A', 'C'])
  // 上移 2 行 → 第 0 行未变只下移(1E) → 第 1 行清行重写
  assert.equal(chunks[1], '\u001b[2A\u001b[1E\u001b[2KC\n')
})

test('LineCanvas：块变高补写新行，变矮清掉残行', () => {
  const chunks: string[] = []
  const canvas = new LineCanvas(data => chunks.push(data), true, s => s)
  canvas.paint(['A'])
  canvas.paint(['AB', 'CD'])
  assert.equal(chunks[1], '\u001b[1A\u001b[2KAB\u001b[1E\u001b[2KCD\n')
  canvas.paint(['X'])
  assert.equal(chunks[2], '\u001b[2A\u001b[2KX\u001b[1E\u001b[2K\n')
})

test('LineCanvas：commit 后放弃所有权，paint 重新纯 append（不回写别人的行）', () => {
  const chunks: string[] = []
  const canvas = new LineCanvas(data => chunks.push(data), true, s => s)
  canvas.paint(['A'])
  canvas.commit()
  canvas.paint(['B'])
  assert.equal(chunks[1], 'B\n')
  assert.ok(!chunks[1].includes('\u001b'))
})

test('LineCanvas：非 TTY 一律退化为普通 append，无 ANSI', () => {
  const chunks: string[] = []
  const canvas = new LineCanvas(data => chunks.push(data), false, s => s)
  canvas.paint(['A', 'B'])
  canvas.paint(['A', 'C'])
  assert.deepEqual(chunks, ['A\nB\n', 'A\nC\n'])
})

// ── 宽度工具 ──

test('displayWidth/truncateToWidth：CJK 计 2 列，ANSI 计 0，截断补 …', () => {
  assert.equal(displayWidth('中文'), 4)
  assert.equal(displayWidth('\u001b[2mx\u001b[0m'), 1)
  const t = truncateToWidth('中文中文', 3)
  assert.equal(t, '中…')
  assert.ok(displayWidth(t) <= 3)
})

test('summarizeToolInput：按工具认字段，未知工具 JSON 兜底并截断', () => {
  assert.equal(summarizeToolInput('bash', { command: 'git status --short' }), 'git status --short')
  assert.equal(summarizeToolInput('read', { filePath: 'src/index.ts' }), 'src/index.ts')
  assert.equal(summarizeToolInput('grep', { pattern: 'foo', path: 'src' }), 'foo @ src')
  assert.equal(summarizeToolInput('webfetch', { url: 'https://a.b' }), 'https://a.b')
  assert.equal(summarizeToolInput('mcp__x__y', { weird: 123 }), '{"weird":123}')
  const long = summarizeToolInput('bash', { command: 'x'.repeat(300) })
  assert.ok(long.length < 110 && long.endsWith('…'))
})

// ── inline：transient 单行 + 弹卡后不回写 ──

test('inline：Thinking 转圈行原地回写，tick 换帧', () => {
  const h = makeHarness('inline')
  h.ui.onModelStart(0)
  assert.equal(h.chunks[0], '⠋ Thinking… 0s\n')
  h.advance(1000)
  h.tick()
  assert.equal(h.last(), '\u001b[1A\u001b[2K⠙ Thinking… 1s\n')
})

test('inline：工具 ▸ 行被 ✔ 原地改写（没人插话时）', () => {
  const h = makeHarness('inline')
  h.ui.onToolStart(startInfo())
  assert.equal(h.last(), '▸ bash: ls -al…\n')
  h.ui.onToolResult(resultInfo())
  assert.equal(h.last(), '\u001b[1A\u001b[2K✔ bash: ls -al 1.5s\n')
})

test('inline：审批卡插话（commitForModal）后结果行改追加，不再回写', () => {
  const h = makeHarness('inline')
  h.ui.onToolStart(startInfo())
  h.ui.commitForModal() // 模拟 picker 弹出前的落历史
  h.ui.onToolResult(resultInfo())
  assert.equal(h.last(), '✔ bash: ls -al 1.5s\n')
  assert.ok(!h.last().includes('\u001b[1A'))
})

test('inline：assistant/thinking/notice 走追加并让出 transient；finish 打 ⏱ 汇总', () => {
  const h = makeHarness('inline')
  h.ui.onModelStart(0)
  h.ui.onThinking('deep **alpha** thought')
  assert.ok(h.last().includes('[thinking] deep alpha thought'), 'thinking 预览也走 Markdown 渲染（color:false 剥标记）')
  h.ui.onAssistant('final **x**')
  assert.ok(h.last().includes('final x'), 'assistant 正文走 Markdown 渲染')
  h.ui.onToolStart(startInfo())
  h.ui.onToolResult(resultInfo())
  h.ui.finish({ kind: 'final', elapsedMs: 12_345, toolCalls: 2 })
  assert.ok(h.last().includes('⏱ 12.3s · 2 tool calls'))
})

test('inline 非 TTY：无 spinner/工具行/ANSI，只剩正文追加', () => {
  const h = makeHarness('inline', { tty: false })
  h.ui.onModelStart(0)
  h.ui.onToolStart(startInfo())
  h.ui.onToolResult(resultInfo())
  h.advance(5000)
  h.ui.finish({ kind: 'final', elapsedMs: 5000, toolCalls: 1 })
  h.ui.onAssistant('answer')
  assert.equal(h.all(), '\nanswer\n')
})

// ── live：活区帧 = 工具卡片 + busy + FOOTER，差分只重写变化行 ──

test('live：Thinking+footer 起块；进工具后 FOOTER 未变不重画', () => {
  const h = makeHarness('live')
  h.ui.onModelStart(0)
  assert.equal(h.chunks[0], '⠋ Thinking… 0s\nFOOTER\n')
  h.ui.onToolStart(startInfo())
  assert.ok(h.last().includes('\u001b[2A'))
  assert.ok(h.last().includes('▸ bash: ls -al'))
  assert.ok(!h.last().includes('FOOTER'), '未变化的 footer 不应被重写')
})

test('live：running 卡片行随 tick 长计时，result 原地 ✔', () => {
  const h = makeHarness('live')
  h.ui.onModelStart(0)
  h.ui.onToolStart(startInfo())
  h.advance(1000)
  h.tick()
  assert.ok(h.last().includes('▸ bash: ls -al… 1.0s'))
  h.ui.onToolResult(resultInfo({ durationMs: 1500 }))
  assert.ok(h.last().includes('✔ bash: ls -al 1.5s'))
  assert.ok(h.last().startsWith('\u001b[2A'))
})

test('live：批内多调用 (i/n) 各占一行，完成行留在块里', () => {
  const h = makeHarness('live')
  h.ui.onModelStart(0)
  h.ui.onToolStart(startInfo({ toolUseId: 'a', index: 1, total: 2 }))
  h.ui.onToolStart(startInfo({ toolUseId: 'b', index: 2, total: 2 }))
  h.ui.onToolResult(resultInfo({ toolUseId: 'b', index: 2, total: 2 }))
  assert.ok(h.last().includes('✔ bash: ls -al (2/2)'))
  // (1/2) 行未变化 → 差分跳过不重写，但它仍存在于完整流
  assert.ok(h.all().includes('▸ bash: ls -al (1/2)'))
  assert.ok(!h.last().includes('(1/2)'), '未变化的 (1/2) 行走差分跳过')
})

test('live：commitForModal 后本批转 append-only，下一 model 步重新起块', () => {
  const h = makeHarness('live')
  h.ui.onModelStart(0)
  h.ui.onToolStart(startInfo())
  h.ui.commitForModal()
  h.ui.onToolResult(resultInfo())
  assert.ok(!h.last().includes('\u001b[1A'), '放手后不许再回写')
  h.ui.onModelStart(1)
  assert.ok(h.last().includes('⠋ Thinking…'))
})

test('live：finish 落历史——悬挂 running 盖 ✖、⏱ 汇总、块不残留', () => {
  const h = makeHarness('live')
  h.ui.onModelStart(0)
  h.ui.onToolStart(startInfo({ toolUseId: 'z' }))
  h.ui.finish({ kind: 'failed', elapsedMs: 3000, toolCalls: 1 })
  assert.ok(h.all().includes('✖ bash: ls -al <1s'))
  assert.ok(h.all().includes('⏱ 3.0s · 1 tool calls'))
  const before = h.chunks.length
  h.tick() // 收尾后 tick 不得再画任何东西
  assert.equal(h.chunks.length, before)
})

test('live + 非 TTY：工厂强制退化为 inline（管道行为零 ANSI 零卡片）', () => {
  const h = makeHarness('live', { tty: false })
  h.ui.onModelStart(0)
  h.ui.onToolStart(startInfo())
  h.ui.onToolResult(resultInfo())
  assert.equal(h.all(), '')
})
