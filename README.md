# dsh-plugins — DSH 插件单仓库

DeepSeek Harness（dsh）自研插件集中开发仓库。**所有插件在一个仓库，不为单个插件另开仓库。**

> 全部代码与文档由 AI 编写（DeepSeek 编程智能体，在 DSH 会话中完成）；人类角色是需求方、评审验收方与最终决策方。

## ⚠️ 维护前先拉取

**这个仓库有多个会话、多台机器同时在改同一个 `main`。动手前先 `git pull`，提交前再同步一次。**

```powershell
git pull --ff-only origin main
git status --short              # 应当没有输出
node scripts/check-all.mjs      # 先确认拉到的代码本身是绿的
```

push 被拒（`rejected (fetch first)`）不是意外，是并发改同一仓库的常态：`fetch` → 看清差异 →
`rebase` → 冲突**取并集** → 双向验证（对方的新增还在、双方检查都通过）→ 再推。
**绝不 `git push --force`。** 完整流程、两次真实事故与判据见
[INSTALL.md §16 维护前先拉取](INSTALL.md#16-维护前先拉取多会话多机器同时改同一个仓库)。

`dist/` 与 `*.tgz` 在 `.gitignore` 里，所以拉取**不会**覆盖任何机器上已发布的 tarball，也不会动
`$DSH_HOME` 下的 profile——同步和发布互不干扰。

## 文档地图

| 想了解 | 看哪里 |
| --- | --- |
| **改这个仓库前要注意什么**（先拉取、冲突怎么办、并发提交） | **[INSTALL.md §16 维护前先拉取](INSTALL.md#16-维护前先拉取多会话多机器同时改同一个仓库)** |
| **官方怎么说**（重载/重启规则、官方安装入口、禁用客户端依赖、排查顺序） | **[INSTALL.md §15 官方口径与偏离记录](INSTALL.md#15-官方口径与偏离记录)**（原文引用 + 一手出处；升级 dsh 后必读） |
| **换了新机器 / 多台机器怎么装** | **[INSTALL.md §11 跨机器使用](INSTALL.md#11-跨机器使用多台机器)**（两种安装方式任选：本机打包 / git 源直装） |
| 怎么装、怎么发版、为什么不能 `link:`、报错怎么排 | **[INSTALL.md](INSTALL.md)**（跨插件唯一权威） |
| 某个插件干什么、机制、限制、它的具体安装命令 | 该插件的 `README.md` |
| 接手某个插件要立刻知道的事（状态、哈希、教训、决策史） | 该插件的 `HANDOFF.md` |
| 某插件的评审档案 | 该插件的 `REVIEW-*.md` |

## 插件索引

| 插件 | 形态 | 版本（源码） | 已装版本 | 文档 |
| --- | --- | --- | --- | --- |
| [dsh-ability-strip](dsh-ability-strip/) | host + client 双半边 | 0.16.2 | `web` profile **0.16.2**（2026-11-11 实测；此行曾长期停在 0.5.0） | [README](dsh-ability-strip/README.md) · [HANDOFF](dsh-ability-strip/HANDOFF.md) |
| [dsh-subagent-wait-reminder](dsh-subagent-wait-reminder/) | 纯 host 半边 | 0.1.1 | `web` profile **0.1.1**（2026-11-11 实测；此行此前停在 0.1.0） | [README](dsh-subagent-wait-reminder/README.md) · [HANDOFF](dsh-subagent-wait-reminder/HANDOFF.md) |
| [dsh-read-img](dsh-read-img/) | 纯 host 半边 | 0.1.6 | `web` profile **0.1.6**（2026-11-09 装入，模型配置沿用原 `tool-vision`；装完无需重启 Host，已实测生效） | [README](dsh-read-img/README.md) · [HANDOFF](dsh-read-img/HANDOFF.md) |
| [dsh-turn-stats](dsh-turn-stats/) | host + client 双半边 | 0.2.0 | `web` profile **0.2.0**（2026-11-11 装入并做运行态核对：投影 `ver 2`、同一轮内随每次调用刷新。源码另含若干**注释订正**，行为与线载荷一致，有意未发版——核对到 HEAD 比已装新不是漏装，见其 HANDOFF） | [README](dsh-turn-stats/README.md) · [HANDOFF](dsh-turn-stats/HANDOFF.md) |

> 「已装版本」是**实测值**（读 `$DSH_HOME/profiles/<profile>/node_modules/<包名>/package.json`），不是推断。核对命令见 [INSTALL.md §11.5](INSTALL.md#115-升级)。**发版的那次改动要顺手把本表对应行一起改掉**——2026-11-11 一次性核对时发现三行里有两行停在旧版本，说明"记得改"靠不住。

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

装之前先验证一遍全仓库（一条命令，跑每个插件自己的 `check`，并在 `check` 未包含测试时补跑 `test`）：

```powershell
node scripts/check-all.mjs
```

> 末尾只有 `RESULT: PASS` 才算过。它只跑离线检查，不需要 profile、不需要浏览器、不碰 `$DSH_HOME`。`test:live` 这类 opt-in 脚本不会被它执行。

**开发时改源码，绝不影响已经安装的线上版本**——tarball 安装是解包拷贝，源码与运行副本物理隔离。要让线上更新，必须显式走一遍「递增版本号 → `pnpm pack` → `dsh plugin --profile web add`」。完整铁律与原因见 [INSTALL.md](INSTALL.md) 第 0–2 节。

## 仓库结构

```
dsh-plugins/
├── README.md                  ← 本文件：项目入口 + 文档地图 + 插件索引
├── INSTALL.md                 ← 跨插件规约：安装隔离 / 发版 / 排错 / 目录骨架 / 官方口径
├── .gitattributes             ← eol=lf：换行不在各机器之间漂移
├── .gitignore                 ← node_modules/ dist/ profile-backups/ *.tgz *.broken
├── scripts/check-all.mjs      ← 一条命令跑完所有插件的 check（含各自 test）
├── dsh-ability-strip/
│   ├── README.md  HANDOFF.md
│   ├── package.json  cordis.patch.yml
│   ├── lib/index.js  lib/client.js   ← client 自带 UI kit，不 require Harness Client 包
│   ├── scripts/*.mjs                 ← 宿主/契约/渲染/打包四项检查
│   └── dist/                         ← 发布产物（git 忽略，磁盘保留，不可覆盖不可删）
├── dsh-subagent-wait-reminder/
│   ├── README.md  HANDOFF.md  REVIEW-v1-FAIL.md  REVIEW-v2-PASS.md  REVIEW-v3-PASS.md
│   ├── package.json  cordis.patch.yml
│   ├── lib/index.js
│   ├── test/reminder.test.mjs        ← 25 例行为测试（node:test，零第三方依赖）
│   └── dist/
└── dsh-read-img/
    ├── README.md  HANDOFF.md
    ├── package.json  cordis.patch.yml
    ├── lib/index.js  lib/cache.js  lib/image.js  lib/vision.js
    ├── scripts/check.mjs             ← 语法 + 包契约 + patch 契约
    ├── test/                         ← 42 例离线 + 11 例插件 + 1 个 opt-in live
    └── dist/
```

新增插件：在本仓库下建目录（**目录名 = 包名**），按 [INSTALL.md](INSTALL.md) 第 9 节骨架建文件，第 10 节有上线五步。

## 历史注记

- **dsh-ability-strip** 曾独立成仓（GitHub `whengu/dsh-ability-strip`，`7e228a0..4b6551c`）。2026-11-03 按「不为单插件另开仓库」的决策解散其 `.git` 并入本仓库；2026-11-04 复用同一个 GitHub 仓库作为本单仓库的远程（不新建仓库），旧两个提交以 `-s ours` 合并保留在历史中，随后仓库更名为 **`dsh-plugins`**。
- **dsh-subagent-wait-reminder** 无独立 git 历史，交接事实由其 [HANDOFF.md](dsh-subagent-wait-reminder/HANDOFF.md) 哈希快照接管。
- 2026-11-03 迁移后两插件的 tgz 绝对路径变化，profile 已从新路径重新登记（相同字节重装，安装副本哈希与源码逐字节一致）。
- 2026-11-04 规约从仓库外移入本仓库根 `INSTALL.md`（此前放工作区根，导致仓库不自洽、链接一出仓库即死链）。
- **2026-11-09 新增 dsh-read-img**：起因是第三方 `dsh-tool-vision` 在上下文里注册 15 个工具（约 13.5 KB schema），对「读一个本地图片文件」过度设计；按需求澄清后改为单工具插件（0 hook、0 浏览器半边）。首个可安装版本 0.1.0，当日迭代到 0.1.4 并装入 web profile（0.1.4 起在请求层隐藏官方的 `read_image`）。
- **2026-11-09 修正索引里的"已装"表述**：核对 `$DSH_HOME/profiles/*/node_modules` 发现，`dsh-read-img` 在本机**四个 profile（acp/headless/sdk/web）里都不存在**，而此前索引写的是「web profile 已装，工具验收通过」、该插件自己的文档也写「线上装的是 0.1.5」。原因未查明（可能是装过之后 profile 在 dsh 升级中被重建，仓库里确有 `profile-backups/`），**但事实是现在没装**。索引因此新增「已装版本」列并改为实测值。以后记录安装状态前请先跑一遍核对命令，不要沿用上一次的结论。
- **2026-11-09 质量轮**：`dsh-ability-strip` 0.5.0 剥离 Harness Client 包依赖（自带 UI kit，`require` 面只剩 react/react-dom），并把官方那条规则固化成会红的检查；`dsh-subagent-wait-reminder` 0.1.1 补 25 例行为测试（`lib/` 未改，哈希可证）；`dsh-read-img` 0.1.6 修 `engines.dsh` 上界、`file://` 主机名语义、Windows 上写死的 POSIX 期望、`test:plugin` 在干净 checkout 上跑不起来四个问题。仓库新增 `.gitattributes`（`eol=lf`，避免换行造成哈希假失败）与 `scripts/check-all.mjs`（一条命令验证全仓库）。
