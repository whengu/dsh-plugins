# design-final — dsh-auto-continue v0.2（最终收敛设计）

对应规格：`requirement.md`（SHA `6CA0727C…BE4B29`）
日期：2026-11-17
状态：待独立设计评审

## 0. 一句话

启动时对最近 N 个会话各读**尾部若干 zstd 帧**，找出最后一个 turn 边界是 `turn/start` 的（= 崩溃遗留），用 `ctx.agents.resume` + `agent.followup` 交回 DSH 续跑；插件**不写任何文件、不持状态、不碰日志内容**。

## 1. 模块

| 模块 | 职责 | 纯/副作用 |
|---|---|---|
| `lib/detect.js` | 从一帧帧解压出的 JSON 事件里找最后一个 turn 边界；后缀判定 | 纯 |
| `lib/frames.js` | 从 Buffer 尾部定位 zstd 帧边界，逐帧解压成事件行 | 纯（输入 Buffer，输出事件） |
| `lib/boot.js` | 编排：`list()` → mtime 排序取 N → 过滤 live → 尾部读 → 判定 → resume+followup | 副作用 |
| `lib/index.js` | `apply(ctx, config)`：开关、启动调度、handle 生命周期、卸载 | 副作用 |
| `lib/client.js` | lazy-CJS UI：一个开关 + 上次扫描结果展示（可选，见 §6） | 客户端 |
| `lib/route.js` | owner-only 只读路由，UI 读开关/状态 | 副作用 |

不引入 `state.js` / `store.js` / `ledger.js` / 账本 / 自研持久化——v0.2 R2 稿的这些模块全部废弃。

## 2. 发现算法（核心，已实测）

### 2.1 拿会话列表

```
const snapshots = await ctx.sessionPersistence.list()   // 每个含 header.id + location.path
```

实测：本机 646 个 artifact，`list()` + 各路径 `stat` 取 mtime + 排序 ≈ 34ms。

### 2.2 挑最近 N 个

```
entries = snapshots.map(s => ({ id: s.header.id, path: s.location?.path, mtime: stat(path).mtimeMs }))
         .filter(e => e.path && isFinite(e.mtime))
recent = entries.sort((a,b) => b.mtime - a.mtime).slice(0, N)   // N 默认 10

// 注：list() 快照中 pending/未实体化会话没有 location（jsonl 后端 :2638-2647），
// 被 filter 跳过。这类会话尚未落盘，本就无可续内容，跳过是正确行为，不是漏判。
```

**不写 lastBoot 时间戳文件**（用户裁定）：崩溃会话必然是崩溃瞬间最后被写的，mtime 排最前，取最近 N 个足够。

### 2.3 过滤 live（防误判正在跑的会话）

```
for (const e of recent) {
  if (ctx.agents.get(e.id)) continue    // 还活着，绝不碰（dsh-agent:725-726）
  ...
}
```

这一行替代了 R2 稿里全部"mtime 极近"启发式。重复续的真危害只在"扫时会话正好 live"，`agents.get` 直接挡住。

### 2.4 尾部读（常数代价）

对每个候选：

```
fd = await open(e.path, 'r')
read 末尾 WINDOW 字节（默认 64KB）
frames = scanFrames(tailBuffer)              // 移植 DSH scanZstdFrames：解析 block header 定位帧边界
for frame in frames.reverse():               // 从尾往前
    events.push(...parseLines(zstdDecompressSync(frame)))
    if 找到 turn/start 或 turn/end: break
close(fd)
```

**实测（本机真实 artifact，临时探针验证）**：
- 21MB 活动会话：4.9ms 找到 `turn/start seq=27759`
- 300KB 旧会话：1.6–2.0ms 找到 `turn/end reason=completed`
- 84 个尾部帧**逐个独立解压全部成功**，一帧一个完整 JSON 事件
- 代价与日志总体积无关

