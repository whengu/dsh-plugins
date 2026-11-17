# reassessment-001 — 独立架构重审：dsh-auto-continue 是否应继续

- 性质：独立根本性重审，只做判定与剖析；不写修复方案、不写代码、不是修复工单。
- 输入：用户最终需求原话 + 对话脉络 + requirement.md / design.md(R2) / design-001.md / design-002.md / progress.md + v0.1.0 实现。
- 权威事实源：DSH 安装树 `D:\Program\nvm\v24.18.1\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，版本 **0.2.2-rc.1**（`dsh-agent-loop/package.json:4` 等全部包一致）。下文所有 DSH 源码行号均针对该版本。
- 方法：静态走读 + 调用链/契约分析（code-review-static）；对需求本身按 design-tree 严格质询（grilling），事实由评审者自行查证，不采信转述。
- 已加载 skill：`code-review-static`、`grilling`。

---

## 总体判定

**CHANGES REQUIRED（方向层面）——当前设计方向不成立，不应以现状继续。**

一句话方向判定：**这个插件想解决的问题是真实的，DSH 原生也确实提供了"配置式启动 resume + 崩溃尾自修复"构件（虽无自动扫描器），但现行 R2 设计没有复用这些构件，而是用自建账本 + 自研持久化 + UI + 934 行设计去重建机制、把简单问题复杂化；应停止现行设计，把"目标会话能否固定配置 / 是否放宽 G3 / 是否接受合成人工授权"三个决策升级给用户后重定形态。**

需要特别指出：本重审发现委托方提供的脉络中，**有一条"越界"指控经权威源码核对并不成立**（见 Q3 的 C2）。独立评审不能为了迎合既有叙事而把错误前提当作事实继承，故在此纠正。

---

## Q1 需求是否真的需要插件？是否是在推翻一个刻意的安全闸？

### 结论（分两层，必须区分）

1. **"disarm"安全闸是刻意的、真实的，且明确针对"未经人工授权的自动复活工作"。** 这一点证据确凿：
   - `dsh-goal-round-driver/README.zh.md:57`：「会话 resume 或 fork 后，active 的 goal 会保持停用续行，直到用户明确授权 resume——驱动器绝不会自行复活工作。」
   - `dsh-goal/README.zh.md:72`：「任何会话开始边界之后，active 的 goal 都会被停用续行——在有人显式 resume 之前，agent 不会自行继续。」
   - `dsh-tool-goal/README.zh.md:116`（模型系统提示，逐字镜像于 `dsh-tool-goal/lib/index.js:195`）：resume 仅在人类以任意措辞明确要求继续时，才用 `update_goal action resume` 重新武装。实现层面 `dsh-tool-goal/lib/index.js:345-350` 的 `requireDirectHuman` 要求当前轮次存在宿主背书的 `{kind:'user'}` 顶层消息；agent/subagent 不能自主 rearm。
   - 持久化语义：`dsh-goal/lib/types/types.d.ts:38` `GoalPhase='active|paused|blocked|complete'`（持久）；`:58` `GoalActivation='armed|disarmed'`（进程本地，从不持久化）；`:82` `GoalView.activation` 注释 "never persisted"。`dsh-agent` 系统提示（本会话 runtime context）也印证：`active goal is disarmed` + `use update_goal action resume to rearm it`。

2. **但用户的原话需求不是"重新武装 goal"，而是"崩溃后下次启动自动续跑那个会话"。** 这是**会话级 resume**，不是 goal 级 rearm。二者是不同机制，不能混为一谈。就在这个区分上，出现两个关键事实：

   - **DSH 已存在官方原生的启动即恢复路径，主 agent 与现有文档均未发现/未采用：**
     - `dsh-agent-loop/README.zh.md:53`：`agents[].resumeSessionId` = 「加载这个持久化会话而不是创建新会话；与 sessionId 互斥」；`:52` `sessionId` = 「首次使用创建，重新挂载时恢复已实体化的历史」；`:218`：省略 `sessionId` 时每次启动都新建 session，**要可靠恢复必须显式提供稳定 `sessionId` 或 `resumeSessionId`**。
     - `dsh-agent-loop/lib/index.js:1347-1378`：启动时遍历 `config.agents`，对带 `resumeSessionId` 的条目直接走 `resumeWith(...)`；`:1410-1427` `restoreOrCreateConfigured` 先恢复、仅在 `SessionPersistenceNotFoundError` 时新建。
     - 身份由 launcher 在装载前注入：`index.js:1254-1260` 注释与 `CONFIGURED_AGENT_IDENTITIES_KEY`，`:1331` `applyLauncherIdentities` 把 launcher 身份覆盖到配置行上（避免 overlay 改路由时丢身份）。这是配置式启动恢复的机制基础；但全树没有 shipped launcher 实际设置该 key（见下方限定）。
     - **崩溃尾巴的修复也是原生的**：`index.js:1739-1740`，resume 时 `const closers = interruptedTurnClosers(persisted); if (closers.length>0) await handle.append(closers)`；`dsh-agent-loop/README.zh.md:116, 198-202` 明确"语义崩溃修复是 agent 层职责，非存储入口"，恢复结果为尚无结果的工具调用注入 `TOOL_OUTCOME_UNKNOWN` / `TOOL_NOT_STARTED`，只重试只读/幂等操作。requirement.md C6 自己也承认这点。
     - **重要限定（经第一手核对，避免夸大原生能力）**：这条原生恢复是**配置驱动的**，不是自动扫描器。`dsh-base/cordis.patch.yml:515-520` 默认 `agents: []`；全树没有任何"启动时枚举所有持久化会话并自动 resume 崩溃者"的实现（NOT FOUND）；也没有任何 shipped launcher 会设置 `CONFIGURED_AGENT_IDENTITIES_KEY`（全树仅 `dsh-agent-loop` 自己定义/消费，`:1260/:1331/:1778`）。所以 DSH **不会**自己发现并续跑任意 web 临时会话。
     - 结论（精确表述）：**对"可被显式配置为稳定身份的会话"，DSH 不需要任何插件即可做到下次启动自动 resume + 自动修复崩溃尾；对任意、非配置会话，原生路径不存在，插件确实在填一个真实的空。** 这是一条未被发现的原生路径，但不是万能替代——它取决于用户要续跑的会话能否被固定配置。

   - **但这恰好撞上刻意的安全设计。** disarm 闸的设计意图是"重启后不要在没有人类授权的情况下自主继续工作"。插件虽然按 requirement.md §3 非目标「不改 goal 生命周期（不调用 goals.*）」没有调用 rearm，但它通过 `agents.resume` + `agentHandle.agent.followup(...)`（`dsh-agent/README.zh.md:58, 61-64`：`followup` 排队一条 next-turn 提示并唤醒驱动器）**合成了一条用户来源的轮次**——功能上等价于"替人类授权了这次续跑"。也就是说：**插件没有在字面上推翻 safety gate，但在效果上绕过了它想防止的"无人授权自动复活"。** 这是本需求最根本的争议点，必须由用户显式裁定，而不是由主 agent 用"我没调用 goals.*"来规避。

### 对 Q1 的直接回答

- **是否推翻刻意安全闸？** 语义上：是（效果等同合成人工授权）；机制上：否（不碰 goal 状态）。这是"绕过"而不是"推翻"，但风险性质相同，必须向用户讲清并由其拍板。
- **是否存在未被发现的原生路径？** **存在，但有限**——`resumeSessionId` / 稳定 `sessionId` 的**配置式**启动恢复（`agents: []` 默认，无自动扫描器、无 launcher 自动喂入身份）+ `interruptedTurnClosers` 自修复。若目标会话可被配置为稳定身份，则**插件在结构上不需要存在**；若不可，插件填补的是一个真实空位——但应复用原生 `resume`/closers，而非自建账本。
- **grilling 式追问（必须回给用户，不能替答）**：你要自动续跑的会话，是不是"应当被固定配置、稳定身份"的那批？若是——原生配置已满足，插件应放弃。若不是（任意 web 临时会话）——那你是在要求系统对**没有人工背书**的会话自动续跑，这正是 disarm 闸禁止的事，需要你明确接受该安全取舍。

---

## Q2 "当场记账"的账本是不是把简单问题复杂化？

### 结论：是，且复杂度有很大一部分是被需求约束 G3 逼出来的——真正该被质询的是 G3 本身。

**证据（投入侧）：**
- design.md 934 行 / ~105 KB；8 个 lib 模块（含自研 `store.js`：mkdir → 临时文件 → `renameSync` 原子写、固定 `Buffer(MAX_STATE_BYTES+1)` 定长读）；自有状态文档 schema（`v/enabled/writer/tails[]` + 4 个上限常量 + 版本不匹配整份丢弃 + fail-closed 方向）；自有三值尾状态机（open/closed/none）；3 类来源判定 + 8 项启动过滤；13 个崩溃点（C-A…C-M）；独立 UI 页面 + owner-only HTTP 路由；21 项分层验证。
- 两轮设计评审均 FAIL：design-001（1 BLOCKER + 1 MAJOR + 7 MINOR，B-1 "清账写把运行中轮次记成 closed"属持续整轮的状态错误）、design-002（1 MAJOR + 6 MINOR，N-1 同一 `reconcile(true)` 被同时要求"排一次启动扫描"与"不补扫"）。
- requirement.md §8 变更记录自述：M-1 → N-1/N-4/N-5 **连续两轮在同一片区域（开关生效时机/effect 挂载）出跨节矛盾**，根因是规格从未规定语义，设计者只能自行发挥。即：规格不清 → 设计反复返工 → 规格再补，典型的复杂度自激。

**证据（收益侧 / 与"哪些会话 crash 了"的相关性）：**
- 用户脉络中的论断"每次 resume 后 agent 保持 live idle，由 factory 永久管理——账本里 open 与 crash 几乎无关"——**部分成立，但需修正**：
  - 启动检测的正确性前提是：`turn/start`（`dsh-agent-loop/lib/index.js:731`）后 `turn/end` 在 `finally` 无条件写入（`:817-826`，throw/abort/error 全都会写）。故**进程内**失败不会留下 open 尾；只有**进程本身死亡**（Host 崩溃）才会留下 open 尾。因此 open 尾确实是"进程死时该会话在跑"的信号——检测前提成立，账本不是无意义的。
  - 但 `liveIds` 过滤（A6）已处理"resume 后新进程里 live idle 的 agent 不重复续"。所以"factory 永久管理 live agent"与"账本 open 判定"并不冲突——这一条不构成对账本的有效反驳；真正的问题是下面的投入产出与原生替代。
- **投入产出不成立**：目标机器 626 个 artifact（requirement.md 自述为时点值）、崩溃为偶发事件。为一个偶发事件常驻"每次 turn 边界同步写盘"的写放大 + 一整套状态文档 + UI + 13 类失效分析，且设计**自认仍有不可覆盖的漏续点**（C-A 边界未落盘、C-L 写后崩溃、C-M 关闭期在途 turn、C-H 卸载期崩溃、C-K 安装前会话、单进程假设 H5 违反时整份覆盖），工程上明显失衡。

**更接近原生的做法（存在，主 agent 已识别但因 C1 拒绝）：**
- design.md §8 明确记录：官方 `ctx.sessionProjections` 单元路线、`ctx.storageDomain`（官方 KV：原子写、schema 校验）都更合适，但因 **C1「插件不得 import 任何 @deepseek-ai/* 包」** 被否决，只好手写 `store.js` + 自有 schema。**即复杂度的主要来源不是问题本身难，而是约束禁止使用官方服务。**
- 而 C1 的依据是"实测 profile 的 node_modules/@deepseek-ai 下不存在 dsh-session/dsh-llm"（requirement.md C1、SQ-3）。这是对**某一个 profile 的时点测量**，未必对所有目标 profile 成立。C1 是否是一条不可动摇的硬约束，是本重审列为"必须回用户裁定"的关键假设（见"核对过但未成 finding"）。

**直接回答 Q2：** 账本是对 G3 的合理工程响应，但 G3 本身是被 v0.1.0 的糟糕做法"过度纠正"出来的——它把"禁止全量解压/遍历"升级成了"禁止任何事后推导 + 常数上界读取"，从而排除了 DSH 原生的、代价很小的启动恢复路径。**应质询的是 G3 的边界，而不是继续在 G3 内把账本做精致。**

---

## Q3 反复出现的同一错误模式：插件职责被系统性高估

### 结论：模式属实（把 DSH 职责揽进插件），但委托方给出的三条"越界自认"中有一条经核对**不成立**，必须纠正后再谈根因。

**逐条核查委托方三条证据：**

| # | 委托方叙述 | 权威源码核对结果 | 判定 |
|---|---|---|---|
| a | 补 closers 是 DSH resume 内部行为，插件不该碰 | `dsh-agent-loop/lib/index.js:1739-1740` 确为 resume 内部行为；design.md C6 / §16.5 已据此明确"本插件不做日志修补" | **成立**（且 R2 已纠正） |
| b | 插件只该调 `agents.resume` + `followup` | `dsh-agent/README.zh.md:32, 58, 61-64` 证明 `ctx.agents.resume`、`agent.followup` 是公开 API；二者正是插件应使用的接缝 | **成立** |
| c | "插件不该持有 handle、不该 dispose"——引用 `FactoryOwnership.dispose` (index.js:1214-1218) + `ctx.effect` (1341) | **不成立，属误读。** 权威文档明确 `AgentHandle.dispose()` 是"唯一能拆除该 agent 的对象"且给出 `await handle.dispose()` 示例（`dsh-agent/README.zh.md:32, 40`）；所有权不变式（`:134`）定义 handle disposer 为"能力"、工厂提供方为"结构化共同拥有者"；真实插件 dsh-acp（`lib/index.js:640, 926`）、dsh-subagent（`lib/index.js:1815-1839, 2039`）都持有并 dispose handle。工厂的 effect 只是**结构性兜底**：`index.js:1340-1341` `ctx.effect(() => () => ownership.dispose())` + `:1214-1218` dispose 编排；`:1519` `ownership.track(dispose)`、`:1701/:1773` `trackWrapper` 使工厂无条件兜底拆除。二者收敛到同一个 memoized teardown（`:1475, 1512-1518`），**共存而非互斥** | **委托方结论错误**——主 agent 当初"承认越界"是一次**错误的认错**，不属于真正的高估证据 |

**根因判断（在纠正 c 之后依然成立）：** 插件职责确被系统性高估，证据是设计本身的结构而非那三条自认：
- 一个"启动续跑"功能内含：自研持久化层（`store.js`）、自有 schema/版本/上限/去重、三值状态机、13 类崩溃分类、开关的 active/computeActive/doc.enabled/loadKind 布尔矩阵、自有 HTTP 路由、整页 UI。
- 两轮评审的全部 BLOCKER/MAJOR 都落在**自制状态与开关结构**内部（B-1 合成 closed、M-1 active 一处计算多处语义、N-1 reconcile 双重语义），没有一条落在"调用 DSH 原生 API 是否正确"上。这说明复杂度是插件自己制造的，而非问题域固有。
- 设计在 §8/§9 反复为"偏离官方 projection / storage-domain"辩护，本质是**先接受 C1，再用自制机制填补 C1 挖出的坑**。
- 故更准确的根因表述是：**"插件该做的事被高估"是被"禁止使用官方服务的约束 + 对 v0.1.0 的过度纠错 + 规格缺位"共同放大的结果**，而不是主 agent 单纯不懂边界。把锅全记在"越界"上，会掩盖 C1/G3 这两个真正需要用户裁定的上游问题。

---

## Q4 结论：继续、缩小、还是放弃？

### 判定：**当前形态放弃（R2 不得作为继续推进的基线）；需求按"缩小到原生配置"重做；仅在用户明确拒绝原生路径后，才讨论最小插件。**

**推荐路径（满足用户原话"崩溃后下次启动自动续跑"且无需插件）：**
把需要自动续跑的会话声明为**稳定身份的声明式 agent**（`sessionId` 或 `resumeSessionId`，`dsh-agent-loop/README.zh.md:52-53, 218`）。DSH 启动时经 `index.js:1347-1378`/`1410-1427`/`resumeWith` 自动恢复，并在 `index.js:1739-1740` 自动修补崩溃尾、注入结果不可知提示（README.zh.md:198-202）。这直接满足"下次启动自动续跑"，且完全不触碰 goal disarm 闸、不自建账本、不写 UI、零自研持久化。**前提**是这些会话的身份可被固定；若不能，需用户说明为什么不能（此时原生路径不足，转入下面的最小插件形态）。注意：此路径要求用户/维护者自行在 profile 配置中列出这些 agent 行——DSH 不会自动发现任意崩溃会话。

**若（且仅若）用户裁定必须覆盖任意非配置会话、且接受合成人工授权的安全取舍：最小形态应是这样的（非设计文档，仅机制描述）：**
> 一个启动期一次性钩子：进程启动时，用 DSH 原生持久化 API 做一次**有界的**尾状态判定（例如复用 `turnBoundaryOf(session)` / 读取会话日志尾部几个事件，判断是否 `turn/start` 后无 `turn/end`，绝不整包解压、绝不按 mtime 猜），找出 open 尾会话；对每个候选调用 `ctx.agents.resume({resumeSessionId})`（让 DSH 自己补 closers 与不可知结果），随后一次 `handle.agent.followup(...)` 注入续跑指令。总开关只控制这一次扫描是否发生；不自建跨重启账本、不自研原子写存储、不做独立 UI 页面（若必须可视化，仅一个开关控件）。
>
> 这个形态成立的前提是**放宽 G3**：允许一次有界的原生尾读取。G3 不放宽，则无账本就无法跨重启记住"谁崩了"，最小形态在结构上不可能——这一点必须由用户选择，不能由设计者假装两者兼容。

**放弃/缩小的可替代方案汇总：** ①原生配置 resume（首选，零插件）；②放宽 G3 后的极小启动钩子；③若用户拒绝放宽 G3 又拒绝原生配置——**无可行方案，停止投入**（与 requirement.md H3 推翻条件一致的结论）。

---

## 对"整个设计方向是否正确"的一句话判定

**不正确：DSH 原生只提供"配置式启动 resume + 崩溃尾自修复"构件而无自动扫描器，但现行设计没有复用这些构件，反而用自建账本 + 自研持久化 + UI 重建机制，再被过度纠正的 G3 与禁用的官方服务约束把复杂度锁死，导致 934 行设计与连续两轮同区域返工仍未落地——应停止现行设计并把"目标会话能否固定配置 / 是否放宽 G3 / 是否接受合成人工授权"三个决策升级给用户。**

---

## 核对过但未成 finding 的关键假设清单

以下均经主动查证或显式识别，但因证据不足或属用户职权，未升级为 finding：

1. **目标会话的身份属性（最关键未知）**：未验证用户要续跑的会话是否可被固定为声明式 agent 的稳定 `sessionId/resumeSessionId`。若可，则插件根本不需要；若不可，需用户说明原因。这决定 Q4 走哪条路，属用户职权，不下结论。
2. **C1 的适用范围**：C1 来自"某 profile 的 node_modules 实测不存在 dsh-session/dsh-llm"（requirement.md C1/SQ-3），是对单一 profile 的时点观测。未验证目标 profile 是否同样缺失；若官方 `sessionProjections`/`storageDomain` 可用，design.md §8 自认其优于自制方案。假设按 C1 成立记录，但建议核实。
3. **"崩溃是偶发事件"**：来自委托方叙述，未在本机测量崩溃频率；投入产出结论对该假设敏感。崩溃若高频，账本价值上升。
4. **followup 的来源背书**：未验证插件 `followup` 注入的消息 `source.kind` 是否为 `{kind:'user'}`。这关系到它功能上是否等价于"人工授权"（Q1）。`dsh-tool-goal/README.zh.md:72` 说 followup/steer 默认 `{kind:'user'}`；design.md 未给出该字段的确定值。标注为未验证。
5. **`turn/end` finally 保证的边界**：`index.js:817-826` 已证明进程内 throw/abort/error 都会写 `turn/end`，故 open 尾≈进程死亡。但 SIGKILL 恰落在 `append` 与持久化 flush 之间是否可能产生半写/丢事件，未验证（涉及存储后端原子性）；账本 C-A/C-L 漏续点已部分覆盖此风险。
6. **委托方"不会同时跑多个 Host"（H5）**：作为用户裁定接受，未质疑；仅记录其为账本失效模式的前提。
7. **v0.1.0 的正面资产**（单一判定函数、50 条断言、4 变异转红）：requirement.md §9 记载，但未作为本次"是否继续"的加分项——它们证明的是旧实现质量，不证明需求应由插件满足。
8. **subagent 结论的独立复核**：本次四路事实发现的子智能体报告，凡进入 finding 的断言（disarm 原文、resumeSessionId 启动路径、FactoryOwnership/handle 双所有权、turn/end finally）均已由本评审者用 read/grep 对权威源码逐条第一手复核；未复核的子智能体叙述未采纳为结论。

---

*评审者：独立架构评审 subagent。仅写本文件；未修改其它文件、未安装、未提交 git、未运行被审查代码。*
