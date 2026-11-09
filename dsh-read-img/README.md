# dsh-read-img

状态：**已安装并实测通过**（web profile，0.1.4，2026-11-09 安装；check 通过、离线用例 32/32、插件用例 10/10、live 用例 1/1、应用内探针通过）。**纯 Host 侧插件**（无 `dsh.client`），不涉及浏览器 `Ctrl+F5`。

## 作用

给纯文本模型一个读懂**本地图片文件**的工具：模型把图片路径交给它，它把图片发给外部 OpenAI 兼容的视觉模型，拿回文字描述。

```text
read_img(path, question?)
```

- `path`：绝对路径、相对会话工作目录的路径，或 `file://` / `http(s)://` URL
- `question`：想问什么（最长 1000 字符）；省略则用配置里的默认指令做完整描述 + 文字转录

**典型场景**：浏览器 / 桌面工具把截图存到本地路径 → 模型调用 `read_img(path="…")` → 拿到「图里写了什么、按钮在哪」。

**它不是**：粘贴图片的桥接、消息改写器、OCR 专用工具集合。粘贴进聊天框的图片不经过本插件（dsH 会把图片块直接交给模型或由其他机制处理）。

## 机制（对齐 dsh 0.2.2-rc.1，逐条有源码出处）

| 环节 | 出处 |
|---|---|
| `defineTool` 把参数简写编译成 JSON Schema，并在每次执行前严格校验参数 | `dsh-tools/lib/index.js:310-360`（编译 :320，校验 :322、:352-356） |
| `tools.register` 只校验 `output` 形状与 `timeoutMs`，返回一个 effect 型 disposer | `dsh-tools/lib/index.js:433-444` |
| 工具执行契约：必须转发 `exec.signal`，返回 `output.schema` 声明的规范值 | `dsh-tools/lib/types/contracts.d.ts:23-36` |
| `timeoutMs` 是协作式超时预算，由 `tools/execute` 包装器执行，不下发给模型 | `dsh-tools/lib/types/contracts.d.ts:60-64` |
| 工具声明由 provider 拥有，不再随 `system-prompt/assemble` 瀑布传递 | `dsh-system-prompt/lib/index.js:396-408`（0.2.2 起 `tools` 在瀑布之后才合并） |
| 会话工作目录取自 `exec.agent.session.header.cwd` | `dsh-session/lib/types/index.d.ts:154`（`readonly header: SessionHeader`，`cwd` 为创建元数据） |
| 视觉调用：`POST {baseURL}/chat/completions`，content 为 `text` + `image_url` 两段（OpenAI 兼容） | 本插件 `lib/vision.js` |
| 隐藏工具：`llm/stream` 的入参带 `tools`，过滤后重入瀑布即改变本次声明 | `dsh-llm/lib/types/types.d.ts:556`（`tools?: ToolSchema[]`）、`dsh-llm/lib/index.js:786-796`（`toolUpdate` 未声明时声明直接取 `tools`） |
| 调用兜底：`tools/pre-execute` 返回 `{ kind: "deny", reason }` | `dsh-tools/lib/types/contracts.d.ts:321-326`（`PreToolDecision`） |

**为什么只有一个工具、没有任何 hook**：本插件的需求是「模型主动去读一个文件」，属于工具语义。用户粘贴图片的场景由别处负责，所以不需要 `llm/stream` 改写，也不注册任何额外工具——上下文里只多一个 schema（979 字节，约 250 tokens）。

## 配置

写在 profile 的 `cordis.patch.yml`，条目 id 为 `read-img`：

```yaml
- id: read-img
  config:
    baseURL: http://frps:18080/llm-router-buss/v1
    model: group/vision
    apiKey: "…"
    maxTokens: 20000        # 不写时也是这个默认值
    timeoutMs: 120000
    maxImageBytes: 10485760
    thinking: false         # 默认禁用思考
    hideTools: ["read_image"]   # 默认隐藏官方的 read_image
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册任何工具 |
| `baseURL` | `http://frps:18080/llm-router-buss/v1` | OpenAI 兼容基址，插件拼 `/chat/completions` |
| `apiKey` | 空 | 以 `Authorization: Bearer` 发送；为空则不发送该头 |
| `model` | `group/vision` | 视觉模型 id |
| `maxTokens` | `20000` | 单次回答上限；开思考时推理内容也占这个预算 |
| `timeoutMs` | `120000` | 单次请求超时；工具级硬超时自动设为该值 +15s |
| `maxImageBytes` | `10485760` | 本地图片大小上限，超了直接报错、不发请求 |
| `thinking` | `false` | 是否允许视觉模型思考。关闭时发送 `chat_template_kwargs: {enable_thinking: false}`；开启时不发，交给端点默认 |
| `hideTools` | `["read_image"]` | 从模型声明里移除、并在调用时拒绝的工具名。默认隐藏宿主自带的 `read_image`；设为 `[]` 即完全关闭 |
| `prompt` | 见源码 | 未给 `question` 时的默认指令 |

