# dsh-ability-strip

> **AI 编写声明（如实披露）**：本插件的全部代码与文档由 AI 编写（DeepSeek 的 AI 编程智能体，在 DeepSeek Harness 会话中完成）。人类角色是需求方与评审验收方：提出需求、纠正设计、把关 code review、做最终验收和安装决策；代码本身没有人类手写的行。对 AI 生成代码有顾虑的使用者请知悉后再用。

DeepSeek Harness（dsh）Web GUI 输入框下方的**只读**能力条——挂在输入栏自己的 dock 里，和 persona 条同一排。它回答一个 GUI 默认看不见的问题：*这个会话到底有什么可用？*——用三个互相独立的标记回答。

**收起态只有图标和数字，没有文字标签**（0.7.0 起）：dock 是共用的横向 flex 行，每个标签都在占用数字需要的宽度。三个标记各用自己的图标区分（火花 / 地球 / 扳手），并带 `aria-label` 与 tooltip，含义不依赖文字。

| 标记（图标） | 数据来源 | 收起时显示什么 |
| --- | --- | --- |
| 火花 | `skills/list`（浏览器 Remote） | 本会话可见的可调用 skill 数量；读取失败时显示红色警示图标 |
| 地球 | `ctx.tools.schemas(agent)`（本包宿主半边） | 连上时显示 MCP 工具数（绿色）；未连接显示 ✕（琥珀）；连接故障或清单读取失败显示警示图标（红色） |
| 扳手 | 同上（同一次读取） | 模型**总共**被提供多少工具（含 MCP）；两个数字之差就是非 MCP 的工具数 |

**状态文字去哪了**：收起态不印"未连接 / 连接故障 / 读取失败"，因为那些字比数字更占地方。它们移到两处——每个标记的 **tooltip**（悬停可见），以及**展开后的明细面板**（MCP 分区的标题右侧直接写出来）。所以"简洁"没有以"看不见状态"为代价。

点击这一行（`role="button"`，就是三个标记本身，没有单独的展开图标）展开**浮动**明细面板（fixed，portal 到 `<body>`，永不推挤页面），列出：

- 每个 skill 的 `/name`、`model+user` / `user-only`、描述和 `whenToUse`
- 每个**已连接** MCP 服务器，及其每个工具的**名字与描述**
- **非 MCP 工具**的名字与描述。**标题的数字就是这一列的条数**（不是总数），下面一行小字把数字算清：`共 N 个：下列 x 个非 MCP，上方 MCP 分区 y 个`；右侧标明是按 agent 视图还是全局视图读的
- 已配置的 MCP Loader 行，带各自的 phase；`dsh-mcp-resources` 是否挂载
- profile 启用的插件包

刷新和关闭在面板头部；Escape 或点击面板外任意位置关闭。

> **工具描述是工具作者自己的话**，直接取自模型看到的那份 schema——所以它回答"这个工具是干什么的"，且不掺任何猜测。描述在宿主侧截断到 400 字符（网络边界，不是取舍），被截断时会带 `…`；完整文本在每行的 tooltip 里。每行最多显示两行描述，避免一条长描述把整个列表挤出视野。

## tools 标记：注册表里该 agent 能看到的工具面

`MCP` 只回答"MCP 通不通"，回答不了"模型手里一共有多少工具"。后者才是容量问题的来源：
一个插件可以注册十几个工具，每个几百到上千字节 schema，全部进系统提示。

这条标记的数字来自宿主半边的同一次读取，但**读法不同**——它按**本会话的 agent** 读：

```js
const agent = ctx.get("agents").get(sessionId)   // 该会话的存活 agent
ctx.tools.schemas(agent)                         // 与真实 executor 完全相同的调用
```

`tools.schemas(agent)` 正是 `dsh-tool-executor-ptc`（`tools.schemas(exec.agent, exec.toolSet)`）和
`dsh-tool-cordis`（`ctx.tools.schemas(context.agent)`）在真实模型步骤里用的调用，所以
`ctx.tools.restrict()` 的按 agent 削减、以及 scoped 注册对全局工具的遮蔽，都会如实反映出来。
省略 scope 拿到的是**全局视图**（部署注册了什么），面板据此在标题右侧写清是哪一种。

