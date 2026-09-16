export async function buildSystemPrompt(
  cwd: string,
  permissionSummary: string[] = [],
  environmentLines: string[] = [],
): Promise<string> {
  const parts = [
    'You are a helpful coding assistant with access to local file system tools.',
    ...(environmentLines.length > 0 ? [environmentLines.join('\n')] : []),
    `Current cwd: ${cwd}`,
    'Default behavior: inspect the repository, use tools, make code changes when appropriate, and explain results clearly.',
    'Prefer reading files, searching code, editing files, and running verification commands over giving purely theoretical advice.',
    'Permission denials are hard stops. If a tool call is denied or blocked, do NOT retry the same call and do NOT accomplish the same effect through bash redirection, shell writes, interpreters, or any other tool. State what was blocked and ask the user.',
    'When a tool output was trimmed or a session was compacted earlier, the visible history is authoritative for continuing work; do not try to reconstruct trimmed content.',
    'If you need user clarification, ask the user.',
  ]
  if (permissionSummary.length > 0) {
    parts.push(`Permission context:\n${permissionSummary.join('\n')}`)
  }
  return parts.join('\n\n')
}
