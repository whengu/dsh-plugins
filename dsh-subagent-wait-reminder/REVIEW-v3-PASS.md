# REVIEW — dsh-subagent-wait-reminder（v3 delta：可安装形态 + step 内去重）

- 评审角色：独立静态评审（subagent），只读被审物，未执行被审代码、未安装、未打包。
- 评审日期：2026-11-02
- 结论先行：**verdict = PASS**，violation_suspected = **false**，无 blocking issue。

## 0. 被审版本与证据基线

被审物哈希（本评审用 `Get-FileHash -Algorithm SHA256` 现算，与任务书前缀逐一相符）：

| 文件 | SHA256 前 16 位 |
|---|---|
| `lib/index.js` | `878A22AB18B45554` |
| `package.json` | `B5E137EECC6805F7` |
| `cordis.patch.yml` | `503F34696620EF36` |
| `README.md` | `00B361A9EB387739` |

运行时证据基线：本机安装的 DSH `0.2.1-rc.5`（`D:\Program\nvm\v24.18.1\node_modules\@deepseek-ai\dsh\package.json` version 字段现读），其依赖闭包位于 `...\dsh\node_modules\@deepseek-ai\*`。下文所有 `文件:行号` 均指该安装副本，由本评审实际读取，非转抄。

按任务约束：`REVIEW-v1-FAIL.md`、`REVIEW-v2-PASS.md` 未读取；被审 README 中的行号不作为证据，其陈述以引文核对。

## 1. blocking_issues

无。

## 2. non_blocking_suggestions

1. **建议：`engines.dsh` 收紧或在 README 注明最低实测版本。**
   evidence：`package.json` 声明 `"engines": { "dsh": ">=0.2.0-rc.2" }`，而 `lib/index.js` 头注释自述机制"verified against the runtime this targets (dsh 0.2.1-rc.5)"。`0.2.0-rc.x` 上事件签名/字段是否一致未验证；装到更老 rc 上可能静默失效（装得上、不生效）。收紧为 `>=0.2.1-rc.5` 或补注释更稳。
2. **建议：`tar -tzf` 核对注释补充 `package/` 前缀说明。**
   evidence：README 安装段写道"`tar -tzf dist\...tgz  # 必须含 lib/index.js、cordis.patch.yml`"。pnpm/npm pack 的 tarball 条目统一带 `package/` 目录前缀，人工核对时应按 `package/lib/index.js`、`package/cordis.patch.yml` 判读，否则首次执行者易误判打包失败。
3. **建议：消除安装副本内的断链。**
   evidence：README 以相对链接引用两份评审报告（"[REVIEW-v2-PASS.md](REVIEW-v2-PASS.md)"等），而 `package.json` 的 `files` 白名单只含 `lib/index.js`、`cordis.patch.yml`、`README.md`，两份报告不会进 tarball → 安装副本内链接悬空。可改为不带链接的纯文字引用，或将报告纳入 `files`。
4. **建议（一致性，可选）：post-execute 对 `block` 变体显式分支。**
   evidence：`lib/index.js` 的监听器统一 `return { ...downstream, additionalContexts: [...] }`；官方同类 `dsh-repeat-tool-reminder/lib/index.js:2251-2259` 对 `downstream.kind === "block"` 走显式分支再附加 contexts。两者最终都类型合法（见 derivation #13），当前写法语义也可接受（post-execute 阶段子进程已创建，block 只改写结果），仅为与官方插件形态一致的可选项。
5. **建议：补 LICENSE 文件或调整说明。**
   evidence：`package.json` 声明 `"license": "MIT"` 但目录内无 LICENSE 文件，`files` 亦未列；tarball 无许可证文本。纯合规卫生问题。

## 3. not_ready_reasons

无（不阻塞判级）。唯一未闭合的验证是"真实会话中确认提醒进入下一次模型请求"，README 已如实声明为待办；本评审通过静态链证明链路闭合（derivation #12），该项属于安装后的验收动作，不构成 NOT_READY 理由。

