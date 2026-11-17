# design-001 — 设计评审：dsh-auto-continue v0.2

评审性质：实现前设计评审（只看设计、规格、约束与事实源；不实现、不安装、不运行被审查物）
评审日期：2026-11-16
评审基线（开工前实算，与冻结值一致）：

| 文件 | SHA-256 | 大小 |
|---|---|---|
| `requirement.md` | `EE9D29B53A43F158BDB3E967CAC1D21DF172022B2DFC6E8E502446A36CD6ABEB` | 10646 B / 90 行 |
| `design.md` | `B629F72F7A70A0BB11278B4341F0F46905E6408AD942524A0432465804D75713` | 73415 B / 765 行 |

事实源：DSH 安装树 `0.2.2-rc.1`（`@deepseek-ai/dsh/node_modules/@deepseek-ai/*` 的 `lib/*.js`、`lib/types/*.d.ts`、`README.zh.md`、`cordis.patch.yml`）、仓库 `INSTALL.md`、同仓双半边先例 `dsh-ability-strip`、`0.1.0` 源码（`dsh-auto-continue/lib/*.js`、`HANDOFF.md`）、DSH 随包插件开发 skill。

---

## 结论

**打回。类型：`FAIL`。**

- **BLOCKER 1 条 / MAJOR 1 条 / MINOR 7 条。**
- 规格覆盖无缺口：`G1–G4`、`A1–A8`、`C1–C6`、`H1–H4` 与 `§6.5` 五条裁定，在设计里都有对应锚点，且约束遵守情况属实（C1/C2/C3/C4/C5/C6 均有证据）。
- 打回原因不是"写得不够细"，而是**主路径上的一处机制错误**（B-1）与**G1 结构保证处的自相矛盾**（M-1）。两者都在设计自检（§18.3 宣称"无"未验证推断）与 DSH 事实源核对之后仍然存活，属"认真自查后仍难发现的高风险矛盾"，因此归 `FAIL` 而非 `NOT_READY`；未见隐瞒、未声明已知问题或诱导放水，不归 `VIOLATION`。

---

## Findings

格式：严重度（code-review-static 映射）→ 缺陷位置 → 判定依据（推演链 + 出处）→ 影响 → 修复建议。

### B-1 [BLOCKER]（HIGH）续跑成功后"清账"写会把一个**正在运行**的轮次记成 `closed`，二次崩溃时该会话不再被续跑

**缺陷在哪**：`design.md:288-289`（§6.2 启动流程：`followup` 之后紧接 `ledger.noteResumeClosed(id, now)`），牵连 `design.md:108`（`withTurnEnd` 的 `by:'resumed'`）、`design.md:137`（`noteResumeClosed`）、`design.md:315-317`（§7 C-D / C-E 两行）、`design.md:553`（§14「崩溃后重启」行）、以及不变量 `design.md:59`（I1）与 `design.md:62`（I4）。

**凭什么判定**——推演链（全部来自 shipped 代码，无一步靠猜测）：

1. `agents.resume(...)` 只会在 `initializeAgent` 完成发布后 resolve，而发布体是 `agent.runMaintenance(...)`，其 `finally` 把 phase 置回 `idle`；恢复的 agent 此时 inbox 为空。
   出处：`dsh-agent-loop/lib/index.js:1565`（`return await agent.runMaintenance(async () => {…})`）、同文件 `586-609`（`runMaintenance` 的 `finally` → `setPhase({kind:'idle'})`）。
2. `handle.agent.followup(msg)` 在 0.1.0 与设计中都等于 `send(msg, 'next-turn', true)`
   出处：`dsh-agent-loop/lib/index.js:570-572`。
3. phase 为 `idle` 时 `send` 调 `this.wakeDriver(...)`；`wakeDriver` 先 `setPhase({kind:'running',…})`，再 `this.loopCtx.agents.withInitiator(this, () => this.kick())`
   出处：`dsh-agent-loop/lib/index.js:564-569`、`618-633`。
