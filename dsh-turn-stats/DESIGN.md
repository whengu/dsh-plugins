# 设计方案：dsh-turn-stats

> 规格来源：[REQUIREMENTS.md](REQUIREMENTS.md)。基线 dsh `0.2.2-rc.1`、profile `web`。
> 本文写实现方案与口径定义；需求本身以 REQUIREMENTS.md 为准。
> ⚠️ **本文写于 v1（轮口径），v2 的改动集中在 §1 决定表、§2.1、§3.1、§5、§7、§9**；其余章节（前端顶替、依赖纪律、外观材料）两版通用。

## 1. 已确认的产品决定

| 议题 | 决定 | 出处 |
|---|---|---|
| 统计范围 | **最近一次模型调用**（v2）。v1 曾是「当前轮次」，因一轮可能持续极久而废弃 | 用户 11-11 提出并确认（REQUIREMENTS §6） |
| 更新时机 | **该次调用结算时**（v2）。v1 曾是 `turn/end` 定格 | 同上 |
| 是否同时保留「本轮累计」 | **不保留**。同一份 state 存两套值会让 pill 显示哪个、title 显示哪个都变成新问题，且要留着那套跨调用累加器 | 用户选简（"越复杂 bug 越多"） |
| 空态 | **显示上一次调用的值**；一次都没有时整颗不显示 | 用户确认（v1 定下，v2 沿用，仅把"上一轮"换成"上一次调用"） |
| ~~「本轮」边界~~ | v1 遗留概念，v2 不再按轮折叠；`turn` 字段仍随值下发，只作定位与对表用 | REQUIREMENTS §6 |
| 速率分母是否含工具耗时 | **不含**。分子分母都只算解码墙钟，与宿主现有 tok/s 同口径 | 对齐宿主 |

## 2. 口径定义（与宿主逐项对齐，不发明新算法）

> **v2 只改求和范围**：下面两式里的「本轮」在 v2 一律读作「**最近一次模型调用**」。算式、helper、格式化函数一个都不换——v1 本来就是把每次调用算出来再跨调用求和，v2 是**去掉那一步求和**。所以口径对齐的证据（下引宿主行号）对两版同样有效。

### 速率

`最近一次调用 decodeTokens ÷ (该次 decodeMs / 1000)`  （v1 口径：把一轮内各次调用的分子分母先各自求和再相除）

逐步规则与宿主 `sessionStats` 的 fold **完全一致**（`dsh-session-stats/lib/types/projection.js:96-119`）：

- `step/start` 开边界，记 `startTime`；
- `assistant/attempt` 可补记首 token 时刻（失败尝试也可能已吐字）；
- `assistant/message` 关闭该步：`decodeMs = max(0, event.time - firstToken)`，**仅当该步 usage 报了 `outputTokens`** 才同时累加 `decodeMs` 与 `decodeTokens`；
- `firstToken` 取 `openStep.firstTokenTime ?? assistantStreamFirstTokenTime(stream)`。

> **v2 只用后两条**。单次调用的解码窗口整个挂在 `assistant/message` 事件自己身上（首 token 时刻由该事件带的 compacted stream 导出），所以 `step/start` 开边界与 `assistant/attempt` 补记都不再需要，`decodeMs`/`decodeTokens` 也从「累加」变「覆盖」。这不是新算法，是把 v1 逐步算完再求和的那一步求和删掉。

### 缓存命中率

`最近一次调用 cacheReadTokens ÷ (uncachedInput + cacheRead + cacheWrite)`  （v1 口径：一轮内各次调用的三个桶先各自求和再相除）

- 三个输入桶**互斥**（`dsh-llm/lib/types/types.d.ts`：`inputTokens` 只算未命中缓存的输入），故分母 = 计费输入；
- **token 加权**后再相除，不是各步百分比求平均 —— 与宿主 `cacheHitPercent`（`dsh-client-ui-chat/lib/client.js:9525-9536`）和 stats 包的 `turnCache`（token 加权）同口径。**v2 把范围收到一次调用后，加权自然退化为该次调用自己的桶之比**——算法仍是同一套，别误以为"不用加权了"而改成对百分比取平均；
- 分母为 0 → 无值。

