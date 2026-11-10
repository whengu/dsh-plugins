# 社区插件调研结论

本文记录对标 `dsh-ability-strip` 时读过的社区实现，以及**每一项的取舍理由**。
目的是避免以后重复调研，也避免有人看到「社区有这个功能」就盲目照搬。

调研方式：`npm pack` / tarball 下载到临时目录解压；发布产物被压缩的，从
`*.js.map` 的 `sourcesContent` 还原原始 TypeScript 再读。**不安装到 profile**，
只读源码。

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

## 一句话结论

这四家真正可迁移的优点，集中在**「配置校验、排序、时间边界、搜索的参数名索引」**
这几处；它们规模更大的架构（分层、队列、持久化）都是被各自的写操作与多服务器
管理场景逼出来的，对「一条只读路由 + 一个只读面板」并不适用。照搬会引入复杂度
而不带来收益。
