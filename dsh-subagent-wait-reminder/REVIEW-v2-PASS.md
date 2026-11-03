# dsh-subagent-wait-reminder 独立静态评审（v2 冻结版）

- 评审对象（只读，SHA256 前 16 位已在评审前复核一致）：
  - `lib/index.js` = `080F9515880BA478…`（140 行）
  - `package.json` = `0474E1AD606D6848…`（16 行）
  - `README.md` = `F292DE8EC906F7AE…`（54 行）
- 运行时参照：`D:\Program\nvm\v24.18.1\node_modules\@deepseek-ai\dsh\`，实测 `@deepseek-ai/dsh/package.json` → `"version": "0.2.1-rc.5"`。
- 评审方式：纯静态源码走读 + 调用链推导。**未安装、未加载、未执行被审插件代码**（含 `node --check`）。所有行号均为本次评审中实际打开读取的位置，不引用被审 README 的行号作为证据。

---

## verdict

**PASS**（可安全加载；需求 1–6 均达成；未发现具有充分证据的正确性缺陷）

## violation_suspected

**false**

## blocking_issues

无。

## not_ready_reasons

无。（唯一未闭合项是“真实会话内的端到端观察”，属被审对象自己声明的剩余风险，且不属于静态评审可覆盖范围；不构成 NOT_READY：注入链路每一环都有源码证据。）

## non_blocking_suggestions

| # | 建议 | 证据 | 说明 |
|---|---|---|---|
| NB-1 | 若要“每个 step 最多一条”，需按 `(agent, action)` 做 step 内去重 | `dsh-tools/lib/index.js:3455-3469`（每次执行各调一次 post-execute）；`dsh-agent-loop/lib/index.js:565-576`（`commitReady` 按 model 顺序逐个 `acceptContext`）；`inbox` 去重只按 `message.id`（`dsh-agent-loop/lib/index.js:42-45`），每次 `reminderMessage` 都新铸 UUID（`lib/index.js:91`） | 一步内派发 N 个子 agent → 注入 N 条**内容完全相同**的提醒（约 N×4 行中文）。需求 3 的字面读法“每次动作只提醒一次”成立，但“不重复堆积”若按 step 维度理解则未满足。扇出是本插件的主用法，建议产出方与需求方确认口径。当前实现不构成需求违背，故列 non_blocking。 |
| NB-2 | 装载文档应写清“`dsh plugin add` 之后还必须在 profile 的 `cordis.patch.yml` 增加条目” | `dsh-app-boot/lib/index.js:1175`（`bundle` 判定＝manifest 声明 `dsh.bundle.patch`）、`:1217`（仅 bundle 依赖自动进 `dsh.profile.bundles`）、`:1226`（非 bundle 归为 `addedPlainDependencies`，仅告警）；`:490-497`（运行时条目列表＝bundle patches + profile 自身 `cordis.patch.yml` + launcher 层） | 被审 `package.json` 无 `dsh` 字段 → 属“普通依赖”，**装完不等于装载**，必须手工插条目。README 第 2 步方向正确，但把它写成“按 patch 规矩”而非“必需步骤”，易被读成可选。 |
| NB-3 | 可选：改为自带 patch 的 bundle，使安装一步生效 | 同上 `dsh-app-boot/lib/index.js:1175,1217` | 与 NB-2 二选一，属交付体验优化。 |
| NB-4 | 明确“本插件只走静态 profile 插件路径，不能作 cordis 动态包运行” | `dsh-cordis-host-runner/lib/index.js:1183`（动态包 `require: "Node modules are unavailable…"`）、`:633-634`（沙箱 ctx 只暴露有限动词） | 文件头自称 “Host half”，该词在 DSH 里也用于动态包的 host 半（`hasHostHalf`，`dsh-cordis-host-runner/lib/typert.host.js:445`）。`import { randomUUID } from 'node:crypto'` 在动态包路径下不可用；README 的安装步骤走的是静态路径，二者需在文档里对齐，防止后来者误按动态包安装。 |
| NB-5 | 文本兜底可考虑收紧为“首块即等于前缀”或加 `exec.name` 非派发工具的排除，并在注释里点明 join 语义 | `lib/index.js:121-122`（`content` 全部 text 块 `join('\n')` 后 `startsWith`）；渲染源 `dsh-tool-subagent/lib/index.js:436-439` | 实测该前缀在整个已安装运行时中只出现一处（`rg "started subagent"` → 唯一命中 `dsh-tool-subagent/lib/index.js:438`），当前无误命中；但首块为 image、或首块为空文本时，改名后的派发工具会静默漏检（降级方向安全，可接受）。 |
| NB-6 | 可把 `classify` 移到 `await next()` 之后（或包 try/catch） | `cordis/lib/index.js:317-325`（不调 `next()` 即否决整条链，含内置默认值）、`dsh-tools/lib/index.js:3466-3468`（post-execute 抛错 → `toolErrorResult`，成功派发被改写成 isError） | 官方 `dsh-repeat-tool-reminder/lib/index.js:2248-2249` 与本插件同序（先判定后 `next()`），故属风格性加固而非缺陷。我逐条核过 `content` 在所有进入 post-execute 的结果形态里都是数组（见维度 8），所以现实可达性极低。 |
| NB-7 | 建议对 summary 自行施加 120 字符上界（等价于 `boundContextSummary` 的语义） | `dsh-llm/lib/types/message.js:10,16-20`（`CONTEXT_SUMMARY_MAX_CHARS = 120`） | 现算得两条 summary 为 49 / 40 字符（`lib/index.js:99-101`），未越界；属对未来改文案的保护。 |

---

## derivation（逐维度证据链）

### 维度 1 端到端可达性 — 成立

注入 → 下一次模型请求的完整链条，逐环实测源码：

1. 事件契约：`tools/post-execute` 是 waterfall，签名 `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>)`（`dsh-tool-cordis/lib/types/api-catalog.js:4476-4482`）。本插件监听器形参顺序与之一致（`lib/index.js:131`）。
2. 决策携带 context：`PostToolDecision` 三个变体都声明 `additionalContexts?: UserMessage[]`（api-catalog:6384）。
3. 注册表合入：`dsh-tools/lib/index.js:3600` 以 `scopeTarget(this, exec.agent)` 派发该瀑布，`:3601` 取 `decision.additionalContexts`，`:3612` 与结果自带 context 合并（result 自带在前、decision 在后），`:3623-3627` 写回最终结果；`:3687-3706` 的 `materializeFinalResult` 把 `additionalContexts` 纳入 presentation（`:3691`），所以它会留在返回给循环的内存结果里。
4. 循环接收：`dsh-agent-loop/lib/index.js:570-572` 每个已提交 slot 逐条 `acceptContext(context)`；`:1166` 的实参是 `(context) => this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [context])` — 写入 next-step 收件箱（同文件 `:490-504` 的文档亦写明 “for the next step boundary”）。
5. step 边界消费：`:902-920` `preStep` 先 `this.inbox.claim(target, …)`（`:906`），把批次作为 `agent/pre-step` 的 `messages`，默认决策 `:916-919` 返回 `{kind:'enter', messages:[...claimed, context]}`。
6. 落盘成模型可见消息：`:1066-1072` `if (firstAttempt) for (const message of decision.messages) … else this.session.append("user/message", message, { surfaceOp: "append" })`；`user/message` 的 `source.kind` 不是 `runtime-context` 即走这条分支（我们的 kind 是 `subagent-wait-reminder`）。
7. 装配进请求：`dsh-session/lib/types/surface.js:75-106` `deriveEventMessage` 对 `user/message` 直接返回 `event.data`（`:85-87`，注释“Ordinary prompts and injected context retain producer-owned framing”），故该消息进入 surface 投影 → 请求历史。

结论：链路闭合，提醒确实出现在**发起该次工具调用的那个 agent** 的下一次请求里（context 挂在被 post-process 的那次执行结果上，`:1166` 用的是当前 loop 自己的 `this.inbox`）。

补充（对需求 1 “两种动作之后”的时序含义）：`:1067` 的 `firstAttempt` 门控说明**同一 step 的模型请求重试不会重复落盘**；而工具调用本来就要求下一步（`:1164-1167` 有 toolCall 时返回 `null` 继续循环），因此“下一次请求”必然发生，不依赖注入去强行多走一步。

### 维度 2 检测正确性 — 成立；两项前提须记录

- `exec.name` 的真实来源：`dsh-agent-loop/lib/index.js:509-518` 用模型 `tool-call` 块的 `block.name` 构造 exec，即**模型侧注册名**。派发工具名来自配置：`dsh-tool-subagent/lib/index.js:359` `const toolName = config.toolName ?? "subagent"`，schema 默认同为 `subagent`（`:313`）。生产配置里确有第二个实例：`dsh-base/cordis.patch.yml:380-384`（`provider: spawn / toolName: subagent`）与 `:391-395`（`provider: fork / toolName: subagent_fork`），`dsh-web-app/presets/{cordis,ptc,standard}.patch.yml:102-103` 同样写 `toolName: subagent_fork`。→ `DISPATCH_TOOLS = {'subagent','subagent_fork'}`（`lib/index.js:54`）对当前运行时精确命中，**两个动作都命中**。
- `list_agents`：注册名硬编码 `dsh-tool-subagent-control/lib/types/list-agents.js:45`，该模块无 `toolName` 配置项 → `POLL_TOOLS`（`lib/index.js:57`）命中可靠。**这使 README 声明的“改名则不检测”限制在现运行时内并无触发路径**（限制陈述偏保守，不算错）。
- 改名兜底可行性：`dsh-tool-subagent/lib/index.js:436-439` 的 render 是**字面量** `started subagent ${value.subagentId}`，与 `toolName` 无关 → 改名后 `lib/index.js:121-122` 的前缀匹配确实有效，兜底成立。
- 误命中面：全运行时 `rg "started subagent"` 仅上述一处，无其它工具产生该前缀；且 `isError === true` 先短路（`lib/index.js:117`）。
- 未覆盖场景（须记录，非缺陷）：若某部署按 `dsh-tools/lib/index.js:2731` 提示做 **per-agent 变体注册**（`register through that agent's ctx`）而改名，则名称集合与前缀兜底都可能落空——与 `list_agents` 改名同属“按名检测”的固有边界，插件注释只写了 `list_agents`，未覆盖这一类。

