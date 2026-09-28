# AGENTS.md — icefox-agent

> 供 AI 协作者阅读的项目实况文档。2026-09-25 全量代码扫描写成，B0-B2 后同步至 2026-09-26；行号会随改动漂移，以符号名搜索为准。
> README 面向使用者，本文面向改代码的人：**模块地图、主流程、数据布局、纪律、已知的坑**。

## 1. 定位与原则

教学/个人向极简 coding agent：TypeScript ESM，`tsx` 直跑无构建，pnpm 管理，运行时依赖仅 `zod` / `dotenv` / `diff` / `@modelcontextprotocol/sdk`。核心主张——**主循环只认一个分支变量，一切筛查下放，一切持久化外置**。改代码时保持"可通读"优先于功能数量；上 UI 框架（Ink/OpenTUI）是被明确拒绝的（TODO B3）。

```
pnpm start                 # 交互式 REPL（先跑 pnpm install）
pnpm start -- --sessions   # 列历史会话
pnpm start -- --resume [id|序号|前缀]   # 裸 --resume 进编号选择
pnpm check                 # tsc 类型检查（noEmit）
pnpm test                  # node:test 全套
npx tsx smoke-mcp.ts       # MCP 连通性冒烟（server-everything 当靶子）
```

`.env` 必需：`MODEL` / `API_KEY` / `BASE_URL`（走 `Authorization: Bearer`，非官方 x-api-key）；可选 `THINKING_BUDGET`（默认 2048，`0` 关闭 extended thinking）、`MODELS_URL`（覆盖模型列表地址；不填则按 `BASE_URL` 推导 `${base}/models` → 去 `/anthropic|/v1` 后缀的根 → origin）、`ICEFOX_TRACE=0`（关 trace）、`ICEFOX_CODE_HOME`（改数据根目录）。

## 2. 模块地图

### 入口与装配（composition root）
| 文件 | 职责 |
|---|---|
| `src/index.ts` | **入口薄壳（~230 行，原 610 行已拆分）**。装配时序：`initRegistry()`(静态工具) → `installQuestionHandler` → `discoverSkills` → `PermissionManager.whenReady` → **`connectMcpServers(loadMcpConfig(cwd))`** → `new AnthropicModelAdapter(getToolSchemas())`（⚠️ 工具在此快照，MCP 必须先注册）→ 构造 `ReplContext` → readline + 输入历史 `history.jsonl`(↑↓) + `slashCompleter`(Tab) → **Ctrl+C 双语义**（回合中=取消当前回合 AbortController+interruptWaiters，空闲=退出）→ 启动 `--resume` → 主循环：`readLine(statusLine+提示符)` → `handleSlash` 分发或 `runTurn`；`--sessions` 只列不进 REPL |
| `src/repl/context.ts` | `ReplContext` 共享状态容器（cwd/projectRoot/model/permissions/toolResultState/historyFile/sessionId/messages/activeTurn/systemContent）；注释写明**重绑=换会话、原地 splice=压缩**的引用纪律两分法 |
| `src/repl/turn.ts` | `runTurn(ctx, input)`：登记 user → 双层 compact → `agentloop`（四回调输出）→ 收据保存；`captureContextSnapshot(ctx)`：启动/切会话固化 system+catalog+tools。这就是将来 TUI 直接复用的"回合 API" |
| `src/repl/slash.ts` | `SLASH_COMMANDS` / `slashCompleter` / `handleSlash`→`'exit'｜'continue'｜'passthrough'`（未识别 `/xxx` 按普通输入进模型）。已实现 `/exit /clear /sessions /rename /resume /compact /mcp /status /help`；`/delete /model /init` 占位 |
| `src/repl/status.ts` | `statusLine(ctx)`：session/model/ctx 利用率条(每格 2 万 token)/mcp 就绪数——prompt 前置、Ctrl+L、回合中每个 tools step 经 onTurnDiags 重打共用 |
| `src/repl/hotkeys.ts` | 空闲全局键：Ctrl+G 会话选择器（picker→deliverLine）/ Ctrl+L 重绘；`ctx.activeTurn` 非空一律放行 |
| `src/question-ui.ts` | question 工具 TTY 接线：单选=picker 模态+"自定义文本"回落行输入；多选=`discardQueuedInput` 防抢答后编号/自由文本 |
| `bin/icefox.js` | 薄壳：`icefox start` → `pnpm start` |
| `src/config.ts` | env 常量 + `ICEFOX_CODE_DIR` + `McpServerConfig` 类型（含 enabled）+ **`loadMcpConfig(cwd)`**：用户级 `~/.ICEFOX-code/mcp.json` 与项目级 `.icefox/mcp.json` 合并（支持 Cursor 的 `mcpServers` 包裹），内置 `DEFAULT_MCP_SERVERS` 兜底；`RuntimeConfig` 类型无人使用 |

