# icefox-agent

一个用 **TypeScript** 写的极简 AI 编码 Agent CLI。

核心理念：**模型 + 工具调用循环**。你把需求交给它，它自主决定调用哪些工具（读文件、搜索代码、执行命令……），把结果回灌给模型，循环往复，直到给出最终答复。

设计取向：**事实与现场分离** —— 盘上永远保留全量事件（append-only），进入模型上下文的只是投影/裁剪后的视图。改代码前请先读 [`AGENTS.md`](AGENTS.md)。

## 特性

- 🔁 **Agent 循环** —— `model.next` → 执行工具 → 结果回灌 → 再次请求，单轮最多 30 步；返回 `TurnReceipt` 收据
- 🧰 **11 个原子化工具** —— `read` / `write` / `edit` / `bash` / `glob` / `grep` / `todowrite` / `question` / `skill` / `task` / `webfetch`
- 🔌 **MCP 客户端** —— 官方 SDK，stdio + Streamable HTTP，外部工具以 `mcp__server__tool` 融入同一管线，断线自动摘除、清单热更新
- 🧠 **渐进式工具披露** —— 上下文里只放 `name + 一句话` 目录，完整 `input_schema` 走 API 的 `tools` 参数
- 💾 **事件溯源会话** —— append-only JSONL，按 `message.id` 幂等增量落盘，支持恢复与切换
- 🗜️ **两层上下文压缩** —— 过半先清旧 tool_result（micro），85%×真实窗口再中段摘要（auto）
- 📐 **真实 token 感知** —— usage 锚点+增量计数；窗口启动时向 provider `/models` 请求真值（拿不到回退 1M 并明说）
- ⌨️ **轻 TUI** —— 审批/选择用方向键高亮卡片（单键直达、Esc 拒绝），Tab slash 补全，Ctrl+G 会话切换，常驻状态行
- 🛑 **回合可取消** —— 回合中 `Ctrl+C` 只取消当前回合（工具杀进程树、审批卡按拒绝结算），空闲时才退出
- 🔍 **上下文追踪** —— 默认开启：每轮完整请求落盘 `traces/`，`inspect-trace` 离线回看与 diff
- 🔐 **权限约束层** —— 三闸审批（path/command/edit）、拒绝不可被 bash 绕行、危险命令分类

## 快速开始

```bash
pnpm install
pnpm start                          # 交互式 REPL
pnpm start -- --sessions            # 列历史会话
pnpm start -- --resume [id|序号|前缀]  # 恢复（裸 --resume 进编号选择）
pnpm check                          # tsc 类型检查
pnpm test                           # node:test（29 用例，临时数据目录隔离）
npx tsx smoke-mcp.ts                # MCP 连通性冒烟
```

`.env`：`MODEL` / `API_KEY` / `BASE_URL`（`Authorization: Bearer` 鉴权）；可选 `THINKING_BUDGET`（默认 2048，`0` 关闭 extended thinking）、`MODELS_URL`（覆盖窗口查询地址）、`ICEFOX_TRACE=0`、`ICEFOX_CODE_HOME`。

### REPL 命令与按键

| 命令 / 按键 | 说明 |
| --- | --- |
| `/exit`、空闲 `Ctrl+C`/`Ctrl+D` | 退出（先 flush trace/会话/MCP） |
| **回合中 `Ctrl+C`** | 只取消当前回合，待答卡按拒绝结算 |
| `/clear` | 清空上下文开新会话（旧会话在盘上可找回） |
| `/sessions` | 列历史会话（当前带 `*`，尾行显示权限文件路径） |
| `/rename <标题>` | 重命名当前会话 |
| `/resume [id\|序号\|前缀]` | 切换会话（切换前打印上下文投影预览） |
| `/compact` | 手动压缩（micro 优先，必要时 summary） |
| `/mcp` | MCP 状态表（●/○/✗）；`/mcp connect|disconnect <name>` 运行时开关 |
| `/status` | 状态行详版：tokens/利用率来源/warningLevel/MCP 明细 |
| `/help` | 命令列表；`/delete` `/model` `/init` 为占位 |
| `Tab` | slash 命令补全 |
| `↑↓` | 输入历史（`history.jsonl` 持久化，启动载入） |
| `Ctrl+G` / `Ctrl+L` | 会话选择器 / 状态行重绘 |
| **审批卡按键** | `↑↓`/`jk` 移动 + Enter，或单键直达（y/a/n/d 或 1-7），`Esc`＝拒绝，`Ctrl+O` 展开 diff/明细 |

