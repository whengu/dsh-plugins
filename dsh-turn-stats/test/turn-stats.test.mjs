import test from "node:test";
import assert from "node:assert/strict";

// `lib/turn-stats.js` imports the host's first-token reader and zod; the plugin
// itself depends on neither at install time (dsh supplies both), so a clean
// checkout has no node_modules. Alias them to the installed dsh — the real
// modules, not stubs (see test/host-packages.mjs for the search order).
import { registerHostModules } from "./host-packages.mjs";

registerHostModules();
const {
  initialTurnStatsState,
  applyTurnStatsEvent,
  turnStatsView,
  turnStatsProjectionDefinition,
  TURN_STATS_KEY,
  TURN_STATS_STATE_VERSION,
} = await import("../lib/turn-stats.js");

/** A compact stream record whose first token is at `time`. */
const streamAt = (time) => [{ type: "chunk", time, chunk: { type: "text-delta", text: "hi" } }];

/**
 * One settled model call. Deliberately the bare `assistant/message` and nothing
 * else: v2's fold must not need a preceding `step/start` or `assistant/attempt`,
 * so every case below is built from this one self-contained event.
 */
function call(state, { turn = 1, step = 1, first = 1000, message = 3000, usage } = {}) {
  return applyTurnStatsEvent(state, {
    type: "assistant/message",
    time: message,
    data: { turn, step, stream: streamAt(first), usage },
  });
}

test("nothing is published before the first call settles", () => {
  // A call in flight has produced committed events, just not the one carrying
  // its usage — the honest empty state is "show nothing", not "show 0".
  const opened = applyTurnStatsEvent(initialTurnStatsState(), {
    type: "step/start",
    time: 1000,
    data: { turn: 1, step: 1 },
  });
  assert.equal(turnStatsView(opened), null, "a running call has no committed usage to show");
  assert.equal(turnStatsView(initialTurnStatsState()), null);
});

test("a settled call publishes its own decode window and output tokens", () => {
  const view = turnStatsView(call(initialTurnStatsState(), { usage: { inputTokens: 100, outputTokens: 500 } }));
  assert.deepEqual(view, {
    turn: 1,
    // first token 1000 → assistant/message 3000, exactly the host fold's rule.
    decodeMs: 2000,
    decodeTokens: 500,
    cacheReadTokens: 0,
    // The three prompt buckets are disjoint, so their sum is the billed input.
    billedInputTokens: 100,
  });
});

test("an isolated call publishes with no preceding step or attempt (window-safe)", () => {
  // v2 removed the accumulator, so a settled call must be foldable on its own.
  // This is what keeps a truncated window — paging, a reconnect baseline, a
  // compaction boundary that starts mid-Turn — from losing the figures.
  const folded = applyTurnStatsEvent(initialTurnStatsState(), {
    type: "assistant/message",
    time: 77_000,
    data: { turn: 9, step: 4, stream: streamAt(75_000), usage: { inputTokens: 3, outputTokens: 400 } },
  });
  assert.deepEqual(turnStatsView(folded), {
    turn: 9,
    decodeMs: 2000,
    decodeTokens: 400,
    cacheReadTokens: 0,
    billedInputTokens: 3,
  });
});

test("the next call replaces the previous one instead of adding to it", async (t) => {
  let state = call(initialTurnStatsState(), { turn: 1, first: 1000, message: 3000, usage: { inputTokens: 100, outputTokens: 500 } });
  state = call(state, { turn: 2, step: 1, first: 10_000, message: 11_000, usage: { inputTokens: 50, outputTokens: 100 } });
  const view = turnStatsView(state);
  // Session-cumulative would have said 600 tokens over 4000ms; a Turn sum would
  // have said 100 over 1000 only at turn/end. v2 says the last call, now.
  assert.equal(view.turn, 2);
  assert.equal(view.decodeMs, 1000);
  assert.equal(view.decodeTokens, 100);
  assert.equal(view.billedInputTokens, 50);

  await t.test("and two calls in one Turn also replace rather than average", () => {
    let inside = call(initialTurnStatsState(), { turn: 5, step: 1, first: 1000, message: 2000, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 } });
    const firstRatio = { ...turnStatsView(inside) };
    inside = call(inside, { turn: 5, step: 2, first: 3000, message: 4000, usage: { inputTokens: 400, outputTokens: 1 } });
    const view = turnStatsView(inside);
    assert.equal(view.billedInputTokens, 400, "the cache denominator is this call's billed input, not a running total");
    assert.equal(firstRatio.cacheReadTokens / firstRatio.billedInputTokens, 0.9, "the first call really did report a cache read");
    assert.equal(view.cacheReadTokens, 0, "and it is not carried into the next call's rate");
  });
});

