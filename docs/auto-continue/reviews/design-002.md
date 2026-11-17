# design-002 — 复审：dsh-auto-continue v0.2（返工稿 R2）

评审性质：第 2 轮实现前设计评审。只判定、不实现；本轮不写修复方案、不做根因分析、不替作者做同类排查。
评审日期：2026-11-16

评审基线（开工前实算，与给定冻结值一致）：

| 文件 | SHA-256 | 大小 |
|---|---|---|
| `requirement.md`（新冻结版） | `0E21745A7585B2432E4EDB89816FADB332C3FCFBECA6C0D27D15D3B7D3E4DCA3` | 11003 B / 91 行 |
| `design.md`（返工稿 R2） | `D39B9702B85D08F58B2009D215BFC9A348D48E51D10B559EA58BB1E298D44DCE` | 105332 B / 934 行 |
| `reviews/design-001.md`（前轮评审，未改动） | `12E4EACB602687C0C8B3F3B955B1E0A91CB5E6EA0DD0DF1E975518F5835D6BA5` | 27929 B |

事实源同上一轮：DSH 安装树 `0.2.2-rc.1`（`lib/*.js`、`lib/types/*.d.ts`、`README.zh.md`、`cordis.patch.yml`）、仓库 `INSTALL.md`、`dsh-ability-strip` 双半边先例、0.1.0 源码与 `HANDOFF.md`、随包插件开发 skill。

---

## 结论

**打回。类型：`FAIL`。** BLOCKER 0 条 / **MAJOR 1 条** / MINOR 6 条。

- 上一轮 9 条 finding（1 BLOCKER + 1 MAJOR + 7 MINOR）**全部闭环**，逐条核对见第 1 节；其中 B-1 的删除是干净的（全文已无 `noteResumeClosed` / `by:'resumed'` 的写路径），M-1 的"判据 / 求值时机分离"成立。
- 打回原因是返工**新引入的一处行为级自相矛盾**（N-1：同一 `reconcile(true)` 调用被同时要求"排一次启动扫描"与"不补扫"），以及 6 条新的表述/接口不一致。N-1 落在本轮 M-1 修复所依赖的"唯一挂载点"结构上，且 §19 与 §18.3 均声称该结构自洽——属返工缺陷而非遗留缺口，故记 `FAIL`；未见隐瞒或诱导放水，不记 `VIOLATION`。

---

## 1. design-001 闭环核对表（9/9 已闭环）