## 3. 数据从哪来：新增一个投影单元，不做前端推算

宿主**没有任何现成的本轮或单次调用数值**：`sessionStats` 与 `tokenUsage` 的 `wire.view` 都只发全会话标量（`projection.js:155-166`、`dsh-token-meter/lib/types/usage-projection.js:118`）。但原料是服务端写入 durable log 的精确值，一项不缺。

走官方扩展口，数值仍由**服务端 fold 产出并经现有 `projection` 帧推送**：

```js
await ctx.sessionProjections.register(definition)   // dsh-session-projection/README.md:56-64
```

「带 `wire` 块的单元会自动进 carrier 快照与变更帧」，前端用现成的 `useProjection(key)` 读——与宿主两颗药丸读 `sessionStats` / `tokenUsage` 完全同一条通道，不是插件自己拉数据。

### 投影定义 `turnStats`（v2）

```
state = {
  last: { turn, decodeMs, decodeTokens, cacheReadTokens, billedInputTokens } | null,   // 最近一次已结算的模型调用
}
```

| 事件 | 动作 |
|---|---|
| `assistant/message` | 该事件自带解码窗口与用量 → `last = 快照(这一次调用)`。取不到首 token 时刻或该次没报 `outputTokens` → **返回同一引用**（不更新、不清空、不写 0） |
| 其它一切事件（含 `step/start`、`assistant/attempt`、`turn/end`） | **返回同一引用**（change feed 靠 `Object.is` 去抖） |

**v2 删掉了什么、为什么能删**：v1 的 `open` 累加器、`settledSteps` 计数、`step/start` 的跨轮清理、`turn/end` 的提交点，全都只服务于「跨调用求和」这一件事。单次调用所需的解码窗口就在 `assistant/message` 事件自己身上（首 token 时刻由该事件携带的 compacted stream 导出，与 v1 同一个 `assistantStreamFirstTokenTime`），所以 fold 不再依赖任何**前置**事件。净效果是代码变少、状态变浅，而不是加东西。

`turn` 字段保留：pill 不显示它，但它是与详情页对表、以及在 checkpoint 里判断"这个值来自哪一次"的凭据。

`wire.view: state => state.last ?? null`，`viewSchema: turnStatsSchema.nullable()`，`summary: false`（与 `sessionStats` 一致，不进会话列表载荷）。**线载荷形状与 v1 完全相同**（同样那 5 个字段），变的只是它现在描述一次调用而非一轮 → 客户端渲染与格式化逻辑零改动，只有文案要改。

**`stateVersion` 必须 1 → 2**：字段集（去掉 `open`）与 fold 语义同时变了，官方 `practices.md:27` 的原文是 *"bump `stateVersion` when fields or fold semantics change"*。旧 checkpoint 会被判为过期并丢弃，该会话冷读时从日志尾部重放一次——这是预期行为，不是故障。

> 空态必须是 **`null` 而不是 `undefined`**，实现时才发现的硬约束：注册表取 cell 的值是 `wire.viewSchema.parse(wire.view(state))`，**没有任何兜底**（`dsh-session-projection/lib/index.js:584-589`），而 `snapshot()` 一次遍历算出该会话**所有** client-visible 单元——view 返回 `undefined` 会让 zod 抛错，炸掉的是整个会话的投影快照，宿主自己那两颗药丸一起躺枪。宿主唯一的空态先例正是这个形状：`viewSchema: worktreeSchema.nullable()` + `view: … : null`（`dsh-experimental-client-ui-forge/lib/index.js:947-950`）。回归用例把注册表那一行 parse 直接照抄进断言，注入旧 bug 时 4 个用例转红。

**恢复语义**：投影注册表会重放 log 重新 fold，所以重开会话、翻页、compaction 都不影响 `last`。附带一条 v2 才有的性质，必须有用例钉住：**孤立的 `assistant/message` 事件（前面没有 `step/start`、没有 `assistant/attempt`）也要能出值**——它同时证明了 fold 无前置依赖、以及窗口分页只截到半个轮时数值不会莫名消失。

