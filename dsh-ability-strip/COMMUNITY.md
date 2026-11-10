# 社区插件调研结论

本文记录对标 `dsh-ability-strip` 时读过的社区实现，以及**每一项的取舍理由**。
目的是避免以后重复调研，也避免有人看到「社区有这个功能」就盲目照搬。

调研方式：`npm pack` / tarball 下载到临时目录解压；发布产物被压缩的，先找
`*.js.map` 的 `sourcesContent` 还原原始 TypeScript；连 sourcemap 都没有的
（`dsh-context`），从 README 的仓库地址 `git clone` 读真实源码。**不安装到
profile**，只读源码。

教训：第一次遇到 `dsh-context` 无 sourcemap 时我停在了「只能看 README」，
其实 README 里就写着仓库地址。**"发布产物不可读" 不等于 "源码不可读"**，
多查一步就能读到 468 个真实 TypeScript 文件——正是这一步让我发现了参数行
视图、Escape 处理、以及它 `paramsOf` 的多形状兜底（并因此去核对了 DSH 官方
的 `projectToolSchema`，确认本插件不需要那层兜底）。

## dsh-mcp-view 0.2.1

宿主 435 行，客户端 678 行，零依赖。同类里结构最清楚的一个。

| 能力 | 取舍 | 理由 |
| --- | --- | --- |
| 按参数名搜索工具 | **已吸收，但改了实现** | 它的 `matchesQuery` 每次按键对每个工具重新递归整份 schema，是 O(工具×schema深度)/字符。本插件改为宿主侧提取一次 `paramNames`、客户端建 `haystack`，每次按键只剩一次子串测试 |
| `localeCompare` 排序 | **已吸收** | 原先用码元比较，大写名会全排在小写前 |
| 未来时间戳保护 | **已吸收** | 时钟回拨时应报「刚刚」而非负数 |
| `health probe` | 不吸收 | `probeHealth` 的 `catch` 里非超时错误返回 `up`，ECONNREFUSED / DNS 失败 / TLS 错误全被报成健康。这个实现不能用 |
| JSON / Markdown 导出 | 不吸收 | 触发浏览器下载，违反「插件不改变磁盘」约束 |
| 收藏 / 排序状态持久化 | 不吸收 | 用户明确要求不持久化任何东西 |
| `copyText` 的 `execCommand` 降级 | 不吸收 | 实现是对的，但本插件没有复制功能 |
| 扫全部会话日志算「最近使用」 | 不吸收 | 用户明确拒绝全量日志读取；且它按目录顺序取前 40 个文件、不排序，可能读到最旧的日志 |
| 客户端解析 `schema` 提参数名 | 不吸收 | 截断的 schema 不是合法 JSON，解析会静默丢掉最大那些 schema 的参数名 |

另：它的「按会话看工具」在本机 0.2.1 实测是坏的——`resolveSessionScope` 读
`agent.scope`，而官方代码零处使用该属性（正确姿势是 `tools.schemas(agent)`）。
用 6 个真实 session id 逐个请求，全部退回 `view: "global"`。此结论仅基于本机
版本实测，未向上游报告。

## dsh-mcp-live-status 0.1.0

宿主端单文件约两百多行，客户端约 16KB。工程纪律最好的一个。

| 能力 | 取舍 | 理由 |
| --- | --- | --- |
| `Config = z.object({...})` 配置校验 | **已吸收** | 把三个写死上限变成可配，默认值与常量一致、带 `min` 校验 |
| `SECRET_FLAG` deny-by-suspicion | 记录思路，未实现 | 本插件不发送 MCP 启动参数，没有泄漏面 |
| 路由错误边界（不向 composer 抛 500） | 已具备 | 本插件的 `fetch` 已用 try 包裹并返回结构化错误 |
| `ctx.reflect.get` 非绑定读取 | 不吸收 | 那是给「顺便看一眼某服务」的插件用的。本插件核心功能就是读工具表，硬依赖 `tools` 才正确（官方 `dsh-agent-tool-presentation` 同样硬依赖） |
| `FIBER_STATE` 运行时镜像 | 不吸收 | 本插件不读 fiber 状态，`fiberPhase` 由官方 `remote.pluginInventory` 在宿主侧就转成了字符串 |
| 可见性感知轮询 | 不适用 | 本插件没有轮询，按需读取本身更省 |
| `3/4` 只在异常时显示分母 | 不吸收 | 本插件的三个数字各有独立语义，不是「已连接/总数」关系 |

