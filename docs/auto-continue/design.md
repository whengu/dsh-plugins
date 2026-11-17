# design — dsh-auto-continue v0.2

状态：**返工稿 R2（待重新评审）**（本文件是设计，不是代码；判定与接口以本文件为准，实现服从本文件与 `requirement.md`）
日期：2026-11-16
上游规格：[requirement.md](requirement.md)（唯一需求来源；本文件不修改它）
本稿依据的规格基线：`SHA-256 0E21745A7585B2432E4EDB89816FADB332C3FCFBECA6C0D27D15D3B7D3E4DCA3`（11003 B / 91 行，含 §6.5 裁定表）
前稿：`B629F72F7A70A0BB11278B4341F0F46905E6408AD942524A0432465804D75713`（评审 `reviews/design-001.md` 判定 FAIL：1 BLOCKER / 1 MAJOR / 7 MINOR）
取代：`dsh-auto-continue` 0.1.0 的隐式设计（含其"启动时遍历 artifact + 全量解压日志"的判定方式）

> 阅读顺序建议：§0（本轮返工了什么）→ §1 → §2 → §3（模块与接口）→ §4（状态文档）→ §5（判定规则与时序）→ §9（G3 备选与取舍，核心论证）→ §10–§12（逐条对照）→ §13（对外接口与零动作保证）→ §17（§6.5 裁定落实）→ §18–§20（自检、声明、风险）。

---

## 0. 返工记录（design-001 → R2）

### 0.1 逐条修复说明

| Finding | 判定 | 怎么改的 | 锚点 |
|---|---|---|---|
| **B-1** BLOCKER：`followup` 之后清账会把**正在运行**的续跑轮记成 `closed` | **接受**（并已独立复核其同步链，§18.1 M21–M23） | **删除整条"合成收尾"支路**：删 `ledger.noteResumeClosed`、删 `withTurnEnd` 的 `by` 参数与 `by:'resumed'` 字段、删 `StateView.tails[].by`。索引只由**被观察到的**边界驱动：`followup` 会同步开出新一轮的 `turn/start`（M23），该事件被写入侧记录为 `open`，此后只等真正的 `turn/end`。`followup` 抛错时不产生 `turn/start`，条目自然留在 `open`，下次启动重试（正是想要的语义） | §5.3（新增"续跑时序"）、§3.2、§3.4、§4、§7 |
| **M-1** MAJOR：§13.3 称 `active`"只算一次、没有第二个地方重算"与运行期切换矛盾 | **接受** | 拆成两件事：`computeActive(config, doc)` 是**单一判据函数**（公式只写一处），`active` 是**运行期布尔**，只允许在两个时机赋值（`apply`；`setEnabled` **落盘成功之后**），其余分支只读；并引入**唯一的挂载函数** `reconcile(active)` 承担"挂/卸订阅与定时器"，使 G1 的结构保证变成"effect 实例的存在性由 `reconcile` 唯一决定"，不再依赖"谓词是常量"这一错误前提 | §13.3、§3.6、§6.3、§14 |
| m-1：§17/§19 把已裁定的规格疑问当未决 | 接受 | §17 由"需用户裁定"改为"**§6.5 裁定的落实**"（SQ-1…SQ-5 逐条写本设计对应实现）；§19 删掉"若用户真实意图是那样则本设计作废"的条件句（该推翻条件写在规格 §6 H3 内，属规格自身条款，不由设计重述） | §17、§19 |
| m-2：`purgeOwn` / `withoutOwnEntries(doc, pid)` 在无逐条 pid 的 schema 下不可实现 | 接受 | **条目增加 `pid` 字段**（每条 6–10 B，`MAX_STATE_BYTES` 内），`withoutOwnEntries(doc, pid)` 因此可实现；`writer` 保留为诊断信息并在字段表里明确"不参与归属判定"；R-3 的"已按 pid 限定"由此成立 | §4、§3.2、§20 R-3 |
| m-3："`tailTurnState` 沿用 0.1.0 语义"不实 | 接受 | 明写：**名字沿用，值域与入参形态按规格改**——入参 = 事件类型数组；第三值由 0.1.0 的 `'empty'` 改为 `'none'`（规格 A5 措辞）；若调用方手里是真实事件，`events.map(e => e.type)` 后折叠，结果相同。A5 的样本与这条定义对齐 | §3.1、§11 A5、§18.1 M24 |
| m-4：§11 A3 行自相矛盾（`boot.js` 既禁又允许 `agents.resume`） | 接受 | 拆成两条断言：**(a)** `detect.js`/`state.js`/`store.js` 不出现 `agents.resume`；**(b)** `boot.js` 里的 `agents.resume` 必须位于 `mode === 'active'` 分支内（结构断言） | §11 A3 |
| m-5：`parseState` 的"顺序"未定义，与 A8 脏输入互斥 | 接受 | 明确分层：`parseState` **不校验 id 唯一性、不校验顺序**，只做逐字段类型/边界校验 + 按 `at` 升序**归一化排序**（重复条目保留）；去重只由 `planBoot`（按 id 保留最新）+ 执行侧 `attempted` Set 负责。A8 用**手工构造的 doc** 直接喂 `planBoot`，不再经过 `parseState` | §3.2、§5.2、§11 A8 |
| m-6：状态文件损坏时开关静默 fail-open 到 `true` | 接受（**改为 fail-closed**） | 把"文件**不存在**"与"文件**存在但不可用**"分开：不存在 = 首次运行，按配置默认起（`true`）；存在但 `oversized`/解析失败/版本不符 = **`enabled` 视为 `false`（fail-closed）**，插件停在非活跃、**不覆盖**该文件（留给取证），UI 显示 `stateFile:'corrupt'` 并提供显式"重新启用"动作（写一份新文档） | §4、§13.1、§20 R-11 |
| m-7：§7 漏两类漏续点 | 接受 | 补 **C-L**（边界写失败后立刻崩溃）与 **C-M**（关→开窗口内已在跑的轮次）两行（原 C-J 顺延为 C-K）；并把"逐点列清楚"降级为"**已知中断点枚举（非穷尽）**"，不再宣称完整性 | §7 |

### 0.2 根因（只改字面不算）

两个缺陷的**同一根因**：**把"推断出来的状态"当成"结构保证"写进设计，且在写之前没有把 DSH 的同步调用链核到底**。

- B-1 的具体形态：我把 `followup` 当成"投递一条消息、异步由驱动处理"，因而认为"我们刚续跑过"可以作为一个**合成事实**写回索引。核对后事实相反：`followup` → `send` → `wakeDriver` → `withInitiator` → `kick` → `turn()` 全链在 `followup()` 返回前同步走到 `session.append("turn/start")`，而 `append` → `commit` 同步派发 `session/event`。也就是说**真事实当场就有了**，我那条合成支路不但多余，而且会把真事实覆盖成假的。
- M-1 的具体形态：我把"启动扫描只跑一次"这一**流程事实**，误写成"谓词只求值一次"这一**结构保证**，并据此宣称 G1 由结构保证；实际 G1 需要的是"effect 的存在性由唯一挂载函数决定"，与谓词求值次数无关。

两类错误同源：**用"我认为它应该这样"替代"我去把那条链读到底"**。§18.3 里"是否有未验证的推断被当成事实：无"这句话本身也是同一种错误的产物（它断言了一个没有实际检验过的性质）。

### 0.3 同类位置排查（同一根因在本设计别处）

| # | 位置 | 同根因表现 | 处置 |
|---|---|---|---|
| 1 | 旧 §4 `by:'resumed'` / `noteResumeClosed` | 合成状态 | 已删除（B-1） |
| 2 | 旧 §13.3 "`active` 只算一次" | 把流程事实伪装成结构保证 | 已改为 `computeActive` + `reconcile`（M-1） |
| 3 | 旧 §4 `writer` 被当作归属依据、R-3 称"已按 pid 限定" | 声称了 schema 不具备的能力 | 条目加 `pid`，`writer` 降级为诊断（m-2） |
| 4 | 旧 §7 "逐点列清楚" | 未验证的完整性断言 | 降级为"已知枚举（非穷尽）"；补 C-L / C-M 两行、旧 C-J 顺延为 C-K（m-7） |
| 5 | 旧 §3.1 "沿用 0.1.0 语义" | 未验证的连续性断言 | 明写值域/入参变更（m-3） |
| 6 | 旧 §11 A3 在同一句里"禁止 + 豁免" | 断言的作用域没有拆开 | 拆 (a)/(b) 两条（m-4） |
| 7 | 旧 §11 A8 与 §3.2 `parseState` 互斥 | 两条设计陈述不可同时成立 | 分层：格式层不校验唯一性（m-5） |
| 8 | 旧 §18.3 "未验证推断：无" | 用结论替代检验 | 改写为逐项可复核条目（§18.3） |
| 9 | 旧 §4/§20 开关损坏即 `true` | 靠副作用决定安全方向 | 显式 fail-closed + UI 出口（m-6） |
| 10 | 旧 §17/§19 重提已裁定疑问 | 引用过期事实（规格已更新） | 改为裁定落实表（m-1） |

### 0.4 本轮新增的自检项

见 §18.1 的 **M21–M25**（①`Session.append`/`commit` 同步派发；②`followup`→`wakeDriver`→`withInitiator` 同步；③`turn()` 在首个 await 前 append `turn/start`；④`tailTurnState` 值域/入参变更；⑤`ResumeAgentOptions.signal` 可用于取消在飞 resume）与 §18.3 的 8 条新检查项（第 6–14 项：合成状态、谓词求值、能力声明、完整性声明、同步链核对、续跑轮自崩、开关安全方向），以及 §21 的 4 条新断言（第 14/15/16/19 项：B-1 回归、重入、`disabled-mid-scan`、崩溃协议模拟）。

---

## 1. 目标与手段

### 1.1 一句话

**把"末尾 turn 是否开放"这个判定，从"启动时读取日志重新推导"改成"事件发生时就地记账"**，启动时只读自己写下的那一份有界索引。

### 1.2 这不是"优化过的扫描"

要求文件 §2 的 G3 明确写了这是认识论要求，不是性能参数。区别是本质的：

| | 0.1.0（被否决） | v0.2（本设计） |
|---|---|---|
| 事实何时可得 | 崩溃**之后**、启动时 | turn 边界提交的**那一刻** |
| 获取方式 | 枚举会话存储 → 排序 → 逐个解压全量日志 | 订阅会话事件流 → 折叠一个布尔 → 落盘一行 |
| 依赖会话数 | 是（遍历全部 artifact；本机两次测量得到 625 与 626 两个数，说明连"总数"本身都不是稳定事实） | 否 |
| 依赖日志体积 | 是（最近 3 个各自整包解压，最大 19.8 MB） | 否 |
| 本机最新的 19.8 MB artifact（requirement §1 实测值） | 可能被解压 | 永远不会被本插件读取 |
| 启动外部读取 | N 次 `stat` + K 次整包解压 + K 次事件解析 | **1 次**固定路径、固定上限的自有状态读取 |

### 1.3 "在跑"这个事实为什么可以当场记下来

DSH 的会话日志有一条**提交后的事件流**：

- `session/event`（`@deepseek-ai/dsh-session` 的 `Events` 声明）：**post-commit、fire-and-forget 的 append feed**，参数是 `(session, event)`，事件"恰好如记录所示"；监听者失败被隔离，不会让已提交的 append 失败。
- `turn/start` 与 `turn/end` 是 `SessionEventMap` 的成员（`known-event-types` 里也有），且 `stepTail` 的折叠前提（两者交替）由 agent loop 保证：`turn()` 先 append `turn/start`，`finally` 无条件 append `turn/end`（含 abort/error 路径）。
- 崩溃痕迹天生是"没有 `turn/end`"：持久化层不修补崩溃尾巴（C6），`agents.resume` 自己在 `interruptedTurnClosers` 里补收尾。

结论：**turn 是否开放 = 最后一次 turn 边界是 start 还是 end**。这个布尔在边界提交时就能确定，不需要日志全文。

### 1.4 手段（三段式）

1. **写入侧（全程在跑）**：订阅 `session/event`，只关心 `turn/start` / `turn/end` 两种 `type`，把该会话的尾巴状态折叠进内存索引，并**同步**写入一份有界的自有状态文档（§4）。成本：一个 turn 生命周期两次小写入。
2. **读入侧（启动一次）**：读**一份**固定路径、固定上限的状态文档（1 次 `read`，字节上限是代码常量，读取实现用定长 buffer）。不碰 `sessionPersistence`，不枚举会话，不碰任何会话日志。
3. **动作侧（仅对候选）**：对索引里 `state === 'open'` 且通过配置/存活/上限过滤的会话，调用 `ctx.agents.resume({ resumeSessionId })` ——**resume 自己回放日志属于豁免范围**（G3 明文），随后 `agent.followup(续跑指令)`。

---

## 2. 术语与不变式

**术语**（沿用 `codebase-design` 的词汇）：

- **模块**：有接口与实现的东西。本设计的模块见 §3。
- **接口**：调用者必须知道的一切（签名、不变量、顺序约束、错误模式、性能特征）。
- **seam（接缝）**：可以在不修改该处的情况下改变行为的位置。本设计有两个真实接缝：**文件系统**（`lib/store.js`，测试用临时目录或内存 fs）与 **宿主服务面**（`ctx.agents` / 事件流，测试用 stub ctx）。第三个"假接缝"（storage domain vs 自有文件）在 §9 里被否决。

**本设计必须成立的不变式**（实现与测试都要围绕它们）：

