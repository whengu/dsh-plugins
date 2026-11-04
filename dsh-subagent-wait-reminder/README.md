# dsh-subagent-wait-reminder

状态：**已安装并实测通过**（web profile，0.1.0，2026-11-02 安装、11-02/03 实测）。静态评审三轮（FAIL→PASS→PASS），真实会话验证三类场景全过（见“生产验证记录”）。

> 注：`REVIEW-*.md` 是开发期评审档案，**不在 `files` 白名单内、不随包发布**——本文件中的评审报告链接只在源码目录有效，安装副本内是死链，属预期。

## 作用

在两种动作之后的下一个 step 边界，向该 agent 注入一条 system-reminder：

1. **创建子智能体**（`subagent` / `subagent_fork` 调用后）：
   > 子智能体完成时，系统会主动把完成通知送进本会话——通知与是否查询无关，不需要任何查询来触发。避免用 `list_agents` 查看运行中状态，不要反复确认它是否还在跑。等待期间继续做独立工作；没有独立工作就结束本轮，收到通知后再继续。只有需要中止时才用 `interrupt_agent`。
2. **查看子智能体状态**（`list_agents` 调用后）：
   > 查询到的运行中状态不改变你要做的事：等系统送达的完成通知。完成通知由系统在子智能体结束时主动送达，与是否查询无关；重复查询不会加速它结束。避免再次查询——继续做独立工作，没有独立工作就结束本轮。

措辞约束（需求）：必须明确“通知与是否查询无关”，不得写成可能被理解为“查询触发通知”的句子；对 `list_agents` 用“避免”而非“禁止”。

## 机制（对齐运行时 dsh 0.2.1-rc.5，逐条有源码出处）

| 环节 | 出处 |
|---|---|
| 检测点：`tools/post-execute` 瀑布，每次实际执行触发一次 | `dsh-tool-cordis/lib/types/api-catalog.js:4476-4482` |
| 决策可携带 `additionalContexts: UserMessage[]`（accept / block 两种变体都支持） | api-catalog `PostToolDecision:6384` |
| 执行字段 `name` / `agent?` / `callId` 是声明字段 | api-catalog `ToolExecutionInput:8176`、`ToolExecution:8168` |
| 结果字段 `isError` / `content` / `additionalContexts` 是声明字段 | api-catalog `ToolExecutionSuccess:8188`、`ToolExecutionFailure:8172` |
| 注册表把决策的 `additionalContexts` 合入结果 | `dsh-tools/lib/index.js:3601-3626`（合并见 :3612） |
| 循环在 step 边界接收这些 context，因而进入下一次模型请求 | `dsh-agent-loop/lib/index.js:504`（参数文档“for the next step boundary”）、消费点 :572 |
| 官方同类插件同一用法：检测在 post-execute，pre-step 只用于识别真实用户输入 | `dsh-repeat-tool-reminder/lib/index.js:2247-2264` |

**为什么不是 `agent/pre-step` 检测**：该事件载荷是 `messages: UserMessage[]`（api-catalog:4006、`PreStepDecision:6424`），实参取自 `inbox.claim()` 的入站批次（dsh-agent-loop:906-912）。`tool-call` 块属于 `AssistantMessage`，工具结果属于 `role: 'tool'`，两者都不可能出现于该数组。

**step 内去重**：`tools/post-execute` 每次执行触发一次且不带 step 标识，因此一步内扇出 N 个子 agent 原本会注入 N 条内容相同的提醒。实现改为“每个 step、每种动作只注入一条”：用 `WeakMap<Agent, Set<action>>` 做闩，并在 `agent/pre-step` 清闩。这里 pre-step 只用于**重置状态**，不参与检测——它确实能拿到 `agent`，而检测所需的调用记录它拿不到。跨步仍会重新提醒（连续轮询每一步都被轻推一次，正是要治的行为）。

## 已知限制（显式取舍，不是疏漏）

- **子 agent 自身也会收到提醒**：监听器绑根 context，任何编排子智能体的角色（含子 agent 派自己的子 agent）都会命中。这是有意的——反轮询规则对所有编排者成立。
- **改名场景的覆盖范围**：`list_agents` 的名字在源码里硬编码、无可配置项（`dsh-tool-subagent-control/lib/types/list-agents.js:45`），当前运行时不存在改名路径，因此没有兜底；派发工具改名有兜底（匹配其固定返回文本 `started subagent `，全运行时唯一）。真正未被覆盖的同类风险是按 per-agent 变体注册工具（`dsh-tools/lib/index.js:2731` 提示的注册方式）导致名字不同——届时需同步更新 `DISPATCH_TOOLS` / `POLL_TOOLS`。
- **失败或被拒绝的调用不注入**：`result.isError === true` 直接跳过——此时没有子智能体在跑，提醒会误导。