4. `withInitiator` → `runWithInitiator` **同步**调用 `operation`（`this.initiatorRuns.run(run, () => this.initiators.run(agent, operation))`，无 await 前置）
   出处：`dsh-agent/lib/index.js:774-783`。
5. `kick()` 与 `turn()` 都是 async 函数，但都在**首个 await 之前**同步执行到 `this.session.append("turn/start", { turn })`
   出处：`dsh-agent-loop/lib/index.js:651-653`（`kick` → `while (await this.turn())`）、`723-735`（`turn()` 内 `append('turn/start')` 在第一处 await 之前）。
6. `Session.append` 是同步方法；`commit()` 在 `this.log.push(event)` 之后**同步**调用 `session/event` 观察者（`invokeContainedSessionObservers`）
   出处：`dsh-session/lib/index.js:1524`（同步 `append`）、`1589-1601`（`commit`）。
7. 于是设计自己的写入侧（`design.md:262`：`state 变 → ledger 内存更新 + store.writeState`）在 `followup` **返回之前**就把该会话写成 `state:'open'`。
8. 回到 §6.2，紧接着的语句 `ledger.noteResumeClosed(id, now)` 按 `design.md:108/137/553` 把同一条目翻成 `closed`（`by:'resumed'`、`seq:null`），而该轮在 `turn/end` 之前不会再产生任何边界事件。

⇒ 结果：**续跑所启动的那一整轮，索引都写着 `closed`，而日志尾巴是 `open`。** 这不是"微秒级窗口"，是持续整轮的状态。

**影响**：

1. **目标场景二次失效**：若进程在这一轮中途死掉（插件存在的理由就是轮次中途死亡，续跑的往往还是一次长任务），下次启动时 `planBoot` 读到 `state:'closed'` → `skipped:'tail-closed'`（`design.md:234`）→ **不续跑**。会话再次永久停在半轮，而这次连 UI 都会说"上一轮已正常结束"。
2. §7 的 C-E 行判定 `✅` 是错的；其理由"那一轮的续跑指令已送达"说的是**上一轮**的指令，而不是刚被这条指令开启的这一轮。C-D 行描述的那个"清账写未落"的窗口在实现上根本不会出现（清账写必然在 open 之后）。
3. 违反设计自己的不变量：I1「只记事实，不记推导」——`by:'resumed'` 记录的是推论，不是事件；I4「判定唯一」——`noteResumeClosed` 是第二套判据，绕过了 `stepTail`。
4. G2 可观测性反向说谎：`StateView.tails[].state` 会告诉用户"它正常结束了"。

**修复建议**：删除 `noteResumeClosed` 与 `by:'resumed'` 这一整条支路，只信任可观察边界——`followup` 成功后由被观察到的 `turn/start` 把条目留在 `open`（真事实）；`followup` 抛错时不产生 `turn/start`，条目仍为 `open`，下次启动自然重试（正是想要的语义）；该轮正常结束时 `turn/end` 把它翻成 `closed`。"我们续过这个会话"这一 UI 信息已由 `lastBoot.resumed`（`design.md:483`）承担，不需要写进尾巴条目。
不要改成"先清账再 followup"：那样 `followup` 抛错时会丢掉重试机会。并在 `scripts/check.mjs` 第 2 层加一条断言：合成一次 resume+followup 之后，该 id 的 ledger 状态必须是 `open`（按现在的设计，这条断言会红）。

### M-1 [MAJOR]（MEDIUM）G1"结构保证"一节与开关的运行期语义自相矛盾

**缺陷在哪**：`design.md:513`（§13.3 第 1 条）：「`active = config.enabled && doc.enabled` **只在 `apply` 里算一次**，之后所有分支都读它。**没有第二个地方重算**」。

**凭什么判定**：同一文档里至少四处要求 `active` 在运行期变化：

- `design.md:492`（§13.1）：`op:'set'` 成功后「**立刻在运行时生效**——开→挂订阅；关→卸订阅 + 清 pending 启动 timer」；
- `design.md:298-300`（§6.3）与 `design.md:548-549`（§14）：UI 关/开要做同样的事；
- `design.md:516`（§13.3 第 4 条）：路由「只做三类事：读内存快照、原子写开关、**挂/卸订阅**」；
- `design.md:475`（§13.1）：`StateView.active` 的定义是「两者相与：插件**此刻**是否在维护索引并会续跑」——"此刻"是运行期谓词，不是 apply 时刻的常量。

