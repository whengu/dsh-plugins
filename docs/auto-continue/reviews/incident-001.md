# 独立评审 — 事故 001（client load id 与包名不一致）

> 评审角色：独立评审者（未参与修复实现）。
> 方法：静态代码走读 + 调用链推演（加载 `code-review-static` skill，未运行被审代码、未运行测试、未安装、未提交）。
> 评审对象身份（冻结快照 SHA-256，开工自算，四项全部吻合，无停止条件）：
>
> | 文件 | SHA-256 |
> | --- | --- |
> | `dsh-auto-continue/lib/client.js` | `166297ABABE010F913C42ACBD8843EC52FDB4D0CEF2622D23B256E4597AE49B2` |
> | `dsh-auto-continue/scripts/check.mjs` | `2BE9A87234EA81F65A183E8FD9951F1304C1D179993305F9376904E22B4AB40D` |
> | `dsh-auto-continue/lib/index.js`（未改） | `A81876516C9DCDB0C3614010E998A7EC850C44986ECAA4C8207198BAFCADCF79` |
> | `dsh-auto-continue/lib/boot.js`（未改） | `856EAD3A1596E1DFE682B10096D0C36306CC1656ECBFB8BBF6B62DFEA34B5229` |

---

## 1. 结论

**打回 — NOT_READY / FAIL。**

根因判断**成立**：主 agent 对事故机理的说明经 dsh-client-modules 源码逐层核对无误，源码侧修正（`lib/client.js` 的 load id 改为 `dsh-auto-continue`）本身正确且充分。**但修复没有进入发布介质**：仓库内唯一的 `dist/dsh-auto-continue-0.2.0.tgz` 解包后 `lib/client.js` 仍是旧 id `auto-continue`，且新增静态门禁只校验源码、不校验 tgz。按本仓库 `INSTALL.md` 的安装铁律只能从 tarball 安装，因此**按现状"安全重装"会 100% 重现同一事故**。

findings 计数：**1 BLOCKER / 0 MAJOR / 2 MINOR**。存在 BLOCKER → 打回。

**可否安全重装：否。** 必须先按 F-01 修复发布介质并复核，再重装。

---

## 2. 根因裁决

主 agent 说法：**成立（事实，置信度高）**。逐层证据如下。

### 2.1 boot manifest entry id 从哪来 — 等于包名

- `dsh-client-modules/lib/index.js` 的 `graphRow(id, rev, fields)` 直接用传入的 `id` 作为 entry 的 `id`，URL 由 `comboReference([id], rev)` 拼成 `<包名>/client.js`。
- 调用点 `ClientModuleRegistry.reconcilePackage(packageName)`：`const entry = graphRow(packageName, ...)`。`packageName` 来自 `resolveMeta` → `locatePkgJson` → `nearestPackage`，最终取被扫描包 **`package.json` 的 `name` 字段**。
- 浏览器侧 `parseBootManifest`（`dsh-client-modules/lib/client.js`）对 `graph.entries` 逐行只做类型校验，`moduleFields.push({ id: row.id, ... })`、`plugins.push({ id: row.id, ... })`，**原样保留 row.id**，不做前缀变换。
- 结论：本插件的 manifest entry id = `package.json.name` = `dsh-auto-continue`。事故复盘第 18 行的引用正确。

### 2.2 register 如何 key factory — `stripClientSuffix` 只去尾部 `/client`

- `stripClientSuffix(spec)` = `spec.endsWith('/client') ? spec.slice(0,-7) : spec`，仅当**结尾**恰为 `/client` 时截断。
- `ClientModuleSystem.register(registration)`：
  - `ownerId = stripClientSuffix(registration.id)`；
  - 无 `chunk` 时 `id = ownerId`；
  - `this.factories.set(id, { factory, rev })`。
- 旧代码 `load({ id: 'auto-continue' })` → 无 `/client` 尾 → `ownerId = 'auto-continue'` → factory 存在 `factories['auto-continue']`。

### 2.3 loader 如何按 id 找 factory，找不到时的行为

