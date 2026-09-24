import { connectMcpServers, getMcpStatus, disposeMcp } from './src/mcp.js'
import { getAllTool, getTool } from './src/tools/index.js'

await connectMcpServers({
  everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
})

console.log('status:', JSON.stringify(getMcpStatus(), null, 2))
const mcpTools = getAllTool().filter(t => t.name.startsWith('mcp__'))
console.log(`registered ${mcpTools.length} mcp tools`)
console.log('meta tools:', getAllTool().filter(t => t.name.includes('mcp_') && !t.name.startsWith('mcp__')).map(t => t.name).join(', '))

const sample = mcpTools.find(t => t.name.includes('get_sum')) ?? mcpTools[0]
if (sample) {
  const r = await sample.run({ a: 2, b: 40 }, { cwd: process.cwd() })
  console.log(`call ${sample.name} ->`, r.ok, '|', r.output.slice(0, 150))
}

const listPrompts = getTool('list_mcp_prompts')
if (listPrompts) {
  const r = await listPrompts.run({}, { cwd: process.cwd() })
  console.log('list_mcp_prompts ->', r.ok, '|', r.output.split('\n').slice(0, 3).join(' / '))
}

await disposeMcp()
process.exit(0)