⇒「只算一次、没有第二个地方重算」与「运行期切换立刻生效」不可同时成立。这不是措辞问题：§13.3 自称是 G1 的"四道**结构**约束"，照第 1 条的字面实现（`const active`），UI 关闭开关后订阅不会被卸载、状态文件继续被写，G1「关闭后插件不产生任何自动行为」就在这一路径上失守。

**修复建议**：把谓词定义与求值时机分开写：`computeActive(config, doc)` 是一个函数（单一判据，不在别处重写公式）；`active` 是运行期布尔，只允许在 `apply` 与 `setEnabled` **成功落盘之后**两处赋值；其余分支只读。这样既保留"单一谓词"，又消掉自相矛盾。同时明确：`setEnabled` 落盘失败时不得改 `active`（否则 UI 显示关、实际仍在记录）。

### m-1 [MINOR]（LOW）§17/§19 把规格已裁定的 5 个疑问当成仍未决，与冻结规格冲突

**依据**：`requirement.md:76-84`（§6.5 裁定表，SQ-1…SQ-5 逐条有裁定）、`requirement.md:31`（变更记录写明"依设计者 5 条规格疑问裁定"，H3 因此修订为允许最小持久化事实）。设计 `design.md:625-636` 仍把同样 5 条列为"需用户裁定"，`design.md:710` 甚至写「其中只有 SQ-1…会让方案作废——如果用户的真实意图是那样，请立刻回退本设计」。设计这 5 条的技术立场**恰好全部与裁定一致**（H3 最小事实、子智能体默认不续、C1 不变、A3 限定插件自身源码、A5 拆两条），所以不改技术内容；但读设计的人会以为方案还悬在用户口上，或以为 H3 可能禁止自有状态文件。
**建议**：把 §17 改成"§6.5 裁定记录 + 本设计的对应实现"，删掉 §19 的条件作废句。

### m-2 [MINOR]（LOW）`purgeOwn()` / `withoutOwnEntries(doc, pid)` 的语义在状态文档 schema 下不可实现，"按 pid 限定"是空头承诺

**依据**：`design.md:111`（`withoutOwnEntries(doc, pid)`「移除本进程写入的条目」）、`design.md:139`（`purgeOwn()`）、`design.md:200`（`writer`「当前维护者 {pid, at}｜**仅诊断用途，不参与判定**」）、`design.md:720`（R-3 称「`purgeOwn` 只清自己的条目（**已按 pid 限定**）」）。而 §4 的状态文档样例与字段表（`design.md:182-206`）里，`tails[]` 只有 `id/state/by/seq/at/origin`，**没有逐条 pid**；`writer` 是文档级单值。
⇒ "本进程写入的条目"没有可判定依据：实现只能退化成"若 `writer.pid` 是本进程则清全部条目"（多进程共享 `$DSH_HOME` 时会删掉别人的条目或一条都不删），与 R-3 的"已按 pid 限定"不符。
**建议**：二选一并写进设计——(a) 条目加 `pid` 字段（每条约 +6–10 B，仍在 `MAX_STATE_BYTES` 内），R-3 的说法才成立；(b) 明确"单写者前提，`purgeOwn` = 清空 `tails`"，并改写 R-3 的缓解句。

### m-3 [MINOR]（LOW）"`tailTurnState` 沿用 0.1.0 名字与语义"不成立