## 4. derivation（逐项核对记录）

### A. 安装形态（本轮重点）

**#6 `dsh.bundle.patch` / `files` / `exports` / `engines` + `cordis.patch.yml` insert 语法 → 成立，构成可被打包并被 `dsh plugin add` 自动激活的 Host 侧插件。**

- 自动激活链路（全部现读安装副本）：
  - `dsh plugin --profile web add <abs.tgz>`：`dsh/lib/bin.js:115-128` 定义 `plugin` 子命令、`--profile` required；`dsh/lib/plugin-BiveYA7h.js:63-98` `runPlugin` → `runPluginCommand`。
  - `dsh-plugin-manager/lib/types/operations.js:591-602` `runPluginCommand` → `runProfilePnpm`（`activateNewBundles` 未被关闭，默认启用）；`:299-584` pnpm 成功（exit 0 且未 stalled）后执行 `reconcile`。
  - `operations.js:96-124` `reconcile`：对**新增**依赖读 `bundleManifest`（`:83-87`，判定 `manifest.dsh?.bundle?.patch !== undefined`），命中则 `loadOverlayPatches` 预校验 patch 文件并追加进 `dsh.profile.bundles`。未声明 bundle 才打"plain dependency"警告。本包已声明，路径闭合。
  - 安装后兼容门：`operations.js:498-534` 对新装包及其 bundle 组件做 `evaluatePluginCompatibility`；本包 `engines.dsh` 满足（下条），不会被拒。
- 启动装载链路：`dsh-app-boot/lib/index.js:1015-1034` `loadProfileDirectory` 按 `dsh.profile.bundles` 顺序读各 bundle 的 patch（`:517-531` `bundlePatchPaths`），与 profile 用户层、home 层、`--patch` 叠加；`prepareProfilePatches`（`:2396-2401`）把行包成 `{ insert: rows }` 应用于**空根**。profile 根 `cordis.yml` 本身是空表（`dsh/lib/profile-boot-C14i-8IN.js:121-127, 216-222`），因此本包的顶层 `- insert:` 恰好把条目追加进根列表。
- insert 语法核对：`applyEntryPatches`（`dsh-app-boot/lib/index.js:61-110`）对 `{ id, insert, name }` 的处理——无外层 `id` 时 `data.push(...insert)`，与被审 `cordis.patch.yml`（顶层 `- insert: - id: subagent-wait-reminder / name: dsh-subagent-wait-reminder`）一致；该最小形态亦与 `dsh-ability-strip/INSTALL.md` §8 模板逐字一致。裸名 `name` 不被 `anchorInsertedPluginNames`（`:3970-3979`）改写，运行时经根 Include 的 baseUrl（锚定 profile 目录，`profile-boot-C14i-8IN.js:206-209`）与 `resolveBundleDir` 第二锚点（profile `package.json`，`dsh-app-boot:995-1001`）从 profile `node_modules` 解析；Loader `unwrapExports`（`cordis-plugin-loader/lib/index.js:666-672`）接受模块命名空间，`apply` + `name` 导出即可挂载。
- `engines.dsh`：`evaluatePluginCompatibility`/`unmetRequirements`（`dsh-app-boot:276-326`）用 `semver.satisfies(runtime, range, { includePrerelease: true })`。本评审实际执行 `semver.satisfies('0.2.1-rc.5', '>=0.2.0-rc.2', {includePrerelease:true})` → `true`（这是对 semver 库的检查，非执行被审插件）。
- `files`/`exports`：运行只需要 `lib/index.js`（仅 `import { randomUUID } from 'node:crypto'`，无外部依赖字段）+ `cordis.patch.yml`；`package.json` 始终包含；`exports["."]` 与 `main` 指向 `./lib/index.js`。无遗漏。
- `private: true` 只影响 publish 不影响 `pnpm pack`（pnpm 语义；本评审因只读约束未实际执行 pack，标注为"未实测，静态判断 + INSTALL.md 同流程实测背书"）。

