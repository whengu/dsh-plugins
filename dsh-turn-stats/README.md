# dsh-turn-stats

状态：**已安装并生效于 profile `web`（0.1.1）**；18/18 用例通过（含真注册表集成测试），口径已与原始 durable log 逐字对表。基线 dsh `0.2.2-rc.1`。安装与实测证据见 [HANDOFF.md](HANDOFF.md#安装与实测证据01x)。
需求见 [REQUIREMENTS.md](REQUIREMENTS.md)，方案与全部证据见 [DESIGN.md](DESIGN.md)，交接与决策见 [HANDOFF.md](HANDOFF.md)。

> 🔧 **0.2.0 口径改版：代码已完成，待安装 + 重启 Host**。统计范围从「最近一个已完成轮次」改为「**最近一次模型调用**」，因为一轮可能持续非常久，等轮末等于看不到（需求变更见 [REQUIREMENTS §6](REQUIREMENTS.md)，决定记录见 DESIGN §1）。药丸文字同时缩短（`缓存命中 72%` → `缓存 72%`，REQUIREMENTS §6.4）。下文凡写「本轮」处，0.2.0 起一律读作「最近一次模型调用」。

## 作用

把输入框下方那两颗统计药丸——**输出速率（tok/s）**与**缓存命中率（%）**——从「整个会话累计」改成「**最近一次模型调用**」（0.2.0；0.1.x 是「最近一个已完成轮次」）。外观、位置、颗数都不变。

为什么不是轮：一轮可能跑很久。2026-11-11 抽样 10 个会话，**每轮步数的中位数是 9**（单步轮只占约 15%）；本会话最长的一轮跑了 22,590 秒。按轮出数等于全程看不到，按调用出数把等待压到一步。重查方法：按 `assistant/message` 的 `usage` 逐轮计数（`zstd -dc session.v4.jsonl.zstd` 后按 `data.turn` 分组）。

## 为什么必须是插件

宿主 `dsh-client-ui-chat` 的 Config 全文只有 5 个字段（`transcriptView / collapseTiming / foldedReplies / performanceUsage / linkOpening`），**没有任何口径开关**；唯一沾边的 `performanceUsage` 只切「紧凑 / 详细」，两条分支读同一个投影、跑同一个算式。分子分母写死在 bundle 里，无 hook。`dsh-session-stats` 无 Config，`dsh-token-meter` 的 `TokenMeterConfig = Record<string, never>`。

## 机制（每条都有源码出处）

| 事实 | 出处 |
|---|---|
| 两颗药丸住在 slot `conversation.composer.dock`，cell key = `options.id`；宿主条目 id 为 `activity`(order 0) / `usage`(order 1) | `dsh-client-ui-chat/lib/client.js:15560-15577`；slot 声明 `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:341-349` |
| **复用内置 id 即进入同一 cell 并顶替** | 宿主内置 API 目录原文：`dsh-cordis-client-runner/lib/client.js:3306-3360` |
| 同 id **且同 priority** 在注册时抛错；list slot 先按 `priority` 升序、再按 `order` 升序，每 cell 渲染第一个存活条目 | 运行时 bundle 的判定条件 `(h.options.priority ?? 0) === n` 与排序 `(f,h)=>(f.options.priority??0)-(h.options.priority??0) \|\| (f.options.order??0)-(h.options.order??0)` |
| 安装型 Client 模块**不会**自动获得负 priority（只有动态包会） | `dsh-client-ui-renderer/lib/client.js:1603` 的 `_register` 不碰 priority；动态包见同文件 `:771` `--nextPriority` |
| 数值必须由宿主 `wire.view` 下发，客户端不得自己折会话事件 | `practices.md:38`；投影模型 `dsh-api-session-controller/lib/types/client/sessions/projection-store.d.ts:1-14` |
| 宿主两个投影都只发全会话标量 | `dsh-session-stats/lib/types/projection.js:155-166`（`view` 只吐 8 个总量）、`dsh-token-meter/lib/types/usage-projection.js:118`（`view: state => state.totals`） |

所以本插件 = 宿主半边注册一个自己的投影 key `turnStats` + 客户端半边用 `priority: -1` 顶替那两颗。

## 数值口径（v2）

- **速率** = 最近一次调用 `decodeTokens ÷ (decodeMs / 1000)`。`decodeMs` 与 `decodeTokens` **成对**取自同一次结算，只认报了 `outputTokens` 的调用——单条规则与宿主 `sessionStats` 逐条相同；首 token 时刻直接 `import { assistantStreamFirstTokenTime } from "@deepseek-ai/dsh-llm"`，不自己实现判定。
- **缓存命中** = 最近一次调用 `cacheRead ÷ (input + cacheRead + cacheWrite)`。三个输入桶按契约互斥（`inputTokens` 只算未命中缓存的输入），故其和就是计费输入。0.1.x 是先跨调用求和再相除（token 加权），v2 的范围缩到一次调用，**算式没换**。
- **更新时机**：每次模型调用结算（`assistant/message`）即刷新；那次调用没报 `outputTokens` 或取不到首 token 时刻 → **不更新**，沿用上一次的值，绝不写 0 或清空。一次都没有时两颗都不显示。
- **不做**流式中的实时值：结算前没有任何已提交的用量可证，硬出数就是需求 2.4 禁止的前端推算（详见 DESIGN §7）。
- tps 与百分比的格式化函数**逐字复制**自宿主（含「99.97% 不得显示成 100」这类诚实性规则），避免对同一组数字给出第二种说法。

## 已知限制（显式取舍）

| 限制 | 原因 |
|---|---|
| 一次调用**流式进行中**不刷新，结算那一刻才跳 | `usage` 随 `assistant/message` 才落盘，流式中的那次调用没有任何已提交数据；提前出数就是需求 2.4 禁止的前端推算 |
| 速率会比轮口径**抖**（v2 新增） | 样本只有一次调用，小步只吐几百 token 时算出的速率噪声天然大。这是"少等"的代价，REQUIREMENTS §6.2 已确认接受 |
| 缓存命中更常显示 `0%`（v2 起更明显） | provider 只在**部分** `assistant/message` 上带 `cacheReadTokens`（2026-11-11 实测：turn 31 有 137,088，turn 32–34 为 0）。轮口径会被同轮其他调用摊平，调用口径不会——但**宿主会话级同样是「无上报即 0」**，两颗同源 |
| 带重试的轮，缓存分母可能比宿主会话值少一次尝试 | 我们对齐 `sessionStats`（按 `assistant/message` 计），宿主会话缓存对齐 `tokenUsage`（按计费尝试计）。两者定义本就不同 |
| 图标依赖宿主 sprite 的 `<symbol>` id | 不可 require primitives；id 找不到时该颗只显示文字，不显示破图 |
| 悬停提示用原生 `title`，只在文字被截断时出现 | 宿主用 primitives 的 `Tooltip`（`onlyWhenClipped`），同样不可 require。可观察契约（截断才给全文）保留，延迟由浏览器决定 |
| 只装客户端半边时两颗消失 | 不退回会话累计——否则等于伪装成功径 |

## 安装

跨插件铁律见仓库根 [INSTALL.md](../INSTALL.md)。本插件是 **host + client 双半边**：宿主半边改了投影注册、客户端半边改了渲染，**升级必须重启 Host 并硬刷新浏览器**（[§15.1](../INSTALL.md#151-重载与重启官方明文决定改完要不要重启)）。

```bash
# 站在本插件目录里
pnpm check
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/dsh-turn-stats-<版本>.tgz
# 然后：重启 Host + 浏览器 Ctrl+F5
```

卸载：`dsh plugin --profile web remove dsh-turn-stats`。

## 验证

```bash
pnpm check                    # 包契约 + 双注册参数 + 双语平衡 + 语法
pnpm test                     # 18 个用例（零网络、零浏览器）
#   test/turn-stats.test.mjs  15 个 fold 口径用例
#   test/registry.test.mjs     3 个真装配用例：真 cordis Context + 宿主 SessionProjectionRegistry
#                              走客户端读的同一条 snapshot() 路径，证明注册成功、key 可见、
#                              线值过 viewSchema、数字与 fold 一致、change feed 行为符合预期
```

真机验收（对应 REQUIREMENTS §3）：

1. 发一个会走多步的请求，**第二个 step 结算后**（不必等轮末）`[data-composer-stat="activity"]` 的数值应已变成那一次调用的值，而不是从第一条消息起累计；
2. DOM 里 `[data-composer-stat]` **恰好两个**（多了说明顶替失败、变成第三颗）；
3. 与**那一次调用**（详情页对应 step 的 usage）交叉核对；此时它与整轮合计、与「统计」页签的每轮行**不相等属正常**；
4. 控制台无 `already has an entry with id`、无 `slot entry crashed`。

⚠️ 验收不能只看「有没有药丸」：组件抛错时该 cell 会**静默回落**成宿主旧药丸，看起来像「装了但没生效」。必须核对数值口径。

## 版本

- 0.2.0 — **口径改为最近一次模型调用**：fold 去掉跨调用累加（`open` 累加器、`settledSteps`、`step/start` 跨轮清理、`turn/end` 提交点全部删除，只认 `assistant/message`），状态从 `{open, last}` 塌成 `{last}`，**`stateVersion` 1 → 2**；线载荷形状不变故客户端只改文案。副作用：不可证的调用一律不发布（宁可留着上一个数），且 change feed 不再有多余的 `null` 帧。药丸文字缩短为 `缓存 {percent}%`。安装要重启 Host。
- 0.1.0 — 首版：`turnStats` 投影 + 顶替两颗药丸（轮口径，`turn/end` 定格）。
- 0.1.1 — `@deepseek-ai/dsh-llm` 与 `zod` 改为 **optional peer**（`engines.dsh` 才是运行门槛），与 `dsh-read-img` 同规约。装 0.1.0 时 pnpm 报 `Issues with peer dependencies`：把宿主包写成硬 peer 且精确锁版，会让以后每次宿主升级都报未满足。
