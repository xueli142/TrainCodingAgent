import { writeFile } from 'node:fs/promises'
import { ToolDefinition } from '../tool.js'
import { z } from 'zod'
import { resolveToolPath } from '../workspace.js'
import { applyReviewedFileChange } from '../file-review.js'
type Input = {
  path: string
  content: string
}

const schema = z.object({
  path: z.string(),
  content: z.string(),
})

export const WriteTool: ToolDefinition<Input> = {
  name: 'write_file',
  description: 'Write content to a file on the local filesystem. Creates the file if it does not exist, overwrites it if it does.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  schema: schema,
  async run(input, content) {
    const target =await resolveToolPath(content, input.path, 'write')
    
    return applyReviewedFileChange(content ,input.path,target,input.content,)
  },
}
