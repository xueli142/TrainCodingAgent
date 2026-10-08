# icefox-agent TODO

> 每次大改动后同步本文件。原则：**先还债 → 再补体验 → MCP → TUI 表皮 → 运行时新状态**。
> 验证基线：`pnpm check` + `pnpm test`（29 用例）+ 真机启动冒烟。

## 🗺️ Plan · 路线规划（当前 → 远期）

| 阶段 | 内容 | 状态 | 排序理由 |
|---|---|---|---|
| **P0 还债** | 收据合约 / 批内去重 / 防抢答 / trust 摘除 / 工程卫生 / 测试起步 | ✅ 完成（B0） | 不修的地基会毒化后面所有功能 |
| **P1 体验** | abort / 统一截断层 / 后台任务 / 历史 / 重试 / compact 双层 / token 真感知 / skills 拓宽 / 真窗口 | ✅ 完成（B1） | 日常使用顺滑度 |
| **P2 MCP** | v2 官方 SDK 全链路 + 配置外置 + /mcp 运行时开关 | ✅ 主体完成（B2，余债见下） | 生态接入 |
| **P3 TUI 表皮** | 模态栈 / picker / 快捷键 / 状态行 | ✅ L1 完成（B3，余留见下） | 不做大屏、只补操作效率 |
| **P4 运行时状态** | plan mode → plan_exit 确认闸 → goal 状态机 | ⏳ 下一个动工 | 有 B3 的 picker 做 UI 承载，有权限层做 enforcement |
| **P5 占位转正** | `/model` `/delete` `/init` 实装、`task` 接线 | 📋 排队 | 独立小件，随需插队 |
| 远期评估 | 流式输出（先设计事件模型）、MCP resources/prompts/OAuth、全屏 L2 | ❄️ 冻结 | 出现真实痛点再解冻 |

**P4 是下一铲**：三件套（mode 规则集 / plan_exit 确认闸 / todowrite 衔接）设计已定稿，见 B4。

## 待办清单

### B2 · MCP 余债

- [ ] 可选（遇到再说）：resources / prompts 元工具、OAuth（远程私有 server 鉴权）、progress 透传

### B3 · TUI 余留

- [ ] 多行 prompt（状态行+`> `）依赖 readline 兼容性，异常终端错位再评估自绘输入行
- [ ] 心跳刷新等真上流式输出时一并设计
- [X] **L1.5 活区重绘（2026-10-08）**：回合内底部活区 = 工具卡片行（▸→✔/✖ 计时，行级差分只重写变化行，教材 MiniCode `screen.ts:53-85`）+ Thinking spinner + statusLine 常驻尾条；不进 alt-screen、不接管输入，readline/picker/question 照常。`--inline`/`ICEFOX_TUI=inline` 退化追加式；非 TTY 一律 inline（零 ANSI 零卡片）。接线：agentloop 新增 `onModelStart/onToolStart/onToolResult`；tty-prompt 新增 `onModalChange/onExternalWrite` 广播（弹卡前渲染器先落历史，杜绝错位回写）；实现见 `src/repl/ui-kit.ts`/`renderer.ts`/`live.ts`
- [X] **Markdown 终端渲染（2026-10-08）**：assistant/progress/thinking 预览经 `renderTerminalMarkdown`——粗体/斜体/删除线/行内代码/标题/引用/分隔线/链接转 ANSI 或剥标记；围栏代码块内原样保护；只动显示，session/trace 存原文（`src/repl/md.ts`）
- [ ] L3（仍冻结）：自绘全屏 raw mode + 自绘输入行 + 鼠标，教材 MiniCode `tty-app.ts`；`TurnRenderer` 接口即插座，升级只加实现不动内核——先守"键击只写 input 缓冲、回调只写 transcript"的无锁纪律
- [ ] ❌ 永不做：Ink/OpenTUI（React 依赖与"极简可通读"冲突）
- [ ] 纪律：**UI 只订阅 `onModelStart`/`onAssistantMessage`/`onProgressMessage`/`onThinking`/`onToolStart`/`onToolResult`/`onTurnDiags` 事件流**，不读 agentloop 内部状态——事件流即投影源，升级渲染只换 renderer 不动主循环

### B4 · plan 与 goal（下一个动工）

设计立场：**人工关口分两种**——否决闸（veto：默认放行、行为可疑才拦、可积累记忆，现有三把闸）与确认闸（consent：默认什么都不发生、人点头才推进、每次新决策不可积累）。plan 属于后者，不塞进 ensureXxx。

- [ ] **① plan mode = PermissionManager 换规则集**（~30 行，先做，让 plan 有牙齿）：
  - `mode: 'build' | 'plan'`；三把闸顶部加判定：plan 模式下变更类动作 → throw "plan 模式禁止变更，继续以文字规划"
  - enforcement 复用审批通道（permissionUi/模态栈/interruptWaiters 零新增弹卡原语；opencode 同构）
  - mode 切换落 session 事件，`/resume` 恢复带回
- [ ] **② `plan_exit` 工具 = 确认闸**：弹特殊审批卡（完整 plan 文本 + 步骤清单），选项 `[a]批准并切 build / [e]给修改意见 / [r]否决`；**fail-closed**：取消/EOF→未批准；不进持久 allow（每次必弹）
- [ ] **③ plan 批准后接 todowrite**：人点头的对象是可勾选清单；执行逐步勾销；goal 状态机（planning→executing→reviewing）长在这条链上
- [ ] 坑位：**确认闸每步一弹=审批疲劳**（批一次，执行期拦截归三把闸）；plan→build 必过闸，build→plan 随意
- [ ] `/plan` `/build` slash 命令作人工兜底（模型自评转换是主路径）
- [ ] goal 控制器：plan 三件套落地后再设计，避免一次引入两层新状态

