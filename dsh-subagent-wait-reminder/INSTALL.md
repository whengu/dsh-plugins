# dsh-subagent-wait-reminder — 安装 / 升级 / 回滚

> 铁律与完整规约见 [..\..\dsh-plugin-dev-guide.md](../../dsh-plugin-dev-guide.md)。本文件只放本插件自己的命令与记录。
> 本插件是**纯 Host 侧**插件（无 `dsh.client`）：Host 不需要重启，也不涉及浏览器 `Ctrl+F5`。

## 打包前检查（只读源码，不碰 profile）

```powershell
cd D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder
pnpm check
pnpm pack --pack-destination dist
tar -tzf dist\dsh-subagent-wait-reminder-<版本>.tgz   # 条目带 package/ 前缀（pnpm pack 规范）；必须含 package/lib/index.js、package/cordis.patch.yml
```

## 安装 / 升级（每次发版递增版本号）

```powershell
dsh plugin --profile web add "D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\dsh-subagent-wait-reminder\dist\dsh-subagent-wait-reminder-<版本>.tgz"
```

本包声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把 patch 追加进 `dsh.profile.bundles`，**不需要手工编辑 profile 的 `cordis.patch.yml`**。若日志出现 `declares no dsh.bundle — installed as a plain dependency`，说明包结构有问题，应修包而不是绕过。

## 验证登记形态

```powershell
(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-subagent-wait-reminder" -Force).LinkType   # 空 = 普通目录（正确）
dsh plugin --profile web why dsh-subagent-wait-reminder
dsh --profile web --dump-config    # 应有本包 patch 插入的 entry
```

功能验证：派发一个子智能体 → 派发结果后应紧跟一条 user 角色 `<system-reminder>`；子智能体结束后完成通知自动到达；全程零 `list_agents`（见 README「生产验证记录」）。

## 回滚 / 卸载

```powershell
dsh plugin --profile web add "<旧版本 tgz 绝对路径>"          # 回滚到旧版
dsh plugin --profile web remove dsh-subagent-wait-reminder   # 彻底移除
```

不要改源码当回滚用——源码与运行副本无任何链接。

## 安装记录

- **2026-11-02**：0.1.0 首装（旧路径 `default-workspace\dsh-subagent-wait-reminder`）。`pnpm pack` 产物 8471 字节、四文件齐全；`dsh plugin add` 含 lockfile 供应链校验（170 entries）与一次 pnpm 垃圾清理（`+1 -32`，-32 为 extraneous 包）；装后 `LinkType` 为空、`why` 有记录、`dsh.profile.bundles` 末尾自动追加本包。
- **2026-11-03**：随单仓库迁移移至 `dsh-plugins\dsh-subagent-wait-reminder`，profile 从新路径重新登记（相同字节重装：`LinkType` 为空、安装副本 `lib\index.js` 哈希 `878A22AB18B45554` 与源码一致、`why` 有记录、`dsh.profile.bundles` 保留本包、无 `skipping profile bundle` 警告）。
