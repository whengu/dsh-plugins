# HANDOFF：dsh-read-img 交接文档

> 交接目标：读完本文 + [README.md](README.md)，接手者应能在**不问任何历史问题**的前提下维护、升级、回滚本插件。
> 本文写于 2026-11-09，快照基线：dsh `0.2.2-rc.1`、Linux 容器、profile `web`、版本 `0.1.4`。

## 1. 这是什么，为什么存在

**一句话**：纯 Host 侧插件，只注册一个工具 `read_img(path, question?)`——把本地图片文件发给外部 OpenAI 兼容的视觉端点，把描述以文本返回给纯文本模型。

**问题起源**（真实会话）：部署用的聊天模型（`group/big-model`）是纯文本模型，但 agent 会用浏览器 / 桌面工具截图并拿到本地路径，之后需要「看懂这张图」。当时装的是第三方 `dsh-tool-vision@0.10.6`，它能用，但**往上下文里注册了 15 个工具、约 13.5 KB schema（约 3.5–4k tokens）**——对「读一个文件」这件事是数量级过度设计。

**关键转折（需求澄清）**：最初按「用户往聊天框粘图」设计（`llm/stream` 改写 + 桥接）。用户明确：**不粘图，只要模型能读本地图片文件**。于是砍掉全部 hook 与消息改写，只留一个工具。这一刀把设计从「桥 + 工具」变成「只有一个工具」，实现量降到 ~200 行。

**方案要点**：

- 一个工具、零 hook、零浏览器半边、零设置页；
- 端点参数走 profile 的 `cordis.patch.yml`；
- 失败一律变成带原因的工具错误，不让整轮失败；
- 结果按「内容 sha256 + 问题」缓存 64 条。

## 2. 当前状态快照

| 项 | 状态 |
|---|---|
| 安装 | `web` profile，版本 `0.1.4`，2026-11-09 以 tarball 安装（`file:/plugins/dist/dsh-read-img-0.1.4.tgz`，该路径是安装时的 staging 路径） |
| 装载 | `include:read-img`，`fiberPhase: active`，热加载，未重启 |
| 静态检查 | `pnpm check` 通过（4 个 lib 文件语法 + 包契约 + patch 契约） |
| 离线用例 | 32/32 通过（`pnpm test`，零依赖） |
| 插件用例 | 10/10 通过（`pnpm test:plugin`，需宿主包可解析） |
| live 用例 | 1/1 通过（`pnpm test:live`，真实端点，2.8s） |
| 应用内探针 | 通过：绝对路径、相对路径、错误路径；报错后工具仍可用 |
| 上下文占用 | 1 个工具，schema 约 1 KB（约 250 tokens） |
| 待办 | 无阻塞。可选项：多图批量、`data:` URL、按问题缓存 TTL |

## 3. 资产地图（SHA256 前 16 位，交接时点快照）

### 开发源码（权威）：本仓库 `dsh-read-img/`

| 文件 | 哈希 | 字节 | 说明 |
|---|---|---|---|
| `lib/index.js` | `65443FDAA444D7BD` | 8837 | 入口：Config、normalizeConfig、createReader、工具注册、隐藏器装配 |
| `lib/hide-tools.js` | `C435DB9498F0A61E` | 2744 | `llm/stream` 声明过滤 + `tools/pre-execute` 兜底，fail-open |
| `lib/image.js` | `CF69D294687FF3E0` | 3368 | 路径分类、magic bytes 嗅探、读文件与大小限制 |
| `lib/vision.js` | `F2883945BD765940` | 4031 | `/chat/completions` 调用、思考开关、响应解析、超时与取消 |
| `lib/cache.js` | `B69516358F81ADB0` | 1058 | 有界 LRU |
| `cordis.patch.yml` | `B1FEFEEF97C6F147` | 282 | bundle patch（id `read-img` / name `dsh-read-img`） |
| `package.json` | `B6F226B5F2869B96` | 1361 | `dsh.bundle.patch` + `engines.dsh` + files 白名单 |
| `scripts/check.mjs` | `B0251997306DE2DF` | 3738 | `pnpm check`：语法 + 包契约 + patch 契约 |

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

## 5. 维护手册

### 改端点 / 换模型 / 换 key

改 profile 的 `cordis.patch.yml` 里 `- id: read-img` 的 `config`，保存即热生效（loader 监听该文件）。**不需要**改源码、不需要重装。

### 改代码并发版

1. 改 `lib/*.js`；
2. `pnpm check`（语法 + 契约）；
3. `pnpm test`（离线用例，任何机器可跑）；在有 dsh 的机器上再跑 `pnpm test:plugin`；
4. 递增 `package.json` 版本号；
5. `pnpm pack --pack-destination dist`；
6. `dsh plugin --profile web add ./dist/dsh-read-img-<版本>.tgz`；
7. 验证：`why` 有记录、`dump-config` 有 `- id: read-img`、调一次工具。

### 回滚

装回旧版本 tarball 即可（`dist/` 里的历史 tgz 不可删）。

### 新机器

按仓库根 [INSTALL.md §11](../INSTALL.md#11-跨机器使用多台机器)：本机重新 `pnpm pack` 后 `add`，或用 git 源直装（`path:/dsh-read-img`）。

## 6. 验收清单（接手时逐条打勾）

- [ ] `pnpm check` 通过
- [ ] `pnpm test` 32/32
- [ ] （有 dsh 的机器）`pnpm test:plugin` 10/10
- [ ] （可选）`pnpm test:live` 1/1，需要 `VISION_BASE` / `VISION_KEY` / `VISION_MODEL`
- [ ] `dsh --profile web --dump-config` 里有 `- id: read-img` 且 config 完整
- [ ] `dsh plugin --profile web why dsh-read-img` 有记录
- [ ] 安装副本 `LinkType` 为空
- [ ] 调一次 `read_img` 返回描述；错误路径返回可读报错
- [ ] 源码哈希与本表一致（或已知差异有记录）
