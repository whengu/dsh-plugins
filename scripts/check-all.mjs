/**
 * Run every plugin's own checks from the repository root, plus the two repo-level
 * tables no plugin owns.
 *
 * Each plugin owns its verification: `scripts/check*.mjs`, `test/*.test.mjs`, and
 * a `check` entry in its `package.json`. This script only discovers the plugins and
 * delegates, so a plugin that adds a check gets it run here without a second list
 * to keep in sync.
 *
 * It then checks the README plugin index against reality (see `checkPluginIndex`),
 * because per-plugin checks cannot see a table in the root README.
 *
 * Usage: node scripts/check-all.mjs [--quiet]
 *   Env: DSH_HOME (default <home>/.dsh) and DSH_PROFILE (default web) locate the
 *   profile whose installed versions the index must match. Absent → that column is
 *   skipped out loud rather than guessed at. Nothing here hardcodes a machine: the
 *   repository is shared across machines (INSTALL.md §16), so "not installed here"
 *   is a note, not a failure.
 *
 * Exit code is 0 only when every plugin passes. The summary at the end names each
 * plugin and its outcome, because a wall of passing output hides the one failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

/** Directories that hold a package but are not plugins. */
const NOT_A_PLUGIN = new Set(["node_modules", "dist", "profile-backups", ".git", "scripts"]);

/** Plugin package directories: a child directory with its own package.json. */
function findPlugins() {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_A_PLUGIN.has(entry.name))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")))
    .sort();
}

/**
 * The README plugin index must match reality, in both directions.
 *
 * This gate used to print RESULT: PASS while the index said `0.5.0` for a plugin
 * that was really at `0.16.2`, and while a whole plugin row was missing — a table
 * in the root README is invisible to every plugin's own checks. Two rules, one per
 * column, because only one of them is checkable everywhere:
 *
 *  - 「版本（源码）」 must equal that plugin's `package.json` — works on any machine.
 *  - 「已装版本」 (the bolded reading) must equal the version installed under the
 *    profile's `node_modules`. A developer box or CI without that profile cannot
 *    measure it, so the column is skipped **out loud** (see `notes`), never silently.
 *
 * @param {string[]} plugins plugin directories discovered by `findPlugins`
 */
function checkPluginIndex(plugins) {
  const problems = [];
  const notes = [];
  const readmePath = path.join(root, "README.md");
  if (fs.existsSync(readmePath) === false) {
    return { problems: ["README.md 不存在，插件索引无从核对"], notes };
  }

  // Rows whose first cell is `[name](dir/)` — the trailing slash is what separates
  // an index row from the documentation-map table above it.
  const rows = fs
    .readFileSync(readmePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\|\s*\[[^\]]+\]\([^)/]+\/\)\s*\|/.test(line))
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  const rowByDir = new Map();
  for (const cells of rows) {
    const link = /^\[([^\]]+)\]\(([^)/]+)\/\)/.exec(cells[0]);
    if (link !== null) rowByDir.set(link[2], cells);
  }
  if (rowByDir.size === 0) return { problems: ["README 里解析不出任何插件索引行，核对需随表结构更新"], notes };

  // DSH_HOME 的默认值是 `~/.dsh`（各平台一样），不再是写死的 `/data` —— 那是某台机器的
  // 布局，换机器就指错目录，还会把「这台机器没装」误报成索引错。
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  const installedRoot = path.join(dshHome, "profiles", process.env.DSH_PROFILE ?? "web", "node_modules");
  const canMeasure = fs.existsSync(installedRoot);
  if (canMeasure === false) {
    notes.push(`已装列未核对：本机没有 ${installedRoot}（换机器 / CI 属正常，只核对了源码列）`);
  }

  for (const dir of plugins) {
    const name = path.basename(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const cells = rowByDir.get(name);
    if (cells === undefined) {
      problems.push(`${name}: README 插件索引缺这一行`);
      continue;
    }
    const sourceCell = cells[2] ?? "";
    if (sourceCell !== manifest.version) {
      problems.push(`${name}: 索引「版本（源码）」= ${sourceCell || "(空)"}，实际 package.json = ${manifest.version}`);
    }
    const claimed = /\*\*([^*]+)\*\*/.exec(cells[3] ?? "");
    if (canMeasure === false) continue;
    const installedPath = path.join(installedRoot, manifest.name, "package.json");
    if (fs.existsSync(installedPath) === false) {
      // 本仓库多机器同步（见 INSTALL.md §16）：这一列记的是「发布 / 实测那台机器」的已装值。
      // 本机没装不等于索引写错了，只是这台机器无从核对——与上面 canMeasure 缺失同款处理，
      // 出声说明而不是猜。装了的机器仍然逐字核对（下面两行），那条不受影响。
      if (claimed !== null) {
        notes.push(`${name}: 本机未装（${installedRoot} 下没有该包），已装列 ${claimed[1]} 未核对`);
      }
      continue;
    }
    const installed = JSON.parse(fs.readFileSync(installedPath, "utf8")).version;
    if (claimed === null) problems.push(`${name}: 已装列读不出加粗版本号（应形如 **0.2.0**），无法与实测 ${installed} 核对`);
    else if (claimed[1] !== installed) problems.push(`${name}: 索引「已装版本」= ${claimed[1]}，profile 实测 = ${installed}`);
  }

  for (const dir of rowByDir.keys()) {
    if (fs.existsSync(path.join(root, dir)) === false) problems.push(`索引指向不存在的目录 ${dir}/`);
  }
  return { problems, notes };
}