### Agent 内核
| 文件 | 职责 |
|---|---|
| `src/agent_loop.ts` | 回合内核。每 step 调 `model.next()` 后只有三条出路：`assistant` → append + **return 结束回合**；`tool_calls` → 逐个 `executeTool`（registry 查名 → zod safeParse → run → catch 转 ok:false）→ loop-guard（同调用第 10 次注入警告）→ 结果过双层预算 → 下一 step；空响应 → 有 progress 文本则续跑否则 return。30 步上限。返回 `TurnReceipt`（addedCount+kind+usage/stopReason），消息只就地 push。接受 `signal`（AbortSignal）：取消时批内未执行调用补配对 cancelled 结果，`kind:'aborted'` 收尾。**权限不在这里**（塞进 `ToolContent.permissions` 由工具自查）；输出全走回调，不碰 UI/落盘 |
| `src/compact.ts` | 压缩两层：`maybeCompactContext` 先 micro（利用率过半，旧 tool_result 就地清 `[cleared]`，盘上不动）后 auto（≥85%×effectiveInput 中段 summarize）；`force` 支持手动 `/compact`；summary 落成后 `markUsagesStale` 整批标脏 |
| `src/type.ts` | `ChatMessage` 12 角色联合类型（含 `assistant_thinking` 带 signature 块、`context_summary`、`snip_boundary`）；`AgentStep`（assistant \| tool_calls，usage 现在会挂到消息的 `providerUsage` 上） |
| `src/prompt.ts` | `buildSystemPrompt`：身份行 + 环境块 + cwd + 行为准则 + **denial 硬停条款（禁 bash 绕行）** + 权限摘要 + skills 目录块 |

### 模型适配
| 文件 | 职责 |
|---|---|
| `src/anthropic-adapter.ts` | 线格式转换 + HTTP。`toAnthropicMessages`：thinking 块带 signature 原样回放；`tool_result` 归 user；`context_summary` 以 user 消息注入。`normalizeAnthropicUsage`：input 计入两项 cache token。`readJsonBody`/`extractErrorMessage` 防错误体吞掉。重试：429/408/5xx/网络错按 `Retry-After` 或指数退避至多 4 次，空响应补枪 2 次，abort 不重试。⚠️ **无 stop_reason 映射**——分支只看 content 里有无 tool_use；`max_tokens` 截断、refusal 未处理 |