**#7 README 安装流程 vs INSTALL.md 规约 → 一致，未发现冲突残留。**

逐条核对（README 陈述为引文，INSTALL.md 为规约源）：

| 规约（INSTALL.md） | README 陈述 | 核对 |
|---|---|---|
| §0/§1 禁止目录安装、`link:`、手工放 node_modules；符号链接=源码即线上 | "禁止目录安装 / `link:` / 手工往 profile `node_modules` 放文件"，并给出 pnpm 行为与 `dsh-client-modules` 缓存机理 | 一致 |
| §2 规则1 只从 tarball；规则2 tgz 不可覆盖、每版递增 | "只从 tarball 安装。`pnpm pack` 是只读快照；…已发布的 tgz 不得覆盖，每次发版必须递增版本号" | 一致 |
| §6 `dist/` 不能删：dependencies 记录 tgz 绝对路径 | "`dist/` 不可删：profile 的 dependencies 记录 tgz 绝对路径" | 一致 |
| §4 命令形态 `pnpm pack --pack-destination dist` → `dsh plugin --profile web add "<绝对路径>"`；`--profile` 必须是实际启动 profile；绝对路径加引号 | 命令块逐条同形，且明确"装进实际启动的 profile（dsh web 即 --profile web）" | 一致；`dsh web`=`--profile web` 简写亦与 `bin.js` 帮助文本一致 |
| §4/§7 声明 `dsh.bundle.patch` 的包自动进 `dsh.profile.bundles`，无需手工编辑 profile `cordis.patch.yml`；出现"declares no dsh.bundle"警告说明包结构有问题应修包 | "本包声明了 `dsh.bundle.patch`…`dsh plugin add` 会自动把 patch 追加进 `dsh.profile.bundles`，不需要手工编辑…若日志出现 `declares no dsh.bundle — installed as a plain dependency`，说明包结构有问题，应修包而不是绕过" | 一致，且与 `operations.js:96-124` 实现吻合 |
| §4 Host 不需要重启（dsh-hmr 监视 profile 清单重组层）；浏览器半边才需 Ctrl+F5 | "Host 不需要重启：`dsh-hmr` 监视 profile 清单并重组层…本插件是纯 Host 侧插件（无 `dsh.client`），没有浏览器半边，因此不涉及 Ctrl+F5" | 一致；`dsh-hmr/lib/index.js:849-873` 现读证实其 watch profile `package.json` 与 patch 文件并 `reconcileProfile` |
| §5 验收：LinkType 为空、`dsh plugin why` 可见 | 验收命令同形 | 一致 |

发现的偏差均为文档精度级（见 non_blocking #2/#3），无与规约相反的指令。

**#8 `files` 白名单 → 无漏。**
`pnpm pack` 产物 = `package.json`（恒含）+ `lib/index.js` + `cordis.patch.yml` + `README.md`。运行时 import 图仅 `node:crypto`（Node 内置），Loader 按包名解析 `exports["."]`。结论：产物足以运行（静态判断；pack 本身未执行，见上）。

### B. step 内去重（本轮重点）

**#9 闩与清闩 → 真正实现"同一 step 内同类动作只提醒一条；跨 step 可重新提醒"；清闩时机恰在 step 边界。**

- 设置点：`lib/index.js:145-161`，`tools/post-execute` 监听器按 `WeakMap<Agent, Set<'dispatch'|'poll'>>` 记闩，同 kind 命中即返回 downstream 不再加。
- 清除点：`lib/index.js:164-167`，`agent/pre-step` 回调 `latched.delete(agent)` 后 `next()`。
- 调用点证据（清闩频率）：
  - `dsh-agent-loop/lib/index.js:902-927` `preStep()`：每次调用 dispatch 一次 `agent/pre-step` waterfall；
  - `:938-1009` `turn()` 的 while 循环**每个 step 先 `preStep`（:956）再 `step()`（:980）**；
  - `step()` 内部对 LLM 失败的重试是 `:1051` 起的 while 循环，**不**重复进入 preStep。
  - ⇒ 每个 step 恰好清一次闩，且清在 step 的任何工具执行之前。不会"永不清闩"（任何后续 turn 的首个 preStep 都会清；pre-step 被其它监听器 reject 也先经过本监听器），也不会"清得过频"（不是每次执行都清）。
