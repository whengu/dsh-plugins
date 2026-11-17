# dsh-auto-continue v0.2

Host + 浏览器双半边插件：**Host 异常崩溃后，下次启动自动续跑崩溃的那个会话**。无状态、不写文件、无独立开关。

规格与定稿设计见仓库内 `docs/auto-continue/requirement.md` 与 `docs/auto-continue/design-final.md`（本插件严格按其实现；如需改动规格，请先取得裁定）。

## 机制

1. **发现（启动后一次）**：`sessionPersistence.list()` 取每个快照的 `header.id` + `location.path`；无 location（pending、尚未落盘）的跳过。每个 path `stat` 取 mtime，按 mtime 降序取最近 **N=10** 个。
2. **尾部读**：对每个候选，只读 artifact **尾部 64KB**（`fs.open` + 从 `size - WINDOW` 起读，恒定字节上界）。用移植 DSH `scanZstdFrames` 的 block-header 遍历法定位完整 zstd 帧，逐帧 `zstdDecompressSync` 后按行解析出 `{type, seq, time, data}` 事件；窗口起点落在帧中间时跳过残缺首帧。不依赖 content size。
3. **判定**：倒序找最后一个 `turn/start` | `turn/end` 边界；最后是 `turn/start` → 崩溃遗留，需要续；`turn/end` 或无边界 → 跳过。`ctx.agents.get(id)` 非空的 live 会话直接跳过（扫描期间变 live 的还会二次检查）。
4. **续跑**：`ctx.agents.resume({resumeSessionId:id})` 恢复（DSH 负责补 closers、拿写所有权、修复日志，插件不碰）；持有 handle → `handle.agent.followup(continuationMessage())` 排一条 user 提示唤醒一轮。每个会话的读/解析/resume 用 try/catch 隔离，失败记入 skipped，不中断整次扫描。
5. **生命周期**：apply 的 `ctx.effect` 里 5s 后 `unref` 跑一次 `runBoot`；disposer 清 timer 并对所有持有 handle 调 `dispose()`。

**提示词是"好心提示"，不是命令**：正文声明"系统自动注入、仅供参考、完全由你决定、不要重复执行"，并保留"结果不明的副作用工具先核实、不盲目重试"语义。是否继续完全交回模型判断。

**无独立开关**：插件加载即生效；要关闭就用 DSH 现有的插件禁用机制（`plugin_manager.set_plugin` 或从 profile 移除）。UI 只读展示，不提供切换控件。

**不写任何文件**：没有账本、没有 lastBoot、没有配置写入；扫描结果只在内存里供只读状态路由展示。不 append、不修改任何会话日志。

## UI

浏览器半边在 composer 下方挂一个只读状态 chip：`上次扫描：续了 X、跳过 Y`，点开一个简单列表（续了谁、跳过了谁及原因）。宿主侧 owner-only 只读路由 `POST /api/auto-continue/status`（Connection 载体保证非 owner 403），返回 `{lastScan, version}`。宿主/客户端均用 Connection 的 `{type:'client-request',rpcId,...}` / `{type:'server-response',rpcId,result}` rpc envelope，与仓库范本 `dsh-ability-strip` 一致。

## 验证状态

- `pnpm check`（= `node scripts/check.mjs`）：**RESULT: PASS**（59 条断言，见下方各层）。
- `node --check` 全部 lib/*.js + check.mjs：通过。
- 覆盖：合成多帧 zstd 的逐帧解压 / 边界定位 / 窗口残缺首帧跳过 / 无 content-size 帧；detect 的 start→续、end/无边界→跳、rankRecent 取 N；boot 对 stub ctx 断言只读尾部上界（A2）、≤N 个（A3）、live 跳过（A4）、resume+followup（A6）、handle dispose（A9）、失败隔离；静态断言源码无写文件调用、无 Harness 包引用、无开关；提示词语义子串。
- **未验证：真机端到端**（未在真实 Host 启动/崩溃场景验证 `resume` 的恢复效果与路由在浏览器中的实际渲染；本机不做浏览器自动化测试）。

## 安装

装配纪律（只从 tarball 安装、`dist/` 不可覆盖）见仓库根 [INSTALL.md](../INSTALL.md)。以下命令只作说明，**未实际执行安装**：

```powershell
cd dsh-plugins/dsh-auto-continue
pnpm check
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/dsh-auto-continue-0.2.0.tgz
```

双半边插件：新增 bundle 可经 HMR 激活，浏览器 `Ctrl+F5` 硬刷新；若替换已装旧版本（宿主 JS 变化），按 INSTALL.md §15.1 需重启 Host。

卸载：

```powershell
dsh plugin --profile web remove dsh-auto-continue
```