test("a call without reported output tokens publishes nothing and keeps the previous figures", () => {
  let state = call(initialTurnStatsState(), { usage: { inputTokens: 100, outputTokens: 500 } });
  const before = turnStatsView(state);
  // An untimed call has no honest rate: publishing it would either blank the
  // speed pill or claim 0 tok/s for a call that was never measured.
  state = call(state, { first: 9000, message: 9500, usage: { inputTokens: 10 } });
  assert.deepEqual(turnStatsView(state), before, "the unmeasurable call left the last honest call on screen");
});

test("a call whose stream carries no first token publishes nothing", () => {
  let state = call(initialTurnStatsState(), { usage: { inputTokens: 100, outputTokens: 500 } });
  const before = turnStatsView(state);
  state = applyTurnStatsEvent(state, {
    type: "assistant/message",
    time: 9000,
    data: { turn: 1, step: 2, stream: [], usage: { inputTokens: 1, outputTokens: 200 } },
  });
  assert.deepEqual(turnStatsView(state), before);
  // v1 credited an abandoned attempt's first token to the step. v2 measures one
  // call, so it measures that call's own window and nothing else — an abandoned
  // attempt is not part of the settled call's speed.
});

test("a retried step's settled message measures its own attempt", () => {
  let state = applyTurnStatsEvent(initialTurnStatsState(), { type: "step/start", time: 100, data: { turn: 1, step: 1 } });
  // The abandoned first attempt tokened at 700; the settled message tokened at
  // 2000 and finished at 2700.
  state = applyTurnStatsEvent(state, { type: "assistant/attempt", time: 900, data: { turn: 1, step: 1, stream: streamAt(700) } });
  state = applyTurnStatsEvent(state, {
    type: "assistant/message",
    time: 2700,
    data: { turn: 1, step: 1, stream: streamAt(2000), usage: { outputTokens: 200 } },
  });
  assert.equal(turnStatsView(state).decodeMs, 700, "700ms of its own attempt, not the abandoned attempt's 2000ms");
});

test("time running backwards cannot subtract from the decode window", () => {
  const state = call(initialTurnStatsState(), { first: 5000, message: 4000, usage: { outputTokens: 10 } });
  assert.equal(turnStatsView(state).decodeMs, 0);
});

test("events the fold does not consume return the identical reference", () => {
  const state = call(initialTurnStatsState(), { usage: { inputTokens: 100, outputTokens: 500 } });
  for (const event of [
    { type: "step/start", time: 1, data: { turn: 1, step: 2 } },
    { type: "assistant/attempt", time: 2, data: { turn: 1, step: 2, stream: streamAt(1) } },
    { type: "step/end", time: 3, data: { turn: 1, step: 2 } },
    { type: "user/message", time: 4, data: { message: {} } },
    { type: "tool/call", time: 5, data: { callId: "call_1" } },
    { type: "tool/result", time: 6, data: { message: { source: { callId: "call_1" } } } },
    { type: "llm/retry-started", time: 7, data: { turn: 1, step: 2 } },
    // v1 committed here. v2 must not: a Turn ending changes no call's figures.
    { type: "turn/end", time: 8, data: { turn: 1, reason: "success" } },
    // A settled call with nothing provable must not even allocate a new state.
    { type: "assistant/message", time: 9, data: { turn: 2, step: 1, stream: [], usage: {} } },
  ]) {
    assert.equal(applyTurnStatsEvent(state, event), state, `${event.type} must not produce a new state object`);
  }
});

