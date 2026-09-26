import type {
  PermissionPromptHandler,
  PermissionRequest,
} from './permissionManager.js'
import { discardQueuedInput, readLine } from './tty-prompt.js'

export function createPermissionPromptHandler(): PermissionPromptHandler {
  return async (request: PermissionRequest) => {
    const dropped = discardQueuedInput()
    if (dropped > 0) {
      console.log(`[approval] 已丢弃回合中排队的 ${dropped} 行输入（防止抢答），需要请重新输入`)
    }
    const lines = [
      '',
      `\u001b[33m\u26a0 approval required\u001b[0m  ${request.summary}  (kind=${request.kind})`,
      ...request.details.map(detail => `    ${detail}`),
      `    scope: ${request.scope}`,
      `    ${request.choices.map(c => `[${c.key}] ${c.label}`).join('   ')}`,
    ]
    console.log(lines.join('\n'))

    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await readLine('choose> ')
      if (answer === null) {
        return { decision: 'deny_once' }
      }
      const chosen = request.choices.find(c => c.key === answer.trim())
      if (!chosen) {
        console.log('invalid choice')
        continue
      }
      if (chosen.decision === 'deny_with_feedback') {
        //readLine 返回 Promise<string | null>：await 取值，EOF 兜底成空反馈
        const feedback = (await readLine('guidance to model> '))?.trim() ?? ''
        return { decision: chosen.decision, feedback }
      }
      return { decision: chosen.decision }
    }
    return { decision: 'deny_once' }
  }
}