**v2 顺带消掉了那帧多余的 `null`**。v1 里 `step/start` 就先改动状态，视图于是经历 `undefined → null`，change feed 会发出一帧 `null`（cell 的视图缓存初值是 `[void 0, void 0]`，`dsh-session-projection/lib/index.js:562-572`）；虽然渲染上无害（`null` 不画药丸），但那是一次白送的下发。v2 第一个改动状态的事件就是携带用量那条，视图直接从 `undefined` 变成数字。真注册表用例已钉住：开步与重试都不惊动这个 key，第一次惊动就带数字，`turn/end` 则完全静默。

## 4. 前端：原地替换两颗药丸

宿主公式写死在 bundle 里、无 hook（`dsh-client-ui-chat/lib/client.js:9565`、`:9695`），唯一开关 `performanceUsage` 只管显示几段读数。所以只能整颗替换。

替换是官方支持的：复用内置 entry 的 **id** 即进入同一 cell 并顶替。

```js
// dsh-cordis-client-runner/lib/client.js:3306-3360 内置 API 目录原文
// "a fresh id is added beside the shipped entries, while
//  reusing a shipped id puts you in THAT cell and replaces it"
// occupants: ["client-ui-chat ActivityPill id 'activity'", "client-ui-chat UsagePill id 'usage'"]
// dsh-client-ui-renderer/lib/types/client/registry.d.ts:166-174
// "Shadowing winners per cell … the first live (non-abdicated) entry of each cell in priority order"
```

⚠️ **`priority: -1` 是必须的，不是可选的。** 自动分配负 priority 只对**动态包**生效（`client.js:432-435`、`:771` `--nextPriority`）；本插件与 `dsh-ability-strip` 一样是**安装型 Client 模块**，`SlotRegistry._register`（`dsh-client-ui-renderer/lib/client.js:1603`）**全程不碰 priority**。宿主两颗的 priority 是 0，不写就是同 id 同 priority → 注册器直接抛错、插件激活失败，报错原文 `list slot "…" already has an entry with id "…" — register at a different priority to shadow it (lowest renders)`。

```js
ctx.slots.inject("conversation.composer.dock", () => {
  ctx.slots.register({ name: "conversation.composer.dock", id: "activity", order: 0, priority: -1, locale: NS, inject }, ActivityPill);
  ctx.slots.register({ name: "conversation.composer.dock", id: "usage",    order: 1, priority: -1, locale: NS, inject }, UsagePill);
});
```

- **位置与颗数天然不变**：同 cell、同 order，需求 2.3 自动满足；
- **恒定渲染静态 plain pill**，不读 `performanceUsage`，不建 dialog → 需求 2.2（不要可点开详情卡）满足；
- `useProjection("turnStats")` 无值 → `return null`，整颗不渲染（宿主 `UsagePill` 本来就这么做）；
- 数字格式复刻宿主规则：tps ≥10 取整、<10 一位小数（`client.js:5881`）；命中率四舍五入将到 100 时自动补小数位（`client.js:8784`）。
- **文案长度是预算**（用户 11-11 追加，REQUIREMENTS §6.4）：状态栏空间珍贵，药丸文字为 `{tps} tok/s` 与 `缓存 {percent}%`（en `Cache {percent}%`），比 v1 的「缓存命中」短两字。`tok/s` 保留是刻意的——单位一丢，同一个数在宿主和本插件就有了两种说法；而"这是缓存"由图标承载，不占字。`title` / `description` 不进状态栏，可以写全长，已改称「最近一次调用」。

### 客户端依赖纪律

官方 `practices.md` 的相关禁令（逐条对齐本设计）：

| 禁令 | 出处 | 本设计怎么守 |
|---|---|---|
| 不得 `require` 任何 Harness Client 包（组件抛错会 blanks 整个 slot entry） | `practices.md:35` | 图标内联 SVG、样式自己前缀、颜色只用 `--dsw-alias-*`；`require` 面收敛为 `react`/`react-dom` |
| **客户端不得自己折会话事件，派生值必须由宿主 `wire.view` 下发** | `practices.md:38` | §3 的 `turnStats` 投影正为此设；客户端只 `useProjection` 读 |
| 派生状态放 sessionProjections，**改语义要 bump `stateVersion`** | `practices.md:26-27` | fold 规则一变就 bump |
| 不得自行 subscribe/rescan 绕过增量机制 | `practices.md:8-9` | 不订阅、不轮询 |
| 不得在 patch 里重写宿主包那一条（matching override **替换整个 config**） | `host-plugin.md:3` | 本插件只 `insert` 自己的条目，绝不写 `ui-chat` 行 |

