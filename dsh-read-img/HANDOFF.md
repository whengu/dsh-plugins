# HANDOFF：dsh-read-img 交接文档

> 交接目标：读完本文 + [README.md](README.md)，接手者应能在**不问任何历史问题**的前提下维护、升级、回滚本插件。
> 本文写于 2026-11-09，最后更新于 0.1.6（同日）；快照基线：dsh `0.2.2-rc.1`、node `24.18.1`、Windows、profile `web`、仓库版本 `0.1.6`（线上装的是 `0.1.5`）。

## 1. 这是什么，为什么存在

**一句话**：纯 Host 侧插件，只注册一个工具 `read_img(path, question?)`——把本地图片文件发给外部 OpenAI 兼容的视觉端点，把描述以文本返回给纯文本模型。

**问题起源**（真实会话）：部署用的聊天模型（`group/big-model`）是纯文本模型，但 agent 会用浏览器 / 桌面工具截图并拿到本地路径，之后需要「看懂这张图」。当时装的是第三方 `dsh-tool-vision@0.10.6`，它能用，但**往上下文里注册了 15 个工具、约 13.5 KB schema（约 3.5–4k tokens）**——对「读一个文件」这件事是数量级过度设计。

**关键转折（需求澄清）**：最初按「用户往聊天框粘图」设计（`llm/stream` 改写 + 桥接）。用户明确：**不粘图，只要模型能读本地图片文件**。于是砍掉全部 hook 与消息改写，只留一个工具。这一刀把设计从「桥 + 工具」变成「只有一个工具」，实现量降到 ~200 行。

**方案要点**：

- 一个工具、零浏览器半边、零设置页；唯一的 hook 是可关闭的工具隐藏器（见决策 6）；
- 端点参数走 profile 的 `cordis.patch.yml`；
- 失败一律变成带原因的工具错误，不让整轮失败；
- 结果按「内容 sha256 + 问题」缓存 64 条。

## 2. 当前状态快照

| 项 | 状态 |
|---|---|
| 安装 | `web` profile，线上版本 `0.1.5`（2026-11-09 以 tarball 安装，`file:/plugins/dist/dsh-read-img-0.1.5.tgz`，该路径是安装时的 staging 路径）；**仓库源码已到 `0.1.6`，尚未安装** |
| 装载 | 线上跑的是 0.1.5：`include:read-img`，`fiberPhase: active`，热加载。装 0.1.6 时替换的是宿主 JS，**必须重启 Host**（仓库根 INSTALL.md §15.1） |
| 静态检查 | `pnpm check` 通过（5 个 lib 文件语法 + 包契约 + patch 契约 + `engines.dsh` 单一下限） |
| 离线用例 | **42/42** 通过（`pnpm test`，零依赖） |
| 插件用例 | **11/11** 通过（`pnpm test:plugin`，**无需 `node_modules`**：测试自动从已安装的 dsh 解析宿主包） |
| live 用例 | 未配置环境变量时 **1 skipped / exit 0**（0.1.5 时曾 1/1 通过，2.8s；0.1.6 未重跑真实端点） |
| 应用内探针 | 0.1.5 时通过（绝对 / 相对 / 错误路径）；0.1.6 未重跑 |
| 上下文占用 | 1 个工具，schema 约 1 KB（约 250 tokens） |
| 待办 | 无阻塞。可选项：多图批量、`data:` URL、按问题缓存 TTL |

## 3. 资产地图（SHA256 前 16 位，交接时点快照）

### 开发源码（权威）：本仓库 `dsh-read-img/`

| 文件 | 哈希 | 字节 | 说明 |
|---|---|---|---|
| `lib/index.js` | `8A795861F86AAA40` | 9207 | 入口：Config、normalizeConfig、createReader、工具注册、隐藏器装配 |
| `lib/hide-tools.js` | `DB44DE53AD598EC3` | 2814 | `llm/stream` 声明过滤 + `tools/pre-execute` 兜底，fail-open |
| `lib/image.js` | `6861E93654E615FE` | 5090 | 路径分类、`file:` URL 主机名规则、magic bytes 嗅探（魔数优先）、读文件与大小限制 |
| `lib/vision.js` | `2252F97115172D10` | 4729 | `/chat/completions` 调用、思考开关、响应解析、超时/取消区分、响应体上限 |
| `lib/cache.js` | `2A0EB842C136BBDC` | 1102 | 有界 LRU |
| `cordis.patch.yml` | `0CD1F9BEC266EFF1` | 289 | bundle patch（id `read-img` / name `dsh-read-img`） |
| `package.json` | `0C20DDF4BFB4F7DA` | 1354 | `dsh.bundle.patch` + `engines.dsh >=0.2.0-rc.2`（单一下限）+ files 白名单 |
| `scripts/check.mjs` | `116FD007C1CFCA5C` | 4375 | `pnpm check`：语法 + 包契约 + patch 契约 + `engines.dsh` 不得带下界之外的写法 |

