import { z } from 'zod'
import { PermissionManager } from './permissionManager.js'

export type ToolContent = {
  cwd: string
  permissions?: PermissionManager
}

export type ToolDefinition<TInput> = {

  name: string
  description: string
  //模拟json格式帮助llm模仿
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run(input: TInput, content: ToolContent): Promise<ToolResult>
}


export type ToolResult = {
  ok: boolean,
  output: string,

}
export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  // private metadataStore: ToolRegistryMetadata
   private readonly disposers: Array<() => Promise<void>> = []

  constructor(
     tools: ToolDefinition<unknown>[],
    
     disposer?: () => Promise<void>,
   ) {
     this.toolsStore = [...tools]
     
     if (disposer) {
       this.disposers.push(disposer)
     }
   }

  // list(): ToolDefinition<unknown>[] {
  //   return this.toolsStore
  // }

  // getSkills(): SkillSummary[] {
  //   return this.metadataStore.skills ?? []
  // }

  // getMcpServers(): McpServerSummary[] {
  //   return this.metadataStore.mcpServers ?? []
  // }

  // setMcpServers(servers: McpServerSummary[]): void {
  //   this.metadataStore = {
  //     ...this.metadataStore,
  //     mcpServers: [...servers],
  //   }
  // }

  // addTools(nextTools: ToolDefinition<unknown>[]): void {
  //   const existingNames = new Set(this.toolsStore.map(tool => tool.name))
  //   for (const tool of nextTools) {
  //     if (existingNames.has(tool.name)) {
  //       continue
  //     }
  //     this.toolsStore.push(tool)
  //     existingNames.add(tool.name)
  //   }
  // }

  // addDisposer(disposer: () => Promise<void>): void {
  //   this.disposers.push(disposer)
  // }

   find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
   }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolContent,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolName}`,
      }
    }

    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        output: parsed.error.message,
      }
    }

    try {
      return await tool.run(parsed.data, context)
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(disposer => disposer()))
  }
}

