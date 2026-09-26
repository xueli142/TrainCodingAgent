import { setDefaultResultOrder } from 'node:dns'
import readline from 'node:readline'
import path from 'node:path'
import { appendFile, readFile } from 'node:fs/promises'
import { buildToolCatalogMessage, getToolSchemas, initRegistry } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { PermissionManager, getPermissionsPath } from './permissionManager.js'
import { createPermissionPromptHandler } from './permissionUi.js'
import { agentloop } from './agent_loop.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import type { ChatMessage } from './type.js'
import { enableTrace, flushTrace } from './context-tracer.js'
import{MODEL, loadMcpConfig, ICEFOX_CODE_DIR}from './config.js'
import { createContentReplacementState, pruneToolResults } from './utils/tool-result.js'
import { discoverSkills, formatSkillsForPrompt } from './tools/tool/index.js'

import {
  buildProcessEnvironment,
  buildProjectEnvironment,
  renderEnvironmentBlock,
} from './environment.js'
import {
  appendSessionEvent,
  flushSessionSaves,
  listSessions,
  newSessionId,
  projectMessages,
  readEvents,
  resumeMessages,
  saveMessages,
  scheduleSave,
  sessionFilePath,
  appendControlEvent,
} from './session.js'
import { maybeCompactContext } from './compact.js'

setDefaultResultOrder('ipv4first')

initRegistry()
import { setQuestionHandler } from './tools/tool/index.js'
import { readLine,attachInputSource, discardQueuedInput, interruptWaiters } from './tty-prompt.js'
import { connectMcpServers, disconnectMcpServer, disposeMcp, getMcpStatus, reconnectMcpServer } from './mcp.js'