test("malformed log rows are ignored rather than folded into NaN", () => {
  const junk = [
    { type: "step/start", time: 1, data: {} },
    { type: "assistant/message", time: 1, data: { turn: 1, step: 1, stream: null, usage: undefined } },
    { type: "assistant/message", time: "soon", data: { turn: 1, step: 1, stream: streamAt(0), usage: { outputTokens: 1 } } },
    // No Turn means the figures cannot be attributed at all.
    { type: "assistant/message", time: 500, data: { step: 1, stream: streamAt(0), usage: { outputTokens: 1 } } },
    // A non-finite output count means there is no honest numerator.
    { type: "assistant/message", time: 5000, data: { turn: 1, step: 1, stream: streamAt(1000), usage: { outputTokens: Number.NaN } } },
    null,
    {},
  ];
  let folded = initialTurnStatsState();
  for (const event of junk) folded = applyTurnStatsEvent(folded, event);
  assert.equal(turnStatsView(folded), null);

  // A negative or non-finite *prompt* count behaves as absent on the cache side,
  // while the call itself stays publishable: the numerator is still honest.
  const sloppy = call(initialTurnStatsState(), {
    first: 1000,
    message: 2000,
    usage: { inputTokens: -5, outputTokens: 42, cacheReadTokens: Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(turnStatsView(sloppy), {
    turn: 1,
    decodeMs: 1000,
    decodeTokens: 42,
    cacheReadTokens: 0,
    billedInputTokens: 0,
  });
});

test("folding a log twice yields the same figures (a restore re-fold, not a delta)", () => {
  const events = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    events.push({ type: "step/start", time: turn * 10_000, data: { turn, step: 1 } });
    events.push({
      type: "assistant/message",
      time: turn * 10_000 + 1500,
      data: { turn, step: 1, stream: streamAt(turn * 10_000 + 500), usage: { inputTokens: turn * 10, outputTokens: turn * 100, cacheReadTokens: turn } },
    });
    events.push({ type: "step/end", time: turn * 10_000 + 1600, data: { turn, step: 1 } });
    events.push({ type: "turn/end", time: turn * 10_000 + 1700, data: { turn, reason: "success" } });
  }
  const fold = () => events.reduce(applyTurnStatsEvent, initialTurnStatsState());
  assert.deepEqual(turnStatsView(fold()), turnStatsView(fold()));
  assert.equal(turnStatsView(fold()).turn, 3, "the last call of the log wins, in both folds");
});

test("the projection unit keeps its key, version and empty-state view contract", () => {
  assert.equal(turnStatsProjectionDefinition.key, TURN_STATS_KEY);
  // Pinned, not `typeof === "number"`: v2 changed the persisted state and the
  // fold rule, so a checkpoint written by 0.1.x must be recognised as stale and
  // discarded rather than read as if it were current.
  assert.equal(TURN_STATS_STATE_VERSION, 2);
  assert.equal(turnStatsProjectionDefinition.stateVersion, 2);
  assert.deepEqual(turnStatsProjectionDefinition.init(), { last: null });
  assert.equal(turnStatsProjectionDefinition.wire.view(turnStatsProjectionDefinition.init()), null);
  assert.equal(turnStatsProjectionDefinition.wire.summary, false);
  assert.equal(turnStatsProjectionDefinition.apply, applyTurnStatsEvent);
});

test("the wire view always satisfies its own viewSchema, including while empty", () => {
  // The registry reads a cell as `viewSchema.parse(view(state))` with no guard
  // (dsh-session-projection/lib/index.js:584-589) and computes every
  // client-visible unit of a session in one pass, so an out-of-schema view is
  // not this plugin failing quietly — it is the session snapshot throwing, with
  // the host's own statistics pills in the blast radius. Every state the fold
  // can reach must therefore parse, not just the happy one.
  const { viewSchema, view } = turnStatsProjectionDefinition.wire;
  const states = [
    turnStatsProjectionDefinition.init(),
    call(initialTurnStatsState(), { usage: { inputTokens: 1, outputTokens: 1 } }),
    // Zero-width decode window: the degenerate denominator case the pills guard.
    call(initialTurnStatsState(), { first: 1000, message: 1000, usage: { outputTokens: 0 } }),
    applyTurnStatsEvent(call(initialTurnStatsState(), { usage: { outputTokens: 1 } }), {
      type: "turn/end",
      time: 9,
      data: { turn: 1, reason: "cancelled" },
    }),
  ];
  for (const [index, state] of states.entries()) {
    const parsed = viewSchema.safeParse(view(state));
    assert.equal(parsed.success, true, `state #${index} 的 view 过不了自己的 viewSchema：${JSON.stringify(parsed.error?.issues)}`);
  }
});

test("both schemas are the boundaries they claim to be", () => {
  const { stateSchema, wire } = turnStatsProjectionDefinition;
  const folded = call(initialTurnStatsState(), { usage: { inputTokens: 100, outputTokens: 500 } });
  // The state schema guards persisted rows…
  assert.equal(stateSchema.safeParse(folded).success, true);
  assert.equal(stateSchema.safeParse(turnStatsView(folded)).success, false, "a bare call is not a state");
  assert.equal(stateSchema.safeParse({ ...folded, extra: 1 }).success, false, "a field a newer build wrote is rejected, not read silently");
  // …and specifically must NOT accept the v1 shape. v1 persisted `{open, last}`;
  // reading such a row as v2 state would silently keep a stale Turn sum alive.
  assert.equal(stateSchema.safeParse({ open: null, last: turnStatsView(folded) }).success, false, "a 0.1.x checkpoint must not parse as v2 state");
  // The view schema guards the wire: exactly the published figures, nothing else.
  assert.equal(wire.viewSchema.safeParse(turnStatsView(folded)).success, true);
  assert.equal(wire.viewSchema.safeParse({ ...turnStatsView(folded), settledSteps: 1 }).success, false, "v1's accumulator field must not leak onto the wire");
});
