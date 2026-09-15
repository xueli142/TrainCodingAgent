# icefox-a·gent

一个用 **TypeScript** 写的极简 AI 编码 Agent CLI。

核心理念：**模型 + 工具调用循环**。你把需求交给它，它自主决定调用哪些工具（读文件、搜索代码、执行命令……），把结果回灌给模型，循环往复，直到给出最终答复。

设计取向：**事实与现场分离** —— 盘上永远保留全量事件（append-only），进入模型上下文的只是投影/裁剪后的视图。

## 特性

- 🔁 **Agent 循环** —— `model.next` → 执行工具 → 结果回灌 → 再次请求，单轮最多 30 步
- 🧰 **11 个原子化工具** —— `read` / `write` / `edit` / `bash` / `glob` / `grep` / `todowrite` / `question` / `skill` / `task` / `webfetch`
- 🧠 **渐进式工具披露** —— 上下文里只放 `name + 一句话` 目录，完整 `input_schema` 走 API 的 `tools` 参数
- 💾 **事件溯源会话** —— append-only JSONL，按 `message.id` 幂等增量落盘，支持恢复与切换
- 🗜️ **自动上下文压缩** —— 估算占用超过窗口 85% 时，把中段旧消息摘要成 `context_summary`
- 🌱 **环境探针** —— 进程/项目环境（平台、shell、git 根、trust 状态）注入系统提示
- 🔍 **上下文追踪** —— `--trace` 把每轮完整请求落盘，`inspect-trace` 离线回看与 diff
- 🧩 **思考块与进度标记** —— 保留 provider thinking 块，识别 `<progress>` / `[PROGRESS]` 中间态
- 🔐 **权限约束层** —— 工作区越界检查、改文件前必须先读、危险命令分类（详见「安全与权限」）

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动交互式对话（tsx 直接运行 TS，无需编译）
pnpm start

# 查看历史会话
pnpm start -- --sessions

# 恢复最近一次会话（或指定 id）
pnpm start -- --resume
pnpm start -- --resume <sessionId>

# 记录每轮请求上下文（排查用）
pnpm start -- --trace
```

退出：输入 `/exit`，或按 `Ctrl+C`（会先 flush trace 与待写会话）。

> 也提供全局命令 `icefox start`（`bin/icefox.js`，内部转发到 `pnpm start`）。

### REPL 内命令

| 命令 | 说明 |
| --- | --- |
| `/exit` | 退出 |
| `/sessions` | 列出本项目的历史会话（当前会话带 `*` 标记） |
| `/resume` | 列出会话并提示用法 |
| `/resume <id\|序号>` | 切到指定会话（切换前会打印当前会话的上下文投影预览） |

## 工作原理

1. 用户在终端输入一句话，push 进 `messages`
2. 若估算上下文超阈值 → 先跑一次压缩（`maybeCompactContext`）
3. 进入 `agentloop()`：把消息交给 `model.next()`
4. 若模型返回 `tool_calls` → 逐个执行工具 → 把 `assistant_tool_call` + `tool_result` 追加回消息 → 再问模型
5. 直到模型给出纯文本回复（`assistant`），打印给用户

`messages` 里的角色（`src/type.ts`）：`system` / `tool`（目录）/ `user` / `assistant` / `assistant_thinking` /
`assistant_progress` / `assistant_tool_call` / `tool_result` / `context_summary` / `snip_boundary`。
适配器发送前会把它们折叠成 Anthropic 的 `system` + `messages`（`tool_use` / `tool_result` 配对）。

## 项目结构

```
src/
├─ index.ts              # 入口：REPL、会话恢复/切换、压缩触发、trace 开关
├─ agent_loop.ts         # ★ 主循环：模型 → 工具 → 回灌 → 再请求
├─ anthropic-adapter.ts  # 模型适配器（Anthropic 协议；thinking/progress 解析、trace 埋点、message 折叠）
├─ prompt.ts             # 系统提示词（cwd + 环境块 + 权限摘要）
├─ type.ts               # ChatMessage / AgentStep / ModelAdapter 等类型
├─ tool.ts               # ToolDefinition / ToolResult / ToolRegistry
├─ permissionManager.ts  # 权限决策（path / command / edit，持久化 permissions.json）
├─ session.ts            # 事件溯源会话存储 + 投影（projectMessages）
├─ compact.ts            # 上下文压缩（estimateTokens / maybeCompactContext）
├─ environment.ts        # 进程环境 / 项目环境 / trust.json
├─ context-tracer.ts     # 每轮请求 trace 落盘（traces/*.jsonl）
├─ inspect-trace.ts      # trace 查看器（独立 CLI）
├─ dump-context.ts       # 打印首轮请求体量（system / messages / tools）
├─ workspace.ts          # 工具路径解析：越界检查 → 权限
├─ file-review.ts        # diff 生成 + 审批后写盘
├─ config.ts             # 数据目录 ICEFOX_CODE_DIR
├─ tools/
│  ├─ index.ts           # 工具注册表 + 目录消息 + schema 导出
│  ├─ tool/              # 11 个标准工具 + 辅助模块
│  │  ├─ read.ts write.ts edit.ts bash.ts glob.ts grep.ts
│  │  ├─ todowrite.ts question.ts skill.ts task.ts webfetch.ts
│  │  ├─ fs-walk.ts      # 目录遍历 / glob→regexp
│  │  ├─ read-state.ts   # 「改前必读」状态（记录 mtime/size）
│  │  ├─ schema-io.ts    # zod → JSON Schema
│  │  └─ index.ts        # standardTools 汇总
│  └─ read_file.ts / list_file.ts / run_command.ts / search_file.ts / write_file.ts   # 早期遗留，未注册
└─ utils/
   ├─ errors.ts          # ENOENT 判断等
   └─ tool-result.ts     # 超长工具输出落盘 + 预览
