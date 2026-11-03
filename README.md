# dsh-plugins — DSH 插件单仓库

本仓库集中管理所有自研 DSH 插件；不为单个插件另开仓库。开发规约（安装隔离、目录骨架、发版流程）：[../dsh-plugin-dev-guide.md](../dsh-plugin-dev-guide.md)。

## 插件索引

| 插件 | 形态 | 版本 | 状态 |
| --- | --- | --- | --- |
| [dsh-ability-strip](dsh-ability-strip/) | host + client 双半边 | 0.3.0 | web profile 已装，页面实测通过 |
| [dsh-subagent-wait-reminder](dsh-subagent-wait-reminder/) | 纯 host 半边 | 0.1.0 | web profile 已装，生产验证通过 |

## 新插件上线

1. 在仓库根新建目录，**目录名 = 包名**；
2. 按规约第 9 节骨架建文件（`package.json` / `cordis.patch.yml` / `lib/` / `README.md`）；
3. `pnpm check` → `pnpm pack` → `dsh plugin --profile web add` → 按规约第 5 节四条验证；
4. 在本表加一行，git 提交。

## 历史注记

- dsh-ability-strip 曾独立成仓（GitHub `whengu/dsh-ability-strip`，`7e228a0..4b6551c`），2026-11-03 按「不为单插件另开仓库」决策解散 `.git` 并入本仓库；该 GitHub 仓库转为冻结存档。
- dsh-subagent-wait-reminder 无独立 git 历史，交接事实由其 [HANDOFF.md](dsh-subagent-wait-reminder/HANDOFF.md) 哈希快照接管。
- 2026-11-03 迁移后，两个插件的 tgz 绝对路径变化，profile 已从新路径重新登记（相同字节重装，安装副本哈希与源码逐字节一致）。
