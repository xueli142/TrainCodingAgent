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
- [X] extended thinking：请求带 `budget_tokens`（`THINKING_BUDGET=0` 关闭）+ 灰色 `[thinking]` 预览打印

## B0 · 还债（已完成 2026-09-26，`pnpm check` + `pnpm test` 全绿）

- [X] ⭐ `agentloop` 返回值改**收据**：`Promise<TurnReceipt>`（`addedCount / kind / stopReason? / usage?`），消息只就地 push，caller 回推在类型层已不可能；新增 `test/agent-loop.test.ts` 锁合约
- [X] `saveMessagesLocked` 批内去重：过滤循环同步回填 `batchSeen`，同数组重复 id 不再双双落盘
- [X] 弹卡抢答：`tty-prompt.discardQueuedInput()`，审批卡与 question 弹前洗掉排队行并提示丢弃数
- [X] trust 闭环 → 选**摘装饰**：删 `trustProject`/`readTrustList`/`ProjectEnvironment.trusted`/环境块 trusted 行/`context_snapshot.trusted` 字段，启动日志改显 `(git)`。若将来做真 trust，需要连 PermissionManager 的持久化策略一起设计
- [X] `getPermissionsPath`：接进 `/sessions` 尾行展示
- [X] `resumeMessages` 的 `chunkId`：选**实现**——投影改用 `sliced`（chunk 首事件之前的段），回滚/中间点重放从此可用（无调用方，纯补能力）
- [X] 工程卫生：`.gitattributes`（`* text=auto eol=lf`）；package.json 更名 `icefox-agent`、删坏的 `check-deps`、新增 `check`（devDep typescript 5.9，**首次全项目类型检查通过**）与 `test` 脚本；清理 5 个未注册遗留工具文件 + `test-tool.ts` + 空文件 `register.ts`/`checkroute.ts`/`search_file.ts`
- [X] **冒烟测试起步**（node:test + tsx loader，ICEFOX_CODE_HOME 隔离到临时目录）：agentloop 增量合约 / loop-guard 只注入一次 / 双层预算字节级复放，3 用例全过

## B1 · 体验补齐（已完成 2026-09-26，check + 5 测试全绿 + 启动冒烟正常）

- [X] ⭐ **回合截断（abort）**：回合中 **Ctrl+C 取消当前回合**而非退出程序——`AbortController` 贯穿 `agentloop`（step 前检查 / model.next catch AbortError / 批内剩余调用补配对 cancelled 结果，绝不留孤儿 tool_use）；审批卡与 question 被 `interruptWaiters()` 以 null 唤醒按拒绝处理；bash 接 signal 杀进程树、webfetch 用 `AbortSignal.any` 合并；空闲时 Ctrl+C 仍是退出。ESC 需 raw mode，留给 TUI L2
- [X] ⭐ **统一截断层**：bash 删 tailLimit（2000 行/50KB 内部截断）、webfetch 删 100k 截断——工具回原文，全走 `replaceLargeToolResult`（50k）+ `applyToolResultBudget`（200k）落盘替换；`EXEMPT_RESULT_TOOLS={skill,edit}` 豁免；`pruneToolResults()` 7 天 TTL 启动清理。偏差：`ToolResult.metadata.outputPath` 未加——路径已内嵌替换文本（`read(path,offset)` 可用），双层表达反而要维护一致性
- [X] ⭐ **后台任务**：`bash` 加 `background?:boolean` + 尾随 `&` 自动识别；detached spawn、日志流 `~/.ICEFOX-code/jobs/<id>.log`、shell 尾追 `[icefox-job exited code N]` sentinel；模型 `read` 看进展、bash kill 进程，零新工具
- [X] `--resume`/`/resume` 可交互：裸 `--resume` 启动列编号供选择；`resolveSessionId` 统一支持 序号|完整id|唯一前缀
- [X] 输入历史：`~/.ICEFOX-code/history.jsonl` 持久化（启动载入 200 条，提交即追加），readline `history` 选项给 ↑↓
- [X] 模型请求重试：429/408/5xx/网络抛错 → `Retry-After` 优先否则 1/2/4s 指数退避（至多 4 次）；空响应补枪 2 次；abort 不参与重试
- [X] 手动 `/compact`（`maybeCompactContext` 加 `force`）+ **microcompact**：利用率过半先把旧的、超出保留窗的大 `tool_result` 就地清成 `[cleared]`（盘上事实不动），不够再走 summary
- [X] ⭐ **token 计数校准 + 窗口感知**（新建 `utils/token-estimator.ts`，按 icefox 风格裁剪 MiniCode 方案）：`agentloop` 把 usage 挂上 assistant 系消息（`providerUsage`，顺手修正了原来挂错到 `usage` 字段的类型谎言）；**锚点+增量**计数；compact 后 `markUsagesStale` 整批标脏；`model→{contextWindow,outputReserve}` 表（claude/deepseek/gpt/gemini/qwen + 128K 兜底），compact 触发从"256K 硬编码 chars/3.5"换成 `utilization ≥ 85%×effectiveInput`
- [X] **skills 发现面拓宽**：`skillRoots` = 项目起向上至 git 根的 `.icefox/skills`+`.claude/skills` + `~/.ICEFOX-code/skills` + `~/.claude/skills`（零迁移复用 Claude 系技能）；frontmatter 支持块标量 `|`/`>`（折行 description 可解析）；name≠目录名、重名均显式 warn。**仍欠**：列表字段/嵌套 YAML（需要时再上真解析器）