- `reconcile()` 遍历 `manifest.modules`，对每行调用 `this.modules.import(row.id, "", {})`；`import(specifier)` 内 `id = stripClientSuffix(specifier)` = `dsh-auto-continue`。
- `import()` → `arriveGraphRow(row)` → `arrive(row)`：
  - `if (this.loadCache.has(id) || this.factories.has(id)) return;` —— 查的是 `dsh-auto-continue`，而 factories 里只有 `auto-continue`，**不命中**；
  - `attempt(url)` 里 `if (this.factories.has(id)) return "registered"` 同样查 `dsh-auto-continue`，仍不命中 → 判为 `"not-registered"`；
  - 最终 `throw new Error('client-modules: could not load "dsh-auto-continue": ... loaded without registering "dsh-auto-continue" via __ModuleLoader__.load')`。
- 即使走到 `materialize(id)`，`const registered = this.factories.get(id)` 也会因同键缺失而抛 `no registered factory for "dsh-auto-continue"`。
- 该错误经 `recordingImportError` 记入 `importErrors`；该 entry 最终**无 fiber**。

### 2.4 错误如何变成页面级失败（前端证据链）

- `dsh-web-frontend/dist/assets/index-*.js` 的 web boot 审计 `qZ()`：遍历 loader entries，`if (i.fiber === void 0)` 时推送 `` `${n}: import failed ...` ``；`if (r.length > 0) throw new Error('web boot: ... entries did not activate')`。
- 同文件的 boot overlay `render()` 以 `Failed to load plugins` 为标题列出失败项。
- 事故报告的 4 行文案（`Failed to load plugins` / `dsh-auto-continue` / `web boot: 1 entry did not activate` / `dsh-auto-continue: import failed (see console for the import error)`）与上述两处前端字符串逐字吻合。
- **诚实标注一处细节差异（未决，非阻断）**：本次核对的 DSH 版本审计代码在 `importError(n)` 存在时会输出 `import failed: <message>`，仅在其为 `undefined` 时输出事故中的 `(see console...)` 变体。两次取的是不同分支；可能源于事故当时安装的 DSH 版本与本 checkout 的 RC 版本差异。这不影响根因结论——两个分支的**共同前提都是 `fiber === undefined`**，即模块未激活，而这正由 id 不匹配造成。此细节记为"未能完全对上版本"，不作为 finding。

**裁决**：主 agent 的因果链（包名=manifest id → register 按 stripClientSuffix 后的 id 存 factory → loader 按 manifest id 查 → 查不到 → import failed → entry did not activate → 页面起不来）逐层成立。**修正方向正确**：`id: 'dsh-auto-continue'` 使 factory key = manifest entry id，两者对齐。slot cell id `auto-continue-status` 是 `conversation.composer.dock` 列表槽内的 cell key，与模块 id 不同域，保持不变是正确的。

---

## 3. 修正正确性 — 源码层面无同类复发点

对冻结的 `lib/client.js` 做 import-failed 风险扫描，结论：**源码 bundle 自身不会再因注册问题失败**。

| 检查项 | 结论 | 依据 |
| --- | --- | --- |
| `exports.inject = ['slots','connection']` 与实际用法 | 匹配：`apply` 只用 `ctx.slots`、`ctx.connection` | 冻结 client.js 的 `apply`；两者都是真实 client 服务（`dsh-client-connection/lib/client.browser.js` 中 `ctx.provide("connection", handle)`；`slots` 为 shell 常驻服务）。工作插件 ability-strip 用完全相同的 `slots`+`connection` 组合并能工作。 |
| 声明了但服务不存在是否导致 entry 无法激活 | **会，但不构成本次回归**：cordis `Inject.resolve` → `Fiber._refresh`，任一 inject 服务 impl 缺失则 epoch=INACTIVE，fiber 停在 pending（前端审计显示 `pending (waiting for services: ...)`，同样是 did-not-activate 类失败）。此风险对 ability-strip（同样声明 `connection`）完全一样，且本次修改未触及 inject；在已用 profile 中 `connection` 随 DSH 常驻。 | `cordis/lib/index.js` 的 `_checkImpl` / `_refresh`（epoch=INACTIVE 分支）；ability-strip client.js 的同款 inject。记为 MINOR 观察，非回归。 |
| `require('react')` 是否在模块表 | 是。web 前端 `staticModules` 构建函数显式含 `react`（与 `react-dom`、`@deepseek-ai/cordis` 等并列为 seed word），经 `createClientModuleSystem` 注入 `this.seed`。`makeRequire` 首分支 `if (this.seed.has(spec)) return this.seed.get(spec)` 命中。 | `dsh-web-frontend/dist/assets/index-*.js` 的 `function YZ(){return{react:...}}`；`dsh-client-modules/lib/client.js` 的 `makeRequire`、`createClientModuleSystem`。两个工作插件同样 `require("react")`。 |
| factory 内同步执行是否抛错 | 不会。factory 顶层只有 `require('react')`、常量与函数定义，无 `document` 访问、无 host 调用、无副作用；`exports.apply`/`exports.inject` 赋值后 `return module.exports`。materialize 可成功。 | 冻结 client.js 全文静态走读。 |
| slot 注册形态 | 与 ability-strip 一致：`ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({name, id, order, inject: () => ({load})}, Component))`。使用全新 cell id `auto-continue-status`，不与已发布 cell 冲突（全仓搜索仅本文件出现）。 | 冻结 client.js 的 `apply`；ability-strip client.js 的 `apply`；全仓 grep。 |
| `priority` | 未声明。auto-continue 用新 cell id，是 additive，不与占用 `activity`/`usage` cell 的 turn-stats 同场景，不需要 `priority: -1` 抢占。 | 对比 turn-stats client.js 头部说明；slot 文档（新 id 为 additive）。 |

