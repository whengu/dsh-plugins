/**
 * Static checks — the `pnpm check` gate.
 *
 * Deliberately dependency-free: it never imports `lib/index.js`, because that
 * module imports host packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`)
 * that only resolve inside a dsh installation. Syntax is checked with
 * `node --check`, which parses without resolving imports.
 *
 * What it covers:
 *   1. every `lib/*.js` parses;
 *   2. `package.json` declares the bundle contract and whitelists every file
 *      the plugin needs at runtime;
 *   3. `cordis.patch.yml` inserts exactly one entry whose name is the package
 *      name, and whose id matches the profile config block.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

// --- 1. syntax -------------------------------------------------------------
const libFiles = readdirSync(join(root, "lib")).filter((name) => name.endsWith(".js"));
check(libFiles.length > 0, "lib/ 下没有任何 .js 文件");
for (const file of libFiles) {
  try {
    execFileSync(process.execPath, ["--check", join(root, "lib", file)], { stdio: "pipe" });
  } catch (error) {
    problems.push(`lib/${file} 解析失败：${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
  }
}

// --- 2. package contract ---------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
check(pkg.name === "dsh-read-img", `包名应为 dsh-read-img，实际 ${pkg.name}`);
check(typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version), "version 必须形如 x.y.z");
check(pkg.type === "module", 'type 必须是 "module"');
check(pkg.main === "lib/index.js", "main 必须是 lib/index.js");
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch 缺失或指向错误（缺了只装不加载）");
const dshRange = typeof pkg.engines?.dsh === "string" ? pkg.engines.dsh.trim() : "";
check(dshRange.length > 0, "engines.dsh 必须声明");
// A lower bound only. An upper bound (or `^` / `~`) makes the dsh version gate
// refuse every future major at install time: `>=0.2.0-rc.2 <0.3.0` rejected
// dsh 0.3.x outright, and dsh ignores peerDependencies once engines.dsh exists,
// so this one string would decide the upgrade alone.
check(
  /^>=\s*[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(dshRange),
  `engines.dsh 必须是单一下限（形如 >=0.2.0-rc.2），实际 "${dshRange}"；上界会在下次大版本升级时直接拒绝安装`,
);
check(pkg.exports?.["."] === "./lib/index.js", 'exports["."] 必须指向 ./lib/index.js');
check(pkg.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml", 'exports["./cordis.patch.yml"] 缺失');

const required = [
  "lib/index.js",
  ...libFiles.filter((name) => name !== "index.js").map((name) => `lib/${name}`),
  "cordis.patch.yml",
  "README.md",
];
for (const file of required) {
  check(Array.isArray(pkg.files) && pkg.files.includes(file), `files 白名单缺少 ${file}（打包会缺文件）`);
}

// --- 3. bundle patch contract ---------------------------------------------
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const ids = [...patch.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)].map((match) => match[1]);
const names = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1]);
check(ids.length === 1, `cordis.patch.yml 应只有 1 个 entry，实际 ${ids.length}`);
check(ids[0] === "read-img", `entry id 应为 read-img，实际 ${ids[0]}`);
check(names[0] === pkg.name, `entry name 应为 ${pkg.name}，实际 ${names[0]}`);

// --- report ----------------------------------------------------------------
if (problems.length > 0) {
  console.error(`check 失败（${problems.length} 项）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check 通过：${libFiles.length} 个 lib 文件语法正常，包契约与 patch 契约一致（${ids[0]} / ${pkg.name}）。`);
