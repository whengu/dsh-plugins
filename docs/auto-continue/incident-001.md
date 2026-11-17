# 事故复盘 — client id 与包名不一致导致页面加载失败

## 事故

装了 dsh-auto-continue 0.2.0 后，web 页面无法加载：
```
Failed to load plugins
dsh-auto-continue
web boot: 1 entry did not activate
dsh-auto-continue: import failed (see console for the import error)
```
用户卸载后恢复。这是**我引入的严重事故**：插件不是"不生效"，而是让整个页面起不来。

## 根因（已用源码坐实）

`lib/client.js` 的 `window.__ModuleLoader__.load({ id })` 里，id 写成了 `'auto-continue'`，但：

- boot manifest 的 entry id = **包名** `dsh-auto-continue`（`dsh-client-modules/lib/client.js:130-136,162`）
- loader 注册 factory：`ownerId = stripClientSuffix(registration.id)`，stripClientSuffix 只去尾部 `/client`（`:98-99,705`）；factory 存到 `this.factories.set(id, ...)`（`:707,712`）
- loader 按 manifest entry id 找 factory（`:526-535`）

我的 factory 注册成 `auto-continue`，loader 找 `dsh-auto-continue`，find 不到 → import failed。两个能工作的插件（ability-strip / turn-stats）的 client id 都是完整包名，只有我的少写了 `dsh-` 前缀。

## 修正

`lib/client.js` 的 load id 改为 `'dsh-auto-continue'`。slot 条目 id `'auto-continue-status'` 不需要等于包名（它是 `conversation.composer.dock` 列表槽内的 cell key），保持不动。

## 为什么之前没抓到（三重失效）

1. **我的 review-checklist C8 只查"两端 method/envelope 一致"，没查 client load id == 包名**——判据缺失。
2. **`pnpm check` 的静态断言只查"client 用 lazy-CJS / token / 无开关"**，没有断言 load id 等于 package.json 的 name——门禁缺口。
3. **两轮代码评审（code-001/002）都没查这一项**——它们聚焦宿主侧逻辑与消息 id，没核客户端注册契约。

## 防复发（已完成）

- check.mjs 新增静态断言：从 client.js 源码提取 `load({ id: '...' })`，断言其等于 package.json 的 `name`。变异测试确认：把 id 改回 `auto-continue` → 该断言转红。
- 独立 review（`reviews/incident-001.md`）逐层坐实根因并确认源码无第二处同类隐患；它同时抓出我"只改源码未重打包"的低级错误（见下）。
- 教训：**"plugin 名 / module id / slot cell id / 路由 channel"是四个不同的 id**，不能想当然省略前缀；凡是 manifest/loader 对齐的 id，必须与 package.json name 逐字一致，并用静态门禁锁死。

## 处置结果（2026-11-17）

| 步骤 | 结果 |
|---|---|
| 用户卸载事故版、页面恢复 | 完成（用户操作） |
| 源码修正 client id → `dsh-auto-continue` | 完成 |
| 新增 incident-001 静态门禁 + 变异验证 | 完成 |
| 独立 review | 打回：发现 dist 里 0.2.0.tgz 仍是旧 id（我修了源码却没重打包）——按现状重装必复现 |
| 递增版本 0.2.0 → 0.2.1 | 完成（index.js VERSION、check.mjs 断言同步用 pkg.version） |
| 重新 pack 0.2.1 | 完成；解包逐字节核对：client id 正确、门禁进包、8 文件 7 个逐字节一致、package.json 仅键序差异（值逐键相等） |
| 安装 0.2.1（未重启 dsh） | 完成；安装副本 id/哈希与源码一致，bundle 已登记 |
| 真机页面是否恢复 | **未验证**（不重启、不碰浏览器；需用户刷新页面确认不再报 import failed） |
