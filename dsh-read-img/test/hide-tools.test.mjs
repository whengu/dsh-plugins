import test from "node:test";
import assert from "node:assert/strict";
import { filterTools, hiddenSet, installToolHider } from "../lib/hide-tools.js";

const READ_IMAGE = { name: "read_image" };
const READ_IMG = { name: "read_img" };
const OTHER = { name: "bash" };

/** Fake cordis context: records listeners, counts stream re-entries. */
function fakeCtx({ hideTools = ["read_image"] } = {}) {
  const listeners = new Map();
  const streamed = [];
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler);
    },
    llm: {
      stream(options) {
        streamed.push(options);
        return "stream-result";
      },
    },
  };
  installToolHider(ctx, () => ({ hideTools }));
  return { ctx, listeners, streamed };
}

test("hiddenSet: drops empty and non-string names", () => {
  assert.deepEqual([...hiddenSet(["a", "", null, 42, "b"])], ["a", "b"]);
  assert.equal(hiddenSet(undefined).size, 0);
});

test("filterTools: removes only the hidden names", () => {
  const tools = [READ_IMAGE, READ_IMG, OTHER];
  const filtered = filterTools(tools, hiddenSet(["read_image"]));
  assert.deepEqual(filtered.map((tool) => tool.name), ["read_img", "bash"]);
});

test("filterTools: returns the same array when nothing matches", () => {
  const tools = [READ_IMG, OTHER];
  assert.equal(filterTools(tools, hiddenSet(["read_image"])), tools);
  assert.equal(filterTools(tools, hiddenSet([])), tools);
  assert.equal(filterTools(undefined, hiddenSet(["read_image"])), undefined);
});

test("filterTools: is idempotent, so the stream re-entry terminates", () => {
  const once = filterTools([READ_IMAGE, READ_IMG], hiddenSet(["read_image"]));
  const twice = filterTools(once, hiddenSet(["read_image"]));
  assert.equal(twice, once);
});

test("llm/stream: a request carrying the hidden tool is re-entered without it", () => {
  const { ctx, listeners, streamed } = fakeCtx();
  const hook = listeners.get("llm/stream");
  let nextCalls = 0;

  const result = hook({ tools: [READ_IMAGE, READ_IMG], messages: [] }, () => {
    nextCalls += 1;
    return "next-result";
  });

  assert.equal(result, "stream-result");
  assert.equal(nextCalls, 0);
  assert.equal(streamed.length, 1);
  assert.deepEqual(streamed[0].tools.map((tool) => tool.name), ["read_img"]);
  assert.deepEqual(streamed[0].messages, []);
});

test("llm/stream: a request without the hidden tool passes straight through", () => {
  const { listeners, streamed } = fakeCtx();
  const hook = listeners.get("llm/stream");
  let nextCalls = 0;

  const result = hook({ tools: [READ_IMG] }, () => {
    nextCalls += 1;
    return "next-result";
  });

  assert.equal(result, "next-result");
  assert.equal(nextCalls, 1);
  assert.equal(streamed.length, 0);
});

test("llm/stream: an empty hide list disables the filter", () => {
  const { listeners, streamed } = fakeCtx({ hideTools: [] });
  const hook = listeners.get("llm/stream");
  let nextCalls = 0;
  hook({ tools: [READ_IMAGE] }, () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(streamed.length, 0);
});

test("llm/stream: fails open when the config cannot be read", () => {
  const listeners = new Map();
  installToolHider(
    { on: (event, handler) => listeners.set(event, handler), llm: { stream() {} } },
    () => {
      throw new Error("config exploded");
    },
  );
  let nextCalls = 0;
  listeners.get("llm/stream")({ tools: [READ_IMAGE] }, () => {
    nextCalls += 1;
    return "ok";
  });
  assert.equal(nextCalls, 1);
});

test("tools/pre-execute: a hidden tool is denied with a redirect", () => {
  const { listeners } = fakeCtx();
  const guard = listeners.get("tools/pre-execute");
  const decision = guard({ name: "read_image" }, () => "next");
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /read_img/);
});

test("tools/pre-execute: other tools and missing names pass through", () => {
  const { listeners } = fakeCtx();
  const guard = listeners.get("tools/pre-execute");
  assert.equal(guard({ name: "bash" }, () => "next"), "next");
  assert.equal(guard({}, () => "next"), "next");
});