> 测试目录（`test/`）不参与发布白名单，但它是验收的一部分：`test/image.test.mjs`（14 例）、`test/plugin.test.mjs`（11 例）、`test/cache.test.mjs`（5）、`test/vision.test.mjs`（12）、`test/hide-tools.test.mjs`（11）、`test/live.test.mjs`（1，默认 skip）；`test/host-packages.mjs` + `test/host-loader.mjs` 是「从 dsh 安装解析宿主包」的测试基础设施（只用于测试，不发布）。

### 运行副本

> `package.json` 在 `pnpm pack` 时被规范化（`scripts` 移到末尾、去掉末尾换行），因此安装副本的 `package.json` 哈希与源码不同，属正常；其余文件逐字节一致（2026-11-09 已实测核对）。

- profile：`$DSH_HOME/profiles/web/node_modules/dsh-read-img/`（普通目录，非链接）
- profile 配置：`cordis.patch.yml` 的 `- id: read-img` 段（含 baseURL / model / apiKey）

## 4. 关键决策与教训

### 决策 1：不做粘贴图片的桥接

需求是「模型读本地文件」，不是「用户粘图」。`llm/stream` 改写会引入：图片块识别、附件导出、按模型模态分流、历史图片修复一整套复杂度，而且对本地文件场景毫无用处。**砍掉**。

### 决策 2：一个工具而不是一组工具

`read_img` 覆盖「看图 / OCR / 读 UI」三类日常需求（`question` 决定问法）。像素级工具（裁剪、取色、diff、grounding）用户没有需求，全部不做。

### 决策 3：保留 `defineTool`，不手写 ToolDefinition

宿主 `defineTool` 负责把参数简写编译成 JSON Schema 并在执行前校验参数；手写定义能少两个 peer 依赖，但会丢掉参数校验与未来的契约演进。取舍：**保留**，代价是 `pnpm test:plugin` 需要在装有 dsh 的机器上跑（见 README「验证状态」）。

### 决策 4：条目 id 用 `read-img`，与包名不同

仓库示例里 id 通常等于包名。本插件沿用 `read-img`（与第三方 `dsh-tool-vision` 用 `tool-vision` 的先例一致），避免已安装 profile 改 id 需要重新登记。若要统一，改 `cordis.patch.yml` 的 id + profile 配置段 + 重新 `add` 三处。

### 决策 5：思考默认关闭，用模板开关而不是 `reasoning_effort`

`group/vision` 是思考型模型：不关思考时，300 token 全花在推理上、正文为空（实测）。关闭方式对比（同一张图、同一问题）：

| 请求参数 | completion tokens | 推理字符 | 正文 |
|---|---|---|---|
| 不加任何开关 | 300（耗尽） | 539 | 空 |
| `reasoning_effort: "none"` | 168 | 265 | 有 |
| `enable_thinking: false`（顶层） | 300（耗尽） | 540 | 空 |
| `thinking: {type: "disabled"}` | 300（耗尽） | 517 | 空 |
| **`chat_template_kwargs: {enable_thinking: false}`** | **6** | **0** | **正确** |

结论：只有 vLLM 系模板开关真正关掉思考；`reasoning_effort: "none"` 只缩短推理，**发它会造成"已关闭"的错觉**，因此不发送。`thinking: true` 时不发任何开关，交给端点默认。

### 决策 6：在请求层隐藏官方 `read_image`

宿主的 `read_image`（`dsh-tool-fs`）始终注册，只在执行时校验路由模态；纯文本模型调用它只会得到一个 `[image omitted …]` 占位符。危害不只是 1120 字节 schema，而是模型会误以为它能看图、白调一轮。