`dsh-ability-strip` 0.5.0 就因为 `require('@deepseek-ai/dsh-client-ui-primitives')` 违规而返工过一次（其 README:157 有记录），本插件从第一行起就按合规写法。

**外观材料的合法来源**：pill 的 CSS 内联在 `dsh-client-ui-chat/lib/client.js:9436-9449`，只有 4 个类（`_anchor` / `_pill` / `_label` / `_sep`），颜色全是 `--dsw-alias-*` → 抄进插件、类名换自己前缀即可逐像素一致。两个图标（`IconGaugeOutlineRegular` / `IconDatabaseOutlineRegular`）来自不可 require 的 primitives 且不在 Node 树，SVG 从活页面 DOM 读——这也是 `practices.md:35` 明确许可的路子。

**文案**：宿主的两条文案编译在 bundle 内（locale JSON 只有 meta），所以插件自带 namespace：`ctx.locale.register(NS, { zh, en })`，不耦合宿主 key。

**本机 profile 已经是 `ui-chat.config.performanceUsage: compact`**（`dsh --profile web --dump-config` 实证）——用户现在看到「只有速率 + 命中率两颗」正是它的结果。需求 2.2 因此等价于「别动这个配置」，而 §4 的恒定 plain pill 渲染保证即使别人把它改成 `detailed`，这两颗也不会变成可点开的详情卡。

## 5. 失败与边界（v2）

| 情况 | 行为 |
|---|---|
| 会话第一次调用尚未结算 | 无 `last` → 两颗都不显示 |
| 某次调用正在流式中 | 显示**上一次已结算**调用的值。v2 缩短的是"等多久出数"，不是"结算前也能出数" |
| 该次调用没报 `outputTokens`，或从其 stream 取不到首 token 时刻 | **不更新**，沿用上一次的值——绝不写 0，也不清空成空态 |
| 失败的尝试（只有 `assistant/attempt`，没有 `assistant/message`） | 不更新。失败尝试没有可证的用量，写进速率就是编数 |
| provider 未报 cache 桶 | 该次调用按 0 计 → 显示 `缓存命中 0%`；只有连计费输入也为 0 时才整颗不显示（分母为 0 → 无值） |
| 一轮内多次调用 | 每次结算都刷新一次，因此轮进行中数字会**逐次变大或变小**——这是 v2 的目的，不是抖动 bug |
| 只装了客户端半边、宿主半边没起 | `useProjection` 恒空 → 两颗消失。**不退回会话累计**——否则会伪装成功径 |

## 6. 验收映射（REQUIREMENTS §3 + §6.3）

| 验收条 | 怎么验 |
|---|---|
| 1 数值随每次调用变化 | 发一个会走多步的请求，**第二个 step 结算后**（不等轮末）比对 `[data-composer-stat="activity"]`，数值应已改变 |
| 2 数值属于那一次调用 | 与详情页/`stats` 页签里**那一步**的用量交叉核对；此时它与整轮合计**不相等属正常** |
| 3 外观完全一致 | 替换前后各截一张图，比对 pill 的 class 尺寸与图标 |
| 4 无新报错 | Host stderr + 浏览器 console 双查 |
| 颗数与位置 | DOM 里 `[data-composer-stat]` 恰好两个，且 dock 内无第三颗 |

## 7. 明确不做