- **I1（只记事实，不记推导）**：索引里的每个状态都**必须来自一条被观察到的边界事件**；由插件自己**推导或合成**的状态（例如"我刚续跑过，所以它应该算结束了"）一律不许写进索引。状态文档只包含"边界发生在谁身上、什么时候、seq 多少、哪个进程记的"，不含任何扫描结果、日志内容、模型数据。
- **I2（索引有界）**：状态文档的 JSON 文本长度 ≤ `MAX_STATE_BYTES`（32768），条目数 ≤ `MAX_ENTRIES`（40），单个 id ≤ `MAX_ID_CHARS`（128）。启动读取最多读 `MAX_STATE_BYTES + 1` 字节，超过即判为损坏。
- **I3（无维护即不信任）**：索引只在插件**活跃**期间被维护。停用（UI 关 / 插件卸载）时，**本进程写入的条目**（按条目自身的 `pid` 判定，见 §4）被移除；启动时若两门中任一为假，则不消费任何条目、也不续跑。由此得到关键性质：**启动时能读到的 `open` 条目，只可能来自"没有走停用路径"的那个进程**（即崩溃/被杀的进程），而不是来自一个正常收尾后又留下脏条目的进程。
- **I4（判定唯一）**：尾巴状态只由 `lib/detect.js` 的单一折叠函数决定（`stepTail` / `tailTurnState`），写入侧与读入侧共用它，不存在第二套判据；**也不存在"不经事件就写状态"的第二条写路径**。
- **I5（动作只在候选上）**：`agents.resume` / `followup` 只出现在 `lib/boot.js` 的"活跃分支"里（§13.3 用结构而非纪律保证）。
- **I6（不承诺精确续跑）**：`DEFAULT_PROMPT` 原样保留 0.1.0 的语义（结果不可知 + 不要盲目重试有副作用的操作），这是 A7 的判定文本。
- **I7（谓词不是常量）**：`active` 是**运行期布尔**，允许在运行期改变；"G1 的结构保证"由 `reconcile(active)` 是**唯一挂载点**承担，而不是由"谓词只求值一次"承担（评审 M-1 的根因）。

---

## 3. 模块划分与接口

七个文件。纯逻辑与宿主分离（保留 0.1.0 的正面资产）；所有 `@deepseek-ai/*` 一律不 import（C1）。

```
dsh-auto-continue/
├── lib/index.js      插件本体：apply / 运行时状态 / 事件订阅 / 启动编排
├── lib/detect.js     纯判定：单一折叠函数、配置解析、候选编排（planBoot）
├── lib/state.js      纯格式：状态文档 schema、上界常量、纯变更函数
├── lib/store.js      唯一 fs 接缝：路径解析、定长读、原子写
├── lib/ledger.js     有状态组合：把 state + store 组成"索引"，供写入侧与启动侧共用
├── lib/boot.js       启动编排：把 ledger 快照 → plan → resume/followup → 汇总
├── lib/route.js      owner-only HTTP 路由：UI 读写同一份状态
└── lib/client.js     浏览器半边（lazy-CJS，自带控件）
```

### 3.1 `lib/detect.js` — 纯判定（0.1.0 的 `detect.js` 演进，不新增第二判据）

| 导出 | 语义 |
|---|---|
| `TAIL` | `{ OPEN:'open', CLOSED:'closed', NONE:'none' }`，三种尾巴状态的字面量 |
| `stepTail(state, eventType)` | **唯一判定函数**：给一个事件类型，返回折叠后的状态。只识别 `turn/start`→`open`、`turn/end`→`closed`；其余类型与未知类型返回入参状态（引用不变，等价于"无影响"）。未知状态入参返回原值。 |
| `tailTurnState(eventTypes)` | `stepTail` 的批量形式（A5 固定样本入口）。**名字沿用 0.1.0，值域与入参形态按规格改**：入参是**事件类型数组**（不是事件对象数组；若调用方手里是真实事件，`events.map(e => e.type)` 后结果相同），第三值由 0.1.0 的 `'empty'` 改为 `'none'`（规格 A5 措辞为"无轮次"）。空数组 → `'none'`。 |
| `DEFAULT_PROMPT` | 0.1.0 的续跑指令原文（A7 的可判定子串来源） |
| `DEFAULT_CONFIG` / `resolveConfig(raw)` | 配置解析与回落（沿用 0.1.0 的"非法字段回落 + 一条 warn"纪律），字段见 §15.2 |
| `isSelected(id, config)` | 白/黑名单（黑名单优先，白名单空=全选） |
| `planBoot({ doc, config, liveIds, now })` | **纯候选编排**：输入是状态文档快照 + 配置 + live id 集合 + 时间；输出 `{ mode, resume, skipped }`。不含任何 I/O，不做任何 resume。规则见 §5.2。 |

接口不变量：全部为纯函数；`planBoot` 不读时间以外的环境，`now` 由调用方注入。

### 3.2 `lib/state.js` — 状态文档格式（纯）

| 导出 | 语义 |
|---|---|
| `STATE_FORMAT_VERSION` = `1` | 文档版本；解析时严格相等，否则整份丢弃 |
| `MAX_STATE_BYTES` = `32768`、`MAX_ENTRIES` = `40`、`MAX_CLOSED_ENTRIES` = `32`、`MAX_ID_CHARS` = `128` | **A4 的常量上界**，测试直接断言这些常量被读取路径引用 |
| `emptyState(now)` | 返回空文档（`enabled:true`、`tails:[]`、无 `writer`） |
| `parseState(text)` | 严格解析 + 校验（版本严格相等、逐字段类型、条目上限、id 长度、`at` 有限整数、`state ∈ {open,closed,none}`、`pid` 为正整数）。**不校验 id 唯一性、不校验顺序**（评审 m-5：格式层不做语义去重）；解析成功后按 `at` **升序归一化排列**，重复 id 的条目**原样保留**。任一字段不满足返回 `undefined`（**整份丢弃**，不猜测、不修补） |
| `serializeState(doc)` | 确定性序列化（键序固定、条目按 `at` 升序），便于测试与人工 diff |
| `withTurnStart(doc, {id, seq, at, origin, pid})` | 记录/刷新一个会话的 `open` 条目（同 id 去重、移到末尾，`pid` 写当前进程） |
| `withTurnEnd(doc, {id, seq, at, pid})` | 同一会话翻为 `closed`（保留条目供 G2 解释；不删除）。**只有被观察到的 `turn/end` 能调用它**——不存在"合成收尾"（评审 B-1） |
| `withEnabled(doc, enabled)` | 切总开关 |
| `withClaim(doc, {pid, at})` | 记录当前维护者（诊断用） |
| `withoutOwnEntries(doc, pid)` / `withoutAnyEntries(doc)` | 移除 `pid === 本进程` 的条目 / 全部条目（I3 的落地手段；逐条带 `pid` 才可实现，评审 m-2） |
| `tailOf(doc, id)` | 查单个会话条目 |

**纯变更函数的引用纪律**：任一 `with*` 在没有实际变化时**返回入参文档本身**（同一引用）。调用方据此决定"不写"——这样关态/无边界事件时既不会写文件，也不会产生内存垃圾（与投影单元的 `Object.is` 闸门同一思路）。

**条目裁剪策略（关键）**：`open` 条目**不按 LRU 淘汰**（它们是候选，淘汰即漏续）；只有 `closed` 条目按最近 32 条保留；总数超 `MAX_ENTRIES` 时，最先淘汰**最旧的 `closed`**；若 `open` 条目本身超过 `MAX_ENTRIES`（现实不可能：同时开着的顶层会话通常 1–3 个），则丢弃最旧的 `open` 并**打一条 warn**——这是唯一有损路径，且被测试覆盖。

### 3.3 `lib/store.js` — 唯一 fs 接缝

| 导出 | 语义 |
|---|---|
| `resolveStatePath(env, homedir)` | `DSH_HOME`（非空白）优先，否则 `homedir()/.dsh`；再拼 `auto-continue/state.json`。与 DSH 自己的 `resolveDshHome` 规则一致（"空/空白 `DSH_HOME` 视为未设置"），**不写死任何本机路径**（INSTALL §16.7） |
| `readState(path, fsLike)` | 用 `openSync` + 定长 `Buffer(MAX_STATE_BYTES + 1)` + `readSync`：返回 `{kind:'missing'|'ok'|'oversized'|'io-error', text?}`。**最多读 MAX_STATE_BYTES+1 字节**，超出即 `oversized` |
| `writeState(path, text, fsLike)` | `mkdirSync(dir,{recursive:true})` → 写 `<path>.tmp-<pid>-<n>` → `renameSync` 覆盖。**没有 fsync**：本插件的失效模型是进程死亡（页缓存随进程消亡而保留），电源丢失不在承诺内（§20 R-6） |

`fsLike` 是接缝参数（默认 `node:fs`），测试用计数 fs 断言"1 次读、≤1 次写"。

### 3.4 `lib/ledger.js` — 索引（state + store 的组合）

```js
openLedger({ store, path, fs, now, warn }) → {
  current()                       // 当前内存文档（只读快照）
  load()                          // 启动时调用一次：read → parse → 返回 {doc, kind, failClosed}
  claim()                         // 写入 writer{pid,at}；失败只 warn
  recordTurnStart(session, event) // 折叠 + 写（同步；一次边界一次写）
  recordTurnEnd(session, event)   // 同上；**只由观察到的 turn/end 调用**
  setEnabled(bool)                // 写开关（enabled 与"移除本进程条目"合并进同一个原子写）；返回是否落盘成功
  purgeOwn()                      // 移除本进程条目（按条目 pid，I3）；无变化则不写
  tails() / enabled() / stateKind() / loadKind() // 读视图
}
```

不变量：①内存文档是**权威**，文件是**派生**；②`with*` 返回同一引用时**不写**（关态与无关事件零 I/O）；③任何写失败只 warn 一次（限流），内存状态继续正确，下一次成功的写自愈文件；④写是**同步**的（事件监听器里），因为只发生在边界上（每 turn 2 次），代价是一次小文件 `rename`；⑤**没有"合成收尾"入口**：`recordTurnEnd` 只能由写入侧（`session/event` 的 `turn/end` 分支）调用，`boot.js` 不得调用它（评审 B-1）。

### 3.5 `lib/boot.js` — 启动编排

```js
runBoot({ ctx, ledger, config, runtime, now }) → {
  at, mode, dryRun,
  resumed: [{ id, ok, detail? }],
  skipped: [{ id, why }],
}
```

顺序固定：

1. 若 `runtime.active() !== true` → 立刻返回 `{mode:'inactive', resumed:[], skipped:[]}`（A1）。
2. `ledger.load()`（若尚未加载；**唯一 1 次状态读取**）→ `planBoot(...)`。
3. 逐个候选（`resume` 计划）：
   a. `runtime.active()` 再查一次（运行期可能已被 UI 关掉）→ 假则 `skipped:'disabled-mid-scan'` 并**停止整个队列**；
   b. `ctx.agents.get(id)` 再查一次（防竞态）→ 活则 `skipped:'already-live'`；
   c. `await ctx.agents.resume({ resumeSessionId: id, signal: runtime.abortSignal() })` —— 结构化取消（`ResumeAgentOptions.signal` 是文档化选项）；
   d. `runtime.active()` **第三次**检查（resume 期间可能被关）→ 假则 `dispose()` 该 handle、记 `skipped:'disabled-mid-scan'`、停止队列（**不排指令**，G1）；
   e. `handle.agent.followup(continuationMessage(prompt))` —— 该调用会**同步**开出新一轮的 `turn/start`（§5.3），写入侧随即把条目刷成 `open`；
   f. **不做任何"清账"写**（B-1）：索引里这一轮的真状态由 c/e 之间的可观察边界决定。
4. 逐条把 `skipped` 原因写进汇总。**单会话失败隔离**：`resume` 抛错（含取消）只影响该会话，队列继续（取消除外，见 3d）。

`boot.js` **不导入也不调用** `lib/state.js` 的变更函数（没有合成状态），它只读 `ledger` 快照。

### 3.6 `lib/index.js` — 插件本体

导出：`name = 'auto-continue'`、`inject = ['agents', 'sessions']`、`apply(ctx, rawConfig)`，并把 `runBoot`、`computeActive`、`planBoot`、`tailTurnState` 再导出给检查脚本。

三个锚点函数（评审 M-1 的修复核心）：

```js
computeActive(config, doc)            // 纯函数：config.enabled && doc.enabled && loadKind !== 'corrupt'
reconcile(active)                    // 唯一挂载点：按 active 挂/卸 session/event 订阅、挂/卸启动 timer
setActive(next)                      // 唯一赋值点：active = next; reconcile(next)
```

`apply` 的骨架：

1. `resolveConfig` → 非法字段 warn 回落。
2. `openLedger` → `load()`（**唯一 1 次状态读取**；`missing` = 首次运行；`oversized`/坏 = fail-closed，见 §4）。
3. `active = computeActive(config, ledger.current())`（**赋值点 ①**）；`reconcile(active)`。
   - `active` 为真：`ledger.claim()`（写 `writer`）+ 挂 `session/event` 订阅 + 排一次 `setTimeout(runBoot, delayMs)`；
   - `active` 为假：`ledger.purgeOwn()`（新进程的 pid 匹配不到旧条目，正常是 no-op）；不挂订阅、不排期。
4. 路由：`ctx.inject(['connection'], (connCtx) => connCtx.connection.fetch.register(...))` —— UI 半边的可达性不阻塞核心功能（headless profile 也能续跑，只是没开关页面）。**路由不受 `active` 影响**（否则关了开关就打不开了），它只响应人的请求。
5. 卸载（`ctx.effect` 的 disposer）：`reconcile(false)`（清 timer + 卸订阅）→ `runtime.abort()`（取消在飞的 resume）→ `ledger.purgeOwn()` → `dispose()` 本插件 resume 上来的 agent。
6. 运行期切开关：路由的 `set` 分支先 `ledger.setEnabled(b)`（原子写），**落盘成功后**才 `setActive(computeActive(...))`（**赋值点 ②**）；落盘失败 → `active` 不变，返回 `persist-failed`。关闭时额外 `runtime.abort()`。`setActive(false)` 之后 `reconcile` 保证**不存在任何 effect 实例**。

### 3.7 `lib/route.js` — 对外接口（详见 §13）

`ENDPOINT = 'auto-continue'`、`ROUTE_PATH = '/api/auto-continue'`、`createRouteHandler(runtime)`。

---

## 4. 状态文档（自有状态，唯一）

路径：`$DSH_HOME/auto-continue/state.json`（`DSH_HOME` 未设则 `~/.dsh`）。

```json
{
  "v": 1,
  "enabled": true,
  "writer": { "pid": 23112, "at": 1763384000000 },
  "tails": [
    { "id": "<sessionId>", "pid": 23112, "state": "closed", "seq": 41, "at": 1763383500000 },
    { "id": "<sessionId>", "pid": 23112, "state": "open",   "seq": 57, "at": 1763383900000, "origin": "subagent" }
  ]
}
```

字段语义：

