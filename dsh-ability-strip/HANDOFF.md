# HANDOFF：dsh-ability-strip 交接文档

> 交接目标：读完本文 + [README.md](README.md)，接手者应当能在**不问任何历史问题**的前提下维护、升级、回滚本插件。
> 本文写于 2026-11-03，快照基线：dsh `0.2.1-rc.5`、pnpm `12.9.1`、Windows、profile `web`。
> **来源声明（如实）**：本插件的评审发生在开发会话内（两轮 × 2 名独立评审），原始评审文档**未落盘存档**，只存在于已被压缩的会话记录中。本文的评审结论是**重建**：依据为 git 历史、README/INSTALL 文本、会话存档摘要。与其余插件的原始评审档案（如 dsh-subagent-wait-reminder 的 REVIEW-*.md）相比，本文精度受限，接手者应以代码与检查脚本为准。

## 1. 这是什么，为什么存在

**一句话**：DSH Web GUI 输入框下方的**只读**能力条（`conversation.composer.dock` 槽位）。收起态显示 `skill | N | MCP | N`——本会话可见的 skill 数量、MCP 注册的工具总数；点击整行展开浮动明细面板（skill 清单、每个已连接 MCP 服务器的工具数与工具名、Loader 行 phase、资源插件、插件包）。

**问题起源**（用户原话：「不要现在就是盲盒, 我啥也看不到」）：GUI 默认不显示当前会话到底有哪些生效的 skill 和 MCP。浏览器没有 MCP 状态 Remote，唯一可观测事实是**工具注册表**（`mcp__<server>__<tool>` 命名），所以本包带宿主半边读 `ctx.tools.schemas()`，经自己的 Fetch 路由发给浏览器。

**已证实的效果**：页面实测收起态 `skill | 22 | MCP | 29`，明细展开/收起、29 个工具名列出、MCP 故障弹窗触发与关闭均实测通过（2026-10-28）。

## 2. 当前状态快照

| 项 | 状态 |
|---|---|
| 安装 | `web` profile，版本 0.3.0；2026-10-28 以 tarball 首装，2026-11-03 随单仓库迁移从新路径重新登记（相同字节） |
| 装载 | 已进 `dsh.profile.bundles`，页面实测有效 |
| 页面验证 | 收起/展开/明细/故障弹窗全过（2026-10-28） |
| 静态评审 | 两轮 × 2 评审，全部发现已修复（结论重建于本文 §5） |
| 版本管理 | 曾独立成仓 GitHub `whengu/dsh-ability-strip`（`7e228a0..4b6551c`，**现为冻结存档**）；2026-11-03 解散 `.git` 并入单仓库 |
| 待办 | 无阻塞事项 |

## 3. 资产地图（哈希为 SHA256 前 16 位，迁移时点快照）

### 开发源码（权威）：`D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-ability-strip\`

| 文件 | 哈希 | 说明 |
|---|---|---|
| `lib\index.js` | `296F6FBCF1121208` | 宿主半边：读 `ctx.tools.schemas()`，服务 `/api/ability-strip` |
| `lib\client.js` | `2AF536B46CF5AF29` | 浏览器半边：能力条本体，lazy-CJS `__ModuleLoader__` 形态，约 1200 行 |
| `cordis.patch.yml` | `6053C78AEE545759` | bundle patch（`- insert: [{id: ability-strip, name}]`） |
| `package.json` | `D87CB9FEF30A3BC7` | `dsh.bundle.patch` + `dsh.client.platform: "web"` + `engines.dsh >=0.2.0-rc.2` |
| `README.md` | `2626120D206B3606` | 中文完整文档（含 AI 编写声明） |
| `scripts\check-*.mjs` ×3 | — | host 契约 / bundle 契约 / 渲染检查（`pnpm check` 三连） |
| `scripts\verify-pack.mjs` | — | tarball 与源码树逐条比对 |
| `dist\dsh-ability-strip-0.3.0.tgz` | — | **发布产物，40212 B，不得覆盖不得删除**（profile lockfile 记录其 sha512） |

