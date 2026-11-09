# dsh-ability-strip

> **AI 编写声明（如实披露）**：本插件的全部代码与文档由 AI 编写（DeepSeek 的 AI 编程智能体，在 DeepSeek Harness 会话中完成）。人类角色是需求方与评审验收方：提出需求、纠正设计、把关 code review、做最终验收和安装决策；代码本身没有人类手写的行。对 AI 生成代码有顾虑的使用者请知悉后再用。

DeepSeek Harness（dsh）Web GUI 输入框下方的**只读**能力条——挂在输入栏自己的 dock 里，和 persona 条同一排。它回答一个 GUI 默认看不见的问题：*这个会话到底有什么可用？*——用三个互相独立的标记回答。

**收起态只有图标和数字，没有文字标签**（0.7.0 起）：dock 是共用的横向 flex 行，每个标签都在占用数字需要的宽度。三个标记各用自己的图标区分（火花 / 地球 / 扳手），并带 `aria-label` 与 tooltip，含义不依赖文字。

| 标记（图标） | 数据来源 | 收起时显示什么 |
| --- | --- | --- |
| 火花 | `skills/list`（浏览器 Remote） | 本会话可见的可调用 skill 数量；读取失败时显示红色警示图标 |
| 地球 | `ctx.tools.schemas(agent)`（本包宿主半边） | 连上时显示 MCP 工具数（绿色）；未连接显示 ✕（琥珀）；连接故障或清单读取失败显示警示图标（红色） |
| 扳手 | 同上（同一次读取） | 模型**总共**被提供多少工具（含 MCP）；面板里把总数拆成"非 MCP"与"上方 MCP 分区"两段并各自计数（**不是**用减法推出来） |

### 没有活跃 agent 时不显示数字（0.9.0 起）

宿主是按**本会话的 agent** 读工具面的（`tools.schemas(agent)`），而 agent 只在"该会话在本 Host 进程里活着"时才存在——会话控制器是按需 resume 的。所以**重启之后，或任何还没在本进程运行过的会话，根本没有 agent 可读**。

收起态的扳手标记有五个互不混淆的状态：**读取中**（…）、**读不到工具清单**（红色问号）、**该会话无活跃 agent**（琥珀问号，不显示数字）、**上次活跃时**（淡色数字 + 时间，agent 已释放但本进程还记得那次读数）、**就绪**（数字，tooltip 写明"本会话 agent 被提供的工具总数"）。后两态必须分开：payload 还没到、或 payload 里根本没有 tools 块，都不能冒充"会话没有 agent"。，面板里则明说"该会话当前没有活跃 agent……下面是部署级注册表，不是本会话的数字"，并给出办法：在会话里发一条消息，再点刷新即可读到本会话视图。

> 之前的做法是退回全局注册表并照常显示数字。那是个诚实性错误：用户看到的是一个"本会话有 N 个工具"的位置上摆着**别的**数字。宁可显示"读不到"，也不拿部署级数字冒充会话数字。

**状态文字去哪了**：收起态不印"未连接 / 连接故障 / 读取失败"，因为那些字比数字更占地方。它们移到两处——每个标记的 **tooltip**（悬停可见），以及**展开后的明细面板**（MCP 分区的标题右侧直接写出来）。所以"简洁"没有以"看不见状态"为代价。

点击这一行（`role="button"`，就是三个标记本身，没有单独的展开图标）展开**浮动**明细面板（fixed，portal 到 `<body>`，永不推挤页面），列出：

- 每个 skill 的 `/name`、`model+user` / `user-only`、描述和 `whenToUse`
- 每个**已连接** MCP 服务器，及其每个工具的**名字与描述**
- **非 MCP 工具**的名字与描述。**标题的数字就是这一列的条数**（不是总数），下面一行小字把数字算清：`共 N 个：下列 x 个非 MCP，上方 MCP 分区 y 个`；右侧标明是按 agent 视图还是全局视图读的
- 已配置的 MCP Loader 行，带各自的 phase；`dsh-mcp-resources` 是否挂载
- profile 启用的插件包

刷新和关闭在面板头部；Escape 或点击面板外任意位置关闭。