| 字段 | 含义 | 备注 |
|---|---|---|
| `v` | 文档版本 | 不等于 1 → 整份丢弃（不迁移；见 §20 R-4） |
| `enabled` | **UI 总开关**的持久值 | 与配置门禁 `config.enabled` 是**两个独立的门**（§16.3）；它在文件不可用时的处置见下表 |
| `writer` | 最后一次 `claim` 的进程 `{pid, at}` | **仅诊断**：不参与归属判定、不参与 `purgeOwn`（归属看条目自己的 `pid`） |
| `tails[].id` | 会话 id | `≤ MAX_ID_CHARS`，不合法即整份丢弃 |
| `tails[].pid` | **写入该条目的进程 pid** | `purgeOwn` 的唯一依据（评审 m-2）；每次边界写都刷成本进程 |
| `tails[].state` | `open` / `closed` / `none` | **只由被观察到的边界事件产生**（I1）；`none` 不写入，但解析器接受（前向兼容 + A5 第三样本） |
| `tails[].seq` | 触发该状态的那条边界事件的 `seq` | 诊断与去重 |
| `tails[].at` | 该边界事件的 `time`（epoch ms） | 排序与 `tailMaxAgeHours` |
| `tails[].origin` | `'subagent'`（若会话 header 的 `origin` 是 subagent） | 启动时不续（见 §5.2） |

**文件不可用时的开关方向（评审 m-6 的决策，写死在这里）**：

| 读取结果 | `enabled` 取值 | 插件行为 | UI |
|---|---|---|---|
| `missing`（首次运行） | 配置默认（`true`） | 正常活跃；首次写文档时落盘 | `stateFile:'missing'` |
| `ok` 且解析通过 | 文档里的值 | 正常 | `stateFile:'ok'` |
| `oversized` / 解析失败 / `v` 不匹配 | **强制 `false`（fail-closed）** | 停在非活跃；**不覆盖、不删除**该文件（留给取证）；不挂订阅、不排期 | `stateFile:'corrupt'` + 显式"重新启用"动作（写一份新文档并把 `enabled` 置 `true`） |
| `io-error`（权限/IO 错） | **强制 `false`（fail-closed）** | 同上 | `stateFile:'io-error'` |

理由：这是一个**会自动花 token** 的功能，安全方向是"不动作"；而"静默回 `true`"会让用户明确关掉的开关在文件损坏后失效（评审 m-6）。"重新启用"是显式的人的动作，因此不违反 G1。

**为什么不是 `ctx.storageDomain` 的一个域**：见 §9 机制 E。

---

## 5. 判定规则（唯一判据，两处使用）

### 5.1 折叠（写入侧）

```js
stepTail(state, type):
  if type === 'turn/start' → OPEN
  if type === 'turn/end'   → CLOSED
  otherwise                → state   // 同一引用，零下游工作
```

`turn/start` / `turn/end` 是否严格交替：agent loop 的 `turn()` 每轮 append 一次 `turn/start`，`finally` 无条件 append 一次 `turn/end`（abort / error / dispose 路径都在 `finally` 里），崩溃恢复的合成收尾也只补 `turn/end`。因此"最后一个边界"就是精确判据（沿用 0.1.0 的论证，不引入启发式）。

### 5.2 候选编排（读入侧，纯）

`planBoot({ doc, config, liveIds, now })`（输入里的"开关值"已经过 §4 的 fail-closed 归一化；`planBoot` 本身不再关心文件状态）：

| 条件（自上而下，先命中先定） | 结果 |
|---|---|
| `config.enabled === false` | `mode:'inactive'`，`resume: []`（配置门禁） |
| `doc.enabled === false` | `mode:'inactive'`，`resume: []`（UI 开关关闭，或文件不可用被 fail-closed） |
| 否则 | `mode:'active'` |
| 条目 `state === 'closed'` | `skipped: 'tail-closed'`（**已正常结束，不动**） |
| 条目 `state === 'none'` | `skipped: 'no-turn'`（无轮次） |
| `origin === 'subagent'` 且 `!config.includeSubagentSessions` | `skipped: 'subagent'` |
| `!isSelected(id, config)` | `skipped: 'config-excluded'` |
| `liveIds.has(id)` | `skipped: 'already-live'`（A6） |
| `now - at > config.tailMaxAgeHours * 3600_000` | `skipped: 'too-old'` |
| 通过全部过滤，但已满 `config.maxResumePerBoot` | `skipped: 'boot-limit'` |
| 通过全部过滤 | `resume.push({id, turnStartSeq, since})` |

排序：`open` 条目按 `at` 降序（最新优先）。**去重在这里，不在格式层**（评审 m-5）：同一 id 有多条 `open`（只可能来自手工编辑/损坏，正常写路径已去重）时，`planBoot` 只保留 `at` 最新的一条，其余落 `skipped:'duplicate-entry'`；执行侧再加一个本轮 `attempted` Set（A8 的第二道保险）。

**为什么"`closed` 也留条目"**：G2 要回答"为什么没动某个会话"。留 `closed` 条目让 UI 能说"它的上一轮已正常结束"，而不是只能沉默。代价是文档多几十字节（有界）。

### 5.3 续跑时序：为什么"清账"是错的，为什么不需要它

这一节是评审 B-1 的正面结论，实现时必须照它写（并在 `check.mjs` 里断言）。

**事实（§18.1 M21–M23，已独立核对）**：`handle.agent.followup(msg)` → `send(msg,'next-turn',true)` → phase 为 `idle` 时 `wakeDriver` 先 `setPhase({kind:'running'})`，再 `agents.withInitiator(this, () => this.kick())`；`withInitiator` 同步调用 operation；`kick()` 的首条语句 `while (await this.turn())` 在求值 `this.turn()` 时就同步执行到 `session.append("turn/start", { turn })`（在该函数的第一个 `await` 之前）；而 `Session.append` → `commit` **同步**派发 `session/event`。

**推论（本设计的核心时序）**：

```
boot: resume(id) ──▶ (resume 内部：open('write') → read(0) → 按需补 interrupted 收尾) ──▶ resolve
      followup(msg) ──┬─ 同步：wakeDriver → kick → turn() → append('turn/start')
                      │            └─ 同步：commit → session/event → 写入侧记录 {state:'open', seq:新}
                      └─ 返回
      （此处不做任何 ledger 写）
```

因此：

- **不需要、也不允许"合成收尾"**：真事实（新一轮的 `turn/start`）在 `followup()` 返回前就已经被写入侧记下来了。若此时再写一条 `closed`，就是把真事实覆盖成假事实，导致"续跑轮中途再崩溃 → 下次启动按 `tail-closed` 跳过"——即评审 B-1。
- `followup` **抛错**时不会产生 `turn/start`，条目保持 `open`，下次启动自然重试（我们要的语义）。
- **一个必须写清的边界分支**：上面"同步开出新一轮"成立的前提是 `wakeDriver` 时 phase 为 `idle`（`resume` 的发布体在 `runMaintenance` 的 `finally` 里把 phase 置回 `idle`，所以紧随其后的 `followup` 正常命中这一分支）。若恰好有别的输入让 phase 不是 `idle`，`wakeDriver` 只置 `wakeRequested` 并返回，**此刻不产生 `turn/start`**；但**两种分支下条目都保持 `open`**（前者被新 `turn/start` 刷新，后者保留旧值）。⇒ "`followup` 之后不做任何 ledger 写"这条规则在两种分支下都安全，这正是它优于任何"根据 followup 结果推断状态"的写法的地方。
- 续跑轮**正常结束**时，`turn/end` 被观察，条目翻 `closed`（唯一能让 `open` 变 `closed` 的路径）。
- **重入**：写入侧的回调会在 `runBoot` 内部被同步调用（栈上重入）。写入侧因此必须满足：只做一次内存更新 + 一次同步小写，不 await、不再调用 `agents.*`、不抛错（`try/catch` 包住并限流 warn）。这条是硬约束（§21 第 2 层有断言）。

**"我们续过这个会话"这一信息不进索引**：它由 `lastBoot.resumed`（进程内，G2）承担。索引只回答"这一轮的边界现在是什么"。

---

## 6. 数据流

### 6.1 运行期（持续）

```
agent loop ──append──▶ Session(日志) ──post-commit──▶ ctx 'session/event' (session, event)
                                                            │
                                             ┌──────────────┴──────────────┐
                                      event.type 不是边界             是 turn/start 或 turn/end
                                             │                             │
                                        直接 return              stepTail(doc[id].state, type)
                                        （零 I/O）                          │
                                                          state 未变 → 不写（同一引用）
                                                          state 变   → ledger 内存更新 + store.writeState(同步)
```

其他所有事件（`user/message`、`step/*`、`tool/*`、`assistant/*`……）在第一个分支就返回：**不读、不折、不写**。

### 6.2 启动（一次，常数上界）

```
apply()
  ├─ resolveConfig()
  ├─ ledger.load()            ← 1 次 readState（≤ MAX_STATE_BYTES+1 字节）
  │    missing        → 空文档，enabled=配置默认
  │    ok             → 严格 parse（失败即按下面一行处理）
  │    oversized/坏/io → fail-closed：enabled 强制 false，且**不覆盖文件**
  ├─ setActive(computeActive(config, doc))      ← 赋值点 ①
  ├─ reconcile(active)                          ← 唯一挂载点
  │    active → claim() + 订阅 session/event + setTimeout(runBoot, delayMs)
  │    否则   → purgeOwn()（新 pid 匹配不到旧条目，通常 no-op）；无订阅、无定时器
  └─ ctx.inject(['connection']) → 注册 /api/auto-continue（不受 active 影响）
                    │
            (delayMs 后) runBoot()
              ├─ active() !== true → 返回空汇总（零 resume / 零 followup）
              ├─ planBoot(doc, {config, liveIds, now})   ← 纯
              └─ 逐个候选：
                   active() 假 → skip('disabled-mid-scan') 且停止队列
                   agents.get(id) 已活 → skip('already-live')
                   await agents.resume({ resumeSessionId: id, signal: runtime.abortSignal() })
                        └─ resume 内部：open('write') → read(0) → 按需补 interrupted 收尾（豁免）
                   active() 假 → dispose(handle) + skip('disabled-mid-scan') + 停止队列（不排指令）
                   handle.agent.followup(continuationMessage(prompt))
                        └─ 同步：turn/start → session/event → 写入侧把条目刷成 open（§5.3）
                   （无任何"清账"写：B-1）
                   void handle.agent.whenIdle().then(诊断日志)
```

`liveIds` 由 `ctx.agents.get(id) !== undefined` 现算（内存查询，不读外部状态）。

### 6.3 关闭 / 卸载

```
UI 关（路由 set 分支）：
    ok = ledger.setEnabled(false)        ← 一次原子写：{enabled:false} + 移除本进程条目
    ok ? setActive(computeActive(...))   ← 赋值点 ②
         runtime.abort()                 ← 取消在飞的 resume（resume 不再占着会话）
         reconcile(false)                ← 卸订阅、清定时器
       : 返回 {ok:false, code:'persist-failed'}，active 保持不变（UI 显示失败原因）
UI 开（路由 set 分支）：
    ok = ledger.setEnabled(true) → 落盘成功 → setActive(computeActive(...)) → reconcile(true)
    （**不补扫**，§16.1；UI 明说"启动判定只在 Host 启动时"）
卸载：   disposer → runtime.abort() → reconcile(false) → purgeOwn() → dispose 本插件 resume 上来的 handles
崩溃：   上述都不发生 → 文档里留着 {state:'open'} 条目（pid=崩溃进程）→ 下次启动命中
```

---

## 7. 崩溃窗口协议（每个中断点下次启动做什么）

这是本设计里最容易出错的地方。下表是**已知中断点的枚举（非穷尽）**——评审 m-7 指出"逐点列清楚"是未经验证的完整性声明，因此这里不再宣称穷尽；实现时按这张表写断言，发现新点就补一行。

| 崩溃点 | 文档状态 | 下次启动的行为 | 语义是否正确 |
|---|---|---|---|
| C-A turn/start 已提交，本插件还没写条目（微秒级窗口：`session/event` 回调内一次同步写） | 无条目（或上一条 `closed`） | 不续 | ❌ 漏续（见 §20 R-1）。缓解：写入发生在同一 tick 的同步路径上，窗口 = 一次 `rename` 的时长 |
| C-B 已写 `open`，进程崩溃（**目标场景**） | `open` | `resume` + `followup`（followup 同步把条目刷成新一轮的 `open`，§5.3） | ✅ |
| C-C resume 内部已补 `interrupted` 收尾（append `closers`），但 `resume` 还没返回 | `open`（本插件没见过收尾，因为 seed 事件不发 `session/event`） | 再 `resume` 一次：`interruptedTurnClosers` 对平衡日志返回空 → 不补收尾；随后 `followup` 续跑指令 | ✅ 正确（上次的指令从未送达，这次补上） |
| C-D `resume` 返回、`followup` 已同步开出新一轮，续跑轮正在跑，进程崩溃 | `open`（位置是**新一轮的** `turn/start`） | 再 `resume`（不补收尾，日志平衡）+ `followup` | ✅ 正确：这正是目标场景（续跑轮又被切断 → 再续一次）。评审 B-1 修好后这一行才成立 |
| C-E 续跑轮正常结束（`turn/end` 被观察到），随后进程崩溃 | `closed` | 不续（`skipped:'tail-closed'`） | ✅（那一轮的续跑指令早已送达，会话自己走完了这一轮） |
| C-F `resume` 抛错 / 被 abort（含"UI 在扫描中途关开关"） | `open`（没有 `turn/start` 产生） | 下次启动重试 | ✅ 不丢指令；代价是这次尝试白做 |
| C-G UI 关开关的写已落，进程崩溃 | `enabled:false`，本进程条目已清 | 什么都不做 | ✅（用户明确关了；这也是 H1 的语义） |
| C-H 插件卸载（HMR / profile 变更）后进程继续跑，然后崩溃 | 本进程条目已在卸载时清掉 | 不续 | ⚠️ 漏续。**有意**：索引无人维护就不可信（I3）。代价见 §20 R-2 |
| C-I Host 正常退出（SIGINT/SIGTERM，root 被 drain） | 插件卸载路径先清账；随后 loop 给每个 turn 补 `turn/end` | 不续 | ✅ 与 0.1.0 一致（正常退出不留开放尾巴） |
| C-J 关态下进程崩溃 | 关态时没有条目 | 不续 | ✅（G1：关态不动作） |
| C-K v0.2 首次安装前就在跑的会话被打断 | 无条目（本插件从未见过它） | 不续 | ⚠️ 一次性漏续，UI 明确说明"索引只覆盖本插件活跃期间" |
| C-L **边界写失败后立刻崩溃**（评审 m-7 第 1 条）：`store.writeState` 抛错 → 内存正确、文件陈旧 → 紧接着进程死亡 | 文件里仍是上一状态（可能缺这条 `open`） | 按文件决策 → 可能不续 | ⚠️ 漏续。**可接受**：与 C-A 同类（保守方向）；缓解：写失败立即 warn 并在 UI 的 `stateFile` 上体现；不重试写（重试也救不了已死进程） |
| C-M **关→开窗口内已在跑的轮次**（评审 m-7 第 2 条）：UI 关时 `purgeOwn` 删掉了条目，此后该轮仍在跑；重新打开后不补扫；随后崩溃 | 无条目 | 不续 | ⚠️ 漏续。**有意**：关 = 完全不动作（G1），重开不补扫（§16.1）。UI 在开态处明示"打开开关不会补扫已错过的轮次" |

