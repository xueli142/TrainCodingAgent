import { listTraceFiles, readTraceEntries } from './context-tracer.js'

/**
 * 用法：
 *   npx tsx src/inspect-trace.ts                     列出最近 trace 文件
 *   npx tsx src/inspect-trace.ts --turn 3            查看第 3 轮请求的完整上下文摘要（默认最后一轮）
 *   npx tsx src/inspect-trace.ts --file <path>       指定 trace 文件
 *   npx tsx src/inspect-trace.ts --raw --turn 2      输出该轮完整 JSON
 *   npx tsx src/inspect-trace.ts --tools             该轮 tool_use↔tool_result 全量原文
 *   npx tsx src/inspect-trace.ts --tools-all         所有轮次的工具原文
 *   npx tsx src/inspect-trace.ts --diff              最后两轮对比：哪部分上下文涨了
 */

type BlockSummary = {
  type: string
  chars: number
  preview: string
}

function summarizeBlock(block: unknown): BlockSummary {
  const b = (block ?? {}) as Record<string, unknown>
  const type = typeof b.type === 'string' ? b.type : 'unknown'
  let body = ''
  if (typeof b.text === 'string') body = b.text
  else if (typeof b.content === 'string') body = b.content
  else if (b.input !== undefined) body = JSON.stringify(b.input)
  const chars = JSON.stringify(block).length
  const preview = body.replace(/\s+/g, ' ').slice(0, 90)
  return { type, chars, preview }
}

function formatEntry(entry: Awaited<ReturnType<typeof readTraceEntries>>[number]): void {
  console.log(`# turn ${entry.turn}  ${entry.ts}  model=${entry.model}`)
  console.log(`system ${entry.systemChars} chars | messages json ${entry.messagesChars} chars | tools+total ${entry.totalChars} chars\n`)

  console.log('--- system (head 600) ---')
  console.log(entry.system.slice(0, 600).replace(/^/gm, '  ') + (entry.system.length > 600 ? '\n  ...(截断)' : ''))

  console.log('\n--- messages ---')
  const messages = entry.messages as Array<{ role?: string; content?: unknown }>
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]
    for (const block of blocks) {
      const s = summarizeBlock(block)
      console.log(`  [${i}] ${m.role ?? '?'} | ${s.type} | ${s.chars}c | ${s.preview}`)
    }
  }

  console.log('\n--- tools ---')
  for (const tool of entry.tools) {
    console.log(`  ${tool.name}  desc=${tool.descChars}c schema=${tool.schemaChars}c`)
  }
}

function formatTools(
  entry: Awaited<ReturnType<typeof readTraceEntries>>[number],
  bodyLimit = 3000,
): void {
  console.log(`# turn ${entry.turn}  ${entry.ts}  tool 原文`)
  const messages = entry.messages as Array<{ role?: string; content?: unknown }>
  const blocks = messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])) as Array<
    Record<string, unknown>
  >
  const useById = new Map(
    blocks
      .filter(b => b.type === 'tool_use')
      .map(b => [b.id as string, b]),
  )

  let hits = 0
  for (const block of blocks) {
    if (block.type !== 'tool_result') {
      continue
    }
    hits += 1
    const use = useById.get(block.tool_use_id as string)
    const name = (use?.name as string | undefined) ?? (block.name as string | undefined) ?? '?'
    console.log(`\n--- ${name}  tool_use_id=${block.tool_use_id}  is_error=${Boolean(block.is_error)}`)
    if (use?.input !== undefined) {
      console.log(`input:  ${JSON.stringify(use.input)}`)
    }
    let body = block.content
    if (typeof body !== 'string') {
      body = JSON.stringify(body)
    }
    const text = body as string
    console.log(`output: ${text.slice(0, bodyLimit)}${text.length > bodyLimit ? `\n...(${text.length}c 全量，其余见 --raw)` : ''}`)
  }
  if (hits === 0) {
    console.log('  (本轮请求的 messages 里没有 tool_result——它们是上一轮的输出，看前一轮)')
  }
}

function diffEntries(
  a: Awaited<ReturnType<typeof readTraceEntries>>[number],
  b: Awaited<ReturnType<typeof readTraceEntries>>[number],
): void {
  console.log(`turn ${a.turn} -> ${b.turn}:`)
  console.log(`  system   ${a.systemChars} -> ${b.systemChars} (${b.systemChars - a.systemChars >= 0 ? '+' : ''}${b.systemChars - a.systemChars}) ${a.system === b.system ? '(未变化)' : '(有变化!)'}`)
  console.log(`  messages ${a.messagesChars} -> ${b.messagesChars} (${b.messagesChars - a.messagesChars >= 0 ? '+' : ''}${b.messagesChars - a.messagesChars})`)
  const aCount = JSON.stringify(a.messages).match(/"role":/g)?.length ?? 0
  const bCount = JSON.stringify(b.messages).match(/"role":/g)?.length ?? 0
  console.log(`  message块数 ${aCount} -> ${bCount}`)
  const names = (e: typeof b) => e.tools.map(t => t.name).join(',')
  console.log(`  tools    ${names(a) === names(b) ? '(同一组)' : `${names(a)} -> ${names(b)}`}, chars ${a.tools.reduce((s, t) => s + t.schemaChars + t.descChars, 0)} -> ${b.tools.reduce((s, t) => s + t.schemaChars + t.descChars, 0)}`)
}

const argv = process.argv.slice(2)
const flagValueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const files = await listTraceFiles()
if (files.length === 0) {
  console.log('No trace files. Start with `pnpm dev -- --trace` (or pass --trace to node src/index.ts).')
  process.exit(0)
}

const fileArg = flagValueOf('--file')
const file =
  !fileArg || fileArg === 'latest'
    ? files[files.length - 1]!
    : fileArg

const entries = await readTraceEntries(file)
if (entries.length === 0) {
  console.log(`trace file empty or unreadable: ${file}`)
  process.exit(1)
}

console.log(`trace: ${file} (${entries.length} turns)\n`)

if (argv.includes('--diff')) {
  if (entries.length < 2) {
    console.log('need >= 2 turns to diff')
  } else {
    diffEntries(entries[entries.length - 2]!, entries[entries.length - 1]!)
  }
  process.exit(0)
}

const turnArg = flagValueOf('--turn')
const target = turnArg ? entries.find(e => e.turn === Number(turnArg)) : entries.at(-1)
if (!target) {
  console.log(`turn ${turnArg} not found; available: ${entries.map(e => e.turn).join(',')}`)
  process.exit(1)
}

if (argv.includes('--tools')) {
  formatTools(target)
  process.exit(0)
}

if (argv.includes('--tools-all')) {
  for (const entry of entries) {
    formatTools(entry)
    console.log()
  }
  process.exit(0)
}

if (argv.includes('--raw')) {
  console.log(JSON.stringify(target, null, 2))
} else {
  formatEntry(target)
}