宿主侧同样无启动即抛路径（详见第 5 节）。

---

## 4. 逐项对比表：本次 client.js vs 两个能工作的插件

| 维度 | dsh-auto-continue（冻结源码） | dsh-ability-strip（能工作） | dsh-turn-stats（能工作） | 判定 |
| --- | --- | --- | --- | --- |
| `load({ id })` | `'dsh-auto-continue'`（修复后） | `"dsh-ability-strip"` | `"dsh-turn-stats"` | ✅ 三者均 = 包名 |
| factory 形态 | `factory: (require) => { ... return module.exports }`，lazy-CJS | 同 | 同 | ✅ 一致 |
| `require` 项 | `react` | `react`, `react-dom` | `react` | ✅ 均为 seed word |
| `exports.inject` | `['slots','connection']` | `['slots','remote','remote.skills','remote.pluginInventory','remote.pluginManager','connection']` | `['slots','locale']` | ✅ 子集关系，用法匹配；`connection` 与 ability-strip 同源 |
| 使用 `ctx.slots` / `ctx.connection` | 两者都用 | 两者都用（+remote） | 只用 slots | ✅ 声明与用法一致 |
| slot 名 | `conversation.composer.dock` | `conversation.composer.dock` | `conversation.composer.dock` | ✅ 同一真实列表槽 |
| 注册形态 | `ctx.slots.inject(name, () => ctx.slots.register({name,id,order,inject:()=>({load})}, Comp))` | 同形（id `ability-strip`, order 65） | generator 形（`function*`，两次 register，`priority:-1`） | ✅ 与 ability-strip 同形；与 turn-stats 的差异由"新 id additive" vs "占用既有 cell 需抢占"决定，非缺陷 |
| slot cell id | `auto-continue-status`（全新，无冲突） | `ability-strip`（全新） | `activity` / `usage`（复用已发布 cell，故需 `priority:-1`） | ✅ 策略自洽 |
| `exports.apply` / `exports.inject` | 都导出 | 都导出 | 都导出 | ✅ 一致 |
| 路由调用形态 | `connection.rpc.call('/api', 'auto-continue/status', {}, signal)`；宿主 `fetch.register({path:'/api/auto-continue/status'})` | 同 URL 契约：`call('/api','ability-strip',...)` + 宿主 `path:/api/ability-strip` | 无路由（走 projection/locale） | ✅ 与 ability-strip 同构；`/api` 前导斜杠、`channel/endpoint` 拼接语义在 ability-strip 注释中已逐条核实 |
| 主题 token | 仅 `--dsw-alias-*` | 仅 `--dsw-alias-*` | 仅 `--dsw-alias-*` | ✅ 一致 |
| 未声明 `dsh.client.inject` / `external` / `immediately` | 均无 | 均无 | 均无 | ✅ manifest row 只有 id/url/rev |

**结论**：源码 client.js 与两个工作插件在所有可能导致"页面起不来"的契约维度上对齐；除第 2 节已修复的 load id 外，未发现同源的第二处 id 漂移。

---

## 5. 宿主侧 boot 一致性（index.js / patch / apply）

