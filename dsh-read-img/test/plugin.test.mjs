import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LruCache } from "../lib/cache.js";
import { readImageFile } from "../lib/image.js";
import { registerHostModules } from "./host-packages.mjs";

// `lib/index.js` imports `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools`,
// which dsh supplies at runtime and this package does not depend on. A clean
// checkout has no node_modules, so alias those two specifiers to the installed
// dsh first (see test/host-packages.mjs) and only then load the plugin.
registerHostModules();
const { apply, createReader, DEFAULTS, MAX_QUESTION_CHARS, normalizeConfig, TOOL_NAME } = await import(
  "../lib/index.js"
);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Escape a literal string for use inside a RegExp (native paths contain `\`). */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fake cordis context that records registered tools. */
function fakeCtx() {
  const registered = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    inject(deps, callback) {
      if (deps.includes("tools")) callback(ctx);
    },
  };
  return { ctx, registered };
}

/** Config normalized once, so the reader sees the same shape as in production. */
function config(overrides = {}) {
  return normalizeConfig({ ...DEFAULTS, apiKey: "k-123", ...overrides });
}

function stubFetch(reply = { choices: [{ message: { content: "a red square" } }] }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { impl, calls };
}

test("normalizeConfig: fills defaults and keeps explicit values", () => {
  const normalized = normalizeConfig(undefined);
  assert.equal(normalized.baseURL, DEFAULTS.baseURL);
  assert.equal(normalized.model, DEFAULTS.model);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.maxTokens, 20_000);
  assert.equal(normalized.thinking, false);
  assert.deepEqual(normalized.hideTools, ["read_image"]);
  assert.equal(normalized.hideTools === DEFAULTS.hideTools, false, "defaults must not be aliased");
  assert.equal(Object.isFrozen(DEFAULTS.hideTools), true, "the shared default array is frozen");

  const custom = normalizeConfig({ model: "x/vision", maxTokens: 99, enabled: false, thinking: true });
  assert.equal(custom.model, "x/vision");
  assert.equal(custom.maxTokens, 99);
  assert.equal(custom.enabled, false);
  assert.equal(custom.thinking, true);

  const noHide = normalizeConfig({ hideTools: [] });
  assert.deepEqual(noHide.hideTools, []);
  const filtered = normalizeConfig({ hideTools: ["read_image", "", 42] });
  assert.deepEqual(filtered.hideTools, ["read_image"]);
});

test("normalizeConfig: rejects unusable numbers and blank required strings", () => {
  assert.throws(() => normalizeConfig({ maxTokens: 0 }), /maxTokens 必须是正数/);
  assert.throws(() => normalizeConfig({ timeoutMs: -1 }), /timeoutMs 必须是正数/);
  assert.throws(() => normalizeConfig({ maxImageBytes: Number.NaN }), /maxImageBytes 必须是正数/);
  assert.throws(() => normalizeConfig({ model: "  " }), /model 不能为空/);
  assert.throws(() => normalizeConfig({ baseURL: "" }), /baseURL 不能为空/);
});

test("apply: registers exactly one tool with the declared name and schema", () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, config());
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.parameters.required.includes("path"), true);
  assert.equal(tool.parameters.properties.question.type, "string");
  assert.deepEqual(tool.output.schema, { type: "string" });
});

test("apply: registers nothing when disabled", () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx, config({ enabled: false }));
  assert.equal(registered.length, 0);
});

test("reader: reads a file, appends the resolved path, and caches by content", async () => {
  const { impl, calls } = stubFetch();
  const read = createReader({
    getConfig: () => config(),
    cache: new LruCache(4),
    fetchImpl: impl,
    readFileImpl: async () => ({ bytes: PNG, mime: "image/png" }),
  });

  // Native absolute path, so the expectation holds on Windows and POSIX alike.
  const cwd = resolve(tmpdir(), "read-img-plugin-cwd");
  const resolved = resolve(cwd, "shots", "a.png");
  const exec = { agent: { session: { header: { cwd } } } };

  const first = await read({ path: "shots/a.png" }, exec);
  assert.match(first, /a red square/);
  assert.match(first, new RegExp(`\\(image: ${escapeRegExp(resolved)}\\)`));
  assert.equal(calls.length, 1);

  const second = await read({ path: "shots/a.png" }, exec);
  assert.equal(second, first);
  assert.equal(calls.length, 1, "second read must be served from cache");
});

test("reader: truncates an over-long question", async () => {
  const { impl, calls } = stubFetch();
  const read = createReader({
    getConfig: () => config(),
    cache: new LruCache(4),
    fetchImpl: impl,
    readFileImpl: async () => ({ bytes: PNG, mime: "image/png" }),
  });
  await read({ path: "/a.png", question: "q".repeat(MAX_QUESTION_CHARS + 50) }, {});
  const sent = JSON.parse(calls[0].init.body).messages[0].content[0].text;
  assert.equal(sent.length, MAX_QUESTION_CHARS);
});

test("reader: http(s) targets are passed through without reading a file", async () => {
  const { impl, calls } = stubFetch();
  const read = createReader({
    getConfig: () => config(),
    cache: new LruCache(4),
    fetchImpl: impl,
    readFileImpl: async () => {
      throw new Error("must not read a local file");
    },
  });
  const answer = await read({ path: "https://example.com/a.png", question: "what?" }, {});
  assert.equal(answer, "a red square");
  assert.equal(JSON.parse(calls[0].init.body).messages[0].content[1].image_url.url, "https://example.com/a.png");
});

test("reader: missing files fail before any request is made", async () => {
  const { impl, calls } = stubFetch();
  const read = createReader({
    getConfig: () => config(),
    cache: new LruCache(4),
    fetchImpl: impl,
  });
  await assert.rejects(read({ path: "/definitely/not/here.png" }, {}), /文件不存在或不可读/);
  assert.equal(calls.length, 0);
});

test("reader: real fixture round-trips through readImageFile", async () => {
  const read = createReader({
    getConfig: () => config(),
    cache: new LruCache(4),
    fetchImpl: stubFetch().impl,
  });
  const fixture = fileURLToPath(new URL("./fixtures/red-square.png", import.meta.url));
  const answer = await read({ path: fixture }, {});
  assert.match(answer, /a red square/);
  assert.match(answer, new RegExp(`\\(image: ${escapeRegExp(fixture)}\\)`));

  // The fixture must really be a PNG, so this also covers mime sniffing.
  const direct = await readImageFile(fixture, 1024 * 1024);
  assert.equal(direct.mime, "image/png");
});

test("reader: a cache hit still reports the path the caller asked for", async () => {
  const { impl, calls } = stubFetch();
  const read = createReader({
    getConfig: () => config(),
    cache: new LruCache(4),
    fetchImpl: impl,
    readFileImpl: async () => ({ bytes: PNG, mime: "image/png" }),
  });

  const first = await read({ path: "/one/a.png" }, {});
  const second = await read({ path: "/two/b.png" }, {});

  assert.match(first, /\(image: \/one\/a\.png\)/);
  assert.match(second, /\(image: \/two\/b\.png\)/);
  assert.equal(calls.length, 1, "same bytes must share one vision call");
});

test("apply: a disabled plugin registers neither the tool nor the hider", () => {
  const registered = [];
  const events = [];
  const ctx = {
    tools: { register: (definition) => registered.push(definition) },
    llm: { stream: () => "stream" },
    on: (event) => events.push(event),
    inject(_deps, callback) {
      callback(ctx);
    },
  };

  apply(ctx, { enabled: false });
  assert.equal(registered.length, 0);
  assert.deepEqual(events, []);

  apply(ctx, { enabled: true });
  assert.equal(registered.length, 1);
  assert.deepEqual(events.sort(), ["llm/stream", "tools/pre-execute"]);
});
