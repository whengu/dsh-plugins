# code-001 — dsh-auto-continue v0.2 独立代码评审

- 评审角色：独立代码评审者（非实现者）
- 日期：2026-11-17
- 对象：`dsh-plugins/dsh-auto-continue/`（6 个冻结文件）
- 依据：`docs/auto-continue/requirement.md`、`design-final.md`；DSH 安装树 `0.2.2-rc.1` 各包 README.zh.md / lib/*.js；范本 `dsh-ability-strip/lib/{index,client}.js`
- 方法：**静态走读 + 调用链/数据流/生命周期/契约推演**。未运行被审查代码、未运行 `pnpm check` / `node scripts/check.mjs`，未构造输入实测。实现者自报的断言 PASS 不作为正确性证据。

## 冻结哈希核对（第一步，已通过）

6 个文件 SHA256 与给定值**逐一完全一致**，无不符，评审继续：

| 文件 | 结果 |
|---|---|
| lib/frames.js `4B098F17…A2A250` | 一致 |
| lib/detect.js `D7CA5C48…E36E36` | 一致 |
| lib/boot.js `1AD9FE75…D0F7` | 一致 |
| lib/index.js `C5169C13…2CB9F32` | 一致 |
| lib/client.js `B09D79CF…926FC` | 一致 |
| scripts/check.mjs `081318A2…7B441` | 一致 |

---

## 结论

**打回 — NOT_READY（含 1 个 BLOCKER）**

- BLOCKER：1
- MAJOR：0
- MINOR：3

存在一处确凿的正确性缺陷：续跑消息（`continuationMessage()`）是一个**没有 `id` 的手工 user 消息**，经 `followup` 写入会话日志后，会在下一次启动冷读该会话时被持久化层判定为损坏事件，使该会话永久无法读取/续跑——与插件“崩溃续跑”的目的完全相反。按判定规则，有 BLOCKER 即打回。

---

## Findings

### F-01 [BLOCKER] 续跑消息缺少 `message.id`，使被续跑的会话日志在下次冷读时判定为损坏

- **位置**：`lib/index.js` 的 `continuationMessage()`（约 68–74 行）；该对象经 `lib/boot.js` 的 `runBoot` Phase 2 的 `handle.agent.followup(makeMessage()...)`（约 153 行）进入会话。
- **问题是什么**：插件手工构造 `{ role:'user', content:[...], source:{kind:'auto-continue'} }`，**没有 `id` 字段**。`source.kind` 的自定义合法性没问题（见第 4 点），缺的是消息身份 `id`。
- **为什么是问题（证据链）**：
  1. 类型契约：`UserMessage` 要求 `readonly id: MessageId`（`dsh-llm/lib/types/message.d.ts:124-132`、`:144-146`）。`Agent.followup(message: UserMessage)` 同（`dsh-agent/lib/types/runtime-types.d.ts:219`）。
  2. 唯一补齐 `id` 的入口是 `createUserMessage` → `createMessage`，后者注入 `id: brandString(randomUUID())`（`dsh-llm/lib/index.js:37-41`、`:59-64`）。**所有生产调用方都用 `createUserMessage()`**：`dsh-api-session-controller/lib/index.js:851`、`dsh-sdk-jsonrpc-server/lib/index.js:512`、`dsh-headless/lib/index.js:361`、`dsh-goal-round-driver/lib/index.js:144`、`dsh-schedule/lib/index.js:1391` 等。
  3. 写入路径不补 id：`followup(input)→send(...,"next-turn",true)→inbox.splice→session.append("user/message", message, {surfaceOp:"append"})`（`dsh-agent-loop/lib/index.js:570-572`、`:564-568`、`:865`），全程不调用 `createMessage`；收件箱投影与 mutate 的重复检查也以 `message.id` 为键（`:43`、`:186`）。
  4. 冷读强制校验：`user/message` 事件必须携带非空字符串 id。`dsh-session/lib/index.js:1194-1205` 的 `assertMessageEventShape` 在 `typeof message["id"] !== "string" || message["id"] === ""` 时抛 `lacks an identified message`；`dsh-session-persistence/lib/index.js:182-195` 的 `validateStoredEvents` 对每个事件调用 `adoptSessionEvent`（`dsh-session/lib/index.js:1086-1089`），后者无条件调用该断言；JSONL 后端的冷读必经此路（`dsh-session-persistence-jsonl/lib/index.js:2834-2844`、`:2876`）。
- **可推导的执行路径**：本次启动 boot 续跑 → followup 写入一条无 id 的 `user/message` → 当前进程内存态不校验 id，看似成功 → 下次进程启动、boot 再次对该会话 `ctx.agents.resume()` → `persistence.open(id,"write")` → `handle.read(0)` → `readStoredLog` → `validateStoredEvents` → `assertMessageEventShape` 抛错 → `SessionPersistenceCorruptionError` → 该会话不可再被读取/续跑，连正常会话控制器也打不开。**结果是把“可崩溃续跑”的会话变成“永久损坏”的会话。**
- **对反证的裁决**：`dsh-agent/README.zh.md:61-64` 的示例确实也省略了 `id`（同时省略了 `role`）。但该示例是简化伪代码，与类型契约、无条件运行时校验、全部生产调用方三者的强证据冲突；它不足以推翻“id 必填”。T1 禁止 `import '@deepseek-ai/*'`，但并不阻止插件用 `node:crypto.randomUUID()` 自行生成 id——即实现者有能力在不违反 T1 的前提下满足契约。
- **影响**：阻断。建议方向（不在本评审实现）：按 `UserMessage` 契约补齐 id 与 source 字段，并让注入测试覆盖真实 `continuationMessage()` 的持久化可接纳性；具体修法由实现者决定。

### F-02 [MINOR] 注入测试用玩具消息覆盖真实实现，无法发现 F-01

- **位置**：`scripts/check.mjs` 的 `stubCtx` deps `continuationMessage`（约 188 行）与“5. prompt”段（约 300–307 行）。
- **依据**：stub 返回 `{role:'user', text:'hint'}`，只 `push` 进数组，从不进入持久化/投影校验；prompt 段只断言文本子串与 `role`，从不校验 `id` 或消息形状。因此“60 断言 PASS”在结构上不可能发现 F-01——注入层把最关键的落地契约整个 stub 掉了。

### F-03 [MINOR] 恒真式断言：`result.candidates`

- **位置**：`scripts/check.mjs:244`：`check('boot: result.candidates lists a session that needed a second check', Array.isArray(result.candidates))`。
- **依据**：`runBoot` 中 `result.candidates = needContinue.map(...)`（`lib/boot.js:126`）恒为数组；该断言不涉及任何内容，属自证式/恒真式，无法发现 candidates 语义回归。

### F-04 [MINOR] 尾部读取字节上界断言只验证传参，未验证实际 `fs.read` 上界

- **位置**：`scripts/check.mjs:237`（检查 `readTails.every(r => r.window === 64*1024)`）配合 stub `readTail`（约 182–187 行）。
- **依据**：stub `readTail` 忽略 `window`、直接返回固定 buffer，断言只证明“把 64KB 传下去了”，不证明“实际读取 ≤64KB”。真正的上界在 `defaultReadTail`（`lib/boot.js:35-47`）的 `Buffer.alloc(length)`（length ≤ window），**静态审读该实现是正确的**；此处记为测试覆盖缺口（MINOR），非代码缺陷。

---

## 已核对但未成 finding 的关键断言（8 点逐条）

1. **帧定位与尾部解码（frames.js）— 通过，无 finding。**
   `scanZstdFrames`（`frames.js:44-90`）与权威实现（`dsh-session-persistence-jsonl/lib/index.js:1305-1368`）逐项一致：magic 4 字节、descriptor 保留位检查、contentSize  flag/单段/dictionary 派生、3 字节 block header（lastBlock/blockType/blockSize，RLE=1 字节）、校验和 4 字节、`maxFrames`。无 content-size 帧由 block 遍历定位，正确。差异仅在非 magic 处：DSH 抛错，插件返回 `tornStart`——这是为 tail 窗口候选扫描做的合理适配。`decodeTailFrames` 的候选策略（试每个 magic，取完整帧数最多、优先干净到 EOF、平局取更早起点）成立：真起点会沿 block 头 walk 跳过帧内巧合 magic 并产出 N 个完整帧，而压缩数据内巧合 magic 最多误产出 ≤1 个结构帧，无法在帧数上胜出；残缺首帧与 torn 尾帧均被正确忽略；事件按帧序返回、`lastTurnBoundary` 取最后边界。“巧合 magic 误切”属理论极低概率，标“未能证实”，不阻断。`check.mjs` 的 torn/no-size/partial-prefix/bogus-magic 断言与上述推演一致。

2. **发现流程（boot.js）— 通过，无 finding。**
   `list → 无 location 跳过 → stat mtime → rankRecent(N) → live 跳过 → 尾部读 → detect → 二次 live → resume → ownership → followup` 顺序与规格一致（`boot.js:79,91,94,101,107,113-114,120,131,137,148,153`）。单会话失败隔离到位：list(:78-83)、readTail/decode(:112-119)、resume(:136-142)、followup(:152-158) 各自 catch 并记 skipped。尾部读字节上界由 `defaultReadTail` 保证（见第 7 点/实现正确），N 之外不读（仅遍历 `recent`），结果仅存内存 `state.lastScan`（`index.js:116`）无落盘。`rankRecent` 丢弃无有限 mtime 项（`detect.js:60-66`）符合规格。

3. **续跑语义（boot.js/index.js）— 流程正确，但承载本评审 BLOCKER（F-01）。**
   `agents.resume` + `followup` 两步 ✓；插件不自行 append 日志/补 closers ✓（DSH 在 `dsh-agent-loop/lib/index.js:1739-1740` 用 `interruptedTurnClosers` 补）；handle 收集进 `handles` Set 并在 disposer 中 dispose ✓；ownership 校验 `ctx.agents.get(id) !== handle.agent`（`boot.js:148`）正确——`agents.resume` 在工厂发布（enter+announce，`dsh-agent-loop:1578-1579`）之后才 resolve（`dsh-agent/lib/index.js:595-600`），`get(id)` 返回 live agent（`:725-726`），正常情形下必相等，竞态被正确挡下。**但 followup 所传消息本身非法（F-01）。**

4. **提示词（index.js）— 通过，无 finding。**
   `CONTINUATION_TEXT`（`index.js:47-55`）满足用户 5 项要求：系统自动注入/非用户指令、仅供参考、交回模型判断、不重复执行、对结果不明工具调用先核实不盲试。`source.kind='auto-continue'` 自定义合法——存储校验对 user 消息只要求 kind 非空字符串（`dsh-session/lib/index.js:1204-1205`），且 merge-extensible 无统一 `plugin` kind（`dsh-llm/lib/types/message.d.ts:95-108`）。`source.kind` 无问题；问题仅在缺 id（F-01）。

5. **UI 与路由（client.js/index.js）— 通过，两端能对上，无 finding。**
   lazy-CJS 表单 ✓（`window.__ModuleLoader__.load({id,factory:(require)=>...})`）；不 require 任何 `@deepseek-ai/*`（仅 `react`）✓；只用 `--dsw-alias-*` token（`client.js:28-34`，无其他 CSS 变量）✓；无开关控件 ✓。owner-only 由载体硬保证：非 owner 返回 403（`dsh-client-connection/lib/index.js:826-832`）。**method/envelope/endpoint 闭环成立**：client `rpc.call('/api','auto-continue/status')`（`client.js:37-44`）发 `POST /api/auto-continue/status`，envelope `{type:'client-request',rpcId,method:'auto-continue/status',payload}`（`client.browser.js:1212-1232`）；host `fetch.register({path:'/api/auto-continue/status',methods:['POST']})`（`index.js:150-165`）经 `registerFetchRoute/assertFetchRoute`（`dsh-client-connection:840-853,973-977`）注册，shared handler 按 pathname 命中（`:826-832`）；返回 `result.ok/value` 被 client 正确读取（`client.js:44-52` ↔ `index.js:159-163`；`client.browser.js:1288-1313`）。

6. **注入与生命周期 — 通过，无 finding。**
   `inject=['agents','sessionPersistence']`（`index.js:30`）为真实服务名（`dsh-agent`、`dsh-session-persistence/lib/index.js:265` 注册为 `ctx.sessionPersistence`）；`ctx.get('connection')` 可选取用（`index.js:144`）与范本同款；effect disposer 清 timer（`clearTimeout`）+ 注销路由 + dispose 全部 handles + `handles.clear()`（`index.js:171-185`）完整；无 config 开关（`check` 亦断言无 `config.enabled`）。`handle.dispose()` 只停循环/注销 live session/关闭写句柄，不删除持久化 artifact（`dsh-agent-loop:1475-1504`），因此卸载插件不会误删用户会话。

7. **注入测试有效性（check.mjs）— 部分覆盖，见 F-02/F-03/F-04。**
   帧/detect/boot 流程断言有实质行为覆盖（合成 zstd、stub ctx 计数）；但真实 `continuationMessage()` 的持久化可接纳性从未被验证（F-02），存在恒真断言（F-03），字节上界只验传参（F-04）。

8. **规格偏离：路由从设计字面 `/auto-continue/status` 改为 `/api/auto-continue/status` — 理由成立，无 finding。**
   `assertFetchRoute`（`dsh-client-connection:973-977`）要求 `endpointFromPath('/api', route.path)` 非 `undefined`；`endpointFromPath`（`:926-931`）要求 `pathname.startsWith('/api/')`。设计字面的 `/auto-continue/status` 会直接抛错“invalid exact Fetch route”。实现者所报理由是**真实成立**的；且该改法与范本 `dsh-ability-strip` 的 `${ROUTE_CHANNEL}/${ROUTE_ENDPOINT}` = `/api/ability-strip`（`dsh-ability-strip/lib/index.js:116-123,560-565`）一致。属有据依的合理偏离，不构成 violation。

---

## 对实现者声明的裁决

- **“零已知阻塞问题” — 不成立，予以否决。** F-01 是经类型契约、无条件运行时校验、全部生产调用方、以及完整写入/冷读路径共同确证的 BLOCKER，不是疑点。
- **“`pnpm check` 60 断言 PASS” — 不接受作为正确性证据。** 如 F-02 所示，注入测试把真实续跑消息替换成玩具值并绕过持久化/投影校验，结构上无法触达 F-01；断言通过只说明被覆盖的那些合成路径符合预期，不能证明续跑写入的消息可被持久化层接纳。按 code-review-static 纪律，测试通过不构成 Review 通过条件。

---

## 评审边界与不确定性

- 未运行任何被审查代码或测试；以上结论均为静态推演，附出处与行号，可由阅读复现。
- 唯一的反证来源是 `dsh-agent/README.zh.md:61-64` 的省略 id 示例；已在 F-01 中明确裁决（示例为简化伪代码，弱于类型契约与运行时校验）。若技术负责人依据该 README 持不同判断，应就“`followup` 是否在任何路径上补 id”做最小验证后再行裁定；在此之前，按证据优势维持 BLOCKER 判定。
- 未引入审美或新维度；除 F-01 外，其余设计要点（帧移植、发现流程、ownership、提示词语义、路由闭环、生命周期、路由前缀偏离）均核对通过。