### 维度 3 决策合规 — 成立，无崩溃路径

- `lib/index.js:135-138` 返回 `{...downstream, additionalContexts}`，保留 `kind` 与 `value`/`content`/`feedback` 原样，只覆写 `additionalContexts`。
- 三变体逐一核对（api-catalog:6384；实现 `dsh-tools/lib/index.js:3601-3627`）：
  - accept+content：`hasOwn('content')` 真、`hasOwn('value')` 假 → 不触发 `:3611` 的 `TypeError("…cannot replace both value and content")`；走 `:3623-3626`。
  - accept+value：同理不冲突；走 `:3613-3621`（注意 `:3614` 只在 `result.isError` 时对 value 抛错，与本插件无关）。
  - block：`decision.kind === "block"` 在 `:3602` 提前分支，`additionalContexts` 仅在非空时写入（`:3608`），`feedback` 未被动。
- **`value`/`content` 同时存在的崩溃路径不由本插件制造**：需要下游决策对象自己带这两个 own key（`Object.hasOwn` 对显式 `undefined` 也返回真），本插件从不新增这两个键。
- 关键点：`additionalContexts` 为 `[ours, ...(downstream.additionalContexts ?? [])]`，与官方 `dsh-repeat-tool-reminder/lib/index.js:2194-2196,2254,2258` 完全同构。

