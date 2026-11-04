# dsh-plugins — DSH 插件单仓库

DeepSeek Harness（dsh）自研插件集中开发仓库。**所有插件在一个仓库，不为单个插件另开仓库。**

> 全部代码与文档由 AI 编写（DeepSeek 编程智能体，在 DSH 会话中完成）；人类角色是需求方、评审验收方与最终决策方。

## 文档地图

| 想了解 | 看哪里 |
| --- | --- |
| 怎么装、怎么发版、为什么不能 `link:`、报错怎么排 | **[INSTALL.md](INSTALL.md)**（跨插件唯一权威） |
| 某个插件干什么、机制、限制、它的具体安装命令 | 该插件的 `README.md` |
| 接手某个插件要立刻知道的事（状态、哈希、教训、决策史） | 该插件的 `HANDOFF.md` |
| 某插件的评审档案 | 该插件的 `REVIEW-*.md` |

## 插件索引

| 插件 | 形态 | 版本 | 状态 | 文档 |
| --- | --- | --- | --- | --- |
| [dsh-ability-strip](dsh-ability-strip/) | host + client 双半边 | 0.3.0 | `web` profile 已装，页面实测通过 | [README](dsh-ability-strip/README.md) · [HANDOFF](dsh-ability-strip/HANDOFF.md) |
| [dsh-subagent-wait-reminder](dsh-subagent-wait-reminder/) | 纯 host 半边 | 0.1.0 | `web` profile 已装，生产验证通过 | [README](dsh-subagent-wait-reminder/README.md) · [HANDOFF](dsh-subagent-wait-reminder/HANDOFF.md) |

## 快速开始（给第一次接触本仓库的人）

```powershell
cd D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\<插件名>
pnpm check          # 只读源码，不碰任何 profile
```

**开发时改源码，绝不影响已经安装的线上版本**——tarball 安装是解包拷贝，源码与运行副本物理隔离。要让线上更新，必须显式走一遍「递增版本号 → `pnpm pack` → `dsh plugin --profile web add`」。完整铁律与原因见 [INSTALL.md](INSTALL.md) 第 0–2 节。

## 仓库结构

```
dsh-plugins/
├── README.md                  ← 本文件：项目入口 + 文档地图 + 插件索引
├── INSTALL.md                 ← 跨插件规约：安装隔离 / 发版 / 排错 / 目录骨架
├── .gitignore                 ← node_modules/ dist/ profile-backups/ *.tgz *.broken
├── dsh-ability-strip/
│   ├── README.md  HANDOFF.md
│   ├── package.json  cordis.patch.yml
│   ├── lib/index.js  lib/client.js
│   ├── scripts/*.mjs          ← 四项契约/渲染/打包检查
│   └── dist/                  ← 发布产物（git 忽略，磁盘保留，不可覆盖不可删）
└── dsh-subagent-wait-reminder/
    ├── README.md  HANDOFF.md  REVIEW-v1-FAIL.md  REVIEW-v2-PASS.md  REVIEW-v3-PASS.md
    ├── package.json  cordis.patch.yml
    ├── lib/index.js
    └── dist/
```

新增插件：在本仓库下建目录（**目录名 = 包名**），按 [INSTALL.md](INSTALL.md) 第 9 节骨架建文件，第 10 节有上线五步。

## 历史注记

- **dsh-ability-strip** 曾独立成仓（GitHub `whengu/dsh-ability-strip`，`7e228a0..4b6551c`）。2026-11-03 按「不为单插件另开仓库」的决策解散其 `.git` 并入本仓库；2026-11-04 复用同一个 GitHub 仓库作为本单仓库的远程（不新建仓库），旧两个提交以 `-s ours` 合并保留在历史中，随后仓库更名为 **`dsh-plugins`**。
- **dsh-subagent-wait-reminder** 无独立 git 历史，交接事实由其 [HANDOFF.md](dsh-subagent-wait-reminder/HANDOFF.md) 哈希快照接管。
- 2026-11-03 迁移后两插件的 tgz 绝对路径变化，profile 已从新路径重新登记（相同字节重装，安装副本哈希与源码逐字节一致）。
- 2026-11-04 规约从仓库外移入本仓库根 `INSTALL.md`（此前放工作区根，导致仓库不自洽、链接一出仓库即死链）。