| 前轮 finding | 状态 | 本轮核对依据（看改动本身，不看自称） |
|---|---|---|
| **B-1** BLOCKER：`followup` 之后清账把运行中的续跑轮记成 `closed` | **已闭环** | `design.md:20,43` 仅有历史叙述；正文已无 `noteResumeClosed`、无 `by:'resumed'`、无 `tails[].by`（`design.md:612` 明写没有该字段）。`withTurnEnd` 只允许被观察到的 `turn/end` 调用（`:157`），`boot.js` 不 import `state.js`（`:217`, `:761`），I1/I4 相应改硬（`:107,110`）。新增 §5.3 的时序（`:332-352`）与 §18.1 M21–M23（`:809-811`）逐条对到 shipped 代码，我复核了这几条：`followup→send→wakeDriver→withInitiator`（同步）`→kick→turn→append('turn/start')`、`append→commit` 同步派发，全部成立（见第 4 节）。§7 C-D 已改写为"续跑轮又被切断 → 再续一次"（`:433`），§21 增加 B-1 回归断言（`:914`）。**无残留合成状态入口。** |
| **M-1** MAJOR：`active`"只算一次"与运行期切换矛盾 | **已闭环** | `computeActive`（单一判据）/ `setActive`（仅两处赋值）/ `reconcile`（唯一挂载点）三锚点见 `:226-228`、`:235`、`:240`、`:383`、`:411`；§13.3 拆成"判据 / 求值时机"（`:633-636`），旧"只算一次、没有第二个地方重算"已不存在；`setEnabled` 先落盘后改 `active`（`:186,240,492`）。原矛盾消失。**但该新结构自身带入 N-1 / N-4 / N-5。** |
| **m-1** §17/§19 把已裁定疑问当未决 | **已闭环** | §17 改为"§6.5 裁定的落实"，SQ-1…SQ-5 逐条对应实现（`:765-777`）；§19 删掉"若用户真实意图是那样则作废"的条件句（`:859-868`）；`design.md:6` 记录了本稿依据的规格哈希 `0E21…DCA3`，与本次实算一致。 |
| **m-2** `purgeOwn` 在无逐条 pid 的 schema 下不可实现 | **已闭环** | 条目新增 `pid`（`:258-259`, `:272`），`parseState` 校验 `pid` 为正整数（`:154`），`withTurnStart`/`withTurnEnd` 带 pid（`:156-157`），`withoutOwnEntries(doc,pid)`（`:160`），`writer` 降级为诊断（`:270`），R-3 相应改写（`:878`）。schema 现在承载了该能力。**注意 `:368` 的写入门槛表述与 pid 刷新相关，见 N-2。** |
| **m-3** "`tailTurnState` 沿用 0.1.0 语义"不实 | **已闭环** | `:139` 明写"名字沿用，值域与入参形态按规格改"：入参=事件类型数组，第三值 `'empty'`→`'none'`，空数组→`'none'`；M24（`:812`）与 0.1.0 `detect.js` 的事实一致；A5 样本已对齐（`:544`）。 |
| **m-4** §11 A3 行自相矛盾 | **已闭环（有 N-6）** | `:542` 拆成 (a) `detect/state/store` 不出现 `agents.resume`、(b) `boot.js` 的 `agents.resume` 只在 `mode === 'active'` 分支；`:25`、`:899` 同步。同句内"既禁又允许"的矛盾已消失，但 (b) 的结构锚点在 boot 流程里没有对应分支（N-6）。 |
| **m-5** `parseState`"顺序"未定义、与 A8 互斥 | **已闭环** | `:154` 明确格式层不校验唯一性/顺序，只做逐字段校验 + 按 `at` 升序归一化、重复条目保留；去重移到 `planBoot`（`:324`，`duplicate-entry`）；A8 改为对手工构造的 doc 直接调 `planBoot`（`:547`）；§21 #9 断言接受重复/乱序（`:907`）。 |
| **m-6** 损坏文件 fail-open 回 `true` | **已闭环（有 N-3）** | §4 新增"文件不可用时的开关方向"表（`:278-287`）：`missing` 按默认、其余 fail-closed、不覆盖文件；`computeActive` 含 `loadKind` 项（`:635`）；A1 增第三种关态形态（`:540`），A4③ 断言 10 MB 文件 → `oversized` → fail-closed（`:543`）；R-11 记录代价（`:886`）。端口本身闭合，但"重新启用"动作的运行期效果未定义（N-3）。 |
| **m-7** §7 漏两类漏续点 | **已闭环** | §7 改为"已知中断点的枚举（非穷尽）"（`:426`），补 C-L（写失败后崩溃，`:441`）与 C-M（关→开窗口，`:442`），原安装前场景顺延为 C-K（`:440`）；R-12/R-13 对应（`:887-888`）；§21 #19 增加 C-L/C-M 模拟（`:919`）。 |

**闭环结论：9/9 已闭环。** 其中 B-1、M-1、m-3、m-5、m-7 是干净闭环；m-2、m-4、m-6 的端口本体闭环，但其修复实现带出本轮的新问题（N-2 / N-6 / N-3）。

### 1.1 对 §0 返工记录的核对（作者声称的四项是否成立）

