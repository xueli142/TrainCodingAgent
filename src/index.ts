/**
 * 入口薄壳：装配根 + REPL 循环。
 * 装配时序纪律（AGENTS.md 纪律 5）：initRegistry → skills → permissions.whenReady
 *   → connectMcpServers（工具进 registry）→ new adapter(getToolSchemas 快照)——顺序不能变。
 * REPL 组件在 src/repl/（context/status/turn/slash/hotkeys），question 接线在 src/question-ui.ts。
 */
import { setDefaultResultOrder } from 'node:dns'
import readline from 'node:readline'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { buildToolCatalogMessage, getToolSchemas, initRegistry } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { PermissionManager } from './permissionManager.js'
import { createPermissionPromptHandler } from './permissionUi.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import type { ChatMessage } from './type.js'
import { enableTrace, flushTrace } from './context-tracer.js'
import { MODEL, API_KEY, BASE_URL, loadMcpConfig, ICEFOX_CODE_DIR } from './config.js'
import { createContentReplacementState, pruneToolResults } from './utils/tool-result.js'
import { discoverSkills, formatSkillsForPrompt } from './tools/tool/index.js'
import { buildProcessEnvironment, buildProjectEnvironment, renderEnvironmentBlock } from './environment.js'
import {
  flushSessionSaves,
  listSessions,
  newSessionId,
  resolveSessionId,
  resumeMessages,
  sessionFilePath,
} from './session.js'
import { attachInputSource, interruptWaiters, readLine } from './tty-prompt.js'
import { formatTokens, hydrateModelContextWindow } from './utils/token-estimator.js'
import { connectMcpServers, disposeMcp } from './mcp.js'
import { installQuestionHandler } from './question-ui.js'
import type { ReplContext } from './repl/context.js'
import { handleSlash, slashCompleter } from './repl/slash.js'
import { registerIdleHotkeys } from './repl/hotkeys.js'
import { captureContextSnapshot, runTurn } from './repl/turn.js'
import { statusLine } from './repl/status.js'
import { abortActiveTurnRenderer, setTuiMode } from './repl/renderer.js'

setDefaultResultOrder('ipv4first')
initRegistry()
installQuestionHandler()

const argv = process.argv.slice(2)
// 回合渲染模式：--inline 追加式 / --tui 活区（默认 live）；ICEFOX_TUI=inline 同级兜底，非 TTY 自动退化
if (argv.includes('--inline') || process.env.ICEFOX_TUI === 'inline') {
  setTuiMode('inline')
} else {
  setTuiMode('live')
}
const procEnv = buildProcessEnvironment()
const projectEnv = buildProjectEnvironment(process.cwd(), procEnv)

