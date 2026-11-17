# code-002 — dsh-auto-continue v0.2 返工复审（独立判定）

- 评审角色：独立复审者（非实现者、非上一轮评审者在同一结论上的背书）
- 日期：2026-11-17
- 对象：`dsh-plugins/dsh-auto-continue/`（返工后冻结代码）
- 上一轮：`reviews/code-001.md`（NOT_READY：1 BLOCKER F-01 + 3 MINOR F-02/F-03/F-04）
- 依据：`docs/auto-continue/requirement.md`、`design-final.md`；DSH 安装树 `0.2.2-rc.1`（`dsh-llm`、`dsh-brand`、`dsh-util-crypto`、`dsh-util-values`、`dsh-session`、`dsh-session-persistence`、`dsh-agent-loop`）
- 方法：**静态走读 + 调用链/数据流/类型契约/生命周期推演**。未运行被审查代码、未运行 `pnpm check` / `node scripts/check.mjs`、未构造输入实测；实现者自报的断言 PASS 不作为正确性证据。测试代码仅作静态材料阅读。

## 第一步：冻结哈希核对（已通过）

开工前自行计算 SHA-256，与给定值逐一完全一致，无不符，复审继续：

| 文件 | 冻结哈希 | 结果 |
|---|---|---|
| lib/index.js | `A8187651…ADCF79`（全值 `A81876516C9DCDB0C3614010E998A7EC850C44986ECAA4C8207198BAFCADCF79`） | 一致 |
| lib/boot.js | `856EAD3A…4B5229`（全值 `856EAD3A1596E1DFE682B10096D0C36306CC1656ECBFB8BBF6B62DFEA34B5229`） | 一致 |
| scripts/check.mjs | `23FEDF91…C5792`（全值 `23FEDF91A76F6366DA5D30041FF04FAA4EF3EA1D4E6B9343FF47FC7C9A9C5792`） | 一致 |
| lib/frames.js | `4B098F17…A2A250`（全值 `4B098F1728095BC1C3B84DD0FF0A61CAB884B0038E9B53F56F253E7507A2A250`） | 一致（未改） |
| lib/detect.js | `D7CA5C48…E36E36`（全值 `D7CA5C48988A13386BAE882CF8AC467BF4D687916CF67EBD6F7945CE0C359E36`） | 一致（未改） |
| lib/client.js | `B09D79CF…926FC` | 一致（未改） |
| package.json | `FEF50DBF…3CF3D1C953` | 一致（未改） |
| cordis.patch.yml | `5B7948C1…B1D07F69141` | 一致（未改） |

返工只触及 `index.js`、`boot.js`、`check.mjs` 三个文件；`frames.js`/`detect.js`/`client.js`（上一轮已判通过的部分）哈希未变，按复审范围约定不重开。

> 本文件中机读位置（函数锚点 + 行号）均指上述冻结哈希所固定的这一份快照，可用哈希复核复现；语义结论以函数/符号锚点为准，不随后续改动失效。

---

## 结论

**PASS — 零 finding。**

- BLOCKER：0
- MAJOR：0
- MINOR：0

上一轮 4 项 findings（F-01~F-04）**逐条闭环**；返工未引入新的硬伤。下列闭环判定均由 DSH `0.2.2-rc.1` 源码静态推演支撑，附出处与链路，可阅读复现。

---

## 闭环核对表（F-01 ~ F-04 逐条）

### F-01 [上一轮 BLOCKER] — **闭环**

**改动位置**：`lib/index.js` 的 `continuationMessage()`（冻结快照 79–86 行）与顶部 `import { randomUUID } from 'node:crypto'`（24 行）；`PRODUCER` 常量（60 行）。

**改动内容**：`continuationMessage()` 现返回
```
Object.freeze({
  id: randomUUID(),
  role: 'user',
  content: Object.freeze([Object.freeze({ type: 'text', text: CONTINUATION_TEXT })]),
  source: PRODUCER,               // Object.freeze({ kind: 'auto-continue' })
})
```

**同构性核对（对照 DSH `createUserMessage`）**：