- **§0.1 修复说明**（`:16-28`）：逐行与正文对得上，未发现"写了但正文没改"的条目。B-1 与 M-1 的"怎么改"与正文一致。
- **§0.2 根因陈述**（`:30-37`）：其事实前提（`followup` 同步开出 `turn/start`、`append→commit` 同步派发）与我本轮对 `dsh-agent-loop` / `dsh-session` 的复核一致（第 4 节 M21–M23），因此该根因陈述与其引用的代码事实不冲突——这是对"作者声称是否成立"的判定，不是代做根因。
- **§0.3 同类位置排查**（`:39-52`）：10 条逐条能在正文找到对应改动；其中第 3、6、7、9 条（writer→pid、A3 拆分、A8 分层、fail-closed）与正文一致。
- **§0.4 新增自检项**（`:54-56`）：M21–M25 存在且内容成立（见第 4 节）；§21 的第 14/15/16/19 项存在。**一处计数笔误**：`:56` 写"§18.3 的 8 条新检查项（第 6–14 项）"，第 6–14 项实为 **9** 条。属笔误，不计 finding。

---

## 2. 本轮 findings

### N-1 [MAJOR]（MEDIUM）同一个 `reconcile(true)` 被同时要求"排一次启动扫描"与"不补扫"，`reconcile` 无法同时满足

**缺陷在哪**：`design.md:227`（§3.6 锚点：`reconcile(active)` 是"唯一挂载点：按 active 挂/卸 `session/event` 订阅、挂/卸启动 timer"）、`design.md:640`（§13.3 第 1 条：订阅与启动 timer 都由 `reconcile` 按 `active` 挂/卸）、`design.md:672`（§14 第 1 行：`reconcile(true)`：`claim` + 挂订阅 + **排一次启动扫描**）——与 `design.md:676`（§14 第 5 行：UI 打开开关 `→ setActive → reconcile(true)`；**不补扫**）、`design.md:733-735`（§16.1：开关打开后不扫一遍索引；否则"启动判定只发生一次"这条语义消失）、`design.md:417`（§6.3：开 = `reconcile(true)`，不补扫）相冲突。

**凭据/推演**：
1. §14 第 1 行与第 5 行调用的是**同一个** `reconcile(true)`，却要求两种互斥后果：前者"排一次启动扫描"，后者"不补扫"。
2. §13.3 第 1 条把 timer 的挂载权**独占**给 `reconcile`，因此不能解释为"只有 apply 才排 timer"——若 timer 只由 apply 排，则 §13.3 第 1 条与 §3.6 锚点关于"timer 由 reconcile 挂/卸"的表述不成立。
3. 设计没有给出任何区分器（例如"本次进程是否已扫描过"的标志）；`:648` 的四条运行时断言只覆盖 `setEnabled(false)` 之后的卸载（断言 ②），没有覆盖 `setEnabled(true)` 之后的 timer 行为；§21 第 13 项也只覆盖写后读回，不覆盖扫描时机。
4. 若按 §13.3/§14 第 1 行的字面实现，开关每次由关到开都会在 `delayMs` 后跑一次 `runBoot`：这既是 §16.1 明文禁止的"补扫"，也会把 `lastBoot`（G2 的"上次启动它做了什么"）覆盖成一次**并非启动**的扫描时间，使 §14 第 5 行"UI 明说：启动判定只在 Host 启动时"这句话对用户不成立。

**影响**：设计把"扫描何时发生"这一用户可见语义交给了一个自相矛盾的挂载点；实现者必须在两种互斥行为中自选，且两种选择都会违反设计文本中的一处。G2 的 `lastBoot` 语义与 §16.1 的决策依赖这一条。§18.3 第 5、7 项（`:846,848`）与 §19"自洽"（`:861`）与此结论不符。

### N-2 [MINOR]（LOW）§6.1 的"state 未变 → 不写"与 §3.2/§5.3 的"刷新"互相冲突；照前者实现会漏掉续跑后条目的 `pid` / `at` 刷新

**缺陷在哪**：`design.md:368`（§6.1 数据流："state 未变 → 不写（同一引用）"）与 `design.md:156`（§3.2：`withTurnStart` "记录/**刷新**一个会话的 `open` 条目…`pid` 写当前进程"）、`design.md:348`（§5.3："前者被新 `turn/start` 刷新"）、`design.md:163`（§3.4："任一 `with*` 在**没有实际变化**时返回入参文档本身"）。

