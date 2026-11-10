# 设计方案：dsh-turn-stats

> 规格来源：[REQUIREMENTS.md](REQUIREMENTS.md)。基线 dsh `0.2.2-rc.1`、profile `web`。
> 本文写实现方案与口径定义；需求本身以 REQUIREMENTS.md 为准。

## 1. 已确认的产品决定

| 议题 | 决定 | 出处 |
|---|---|---|
| 更新时机 | **轮结束后定格**：`turn/end` 之前不产生本轮值 | 用户确认 |
| 空态 | **显示上一轮的值**；一个已完成轮都没有时整颗不显示 | 用户确认（与需求 2.5「不显示 0 或占位」一致） |
| 「本轮」边界 | `turn/start` → `turn/end`，**含**轮内工具调用与多次模型调用 | REQUIREMENTS §5 + 宿主 turn 定义 |
| 速率分母是否含工具耗时 | **不含**。分子分母都只算解码墙钟，与宿主现有 tok/s 同口径，故工具调用的多少不改变速率数值 | 对齐宿主 |

## 2. 口径定义（与宿主逐项对齐，不发明新算法）

### 速率

`本轮 decodeTokens ÷ (本轮 decodeMs / 1000)`

逐步规则与宿主 `sessionStats` 的 fold **完全一致**（`dsh-session-stats/lib/types/projection.js:96-119`）：

- `step/start` 开边界，记 `startTime`；
- `assistant/attempt` 可补记首 token 时刻（失败尝试也可能已吐字）；
- `assistant/message` 关闭该步：`decodeMs = max(0, event.time - firstToken)`，**仅当该步 usage 报了 `outputTokens`** 才同时累加 `decodeMs` 与 `decodeTokens`；
- `firstToken` 取 `openStep.firstTokenTime ?? assistantStreamFirstTokenTime(stream)`。

### 缓存命中率

`本轮 ΣcacheReadTokens ÷ 本轮 Σ(uncachedInput + cacheRead + cacheWrite)`

- 三个输入桶**互斥**（`dsh-llm/lib/types/types.d.ts`：`inputTokens` 只算未命中缓存的输入），故分母 = 计费输入；
- **token 加权**后再相除，不是各步百分比求平均 —— 与宿主 `cacheHitPercent`（`dsh-client-ui-chat/lib/client.js:9525-9536`）和 stats 包的 `turnCache`（token 加权）同口径；
- 分母为 0 → 无值。

## 3. 数据从哪来：新增一个投影单元，不做前端推算

宿主**没有任何现成的本轮数值**：`sessionStats` 与 `tokenUsage` 的 `wire.view` 都只发全会话标量（`projection.js:155-166`、`dsh-token-meter/lib/types/usage-projection.js:118`）。但原料是服务端写入 durable log 的精确值，一项不缺。

走官方扩展口，数值仍由**服务端 fold 产出并经现有 `projection` 帧推送**：

```js
await ctx.sessionProjections.register(definition)   // dsh-session-projection/README.md:56-64
```

「带 `wire` 块的单元会自动进 carrier 快照与变更帧」，前端用现成的 `useProjection(key)` 读——与宿主两颗药丸读 `sessionStats` / `tokenUsage` 完全同一条通道，不是插件自己拉数据。

### 投影定义 `turnStats`

```
state = {
  open: { turn, decodeMs, decodeTokens, cacheRead, billedInput } | null,   // 进行中轮的累加器
  last: { turn, decodeMs, decodeTokens, cacheRead, billedInput } | null,   // 最近一个已完成轮
}
```

| 事件 | 动作 |
|---|---|
| `step/start` | 若 `open.turn` 与新 turn 不同 → 丢弃未完成累加（被中断轮不发布），开新累加器 |
| `assistant/attempt` | 匹配当前 open step 且尚无首 token → 补记 `firstTokenTime` |
| `assistant/message` | 匹配当前 open step → 按 §2 规则累进 `open`；记 `firstTokenTime` 已消费 |
| `tool/call` / `tool/result` | **忽略**（工具墙钟不进速率） |
| `turn/end` | `open` 非空且有已提交步 → `last = 快照(open)`；`open = null`。`open` 为空（本轮没进 step）→ 保留上一轮 |
| 其他 | 返回同一引用（change feed 靠 `Object.is` 去抖） |

`wire.view: state => state.last ?? undefined`，`summary: false`（与 `sessionStats` 一致，不进会话列表载荷）。

**恢复语义**：投影注册表会重放整个 log 重新 fold，所以重开会话、翻页、compaction 都不影响 `last` —— 与宿主 `sessionStats` 的 log-scoped 性质同源。

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

## 5. 失败与边界

| 情况 | 行为 |
|---|---|
| 会话第一轮尚未结束 | 无 `last` → 两颗都不显示 |
| 上一轮有值、本轮进行中 | 显示上一轮的值（= `last`，直到 `turn/end` 才替换） |
| 本轮无 step（例如被立即打断） | 保留上一轮，不清空 |
| 轮被取消/失败 | 已提交步的值仍定格（与宿主 `steps` 计数含 failed/cancelled 一致） |
| provider 未报 cache 桶 | 缓存命中那颗不显示（分母缺项），速率那颗照常 |
| 只装了客户端半边、宿主半边没起 | `useProjection` 恒空 → 两颗消失。**不退回会话累计**——否则会伪装成功径 |

## 6. 验收映射（REQUIREMENTS §3）

| 验收条 | 怎么验 |
|---|---|
| 1 数值随每轮变化 | 连发两轮不同长度的请求，比对 `[data-composer-stat="activity"]` 文本；第二轮后数值应等于第二轮自身 |
| 2 第二轮体现第二轮 | 同上，且与详情页/`stats` 页签的 per-turn 行交叉核对 |
| 3 外观完全一致 | 替换前后各截一张图，比对 pill 的 class 尺寸与图标 |
| 4 无新报错 | Host stderr + 浏览器 console 双查 |
| 颗数与位置 | DOM 里 `[data-composer-stat]` 恰好两个，且 dock 内无第三颗 |

## 7. 明确不做

- 实时逐 token 刷新（REQUIREMENTS §4）
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
| 2 | 新投影 key 的 `wire` 下发未经真机验证 | 客户端读到 undefined → 两颗**消失** | 静态上运行时 key 不透明（`faceOf(key: string)`），理论必通；装上后第一件事就是核对 DOM 有 `[data-composer-stat]` |
| 3 | 组件抛错 → 该条目 abdicate → **该 cell 自动回落宿主旧药丸** | 表现是「装了就等于没装」，且**不报错**，极易误判为成功 | 验收必须比对数值口径，不能只看「有没有药丸」；控制台会有 `slot entry crashed in '<slot>'` |
| 4 | 口径漂移：我们的 fold 复刻宿主规则而非复用其代码（宿主只发全会话标量，无法复用） | 宿主若改 `decodeMs` 定义，两颗会与详情页不一致 | 验收 §6-2 与详情页 per-turn 行交叉核对 |
| 5 | 抄来的 CSS/图标不随宿主升级演进 | 宿主改样式后外观可能不一致 | 只引用 `--dsw-alias-*` token，不用字面色；升级后重截一次图 |
| 6 | `turn/end` 语义变化 | 定格失效 | 宿主已明文 `{turn, reason}` 是轮边界（`dsh-session/lib/types/types.d.ts:279-282`），概率低 |

风险 2 与 3 的共同点是**失败都不响**，所以本插件的验收标准必须建立在「数值口径」而不是「元素存在」上。
