# progress — dsh-auto-continue v0.2

流程：`dev-pipeline`（触发原因：需求未对齐 + 影响面未查清 + 用户要求必须 review）

## 阶段状态（最终收敛版）

| # | 阶段 | 状态 | 制品 |
|---|---|---|---|
| 1 | REQUIREMENT | **已落盘并与用户逐条对齐** | `requirement.md`（`6CA0727C…BE4B29`） |
| 2 | DESIGN | **已落盘（153 行精简版）** | `design-final.md`（`659218CB…27D7C4A8`） |
| 3 | DESIGN_REVIEW | **主 agent 自查替代**（评审 subagent 连续 2 次启动后失败退出，未留结论）；按 7 点清单逐条查权威源码，结论见 design-final.md §8 S9-S14 | 无独立 review 文件，偏离已记录 |
| 4 | IMPLEMENTATION | **完成**（实现者交付，主 agent 逐文件复核 frames/boot/index/client） | `dsh-auto-continue/lib/*` |
| 5 | CODE_REVIEW | **首轮打回**（code-001.md：1 BLOCKER 消息缺 id + 3 MINOR，否决"零已知阻塞"声明）→ FIX → **复审 PASS**（code-002.md：零 finding，F-01~F-04 全闭环） | `reviews/code-001.md`、`reviews/code-002.md` |
| 6 | FIX | **完成**（补 `id: randomUUID()`、真实消息断言、内容断言、defaultReadTail 行为断言；4/4 闭环，F-01 变异测试转红确认门禁有效） | — |
| 7 | VERIFY | **完成**（node --check、pnpm check 68 断言、哈希一致、5 项变异转红、check-all 6/6 PASS） | `verify-001.md` |
| 8 | DELIVER | **0.2.1 已安装**（事故修复版；未重启 dsh；页面是否恢复待用户确认） | — |

## 事故与修复（2026-11-17）

- 0.2.0 装机后 web 页面无法加载（`entry did not activate / import failed`）——根因是 client.js 的 load id 写成 `auto-continue`，与包名 `dsh-auto-continue` 不一致，factory 注册到错误 key。详见 `incident-001.md`。
- 用户卸载恢复 → 源码修正 id → 新增静态门禁（变异验证有效）→ 独立 review 又抓出"只改源码未重打包"→ 递增 0.2.1 重新打包（解包逐字节核对）→ 安装 0.2.1。
- **未重启 dsh**；页面是否真正恢复、插件是否真能续跑崩溃会话，需用户刷新页面确认（本任务不动浏览器）。

## UI 改动（2026-11-17，0.2.2）

- 用户：状态栏空间有限，dock 只显示图标+续了数字，详情进点击弹窗，详情呈现优化。
- 实现：dock = `↻` + `resumed.length`；`DetailDialog` 用 `react-dom` portal 到 body，摘要条（已续/跳过/版本）+ 两个列表（跳过原因映射为中文），遮罩/×/Esc 关闭、焦点移入还原 + Tab trap。
- 独立 review `reviews/ui-001.md` PASS（0 BLOCKER/MAJOR，2 MINOR）；两个 MINOR（遮罩用 `--dsw-alias-bg-mask-1` token、补 Tab focus trap）已修。
- 0.2.2 已打包装机：tgz 解包逐字节核对（client id 正确、7 文件一致、新 UI 元素在包内、门禁在包内）；安装副本哈希与源码一致；未重启 dsh；UI 观感待用户刷新确认。

## 状态栏去空白（2026-11-17，0.2.3）

- 用户：状态栏 chip 图标左右空白占位太多，希望左右填充置 0。
- 取证结论：左右空白唯一来源是 `StatusChip` button 的 `padding:'2px 4px'`（左右各 4px）。外层 dock 容器 `.uV2eYG_dock`（client-ui-conversation InputBar）只有 `gap:12px` 与 `padding-top:4px`，无左右 padding；slot 渲染层 `ANCHOR_STYLE={display:'contents'}`、错误边界正常态直接返回 children、renderEntry 直接渲染组件，均不产生空白包裹。
- 改动：button padding 改为 `'2px 0'`（仅清左右，保留上下 2px 点击区）。图标与数字间 `gap:4` 保留（尺寸合适，非外侧空白）。
- 版本 bump 到 0.2.3（package.json 与 lib/index.js VERSION 同步，check 有断言）；同版本 tgz add 可能因 lockfile 无变化留下旧文件（dsh-plugin-manager README），沿用递增版本规避陈旧包。