`C-D` / `C-F` 的取向：**宁可多送一条续跑指令，不可丢指令**。丢指令会让一个已修复的会话继续停着（用户回到电脑前看到的是"什么都没发生"），而多送一条的后果被现状 prompt 自我限制（"如果核查后发现任务其实已经完成，直接给出结论并结束本轮，不要重复执行"）。

---

## 8. 与"官方投影"路线的关系（为什么不用 `ctx.sessionProjections`）

`practices.md` 的 Performance 节建议：把日志派生的逐会话状态放进 `ctx.sessionProjections` 单元，而不是自己订阅 `session/event` 再重扫 `session.events`。本设计**有意偏离**，理由与本设计的性质直接相关（偏离记录，按仓库纪律写清原因与代价）：

1. 我们的写入侧**没有重扫**：它只折一个三值状态，没有任何 `session.events` 回放（规则与投影一致，代价更低）。
2. 投影单元的价值在"框架驱动 + 变更流 + 持久检查点"，而**持久检查点这条路在本需求下被堵死**（见 §9 机制 B：`viewCheckpoint` 跳过无 `wire` 的单元；`cachedSnapshot` 需要 `SessionHeader`，而 header 只能经 `sessionPersistence` 取，直接违反 A3）。
3. 我们的读者是**下一个进程的启动路径**，不是活会话；投影的读面（`stateOf(session)`）需要活 `Session` 对象。

代价：没有变更流（UI 靠一次请求读快照，不轮询，符合 `practices.md` 的"不要轮询"）；需要自己维护持久化（§3.2/§3.3 已把复杂度集中在两个模块里）。**如果将来 `cachedSnapshot` 支持 host-only key，本设计的 `lib/ledger.js` 可以整体换成投影单元 + 缓存，其余模块不变**——这是有意留下的替换点。

---

## 9. G3 备选机制与取舍（≥2 备选，逐个淘汰，最后给推荐）

评价维度按任务要求：**成本 / 正确性 / 失效模式 / 依赖的 DSH 内部契约**。全部结论均来自本次对 `dsh 0.2.2-rc.1` 安装树的核对（出处见 §18 自检清单）。

### 机制 A — 进程内观测 + 自有单文档写前记录（**推荐**）

- **成本**：运行期每 turn 2 次同步小写（约 200–600 B 的 `rename`）；启动 1 次定长读（≤32 KiB）。与会话数、日志体积**无关**。
- **正确性**：对"边界是否发生"是精确的（判据在事件提交那一刻得到）；失效面见 §7 的枚举——C-A / C-H / C-J / C-K / C-L / C-M 是保守方向（漏续，不误续）；C-D 是"续跑轮被再次切断"的正常路径（可能多送一条指令，被现状 prompt 自我限制）；C-F 是"这次尝试白做"（不丢指令、也不误续）。**索引里不存在"我们推断出来的状态"**（I1），所以不会出现"把开放轮次记成已关闭"这类反向错误（评审 B-1 的教训）。
- **失效模式**：状态文档损坏/超限 → 整份丢弃 → 退化为"这一轮不续"，UI 明说；写失败 → 内存仍正确，文件滞后，下一条边界自愈。
- **依赖的内部契约**（4 条，全部在公开 `.d.ts` / README 层面）：
  1. `session/event` 是 `(session, event)` 的 post-commit feed；
  2. `event.type` 取 `turn/start` / `turn/end`，`event.seq` / `event.time` 存在；
  3. `turn/start` 与 `turn/end` 交替，且 abort/error 也走 `finally` 的 `turn/end`；
  4. `agents.resume({resumeSessionId})` 自己补 `interrupted` 收尾，且**收尾不走 `session/event`**（seed 事件不发事件）。

### 机制 B — 官方投影注册表 + `ctx.sessionProjectionCache.cachedSnapshot`

设想：注册一个 host-only 投影单元（`key: 'autoContinueTail'`），让它折叠 `openTurnStartSeq`，启动时用 `cachedSnapshot(header, ['autoContinueTail'])` 零 I/O 读回。

- **成本**：几乎为零（写由投影缓存按 `writeEveryEvents: 200` / `writeIntervalMs: 5000` + `turn/end` 必写点负责）；启动 1 次同步内存读。
- **否决理由（3 条，都是硬事实）**：
  1. **读不回来**：`cachedSnapshot` → `viewCheckpoint(rows, keys)`，其实现里 `if (def.wire === void 0) continue` —— **无 `wire` 块的单元不会被 view**。为了读回自己的状态，我们必须给单元加一个 `wire`（把内部状态暴露给客户端），这是把内部机制塞进客户端投影表。
  2. **拿不到 header**：`cachedSnapshot(meta, keys)` 的第一个参数是 `SessionHeader`；而 header 的来源只有 `sessionPersistence.list/stat/open` —— **直接违反 A3**（零 `sessionPersistence` 调用）。绕法是自己把 header 字段也存起来，那就等于回到机制 A 自有文档，且多背一个"header 合成"的伪契约。
  3. **陈旧窗口双向**：投影缓存的写是 write-behind（`turn/end` 必写但 fire-and-forget、先 `sessions.flush` 再落缓存；其间按 200 事件 / 5 s 节流）。因此：崩溃发生在 turn 开始后 5 s / 200 事件以内 → 缓存仍说 `closed`（**漏续**）；崩溃发生在 `turn/end` 提交后、缓存写落盘前 → 缓存仍说 `open`（**误续**）。两个方向都有窗口，而 A5 要求"开放/已关闭"都能正确识别。
- **依赖的内部契约**：投影缓存的三必写点、节流语义、`viewCheckpoint` 的 wire-only 行为——**比机制 A 更深地依赖未承诺的实现细节**。

### 机制 C — 反向读取 artifact 尾部（找最后一个 zstd 帧，只解尾窗）

设想：不落任何状态，启动时对候选 artifact 从尾部反向扫 zstd 帧边界，只解最后一帧里的 JSONL 行。

- **成本**：与"尾窗"大小相关；窗口不够（例如最后一帧是巨量 tool result、没有边界行）必须自适应放大 → 最坏退化为扫全文。
- **否决理由**：
  1. **候选集合没有来源**：不枚举会话存储就没有"要对哪些 artifact 反向读"的名单；要有名单就得有持久索引 —— 那已经是机制 A，反向读只是它的一个可选校验器。
  2. **依赖物理编码内部契约**：JSONL 后端 README 明确"默认产物是独立 Zstandard 帧的标准拼接"，但**帧尺寸、切帧时机、页脚/索引是否存在**都属于后端私有（它自己的 `src/zstd.ts` 才拥有帧扫描）。C5 已经把"从尾部读日志"这条在本后端上否掉了。
  3. **成本不恒定**：自适应窗口让"常数上界"变成"通常小、偶尔大"，与 G3/A4 的措辞直接冲突。

### 机制 D — 纯内存索引（不落盘）

- **成本**：零 I/O。
- **否决理由**：跨重启失忆 = 功能不存在（重启后没有任何候选）。这是 H3 修订前字面读法的产物，与 G3 不可共存；规格 §6.5 已裁定修订 H3（允许机制所需的最小持久化事实），因此本机制正式出局（落实见 §17）。

### 机制 E — 自有 `ctx.storageDomain` 域（单文档 `global`）

设想：用 `ctx.storageDomain.open(defineDomain({ name:'auto_continue', version:1, layout:'single', global:{ schema, initial } }))` 存同一份文档；`DomainFacility.open` 会把域的记录加载进内存，启动读是零 I/O 的内存读。

- **成本**：与机制 A 相当（甚至更低：不需要自己写原子替换）。
- **否决理由（C1 约束下的依赖问题，不是能力问题）**：
  1. `DomainSpec.global.schema` 与 `domainTable()` 都要求 **zod** `ZodType`；`defineDomain`/`domainTable` 来自 `@deepseek-ai/dsh-storage-domain`（profile 里不可解析 → C1 禁止 import）。若手写 spec 字面量，仍需 `zod` —— 而 `zod` 在 web profile 里只是被别的包 hoist 上来（profile 的 `dependencies` 没有它），插件不应该依赖一个未声明、靠 hoist 存在的传递依赖。
  2. `storageDomain` 是后端可路由的：`open()` 依次校验 `backend-not-found` / `facet-unsupported` / `version-mismatch` / `invalid-record`（可配 `backup-and-skip`），这些错误在启动路径上会变成插件加载失败或静默降级，比"读一个自己格式的 JSON"有更多失败面。
- **结论**：**如果 C1 将来放宽到允许 `zod` + `@deepseek-ai/dsh-storage-domain`，E 是比 A 更好的存储接缝**（官方 KV、原子写、schema 校验、零自研持久化）。现行 C1 下选 A——**SQ-3 已被规格驳回（C1 不变）**，因此这不是待裁定项，而是被裁定排除的可选路径（§17）。

### 机制 F（对照项）— 0.1.0 的"枚举 + 全量解压"

作为基线列出，证明它不是"慢"而是"错"：成本随会话数与日志体积线性增长；正确性没问题；失效模式是"启动被日志体积绑架"；依赖的内部契约同样很深（`location.path`、多帧 zstd 语义、C5 的 `eventCount` 缺失）。**用户已否决，v0.2 不以任何形式保留**（包括"只枚举元数据"这种半保留）。

### 推荐

**机制 A**。理由三条，按权重：

1. 它是唯一一个**把事实的获取时点挪到事实发生处**的方案（G3 的认识论要求），其余方案都是"事后读某个缓存/尾部"。
2. 在 C1 与 A3 的联合约束下，它是唯一**不需要 `sessionPersistence` 也不需要宿主内部 helper**的方案（B 需要 header，C 需要物理格式，E 需要 zod）。
3. 失效方向可审计：所有窗口都在 §7 表里，且绝大多数是"漏续"（保守），唯一的乐观窗口（C-D）被现状 prompt 自我限制。

---

## 10. G1–G4 逐条

| 目标 | 本设计如何满足 | 锚点 |
|---|---|---|
| **G1 开关** | UI 总开关持久在状态文档 `enabled`；`config.enabled` 是部署门禁。两者经**纯函数** `computeActive(config, doc)` 合成运行期布尔 `active`；**effect（订阅 / 定时器 / 索引写）的存在性由唯一挂载点 `reconcile(active)` 决定**。关态下：不订阅事件、不排启动扫描、不 resume、不 followup；唯一活着的资源是 owner-only 路由（为了能把开关打开；它只响应人的请求，属"被调用"不属"自动行为"）。扫描中途关开关：`runBoot` 逐候选复查 `active`，并在关态时 abort 在飞的 resume、不排指令 | §13.3 结构性保证 |
| **G2 可观测** | UI 页面回答三问：①"是否启用" = 两个门 + `active` + `stateFile`；②"上次启动做了什么" = 进程内 `lastBoot` 汇总（`resumed` / `skipped` 带原因码）；③"为什么没动某个会话" = 索引里的 `closed`/`subagent`/`too-old`/`config-excluded`/`already-live`/`boot-limit`/`duplicate-entry` 逐条中文解释；另加两条诚实说明"索引只覆盖插件活跃期间"、"`tails[].state` 只反映被观察到的边界（不会被续跑动作改写）" | §13.1 `StateView` |
| **G3 不事后重推导** | 启动判定路径 = `ledger.load()`（1 次定长读）+ `planBoot`（纯内存）+ `agents.get`（内存）。**不枚举会话存储、不碰任何会话日志、不依赖会话数**。resume 的日志回放属豁免 | §3, §6.2, §9 |
| **G4 既有正确性不退化** | ①只续"末尾 turn 开放"：判据未变（`stepTail`），`closed` 明确 skip，且**索引里不存在合成状态**（评审 B-1 修复后这条才真正成立）；②live 不重复续：`planBoot` 的 `already-live` + 执行前二次 `agents.get`；③不承诺精确续跑：`DEFAULT_PROMPT` 原文保留；④一次启动内同一会话最多一次：`planBoot` 去重 + 执行侧 `attempted` Set。**回归基准是 0.1.0 源码与其检查脚本，不是线上实测**（其 HANDOFF 记录真机端到端未验证） | §5.2, §5.3, §3.5, I1/I4/I6 |

---

## 11. A1–A8 逐条

