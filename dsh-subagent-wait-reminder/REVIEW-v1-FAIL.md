# REVIEW：dsh-subagent-wait-reminder（独立静态评审）

- 被审对象（只读，未修改、未安装、未执行）：
  - `lib/index.js` SHA256 前16位 `B20FD8F71CAF706B` ✅ 与冻结版本一致
  - `package.json` `0474E1AD606D6848` ✅
  - `README.md` `CE5B6F73EA7A3EA8` ✅
- 运行时参照：`@deepseek-ai/dsh` **0.2.1-rc.5**（`D:\Program\nvm\v24.18.1\node_modules\@deepseek-ai\dsh\package.json:4`）
- 评审方式：纯静态走读 + 调用链/API 契约核查。未运行被审代码，未运行任何测试，未以运行观测作为结论依据。

---

## verdict

**FAIL**

## violation_suspected

**false** —— 未发现越权行为：不写文件、不注册工具（无 `ctx.tools.register`）、不拦截工具调用（无 `tools/pre-execute`/`guard` 监听）、仅 `node:crypto` 零外部依赖。失败原因是功能性缺陷（提醒永不触发），不是合规/安全问题。

---

## blocking_issues

### B1（CRITICAL）检测数据源选错：`agent/pre-step` 的 `messages` 结构上不可能包含工具调用或工具结果，提醒永不注入

**问题**
插件唯一的触发逻辑 `collectActions(messages)`（`lib/index.js:74-93`）从 `agent/pre-step` 回调收到的 `messages` 里找两类信号：

1. `block.type === 'tool-call'` 且 `name ∈ {subagent, subagent_fork, list_agents}`（`lib/index.js:79-81`）
2. `message.role === 'tool'` 且文本以 `started subagent ` 开头（`lib/index.js:83-90`）

但 `agent/pre-step` 的 `messages` **不是会话历史，而是本步新领用的入站消息批次**，其契约类型是 `UserMessage[]`。因此：

- `tool-call` 块只存在于 `AssistantMessage.content` 中，永不进入 `UserMessage[]` 批次；
- `role: 'tool'` 的消息是 `ToolResultMessage`，也不可能是 `UserMessage`。

**证据链（静态推导，可独立复现）**

1. 事件契约（权威）：`'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>)`
   — `dsh-tool-cordis/lib/types/api-catalog.js:4004-4010`
2. 决策类型：`PreStepDecision = { kind:'reject' } | { kind:'enter'; messages: UserMessage[]; startsRequestSeries?: true }`
   — `api-catalog.js:6423-6424`
3. 唯一调用点：`const claimed = this.inbox.claim(target, position.turn);` → `waterfall("agent/pre-step", { messages: claimed, ...position, signal })`
   — `dsh-agent-loop/lib/index.js:906-912`。`decision.messages` 随后被**作为新的 user 消息写入会话**：`this.session.append("user/message", message, { surfaceOp:'append' })`
   — `dsh-agent-loop/lib/index.js:1067-1073`。这说明该数组只能是"新增消息"，不可能是历史回放（否则会重复落盘）。
4. `inbox.claim` 只从待处理入站队列取消息：`next-step` + 可选 `next-turn`
   — `dsh-agent-loop/lib/index.js:103-111`。写入这两个队列的是入站用户/驱动消息：`dsh-api-session-controller/lib/index.js:1036`、`dsh-agent-instructions/lib/index.js:1362`、`dsh-goal-round-driver/lib/index.js:104`，以及子智能体完成通知 `createSettlementMessage(...)` —— 它本身是 `createUserMessage({ role:'user', source:{kind:'subagent-settled', form:'notice'} })`
   — `dsh-subagent/lib/index.js:508-539`、投递点 `dsh-subagent/lib/index.js:2053`。
5. 类型层面封口：`UserMessage extends MessageBase { readonly role: 'user' }`；`AssistantMessage { role:'assistant' }`；`ToolResultMessage { role:'tool'; toolCallId }`
   — `dsh-llm/lib/types/message.d.ts:124-133,144-146,148-151,153-159`
