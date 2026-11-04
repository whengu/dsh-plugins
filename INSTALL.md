# DSH 插件安装与开发隔离规约

> **核心目标：开发时改源码，绝不影响已经安装的线上版本。**
>
> 本文件是**本仓库所有插件共用的唯一安装权威**：安装铁律、为什么禁 `link:`、发版流程、排错表、目录骨架、单仓库管理。插件自己的具体命令在各插件 `README.md` 的「安装」节。
>
> 本文由 AI 编写（DeepSeek 编程智能体）。命令均在本机实测，机制对照 DSH `0.2.1-rc.5` 源码核对（pnpm `12.9.1`，Windows）。
> 沿革：`dsh-ability-strip/INSTALL.md`（2026-10-28）→ 工作区级 `dsh-plugin-dev-guide.md`（2026-11-03）→ 本仓库根 `INSTALL.md`（2026-11-04，收入仓库以保证仓库自洽）。

## 0. 先记住这条铁律

**开发中的源码目录，和运行中的插件，必须是两个物理隔离的副本。**

| 东西 | 位置 | 谁在读写 |
| --- | --- | --- |
| 开发源码 | `dsh-plugins/<插件名>/`（本仓库） | 你（编辑、打包） |
| 安装副本 | `$DSH_HOME/profiles/<profile>/node_modules/<包名>/` | 运行中的 Host / 浏览器 |

正确安装（tarball）之后，这两者之间**没有任何链接**：改源码不会改安装副本，页面不会变。想让线上更新，必须显式执行一次「重新打包 + 重新安装」——这是一次可审阅的版本切换，而不是顺手保存就生效。

反面做法（目录安装 / `link:`）会让两者变成同一份文件：你保存一次源码，用户页面就变一次，没有评审、没有版本、没法回滚。**本项目明令禁止这种方式。**

本机实测证据（dsh-ability-strip 0.3.0）：

- 安装后源码 `README.md` 又被改过 → 源码与安装副本的哈希**不同**（安装副本仍是打包时的版本）
- `lib/client.js` 安装后没改 → 两侧哈希**完全一致**
- 安装副本是普通目录（`LinkType` 为空），不是符号链接

---

## 1. 为什么目录安装 / `link:` 会破坏隔离

pnpm 对三种本地 spec 的处理完全不同：

| 你写的 spec | pnpm 实际行为 | DSH 解析为 |
| --- | --- | --- |
| `<绝对路径>.tgz` | 解包**拷贝**进 `node_modules` | `tarball` |
| `<绝对目录>` | **符号链接**（等同 `pnpm link`） | `path` |
| `link:<绝对目录>` | **符号链接** | `path` |

pnpm 文档原话：从目录安装「会在 `node_modules` 里创建符号链接，等同于运行 `pnpm link`」。

而 DSH 的客户端模块系统让这个问题更严重：

1. `dsh-client-modules` 把每个插件客户端 bundle 的**绝对路径**缓存在 `pkgMeta`（key 为 `baseUrl + \0 + loaderName`），**永不失效**；
2. `captureArtifactBaseline()` 之后 stat 这个缓存路径来推导 revision；
3. `link:` 安装记下的是**源码目录**路径 → Host 一直发源码目录里的文件；
4. 卸载、换 tarball 重装、改 profile 都不清这个缓存 → 直到重启 Host，页面读的仍是源码树。

**实际后果**：你以为在「开发环境」改代码，其实直接改了线上界面。而且重装 tarball 也救不回来，除非重启 Host 或换一个新的包名（新 specifier = 新缓存 key）。这就是 dsh-ability-strip 从 `dsh-runtime-inspector` 改名的真实原因。

---

## 2. 正确的隔离模型

```
开发源码目录（dsh-plugins/<插件名>/）   （随便改，不影响任何运行中的实例）
    │
    │  pnpm pack —— 只读快照，生成不可变产物
    ▼
dist/<包名>-<版本>.tgz                （发布介质：一旦发布就不要覆盖）
    │
    │  dsh plugin --profile web add   —— 解包拷贝
    ▼
$DSH_HOME/profiles/web/node_modules/<包名>/   （运行副本：Host/浏览器只读这里）
```

四条不可违反的规则：