## dsh-mcp-manager 0.6.0

发布产物是压缩单行（宿主 650KB / 客户端 26KB），从 sourcemap 还原出
1017 行 TypeScript 自有源码后读完。它是**管理型**插件（增删改 MCP 配置），
与本插件的只读定位不同。

| 能力 | 取舍 | 理由 |
| --- | --- | --- |
| `queues: Map<string, Promise<void>>` 串行化操作链 | 不吸收 | 它要管理多个 MCP 服务器各自 connect/disconnect。本插件一次只显示一个会话，全局单锁就是正确粒度，引入 Map 只会增加复杂度 |
| `errors: Map<string,string>` 记录每服务器失败原因 | 不吸收 | 本插件按分区展示错误（skills / inventory / bundles / tools 各自 `{error}`），比全局 Map 更贴合 |
| `failOnStartupError` / `connectingSince` / `lastAttempt` | 不吸收 | 都是写操作与重连管理相关 |

## dsh-mcp-studio 1.0.6

发布产物 825KB（把 `ajv`、`readdirp`、`anymatch` 等打进 bundle）。从 sourcemap
还原出 107 个自有 TypeScript 文件后读完。

| 能力 | 取舍 | 理由 |
| --- | --- | --- |
| routes / service / storage / events / config 分层 | 不吸收 | 它有 20+ 条 REST 路由与写操作，分层是必要的。本插件只有 1 条只读路由，拆成 20 个文件是过度设计 |
| `disposer` 把注册与清理绑定 | 不吸收 | 依赖 `dsh-tauri` 的 `defineRoutes`，本插件不用该框架 |
| `ctx.effect(fn, label)` 命名标签 | 已具备 | 本插件注册工具路由的 `ctx.effect` 本来就传了 `"ability-strip: tool route"` |
| `splitCommandLine` / `validateMcpInput` / `loadPatch` | 不吸收 | MCP 配置管理与 YAML 写入特有，本插件无写操作 |
| 打包依赖进 bundle | **反面教材** | 825KB 单文件，源码不可读、排查困难 |

## dsh-context 0.83.1

同域但不同量级：它是上下文仪表盘（当前上下文、趋势、上下文浏览器、事件、文件活动、
命令执行、Agent 网络、跨 Agent 协作），宿主 13 条 `/api/` 路由、客户端 920KB。

**源码是完整读过的**：发布产物虽无 sourcemap，但 README 里有仓库地址，克隆
`github.com/bowenliang123/dsh-context` 后读到 468 个 TypeScript 文件，其中与本插件
直接同域的有 `browserSchema.ts`、`browserToolCard.tsx`、`boundedCache.ts`、
`clearableInput.tsx`，另有一份 `docs/host-client-principles.md` 明确写着前后端原则。

