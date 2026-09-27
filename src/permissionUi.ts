import type {
  PermissionPromptHandler,
  PermissionRequest,
} from './permissionManager.js'
import { readLine } from './tty-prompt.js'
import { pick } from './picker.js'

export function createPermissionPromptHandler(): PermissionPromptHandler {
  return async (request: PermissionRequest) => {
    const detail = [...request.details, `scope: ${request.scope}`]
    const index = await pick({
      title: `approval required — ${request.summary}  (kind=${request.kind})`,
      options: request.choices.map(choice => ({
        key: choice.key,
        label: choice.label,
        hint: choice.decision,
        danger: choice.decision.startsWith('deny'),
        detail,
      })),
    })
    if (index === null) {
      // Esc / Ctrl+C / EOF：fail-closed，取消即拒绝
      return { decision: 'deny_once' }
    }
    const chosen = request.choices[index]
    if (chosen.decision === 'deny_with_feedback') {
      // 自由文本仍走行输入（picker 管不了多字输入），EOF 兜底成空反馈
      const feedback = (await readLine('guidance to model> '))?.trim() ?? ''
      return { decision: chosen.decision, feedback }
    }
    return { decision: chosen.decision }
  }
}