1. **只从 tarball 安装。** 不用目录、不用 `link:`、不手工往 profile 的 `node_modules` 里放文件。
2. **tarball 是不可变产物。** 每个版本一个文件名；发布后不再改写这个文件（profile 的 lockfile 记录了它的 sha512 完整性，覆盖会导致后续 `pnpm install` 校验失败或行为不可预期）。
3. **要更新线上，必须显式执行「新版本 + 重新打包 + 重新安装」。** 保存源码本身永远不构成上线。
4. **不为测试新建 profile，不把半成品装进现有 profile。** 开发阶段不安装任何东西；安装即发布，发布可回滚。

---

## 3. 日常开发流程（不影响线上）

### 第 1 步：改源码，只跑本地检查

```powershell
cd D:\Users\guwh\Documents\deepseek-harness\default-workspace\dsh-plugins\<插件名>
node --check lib\<每个 .js 文件>   # 语法（宿主插件查 lib\index.js，双半边插件还要查 lib\client.js）
pnpm check                        # 项目自带的检查（必须全过）
```

这些命令只读源码，不碰任何 profile，**不会影响线上**。

### 第 2 步：验证——默认不碰任何 profile

**不要为了预览新建 profile，也不要把半成品装进现有 profile。** 真实页面的验证只发生在发布步骤（第 3 步）——而发布本身是可回滚的：出问题就把旧版本的 tarball 装回去（见第 4 步）。开发期间源码怎么改都不会影响线上，这正是我们想要的。

### 第 3 步：验收通过，才切换到线上

只有这一步会改变用户看到的版本，而且是一次明确的、可审阅的产物切换：

```powershell
# 1. 定稿版本号（递增），重新打包到正式目录
pnpm check
pnpm pack --pack-destination dist
# 有 verify-pack 脚本的插件跑一遍校验
node scripts/verify-pack.mjs dist\<包名>-<新版本>.tgz

# 2. 装进线上 profile
dsh plugin --profile web add "D:\...\dsh-plugins\<插件名>\dist\<包名>-<新版本>.tgz"

# 3. 浏览器 Ctrl+F5 硬刷新（纯 Host 侧插件不需要）
```

### 第 4 步：需要回滚时

旧版本的 tarball 还留着，直接装回旧包即可（不要试图改回源码）：

```powershell
dsh plugin --profile web add "<绝对路径>\dist\<包名>-<旧版本>.tgz"
```

---

## 4. 正式安装步骤（线上 profile）

```powershell
cd D:\...\dsh-plugins\<插件名>
pnpm pack --pack-destination dist
tar -tzf dist\<包名>-<版本>.tgz        # 确认 lib/、cordis.patch.yml 都在
dsh plugin --profile web add "D:\...\dsh-plugins\<插件名>\dist\<包名>-<版本>.tgz"
# 浏览器 Ctrl+F5（有浏览器半边的插件）
```

要点：

- **`--profile` 必填**，且必须和实际启动的 profile 一致（`dsh web` 就是 `dsh --profile web` 的简写，所以安装时用 `--profile web`）。
- 本地路径写**绝对路径**并加引号；命令行会按当前目录解析 `./`，但绝对路径最稳，GUI 安装入口只接受绝对路径。
- `dsh plugin` 会把参数原样转发给 profile 目录里的 pnpm，然后：检查 `engines.dsh` 兼容性 → 把声明了 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`。
- 第一次对不存在的 profile 名执行会自动初始化一个空 profile——这很容易造成「装到了幽灵 profile、页面永远没效果」的困惑。务必用实际启动的那个 profile 名；**不要为了测试新建 profile**。
- Host **不需要重启**：`dsh-hmr` 监视 profile 清单并重组层；但浏览器按 bundle revision 缓存客户端代码，必须 `Ctrl+F5` 硬刷新。
- 移动插件目录（改变 tgz 绝对路径）后，必须从新路径重新 `add`——profile 记录的路径不允许手工编辑，`add` 是唯一合法途径。

---

## 5. 如何确认「线上没有被源码污染」

按顺序查，前三条任何一条不对就说明安装形态有问题：

### ① profile 记录的是 tarball，不是 link

打开 `$DSH_HOME/profiles/web/package.json`：

```json
"dependencies": {
  "<包名>": "file:<绝对路径>/dist/<包名>-<版本>.tgz"   // ✅ 正确
  // "<包名>": "link:<源码目录>"                        // ❌ 危险：源码即线上
}
```

### ② node_modules 里是普通目录

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\web\node_modules\<包名>"   # 默认 home；设了 DSH_HOME 就换成 $env:DSH_HOME
(Get-Item $p -Force).LinkType
# 空 = 普通目录（正确）
# Junction / SymbolicLink = 链接（错误）
```

