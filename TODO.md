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
- [ ] ⭐ **token 计数校准 + 窗口感知**（现在只有 chars/3.5 假估算 + 256K 硬编码，真实 usage 只进诊断不进决策）：
  - usage 挂到消息上：`agentloop` push assistant 消息时写入 `providerUsage`（type.ts 字段已留）
  - **锚点+增量计数**：从后往前找最近一条新鲜 usage 作精确锚点，之后增量才用字符估；压缩/重排后把旧 usage 标脏（stale）不许再锚
  - model→`{contextWindow, outputReserve}` 小表（留实际用的 3-5 个模型 + 未知兜底），`effectiveInput` 全局唯一定义，compact 触发、状态行、tool-result 预算共用
  - 参考：MiniCode `utils/token-estimator.ts`（分角色字符率 2.0~3.5 + 三态 source 标记）与 `utils/model-context.ts`（映射表 + normal/warning/critical/blocked 四档）——**方案仅供参考，按 icefox 的极简风格裁剪实现，不照搬**
- [ ] **skills 发现面拓宽**（对齐 Anthropic 规范 / opencode）：
  - `skillRoots` 增加 `~/.claude/skills`（零迁移复用现成几百个技能）+ 项目级向上查找到 worktree 根
  - frontmatter 解析升级：单行正则 → 完整 YAML（支持折行 description、列表字段）
  - 校验 name 与目录名一致（规范要求）；重名策略从"首见即赢"改为显式警告

## B2 · MCP（v2 官方 SDK 版已落地，余债如下）

已完成：`@modelcontextprotocol/sdk` 接入（stdio + StreamableHTTP）、分页 list、`mcp__server__tool` 命名 sanitize、description 头部 "MCP tool from server" 隐式标注、结果归一化（content+structuredContent+isError）、断线 onclose 摘僵尸、ToolListChanged 热更新、`server-everything`/`filesystem` 冒烟通过（含 -32602 错误通路）。

- [ ] 配置外置：`~/.ICEFOX-code/mcp.json` + 项目 `.icefox/mcp.json` 合并读取（现为 `config.ts` 硬编码）；`enabled:false` 支持
- [ ] `/mcp` 命令：展示 `getMcpStatus()`（连接态/工具数/错误），运行时 connect/disconnect
- [ ] `disposeMcp` 挂更多退出路径（SIGTERM、异常退出目前只覆盖 SIGINT 与正常收尾）
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

## 架构备忘（别回退）

- **一条消息只能有一个提交点**：agentloop 就地 push 共享数组（崩溃窗口 ≤1s 的来源），返回值 = 仅增量，caller 不得回推（历史双提交点 bug：重复的 tool_use 破坏配对折叠 → 模型连环重试，重复还能双双落盘、跨重启存活）
- **引用纪律**：`scheduleSave` 存数组引用——换会话（/resume、/clear）**重绑**新数组，压缩（同会话）**原地 splice**；两种写法各自只对一种场景正确
- 事实与现场分离：盘上永远全量事件，进上下文的只是投影；压缩失败 = 放弃本轮，绝不丢消息
- 权限两条通道都要有：人的通道（审批卡/单读者）+ 模型的通道（文案 + bash 硬闸 + 记忆规则）
- `deny` 记忆不可被任何 bash 形态洗掉（gateTouchedPaths 与 write 共用同一把闸）
- 流式输出暂不做：非流式对 DeepSeek 类网关够用且少一整层复杂度；要做时先设计事件模型再动手