**依据**：`design.md:90` 称「沿用 0.1.0 名字与语义」，但 0.1.0 的 `tailTurnState(events)` 取**事件数组**、无边界时返回 `'empty'`（`dsh-auto-continue/lib/detect.js:83-91`）；设计改成取**事件类型数组**（`design.md:424` 的 A5 样本传的是字符串），且第三值是 `'none'`（`design.md:88`）。规格 `requirement.md:49` 要求「空事件数组 → none」——值域以规格为准是对的，错的是"沿用 0.1.0 语义"这句断言，以及参数形态在 A5 样本与规格措辞（"空事件数组"）之间没有定义清楚。
**建议**：明写"值域按规格改为 `none`（0.1.0 是 `empty`）；入参形态 = 事件类型数组；空数组 → `none`"，并把 A5 的固定样本与这条定义对齐。

### m-4 [MINOR]（LOW）§11 A3 行自相矛盾：`boot.js` 既被禁止、又被允许出现 `agents.resume`

**依据**：`design.md:422`：「判定路径模块（`detect.js`/`state.js`/`store.js`/`boot.js`）不出现 …、`agents.resume`（`agents.resume` 只允许在 `boot.js` 的 active 分支）」。同一句里把 `boot.js` 划进"不得出现"清单又立刻豁免。
**建议**：拆成两条断言：(a) `detect/state/store` 不出现 `agents.resume`；(b) `boot.js` 中的 `agents.resume` 必须位于 `mode === 'active'` 分支内（可用结构断言）。

### m-5 [MINOR]（LOW）`parseState` 的"顺序"校验未定义，与 A8 的脏输入测试互斥

**依据**：`design.md:105` 的 `parseState` 校验项里有「顺序」，但没定义"顺序"是什么；`design.md:427` 的 A8 却要求"文档里同一个 id 写两条 `open`"这种脏输入被接受，并断言 `resume` 只被调用一次。若"顺序"包含 id 唯一/排序约束，`parseState` 会整份丢弃（`design.md:105`"任一不满足返回 undefined"），`planBoot` 根本看不到条目，`resume` 调用次数是 **0**，A8 的断言按字面必然失败。
**建议**：明确分层——`parseState` 不做 id 唯一性校验，去重只由 `planBoot` + `attempted` Set 负责；或让 A8 直接对手工构造的 `doc` 调 `planBoot`。同时删掉未定义的"顺序"或给出定义。

### m-6 [MINOR]（LOW）状态文件不可读时总开关静默回到 `true`（对会自动花 token 的功能是 fail-open），设计未做决策

**依据**：`design.md:104` 的空文档 `enabled:true`；`design.md:274-275`（`oversized`/坏 → 空文档 + warn）；`design.md:198`（`v` 不匹配 → 整份丢弃）。R-4（`design.md:721`）只讨论"陈旧条目 + `tailMaxAgeHours`"，没有讨论**开关值**的丢失。后果：用户上次明确关掉的总开关，在一次文件损坏/版本不匹配后会被静默当成"从未设置"→ 下一次启动照常续跑。
**建议**：把一个显式决策写进 §4/§20：或者把 `enabled` 从"整份丢弃"里摘出来（独立的极小开关文件，`tails` 坏掉不影响它）；或者规定"文件存在但不可解析 → 视为 `enabled:false`（fail-closed）+ UI 显示 `stateFile:'corrupt'` 并给一个重新启用的动作"。两种都可以，但不能靠副作用决定。

### m-7 [MINOR]（LOW）§7 声称"逐点列清楚"，但漏了两类会漏续的中断点

**依据**：`design.md:309` 自称「这是本设计里最容易出错的地方，逐点列清楚，实现时按这张表写断言」。缺的行：

1. **边界写失败后立刻崩溃**：`design.md:348` 说"写失败 → 内存仍正确，文件滞后，下一条边界自愈"——若"下一条"永远不来（进程死了），文件就缺这条 `open`，下次启动漏续。§7 表里没有这一行。
2. **关→开期间已在运行的轮次**：关态会 `purgeOwn` 掉条目（`design.md:298`），重新打开后"不补扫"（`design.md:549`、§16.1），因此该轮在索引里没有条目；若此时崩溃 → 漏续。§7 表里也没有这一行（C-G 只覆盖"卸载后进程继续跑"）。