### ③ 改源码后页面不会自己变

在源码里改一个字符串保存，**不要重新打包**，然后刷新页面：

- 刷新后页面没变化 → 隔离正确（这是期望行为）
- 刷新后页面内容跟着变了 → 你装的是 link（源码即线上），必须立刻换成 tarball 安装并重启 Host

### ④ 依赖与 bundle 都登记了

```powershell
dsh plugin --profile web why <包名>
dsh --profile web --dump-config     # 输出里应能看到该包 patch 插入的 entry
```

---

## 6. 升级 / 卸载

```powershell
# 升级：改版本号 → 打包 → 重新 add（同名包原地替换安装副本）
pnpm pack --pack-destination dist
dsh plugin --profile web add "<绝对路径>\dist\<包名>-<新版本>.tgz"

# 卸载
dsh plugin --profile web remove <包名>
```

- **每次发布都递增版本号**，保证 tarball 文件名唯一；不要用同一个文件名覆盖已发布的包。
- `dist/` 不能删：profile 的 `dependencies` 记录的是 tarball 的绝对路径，之后执行 `dsh plugin install` 还需要这个文件存在。
- 卸载后同样 `Ctrl+F5`（有浏览器半边的插件）。

---

## 7. 常见错误对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `dsh: warning: <包名> declares no dsh.bundle — installed as a plain dependency, not a profile layer` | `package.json` 缺 `dsh.bundle.patch` | 补上，`remove` 后重新 `add` |
| `client-modules: <包名> declares dsh.client but exports no "./client" bundle` | 声明了 `dsh.client` 但 `exports` 没有 `./client` | 补 `exports["./client"]` |
| `dsh: installation rejected: ...`（engines.dsh 不匹配） | 插件声明的 `engines.dsh` 与当前 dsh 不兼容 | 修正声明，或确认风险后 `dsh plugin --profile web allow-version <包名>@<版本> --dsh-version <精确版本> --accept-risk` |
| 装完页面没效果 | 装错 profile / 没硬刷新 / 不是客户端插件 | 确认启动 profile；`Ctrl+F5`；检查 `dsh.client.platform` |
| **改了源码页面没变化** | **正常**：tarball 安装是拷贝 | 重新 `pnpm pack` + `add` + 刷新 |
| **改了源码、刷新后页面跟着变** | **危险**：装的是目录/link | 改用 tarball 安装；必要时重启 Host 或换包名 |
| `dsh: pnpm was not found...` | 本机没有 pnpm | 安装 pnpm 并加入 PATH |
| 安装介质被移动/删除后 `dsh plugin install` 失败 | profile 引用 tarball 绝对路径 | 把 tgz 放回原路径，或从新路径重新 `add` |
| 启动日志 `skipping profile bundle "<包名>": ...` | bundle 的 patch 缺失/格式错/版本不兼容 | `dsh --profile web --dump-config` 查；修复后重装 |

---

## 8. 插件包必须满足的结构

`package.json` 最小示例：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "engines": {
    "dsh": ">=0.2.0-rc.2"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "cordis.patch.yml",
    "README.md"
  ]
}
```

`cordis.patch.yml` 最小形态：

```yaml
- insert:
    - id: my-plugin
      name: 'my-plugin'
