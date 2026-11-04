# HANDOFF：dsh-subagent-wait-reminder 交接文档

> 交接目标：读完本文 + [README.md](README.md) + 三份评审档案，接手者应当能在**不问任何历史问题**的前提下维护、升级、回滚本插件。
> 本文写于 2026-11-03，快照基线：dsh `0.2.1-rc.5`、pnpm `12.9.1`、Windows、profile `web`。

## 1. 这是什么，为什么存在

**一句话**：dsh 宿主侧插件。主 agent 派发子智能体（`subagent`/`subagent_fork`）或查询其状态（`list_agents`）之后，在该 agent 的下一个 step 边界注入一条 system-reminder：「等完成通知，不要轮询」。

**问题起源**（用户观察到的真实病灶）：agent 派发 subagent 后反复调用 `list_agents` 轮询，每次都要用户喊停才停。三层根因，全部在 DSH 运行时源码中定位到行号（见 [README.md](README.md) 机制表）：

1. 派发工具返回文本只有 `started subagent <id>`——决策点上没有任何「接下来该做什么」的指引；
2. 防轮询的唯一语句写在 `list_agents` 工具自己的 description 里（"there is no need to keep checking"），模型读到它时已经决定要查了，且 "no need" 是许可语气不是禁止；
3. 派发工具描述里的 "steer it while running" 把运行期监视合法化。

**方案**（用户提出并拍板）：不靠再喊一遍「不要轮询」，而是在决策点注入声明。完成通知机制本身可靠（实测证实：子智能体结束必通知），所以只要让模型在派发后的第一次请求里读到「通知必达、无需查询」，轮询的诱因就消除了。

**已证实的效果**：三类真实场景实测全过（单发/重启冷载/一步扇出 3 个），详见 [README.md](README.md)「生产验证记录」。

## 2. 当前状态快照

| 项 | 状态 |
|---|---|
| 安装 | `web` profile，版本 0.1.0，2026-11-02 以 tarball 安装 |
| 装载 | 已进 `dsh.profile.bundles`，重启冷载实测有效 |
| 生产验证 | 三场景全过（2026-11-02/03），零 `list_agents` 轮询 |
| 静态评审 | 三轮：v1 FAIL → v2 PASS → v3 PASS（v3 覆盖可安装形态与 step 闩） |
| 待办 | 无阻塞事项；可选事项见 §7 |

## 3. 资产地图（哈希为 SHA256 前 16 位，交接时点快照）

### 开发源码（权威）：`D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder\`

| 文件 | 哈希 | 说明 |
|---|---|---|
| `lib\index.js` | `878A22AB18B45554` | **唯一可执行代码**，v3 评审对象，7268 B，零外部依赖（仅 node:crypto） |
| `cordis.patch.yml` | `503F34696620EF36` | bundle patch（`- insert: [{id, name}]`），安装时由 dsh 自动登记 |
| `package.json` | `BD4E92680D4DC35A` | 含 `dsh.bundle.patch` 声明（必需，否则只装不加载）；`engines.dsh >=0.2.1-rc.5` |
| `README.md` | `B07A093872FF9AFB` | 完整文档：机制表（逐条源码行号）、限制、边界、验证记录、故障排查 |
| `REVIEW-v1-FAIL.md` | `3585DB4BE0B3B6E1` | v1 评审：抓出静默 no-op（见 §5 教训一） |
| `REVIEW-v2-PASS.md` | `5427BDCDC82CB02A` | v2 评审：端到端闭合；裁决出扇出重复注入问题 |
| `REVIEW-v3-PASS.md` | `D948D1F8F435E1B9` | v3 评审：安装链路逐行核实 + step 闩 + 全回归 |
| `dist\dsh-subagent-wait-reminder-0.1.0.tgz` | `589D7BB0C41B8A56` | **发布产物，8471 B，不得覆盖不得删除**（profile lockfile 记录其 sha512，dependencies 引用其绝对路径） |

`REVIEW-*.md` 与本文（`HANDOFF.md`）是开发期档案，**不在 `package.json` 的 `files` 白名单内、不随包发布**。

