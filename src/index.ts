import { setDefaultResultOrder } from 'node:dns'
import readline from 'node:readline'
import { buildToolCatalogMessage, getToolSchemas, initRegistry } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { PermissionManager } from './permissionManager.js'
import { agentloop } from './agent_loop.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import type { ChatMessage } from './type.js'
import {
  flushSessionSaves,
  latestSessionId,
  listSessions,
  newSessionId,
  resumeMessages,
  saveMessages,
  scheduleSave,
  sessionFilePath,
} from './session.js'

setDefaultResultOrder('ipv4first')

initRegistry()

const argv = process.argv.slice(2)

function flagValue(flag: string): string | undefined | null {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const next = argv[index + 1]
  return next && !next.startsWith('--') ? next : ''
}

async function main(): Promise<void> {
  const cwd = process.cwd()

  if (argv.includes('--sessions')) {
    const sessions = await listSessions(cwd)
    if (sessions.length === 0) {
      console.log('No saved sessions for this project.')
      return
    }
    for (const session of sessions) {
      const when = new Date(session.updatedAt).toLocaleString()
      console.log(`${session.id}  ${when}  ${session.eventCount} events  ${session.title ?? ''}`)
    }
    return
  }

  const permissions = new PermissionManager(cwd)
  await permissions.whenReady()

  const model = new AnthropicModelAdapter(getToolSchemas())

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
    {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary()),
    },
    buildToolCatalogMessage(),
    ...restored,
  ]

  console.log(`[session ${sessionId}] ${restored.length > 0 ? `resumed ${restored.length} messages` : 'new'}`)
  console.log(`store: ${sessionFilePath(cwd, sessionId)}`)

  await saveMessages(cwd, sessionId, messages)

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const flushOnExit = async () => {
    await flushSessionSaves()
  }
  process.on('SIGINT', () => {
    void flushOnExit().finally(() => process.exit(130))
  })

  try {
    for await (const rawInput of rl) {
      const input = rawInput.trim()
      if (!input) {
        continue
      }
      if (input === '/exit') {
        break
      }

      messages.push({ role: 'user', content: input })
      scheduleSave(cwd, sessionId, messages)
      const result = await agentloop({
        model,
        messages,
        cwd,
        permissions,
      })
      messages.push(...result)
      scheduleSave(cwd, sessionId, messages)

      const last = [...messages].reverse().find(m => m.role === 'assistant')
      if (last && last.role === 'assistant') {
        console.log(`\n${last.content}\n`)
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