## 覆盖边界（本插件不管什么）

- **后台任务轮询不在覆盖范围**：`pwsh run_in_background` / `job_output` 的忙碌轮询是另一条循环，本插件只看子智能体的派发与状态查询。后台 job 的防轮询目前只靠系统提示层（`dsh-tool-jobs` 的工具描述），与子智能体改造前同样的弱点——若实践中观察到 job 轮询成瘾，照本插件的模式（post-execute + additionalContexts）扩展 `POLL_TOOLS` 即可。
- **`send_message` 转向运行中的子智能体不触发提醒**：这是运行期合法交互（DSH 设计如此），不是轮询。
- **`interrupt_agent` 不触发提醒**：中止是合法动作，提醒文案里也明确指向它。

## 验证状态

- 已执行：`node --check lib/index.js` → OK。
- 已执行：字段级类型核对（上表逐条对照 api-catalog 声明），确认没有“凭同名猜测字段”。
- 已执行：三轮独立静态评审，v1 FAIL → v2 PASS → v3 PASS（v3 覆盖可安装形态与 step 闩，报告见 [REVIEW-v3-PASS.md](REVIEW-v3-PASS.md)）。
- 已执行：tarball 打包、装入 web profile、登记形态验证（LinkType 为空、`dsh plugin why` 有记录、bundles 自动登记）。
- 已执行：**真实会话验证三类场景**（见“生产验证记录”），唯一遗留的静态风险已闭合。
- PASS 后的文档级修正（engines 下限收紧、tar 条目前缀说明等）：**可执行代码 `lib/index.js` 未动**，与被审版本逐字节一致；文档 delta 未单独立轮评审，理由：修正内容均为评审建议或纯文档，比例原则。

## 生产验证记录

环境：dsh `0.2.1-rc.5`、pnpm `12.9.1`、Windows、profile `web`。

| 日期 | 场景 | 预期 | 实测 |
|---|---|---|---|
| 2026-11-02 | 单次派发（hmr 热载） | 派发后下一次请求出现 1 条提醒；完成通知自动到达；全程零 `list_agents` | 全部符合 |
| 2026-11-03 | 单次派发（重启后冷载） | 同上，且验证 bundle 从 `dsh.profile.bundles` 持久装载 | 全部符合；安装副本哈希与评审版本一致（`878A22AB18B45554`） |
| 2026-11-03 | 同一步扇出 3 个子 agent | 仅注入 **1 条**提醒（step 闩）；3 条结果与 3 条结束通告全部到达 | 全部符合（A/B/C 标记齐全） |

判定“插件在工作”的直接证据：派发工具结果之后，会话里紧跟着一条 user 角色的 `<system-reminder>`（内容即上文“作用”一节的引文）。

## 评审历史

- 首版（`agent/pre-step` 检测 + `WeakMap` 按 callId 去重 + 文本兜底）被独立评审判 **FAIL**：检测数据源的载荷类型不可能包含所读字段，插件是静默 no-op。完整评审记录存档于 [REVIEW-v1-FAIL.md](REVIEW-v1-FAIL.md)（对应首版哈希 B20FD8F71CAF706B）。
- 根因：把“pre-step 能追加消息”（正确）误当成“pre-step 能读到会话历史里的工具调用”（错误）。证据当时已在手边——`dsh-tool-skill` 的 `invokedSkillNames` 含 `if (message.source.kind !== "user") continue`，我没有推下去。
- 新增自检项（本类错误的拦截点）：**写任何事件监听前，先查该事件载荷的类型声明，逐个确认要读的字段存在于该类型；只读类型确认过的字段。**
- 同类排查：现版本读取的 `exec.name` / `exec.agent` / `result.isError` / `result.content` / `downstream.additionalContexts` 已全部在声明层核对；pre-step 监听只读 `agent` 一个字段，其存在性由事件签名确认（api-catalog:4006）。
- v2 判 PASS 后按评审裁决落地：① step 内去重（原实现一步扇出 N 个会注入 N 条相同提醒）；② 可安装形态修正（现“安装”一节即修正后的流程）。
- 更早一轮评审的实质建议亦已采纳：`source.form` 改用运行时词汇 `notice`；删除与“不拦截任何工具调用”冲突的 `tools.guard` 备选方案；头注释不再自称 “Host half”（该词在 DSH 指 cordis 动态包的 host 半，那里不能用 Node 内置模块）。

## 安装

已于 2026-11-02 以 tarball 装入 web profile（0.1.0）；2026-11-03 随单仓库迁移移至 `dsh-plugins\dsh-subagent-wait-reminder` 并从新路径重新登记（相同字节重装，安装副本哈希逐字节一致）。