| # | 判定方法（实现时要写进 `scripts/check.mjs`） | 本设计如何保证 |
|---|---|---|
| **A1** | 构造关态（`enabled:false` 的文档，或配置门禁为假，或 `stateFile:'corrupt'` 触发的 fail-closed 三种形态各一次），跑 `apply` + `runBoot`：断言 `sessionPersistence` 零调用（用一个"任何属性读都抛"的 Proxy 注入 ctx）、`agents.resume` 零调用、`followup` 零调用、`reconcile` 未挂任何 effect（订阅注册次数 0、timer 创建次数 0）、`store.writeState` 零调用（新进程 pid 匹配不到旧条目，`purgeOwn` 是 no-op） | `runBoot` 第一句是 `if (runtime.active() !== true) return`；关态 `reconcile(false)` 不创建任何 effect。任何路径都不会到达 `resume` |
| **A2** | 用路由处理器跑两次合成请求：`{op:'set',enabled:false}` → `{op:'state'}`；断言第二次返回 `enabled:false`；再用**新的** `openLedger` 读同一路径的文件，断言仍是 `false`（写读一体 + 落盘一致）。再加一条反向断言：让 `store.writeState` 抛错 → 路由返回 `persist-failed` **且** `StateView.enabled` 仍为旧值（落盘失败不得改 `active`，评审 M-1） | `setEnabled` 一次原子写并返回布尔；`state` 读同一份内存文档 |
| **A3** | 静态两条：**(a)** `detect.js`/`state.js`/`store.js` 不出现字符串 `sessionPersistence`，也不出现 `.read(`、`read(0`、`agents.resume`；**(b)** `boot.js` 中的 `agents.resume` 必须只出现在 `mode === 'active'` 分支内（结构断言）。另加：`lib/*.js` 全部不出现字符串 `sessionPersistence`（含 `boot.js`）。运行时：A1 的 Proxy 断言零调用（开态同样跑一次，桩 `agents` 的 `resume` 不触持久化） | `inject = ['agents','sessions']`，**插件从未声明 `sessionPersistence`**；全仓源码不出现该标识符，也不 `open()` 任何 `SessionHandle` |
| **A4** | ①用计数 fs 跑启动路径，断言 `read` 次数 = 1；②同一路径喂 1 个会话与 1000 个会话两种 ctx（后者带一个"若被枚举就抛"的 stub `sessionPersistence`），断言两次读取次数、读取字节数完全相同；③喂一个 10 MB 的状态文件，断言实际读取字节 ≤ `MAX_STATE_BYTES + 1`、判为 `oversized`、并因此 **fail-closed**；④断言 `state.js` 的常量被读取路径引用（`MAX_STATE_BYTES` 出现在 `store.readState` 的实现里） | `store.readState` 用定长 buffer；`state.js` 有 `MAX_STATE_BYTES`/`MAX_ENTRIES`；不存在任何 list/stat/enumerate 调用 |
| **A5** | 三条固定样本（**入参是事件类型数组**，§3.1）：`tailTurnState(['turn/start','user/message','step/start']) === 'open'`、`tailTurnState([...同,'turn/end']) === 'closed'`、`tailTurnState([]) === 'none'`；再加 `planBoot` 对 `state:'open'/'closed'/'none'` 三种**手工构造文档**分别给出 `resume` / `skipped:'tail-closed'` / `skipped:'no-turn'`（SQ-5 的两条「无轮次」断言：空数组 + 合成 `none` 文档） | 判定只有一个函数（I4）；文档保留 `closed` 条目、解析器接受 `none`，三种状态都可判 |
| **A6** | stub `ctx.agents.get(id)` 返回一个对象（live），断言该 id 不出现于 `resume` 调用记录里，且 `skipped` 含 `already-live` | `planBoot` 的 `liveIds` + 执行前二次 `agents.get` |
| **A7** | 断言消息 `content[0].text` 同时包含"结果不可知"与"不要"+"重试"语义的可判定子串（`DEFAULT_PROMPT` 原文含"其真实结果不可知"与"不要盲目重试"），且 `role==='user'`、`source.kind==='auto-continue'`、对象已冻结 | `DEFAULT_PROMPT` 原样保留；消息构造沿用 0.1.0 的冻结对象 |
| **A8** | **对手工构造的 doc 直接调 `planBoot`**（不经 `parseState`，评审 m-5）：同一 id 两条 `open` → 只产出一个 `resume`，另一条落 `skipped:'duplicate-entry'`；再把 `maxResumePerBoot` 设为 1、doc 里 2 个不同 id 的 open → 第二条落 `skipped:'boot-limit'`；再加执行侧断言：`attempted` Set 使 `agents.resume` 对同一 id 的调用次数 ≤ 1 | `planBoot` 按 id 去重（保留 `at` 最新）+ `attempted` Set + `maxResumePerBoot` |

---

## 12. C1–C6 逐条

| 约束 | 遵守方式 | 自查 |
|---|---|---|
| **C1** 不 import 任何 `@deepseek-ai/*` | 七个文件只用 `node:crypto`（消息 id）、`node:fs`、`node:path`、`node:os`。**连 `@deepseek-ai/schemastery` 也不用**（因此不声明 `Config`，配置用自研 `resolveConfig` 校验；schemastery 虽然在本 profile 可解析，但 C1 的措辞是"不得 import 任何"）。宿主服务全部经 `ctx` 取得（`ctx.agents`、`ctx.on`、`ctx.connection` 经 `ctx.inject`） | `check.mjs` 断言 `lib/*.js` 与 `lib/client.js` 的 `from '...'`/`require` 清单 ⊆ {`node:crypto`,`node:fs`,`node:path`,`node:os`,`./detect.js`,`./state.js`,`./store.js`,`./ledger.js`,`./boot.js`,`./route.js`}（client 半边为 `react`,`react-dom`） |
| **C2** 客户端不 require Harness Client 包 | 自带 switch/按钮/标题条，只用 `--dsw-alias-*` token；`require` 面仅 `react`、`react-dom` | `check.mjs`：client 的 `require` 清单白名单（照 `dsh-ability-strip/scripts/check-bundle-contract.mjs` 的做法） |
| **C3** 客户端 lazy-CJS | `window.__ModuleLoader__.load({ id:'dsh-auto-continue', factory:(require)=>{...} })`，`factory` 内 `exports.apply`/`exports.inject`，无构建步骤 | `check.mjs`：文本断言文件以 `window.__ModuleLoader__.load({` 开头；`factory` 里没有顶层副作用 |
| **C4** 只从 tarball 安装 | 不改安装流程；`package.json` 的 `files` 白名单加 `lib/client.js`；文档只写仓库相对路径与 `$DSH_HOME` 表述 | 实现阶段 `pnpm pack` + `verify-pack`（若有）；本文件不写任何本机绝对路径 |
| **C5** JSONL 不给 `eventCount`，多帧 zstd 不能从尾部读 | **本设计完全不读 artifact**：既不需要 `eventCount`，也不需要尾部读 | A3/A4 的零调用断言即是证明 |
| **C6** 持久化不修补崩溃尾巴，resume 自己补 `interrupted` | 本插件不做任何日志修补：`resume` 之后不重读日志、不 append 收尾、不改 header。`interruptedTurnClosers` 只在 `dsh-agent-loop` 的 resume 内部被调用 | 源码里没有任何 `append(`/`open(` 到 `SessionHandle` 的调用（`check.mjs` 断言 `.append(` 不出现在 `lib/`） |

---

## 13. 对外接口：UI 如何读状态、切总开关

### 13.1 形状（宿主 ←→ 浏览器）

沿用本仓库 `dsh-ability-strip` 已验证的通道（`/api` 载体的 `client-request` 信封），因为 `dsh-api-gateway` 已占用 `/api` 的 interceptor（`connection.rpc.intercept` 对同一 channel 重复注册会抛），插件只能走**精确 Fetch 路由**：

```
POST /api/auto-continue        (methods: ['POST'], requestBody: 'buffered')

请求（客户端 connection.rpc.call('/api','auto-continue',payload) 生成，勿手拼）：
  { type:'client-request', rpcId, method:'auto-continue', payload }

payload:
  { op:'state' }                   读
  { op:'set', enabled: boolean }   写（写后返回同一份状态：A2）

响应：
  { type:'server-response', rpcId, result }
  result = { ok:true, value: StateView }
         | { ok:false, error:{ code, message, details } }

error.code ∈ 'bad-request' | 'config-disabled' | 'persist-failed' | 'internal'
```

`StateView`（`lib/route.js` 的 `stateView(runtime)`，**唯一**的 UI 数据面）：

```json
{
  "version": "0.2.0",
  "configEnabled": true,          // profile 配置门禁
  "enabled": true,                // UI 总开关（持久值；文件不可用时按 §4 归一化为 false）
  "active": true,                 // 运行期布尔：此刻是否会维护索引并续跑（不是 apply 时刻的常量）
  "dryRun": false,
  "maintained": true,             // 等价于 active：reconcile(active) 是否挂上了订阅
  "writer": { "pid": 23112, "at": 1763384000000 },
  "tails": [ { "id": "...", "pid": 23112, "state": "open", "seq": 57, "at": 1763383900000, "origin": null } ],
  "lastBoot": {                   // 进程内；重启即空（H3 的落点）
    "at": "2026-11-16T10:11:12.000Z",
    "mode": "active",
    "resumed": [ { "id": "...", "ok": true } ],
    "skipped": [ { "id": "...", "why": "already-live" } ]
  },
  "limits": { "maxStateBytes": 32768, "maxEntries": 40, "maxResumePerBoot": 3,
              "maxTailAgeHours": 24 },
  "stateFile": "ok"               // 'ok' | 'missing' | 'oversized' | 'corrupt' | 'io-error'
}
```

`tails[].state` 只反映**被观察到的**边界（I1）；没有 `by` 字段——"我们续过它"这件事只出现在 `lastBoot.resumed`（评审 B-1）。`skipped[].why` 的完整取值见 §5.2 + `'disabled-mid-scan'` + `'resume-failed'` + `'duplicate-entry'`。

`op:'set'` 的语义：**一次原子写**（`enabled` 与"移除本进程条目"在同一份文档里）；**落盘成功后**才改变运行期 `active` 并 `reconcile`（开→挂订阅；关→卸订阅 + 清 pending 启动 timer + abort 在飞的 resume）；落盘失败 → 返回 `persist-failed`，`active` 不变（评审 M-1）。配置门禁为假时返回 `config-disabled`（UI 上开关置灰并显示原因）。`stateFile` 为 `corrupt`/`io-error`/`oversized` 时开关同样置灰，但给一个显式的"重新启用"动作（§4）。

### 13.2 鉴权与所有权边界

分四层，逐层说明"谁在管"：

1. **同源/令牌栅栏 + 浏览器令牌**：载体层。`ConnectionFetchRoute.fetch` 的契约原文："Handle one request after the physical carrier has applied its trust and authentication policy." 请求必须先过 `connection.admit`（Host/Origin 信任 + 浏览器 cookie 令牌）才会被派发。
2. **owner-only**：载体层，硬编码。`createSharedFetchHandler` 在精确路由分支上有 `if (peer.principal.kind !== "owner") return new Response("forbidden", { status: 403 })`；类型注释亦写明"Only owner Peers reach an exact route; the shared handler answers 403 for every other principal"。⇒ **本插件的接口天然只有 owner 可达**，非 owner（远端/受限 Peer）连读都不允许。
3. **插件自身**：不做 principal 判断（精确路由的 `fetch(request)` 拿不到 peer，这是有意的载体分工）；因此插件一侧的纪律是：**接口里不允许出现任何"以请求内容为依据去动别人的会话"的操作**。当前两个 op 的爆炸半径是"读自己的索引 / 切自己的开关"，不含会话 id 参数 —— 这是**接口形状**上的安全，而不是靠校验。
4. **远端暴露**：若部署配置了 `trustedHosts` 允许非 loopback 权威，owner 令牌仍可来自远端；这是部署级决定（`ConnectionConfig.trustedHosts`），不属于插件职责，写进 §20 R-5 提示。

**不做的事**（明确记录下来，避免后续被"顺手加上"）：

- 不提供"手动续跑指定会话"的 op（会使接口获得以 id 为参数的写能力，爆炸半径立刻扩大；也不是需求）。
- 不提供"清空索引"的 op（幂等性由插件自己维护）。
- 不把开关做成 profile 配置写入：宿主插件改写自己的 `cordis.patch.yml` 属明确禁止；官方入口是 `configEditor.edit(entry, ...)`，而"就地生效不重启"要求字段声明 `.volatile()`，那需要 schemastery `Config`（C1 冲突）。详见 §16.3。

### 13.3 "关闭后零动作"的结构性保证（不是纪律，是形状）

**先把两件事分开**（这是评审 M-1 的根因）：

- **判据**：`computeActive(config, doc)` 是**纯函数**，公式只在这里写一次（`config.enabled && doc.enabled && loadKind ∉ {corrupt, oversized, io-error}`）。任何地方都不得再写一遍这个与运算。
- **求值时机**：`active` 是**运行期布尔**，允许在运行期改变。只允许在两个时机赋值（`apply`；`setEnabled` **落盘成功之后**），其余分支只读。

在 `active` 之上叠四道**结构**约束：

1. **唯一挂载点**：`reconcile(active)` 是**唯一**创建/销毁 effect 的地方——`session/event` 订阅、启动 `timer` 都由它按 `active` 挂/卸，且幂等。⇒ "关态下不存在任何 effect 实例"是由结构保证的，而不是由"谓词是常量"保证的（旧稿的错误）。
2. **副作用函数只被活跃段可达**：`runBoot` 第一句读 `runtime.active()`；`ledger.recordTurnStart/recordTurnEnd` 只被订阅回调调用；`agents.resume`/`followup` 只出现在 `runBoot` 的活跃段。⇒ 关态下从 `apply` 出发的可达语句集合里，**没有任何一条能到达 resume/followup/索引写**（唯一的写是 `purgeOwn`，而新进程 pid 匹配不到旧条目，是 no-op）。
3. **运行期切换不留半截**：`setEnabled` 先落盘、成功后 `setActive` + `reconcile`；关态时额外 `runtime.abort()`，`runBoot` 在每个候选前后复查 `active` 并在 resume 之后、`followup` 之前再查一次（`skipped:'disabled-mid-scan'`，**不排指令**）。落盘失败 → `active` 不变。
4. **路由不构成"自动行为"**：路由只在人发起请求时执行，且只做三类事：读内存快照、原子写开关 + `reconcile`、给"重新启用"写一份新文档。它不 resume、不写会话、不动别人的条目。

可复核的断言方式（实现阶段）：

- 静态：`check.mjs` 断言 `agents.resume` / `followup(` 只出现在 `boot.js`；断言 `ctx.on(` 与 `setTimeout(` **只出现在 `reconcile` 的函数体内**（结构断言，取代旧稿"位于 active 判定之后"的弱断言）；断言 `computeActive` 的与运算表达式只出现一次（文本断言）。
- 运行时：①关态 `apply` + `runBoot` → 订阅注册 0、timer 0、`resume` 0、`followup` 0、文件写 0；②开态 `apply` 后调用 `setEnabled(false)` → 断言订阅被卸载、timer 被清、`runtime.active() === false`；③开态扫描中途 `setEnabled(false)` → 断言后续候选全部 `skipped:'disabled-mid-scan'`、零 `followup`；④`setEnabled` 落盘失败 → 断言 `active` 仍为 `true` 且返回 `persist-failed`。