| 能力 | 取舍 | 理由 |
| --- | --- | --- |
| **参数行是主视图，原始 JSON 藏在折叠后**（`browserToolCard.tsx` 的 `ToolSchema`） | **已吸收（0.16.0）** | 原来我把 pretty-printed JSON 当主视图。它的做法更适合「看形状」：每行是 名字 · 类型 · 是否必填 · 描述，JSON 点开才出现。类型还做了紧凑化（`object{3}` / `array<string>` / `string (enum)` / `string \| number`） |
| **参数摘要在宿主侧从完整 schema 派生** | **已吸收（0.16.0）** | 它的数据来自会话日志，没有这个约束；本插件的 schema 预览会被 `maxSchemaChars` 截断，浏览器拿到的可能是半截 JSON。所以摘要必须宿主侧算，否则最大那些 schema 恰恰没有摘要——这条是从它的「摘要与明细分离」推出来的，不是照搬 |
| **`required` 标记 + 单参数描述上限** | **已吸收（0.16.0）** | 必填用 `✓`/`·` 而不是中文词，一列读下来比文字快；单参数描述另有 160 字符上限、参数行 24 行上限，避免一条参数吃掉整个面板 |
| **搜索框的清除按钮 + `onMouseDown` 防失焦**（`clearableInput.tsx`） | **已吸收（0.16.0）** | 仅在有内容时出现；`onMouseDown` 阻止默认，避免点按钮时输入框先失焦 |
| **搜索框的 Escape 清空** | **改了实现才吸收（0.16.0）** | 它的 handler 挂在 input 上，而本插件的 Escape 在 `window` **捕获阶段**就 `stopPropagation`，input 永远收不到。所以改成让面板的捕获 handler 先判断「焦点在带标记的搜索框里且非空」再清空；`isComposing` 也一并判断——中文输入法组字时 Escape 属于输入法，不该清我们的状态 |
| **`boundedCache.ts`**：字节/权重上限 + TTL + 保护键 + 淘汰原因回调 + `unref` 定时器 | 不吸收 | 这是它 920KB 客户端需要的重型缓存。本插件只有 `prettySchema` 一个 64 项 FIFO，已经够用；引入 TTL 与定时器会破坏「无轮询、无常开连接」的既有性质 |
| **每个明细视图都有显式上限**（步骤 1500 · 轮次 300 · 事件 400 · surface 2000 · 存档 400 · 文件操作 400 · 命令 400） | **已具备，且本条是该做法的独立佐证** | 本插件对 `paramNames` 用的正是同一原则（深度 4 / 输出 200 / 访问节点 500），0.16.0 又给参数行加了 24 行上限。社区独立收敛到「每个列表都要有上限」，说明这不是过度防御 |
| **两级缓存**：缓存只放精简摘要，大体量明细面板需要时重算 | 不吸收 | 它的明细来自持久会话日志，重算是为了不让缓存膨胀。本插件读的是活的工具注册表，没有「从日志重新汇总」的分支 |
| **估算值与实际值并列显示，估算标 `≈`** | 不吸收（本插件没有估算值） | 本插件显示的每个数字都是精确测量：`totalTools` 来自注册表、`schemaChars` 是 `JSON.stringify` 的字节数、`entries.length` 是计数。既然没有估算，就不需要这个标注机制 |
| 依赖 `client-ui-primitives` + `zod` + `schemastery` | 不吸收 | 本插件客户端零依赖、宿主只用 `schemastery`。同引 `zod` 与 `schemastery` 是同一件事的两套实现 |
| 13 条 `/api/` 路由、920KB 客户端 | 不吸收 | 它有 7 类明细视图，本插件只有「读一份工具摘要」这一个动作 |

### 它的 `paramsOf` 让我查清了一件本来会做错的事

`browserSchema.ts` 的 `paramsOf` 依次尝试 `parameters`、`input_schema`、`inputSchema`
三种形状。看起来该学，但走读 DSH 官方源码后否掉了：

- `dsh-tools` 的 `schemas()` 调用 `projectToolSchema(definition, ...)`；
- `projectToolSchema` 只返回 `{ name, description, parameters, deferLoading? }`。

也就是说官方注册表**只可能**给出 `parameters`。它做多形状兜底，是因为它读的是会话
日志里各家客户端的历史数据。本插件数据源单一，加那层兜底只会掩盖真正的契约破坏。
**查过官方实现之后判定不需要，就不加。**

### 顺带做的一次实测

它提到「缓存保持很小」，我据此检查本插件是否缺「整包字节上限」。真机实测（72 个
工具）：schema 总量 **41,696 字符（约 41KB）**，平均 579、最大 2180。按单个 schema
6000 的上限推算，要 500 个工具且每个都写满 6000 才到 2.86MB，而真实 schema 平均只有
579。**测过之后判定不需要，就不加**，避免用一层永远不触发的代码换复杂度。


## 另外两个只做了范围判断的

- `dsh-m` (0.12.13) / `dshmarket` (1.73.17)：插件市场（浏览、安装、卸载、升级）。
  它们读的是**插件**清单与包元数据，本插件读的是**工具**注册表；且它们的核心动作
  是写（安装/卸载），与本插件的只读定位不重叠。不深入。
- `dsh-plugin-catalog` / `dsh-plugin-shop-catalog`：9714 条目录数据，没有可读的实现。

## 一句话结论

这五家真正可迁移的优点，集中在**「配置校验、排序、时间边界、搜索的参数名索引、
每个列表都要有上限」**这几处；它们规模更大的架构（分层、路由群、队列、持久化、
从日志重算明细）都是被各自的写操作、多视图或长会话场景逼出来的，对
「一条只读路由 + 一个只读面板」并不适用。照搬会引入复杂度而不带来收益。