## 工作原理

```
启动: 注册静态工具 → 发现 skills → 加载权限 → 连接 MCP（注册外部工具）→ 构造 adapter
      （工具在此快照）→ 组装 system+目录+恢复投影 → readline 循环
每轮: 输入(+历史) → push+排程落盘 → 压缩检查 → beginTurn+取消令牌 → agentloop → endTurn
step: model.next → assistant? 结束回合
              ↘ tool_calls? → 查表→zod→执行[工具内权限闸] → loop-guard → 预算裁剪 → 下一 step
```

上下文角色（`src/type.ts`）：`system` / `tool`（目录）/ `user` / `assistant` / `assistant_thinking`（带签名回放）/ `assistant_progress` / `assistant_tool_call` / `tool_result` / `context_summary` / `snip_boundary`。适配器折叠成 Anthropic 线格式发送。

> **agentloop 合约（勿回退）**：新消息**就地 push** 进调用方共享数组；返回 `TurnReceipt`（新增数/结束类型/usage）——一条消息只有一个提交点。**引用纪律**：换会话**重绑**数组、压缩**原地 splice**（详见 AGENTS.md 第 4 节）。

## 项目结构

```
src/
├─ index.ts              # 装配根 + REPL：启动时序、斜杠命令、Ctrl+C 双语义、状态行、快捷键
├─ agent_loop.ts         # ★ 主循环：唯一分支变量，TurnReceipt 收据，abort 配对
├─ anthropic-adapter.ts  # 线格式转换 + 重试退避 + thinking + trace 埋点
├─ prompt.ts  type.ts  tool.ts  config.ts        # 系统提示 / 类型 / 工具契约 / env+MCP 配置
├─ permissionManager.ts  permissionUi.ts          # 三把闸+分层记忆 / 审批卡→picker 适配
├─ tty-prompt.ts         # 单读者 + 模态栈键路由（keypress 听 stdin，line 栈顶优先）
├─ picker.ts             # 决策模态选择器（高亮列表/单键直达/Esc=fail-closed/Ctrl+O）
├─ session.ts            # 事件溯源存储 + 投影（chunkId 可截断重放）
├─ compact.ts            # micro（清旧 tool_result）+ auto（中段摘要）+ usage 标脏
├─ mcp.ts                # 官方 SDK 客户端：双 transport、sanitize 命名、热更新、运行时开关
├─ environment.ts  workspace.ts  file-review.ts   # 环境块 / 路径闸 / diff 审批写盘
├─ context-tracer.ts  inspect-trace.ts  dump-context.ts   # trace 落盘 / 查看器 / 首轮开销
├─ tools/
│  ├─ index.ts           # registry（Map）+ 目录消息 + MCP 动态注册/摘除接口
│  └─ tool/              # 11 标准工具 + fs-walk / read-state / schema-io
└─ utils/
   ├─ token-estimator.ts # 锚点+增量计数 / 真实窗口 hydrate(1M 兜底) / formatTokens
   ├─ tool-result.ts     # 双层预算(50k/200k) + 字节级稳定复放 + TTL 清理
   └─ errors.ts
```

## 工具集要点