## 隐藏官方的 `read_image`

宿主自带的 `read_image`（`@deepseek-ai/dsh-tool-fs`）**始终注册**，只在执行时检查路由模态：纯文本模型调用它，会拿到一个被请求投影替换成 `[image omitted because this model accepts text only; …]` 的占位符。模型看到名字和描述会以为它能看图，于是白调一轮。

本插件的处理：

1. **声明过滤**：在 `llm/stream` 里把 `hideTools` 中的名字从 `options.tools` 移除，再重入瀑布（瀑布是幂等的，第二次必然走到 `next()`，不会递归）；
2. **调用兜底**：`tools/pre-execute` 对同名调用直接拒绝，并告诉模型改用 `read_img`。

**失败策略是 fail-open**：配置读取异常、`tools` 不是数组、字段改名……任何非预期情况都原样 `next()`——隐藏器看不懂请求时，绝不阻断请求。代价是宿主若改了字段名，工具会静默重新出现，而不是报错。

不想要这个行为：`hideTools: []`（过滤器与兜底同时关闭）。

---

## 已知限制（显式取舍）

- **单图**：一次调用读一张图。多图请分多次调用；目前没有 `paths` 数组参数。
- **无流式**：等视觉模型整段返回后才把文本交给模型，长图 + 慢端点会让该步变慢（有 120s 上限）。
- **思考默认关闭**：看图描述不需要推理链。关闭用的是 vLLM 系模板开关 `chat_template_kwargs.enable_thinking`——在 group/vision 上实测：不开任何开关时 300 token 全花在推理上、正文为空；`reasoning_effort: "none"` 只把推理压到 265 字符；只有模板开关能让推理归零。`thinking: true` 时端点会先想再答，`maxTokens` 要留足（推理与答案共用预算）。
- **只做「看图」**：不做像素级操作（裁剪、取色、diff、grounding），这些是另一类需求。
- **缓存按内容哈希**：同一张图换个路径读会命中缓存，返回里回显的仍是**本次调用方给的路径**；但缓存不跨进程、重启即失效。
- **不校验视觉模型能力**：`model` 写错或端点不支持图片时，由端点返回的错误透传（HTTP 状态 + 响应片段）。
- **问题截断**：超过 1000 字符的 `question` 会被截断，不报错。

## 覆盖边界（本插件不管什么）

- **粘贴图片**：不进本插件。需要「粘图自动转文字」是另一套机制（`llm/stream` 改写），本插件刻意不做。
- **多图批量**：一次一张。
- **本地 OCR**：不内置任何 OCR，全部依赖配置的视觉端点。

## 验证状态

| 项 | 结果 |
|---|---|
| `pnpm check`（语法 + 包契约 + patch 契约） | 通过，4 个 lib 文件 |
| 离线用例 `pnpm test`（cache / image / vision / hide-tools，零依赖） | 32/32 通过 |
| 插件用例 `pnpm test:plugin`（需宿主包可解析） | 10/10 通过 |
| live 用例 `pnpm test:live`（打真实端点） | 1/1 通过，2.8s，正确识别「左上红、右下蓝、白底」 |
| 应用内探针（子智能体调用 `read_img`） | 通过：绝对路径、相对路径、错误路径三种场景；报错后工具仍可用 |
| 上下文占用 | 1 个工具，schema 979 字节（约 250 tokens）；且不再声明官方的 `read_image`（省 1120 字节） |

> `pnpm test:plugin` / `pnpm test:live` 需要能解析 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`（只有 dsh 安装树里才有，npm 上的同名包是占位版本）。在装有 dsh 的机器上，把这两个包软链到本目录 `node_modules/@deepseek-ai/` 即可；`pnpm test` 本身零依赖，任何机器可跑。

## 安装

跨插件铁律（只从 tarball 安装、`dist/` 不可覆盖不可删、禁止目录 / `link:` 安装等）见仓库根 [INSTALL.md](../INSTALL.md)——本文件不复述，只放本插件自己的命令。本插件是**纯 Host 侧**插件：Host 不需要重启。

### 打包前检查（只读源码，不碰 profile）

```powershell
# 站在本插件目录里
pnpm check
pnpm pack --pack-destination dist
tar -tzf dist\dsh-read-img-<版本>.tgz   # 条目带 package/ 前缀；必须含 package/lib/index.js、package/cordis.patch.yml
```

### 安装 / 升级（每次发版递增版本号）

```powershell
# 方式 A：本机打包后安装（站在本插件目录里，用 ./ 相对路径）
dsh plugin --profile web add ./dist/dsh-read-img-<版本>.tgz