### 维度 4 需求 3（不重复）— 成立（按“每动作一次”口径）

- 每次执行只跑一遍瀑布一次：`dsh-tools/lib/index.js:3455-3469` `finalizeScheduledExecution` 内含唯一一处 `postExecute`（`:3464`）；调用侧 `dsh-agent-loop/lib/index.js:565-576` `commitReady` 对每个 slot 至多调用一次 `finalize`（`committed++` 单调），`:618-660` 的 abort 分支只给**未启动**的调用补记合成结果（`:663-679` `appendSkippedToolCall`，不经 post-execute）→ 未执行即不提醒。
- 重试不重复：模型请求重试在 `:1067` 被 `firstAttempt` 挡住，不重复 append `user/message`。
- 历史回放不重复：`additionalContexts` **不写进** 持久 `tool/result` 事件（`:691-704` 的 data 只有 `turn/step/message/error/meta`）；提醒的持久性只来自 `agent/inbox/spliced`（`:103-111` `claim` 用带 `removedCount` 的 splice 消费）。重放按 splice 序列重建收件箱（`:26-62`），不会二次投递；唯一残留风险是崩溃恰好发生在 splice 与 claim 之间 → 恢复后多送一次（语义上是“待办仍在”，非重复堆积）。
- 并发：插件无跨事件可变状态（无 Map/WeakMap/setTimeout），监听器每次新建消息；inbox 的唯一性约束是 `id` 去重（`:42-45`），每次新 UUID 不碰撞。
- 见 NB-1 关于“一步多动作 → 多条相同文本”的口径问题。