- 键一致性证据：`tools/post-execute` 的 `exec.agent` 来自 `executeToolCalls` 的 `ctx.agents.requireInitiator()`（`dsh-agent-loop:506-518`），即 `wakeDriver` 里 `withInitiator(this, …)` 的 loop agent 本体（`:868`）；`agent/pre-step` 经 `this.dispatch = agentEvents(loopCtx, this)`（`:777`）派发，`agentEvents` 的 fused 恒注入同一 `agent` 对象（`dsh-agent/lib/index.js:242-272`）。两处为同一对象，WeakMap 键匹配。
- 同 step 内并发：`runGroup.commitReady`（`dsh-agent-loop:565-576`）按模型顺序**串行** commit，Set 操作同步，无竞态；一步内扇出 N 个同 kind 调用只留第一条。
- 跨 step 重新提醒：闩已清，下一步同类动作重新注入——与需求 3 相符。

**#10 pre-step 监听器只读 `agent` → 字段存在，透传无干扰。**

- 载荷类型：`api-catalog.js:4006` 声明 `payload: { agent: Agent; messages: UserMessage[]; turn; step; signal }`；实现上 `agent` 由 `agentEvents` fused 注入（`dsh-agent/lib/index.js:243-246`，spread 在前防止外部覆盖）。
- 实参来源：`messages` 取自 `this.inbox.claim()`（`dsh-agent-loop:906`），确为入站用户批次，不含工具调用/结果——README"为什么不是 pre-step 检测"的论断成立。
- 本插件只解构 `{ agent }`，`return next()` 原样透传 `PreStepDecision`（`reject`/`enter` 均不改），不触碰 `messages`，未用 `prepend` 改变监听次序 → 不干扰其它插件（对照：官方 model-switch notice 用 `{prepend:true}` 插消息，`dsh-agent/lib/index.js:193-204`）。

**#11 监听器抛错 / 不调 `next()` 的后果 → 机制已查清；本插件两个监听器均无触雷路径。**

- waterfall 语义：不调 `next()` 即否决整条链、含内建行为（`cordis/lib/index.js:307-325` 的文档与实现）；`agent/pre-step` 被否决=该 step 无法进入。
- `tools/post-execute` 监听器抛错：`postExecute` 位于 `execute` 外层 try/catch，"a throwing listener → isError"（`dsh-tools/lib/index.js:3597` 注释；`:3455-3468` `finalizeScheduledExecution` 的 catch 把结果改写为 `toolErrorResult`）——即会把成功派发改写成错误。
- 本插件：两监听器都在自身逻辑后调用 `next()`；post-execute 在 `next()` 之前只有 `classify`（读 `exec.name`、`result.isError`、`result.content`，字段均有类型依据 `api-catalog:8176/8172/8188`，且 `?? []`、可选链兜底，无抛错路径）；`next()` 之后只有 `randomUUID`、spread、`Object.freeze`，无可预见抛错路径。pre-step 的 `latched.delete(agent)` 对对象键无异常路径。结论：不会因本插件把成功派发改写为错误，也不会否决瀑布。

### C. 回归

**#12 端到端链路 → 闭合。**

post-execute 监听器返回 `additionalContexts` → 注册表合并进结果（`dsh-tools:3599-3627`：`additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts]`，accept/value/content/block 三路径都带上）→ `runGroup.commitReady` 对每个 `result.additionalContexts` 调 `acceptContext`（`dsh-agent-loop:570-572`）→ `acceptContext` 追加进 inbox `next-step`（`:1166`）→ 下一 step 的 `preStep` 先 `inbox.claim`（`:906`）→ `step()` 把非 `runtime-context` 的 decision 消息 `session.append("user/message", …)`（`:1067-1073`）→ 进入该 agent 下一次模型请求。另：turn 收尾判定在 `inbox.nextStep` 非空时不 break（`:1000-1007`），所以即便派发是本轮最后一个动作，提醒也会自己触发下一个 step 被消费。取消路径 `toolAbortedResult`/`toolAbortedBeforeDispatchResult` 保留 `additionalContexts`（`dsh-tools:3772-3808`），提醒不因取消丢失。

