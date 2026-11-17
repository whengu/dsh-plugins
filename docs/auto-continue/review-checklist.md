# 代码评审核查清单 — dsh-auto-continue v0.2

用途：给代码评审者（或主 agent 替代自查）的**稳定判据**。按新全局规则，只写"怎么查/怎么判"，不写行号与当前快照值。评审时所有行号现场 grep 现取。

## 规格一致性

- 代码服从 `requirement.md` 与 `design-final.md`；冲突默认怀疑代码。
- 需求要点：崩溃后下次启动自动续跑 web 会话；插件不写文件、不持状态、不碰日志内容；最近 N + 尾部读；live 跳过；提示词是"好心提示交回模型判断"；**无独立开关**（禁用插件即关闭）；UI 只读展示。

## 逐项判据与查法

### C1 不写文件 / 不持状态

- 查：`lib/` 与 `client/` 源码 grep `writeFile|appendFile|mkdir|createWriteStream|state|lastBoot`。
- 判：出现任何写文件 API 即 BLOCKER；出现持久化状态文档即 BLOCKER。
- 原理：无状态是本版架构核心，所有崩溃一致性复杂度都靠它消除。

### C2 无宿主包 import

- 查：grep `@deepseek-ai/` in `lib/` 与 `client/`。
- 判：出现即 BLOCKER（profile 的 node_modules 实测解析不到 dsh-session/dsh-llm 等）。
- 服务一律经 `ctx`（`agents`、`sessionPersistence`、`connection`）。

### C3 帧定位正确性

- 查：`lib/frames.js` 的定位逻辑，对照 DSH `dsh-session-persistence-jsonl` 包里 `scanZstdFrames` 的实现（现场 grep 函数名）。
- 判：
  - 若用"frame content size"定位 → BLOCKER（zstd 帧不保证携带该字段）。
  - 若用裸 magic 简单切分且不处理残缺首帧 → MAJOR。
  - 正确：解析 frame descriptor → 循环 block header（lastBlock 位+blockType+blockSize）→ 帧 [start,end)；跳过窗口开头残缺帧；每帧独立 `zstdDecompressSync`。
- 自检证据：合成多帧 zstd（每帧一个事件）跑通；本机真实 artifact 尾部 84 帧全解（实测结论，评审可抽查）。

### C4 边界判定

- 查：`detect.js` 的 `lastTurnBoundary` / `canContinue`。
- 判：最后边界是 `turn/start` → true；`turn/end` 或 null → false。
- 原理：`turn/end` 在 agent-loop 的 turn finally 里无条件写，正常结束必留 turn/end；只剩 turn/start 唯一原因是进程死亡。
- 自检证据：合成事件序列三种情形各有断言。

### C5 发现流程顺序

- 查：`boot.js` 顺序必须是 list → 取 location.path → stat mtime → rankRecent(N) → 逐候选。
- 判：
  - 先看 `ctx.agents.get(id)`（live 跳过）→ 必须在读尾部之前，且 resume 前二次检查（防扫描期间变 live）。
  - 无 location 的 pending 快照跳过（未落盘无可续）。
  - 单次尾部读字节数有上界（WINDOW），只处理 ≤ N 个。
- 自检证据：stub ctx 计数断言读尾部次数 ≤ N、live 的 id 不被 resume。

### C6 resume + followup 语义

- 查：`ctx.agents.resume({resumeSessionId:id})` 返回 handle；`handle.agent.followup(message)`。
- 判：
  - 两步缺一不可（resume 后 agent 是 live+idle+inbox 空，不 followup 什么都不发生）。
  - 插件不得自己 append 任何日志事件（不调 session.append / 不补 closers）——那是 DSH resume 内部。
  - handle 被持有、在插件卸载 disposer 里 dispose（dsh-agent README 的官方形态；factory 的 ownership.dispose 是结构性兜底，memoized 同一 teardown，二者不冲突）。
  - 单会话失败 try/catch 隔离，记 skipped，不中断扫描。

### C7 提示词

- 查：`continuationMessage` 的正文与 source。
- 判：正文含"系统自动注入/仅供参考/由你决定/不要重复执行/先核实外部状态"语义；是 user-role 消息；`source.kind` 非空字符串（自定义 kind 合法，运行期只要求非空）。
- 反例：写成"命令模型继续""你必须继续"即 MAJOR（违背"交回模型判断"）。

### C8 UI 路由与客户端

- 查：宿主 `ctx.connection.fetch.register` 与客户端 `rpc.call`/fetch 的**方法与 envelope 两端一致**。
- 判：owner-only 由载体硬保证（非 owner 403）；UI 只读展示，无开关控件；客户端 lazy-CJS、自带控件、只用 `--dsw-alias-*`，不 require `@deepseek-ai/*`。
- 自检证据：宿主返回 envelope 与客户端解析一致（范本 ability-strip 有可复制的两端实现）。

### C9 开关语义

- 查：无 `config.enabled`、无切换控件。
- 判：出现独立开关即 MAJOR（用户裁定：禁用插件即关闭）。

### C10 验证脚本

- 查：`pnpm check` 实际跑、退出码 0、断言覆盖 C1-C9 关键点。
- 判：只有语法检查不算验证；必须有 stub 集成断言 + 合成帧 fixture + 静态禁写断言。
- fixture 不得依赖本机绝对路径（用合成 zstd 帧）。

## 验证者纪律

- 评审者不跑被审查代码；验证者（主 agent）跑 `pnpm check` 并报告真实命令/退出码/输出尾部。
- 评审 PASS ≠ 验证通过；两者独立。
- 发现缺陷按"作者失败"归因；同类问题反复出现换做法，不缝补。
