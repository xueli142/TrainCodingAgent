import path from 'node:path'
import type { ToolContent } from './tool.js'

export async function resolveToolPath(
  context: ToolContent,
  targetPath: string,
  intent: 'read' | 'write' | 'list' | 'search',
): Promise<string> {
  const resolved = path.resolve(context.cwd, targetPath)

  if (!context.permissions) {
    const workspaceRoot = path.resolve(context.cwd)
    const relative = path.relative(workspaceRoot, resolved)

    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Path escapes workspace: ${targetPath}`)
    }

    return resolved
  }

  await context.permissions.ensurePathAccess(resolved, intent)
  return resolved
}