**#13 `PostToolDecision` 三变体 → 类型合法，无 content/value 互斥崩溃路径。**

`PostToolDecision` 三变体均允许可选 `additionalContexts?: UserMessage[]`（`api-catalog:6384`）。本插件只做 `{ ...downstream, additionalContexts: [ours, ...downstream.additionalContexts ?? []] }`：
- accept+value：保留 `value`，走 `dsh-tools:3613-3621` 的 value 替换路径并合并 contexts；
- accept+content：保留 `content`，走 `:3623-3627` 合并 contexts；
- block：保留 `feedback`，走 `:3602-3609`，contexts 随 block 结果交付。
插件自身从不添加 `content`/`value`，因此不可能构造出触发 `:3611` `TypeError("…cannot replace both value and content")` 的双字段决策；互斥保护是注册表的防御，不是本插件的崩溃面。

**#14 检测集合与改名兜底 → 成立。**

- `subagent` 为 `dsh-tool-subagent` 的 `toolName` 默认值（`dsh-tool-subagent/lib/index.js:313, 359`）；`subagent_fork` 是同一插件按 preset 配置的第二个实例（`dsh-web-app/presets/cordis.patch.yml:102`、`standard.patch.yml:103`、`ptc.patch.yml:103` 均为 `toolName: subagent_fork`）→ `DISPATCH_TOOLS = {subagent, subagent_fork}` 与当前运行时吻合。
- 改名兜底：派发工具成功结果的 render 固定为 `` `started subagent ${value.subagentId}` ``（`dsh-tool-subagent:436-439`），与 `toolName` 无关；全安装副本 grep `started subagent` 仅此一处 → 兜底前缀唯一，无误报源。
- `list_agents`：名字硬编码（`dsh-tool-subagent-control/lib/types/list-agents.js:43-45`），该插件无 toolName 配置项 → 当前运行时确无改名路径，与 README"没有兜底"的显式取舍一致。README 指出的真实残余风险（按 per-agent 变体注册工具导致名字不同，`dsh-tools/lib/index.js:2731` 的报错文案即提示该注册方式）核对属实。

**#15 需求 5 → 满足。**

无 `tools.register`、无 `guard`、无 `tools/pre-execute`（全文件仅 `tools/post-execute` 与 `agent/pre-step` 两个监听器）；不拦截、不否决（两监听器都调 `next()` 并透传）；不改写他人结果的 `value`/`content`/`feedback`，只附加 `additionalContexts`。前置顺序：插件提醒排在 decisionContexts 首位、注册表合并顺序为"工具自带 contexts → decision contexts"（`dsh-tools:3612`），与官方 repeat-tool-reminder 的 prepend 同型（`:2251-2259`），只影响多条注入消息的先后，不影响其它插件各自的相对顺序。不改任何既有文件。

**#16 消息形状 → 合法。**

`MessageBase { id, content, source }` + `role:'user'`（`dsh-llm/lib/types/message.d.ts:124-146`）；`form:'notice'` 要求同源携带 `summary`（`ContextFormed`，`:85-88`），两条 summary 均在 120 字界内且未超 `CONTEXT_SUMMARY_MAX_CHARS`；自定义 `source.kind` 是 merge-extensible 词汇（`:95-99`："each producer declares its own kind…no shared catch-all plugin kind"），官方先例 `dsh-repeat-tool-reminder` 即用 `kind:"repeat-tool-reminder"`（其 `lib/index.js:2132`）。插件手工构造并逐层 `Object.freeze`（消息/内容数组/块/source），与 `createUserMessage` 的 deepFreeze 冻结强度等价；`id=randomUUID()` 每次新鲜，不会触发 inbox 的重复 id 校验（`dsh-agent-loop:190-194`）。因需求 4 禁止外部依赖，不走 `@deepseek-ai/dsh-llm` 的工厂属约束内的正确取舍。

