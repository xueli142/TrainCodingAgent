import { toAnthropicMessages } from './anthropic-adapter.js'
import { PermissionManager } from './permissionManager.js'
import { buildSystemPrompt } from './prompt.js'
import { buildToolCatalogMessage, getToolSchemas, initRegistry } from './tools/index.js'
import type { ChatMessage } from './type.js'

initRegistry()

const cwd = process.cwd()
const permissions = new PermissionManager(cwd)
await permissions.whenReady()

const userMessage = process.argv[2] ?? '你好，看看你的tool有什么'

let messages: ChatMessage[] = [
  {
    role: 'system',
    content: await buildSystemPrompt(cwd, permissions.getSummary()),
  },
  buildToolCatalogMessage(),
  { role: 'user', content: userMessage },
]

console.log('############ raw ChatMessage[] (本地存储形态) ############')
for (const m of messages) {
  const chars = 'content' in m ? String(m.content).length : 0
  console.log(`- role=${m.role}  ${chars} chars`)
}

const payload = toAnthropicMessages(messages)
const tools = getToolSchemas()

console.log('\n############ 1. system 字段（role=system 与 role=tool 折叠后的最终头部） ############\n')
console.log(payload.system)

console.log('\n############ 2. messages 字段（线上传输格式） ############\n')
console.log(JSON.stringify(payload.messages, null, 2))

console.log('\n############ 3. tools 字段（input_schema 全文） ############')
for (const t of tools) {
  console.log(`\n--- ${t.name} (description ${t.description.length} chars) ---`)
  console.log(JSON.stringify(t.input_schema))
}

const systemChars = payload.system.length
const toolsChars = JSON.stringify(tools).length
console.log('\n############ 4. 首轮请求体量 ############')
console.log(`system ≈ ${systemChars.toLocaleString()} chars`)
console.log(`tools  ≈ ${toolsChars.toLocaleString()} chars`)
console.log(`总计首轮固定开销 ≈ ${(systemChars + toolsChars).toLocaleString()} chars ≈ ${Math.round((systemChars + toolsChars) / 3.5)} tokens（中文估算）`)