两者都是保守方向的漏续，与设计"宁可漏续不可误续"的取向一致，但"完整性"是这张表自己宣称的性质，实现会照它写断言。
**建议**：补两行（结论都是"⚠️ 漏续、可接受，UI 明说"），或弱化"逐点列清楚"的表述并改为"已知中断点枚举（非穷尽）"。

---

## 范围外观察（不阻断本次判定，单独记录）

- **规格的安装前提与本机现状不一致**：`requirement.md:9` 称 0.1.0「已实现并装入 `web` profile」，但当前四个 profile（`web`/`acp`/`headless`/`sdk`）的 `package.json` 里都没有 `dsh-auto-continue` 依赖或 bundle，`node_modules/dsh-auto-continue` 均不存在；`dsh-auto-continue/HANDOFF.md:15` 自己记录「真机端到端 **未验证**」、`HANDOFF.md:123` 的验收项未勾。v0.2 设计不因此失效（0.1.0 的语义可从仓库源码核到，本文引用均以源码为准），但"既有正确性已确立"这一前提比规格陈述的弱，`G4` 的回归基准应当明确写"以 0.1.0 源码+检查脚本为准，而非线上实测"。
- **规格笔误**：`requirement.md:82` 写 `cosmoketry`，profile 中实际存在的是 `cosmokit`；设计 §18.1 M18 用 `cosmokit` 是**正确**的。这是规格错字，不是设计缺陷。
- **数字互不一致**：`requirement.md:89` 说 626 artifacts（`:14` 是 19.8 MB 那条），`dsh-auto-continue/HANDOFF.md:95` 实测 625。v0.2 已作废该判据（`design.md:593`），不影响本次判定。

---

## 已核对、**未**构成 finding 的关键断言（证明查过事实源）

