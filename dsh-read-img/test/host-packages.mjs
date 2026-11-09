/**
 * Host packages for the tests (test-only; nothing here ships with the plugin).
 *
 * `lib/index.js` imports `@deepseek-ai/schemastery` (config schema) and
 * `@deepseek-ai/dsh-tools` (`defineTool`). Neither is a dependency of this
 * package: dsh supplies both at runtime — every profile bundle is loaded with
 * the installation's dependency tree added to Node's resolvers — which is why
 * `package.json` lists them as *optional peers* and `engines.dsh` gates the
 * runtime instead. A clean checkout therefore has no `node_modules`, and a bare
 * `import "../lib/index.js"` fails with ERR_MODULE_NOT_FOUND.
 *
 * This module locates the installed dsh and aliases exactly those two bare
 * specifiers to the files inside it, so the tests exercise the real host modules
 * while `lib/` stays untouched. Not a skip and not a stub: if the packages cannot
 * be found the run fails, with the search path and the remedy in the message.
 *
 * Search order (cheap checks only, no network, no install):
 *   1. `DSH_HOST_DIR` — the installed `@deepseek-ai/dsh` package directory.
 *   2. node's own global module roots: `<node dir>/node_modules` (Windows) and
 *      `<node dir>/../lib/node_modules` (POSIX).
 *   3. the same two roots below every PATH entry, which covers nvm and pnpm
 *      launchers whose binaries sit outside the module tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The installation that supplies the host packages. */
const HOST_PACKAGE = "@deepseek-ai/dsh";

/** Bare specifiers `lib/index.js` imports from the host. */
const HOST_MODULES = ["@deepseek-ai/schemastery", "@deepseek-ai/dsh-tools"];

/** Every node_modules directory a global install may have put them in. */
function globalModuleRoots() {
  const roots = [];
  const nodeDir = dirname(process.execPath);
  roots.push(join(nodeDir, "node_modules"));
  roots.push(join(nodeDir, "..", "lib", "node_modules"));
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (entry.length === 0) continue;
    roots.push(join(entry, "node_modules"));
    roots.push(join(entry, "..", "lib", "node_modules"));
    roots.push(join(entry, "..", "node_modules"));
  }
  return roots;
}

/**
 * Package directory of the installed dsh.
 * @returns {string} absolute path; throws when the installation is not on any known root.
 */
function findHostPackageDir() {
  const tried = [];
  const override = process.env.DSH_HOST_DIR;
  if (override !== undefined && override.length > 0) {
    const dir = resolve(override);
    if (existsSync(join(dir, "package.json"))) return dir;
    tried.push(`${override}（来自 DSH_HOST_DIR）`);
  }
  for (const root of globalModuleRoots()) {
    const dir = join(root, HOST_PACKAGE);
    if (existsSync(join(dir, "package.json"))) return dir;
    tried.push(root);
  }
  throw new Error(
    "test: 找不到 dsh 安装目录。test/plugin.test.mjs 从 dsh 安装里取 " +
      `${HOST_MODULES.join(" 与 ")} 来加载 lib/index.js（插件自身不依赖它们）。\n` +
      "已查找：\n" +
      tried.map((entry) => `  - ${entry}`).join("\n") +
      "\n把 DSH_HOST_DIR 指向已安装的 @deepseek-ai/dsh 包目录后重试，例如：\n" +
      "  DSH_HOST_DIR=<dsh 安装目录>/node_modules/@deepseek-ai/dsh node --test test/plugin.test.mjs",
  );
}

/**
 * Package directory of one host module, seen from the dsh package — the same
 * `node_modules` walk dsh itself performs, so nested and hoisted layouts both work.
 * @param {string} hostPackageDir
 * @param {string} name
 * @returns {string | undefined}
 */
function hostModuleDir(hostPackageDir, name) {
  const anchor = createRequire(join(hostPackageDir, "package.json"));
  for (const nodeModules of anchor.resolve.paths(name) ?? []) {
    const dir = join(nodeModules, ...name.split("/"));
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return undefined;
}

/**
 * The file a bare specifier should load: the `import` condition of its exports,
 * falling back to the default entry — what the plugin's `import` statements get
 * at runtime.
 * @param {string} packageDir
 * @returns {string} absolute path
 */
function entryFile(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const exported = manifest.exports?.["."];
  const target =
    typeof exported === "string"
      ? exported
      : (exported?.import ?? exported?.default ?? exported?.require ?? manifest.module ?? manifest.main);
  if (typeof target !== "string") throw new Error(`test: ${packageDir} 没有可用的入口文件声明`);
  return join(packageDir, target);
}

/**
 * Map each host bare specifier to the file inside the dsh installation.
 * @returns {Record<string, string>} specifier → file URL
 */
export function hostEntryPoints() {
  const hostPackageDir = findHostPackageDir();
  /** @type {Record<string, string>} */
  const entries = {};
  for (const name of HOST_MODULES) {
    const dir = hostModuleDir(hostPackageDir, name);
    if (dir === undefined) {
      throw new Error(
        `test: dsh 安装在 ${hostPackageDir}，但其中找不到 ${name}。` +
          "dsh 依赖缺失或安装不完整；重新安装 dsh 后再跑。",
      );
    }
    entries[name] = pathToFileURL(entryFile(dir)).href;
  }
  return entries;
}

/**
 * Install the aliases for the rest of the process. Call this before importing
 * `lib/index.js` (the import must be dynamic, so it runs after registration).
 * @returns {Record<string, string>} the aliases that were installed
 */
export function registerHostModules() {
  const entries = hostEntryPoints();
  register(new URL("./host-loader.mjs", import.meta.url).href, { data: { entries } });
  return entries;
}
