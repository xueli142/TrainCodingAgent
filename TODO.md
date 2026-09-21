# icefox-agent TODO

> 2026-09-20 整理。对照 `icefox-agent-对比报告.md`（vs MiniCode / opencode）与最近几轮代码审查。
> 原则：先还债 → 再补体验 → MCP → TUI。标 ⭐ 的为性价比最高项。

## 已完成（本轮已落地，留档备查）

- [X] skills 目录注入系统提示（`discoverSkills` + `formatSkillsForPrompt`）
- [X] `question` 工具接线（单读者 `readLine` 模态分发）
- [X] 工具结果批量预算 + 稳定替换（`toolResultState` 接入 `agentloop`）
- [X] `allow_once` 真·一次性（删死集合）、`/sessions` 标题 fallback（首条 user 截断）
- [X] tty-prompt 重写：单读者 + waiters 队列 + EOF→null（全链路 null 语义）
- [X] README 同步至当前真实行为
- [X] `/rename`（rename 事件生产者）+ `/clear`（开新会话不删盘）+ `/help`；占位命令统一"提示+continue"
- [X] **修复 `/resume` 污染旧会话的引用共享 bug**：`messages` 改 `let`，换会话时重绑新数组（压缩保持原地 splice）；`scheduleSave` 存引用，旧 job 不再看到新内容
- [X] `executeTool` 调试 `console.log` 噪音移除

## B0 · 还债（~0.5-1 天，先做这个）

- [ ] ⭐ `agentloop` 返回值改**收据**而非消息数组：`Promise<TurnReceipt>`（`addedCount / stopReason / usage`），调用方要内容就 `messages.slice(before)`——让"caller 不得回推"从 README 约定变成编译期不可能（类型仍是 `ChatMessage[]` 就是给未来调用方留弹药）
- [ ] `saveMessagesLocked` 批次内不去重：同一次调用数组里重复的同 id 消息会双双落盘（去重集合来自盘上快照，批内不回填）→ filter 时同步 add
- [ ] 弹卡抢答边界：回合中提前输入会排队，被下一张审批卡吃掉 → 弹卡时提示"回车跳过已排队输入"或清空 stale queue
- [ ] trust 闭环：`trustProject` 接线加 `/trust` 命令，或者把 trust 从 system prompt 里摘掉——不要留装饰
- [ ] `getPermissionsPath`：接进 `/sessions` 输出展示，或删
- [ ] `resumeMessages` 的 `chunkId` 切片：要么实现（会话回放/分支用），要么删参数
- [ ] 工程卫生：`.gitattributes`（`* text=auto eol=lf`）；`package.json` name 改 `icefox-agent`、修/删坏掉的 `check-deps` 脚本；加 `check` 脚本（devDep typescript + `tsc --noEmit`，这几轮全靠借 MiniCode 的 tsc）；清理 `tools/` 顶层 5 个未注册遗留文件 + 空文件 `register.ts`/`checkroute.ts`/`search_file.ts`/`text/`
- [ ] **冒烟测试起步**（node:test，对齐 MiniCode）：agentloop 增量合约 / loop-guard / 批量预算替换稳定性 3 个用例

## B1 · 体验补齐（~1-2 天）

- [ ] ⭐ **统一截断层**（参照 opencode Truncate + MiniCode tool-result-storage）：
  - 工具返回原文，`executeTool` 统一做：超限 → 原始全文落 `tool-results/`，替换为「预览 + read(path, offset) 续读提示」；bash/webfetch 删内部截断（现在头部直接丢了）
  - `skill`/`edit` 进豁免名单；`ToolResult` 加 `metadata.outputPath/truncated`
  - `tool-results/` 加 7 天 TTL 启动清理（现在永久堆积）
- [ ] ⭐ **后台任务**（参照 MiniCode run_command）：`bash` 加 `background?: boolean` + 尾随 `&` 自动识别；detached spawn → 日志落 `~/.ICEFOX-code/jobs/`；sentinel 记退出码；`process.kill(pid,0)` 探活；模型用 `read`/`kill` 即可闭环，不加新工具
- [ ] `--resume` / `/resume` 可交互化：列编号 + 输序号回车即切（裸 `--resume` 启动时进选择）；id 支持前缀模糊匹配
- [ ] 输入历史：`~/.ICEFOX-code/history.jsonl` 持久化 + ↑↓ 翻找
- [ ] 模型请求重试：429/5xx 指数退避 + `Retry-After`（最多 3-5 次）；空响应重试 2 次
- [ ] 手动 `/compact` 命令；microcompact（利用率过半时旧 tool_result 清成 `[cleared]` 占位）

## B2 · MCP 最小闭环（~2-3 天）

参照 MiniCode `mcp.ts` 砍到 ~400 行：

- [ ] stdio JSON-RPC：initialize 握手 → `tools/list` → `tools/call`
- [ ] 命名 `server__tool`，与现有 11 工具共用同一套 directory / input_schema / 执行管线
- [ ] 结果归一化：text 拼接 + structuredContent；`isError` → `ok:false`
- [ ] 配置：`~/.ICEFOX-code/mcp.json` + 项目 `.icefox/mcp.json` 合并；`enabled:false`
- [ ] 状态展示：启动时打印各 server 连接结果；失败不阻塞启动
- [ ] **跳过（v2 再说）**：resources / prompts / OAuth / streamable-http / 协议协商缓存

## B3 · TUI（分两步，先 L1）

- [ ] **L1 readline 化妆（~1-2 天）**：状态行（session / model / ctx 利用率）；审批卡配色；`/` 前缀补全；`/status` 命令
- [ ] L2 自绘全屏（一周级，另立项）：raw mode + 备用屏幕 + diff 渲染；参照 MiniCode `tty-app.ts`（2.5k 行教材）——输入事件串行化防互踩；审批变弹窗（diff 可滚动）；工具行折叠
- [ ] ❌ 不上 Ink/OpenTUI：React 依赖与"极简可通读"冲突
- [ ] 纪律（现在就守）：**UI 只订阅 `onAssistantMessage`/`onProgressMessage`/`onTurnDiags` 事件流，不读 agentloop 内部状态**——L2 时只搬 REPL，主循环不动

## 架构备忘（别回退）

- **一条消息只能有一个提交点**：agentloop 就地 push 共享数组（崩溃窗口 ≤1s 的来源），返回值 = 仅增量，caller 不得回推（历史双提交点 bug：重复的 tool_use 破坏配对折叠 → 模型连环重试，重复还能双双落盘、跨重启存活）
- **引用纪律**：`scheduleSave` 存数组引用——换会话（/resume、/clear）**重绑**新数组，压缩（同会话）**原地 splice**；两种写法各自只对一种场景正确
- 事实与现场分离：盘上永远全量事件，进上下文的只是投影；压缩失败 = 放弃本轮，绝不丢消息
- 权限两条通道都要有：人的通道（审批卡/单读者）+ 模型的通道（文案 + bash 硬闸 + 记忆规则）
- `deny` 记忆不可被任何 bash 形态洗掉（gateTouchedPaths 与 write 共用同一把闸）
- 流式输出暂不做：非流式对 DeepSeek 类网关够用且少一整层复杂度；要做时先设计事件模型再动手
