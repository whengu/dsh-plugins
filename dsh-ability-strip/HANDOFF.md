# HANDOFF：dsh-ability-strip 交接文档

> 交接目标：读完本文 + [README.md](README.md)，接手者应当能在**不问任何历史问题**的前提下维护、升级、回滚本插件。
> 本文写于 2026-11-03，2026-11-09 更新（0.4.0：定时轮询 → 变更推送）；快照基线：dsh `0.2.2-rc.1`、pnpm `12.9.1`、Windows、profile `web`。
> **来源声明（如实）**：本插件的评审发生在开发会话内（两轮 × 2 名独立评审），原始评审文档**未落盘存档**，只存在于已被压缩的会话记录中。本文的评审结论是**重建**：依据为 git 历史、README/INSTALL 文本、会话存档摘要。与其余插件的原始评审档案（如 dsh-subagent-wait-reminder 的 REVIEW-*.md）相比，本文精度受限，接手者应以代码与检查脚本为准。

## 1. 这是什么，为什么存在

**一句话**：DSH Web GUI 输入框下方的**只读**能力条（`conversation.composer.dock` 槽位）。收起态显示 `skill | N | MCP | N`——本会话可见的 skill 数量、MCP 注册的工具总数；点击整行展开浮动明细面板（skill 清单、每个已连接 MCP 服务器的工具数与工具名、Loader 行 phase、资源插件、插件包）。

**问题起源**（用户原话：「不要现在就是盲盒, 我啥也看不到」）：GUI 默认不显示当前会话到底有哪些生效的 skill 和 MCP。浏览器没有 MCP 状态 Remote，唯一可观测事实是**工具注册表**（`mcp__<server>__<tool>` 命名），所以本包带宿主半边读 `ctx.tools.schemas()`，经自己的 Fetch 路由发给浏览器。

**已证实的效果**：页面实测收起态 `skill | 22 | MCP | 29`，明细展开/收起、29 个工具名列出、MCP 故障弹窗触发与关闭均实测通过（2026-10-28）。

## 2. 当前状态快照
| 项 | 状态 |
|---|---|
| 安装 | `web` profile：**0.7.0**（0.3.0 → 0.4.0 → 0.5.0 → 0.6.0 → 0.7.0，均以 `dsh plugin add <tarball>` 装入） |
| 源码 | 0.7.0：0.4.0 变更推送 + 0.5.0 本地 UI kit（不加载 Harness Client 包）+ 0.6.0 的 tools 标记（按本会话 agent 读工具面）+ 0.7.0 的图标化收起态与工具描述 |
| 宿主半边生效状态 | **0.4.0 与 0.5.0 均已真机确认生效**（0.4.0 重启后 `GET /api/ability-strip/events` = 200 + `text/event-stream`；0.5.0 宿主未改故无需重启）。**0.6.0 新增的 `local` / `scope` 字段需重启 Host 才生效** |
| 装载 | 已进 `dsh.profile.bundles`；`LinkType` 为空；安装副本与源码内容一致（按换行归一比对）；`why` 有记录 |
| 页面验证 | 0.3.0：收起/展开/明细/故障弹窗全过（2026-10-28）。0.4.0：推送主路径已验（首帧 `{"version":0}`、20 秒空闲零请求、断线警示标真实出现）。0.5.0：自绘 svg 与面板视觉已验。**0.6.0：客户端可验（tools 计数来自旧宿主也能显示）；非 MCP 清单与 scope 标注需重启后验** |
| 静态评审 | 多轮：两轮 × 2 评审 + subagent 实现与主 agent 独立复核 + 0.5.0/0.6.0 的变异验证（scope 忽略 sessionId → 5 条断言红；scope 标注改为恒 global → 1 条红） |
| 待办 | 重启 Host 后确认 0.6.0 的 tools 面板：标题右侧应显示"本会话 agent 可见"，且非 MCP 工具名清单非空 |

## 3. 资产地图（哈希为 SHA256 前 16 位，迁移时点快照）

### 开发源码（权威）：本仓库下的 `dsh-ability-strip/` 目录