6. `tool-call` 块的归属：装配器产出 `{type:'tool-call', id, name, arguments}`
   — `dsh-llm/lib/index.js:1031-1036`；它以 `assistant/message` 事件落盘（`dsh-agent-loop/lib/index.js:1156`），工具结果以 `tool/call` + `tool/result` 事件落盘（`dsh-agent-loop/lib/index.js:681-707`，另见 `:984` 的恢复路径）。两条都与 inbox 批次无关。
7. 一等先例反证（同类需求的标准做法）：`dsh-repeat-tool-reminder` 要在"某工具调用之后给模型一条提醒"，它在 **`tools/post-execute`** 检测调用（`dsh-repeat-tool-reminder/lib/index.js:2247-2259`），而把 `agent/pre-step` 的 `messages` 只用来判断 `message.source.kind === "user"`（同文件 `:2261-2264`）。`dsh-tool-skill` 用同一数组做的也是扫 `source.kind === 'user'` 的文本手势（`dsh-tool-skill/lib/index.js:1109-1122`）—— 没有任何一等实现从 `pre-step` 批次里找工具调用。

**影响**
- `collectActions` 恒返回空 Map → `lib/index.js:122-123` 每步都 `return decision`，**两种动作（1a 派发、1b 查询）都不会注入提醒**：需求 1 完全未实现，插件是静默 no-op。
- 需求 3（去重）、`DISPATCH_TOOLS`/`POLL_TOOLS`、以及"改名兜底"（`lib/index.js:38,45-46,83-90`）全部落空 —— 主信号和兜底信号读的是同一份不可能命中的数据。
- 危害等级不高的原因是失败模式为"无操作"而非崩溃：不会破坏会话，但用户会以为插件在工作。

**修复方向（两条都被源码支持，任选其一）**

- 方案 A（一等模式，最小改动）：把检测搬到 `tools/post-execute` 瀑布：签名 `(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next)`（`api-catalog.js:4476-4482`），按 `exec.name` 判定动作、按 `exec.callId` 天然一次（每次执行只回调一次，需求 3 自动满足），返回 `{ ...downstream, additionalContexts: [...] }`；`additionalContexts` 会被合入该工具结果并进入下一次模型请求（`dsh-tools/lib/index.js:3434`、`:3601-3626`；先例 `dsh-repeat-tool-reminder/lib/index.js:2247-2259`）。
- 方案 B（保留现有注入代码）：用只读的 `tools/result` 事件（`api-catalog.js:4500-4506`，`exec` 携带 `name`/`callId`/`agent`）把"待提醒"按 agent 记入 WeakMap，再在 `agent/pre-step` 里排空并追加到 `decision.messages`。注入侧本身是正确的，只有检测侧要换。
- 无论哪种，判定都应使用 `exec.name`/`block.name` 与 `list_agents`（`dsh-tool-subagent-control/lib/types/list-agents.js:45`），不要依赖 render 文本前缀匹配。派发工具名 `subagent` / `subagent_fork` 在当前 profile 由配置给出（`dsh-tool-subagent/lib/index.js:359` `config.toolName ?? "subagent"`；`dsh-base/cordis.patch.yml:384,395`），改名是配置驱动的，render 文本兜底既脆弱又不必要。

---

## non_blocking_suggestions