```

## 工具集

| 工具 | 说明 |
| --- | --- |
| `read` | 读取文件 / 目录，行号前缀；二进制拒绝 |
| `write` | 写入文件（要求先 `read`） |
| `edit` | 精确字符串替换，失败即报错；返回 diff |
| `bash` | 执行终端命令，支持 `timeout` / `workdir`，尾部截断 |
| `glob` | 按文件名模式匹配（最多 100 条，按修改时间倒序） |
| `grep` | 按内容正则搜索（最多 200 条匹配） |
| `todowrite` | 维护任务列表（全量替换，`in_progress` 至多一条） |
| `question` | 向用户提问（**未接线**） |
| `skill` | 从 `.icefox/skills` 或 `~/.ICEFOX-code/skills` 加载 `SKILL.md` |
| `task` | 派发子任务（**未接线**） |
| `webfetch` | 抓取网页并转纯文本，超长截断 |

## 数据目录

统一放在 `~/.ICEFOX-code/`（可用环境变量 `ICEFOX_CODE_HOME` 覆盖）：

```
~/.ICEFOX-code/
├─ projects/<cwd-slug>/<sessionId>.jsonl   # 会话事件流（append-only）
├─ traces/<ts>-<session>.jsonl             # --trace 的每轮请求快照
├─ tool-results/<session>/<id>.txt         # 超长工具输出原文
├─ skills/                                 # 全局技能
├─ permissions.json                        # 持久化的允许/拒绝规则
└─ trust.json                              # 项目信任列表
```

### 会话存储

- **事实源**：一行一个 JSON 事件，`append-only`，带 `id / session / seq / cwd / type / ts / parent / message`
- **写入**：`saveMessages` 按 `message.id` 去重；`scheduleSave` 1s 合批，`fsync` 落盘
- **投影**：`projectMessages` 从最后一条 `summary` 起播，只保留 `user` / 非空 `assistant` / `tool_result`（降维成 user 文本）/ `summary` / `snip_boundary`
- `system` 与工具目录消息**不落盘**，每次启动现场重建

## 上下文压缩

`compact.ts`（对齐分层压缩的最低一档）：估算 `Σ chars / 3.5`；达到上下文窗口的 85% 时，保留固定头部
（`system`/`tool`）与尾部最近 `keepRecentMessages` 条，中间段渲染成 transcript 交给模型摘要，产出
`context_summary` 消息。**失败即放弃本轮压缩，绝不丢消息**（盘上事实始终全量）。

可调参数集中在 `COMPACT_CONFIG`：`contextWindowTokens` / `triggerUtilization` / `keepRecentMessages` / `minMiddleMessages`。

## 调试与排查

```bash
# 1) 启动时打开 trace，每轮请求（system / messages / tools 全文）追加到 ~/.ICEFOX-code/traces
pnpm start -- --trace