## B2 · MCP（余债清偿 2026-09-26）

已完成：`@modelcontextprotocol/sdk` 接入（stdio + StreamableHTTP）、分页 list、`mcp__server__tool` 命名 sanitize、description 头部 "MCP tool from server" 隐式标注、结果归一化（content+structuredContent+isError）、断线 onclose 摘僵尸、ToolListChanged 热更新、`server-everything`/`filesystem` 冒烟通过（含 -32602 错误通路）。

- [X] 配置外置：`loadMcpConfig` 合并 `~/.ICEFOX-code/mcp.json` + 项目 `.icefox/mcp.json`（支持 `mcpServers` 包裹层，与 Cursor 格式互通）；`enabled:false` 静默跳过；`config.ts` 内置项降为兜底默认
- [X] `/mcp` 命令：彩色状态表（●/○/✗ + 工具数 + 错误）；**运行时开关** `reconnectMcpServer`/`disconnectMcpServer`（`/mcp connect|disconnect <name>`，断开即摘工具）
- [X] 退出路径补全：SIGTERM → flushOnExit(含 disposeMcp)；`main().catch` 启动段抛错也 allSettled flush
- [ ] 可选（遇到再说）：resources / prompts 元工具、OAuth（远程私有 server 鉴权）、progress 透传

## B3 · TUI（定位先行，效果型 UI 一律缓做）

**设计立场**（2026-09-24 定，参考 MiniCode 自研行 diff / opencode 事件投影两条路线的调研结论）：

- **TUI = 落盘事件的投影，不是独立状态系统**。icefox 已有全量事件日志（`appendSessionEvent`/`readEvents`/`projectMessages`），所有展示内容应可从这个事件流推导——opencode 证明了这条路的终态是"TUI 无状态、server 是唯一事实源，重启即恢复视图"；我们同进程，等价做法是渲染层只读事件+派生状态
- **TUI 的另一半价值是便捷命令系统**：slash 快捷命令体系（补全、`/status`、`/mcp`、会话操作），相比裸 CLI 提升操作效率——这是 L1 的主线
- **效果型 UI 先缓**：备用屏全屏重绘、鼠标选区复制、ctx 十格条动画、diff viewer、sidebar、leader-key 键位系统——两个前辈都有，但对 2k 行工具是负债，出现真实痛点再说

待办：

- [ ] **L1 事件投影 + 命令系统（主线，~1-2 天）**：
  - 状态行（session / model / ctx 利用率——数据源等 B1 token 校准落地，两任务串成链）
  - slash 补全 + `/status`；审批卡配色（保持 readline，opencode 的"内联非模态"优于 MiniCode 的全屏替换）
  - 渲染侧合帧：借鉴 opencode 的 16ms 事件队列 + 单次 batch 应用（约 10 行，防流式刷屏卡顿）
- [ ] L2（暂缓，另立项再评估）：自绘全屏 raw mode + 行级 diff 重绘，教材 MiniCode `tty-app.ts`/`screen.ts:53-85`；真要做先守输入事件 promise 链串行化（键击只写 input 缓冲、agent 回调只写 transcript，天然无锁）
- [ ] ❌ 不上 Ink/OpenTUI：React 依赖与"极简可通读"冲突
- [ ] 纪律（现在就守）：**UI 只订阅 `onAssistantMessage`/`onProgressMessage`/`onTurnDiags` 事件流，不读 agentloop 内部状态**——事件流即投影源，L2 时只搬 REPL，主循环不动

## B4 · runtime状态追加，goal和plan






## 架构备忘（别回退）

- **一条消息只能有一个提交点**：agentloop 就地 push 共享数组（崩溃窗口 ≤1s 的来源），返回值 = 仅增量，caller 不得回推（历史双提交点 bug：重复的 tool_use 破坏配对折叠 → 模型连环重试，重复还能双双落盘、跨重启存活）
- **引用纪律**：`scheduleSave` 存数组引用——换会话（/resume、/clear）**重绑**新数组，压缩（同会话）**原地 splice**；两种写法各自只对一种场景正确
- 事实与现场分离：盘上永远全量事件，进上下文的只是投影；压缩失败 = 放弃本轮，绝不丢消息
- 权限两条通道都要有：人的通道（审批卡/单读者）+ 模型的通道（文案 + bash 硬闸 + 记忆规则）
- `deny` 记忆不可被任何 bash 形态洗掉（gateTouchedPaths 与 write 共用同一把闸）
- 流式输出暂不做：非流式对 DeepSeek 类网关够用且少一整层复杂度；要做时先设计事件模型再动手