| # | 设计中的断言 | 事实源与核对结果 |
|---|---|---|
| 1 | M1 `session/event` 是 post-commit、fire-and-forget、参数 `(session, event)`、观察者失败被隔离 | `dsh-session/lib/types/index.d.ts:53-63` 原文一致；`dsh-session/lib/index.js:1589-1601` 同步派发且逐监听者隔离。**成立** |
| 2 | 插件可用 `ctx.on('session/event')` 订阅（非 agent 作用域） | `dsh-session/lib/types/index.d.ts:26-30` 是对 `@deepseek-ai/cordis` 的 `Events` 增补；shipped `dsh-session-projection-cache/lib/index.js:293` 就是同一写法。**成立** |
| 3 | M3 `turn/start`/`turn/end` 是已知事件类型，事件带 `seq`/`time` | `known-event-types.js:78-79`；`types.d.ts:268,279`（SessionEventMap）；`SessionEvent` 含 `seq`/`time`（`types.d.ts:497-520`）。**成立** |
| 4 | M4 turn 边界交替，abort/error 也走 `finally` 补 `turn/end` | `dsh-agent-loop/lib/index.js:723-826`：`append('turn/start')` 后 `finally` 无条件 `append('turn/end')`，abort/error 分支同样走到 `finally`。**成立**（属对实现细节的依赖，设计已在 §9 明示） |
| 5 | M5 持久化不补崩溃尾巴；`interruptedTurnClosers` 对平衡日志返回空 | `dsh-session/lib/types/repair.js:187` → `openTurnClosers(events,{kind:'interrupted'})`，"empty when the log is already balanced"；`dsh-agent-loop/lib/index.js:1736-1740` 先 `read(0)` 再按需 `handle.append(closers)`。**成立**（引文文字非逐字，语义一致） |
| 6 | M6 恢复收尾不出现在 `session/event` 上 | `dsh-session/lib/types/index.d.ts:161` "Seed events never publish on `session/event`"；resume 用 `SessionPreparation.create(... seed:[...persisted,...closers])` 且 closers 走持久化句柄 `handle.append`（`dsh-agent-loop/lib/index.js:1740-1746`）。**成立** |
| 7 | M7 `agents.resume({resumeSessionId})`、`handle.agent.followup`、`whenIdle`、`ctx.agents.get(id)` | `dsh-agent/lib/types/index.d.ts:111-113`（ResumeAgentOptions）、`145-148`（AgentHandle{agent,dispose}）、`300`（resume）、`357`（get）；`dsh-agent-loop/lib/types/agent.d.ts:50,64`。0.1.0 用的是同一形状（`lib/index.js:234-243`）。**成立** |
| 8 | M8 会话对象可读身份与分类（`header.origin==='subagent'`） | `dsh-session/lib/types/types.d.ts:81-92,116-125`（`isSeeded`/`origin?:'subagent'`/`delegationDepth`）；`Session.header`/`get id`（`index.d.ts:154,158`）。**成立** |
| 9 | M9 服务名 `agents`/`sessions`；web profile 挂载了 session/agent/persistence/connection | `dsh-agent/lib/index.js:450 super(ctx,"agents")`；`dsh-session/lib/index.js:1748 super(ctx,"sessions")`；`dsh-base/cordis.patch.yml` 含 `session`/`agent`/`session-persistence-jsonl`/`session-projection`/`session-projection-cache`，`dsh-web-app/cordis.patch.yml` 含 `connection`/`webserver`。**成立** |
| 10 | M10 精确路由只有 owner Peer 可达；类型层写明 403 | `dsh-client-connection/lib/types/rpc.d.ts:126-131`；`dsh-client-connection/lib/index.js:830`（`peer.principal.kind !== "owner"` → 403）。**成立** |
| 11 | M11 `/api` interceptor 已被 `dsh-api-gateway` 占用，重复注册会抛 | `dsh-api-gateway/lib/index.js:790`；`dsh-client-connection/lib/index.js:873-885`（duplicate → throw `already has an interceptor`）。**成立** ⇒ 设计"只能走精确 Fetch 路由"成立 |
| 12 | M12 客户端 `rpc.call` 的信封与 URL 拼法 | `dsh-client-connection/lib/client.browser.js:1212-1226`：`{type:'client-request', rpcId, method: endpoint, payload}`，POST `${channel}/${endpoint}`.slice(1)；返回前校验 rpcId 与 `server-response`；失败态要求 `error.{code,message,details}`。设计 §13.1 的信封**逐字段正确** |
| 13 | 路由注册形状 `{path, methods, requestBody:'buffered', fetch}`、path 在 `/api` 之下 | `rpc.d.ts:119-141`；先例 `dsh-ability-strip/lib/index.js:117-123,560-565`（`/api/ability-strip`，POST，buffered）。**成立** ⇒ 设计 `ROUTE_PATH='/api/auto-continue'` 形态正确 |
| 14 | 端点名 `auto-continue` 合法 | `client.browser.js:1201-1202,1317`：channel `^/[A-Za-z0-9._~-]+$`、endpoint 段 `^[A-Za-z0-9_$.-]+$`（连字符允许）。**成立** |
| 15 | M20 `.volatile()` 依赖 schemastery 元数据；普通字段编辑会重启插件；官方禁止插件改写 profile 的 `cordis.patch.yml` | `cordis-plugin-loader/lib/index.js:387,412,513-535`（`schema?.meta?.volatile` / `equalExceptVolatile` / `_commitVolatile`；`volatileEntries` 来自 cosmokit）；官方 `host-plugin.md:68-77` 原文与设计 §16.3 引文一致。**成立** |
| 16 | 投影缓存：`turn/end` 必写但 fire-and-forget、先 `sessions.flush` 再落缓存、200 事件 / 5 s 节流 | `dsh-session-projection-cache/lib/index.js:293-316`、`265-269`（`await this.ctx.sessions.flush(session)` 在 `put` 之前）；`dsh-base/cordis.patch.yml:196-200`。**成立** ⇒ 机制 B 陈旧窗口论证成立 |
| 17 | 投影缓存读不回无 `wire` 的单元；`cachedSnapshot(meta: SessionHeader, keys)` | `dsh-session-projection/lib/index.js:367-373`（`if (def.wire === void 0) continue`）；`dsh-session-projection-cache/lib/types/index.d.ts:94`。**成立** ⇒ 机制 B 否决理由 1、2 成立 |
| 18 | storage-domain 的 spec 需要 zod | `dsh-storage-domain/lib/types/spec.d.ts:10,15,80,93`（`ZodType` / `domainTable` / `defineDomain`）；`open()` 的错误码 `backend-not-found`/`facet-unsupported`/`version-mismatch`/`invalid-record` 亦在 `lib/index.js:365-399`。**成立** ⇒ 机制 E 否决理由成立 |
| 19 | M16 JSONL 是"独立 zstd 帧拼接"，`list` 只读 header 帧 | `dsh-session-persistence-jsonl/README.zh.md:109-111`；崩溃尾巴语义见 `:77`。**成立** ⇒ 机制 C 否决、C5 遵守均成立 |
| 20 | M18 profile 里可解析的 `@deepseek-ai/*` 只有 3 个；zod 只是被 hoist | 实查 `%DSH_HOME%\profiles\web\node_modules\@deepseek-ai` → `cosmokit`/`dsh-web-search-exa`/`schemastery`；`profiles/web/package.json:4-15` 无 zod，但 `node_modules/zod` 存在（hoist）。**成立** ⇒ C1 的事实基础成立 |
| 21 | `DSH_HOME` 空/空白视为未设置，默认 `~/.dsh`；路径不写死本机 | `dsh-home-paths` 类型注释与 `resolveDshHome` 一致；设计 `resolveStatePath` 与 `INSTALL.md:858` 规定的公式一致（`process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')`）。**成立**（设计把"与 resolveDshHome 一致"限定在空白环境变量这一条，未过度声明） |
| 22 | M13–M15 以外：C2/C3 的客户端形态 | `dsh-client-ui-schedule/lib/client.js:1-6`（`window.__ModuleLoader__.load({id, factory})`）、`dsh-ability-strip/lib/client.js:31-39,383-392`（`require('react'/'react-dom')` 白名单、`inject` 列表）；`INSTALL.md:706-720`（官方口径与 15.3）。**成立** |
| 23 | H2 的 UI 形态：`sidebar.panellist.id` + `main.key` 同值构成可进入的宿主级页面 | `dsh-client-ui-schedule/lib/client.js:19360-19399`（`main` 用 `key: PANEL_ID`，`sidebar.panellist` 用 `id: PANEL_ID`）；`dsh-client-ui-layout/lib/client.js:713` 把 `main` 定义为 `{kind:'keyed', scope:'root'}`。设计只用这两个槽即可构成页面，规格 H2 里的 `sidebar.right.pane.tab` 是同一先例的"任务详情页"槽，不是页面可达性的必要条件。**成立** |
| 24 | `ctx.effect` / `ctx.inject` 的存在与签名 | `cordis/lib/types/fiber.d.ts:161-163`、`cordis/lib/types/registry.d.ts:111`。**成立** |
| 25 | A7 的可判定文本：`DEFAULT_PROMPT` 原样保留，含"其真实结果不可知"与"不要盲目重试" | 0.1.0 `lib/detect.js:41-50` 原文；`design.md:64` 的 I6 与之一致。**成立** |
| 26 | A7 的消息形状（`content[0].text`、`role:'user'`、`source.kind==='auto-continue'`、冻结）能通过会话日志的消息校验 | `dsh-session/lib/index.js:1194-1219`：`user/message` 对 `source` 只要求"非空 `kind` 字符串"，`content` 只要求是数组；0.1.0 `lib/index.js:118-125` 的冻结形状满足。**成立** |
| 27 | 0.1.0 的 `inject=['agents','sessionPersistence']`、会偶然续子智能体会话 | 0.1.0 `lib/index.js:72-75`；其 `rankRecent` 只按 mtime 排序、无 origin 过滤（`lib/index.js:163-182`）。**成立** ⇒ §15 差异表与 SQ-2 的事实基础成立 |
| 28 | `practice` 层面的偏离已记录：把日志派生状态放进投影单元 vs 本设计自建文档 | 官方 `practices.md:26` 原文与设计 §8 的引用一致；设计给出 3 条理由并留替换点（`design.md:330-336`），符合仓库 `INSTALL.md` §15"偏离须记录原因与代价"的纪律。**成立**（不构成 finding） |
| 29 | §3.3 的原子写（tmp + rename、无 fsync）与进程死亡失效模型自洽 | Node `fs.renameSync` 覆盖目标；设计把断电排除在承诺外并写明（`design.md:124,723`）。**成立**（R-6 已声明） |
| 30 | A1/A4 的"1 次定长读"在结构上成立 | `apply` 只 `ledger.load()` 一次；`runBoot` 复用已加载文档（`design.md:165,271-272`）；无常量以外的大小依赖。**成立** |

