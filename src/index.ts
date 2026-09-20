import { setDefaultResultOrder } from 'node:dns'
import readline from 'node:readline'
import { buildToolCatalogMessage, getToolSchemas, initRegistry } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { PermissionManager } from './permissionManager.js'
import { createPermissionPromptHandler } from './permissionUi.js'
import { agentloop } from './agent_loop.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import type { ChatMessage } from './type.js'
import { enableTrace, flushTrace } from './context-tracer.js'
import{MODEL}from './config.js'
import { createContentReplacementState } from './utils/tool-result.js'
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
  latestSessionId,
  newSessionId,
  projectMessages,
  readEvents,
  resumeMessages,
  saveMessages,
  scheduleSave,
  sessionFilePath,
} from './session.js'
import { maybeCompactContext } from './compact.js'

setDefaultResultOrder('ipv4first')

initRegistry()
import { setQuestionHandler } from './tools/tool/index.js'
import { readLine,attachInputSource } from './tty-prompt.js'

setQuestionHandler(async (questions) => {
  const answers: string[] = []
  for (const q of questions) {
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

function previewMessages(messages: ChatMessage[], count = 4): string[] {
  return messages
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

  const model = new AnthropicModelAdapter(getToolSchemas())

  async function systemContent(): Promise<string> {
    return buildSystemPrompt(
      cwd,
      permissions.getSummary(),
      renderEnvironmentBlock(procEnv, projectEnv, MODEL),
      skillsBlock,
    )
  }

  let sessionId = newSessionId()
  let restored: ChatMessage[] = []
  const resumeArg = flagValue('--resume')
  if (resumeArg !== undefined) {
    const target = resumeArg || (await latestSessionId(cwd))
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

  const messages: ChatMessage[] = [
    { role: 'system', content: await systemContent() },
    buildToolCatalogMessage(),
    ...restored,
  ]

  console.log(`[session ${sessionId}] ${restored.length > 0 ? `resumed ${restored.length} messages` : 'new'}`)
  console.log(`project: ${projectEnv.root} (${projectEnv.trusted ? 'trusted' : 'untrusted'})`)
  console.log(`store: ${sessionFilePath(cwd, sessionId)}`)

  if (process.env.ICEFOX_TRACE !== '0') {
    const traceFile = await enableTrace(sessionId)
    console.log(`trace: ${traceFile}`)
  }

  await appendSessionEvent(cwd, sessionId, 'context_snapshot', {
    model: MODEL,
    project: projectEnv.root,
    trusted: projectEnv.trusted,
    system: messages[0]?.role === 'system' ? messages[0].content : '',
    catalog: messages[1]?.role === 'tool' ? messages[1].content : '',
    tools: getToolSchemas(),
  })

  await saveMessages(cwd, sessionId, messages)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  attachInputSource(rl)

  const flushOnExit = async () => {
    await flushTrace()
    await flushSessionSaves()
  }
  process.on('SIGINT', () => {
    void flushOnExit().finally(() => process.exit(130))
  })

  async function handleResume(arg: string): Promise<void> {
    const sessions = await listSessions(cwd)
    let target: string | undefined
    if (!arg) {
      console.log('\nsessions:')
      sessions.forEach((s, i) => console.log(`  ${i + 1}. ${s.id}  ${s.eventCount}e  ${s.title ?? ''}`))
      console.log('用法: /resume <id|序号>')
      return
    }
    target = /^\d+$/.test(arg) ? sessions[Number(arg) - 1]?.id : arg
    if (!target) {
      console.log(`session not found: ${arg}`)
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

    messages.splice(0, messages.length, { role: 'system', content: await systemContent() }, buildToolCatalogMessage(), ...loaded)
    sessionId = target
    await appendSessionEvent(cwd, sessionId, 'context_snapshot', {
      model: MODEL,
      project: projectEnv.root,
      trusted: projectEnv.trusted,
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
        continue
      }
      if (input === '/resume' || input.startsWith('/resume ')) {
        await handleResume(input.slice('/resume'.length).trim())
        continue
      }

      messages.push({ role: 'user', content: input })
      scheduleSave(cwd, sessionId, messages)

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
        console.log(`[compact] ${outcome.removedCount} 条旧消息 → summary（${outcome.tokensBefore} → ${outcome.tokensAfter} tok est.）`)
      }

      permissions.beginTurn()
      try {
        await agentloop({
          model,
          messages,
          cwd,
          permissions,
          maxSteps: 30,
          toolResultState,
          onAssistantMessage: content => { console.log(`\n${content}\n`) },
          onProgressMessage: content => { console.log(`[progress] ${content}`) },
          onTurnDiags: info => {
            void appendSessionEvent(cwd, sessionId, 'turn_end', { ...info }).catch(() => {})
          },
        })
        scheduleSave(cwd, sessionId, messages)
      } catch (error) {
        await appendSessionEvent(cwd, sessionId, 'error', {
          where: 'agentloop',
          message: error instanceof Error ? error.message : String(error),
        }).catch(() => {})
        console.log(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`)
      } finally {
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
  process.exitCode = 1
})