> ### 它读的是注册表，不是最终请求
>
> 这一点必须说清楚，因为它会造成"看起来不对"：**插件可以在请求层再做一次过滤**，而
> 那层过滤在注册表里看不见。真实例子就是本项目自己的 `dsh-read-img`——它在
> `llm/stream` 里把 `read_image` 从 `options.tools` 里剔除，并用一条 pre-execute guard
> 拒绝残余调用（历史记录、模型幻觉）。
>
> 结果：`read_image` **仍在注册表里**，所以能力条照样列出它；但模型收到的请求里没有它。
> 这不是谁坏了，而是两个不同的问题："注册了什么" vs "这次请求发了什么"。
>
> 能力条只回答前者，并且**在面板里直接写出这个限制**（工具分区标题下方那行小字），
> 免得读者以为数字虚高或插件失效。要回答后者需要观察真实请求（`llm/stream` 下游的最终
> `options.tools`），那只有发过一次请求后才有值，且受监听器注册顺序影响——不值得为此
> 引入一个会 staleness 的视图。

**如实说明两个边界**：

- `schemas(agent)` 不含**按步**准入（`toolSet`），所以它是"这个 agent 被提供什么"，不是"某一步真放行了什么"。后者要一次真实步骤才有意义。
- 非 MCP 那一桶叫 `local` 而不是"内置"：schema 里没有来源字段，插件注册的工具和 Harness 自带的工具在这里无法区分。名字按**已知事实**取（不是 MCP 服务器的），不发明区分度。

## MCP 的"已连接"判断是真实的，且会自己变

浏览器没有 MCP 状态 Remote，早期版本只能报 Loader 的启用状态。那不是用户问的问题。可观测的事实是**工具注册表**：MCP 服务器每暴露一个远端工具，注册表里就有一个 `mcp__<server>__<tool>` 命名的工具；连接失败的服务器注册数为**零**。

所以本包自带宿主半边：读 `ctx.tools.schemas()`，按该命名约定分组，把每个服务器的计数经自己的路由发给浏览器。能力条收起时直接显示工具总数（如 `MCP 29`）——"已连接"三个字是冗余的，数量本身就是证据。

**它是推送，不是轮询。** 宿主半边在共享 `/api` 载体上多开了一条精确路由 `/api/ability-strip/events`，内容是一路 Server-Sent Events；`tools/change` 一响，它就往下写一帧"注册表变了"。浏览器半边用原生 `EventSource` 接着，收到帧就静默重读一次。于是：

- **页面上没有任何定时器。** 不 `setInterval`、不 `setTimeout` 打点。东西没变，这条连接就一句话都不发。
- **延迟从"最迟 15 秒"变成"事件发生那一刻"。** MCP 服务器掉线、重连、新增工具，都在注册表变动的同时反映到能力条上。
- 连接建立、断开重连时宿主都先写一帧当前版本，浏览器据此补读一次——所以"浏览器刚读的那一瞬间注册表又变了"这种缝隙不会留下过期数字。
- **推送断了会说出来，不会假装没变。** `EventSource` 报错时（无论它随后自己重连、还是遇到致命状态彻底不再重试），能力条立刻进入"推送断开"状态：收起态行尾出现一个 11 px 的琥珀色警示标（健康时不存在，所以正常宽度不受影响），明细面板里明写"下面这些数字不会再自动更新"。同一次故障只补读一次，不会因为重试而变成读取风暴；连接恢复后标记清除、下一次故障再补读一次。遇到彻底不再重试的情况，切回标签页会重开这条流并重读——依然没有定时器，读者回来就是那个事件。

刷新时机只剩下"确实发生了什么"和"读者确实在看"两种：收到推送帧、打开明细面板、标签页重新可见、以及手动点刷新。收起态不会为了保持新鲜而空转。

三道护栏保留，各自仍然解决一种浪费：

| 浪费 | 护栏 |
| --- | --- |
| 每次读取复制整个工具目录 | 宿主半边缓存摘要，在 `tools/change` 时精确失效——从不用定时器。答案没变的读取根本不调 `schemas()`。同一条 `tools/change` 订阅同时负责失效和推送，不是两套机制。 |
| 重绘相同数据 | `samePayload` 比较能力条实际渲染的字段；一次可见变动可能连续产生几帧，没变的帧返回同一个 state 对象，React 不调度渲染。 |
| 对慢 Host 叠请求 | in-flight 闩：读取未完成时再来的帧直接丢弃（并标记补读一次），不发第二个请求；一波帧因此最多折叠成一次补偿读取。 |

`loadedAt` 有意排除在比较之外——它每次都不同，放进去整个抑制就废了。面板显示的是当前载荷的时间戳，即"这个答案是什么时候取的"的诚实读法。

两个诚实的限制：