> **工具描述是工具作者自己的话**，直接取自模型看到的那份 schema——所以它回答"这个工具是干什么的"，且不掺任何猜测。描述在宿主侧截断到 400 字符（网络边界，不是取舍），被截断时会带 `…`（**tooltip 里也只有截断后的那一份**：宿主是唯一的来源，截断发生在它发出之前）。每行最多显示两行描述，避免一条长描述把整个列表挤出视野。

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

## MCP 的"已连接"判断是真实的，且靠重读而非推送

声明了 MCP 服务器，不等于连上了。`dsh-mcp-client` 只有在真正连上并列出工具之后，才会把
`mcp__<server>__<tool>` 注册进工具注册表；连不上就一个都不注册。所以"这个 server 的工具在不在
注册表里"是浏览器唯一能拿到的连接证据，本包的 MCP 标记就只承认这一条判据。

**判据的取舍**：连上但一个工具都没暴露的服务器，与根本没连上的服务器，在注册表里完全一样（都没东西）。
本包把两者都算"未连接"——一个拿不到工具的服务器对你没用，哪怕 socket 是通的。

### 更新方式：按需重读（0.10.0 起不再推送）

早期版本在共享 `/api` 载体上另开了一条 SSE 路由（`/api/ability-strip/events`），注册表一变就推一帧。
**已移除**。现在这条能力条是一个"读数"，不是订阅：它在四个时刻重读——挂载时、切换会话时、
打开明细时、以及你按刷新时。没有推送、没有定时器、不占常开连接。

代价要说清楚：**数字是你上次读它的那一刻，不是此刻。** MCP 服务器在你没重读的这段时间里掉线，
条上不会自己变；点开明细或刷新才会重读。

### 没有活跃 agent 时：记住上一次，并标明时间

宿主只在"该会话的 agent 活在这个进程里"时才能读到它自己的工具面。所以：

- **有活跃 agent**：读到的就是当前值，`scope: agent`，tooltip 写明"本会话 agent 被提供的工具总数"。
- **agent 已释放（进程还在）**：宿主**记得**上一次该会话的答案，原样返回并标记 `stale` + `recordedAt`。
  收起态仍显示那个数字（淡色，表示不是当前值），tooltip 写"上次活跃时（N 分钟前）……当前无活跃 agent"；
  面板标题写"上次活跃时 · N 分钟前"，并明说"下面是它上次活跃时读到的工具清单，**不是现在的部署注册表**"。
- **重启之后 / 从未读过**：没有任何记忆，收起态显示琥珀问号且**不显示数字**，面板说明原因与办法。

> 这是**进程内记忆**：不写文件、不读会话日志、不进浏览器存储。进程结束它自然消失，那个会话在重启后回到"没有读数"的状态——只是内存实现的自然结果。

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

每个不同的故障只弹一次（按受影响服务器名做 key），持续的故障不会因为你重读一次就重新唠叨；点红色 连接故障 标记可在关闭后重新打开。弹窗列出每个受影响的服务器及其 Loader phase，并明说真实报错在 Host 日志里——能力条唯一拿不到的东西，说出来而不是糊弄过去。

## 两半如何通话

浏览器看得到 skill 目录、插件包清单、MCP 配置行，但**看不到工具注册表**。这个信息缺口由本包的宿主半边补上，
走的是 DSH 自己的 RPC 载体（`connection.rpc.call`）——和 DSH 内置 Remote 同一条路径、同一套鉴权与超时。

```js
browser:  connection.rpc.call("/api", "ability-strip", { sessionId })   # 读一次
host:     { type: 'server-response', rpcId, result: { ok: true, value: {...} } }
```

`result.value` 里有：`scope`（`agent` / `global`）、`totalTools`、`servers`（每个 MCP 服务器及其工具名与描述）、
`local`（非 MCP 工具及其描述）、`readAt`；从记忆作答时另有 `stale: true` 与 `recordedAt`。

一条路由，一个动词（POST）。没有第二条流路由，也没有浏览器侧的长连接。

## 它放在哪，为什么保持窄

能力条注册进 `conversation.composer.dock`——输入栏自己的 dock 元素，输入栏在它自己的输入行**之后**渲染它。`conversation.input.dock` 会落在输入框*上方*：它是 composer 栈里被输入栏跟随的子元素。别挪回去。