1. **id 值形态**：DSH `createMessage`（`dsh-llm/lib/index.js:37-42`）注入 `id: brandString(randomUUID())`；`brandString` 运行时恒等（`dsh-brand/lib/index.js:20-22`，函数体仅 `return value;`），故线上值就是 DSH `randomUUID()` 的输出——标准 v4 UUID 字符串（`dsh-util-crypto/lib/index.js:27-33`，形如 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`）。`node:crypto.randomUUID()` 返回同一规范 v4 UUID 字符串（Node 官方 API 行为），为非空字符串、含连字符、36 字符。**值形态一致**。
2. **深冻结**：DSH 用 `deepFreeze(structuredClone({...}))`；插件对本对象图的每个可达对象节点显式 `Object.freeze`：顶层对象、`content` 数组、`content[0]` 块、`source`（`PRODUCER`，已冻结）。字符串子节点无需冻结。逐个节点比对 `dsh-util-values/lib/index.js:809` 的 `deepFreeze` 遍历结果——对本形状二者产出的冻结图完全等价。`structuredClone` 的作用是脱离共享引用；插件每次调用新建对象字面量，唯一共享子对象是冻结的 `PRODUCER`，不可变故无别名风险。**冻结语义等价**。
3. **role 契约**：`role: 'user'`，与 `MESSAGE_ROLE_BY_TYPE["user/message"] = "user"`（`dsh-session/lib/index.js:1189`）及 `assertMessageEventShape` 的 `messageRecord["role"] !== expectedRole` 校验（:1203）一致。
4. **source 契约**：`source.kind = 'auto-continue'` 为非空字符串，满足 `:1205`（`typeof source === object && typeof source.kind === string && source.kind !== ""`）；`validateSessionEventData`（:242-262）对 text 块无 tool-addition/removal 约束，不触发 developer-role 分支。
5. **content 契约**：`content` 为数组，满足 `:1206`（`Array.isArray(content)`）。

**能否让 `assertMessageEventShape` 通过的链路推演**：
- `followup(input)` → `send(input,"next-turn",true)` → `inbox.splice`（`dsh-agent-loop/lib/index.js:570-572`、`:567`）→ 写入 `agent/inbox/spliced` 事件（`mutate`，:174-201）；该事件类型非 message event，`isMessageEventType` 返回 false，`assertMessageEventShape` 早退（:1195-1196）。
- 下一轮 `preStep` 从 inbox `claim` 出该消息（:670），进入 `decision.messages`，最终 `session.append("user/message", message, {surfaceOp:"append"})`（:865）。
- 冷读：`validateStoredEvents`（`dsh-session-persistence/lib/index.js:182-196`）→ `adoptSessionEvent`（`dsh-session/lib/index.js:1086-1103`）→ 无条件 `assertMessageEventShape`（:1089）。对 `user/message`，校验对象即 `event.data`（:1199 `message = record`），也就是上面构造的对象：id 非空字符串 ✓、role='user' ✓、source.kind 非空 ✓、content 数组 ✓ → 全部通过，不再抛 `lacks an identified message`，`SessionPersistenceCorruptionError` 路径被切断。
- 冻结对象进入持久化不产生新问题：`adoptSessionEvent:1091-1093` 对 `user/message` 主动 `deepFreeze(event.data)`，对已冻结对象重入是无害 no-op；DSH 自身即以冻结消息发布（`createUserMessage`→`deepFreeze`），持久化层本就设计为接收冻结消息。

**T1 约束**：`node:crypto` 属 `node:*`，非 `@deepseek-ai/*`；遵守 T1。`check.mjs:317` 的静态断言也验证了 index.js 无 Harness import。

**判定**：F-01 真正闭环。BLOCKER 解除。

### F-02 [上一轮 MINOR] — **闭环**

**改动位置**：`scripts/check.mjs` 的 `stubCtx`（冻结快照 146–196 行，关键在 166、189–191 行）与 boot 段 followup 断言（253–256 行）。

**改动内容**：
- 第 26–34 行从 `../lib/index.js` 导入真实 `continuationMessage`；stubCtx 的 `deps.continuationMessage` 由上一轮的玩具 stub（`{role:'user',text:'hint'}`）改为**真实函数引用**（:189-191）。
- `boot.js:71` 的 `makeMessage = deps.continuationMessage`，`boot.js:153` 的 `handle.agent.followup(makeMessage ? makeMessage() : undefined)` 因此把**真实消息对象**送进 stub 的 followup（stub :166 `followed.push({id, msg})` 记录）。
- 新增断言：`:255` 验 `msg.role === 'user' && Array.isArray(msg.content) && msg.source.kind === 'auto-continue'`；`:256` 验 `run.followed.length === 2 && 每条 msg.id 为非空字符串`；`:342` 验两次调用 id 不同（fresh identity）。

**可判失败性核对**：
- 若 boot.js 未调用 makeMessage（如 deps 缺失导致传 `undefined`），`f.msg?.role` 为 undefined → `:255` 失败。
- 若 `continuationMessage` 回归为缺 id / id 非字符串 / 空 id，`:256` 失败（`assertMessageEventShape:1200` 的同一不变式）。
- 若角色或 source 退化，`:255`/`:338`/`:339` 失败。
- 若 id 变成常量，`:342` 失败。

因此断言是**真实可失败的内容断言**，结构上已能发现 F-01 这一类回归；不再存在“玩具消息绕过真实实现”的缺口。stub 只在 Host 边界记录消息，消息本体来自生产函数，符合注入测试的正当形态。

**判定**：F-02 闭环。

### F-03 [上一轮 MINOR] — **闭环**

**改动位置**：`scripts/check.mjs:248`。

**改动内容**：上一轮 `check('...', Array.isArray(result.candidates))` 恒真断言，改为
```
check('boot: result.candidates exactly lists the open tails beyond the first check',
      result.candidates.join(',') === 'open-1,open-2', JSON.stringify(result.candidates))
```

**可判失败性核对（内容推演）**：`result.candidates = needContinue.map(e => e.id)`（`boot.js:126`）。在该用例中 recent=4、按 mtime 取 open-1/closed-1/live-1/open-2（pending-1 无 location 被 :91 过滤，old-open 排第 5 被 N 截断）；Phase 1 仅 open-1、open-2 的 OPEN_TAIL 边界为 turn/start → needContinue；故 candidates 精确等于 `open-1,open-2`。若混入 closed-1/live-1 或漏掉 open-2，断言即失败。已从“只验类型”变为“验内容”。

**判定**：F-03 闭环。

### F-04 [上一轮 MINOR] — **闭环**

**改动位置**：`lib/boot.js:35`（`export async function defaultReadTail`）与 `scripts/check.mjs` 的 3b 段（:283–308）。

**改动内容**：
- `defaultReadTail` 已**导出**（`export` 关键字在位），`check.mjs:26` 成功导入。
- 3b 段 `mkdtemp` 建临时目录 → 写 256KB（4×64KB）文件、末字节置唯一标记 `0x5a` → 在 `try/finally` 中调用真实 `defaultReadTail` 并断言：
  - `:300` `tail.length === window`（64KB）——断言只读 window 字节；
  - `:301` `tail[tail.length-1] === 0x5a`——断言取的是**文件尾部**（非头部/中部）；
  - `:304` window=1MB 时 `whole.length === size && 末字节 === 0x5a`——断言**不超文件尺寸**；
  - `:306` `finally` 中 `rm(dir,{recursive:true,force:true})` 清理。

**可判失败性核对**：这些断言直接检查真实函数返回值，而非像上一轮那样只验传给 stub 的 `window` 参数。对 `defaultReadTail` 的实现（:35-47：`start = max(0, size-window)`、`length = size-start`、`Buffer.alloc(length)`、`file.read(...,start)`）逐条推演均与断言一致，且任一回归（读全文件、读头部、越界）都会使相应断言失败。

**判定**：F-04 闭环。

---

## 返工新硬伤

**无。** 逐项核对返工动作本身：

1. **randomUUID 用法**：`node:crypto.randomUUID()` 在 Node 24（本机 `v24.18.1`）为内置 API；命名 ESM 导入形式正确；输出与 DSH 自产 id 同形态（v4 字符串）。无问题。
2. **冻结对象**：对已冻结对象再 `Object.freeze`/`deepFreeze` 是 no-op 不抛错；消息对象图全部节点已冻结，无遗漏可变子节点；持久化层设计为接收冻结消息。无问题。
3. **导出面**：新增 `defaultReadTail`（boot.js）与 `continuationMessage`（index.js）导出均为**追加式**，不改动 loader 识别的 `name`/`inject`/`apply` 契约，不影响插件加载。无问题。
4. **临时文件测试清理**：`mkdtemp` 在 `os.tmpdir()` 下、`try/finally` 中 `rm(...,force,recursive)`，即便断言异常也执行清理；`check.mjs` 的写文件仅限测试脚本自身，静态断言 `:316` 只扫描 `lib/*.js`（插件本体不写文件约束 A5 不被破坏）。无问题。
5. **check.mjs 自身健壮性**：`check()` 只记录失败不抛出，其余用例继续执行；3b 段无未闭合资源（文件句柄由 `defaultReadTail` 的 `finally` 关闭，:44-46）；新增断言均为可选链安全访问。无问题。

---

## 核对过但未成 finding 的关键断言清单

1. **`id` 形态与 `brandString` 恒等**：`dsh-brand/lib/index.js:20-22` 函数体 `return value;` 确证运行时恒等；`dsh-util-crypto:27-33` 与 `node:crypto.randomUUID()` 同为规范 v4 UUID 字符串。`assertMessageEventShape:1200` 仅要求非空字符串，二者均满足。未成 finding：满足且同构。
2. **`role`/`source.kind`/`content` 契约**：逐条对照 `dsh-session/lib/index.js:1194-1219` 与 `:242-277`，均通过。`source.kind='auto-continue'` 的合法性上一轮已判通过（存储仅要求非空 kind），本轮未改该语义。
3. **深冻结等价性**：对照 `dsh-util-values:809` 的 `deepFreeze` 对本对象图的遍历，插件的显式 `Object.freeze` 覆盖全部对象节点，等价。未成 finding：无遗漏。
4. **共享冻结 `PRODUCER` 单例**：所有 `continuationMessage()` 共享同一冻结 source 对象，与 DSH `structuredClone` 每次克隆 source 不同；因对象不可变、序列化按值处理，行为等价，不影响身份/持久化/去重。未成 finding：不可变共享无害。
5. **`:342` id 唯一性为概率性**：`randomUUID()` 加密随机，碰撞概率可忽略；作为“fresh identity per message”断言是标准做法。未成 finding。
6. **check.mjs 未字面调用 `assertMessageEventShape`**：只读静态材料后判定——`:255`/`:256`/`:337-340` 已镜像冷读强制的全部不变式（id 非空串、role、source.kind、content 数组），足以发现 F-01 类回归；不要求注入测试字面调用 DSH 内部函数。未成 finding：覆盖充分。
7. **写入/冷读完整链路**：`followup`→`send`→`inbox.splice`→`user/message append`→`validateStoredEvents`→`adoptSessionEvent`→`assertMessageEventShape` 全链已走读（出处见 F-01），冻结消息在各节点均无异常路径。未成 finding。
8. **未重开项**：帧移植、发现流程、ownership、提示词语义、路由闭环、生命周期、`/api/` 前缀理由——相关文件哈希未变（frames/detect/client）或返工仅追加导出与消息构造（index.js 未触碰这些语义），按复审范围约定不重复审，上一轮通过结论维持。

---

## 复审边界

- 未运行任何被审查代码或测试；以上结论均为静态推演，附出处与行号，可由阅读复现。
- 本轮结论不依赖实现者自报的断言 PASS；断言 PASS 未被当作正确性证据。
- 结论形态：**PASS（零 finding）**。