注：本插件最初自带的 `INSTALL.md` 已升格为**仓库根** [INSTALL.md](../INSTALL.md)（跨插件唯一权威），本插件不再单独持有；本插件的具体命令在 [README.md](README.md)「安装」节。`profile-backups\` 是改 profile 前的会话备份，git 忽略、不随包发布。

### 运行副本（只读）：`C:\Users\guwh\.dsh\profiles\web\node_modules\dsh-ability-strip\`

- `lib\client.js`、`lib\index.js` 与源码**逐字节一致**（迁移重装后哈希复核通过）。
- `README.md` 是打包时的**英文旧版**（源码后来中文化）——有意不同步，文档不影响行为，下次发版自然带上。
- 普通目录（`LinkType` 为空），非符号链接。

### profile 登记

- 依赖指向 `file:<本仓库路径>\dist\dsh-ability-strip-0.3.0.tgz`；`dsh.profile.bundles` 含本包名。
- 改动这两个记录的唯一合法途径是 `dsh plugin --profile web add/remove`，**禁止手工编辑**。

## 4. 工作机制速览（细节见 README）

1. **双半分工**：浏览器半边每 15 秒（页面可见时）经 `connection.rpc.call("/api", "ability-strip", ...)` 读宿主半边；宿主半边读工具注册表并按 `mcp__<server>__<tool>` 约定分组计数，自带缓存（`tools/change` 失效，失败不缓存）。
2. **三道轮询护栏**：宿主缓存（答案没变不调 `schemas()`）、`samePayload` 抑制（数据没变不重渲染）、in-flight 闩（慢 Host 不叠请求）。三者各有一条变异测试钉死。
3. **故障状态机**：已配置且启用但零工具注册 → 连接故障弹窗（按服务器名去重，只弹一次）；无配置/全禁用 → 未连接不弹；注册表读不动 → 读取失败不弹。

## 5. 接手必读的教训（**重建自会话存档**，原始评审未存档）

1. **`anchorRef` 必须真的绑到 DOM**（高危）：面板定位依赖锚点，ref 未绑时 `place()` 早退、面板永久不可见——静态读代码发现不了绑定缺失，页面一动就知道。
2. **in-flight 跳过必须补偿**（中危）：读取进行中的轮询直接返回时，必须递增 `requestId` 并标记补读，否则旧会话数据会写进新会话。
3. **`fiberPhase` 判定要排除 `null`/`unloading`**（中危）：把非稳态当已定，会在 MCP 启动期（pending/loading）误报连接故障弹窗。稳态 = `active || failed`。
4. **RPC 通道必须是 `"/api"`**（中危）：`rpc.call` 对通道做 `.slice(1)` 剥前导斜杠——写 `"api"` 会发成 `pi/...` 404。
5. **`mcp__` 拆分是启发式不是约定回析**（中危）：DSH 从不解析公共工具名，`mcp__<server>__<tool>` 只能按最后一个 `__` 启发式拆分；文档不得声称「与 harness 同规则」。
6. **UI 契约先查再用**（低危系列）：`ui.Button` 的 `size` 只有 `md`/`sm`（无 `xs`）、`ui.Tag` 的 `tone` 无 `plain`（用 `quiet`）；Modal 的 `aria-modal` 会截获 Escape、outside-click 要跳过 `[role="dialog"][aria-modal]`；`samePayload` 漏字段（bundle 版本/行数/资源条目 id）会让抑制失效；宿主缓存失败结果会让瞬时错误钉死。
7. **元规则**：静态评审与执行验证互补，缺一不可；改 UI 契约前先读 `@deepseek-ai/dsh-client-ui-primitives` 的实际契约，不凭印象。

## 6. 维护手册

### 日常验证（改完任何东西后做一次）

```powershell
pnpm check    # check-host + check-bundle-contract + check-render，必须全部 RESULT: PASS
```

渲染检查覆盖全部显示状态（首绘/已载/收起/展开/各类失败/弹窗触发与三道轮询护栏的变异测试），不需要浏览器。

### 升级发版

```powershell
cd D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-ability-strip
# 1. 递增 package.json 版本号
pnpm check
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist\dsh-ability-strip-<新版本>.tgz
dsh plugin --profile web add "D:\...\dsh-plugins\dsh-ability-strip\dist\dsh-ability-strip-<新版本>.tgz"
# 2. 浏览器 Ctrl+F5；页面应出现  skill | N | MCP | N
```

### 回滚 / 卸载

- 回滚：`dsh plugin --profile web add <旧版本 tgz 绝对路径>` + `Ctrl+F5`。
- 卸载：`dsh plugin --profile web remove dsh-ability-strip`。
- 不要改源码当回滚用——源码与运行副本无任何链接。

### 升级 dsh 时必须复查的版本耦合点

1. 槽位 `conversation.composer.dock` 仍存在且在输入行**之后**渲染（挪到 `conversation.input.dock` 会跑到输入框上方）；
2. `connection.rpc.call("/api", ...)` 信封（`client-request`/`server-response`）与 `connection.fetch.register` 精确路由契约不变；
3. `ctx.tools.schemas()` 深拷贝语义与 `tools/change` 事件仍存在；
4. `mcp__<server>__<tool>` 命名约定不变（拆分逻辑依赖它）；
5. 基线模块表仍含 `react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`（`check-bundle-contract` 会抓住漂移）；
6. `ui.Button`/`ui.Tag` 契约（size/tone 取值）不变。

## 7. 已知限制（README 有完整论述）

- 轮询不是推送：掉线服务器最迟一个周期（15 秒）才显示；实时推送需要 Typert Remote Event 声明，对本插件的体量不成比例。
- 连上但零工具 = 未连接：`dsh-mcp-client` 连接对象私有，两种情况从注册表不可区分；工具不可用即未连接，是有意读法。
- 无连接细节：失败原因在 Host 日志，页面拿不到——弹窗明说这一点。

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
| 2026-11-03 | **单仓库迁移** | 解散独立 `.git`（GitHub 转冻结存档），移入 `dsh-plugins\`；profile 从新路径重新登记（相同字节，哈希复核一致） |

## 9. 接手验收清单（接手者照此自证接手完成）

- [ ] `pnpm check` 三项全 PASS；`lib\client.js` 哈希 = `2AF536B46CF5AF29`。
- [ ] `dsh plugin --profile web why dsh-ability-strip` 有记录；安装副本 `LinkType` 为空。
- [ ] 页面输入框下方出现 `skill | N | MCP | N`；点击行展开明细、再点收起。
- [ ] 能复述 §5 至少三条教训的根因（anchorRef、in-flight 补偿、`/api` 通道）。
- [ ] 知道升级、回滚、卸载各用哪条命令（§6）。
- [ ] 知道 dsh 升级后要复查哪些耦合点（§6 末尾六条）。
- [ ] 知道跨插件规约在仓库根 [INSTALL.md](../INSTALL.md)，本插件安装命令的权威出处是 [README.md](README.md)「安装」节。