> 仓库 clone 位置随机器而异，本文不写死路径。哈希与字节数是机器无关的证据，可直接用于任意机器的核对。

| 文件 | 哈希 | 说明 |
|---|---|---|
| `lib\index.js` | `E3E8BDD6FBB46C92` | 宿主半边：读 `ctx.tools.schemas()`，服务 `/api/ability-strip`（读）与 `/api/ability-strip/events`（变更推送） |
| `lib\client.js` | `8E532A4D8C8E355D` | 浏览器半边：能力条本体，lazy-CJS `__ModuleLoader__` 形态，约 1350 行 |
| `cordis.patch.yml` | `6053C78AEE545759` | bundle patch（`- insert: [{id: ability-strip, name}]`） |
| `package.json` | `C1436709097B796B` | `dsh.bundle.patch` + `dsh.client.platform: "web"` + `engines.dsh >=0.2.0-rc.2`，版本 0.4.0 |
| `README.md` | `4BEE357FD0D3B2F5` | 中文完整文档（含 AI 编写声明） |
| `scripts\check-*.mjs` ×3 | — | host 契约 / bundle 契约 / 渲染检查（`pnpm check` 三连） |
| `scripts\verify-pack.mjs` | — | tarball 与源码树逐条比对 |
| `dist\dsh-ability-strip-0.3.0.tgz` | — | **发布产物，39936 B，9 个条目，不得覆盖不得删除**（profile lockfile 记录其 sha512；2026-11-04 全量复核时纠正了此前误记的 40212 B） |

