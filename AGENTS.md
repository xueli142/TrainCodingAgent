# AGENTS.md — icefox-agent

> 供 AI 协作者阅读的项目实况文档。基于 2026-09-25 全量代码扫描写成，行号会随改动漂移，以符号名搜索为准。
> README 面向使用者，本文面向改代码的人：**模块地图、主流程、数据布局、纪律、已知的坑**。

## 1. 定位与原则

教学/个人向极简 coding agent：TypeScript ESM，`tsx` 直跑无构建，pnpm 管理，运行时依赖仅 `zod` / `dotenv` / `diff` / `@modelcontextprotocol/sdk`。核心主张——**主循环只认一个分支变量，一切筛查下放，一切持久化外置**。改代码时保持"可通读"优先于功能数量；上 UI 框架（Ink/OpenTUI）是被明确拒绝的（TODO B3）。

```
pnpm start                 # 交互式 REPL（先跑 pnpm install）
pnpm start -- --sessions   # 列历史会话
pnpm start -- --resume [id]
npx tsx smoke-mcp.ts       # MCP 连通性冒烟（server-everything 当靶子）
```

`.env` 必需：`MODEL` / `API_KEY` / `BASE_URL`（走 `Authorization: Bearer`，非官方 x-api-key）；可选 `THINKING_BUDGET`（默认 2048，`0` 关闭 extended thinking）、`ICEFOX_TRACE=0`（关 trace）、`ICEFOX_CODE_HOME`（改数据根目录）。

## 2. 模块地图

### 入口与装配（composition root）
| 文件 | 职责 |
|---|---|
| `src/index.ts` | REPL + 装配根。启动时序：`initRegistry()`(静态工具) → `discoverSkills` → `PermissionManager.whenReady` → **`connectMcpServers(mcpConfig)`** → `new AnthropicModelAdapter(getToolSchemas())`（⚠️ 工具在此快照，MCP 必须先注册）→ system/catalog 组装 → `resumeMessages` 恢复 → readline 循环。斜杠命令：`/exit /clear /sessions /rename /resume /help` 已实现；`/compact /delete /model /init` 是占位 |
| `bin/icefox.js` | 薄壳：`icefox start` → `pnpm start` |
| `src/config.ts` | env 常量 + `ICEFOX_CODE_DIR` + `McpServerConfig` 类型 + **`mcpConfig` 目前硬编码**（外置 JSON 在 TODO B2）；`RuntimeConfig` 类型无人使用 |

### Agent 内核
| 文件 | 职责 |
|---|---|
| `src/agent_loop.ts` | 回合内核。每 step 调 `model.next()` 后只有三条出路：`assistant` → append + **return 结束回合**；`tool_calls` → 逐个 `executeTool`（registry 查名 → zod safeParse → run → catch 转 ok:false）→ loop-guard（同调用第 3 次注入警告）→ 结果过双层预算 → 下一 step；空响应 → 有 progress 文本则续跑否则 return。30 步上限。**权限不在这里**（塞进 `ToolContent.permissions` 由工具自查）；输出全走回调，不碰 UI/落盘 |
| `src/type.ts` | `ChatMessage` 12 角色联合类型（含 `assistant_thinking` 带 signature 块、`context_summary`、`snip_boundary`）；`AgentStep`（assistant \| tool_calls + `providerUsage` 元数据字段——**已定义未接线到消息上**，token 校准的欠账，见 TODO B1） |
| `src/prompt.ts` | `buildSystemPrompt`：身份行 + 环境块 + cwd + 行为准则 + **denial 硬停条款（禁 bash 绕行）** + 权限摘要 + skills 目录块 |

### 模型适配
| 文件 | 职责 |
|---|---|
| `src/anthropic-adapter.ts` | 线格式转换 + HTTP。`toAnthropicMessages`：thinking 块带 signature 原样回放；`tool_result` 归 user；`context_summary` 以 user 消息注入。`normalizeAnthropicUsage`：input 计入两项 cache token。`readJsonBody`/`extractErrorMessage` 防错误体吞掉。⚠️ **无 stop_reason 映射**——分支只看 content 里有无 tool_use；`max_tokens` 截断、refusal 未处理 |