**帧定位可靠性**（关键教训，写进实现约束）：
- ❌ 不可用"找第一个 magic → 整体解压到 EOF"——实测只能解出 1–2 事件（帧边界凑不齐，probe3 证伪）
- ❌ 不可假设帧头带 content size——zstd 帧不保证携带该字段（`contentSizeBytes` 在无 content size 且非 single-segment 时为 0，`dsh-session-persistence-jsonl:1328`）
- ✅ 正确做法：**移植 DSH `scanZstdFrames` 的 block-header 遍历法**（`dsh-session-persistence-jsonl/lib/index.js:1305-1367`）：从 magic 起，读 1 字节 frame descriptor（算出 header 剩余长度），再循环读 3 字节 block header（lastBlock 位 + blockType + blockSize）跳到 lastBlock，得出帧的 [start,end)，逐帧 `zstdDecompressSync`。实测 84/84 帧独立解压成功、一帧一个 JSON 事件。
- **尾部窗口边界陷阱**：窗口起点常落在某帧中间。必须**向前跳过窗口开头残缺的第一帧**，从第一个完整 magic 开始扫描（magic 可能出现在任意字节，但只有 magic 对齐的帧才能独立解压）。probe2 因逐 magic 切分恰好避开了这点；正式实现要显式处理。
- 佐证：DSH 后端用 `scanZstdFrames()` + `maxFrames` 做同样的 metadata-only 读者；该函数未导出，插件实现精简移植版。

### 2.5 判定

```
lastBoundary = 倒序找最后一个 turn/start | turn/end
if lastBoundary is turn/start → CANDIDATE（崩溃遗留）→ 续
else（turn/end / 无边界）→ 跳过
```

## 3. 续跑（DSH 全权）

```
for (const id of candidates) {
  if (ctx.agents.get(id)) continue            // 双重检查：扫描期间可能变 live
  const handle = await ctx.agents.resume({ resumeSessionId: id })
  handles.add(handle)                          // 持有，卸载时 dispose（官方形态 dsh-agent:32）
  const agent = handle.agent
  if (ctx.agents.get(id) !== agent) continue   // 归属校验
  agent.followup(continuationMessage())  // 排一条建议消息唤醒一轮（消息须带 id，见下）
}
```

- DSH resume 内部：读日志、补 `interruptedTurnClosers`、拿写所有权、重建 agent。**插件不碰任何一项。**
- 插件只调两个入口：`ctx.agents.resume` + `agent.followup`。
- handle 由插件持有，`apply` 的 disposer 里 `handle.dispose()`（`dsh-agent/README.zh.md:32,40`；`dsh-acp/lib/index.js:640` 佐证）。
- **消息必须有 id**：`continuationMessage()` 注入 `id: randomUUID()`（`node:crypto`）。followup 会把消息以 `user/message` 事件落盘，冷读强制校验非空 id；缺 id 会让会话永久损坏（首轮评审 F-01，已修复并经复审 PASS）。
- 关态语义：插件未加载即无扫描动作；无 `config.enabled` 内部判断。

## 4. 提示词（用户明确要求：好心提示，非命令）

```
[系统自动提示 · 仅供参考]
这是系统在检测到上次进程异常退出后，自动注入的一条提示，不是用户的真实指令。
请自行判断：当前任务是否仍应继续推进。
- 若你判断任务尚未完成，可以从当前工作区与会话历史出发继续；
- 若你判断任务已经完成，或继续会有风险，请直接结束，不要重复执行任何步骤；
- 对于上次中断时结果不明的工具调用（可能有副作用），请先核实外部状态，不要盲目重试。
是否继续、如何继续，完全由你决定。
```

`source.kind = 'auto-continue'`（自定义 kind，运行期只要求非空字符串，已核 `dsh-session/lib/index.js:1204-1216`）。

## 5. 开关与 UI（2026-11-17 用户裁定）