### B5 · 占位转正与小件

- [ ] `/model <id>`：切模型 + 重建 system + **重新 hydrate 窗口**（现在窗口只在启动时拉一次）
- [ ] `/delete <id>`：接现成 `clearSession` + 二次确认（确认对象非当前会话，或提示先 `/clear`）
- [ ] `/init`：扫描项目生成 AGENTS.md 风格指令文件
- [ ] `task` 子代理接线：嵌套 agentloop + 受限工具集（task.ts 注释里留有设计）
- [ ] skills 列表字段/嵌套 YAML（需要时上真解析器）
- [ ] `config.ts` 删无人使用的 `RuntimeConfig` 类型

### 已知坑（别被源码骗到，详见 AGENTS.md 第 5 节）

- [ ] resume 后 tool_result 阈值/形态与实时不一致（25k 文本 vs 50k/200k 块）——字节级复现在 resume 边界断裂，需要时统一
- [ ] tool-results 子目录是随机 uuid，无法反查会话归属
- [ ] `getStandardToolSchemas` 与 `getToolSchemas` 重复、`ToolRegistry` 类与 Map registry 并存——双轨待合流

## 归档 · 已完成（时间倒序，只留一句话）

### 2026-09-29（index 拆分 · TUI Phase 0 地基）
- [X] `src/index.ts` 610 行 → ~230 行薄装配根：拆出 `repl/{context,turn,slash,status,hotkeys}.ts` + `question-ui.ts`，`resolveSessionId`/`previewMessages` 收编进 `session.ts`；`ReplContext` 统一 sessionId/messages/activeTurn；纯搬迁无行为变化（check + 29 用例 + `--sessions` 冒烟过），TUI 升级时只换外壳、`runTurn`/`handleSlash` 直接复用

### 2026-09-28（窗口真值化收尾）
- [X] 模型窗口强制查 `/models`（候选链 MODELS_URL→base/models→去后缀→origin），**删内置猜测表**，失败统一 1M 兜底并明说；`formatTokens`（/1000 四舍五入，<1M 用 K、≥1M 用 M）统一状态行与 /status
- [X] keypress 监听对象修正（rl 不转发 keypress，须听 stdin 流本身）+ 真 readline 回归测试；`flushTypedInput` 单 key 对象修正；picker Enter 微任务拆栈防抢答

### 2026-09-26（B3 L1 表皮 + B1/B2 清偿）
- [X] 模态栈键路由（pushModal/onKey/onLine/onClose + interruptWaiters/EOF 关模态 + deliverLine/onGlobalKey）；picker 组件（方向键/单键直达/Esc=fail-closed deny/Ctrl+O 展开 diff）；Tab slash 补全；Ctrl+G/L；状态行（session·model·ctx 真感知·mcp）+ 每 step 重打；`/status`
- [X] abort（Ctrl+C 回合中取消：AbortController 贯穿 + 批内配对 cancelled + interruptWaiters 唤醒待答卡）；统一截断层（bash/webfetch 删内部截断、skill/edit 豁免、TTL 7 天）；后台任务（background/`&` + jobs 日志 + sentinel）；输入历史；模型重试（429/5xx 退避 + 空响应补枪）；`/compact`+microcompact；token 锚点+增量计数 + providerUsage 上消息；skills 拓宽（.claude + 向上查找 + 块标量 + 重名警告）
- [X] MCP：配置外置双级合并（兼容 Cursor `mcpServers`）+ enabled + `/mcp` 状态表与运行时 connect/disconnect + SIGTERM/main().catch 退出路径
- [X] B0：TurnReceipt 收据合约 / 批内去重 / 弹卡防抢答 / trust 摘装饰 / getPermissionsPath 接 /sessions / chunkId 实现 / 工程卫生（更名 icefox-agent、typescript+check、node:test 起步）/ 遗留文件清理
- [X] loop-guard 阈值 3→10（与文档同步）

### 更早（详见 git log）
- [X] skills 注入 / question 接线 / 批量预算 / tty-prompt 单读者重写 / `/rename` `/clear` `/sessions` / `/resume` 引用共享 bug 修复 / extended thinking（THINKING_BUDGET 可关）/ MCP v2（官方 SDK、sanitize 命名、MCP tool 隐式标注、断线摘僵尸、热更新）

## 架构备忘（别回退）

- **一条消息只能有一个提交点**：agentloop 就地 push 共享数组，返回 `TurnReceipt`（崩溃窗口 ≤1s 的来源）——caller 回推在类型层已不可能（历史双提交点 bug：重复 tool_use 破坏配对 → 连环重试、双双落盘、跨重启存活）
- **引用纪律**：`scheduleSave` 存数组引用——换会话**重绑**新数组，压缩**原地 splice**；两种写法各自只对一种场景正确
- 事实与现场分离：盘上永远全量事件，进上下文的只是投影；压缩失败 = 放弃本轮，绝不丢消息
- 权限两条通道都要有：人的通道（审批卡/picker/单读者）+ 模型的通道（文案 + bash 硬闸 + 记忆规则）
- `deny` 记忆不可被任何 bash 形态洗掉（gateTouchedPaths 与 write 共用同一把闸）
- 人工关口分两种：veto（三闸，可积累记忆）与 consent（plan/plan_exit，每次必弹、fail-closed）——不要互相塞
- 模态栈铁律：keypress 听 stdin 流本身（rl 不转发）；Enter 伴生 line 靠"栈顶不接线即丢弃"+微任务拆栈消化
- 流式输出暂不做：非流式对 DeepSeek 类网关够用且少一整层复杂度；要做时先设计事件模型再动手
