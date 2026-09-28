import type { ChatMessage, ModelAdapter } from '../type.js'
import type { PermissionManager } from '../permissionManager.js'
import type { ContentReplacementState } from '../utils/tool-result.js'

/**
 * REPL（与将来的 TUI）共享的状态容器。装配根（src/index.ts）构造一次，全程传递。
 *
 * 引用纪律（AGENTS.md 纪律 2）：
 *  - `messages` **重绑**（赋新数组）= 换会话 / 清空——必须先把旧数组的待写 flush 掉
 *  - `messages` **就地 splice/push** = 压缩与回合提交——保存方与内核持有的引用保持同一数组
 */
export type ReplContext = {
  cwd: string
  projectRoot: string
  model: ModelAdapter
  permissions: PermissionManager
  toolResultState: ContentReplacementState
  historyFile: string
  sessionId: string
  messages: ChatMessage[]
  /** 当前回合的 AbortController；空闲为 null。Ctrl+C 双语义与全局键都读它判状态 */
  activeTurn: AbortController | null
  /** system 提示现搭（权限摘要会变，每次启动/切会话/清空时重建） */
  systemContent(): Promise<string>
}
