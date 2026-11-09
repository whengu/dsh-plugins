/**
 * Opt-in live test: drives the real vision endpoint.
 *
 *   VISION_BASE=http://... VISION_KEY=... VISION_MODEL=group/vision \
 *     node --test test/live.test.mjs
 *
 * Without the environment variables the file registers one skipped test and
 * exits 0. Nothing is imported at module scope: `lib/index.js` needs host
 * packages that only the dsh installation provides, so an unconfigured run must
 * reach the skip before it can ever hit a module-resolution error.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const base = process.env.VISION_BASE;
const key = process.env.VISION_KEY;
const model = process.env.VISION_MODEL;

const enabled = Boolean(base && model);
const skip = enabled ? false : "set VISION_BASE/VISION_KEY/VISION_MODEL to run the live test";

test("live: read_img describes the bundled fixture", { skip }, async () => {
  // Loaded here, not at module scope: the skip path must not depend on the host
  // packages being resolvable (see test/host-packages.mjs).
  const { registerHostModules } = await import("./host-packages.mjs");
  registerHostModules();
  const { LruCache } = await import("../lib/cache.js");
  const { createReader, DEFAULTS, normalizeConfig } = await import("../lib/index.js");

  const config = normalizeConfig({ ...DEFAULTS, baseURL: base, apiKey: key ?? "", model });
  const read = createReader({ getConfig: () => config, cache: new LruCache(4) });
  // fileURLToPath, not URL.pathname: on Windows the pathname keeps a leading
  // slash before the drive letter, which no filesystem call accepts.
  const fixture = fileURLToPath(new URL("./fixtures/red-square.png", import.meta.url));

  const answer = await read({ path: fixture, question: "这张图里有哪些颜色？分别在什么位置？" }, {});
  assert.ok(answer.length > 10, "answer should not be empty");
  assert.match(answer, /\(image: /);
  console.log("live answer:", answer.slice(0, 200).replace(/\n/g, " "));
});
