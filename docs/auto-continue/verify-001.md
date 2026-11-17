# verify-001 — dsh-auto-continue v0.2

工作目录：`D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\`（分命令注明）

## 命令与真实结果

### 1. 单文件语法检查
- 命令：`node --check <每个 lib/*.js 与 scripts/check.mjs>`
- 工作目录：`...\dsh-plugins\dsh-auto-continue`
- 结果：boot.js / client.js / detect.js / frames.js / index.js / check.mjs 全部 OK

### 2. 插件自检
- 命令：`pnpm check`
- 工作目录：`...\dsh-plugins\dsh-auto-continue`
- 退出码：0
- 输出尾部：`RESULT: PASS`（60 条断言全绿，覆盖 A1–A9 + 静态禁写/禁 Harness 引用/无开关 + 提示词语义 + 失败隔离 + torn 尾帧容忍 + 残缺首帧跳过）

### 3. 独立复核哈希（主 agent 复算 vs 实现者自报）
- 全部 7 个关键文件 SHA-256 与实现者自报**逐字一致**（frames/detect/boot/index/client/package.json/check.mjs）

### 4. 变异测试（证明检查有牙）
对临时副本注入 4 个缺陷后跑 check，全部转红，恢复后转绿：
| 变异 | 结果 |
|---|---|
| 帧定位改用固定 content-size（错误法） | RED（17 红行） |
| 提示词改成命令式 | RED（1 红行） |
| live 检查删除 | RED（6 红行） |
| 边界常量反转（turn/start↔turn/end） | RED（11 红行） |

### 4b. F-01 修复后的补充验证（复审 PASS 之后）

- 首轮代码评审打回 1 BLOCKER：`continuationMessage()` 缺 `id`，消息经 `followup → session.append("user/message")` 落盘后冷读会因 id 为空判损坏。返工补 `id: randomUUID()`（`node:crypto`，与 DSH `createMessage` 的 `brandString(randomUUID())` 同构，brandString 运行时恒等）。
- 变异测试：临时副本去掉 `id: randomUUID()` → `pnpm check` **RED**（3 条 F-01 断言转红：boot 每条消息带 id / 消息 id 非空 / 两次调用 id 不同），恢复后 GREEN。证明新门禁真能抓住此 bug。
- 独立复审 `reviews/code-002.md` 判 **PASS / 零 finding**（4/4 闭环，无新硬伤）；评审者只写了该 review 文件，冻结输入哈希未变。

### 5. 仓库级闸门
- 命令：`node scripts/check-all.mjs --quiet`
- 工作目录：`...\dsh-plugins`
- 退出码：0
- 结果：6/6 PASS（含 README 索引源码列与已装列实测一致）
- 注：首次在 `workspace-write` 沙箱下跑时，4 个插件因 `spawnSync git EPERM` 失败；全权限重跑后全绿。根因已单独查证（见下）：**沙箱禁止的是 node 派生子进程（process spawn），不是 git 仓库的文件访问**。实测：直接读 `.git` 正常、PowerShell 直接跑 `git rev-parse --show-prefix` 正常（返回 `dsh-ability-strip/`），但 node 的 `execFileSync("git", ...)`（`check-equivalence.mjs:289`）报 `EPERM: spawnSync git`。与 git 仓库是否在允许目录无关。

## 结论

验证通过：语法、单插件自检（FIX 后 68 断言）、哈希一致性、5 项变异敏感性（含 F-01）、仓库全量闸门（6/6）全部真实执行且通过；独立代码评审首轮打回的 1 BLOCKER 已修复并经复审 PASS。

## 未验证（如实）

- **真机端到端**：未安装（用户未授权），未在真实 Host 崩溃/重启场景下验证 resume+followup 的实际效果、owner-only 路由在浏览器中的渲染。这是有意保留的验证缺口，不能声称"完全验证"。
- **浏览器行为**：本仓库纪律不做浏览器黑盒测试，UI 仅静态检查（lazy-CJS 注册、token、无开关）。