- `lib/index.js`：`export const name = 'auto-continue'`；`export const inject = ['agents','sessionPersistence']`。
- `cordis.patch.yml`：`- insert: - id: auto-continue, name: 'dsh-auto-continue'`。
- 与两个工作插件的 patch 形态完全一致（ability-strip: id `ability-strip` / name `dsh-ability-strip`；turn-stats: id `turn-stats` / name `dsh-turn-stats`）：**Loader row id 用短名，name 用包名**。`index.js.name` 与 patch 的 `id` 一致。✅
- 服务真实性：`agents`、`sessionPersistence` 均为 DSH 常驻宿主服务（多处 `ctx.get('sessionPersistence')` / `static inject = ['agents', ...]` 佐证）。✅
- `STATUS_PATH = '/api/auto-continue/status'` 与 client 的 `API_CHANNEL='/api'` + `STATUS_ENDPOINT='auto-continue/status'` 拼接结果一致。✅
- `apply(ctx)` 无启动即抛路径：`setTimeout` 延迟 5s 且 `unref()`；scan 整体包在 `try/catch`；`ctx.get?.('connection')` 用可选链并 try/catch；路由注册 try/catch；cleanup 全 best-effort。最坏情况是功能不生效并 warn，不会拖垮 boot。✅

---

## 6. 新静态门禁有效性判定

check.mjs 冻结快照中的断言：

```js
const clientIdMatch = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(clientSource)
check('static: client load id equals package name (incident-001)',
      clientIdMatch !== null && clientIdMatch[1] === pkg.name, ...)
```

**判定：门禁逻辑本身有效（PASS），但保护范围不足（见 F-01）。**

- 可判失败：以事故旧值推演——`clientIdMatch[1] = 'auto-continue'`，`pkg.name = 'dsh-auto-continue'`，条件为 false → `failures += 1` → 末尾 `process.exit(1)`。断言确实会转红，不是注释式装饰。主 agent 声称的"变异测试转红"我按 skill 要求**未运行**验证，但断言逻辑静态可判失败，结论一致。
- 取值来源正确：`clientSource` 读 `lib/client.js`，`pkg` 读同包 `package.json`，正是"两端对齐"的正确比较对象。
- 局限 1（关键，见 F-01）：只校验源码树，不校验 `dist/*.tgz` 内的 bundle。`pnpm check` 通过 ≠ 发布介质正确。
- 局限 2（MINOR，F-02）：正则与代码排版耦合——要求 `load({ id: '...' })` 中 `id` 紧跟 `{`（仅允许空白），且 id 用引号包裹。若将来重排为 `load({ factory: ..., id: ... })` 或改成计算式 id，正则不命中会使 `clientIdMatch === null`，同样判失败（不会误放行）；但若改成注释中含 `load({ id: pkg.name })` 之类动态写法，门禁只覆盖字符串字面量场景。属可维护性提示，不影响当前拦截能力。

---

## 7. Findings

### F-01 — BLOCKER — 修复未重新打包：发布的 0.2.0 tgz 仍含致事故旧 id，重装必然复现

- **位置**：`dsh-auto-continue/dist/dsh-auto-continue-0.2.0.tgz` 内 `package/lib/client.js`（`window.__ModuleLoader__.load({ id: 'auto-continue', ... })`）；对照冻结源码 `dsh-auto-continue/lib/client.js` 的 `id: 'dsh-auto-continue'`。
- **事实与依据**：
  - 解包 0.2.0.tgz 实测：`package/lib/client.js` SHA-256 = `B09D79CF5CA37AEA8A24BEC87EBD8851E56B9EFA64E51F7B7A96B5B88B0926FC`，与冻结源码哈希 `166297AB...E49B2` **不同**；tgz 内首条 id 为 `'auto-continue'`，第二条为 slot cell id `'auto-continue-status'`。
  - tgz 内 `package/scripts/check.mjs` SHA-256 = `23FEDF91...C5792`，与冻结源码 `2BE9A872...B40D` **不同**；对 tgz 内 check.mjs 搜索 `client load id equals package name` / `incident-001` / `clientIdMatch` **无任何命中** —— 门禁也没进包。
  - tgz 内 `package.json` version 仍为 `0.2.0`（与事故版本同号）。
  - `INSTALL.md` §0/§1/§11.3 规定：本仓库**只能从 tarball 安装**（`dsh plugin --profile web add ./dist/<包>-<版本>.tgz`），目录/`link:` 安装明令禁止；tarball 是不可变产物、每版一文件、发布后不得覆盖；"改源码不会改安装副本，保存源码本身永远不构成上线"。
  - `scripts/check-all.mjs` 只对各插件**源码**跑 `check`，auto-continue 也没有 `verify-pack` 脚本；门禁链条中没有任何一环校验 tgz 内容。