- **无独立开关**：插件加载即生效。要关闭就禁用插件本身（`plugin_manager.set_plugin` 或从 profile 移除）——用户明确说"不用另外加开关"。因此没有 `config.enabled`、没有开关写入、没有切换路由。
- **UI 只读展示**：宿主开一条 owner-only 只读路由（`ctx.connection.fetch.register`，owner 校验由载体硬保证，非 owner 403 — `dsh-client-connection/lib/index.js:830`），路径为 `/api/auto-continue/status`（`assertFetchRoute`/`endpointFromPath` 强制 `/api/` 前缀；初稿写的可选路径字面值不成立，已按实现的正确形态订正），走 Connection 的 `client-request`/`server-response` rpc envelope，客户端以 `rpc.call('/api','auto-continue/status')` 读取。暴露 `{lastScan:{candidates:[...], resumed:[...]}, version}`，客户端一个只读状态展示（上次扫描续了谁、跳过了谁）。**无切换控件、无整页仪表盘、无报表持久化**。
- 关态语义由"插件未加载"保证：不加载就没有扫描动作，无需插件内部判断。

## 6. 验证计划

- `lib/detect.js`：纯函数，边界判定（open/closed/none）、尾帧解析、排序取 N、live 过滤逻辑可注入测试。
- `lib/frames.js`：用真实 artifact（复制一份到测试夹具）断言帧定位 + 解压 + 事件提取；断言 84 帧全解、边界找对。
- 集成：`runBoot` 对 stub ctx（list/stat/open/resume/followup 计数）断言 A1–A9。
- 静态断言：源码无 `writeFile`/`appendFile`、`sessionPersistence` 只出现 `list`。
- 性能断言：单次扫描对 ≤10 个会话，尾部读字节 ≤ 10×64KB。

## 7. 约束遵守

- T1：`lib/` 只 import `node:*` 与本地模块，无 `@deepseek-ai/*`。
- T2：客户端 lazy-CJS、自带控件、`--dsw-alias-*` token。
- T3：逐帧独立解压（§2.4 实证）。
- T4：只从 tarball 安装，**安装需用户单独授权**。
- T5：单进程，无锁。

## 8. 自检清单

| # | 结论 | 依据 |
|---|---|---|
| S1 尾部读可行 | 成立 | 实测：21MB/4.9ms、300KB/1.6-2ms、84 帧全解 |
| S2 live 判据 | 成立 | `ctx.agents.get(id)` dsh-agent:725-726 |
| S3 resume+followup 两步 | 成立 | `followup`→`wakeDriver` 同步开轮，inbox 空不自起（agent-loop:570/618/827） |
| S4 handle 持有正确 | 成立 | dsh-agent README:32,40；dsh-acp:640 |
| S5 DSH 负责修复日志 | 成立 | agent-loop:1739-1740 `interruptedTurnClosers` |
| S6 提示词来源合法 | 成立 | dsh-session:1204-1216 只要求非空 kind |
| S7 重复续危害可控 | 成立 | 见 requirement 及 self-reflection §8；agents.get 挡 live |
| S8 不写文件 | 设计保证 | 模块表无 store/state，静态断言 |
| S9 边界判据无反例 | 成立 | `turn/end` 在 finally 无条件写（agent-loop:817-826），正常结束必留 turn/end |
| S10 帧定位可靠 | 成立 | 移植 scanZstdFrames block-header 遍历（jsonl:1305-1367）；无 content size 也能定位；84/84 帧独立解压 |
| S11 无 location 会话 | 正确处理 | pending 快照无 location（jsonl:2638-2647），被 filter 跳过；未落盘无可续内容 |
| S12 web 会话 ID 空间 | 成立 | web resume 走 `ctx.agents.resume({resumeSessionId})`（session-controller:312-316），与方案同一空间 |
| S13 handle dispose 不冲突 | 成立 | teardown 用 `disposing ??=` memoized（agent-loop:1475），factory 与调用方收敛同一 teardown |
| S14 无独立开关 | 用户裁定 | 插件加载即生效，禁用插件=关闭；无 config.enabled |