```

关键字段与后果：

| 字段 | 作用 | 缺失/写错的后果 |
| --- | --- | --- |
| `dsh.bundle.patch` | 声明「这是 bundle」 | 只装成普通依赖，永不加载 |
| `dsh.client.platform: "web"` | 声明「有浏览器半边」 | 浏览器不加载 |
| `exports["./client"]` | 浏览器 bundle 入口 | 声明了 `dsh.client` 却缺它会直接抛错 |
| `engines.dsh` | 兼容性门槛 | 不匹配会被安装拒绝或启动时跳过 |
| `files` | `pnpm pack` 白名单 | 漏 `lib/`、`cordis.patch.yml` → 装出来的包是残的 |

> `files` 是白名单：`pnpm pack` 只打包列出的文件（`package.json` 始终包含）。「本地能跑、装了不生效」最常见的原因就是这里漏文件。`dsh.client` 一节仅双半边插件需要；纯 Host 侧插件删掉 `dsh.client` 和 `exports["./client"]`。

---

## 9. 每插件标准骨架

单仓库内每个插件按同一骨架组织（复杂度成比例裁剪，但必需项不减）：

```
<包名>/                     目录名 = package.json 的 name（硬规则，dsh 按名字解析）
├── package.json            必需：dsh.bundle.patch + engines.dsh + files 白名单
├── cordis.patch.yml        必需：- insert: [{id, name}]
├── lib/index.js            必需（宿主半边）；lib/client.js 仅当声明 dsh.client
├── scripts/                按需（契约/渲染检查等）；最低门槛 = pnpm check 覆盖全部 lib/*.js 语法
├── README.md               必需：作用 / 机制（逐条源码出处）/ 已知限制 / 验证状态 + 「安装」节（本插件命令）
├── HANDOFF.md              必需（会话收尾交付物）：状态快照 / 资产哈希 / 教训 / 维护手册 / 决策记录 / 验收清单
├── REVIEW-*.md             按需：评审档案（开发期产物，不进 files 白名单、不随包发布）
└── dist/                   不可变 tgz（git 忽略、磁盘保留、不可覆盖不可删）
```

要点：

- **安装命令写在插件 `README.md` 的「安装」节**，跨插件铁律链接到仓库根 `INSTALL.md`。**不在插件目录里另建 INSTALL.md**——同一个主题两处维护必然漂移（wait-reminder 就发生过 README 与安装记录各写一遍）。
- **HANDOFF.md 是会话收尾的硬性交付物**，不是可选项。开发会话会被压缩、会结束，交接档案是唯一持续存在的记忆。重建的 HANDOFF 必须如实标注「重建自××，原始评审未存档」。
- `profile-backups/`（改 profile 前的备份）是会话产物，git 忽略，不随包发布、不进骨架必需项。
- 改 profile 登记的唯一合法途径是 `dsh plugin --profile web add/remove`，禁止手工编辑 profile 的 `package.json` / `pnpm-lock.yaml`。

---

## 10. 单仓库管理

所有自研插件集中在 **一个仓库** 内开发，不为单个插件另开仓库。仓库必须**自洽**：所有文档链接都在仓库内，不指向仓库外的文件。

```
dsh-plugins/                       ← 插件单仓库（git）
├── README.md                      ← 项目入口：插件索引、快速开始、文档地图
├── INSTALL.md                     ← 本文件：跨插件安装/隔离/发版规约（唯一权威）
├── .gitignore                     ← node_modules/ dist/ profile-backups/ *.tgz *.broken
├── dsh-ability-strip/             ← host+client 双半边，0.3.0
│   ├── README.md                  ← 插件说明 + 本插件安装命令
│   ├── HANDOFF.md                 ← 交接档案
│   └── …（package.json / cordis.patch.yml / lib / scripts）
└── dsh-subagent-wait-reminder/    ← 纯 host 半边，0.1.0
    ├── README.md
    ├── HANDOFF.md
    ├── REVIEW-v*.md               ← 评审档案（不随包发布）
    └── …
```

**文档归属（写一次，不重复）**：

| 层级 | 内容 | 位置 |
| --- | --- | --- |
| 项目入口 | 这是什么、插件索引、快速开始、文档地图 | 仓库根 `README.md` |
| 跨插件规约 | 安装铁律、禁 `link:` 的理由、发版流程、排错表、目录骨架 | 仓库根 `INSTALL.md`（本文件） |
| 插件说明 | 作用 / 机制（源码出处）/ 已知限制 / 验证状态 + 本插件命令 | `<插件>/README.md` |
| 交接档案 | 状态快照 / 资产哈希 / 教训 / 决策记录 / 验收清单 | `<插件>/HANDOFF.md` |
| 评审档案 | 开发期产物，不进 `files` 白名单、不随包发布 | `<插件>/REVIEW-*.md` |

四条硬规则：

1. **仓库自洽**：文档之间的链接只用仓库内相对路径，不出现 `../` 指到仓库外（仓库可独立克隆、独立阅读）。
2. **共用知识只写一次**：安装铁律写在 `INSTALL.md`，插件 README 只链接、不复述。
3. **每个插件必有 `README.md` 与 `HANDOFF.md`**：前者面向使用者，后者面向接手者。
4. **不进 `files` 白名单的东西**（HANDOFF / REVIEW / 规约）不随包发布，安装副本里看不到属预期。

**新插件上线（照抄即可）**：

1. 在本仓库下新建目录，目录名 = 包名；
2. 按第 9 节骨架建文件（`package.json` / `cordis.patch.yml` / `lib/` / `README.md`）；
3. `pnpm check` → `pnpm pack` → `dsh plugin --profile web add` → 验证（第 5 节四条）；
4. 在仓库 `README.md` 的索引表加一行；
5. 写 `HANDOFF.md`（会话收尾的硬性交付物），git 提交。

**迁移记录（2026-11-03/04）**：dsh-ability-strip 曾独立成仓（GitHub `whengu/dsh-ability-strip`，`7e228a0..4b6551c`），按「不为单插件另开仓库」的决策解散其 `.git` 并入本仓库；2026-11-04 复用该 GitHub 仓库作为本单仓库的远程（旧提交保留在历史中），**没有新建仓库**，随后更名为 `whengu/dsh-plugins`。dsh-subagent-wait-reminder 无 git 历史，由其 HANDOFF 哈希快照接管。两插件目录移动后 tgz 绝对路径变化，profile 从新路径重新 `add`（相同字节重装，安装副本哈希逐字节一致）。

**将来若某插件要独立成干净仓库对外发布**：

1. 把插件目录移出仓库（历史可用 `git subtree split` 拆分，或以当前内容新开仓库并注明出处）；
2. profile 从新路径重新 `add`（唯一合法途径），并做第 5 节四条验证。

---

## 11. 特殊场景

### 桌面版（Desktop）

`dsh plugin --profile desktop ...` 管理 Desktop 的保留 profile：必须先用 Desktop 打开过一次完成初始化，并**完全退出 Desktop** 后再执行。普通 `dsh web` 用户忽略。

### 离线安装

本地 tarball 安装不访问 registry（pnpm 只从文件解包），适合内网/无网机器；但本机必须有可用的 pnpm。

---

## 12. 机制出处（便于核对）

- `@deepseek-ai/dsh/lib/bin.js` — `parseDshArgs`：`plugin` 子命令，`--profile` 为 requiredOption，其余参数原样转发 pnpm。
- `@deepseek-ai/dsh/lib/plugin-*.js` — `runPlugin`：调用 `runPluginCommand`；pnpm 缺失（exit 127）与不兼容包（`allow-version` 提示）在这一层输出。
- `@deepseek-ai/dsh-plugin-manager/lib/types/operations.js` — `runProfilePnpm`：锁定 profile `package.json`、在 profile 目录运行 pnpm、相对路径按调用方 cwd 锚定、安装后做 `engines.dsh` 校验并可回滚、成功后 `reconcile`。
- `@deepseek-ai/dsh-plugin-manager/lib/index.js` — `reconcile`：新依赖声明 `dsh.bundle` 才追加进 `dsh.profile.bundles`；否则打印「plain dependency, not a profile layer」。
- `@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js` — `parseInstallSpec`：`file:`/`link:`/绝对路径解析；`.tgz` 为 `tarball`，目录为 `path`；服务端入口拒绝相对路径。
- `@deepseek-ai/dsh-client-modules/lib/index.js` — `resolveMeta`：`dsh.client.platform` 必须为 `"web"`、必须能解析 `exports["./client"]`；`pkgMeta` 的绝对路径缓存正是 link 风险的来源。
- `@deepseek-ai/dsh-app-boot/lib/index.js` — `resolveProfileDir` / `PROFILES_DIR`：profile 位于 `$DSH_HOME/profiles/<name>`，bundle 按 `dsh.profile.bundles` 顺序组合 patch。

---

## 13. 各插件的具体命令

本文件只写跨插件规约。每个插件的打包 / 安装 / 验证 / 回滚命令写在该插件 README 的「安装」节，避免两处维护：

- [dsh-ability-strip/README.md](dsh-ability-strip/README.md)（双半边，有浏览器半边）
- [dsh-subagent-wait-reminder/README.md](dsh-subagent-wait-reminder/README.md)（纯 Host 侧）