处理：`llm/stream` 里过滤 `options.tools`（`toolUpdate` 未声明时，声明就是取这个字段，见 `dsh-llm/lib/index.js:786-796`），再重入瀑布；`tools/pre-execute` 对同名调用拒绝并指向 `read_img`。**全程 fail-open**：任何异常都 `next()`。

不做的事：不碰 `toolHistory`（用户明确不要求），不整体覆盖 preset（实验证明局部 patch 只改到顶层死条目，整体替换会把 40+ 插件削成 1 个）。

### 教训 1：推荐插件前先数工具面

上一轮推荐 `dsh-tool-vision` 时只验了「能跑」，没数它注册多少工具——15 个工具 13.5 KB 是后期才发现的。**对这类插件，上下文成本与功能同等重要，应先量化再推荐。**

### 教训 2：先确认使用场景，再定架构

「粘图」与「读本地文件」看着相似，架构差一整层。设计前用一句话确认场景，比事后重写便宜。

### 决策 7：`file://` 只接受空主机名，`engines.dsh` 只有下限（0.1.6）

- **`file:` URL 的主机名规则由插件自己定，不用 `fileURLToPath` 的平台行为**：Node 在 Windows 上把 `file://server/share/x` 转成 UNC 路径 `\\server\share\x`，在 POSIX 上对同一个 URL 抛 `ERR_INVALID_FILE_URL_HOST`——同一份输入两个平台语义相反，而旧文案还写着「主机名只能是 localhost 或留空」（`localhost` 会被 URL 解析器归一成空主机，实测 node 18/20/24 一致，所以那句话从来只等于空主机）。改为显式检查 `URL.hostname`：空通过，其余**两端一律拒绝**，报错里直接指向「传 UNC 路径」这条仍然可用的路。不选「Windows 支持 UNC」的理由：那会让契约随平台分叉，且 `file://example.com/x.png` 被静默当成网络共享是意外行为；访问能力没有损失（UNC 本身就是绝对路径）。
- **`engines.dsh` 只写下限 `>=0.2.0-rc.2`**：上界（`<0.3.0`）会让 dsh 安装闸门在官方大版本升级时直接拒绝插件，而 dsh 的判定是「有 `engines.dsh` 时忽略 peerDependencies」（`dsh-app-boot` 的 `unmetRequirements`），所以这一个字符串就决定了升级死活。下限取 0.2.0-rc.2 是**逐条核实过契约存在**的最低版本（`tools/pre-execute` + `PreToolDecision.kind:"deny"`、`defineTool` 的 `output.schema`/`render`、`llm/stream` 的 `tools`、会话头绝对 `cwd`），不是抄兄弟插件的数字；更早的版本没核实，不声明支持。

## 5. 评审记录

### v1（2026-11-09，0.1.4 → 0.1.5）

一次完整的代码评审（5 个源文件 + 4 个测试文件 + check 脚本 + 包/patch 契约 + 文档一致性），发现并修复：

| 级别 | 问题 | 修复 |
|---|---|---|
| P1 | `normalizeConfig` 把 `DEFAULTS.hideTools` 的数组引用直接返回，调用方 `push/sort` 会污染模块级默认值 | `DEFAULTS.hideTools` 冻结，normalize 每次都拷贝 |
| P1 | README/HANDOFF 仍写「零 hook / 没有任何 hook」，与 0.1.4 新增的 `llm/stream` 隐藏器不符 | 改成「唯一例外是工具隐藏器」并在决策 6 说明 |
| P2 | `file://` 带主机名时抛裸 `ERR_INVALID_FILE_URL_HOST` | 包一层，输出 `read_img: 不支持的 file URL：…` |
| P2 | 调用方 abort 被报成「超时」（`AbortError` 与 `TimeoutError` 共用文案） | 先判 `signal.aborted`，输出「已取消」 |
| P2 | 媒体类型以扩展名优先，`.png` 实为 JPEG 时错标 | 改为魔数优先、扩展名兜底 |
| P2 | 响应体无上限 | `content-length` 超过 4 MB 直接拒绝 |
| P3 | 无重试、fail-open 无遥测 | 有意不做：端点稳定，遥测会引入日志噪音 |
| P3 | 测试缺口：重入终止、`enabled:false` | 已补两个用例 |

