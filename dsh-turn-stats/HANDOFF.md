# HANDOFF — dsh-turn-stats

给接手的人（或下一次会话里的我）：先读 [REQUIREMENTS.md](REQUIREMENTS.md) → [DESIGN.md](DESIGN.md) → 本文件。DESIGN.md 里有完整证据链，本文件只记「为什么长成这样」和「下一步差什么」。

## 资产地图

| 文件 | 职责 | 改动时要一起看 |
|---|---|---|
| `lib/turn-stats.js` | 纯 fold：`initialTurnStatsState / applyTurnStatsEvent / turnStatsView` + zod 状态/视图 schema + `turnStatsProjectionDefinition`。零 I/O、零宿主服务依赖，可在裸 Node 跑 | `test/turn-stats.test.mjs`；口径来源 `dsh-session-stats/lib/types/projection.js:65-166` |
| `lib/index.js` | 宿主半边：把上面那个 definition 注册到 `ctx.sessionProjections`。只 inject `sessionProjections` | 注册返回的是 callable thenable，**必须 `await` 且不要把它 return 出去**（`Invalid effect`） |
| `lib/client.js` | 浏览器半边：lazy-CJS bundle；注册 `turnStats` 双语字典 + 以 `priority: -1` 顶替 `activity`/`usage` 两颗药丸；内含复制来的 CSS、图标 symbol 解析、两个格式化函数 | 顶替语义的四条运行时事实见 README 表格；bundle 形态照 `dsh-ability-strip/lib/client.js` |
| `scripts/check.mjs` | 包契约静态检查：语法、`package.json` 可解析且 `files`/`exports`/`dsh.*` 与磁盘一致、patch 走 insert 且 id/name 一致、**两处注册都带 priority/order/locale**、client 不 require Harness 包、双语键集平衡 | 结构改了要同步改正则——它已经在 `registrations.length === 2` 上防了「正则匹配不到导致空过」 |
| `test/turn-stats.test.mjs` | 15 个纯 fold 用例：口径、跨轮替换、放弃轮、时间倒挂、坏数据、引用不变性、重放确定性、schema 边界 | `test/host-packages.mjs` 负责把 `@deepseek-ai/dsh-llm` 与 `zod` 别名到已安装 dsh（插件本身不装依赖） |
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

## 还差什么

- [x] ~~真注册表是否接受这个 definition~~ —— 已由 `test/registry.test.mjs` 证明（注册不抛、key 在快照里可见、线值过 schema）。
- [ ] **安装 + 真机验收**（尚未做）。装法见 README「安装」；本插件双半边，装完要重启 Host + `Ctrl+F5`。
- [x] **已安装并生效**：0.1.0 → 0.1.1（`/plugins/dist/`，见下「安装与实测证据」）。
- [ ] 视觉与文案外观（字号、间距、图标、截断提示）由用户确认。数值口径已用服务端数据自证，见下。
- [ ] 需求书写明「本期只交付插件本体」，故未做实时逐 token 刷新、未写额外文档/测试工程化。若下期要做实时值，改动点是宿主 fold 增加 `open` 快照下发（需要 `stateVersion` 递增），不是在客户端补算。

## 回滚

```bash
dsh plugin --profile web remove dsh-turn-stats   # 宿主重启 + 硬刷新后回到宿主原药丸
```

`dist/` 里的 tarball 不可改动，只追加新版本。

## 本目录之外的相关事实

- 打包安装纪律（tarball only、`dist/` 只追加、重载与重启）：仓库根 [INSTALL.md](../INSTALL.md)。
- 官方插件规约：`official-plugins` 技能的 `references/practices.md`（禁 require 客户端包、客户端不折事件、patch 整条覆盖等）。
- 顺带发现：`dsh-ability-strip` 的 `pnpm check` 偶发 FAIL（同代码连跑两次又 PASS）。不是本插件引入的，未深查。

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

| 量 | log 求和 | 本插件 checkpoint 的 `last`（turn 33） |
|---|---|---|
| 计费输入 | 850,598 | 850,598 |
| 缓存读 | 0 | 0 |
| 输出 | 2,989 | 2,989 |

> 途中一次**误判被数据推翻**：见 turn 33 的 `cacheReadTokens=0` 而宿主 `tokenUsage.totals.cacheReadTokens=80,456,192`，一度判定自己的 fold 漏了缓存桶。按轮求和后证实：80M 全部来自更早轮次（turn 31 有 137,088），turn 32–34 该 provider 确实没上报缓存读。**结论：缓存桶只在部分消息上出现，本轮无上报时显示 0% 与宿主会话口径同源**，不是丢数。

### 已知遗留（都不是本插件引入）

- `install_bundle` 每次报 `[WARN] Issues with peer dependencies found`：11-09 装 `dsh-read-img 0.1.3→0.1.4` 的日志里就已出现，早于本插件；具体是哪个包未定位（不跑 `pnpm` 进 profile 目录，官方禁止）。本包已按 `dsh-read-img` 规约改 optional peer，只是不再参与该检查。
- `dsh --dump-config` 报 `entry "ability-strip" not found`：`dsh-ability-strip` 现为 `enabled: false`，patch 仍引用其条目 id。
- `dsh-ability-strip` 的 `pnpm check` 偶发 FAIL（同代码连跑两次又 PASS）。
