# HANDOFF — dsh-turn-stats

给接手的人（或下一次会话里的我）：先读 [REQUIREMENTS.md](REQUIREMENTS.md) → [DESIGN.md](DESIGN.md) → 本文件。DESIGN.md 里有完整证据链，本文件只记「为什么长成这样」和「下一步差什么」。

## 资产地图

| 文件 | 职责 | 改动时要一起看 |
|---|---|---|
| `lib/turn-stats.js` | 纯 fold：`initialTurnStatsState / applyTurnStatsEvent / turnStatsView` + zod 状态/视图 schema + `turnStatsProjectionDefinition`。零 I/O、零宿主服务依赖，可在裸 Node 跑。**v2 起 state 只有 `{last}`，且只响应 `assistant/message`，其余事件一律同引用** | `test/turn-stats.test.mjs`；口径来源 `dsh-session-stats/lib/types/projection.js:65-166` |
| `lib/index.js` | 宿主半边：把上面那个 definition 注册到 `ctx.sessionProjections`。只 inject `sessionProjections` | 注册返回的是 callable thenable，**必须 `await` 且不要把它 return 出去**（`Invalid effect`） |
| `lib/client.js` | 浏览器半边：lazy-CJS bundle；注册 `turnStats` 双语字典 + 以 `priority: -1` 顶替 `activity`/`usage` 两颗药丸；内含复制来的 CSS、图标 symbol 解析、两个格式化函数 | 顶替语义的四条运行时事实见 README 表格；bundle 形态照 `dsh-ability-strip/lib/client.js` |
| `scripts/check.mjs` | 包契约静态检查：语法、`package.json` 可解析且 `files`/`exports`/`dsh.*` 与磁盘一致、patch 走 insert 且 id/name 一致、**两处注册都带 priority/order/locale**、client 不 require Harness 包、双语键集平衡 | 结构改了要同步改正则——它已经在 `registrations.length === 2` 上防了「正则匹配不到导致空过」 |
| `test/turn-stats.test.mjs` | 15 个纯 fold 用例：口径、跨轮替换、放弃轮、时间倒挂、坏数据、引用不变性、重放确定性、schema 边界。**v2 要动其中两条**：「跨轮替换」「放弃轮」随轮口径作废，换成「连续两次调用后者覆盖前者」与「孤立 `assistant/message`（前面没有 `step/start`、`assistant/attempt`）也能出值」——后者同时钉住 fold 无前置依赖与窗口分页安全性 | `test/host-packages.mjs` 负责把 `@deepseek-ai/dsh-llm` 与 `zod` 别名到已安装 dsh（插件本身不装依赖） |
| `test/registry.test.mjs` | 3 个**真装配**用例：真 `Context` + 真 `SessionProjectionRegistry`，经 `session/event` 驱动，读 `snapshot()`——即浏览器投影存储走的那条路 | 假 session 只需 `header / inheritedEventCount / seq / snapshotEvents / eventAt`；别名表多带 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session-projection` |
| `cordis.patch.yml` | `insert` 一行 `id: turn-stats` | **不要**整段重写 `ui-chat` 那行：一条匹配的 patch 覆盖该条目的**全部** config |

## 关键决策（含被推翻的假设）

1. **口径 = 宿主口径，不自造**。`decodeMs`/`decodeTokens` 成对累加、首 token 用宿主导出的 `assistantStreamFirstTokenTime`、缓存分母用三个互斥桶之和。这样本插件的数字和宿主会话级数字放在同一张表里不会互相打脸。
2. **定格在 `turn/end`**（用户选定）。中途不动不是懒，是 `usage` 只在 `assistant/message` 落盘——提前出数只能是猜。
3. **空态显示上一轮**（用户选定）；一轮都没有就两颗都不显示。**没有已完成轮 ≠ 显示 0**。
4. 顶替靠 `priority: -1` + 同 id。设计初稿以为「安装型模块会自动拿负 priority」——**错的**：只有动态注册的包会（`dsh-client-ui-renderer/lib/client.js:771`），安装型走 `_register` 不碰 priority（同文件 `:1603`）。不写 `priority` 的后果不是「不生效」，是**注册时抛错、整个插件不激活**。
5. 曾以为可以只改配置达到目的。查完 `dsh-client-ui-chat` Config 全 5 个字段 + `performanceUsage` 两条分支后确认：不可能，两条分支同一算式。
6. 客户端**不折叠会话事件**：`practices.md:38` 禁止，且浏览器只有分页窗口，窗口级折叠的含义会随滚动/压缩漂移。
7. CSS、格式化函数、图标 symbol 一律「复制 + 自己冠前缀」，不 require primitives（`practices.md:35`）。require 到的组件一旦抛错，整个 cell 崩掉并**静默回落**成宿主旧药丸。
8. **v2：口径从「轮」改成「最近一次模型调用」**（用户 11-11 提出，理由是一轮可能跑很久，等 `turn/end` 等于看不到）。
   - **被推翻的假设**：v1 时我把「轮结束后定格」写成了像是宿主给的限制（DESIGN 旧 §1 表里"更新时机"的措辞）。**它从来只是产品选择**——宿主每次调用结算都会随 `assistant/message` 落一份完整的解码窗口与用量，按调用出数不需要任何新数据源。把这个选择当成限制，白让功能难用了一整版。
   - **改完之后 fold 更小**：`open` 累加器、`settledSteps`、`step/start` 的跨轮清理、`turn/end` 的提交点全部删除，只留「`assistant/message` → 覆盖 `last`」。符合用户"越复杂 bug 越多"的要求。
   - **没有跟着改名的东西是故意的**：插件仍叫 `dsh-turn-stats`、投影 key 仍叫 `turnStats`。改 key 要多出一条迁移与共存路径，收益只有命名好看。看到名字以为是轮口径的人（包括下一次的我）——以 REQUIREMENTS §6 为准。
   - **v2 的 state 只剩 `{last}`**，字段形状与 v1 的 `last` 一致 → 线载荷不变 → 客户端只改文案。但持久 state 字段集变了，**`stateVersion` 必须 1 → 2**（`practices.md:27`）。

## 还差什么

- [x] ~~真注册表是否接受这个 definition~~ —— 已由 `test/registry.test.mjs` 证明（注册不抛、key 在快照里可见、线值过 schema）。
- [ ] **安装 + 真机验收**（尚未做）。装法见 README「安装」；本插件双半边，装完要重启 Host + `Ctrl+F5`。
- [x] **已安装并生效**：0.1.0 → 0.1.1（`/plugins/dist/`，见下「安装与实测证据」）。
- [ ] 视觉与文案外观（字号、间距、图标、截断提示）由用户确认。数值口径已用服务端数据自证，见下。
- [ ] **v2（0.2.0）实现**：文档已定稿（REQUIREMENTS §6 / DESIGN §1·§2·§3·§5·§7·§9 / README 口径段），**代码未动**。落地清单：fold 去掉累加与 `turn/end` 分支 → `stateVersion` 1→2 → 客户端文案「本轮」→「最近一次调用」→ 改两条旧用例 + 新增两条 → `pnpm check && pnpm test` → 出包装 `/plugins/dist` → **要重启 Host**（替换已装包的宿主 JS；判据见工作区 `notes/config/quick-facts.md`「升级要不要重启」）。
- [x] ~~下期若做实时值，改动点是宿主 fold 增加 `open` 快照下发~~ —— **v2 走了另一条路**：不新增 `open` 下发，而是**取消跨调用求和**，直接发每次调用的结算值，代码反而变少。真·流式实时（接 `agent/assistant-stream`）已明确否决，理由写在 DESIGN §7。

## 回滚

```bash
dsh plugin --profile web remove dsh-turn-stats   # 宿主重启 + 硬刷新后回到宿主原药丸
```

`dist/` 里的 tarball 不可改动，只追加新版本。

## 本目录之外的相关事实

- 打包安装纪律（tarball only、`dist/` 只追加、重载与重启）：仓库根 [INSTALL.md](../INSTALL.md)。
- 官方插件规约：`official-plugins` 技能的 `references/practices.md`（禁 require 客户端包、客户端不折事件、patch 整条覆盖等）。
- 顺带发现：`dsh-ability-strip` 的 `pnpm check` 偶发 FAIL（同代码连跑两次又 PASS）。不是本插件引入的，11-11 复查 13 次全 PASS 无法复现，见下「已知遗留」。

## 安装与实测证据（0.1.x）

安装走官方入口，不手写 profile 的 `package.json` / `cordis.patch.yml`：

```bash
install -m 644 dist/dsh-turn-stats-<版本>.tgz /plugins/dist/     # 持久 bind mount，包只追加
# plugin_manager: action=install_bundle, target=file:/plugins/dist/dsh-turn-stats-<版本>.tgz
```

`install_bundle` 三次返回均为 `application: "applied"`、`warnings: []`、**没有 `restart-required`** —— 与官方明文一致：*安装新 bundle 可经 HMR 激活；替换已安装的包才需要重启换新 JS 代际*。

### 宿主半边确实活着（非视觉、可复跑）

投影 checkpoint 会把每个 key 的 `(ver, seq, val)` 落盘，直接读它就能证明注册与 fold 发生在**真宿主**上，不必碰浏览器：

```bash
cd /data/storages/session_projcache/sessions && python3 -c "
import json,glob
d=json.load(open('<该会话的>.json'))
f=[]
def w(o):
    if isinstance(o,dict):
        for k,v in o.items():
            f.append(v) if k=='turnStats' and isinstance(v,dict) and 'val' in v else w(v)
    elif isinstance(o,list): [w(v) for v in o]