| 工具 | 说明 |
| --- | --- |
| `bash` | 权限最重：拆段审批 + 绕行硬闸；`background:true`/尾随 `&` 起后台（日志 `jobs/`+退出码哨兵）；接取消信号杀进程树 |
| `edit`/`write` | 改前必读（mtime/size 账本）→ diff 审批在工具内 → 写后记账 |
| `skill` | 发现 `.icefox/skills`、`.claude/skills`（项目向上至 git 根 + 用户级），摘要进提示、正文按需加载 |
| `question` | 单选走 picker 高亮卡，多选/无选项回落行输入 |
| `mcp__*` | 远程 MCP 工具，description 带 "MCP tool from server" 标注；schema 直通（远端校验） |

## MCP 配置

`~/.ICEFOX-code/mcp.json`（用户级）与 `.icefox/mcp.json`（项目级，同名覆盖）合并读取，兼容 Cursor 的 `mcpServers` 包裹：

```json
{
  "mcpServers": {
    "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\some\\dir"] },
    "api":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${MY_TOKEN}" } },
    "dead": { "command": "…", "enabled": false }
  }
}
```

改配置需重启；运行时开关用 `/mcp connect|disconnect <name>`。

## 数据目录

`~/.ICEFOX-code/`（`ICEFOX_CODE_HOME` 可覆盖）：

```
├─ projects/<cwd-slug>/<sessionId>.jsonl   # 会话事件流（append-only，13 类事件）
├─ traces/<ts>-<session>.jsonl             # 每轮请求全文
├─ tool-results/<进程id>/<id>.txt          # 超长工具输出原文（7 天 TTL 自动清理）
├─ jobs/<id>.log                           # 后台任务日志（尾部含退出码哨兵）
├─ skills/                                 # 用户级技能
├─ mcp.json  permissions.json  history.jsonl
```

## 上下文与窗口

- 计数：`usage.inputTokens` 锚点 + 尾部分角色字符估；压缩后锚点整批标脏
- 窗口：启动向 `/models` 请求真实 `context_window`/`max_output_tokens`（候选地址链，`MODELS_URL` 可指定）；拿不到回退 **1M**，启动日志注明；展示统一 `/1000` 四舍五入（K/M）
- 触发：util ≥50% micro / ≥85% auto，参数集中在 `COMPACT_CONFIG`

## 安全与权限

- 三闸：path（workspace 内直放）/ command（危险分类命中才问）/ edit（**永远问**，7 选项含 turn 级与反馈式拒绝）
- 记忆层级：持久化 `permissions.json` ＞ 回合（仅 edit）＞ 一次性；`allow_once` 真·一次性
- **拒绝不可洗**：bash 抽路径候选，命中已 deny 的 edit 目标直接抛错；越界走与 write 同一把闸
- **fail-closed**：审批卡 `Esc`/Ctrl+C/EOF 一律按拒绝处理
- loop-guard：相同调用第 10 次注入警告并标 error，掐断无脑重试

## 调试与排查

```bash
npx tsx src/inspect-trace.ts [--file f] [--turn N] [--tools|--tools-all|--diff|--raw]
npx tsx src/dump-context.ts     # 首轮固定开销
npx tsx smoke-mcp.ts            # MCP 连通（everything 靶子）
```

动 `agentloop`/`session` 前先看 trace——本项目最贵的两个历史 bug（双提交点、引用共享）都埋在那里。

## 技术栈

Node.js + TypeScript（ESM，`tsx` 直跑无构建）· `zod` · `diff` · `dotenv` · `@modelcontextprotocol/sdk` · `node:test`

## 已知问题

- resume 后 tool_result 的阈值与形态与实时不一致（25k 文本 vs 50k/200k 块），跨 resume 字节级复现在边界断裂
- tool-results 目录名是随机进程 id，无法反查会话归属
- `task` 工具未接线（返回引导文案）；`/delete` `/model` `/init` 是占位
- 完整清单与路线规划见 [`TODO.md`](TODO.md)

---

详细设计说明见 [`docs/项目说明.md`](docs/项目说明.md)。
