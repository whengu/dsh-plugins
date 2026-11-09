/**
 * Opt-in live test: drives the real vision endpoint.
 *
 *   VISION_BASE=http://... VISION_KEY=... VISION_MODEL=group/vision \
 *     node --test test/live.test.mjs
 *
 * Skipped entirely when the environment is not configured, so `npm test`
 * stays offline and deterministic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../lib/cache.js";
import { createReader, DEFAULTS, normalizeConfig } from "../lib/index.js";

const base = process.env.VISION_BASE;
const key = process.env.VISION_KEY;
const model = process.env.VISION_MODEL;

const enabled = Boolean(base && model);
const skip = enabled ? false : "set VISION_BASE/VISION_KEY/VISION_MODEL to run the live test";

test("live: read_img describes the bundled fixture", { skip }, async () => {
  const config = normalizeConfig({ ...DEFAULTS, baseURL: base, apiKey: key ?? "", model });
  const read = createReader({ getConfig: () => config, cache: new LruCache(4) });
  const fixture = new URL("./fixtures/red-square.png", import.meta.url).pathname;

  const answer = await read({ path: fixture, question: "这张图里有哪些颜色？分别在什么位置？" }, {});
  assert.ok(answer.length > 10, "answer should not be empty");
  assert.match(answer, /\(image: /);
  console.log("live answer:", answer.slice(0, 200).replace(/\n/g, " "));
});