function flagValue(flag: string): string | undefined | null {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const next = argv[index + 1]
  return next && !next.startsWith('--') ? next : ''
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const skillsBlock = formatSkillsForPrompt(await discoverSkills(cwd))

  //只列会话不进 REPL
  if (argv.includes('--sessions')) {
    const sessions = await listSessions(cwd)
    if (sessions.length === 0) {
      console.log('No saved sessions for this project.')
      return
    }
    sessions.forEach((session, i) => {
      const when = new Date(session.updatedAt).toLocaleString()
      console.log(`${i + 1}. ${session.id}  ${when}  ${session.eventCount} events  ${session.title ?? ''}`)
    })
    return
  }

  const permissions = new PermissionManager(cwd, createPermissionPromptHandler())
  //等待磁盘权限加载完
  await permissions.whenReady()

  //MCP 工具必须在 model 构造（快照 getToolSchemas）之前注册进 registry
  await connectMcpServers(await loadMcpConfig(cwd))

  const model = new AnthropicModelAdapter(getToolSchemas())

  // 真实窗口：向 provider 的模型列表接口问一次（不再只靠内置表）；失败静默回退，不阻塞启动
  const modelWindow = await hydrateModelContextWindow(MODEL, {
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    modelsUrl: process.env.MODELS_URL,
    timeoutMs: 5_000,
  }).catch(() => undefined)
  console.log(
    modelWindow
      ? `\u001b[2m[model] ${MODEL} 窗口 ${formatTokens(modelWindow.contextWindow)} · 输入预算 ${formatTokens(modelWindow.effectiveInput)}（来自 /models）\u001b[0m`
      : `\u001b[2m[model] 未能从接口获取 ${MODEL} 的真实窗口，回退 1M 兜底\u001b[0m`,
  )

  // ── reader 先行：resume 交互与后续 REPL 共用单读者通道 ──
  const historyFile = path.join(ICEFOX_CODE_DIR, 'history.jsonl')
  const inputHistory: string[] = (await readFile(historyFile, 'utf8').catch(() => ''))
    .split('\n')
    .map(line => {
      try {
        return String((JSON.parse(line) as { input?: unknown }).input ?? '')
      } catch {
        return ''
      }
    })
    .filter(Boolean)
    .slice(0, 200)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: inputHistory,
    historySize: 200,
    completer: slashCompleter,
  })
  attachInputSource(rl)
  void pruneToolResults().catch(() => {})

  const ctx: ReplContext = {
    cwd,
    projectRoot: projectEnv.root,
    model,
    permissions,
    toolResultState: createContentReplacementState(),
    historyFile,
    sessionId: newSessionId(),
    messages: [],
    activeTurn: null,
    systemContent: async () =>
      buildSystemPrompt(cwd, permissions.getSummary(), renderEnvironmentBlock(procEnv, projectEnv, MODEL), skillsBlock),
  }

  const flushOnExit = async () => {
    await flushTrace()
    await flushSessionSaves()
    await disposeMcp()
  }

  // ── Ctrl+C 语义：回合中=取消当前回合（打审批卡/杀掉 signal 感知工具）；空闲/再按一次=退出 ──
  const onCtrlC = () => {
    if (ctx.activeTurn && !ctx.activeTurn.signal.aborted) {
      ctx.activeTurn.abort()
      const woken = interruptWaiters()
      // 先让本回合渲染器静默收尾（停 timer、放弃行所有权），[interrupt] 才落在干净位置
      abortActiveTurnRenderer()
      console.log(`\n[interrupt] 已取消当前回合${woken > 0 ? `（${woken} 张待答卡按拒绝处理）` : ''}`)
      return
    }
    void flushOnExit().finally(() => process.exit(130))
  }
  rl.on('SIGINT', onCtrlC)
  process.on('SIGINT', onCtrlC)
  process.on('SIGTERM', () => {
    void flushOnExit().finally(() => process.exit(143))
  })

  registerIdleHotkeys(ctx)

  // ── 启动 --resume：裸参数进编号选择 ──
  let restored: ChatMessage[] = []
  const resumeArg = flagValue('--resume')
  if (resumeArg !== undefined) {
    const sessions = await listSessions(cwd)
    let target: string | undefined
    if (resumeArg) {
      target = resolveSessionId(sessions, resumeArg)
    } else if (sessions.length > 0) {
      console.log('\nsessions:')
      sessions.forEach((s, i) => console.log(`  ${i + 1}. ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.title ?? ''}`))
      const chosenLine = (await readLine('输入序号或 id 前缀（回车取最新）: '))?.trim()
      target = !chosenLine ? sessions[0]?.id : resolveSessionId(sessions, chosenLine)
    }
    if (!target) {
      console.error('No saved session to resume.')
      process.exitCode = 1
      return
    }
    const loaded = await resumeMessages(cwd, target)
    if (!loaded) {
      console.error(`Session ${target} not found or empty.`)
      process.exitCode = 1
      return
    }
    ctx.sessionId = target
    restored = loaded
  }

  ctx.messages = [
    { role: 'system', content: await ctx.systemContent() },
    buildToolCatalogMessage(),
    ...restored,
  ]

  console.log(`[session ${ctx.sessionId}] ${restored.length > 0 ? `resumed ${restored.length} messages` : 'new'}`)
  console.log(`project: ${projectEnv.root}${projectEnv.isGitRepo ? ' (git)' : ''}`)
  console.log(`store: ${sessionFilePath(cwd, ctx.sessionId)}`)

  if (process.env.ICEFOX_TRACE !== '0') {
    const traceFile = await enableTrace(ctx.sessionId)
    console.log(`trace: ${traceFile}`)
  }

  await captureContextSnapshot(ctx)

  // ── REPL 主循环：状态行 + 提示符 → slash 分发或跑一个回合 ──
  try {
    while (true) {
      const raw = await readLine(`${statusLine(ctx)}\n> `)
      if (raw === null) {
        break // EOF（Ctrl+D / 管道关闭）：退出循环，走 flushOnExit
      }
      const input = raw.trim()
      if (!input) {
        continue
      }
      if (input.startsWith('/')) {
        const action = await handleSlash(ctx, input)
        if (action === 'exit') break
        if (action === 'continue') continue
        // passthrough：未识别的 /xxx 按普通输入交给模型（与旧行为一致）
      }
      await runTurn(ctx, input)
    }
  } finally {
    await flushOnExit()
  }

  rl.close()
}

main().catch(error => {
  console.error(error)
  //启动段（try/finally 之前）抛错也尽力 flush：trace/会话/MCP 子进程
  void Promise.allSettled([flushTrace(), flushSessionSaves(), disposeMcp()]).finally(() => {
    process.exitCode = 1
  })
})