# 2) 离线查看
npx tsx src/inspect-trace.ts                    # 列出最近的 trace 文件
npx tsx src/inspect-trace.ts --turn 3           # 看第 3 轮的上下文摘要（默认最后一轮）
npx tsx src/inspect-trace.ts --tools            # 该轮 tool_use ↔ tool_result 原文
npx tsx src/inspect-trace.ts --tools-all        # 所有轮次的工具原文
npx tsx src/inspect-trace.ts --diff             # 最后两轮对比：哪块上下文涨了
npx tsx src/inspect-trace.ts --raw --turn 2     # 该轮完整 JSON
npx tsx src/inspect-trace.ts --file <path>      # 指定文件

# 3) 只想知道首轮固定开销（system + tools 的字符/估算 token）
npx tsx src/dump-context.ts
```

## 安全与权限

- **路径**：所有工具路径先经 `workspace.ts` 解析到 cwd；越界交给 `PermissionManager`
- **改前必读**：`read-state.ts` 记录已读文件的 `mtime/size`，`write`/`edit` 前校验（改动过要重读）
- **危险命令分类**：`git reset --hard` / `git clean` / `git checkout --` / `git push --force` / `npm publish`，以及 `node` / `python3` / `bun` / `bash` / `sh` 等任意代码执行
- **决策持久化**：允许/拒绝规则写入 `permissions.json`，可跨会话生效
- **超长输出**：超过 50,000 字符的工具结果落盘，上下文里只留预览与文件路径

> ⚠️ 目前交互式审批 UI **尚未接线**：`index.ts` 里 `new PermissionManager(cwd)` 没有传入 prompt handler，
> 因此需要审批的操作（如 `edit`/`write`、越界访问、危险命令）会直接抛出 `requires approval ... TTY mode`。
> 在接上审批回调之前，这类操作实际上是被硬拒的。

## 技术栈

- **运行时**：Node.js + TypeScript（ES2022 / NodeNext）
- **执行**：`tsx` 直接运行 TS，无构建步骤
- **模型**：Anthropic 兼容协议（默认指向 DeepSeek）
- **依赖**：`zod`（工具入参校验 + JSON Schema 生成）、`diff`（编辑 diff）

## 已知问题与待办

- ⚠️ `anthropic-adapter.ts` 里 API Key 与 `BASE_URL` 硬编码，且 `config.ts` 的 `RuntimeConfig` 未被使用 —— 应改读环境变量
- ⚠️ `PermissionManager` 的交互式 prompt handler 未接线（见上），`edit`/`write`/危险命令目前直接被拒
- `question`、`task` 工具未接线（`setQuestionHandler` / `setTaskExecutor` 未被调用）
- `skill` 的 `available_skills` 未注入系统提示（`formatSkillsForPrompt` 未被调用），模型只能猜技能名
- 工具结果的**批量预算**（`utils/tool-result.ts` 的 `applyToolResultBudget`）尚未接入 `agent_loop`
- `agent_loop.ts` 中 `shouldTreatAssistantAsProgress` 目前恒为 `false`，progress 中间态判断未实现
- 遗留/空文件可清理：`checkroute.ts`、`register.ts`（空）、`src/text/`（空）、`src/tools/` 顶层的旧工具、`test-tool.ts`（引用旧路径）
- 工程配置：`package.json` 的 `name` 仍是 `claude-cli`，`check-deps` 指向不存在的 `scripts/check-deps.js`，`inspect-trace` 提示的 `pnpm dev` 脚本不存在

---

详细设计说明见 [`docs/项目说明.md`](docs/项目说明.md)。