> **2026-11-03 单仓库迁移注记**：插件目录已移入 `default-workspace\dsh-plugins\`，profile 已从新路径重新登记（相同字节重装）。上表哈希为**迁移前快照**：`lib\index.js`、`cordis.patch.yml`、`package.json` 未动（哈希仍有效）；`README.md` 与本文的路径/引用已更新——两者哈希已变，以当前文件为准。

### 运行副本（只读）：`C:\Users\guwh\.dsh\profiles\web\node_modules\dsh-subagent-wait-reminder\`

- `lib\index.js` = `878A22AB18B45554`，`cordis.patch.yml` = `503F34696620EF36`——**与源码逐字节一致**。
- `package.json` = `462707F5FB4090B4`，与源码 `BD4E92680D4DC35A` 的差异**仅键序**（pnpm pack 规范化所致），字段与值完全一致（已逐字段 diff 确认）。
- `README.md` = `7F936E139D0A6016`，是打包时旧版；源码 README 收尾时补了生产验证记录等章节，**有意不同步**（文档不影响行为），下次发版自然带上。

### profile 登记（安装状态的事实记录处）

- `C:\Users\guwh\.dsh\profiles\web\package.json`：`dependencies` 中 `dsh-subagent-wait-reminder` 指向 tgz 绝对路径；`dsh.profile.bundles` 数组含本包名。
- 改动这两个记录的唯一合法途径是 `dsh plugin --profile web add/remove`，**禁止手工编辑**。

## 4. 工作机制速览（细节与源码行号见 README「机制」表）

1. **检测**：`tools/post-execute` 瀑布，按 `exec.name` 分类（`subagent`/`subagent_fork` → dispatch；`list_agents` → poll）；派发工具改名有文本兜底（其固定返回 `started subagent `，全运行时唯一）。`isError` 跳过（失败/被拒调用没有子智能体在跑）。
2. **注入**：`PostToolDecision.additionalContexts` 携带 user 消息 → 注册表合入结果 → 循环在 step 边界接收 → 进入下一次模型请求。
3. **去重**：`WeakMap<Agent, Set<action>>` 闩，一步内同类动作只注入 1 条（扇出 5 个只提醒 1 次）；`agent/pre-step` 清闩——**pre-step 在这里只做状态重置，绝不用于检测**（原因见 §5）。

## 5. 接手必读的三条教训（踩过的坑，成本已付）

### 教训一：事件载荷的类型声明是唯一可信依据（v1 FAIL，代价一整轮返工）

首版用 `agent/pre-step` 检测「上一步派发过 subagent」——**类型上不可能成立**：该事件载荷是 `messages: UserMessage[]`（api-catalog:4006、`PreStepDecision:6424`），实参来自 `inbox.claim()` 的入站批次（dsh-agent-loop:906-912）；`tool-call` 块属 `AssistantMessage`、工具结果属 `role:'tool'`，两者都进不了这个数组。插件成了静默 no-op，所有下游逻辑（去重、兜底）一并落空。

更刺痛的是：证据当时就在手边——`dsh-tool-skill` 的 `invokedSkillNames` 里有 `if (message.source.kind !== "user") continue`，我读进了上下文却没推下去。评审抓出来后才修。

**接手者的铁律：写任何事件监听前，先查该事件载荷的类型声明（`dsh-tool-cordis/lib/types/api-catalog.js`），逐个确认要读的字段存在于该类型；只读类型确认过的字段。** 官方先例 `dsh-repeat-tool-reminder` 的分工（检测在 post-execute、pre-step 只识别真实用户输入）是现成模板。

### 教训二：提醒文案的两种歧义（用户裁决，改措辞两次）

- 「结束通知会**自动到达**」会被读成「查询触发通知」——必须写成「系统会**主动**送达，**与是否查询无关**」；
- 对 `list_agents` 用「**避免**」而非「禁止」（产品决策）；
- 文案不得含会被 `list_agents` 实际返回值证伪的断言（如「查询不带来新信息」——它其实返回 status）。

改文案时保持这三条约束，需求方对措辞敏感。

### 教训三：安装规约（用户纠偏，推翻过我的整个安装方案）

- **只从 tarball 安装**。目录/`link:` 安装 = 符号链接 = 源码即线上，且 `dsh-client-modules` 的路径缓存让坏形态重装都救不回；
- `dsh.bundle.patch` 是自动激活的前提：没有它，`dsh plugin add` 只登记依赖并打印 `declares no dsh.bundle` 警告，**插件永不加载**；
- 每次发布必须递增版本号（tarball 不可覆盖，lockfile 记 sha512）；`dist/` 不可删；
- Host 不需要重启（`dsh-hmr` 重组层）；本插件纯 Host 侧，也不涉及 `Ctrl+F5`。

完整规约见仓库根 `..\INSTALL.md`（[INSTALL.md](../INSTALL.md)，跨插件唯一权威：安装隔离 · 目录骨架 · 单仓库）。本插件的具体命令在 [README.md](README.md)「安装」节。

## 6. 维护手册

### 日常验证（改完任何东西后做一次）

1. `pnpm check`（= `node --check lib/index.js`）→ exit 0。
2. 真实派发一个子智能体 → 派发结果后应紧跟一条 user 角色 `<system-reminder>`（内容即 README「作用」引文）。
3. 子智能体结束后应自动收到完成通知，全程不应有任何 `list_agents` 调用。

### 升级发版

```powershell
cd D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder
# 1. 改代码 → package.json 递增版本号（如 0.1.1）
pnpm check
pnpm pack --pack-destination dist
tar -tzf dist\dsh-subagent-wait-reminder-0.1.1.tgz     # 应含 package/lib/index.js、package/cordis.patch.yml
dsh plugin --profile web add "D:\...\dist\dsh-subagent-wait-reminder-0.1.1.tgz"
# 验证：dispatch 一次看提醒；LinkType 为空；dsh plugin --profile web why 有记录
```

### 回滚 / 卸载

- 回滚到旧版：`dsh plugin --profile web add <旧版本 tgz 绝对路径>`。
- 彻底移除：`dsh plugin --profile web remove dsh-subagent-wait-reminder`。
- 不要改源码当回滚用——源码与运行副本无任何链接。

### 升级 dsh 时必须复查的版本耦合点

本插件对以下运行时行为有版本耦合（行号取自 0.2.1-rc.5，升级后按新版本重新核对）：

1. `tools/post-execute` 事件签名与 `PostToolDecision.additionalContexts` 仍存在（api-catalog ~:4476、~:6384）；
2. additionalContexts 合并进结果并到达 step 边界（dsh-tools ~:3601-3626、dsh-agent-loop ~:504/:572）；
3. `user/message` 落盘校验仍接受自定义 `source.kind`（dsh-session ~:1194-1219）；
4. 派发工具返回文本仍是 `started subagent <id>`（文本兜底依赖它，dsh-tool-subagent ~:436-439）；
5. 派发工具默认名仍是 `subagent`、`list_agents` 未改名（`subagent_fork` 来自 web preset 的 `toolName` 配置，改 preset 需同步 `DISPATCH_TOOLS`）。

## 7. 已知限制与扩展点

| 项 | 说明 | 扩展方向 |
|---|---|---|
| 后台 job 轮询不覆盖 | `pwsh run_in_background`/`job_output` 是另一条循环，防轮询只有系统提示层（与子智能体改造前同样弱点） | 观察到 job 轮询成瘾时，把对应工具名加进 `POLL_TOOLS` 并写专属文案 |
| per-agent 变体注册的工具名 | 按 agent 变体注册导致名字不同时不命中 | 同步更新 `DISPATCH_TOOLS`/`POLL_TOOLS` |
| `list_agents` 无改名兜底 | 名字硬编码（list-agents.js:43-45），当前运行时无改名路径 | 若未来出现配置项，补对应检测 |
| 源码 README 超前于安装副本 | 收尾补文档所致，文档差异不影响行为 | 下次发版自然同步；急同步则重走发版流程 |
| 提醒只到「下一步」 | 提醒是轻推不是硬闸：模型仍可能无视它继续轮询（无运行时拦截） | 备选硬方案 `tools.guard` 直接拒 `list_agents`——被 v1 评审否决（与需求 5「不拦截任何调用」冲突）；若未来要硬闸，需先改需求 |

## 8. 历史与决策记录

| 时间 | 事件 | 决策/结果 |
|---|---|---|
| 2026-11-02 | 用户报告轮询病灶并要求定位工具设计问题 | 实测证实：通知机制可靠，缺口在决策点无提示；方案定为「派发后注入声明」 |
| 2026-11-02 | v1 静态评审 | **FAIL**（静默 no-op）→ 改 `tools/post-execute` 检测 |
| 2026-11-02 | 用户措辞裁决 | 「自动到达」改「系统主动送达、与查询无关」；「禁止」改「避免」 |
| 2026-11-02 | v2 静态评审 | **PASS**；裁决出扇出重复注入 → 加 step 闩（pre-step 仅清状态） |
| 2026-11-02 | 用户指正安装规约 | 推翻目录安装方案 → `dsh.bundle.patch` + tarball（结构改动：package.json、新增包内 cordis.patch.yml） |
| 2026-11-02 | v3 静态评审 | **PASS**（安装链路逐行核实 + step 闩 + 全回归）；采纳 3 处文档精度修正与 engines 收紧 |
| 2026-11-02 | 安装执行 | tarball 装入 web profile，登记形态验证通过 |
| 2026-11-02/03 | 生产验证 | 单发（热载/冷载）+ 扇出×3 三场景全过 |
| 2026-11-03 | 开发收尾 | README 补生产验证记录、故障排查、覆盖边界；本文交接 |
| 2026-11-03 | 单仓库迁移 | 目录移入 `dsh-plugins\`；profile 从新路径重新登记（相同字节重装，安装副本 `lib\index.js` 哈希仍为 `878A22AB18B45554`）；跨插件规约引用改为仓库根 `..\INSTALL.md` |
| 2026-11-04 | 文档归属纠正 | 规约收入仓库根 `INSTALL.md`；曾经抽出的插件级 `INSTALL.md` 撤销，命令并回 [README.md](README.md)「安装」节（同一主题不再两处维护） |

## 9. 接手验收清单（接手者照此自证接手完成）

- [ ] 通读 README「机制」表与本文 §5，能复述 v1 FAIL 的类型级根因。
- [ ] `pnpm check` 通过；源码 `lib/index.js` 哈希 = `878A22AB18B45554`。
- [ ] `dsh plugin --profile web why dsh-subagent-wait-reminder` 有记录。
- [ ] 派发一个子智能体，亲眼确认提醒出现在下一次请求、完成通知自动到达、全程零 `list_agents`。
- [ ] 知道升级、回滚、卸载各用哪条命令（§6）。
- [ ] 知道 dsh 升级后要复查哪些耦合点（§6 末尾五条）。