**凭据/推演**：
1. 续跑后条目在写入时已是 `open`（来自崩溃进程），`followup` 同步产生的 `turn/start` 折叠结果仍是 `open`——**状态不变，但 `seq`/`at`/`pid` 会变**。
2. §3.2/§3.4 的规范语义是"有实际变化就写"（`pid`/`at` 变化属于实际变化），据此 `pid` 会被刷成本进程；§6.1 的"state 未变 → 不写"按字面则是跳过这次写。
3. 若按 §6.1 字面实现，条目会保留**崩溃进程的 `pid`**；`purgeOwn` 只删 `pid === 本进程` 的条目（`:160,187`），因此本进程在正常退出/关开关时清不掉这条 `open`。下一个进程读到它 → `planBoot` 视为可续（`:322`）→ 对一条日志尾巴已平衡的会话再发一次 `continue`。这正是 I3（`:109`）宣称"启动时能读到的 `open` 条目只可能来自崩溃进程"要排除的情形；同时 `at` 停留在崩溃时刻，会让"重复续跑过的长任务"更容易被判 `too-old`（`:320`）。
4. 该冲突在 §18.3 第 6/7 项（`:847-848`）未被覆盖，§21 也没有"续跑后条目 `pid` 应为本进程"的断言——`:914` 的回归断言只查 `state === 'open'`。

**影响**：I3 的"无维护即不信任"保证依靠 `pid` 归属；两套写入门槛并存时，实现者可能做出使该保证失效的选择。属规范文本级矛盾，影响面被局限在"续跑轮运行中本进程正常退出/关开关"这一组合。

### N-3 [MINOR]（LOW）"重新启用"动作的运行期效果未定义，且与 `computeActive` 的 `loadKind` 项冲突

**缺陷在哪**：`design.md:284`（§4：`oversized`/解析失败/`v` 不匹配 → 强制 `false`；UI 给"重新启用"动作"写一份新文档并把 `enabled` 置 `true`"）、`design.md:614`（§13.1：`op:'set'` **落盘成功后**才改变 `active` 并 `reconcile`；corrupt/io-error/oversized 时开关置灰但给"重新启用"动作）、`design.md:635`（`computeActive` 含 `loadKind ∉ {corrupt, oversized, io-error}`）、`design.md:643`（§13.3 第 4 条：路由的第三类事是"给'重新启用'写一份新文档"）。

**凭据/推演**：
1. 文件不可用时 `loadKind` 是 `corrupt`/`oversized`/`io-error`（`:182,284-285`）。
2. `computeActive` 把 `loadKind` 作为与运算的一项；"重新启用"写出的新文档只改变磁盘内容与 `doc.enabled`，不改变 `loadKind`（设计未定义任何重置点）。
3. 因此按 §13.1"落盘成功 → `setActive(computeActive(...))`"，重新启用后 `active` 仍为 `false`；而 §4 的表格与 §13.3 第 4 条只描述了"写一份新文档"，没有描述它与 `setActive`/`reconcile` 的关系。`StateView` 会同时给出 `enabled:true` 与 `active:false, maintained:false`（`:594-597`），设计没有定义这种组合的含义。
4. §21 没有任何针对"重新启用"动作的断言（`:912` 只测三种关态；`:913` 只测正常 set 的双向）。

**影响**：这是本轮回合为一个**总会花 token 的功能**新加的安全出口；出口的效果（是否在本次进程内恢复维护、是否只等下次启动）没有定死，UI 的 `enabled`/`active` 两个字段在该分支下会互相矛盾。

### N-4 [MINOR]（LOW）`computeActive` 的签名与其公式不一致，且"公式只写一处"在文档内有两份不同写法

**缺陷在哪**：`design.md:226`（`computeActive(config, doc)` // `config.enabled && doc.enabled && loadKind !== 'corrupt'`）、`design.md:235`（`computeActive(config, ledger.current())`）、`design.md:383`（`setActive(computeActive(config, doc))`）与 `design.md:635`（"公式只在这里写一次"：`config.enabled && doc.enabled && loadKind ∉ {corrupt, oversized, io-error}`）。

