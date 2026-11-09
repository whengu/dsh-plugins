/**
 * Run every plugin's own checks from the repository root.
 *
 * Each plugin owns its verification: `scripts/check*.mjs`, `test/*.test.mjs`, and
 * a `check` entry in its `package.json`. This script only discovers the plugins and
 * delegates, so a plugin that adds a check gets it run here without a second list
 * to keep in sync.
 *
 * Usage: node scripts/check-all.mjs [--quiet]
 *
 * Exit code is 0 only when every plugin passes. The summary at the end names each
 * plugin and its outcome, because a wall of passing output hides the one failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

const failed = outcomes.filter((outcome) => outcome.ok !== true);
console.log("\n=== summary ===");
for (const outcome of outcomes) {
  console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${outcome.name}  (${outcome.note})`);
}
console.log(failed.length === 0 ? "\nRESULT: PASS" : `\nRESULT: FAIL (${failed.length} plugin(s))`);
process.exit(failed.length === 0 ? 0 : 1);
