# dsh-read-img

状态：仓库源码 **0.1.6**，**已于 2026-11-09 装入 `web` profile 并实测生效**（模型配置沿用被替换掉的第三方 `tool-vision`：`baseURL` `http://192.168.155.44:8000/llm-router-buss/v1`、`model` `group/vision`、`maxTokens` 24096）。0.1.6 的本地验证：`check` 通过、离线用例 42/42、插件用例 11/11（无需 `node_modules`）、live 用例在无 provider 配置时**明确 skip**。**纯 Host 侧插件**（无 `dsh.client`），不涉及浏览器 `Ctrl+F5`。注意：**新装** bundle 可经 HMR 激活（当日实测：装完未重启 Host，`read_img` 即可调用）；而**替换**已安装包的宿主 JS 才需要重启 Host（见仓库根 [INSTALL.md §15.1](../INSTALL.md#151-重载与重启官方明文决定改完要不要重启)）。

## 作用

给纯文本模型一个读懂**本地图片文件**的工具：模型把图片路径交给它，它把图片发给外部 OpenAI 兼容的视觉模型，拿回文字描述。

```text
read_img(path, question?)
```

- `path`：绝对路径、相对会话工作目录的路径、`file://` URL（主机名必须留空）或 `http(s)://` URL。Windows 网络共享请**直接传 UNC 路径**（`\\server\share\x.png`），不要写成 `file://server/share/x.png`
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

**为什么只有一个工具、没有消息改写**：本插件的需求是「模型主动去读一个文件」，属于工具语义。用户粘贴图片的场景由别处负责，所以不改写任何消息，也不注册额外工具——上下文里只多一个 schema（979 字节，约 250 tokens）。**唯一例外**是可关闭的工具隐藏器（`hideTools`），见下文〈隐藏官方的 `read_image`〉。

## 运行要求（`engines.dsh`）

```json
"engines": { "dsh": ">=0.2.0-rc.2", "node": ">=22" }
```

- **只有下限，没有上界**。上界（原先的 `>=0.2.0-rc.2 <0.3.0`）会让 dsh 的版本闸门在**安装时直接拒绝** 0.3.x——一次正常的官方升级就变成「插件不可用」。`check` 现在会拒绝任何带空间隔或 `^`/`~` 的写法。
- **下限依据**：本插件只用到四类宿主契约，`@deepseek-ai/dsh@0.2.0-rc.2` 的发行包内逐条存在——`tools/pre-execute` 事件与 `PreToolDecision.kind: "deny"`（`dsh-tools@0.2.0-rc.2` 的 `lib/types/index.d.ts`）、`defineTool` 的 `output.schema`/`output.render`（同包 `lib/index.js`）、`llm/stream` 入参里的 `tools?: ToolSchema[]`（`dsh-llm@0.2.0-rc.2` 的 `lib/types/types.d.ts`）、会话头的绝对 `cwd`（`dsh-session@0.2.0-rc.2`）。更早的版本没有核实，因此不声明支持。
- **`peerDependencies` 不参与版本闸门**：dsh 自己的判定逻辑是「有 `engines.dsh` 时由它单独决定，忽略 peerDependencies」（`dsh-app-boot/lib/index.js` 的 `unmetRequirements` 注释）。那两个 optional peer 只是「这些名字来自宿主」的文档，不作为版本要求。

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

## 数据流向与信任边界

- 本地图片以 base64 形式随请求发给配置的 `baseURL`；插件不在本地另存副本、不上传其他位置。
- `http(s)` 目标由视觉端点去抓，本插件不下载；因此 `maxImageBytes` **只约束本地文件**，URL 目标不受它限制。
- URL 结果按 **URL 字符串**缓存，同一地址内容变化不会自动失效（LRU 64 条，随进程重启清空）。
- 插件能读进程可读的任意图片路径——权限等同于执行它的那个进程。涉密图片不要交给不可信的端点。

## 隐藏官方的 `read_image`

宿主自带的 `read_image`（`@deepseek-ai/dsh-tool-fs`）**始终注册**，只在执行时检查路由模态：纯文本模型调用它，会拿到一个被请求投影替换成 `[image omitted because this model accepts text only; …]` 的占位符。模型看到名字和描述会以为它能看图，于是白调一轮。

本插件的处理：

1. **声明过滤**：在 `llm/stream` 里把 `hideTools` 中的名字从 `options.tools` 移除，再重入瀑布（瀑布是幂等的，第二次必然走到 `next()`，不会递归）；
2. **调用兜底**：`tools/pre-execute` 对同名调用直接拒绝，并告诉模型改用 `read_img`。

**失败策略是 fail-open**：配置读取异常、`tools` 不是数组、字段改名……任何非预期情况都原样 `next()`——隐藏器看不懂请求时，绝不阻断请求。代价是宿主若改了字段名，工具会静默重新出现，而不是报错。

不想要这个行为：`hideTools: []`（过滤器与兜底同时关闭）。

---

## 已知限制（显式取舍）

- **`file://` 只接受空主机名**：`file:///C:/shots/a.png` 可以；`file://server/share/x.png`、`file://example.com/x.png` 一律拒绝。理由：Node 对带主机名的 `file:` URL **平台行为相反**——Windows 的 `fileURLToPath` 会把它转成 UNC 路径 `\\server\share\x`，POSIX 直接抛错，同一份输入在两个平台语义不同。插件改为自己检查 `URL.hostname`，两端同规则；Windows 上读网络共享仍可**直接传 UNC 路径**（`toTarget` 把它当绝对路径）。`file://localhost/...` 等价于空主机名（URL 解析器会把 `localhost` 归一成空）。
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

## 验证状态（0.1.6，2026-11-09，Windows + node 24.18.1）

| 项 | 结果 |
|---|---|
| `pnpm check`（语法 + 包契约 + patch 契约 + `engines.dsh` 单一下限） | 通过，5 个 lib 文件 |
| 离线用例 `pnpm test`（cache / image / vision / hide-tools，零依赖） | **42/42 通过** |
| 插件用例 `pnpm test:plugin` | **11/11 通过**，无 `node_modules` 也能跑 |
| live 用例 `pnpm test:live` | 未配置 `VISION_BASE`/`VISION_KEY`/`VISION_MODEL` 时 **1 skipped / exit 0**；本次未打真实端点 |
| 应用内探针（子智能体调用 `read_img`） | 0.1.5 时通过（绝对 / 相对 / 错误路径）；0.1.6 未重跑 |
| 上下文占用 | 1 个工具，schema 979 字节（约 250 tokens）；且不再声明官方的 `read_image`（省 1120 字节） |

> **`pnpm test:plugin` 不需要 `node_modules`，也不需要软链**。`lib/index.js` 从宿主拿两个包（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`），而插件自身不依赖它们；测试用 `test/host-packages.mjs` 在本机找已安装的 dsh，把这两个裸标识符别名到该安装里的真实文件（`test/host-loader.mjs` 是解析钩子），所以 `lib/` 一行不用改、也不新增依赖。查找顺序：`DSH_HOST_DIR`（指向已安装的 `@deepseek-ai/dsh` 包目录）→ node 自己的全局模块目录 → PATH 各条目下的模块目录。找不到就**直接失败**并打印查过哪些路径，不会静默跳过。
> `pnpm test` 本身零依赖，任何机器可跑；`pnpm test:live` 没配环境变量时只报一个 skip。

不装 pnpm 时的等价命令（都在本插件目录里执行）：

```powershell
node scripts/check.mjs
node --test test/cache.test.mjs test/image.test.mjs test/vision.test.mjs test/hide-tools.test.mjs
node --test test/plugin.test.mjs        # 干净 checkout 也能跑
node --test test/live.test.mjs          # 无 provider 配置 -> 1 skipped / exit 0
```

## 安装

跨插件铁律（只从 tarball 安装、`dist/` 不可覆盖不可删、禁止目录 / `link:` 安装等）见仓库根 [INSTALL.md](../INSTALL.md)——本文件不复述，只放本插件自己的命令。本插件是**纯 Host 侧**插件：没有浏览器半边，不需要 `Ctrl+F5`；但升级/替换已安装包的宿主 JS 必须**重启 Host** 才加载新代码（[§15.1](../INSTALL.md#151-重载与重启官方明文决定改完要不要重启)）。

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

- **2026-11-09（本轮）**：**0.1.6 只改了源码，尚未安装**。装上时替换的是已安装包的宿主 JS（`lib/image.js`、`package.json`、`scripts/check.mjs`），按 [INSTALL.md §15.1](../INSTALL.md#151-重载与重启官方明文决定改完要不要重启) 必须**重启 Host** 才生效；重启前请先按本文〈验证状态〉跑完本地检查。
- **2026-11-09**：0.1.5 装入 `web` profile（仓库构建的 tarball 约 15 KB，7 个条目：`lib/index.js`、`lib/cache.js`、`lib/image.js`、`lib/vision.js`、`cordis.patch.yml`、`package.json`、`README.md`）。装载后 `include:read-img` 为 `active`；`dsh --profile web --dump-config` 中 `- id: read-img` 带完整 config。同一天停用第三方 `dsh-tool-vision`（`enabled: false`），上下文中的视觉工具由 15 个降为 1 个。当日中途曾用开发目录产物装过一次，随后以**本仓库构建的 tarball 重装**，确认运行副本与源码一致（`package.json` 由 `pnpm pack` 规范化，见下）。

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
7. **报「不支持的 file URL」**：看括号里的原因。带主机名的（`file://server/share/x.png`）改成 UNC 路径本身；主机名为空但仍失败的（Windows 上 `file:///tmp/a.png` 没有盘符），改成 `file:///C:/tmp/a.png` 或直接传路径。

## 版本

- 0.1.6 — 评审修复四项：`engines.dsh` 去掉上界（`>=0.2.0-rc.2 <0.3.0` → `>=0.2.0-rc.2`，`check` 现在拒绝任何上界写法）；`file://` 带主机名改为**显式检查 `URL.hostname`**、两端一律拒绝（不再依赖 `fileURLToPath` 的平台差异），并在报错里指向 UNC 路径这一可用形式；`image.test.mjs` 与 `plugin.test.mjs` 去掉 POSIX 写死的期望（改用 `resolve`/`pathToFileURL`/`fileURLToPath` 生成，平台差异单独成用例）；`test:plugin` 不再需要 `node_modules`（测试自动从已安装的 dsh 解析两个宿主包）。用例 37→42，插件用例 11/11。live 用例未配置环境变量时改为明确 skip。文档同步「零绝对路径」。
- 0.1.5 — 评审修复：默认值数组不再被共享引用（`hideTools` 每次拷贝、`DEFAULTS.hideTools` 冻结）；`file://` 带主机名的报错带 `read_img:` 前缀；调用方取消不再被误报成超时；媒体类型改为**魔数优先**；响应体超过 4 MB 直接拒绝。用例 32→37、10→11。
- 0.1.4 — 新增 `hideTools`（默认 `["read_image"]`）：在 `llm/stream` 里过滤声明、在 `tools/pre-execute` 里拒绝调用，全程 fail-open。停用宿主那个永远拿不到内容的官方图像工具，避免模型误调。
- 0.1.3 — `maxTokens` 默认改为 20000；新增 `thinking` 配置（默认 `false`）。关闭时发送 `chat_template_kwargs: {enable_thinking: false}`：实测该端点从「300 token 用尽、正文为空」变为「6 token 直接作答」。`reasoning_effort: "none"` 经实测只把推理从 539 字符压到 265 字符、并未关闭，因此不发送。
- 0.1.2 — 修 0.1.1 的两个细节：缓存只存模型答案、路径后缀按调用方回显；工具级硬超时改为跟随配置值（+15s）。
- 0.1.1 — 模块化（`lib/cache.js`、`lib/image.js`、`lib/vision.js`）、补 30 个离线用例与 1 个 live 用例、错误分类。
- 0.1.0 — 首个可安装形态：单工具、单文件实现。