**凭据/推演**：
1. 公式含有 `loadKind`，但三处声明/调用点都只传 `(config, doc)`；`loadKind` 是 ledger 的读视图（`:188`），既不是 doc 的字段（§4 字段表 `:266-276`），也不在参数列表里。按 §3.6 的"纯函数"要求，该函数无法从声明的入参取得这一项。
2. 两处公式的字面内容不同（`!== 'corrupt'` vs `∉ {corrupt, oversized, io-error}`）；由于 §4 已把三种不可用形态的 `enabled` 都归一为 `false`，两者行为等价，但"公式只写一处"（`:635`, `:901` 的检查项）与文档自身的两份写法相抵。
3. `:226` 的注释形式与 `:635` 的正文形式并存，§13.3 的静态检查"与运算表达式只出现一次"只对代码生效，无法消除文档层歧义。

**影响**：这是 M-1 的"单一判据"赖以成立的接口；签名与公式不一致会让实现者自行决定 `loadKind` 从哪来（读 ledger？还是把它并入 doc？），而两种做法对"纯函数"与可测性的影响不同。

### N-5 [MINOR]（LOW）"`reconcile` 是唯一创建/销毁 effect 的地方"与"关态下不存在任何 effect 实例"同设计自身矛盾

**缺陷在哪**：`design.md:640`（§13.3 第 1 条）、`design.md:240`（§3.6 第 6 步："`setActive(false)` 之后 `reconcile` 保证**不存在任何 effect 实例**"）、`design.md:846`（§18.3 第 5 项）与 `design.md:238`（§3.6 第 4 步：路由经 `ctx.inject(['connection'], …)` + `fetch.register` 注册，**不受 `active` 影响**）、`design.md:239`（第 5 步：卸载 disposer 本身是 `ctx.effect`）、`design.md:643`（§13.3 第 4 条：路由在关态仍然活着，否则开关打不开）、`design.md:529`（G1 行："关态下唯一活着的资源是 owner-only 路由"）。

**凭据/推演**：
1. 路由注册与插件生命周期 disposer 都是 effect 型资源，且设计明文要求它们在关态存在（`:238`, `:239`, `:643`, `:529`）。
2. 因此"`reconcile` 是唯一创建/销毁 effect 的地方"与"关态下不存在任何 effect 实例"按字面均不成立；成立的只是较窄的命题——"行为型 effect（`session/event` 订阅、启动 timer）只在 `reconcile` 里挂/卸，且关态不挂"。
3. `:647` 的静态断言只约束 `ctx.on(`/`setTimeout(` 出现在 `reconcile` 内，与窄命题一致；但 `:640`/`:240` 的措辞是宽命题，且 `:846` 把它当作关态检查的结论。

**影响**：M-1 的修法正是用"effect 存在性"替代"谓词常量性"；宽命题一旦被实现者当作结构约束，会与"路由在关态必须活着"直接冲突（§13.3 第 4 条与 G1 行）。属表述级矛盾，行为意图在 `:238`/`:643` 已写明。

### N-6 [MINOR]（LOW）A3(b) 与 §21 第 3 项的"`mode === 'active'` 分支"在 boot 流程里没有对应锚点

**缺陷在哪**：`design.md:542`（§11 A3(b)：`boot.js` 中的 `agents.resume` 必须只出现在 `mode === 'active'` 分支内）、`design.md:899`（§21 第 3 项同）与 `design.md:206-215`（§3.5 runBoot 的实际顺序：第 1 步是 `runtime.active() !== true` 的早退，第 2 步 `planBoot` 产出 `mode`，第 3 步遍历 `resume`，全程没有 `mode === 'active'` 分支）、`design.md:390`（§6.2 伪代码同样只出现 `active()` 检查）。