- **推送只覆盖工具注册表。** 收起态那两个数字里，MCP 那半是实时的（掉线、重连、新增工具立刻反映），skill 那半是"上次读取时"的值——所以一台一直放着不碰的页面，skill 计数可能偏旧。这不是漏掉了信号，而是不划算：skill 清单、Loader 行、插件包这三块的内容只在明细面板里可见，而面板一打开就必定重读一次。DSH 的转发事件白名单（`dsh-api-remotes` 里那个封闭数组）确实转发 `plugin-manager/changed`、`agent-preset/selected`，本包有意不去订它们：它们描述的是插件安装/预设切换，不等于这几块渲染的内容变了，订上只会用不相关的事件触发读取。
- **推送自己也会断，但它会承认。** 流断开时（宿主重载、cookie 失效、代理掐流），能力条显示"推送断开"标记而不是继续装作数据是新的——它冻结在旧数字上这件事，读者看得见。代价是：断开期间没有自动恢复（`EventSource` 自己会重连；彻底不再重试的情况要等你切回标签页或点刷新）。这里没有加定时重试，因为那正是这次改掉的东西。
- **连上但不暴露工具的服务器算 未连接。** 这是有意的。`dsh-mcp-client` 把连接对象（`ready`、`connectedAt`、重试监督器）保持私有，所以"连上了但零工具"和"从没连上"从外面看注册表都是零、无法区分。工具不可用的服务器两种情况下都不能用，所以安全的读法是 未连接——能力条就报这个。

## 故障会打断阅读；缺失不会

MCP 静默失败正是这个插件存在的理由：工具不工作了，唯一痕迹进了 Host 日志，GUI 里什么都没有。所以**故障**会自己弹对话框，不需要你点。

故障是一个精确形状，不只是"没有工具"：

| 情形 | 标记 | 弹窗 |
| --- | --- | --- |
| 至少一个服务器注册了工具 | 工具总数（如 `29`） | 否 |
| 配置并启用了 MCP，但没有任何服务器注册工具 | 连接故障 | **是，一次** |
| 完全没配置 MCP | 未连接 | 否 |
| 所有 MCP 行都被禁用 | 未连接 | 否 |
| 工具注册表读不动 | 读取失败 | 否 |

三个排除项和触发条件一样重要。没人配置的功能、故意关掉的服务器，去唠叨就是噪音——噪音会让插件被卸载，那才真没意义。注册表读失败被排除，是因为能力条真的无法判断有没有出问题，不能凭无知给人定罪。

每个不同的故障只弹一次（按受影响服务器名做 key），持续的故障不会因为收到推送帧就重新唠叨；点红色 连接故障 标记可在关闭后重新打开。弹窗列出每个受影响的服务器及其 Loader phase，并明说真实报错在 Host 日志里——能力条唯一拿不到的东西，说出来而不是糊弄过去。

## 两半如何通话

```
browser:  connection.rpc.call("/api", "ability-strip", payload)      # 读一次
host:     connection.fetch.register({ path: "/api/ability-strip", methods: ["POST"] })
wire:     request  { type: "client-request",  rpcId, payload: { action, data } }
          response { type: "server-response", rpcId, result }

browser:  new EventSource("api/ability-strip/events")                # 变更推送
host:     connection.fetch.register({ path: "/api/ability-strip/events", methods: ["GET"] })
wire:     text/event-stream, 每帧形如 `data: {"version":N}`
```

`rpc.call` 靠读 `owner.webServer` 建专用通道，新版 harness 拒绝这样做，所以宿主半边改为在共享 `/api` 载体上注册**精确 Fetch 路由**——载体自己挂载该路由并施加同样的 owner-only 认证。这和社区 MCP 面板用的是同一机制。这里不依赖任何第三方插件。

两条路由分开而不是给同一条加 GET，是因为契约不同：读那条是"问一次答一次"、只接受 POST（`rpc.call` 没有别的动词），推那条是一条常开的 GET 流。分开之后每条路由只有一个动词、一种形状，各自能被单独测。

为什么不用 DSH 自己的转发事件（`ctx.remote.$on`）走这条路：那是 `dsh-api-remotes` 内部一个封闭的白名单数组，共 30 条，**不含 `tools/change`**，也没有对外追加的 API；而宿主侧的 `typertGateway.registerRemoteEvents()` 是**单例**（重复注册直接抛错），运行时那个位置已经被 `dsh-api-remotes` 占用——它正是所有核心 `$on` 消费者（会话列表、审批、命令、goal、模型选择…）的数据来源。第三方插件既挤不进去，抢到手也会掐断全站。所以信号改走本包自己的路由，同一套 owner-only 认证，不外溢。

浏览器侧只用原生 `EventSource`：它自带重连与退避，不需要 `eventsource-parser` 之类的依赖（本包仍然是零运行时依赖）。服务端把响应头设成 `text/event-stream`，DSH 的 gzip 中间件对这类响应有显式豁免，所以帧不会被压缩缓冲成一坨。

两个 MCP 包是有意分开的。`@deepseek-ai/dsh-mcp-client` 是**每服务器一行**，所以那些行就是已配置的服务器列表。`@deepseek-ai/dsh-mcp-resources` 对所有服务器只挂**一次**、增加三个资源读取工具；把它算成服务器是错的，但完全藏起来又会隐藏"配置的服务器到底能不能读"。