- 实时逐 token 刷新（REQUIREMENTS §4；v2 也不做，理由见下）
- **接 `agent/assistant-stream` 做流式中的速率**。官方确实给了这个实时源（`practices.md:28`：*"render live tokens from `agent/assistant-stream`"*；宿主侧 `AssistantStreamAttempt` 甚至带 `get usage()` 读"流中最近一次适配器上报的用量"），但接它要新开一条通路：投影单元只吃已提交事件、喂不进去 → 得自己维护每会话计数器 + 另开一条下发通道 + 客户端加计时器重绘。**而且缓存命中率那条根本接不上**（分母要的桶在结算前拿不到），结果是一个 pill 实时、一个 pill 结算才动，比现在更像一个 bug。按"越复杂 bug 越多"直接否掉。
- **双口径同时显示**（pill 显示最近一次调用、title 附带本轮累计）。要多存一套跨调用累加，且"到底看哪个"变成新问题。用户选简。
- 详情卡 / `stats` 页签
- 修改会话累计口径的既有消费者（我们**新增** key `turnStats`，不碰 `sessionStats` / `tokenUsage`，零冲突）
- 写任何会话数据、配置、模型设置（需求 2.5）

## 8. 为什么不是改配置就行

已逐个查过宿主的相关 Config，**没有任何口径开关**：

- `dsh-client-ui-chat` 的 Config 全文只有 5 个字段：`transcriptView / collapseTiming / foldedReplies / performanceUsage / linkOpening`；
- 唯一沾边的 `performanceUsage` 只切 `compact|detailed`，**两条分支读同一个投影、跑同一个算式**；
- `dsh-session-stats` 无 Config；`dsh-token-meter` 的 `TokenMeterConfig = Record<string, never>`。

宿主的分子分母写死在 bundle 里、无 hook。所以「只改数字」这件事在配置层不存在解，必须写插件。

## 9. 风险

| # | 风险 | 影响 | 兜底 |
|---|---|---|---|
| 1 | 忘写 `priority: -1` | 注册抛错、**插件激活失败**（不是静默无效） | 冒烟用例断言注册参数；真机看 console 有无 `already has an entry with id` |
| 2 | view 与 viewSchema 不匹配（已实现并修：空态必须 `null` + `.nullable()`） | 不是静默消失，而是**会话投影快照整体抛错**，连带宿主药丸 | 用例把注册表的 `viewSchema.parse(view(state))` 照抄为断言，覆盖 init/进行中/已提交/取消四种状态 |
| 3 | 组件抛错 → 该条目 abdicate → **该 cell 自动回落宿主旧药丸** | 表现是「装了就等于没装」，且**不报错**，极易误判为成功 | 验收必须比对数值口径，不能只看「有没有药丸」；控制台会有 `slot entry crashed in '<slot>'` |
| 4 | 口径漂移：首 token 判定**已复用**宿主导出的 `assistantStreamFirstTokenTime`，剩下的漂移面只有求和规则本身 | 宿主若改 `decodeMs` 定义，两颗会与详情页不一致 | 验收 §6-2 与详情页 per-turn 行交叉核对 |
| 5 | 抄来的 CSS/图标不随宿主升级演进 | 宿主改样式后外观可能不一致 | 只引用 `--dsw-alias-*` token，不用字面色；升级后重截一次图 |
| 6 | `turn/end` 语义变化 | 定格失效 | v2 已不再依赖 `turn/end`（该事件落到"同引用"分支）；此风险随 v2 **消失**，保留此行为变更记录 |
| 7 | **数字抖动**被当成算错报回来（v2 新增） | 一次只吐几百 token 的小步，速率噪声天然大 | 已作为代价写进 REQUIREMENTS §6.2；文案写明「最近一次调用」，让人一眼知道样本范围只有一步 |
| 8 | **名称与口径不符**（v2 新增）：插件仍叫 `dsh-turn-stats`、key 仍叫 `turnStats` | 后来者按名字理解成轮口径，改错地方 | 不改 key（改要多一条迁移与共存路径）。README 首段第一句就是口径；`turn` 字段仍随值下发，checkpoint 里能直接看出这个值属于哪一轮 |
| 9 | 与「统计」页签的**每轮**行不再可比（v2 新增） | 对表时误判成丢数 | 对表对象换成"那一次调用的用量"；v1 的按轮求和对表法只适用于 0.1.x，见 HANDOFF |

风险 2 与 3 的共同点是**失败都不响**，所以本插件的验收标准必须建立在「数值口径」而不是「元素存在」上。