**凭据/推演**：
1. `mode` 是 `planBoot` 的返回值（`:143`, `:197`），在 §3.5/§6.2 的流程里只被写进汇总，没有被用作分支条件；分支条件是 `runtime.active()`。
2. 因而 `:542`/`:899` 要求的结构断言在设计的实现骨架里找不到可断言的锚点；实现者要么补一个 `mode !== 'active'` 早退（设计未描述），要么让该断言无对象。m-4 的原矛盾已消除，但 (b) 的锚点描述与 §3.5/§6.2 不一致。
3. `:215` 的"取消除外，见 3d"与 `:211` 的 abort 语义相关：3d 只在 resume **成功**后执行；resume 因 abort 而 reject 时走的是"单会话失败隔离、队列继续"，该候选会记 `resume-failed` 而非 `disabled-mid-scan`，直到下一候选的 3a 才停队。这与 §13.1 的原因码集合（`:585`, `:612`）不冲突，但"取消即停队"的表述与代码路径不完全一致。此点仅作为 N-6 的旁证记录，不单列 finding。

**影响**：检查计划（`check.mjs` 第 0 层）是实现的验收面；锚点与实际骨架不一致时，该断言要么被弱化、要么迫使实现偏离骨架。

### N-7 [MINOR]（LOW）R-3 改写后遗漏了多进程共享文档的主要失效模式（整份文档互相覆盖）

**缺陷在哪**：`design.md:878`（R-3：影响写"两进程写同一份文档：`writer` 互相覆盖；`enabled` 是共享的"），对照前轮同一条（设计 1 稿 R-3 写的是"条目互相覆盖；`purgeOwn` 只清自己的条目"）。

**凭据/推演**：
1. 写路径是"整份文档序列化后 `renameSync` 覆盖"（`:173`），且内存文档是权威、文件是派生（`:191`）。两个进程各自持有整份文档时，任何一次边界写都会用本进程的内存快照覆盖对方刚写入的条目——这与"`writer` 互相覆盖"不是同一件事：后者只影响诊断字段，前者会**丢掉对方进程记录的 `open` 条目**（漏续），或把对方已翻 `closed` 的条目写回 `open`（误续）。
2. 本轮 m-2 的修复（条目带 `pid` + `purgeOwn` 按 pid）只解决"清理时误删"的一半问题，不解决"整份覆盖"；R-3 的"现有缓解"列（`:878`）也没有提到这一点。
3. R-3 的结论（建议一个 profile 只启用一份）本身仍然成立，因此不改变非阻塞定性。

**影响**：风险表是本设计"没有隐藏项"（`:867`）的唯一载体；多进程场景的主要失效模式从风险描述里消失，会让后续维护者低估该组合的后果。

---

## 3. 已核对、未构成 finding 的关键断言（本轮新增与复核对）

### 3.1 本轮新增的事实断言 M21–M25（逐条对安装树复核）

| # | 设计断言 | 复核结果 |
|---|---|---|
| M21 | `Session.append` 同步、构造事件后 `commit(event, entry)` 并 `return event`；`commit` 在 `log.push` 后同一函数体内同步派发 `session/event` | `dsh-session/lib/index.js` `append(type,data,…)` 无 `async`，`deepFreeze` 后 `this.commit(event, entry); return event`；`commit` 在 `log.push` 之后同步调用 `invokeContainedSessionObservers`。**成立** |
| M22 | `followup→send(…,'next-turn',true)`；idle 时 `wakeDriver` 同步 `setPhase({running})` 并 `agents.withInitiator(this, ()=>this.kick())`；`runWithInitiator` 同步调用 operation；`initiators` 是 `AsyncLocalStorage` | `dsh-agent-loop` 的 `followup`/`send`/`wakeDriver` 与设计一致；`dsh-agent/lib/index.js` `initiators = new AsyncLocalStorage()`、`initiatorRuns = new AsyncLocalStorage()`，`runWithInitiator` 里 `result = this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))`——`AsyncLocalStorage.run` 同步调用回调。**成立** |
| M23 | `kick()` 第一条 `while (await this.turn())`；`turn()` 在首个 await 前 append `turn/start` | `kick()` 与 `turn()` 源码一致；`turn/start` 的 append 在 `try{while(true){…await this.preStep}}` 之前。**成立**（这正是 B-1 闭环的判据） |
| M24 | `tailTurnState` 入参与值域已变（类型数组；无边界→`'none'`；0.1.0 为事件数组、`'empty'`） | 0.1.0 `lib/detect.js:83-91` 为 `tailTurnState(events)` + `return 'empty'`；设计 §3.1/§11 A5 与规格 A5 的措辞已对齐。**成立** |
| M25 | `ResumeAgentOptions.signal` 是"创建期取消信号" | `dsh-agent/lib/types/index.d.ts`：`readonly signal?: AbortSignal;` 注释 "Optional creation-only cancellation signal for persistence load/setup; detached before return."。**成立**（resume 返回后 abort 不影响已发布 agent；`resumeWith` 的 finally 会 `handle?.close()`，`dsh-agent-loop/lib/index.js` 1731-1771） |

