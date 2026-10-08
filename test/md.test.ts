import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPalette } from '../src/repl/ui-kit.js'
import { renderTerminalMarkdown } from '../src/repl/md.js'

const plain = createPalette(false)
const color = createPalette(true)

test('行内标记剥离：恒等调色板下得到干净文本（管道安全）', () => {
  assert.equal(renderTerminalMarkdown('这是 **重点** 与 `code` 混排', plain), '这是 重点 与 code 混排')
  assert.equal(renderTerminalMarkdown('*斜体* 和 ~~删除~~', plain), '斜体 和 删除')
  assert.equal(renderTerminalMarkdown('__双下划线__ 也粗', plain), '双下划线 也粗')
})

test('彩色调色板：bold/cyan/dim/italic 落 ANSI', () => {
  assert.equal(renderTerminalMarkdown('**b**', color), '\u001b[1mb\u001b[0m')
  assert.equal(renderTerminalMarkdown('`c`', color), '\u001b[36mc\u001b[0m')
  assert.equal(renderTerminalMarkdown('~~s~~', color), '\u001b[2ms\u001b[0m')
  assert.ok(renderTerminalMarkdown('*i*', color).includes('\u001b[3mi'))
})

test('代码围栏内原样保护，围栏行置灰', () => {
  const src = '前面\n```\nconst a = 1 * 2 ** 3\n```\n后面'
  const out = renderTerminalMarkdown(src, plain)
  assert.ok(out.includes('const a = 1 * 2 ** 3'), '围栏内容不许被动')
  const lines = out.split('\n')
  assert.ok(lines[0].includes('前面') && lines[4].includes('后面'))
})

test('链接与图片拆成 文本(url)；空文本只剩 url', () => {
  assert.equal(renderTerminalMarkdown('[官网](https://x.com)', plain), '官网(https://x.com)')
  assert.equal(renderTerminalMarkdown('[](https://x.com)', plain), 'https://x.com')
  assert.equal(renderTerminalMarkdown('![图注](https://i.png)', plain), '图注(https://i.png)')
})

test('行级规则：标题加粗、--- 转分隔线、> 置灰', () => {
  assert.equal(renderTerminalMarkdown('# 大标题', plain), '大标题')
  assert.equal(renderTerminalMarkdown('## **粗** 标题', plain), '粗 标题')
  assert.equal(renderTerminalMarkdown('# H', color), '\u001b[1mH\u001b[0m')
  assert.equal(renderTerminalMarkdown('---', plain), '─'.repeat(48))
  assert.equal(renderTerminalMarkdown('> 引用一句', plain), '│ 引用一句')
})

test('snake_case 与数学星号不误伤', () => {
  assert.equal(renderTerminalMarkdown('user_name 和 some_value 保持', plain), 'user_name 和 some_value 保持')
  assert.equal(renderTerminalMarkdown('2 * 3 = 6', plain), '2 * 3 = 6')
})

test('普通中文段落零改动（幂等）', () => {
  const s = '这是一段普通说明。\n- 列表项一\n- 列表项二\n\n| a | b |\n|---|---|\n'
  assert.equal(renderTerminalMarkdown(s, plain), s)
  assert.equal(renderTerminalMarkdown(renderTerminalMarkdown(s, plain), plain), s)
})

test('行内代码内的星号/下划线不参与外层解析', () => {
  assert.equal(renderTerminalMarkdown('用 `a*b*c` 表示', plain), '用 a*b*c 表示')
})