## 横向间距全部归零（2026-11-17，0.2.4）

- 用户："所有横向浪费全部改成0"。把 StatusChip 图标↔数字的 `gap:4` 改为 `gap:0`（0.2.3 已清掉左右 padding）。至此状态 chip 左右 padding 与内部 gap 全为 0。
- 版本 bump 到 0.2.4 并同步文档；dist/ 被 .gitignore 忽略，tgz 不入库，仓库提交的是源码。线上已装 0.2.3，本次未安装。

### 其它带 UI 插件的横向间距排查（仅检查，未改动）

- `dsh-ability-strip`（挂同一 `conversation.composer.dock`）：根 `padding:"2px 0"` 左右已 0；三个 chip（技能/MCP/工具）行 `gap:5`、chip 内部图标↔数字 `gap:3`（`CHIP` 常量）；chip 左右无 padding。这些 gap 是多个独立控件间/图标与数字间的分隔，与 auto-continue 单 chip 紧贴场景不同；属已装机插件，未在本次授权内改动。
- `dsh-turn-stats`（shadow 官方 activity/usage 位置）：pill 样式 `gap:6px; padding:1px 8px` 完全照抄官方 `StatsPills.module.css`（源码注释声明"values are untouched so the pill keeps its metrics"），左右各 8px padding 是官方视觉契约的一部分；改动会偏离官方外观，需用户明确授权才动。
- 结论：三者中 auto-continue 的横向浪费已清零；另两个的间距要么是控件间必要分隔、要么是官方对齐契约，且都涉及已装机版本，本次不擅自改。

## 收敛脉络（用户逐条纠偏，全部采纳）

1. 否决 v0.1.0「遍历全部 + 全量解压」（原话：荒唐/乱搞/无法通过质量审查）
2. 「扫 session 目录难道必须全量解压？」→ 实测尾部读 4.9ms，推翻我的错误结论
3. 「不要对每个，挑最近的」→ 取最近 N + stat mtime
4. 「插件不要写文件」→ 删掉 lastBoot 时间戳，纯无状态
5. 「重复续有危害吗」→ `agents.get` 一行挡 live，删掉全部防重复复杂度
6. 「提示词是系统自动的好心提示，交回模型判断」→ 写进规格 §6 与设计 §4

**设计规模：934 行（R2，已作废）→ 153 行（final）。**

## 关键实证（支撑设计，均已实跑）

- 尾部读：21MB 活动会话 4.9ms 找到 `turn/start`；300KB 旧会话 1.6–2ms 找到 `turn/end reason=completed`
- 多帧 zstd：尾部 84 帧逐个独立解压 84/84 成功，一帧一个 JSON 事件
- list()+stat 排序：646 个 artifact 约 34ms
- DSH 官方后端有 `scanZstdFrames()` + `maxFrames`（`dsh-session-persistence-jsonl:1299-1302`），证明"每帧一事件、metadata-only 尾部读"是官方容器设计

## 冻结记录（当前有效）

| 制品 | bytes | 行 | SHA-256 |
|---|---|---|---|
| `requirement.md` | 5251 | 84 | `6CA0727CF40C71CDC7725A6AF7DA8D64C4C622F6EA6F0AC0B7C476268CBE4B29` |
| `design-final.md` | 7901 | 153 | `659218CB5F709B4F528487472992F759F382FBA718C0B532E783C25227D7C4A8` |

**已作废仅留档**：v0.1.0 实现、design.md R1(`B629F72F…`)/R2(`D39B9702…`)、design-001/002 review、reassessment-001、requirement 历次版本。

## 前置事实

- `dsh-auto-continue` 0.1.0 曾于 2026-11-16 被**未授权安装**，同日用户要求后已卸载干净（依赖、bundle、node_modules、lockfile 全清）。
- **长期硬约束：未经用户明确允许，不得安装任何插件。** 写插件 ≠ 安装插件。
- 当前 profile 未安装该插件。

## 仍待用户裁定（不阻塞设计评审，阻塞实现/安装）

- UI 开关是否要"点击即切换"（需写配置/状态）还是本版的"只读展示 + 配置里切" —— 设计 §5 暂取后者以守住"不写文件"。
- 安装必须单独授权。