### 3.2 本轮新引入的边界分支（逐个核对，仅 N-1…N-6 中的已列项构成 finding）

| 分支 | 结论 |
|---|---|
| `wakeDriver` 时 phase **非 idle**（§5.3 `:348`） | **不构成 finding**。该分支下 `followup` 只入队、不产生 `turn/start`，条目**当时**确实保持 `open`；随后当前轮 `turn/end` 被观察为 `closed`（真实边界，符合 I1）、队列消息由 `turn()` 的 `inbox.hasPending` 续下一轮再开 `turn/start`（`kick` 的 `while` 循环），不会出现"续跑轮被记成 closed"那类假状态。`send` 里 `wakingAfterAbort` 在 phase=running 且未 abort 时为 false，`wakeDriver` 不置 `wakeRequested`，但入队消息仍由 `hasPending` 驱动，不丢。仅存在 `turn/end` 与下一 `turn/start` 之间的极窄保守窗口（与 C-A 同类），§7 已声明非穷尽。**自洽。** |
| `disabled-mid-scan`（§3.5 3a/3d、`:209-215`、R-12） | **不构成 finding**。3a 早于每个候选、3d 在 resume 之后 followup 之前；关态不排指令（G1）、条目保持 `open` 下次重试（C-F）；`handle.dispose()` 只释放本插件恢复的 agent。abort 导致的 reject 记 `resume-failed` 而非 `disabled-mid-scan`（N-6 旁证），结果仍是"不排指令 + 后续候选停队"。**行为自洽。** |
| `runtime.abortSignal()` 复用（`:211`, `:395`） | **不构成 finding**。唯一的重复扫描入口是 N-1 的 timer；在本进程内 `runBoot` 只由启动 timer 触发，关闭→重开不重扫（§16.1），因此"控制器被 abort 后再次传给 resume"在设计的单进程路径上不可达。若 N-1 按 §14 第 1 行实现，该不可达性才成立；本条与 N-1 相关，不单列。 |
| fail-closed 表（§4 `:278-287`）与 A1/A4 断言 | **端口闭合**：`missing` 与"存在但不可用"分开；`oversized`/解析失败/`v` 不匹配/`io-error` 一律 `active:false`、不覆盖文件；A1 增三形态、A4③ 增 oversized 断言。与规格 G1/H1 的保守方向一致，规格未规定损坏分支，因此不违反规格。**唯一未定死处是"重新启用"动作的运行期效果（N-3）。** |
| `parseState` / `planBoot` 分层（m-5 修复） | **成立**。格式层不校验唯一/顺序、按 `at` 归一化、重复保留；`planBoot` 保留最新 + `duplicate-entry`；A8 改用手工 doc；§21 #9 明确"接受重复与乱序"。与 A8 的"同 id 两条 open 只 resume 一次"可同时成立。 |
| §16.5 合成状态禁令 + `check.mjs` 结构断言（`:761`, `:902`） | **成立**且可复核：`state.js` 里只有 `withTurnStart`/`withTurnEnd` 写 `state`，`boot.js` 不 import `state.js`；这条禁令覆盖了 B-1 的原形与"关开关时改写 state"的变体。 |
| `pid` 归属与 R-3（m-2 修复） | **schema 层成立**：`tails[].pid`、`parseState` 校验、`purgeOwn` 按 pid、`writer` 仅诊断；`multi-process` 的整份覆盖问题仍是 R-3 的既有风险（N-7 的表述遗漏，不改变定性）。 |
| 规格 §6.5 的落实（§17） | **成立**：SQ-1…SQ-5 逐条对应到 §4/§5.2/§9/§11；`design.md:6` 的规格哈希与本次实算一致，未引用过期规格。 |