### 维度 5 消息形状合法性 — 成立

- 声明层：`UserMessage = MessageBase{readonly id; readonly content: readonly ContentBlock[]; readonly source: MessageSource} & {role:'user'}`（`dsh-llm/lib/types/message.d.ts:124-133,144-146`）；`MessageSourceMap` 文档明确“merge-extensible，每个生产者在自己模块里声明自己的 kind，消费者对未知 kind 落到默认分支”（`:94-108`）→ 自定义 `kind: 'subagent-wait-reminder'` 是**被授权的正规做法**。`form:'notice'` 属运行时词汇表（`:46-58`），且 notice 变体要求 `summary: string`（`:86-88`）→ 已提供。
- 工厂对照：官方用 `createUserMessage`（`dsh-llm/lib/types/message.js:53-58` → `createMessage:34-39` = `deepFreeze(structuredClone({...input, id: brandString(randomUUID())}))`）。`brandString` 是**编译期恒等函数**（`dsh-brand/lib/index.js:20-22`），`dsh-util-crypto` 的 `randomUUID` 是 `getRandomValues` 铸的 v4 十六进制串（`:27-33`）——与本插件 `node:crypto` 的 `randomUUID()` 同类同形。故手工构造与工厂产物**字段等价**，仅少了 detached clone；因对象本已冻结且下游只读（`dsh-session/lib/types/index.js:99-118` 对 `user/message` 走 `deepFreeze(event.data)`；surface 只读取），无行为差异。
- 持久化校验：`assertMessageEventShape`（`dsh-session/lib/index.js:1194-1219`）对 `user/message` 要求 `id` 非空字符串（`:1200`）、`role === 'user'`（`:1203`，映射表 `:1186-1192`）、`source.kind` 非空字符串（`:1205`）、`content` 为数组（`:1206`）；`system/assistant/tool` 的 kind 约束分支（`:1208-1218`）不适用于 user。**无 kind 白名单**。
- 数据级校验：`validateSessionEventData`（`dsh-session/lib/types/surface.js:118-150`）对 `user/message` 只禁止 developer 角色与 tool-addition/tool-removal 块（`:123-130`），我们的块是纯 `text`。
- JSON 可序列化门：结果经 `materializePresentation → snapshotJsonValue`，非 lossless JSON 会抛 `TypeError("tool result must be losslessly JSON-serializable")`（`dsh-tools/lib/index.js:2703-2706`，presentation 含 `additionalContexts`，见 `:3691`）。我们的消息是纯字符串/数组/普通对象字面量（`lib/index.js:90-103`，无函数/symbol/undefined）→ 通过。
- 同类实现一致性：`dsh-repeat-tool-reminder/lib/index.js:2235-2245` 与 `dsh-subagent/lib/index.js:511-539`（`source:{kind:'subagent-settled', form:'notice', summary:…}`）证明“自定义 kind + notice + summary”是被生产代码实际使用的组合。

### 维度 6 需求 5（无副作用）— 成立