w(d); print(f)"
```

0.1.0 装好后立刻在该目录看到 `turnStats` 的 checkpoint（`ver: 1`，`open` 落在当时正在跑的那一轮），证明 HMR 已激活。

### 口径正确性的逐字对表

原始 durable log（`session.v4.jsonl.zstd`，`zstd -dc` 后按 `assistant/message` 的 `usage` 按轮求和）对 turn 33：

> ⚠️ **这套按轮求和的对表法只适用于 0.1.x**。v2 起投影发的是**单次调用**的值，核对对象换成**那一个 `assistant/message` 事件自己带的量**（同一事件里的解码窗口与 `usage`），不要再按轮求和——那是被废弃的口径，按它比会得出「插件少算了」的假结论。

| 量 | log 求和 | 本插件 checkpoint 的 `last`（turn 33） |
|---|---|---|
| 计费输入 | 850,598 | 850,598 |
| 缓存读 | 0 | 0 |
| 输出 | 2,989 | 2,989 |

> 途中一次**误判被数据推翻**：见 turn 33 的 `cacheReadTokens=0` 而宿主 `tokenUsage.totals.cacheReadTokens=80,456,192`，一度判定自己的 fold 漏了缓存桶。按轮求和后证实：80M 全部来自更早轮次（turn 31 有 137,088），turn 32–34 该 provider 确实没上报缓存读。**结论：缓存桶只在部分消息上出现，本轮无上报时显示 0% 与宿主会话口径同源**，不是丢数。

### 已知遗留（都不是本插件引入；11-11 已全部定位，前两条已处置）

- `install_bundle` 每次报 `[WARN] Issues with peer dependencies found`：**已定位**，11-11 在 profile 依赖清单的**隔离副本**里复现（`pnpm install --lockfile-only --ignore-scripts`，不碰真 profile）后用 `pnpm peers check` 点名：`@deepseek-ai/dsh-web-search-exa`、`dsh-context`、`dshmarket`、`@nonamelego/dsh-catppuccin` 四家报缺失，**本包出现 0 次**。属"运行时由宿主提供"的 peer 在依赖树里天然不可见，无需处理。
- `dsh --dump-config` 报 `entry "ability-strip" not found`：**已消失**。当时 `dsh-ability-strip` 包未启用，patch 层没进树而 patch 里引用了其条目 id。11-11 又发现同一文件里遗留 `- id: ability-strip / disabled: true`（条目级二次关闭，GUI 的开关只动包层、不会清理它），已按 `config-change-protocol` 删除并现查确认启用。
- `dsh-ability-strip` 的 `pnpm check` 偶发 FAIL：11-11 连跑 **13 次全 PASS**，无法复现。**教训在我这边**：第一次 FAIL 时我只 `tail -8`，把失败的脚本名与断言文本丢掉了，所以现在无从归因。下次遇到同类一次性的 check 失败，**先留全量输出再重跑**。
