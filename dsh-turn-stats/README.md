# dsh-turn-stats

状态：**已实现，18/18 用例通过（含真注册表集成测试），未安装**。基线 dsh `0.2.2-rc.1`、profile `web`。
需求见 [REQUIREMENTS.md](REQUIREMENTS.md)，方案与全部证据见 [DESIGN.md](DESIGN.md)，交接与决策见 [HANDOFF.md](HANDOFF.md)。

## 作用

把输入框下方那两颗统计药丸——**输出速率（tok/s）**与**缓存命中率（%）**——从「整个会话累计」改成「最近一个已完成轮次」。外观、位置、颗数都不变。

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

## 数值口径

- **速率** = 本轮 `ΣdecodeTokens ÷ (ΣdecodeMs / 1000)`。`decodeMs` 与 `decodeTokens` **成对**累加，只统计报了 `outputTokens` 的步——与宿主 `sessionStats` 逐条同规则；首 token 时刻直接 `import { assistantStreamFirstTokenTime } from "@deepseek-ai/dsh-llm"`，不自己实现判定。
- **缓存命中** = 本轮 `ΣcacheRead ÷ Σ(input + cacheRead + cacheWrite)`，先求和再相除（token 加权），与宿主 `cacheHitPercent` 及 stats 页签的 `turnCache` 同口径。三个输入桶按契约互斥（`inputTokens` 只算未命中缓存的输入），故其和就是计费输入。
- **定格时机**：`turn/end` 是唯一提交点。轮进行中显示上一轮的值；没有任何已完成轮时两颗都不显示。
- tps 与百分比的格式化函数**逐字复制**自宿主（含「99.97% 不得显示成 100」这类诚实性规则），避免对同一组数字给出第二种说法。

## 已知限制（显式取舍）

| 限制 | 原因 |
|---|---|
| 本轮进行中数值不动，轮结束才跳 | `usage` 随 `assistant/message` 才落盘，流式中的那一步没有任何已提交数据；提前出数就是需求 2.4 禁止的前端推算 |
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

1. 连发两轮长度明显不同的请求，第二轮后 `[data-composer-stat="activity"]` 的数值应等于第二轮自身，而不是从第一条消息起累计；
2. DOM 里 `[data-composer-stat]` **恰好两个**（多了说明顶替失败、变成第三颗）；
3. 与轮尾用量或「统计」页签交叉核对同一轮的量级；
4. 控制台无 `already has an entry with id`、无 `slot entry crashed`。

⚠️ 验收不能只看「有没有药丸」：组件抛错时该 cell 会**静默回落**成宿主旧药丸，看起来像「装了但没生效」。必须核对数值口径。

## 版本

- 0.1.0 — 首版：`turnStats` 投影 + 顶替两颗药丸。
- 0.1.1 — `@deepseek-ai/dsh-llm` 与 `zod` 改为 **optional peer**（`engines.dsh` 才是运行门槛），与 `dsh-read-img` 同规约。装 0.1.0 时 pnpm 报 `Issues with peer dependencies`：把宿主包写成硬 peer 且精确锁版，会让以后每次宿主升级都报未满足。