**#17 文案 → 合规。**

- 两条提醒均含"通知与是否查询无关"（DISPATCH 第 2 句、POLL 第 2 句），且都是肯定句式"系统主动送达"，不存在"查询触发通知"的可误读表述。
- 对 `list_agents`：DISPATCH 用"避免用 list_agents 查看运行中状态"，POLL 用"避免再次查询"；全文件 grep 无"禁止/严禁/不准"作用于查询行为（grep 证实）。
- 无会被 `list_agents` 实际返回值证伪的断言：该工具实际返回 `running | inactive | (no subagents) | diagnostic 行`（`list-agents.js:58-107` schema/render），提醒文案以"查询到的运行中状态不改变你要做的事"这类条件式表述，对空列表/inactive 亦不为假；"完成通知由系统在子智能体结束时主动送达"与工具自述"You will be notified when a subagent finishes"（`list-agents.js:48`）一致。

### README 待证断言核对（引文式，不引用其行号）

| README 陈述（摘引） | 裁决 | 依据 |
|---|---|---|
| 机制表 8 条出处（post-execute 瀑布、PostToolDecision、ToolExecutionInput/Execution、Success/Failure 字段、dsh-tools 合并、agent-loop acceptContext :504/:572、官方插件同用法） | 全部**证实** | 与安装副本逐一比对：api-catalog:4476-4482/6384/8168-8188；dsh-tools:3601-3626（合并确在 :3612）；dsh-agent-loop:504/572；repeat-tool-reminder:2247-2264 |
| "agent/pre-step 载荷是 messages…取自 inbox.claim()…tool-call/result 不可能出现于该数组" | **证实** | api-catalog:4006/6424；dsh-agent-loop:906-912 |
| "step 内去重…WeakMap 闩 + pre-step 清闩；pre-step 只重置状态、能拿到 agent" | **证实** | 见 derivation #9/#10 |
| "list_agents 名字硬编码、无改名路径；派发工具有 `started subagent ` 兜底、全运行时唯一；per-agent 变体注册是真实残余风险" | **证实** | 见 #14 |
| "失败或被拒绝的调用不注入" | **证实** | `classify` 先判 `result.isError === true` 即 null（lib/index.js:120-127）；denied 调用以 isError 结果流经 post-execute（dsh-tools:3339-3353） |
| 安装段全部规约 | **证实一致** | 见 #7 |
| "已执行：`node --check lib/index.js` → OK" | **无法独立核实**（评审禁止执行被审代码）；静态通读为合法 ESM、未见语法问题。标注：未验证项 | 约束声明 |
| "第二轮独立评审对 v2（080F9515880BA478）判 PASS" | **无法核实**（禁读该报告）；且当前 `lib/index.js` 哈希为 `878A22AB18B45554` ≠ 所称 v2 哈希，该 PASS 不构成对当前字节的证据。README 自己已声明"当前字节已不等于被审版本，delta 另派评审"，陈述诚实、无误导 | 哈希现算 |
| "未安装、未在真实会话验证……这是当前最大剩余风险" | 与实际状态一致，属遗留风险而非缺陷 | 见 not_ready_reasons 说明 |

## 5. 结论

- 12 项检查点（#6–#17）全部核对，未发现正确性缺陷；两处本轮新增机制（可安装形态、step 内去重）在静态链上均成立。
- verdict：**PASS**。
- 残余风险（不阻塞、已被产出方自报）：未经真实会话验证提醒确实进入下一次请求；`engines.dsh` 下限宽于实测版本（non_blocking #1）。
- 评审未做之事及原因：未运行 `node --check`/`pnpm pack`/安装（任务只读约束）；上述相关结论均标注为静态判断。