### 工具系统
| 文件 | 职责 |
|---|---|
| `src/tool.ts` | `ToolDefinition`（name/description/inputSchema JSON Schema + zod schema + run）、`ToolContent {cwd, permissions}`、`ToolRegistry`（另一个类，实际 REPL 用的是下面 Map 版） |
| `src/tools/index.ts` | **registry 事实本体**：模块级 `Map` + `initRegistry/registerTool/unregisterToolsByPrefix/getTool/getToolSchemas`；渐进披露：`buildToolCatalogMessage()` 生成 name+首行摘要的目录消息进上下文，完整 schema 走 API tools 参数。`NOT_WIRED_TOOLS={task,question}` 是静态提示名单 |
| `src/tools/tool/index.ts` | `standardTools` 11 件套（opencode 同名集）：bash/edit/glob/grep/question/read/skill/task/todowrite/webfetch/write |
| `src/tools/tool/bash.ts` | 权限最重的工具：拆段逐条 `ensureCommand` + **`gateTouchedPaths` 绕行硬闸**（命中已 deny 的 edit 目标直接抛错，防 deny 被 bash 洗掉）；win32 用 taskkill /T 杀树；tail 限 2000 行/50KB |
| `src/tools/tool/edit.ts` / `write.ts` | 都走"先读后改"（`read-state.ts` 账本）→ 构建 unified diff → **`ensureEdit(path, diff)` 审批在工具内** → 写后 `rememberRead` 防自环 |
| `src/tools/tool/read.ts` | `N: content` 行号格式、单行 2000 字符截、目录列表、二进制 NUL 拒绝、读完登记指纹 |
| `src/tools/tool/glob.ts` / `grep.ts` | 共用 `fs-walk.ts`（手写 glob→RegExp + 栈式 DFS）；grep 纯 JS 非 ripgrep，限额 200 匹配/6000 文件 |
| `src/tools/tool/skill.ts` | SKILL.md 发现（`.icefox/skills` + `~/.ICEFOX-code/skills`）+ 两阶段披露；frontmatter 只支持单行 kv（拓宽在 TODO B1） |
| `src/tools/tool/question.ts` / `task.ts` | "not wired"模式：模块级单例 setter。question 已在 index.ts 接 TTY handler；**task 全仓无注册点，是唯一真未接线工具** |
| `src/tools/tool/todowrite.ts` | 状态存模块级内存变量，**不落盘不进 session** |
| `src/tools/tool/schema-io.ts` | zod→JSON Schema 唯一出口（`io:'input'`，删 $schema） |
| `src/tools/tool/read-state.ts` / `fs-walk.ts` | 辅助：改前必读账本（mtime+size 指纹）/ 目录遍历底座 |
| `src/tools/{read_file,write_file,list_file,run_command}.ts`、`src/tools/search_file.ts` | ⚠️ **未注册的遗留文件**（含空文件），B0 工程卫生待清理 |

### 权限
| 文件 | 职责 |
|---|---|
| `src/permissionManager.ts` | 三把闸：`ensurePathAccess`（workspace 内直放）/ `ensureCommand`（先 cwd 后命令，`classifyDangerousCommand` 硬归类）/ `ensureEdit`（7 选项含 turn 级 allow_turn/allow_all_turn）。持久层 `~/.ICEFOX-code/permissions.json` 六组前缀/模式数组；内存层 session deny 集合（不持久）。`beginTurn/endTurn` 清 turn 级授权。**⚠️ 不消费 trusted**（trust 是装饰，见坑）；文件整体 2 空格缩进异常 |
| `src/permissionUi.ts` | 审批卡文案，走 `tty-prompt.readLine` 单读者 |

### 持久化与数据
| 文件 | 职责 |
|---|---|
| `src/session.ts` | **事实日志**：`~/.ICEFOX-code/projects/<slug>/<sessionId>.jsonl` append-only，13 种事件类型。写路径三层：`appendSessionEvent`（即时落盘）、`saveMessages`/`scheduleSave`（按 id 去重增量 + 1s 批量 + `withStoreLock` promise 链串行化保 seq 链）、`flushSessionSaves`（退出/切会话前）。读路径 `projectMessages`：**从最后一条 summary 起播**；thinking/progress/tool_call 不进上下文（tool_call 的 input 留盘审计）；tool_result 降维为 user 文本截 25k |
| `src/context-tracer.ts` | 每次 `model.next()` 前写完整请求（system/messages/tools 全文）到 `~/.ICEFOX-code/traces/*.jsonl`，默认开 |
| `src/inspect-trace.ts` / `src/dump-context.ts` | trace 离线查看器 / 首轮上下文固定开销一次性打印脚本 |
| `src/utils/tool-result.ts` | 双层预算：单条 50k 替换 + 每批 200k 总量按大小降序替换；全文落 `~/.ICEFOX-code/tool-results/<随机进程id>/<toolUseId>.txt`，替换文本含 preview+续读提示；`ContentReplacementState` 按 toolUseId 记忆替换文本实现**跨请求字节级稳定复放** |
| `src/environment.ts` | 进程/项目环境块（shell 探测、git root、slug）。⚠️ `trustProject` 零调用者，trust.json 只读不写 |
| `src/workspace.ts` | `resolveToolPath` 路径闸唯一入口：有 permissions 委托之，无则越界即抛 |
| `src/file-review.ts` | `buildUnifiedDiff`（diff 包）+ `applyReviewedFileChange`（write 的完整审批-写流程） |