1. **`source.form: 'reminder'` 不在声明的 form 词汇表内。** `ContextForm` 允许 `instructions|catalog|snapshot|notice|relay|recall`（`dsh-llm/lib/types/message.d.ts:45-58,75-93`），插件用 `'reminder'`（`lib/index.js:101`）。运行时不会因此崩溃：持久日志校验器对未知 `kind` 走 `default` 分支，只要求 `kind` 非空（`dsh-session-format-v0-to-v1/lib/index.js:775-823,914-916`），`form` 白名单只作用于 `kind: 'plugin'`（同文件 `:821-822,919-941`）。但同类一等实现都用 `form:'notice'` + `summary`（`dsh-repeat-tool-reminder/lib/index.js:2240-2244`；`dsh-subagent/lib/index.js:533-538`），surface 依此渲染折叠行。建议改为 `form:'notice'` 并给出 `summary`（用 `boundContextSummary` 的 120 字上限语义）。
2. **消息未深冻结。** 运行时工厂对消息做 `deepFreeze(structuredClone(...))`（`dsh-llm/lib/index.js:37-42`），插件返回可变普通对象（`lib/index.js:96-103`），且会被多个后续监听器与持久层共享。建议递归 `Object.freeze`（仍不需要引入外部包，满足需求 4）。`id: randomUUID()` 本身没问题：`MessageId`/`brandString` 只是编译期 brand，运行时是普通字符串。
3. **POLL 文案含可证伪断言。** "状态查询……也不会带来新信息"（`lib/index.js:59`）与 `list_agents` 的真实返回冲突：它返回每个子 agent 的 `status: running|inactive`、`label`，以及 diagnostic 行（`dsh-tool-subagent-control/lib/types/list-agents.js:18-20,89-107`）——这确实是新信息。建议改成"不会带来关于它何时结束、结果如何的新信息"，否则模型遇到一次"查询返回了新状态"就会整体不信任提醒，反而削弱插件效果。
4. **作用域策略需显式决定。** 插件在根 ctx 注册监听（`lib/index.js:117`），而派发是 agent-scoped 分派（`api-catalog.js:4009` 的 scope-filter 说明），所以子 agent 自己调用 `subagent`/`list_agents` 时也会被注入。需求只说"父 agent"。子 agent 派发时它自己就是父，扩大范围未必错，但应有意识地选择；若要限定，先例是注册到 agent 作用域 ctx（`dsh-subagent/lib/index.js:1861-1863`、`dsh-agent/lib/index.js:193`）。
5. **去重状态是内存态。** WeakMap 按 agent 键（`lib/index.js:115`）与一等实践一致（`dsh-repeat-tool-reminder/lib/index.js:2209`），进程重启/冷恢复后丢失。修好后请保持"事件驱动 + 每次执行一次"，不要改为扫描历史消息，否则历史里的同名调用会反复触发。
6. **README 的备选方案与需求 5 冲突。** `README.md:25` 提出"备选方案是 `tools.guard` 直接拦 `list_agents`"，而需求 5 明确禁止拦截或阻断任何工具调用；`tools/pre-execute` 的 `deny/cancel/ask` 语义确实能拦（`api-catalog.js:4484-4489`）。建议从文档删除，防止后续实现走偏。
7. **安装路线尚未验证（不影响本次结论）。** `README.md:29` 的 `dsh plugin --profile web add file:<dir>` 与 CLI 的 pnpm 转发语义一致（`dsh/lib/bin.js:116-126`），重启宿主也正确（宿主插件在启动时装载），但"本地 `file:` 包 + 在 profile 插件清单登记条目"这条路径我没有实际验证过，未做静态确认的部分应保留为待验证。

---

## not_ready_reasons

（空。本插件不是"材料不足无法判断"，而是静态可证明的功能缺陷：检测数据源在类型与实现两个层面都不可能命中。）

---

## derivation（逐项核对结果）

**维度 1 事件契约 —— 一致（除检测数据源外）**
- 监听签名 `ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => …)`：与调用点载荷 `{ messages, turn, step, signal }` + scope 注入的 `agent` 一致（`dsh-agent-loop/lib/index.js:909-912`、`api-catalog.js:4006`），与一等先例逐字相同（`dsh-tool-skill/lib/index.js:896`）。✅
- 先 `await next()` 再改结果的 post-order 写法：与先例一致（`dsh-tool-skill/lib/index.js:897-930`）。✅
- `decision.kind === 'reject'` 早退：必要且正确 —— reject 分支**没有** `messages` 字段（`api-catalog.js:6424`；实际 reject 产出见 `dsh-api-session-controller/lib/index.js:2516`）。若直接展开会抛 TypeError。✅
- 追加方式 `{ ...decision, messages: [...decision.messages, ...injections] }`：与先例同形（`dsh-tool-skill/lib/index.js:926-929`），且**不原地改动**可能已冻结的数组；spread 保留 `startsRequestSeries`（`api-catalog.js:6424`）。✅