setQuestionHandler(async (questions) => {
  const answers: string[] = []
  for (const q of questions) {
    const dropped = discardQueuedInput()
    if (dropped > 0) {
      console.log(`[question] 已丢弃排队的 ${dropped} 行输入（防止抢答），需要请重新输入`)
    }
    console.log(`\n? [${q.header}] ${q.question}`)
    q.options.forEach((o, i) =>
      console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`))
    const tip = q.multiple ? '输入编号(逗号分隔)或自述，回车确认: ' : '输入编号或自述: '
    const line = await readLine(tip)
    if (line === null) throw new Error('No interactive console available') // question.ts 会捕获 → ok:false 引导模型改纯文本提问
    const raw = line.trim()
    if (!q.multiple) {
      // 单选：仅当整行是合法编号才映射成选项，否则整行原样作为自由文本（避免带空格的回答被切碎）
      const n = Number(raw)
      answers.push(Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1].label : raw)
      continue
    }
    const picked = raw.split(/[,，、\s]+/).map(s => {
      const n = Number(s)
      return Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1].label : s
    }).filter(Boolean)
    answers.push(picked.join(', '))
  }
  return answers
})

const argv = process.argv.slice(2)
const procEnv = buildProcessEnvironment()
const projectEnv = buildProjectEnvironment(process.cwd(), procEnv)
const toolResultState = createContentReplacementState()

function flagValue(flag: string): string | undefined | null {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const next = argv[index + 1]
  return next && !next.startsWith('--') ? next : ''
}

function previewMessages(messages: ChatMessage[], count = 4): string[] {  return messages
    .filter(m => m.role !== 'system' && m.role !== 'tool')
    .slice(-count)
    .map(m => {
      if (m.role === 'user') return `user: ${m.content.slice(0, 80)}`
      if (m.role === 'assistant') return `assistant: ${m.content.slice(0, 80)}`
      if (m.role === 'context_summary') return `summary: ${m.content.slice(0, 80)}...`
      if (m.role === 'tool_result') return `tool(${m.toolName})${m.isError ? ' [error]' : ''}`
      if (m.role === 'assistant_tool_call') return `call ${m.toolName}`
      return m.role
    })
}

/** 会话目标解析：序号 | 完整 id | 唯一前缀 */
function resolveSessionId(
  sessions: Array<{ id: string }>,
  arg: string,
): string | undefined {
  if (/^\d+$/.test(arg)) {
    return sessions[Number(arg) - 1]?.id
  }
  const exact = sessions.find(s => s.id === arg)
  if (exact) {
    return exact.id
  }
  const prefixHits = sessions.filter(s => s.id.startsWith(arg))
  return prefixHits.length === 1 ? prefixHits[0]?.id : undefined
}

async function main(): Promise<void> {
  const cwd = process.cwd()
  const skillsBlock = formatSkillsForPrompt(await discoverSkills(cwd))
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

  async function systemContent(): Promise<string> {
    return buildSystemPrompt(
      cwd,
      permissions.getSummary(),
      renderEnvironmentBlock(procEnv, projectEnv, MODEL),
      skillsBlock,
    )
  }

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
  })
  attachInputSource(rl)

  const flushOnExit = async () => {
    await flushTrace()
    await flushSessionSaves()
    await disposeMcp()
  }

  void pruneToolResults().catch(() => {})

  // ── Ctrl+C 语义：回合中=取消当前回合（打审批卡/杀掉 signal 感知工具）；空闲/再按一次=退出 ──
  let activeTurn: AbortController | null = null
  const onCtrlC = () => {
    if (activeTurn && !activeTurn.signal.aborted) {
      activeTurn.abort()
      const woken = interruptWaiters()
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

  let sessionId = newSessionId()
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
      const pick = (await readLine('输入序号或 id 前缀（回车取最新）: '))?.trim()
      target = !pick ? sessions[0]?.id : resolveSessionId(sessions, pick)
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
    sessionId = target
    restored = loaded
  }

  let messages: ChatMessage[] = [
    { role: 'system', content: await systemContent() },
    buildToolCatalogMessage(),
    ...restored,
  ]

  console.log(`[session ${sessionId}] ${restored.length > 0 ? `resumed ${restored.length} messages` : 'new'}`)
  console.log(`project: ${projectEnv.root}${projectEnv.isGitRepo ? ' (git)' : ''}`)
  console.log(`store: ${sessionFilePath(cwd, sessionId)}`)

  if (process.env.ICEFOX_TRACE !== '0') {
    const traceFile = await enableTrace(sessionId)
    console.log(`trace: ${traceFile}`)
  }

  await appendSessionEvent(cwd, sessionId, 'context_snapshot', {
    model: MODEL,
    project: projectEnv.root,
    system: messages[0]?.role === 'system' ? messages[0].content : '',
    catalog: messages[1]?.role === 'tool' ? messages[1].content : '',
    tools: getToolSchemas(),
  })

  await saveMessages(cwd, sessionId, messages)

  async function handleResume(arg: string): Promise<void> {
    const sessions = await listSessions(cwd)
    let target: string | undefined
    if (!arg) {
      console.log('\nsessions:')
      sessions.forEach((s, i) => console.log(`  ${i + 1}. ${s.id}  ${s.eventCount}e  ${s.title ?? ''}`))
      console.log('用法: /resume <id|序号>')
      return
    }
    target = resolveSessionId(sessions, arg)
    if (!target) {
      console.log(`session not found: ${arg}（支持序号/完整id/唯一前缀）`)
      return
    }
    if (target === sessionId) {
      console.log(`already in session ${sessionId}`)
      return
    }

    const oldEvents = await readEvents(cwd, sessionId)
    const oldProjection = projectMessages(oldEvents)
    console.log(`\n切换前会话 ${sessionId}（投影后 ${oldProjection.length} 条，模型当前可见）:`)
    for (const line of previewMessages(oldProjection, 6)) {
      console.log(`  ${line}`)
    }

    await saveMessages(cwd, sessionId, messages)
    await flushSessionSaves()
    await appendSessionEvent(cwd, sessionId, 'session_switch', { to: target, at: Date.now() })

    const loaded = await resumeMessages(cwd, target)
    if (!loaded) {
      console.log(`session ${target} empty after switch`)
      return
    }
      //在原本的数组上修改
    //messages.splice(0, messages.length, { role: 'system', content: await systemContent() }, buildToolCatalogMessage(), ...loaded)
    //新建一个数组，
    messages = [{ role: 'system', content: await systemContent() }, buildToolCatalogMessage(), ...loaded]
    sessionId = target
    await appendSessionEvent(cwd, sessionId, 'context_snapshot', {
      model: MODEL,
      project: projectEnv.root,
        system: messages[0]?.role === 'system' ? messages[0].content : '',
      catalog: messages[1]?.role === 'tool' ? messages[1].content : '',
      tools: getToolSchemas(),
    })
    await saveMessages(cwd, sessionId, messages)

    console.log(`已切换到会话 ${sessionId}（${loaded.length} 条消息进入上下文）:`)
    for (const line of previewMessages(loaded, 6)) {
      console.log(`  ${line}`)
    }
    console.log(`store: ${sessionFilePath(cwd, sessionId)}`)
  }

  try {
    while (true) {
      const raw = await readLine()
      if (raw === null) {
        break // EOF（Ctrl+D / 管道关闭）：退出循环，走 flushOnExit
      }
      const input = raw.trim()
      if (!input) {
        continue
      }
      if (input === '/exit') {
        break
      }
    
      if (input === '/clear') {
  await flushSessionSaves()                          // 旧会话的待写全部落盘（此刻还是旧引用、旧 sessionId）
  await saveMessages(cwd, sessionId, messages)       // 双保险：全量写旧文件
  const oldId = sessionId
  sessionId = newSessionId()
  messages = [
    { role: 'system', content: await systemContent() },
    buildToolCatalogMessage(),
  ]
  console.log(`已清空上下文，新会话 ${sessionId}；旧会话 ${oldId} 仍在盘上，/resume ${oldId} 可找回`)
  continue
}     
      //列出所有sessions
      if (input === '/sessions') {
        const sessions = await listSessions(cwd)
        if (sessions.length === 0) {
          console.log('No saved sessions.')
          continue
        }
        sessions.forEach((s, i) => {
          const mark = s.id === sessionId ? '*' : ' '
          console.log(`${mark}${i + 1}. ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.eventCount}e  ${s.title ?? ''}`)
        })
        console.log(`permissions: ${getPermissionsPath()}`)
        continue
      }
      //MCP 服务器状态（连接态 / 工具数 / 错误）；/mcp connect|disconnect <name> 运行时开关
      if (input === '/mcp' || input.startsWith('/mcp ')) {
        const parts = input.slice(4).trim().split(/\s+/)
        const sub = parts[0]
        if (sub === 'connect' && parts[1]) {
          const status = await reconnectMcpServer(parts[1])
          console.log(`/mcp connect ${parts[1]} → ${status.status}${status.error ? `: ${status.error}` : ''}`)
          continue
        }
        if (sub === 'disconnect' && parts[1]) {
          await disconnectMcpServer(parts[1])
          console.log(`/mcp disconnect ${parts[1]}：已断开并摘除工具（重连用 /mcp connect ${parts[1]}）`)
          continue
        }
        const statuses = getMcpStatus()
        if (statuses.length === 0) {
          console.log('未配置任何 MCP 服务器（~/.ICEFOX-code/mcp.json 或 .icefox/mcp.json）')
          continue
        }
        for (const s of statuses) {
          const mark = s.status === 'connected' ? '\u001b[32m●\u001b[0m' : s.status === 'disabled' ? '\u001b[90m○\u001b[0m' : '\u001b[31m✗\u001b[0m'
          console.log(`${mark} ${s.name}  ${s.status}${s.status === 'connected' ? ` (${s.toolCount} tools)` : ''}${s.error ? `  ${s.error}` : ''}`)
        }
        console.log('用法: /mcp connect <name> | /mcp disconnect <name>')
        continue
      }
      // 重命名对话
      if (input === '/rename' || input.startsWith('/rename ')) {
  const title = input.slice('/rename'.length).trim()
  if (!title) {
    console.log('用法: /rename <标题>')
    continue
  }
  await appendControlEvent(cwd, sessionId, 'rename', { title })   // 控制事件即时落盘，不进批量窗口
  console.log(`当前会话已命名：${title}`)
  continue
}           

      if (input === '/resume' || input.startsWith('/resume ')) {
        await handleResume(input.slice('/resume'.length).trim())
        
        continue

      }
      
      //手动压缩：先走 micro（清旧 tool_result），过半不够再强制中段 summary
      if (input === '/compact') {
        const outcome = await maybeCompactContext({ model, messages, force: true })
        if (outcome.compacted) {
          messages.splice(0, messages.length, ...outcome.messages)
          await saveMessages(cwd, sessionId, messages)
          await appendSessionEvent(cwd, sessionId, 'turn_end', {
            kind: 'compact',
            removedCount: outcome.removedCount,
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
          })
          console.log(`/compact: ${outcome.removedCount} 条 → summary（${outcome.tokensBefore} → ${outcome.tokensAfter} tok）`)
        } else if (outcome.removedCount > 0) {
          console.log(`/compact(micro): 清理 ${outcome.removedCount} 条旧 tool_result 为 [cleared]`)
        } else {
          console.log('/compact: 无可压缩内容（中段太短或已经够小）')
        }
        continue
      }
      //删除会话（TODO：接 clearSession + 二次确认删除，对象应是「非当前会话」或先 /clear）
      if (input === '/delete') {
        console.log('（占位）/delete 尚未实现')
        continue
      }
      //切换模型（TODO：写 model 字段 + 重建 system 提示）
      if (input === '/model') {
        console.log('（占位）/model 尚未实现')
        continue
      }
      if (input === '/help') {
        console.log([
          '/exit              退出（空闲时 Ctrl+C / Ctrl+D 亦可；回合中 Ctrl+C 只取消回合）',
          '/clear             清空上下文并开新会话（旧会话保留在盘上）',
          '/sessions          列出本项目历史会话（当前带 *）',
          '/mcp               MCP 服务器连接状态与工具数',
          '/rename <标题>     重命名当前会话',
          '/resume [id|序号]  切换会话（支持 id 前缀模糊）',
          '/compact           手动压缩上下文（micro 优先，必要时 summary）',
          '/delete /model /init  占位，尚未实现',
          'Ctrl+C             回合中=取消当前回合；空闲=退出',
        ].join('\n'))
        continue
      }
      //初始化项目指令（TODO：生成 AGENTS.md 风格说明文件，见 TODO.md B1）
      if (input === '/init') {
        console.log('（占位）/init 尚未实现')
        continue
      }
      messages.push({ role: 'user', content: input })
      scheduleSave(cwd, sessionId, messages)
      void appendFile(historyFile, JSON.stringify({ input }) + '\n').catch(() => {})

      const outcome = await maybeCompactContext({ model, messages })
      if (outcome.compacted) {
        messages.splice(0, messages.length, ...outcome.messages)
        await saveMessages(cwd, sessionId, messages)
        await appendSessionEvent(cwd, sessionId, 'turn_end', {
          kind: 'compact',
          removedCount: outcome.removedCount,
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
        })
        console.log(`[compact] ${outcome.removedCount} 条旧消息 → summary（${outcome.tokensBefore} → ${outcome.tokensAfter} tok）`)
      } else if (outcome.removedCount > 0) {
        console.log(`[microcompact] 清理 ${outcome.removedCount} 条旧 tool_result`)
      }

      permissions.beginTurn()
      activeTurn = new AbortController()
      try {
        const receipt = await agentloop({
          model,
          messages,
          cwd,
          permissions,
          maxSteps: 30,
          toolResultState,
          signal: activeTurn.signal,
          
          onAssistantMessage: content => { console.log(`\n${content}\n`) },
          onProgressMessage: content => { console.log(`[progress] ${content}`) },
          onThinking: content => {
            const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content
            const dim = preview.replace(/\n/g, '\n\u001b[2m')
            console.log(`\u001b[2m[thinking] ${dim}\u001b[0m`)
          },
          onTurnDiags: info => {
            void appendSessionEvent(cwd, sessionId, 'turn_end', { ...info }).catch(() => {})
          },
        })
        if (receipt.kind === 'aborted') {
          console.log('[aborted] 本回合已取消，可继续输入')
        }
        scheduleSave(cwd, sessionId, messages)
      } catch (error) {
        await appendSessionEvent(cwd, sessionId, 'error', {
          where: 'agentloop',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
        console.log(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`)
      } finally {
        activeTurn = null
        permissions.endTurn()
      }
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