- 不注册工具：`lib/index.js` 全文只有一处 `ctx.on`（`:131`），无 `ctx.tools.register` / `defineTool`。
- 不拦截/阻断：监听器在每条路径都**恰好调用一次** `await next()`（`:133`），并原样返回 `downstream`（`:134`）或仅扩展它（`:135-138`）；cordis 的“不调 next() 即否决后续与内置行为”风险（`cordis/lib/index.js:311-312`）不存在。
- 不改写其它工具结果：`action === null` 早退返回同一对象引用；命中分支只做对象展开，`result` 未被写（`dsh-tools` 侧本就把它当 `Readonly`，`:4478`）。
- context 顺序影响：我们前插自己的 context（`[ours, ...downstream.additionalContexts ?? []]`）。瀑布外层监听器先跑（`cordis/lib/index.js:320-324`），故**注册更早的插件其 context 排在我们之后**；注册顺序改变会影响相对次序，但官方同类插件用完全相同策略（`:2194-2196`），且注册表最终以 `[...result.additionalContexts, ...decisionContexts]` 合并（`dsh-tools/lib/index.js:3612`），工具自身 defer 的 context 恒在前。→ 语义中性，符合“不修改既有语义”。
- 作用域副作用：`scopeTarget` 的过滤器对**无 scope 标签的 context 监听器一律放行**（`dsh-scope/lib/index.js:331-332`，文档 `:316-322`），因此本插件会看到全进程所有 agent 的工具执行——即需求 6 第一条已知取舍，实现与声明一致。

### 维度 7 装载契约 — 成立（含一处需澄清的部署语义）

- 导出形态：`export const name`（`lib/index.js:48`）与 `export function apply(ctx)`（`:130`）。cordis 接受“函数 / class / 带 `apply` 的对象”（`cordis/lib/index.js:1619-1621`），ESM namespace 对象即“带 apply 的对象”；`plugin.name` 用作运行时显示名（`:1625-1628`）；`Config` 缺省合法（`:1631`）；`inject` 缺省 → `Inject.resolve(undefined)` 返回空表（`:1635` + `:1491-1493`）。只用 `ctx.on` 不触发“without inject”报错路径（`:676`）。
- 官方先例的导出面就是 `{Config, apply, name}` 且**无 inject**（`dsh-repeat-tool-reminder/lib/index.js:2267`），并作为宿主插件被 `dsh-base/cordis.patch.yml:448-449` 装载 → 本插件的 `{name, apply}` 形态可加载。
- 包字段：`"type":"module"` + `"main":"lib/index.js"` + `"exports"` 含 `"."` 与 `"./package.json"`，与官方插件同构（对照 `dsh-repeat-tool-reminder/package.json`）。无 `dependencies`/`peerDependencies` → 需求 4 的“不依赖外部包”成立（唯一 import 是 `node:crypto`，`lib/index.js:45`）。
- engines 预发布判定：`engines.dsh: ">=0.2.0-rc.2"`；比较函数固定 `includePrerelease: true`（`dsh-app-boot/lib/index.js:276-278`），且文档声明“An own `engines.dsh` range decides alone and peerDependencies are ignored … Prereleases participate in ranges”（`:301-304`）。实测运行时版本 `0.2.1-rc.5`，其 `[major,minor,patch]` 高于下界 `0.2.0-rc.2` → **满足**。（注：若去掉 `includePrerelease`，跨 tuple 的预发布版本本不应满足该下界；这里依赖 app-boot 显式开启的该标志，属宿主行为，已核实。）
- 身份字段：不满足时才要求 `name`/`version` 非空（`:261-264,316-318`）；本包两者齐备。
- 本地包安装链路：`dsh plugin … add file:<绝对路径>` → `runPluginCommand` 把参数原样交给 pnpm（`dsh-plugin-manager/lib/types/operations.js:591-602`），且 `parseInstallSpec` 显式接受 `file:`/`link:` 前缀的绝对路径并归类 `kind:'path'`（`dsh-plugin-manager/lib/types/install-spec.js:58-67`），安装前还会直接从磁盘读该目录 `package.json` 做兼容性判定（`dsh-plugin-manager/lib/index.js:391-407`）。→ README 第 1 步标“未静态验证”的这条，**本次已静态验证为可行**（Windows 绝对路径须为 absolute；相对路径会被拒：`install-spec.js:64-69`）。
- 但见 NB-2：普通依赖不会自动进入运行条目，必须 profile patch 条目（`dsh-app-boot/lib/index.js:1175,1217,1226` + `:490-497`）。

### 维度 8 崩溃与边界 — 后果有限，风险低