跨插件铁律（只从 tarball 安装、`dist/` 不可覆盖不可删、禁止目录/link 安装等）见仓库根 [INSTALL.md](../INSTALL.md)——本文件不复述，只放本插件自己的命令与记录。本插件是**纯 Host 侧**插件（无 `dsh.client`）：Host 不需要重启，也不涉及浏览器 `Ctrl+F5`。

### 打包前检查（只读源码，不碰 profile）

```powershell
cd D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder
pnpm check
pnpm pack --pack-destination dist
tar -tzf dist\dsh-subagent-wait-reminder-<版本>.tgz   # 条目带 package/ 前缀；必须含 package/lib/index.js、package/cordis.patch.yml
```

### 安装 / 升级（每次发版递增版本号）

```powershell
dsh plugin --profile web add "D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder\dist\dsh-subagent-wait-reminder-<版本>.tgz"
```

### 验证登记形态

```powershell
(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-subagent-wait-reminder" -Force).LinkType   # 空 = 普通目录（正确）
dsh plugin --profile web why dsh-subagent-wait-reminder
dsh --profile web --dump-config    # 应有本包 patch 插入的 entry
```

功能验证：派发一个子智能体 → 派发结果后应紧跟一条 user 角色 `<system-reminder>`；子智能体结束后完成通知自动到达；全程零 `list_agents`（见「生产验证记录」）。

### 回滚 / 卸载

```powershell
dsh plugin --profile web add "<旧版本 tgz 绝对路径>"          # 回滚到旧版
dsh plugin --profile web remove dsh-subagent-wait-reminder   # 彻底移除
```

不要改源码当回滚用——源码与运行副本无任何链接。

### 安装记录

- **2026-11-02**：0.1.0 首装（旧路径 `default-workspace\dsh-subagent-wait-reminder`）。`pnpm pack` 产物 8471 字节、四文件齐全；`dsh plugin add` 含 lockfile 供应链校验（170 entries）与一次 pnpm 垃圾清理（`+1 -32`，-32 为 extraneous 包）；装后 `LinkType` 为空、`why` 有记录、`dsh.profile.bundles` 末尾自动追加本包。
- **2026-11-03**：随单仓库迁移移至 `dsh-plugins\dsh-subagent-wait-reminder`，profile 从新路径重新登记（相同字节重装：`LinkType` 为空、安装副本 `lib\index.js` 哈希 `878A22AB18B45554` 与源码一致、`why` 有记录、无 `skipping profile bundle` 警告）。

## 故障排查：如果派发后没看到提醒

1. 确认装载：`dsh --profile web --dump-config` 输出里应有本包 patch 插入的 entry；`dsh plugin --profile web why dsh-subagent-wait-reminder` 应有记录。
2. 确认启动日志无 `skipping profile bundle "dsh-subagent-wait-reminder"`（patch 缺失/格式错/版本不兼容都会走这条）。
3. 确认安装副本完整：`node_modules\dsh-subagent-wait-reminder\lib\index.js` 存在，且哈希与源码一致（对照命令见下方“版本”）。
4. 确认安装形态：`(Get-Item <安装副本目录> -Force).LinkType` 为空——若是 Junction/SymbolicLink，说明被目录/link 安装污染，按仓库根 [INSTALL.md](../INSTALL.md) 第 5 节处理。
5. 都正常仍无提醒 → 升级 dsh 后可能命中版本耦合点（README“机制”表所列行号随版本漂移），按新版本重新核对事件契约。

回滚：`dsh plugin --profile web remove dsh-subagent-wait-reminder`（0.1.0 为首个版本，无旧 tgz 可回装）。

## 版本

- 0.1.0 — 首个可安装形态（含 `dsh.bundle.patch` 与包内 `cordis.patch.yml`）。2026-11-02 装入 web profile，11-02/03 实测通过。

### 运行副本与源码的同步状态

本次开发收尾时在源码目录更新了 README（补生产验证记录等），**安装副本里的 README 仍是打包时的旧版**——按隔离原则这无害（文档不影响行为），但两份 README 已有差异。下次因任何原因发新版本时（0.1.1+），新版会自然带上；若希望立即同步，走一遍“新版本号 → `pnpm pack` → `add`”即可。

对照安装副本与源码是否一致：

```powershell
foreach ($side in @("C:\Users\guwh\.dsh\profiles\web\node_modules\dsh-subagent-wait-reminder", "D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder")) {
  $h = (Get-FileHash "$side\lib\index.js" -Algorithm SHA256).Hash.Substring(0,16)
  Write-Host "$side -> lib/index.js $h"
}
# 两行相同 = 可执行代码一致（当前均为 878A22AB18B45554）
```
