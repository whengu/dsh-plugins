# DSH 插件安装与开发隔离规约

> **核心目标：开发时改源码，绝不影响已经安装的线上版本。**
>
> 本文件是**本仓库所有插件共用的唯一安装权威**：安装铁律、为什么禁 `link:`、发版流程、排错表、目录骨架、单仓库管理。插件自己的具体命令在各插件 `README.md` 的「安装」节。
>
> ⚠️ **本规约在若干处有意偏离 DSH 官方默认做法**（`link:` 安装、安装入口、客户端依赖）。**官方权威出处、原文引用、以及每处偏离的原因与代价，全部记在 [§15 官方口径与偏离记录](#15-官方口径与偏离记录)。** 动手前先读那一节，不要把我们仓库的取舍误当成 DSH 的规则。
>
> 本文由 AI 编写（DeepSeek 编程智能体）。命令均在本机实测，机制对照 DSH `0.2.2-rc.1` 源码核对（pnpm `12.9.1`，Windows）。
> 沿革：`dsh-ability-strip/INSTALL.md`（2026-10-28）→ 工作区级 `dsh-plugin-dev-guide.md`（2026-11-03）→ 本仓库根 `INSTALL.md`（2026-11-04，收入仓库以保证仓库自洽）→ 2026-11-09 补入官方口径与偏离记录。

## 0. 先记住这条铁律

**开发中的源码目录，和运行中的插件，必须是两个物理隔离的副本。**

| 东西 | 位置 | 谁在读写 |
| --- | --- | --- |
| 开发源码 | `dsh-plugins/<插件名>/`（本仓库） | 你（编辑、打包） |
| 安装副本 | `$DSH_HOME/profiles/<profile>/node_modules/<包名>/` | 运行中的 Host / 浏览器 |

正确安装（tarball）之后，这两者之间**没有任何链接**：改源码不会改安装副本，页面不会变。想让线上更新，必须显式执行一次「重新打包 + 重新安装」——这是一次可审阅的版本切换，而不是顺手保存就生效。

反面做法（目录安装 / `link:`）会让两者变成同一份文件：你保存一次源码，用户页面就变一次，没有评审、没有版本、没法回滚。**本仓库明令禁止用这种方式做发布。**

> 必须说清的边界：**官方文档把"目录安装即链接源码"当作本地开发循环**（见 [§15](#15-官方口径与偏离记录)）。本仓库禁止它是为了**发布隔离**，不是因为它违反 DSH 规则。两者不冲突——但你要知道自己站在"更严"的一侧，代价是放弃了官方那种"改完即生效"的热迭代体验。开发期想看效果请走 §3（不装），发布走 tarball 或 git 源（§11）。

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
cd <仓库目录>/<插件目录>          # 仓库 clone 在哪都行，不必各机器一致
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

# 2. 装进线上 profile（站在插件目录里，用 ./ 相对路径）
dsh plugin --profile web add ./dist/<包名>-<新版本>.tgz

# 3. 浏览器 Ctrl+F5 硬刷新（纯 Host 侧插件不需要）
```

### 第 4 步：需要回滚时

旧版本的 tarball 还留着，直接装回旧包即可（不要试图改回源码）：

```powershell
# 站在插件目录里
dsh plugin --profile web add ./dist/<包名>-<旧版本>.tgz
```

---

## 4. 正式安装步骤（线上 profile）

有两种安装方式，**任选一种**（跨机器场景见第 11 节的完整对比与流程）：

**方式 A：本机打包后安装（本节详述）**

```powershell
cd <仓库目录>/<插件目录>
pnpm pack --pack-destination dist
tar -tzf dist\<包名>-<版本>.tgz        # 确认 lib/、cordis.patch.yml 都在
dsh plugin --profile web add ./dist/<包名>-<版本>.tgz
# 浏览器 Ctrl+F5（有浏览器半边的插件）
```

**方式 B：git 源直接安装（免打包）**

```powershell
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 40 位 SHA>&path:/<插件目录>"
# 浏览器 Ctrl+F5（有浏览器半边的插件）
```

要点：

- **`--profile` 必填**，且必须和实际启动的 profile 一致（`dsh web` 就是 `dsh --profile web` 的简写，所以安装时用 `--profile web`）。
- **方式 A 的路径写法**：站在插件目录里用 `./dist/<包名>-<版本>.tgz`。CLI 会把以 `.`/`..` 开头的路径按当前目录锚定成绝对路径再交给 pnpm；**裸相对路径（`dist/x.tgz`）不会被锚定**，会解析到 profile 目录而失败。绝对路径也能用，但不要写进文档或脚本——各机器路径不同。
- **方式 B 的写法要点**：SHA 用完整 40 位；不需要站在插件目录里；只能装远端已有的 commit。详细说明与验证状态见 §11.4。
- `dsh plugin` 会把参数原样转发给 profile 目录里的 pnpm，然后：检查 `engines.dsh` 兼容性 → 把声明了 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`。
- 第一次对不存在的 profile 名执行会自动初始化一个空 profile——这很容易造成「装到了幽灵 profile、页面永远没效果」的困惑。务必用实际启动的那个 profile 名；**不要为了测试新建 profile**。
- **重启规则（按改的是哪一半区分，别一概而论）**：
  - **只改浏览器半边**（`lib/client.js`）→ Host **不需要重启**，`dsh-hmr` 重组层 + 浏览器 `Ctrl+F5` 硬刷新即可。
  - **改了宿主半边代码**（`lib/index.js`，或任何被 Host `import` 的模块）→ **必须重启 Host 进程**。原因：Loader 用普通 ES Module `import()` 载入宿主模块，同一 specifier 一律命中 Node 的 ESM 缓存，`dsh-hmr` 只是重写 patch/清单并重组 Loader 树，**不会重新求值模块**。
  - `engines.dsh`/`cordis.patch.yml`/profile 清单这类**层结构变化**由 `dsh-hmr` 处理后即可生效，但**它不会让已被缓存求值过的宿主模块重新执行**。
  - 实测证据（2026-11-09，本机）：安装带新宿主路由的 0.4.0 后硬刷新，旧路由 `POST /api/ability-strip` 返回 200，新增的 `GET /api/ability-strip/events` 仍 404，宿主进程启动时间早于安装时间。**这是判别"宿主是否已加载新代码"最直接的方法：探测只有新代码才有的路由/行为。**
- 用方式 A 时，移动插件目录（改变 tgz 绝对路径）后必须从新路径重新 `add`；用方式 B 则不受目录位置影响。

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
# 方式 A：改版本号 → 打包 → 重新 add（同名包原地替换安装副本）
# 以下命令都在插件目录里执行
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/<包名>-<新版本>.tgz

# 方式 B：改版本号并 push → 用新 commit 重新 add（免打包，任何目录执行）
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<新完整 SHA>&path:/<插件目录>"

# 卸载（两种方式相同）
dsh plugin --profile web remove <包名>
```

- **每次发布都递增版本号**，保证 tarball 文件名唯一、且插件 UI 能区分不同构建；不要用同一个文件名覆盖已发布的包。
- 方式 A 下 `dist/` 不能删：profile 的 `dependencies` 记录的是 tarball 的**本机绝对路径**，之后执行 `dsh plugin install` 还需要这个文件存在。方式 B 不产生 `dist/`。
- 跨机器的升级/回滚流程见第 11.5、11.6 节。
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

## 11. 跨机器使用（多台机器）

**核心：安装包不跨机器传递。每台机器从同一份 git 源码出发，用下面两种方式之一把它装进自己的 profile。**

两种方式都**彻底消灭路径问题**——profile 记录的是本机自己的路径（或 git 定位信息），从来没有跨机器共享过路径。**每台机器可以各选一种，互不影响。**

> 两种方式用的都是 `dsh plugin --profile web add`，**不是** DSH 官方的 `plugin_manager install_bundle`。官方入口传的是包**目录**（= 链接源码），适合本地热迭代；这里选 tarball / git 源是为了发布隔离与跨机器一致。取舍与官方原文见 [§15.2](#152-官方安装入口我们没在用)。
>
> **升级已装插件时注意**：替换已安装包的**宿主 JS** 必须重启 Host 才生效（官方明文，见 [§15.1](#151-重载与重启官方明文决定改完要不要重启)）；只改客户端 bundle 则硬刷新即可。

### 11.1 为什么不能把 tgz / profile 复制到别的机器

profile 的 `package.json` 里，依赖值要么形如 `file:<本机绝对路径>.tgz`，要么形如 `git+<url>#<sha>&path:/<目录>`。前者与机器绑定，且之后的 `dsh plugin install` 依赖那个 tgz **在原地存在**。

| 做法 | 结果 |
| --- | --- |
| 把 A 的 `dist/*.tgz` 拷到 B，在 B 上用 B 自己的路径 `add` | **可以**（`add` 时的路径才被记录） |
| 把 A 的 profile `package.json` / `pnpm-lock.yaml` 拷到 B | **不可行**：里面是 A 的路径 |
| 把 A 的 `dist/` 整体搬进 B 的仓库位置 | 不必要：B 自己 pack 几秒就有 |

### 11.2 两种方式怎么选

| 维度 | 方式 A：本机打包（tarball） | 方式 B：git 源直接安装 |
| --- | --- | --- |
| 需要的命令 | `pnpm pack` + `dsh plugin add` | 只有 `dsh plugin add` |
| `dist/` 目录 | **必需**：不可删、不可覆盖、不进 git | **完全不需要** |
| 联网时机 | 只在 `git pull` | `git pull` **和**安装时 |
| 需要 git 客户端 | `git pull` 需要 | 安装时也需要 |
| profile 记录什么 | `file:<本机 tgz 路径>` | `git+<url>#<sha>&path:/<目录>`，精确到 commit |
| 回滚粒度 | 按 semver，装回旧 tgz | 按 commit SHA |
| 回滚前提 | 本机 `dist/` 里还留着那个版本的 tgz | 任何能联网的机器都能做 |
| 产物陈旧风险 | 有：`git pull` 后忘记重新 pack，装的还是旧包 | **没有** |
| 仓库换位置/迁移后 | 记录失效，必须重新 `add` | **不受影响**（记的是 git 坐标） |
| 离线重装（node_modules 被清） | ✅ 本机 tgz 即可 | ❌ 需联网重新拉取 |
| 给不装 git 的人分发 | ✅ | ❌ |
| 未来若插件引入构建步骤 | 不受影响 | 需在 profile 的 `pnpm-workspace.yaml` 配 `allowBuilds`（pnpm 默认阻止 git 依赖的构建脚本） |

**选择建议**：

- **方式 B（git 源）的适用场景**：这台机器本来就靠 git 同步代码（网络与 git 已是前提），且希望省掉 `dist/` 这个「每台机器各一份、不进版本库、又不可删」的本地状态，并让 profile 直接记录 commit。跨机器场景下出错点更少。
- **方式 A（本机打包）的适用场景**：机器访问不了 GitHub；或要把插件给不装 git 的人；或需要在断网时重装。
- **可以混用**：比如主力机用 B、隔离机用 A，互不冲突。

以下命令的站位统一为「**站在某个插件的目录里**」（`<插件目录>` 指 `dsh-ability-strip` 之类），好处是不出现任何本机绝对路径。

### 11.3 方式 A：本机打包后安装（tarball）

**前提**：本机已装 `node` / `pnpm` / `git` / `dsh`。本机实测可用组合：node `v24.18.1`、pnpm `12.9.1`、dsh `0.2.2-rc.1`。

**第 1 步：clone（目录位置随意，各机器不必一致）**

```powershell
git clone https://github.com/whengu/dsh-plugins.git
cd dsh-plugins
```

**第 2 步：每个插件跑一遍校验**

```powershell
cd <插件目录>
pnpm check            # 必须通过
cd ..
```

**第 3 步：在本机打包（产物落在本机 `dist/`）**

```powershell
cd <插件目录>
pnpm pack --pack-destination dist
cd ..
```

产物：`dist/<包名>-<版本>.tgz`。版本号来自源码（见 11.5）。

打包是**可复现**的：同一机器连续两次 `pnpm pack` 字节完全一致（tar 内 mtime 被规范化为固定值，不是真实文件时间），tarball 内路径全是 `package/...` 相对路径，不含任何本机路径。pnpm / Node 版本不同时压缩结果可能不同（内容一致、字节可能不同）。

**第 4 步：安装——用 `./` 相对路径，不要写绝对路径**

```powershell
cd <插件目录>
dsh plugin --profile web add ./dist/<包名>-<版本>.tgz
cd ..
```

**为什么 `./` 行、裸相对路径不行**：

- CLI 只把以 `.` 或 `..` 开头的路径按**调用时的当前目录**解析成绝对路径再交给 pnpm（`anchorPathSpec` 只匹配 `\.{1,2}`）。实测：失败信息里显示的是解析后的完整本机路径，证明锚定生效。
- `dist/x.tgz` 这种**不带 `./`** 的写法不会被锚定，而 pnpm 是在 **profile 目录**里运行的，会解析到错误位置。

**第 5 步：验证** —— 见 11.5 末尾的通用清单。

### 11.4 方式 B：git 源直接安装

一条命令装完，**不需要 `pnpm pack`，不需要 `dist/`**。spec 格式：

```
git+https://github.com/whengu/dsh-plugins.git#<40 位 commit SHA>&path:/<插件目录>
```

**第 1 步：取到要安装的 commit**

```powershell
git clone https://github.com/whengu/dsh-plugins.git
cd dsh-plugins
git rev-parse HEAD        # 复制完整的 40 位 SHA
```

也可以不 clone，直接在 GitHub 网页上复制某个 commit 的完整 SHA。

**第 2 步：安装**

```powershell
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 SHA>&path:/<插件目录>"
```

两个插件的实际写法（把 `<完整 SHA>` 换成真实值）：

```powershell
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 SHA>&path:/dsh-ability-strip"
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<完整 SHA>&path:/dsh-subagent-wait-reminder"
```

要点：

- SHA 用**完整 40 位**：短 SHA 实测也能用，但完整 SHA 才保证唯一、不会因未来对象增加产生歧义。
- 该命令**不需要站在插件目录里**（没有本地路径参与），任何目录执行都行。
- pnpm 会把仓库拉进自己的 store，再把 `files` 白名单内的内容拷进 profile 的 `node_modules`——所以仍然是**副本**，与源码树无链接。
- **只能装远端已有的 commit**，未 push 的本地提交取不到。这与「安装即发布」一致，是约束也是保障。

**验证状态（如实）**：

| 已验证（临时目录实测） | 未验证 |
| --- | --- |
| pnpm `12.9.1` 能从 monorepo 子目录安装成功 | `dsh plugin add` 在**真实 profile** 上把它登记进 `dsh.profile.bundles` 的端到端效果 |
| 装出的是副本：链接指向 pnpm store 而非源码树，内容哈希与源码一致 | |
| profile 同款 `nodeLinker: hoisted` 下 `LinkType` 为空，普通目录，与 tarball 形态一致 | |
| 安装内容严格遵循 `files` 白名单，`cordis.patch.yml` 在内 | |
| dsh 的 spec 解析接受该形式（`kind: "git"`）；dsh 自家插件市场用同一格式生成安装目标 | |

> 静态上登记没问题：`reconcile` 读的是 `node_modules/<包名>/package.json` 的 `dsh.bundle`，git 安装同样有这个文件。但**首次在真实 profile 上用方式 B 时，请照 11.5 末尾的清单确认一遍**（尤其是 `dsh.profile.bundles` 是否自动追加、`LinkType` 是否为空）。

### 11.5 升级

两种方式都需**先递增版本号并 push**。版本号写在源码 `package.json` 里，随 git 同步；发起人改一次，其他机器 `git pull` 即得，**不需要每台各改一次**。

**为什么用 git 装也要递增版本号**：插件 UI 显示的是 `package.json` 的 version（例如能力条面板显示 `dsh-ability-strip 0.3.0`）。若两个 commit 都写 0.3.0，页面分辨不出运行的是哪一个。

**方式 A**

```powershell
git pull
cd <插件目录>
pnpm check
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/<包名>-<新版本>.tgz
cd ..
```

**方式 B**

```powershell
git pull
git rev-parse HEAD        # 取新的完整 SHA
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<新完整 SHA>&path:/<插件目录>"
```

**两种方式通用的安装后验证**

```powershell
dsh plugin --profile web why <包名>          # 应有记录
dsh --profile web --dump-config              # 应有该包 entry，且无 skipping 警告

$prof = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'profiles/web'
(Get-Item (Join-Path $prof 'node_modules/<包名>') -Force).LinkType    # 空 = 普通目录（正确）
```

> profile 通用规则是 `$DSH_HOME/profiles/<profile>`，默认 `~/.dsh/profiles/<profile>`。上面用环境变量拼接，避免写死路径；POSIX shell 等价于 `${DSH_HOME:-$HOME/.dsh}/profiles/web`。

功能验证：

| 插件 | 怎么确认它在工作 |
| --- | --- |
| `dsh-ability-strip` | 浏览器 `Ctrl+F5`，输入框下方出现 `skill N \| MCP N`，点击行展开明细 |
| `dsh-subagent-wait-reminder` | 派发一个子智能体，派发结果后应紧跟一条 user 角色 `<system-reminder>`；纯 Host 侧，不需要刷新浏览器 |

**重启规则**：只改浏览器半边 → Host 不用重启，硬刷新即可；**改了宿主半边代码 → 必须重启 Host 进程**（ESM 缓存，`dsh-hmr` 只重组层不重新求值模块，见 §4 的实测证据）。有浏览器半边的插件无论如何都要硬刷新。

### 11.6 回滚

**方式 A**：装回旧版本 tgz。

```powershell
cd <插件目录>
dsh plugin --profile web add ./dist/<包名>-<旧版本>.tgz
```

⚠️ 前提是**本机 `dist/` 里还留着那个版本**。`dist/` 不进 git，每台机器只保留本机打过的包；本机没有该版本时，退到旧提交再打包：

```powershell
git checkout <旧提交>
cd <插件目录>
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/<包名>-<旧版本>.tgz
cd ..
git checkout -            # 回到原分支
```

**方式 B**：装回旧 commit，任何能联网的机器都能做。

```powershell
dsh plugin --profile web add "git+https://github.com/whengu/dsh-plugins.git#<旧完整 SHA>&path:/<插件目录>"
```

**两种方式通用**：不要改源码当回滚用——源码与运行副本无任何链接。

### 11.7 仓库换位置 / 机器迁移

**方式 A**：profile 记录的是旧绝对路径，仓库一移动那条记录就失效（`dsh plugin install` 会报找不到文件）。处理：

```powershell
cd <新位置的插件目录>
pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/<包名>-<版本>.tgz
```

**方式 B**：**不受影响**。profile 记录的是 git URL + SHA，与本地 clone 位置无关——这是方式 B 在跨机器场景下的一个实际优势。

两种方式都**不要**手工编辑 profile 的 `package.json` 或 `pnpm-lock.yaml`——`add` 是唯一合法途径，它会同时更新依赖、lockfile 和 `dsh.profile.bundles`。

### 11.8 跨机器绝对不要做的事

- ❌ 跨机器复制 profile 的 `package.json` / `pnpm-lock.yaml`（里面是另一台机器的路径）
- ❌ 在脚本或文档里写死本机绝对路径（换机器/换目录即失效）
- ❌ 用 `link:` 或目录安装（源码即线上，见第 1 节）
- ❌ 把 `dist/` 提交进 git（`.gitignore` 已排除；要分发就用 11.3 或 11.4）
- ❌ 为了测试新建 profile（见第 4 节）
- ❌ 用方式 B 装未 push 的本地提交（git 源只能取远端已有的 commit）

---

## 12. 特殊场景

### 桌面版（Desktop）

`dsh plugin --profile desktop ...` 管理 Desktop 的保留 profile：必须先用 Desktop 打开过一次完成初始化，并**完全退出 Desktop** 后再执行。普通 `dsh web` 用户忽略。

### 离线安装

本地 tarball 安装不访问 registry（pnpm 只从文件解包），适合内网/无网机器；但本机必须有可用的 pnpm。

---

## 13. 机制出处（便于核对）

- `@deepseek-ai/dsh/lib/bin.js` — `parseDshArgs`：`plugin` 子命令，`--profile` 为 requiredOption，其余参数原样转发 pnpm。
- `@deepseek-ai/dsh/lib/plugin-*.js` — `runPlugin`：调用 `runPluginCommand`；pnpm 缺失（exit 127）与不兼容包（`allow-version` 提示）在这一层输出。
- `@deepseek-ai/dsh-plugin-manager/lib/types/operations.js` — `runProfilePnpm`：锁定 profile `package.json`、在 profile 目录运行 pnpm、相对路径按调用方 cwd 锚定、安装后做 `engines.dsh` 校验并可回滚、成功后 `reconcile`。
- `@deepseek-ai/dsh-plugin-manager/lib/index.js` — `reconcile`：新依赖声明 `dsh.bundle` 才追加进 `dsh.profile.bundles`；否则打印「plain dependency, not a profile layer」。
- `@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js` — `parseInstallSpec`：`file:`/`link:`/绝对路径解析；`.tgz` 为 `tarball`，目录为 `path`；服务端入口拒绝相对路径。
- `@deepseek-ai/dsh-client-modules/lib/index.js` — `resolveMeta`：`dsh.client.platform` 必须为 `"web"`、必须能解析 `exports["./client"]`；`pkgMeta` 的绝对路径缓存正是 link 风险的来源。
- `@deepseek-ai/dsh-app-boot/lib/index.js` — `resolveProfileDir` / `PROFILES_DIR`：profile 位于 `$DSH_HOME/profiles/<name>`，bundle 按 `dsh.profile.bundles` 顺序组合 patch。

---

## 14. 各插件的具体命令

本文件只写跨插件规约。每个插件的打包 / 安装 / 验证 / 回滚命令写在该插件 `README.md` 的「安装」节，避免两处维护：

- [dsh-ability-strip/README.md](dsh-ability-strip/README.md)（双半边，有浏览器半边）
- [dsh-subagent-wait-reminder/README.md](dsh-subagent-wait-reminder/README.md)（纯 Host 侧）
- [dsh-read-img/README.md](dsh-read-img/README.md)（纯 Host 侧，单工具）

---

## 15. 官方口径与偏离记录

**权威出处**：DSH **随包安装**的插件开发 skill — `cordis-plugin-development`，位于
`<dsh 安装目录>/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
（`SKILL.md` + `references/host-plugin.md`、`practices.md`、`verification.md`、`ui-plugin.md`、`mcp-bundle.md`）。

这是**唯一的一手权威**。本仓库的规约是在它之上叠加"发布隔离"的取舍，凡冲突处以下面记录为准。**升级 dsh 后请重读这几份文件**（路径随版本可能变化，用 `Get-ChildItem <dsh>\node_modules\@deepseek-ai\dsh-agent-preset\skills` 定位）。

### 15.1 重载与重启（官方明文，决定"改完要不要重启"）

`references/host-plugin.md` 末尾原文：

> Inspect saved-state and activation outcomes separately: `failed` requires diagnosis, `overridden` means a higher-priority layer wins, and `restart-required` means the change is not live. **Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation.** Do not infer updated browser code from an unchanged slot id.

落到操作上：

| 改了什么 | 是否需要重启 Host |
| --- | --- |
| 新增一个 bundle（此前从未装过） | ❌ 可通过 HMR 激活 |
| 客户端 bundle（`lib/client.js`） | ❌ Host 不用重启，浏览器硬刷新即可 |
| 配置 / patch 层 / 条目增删禁用 | ❌ `dsh-hmr` 重组层 |
| **替换已安装包的宿主 JS（`lib/index.js`）** | ✅ **必须重启**（"fresh JavaScript module generation"） |

**为什么它不热**（代码层，便于自查）：`cordis-plugin-loader` 用裸路径 `import()`（相对路径 `import(new URL(name, baseUrl).href)`、包名 `import(resolve(name))`），**无任何 cache-busting**；`internal/update` 的 "reload" 只是拿已缓存的模块命名空间重新 `apply`；`dsh-app-boot` 虽通过原生插件访问 Node 内部 ESM loader，但只用于**解析路由**（拦截 `resolveSync`）与特性探测（`getOrCreateModuleJob` 仅出现在 `modern` 判断里），**从不失效 module job**。

**本机实测（2026-11-09）**：替换 `dsh-ability-strip` 0.3.0 → 0.4.0 后硬刷新，客户端已是 0.4.0（新警示标出现），但新增的 `GET /api/ability-strip/events` 仍 404、旧的 `POST /api/ability-strip` 正常 200 → 宿主仍是旧模块代际。

**另一次与之冲突的观察（2026-11-11，未归因，口径不变）**：装 `dsh-turn-stats` 0.1.1 → 0.2.0（宿主 `lib/turn-stats.js` 变了、投影 `stateVersion` 1→2）后，在**未重启**的进程里就读到了只有新代码才能产出的投影 `ver 2`（当时 `ps` 显示 dsh `etimes 973`，容器内只有一个 node 进程、无 worker 可归因）。可上面那条代码层解释并没有被推翻：loader 仍是裸 `import(name)`、无 cache-busting，且 `node_modules/<包>` 是**真实目录而非版本化软链**（换版本不换路径，所以"路径变了才拿到新代码"这个假说不成立）。**两条都是实测，谁也没被解释掉**，因此：本表的"必须重启"**维持不变**，也不为此追加调查（用户 2026-11-11 裁决：接受每次重启的代价）。细节与反证出处见 `dsh-turn-stats/HANDOFF.md`「安装与实测证据（0.2.0）」第 2 条。

**`plugin_manager` 的 `restart-required` 不能当作唯一依据**（同日实测）：两次替换已装包（含宿主 JS 变化的 0.2.0）都只回 `application: "applied"`、`warnings: []`，**没有**报 `restart-required`。所以 15.2 那句"官方 API 会直接给出"要按"给了就信、没给不代表不用重启"来用。

> **判别法**：不要靠日志或进程列表猜，**探测只有新代码才有的路由/行为**。官方 API（`plugin_manager`）会直接给出 `restart-required`，见 15.2。

### 15.2 官方安装入口（我们没在用）

`references/host-plugin.md`：

> `plugin_manager` `install_bundle` performs package installation and bundle selection; do not reproduce those steps with shell commands.

`SKILL.md`：

> use `plugin_manager` with `action: install_bundle` and **the absolute package directory** as `target` …
> Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps

要点：
- 官方入口是 **`plugin_manager install_bundle`，传包目录**，返回 `application` / `warnings` / `restart-required`，**用它判断是否生效**。
- 目录安装 = **链接**（`host-plugin.md`：「Local directory installation links the checkout instead… `files` does not filter a linked directory」）。也就是说官方本地开发循环就是链接源码、改完即生效。
- `set_plugin` / `set_bundle` 开关；`remove_bundle` 移除。`failed` 要诊断、`overridden` 表示被更高优先级层覆盖、`restart-required` 表示未生效。

**我们为什么仍用 `dsh plugin --profile web add <tarball>`**：本仓库要求发布与源码物理隔离（§0），而官方目录安装是链接。用 tarball 能同时满足隔离与可回滚。代价：拿不到官方的 `restart-required` 信号，只能靠 15.1 的判别法自查。**如果你只是做本地快速迭代**，用官方 `install_bundle`（链接）更顺手——但要接受"改源码即改线上"。

### 15.3 客户端不得 require Harness Client 包（**已于 0.5.0 对齐**）

`references/practices.md`：

> **Do not `require('@deepseek-ai/dsh-client-ui-primitives')`** or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and **a throwing component blanks your slot entry** (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin … Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references …

**曾经的状态**：`dsh-ability-strip/lib/client.js` 曾 `require` 它（用 `ui.Button`/`ui.Tag`/`ui.Modal`/`ui.Icon*`），与官方这条明确冲突。它能运行，但风险是官方点名的：0.2.2 就把 `ui-primitives`/`dockkit`/`slots`/`store` 四个包合并进了 shell，模块表恰好还暴露这些名字才没炸。

**0.5.0 已偿还**：该 bundle 现在自带 UI kit（`Icon`/`Tag`/`Button`/`Modal` + 10 条图标 path），`require` 面收敛为 `["react","react-dom"]`，色彩只引用 `--dsw-alias-*`。做法与残留代价见 `dsh-ability-strip/HANDOFF.md` §7.5。

**已固化为检查**（这条规则不再靠人记）：`dsh-ability-strip/scripts/check-bundle-contract.mjs` 的基线允许表只留 React，并单列断言——`require` 里出现任何 `@deepseek-ai/*` 即失败，失败信息带官方出处。**新插件照此实现自己的检查。**

**写 theme token 时的坑**：`--dsw-alias-*` 定义在 `<body>` 上并向 composer dock 继承，在 `document.documentElement` 上查是**空的**。要在真实渲染元素上读 `getComputedStyle` 才看得到（真机验证过：`document.body` 有值，`:root` 没有）。

> 注意区分：`dsh.client.inject`（在 `package.json` 里声明模块）**仍是允许的**，它只影响激活顺序；被禁的是运行时 `require(...)` 那个包。


### 15.4 不要轮询，等事件（支持把定时器换成事件推送）

`references/practices.md`：

> **The framework drives; the plugin computes.** Session projections, Conversation assembly, and slot rendering subscribe, cache, and publish for you. A plugin that subscribes, rescans, or writes DOM itself bypasses that incremental machinery.
>
> Wait on durable events such as `turn/end`, `assistant/message`, or `tool/result`… **Do not poll `agent/status`.**

结论：官方整体取向是"等事件、别轮询"，所以 `dsh-ability-strip` 0.4.0 把 15 秒定时器换成变更推送，**方向与官方一致**。

但要如实说明一处限定：官方理想路径是**框架转发事件**（`ctx.remote.$on`），而 `@deepseek-ai/dsh-api-remotes` 的转发白名单 `API_REMOTE_FORWARDED_EVENTS` 是**核心包内的封闭静态数组（30 条）**，**不含 `tools/change`**，也没有对外追加 API；同一进程里唯一的事件源槽位 `typertGateway.registerRemoteEvents` 已被该包占用（重复注册直接抛错）。所以自建 SSE 通道是**对框架缺口的补偿**，不是官方推荐形态——它用到了 15.6 的能力，但要知道这属于"官方没覆盖的空白"。

### 15.5 本仓库与官方的偏离总表

| 主题 | 官方做法 | 本仓库做法 | 为什么偏离 | 代价 |
| --- | --- | --- | --- | --- |
| 安装形态 | 目录安装（= 链接源码） | tarball 拷贝 / git 源 | 发布与源码物理隔离、可回滚 | 放弃"改完即生效"的官方开发循环 |
| 安装入口 | `plugin_manager install_bundle` | `dsh plugin --profile web add` | 同上（官方入口是链接） | 拿不到官方 `restart-required` 信号 |
| 客户端依赖 | 禁止 `require` Harness Client 包 | **已对齐**：自带控件 + 仅 `--dsw-alias-*` token（0.5.0） | 官方明文禁止 | 控件外观不随宿主升级演进 |
| 刷新机制 | 等框架转发的事件 | 自建 SSE 通道 | `tools/change` 不在转发白名单 | 多用一条 HTTP 连接；属官方空白区 |

### 15.6 官方推荐的排查顺序（照它做，省时间）

`SKILL.md`「Knowledge sources, in order」：

1. **Inspection**：`cordis_inspect_query`（`Service` / `Event` / `Config` / `Tool` / `Slots` / `Theme`）；
2. **Package documentation**：`Config.listConfigs` 拿 `packageDir` → 读该包 `README.md`；
3. **Source**：安装包只有 `lib/index.js` + `lib/types/**/*.d.ts`（带 JSDoc），源码 checkout 才有 `src/`。**从具体的安装或运行失败出发**做源码级诊断，不要一上来就考古。

另外 `SKILL.md` 还有两条与本仓库直接相关：

> Changes affect every session in that profile and survive restart.

> Every `plugin_manager` action … also needs approval without Full access, so call it only when its result decides the next step.

### 15.7 换行、哈希与 `verify-pack`（踩过一次坑）

**现象**：安装 0.4.0 后复核，安装副本的 `lib/index.js` 与工作区**哈希不一致**（`lib/client.js` 却一致）。排查结论：

- 本机 `core.autocrlf = true`，git 在提交/rebase 时把工作区写成 **CRLF**；而 tarball 里该文件是 **LF**。
- 两者**归一化换行后内容完全相同**（哈希 `E3E8BDD6FBB46C92` 一致），文件反而变大（15557 → 15952 B，多出 395 个 `\r`）。
- 后果不是功能问题（JS 不关心换行），而是**证据链假失败**：`verify-pack` 逐字节比对会报 `CONTENT DIFFERS`，HANDOFF 里当证据的哈希也会因机器/检出方式而漂移。

**已做的修复**：

1. 新增 `.gitattributes`：`* text=auto eol=lf`，让工作区在**所有平台**都与仓库 blob 一致，二进制（`*.png` 等）不参与换行转换。
2. `verify-pack.mjs` 的 `sameText` 扩展为**忽略换行风格 + 末尾换行**；`exact` 仍严格比对字节，命中时仍会显示 `exact`。

**遗留与注意**：

- 本次没有强行把已存在的工作区文件重排为 LF（`git checkout-index` 不会重写内容等价的文件）。所以**当前这棵工作区仍是 CRLF**，而 tarball 混了两种形式（`client.js` 为 CRLF、`index.js` 为 LF）。
- 因此：**HANDOFF 里的哈希记录各自对应其 tarball 的实际形式，跨换行比较会不一致**。核对哈希时要么按 LF 归一，要么用 `verify-pack`（它已忽略换行）。
- 新克隆/新机器会得到干净的 LF 工作区；下一次发版打出的 tarball 也是纯 LF，之后的哈希记录才真正稳定。

---

## 16. 维护前先拉取（多会话、多机器同时改同一个仓库）

**铁律：动手改任何文件之前，先 `git pull`。**

这个仓库不是单人单会话在写。同一台机器上可能有多个 DSH 会话在改不同插件，多台机器也在推同一个
`main`。仓库本身是共享的、不是谁的私有工作区，所以"我这边好好的"不构成不拉取的理由。

### 16.1 开工三步

```powershell
cd dsh-plugins
git pull --ff-only origin main      # 先同步；报错说明有本地提交，见 16.3
git status --short                  # 应当没有任何输出；有输出先弄清是谁的改动
node scripts/check-all.mjs          # 拉到的代码本身是绿的，再动手
```

先跑一次 `check-all` 的意义：**把"别人的红"和"你引入的红"分开**。不先取基线，出了问题无法判断是谁改坏的。

### 16.2 提交前再同步一次

```powershell
git fetch origin main
git log --oneline HEAD..origin/main    # 有输出=别人又推进了，先整合再推
```

只 `git pull` 一次是不够的：从开工到提交之间别人可能已经推了。

### 16.3 push 被拒时怎么做（2026-11-09 本机真实发生过两次）

```
! [rejected]  main -> main (fetch first)
hint: Updates were rejected because the remote contains work that you do not have locally.
```

处理顺序，**不要跳步**：

1. `git fetch origin main`
2. `git log --oneline HEAD..origin/main` —— 看清别人新增了哪些提交
3. `git diff --stat HEAD...origin/main` —— 看清涉及哪些文件（共享文档冲突概率最高）
4. `git rebase origin/main`
5. 冲突**取并集**：两边的新增都要保留，禁止整块用自己的覆盖。
6. 冲突解决后**必须验证双方成果都在**：对方新增的文件存在、对方插件的检查仍通过、自己的检查仍通过
7. 再 push

**绝不 `git push --force`。** 那会抹掉别人已经推上去的提交，是不可逆的破坏。

### 16.4 两次真实事故（照抄下来的教训）

| 日期 | 场景 | 结果 |
| --- | --- | --- |
| 2026-11-09 | 另一个会话先推了 `dsh-read-img`（2 个提交），我这边也没拉就推 | `rejected (fetch first)`；`git diff HEAD...origin/main` 显示对方也改了 `INSTALL.md` / `README.md`；rebase 后冲突在 §14 的插件清单，取并集（保留对方的 `dsh-read-img` 链接 + 我的 §15），复核三个插件齐全、双方检查都通过才推 |
| 2026-11-09 | 同一时段另一次推送 | 同样 `rejected`；说明这不是偶发，是多人并发改同一仓库的常态 |

两次都没有丢数据，靠的是"fetch → 看清差异 → rebase → 取并集 → 双向验证"，而不是靠手快。

### 16.5 拉取不会破坏已发布的产物

`dist/` 与 `*.tgz` 都在 `.gitignore` 里，**不在版本控制内**。所以 `git pull` 永远不会覆盖、删除任何机器上
已经打好的 tarball，也不会改动 `$DSH_HOME` 下的 profile。拉取只影响源码与文档。

这也是"发布用 tarball + 源码与安装副本物理隔离"（§0）带来的额外好处：同步和发布是两件互不干扰的事。

### 16.6 共享文件的额外注意

`README.md` 与 `INSTALL.md` 是改动最频繁、冲突概率最高的两个文件。改它们之前**先 pull**，
改完尽快提交推送，缩短冲突窗口。插件目录内的文件只由负责该插件的会话改，冲突面小得多。

### 16.7 文档不要写死本机路径

本仓库**多机器同步：一台 Windows、一台 Linux**。所以这里的每个文件都会同时出现在两种布局下，
任何一台机器的绝对路径，在另一台机器上要么不存在，要么指到别的东西。

**规则：文档与脚本里的路径一律用可移植表述，不写本机绝对路径。**

| 场景 | 写法 | 不写 |
| --- | --- | --- |
| profile 目录 | `$DSH_HOME/profiles/<profile>/`（POSIX 同式：`${DSH_HOME:-$HOME/.dsh}/profiles/<profile>`） | `/data/profiles/web/`、`C:\Users\<你>\.dsh\profiles\web\` |
| dsh 安装树 | `<dsh 安装目录>/node_modules/@deepseek-ai/...`，具体值用 `npm root -g` 取 | `/opt/conda/lib/node_modules/...`、`D:\Program\nvm\...\node_modules\...` |
| 仓库自身 | 仓库内**相对路径**（`../INSTALL.md`） | `D:/Users/.../dsh-plugins/...`、`/workspace/...` |
| 脚本默认值 | `process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh")` | `process.env.DSH_HOME ?? "/data"` |

`DSH_HOME` 的官方默认值是 **`~/.dsh`（各平台一致）**，不是 `/data`。脚本里写 `/data` 是把某台机器的
布局当成规范：换机器就指错目录，还会把「这台机器没装」误报成「索引写错了」。

**历史记录是例外，但必须标明环境。** 实测证据要写清是在哪台机器/什么环境量的，读者才知道能不能套用：

- ✅ `2026-11-11 在 Linux 容器（/data/profiles/web）实测：...`
- ❌ `2026-11-11 实测：...`（读者在另一台机器复现不出来，会以为文档错了或自己装漏了）

这类记录**不需要回头重写**——它是当时的事实留档。要改的是**新写的**内容：命令、默认值、待办清单
这类会被照着执行的，必须机器无关；只有「当时确实在这个路径下做的」这种叙事，才允许出现绝对路径，
并附上环境。**判断标准：读者会不会照着敲？会，就不能写死。**

**闸门已经机器无关**：`scripts/check-all.mjs` 的「已装版本」列，本机装了才逐字核对；本机没装只
**出声提示**（`注：<包名>: 本机未装 ...，已装列 <版本> 未核对`），不判红。因为它核的是
「发布/实测那台机器」的值，本机没装不等于索引错。