- `exec.agent` 为空：`lib/index.js:132` 先判 `exec.agent === void 0` → `action = null` → 原样返回下游。注意这是**仅判 undefined**（`ToolExecutionInput.agent?: Agent`，api-catalog:8176），符合声明。附带事实：`list_agents` 与派发工具在 `agent` 缺失时自身抛错（`dsh-tool-subagent/lib/index.js:442-444`；`dsh-tool-subagent-control/lib/types/list-agents.js:113`），即该边界本就不产生成功结果。
- `result.content` 缺失/异形：进入 post-execute 的结果一律 `content` 为数组——成功走 `createSuccessResult`（`:3637-3666`，render 后 `snapshotProjection`）、失败走 `toolErrorResult`（`:3712`）、取消走 `toolAbortedResult`/`toolAbortedBeforeDispatchResult`（`:3772-3808`，均硬编码 `content: [{type:'text',…}]`）、拒绝走 `:3339-3352`（同样硬编码数组），且 `:3428` 已强制规范化。**因此 `classify` 的 `.filter` 不会因非数组抛错**；块级访问用了 `block?.type`（`:121`）可容 null/字符串元素；`join` 对 `text: undefined` 转空串。
- 监听器抛错的后果：`waterfall` 不吞异常（`cordis/lib/index.js:317-325`），`finalizeScheduledExecution` 的 catch 把整次结果改写成 `toolErrorResult`（`dsh-tools/lib/index.js:3466-3468`）→ **一次成功的子智能体派发会被模型看成失败**。现实可达性评估：仅剩 `next()` 自身 reject（下游插件抛错，与我们无关）与 `randomUUID()` 失败两条，均非本插件逻辑。故不阻塞，但见 NB-6。
- `downstream.additionalContexts` 非数组（下游插件违约）：`[msg, ...nonArray]` 会在展开时抛 → 同上一条后果；这是共享契约面，官方插件同样暴露。
- 冻结对象：`Object.freeze` 三层（`:90-103`）。下游对 context 消息只做读取/克隆/`deepFreeze`（`dsh-session/lib/types/index.js:105`；`dsh-llm/lib/types/message.js:26-28,34-39` 的 `freezeMessage/createMessage` 都是先 clone 再冻），未见就地写字段 → 无 strict-mode 抛错路径。
- 与 block 决策叠加：若另有插件把本次结果 block 掉，我们的提醒仍随 `decisionContexts` 送达（`dsh-tools/lib/index.js:3602-3609`，此时工具自带 deferred context 被丢弃）。事实核对：post-execute 在 tool body **执行之后**运行（`:3405-3408` 先 `bodyInvoked = true` 再 execute），子 agent 已真实启动、完成通知仍会送达 → 提醒内容在该边界仍为真，不构成误导。

### 维度 9 文案合规（需求 2）— 成立

逐句核对 `lib/index.js:62-77`：

- 明确“通知与查询无关”，且不可能被读成“查询触发通知”：
  - 派发文案：“系统会主动把完成通知送进本会话——**通知与是否查询无关，不需要任何查询来触发**。”（`:64`）
  - 轮询文案：“完成通知由系统在子智能体结束时主动送达，**与是否查询无关；重复查询不会加速它结束**。”（`:74`）
  两句都用了“无关/不会”型否定，未出现“查询后即收到”一类因果句式。
- 对 `list_agents` 使用“避免”而非“禁止”：`避免用 list_agents 查看运行中状态`（`:65`）、`避免再次查询`（`:75`）→ 合规。
- 事实性校验（提醒不能承诺不存在的机制）：运行时确实**主动**投递完成通知——`createSettlementMessage`（`dsh-subagent/lib/index.js:508-539`）经 `parent.followup(message)`（`:1642`）送进父会话，与任何查询工具无关；`list_agents` 自身描述也写明“You will be notified when a subagent finishes; there is no need to keep checking its status”（`dsh-tool-subagent-control/lib/types/list-agents.js:46-49`），派发工具描述为“The runtime notifies you when it finishes.”（`dsh-tool-subagent/lib/index.js:384`）。→ 文案与运行时行为一致。
- `interrupt_agent` 作为“仅中止时用”的指路，与工具目录语义一致（`interrupt_agent` 描述：调用即请求停止；深层后代仅可由它中止）。
- 轻微可议（不改判）：`:66` “没有独立工作就结束本轮” 与需求 2 无冲突；`<system-reminder>` 包裹与宿主既有提醒风格一致，不构成阻塞项。