---

## 规格逐条覆盖核对（结论：无缺口）

| 规格条目 | 设计要求 | 核对结果 |
|---|---|---|
| G1 开关 | §10 G1 行、§13.1/§13.3 | 有对应机制；但 §13.3 的表述自相矛盾（见 M-1） |
| G2 可观测 | `StateView`（§13.1）三问 + 原因码 + 边界说明 | 覆盖；但 B-1 会让 `tails[].state` 说谎 |
| G3 不事后重推导 | §6.2 启动路径、§9 备选淘汰、§10/§18.2 | 结构成立，无 `sessionPersistence` 路径，无常量以外读取 |
| G4 既有语义不退化 | §10 G4 行、§15 差异表 | 判据/消息/live/一次启动一次均保留；"只续开放尾巴"被 B-1 的误记为 closed 破坏 |
| A1–A8 | §11 逐条 + §21 第 1–3 层断言 | 均有可判断言；A3 行文自相矛盾（m-4）、A8 与 `parseState` 互斥（m-5） |
| C1–C6 | §12 逐条 | 与事实源一致（见上表第 9、19、20、22 行） |
| H1–H4 | §10/§14/§17 | 覆盖；H2 的页面形态按先例成立 |

---

## 放行条件（下一版必须做到）

1. **修 B-1**：删除 `noteResumeClosed` / `by:'resumed'` 与 §7 C-D/C-E 基于"清账"的分析；改由可观察边界记账，并在 §21 第 2 层加"resume+followup 之后状态必须为 open"的断言。
2. **修 M-1**：把 `active` 写成"单一判据函数 + 运行期布尔，只在 apply 与 setEnabled 成功落盘后赋值"，并明确落盘失败不改 `active`。
3. 把 m-1…m-7 并入设计的 open-items（或直接在 §3/§4/§7/§11/§17 里改掉）。其中 m-5 与 m-6 最好在实现前定死，因为它们直接决定 `parseState` 的分层与开关的失败方向。
4. 重新自检 §18.3 的"是否有未验证的推断被当成事实：无"——本轮的 B-1 正是一条未被验证的推断（"clear 时状态仍为 open"），自检表不应当给出"无"。