## 它放在哪，为什么保持窄

能力条注册进 `conversation.composer.dock`——输入栏自己的 dock 元素，输入栏在它自己的输入行**之后**渲染它。`conversation.input.dock` 会落在输入框*上方*：它是 composer 栈里被输入栏跟随的子元素。别挪回去。

那个 dock 是与其他部件共享的一条 flex 行（本机上有两个会话统计部件、persona 条、上下文计）。在那里 `width: 100%` 什么也居中不了——它强迫整行溢出，把所有兄弟一起拖走，能力条自己的内容反而偏向一边。本机实测：整宽声明在 941 px 的行里占掉 **555 px**，内容只有 361 px；改为按内容定宽、把刷新控件挪进明细面板后，收起态缩到 **284 px**，去掉标题、改成 `skill N | MCP N` 的重设计又更窄。

所以：包裹层是 `flex: 0 1 auto`（内容宽），明细面板是 portal 到 `<body>` 的 fixed 浮层，打开它不改任何布局。dock 上 `justify-content: center` 居中不了这个组——那行是满的——能力条就待在 dock 放它的地方。

## 构造上就是只读的

浏览器半边只调三个只读 Remote：`skills/list`、`pluginInventory/list`、`pluginManager/listBundles`，外加订阅本包自己的变更流。宿主半边每个请求读一次工具注册表（`ctx.tools.schemas()`），变更流本身不读注册表、只转发一个版本号。不注册、不写入、不变更、不持久化任何东西：没有工具、没有设置、没有配置文件、请求之间没有状态。生命周期对象是两条 Fetch 路由和它们打开的流，effect 在 unload 时一并 dispose 并关掉所有还开着的流。

## 已知限制（面板里也写了）

- **推送只覆盖工具注册表。** MCP 那半是实时的：注册表一变就推一帧。另外三块（skill 清单、Loader 行、插件包）只在打开明细、切回标签页或手动刷新时重读——所以 skill 数量可能是几分钟前的。可见的代价：如果你完全不碰页面、又有 skill 在后台增删，收起态那个数字会偏旧；这不是"读不到"，而是"没人问就没读"。打开明细必定重读一次，所以看明细时它一定不是旧值。
- **连上但零工具读作 未连接。** 唯一的证据是注册到的工具。`dsh-mcp-client` 的连接对象是私有的，连接成功但不暴露工具的服务器和从没连上的服务器无法区分。两者都报 未连接，有意为之：工具不可用的服务器两种情况下都不能用。
- **没有连接细节。** 服务器真失败时，原因不在注册表里——它去了 Host 日志。能力条说不出为什么。
- **推送通道占一条浏览器连接。** 每个页面持有一条常开的 SSE 请求（HTTP/1.1 同一 origin 上限 6 条）。空闲时不发数据，但这条槽位是占着的。DSH 自己的客户端 HMR 也用同样的做法。
- **自带控件，只用 theme token。** 0.5.0 起本插件的浏览器半边**不加载任何 Harness Client 包**（此前 `require` 了 `@deepseek-ai/dsh-client-ui-primitives`，那是 DSH 官方 skill `cordis-plugin-development` 里 `references/practices.md` 明文禁止的做法）。按钮、状态标签、弹窗、图标全部是本 bundle 自己的实现，色彩只引用 `--dsw-alias-*` 主题变量。代价是这些控件的外观不随宿主升级自动演进；收益是宿主把那些包改名、合并、删掉时本插件不会跟着变空白。
- **tools 标记可能是全局视图。** 它按本会话 agent 读（`tools.schemas(agent)`）；但如果该会话暂时没有存活 agent（宿主查不到），会退回全局视图并在面板里写明"全局注册（未取到本会话 agent）"。**全局视图不是"更大的那个"**：它不含 `ctx.tools.restrict()` 的按 agent 削减，也**不含注册在该 agent scope 里的工具**（`view(scope)` = 全局层 + 祖先层 + 自己的注册）。本机 2026-11-09 实测同一时刻全局 40、agent 视图 72——**方向是少，不是多**。所以看到 `scope: global` 时，那个数字只能当参考。
- **tools 列表只反映注册表。** 插件在请求层做的过滤（`llm/stream` 里剔除 `options.tools`）不在此视图中：`dsh-read-img` 会隐藏并拒绝 `read_image`，但注册表仍有它，所以能力条照样列出。数字与"这次请求真发了什么"可能不一致，这是有意保留的语义差（面板里也写了）。
- **tools 计数不含按步准入。** `schemas(agent)` 没有传 `toolSet`，所以它是"这个 agent 被提供什么"，不是"某一步真放行了什么"。后者只有真实步骤内部才知道。

