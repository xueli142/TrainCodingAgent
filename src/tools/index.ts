import { ToolDefinition } from '../tool.js'
import { ReadTool } from './read_file.js'
import { WriteTool } from './write_file.js'
import { listFilesTool } from './list_file.js'
import { runCommandTool } from './run_command.js'
const registry = new Map<string, ToolDefinition<any>>()

// export  async function createDafultToolRegistry(args:{
//     cwd:string,
//     runtime:
// })

export  function initRegistry():void {
    registerTool(ReadTool)
    registerTool(WriteTool)
    registerTool(listFilesTool)
    registerTool(runCommandTool)
    
}



export function registerTool<T>(tool:ToolDefinition<T>):void{
    registry.set(tool.name,tool)
}
export function getTool(name:string):ToolDefinition<any>|undefined{

    return registry.get(name)
}
export function getAllTool():ToolDefinition<any>[]{

        return Array.from(registry.values())
}

export function getToolSchemas(): any[] {
    return getAllTool().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
    }))
}