/**
 * Run one command, streaming its output straight through.
 *
 * `stdio: "inherit"` rather than a pipe: a pipe round-trip through the runtime can
 * be refused outright, and the point of this script is to show the real output.
 * `shell` is required on Windows, where npm is a `.cmd` shim.
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: true });
  return { ok: result.status === 0, status: result.status };
}

const plugins = findPlugins();
if (plugins.length === 0) {
  console.error("no plugin package found");
  process.exit(1);
}

const outcomes = [];
for (const dir of plugins) {
  const name = path.basename(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};
  const declared = scripts.check;

  if (quiet !== true) console.log(`\n=== ${name} ===`);
  if (declared === undefined) {
    outcomes.push({ name, ok: false, note: "package.json has no `check` script" });
    continue;
  }
  // `npm run` rather than re-deriving the command: the package's own script is the
  // single source of truth for how that plugin is verified.
  let failedStep;
  if (run("npm", ["run", "check", "--silent"], dir).ok !== true) {
    failedStep = "check";
  } else if (scripts.test !== undefined && !scripts.check.includes("test")) {
    // A plugin may keep syntax/contract checks and behaviour tests in separate
    // scripts; a gate that runs only `check` would miss a red suite. `test` is run
    // when it means something other than what `check` already covered — `check`
    // containing the word "test" is how a plugin says "mine already does".
    // `test:live`-style opt-in scripts are deliberately not run.
    if (run("npm", ["test", "--silent"], dir).ok !== true) failedStep = "test";
  }
  outcomes.push({
    name,
    ok: failedStep === undefined,
    note: failedStep === undefined ? "check passed" : `${failedStep} failed`,
  });
}

// Repo-level table check: the index is documentation, so no plugin can police it.
const index = checkPluginIndex(plugins);
for (const note of index.notes) console.log(`\n注：${note}`);
if (index.problems.length > 0) {
  console.log("\n=== README 插件索引 ===");
  for (const problem of index.problems) console.log(`  ✗ ${problem}`);
}
outcomes.push({
  name: "README 插件索引",
  ok: index.problems.length === 0,
  note: index.problems.length === 0 ? "源码列与已装列均与实测一致" : `${index.problems.length} 处与实测不符`,
});

const failed = outcomes.filter((outcome) => outcome.ok !== true);
console.log("\n=== summary ===");
for (const outcome of outcomes) {
  console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${outcome.name}  (${outcome.note})`);
}
console.log(failed.length === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failed.length} plugin(s))`);
process.exit(failed.length === 0 ? 0 : 1);