### 13.4 客户端半边（`lib/client.js`）

- 形态：lazy-CJS（C3），`exports.inject = ['slots','connection']`，`exports.apply(ctx)`。
- 页面可达性（H2 的落点，沿用 `dsh-client-ui-schedule` 的宿主级页面模式）：
  - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'auto-continue', order:90, label:()=>'自动续跑' }, Icon))` —— 侧栏入口；
  - `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'auto-continue', inject:()=>({ read, write }) }, Page))` —— 页面本体。`sidebar.panellist.id` 与 `main.key` 取值相同（schedule 的做法）。
- 控件自带（C2）：一枚 `role="switch"` `aria-checked` 的总开关 + 若干只读表格（状态、索引、上次启动、原因码解释）。样式只用 `--dsw-alias-*`；`require` 限 `react`/`react-dom`。
- 数据：`connection.rpc.call('/api','auto-continue',{op:'state'})` 在**页面挂载时**与**开关切换后**各读一次；不轮询、不开 SSE、不写 DOM 到 `document.body`（符合 `practices.md` 的"不要轮询"与"通过 slot 贡献 UI"）。
- 不做：不编辑白/黑名单（非目标）、不展示会话正文（只看 id/状态/时间）、不做自动刷新。

### 13.5 `package.json` / `cordis.patch.yml` 的形状变化（设计级，不是实现）

- `version: 0.2.0`；新增 `exports["./client"] = "./lib/client.js"`、`dsh.client.platform = "web"`；`files` 增 `lib/client.js`、`README.md`、`scripts/check.mjs`。
- `inject = ['agents','sessions']`（**移除 `sessionPersistence`**——这是 A3 的结构性保证）。
- `cordis.patch.yml` 保持 `- insert: [{ id: auto-continue, name: 'dsh-auto-continue' }]`，无配置即默认值。

---

## 14. 状态与生命周期（开关 / 卸载 / 重启）

| 事件 | 插件做什么 | 状态文档 | 用户看到什么 |
|---|---|---|---|
| Host 启动，两门都开 | 读 1 次文档 → `computeActive` → `reconcile(true)`：`claim` + 挂订阅 + 排一次启动扫描 | 首次运行写一份新文档；此后按需写 | UI：`active:true, maintained:true`；扫描后出 `lastBoot` |
| Host 启动，UI 开关关 | 读 1 次文档 → `computeActive` 假 → `reconcile(false)`；`purgeOwn`（新 pid 匹配不到，no-op） | 不写 | UI：`enabled:false`，开关可打开 |
| Host 启动，配置门禁关 | 同上，但开关置灰 | 不写 | UI：`configEnabled:false` + 原因 |
| Host 启动，状态文件不可用 | fail-closed（§4）：`active:false`；**不覆盖文件** | 不写（留给取证） | UI：`stateFile:'corrupt'/'oversized'/'io-error'` + "重新启用"动作 |
| UI 打开开关 | `setEnabled(true)` 落盘成功 → `setActive` → `reconcile(true)`；**不补扫**（§16.1） | 原子写 `enabled:true` | 开关亮；`maintained:true`；提示"不会补扫已错过的轮次" |
| UI 关闭开关 | `setEnabled(false)` 落盘成功 → `setActive(false)` → `abort()` + `reconcile(false)`：卸订阅、清 timer、丢弃本进程条目 | 同一个原子写里 `enabled:false` + 清账 | 开关灭；`maintained:false`；候选清零（提示"关闭即不再自动处理"） |
| 插件卸载（HMR / profile 变更 / `dsh plugin remove`） | `abort()`、`reconcile(false)`、`purgeOwn`、`dispose` 本插件 resume 上来的 agent | 一次清账写 | —（索引归零；下次启动不续，见 §7 C-H） |
| Host 正常退出 | 同"卸载"（root disposal 走同一条 disposer） | 同上 | — |
| Host 崩溃 / 被杀 | 什么都来不及做 | 保留 `open` 条目（`pid` = 崩溃进程） | 下次启动续跑 |
| 崩溃后重启 | 见第 1 行 | `open` 条目被消费：续跑后该轮由 `followup` 同步开出的 `turn/start` 刷成 `open`（§5.3），并在该轮真正结束时由 `turn/end` 翻成 `closed`；**不存在"resume 后写成 closed"的路径** | UI：`lastBoot.resumed / skipped` |

`lastBoot` 在每次进程启动重置（H3 的落点：**不持久化扫描历史**）；索引本身是**机制事实**，不是历史报表（规格 §6.5 的 SQ-1 裁定；落实见 §17）。

---

## 15. 与 0.1.0 的差异清单

### 15.1 差异表

| 项 | 0.1.0 | v0.2 | 为什么 |
|---|---|---|---|
| 判定来源 | 启动时遍历 artifact → mtime 取最近 N → 全量解压 + 解析 | 运行期事件折叠 → 自有索引 → 启动读 1 份文档 | G3（用户否决原做法） |
| `inject` | `['agents','sessionPersistence']` | `['agents','sessions']` | A3 的结构性保证 |
| `lib/detect.js` | `tailTurnState` / `newestEventTime` / `rankRecent` / `resolveConfig` / `isSelected` | 加 `TAIL` / `stepTail` / `planBoot`；**删 `newestEventTime`、`rankRecent`**（mtime 排序不再需要） | 判据从"事后排序"变为"当场记录" |
| 配置 `recentSessions` | 扫描窗口大小 | **删除**（由索引用"哪些会话真的开着"直接回答） | 原字段只是"哪个会话可能在跑"的代理，索引给出直接答案 |
| 配置 `maxResumePerBoot` | 无（窗口即上限） | 新增，默认 3 | 保留"只续最近的几个"的用户裁决（D3），但不依赖 mtime |
| 配置 `tailMaxAgeHours` | 无 | 新增，默认 24 | 防"状态文档被从旧备份恢复"导致的离奇续跑（§20 R-4） |
| 配置 `includeSubagentSessions` | 无 | 新增，默认 `false` | 0.1.0 会（偶然地）resume 子智能体会话；单独复活一个子会话没有语义（SQ-2 裁定：接受为设计决定，见 §17） |
| UI | 无 | 宿主级页面（`sidebar.panellist` + `main`）+ owner-only 路由 | G1 / G2 |
| 存储 | 无 | `$DSH_HOME/auto-continue/state.json`（有界、原子写） | G3 的机制载体 |
| 消息文本 / 语义（`DEFAULT_PROMPT`、`agents.resume`、冻结消息、失败隔离、卸载 dispose） | — | **逐字保留** | G4 / A7 |

### 15.2 配置面（v0.2，全部走 profile 的 `cordis.patch.yml`，不在 UI 编辑）

| 字段 | 默认 | 语义 | 与 0.1.0 |
|---|---|---|---|
| `enabled` | `true` | **部署门禁**：为假时插件不维护索引、不续跑（UI 开关置灰）；不是运行期开关 | 保留同名，语义明确为"门禁" |
| `switch` | — | **不是配置**：UI 总开关持久在状态文档的 `enabled`，首次运行按 `true` 起 | 新增概念（0.1.0 没有 UI） |
| `dryRun` | `false` | 只判定并记日志（`would continue "<id>"`），不 resume、不改条目 | 保留（观察用，0.1.0 已有） |
| `delayMs` | `5000` | 启动后等多久再判定：让其它启动组件先就位，避免抢写所有权 | 保留 |
| `maxResumePerBoot` | `3` | 一次启动最多续几个会话（其余记 `skipped:'boot-limit'`） | 取代 `recentSessions` |
| `tailMaxAgeHours` | `24` | 条目早于此龄视为过期（`skipped:'too-old'`），防旧备份恢复 | 新增 |
| `includeSubagentSessions` | `false` | 是否续子智能体会话（`origin:'subagent'`） | 新增（0.1.0 偶然会续，见 SQ-2） |
| `sessions` | `[]` | 白名单；空 = 全选 | 保留 |
| `excludeSessions` | `[]` | 黑名单，优先于白名单 | 保留 |
| `prompt` | `DEFAULT_PROMPT` | 续跑指令文本（A7 的可判定文本即默认值） | 保留 |

非法值一律回落默认 + 一条 warn（沿用 0.1.0 的纪律：启动期抛错比降级代价更大）。

### 15.3 一条被作废的"正面资产"，以及为什么这不违反"不丢弃资产"

0.1.0 的真实数据实测（626 个 artifact；<1KB 仅 4 个；故"按 mtime 取最近 N 个"这个窗口判据成立）曾是一条被反复引用的资产。**v0.2 不再使用 mtime 窗口**，因此这条实测结论连同 `rankRecent` / `newestEventTime` 一起作废。

这不是把资产扔掉，而是**资产的上游前提消失了**：那条实测回答的是"最近 N 个里面有没有垃圾（空 artifact）占位"，而 v0.2 的候选集合来自事件流，不存在"占位"问题，也不存在"哪个会话可能在跑"的排序问题。保留一个没有用处的判据比删掉它更危险——它会诱使后人把它接回去。

仍然完整保留的资产：纯逻辑与宿主分离（`detect.js`/`state.js` 仍是零 I/O 模块）、单一判定函数、两层断言结构、变异测试必须全红的纪律、以及"探针的解码器可能比被测代码更可疑"这条教训（本设计因此**完全不碰 artifact 字节**）。

---

## 16. 几个被明确否决的做法（写下来防止回归）

### 16.1 不写"补扫"

开关打开后**不**立刻扫一遍索引：①索引本来就没有"关态期间的 open"（关态不记录）；②补扫会让"启动判定只发生一次"这条语义消失，UI 无法解释"它什么时候动过手"。

### 16.2 不在 `session/event` 里做任何"顺便"的重活

监听器只有两个分支（边界 / 非边界）。不读 `session.events`（`practices.md` 明确反对），不写日志文件，不做网络调用。

### 16.3 不把总开关做成 profile 配置

- 官方规则：宿主插件**不得**读取/过滤/改写 profile 的 `cordis.patch.yml`；要改自己的配置只能用 `configEditor.edit(entry, ...)`。
- 官方规则："Editing an ordinary field restarts the plugin so `apply` rebuilds its state; a field declared `.volatile()` updates in place and is read with `config.field.get()`."
- 而 `.volatile()` 依赖 schemastery `Config` 的 `schema.meta.volatile`（loader 的 `equalExceptVolatile` / `volatileEntries`）⇒ 需要 `import z from '@deepseek-ai/schemastery'`，与 C1 的"不得 import 任何 `@deepseek-ai/*`"冲突；且即使能写，重启插件来"关开关"也是错的语义（会重新 `apply` 并重排队列）。
- 另外：开关的写必须与"清账"在**同一个原子写**里完成（§7 C-G），配置编辑做不到这一点。
⇒ 开关落在自有状态文档；`config.enabled` 保留为部署门禁（0.1.0 的字段语义不退化为"被静默忽略"）。

### 16.4 不做"补偿式校验"

不在启动时用 `sessionPersistence` 校验索引条目（例如"顺便 stat 一下确认 mtime"），哪怕只读元数据：那正是 G3 变更记录里被用户点名否决的"允许枚举但只读元数据"的半保留做法。

### 16.5 不写"合成状态"（评审 B-1 的教训，固化为规则）

索引里的 `state` 只能由 `session/event` 的两条边界分支写入。**任何"因为我做了 X，所以它现在应当是 Y"的写回都是禁止的**，包括但不限于：

- "我刚 resume 成功 → 它算结束了"（B-1 的原形）；
- "我刚关掉开关 → 所有条目算无效"（正确做法是**删除**本进程条目，而不是改写它们的 state）；
- "超时没动静 → 算它结束了"（任何基于时间/计数的推断）。

判据：**如果一条 `state` 写操作找不到它对应的那条事件（`seq` 指向某个真实提交的 `turn/start`/`turn/end`），它就不该存在**。`check.mjs` 据此断言：`state.js` 里只有两个函数能设置 `state` 字段，且 `boot.js` 不 import `state.js`。

---

## 17. 规格 §6.5 裁定的落实（不再有"未决疑问"）

规格已在 `requirement.md` §6.5 对设计者提出的 5 条疑问逐条裁定（评审 m-1：前稿把它们当成"待用户裁定"是引用了过期事实）。下表是**裁定 → 本设计的对应实现**，实现阶段按第三列核对即可：

| 裁定 | 结论 | 本设计的落实 |
|---|---|---|
| SQ-1 | H3 **已修订**：UI 的扫描/报表历史不跨重启；机制所需的最小持久化事实**允许**（一份有界自有状态文档） | §4 状态文档即该"最小事实"；`lastBoot` / `resumed` / `skipped` 全在进程内，重启即空（H3 的报表部分） |
| SQ-2 | **接受为设计决定**：子智能体会话默认不续 | `planBoot` 的 `origin === 'subagent'` → `skipped:'subagent'`；`config.includeSubagentSessions` 默认 `false`（§15.2） |
| SQ-3 | **驳回**：C1 不变，`@deepseek-ai/*` 一律不 import；不引入 `zod` 依赖 | 自研 `store.js`（§3.3）；§9 机制 E 的结论同步改为"现行 C1 下选机制 A"，不再作为待裁定项 |
| SQ-4 | **已澄清**：A3 限定"插件自身源码"；`agents.resume` 的回放不计入 | §11 A3 拆成 (a)/(b) 两条断言；`inject` 不含 `sessionPersistence` |
| SQ-5 | **已采纳**：A5 的"无轮次"拆两条断言 | §11 A5：`tailTurnState([]) === 'none'` + 合成 `none` 文档 → `skipped:'no-turn'` |

**因此本设计不再向用户提出任何规格疑问。** 规格里唯一保留的外部条件是它自己的条款（§6 H3 的推翻条件："若用户认定任何跨重启自有文件都违反其本意，则 v0.2 无可行方案"）——那是规格对用户的开放项，不是设计对规格的疑问，本文只做引用、不重述为待决。

---

## 18. 自检清单（逐项：结论 + 可复核依据）

依据形式：`<包/文件> 的 <符号>` + 原文引用（可从安装树 grep 复核；按仓库"设计文档不写行号"的纪律不记行号）。

### 18.1 机制事实（本设计的正确性基础）

| # | 结论 | 依据（可复核） |
|---|---|---|
| M1 | 存在 post-commit 的 `session/event` 事件，参数是 `(session, event)` | `@deepseek-ai/dsh-session` `lib/types/index.d.ts` 的 `Events` 声明："Post-commit, fire-and-forget append feed. The listener snapshot resolves before the log push, but callbacks run after it; observer failures are logged and contained without making the committed append fail." |
| M2 | 该事件确实被 shipped 代码这样用 | `@deepseek-ai/dsh-session-projection-cache` `lib/index.js` 的 `installWritePath()`：`this.ctx.on("session/event", (session, event) => {...})` |
| M3 | `turn/start` / `turn/end` 是已知事件类型，事件带 `seq` / `time` | `dsh-session` `lib/types/known-event-types.js` 含 `'turn/start'`、`'turn/end'`；`lib/types/types.d.ts` 的 `SessionEvent` 变体含 `seq: SessionSeq`、`time: number` |
| M4 | turn 边界严格交替，abort/error 也补 `turn/end` | `dsh-agent-loop` `lib/index.js` 的 `turn()`：先 `this.session.append("turn/start", { turn })`，`finally { this.session.append("turn/end", { turn, reason: turnEnds }) }`（abort 分类 `turnEnds = { kind:'aborted', reason: cause }` 同样走 finally） |
| M5 | 崩溃尾巴不被持久化层修补，`resume` 自己补 | `dsh-session` `lib/types/repair.d.ts` `interruptedTurnClosers`："Crash-recovery entry point: synthetic closers that balance a persisted log whose tail turn was interrupted… empty when the log is already balanced"；`dsh-agent-loop` 的 `resumeWith()`：`const closers = interruptedTurnClosers(persisted); if (closers.length > 0) await handle.append(closers)` |
| M6 | 恢复收尾**不会**出现在 `session/event` 上 | `dsh-session` `Session` 的 `firstLiveSeq` 文档："Seed events never publish on `session/event`"；且 resume 是通过 `SessionPreparation.create(... seed: [...persisted, ...closers] ...)` 把收尾塞进 seed，再 `append(closers)` 于持久化句柄 |
| M7 | `agents.resume({ resumeSessionId })` 返回 `AgentHandle`，`agent.followup(msg)` 会唤醒 | `dsh-agent` `lib/types/index.d.ts` 的 `ResumeAgentOptions.resumeSessionId`、`AgentHandle.dispose()`；`dsh-agent-loop` `lib/types/agent.d.ts` 的 `followup(input: UserMessage)`、`whenIdle(): Promise<void>` |
| M8 | 会话对象在事件里可读到身份与分类 | `dsh-session` `Session`：`readonly header: SessionHeader` / `get id()`；`SessionHeader` 含 `origin?: 'subagent'`、`delegationDepth?`、`isSeeded` |
| M9 | 服务名是 `agents` / `sessions` / `connection` | `dsh-agent/lib/index.js` `super(ctx, "agents")`；`dsh-session/lib/index.js` `super(ctx, "sessions")`；`dsh-client-connection/lib/index.js` `super(ctx, "connection")` |
| M10 | 精确 Fetch 路由只对 owner Peer 开放 | `dsh-client-connection/lib/index.js` `createSharedFetchHandler()`："if (peer.principal.kind !== "owner") return new Response("forbidden", { status: 403 })"；类型层 `ConnectionFetchRoute.fetch`："Only owner Peers reach an exact route; the shared handler answers 403 for every other principal." |
| M11 | `/api` 的 interceptor 已被 `dsh-api-gateway` 占用（故本插件只能走精确路由） | `dsh-api-gateway/lib/index.js` 调用 `connectionCtx.connection.rpc.intercept("/api", ...)`；`dsh-client-connection` 的 `registerInterceptor()`："connection: shared RPC channel … already has an interceptor" |
| M12 | 客户端 `rpc.call` 的信封与 URL 拼法 | `dsh-client-connection/lib/client.browser.js` 的 `createWebConnectionRpc().call()`：`{ type:'client-request', rpcId, method: endpoint, payload }`，POST 到 `` `${channel}/${endpoint}`.slice(1) ``，返回前校验 `full.result` |
| M13 | 投影缓存**读不回** host-only 单元（机制 B 的否决依据） | `dsh-session-projection/lib/index.js` `viewCheckpoint()`："if (def.wire === void 0) continue"；`dsh-session-projection/README.zh.md`："不带 `wire` 块的单元将状态保留在 host" |
| M14 | 投影缓存确实按 `turn/end` 必写 + 200 事件/5 s 节流（机制 B 的陈旧窗口依据） | `dsh-session-projection-cache/lib/index.js` `installWritePath()`：`if (event.type === "turn/end") { this.flushSoft(session, "turn/end"); return }` + `writeEveryEvents` / `writeIntervalMs` 计时器；`dsh-base/cordis.patch.yml` 的 `session-projection-cache` 行配置为 `writeEveryEvents: 200, writeIntervalMs: 5000` |
| M15 | `cachedSnapshot` 需要 `SessionHeader`（机制 B 违反 A3 的直接原因） | `dsh-session-projection-cache/lib/types/index.d.ts`：`cachedSnapshot(meta: SessionHeader, keys?: ProjectionKeySelection)`；header 的唯一来源是 `sessionPersistence.list/stat/open` |
| M16 | JSONL 后端的物理编码是"独立 zstd 帧拼接"且 `stat/list` 只读 header（机制 C 的依据） | `dsh-session-persistence-jsonl/README.zh.md`「物理编码」节与「读取日志」节；`dsh-session-persistence/lib/types/index.d.ts` 的 `SessionPersistenceSnapshot`（`eventCount?` 标注"when the backend can provide it cheaply; otherwise absent"，`sizeBytes?` 同） |
| M17 | `storageDomain` 的 spec 需要 zod（机制 E 的依据） | `dsh-storage-domain/lib/types/spec.d.ts`：`DomainGlobalSpec.schema: ZodType<G>`、`domainTable(schema: ZodType<V>)`、`defineDomain`；模块头注释："Record schemas are zod… plugin `Config` stays schemastery" |
| M18 | profile 里能解析到的 `@deepseek-ai/*` 只有 `cosmokit` / `dsh-web-search-exa` / `schemastery`（C1 的事实基础：`dsh-session`、`dsh-llm` 等都不在其中） | 命令：`Get-ChildItem $DSH_HOME\profiles\web\node_modules\@deepseek-ai`，输出三项（本次实跑） |
| M19 | web profile 由 `dsh-base` + `dsh-web-app` 等 bundle 组成，`session-projection` / `storage` / `storage-json` / `storage-domain` / `session-projection-cache` / `sessions` / `agents` / `connection` / `webserver` 均在组合中 | `dsh-base/cordis.patch.yml` 与 `dsh-web-app/cordis.patch.yml` 的 insert 行；`$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`（本次实跑读） |
| M20 | `.volatile()` 配置字段依赖 schemastery schema 元数据（§16.3 的依据） | `cordis-plugin-loader` 的实现里 `equalExceptVolatile` / `_commitVolatile` 读 `schema?.meta?.volatile`；`@deepseek-ai/cosmokit` 的 `volatileEntries` |
| **M21** | `Session.append` 是**同步**方法，`commit` 在把事件推入日志后**同步**派发 `session/event` 观察者 | `dsh-session/lib/index.js` 的 `Session.append`（无 `async`，构建事件后直接 `this.commit(event, entry)` 并 `return event`）与 `Session.commit`（`this.log.push(event)` 之后同一函数体内 `invokeContainedSessionObservers(..., "session/event", ...)`）。**本轮返工新增**（B-1 的前提之一） |
| **M22** | `followup` → `send(...,'next-turn',true)` → phase 为 `idle` 时 `wakeDriver` 同步 `setPhase({kind:'running'})` 并 `agents.withInitiator(this, () => this.kick())`；`withInitiator` → `runWithInitiator` **同步**调用 operation | `dsh-agent-loop/lib/index.js` 的 `followup` / `send` / `wakeDriver`；`dsh-agent/lib/index.js` 的 `runWithInitiator`：`result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))`，且同文件把 `initiators` 构造为 `new AsyncLocalStorage()` —— `AsyncLocalStorage.run(store, callback)` 是**同步**调用 callback，因此整条链到 `kick()` 入口都是同步的。**本轮返工新增** |
| **M23** | `kick()` 首条语句 `while (await this.turn())`；`turn()` 在**第一个 await 之前**就 `this.session.append("turn/start", { turn })` ⇒ **续跑轮的 `turn/start` 在 `followup()` 返回之前已被提交并派发** | `dsh-agent-loop/lib/index.js` 的 `kick()` 与 `turn()`（`append('turn/start')` 之后才进入 `try` 与 `await this.preStep(...)`）。**本轮返工新增**，是 B-1 的直接判据、也是"无需合成收尾"的正面依据 |
| **M24** | `tailTurnState` 的值域与入参在本设计中**已变**：入参 = 事件类型数组；无边界 → `'none'`（0.1.0 是 `'empty'`，入参是事件对象数组） | 0.1.0 `lib/detect.js` 的 `tailTurnState`（`return 'empty'`）；规格 `requirement.md` §4 A5 的措辞（"空事件数组 → none"）。**本轮返工新增**，用于纠正前稿"沿用 0.1.0 语义"的不实表述 |
| **M25** | `ResumeAgentOptions.signal` 是文档化的"创建期取消信号"（可用于取消在飞的 resume） | `dsh-agent/lib/types/index.d.ts` 的 `ResumeAgentOptions.signal`："Optional creation-only cancellation signal for persistence load/setup; detached before return." |

### 18.2 需求条目

| 条目 | 结论 | 依据（本设计的锚点 + 复核方式） |
|---|---|---|
| G1 | 满足 | §13.3 的"判据/求值时机分离" + `reconcile` 唯一挂载点；A1 的运行时断言（关态订阅 0 / timer 0 / resume 0 / followup 0 / 写 0）；A2 的 `persist-failed` 反向断言 |
| G2 | 满足 | §13.1 `StateView` 的三个必答字段（`active` / `lastBoot` / `tails`+`why` 原因码）+ 两条诚实说明（`tails[].state` 只反映观察到的边界） |
| G3 | 满足 | §6.2 启动路径只有 1 次定长读 + 纯内存 `planBoot`；§9 证明这是唯一在 C1/A3 下可行的"当场记账"方案 |
| G4 | 满足 | §10 的 G4 行（判据不变 / live 不重续 / prompt 原样 / 一次启动一次）+ §5.3（索引不被续跑动作改写）；回归基准 = 0.1.0 源码与检查脚本 |
| A1 | 设计上满足，断言待实现 | §11 A1 行 + §13.3 |
| A2 | 设计上满足 | §13.1 `op:'set'` 一次原子写与"写后读回"；断言给出两条（同处理器两次请求 + 新实例读盘；落盘失败不改 `active`） |
| A3 | 设计上满足（静态 (a)/(b) + 运行时） | `inject` 不含 `sessionPersistence`（§12 C1 行、§15 差异表）；`read(0)`/`open(`/`append(`/`stat(`/`list(` 全不出现；运行时 Proxy 断言；**`boot.js` 的 active 分支结构断言** |
| A4 | 设计上满足 | `MAX_STATE_BYTES` / `MAX_ENTRIES` 常量 + `store.readState` 定长 buffer；1 vs 1000 会话读取次数相同（无枚举路径）；10 MB 文件 → `oversized` → fail-closed |
| A5 | 设计上满足 | `stepTail`/`tailTurnState` 单一判据（入参=类型数组，M24）+ 保留 `closed` 条目 + 接受 `none` 样本（SQ-5 的两条断言） |
| A6 | 设计上满足 | `planBoot.liveIds` + 执行前二次 `agents.get` |
| A7 | 满足 | `DEFAULT_PROMPT` 原样保留（含"其真实结果不可知"、"不要盲目重试"） |
| A8 | 设计上满足 | `planBoot` 按 id 去重（`duplicate-entry`）+ `attempted` Set + `maxResumePerBoot`；断言用**手工构造的 doc**（m-5） |
| C1 | 满足 | §12 C1 行（依赖清单只含 `node:*` 与相对模块；连 schemastery 也不用；SQ-3 已驳回放宽） |
| C2 | 满足 | §13.4（自带控件、只 `--dsw-alias-*`） |
| C3 | 满足 | §13.4（`window.__ModuleLoader__.load({id, factory})`） |
| C4 | 满足（不改安装纪律） | §13.5（`files` 白名单补 `lib/client.js`）；本文件全篇无本机绝对路径 |
| C5 | 满足（完全不读 artifact） | §12 C5 行；A3 的零调用断言即证明 |
| C6 | 满足（不做任何修补） | §12 C6 行；源码无 `append(`/`open(` |

### 18.3 本设计自身的一致性检查（评审要求逐项可复核）

| # | 检查 | 结论 + 复核方式 |
|---|---|---|
| 1 | 判据是否只有一处 | **是**：`detect.js` 的 `stepTail`，写入侧与 A5 样本共用；`planBoot` 只消费其输出。复核：`state.js` 里只有 `withTurnStart`/`withTurnEnd` 两个函数写 `state` 字段（§16.5）。 |
| 2 | 是否存在"枚举会话存储"的路径 | **否**：`lib/` 不出现 `sessionPersistence` / `readdir` / `stat(`；复核：`check.mjs` 第 0 层白名单 grep。 |
| 3 | 是否存在"读会话日志"的路径 | **否**：无 `SessionHandle` 的 `open/read/append` 调用（唯一回放在 `agents.resume` 内，豁免）。 |
| 4 | 启动读取是否有常数上界 | **是**：1 次 `readState`，字节上限 `MAX_STATE_BYTES + 1`（`store.readState` 的定长 buffer）。 |
| 5 | 关态是否可能动作 | **否**：`reconcile(false)` 是唯一挂载点且不创建 effect；`runBoot` 逐候选复查 `active`；落盘失败不改 `active`。复核：§13.3 的四条运行时断言。 |
| 6 | **索引里是否存在"非观察得来"的状态**（前稿在此失守） | **否**：`state` 只能由 `withTurnStart`/`withTurnEnd` 设置，二者只被 `session/event` 的两个边界分支调用；`boot.js` 不 import `state.js`（§16.5）。复核：结构断言。 |
| 7 | **`active` 是否有第二处公式 / 第二处赋值** | **公式只有一处**：`computeActive`；**赋值只有两处**：`apply` 与 `setEnabled` 成功后（§13.3）。复核：文本断言"与运算只出现一次"+ 结构断言"`active` 的赋值点 == 2"。 |
| 8 | **设计里是否声称了 schema 不具备的能力**（前稿 `purgeOwn` 在此失守） | **已消除**：条目带 `pid`，`withoutOwnEntries(doc, pid)` 可实现；`writer` 明确降级为诊断。复核：§4 字段表 + `state.js` 的 `withoutOwnEntries`。 |
| 9 | **完整性声明是否可证**（前稿"逐点列清楚"在此失守） | **已降级**：§7 明写"已知中断点的枚举（非穷尽）"，并补 C-K / C-L / C-M 三行。 |
| 10 | **同步调用链是否核到底**（B-1 的根因） | **是**：M21–M23 三条实测到 shipped 代码的符号级事实；§5.3 的时序即由它们推出。复核：按 M21–M23 的锚点重读那三段实现。 |
| 11 | 是否有未验证的推断被当成事实 | **前稿在这里给"无"是错的**：B-1（"清账时状态仍为 open"）就是一条未验证的推断。本轮把它换成**可执行的要求**：每条机制断言必须落到"包名 + 符号 + 原文引用"（§18.1）；无法落到符号的（§7 C-A 的窗口时长、同步写在真实磁盘上的耗时）一律标"实现阶段测量"并进 §20 风险表；凡是"我认为它应该这样"的调用链，写进设计前必须读到那段代码（M21–M23 即本轮照此补的三条）。复核方式：逐条检查 §18.1 的"依据"列是否含包名与符号。 |
| 12 | 依赖的未承诺内部契约是否已最小化 | **4 条**（§9 机制 A），全部在公开类型/README 层；机制 B/C/E 依赖更深（各自已被否决）。 |
| 13 | 崩溃协议是否覆盖了"续跑轮自己再崩" | **是**：§7 C-D 行（这一行在前稿里是错的，§5.3 是其修复依据）。 |
| 14 | 开关的安全方向是否显式 | **是**：§4 的"文件不可用 → fail-closed"表；§20 R-11 记录代价。 |

---

## 19. 提交声明

**零已知阻塞问题。** 本设计在上述事实基础上自洽、可判、可实现；不阻塞于任何未决技术问题。

具体地说：

- `design-001` 的 1 BLOCKER（B-1）与 1 MAJOR（M-1）**已修复**，修复说明、根因、同类位置排查见 §0；7 条 MINOR **逐条闭环**（§0.1），其中 m-5 / m-6 已按评审要求"在实现前定死"（格式层不校验唯一性；开关 fail-closed）。
- 规格的 5 条疑问已由 `requirement.md` §6.5 裁定，本设计逐条落实（§17）；本文**不再向用户提出规格疑问**。
- 剩余全部风险都在 §20 的清单里，且都写明"影响 / 缓解 / 后续建议"；没有隐藏项。
- 事实依据集中在 §18.1 的 M1–M25，每条都可按"包 + 符号 + 原文"复核；无法落到符号的只有两处（§7 C-A 的实际窗口时长、同步写在真实磁盘上的耗时），均已标为"实现阶段测量"并列入 R-1。

---

## 20. 已知非阻塞风险清单

| # | 风险 | 影响 | 现有缓解 | 建议 |
|---|---|---|---|---|
| R-1 | `turn/start` 提交与索引写入之间的小窗口（一次 `rename` 的时长）崩溃 | 该会话漏续一次 | 写入在 `session/event` 回调内同步完成，窗口已在微秒量级；§7 C-L 记录"写失败后立刻崩溃"的同类风险 | 实现阶段实测单次写入耗时并记入 HANDOFF；若 > 5 ms 需重新评估 |
| R-2 | 插件卸载（HMR / profile 变更）后进程继续运行，其间的崩溃不再可续 | 该次崩溃的所有会话漏续 | 卸载即清账（按条目 `pid`），UI/文档明说"索引只覆盖活跃期间" | 这是"无维护不信任"（I3）的必然代价 |
| R-3 | 多 Host 进程共用同一个 `$DSH_HOME`（如 `web` + `acp` 同时开） | 两进程写同一份文档：`writer` 互相覆盖；`enabled` 是共享的（一个进程关开关会影响另一个） | **条目带 `pid`**，`purgeOwn` 只删本进程条目（本轮修复 m-2 后才真正成立）；`writer` 仅诊断；resume 失败按单会话隔离并上报 | 文档建议在**一个** profile 里启用；如需多进程共存，后续可做"每 Host 一份状态 + 一份 manifest" |
| R-4 | 状态文档被从旧备份恢复 / 手工改坏 / 版本不匹配 | 可能对早已结束的会话发一次续跑；或（按 §4 fail-closed）功能暂停 | `tailMaxAgeHours`（默认 24h）+ 严格校验（坏则整份丢弃，绝不猜测）+ 无版本迁移（`v` 不匹配即丢弃） | 不做迁移是明确的取舍：旧格式的语义无法证明，丢弃只损失一次续跑机会 |
| R-5 | 部署配置了 `trustedHosts` 且 owner 令牌经远端起效 | 远端 owner 也能读状态/切开关 | 仍受 owner-only 栅栏；接口不含会话 id 参数，爆炸半径限于本插件状态 | 属部署级决定，插件不做额外限制（否则与官方 owner 模型冲突） |
| R-6 | **不 fsync**：只防进程死亡，不防断电/蓝屏 | 断电时可能丢掉最后一条边界写入 | 只影响"最后一条写入是否落地"；最坏是漏续（保守方向） | 若要覆盖断电，需要给边界写入加 `fsync`，代价是每 turn 两次同步落盘；当前判断为不值得，请用户在需要时提出 |
| R-7 | 索引不覆盖 v0.2 安装前就在跑的会话（§7 C-K） | 一次性漏续 | README/UI 明说 | 无（这正是"不得事后重推导"的代价，不能靠扫描补回来） |
| R-8 | `DEFAULT_PROMPT` 会让被续跑的模型花 token，且审批策略仍是部署策略（自动拒绝时可能卡住） | 续跑可能停在审批处 | 与人工打"继续"完全同权限；UI 明示"续跑会消耗 token" | 不需改；属既有语义（0.1.0 README「已知限制」已记） |
| R-9 | 服务名写错（`sessions`/`agents`/`connection`）不会报错，插件只是永不激活 | 功能静默不生效 | `inject` 只声明已核对的名字（§18.1 M9）；UI 的 `active/maintained` 会显式暴露未激活 | 实现阶段用 `dsh --profile web --dump-config` 核对 entry 已插入（INSTALL §5 ④） |
| R-10 | 客户端 slot 名变化（`sidebar.panellist` / `main`） | 页面入口消失 | 沿用 shipped `dsh-client-ui-schedule` 的同一组 slot 与注册形状（本次核对） | 升级 DSH 后重读该包的 `client.js` 注释段 |
| **R-11** | **状态文件不可用时 fail-closed**（§4 的决策） | 用户会看到"功能停了、要手动重新启用"——若文件因磁盘错误损坏，这是一个需要人介入的状态 | UI 的 `stateFile` 明示 + "重新启用"动作；不覆盖原文件以便取证 | 若用户认为"功能停摆"比"多花 token"更不可接受，把 §4 的决策反过来即可（一行改动，但必须同时改 UI 文案）——本设计选择安全方向，理由写在 §4 |
| **R-12** | **扫描中途关开关**：`runBoot` abort 在飞的 resume，可能留下"已修复尾巴但没排指令"的会话 | 该会话停着，直到下次启动重试（索引条目仍为 `open`） | abort 只取消一个已开始的 resume；条目保持 `open`，下次启动重试（§7 C-F） | 这是"关即不动作"（G1）与"不丢指令"的交叉取舍：关的时候不排指令优先 |
| **R-13** | **关→开窗口**（§7 C-M）：关态期间已在跑的轮次不留条目，重开不补扫 | 该轮若中断则漏续 | UI 在"打开开关"处明示"不会补扫已错过的轮次" | 补扫需要读日志/枚举（违反 G3），因此不做 |

---

## 21. 实施阶段的验证计划（交给实现者；设计阶段不执行）

`scripts/check.mjs` 至少包含（沿用 0.1.0 的"两层 + 恒定真式禁令"纪律）：

**第 0 层 契约与静态**
1. `lib/*.js` 依赖清单白名单（C1）；`lib/client.js` 的 `require` 白名单（C2）与 lazy-CJS 形态（C3）。
2. `inject` 不含 `sessionPersistence`；`lib/` 里 grep 不到 `sessionPersistence` / `open(` / `append(` / `read(0` / `readdir` / `stat(`（A3 (a)）。
3. `agents.resume` / `followup(` 只出现在 `boot.js`，且位于 `mode === 'active'` 分支内（A3 (b)，结构断言）。
4. `ctx.on(` 与 `setTimeout(` **只出现在 `reconcile` 的函数体内**（M-1 的结构断言；取代旧稿"位于 active 判定之后"）。
5. `computeActive` 的与运算表达式只出现一次；`active` 的赋值点正好两处（§13.3 检查 7）。
6. `state.js` 里只有 `withTurnStart`/`withTurnEnd` 能写 `state` 字段；`boot.js` 不 import `state.js`（§16.5，防合成状态回归）。
7. `state.js` 的上界常量与文档一致性（`MAX_STATE_BYTES` 被 `store.readState` 引用）。

**第 1 层 纯函数**
8. A5 的三条固定样本（`tailTurnState`，入参=类型数组）+ `planBoot` 的三种文档样本（含合成的 `none`）。
9. `parseState` 的拒绝面：版本不符、字段类型错、超出 `MAX_ENTRIES`、id 超长、`at` 非有限、`pid` 非正整数 → 一律 `undefined`；**接受**重复 id 与乱序 `at`（并按 `at` 归一化，m-5）。
10. 裁剪策略：`closed` 按 LRU 淘汰、`open` 不被淘汰；`open` 超上限时丢弃最旧并产生 warn。
11. `resolveConfig` 的非法值回落（沿用 0.1.0 的 6 条断言风格）。

**第 2 层 组合（stub ctx + 临时真实目录）**
12. A1/A3/A4：关态（三种形态：UI 关 / 配置门禁关 / 文件损坏 fail-closed）与开态各跑一次 `runBoot`，断言 `sessionPersistence` 零调用（Proxy 计数）、`read` 恰好 1 次、`write` ≤ 1 次、订阅注册 0（关态）；1 vs 1000 会话的 stub 读取次数相同；10 MB 状态文件被读 ≤ `MAX_STATE_BYTES+1` 字节并 fail-closed。
13. **A2 双向**：路由 `set` → `state` 的写后读回 + 新 `openLedger` 读盘一致；**外加** `store.writeState` 抛错时返回 `persist-failed` 且 `active` 不变、`enabled` 不变。
14. **B-1 回归断言（评审明确要求）**：桩一个会**同步** append `turn/start` 并派发 `session/event` 的 `agents.resume`/`followup`；跑完一次 resume+followup 后，该 id 在 ledger 里必须是 **`open`**（本轮前稿的写法会红）。
15. **重入断言**：写入侧回调在 `runBoot` 内部被同步调用时不抛错、不 await、不调用 `agents.*`；用"回调里记录调用栈深度"的方式断言重入路径被覆盖。
16. **`disabled-mid-scan`**：开态扫描到第 1 个候选时切 `setEnabled(false)` → 断言后续候选全部 `skipped:'disabled-mid-scan'`、`followup` 零调用、`active()` 为 `false`、订阅已卸载。
17. A6/A8：live 跳过；**手工构造的 doc** 里同 id 两条 `open` 只 resume 一次（另一条 `duplicate-entry`）；`maxResumePerBoot` 截断；`attempted` Set 使同一 id 的 `resume` ≤ 1 次。
18. A7：消息形状、冻结、`source.kind`、正文可判定子串。
19. 崩溃协议（§7）的可模拟点：C-A/C-B/C-C/C-D/C-E/C-F/C-G/C-K/C-L/C-M——用"重新 `openLedger` 同一路径"模拟重启；其中 C-D 用"resume+followup 后立刻重开 ledger"验证条目仍 `open`；C-L 用"写失败后重开 ledger"验证条目确实缺了这条 `open`（承认漏续，不假装自愈）。
20. 失败隔离：状态文件损坏、写失败（只读目录）、resume 抛错、resume 被 abort、followup 抛错，五种都不致命，且都落进 `skipped` / 返回码。

**第 3 层 真机（发布后）**
21. 重启 Host 后验收：①UI 能读到 `active/maintained`；②手工制造一次崩溃（轮次中途杀进程）→ 下次启动日志出现 `auto-continue: continuing "<id>"`；③**再让续跑那一轮中途崩溃一次** → 再下次启动仍能续（B-1 的端到端验证，必须有）；④UI 关闭开关 → 杀进程 → 下次启动无续跑；⑤用 `dsh --profile web --dump-config` 确认 entry 在组合里且无 `skipping` 警告（服务名写错只会表现为"插件永不激活"，只能这样查）。

---

## 22. 维护义务（写进 HANDOFF 的条目）

1. 本文件 §18.1 的 **M1–M25** 是**本设计的证据底座**。DSH 升级后若其中任一条失效（尤其 M1/M3/M4/M6/M10/M11，以及本轮新增的 **M21–M23** 同步链），**必须先改本文件再改代码**。
2. `lib/index.js` 顶部的机制注释必须与 §1.3、§5.3、§7 一致；注释与实现不一致比没有注释更糟（0.1.0 的教训）。
3. `README.md` 必须新增一节"为什么不扫日志"，直接指向本文件 §9；否则下一个维护者会在"性能优化"的名义下把扫描加回来。
4. 任何"只读元数据的枚举"提案都违反 G3 的变更记录，必须先经用户裁定（§16.4）。
5. **任何"合成状态"提案都违反 §16.5**，包括"resume 成功后顺手清账"这类看起来无害的写法——它在 0.2.0 的评审里被证明会把开放的轮次记成已关闭（B-1）。
6. 改动 `active` / `reconcile` 的挂载结构时，必须同步更新 §13.3 的"判据 / 求值时机"分离说明；把 `active` 写成 `const` 会重新引入 M-1 那类自相矛盾。