那个 dock 是与其他部件共享的一条 flex 行（本机上有两个会话统计部件、persona 条、上下文计）。在那里 `width: 100%` 什么也居中不了——它强迫整行溢出，把所有兄弟一起拖走，能力条自己的内容反而偏向一边。本机实测：整宽声明在 941 px 的行里占掉 **555 px**，内容只有 361 px；改为按内容定宽、把刷新控件挪进明细面板后，收起态缩到 **284 px**，去掉标题、改成 `skill N | MCP N` 的重设计又更窄。

所以：包裹层是 `flex: 0 1 auto`（内容宽），明细面板是 portal 到 `<body>` 的 fixed 浮层，打开它不改任何布局。dock 上 `justify-content: center` 居中不了这个组——那行是满的——能力条就待在 dock 放它的地方。

## 构造上就是只读的

浏览器半边只调三个只读 Remote：`skills/list`、`pluginInventory/list`、`pluginManager/listBundles`，外加读本包自己的宿主路由。宿主半边每次读取时读一次工具注册表（`ctx.tools.schemas(agent)`）。**不写文件、不读会话日志、不持久化任何东西**：没有工具、没有设置、没有配置文件、没有磁盘痕迹。唯一的运行时状态是本进程内的两张有界表（当前答案缓存 + 每个会话上一次读数），`dispose()` 时一起清掉；生命周期对象只有一条 Fetch 路由。

## 已知限制（面板里也写了）

- **按需重读意味着你看到的是上次读数。** 四块（工具、skill 清单、Loader 行、插件包）都在同一次读取里取回，所以它们之间不会互相错位；但它们整体都可能落后于此刻。掉线、重连、新装插件这些变化，要等下一次读取（打开明细 / 刷新）才反映出来——所以 skill 数量可能是几分钟前的。可见的代价：如果你完全不碰页面、又有 skill 在后台增删，收起态那个数字会偏旧；这不是"读不到"，而是"没人问就没读"。打开明细必定重读一次，所以看明细时它一定不是旧值。
- **连上但零工具读作 未连接。** 唯一的证据是注册到的工具。`dsh-mcp-client` 的连接对象是私有的，连接成功但不暴露工具的服务器和从没连上的服务器无法区分。两者都报 未连接，有意为之：工具不可用的服务器两种情况下都不能用。
- **没有连接细节。** 服务器真失败时，原因不在注册表里——它去了 Host 日志。能力条说不出为什么。
- **按需重读不等于"打开必新"。** 打开明细会重读一次，但若两次答案完全相同，界面不会重绘（省一次无意义的重渲染）——所以"我点开了它就是最新"不成立，只有"我刚读了一次"成立。
- **没有任何常开连接。** 旧版每个页面持有一条 SSE 请求（HTTP/1.1 同一 origin 上限 6 条），现在这条连接不存在了：读一次、关掉，只此而已。DSH 自己的客户端 HMR 也用同样的做法。
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