**维度 2 消息形状 —— 运行时可接受（推翻了我最初的怀疑）**
- 待验证风险是"自定义 `source.kind` 是否被拒"。证据结论：`MessageSourceMap` 是 merge-extensible 联合，声明文档写明"user messages carry any producer's kind, and consumers fall through unknown kinds"（`dsh-llm/lib/types/message.d.ts:94-108,121-122`）。一等插件正是这么做的（`dsh-repeat-tool-reminder/lib/index.js:2132` `kind:'repeat-tool-reminder'`）。✅
- 会话日志校验器对未知 kind 只要求非空字符串（`dsh-session-format-v0-to-v1/lib/index.js:775,914-916`）。✅
- 字段齐备：`id`/`role:'user'`/`content:[{type:'text',text}]`/`source` 覆盖 `MessageBase`（`dsh-llm/lib/types/message.d.ts:124-133`），与 `createUserMessage` 产物同形（`dsh-llm/lib/index.js:37-42,59-64`）。✅
- 遗留偏差：`form:'reminder'` 不在 form 词汇表（见 non_blocking 1）；消息未冻结（non_blocking 2）。

**维度 3 检测逻辑 —— 名称/字段假设正确，数据源错误（→ B1）**
- 工具名 `subagent`/`subagent_fork`：与当前 profile 配置逐字一致（`dsh-tool-subagent/lib/index.js:359`；`dsh-base/cordis.patch.yml:384,395`）。`list_agents`：`dsh-tool-subagent-control/lib/types/list-agents.js:45`。✅
- `tool-call` 块字段 `type/name/id`：与 `ToolCallBlock` 一致（`api-catalog.js:8132`、装配器 `dsh-llm/lib/index.js:1031-1036`）。✅
- 工具结果消息字段 `toolCallId` / `source.callId`：与 `createToolResultMessage`（`dsh-llm/lib/index.js:101-112`）与 `ToolResultMessage`（`dsh-llm/lib/types/message.d.ts:153-159`）一致 —— 字段名对，但这类消息不会出现在被扫描的数组里。❌
- 派发返回文本 `started subagent `：与 render 模板逐字一致（`dsh-tool-subagent/lib/index.js:436-439`）。✅（同样无机会命中）
- 两种动作覆盖：意图上 a、b 都覆盖，实际两者都不可达。❌ → B1

**维度 4 去重与状态 —— 设计正确（当前不可达）**
- 按 callId 去重、Set 累积、`seen.add` 在注入前：逻辑无误（`lib/index.js:125-136`）。✅
- WeakMap 以 agent 对象为键：与一等实现同构（`dsh-repeat-tool-reminder/lib/index.js:2209`、`dsh-tool-skill` 的 `catalogHistory(agent)`），agent 实例在多步之间稳定（同一 `ReactLoopAgent` 持有 inbox，`dsh-agent-loop/lib/index.js:906`），可被回收。✅
- 状态在 `apply(ctx)` 闭包内，按 ctx 隔离，无跨会话串扰。✅

**维度 5 误触发/漏触发 —— 漏触发是致命的**
- 漏触发：两种动作都测不到（B1）。❌
- 同一步多调用：若可达，会一次注入多条提醒（每 callId 一条）。可接受，但与需求"注入一条提醒"的单数表述有偏差，建议聚合成一条。⚠️（不可达，故不阻塞）
- 历史消息重复出现：dedupe 已按 callId 挡住 —— 前提是修好后仍采用事件驱动检测；若改成扫历史则有重启后重触发风险（non_blocking 5）。
- 工具改名：`DISPATCH_TOOLS` 集合按当前 profile 正确；render 文本兜底对 `list_agents` 无对应物，属半覆盖设计。改名场景下真正需要的仍是 `exec.name`。⚠️
- 子 agent 场景：会被注入（non_blocking 4）。
- 反例核查：入站批次里唯一可能带 `tool-call` 块的路径我没有找到任何写入者（inbox 写入者清单见 B1 证据 4）；"完成通知"本身是 `role:'user'` 文本消息，不触发插件。

