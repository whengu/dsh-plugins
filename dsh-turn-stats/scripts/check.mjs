/**
 * Package contract check (no dependencies, runs in a clean checkout).
 *
 * Every rule here is something that fails *silently* or *at activation* in the
 * app, i.e. exactly the class of mistake a reviewer skims past:
 *
 * - `package.json` unparseable → Node refuses the whole package directory with
 *   `Invalid package config`, and the message names the file, not the mistake.
 * - a missing `priority` on the shadowing registrations → the slot registry
 *   throws at registration and the plugin never activates.
 * - an unbalanced locale dictionary → the typed `locale.register` rejects it.
 * - a client `require` of a Harness package → sanctioned only as a copy; an
 *   import throws at render and blanks the slot entry.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/** @param {boolean} ok @param {string} claim */
function assert(ok, claim) {
  if (!ok) problems.push(claim);
}

/** @param {string} relative @returns {string} */
const text = (relative) => readFileSync(join(root, relative), "utf8");

// 1. Syntax of everything that ships.
const LIB_FILES = ["lib/index.js", "lib/turn-stats.js", "lib/client.js"];
for (const file of LIB_FILES) {
  assert(existsSync(join(root, file)), `缺少 ${file}`);
  try {
    execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
  } catch (error) {
    problems.push(`${file} 语法错误：${String(error.stderr ?? error).split("\n")[0]}`);
  }
}

// 2. package.json parses and its declared surface matches the files on disk.
let manifest;
try {
  manifest = JSON.parse(text("package.json"));
} catch (error) {
  problems.push(`package.json 不是合法 JSON：${error.message}`);
}
if (manifest !== undefined) {
  assert(manifest.name === "dsh-turn-stats", `package.json name 应为 dsh-turn-stats，实为 ${manifest.name}`);
  assert(/^\d+\.\d+\.\d+$/.test(String(manifest.version)), `version 应为三段数字，实为 ${manifest.version}`);
  for (const file of manifest.files ?? []) {
    assert(existsSync(join(root, file)), `files 白名单里的 ${file} 不存在`);
  }
  for (const file of LIB_FILES) {
    assert((manifest.files ?? []).includes(file), `${file} 未列入 files 白名单，打包后会缺文件`);
  }
  assert(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch 应指向 ./cordis.patch.yml");
  assert(manifest.dsh?.client?.platform === "web", "dsh.client.platform 应为 web");
  assert(manifest.exports?.["./client"] === "./lib/client.js", 'exports["./client"] 应指向 ./lib/client.js');
}

// 3. The bundle patch inserts this plugin under the id the client half expects.
const patch = text("cordis.patch.yml");
assert(/- insert:/.test(patch), "cordis.patch.yml 必须走 insert，不要整段覆盖宿主配置");
const patchName = /name:\s*'([^']+)'/.exec(patch)?.[1];
assert(patchName === manifest?.name, `patch 的 name (${patchName}) 与包名 (${manifest?.name}) 不一致`);
assert(/id:\s*turn-stats/.test(patch), "patch 的 id 应为 turn-stats");

// 4. The two load-bearing registration facts.
const client = text("lib/client.js");
const registrations = [...client.matchAll(/ctx\.slots\.register\(\s*\{[\s\S]*?\},\s*([A-Za-z]+)\s*,?\s*\)/g)];
assert(registrations.length === 2, `应有 2 处 slots.register，实为 ${registrations.length}`);
for (const match of registrations) {
  const options = match[0];
  assert(/priority:\s*SHADOW_PRIORITY/.test(options), `${match[1]} 的注册缺 priority：同 id 同 priority 会在注册时抛错，插件不激活`);
  assert(/order:\s*\d/.test(options), `${match[1]} 的注册缺 order：位置由 order 决定`);
  assert(/locale:\s*NS/.test(options), `${match[1]} 的注册缺 locale，组件收不到 t`);
}
assert(!/require\(["']@deepseek-ai\//.test(client), "client.js 不得 require 任何 Harness 包（practices.md:35）");
assert(!/require\(["'](?!react|react-dom)/.test(client.replace(/require\("react-dom"\)/g, "")), "client.js 的 require 面只能是 react / react-dom");
assert(client.includes("window.__ModuleLoader__.load"), "client.js 必须是 lazy-CJS bundle 形态");

// 5. Locale dictionaries must be balanced: the typed register requires both
//    baseline locales and rejects a dictionary missing a key the other has.
function dictionaryKeys(source, locale) {
  const start = source.indexOf(`${locale}: {`);
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  // Keys sit at the block's shallowest indentation; hard-coding a tab count
  // would make this check break on a reformat instead of on a real mismatch.
  const body = source.slice(start, end);
  const indents = [...body.matchAll(/^(\t+)(\w+):/gm)].map((match) => match[1].length);
  const shallowest = indents.length > 0 ? Math.min(...indents) : 0;
  return [...body.matchAll(new RegExp(`^\\t{${shallowest}}(\\w+):`, "gm"))].map((match) => match[1]).filter((key) => key !== "zh" && key !== "en");
}
const zh = dictionaryKeys(client, "zh");
const en = dictionaryKeys(client, "en");
assert(zh.length >= 2 && en.length >= 2, `DICTIONARIES 解析不出文案键（zh=${zh.length}, en=${en.length}），check 需随结构更新`);
assert(JSON.stringify(zh.slice().sort()) === JSON.stringify(en.slice().sort()), `zh/en 文案键集合不一致：zh=[${zh}] en=[${en}]`);
for (const key of ["speed", "cacheHit"]) assert(zh.includes(key), `缺少 ${key} 文案`);

if (problems.length > 0) {
  console.error("check 失败：");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(`check 通过：${LIB_FILES.length} 个 lib 文件语法正常；包契约、patch 契约、双注册参数、双语平衡均一致。`);