历史实测证据（2026-11-09，0.4.0 时期；推送路由已在 0.10.0 移除）：安装新增了推送路由的 0.4.0 后硬刷新，旧路由 `POST /api/ability-strip` 仍返回 200，而新增的 `GET /api/ability-strip/events` 返回 404——宿主仍在跑旧代码。判别"宿主是否加载了新代码"最快的方法就是探测只有新代码才有的路由/行为。详见仓库根 [INSTALL.md](../INSTALL.md) §4。

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
| `lib/index.js` | 宿主半边：读 `ctx.tools.schemas(agent)`，按需服务 `POST /api/ability-strip`，并在内存里记住每个会话上一次由活 agent 给出的答案 |
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
node scripts/check-render.mjs            # 渲染能力条的每一种显示状态 + 按需读取契约
node scripts/verify-pack.mjs <tarball>   # tarball 与本树一致，引用齐全
pnpm check                               # 前三项一起
```

每项钉死什么：

- **check-host** 导入 `lib/index.js`，钉死承重假设：`mcp__<server>__<tool>` 拆分，包括服务器名本身含 `__` 的情况（在**最后一个**分隔符处拆）以及拒绝非 MCP 名。随后检查汇总形状、注册表抛错变成 `error` 而不是静默零。路由部分是**两条**：读路由在 `/api/ability-strip`，只接受 POST、认载体 `client-request` 信封、对不可解析的 body 回 400；推送路由在 `/api/ability-strip/events`（路径按字面钉死，和浏览器硬编码的那串必须一致），只接受 GET、回 `text/event-stream`。变更流的契约逐条测：开流先写一条 SSE 注释、紧接着一帧当前版本；**开流本身不查注册表**（缓存是冷的，所以真读了会立刻多一次 `schemas()`）；`tools/change` 恰好推出下一版；请求中止与 effect dispose 都必须把流关掉。缓存部分：`tools/change` 恰好失效一次、重复读取不碰注册表、同一条 `tools/change` 订阅既管失效又管推送（订阅者收到变更、退订后收不到、订阅不读注册表）。
- **check-bundle-contract** 用一个桩 `window.__ModuleLoader__` 求值 `lib/client.js`，断言 factory id 等于包名、只 require 基线模块（`react`、`react-dom`）、导出的 `inject` 列表覆盖实际读取的每个 Remote 和 service（含 `connection`），且 `apply()` 恰好往 `conversation.composer.dock` 注册一个组件、inject face 暴露 `load` 且*不*遮蔽内置 `sessionId` prop。基线允许表只留 React，并单列一条断言：**只要 `require` 里出现任何 `@deepseek-ai/*` 就失败**——把官方那条"不加载 Harness Client 包"从注释变成会红的检查（变异验证：把 primitives 加回去，该检查立刻红并打印官方出处）。
- **check-render** 用一个小 hook 运行时构建树，桩掉 `document.body`、`createPortal`、`setInterval` 与 `EventSource` 记录器（后者用于断言**不再开流**），断言每种显示状态下读者可见的文本：首绘（pending，从不下假结论）、已加载（`skill N`、MCP 工具数、不打印服务器 id）、**配置了服务器但零工具注册时读作 未连接**且仍列为已配置、展开态（portal 面板带两节标题、skill `/name`、`whenToUse`、已连接服务器及工具数和工具名称、Loader phase、资源插件行、bundles、刷新与关闭控件）、无资源插件、工具注册表失败（`读取失败`，绝不静默报已连接/未连接）、skills/bundles 独立失败、空但成功的读取（`未连接`）、以及 load 抛错（错误必须可见）。它还证明收起态不构建任何明细树（dock 在 composer 每次击键都会重渲染）。
- **"不推送、不空转"本身在 check-render 里被钉死**：`setInterval` 被捕获而从不调度——**任何状态下只要注册了定时器就算失败**（这是"旧问题消失"的直接证据）；每次挂载恰好开一条流、地址是文档相对路径 `api/ability-strip/events`、卸载时关掉并摘掉 visibility 监听器。三道护栏对应三类浪费，各自有独立断言：隐藏标签页收到帧也不读（切回来补读）、同一答案的帧返回同一个 state 对象（不渲染）、读取未完成时的一波帧折叠成一次补偿读取。推送断开这一路单独测：报错后**恰好**补读一次且标记可见、再报错**不**再补读、`open` 后标记清除且下一次报错又会补读一次、关掉的流在切回标签页时重开一条（活着的时候不许重开）。
- **故障触发有自己的变异矩阵。** 三个条件每一个都被证明是必要的——破坏它、看对应检查失败：去掉 `tools.error` 会让读不动的注册表弹窗，去掉"有启用行"要求会让没配置的 profile 弹窗，把"没有服务器"强制为 false 会让真故障漏报。每条否定检查都跑完整的提交序列，否则错误弹开的对话框根本到不了可见阶段。
- **变化流的泄漏不变量逐条测**（check-host）：`openEventStream` 用真实 `ReadableStream` 直接驱动，三条结束路径——请求 abort、消费端 cancel、unload 走集合——每一条都必须把订阅者和 unload 集合里的条目一起清掉，且重复拆除不得复活订阅者。订阅者数量由 reader 只读的 `subscribers` 暴露，所以"忘了 detach"或"忘了从集合里删"都会被抓到，而不是只跑了绿。
- **verify-pack** 解开 `.tgz` 与本树逐条比对（`package.json` 按值比，因为 pnpm 会重写其格式），并检查 `main` / `exports` / `files` / `dsh.bundle.patch` 引用的每个文件确实在载荷里。

这些能抓住 `node --check` 抓不住的：未定义标识符、写错的 slot 名、读了 Remote 却没声明对应 inject、以及与 MCP 客户端约定不一致的工具名拆分。

## 验证状态

- `pnpm check`（check-host / check-bundle-contract / check-render）在当前树上全部通过（跑一遍，输出就是证据）。
- **0.10.0 真机验证**（2026-11-09）：活跃会话上显示 `工具 72`，tooltip "本会话 agent 被提供的工具总数（含 MCP）：72"；面板 `工具 44 · 注册表 · 本会话 agent 视图 · 共 72 个：下列 44 个非 MCP，上方 MCP 分区 28 个`。早期的推送路由（0.4.0–0.9.x，`GET /api/ability-strip/events`）已移除，其历史验证记录不再适用。
- **0.5.0（剥离 primitives）已在真机上验证**：装 0.5.0 后硬刷新，自绘 3 个 svg 正常渲染（`stroke` 计算值 = `--dsw-alias-label-primary`），面板布局与 tag 对齐正常、刷新按钮确实发出请求，20 秒空闲零请求，源码零 `setInterval`/`setTimeout`。宿主半边未改，故当时无需重启。
- **0.6.0（tools 标记）待重启 Host 后才能真机验证宿主半边**：新增的 `local` / `scope` 字段由宿主产出，替换已安装包的宿主 JS 必须重启（INSTALL.md §15.1）。客户端半边硬刷新即可，且在旧宿主下 `totalTools` 仍能正确显示——只是非 MCP 清单会空、scope 会显示"全局注册"。
（**已重启验证**：	ools 72、标注“本会话 agent 可见”、非 MCP 工具名清单非空）
- **0.7.0（图标化 + 工具描述）已部分真机验证**：收起态三个标记只剩图标与数字（`23 / 28 / 72`），行宽 132px → **114px**；`aria-label` 与 tooltip 保留完整状态文案。**工具描述需再重启一次宿主**才出现——描述由宿主产出，运行中的宿主仍是 0.6.0；客户端已按"旧宿主只给名字"降级（`asTool`），不会渲染成 undefined。
- 变异矩阵（0.4.0 本轮实测，19 条，每条都确认检查会失败并逐条还原到字节一致）：去掉隐藏标签页护栏、去掉 `samePayload` 抑制、去掉 in-flight 闩、去掉"打开面板即读"、去掉卸载时关流、重新加回 15 秒 `setInterval`、让变更流去读注册表、去掉宿主 unload 关流、重命名宿主路由名、只改浏览器侧路由名、去掉宿主 abort 监听、**去掉 `error` 监听、去掉"一次故障只补读一次"这层闸、不重置这道闸、去掉"切回标签页重开死流"、把重开改成无条件重开（会重复开流）、去掉拆除时的 `detach`、去掉拆除时对 unload 集合的删除**——全部被对应检查抓到。
- 同上但**未被任何断言覆盖**的一处，如实记下：`openEventStream` 里 `send()` 的 `catch`（`controller.enqueue` 抛错时走 `shutdown`）目前**没有任何可触发的路径**——只有"流被关闭/置错但拆除没跑"才会走到它，而代码里所有关闭点都先走 `shutdown`。把 `catch` 改回"只置标志不拆除"，检查仍然全绿。这条修复是对的安全网，不是被测试证明的行为；加测试只能靠给生产代码塞一个测试专用入口，判定不划算。
- `verify-pack` 是打包介质比对：0.3.0 / 0.4.0 / 0.5.0 打包时均通过。README 这类文档改动会让已打包的 tarball 与当前树不一致——发下一版时重新 `pnpm pack` 后再跑。
- **0.3.0 曾在运行中的 Host 上验证**（2026-10-28，本机）：Loader 加载了宿主半边，`/api/ability-strip` 路由注册成功，浏览器→宿主 RPC 往返成功；页面实测收起态 `skill | 22 | MCP | 29`，点击行展开明细、列出 29 个工具名称，再次点击收起；MCP 故障弹窗的触发与关闭也实测过。0.4.0 的同一组实测待装后进行。
- 早期版本的实测记录：能力条渲染在 `[data-composer-dock]`、编辑器下方；所发 bundle 的 revision 等于已安装拷贝的 `artifactRevision`，而不是源码树的——这个测量证明 `lib/` 下的代码已不是页面运行的代码。
