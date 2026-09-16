import type {
  PermissionPromptHandler,
  PermissionRequest,
} from './permissionManager.js'
import { readLineFromConsole } from './tty-prompt.js'

export function createPermissionPromptHandler(): PermissionPromptHandler {
  return async (request: PermissionRequest) => {
    const lines = [
      '',
      `\u001b[33m\u26a0 approval required\u001b[0m  ${request.summary}  (kind=${request.kind})`,
      ...request.details.map(detail => `    ${detail}`),
      `    scope: ${request.scope}`,
      `    ${request.choices.map(c => `[${c.key}] ${c.label}`).join('   ')}`,
    ]
    console.log(lines.join('\n'))

    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = readLineFromConsole('choose> ')
      if (answer === null) {
        return { decision: 'deny_once' }
      }
      const chosen = request.choices.find(c => c.key === answer.trim())
      if (!chosen) {
        console.log('invalid choice')
        continue
      }
      if (chosen.decision === 'deny_with_feedback') {
        const feedback = readLineFromConsole('guidance to model> ') ?? ''
        return { decision: chosen.decision, feedback }
      }
      return { decision: chosen.decision }
    }
    return { decision: 'deny_once' }
  }
}