### 工具系统
| 文件 | 职责 |
|---|---|
| `src/tool.ts` | `ToolDefinition`（name/description/inputSchema JSON Schema + zod schema + run）、`ToolContent {cwd, permissions, signal?}`（signal 为回合取消信号，长跑工具应自觉接）、`ToolRegistry`（另一个类，实际 REPL 用的是下面 Map 版） |
| `src/tools/index.ts` | **registry 事实本体**：模块级 `Map` + `initRegistry/registerTool/unregisterToolsByPrefix/getTool/getToolSchemas`；渐进披露：`buildToolCatalogMessage()` 生成 name+首行摘要的目录消息进上下文，完整 schema 走 API tools 参数。`NOT_WIRED_TOOLS={task,question}` 是静态提示名单 |
| `src/tools/tool/index.ts` | `standardTools` 11 件套（opencode 同名集）：bash/edit/glob/grep/question/read/skill/task/todowrite/webfetch/write |
| `src/tools/tool/bash.ts` | 权限最重的工具：拆段逐条 `ensureCommand` + **`gateTouchedPaths` 绕行硬闸**（命中已 deny 的 edit 目标直接抛错，防 deny 被 bash 洗掉）；win32 用 taskkill /T 杀树；接 `context.signal`（Ctrl+C 杀进程树）；`background:true`/尾随 `&` → detached 起后台，日志 `~/.ICEFOX-code/jobs/` + 退出码 sentinel，模型用 read 跟进。输出不再内部截断（交统一层） |
| `src/tools/tool/edit.ts` / `write.ts` | 都走"先读后改"（`read-state.ts` 账本）→ 构建 unified diff → **`ensureEdit(path, diff)` 审批在工具内** → 写后 `rememberRead` 防自环 |
| `src/tools/tool/read.ts` | `N: content` 行号格式、单行 2000 字符截、目录列表、二进制 NUL 拒绝、读完登记指纹 |
| `src/tools/tool/glob.ts` / `grep.ts` | 共用 `fs-walk.ts`（手写 glob→RegExp + 栈式 DFS）；grep 纯 JS 非 ripgrep，限额 200 匹配/6000 文件 |
| `src/tools/tool/skill.ts` | SKILL.md 发现（`.icefox/skills` + `.claude/skills`，从 cwd 向上到 git 根 + 用户级两目录）+ 两阶段披露；frontmatter 支持块标量 `|`/`>`（非完整 YAML）；name≠目录名/重名显式 warn |
| `src/tools/tool/question.ts` / `task.ts` | "not wired"模式：模块级单例 setter。question 已在 index.ts 接 TTY handler；**task 全仓无注册点，是唯一真未接线工具** |
| `src/tools/tool/todowrite.ts` | 状态存模块级内存变量，**不落盘不进 session** |
| `src/tools/tool/schema-io.ts` | zod→JSON Schema 唯一出口（`io:'input'`，删 $schema） |
| `src/tools/tool/read-state.ts` / `fs-walk.ts` | 辅助：改前必读账本（mtime+size 指纹）/ 目录遍历底座 |

### 权限
| 文件 | 职责 |
|---|---|
| `src/permissionManager.ts` | 三把闸：`ensurePathAccess`（workspace 内直放）/ `ensureCommand`（先 cwd 后命令，`classifyDangerousCommand` 硬归类）/ `ensureEdit`（7 选项含 turn 级 allow_turn/allow_all_turn）。持久层 `~/.ICEFOX-code/permissions.json` 六组前缀/模式数组；内存层 session deny 集合（不持久）。`beginTurn/endTurn` 清 turn 级授权；文件整体 2 空格缩进异常 |
| `src/permissionUi.ts` | 审批卡 → picker 的薄适配：choices 映射为选项、details 进 detail（Ctrl+O 可展），取消=deny_once（fail-closed）；deny_with_feedback 回落 `readLine` 收文本 |
| `src/picker.ts` | 决策模态选择器（B3 L1）：↑↓/j/k 导航、1-9 与 option.key 单键直达、Enter 确认、Esc=取消、Ctrl+O 展开 detail。**全程走 onKey + settle 微任务拆栈**——Enter 伴生的 line 在"栈顶不接线"时被丢弃，单键漏进 buffer 的字符被 flushTypedInput 清理，结构性防抢答；`setPickerWriter` 供测试注入静默 sink（别猴补 process.stdout，会吞测试报告器） |