---

## 评审方法与限制（如实）

- 只读检查：两份文档、`INSTALL.md`、`0.1.0` 源码与 `HANDOFF.md`、`dsh-ability-strip` 宿主/客户端先例、DSH 安装树（`lib/*.js`、`lib/types/*.d.ts`、`README.zh.md`、`cordis.patch.yml`）、profile 目录与四个 profile 的 `package.json`。
- 未运行任何被审查代码（v0.2 尚不存在），未启动 Host，未安装/打包任何东西，未执行测试，未修改 `design.md`/`requirement.md` 或任何其它文件。本文是本次唯一写入的文件。
- B-1 的结论来自 shipped 代码的同步调用链（`append` → `commit` → 同步观察者；`followup` → `wakeDriver` → `withInitiator` → `kick` → `turn` → `append('turn/start')`），不是运行期观测；同一链路上的每一步都已给出文件与行号，可独立复核。未实测的部分只有"真实崩溃是否按此路径发生"，那一步与本文结论无关。
- 未核实项（明确标注"未能证实"）：`setTimeout(runBoot, delayMs)` 与 `ledger` 的同步写在真实 Windows 磁盘上的耗时（设计 §20 R-1 已把它列为实现阶段测量项，本文不据此判缺陷）；断电场景（设计已明文排除）。