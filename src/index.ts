import { setDefaultResultOrder } from 'node:dns'
import readline from 'node:readline'
import { getToolSchemas, initRegistry } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { PermissionManager } from './permissionManager.js'
import { agentloop } from './agent_loop.js'
import { AnthropicModelAdapter } from './anthropic-adapter.js'
import type { ChatMessage } from './type.js'

// 本机网络无 IPv6，强制 DNS 解析优先返回 IPv4 地址
setDefaultResultOrder('ipv4first')

initRegistry()

async function main(): Promise<void> {
  const cwd = process.cwd()
  const permissions = new PermissionManager(cwd)
  await permissions.whenReady()

  const model = new AnthropicModelAdapter(getToolSchemas())

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: await buildSystemPrompt(cwd, permissions.getSummary()),
    },
  ]

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  for await (const rawInput of rl) {
    const input = rawInput.trim()
    if (!input) {
      continue
    }
    if (input === '/exit') {
      break
    }

    messages.push({ role: 'user', content: input })
    const result = await agentloop({
      model,
      messages,
      cwd,
      permissions,
    })
    messages.push(...result)

    const last = [...messages].reverse().find(m => m.role === 'assistant')
    if (last && last.role === 'assistant') {
      console.log(`\n${last.content}\n`)
    }
  }

  rl.close()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
