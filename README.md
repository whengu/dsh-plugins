# dsh-plugins — DSH 插件单仓库

DeepSeek Harness（dsh）自研插件集中开发仓库。**所有插件在一个仓库，不为单个插件另开仓库。**

> 全部代码与文档由 AI 编写（DeepSeek 编程智能体，在 DSH 会话中完成）；人类角色是需求方、评审验收方与最终决策方。

## 文档地图

| 想了解 | 看哪里 |
| --- | --- |
| **官方怎么说**（重载/重启规则、官方安装入口、禁用客户端依赖、排查顺序） | **[INSTALL.md §15 官方口径与偏离记录](INSTALL.md#15-官方口径与偏离记录)**（原文引用 + 一手出处；升级 dsh 后必读） |
| **换了新机器 / 多台机器怎么装** | **[INSTALL.md §11 跨机器使用](INSTALL.md#11-跨机器使用多台机器)**（两种安装方式任选：本机打包 / git 源直装） |
| 怎么装、怎么发版、为什么不能 `link:`、报错怎么排 | **[INSTALL.md](INSTALL.md)**（跨插件唯一权威） |
| 某个插件干什么、机制、限制、它的具体安装命令 | 该插件的 `README.md` |
| 接手某个插件要立刻知道的事（状态、哈希、教训、决策史） | 该插件的 `HANDOFF.md` |
| 某插件的评审档案 | 该插件的 `REVIEW-*.md` |

## 插件索引

| 插件 | 形态 | 版本 | 状态 | 文档 |
| --- | --- | --- | --- | --- |
| [dsh-ability-strip](dsh-ability-strip/) | host + client 双半边 | 0.3.0 | `web` profile 已装，页面实测通过 | [README](dsh-ability-strip/README.md) · [HANDOFF](dsh-ability-strip/HANDOFF.md) |
| [dsh-subagent-wait-reminder](dsh-subagent-wait-reminder/) | 纯 host 半边 | 0.1.0 | `web` profile 已装，生产验证通过 | [README](dsh-subagent-wait-reminder/README.md) · [HANDOFF](dsh-subagent-wait-reminder/HANDOFF.md) |
| [dsh-read-img](dsh-read-img/) | 纯 host 半边 | 0.1.4 | `web` profile 已装，工具验收通过 | [README](dsh-read-img/README.md) · [HANDOFF](dsh-read-img/HANDOFF.md) |

## 快速开始（给第一次接触本仓库的人）

```powershell
git clone https://github.com/whengu/dsh-plugins.git
cd dsh-plugins
```

然后每个插件选**一种**方式安装（两种等效，可各机器混用）：

```powershell
# 方式 A：本机打包后安装（会产生 dist/，tarball 不可覆盖不可删）
cd <插件目录>
pnpm check
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/<包名>-<版本>.tgz
cd ..

# 方式 B：git 源直接安装（免打包、不产生 dist/，需联网；SHA 用完整 40 位）
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 SHA>&path:/<插件目录>"
```

> 仓库 clone 到哪都行，各机器不必一致。两种方式的完整对比、升级、回滚与禁忌见 [INSTALL.md §11](INSTALL.md#11-跨机器使用多台机器)。

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
├── dsh-subagent-wait-reminder/
│   ├── README.md  HANDOFF.md  REVIEW-v1-FAIL.md  REVIEW-v2-PASS.md  REVIEW-v3-PASS.md
│   ├── package.json  cordis.patch.yml
│   ├── lib/index.js
│   └── dist/
└── dsh-read-img/
    ├── README.md  HANDOFF.md
    ├── package.json  cordis.patch.yml
    ├── lib/index.js  lib/cache.js  lib/image.js  lib/vision.js
    ├── scripts/check.mjs      ← 语法 + 包契约 + patch 契约
    ├── test/                  ← 30 个离线用例 + 1 个 opt-in live 用例
    └── dist/
```

新增插件：在本仓库下建目录（**目录名 = 包名**），按 [INSTALL.md](INSTALL.md) 第 9 节骨架建文件，第 10 节有上线五步。

## 历史注记

- **dsh-ability-strip** 曾独立成仓（GitHub `whengu/dsh-ability-strip`，`7e228a0..4b6551c`）。2026-11-03 按「不为单插件另开仓库」的决策解散其 `.git` 并入本仓库；2026-11-04 复用同一个 GitHub 仓库作为本单仓库的远程（不新建仓库），旧两个提交以 `-s ours` 合并保留在历史中，随后仓库更名为 **`dsh-plugins`**。
- **dsh-subagent-wait-reminder** 无独立 git 历史，交接事实由其 [HANDOFF.md](dsh-subagent-wait-reminder/HANDOFF.md) 哈希快照接管。
- 2026-11-03 迁移后两插件的 tgz 绝对路径变化，profile 已从新路径重新登记（相同字节重装，安装副本哈希与源码逐字节一致）。
- 2026-11-04 规约从仓库外移入本仓库根 `INSTALL.md`（此前放工作区根，导致仓库不自洽、链接一出仓库即死链）。
- **2026-11-09 新增 dsh-read-img**：起因是第三方 `dsh-tool-vision` 在上下文里注册 15 个工具（约 13.5 KB schema），对「读一个本地图片文件」过度设计；按需求澄清后改为单工具插件（0 hook、0 浏览器半边）。首个可安装版本 0.1.0，当日迭代到 0.1.4 并装入 web profile（0.1.4 起在请求层隐藏官方的 `read_image`）。