### MCP 与交互
| 文件 | 职责 |
|---|---|
| `src/mcp.ts` | **官方 SDK 版（v2）**：Client + Stdio/StreamableHTTP transport、分页 list、sanitize 命名 `mcp__server__tool` + description 头部 "MCP tool from server" 隐式标注、`onclose` 断线摘僵尸、`ToolListChanged` 热更新、结果归一化（content+structuredContent+isError→ok）。工具动态进同一 registry，与内置工具同管线 |
| `src/tty-prompt.ts` | 单读者模型：`attachInputSource` 唯一订阅 rl.line；queue+waiters FIFO，EOF→全部 null。REPL/question/审批共用一条输入通道 |

## 3. 主流程速写

```
启动:  initRegistry → skills → permissions(whenReady) → connectMcpServers(注册进registry)
       → new AnthropicModelAdapter(getToolSchemas() 快照) → messages=[system, catalog, ...resume投影]
每轮:  user 输入 → push+scheduleSave → maybeCompactContext(≥85%×256K 字符估/3.5 触发中段 summarize)
       → beginTurn → agentloop → endTurn
step:  model.next → assistant? return（回合完）
                ↘ tool_calls? → executeTool(registry 查名→zod→run[工具内权限闸]→loop-guard)
                              → 单条50k替换 → 批量200k预算 → append tool_result → 下一step（≤30）
```

## 4. 纪律（改代码前读）

1. **一条消息只能有一个提交点**：agentloop 就地 push 共享数组，返回值=增量，caller 不得回推（历史双提交点 bug：重复 tool_use 破坏配对 → 模型连环重试）
2. **引用纪律**：`scheduleSave` 存数组引用——换会话**重绑**新数组，同会话压缩**原地 splice**；两种写法各自只对一种场景正确
3. **UI 只订阅回调**（`onAssistantMessage/onProgressMessage/onTurnDiags`/新增的 `onThinking`），不读 agentloop 内部状态
4. **deny 不可洗**：bash 的 `gateTouchedPaths` 与 write/edit 共用闸；新工具触达文件必须走 `resolveToolPath`
5. **工具注册先于 adapter 构造**（快照语义），改启动顺序时小心
6. **MCP 工具 schema 是 `z.unknown()` 直通**：参数校验实际发生在远端 server（-32602 会作为 ok:false 回给模型）

## 5. 已知的坑与死代码（TODO.md 有对应条目，此处只列"别被源码骗到"）

- `resumeMessages` 的 `chunkId` 参数算了 `sliced` 但投影仍用全量——形同虚设
- `trusted` 是装饰：环境块宣称 "persistent approvals allowed"，但 PermissionManager 无条件持久化 allow_always；`trustProject` 无人调用
- `readJsonBody` 永远返回对象 → `extractErrorMessage` 的 string 分支不可达（防御性冗余，无害）
- tool-results 目录名是**模块加载时的随机 uuid**，与会话 sessionId 无关，无法反查归属
- 同一 tool_result 三处阈值不一致：实时 50k/200k，resume 投影 25k 且形态变 `[tool X result]` 文本——resume 前后模型看到的不是同一份字节
- SIGINT 有 flushOnExit，**SIGTERM/uncaughtException 没有**；main() try/finally 之前抛错也不 flush
- `providerUsage` 类型字段在 `type.ts` 存在但 loop 不挂载 → token 计数目前是 chars/3.5 假估算（校准方案参考见 TODO B1）
- `ToolRegistry` 类（tool.ts）与 `tools/index.ts` 的 Map registry 并存，**实际用后者**；`getStandardToolSchemas` 与 `getToolSchemas` 功能重复
- 空文件 `src/checkroute.ts`、`src/register.ts`、`src/tools/search_file.ts` + 遗留未注册工具文件：B0 清理项

## 6. 测试与验证现状

无正式测试框架（B0 计划 node:test 起步）。现可行验证手段：`npx tsx <脚本>` 冒烟（如 `smoke-mcp.ts`）；`dump-context.ts` 看首轮固定开销；`inspect-trace.ts` 回放真实请求排错。**动 agentloop/session 前先看 trace**——那里埋着本项目最贵的两个历史 bug（双提交点、引用共享）。
