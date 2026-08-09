




export async function buildSystemPrompt(cwd: string,
  permissionSummary: string[] = [],
): Promise<string> {
  const parts = [
    'You are a helpful coding assistant with access to local file system tools.',
    `Current cwd: ${cwd}`,
    'Default behavior: inspect the repository, use tools, make code changes when appropriate, and explain results clearly.',
    'Prefer reading files, searching code, editing files, and running verification commands over giving purely theoretical advice.',
    'If you need user clarification, ask the user.',
  ]
  if (permissionSummary.length > 0) {
    parts.push(`Permission context:\n${permissionSummary.join('\n')}`)
  }
  return parts.join('\n\n')
}