Loader 行只带 `entryId`、`moduleName`、`meta`、`enabled`、`fiberPhase`——**没有配置**——所以配置里的 `serverName` 从 inventory 拿不到。已连接的服务器改从工具注册表取名，面板才叫得出它们；Loader 行保留自己的行 id（本机是 `mcp-local`）。

## 安装

**当前安装形态（本机 `web` profile）：`file:` tarball 拷贝安装，不是 link。** profile 记录 `dsh-ability-strip-0.3.0.tgz` 的绝对路径，`node_modules/dsh-ability-strip` 是解包的普通目录（非符号链接）——编辑这份源码树影响不到运行中的安装。

跨插件铁律（只从 tarball 安装、为什么禁 `link:`、发版流程、排错表）见仓库根 [INSTALL.md](../INSTALL.md)——本文件不复述，只放本插件自己的命令。历史决策（为什么改名、为什么拒绝 link）见文末附录。

### 打包 / 安装 / 升级

```powershell
# 方式 A：本机打包后安装（站在本插件目录里；仓库 clone 在哪都行）
pnpm check                                   # 三项检查，必须全部 RESULT: PASS
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist\dsh-ability-strip-<版本>.tgz
dsh plugin --profile web add ./dist/dsh-ability-strip-<版本>.tgz   # 用 ./ 相对路径
# 浏览器 Ctrl+F5 硬刷新（有浏览器半边，必须刷新）

# 方式 B：git 源直接安装（免打包、不产生 dist/，任何目录执行，需联网）
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 40 位 SHA>&path:/dsh-ability-strip"
```