**维度 6 崩溃风险 —— 未发现**
- `decision.kind === 'reject'`（无 `messages`）已早退。✅
- `signal?.aborted === true` 时直接返回 decision（`lib/index.js:120`），既不注入也不抛错；调用点随后自行 `signal.throwIfAborted()`（`dsh-agent-loop/lib/index.js:921`），语义安全。比先例的 `signal.throwIfAborted()`（`dsh-tool-skill/lib/index.js:901`）更保守，不算问题。✅
- 字段缺失防御：`block?.type`、`Array.isArray(message.content)`、`message.source?.callId` 均有保护（`lib/index.js:77-89`）。✅
- 唯一未覆盖：监听器无 try/catch，抛出会经 waterfall 传播成 `agent/error`；但按契约 `messages` 恒为数组，风险低。⚠️（不阻塞）

**维度 7 装载约定 —— 可装载**
- `export const name` + `export function apply(ctx)`：ESM 命名导出，符合 cordis 插件形态；loader 会 `exports.default ?? exports` 归一（`cordis-plugin-loader/lib/index.js:667-672`）。✅
- `package.json`：`"type":"module"` + `main` + `exports["."]` 指向 `lib/index.js`，与一等宿主插件同构（对照 `dsh-experimental-session-search/package.json:14-26`；缺 `types`/`files`/`icon` 属可选）。✅
- `engines.dsh: ">=0.2.0-rc.2"` vs 运行版本 `0.2.1-rc.5`：**我原本怀疑 node-semver 的预发布规则会让 0.2.1-rc.5 不满足 `>=0.2.0-rc.2`，被证据推翻** —— DSH 的兼容性判定显式使用 `{ includePrerelease: true }`，且文档说明"Prereleases participate in ranges"（`dsh-app-boot/lib/index.js:276-284,300-304`）。`engines.dsh` 存在时单独决定，peer 不参与（同文件 `:281-285`）。✅ 无 `inject` 导出：插件只用 `ctx.on`，不需要服务解析。✅
- 需求 5 合规：无 `ctx.tools.register`、无 `tools/pre-execute`/`guard` 监听、无文件写入、仅 `node:crypto`（`lib/index.js:30`）。✅

**维度 8 文案合规 —— 符合需求 2**
- "通知由系统主动送达、与是否查询无关"表述：DISPATCH "系统会主动把完成通知送进本会话——通知与是否查询无关，不需要任何查询来触发"（`lib/index.js:50`）；POLL "完成通知由系统在子智能体结束时主动送达，与是否查询无关"（`lib/index.js:60`）。均不会被读成"查询触发通知"。✅
- `list_agents` 用"避免"（`lib/index.js:51,61`），全文无"禁止"。✅
- 事实核对：完成通知确实由运行时主动投递给父 agent（`dsh-subagent/lib/index.js:508-539` 构造 `subagent-settled` 用户消息，`:2053` 投递），措辞站得住。⚠️ 极端情况下投递会失败并只记 warn（`dsh-subagent/lib/index.js:2060`），文案的绝对承诺在该场景不成立 —— 影响可忽略，不改判。
- POLL 第二句"也不会带来新信息"不准确（non_blocking 3）。

**评审自检**：未运行被审代码；未运行测试；未以运行观测作结论；所有断言附文件+行号；对 `engines.dsh` 与自定义 `source.kind` 两个先验怀疑均已用源码推翻并记录。

---

## 结论给 parent

插件的注入侧（消息形状、waterfall 用法、reject/signal 处理、去重设计、装载约定、文案措辞）经静态核对是**可用且符合契约**的；失败点单一且致命：**它从 `agent/pre-step` 的 `messages`（契约类型 `UserMessage[]`）里找工具调用与工具结果，这在类型和实现两个层面都不可能发生**，因此需求 1 的两个触发点都是 no-op。按 B1 的方案 A（`tools/post-execute` + `additionalContexts`）或方案 B（`tools/result` 记录 + pre-step 排空）替换检测侧后即可成立；改动面很小，不需要重写注入逻辑。