### 维度 10 README 与需求 6 陈述的真实性

机制表逐条复核（README:18-26）：

| README 断言 | 我的独立核验 | 结论 |
|---|---|---|
| post-execute 事件签名 | api-catalog:4476-4482 确实存在该条目，签名在 :4478 | **对得上** |
| `PostToolDecision:6384` 支持 accept/block 两种变体带 context | :6384 声明三变体，每个都含 `additionalContexts?: UserMessage[]` | **对得上**（README 说“accept / block 两种变体”是概括，实际 accept 拆 value/content 两支，无实质错误） |
| `ToolExecutionInput:8176`、`ToolExecution:8168` 字段 | :8176 含 `name`/`agent?`/`callId`；:8168 extends :8176 | **对得上** |
| `ToolExecutionSuccess:8188`、`ToolExecutionFailure:8172` 字段 | :8188 含 `isError:false`/`value`/`content`/`additionalContexts`；:8172 含 `isError:true`/`error`/`content`/`additionalContexts` | **对得上** |
| 注册表合并 `dsh-tools:3601-3626`（合并见 :3612） | 函数体 `:3599-3628`，`decisionContexts` 于 :3601，合并于 :3612 | **对得上** |
| 循环接收 `dsh-agent-loop:504`（文档“for the next step boundary”）、消费点 :572 | :504 为 `@param acceptContext - accepts committed result context for the next step boundary.`；:572 为 `acceptContext(context)` 循环 | **对得上** |
| 官方插件同用法 `dsh-repeat-tool-reminder:2247-2264` | :2247 起为 `ctx.on("tools/post-execute", …)`，:2254/:2258 用 `prependContext`，:2261-2262 为 `agent/pre-step` 仅识别 `source.kind === "user"` | **对得上** |
| pre-step 载荷不可用于检测（api-catalog:4006、`PreStepDecision:6424`、`dsh-agent-loop:906-912`） | :4006 载荷 `{agent, messages: UserMessage[], turn, step, signal}`；:6424 `PreStepDecision` 两变体；:906-912 `claim()` 结果即 `messages` | **对得上**，且该推理成立：`tool-call` 块属 AssistantMessage（message.d.ts:148-151）、结果属 `role:'tool'`（:153-160），不可能出现在 `UserMessage[]` |
| 机制行头“dsh 0.2.1-rc.5”（README:16；lib/index.js:14） | `@deepseek-ai/dsh/package.json` 实测 0.2.1-rc.5 | **对得上** |

需求 6 三条取舍（README:32-34）逐一验真：

1. “子 agent 自身也会收到提醒”：由 `dsh-scope/lib/index.js:331-332` 无标签监听器全局放行 + `dsh-tools/lib/index.js:3600` 按 `exec.agent` 派发共同决定 → **真实**，影响面为“所有编排者的反轮询引导一致”，无功能副作用（消息只进发起者自己的请求）。
2. “`list_agents` 改名则不检测”：检测只依赖名字（`lib/index.js:57,119`），无兜底 → **陈述保守为真**；但 `list_agents` 名在 `list-agents.js:45` 硬编码且该插件无重名配置，故现运行时不存在触发路径。真正未被 README 覆盖的同类风险是 **per-agent 变体注册导致的改名**（`dsh-tools/lib/index.js:2731`），见维度 2。
3. “失败或被拒的调用不注入”：`isError === true` 短路（`lib/index.js:117`）。事实链完整：拒绝/取消确实**也会进入**本瀑布（`dsh-tools/lib/index.js:3332-3353` 对 deny/cancel 返回 `kind:'post-result'` 且 `isError:true`），所以“被拒不注入”是靠 isError 判定实现的，而非“被拒不进瀑布” → **真实**，且插件注释 `lib/index.js:110-111` 关于“denied calls still flow through this waterfall”的说法也**为真**（与官方注释 `dsh-repeat-tool-reminder/lib/index.js:2216-2221` 相互印证）。

验证状态声明核对（README:36-40）：