# 方式 B：git 源直接安装（免打包、不产生 dist/，任何目录执行，需联网）
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 40 位 SHA>&path:/dsh-read-img"
```

两种方式等效，可各机器混用；对比与取舍见仓库根 [INSTALL.md §11.2](../INSTALL.md#112-两种方式怎么选)。

### 验证登记形态

```powershell
$prof = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'profiles/web'
(Get-Item (Join-Path $prof 'node_modules/dsh-read-img') -Force).LinkType   # 空 = 普通目录（正确）
dsh plugin --profile web why dsh-read-img
dsh --profile web --dump-config    # 应有 `- id: read-img` 条目
```

功能验证：让 agent 调一次 `read_img`（给一张本地 PNG 的绝对路径），应返回图片描述并在末尾带 `(image: <绝对路径>)`；再给一个不存在的路径，应报 `read_img: 文件不存在或不可读：<绝对路径>`。

### 回滚 / 卸载

```powershell
dsh plugin --profile web add ./dist/dsh-read-img-<旧版本>.tgz   # 回滚到旧版
dsh plugin --profile web remove dsh-read-img                    # 彻底移除
```

不要改源码当回滚用——源码与运行副本无任何链接。

### 安装记录

- **2026-11-09**：0.1.4 装入 `web` profile（仓库构建的 tarball 约 14 KB，7 个条目：`lib/index.js`、`lib/cache.js`、`lib/image.js`、`lib/vision.js`、`cordis.patch.yml`、`package.json`、`README.md`）。装载后 `include:read-img` 为 `active`；`dsh --profile web --dump-config` 中 `- id: read-img` 带完整 config。同一天停用第三方 `dsh-tool-vision`（`enabled: false`），上下文中的视觉工具由 15 个降为 1 个。当日中途曾用开发目录产物装过一次，随后以**本仓库构建的 tarball 重装**，确认运行副本与源码一致（`package.json` 由 `pnpm pack` 规范化，见下）。

## 运行副本与源码的同步状态

发版后安装副本与本仓库源码应当逐字节一致，`package.json` 除外——`pnpm pack` 会把它规范化（`scripts` 移到末尾、去掉文件末尾换行），这是打包器的行为，不是漂移。

对照命令（两行哈希相同 = 一致；基线见 [HANDOFF.md](HANDOFF.md) §3）：

```powershell
$prof = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh') } 'profiles/web'
foreach ($file in 'lib/index.js','lib/cache.js','lib/image.js','lib/vision.js','cordis.patch.yml') {
  $src = (Get-FileHash (Join-Path (Get-Location) $file) -Algorithm SHA256).Hash.Substring(0,16)
  $run = (Get-FileHash (Join-Path $prof "node_modules/dsh-read-img/$file") -Algorithm SHA256).Hash.Substring(0,16)
  Write-Host "$file  src=$src  installed=$run"
}
```

## 故障排查：调用报错或不出现工具

1. **工具不在列表里**：`dsh --profile web --dump-config` 是否有 `- id: read-img`；`dsh plugin --profile web why dsh-read-img` 是否有记录；启动日志有无 `skipping profile bundle "dsh-read-img"`。
2. **报「无法完成对 … 的请求」**：端点地址 / 网络 / 超时。先用 curl 验证 `{baseURL}/models` 可达。
3. **报 HTTP 401**：`apiKey` 未配置或错误。
4. **报「视觉模型返回了空内容」**：`model` 写错，或 `maxTokens` 太小被推理内容占满。
5. **报「图片 … 超过上限」**：调大 `maxImageBytes`，或先裁剪图片。
6. **报「不是普通文件」/「文件不存在」**：路径按会话 cwd 解析，相对路径容易指错；报错里已给出解析后的绝对路径。

## 版本

- 0.1.4 — 新增 `hideTools`（默认 `["read_image"]`）：在 `llm/stream` 里过滤声明、在 `tools/pre-execute` 里拒绝调用，全程 fail-open。停用宿主那个永远拿不到内容的官方图像工具，避免模型误调。
- 0.1.3 — `maxTokens` 默认改为 20000；新增 `thinking` 配置（默认 `false`）。关闭时发送 `chat_template_kwargs: {enable_thinking: false}`：实测该端点从「300 token 用尽、正文为空」变为「6 token 直接作答」。`reasoning_effort: "none"` 经实测只把推理从 539 字符压到 265 字符、并未关闭，因此不发送。
- 0.1.2 — 修 0.1.1 的两个细节：缓存只存模型答案、路径后缀按调用方回显；工具级硬超时改为跟随配置值（+15s）。
- 0.1.1 — 模块化（`lib/cache.js`、`lib/image.js`、`lib/vision.js`）、补 30 个离线用例与 1 个 live 用例、错误分类。
- 0.1.0 — 首个可安装形态：单工具、单文件实现。