两种方式等效，可各机器混用；对比与取舍见仓库根 [INSTALL.md §11.2](../INSTALL.md#112-两种方式怎么选)，方式 B 的验证状态见 [§11.4](../INSTALL.md#114-方式-bgit-源直接安装)。

每次发版**递增版本号**；方式 A 的 `dist/` 留在原地（profile 记录 tarball 的本机绝对路径，之后 `dsh plugin install` 还要用）。卸载：`dsh plugin --profile web remove dsh-ability-strip`。

**换机器**：每台机器用上面任一方式装各自的一份。完整流程见仓库根 [INSTALL.md §11 跨机器使用](../INSTALL.md#11-跨机器使用多台机器)。

### 验证

- 页面输入框下方出现 `skill | N | MCP | N`；点击行展开明细、再点收起。
- 安装形态是普通目录而非源码链接（`$prof` 的取法见 [INSTALL.md §11.5](../INSTALL.md#115-升级)）：
  ```powershell
  $prof = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'profiles/web'
  (Get-Item (Join-Path $prof 'node_modules/dsh-ability-strip') -Force).LinkType   # 空 = 普通目录
  ```
- `dsh plugin --profile web why dsh-ability-strip` 有记录；`dsh --profile web --dump-config` 能看到本包 entry。

### 回滚

```powershell
# 站在本插件目录里，装回本机 dist/ 中的旧版本
dsh plugin --profile web add ./dist/dsh-ability-strip-<旧版本>.tgz   # + Ctrl+F5
```

不要改源码当回滚用——源码与运行副本无任何链接。

### 安装记录

- **2026-10-28**：0.3.0 首装（旧路径 `default-workspace\dsh-ability-strip`）；页面实测 `skill | 22 | MCP | 29`、明细展开/收起、29 个工具名、故障弹窗全过。
- **2026-11-03**：随单仓库迁移移至 `dsh-plugins\dsh-ability-strip`，profile 从新路径重新登记（相同字节重装，`lib\client.js`/`lib\index.js` 安装副本哈希与源码一致、`LinkType` 为空、`why` 有记录）。

`dsh plugin add` 会转发给 profile 内的 pnpm，并自动把包追加进 `dsh.profile.bundles`（因为声明了 `dsh.bundle.patch`）。

**重启规则（本包两半都有代码，必须分清）**：
- 只改浏览器半边（`lib/client.js`）→ Host 不用重启，`Ctrl+F5` 硬刷新即可。
- **改宿主半边（`lib/index.js`）→ 必须重启 Host 进程**：Loader 用普通 `import()` 载入宿主模块，同一 specifier 命中 Node 的 ESM 缓存，`dsh-hmr` 只重组层、不重新求值模块。

实测证据（2026-11-09）：安装新增了推送路由的 0.4.0 后硬刷新，旧路由 `POST /api/ability-strip` 仍返回 200，而新增的 `GET /api/ability-strip/events` 返回 404——宿主仍在跑旧代码。判别"宿主是否加载了新代码"最快的方法就是探测只有新代码才有的路由/行为。详见仓库根 [INSTALL.md](../INSTALL.md) §4。

## 附录：为什么拒绝 `link:` 和目录安装（历史决策记录，不是当前形态）

以下记录当初的决策依据：为什么安装介质必须是 tarball、为什么坚决不用 `link:`。**当前安装不是 link**（见上节）；跨插件的通用机制分析见仓库根 [INSTALL.md](../INSTALL.md) 第 1 节，这里只留本插件独有的实测记录。

### 为什么在这里 `link:` 安装不安全——实测，不是假设

`dsh-client-modules` 把每个插件客户端 bundle 的**绝对**路径缓存在 `pkgMeta`，key 是 `` `${baseUrl}\0${loaderName}` ``，且**永不失效**（包内没有任何 `delete`/`clear`）。`captureArtifactBaseline()` 随后 stat 这个缓存路径来推导 revision，于是整个会话一直读的是**第一次**解析时记下的文件。

`link:` 安装记下的就是源码目录。卸载、从 tarball 重装、改 profile 都不清这个缓存：Host 会一直发工作树的文件，直到重启。这在本机实测到过——boot graph 发的是源文件的 revision，profile 里的拷贝原封未动。

不需要重启的修复是**换包名**：新的 specifier 就是新的缓存 key，第一次解析发生在 tarball 进 profile 之后，钉住的就是拷贝。这就是本包叫 `dsh-ability-strip` 而不是早先 `dsh-runtime-inspector` 身份的原因。

### 为什么是 tarball 而不是目录 / `link:`

已对照 pnpm 文档和 DSH 自己的 spec 解析器验证：

| spec 形态 | pnpm 结果 | DSH 解析为 |
| --- | --- | --- |
| `<绝对路径>.tgz` | store 里的解包拷贝 | `tarball` |
| `<绝对目录>` | **符号链接**，等同 `pnpm link` | `path` |
| `link:<绝对目录>` | **符号链接** | `path` |

pnpm 文档直说：从目录安装"会在 `node_modules` 里创建符号链接，等同于运行 `pnpm link`"。符号链接意味着改这棵树会不经评审直接改活的 UI，所以两种非 tarball 形态都被有意拒绝。

## 文件

| 路径 | 角色 |
| --- | --- |
| `README.md` | 插件说明 + 本插件安装命令（跨插件规约见仓库根 `../INSTALL.md`） |
| `HANDOFF.md` | 交接档案（状态快照/哈希/教训/决策记录） |
| `cordis.patch.yml` | 往 Loader 插入承载本包的 Host 行 |
| `lib/index.js` | 宿主半边：读 `ctx.tools.schemas()`，服务 `/api/ability-strip`（读）与 `/api/ability-strip/events`（变更推送） |
| `lib/client.js` | 浏览器半边：能力条本体，lazy-CJS `__ModuleLoader__` 形态 |
| `scripts/` | 四项验证检查（见下） |
| `dist/*.tgz` | 构建出的安装介质，不入 git |

## 环境要求

- DSH `>=0.2.0-rc.2`（声明为 `engines.dsh`，安装和启动时强制）

`engines.dsh` 很重要：没有它，一次改变客户端 slot API 的 DSH 升级会在运行时静默失败，而不是拒绝安装。有意不声明 `engines.node`——本包不添加任何 Node 版本相关的 Host 代码，DSH 自己也不声明 Node 范围，声明一个就是无根据的约束。

按官方 manifest 参考：

- `engines.dsh` 独自决定；声明它时 `peerDependencies` 被忽略，且预发布版本参与范围匹配——这就是 `>=0.2.0-rc.2` 能匹配运行中的 `0.2.1-rc.2` 的原因。
- `dsh.manifestVersion: 1` 标记 manifest 格式（与 npm、Session 版本无关）。
- `dsh.bundle.patch` 可以是一个路径或有序列表；本包用一个。
- 不兼容的 **bundle** 在启动时跳过并列入 `skippedBundles`，不会崩掉应用；不兼容的 **tarball 安装**在安装后判定再回滚。这就是范围要声明在这里而不是留空的原因。
- `dsh.client.external` 只用于非基线模块请求。本 bundle 只 import `react` 和 `react-dom`，两者都在 shell 的静态表里，所以不需要 `external` 条目。**不加载任何 Harness Client 包**是刻意的，理由见「已知限制」与仓库根 `INSTALL.md` §15.3。

## 构建

没有构建步骤。`lib/client.js` 直接按模块系统期望的 lazy-CJS 形态编写——一次 `window.__ModuleLoader__.load({ id, factory })` 注册，factory 只 `require` 基线模块。Host 原样发这个文件，revision 由 mtime/size 推导，无需编译。`scripts/` 里的检查就是编译器本该提供的安全网，且不需要浏览器就能跑。

## 验证

不涉及浏览器。四项检查直接对着真实源码跑：

```sh
node scripts/check-host.mjs              # mcp__ 拆分、按服务器汇总、两条路由契约、变更流
node scripts/check-bundle-contract.mjs   # loader 注册 + slot + inject 契约
node scripts/check-render.mjs            # 渲染能力条的每一种显示状态 + 推送机制
node scripts/verify-pack.mjs <tarball>   # tarball 与本树一致，引用齐全
pnpm check                               # 前三项一起
```

每项钉死什么：

- **check-host** 导入 `lib/index.js`，钉死承重假设：`mcp__<server>__<tool>` 拆分，包括服务器名本身含 `__` 的情况（在**最后一个**分隔符处拆）以及拒绝非 MCP 名。随后检查汇总形状、注册表抛错变成 `error` 而不是静默零。路由部分是**两条**：读路由在 `/api/ability-strip`，只接受 POST、认载体 `client-request` 信封、对不可解析的 body 回 400；推送路由在 `/api/ability-strip/events`（路径按字面钉死，和浏览器硬编码的那串必须一致），只接受 GET、回 `text/event-stream`。变更流的契约逐条测：开流先写一条 SSE 注释、紧接着一帧当前版本；**开流本身不查注册表**（缓存是冷的，所以真读了会立刻多一次 `schemas()`）；`tools/change` 恰好推出下一版；请求中止与 effect dispose 都必须把流关掉。缓存部分：`tools/change` 恰好失效一次、重复读取不碰注册表、同一条 `tools/change` 订阅既管失效又管推送（订阅者收到变更、退订后收不到、订阅不读注册表）。
- **check-bundle-contract** 用一个桩 `window.__ModuleLoader__` 求值 `lib/client.js`，断言 factory id 等于包名、只 require 基线模块（`react`、`react-dom`）、导出的 `inject` 列表覆盖实际读取的每个 Remote 和 service（含 `connection`），且 `apply()` 恰好往 `conversation.composer.dock` 注册一个组件、inject face 暴露 `load` 且*不*遮蔽内置 `sessionId` prop。基线允许表只留 React，并单列一条断言：**只要 `require` 里出现任何 `@deepseek-ai/*` 就失败**——把官方那条"不加载 Harness Client 包"从注释变成会红的检查（变异验证：把 primitives 加回去，该检查立刻红并打印官方出处）。
- **check-render** 用一个小 hook 运行时构建树，桩掉 `document.body`、`createPortal`、`EventSource` 记录器，断言每种显示状态下读者可见的文本：首绘（pending，从不下假结论）、已加载（`skill N`、MCP 工具数、不打印服务器 id）、**配置了服务器但零工具注册时读作 未连接**且仍列为已配置、展开态（portal 面板带两节标题、skill `/name`、`whenToUse`、已连接服务器及工具数和工具名称、Loader phase、资源插件行、bundles、刷新与关闭控件）、无资源插件、工具注册表失败（`读取失败`，绝不静默报已连接/未连接）、skills/bundles 独立失败、空但成功的读取（`未连接`）、以及 load 抛错（错误必须可见）。它还证明收起态不构建任何明细树（dock 在 composer 每次击键都会重渲染）。
- **推送机制本身在 check-render 里被钉死**：`setInterval` 被捕获而从不调度——**任何状态下只要注册了定时器就算失败**（这是"旧问题消失"的直接证据）；每次挂载恰好开一条流、地址是文档相对路径 `api/ability-strip/events`、卸载时关掉并摘掉 visibility 监听器。三道护栏对应三类浪费，各自有独立断言：隐藏标签页收到帧也不读（切回来补读）、同一答案的帧返回同一个 state 对象（不渲染）、读取未完成时的一波帧折叠成一次补偿读取。推送断开这一路单独测：报错后**恰好**补读一次且标记可见、再报错**不**再补读、`open` 后标记清除且下一次报错又会补读一次、关掉的流在切回标签页时重开一条（活着的时候不许重开）。
- **故障触发有自己的变异矩阵。** 三个条件每一个都被证明是必要的——破坏它、看对应检查失败：去掉 `tools.error` 会让读不动的注册表弹窗，去掉"有启用行"要求会让没配置的 profile 弹窗，把"没有服务器"强制为 false 会让真故障漏报。每条否定检查都跑完整的提交序列，否则错误弹开的对话框根本到不了可见阶段。
- **变化流的泄漏不变量逐条测**（check-host）：`openEventStream` 用真实 `ReadableStream` 直接驱动，三条结束路径——请求 abort、消费端 cancel、unload 走集合——每一条都必须把订阅者和 unload 集合里的条目一起清掉，且重复拆除不得复活订阅者。订阅者数量由 reader 只读的 `subscribers` 暴露，所以"忘了 detach"或"忘了从集合里删"都会被抓到，而不是只跑了绿。
- **verify-pack** 解开 `.tgz` 与本树逐条比对（`package.json` 按值比，因为 pnpm 会重写其格式），并检查 `main` / `exports` / `files` / `dsh.bundle.patch` 引用的每个文件确实在载荷里。

这些能抓住 `node --check` 抓不住的：未定义标识符、写错的 slot 名、读了 Remote 却没声明对应 inject、以及与 MCP 客户端约定不一致的工具名拆分。

## 验证状态

- `pnpm check`（check-host / check-bundle-contract / check-render）在当前树上全部通过（跑一遍，输出就是证据）。
- **0.4.0 的推送机制已在真机上验证**（2026-11-09，重启 Host 后）：`GET /api/ability-strip/events` 返回 200 + `text/event-stream`；页面内 `EventSource` 连上并收到首帧 `{"version":0}`；空闲 20 秒**零请求**（旧版每 15 秒一次）；推送断开时琥珀警示标真实出现（那次 404 恰好提供了真实故障场景）。
- **0.5.0（剥离 primitives）已在真机上验证**：装 0.5.0 后硬刷新，自绘 3 个 svg 正常渲染（`stroke` 计算值 = `--dsw-alias-label-primary`），面板布局与 tag 对齐正常、刷新按钮确实发出请求，20 秒空闲零请求，源码零 `setInterval`/`setTimeout`。宿主半边未改，故当时无需重启。
- **0.6.0（tools 标记）待重启 Host 后才能真机验证宿主半边**：新增的 `local` / `scope` 字段由宿主产出，替换已安装包的宿主 JS 必须重启（INSTALL.md §15.1）。客户端半边硬刷新即可，且在旧宿主下 `totalTools` 仍能正确显示——只是非 MCP 清单会空、scope 会显示"全局注册"。（**已重启验证**：	ools 72、标注“本会话 agent 可见”、非 MCP 工具名清单非空）
- **0.7.0（图标化 + 工具描述）已部分真机验证**：收起态三个标记只剩图标与数字（`23 / 28 / 72`），行宽 132px → **114px**；`aria-label` 与 tooltip 保留完整状态文案。**工具描述需再重启一次宿主**才出现——描述由宿主产出，运行中的宿主仍是 0.6.0；客户端已按"旧宿主只给名字"降级（`asTool`），不会渲染成 undefined。
- 变异矩阵（0.4.0 本轮实测，19 条，每条都确认检查会失败并逐条还原到字节一致）：去掉隐藏标签页护栏、去掉 `samePayload` 抑制、去掉 in-flight 闩、去掉"打开面板即读"、去掉卸载时关流、重新加回 15 秒 `setInterval`、让变更流去读注册表、去掉宿主 unload 关流、重命名宿主路由名、只改浏览器侧路由名、去掉宿主 abort 监听、**去掉 `error` 监听、去掉"一次故障只补读一次"这层闸、不重置这道闸、去掉"切回标签页重开死流"、把重开改成无条件重开（会重复开流）、去掉拆除时的 `detach`、去掉拆除时对 unload 集合的删除**——全部被对应检查抓到。
- 同上但**未被任何断言覆盖**的一处，如实记下：`openEventStream` 里 `send()` 的 `catch`（`controller.enqueue` 抛错时走 `shutdown`）目前**没有任何可触发的路径**——只有"流被关闭/置错但拆除没跑"才会走到它，而代码里所有关闭点都先走 `shutdown`。把 `catch` 改回"只置标志不拆除"，检查仍然全绿。这条修复是对的安全网，不是被测试证明的行为；加测试只能靠给生产代码塞一个测试专用入口，判定不划算。
- `verify-pack` 是打包介质比对：0.3.0 / 0.4.0 / 0.5.0 打包时均通过。README 这类文档改动会让已打包的 tarball 与当前树不一致——发下一版时重新 `pnpm pack` 后再跑。
- **0.3.0 曾在运行中的 Host 上验证**（2026-10-28，本机）：Loader 加载了宿主半边，`/api/ability-strip` 路由注册成功，浏览器→宿主 RPC 往返成功；页面实测收起态 `skill | 22 | MCP | 29`，点击行展开明细、列出 29 个工具名称，再次点击收起；MCP 故障弹窗的触发与关闭也实测过。0.4.0 的同一组实测待装后进行。
- 早期版本的实测记录：能力条渲染在 `[data-composer-dock]`、编辑器下方；所发 bundle 的 revision 等于已安装拷贝的 `artifactRevision`，而不是源码树的——这个测量证明 `lib/` 下的代码已不是页面运行的代码。