### 持久化与数据
| 文件 | 职责 |
|---|---|
| `src/session.ts` | **事实日志**：`~/.ICEFOX-code/projects/<slug>/<sessionId>.jsonl` append-only，13 种事件类型。写路径三层：`appendSessionEvent`（即时落盘）、`saveMessages`/`scheduleSave`（按 id 去重增量 + 1s 批量 + `withStoreLock` promise 链串行化保 seq 链）、`flushSessionSaves`（退出/切会话前）。读路径 `projectMessages`：**从最后一条 summary 起播**；thinking/progress/tool_call 不进上下文（tool_call 的 input 留盘审计）；tool_result 降维为 user 文本截 25k。`resolveSessionId`（序号/精确/唯一前缀）与 `previewMessages`（一行式预览）也在本模块，供 REPL 与启动 `--resume` 共用 |
| `src/context-tracer.ts` | 每次 `model.next()` 前写完整请求（system/messages/tools 全文）到 `~/.ICEFOX-code/traces/*.jsonl`，默认开 |
| `src/inspect-trace.ts` / `src/dump-context.ts` | trace 离线查看器 / 首轮上下文固定开销一次性打印脚本 |
| `src/utils/tool-result.ts` | 双层预算：单条 50k 替换 + 每批 200k 总量按大小降序替换；`EXEMPT_RESULT_TOOLS={skill,edit}` 豁免；全文落 `~/.ICEFOX-code/tool-results/<随机进程id>/<toolUseId>.txt`，替换文本含 preview+续读提示；`ContentReplacementState` 按 toolUseId 记忆替换文本实现**跨请求字节级稳定复放**；`pruneToolResults()` 7 天 TTL（启动调用） |
| `src/utils/token-estimator.ts` | token 感知唯一出口：分角色字符率、**锚点+增量**计数（新鲜 `providerUsage.inputTokens` 起锚，尾段才字符估）、`markUsagesStale`；窗口来源二层——启动时 `hydrateModelContextWindow(model,{baseUrl,apiKey,modelsUrl})` 向 provider `/models` 要真实 `context_window`/`max_output_tokens` 写进进程缓存（候选地址链：MODELS_URL→base/models→去后缀→origin），`getModelContextWindow` 同步读缓存、**未命中一律回退 1M 兜底**（不再有离线模型表，启动日志明说"回退 1M"）；`formatTokens`（/1000 四舍五入，<1M 用 K、≥1M 用 M）供状态行统一展示；compact 触发与四档 warningLevel 都消费它 |
| `src/environment.ts` | 进程/项目环境块（shell 探测、git root、slug）。B0 已摘除 trust 装饰（trustProject/trusted 字段/环境块宣称均已删） |
| `src/workspace.ts` | `resolveToolPath` 路径闸唯一入口：有 permissions 委托之，无则越界即抛 |
| `src/file-review.ts` | `buildUnifiedDiff`（diff 包）+ `applyReviewedFileChange`（write 的完整审批-写流程） |

### MCP 与交互
| 文件 | 职责 |
|---|---|
| `src/mcp.ts` | **官方 SDK 版（v2）**：Client + Stdio/StreamableHTTP transport、分页 list、sanitize 命名 `mcp__server__tool` + description 头部 "MCP tool from server" 隐式标注、`onclose` 断线摘僵尸、`ToolListChanged` 热更新、结果归一化（content+structuredContent+isError→ok）、`enabled:false` 落 disabled 态、运行时 `reconnectMcpServer`/`disconnectMcpServer`（配置缓存在 configMap）。工具动态进同一 registry，与内置工具同管线 |
| `src/tty-prompt.ts` | 单读者模型（B3 L1）：`attachInputSource` 唯一订阅 rl.line；queue+waiters FIFO，EOF→全部 null。**模态栈路由**：`pushModal({onKey,onLine,onClose})`——栈非空时 keypress 只给栈顶、line 交栈顶 onLine（无 onLine 则丢弃=结构性防抢答）；`interruptWaiters`/EOF 先关模态再 null 唤醒等待者；`flushTypedInput` 清模态消费后漏进 readline 缓冲的残字。**全局键表**：`onGlobalKey`（无模态时收 keypress，供 Ctrl+G/Ctrl+L 类空闲快捷键）+ `deliverLine`（模态把结果注入回等待中的 readLine）。未迁移消费方（question 多选等仍用 readLine）行为不变 |

## 3. 主流程速写

```
启动:  initRegistry → skills → permissions(whenReady) → connectMcpServers(注册进registry)
       → new AnthropicModelAdapter(getToolSchemas() 快照) → messages=[system, catalog, ...resume投影]
每轮:  user 输入(+history) → push+scheduleSave → maybeCompactContext(micro:util≥50% 清旧 tool_result；
       auto:util≥85%×effectiveInput 中段 summarize) → beginTurn+AbortController → agentloop → endTurn
       （Ctrl+C：activeTurn.abort() → 循环以 kind:'aborted' 收尾，待答卡按拒绝唤醒）
step:  model.next → assistant? return（回合完）
                ↘ tool_calls? → executeTool(registry 查名→zod→run[工具内权限闸]→loop-guard)
                              → 单条50k替换 → 批量200k预算 → append tool_result → 下一step（≤30）
```

