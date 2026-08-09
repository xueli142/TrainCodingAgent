import { readFile } from 'node:fs/promises'
import { ToolDefinition } from "../tool.js"
import { z } from 'zod'
import { resolveToolPath } from '../workspace.js'

const DEFAULT_READ_LIMIT = 8000
const MAX_READ_LIMIT = 20000

type Input = {
    path:string,
    offset?:number,
    limit?:number,

}
const schema= 
    z.object({
    path: z.string(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional()

})

export const ReadTool:ToolDefinition<Input> ={
    name:'read_file',
    description: 'Read a file from the local filesystem',
    inputSchema:{
        type:'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
      schema: schema,
    async run(input, context) {
      const target = await resolveToolPath(context, input.path, 'read')
      const content = await readFile(target, 'utf8')
      const offset = Math.max(0, input.offset ?? 0)
      const limit = Math.min(MAX_READ_LIMIT, input.limit ?? DEFAULT_READ_LIMIT)
      const end = Math.min(content.length, offset + limit)
      const chunk = content.slice(offset, end)
      const truncated = end < content.length
      const header = [
        `FILE: ${input.path}`,
        `OFFSET: ${offset}`,
        `END: ${end}`,
        `TOTAL_CHARS: ${content.length}`,
        truncated
          ? `TRUNCATED: yes - call read_file again with offset ${end}`
          : 'TRUNCATED: no',
        '',
      ].join('\n')

      return {
        ok: true,
        output: header + chunk,
      }
    },

      
  }

    
  