结论：无阻断问题；上述 P1/P2 已在 0.1.5 全部修复，用例 32→37、10→11。

### v2（2026-11-09，0.1.5 → 0.1.6）

| 级别 | 问题 | 修复 |
|---|---|---|
| P1 | `engines.dsh` 带 `<0.3.0` 上界，dsh 0.3.x 会在安装时被直接拒绝 | 改为 `>=0.2.0-rc.2`；`check.mjs` 加「只允许单一下限」断言，回归立刻变红 |
| P1 | `file://` 带主机名的文案（「只能是 localhost 或留空」）在 Windows 上**相反**：`file://example.com/x.png` 被转成 UNC 而不报错，`file://localhost/x.png` 反而抛错 | 显式检查 `URL.hostname`，两端同规则拒绝；错误按原因分两种（主机名非空 / 路径不可转换） |
| P2 | `test/image.test.mjs` 两条用例按 POSIX 写死（`/work/shots/a.png`、`file:///tmp/a.png`），Windows 必失败 | 期望值改用 `resolve`/`pathToFileURL`/`fileURLToPath` 生成；盘符与 UNC 两处平台差异各自成用例，断言不放宽 |
| P2 | `test/plugin.test.mjs` 在干净 checkout 上 `ERR_MODULE_NOT_FOUND`（宿主包只在 dsh 安装里） | `test/host-packages.mjs` 定位已安装的 dsh 并把两个裸标识符别名到其真实文件（`test/host-loader.mjs` 解析钩子）；找不到就失败并打印查找路径 |
| P2 | `test/live.test.mjs` 在无 provider 时**崩在 import**，不是 skip | 宿主包与插件改为测试体内动态 import，环境变量缺失时 1 skipped / exit 0 |

本次同时修掉两处同类 POSIX 假设：`plugin.test.mjs` 的 `new URL(...).pathname`（多一个前导 `/`，Windows 上 stat 必失败）与 `/work` cwd 期望；`live.test.mjs` 的同一 `pathname` 用法。

验证：`check` 通过；离线 42/42；`test:plugin` 11/11（无 `node_modules`）；live 明确 skip。四个修复各做一次变异验证（改坏→断言变红→还原后 SHA-256 一致）。

## 6. 维护手册

### 改端点 / 换模型 / 换 key

改 profile 的 `cordis.patch.yml` 里 `- id: read-img` 的 `config`，保存即热生效（loader 监听该文件）。**不需要**改源码、不需要重装。

### 改代码并发版

1. 改 `lib/*.js`；
2. `pnpm check`（语法 + 契约）；
3. `pnpm test`（离线用例，任何机器可跑）；再跑 `pnpm test:plugin`（会自动从本机已安装的 dsh 取宿主包，**不需要 `node_modules`**，也不需要软链）；
4. 递增 `package.json` 版本号；
5. `pnpm pack --pack-destination dist`；
6. `dsh plugin --profile web add ./dist/dsh-read-img-<版本>.tgz`；
7. 验证：`why` 有记录、`dump-config` 有 `- id: read-img`、调一次工具。

### 回滚

装回旧版本 tarball 即可（`dist/` 里的历史 tgz 不可删）。

### 新机器

按仓库根 [INSTALL.md §11](../INSTALL.md#11-跨机器使用多台机器)：本机重新 `pnpm pack` 后 `add`，或用 git 源直装（`path:/dsh-read-img`）。

## 7. 验收清单（接手时逐条打勾）

- [ ] `pnpm check` 通过（含 `engines.dsh` 只有下限）
- [ ] `pnpm test` 42/42
- [ ] `pnpm test:plugin` 11/11（**不需要 `node_modules`**；找不到 dsh 时按提示设 `DSH_HOST_DIR`）
- [ ] （可选）`pnpm test:live`：没设 `VISION_BASE` / `VISION_KEY` / `VISION_MODEL` 时应为 **1 skipped / exit 0**；设了则应 1/1
- [ ] `dsh --profile web --dump-config` 里有 `- id: read-img` 且 config 完整
- [ ] `dsh plugin --profile web why dsh-read-img` 有记录
- [ ] 安装副本 `LinkType` 为空
- [ ] 调一次 `read_img` 返回描述；错误路径返回可读报错
- [ ] 源码哈希与本表一致（或已知差异有记录）