## 4. 纪律（改代码前读）

1. **一条消息只能有一个提交点**：agentloop 就地 push 共享数组，返回值是 `TurnReceipt`（不含消息）——caller 回推在类型层已不可能（历史双提交点 bug：重复 tool_use 破坏配对 → 模型连环重试）
2. **引用纪律**：`scheduleSave` 存数组引用——换会话**重绑**新数组，同会话压缩**原地 splice**；两种写法各自只对一种场景正确
3. **UI 只订阅回调**（`onAssistantMessage/onProgressMessage/onTurnDiags`/新增的 `onThinking`），不读 agentloop 内部状态
4. **deny 不可洗**：bash 的 `gateTouchedPaths` 与 write/edit 共用闸；新工具触达文件必须走 `resolveToolPath`
5. **工具注册先于 adapter 构造**（快照语义），改启动顺序时小心
6. **MCP 工具 schema 是 `z.unknown()` 直通**：参数校验实际发生在远端 server（-32602 会作为 ok:false 回给模型）
7. **改完必交修改简报**：每轮改动收尾时输出——动了哪些文件（`git diff --stat` 口径）、每项一句话动机、验证结果（`pnpm check` / `pnpm test` / 冒烟命令的实际输出结论，不许写"应该没问题"）、未尽事项；涉及行为变化的同步更新 README / TODO.md / 本文档的实况段落

## 5. 已知的坑与死代码（TODO.md 有对应条目，此处只列"别被源码骗到"）

- `readJsonBody` 永远返回对象 → `extractErrorMessage` 的 string 分支不可达（防御性冗余，无害）
- tool-results 目录名是**模块加载时的随机 uuid**，与会话 sessionId 无关，无法反查归属
- 同一 tool_result 三处阈值不一致：实时 50k/200k，resume 投影 25k 且形态变 `[tool X result]` 文本——resume 前后模型看到的不是同一份字节
- `ToolRegistry` 类（tool.ts）与 `tools/index.ts` 的 Map registry 并存，**实际用后者**；`getStandardToolSchemas` 与 `getToolSchemas` 功能重复
- abort 只保证「不留孤儿 tool_use + 收据正确」：长跑但不接 `context.signal` 的工具（edit 审批除外，它走 interruptWaiters）取消后仍会跑完当前那一次，只是结果丢弃
- ESC 在 picker 模态内=取消该卡；但**回合级取消仍只有 Ctrl+C**（空闲捕获 ESC 需自绘输入行，暂缓）；`onThinking` 预览截断是 UI 行为，盘上 thinking 仍全量
- `/mcp connect/disconnect` 是运行时开关，但**改 mcp.json 仍要重启**（文件 watcher 没做）

（B0 已清：trust 装饰、遗留工具文件、空文件、`check-deps` 坏脚本均已移除；`resumeMessages` chunkId 已实现为投影截断段）
（B1/B2 已清：`providerUsage` 现已挂到 assistant 系消息 + token 锚点计数；SIGTERM 与 `main().catch` 启动段抛错均已 flush；MCP 配置已外置到 mcp.json）

## 6. 测试与验证现状

`pnpm check`（tsc noEmit）+ `pnpm test`（node:test 经 tsx，五个文件 29 用例：`agent-loop`[收据/loop-guard/预算复放/abort×2] `tty-modal`[模态栈路由] `picker`[选择器+Enter 竞态] `keypress-wiring`[真 readline 伪 TTY 锁 keypress 监听对象] `token-estimator`[1M 兜底/formatTokens/远端缓存优先]；测试自行把 `ICEFOX_CODE_HOME` 指到临时目录）。另有冒烟手段：`npx tsx smoke-mcp.ts`（MCP 连通）、`dump-context.ts`（首轮固定开销）、`inspect-trace.ts`（回放真实请求）。**动 agentloop/session 前先看 trace**——那里埋着本项目最贵的两个历史 bug（双提交点、引用共享）。