- **推演链**：用户按仓库规约从 `dist/dsh-auto-continue-0.2.0.tgz` 重装 → 安装副本 client.js 的 id 仍为 `auto-continue` → factory 注册到 `factories['auto-continue']` → manifest entry id `dsh-auto-continue` 查不到 factory → import failed → fiber 缺失 → `web boot: 1 entry did not activate` → 页面再次起不来。`pnpm check` 全绿也不会报警，因为门禁只看源码。
- **影响**：本次事故的直接同类复发，"看清楚不要再翻车"的核心诉求未满足；且用户若相信"源码已修"而重装，会造成二次事故与二次回滚。
- **建议修复（供主 agent 执行，本评审不实施）**：
  1. 递增版本号（如 `0.2.1`）——不可覆盖不可变的 `0.2.0.tgz`；
  2. 从修正后的源码重新 `pnpm pack`，生成新 tgz；
  3. 解包新 tgz 逐字节核对 `package/lib/client.js` 的 `id: 'dsh-auto-continue'` 与 `package/scripts/check.mjs` 含 incident-001 门禁；
  4. 从新 tgz 重装并真实刷新页面确认"Failed to load plugins"消失；
  5. 补一条校验发布介质的门禁（至少：从 tgz 解出的 client.js id 必须等于 package.json name），否则源码门禁给了虚假安全感。
- **状态**：**阻断交付**。此项不解决，不能判定可安全重装。

### F-02 — MINOR — 门禁只覆盖字符串字面量，排版耦合

- **位置**：`dsh-auto-continue/scripts/check.mjs` 的 incident-001 断言正则。
- **依据**：正则要求 `load({` 后紧跟 `id:` 且 id 为引号内字面量。当前冻结代码满足，转红能力已确认；但它是"文本形态"门禁，不是语义门禁——id 若改为表达式/变量（如复用包名常量）会不再命中。
- **影响**：不影响当前拦截，属后续演进时的漏防风险。
- **建议**：日后可改为从 client.js 中解析 load 调用的 id 表达式并求值/静态解析，而非纯正则；当前不必为此打回。

### F-03 — MINOR（未能证实为回归）— `connection` inject 在缺失该服务的 profile 上会让 entry 停在 pending

- **位置**：冻结 client.js 的 `const inject = ['slots','connection']`。
- **依据**：cordis `Fiber._refresh` 在任一 inject 服务 impl 缺失时置 epoch=INACTIVE，fiber 不激活；web boot 审计把 pending 也列为 did-not-activate。但 `connection` 由 DSH 常驻 client-connection 插件提供，且能工作的 ability-strip 声明了同样的 `connection`，在既有 profile 中均已激活。
- **影响**：仅在极端裁剪 profile（无 connection 插件）下出现，属"功能不生效"而非本次注册的 import-failed 同类问题；本次修改未触及 inject。
- **状态**：不构成 payment blocker，记录供部署侧知悉。

---

## 8. 交付判定汇总

| 评审维度 | 判定 |
| --- | --- |
| 根因是否成立 | ✅ 成立（源码逐层确认，见 §2） |
| 源码修正是否正确且充分 | ✅ 是（见 §3、§4、§5） |
| 新静态门禁逻辑 | ✅ 可判失败（见 §6）；但保护范围有缺口（F-01） |
| 同类隐患全面排查 | ✅ 未发现第二处 id 漂移或其他 import-failed 触发点（见 §4） |
| 发布介质是否安全 | ❌ 否（F-01） |
| 总体结论 | **打回 / NOT_READY / FAIL（1 BLOCKER）** |
| 可否安全重装 | **否**——须先按 F-01 重新打包新版本、校验 tgz 内容并实测后再重装 |

> 本评审未运行被审代码、未运行测试、未安装、未提交；唯一写入文件为本评审文档。所有结论均来自静态源码/配置/产物走读与哈希实测。