### 3.3 第二轮仍成立、未重开的前轮事实（抽样复核，安装树未变）

`session/event` 的 `(session,event)` post-commit 语义与同步派发、`turn/start`/`turn/end` 为 `SessionEventMap` 成员且带 `seq`/`time`、`turn()` 的 `finally` 补 `turn/end`、`interruptedTurnClosers` 对平衡日志返回空、seed 事件不发布 `session/event`、`agents.resume`/`AgentHandle{agent,dispose}`/`agents.get`、`connection` 的精确路由 owner-only 403 与 `/api` interceptor 占用、`rpc.call` 信封与 endpoint 命名规则、lazy-CJS 与 client `inject=['slots','connection']`、`sidebar.panellist`/`main` 先例、投影缓存 `wire`/`cachedSnapshot`/`turn/end` 必写与 200/5s、storage-domain 的 zod 依赖、`.volatile()` 依赖 schemastery 元数据、JSONL 多帧 zstd、profile `@deepseek-ai` 仅三项且 zod 靠 hoist、`DSH_HOME` 空白即未设置的规则——本轮抽样复核结论与 design-001 第 4 节一致，**未发现设计的事实引用发生变化或失效**。0.1.0 的 `DEFAULT_PROMPT` 文本与消息 shape 也未变（`detect.js:41-50`、`index.js:118-125`；`dsh-session` 的 `user/message` 只要求非空 `kind`）。

---

## 4. 范围外观察（不阻断）

- 规格 `requirement.md:3` 的状态仍是"待用户裁定"，而其 §6.5 已给出 5 条裁定、`design.md` 也已把它们当已决落实。这是规格自身的状态行与其正文不同步，属规格范围的文档问题；不影响本设计判定（设计按 §6.5 落实是正确的）。
- 规格 `requirement.md:91` 新增"引用 artifact 数量要写明测量时刻"；`design.md:723`（§15.3）仍以"626 个 artifact"作无条件陈述（该资产已作废，且 `:74` 已补"两次测量 625/626"的说明）。属已作废段落的引用习惯问题，不计 finding。
- 本机四个 profile 仍无 `dsh-auto-continue`（与新版规格 §1 的"已卸载"一致），因此本轮无线上实测可参照；这不是设计缺陷。

---

## 5. 评审方法与限制（如实）

- 只读核对：新版 `requirement.md`、返工稿 `design.md` 全文（934 行）、前轮 `reviews/design-001.md`、`INSTALL.md`、`dsh-ability-strip` 先例、0.1.0 源码与 `HANDOFF.md`、DSH 安装树相关 `lib/*.js` 与 `lib/types/*.d.ts`、profile 目录。开工前与收尾各算一次两份冻结文件的 SHA-256，均与给定值一致；`design-001.md` 未被改动。
- 未运行任何被审查代码（v0.2 尚不存在），未启动 Host，未安装/打包，未执行测试，未修改 `design.md` / `requirement.md` / `design-001.md` 或任何其它文件。本轮唯一写入的文件是 `reviews/design-002.md`。
- B-1 与 M21–M23 的结论来自 shipped 代码的同步调用链（文件与行号见各条），未依赖运行期观测；唯一的运行期假设是 Node `AsyncLocalStorage.run` 同步调用回调（Node 文档语义，且 `runWithInitiator` 的写法可静态确定）。
- 未核实项：`reconcile` 的 timer 若按某个未写入设计的"一次性"标志实现，N-1 的行为后果会被规避；该实现路径设计里没有文字依据，故 N-1 按现有文本判定。同步写在真实磁盘上的耗时、C-A 的窗口时长仍属实现阶段测量（§20 R-1），本轮不据此判缺陷。