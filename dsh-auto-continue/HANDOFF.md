# HANDOFF — dsh-auto-continue v0.2

交接档案。面向接手者，不是用户手册（用户手册见 [README.md](README.md)）。
规格与定稿设计见仓库内 `docs/auto-continue/requirement.md` 与 `docs/auto-continue/design-final.md`。

## 状态快照

已按冻结规格与定稿设计实现 v0.2，覆盖旧同名文件（`lib/detect.js`、`lib/index.js`、`package.json`、`cordis.patch.yml`、`scripts/check.mjs`、`README.md`）；新增 `lib/frames.js`、`lib/boot.js`、`lib/client.js`。旧 `dist/dsh-auto-continue-0.1.0.tgz` 未改动。

- `pnpm check`：RESULT: PASS（59 条断言）。
- `node --check`：lib/*.js + check.mjs 全部通过。
- 形态：Host + 浏览器双半边；运行时零第三方依赖（lib 仅 `node:*`，client 仅 React）。
- 未安装、未提交 git、未改规格/设计文档、未写 `$DSH_HOME` 下任何文件。

## 模块与职责

| 文件 | 职责 |
|---|---|
| `lib/frames.js` | 纯函数：`scanZstdFrames`（移植 DSH block-header 遍历定位帧边界，不依赖 content size）、`decodeTailFrames`（尾部窗口跳过残缺首帧，逐帧独立 `zstdDecompressSync`，产出 `{type,seq,time,data}`） |
| `lib/detect.js` | 纯函数：`lastTurnBoundary` / `canContinue` / `rankRecent` |
| `lib/boot.js` | `runBoot(ctx, deps)`：`list`→pending 跳过→stat+mtime 排序取 N(10)→live 跳过→尾部 64KB→detect→二次 live 检查→`resume`+持有 handle+`followup`；单例失败 try/catch 隔离；返回 `{candidates,resumed,skipped}` 仅内存 |
| `lib/index.js` | 入口：`name`/`inject`(`agents`,`sessionPersistence`)/`apply`；5s `unref` 定时一次 `runBoot`；disposer 清 timer + 对 handle `dispose()`；owner-only 只读路由 `POST /api/auto-continue/status`；`continuationMessage()` 好心提示；无开关、无 config |
| `lib/client.js` | lazy-CJS 只读状态 chip（续 X / 跳 Y + 简表），只 require React、只用 `--dsw-alias-*` token，无切换控件 |

## 决策记录

1. **路由路径/方法**：设计写 `path:'/auto-continue/status'`、任务最初写 GET。核实 DSH `dsh-client-connection/lib/index.js` 的 `assertFetchRoute`（要求 `/api` 前缀）与范本 `dsh-ability-strip/lib/index.js` 的 POST + rpc envelope，最终采用 `POST /api/auto-continue/status` + Connection 的 `{type:'client-request',rpcId,...}` / `{type:'server-response',rpcId,result}` envelope。两半端点一致，owner-only 由载体保证（非 owner 403）。此为对规格字面路径的**偏离**，已交主 agent 裁定（见"已知非阻塞风险"）。
2. **connection 取法**：`inject` 冻结为 `['agents','sessionPersistence']`（任务硬约束），故宿主路由用 `ctx.get('connection')` 而非直接 `ctx.connection`（Cordis 官方口径：未声明的服务用 `ctx.get`，避免属性代理的拓扑敏感问题）。路由是可选展示，无 Connection 的 profile 自动降级为无 UI。
3. **后置归属校验**：`ctx.agents.get(id)` 返回已注册 agent（dsh-agent 源码 `get`），`resume` 返回的 `handle.agent` 是同一对象；`runBoot` 用它做二次检查，防扫描期间被别人 resume。
4. **frames 魔数扫描方向**：早期版本从后往前尝试 magic，导致只解出最后一帧；已修正为从窗口最早 magic 开始，取第一个能完整扫到 EOF 的候选，从而跳过残缺首帧并保留所有完整帧。check 中已覆盖该路径。
5. **零依赖**：无 `dependencies`/`peerDependencies`；lib 与 client 均不引用任何 Harness 包。
6. **code-001 评审返工**：F-01 BLOCKER（续跑消息缺 `id`）已修；F-02（测试用真实 `continuationMessage()`）、F-03（candidates 内容断言替代恒真断言）、F-04（`defaultReadTail` 真实临时文件字节上界断言）一并闭环。

## 已知非阻塞风险

1. **规格字面路径偏离**：设计 §5 写 `/auto-continue/status`，实现为 `/api/auto-continue/status`（DSH Connection 强制 `/api` 前缀）。功能等价且是唯一可工作形态；若主 agent 坚持以字面路径注册，需改用 `ctx.webServer.register`（但那会失去 owner-only 语义），不推荐。
2. **续跑消息 id（F-01 修复）**：`followup` 传入的消息必须自带非空字符串 `id`，否则 `session.append("user/message")` 落盘后下次冷读 `assertMessageEventShape` 判损坏、会话永久不可读。`continuationMessage()` 用 `node:crypto.randomUUID()` 生成 id（DSH `createMessage` 注入的 `brandString(randomUUID())` 运行时即恒等 UUID，无需 Harness 包）。check 用真实 `continuationMessage()` 断言 id/role/source/content 与深冻结。真机恢复效果未端到端验证。
3. **尾部窗口边界**：64KB 窗口内至少需容纳最后一个完整 zstd 帧；极端超大单事件帧（>64KB）可能整帧落在窗口外而被跳过。设计已接受 64KB 默认，未做动态扩窗。
4. **多机路径可移植性**：文档、脚本均无本机绝对路径；测试用合成 zstd，不依赖 `$DSH_HOME/sessions`。

## 验收清单

- [x] 实现文件全部覆盖/新增，旧 dist/*.tgz 未动
- [x] `pnpm check` PASS（逐项输出见主 agent 交付消息）
- [x] `node --check` 全部通过
- [x] 源码静态：无写文件调用、无 Harness 包引用、无开关
- [x] 提示词语义断言（系统自动注入 / 仅供参考 / 完全由你决定 / 不要重复执行 / 核实外部状态 / 不盲目重试）
- [x] F-01 消息 id 与持久化形状断言；F-02 真实消息注入；F-03 非空断言；F-04 真实文件字节上界断言
- [x] SHA-256 已计算（见交付消息）
- [x] 未安装、未提交、未改规格/设计文档、未写 `$DSH_HOME`
- [ ] 真机端到端（未验证，见上）