- “已执行 `node --check`” / “已执行字段级类型核对”：属产出方自述。前者**本次无法核实**（评审约束禁止对被审文件运行任何命令，包括 `--check`；我改为整文件静态走读，语法为标准 ESM，无语法可疑构造）；后者**已由我独立复核为真**（上表即其结果）。README 把“未安装、未在真实会话验证”列为最大剩余风险，这一自我评级**与事实一致**——注入链每一环虽有源码证据，但“提醒进入下一次请求”的最终确证仍需一次真实派发观察。
- 评审历史段（README:42-48）称首版 FAIL 与本版无关：本版检测数据源已改为 post-execute，与首版根因（读 pre-step 里没有的字段）不再相关；`lib/index.js` 全文只读 `exec.name`、`exec.agent`、`result.isError`、`result.content`、`downstream.additionalContexts` 五个字段，**全部在其声明类型内**（api-catalog:8176、:8172/:8188、:6384）→ README:47 的“已全部在声明层核对”为真。
- README:52 “本地包登记这条路径未静态验证” → 本次已静态验证可行（`install-spec.js:58-67` + `operations.js:591-602`），可去掉该 hedge；README:53 的“必须先备份再改 patch”属流程建议，与源码无冲突。

---

## 需求逐条对照

| 需求 | 结论 | 关键证据 |
|---|---|---|
| 1a 派发（`subagent`/`subagent_fork`）后注入 | 达成 | `lib/index.js:54,118`；名来源 `dsh-tool-subagent/lib/index.js:359` + `dsh-base/cordis.patch.yml:380-395` |
| 1b 查看状态（`list_agents`）后注入 | 达成 | `lib/index.js:57,119`；名 `dsh-tool-subagent-control/lib/types/list-agents.js:45` |
| 1 注入到“该 agent 下一次模型请求” | 达成（静态闭合，待一次真实观察） | 维度 1 全链（`dsh-tools:3601-3627` → `dsh-agent-loop:572,1166,906-920,1066-1072` → `dsh-session/lib/types/surface.js:85-87`） |
| 2 文案（通知与查询无关；对 list_agents 用“避免”） | 达成 | 维度 9；真实性由 `dsh-subagent/lib/index.js:508-539,1642` 支撑 |
| 3 每动作一次、不重复堆积 | 达成（按“每动作一次”读法）；step 内扇出会叠多条相同文本 → NB-1 | `dsh-tools:3455-3469`；`dsh-agent-loop:565-576,42-45,1067` |
| 4 宿主插件加载、无外部包 | 达成 | `cordis/lib/index.js:1619-1641`、`dsh-app-boot:276-304,1175-1226`；`lib/index.js:45` 仅 `node:crypto` |
| 5 不注册工具、不拦截、不改既有文件 | 达成 | 维度 6；`lib/index.js:131-139` |
| 6 三条已知取舍 | 三条均真实（其中“改名”在现运行时无触发路径；另有一类改名风险未列） | 维度 2、维度 10 |

## 遗留风险与后续建议

1. 按 README 步骤安装后，用**一次真实派发 + 一次 `list_agents`** 观察：两条 `<system-reminder>` 是否各出现在下一 step 的请求里；Web GUI 是否把该 `source.kind` 呈现为不透明上下文（客户端读 `source.kind` 处均为正向匹配、未知 kind 自然落空，见 `dsh-client-ui-chat/lib/client.js:2815,2831,9890`，不会当作人类输入）。
2. 若需求方希望“每 step 一条”，按 NB-1 加去重，并同步更新 README 的机制描述（当前 README:17-18 明确写的是“每次实际执行触发一次”，与实现一致；改动后需一并修订）。
3. 建议在 README 安装步骤里补 NB-2 的必需 patch 条目（含建议写法 `- id: subagent-wait-reminder` / `name: dsh-subagent-wait-reminder`），并把 `file:` 那行的“未静态验证”改为“已静态验证：需绝对路径”。
4. 版本耦合点（升级时须重查）：`started subagent ` 渲染前缀（`dsh-tool-subagent/lib/index.js:438`）、`PostToolDecision.additionalContexts` 契约（api-catalog:6384）、accept 分支对 `content`+`value` 的互斥抛错（`dsh-tools/lib/index.js:3611`）、`user/message` 形状校验（`dsh-session/lib/index.js:1194-1219`）。