注：本插件最初自带的 `INSTALL.md` 已升格为**仓库根** [INSTALL.md](../INSTALL.md)（跨插件唯一权威），本插件不再单独持有；本插件的具体命令在 [README.md](README.md)「安装」节。`profile-backups\` 是改 profile 前的会话备份，git 忽略、不随包发布。

### 运行副本（只读）：`$DSH_HOME/profiles/web/node_modules/dsh-ability-strip/`

> 默认 `$DSH_HOME` 为 `~/.dsh`；随机器而异，不写死。

- `lib\client.js`、`lib\index.js` 与源码**逐字节一致**（迁移重装后哈希复核通过）。
- `README.md` 是打包时的**英文旧版**（源码后来中文化）——有意不同步，文档不影响行为，下次发版自然带上。
- 普通目录（`LinkType` 为空），非符号链接。

### profile 登记

- 依赖指向 `file:<本仓库路径>\dist\dsh-ability-strip-0.3.0.tgz`；`dsh.profile.bundles` 含本包名。
- 改动这两个记录的唯一合法途径是 `dsh plugin --profile web add/remove`，**禁止手工编辑**。

## 4. 工作机制速览（细节见 README）

1. **双半分工**：浏览器半边经 `connection.rpc.call("/api", "ability-strip", ...)` 读宿主半边，宿主半边读工具注册表并按 `mcp__<server>__<tool>` 约定分组计数，自带缓存（`tools/change` 失效，失败不缓存）。
2. **推送而不是轮询**：宿主半边在同一条 `/api` 载体上多开一条精确路由 `/api/ability-strip/events`（`GET`，`text/event-stream`）。`tools/change` 一响就写一帧 `data: {"version":N}`；浏览器半边用原生 `EventSource` 接收，收到帧就静默重读一次。**页面上没有任何定时器**：刷新只由"推送帧到达 / 打开明细 / 标签页重新可见 / 手动刷新 / 会话切换"触发。开流时宿主先写一帧当前版本，用来补上"浏览器刚读过、流才建好"这段缝隙以及断线重连后的缺口。
3. **推送断开必须可见**：`EventSource` 报错时（`error`）能力条进入"推送断开"状态——收起态行尾一个 11 px 琥珀警示标（健康时不渲染，所以正常宽度不变）、明细面板里一句话说明数字不再自动更新。同一次故障**只补读一次**（`compensated` 闸），`open` / 收到帧时复位，所以重试不会变成读取风暴；彻底不再重试的情况靠"切回标签页"重开这条流，仍然没有定时器。
4. **三道护栏**（都不是轮询专用的，保留了）：宿主缓存（答案没变不调 `schemas()`；同一条 `tools/change` 订阅既失效缓存又推送）、`samePayload` 抑制（数据没变不重渲染）、in-flight 闩 + 单标记补读（慢 Host 不叠请求，一波帧折叠成一次补偿读取）。三者各有一条变异测试钉死。
5. **故障状态机**：已配置且启用但零工具注册 → 连接故障弹窗（按服务器名去重，只弹一次）；无配置/全禁用 → 未连接不弹；注册表读不动 → 读取失败不弹。

## 5. 接手必读的教训（**重建自会话存档**，原始评审未存档）

1. **`anchorRef` 必须真的绑到 DOM**（高危）：面板定位依赖锚点，ref 未绑时 `place()` 早退、面板永久不可见——静态读代码发现不了绑定缺失，页面一动就知道。
2. **in-flight 跳过必须补偿**（中危，0.4.0 后风险更高）：读取进行中的再次请求直接返回时，必须递增 `requestId` 并标记补读，否则旧会话数据会写进新会话。改成推送后这条更容易踩到——一波 `tools/change` 会连着来，正是靠"单标记补读"把 N 帧折叠成一次补偿读取，删掉它就会一帧一读。
3. **`fiberPhase` 判定要排除 `null`/`unloading`**（中危）：把非稳态当已定，会在 MCP 启动期（pending/loading）误报连接故障弹窗。稳态 = `active || failed`。
4. **RPC 通道必须是 `"/api"`**（中危）：`rpc.call` 对通道做 `.slice(1)` 剥前导斜杠——写 `"api"` 会发成 `pi/...` 404。
5. **`mcp__` 拆分是启发式不是约定回析**（中危）：DSH 从不解析公共工具名，`mcp__<server>__<tool>` 只能按最后一个 `__` 启发式拆分；文档不得声称「与 harness 同规则」。
6. **UI 契约先查再用**（低危系列）：`ui.Button` 的 `size` 只有 `md`/`sm`（无 `xs`）、`ui.Tag` 的 `tone` 无 `plain`（用 `quiet`）；Modal 的 `aria-modal` 会截获 Escape、outside-click 要跳过 `[role="dialog"][aria-modal]`；`samePayload` 漏字段（bundle 版本/行数/资源条目 id）会让抑制失效；宿主缓存失败结果会让瞬时错误钉死。
7. **元规则**：静态评审与执行验证互补，缺一不可；改 UI 契约前先读 `@deepseek-ai/dsh-client-ui-primitives` 的实际契约，不凭印象。

## 6. 维护手册

> **动手前先 `git pull`。** 这个仓库有多个会话、多台机器同时改同一个 `main`：push 被拒
> （`rejected (fetch first)`）是常态而不是意外。`fetch` → 看清差异 → `rebase` → 冲突取并集 →
> 双向验证 → 再推；**绝不 `--force`**。完整流程与判据见仓库根 `INSTALL.md` §16。

### 日常验证（改完任何东西后做一次）

```powershell
pnpm check    # check-host + check-bundle-contract + check-render，必须全部 RESULT: PASS
```

渲染检查覆盖全部显示状态（首绘/已载/收起/展开/各类失败/弹窗触发）与推送机制（无定时器、开流地址、隐藏标签页不读、同答案不渲染、一波帧折叠、卸载关流），不需要浏览器。

### 0.4.0 装机后要验什么（本轮未真机验证）

```powershell
pnpm check                                                            # 先全绿
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist\dsh-ability-strip-0.4.0.tgz
dsh plugin --profile web add ./dist/dsh-ability-strip-0.4.0.tgz       # 站在插件目录里
# 浏览器 Ctrl+F5
```

页面打开后逐条确认（控制台按 F12）：

1. 输入框下方能力条出现 `skill | N | MCP | N`，明细展开/收起正常——UI 契约不该有任何变化。
2. DevTools 的 Network 里有一条挂住的 `events` 请求，`type` 是 `eventsource`、`Content-Type: text/event-stream`；**静置十几分钟不会出现新的周期请求**（这就是"没有轮询"的直接证据）。
3. 断开/恢复一个 MCP 服务器（或改它的地址），能力条在事件发生的那一刻就变（旧版本最迟 15 秒），不需要点刷新。
4. 切到别的标签页再回来：数字立刻重读一次；故障弹窗在最需要的时候出现。
5. **故意把流打断**：DevTools → Network → 找到那条 `events` 请求 → 右键 `Block request URL`（或停掉宿主再起）。
   - 期望：收尾出现琥珀警示标，明细面板明写"变更推送已断开：下面这些数字不会再自动更新"；
   - 解封/恢复后刷新页面（或切走再切回标签页）：标记消失、流重新连上；
   - **不应**出现周期性的重读请求，也不应出现读取风暴（一次故障只补读一次）。
6. 关掉这个标签页，宿主侧那条流应随之结束（浏览器关连接 → 宿主 abort → 流关闭），不会积压。

回滚：装回 0.3.0 的 tarball 即可（同一套命令）。

### 升级发版

```powershell
# 站在本插件目录里
# 1. 递增 package.json 版本号
pnpm check
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist\dsh-ability-strip-<新版本>.tgz
dsh plugin --profile web add ./dist/dsh-ability-strip-<新版本>.tgz
# 2. 浏览器 Ctrl+F5；页面应出现  skill | N | MCP | N
```

### 回滚 / 卸载

- 回滚：`dsh plugin --profile web add ./dist/dsh-ability-strip-<旧版本>.tgz` + `Ctrl+F5`（站在插件目录里）。
- 卸载：`dsh plugin --profile web remove dsh-ability-strip`。
- 不要改源码当回滚用——源码与运行副本无任何链接。

### 升级 dsh 时必须复查的版本耦合点

1. 槽位 `conversation.composer.dock` 仍存在且在输入行**之后**渲染（挪到 `conversation.input.dock` 会跑到输入框上方）；
2. `connection.rpc.call("/api", ...)` 信封（`client-request`/`server-response`）与 `connection.fetch.register` 精确路由契约不变；
3. **`connection.fetch.register` 的精确路由仍然返回 handler 自己的 `Response` 且 `bridge` 逐块写出 `response.body`**——变更流依赖这一点（它是一条常开的流式响应，不是一次性 JSON）。同时确认 `/api` 前缀路由仍由 `bridge` 承载（只看 `dsh-client-connection` 的 `createSharedFetchHandler` 与 `apply` 两处）；
4. **宿主 webServer 的 gzip 过滤器仍豁免 `content-type: text/event-stream`**（否则帧会被压缩缓冲成一坨，页面表现为"流连上了但永远不更新"）；
5. `ctx.tools.schemas()` 深拷贝语义与 `tools/change` 事件仍存在（后者同时是缓存失效与推送的信号源）；
6. `mcp__<server>__<tool>` 命名约定不变（拆分逻辑依赖它）；
7. 基线模块表仍含 `react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`（`check-bundle-contract` 会抓住漂移）；浏览器侧还依赖全局 `EventSource`（标准 API，无需声明）；
8. `ui.Button`/`ui.Tag` 契约（size/tone 取值）不变。

## 7. 已知限制（README 有完整论述）

- 推送只覆盖工具注册表：MCP 那半是实时的；`skills/list`、`pluginInventory/list`、`pluginManager/listBundles` 三块没有对应的变更信号（可用的近似事件见 README），只在打开明细 / 切回标签页 / 手动刷新时重读——所以收起态的 skill 计数可能是几分钟前的。
- 推送断开时的行为：能力条显示"推送断开"（收起态一个 11 px 警示标 + 面板里一句话），并补读一次，然后**不会自动恢复**——`EventSource` 自己会重连，彻底不再重试的情况要等切回标签页或点刷新。断开期间数字会冻结，但读者能看见它冻结了，这是有意取舍：加定时重试等于把这次删掉的轮询请回来。
- 推送通道占一条浏览器连接：每个页面一条常开的 SSE（HTTP/1.1 同源上限 6 条）。空闲不发数据，但槽位是占着的；DSH 自己的 client-hmr 用同样的做法。
- 连上但零工具 = 未连接：`dsh-mcp-client` 连接对象私有，两种情况从注册表不可区分；工具不可用即未连接，是有意读法。
- 无连接细节：失败原因在 Host 日志，页面拿不到——弹窗明说这一点。

## 7.5 技术债

### 债 1：客户端 require 了 `@deepseek-ai/dsh-client-ui-primitives` —— **已于 0.5.0 偿还**

DSH 随包的官方 skill `cordis-plugin-development` 的 `references/practices.md` 写着：

> **Do not `require('@deepseek-ai/dsh-client-ui-primitives')`** or load any other Harness Client package as a module… They change without notice, a plain-JS plugin has no type check, and **a throwing component blanks your slot entry** (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin … keep only `--dsw-alias-*` token references …

**当时的状态**：`lib/client.js` 曾 require 它，用 `ui.Button` / `ui.Tag` / `ui.Modal` / 11 个 `ui.Icon*`。真机能跑，但风险是官方点名的：0.2.2 已经把 `ui-primitives`/`dockkit`/`slots`/`store` 四个包**合并进 shell**，只因模块表恰好仍暴露这些名字才没炸。

**0.5.0 怎么做的**：

- `lib/client.js` 顶部新增一段**本地 UI kit**（`Icon` / `Tag` / `Button` / `Modal` + 10 条图标 path），`require` 面收敛为 `["react","react-dom"]`。
- 色彩**只**引用 `--dsw-alias-*`：`state-warn-primary`、`state-error-primary`、`state-success-primary`、`label-primary/secondary/tertiary`、`bg-layer-1`、`bg-base`、`bg-mask-1`、`border-l2`、`button-primary-fill`、`interactive-bg-hover`。这些名字不是猜的——在真机页面用 `getComputedStyle` 读过。**注意它们定义在 `<body>` 上并向 composer dock 继承，`document.documentElement` 上查是空的。**
- `Modal` 自己实现：portal 到 `body`、`role="dialog"` + `aria-modal="true"`、Escape（capture 且消费事件，避免同时关掉后面的面板）、遮罩点击关闭、打开时移入焦点 / 关闭时归还、Tab 在对话框内循环。
- 图标是 16×16 单 path 的 outline SVG，`stroke="currentColor"` + `vectorEffect: non-scaling-stroke`；加载态用 SMIL `animateTransform` 旋转，不依赖样式表。

**守卫**（把规则变成会红的检查，而不是注释）：

- `check-bundle-contract.mjs` 的基线允许表**只留 React**，并单列一条断言：`require` 里出现任何 `@deepseek-ai/*` 即失败，失败信息带官方出处。变异验证：把 primitives 加回去 → 立刻 `RESULT: FAIL`。
- `check-render.mjs` 新增 `collectElements()`，断言故障对话框里的图标**渲染成真实 `<svg>`**，且调用点传的 `style.color` **透传到 svg**。后一条是真踩到的 bug：`Icon` 最初吞掉 `style`，红色故障图标会退回继承色（变异验证：去掉透传 → 该断言红）。

**残留代价（如实说）**：这些控件的外观不再随宿主升级自动演进——宿主改了按钮圆角或 Tag 配色，本插件不会跟。这是官方指引接受的交换。

### 债 2：安装入口不是官方 `plugin_manager install_bundle`

官方入口传包**目录**（= 链接源码）并返回 `application` / `restart-required`。本仓库用 `dsh plugin --profile web add <tarball>`（为了发布隔离），代价是拿不到官方的 `restart-required` 信号，只能靠"探测只有新代码才有的路由"自查。详见仓库根 `INSTALL.md` §15.2。

## 8. 历史与决策记录

| 时间 | 事件 | 决策/结果 |
|---|---|---|
| 2026-10-27 | 首版 `dsh-runtime-inspector` 以 link 形态安装 | 踩实 `pkgMeta` 绝对路径缓存坑：源码即线上，重装 tarball 也救不回 |
| 2026-10-27 | **改名 `dsh-ability-strip`** 并改为 tarball 安装 | 新 specifier = 新缓存 key，不重启修复；安装隔离铁律由此确立 |
| 2026-10-28 | 0.3.0：新增宿主半边 | 工具注册表读取 + `/api/ability-strip` 路由 + MCP 工具数/故障弹窗 + 浮动明细面板 |
| 2026-10-28 | 两轮 × 2 静态评审 | 全部发现（HIGH-1、MEDIUM 若干、LOW 系列与建议项）修复并页面实测；原始评审文档未存档（本 HANDOFF §5 为重建） |
| 2026-10-28 | 安装 + 页面实测 | `skill \| 22 \| MCP \| 29`、明细、工具名、故障弹窗全过 |
| 2026-10-28 | 推送 GitHub | `whengu/dsh-ability-strip` 公开仓（`7e228a0`） |
| 2026-11-02 | README 全文中文化 + AI 编写声明 | `4b6551c`；安装形态澄清为 tarball 拷贝，link 论述降为历史决策 |
| 2026-11-03 | **单仓库迁移** | 解散独立 `.git`，移入 `dsh-plugins\`；profile 从新路径重新登记（相同字节，哈希复核一致） |
| 2026-11-04 | 远程复用与更名 | 单仓库推送回原 GitHub 仓库 `whengu/dsh-ability-strip`（不新建仓库），旧两个提交以 `-s ours` 合并保留；随后仓库更名为 `whengu/dsh-plugins` |
| 2026-11-09 | **dsh 升级兼容复核（0.2.1-rc.5 → 0.2.2-rc.1）** | **兼容，无需改代码**。真机证据：`[data-composer-dock]` 显示 `skill 22 / MCP 28`；点击展开明细 6979 字符、三节齐全、**0 处读取失败**。契约核对：`rpc.call(channel, endpoint, payload, signal)` 与 `` `${channel}/${endpoint}`.slice(1) `` 拼接未变；`client-request`/`server-response` 信封未变；精确 Fetch 路由 `{path, methods}` 未变；基线模块名仍在 shell 模块表。**变化提醒**：`dsh-client-ui-primitives`/`-dockkit`/`-slots`/`-store` 已不再是独立 npm 包（并入 shell bundle），模块解析不受影响，但不要写进 `dependencies` 指望从磁盘解析 |
| 2026-11-09 | **0.4.0：定时轮询 → 变更推送** | 起因是用户反馈"它是在页面上定时的，这样做不优雅"。**为什么不能走 DSH 的转发事件**：`typertGateway.registerRemoteEvents()` 是单例（`dsh-api-gateway\lib\index.js` 里已有注册就抛 `already registered`），运行时那个位置归 `dsh-api-remotes`——全站 `ctx.remote.$on` 的唯一数据源；其事件白名单是包内封闭静态数组（30 条，无 `tools/change`），没有对外追加 API；浏览器侧 `$on` 对事件名不做运行时校验，订阅一个不在白名单里的事件不报错、只是永远不触发（静默失效）。**怎么做的**：本包自己的精确 Fetch 路由返回流式 `Response`（`createSharedFetchHandler` 把 handler 的 Response 原样返回，`/api` 前缀由 `bridge` 逐块写 `response.body`），按 DSH 自己的 client-hmr 先例用 SSE；浏览器侧用原生 `EventSource`（不引依赖，仍是零运行时依赖）。**取舍**：代价是每页一条常开连接，收益是页面上再无定时器、MCP 变化延迟从"最迟 15 秒"变成"事件发生那一刻"；被否决的方案见 README「两半如何通话」与「已知限制」。**验证**：`pnpm check` 三项 PASS + 变异矩阵逐条确认会失败（含"重新加回 15 秒 setInterval 必须被抓到"）。**未真机验证**（本轮禁止部署），装机后的验证步骤见 §6 |
| 2026-11-09 | **0.4.0 复审修复（推送断开 + 拆流泄漏）** | 复审指出两处真缺陷，都已修。**(1) 变更流断开后能力条静默停更**：`EventSource` 遇到致命状态（非 200、content-type 不对）**永不重试**，而原实现只挂了 `message`，于是没有任何读取、数字冻结却看不出「停更」——把静默失败从 MCP 转移到了自己的传输层。修法：`error` 上补读一次（`compensated` 闸保证一次故障只补一次，`open`/`message` 复位）、状态可见（收起态 11 px 警示标，健康时不渲染所以宽度不变；面板里一句话）、切回标签页重开被彻底关闭的流（仍无定时器）。**(2) `send()` 的 `catch` 破坏清理路径**：原来 `catch` 只置 `closed`，而 `shutdown` 以 `closed` 早退，导致 `detach()` 与 `streams.delete` 都不执行——安全网失败反而制造泄漏。修法：把 `closed`/拆除两义合一为单个 `cleaned` 闸，`catch` 直接调 `shutdown()`；并给 reader 加只读 `subscribers`，用真实流逐条测三条结束路径（abort / cancel / unload）都清空订阅者与 unload 集合。**覆盖诚实度**：(1) 的每个分支都有能抓到回归的变异（去 `error` 监听、去一次性闸、不重置闸、去重开、无条件重开）；(2) 的 `catch` 分支**没有任何可触发路径**，变异后检查仍全绿——它是正确的安全网而非被证明的行为，未强行造测试入口 |
| 2026-11-09 | **0.4.0 装机 + 发现宿主不热重载** | 打包（`verify-pack` PASS）→ `dsh plugin add ./dist/…-0.4.0.tgz` → 硬刷新。**客户端 0.4.0 生效**：渲染 `skill 22 / MCP 28`，并因推送未通而正确显示琥珀警示标（**这是修复 (1) 的真机验证**）。**宿主半边未生效**：`GET /api/ability-strip/events` 返回 404，而 `POST /api/ability-strip` 正常 200 且带真实数据。定位：Loader 用普通 `import()`，同一 specifier 命中 Node ESM 缓存；`dsh-hmr` 只监视 patch/清单并重组层，**不重新求值宿主模块**。结论：**宿主半边改动必须重启 Host**（我此前在 INSTALL.md/README 写的"Host 不需要重启"是错的，已全仓纠正，并给出"探测只有新代码才有的路由"这个判别法） |
| 2026-11-09 | **查官方口径（结论：方向对，另有三处偏离）** | 用户质疑"DSH 大多数东西都热重载，是不是走错方向"。找到随包安装的官方 skill `dsh-agent-preset/skills/cordis-plugin-development/`，其 `references/host-plugin.md` 明文：**"Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation."** → 重启要求是官方规则，非我方判断失误。`references/practices.md` 亦明文 **"Do not poll"** / "Wait on durable events"，故"轮询→事件推送"方向与官方一致。同时发现三处偏离：**(1) 客户端 require `ui-primitives` 被官方明文禁止（技术债，见 §7.5）**；(2) 安装入口应为 `plugin_manager install_bundle`（我们用的是 `dsh plugin add`，拿不到 `restart-required`）；(3) 官方本地开发用目录安装（= 链接），本仓库为发布隔离而禁用。已全部写入仓库根 `INSTALL.md` §15 |
| 2026-11-09 | **0.5.0 偿还 §7.5 债 1：剥离 primitives 依赖** | 用户要求"处理技术债和质量问题，范围全仓库"。做法：在 `lib/client.js` 内实现本地 UI kit（Icon/Tag/Button/Modal + 10 条图标 path），色彩只用真机读出来的 `--dsw-alias-*`；`require` 面从 `["react","react-dom","@deepseek-ai/dsh-client-ui-primitives"]` 收敛到 `["react","react-dom"]`。**宿主半边一字未改**（`lib/index.js` 归一化哈希仍为 `E3E8BDD6FBB46C92`），所以本次装机不需要重启 Host，硬刷新即可。附带修掉两个真 bug：①`Icon` 吞掉调用点传的 `style`（彩色故障图标会退回继承色）；②`check-render` 的 `createElement` 不像 React 那样写 `props.children`，换成按 React 契约解构 children 的组件后会静默丢文本。两处都补了断言并做变异验证。 |
| 2026-11-09 | **0.6.0 新增 tools 标记：回答「dsh 向 agent 暴露了哪些工具」** | 用户问能否用插件呈现"dsh 向 agent 暴露了哪些工具"，并问能否和 MCP 合到一起。**能，且合到本插件最合适**——它本来就在读工具注册表。查证结论：① 浏览器侧**没有** tools 版 Remote（`dsh-api-remotes` 里无对应命名空间），所以必须改宿主半边；② `ctx.tools.schemas(scope)` 的 scope 要传 **Agent 对象**（`dsh-tool-executor-ptc` 用 `schemas(exec.agent, exec.toolSet)`、`dsh-tool-cordis` 用 `schemas(context.agent)`），省略则是全局视图；③ `Agents.get(id)` 的入参正是 shared agent/session id，所以会话 id 能解析到 agent。实现：路由开始接收 `payload.sessionId`（此前丢弃），宿主按 `schemas(agent)` 读并在负载里加 `scope`（agent/global）与 `local`（非 MCP 工具名）；reader 缓存改为**按 sessionId 分键**（不同 agent 的 restriction 不同，不能互相喂答案）；客户端新增第三个标记 `tools`（总数）与面板「工具」分区。两条边界如实写进 README：不含按步准入（未传 toolSet）、`local` 不等于"内置"（schema 无来源字段）。变异验证：忽略 sessionId → 5 条断言红；scope 标注恒为 global → 1 条红。**0.6.0 的宿主字段需重启 Host 才生效。** |
| 2026-11-09 | **0.7.0 紧凑化 + 工具描述** | 用户三点要求：①工具描述能否顺手显示；②状态栏空间不足，移除 `skill`/`MCP`/`tools` 文本只留图标；③MCP 无连接时不要文字，只给图标，"无"/详情挪到展开面板。实施：宿主汇总改为返回 `{name, description}` 对象（描述取自模型看到的那份 schema，按 400 字符截断并加 `…`，`MAX_DESCRIPTION_CHARS` 可测）；客户端三个 chip 去掉标签，各用图标区分 + `aria-label` + `title`；MCP 状态由"文字"改为"图标"（连上=绿色数字、未连接=琥珀 ✕、故障/读取失败=红色警示），文字移进 tooltip 与面板 MCP 标题右侧；面板里 MCP 工具与非 MCP 工具都用同一 `ToolRow`（名字 + 最多两行描述，完整文本在 tooltip）。**顺带纠正一处我写反的事实**：全局视图并非"更大"——它不含 agent scope 里注册的工具，本机实测同一时刻全局 40 / agent 72，方向是少。变异验证：把 `skill` 标签加回 → 1 条断言红；描述不进渲染文本 → 2 条断言红（MCP 与非 MCP 各一）。 |

## 9. 接手验收清单（接手者照此自证接手完成）

- [ ] `pnpm check` 三项全 PASS；`lib\client.js` 哈希 = `8E532A4D8C8E355D`、`lib\index.js` 哈希 = `E3E8BDD6FBB46C92`。
- [ ] `dsh plugin --profile web why dsh-ability-strip` 有记录；安装副本 `LinkType` 为空。
- [ ] 页面输入框下方出现 `skill | N | MCP | N`；点击行展开明细、再点收起。
- [ ] Network 里有一条常开的 `eventsource`/`text/event-stream` 请求，静置时没有任何周期请求。
- [ ] 能复述 §5 至少三条教训的根因（anchorRef、in-flight 补偿、`/api` 通道）。
- [ ] 知道升级、回滚、卸载各用哪条命令（§6）。
- [ ] 知道 dsh 升级后要复查哪些耦合点（§6 末尾六条）。
- [ ] 知道跨插件规约在仓库根 [INSTALL.md](../INSTALL.md)，本插件安装命令的权威出处是 [README.md](README.md)「安装」节。
