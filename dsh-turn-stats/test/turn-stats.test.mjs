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
} = await import("../lib/turn-stats.js");

/** A compact stream record whose first token is at `time`. */
const streamAt = (time) => [{ type: "chunk", time, chunk: { type: "text-delta", text: "hi" } }];

/** One settled step: open it, then assemble the message with `usage` at `messageTime`. */
function step(state, { turn, step: stepIndex, first, message, usage }) {
  state = applyTurnStatsEvent(state, { type: "step/start", time: first - 500, data: { turn, step: stepIndex } });
  state = applyTurnStatsEvent(state, {
    type: "assistant/message",
    time: message,
    data: { turn, step: stepIndex, stream: streamAt(first), usage },
  });
  return state;
}

/** A full turn with one step, committed. */
function oneStepTurn(state = initialTurnStatsState(), { turn = 1, first = 1000, message = 3000, usage } = {}) {
  state = step(state, { turn, step: 1, first, message, usage: usage ?? { inputTokens: 100, outputTokens: 500, cacheReadTokens: 0 } });
  state = applyTurnStatsEvent(state, { type: "step/end", time: message + 1, data: { turn, step: 1 } });
  return applyTurnStatsEvent(state, { type: "turn/end", time: message + 2, data: { turn, reason: "success" } });
}

test("nothing is published before the first Turn completes", () => {
  const inFlight = step(initialTurnStatsState(), {
    turn: 1,
    step: 1,
    first: 1000,
    message: 3000,
    usage: { inputTokens: 100, outputTokens: 500 },
  });
  assert.equal(turnStatsView(inFlight), null, "a Turn still running has no figures to show");
  assert.equal(turnStatsView(initialTurnStatsState()), null);
});

test("a completed Turn publishes its own decode window and output tokens", () => {
  const view = turnStatsView(oneStepTurn());
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

test("the second Turn replaces the first instead of adding to it", () => {
  let state = oneStepTurn();
  state = oneStepTurn(state, { turn: 2, first: 10_000, message: 11_000, usage: { inputTokens: 50, outputTokens: 100 } });
  const view = turnStatsView(state);
  // Whole-session would have said 700 tokens over 3000ms. The requirement is the
  // second Turn on its own terms: 100 tokens over 1000ms.
  assert.equal(view.turn, 2);
  assert.equal(view.decodeMs, 1000);
  assert.equal(view.decodeTokens, 100);
  assert.equal(view.billedInputTokens, 50);
});

test("a step without reported output tokens adds to neither side of the ratio", () => {
  let state = initialTurnStatsState();
  state = step(state, { turn: 1, step: 1, first: 1000, message: 5000, usage: { inputTokens: 10 } });
  state = applyTurnStatsEvent(state, { type: "turn/end", time: 5001, data: { turn: 1, reason: "success" } });
  const view = turnStatsView(state);
  assert.equal(view.decodeMs, 0, "an untimed step must not lend its wall time to a rate");
  assert.equal(view.decodeTokens, 0);
  assert.equal(view.billedInputTokens, 10, "its billed input still counts toward the cache denominator");
});

test("a retried attempt's first token survives into the settled message", () => {
  let state = applyTurnStatsEvent(initialTurnStatsState(), {
    type: "step/start",
    time: 100,
    data: { turn: 1, step: 1 },
  });
  // The first attempt produced tokens, then the retry replaced its slot; the
  // settled message carries no stream of its own to read the time from.
  state = applyTurnStatsEvent(state, {
    type: "assistant/attempt",
    time: 900,
    data: { turn: 1, step: 1, stream: streamAt(700) },
  });
  state = applyTurnStatsEvent(state, {
    type: "assistant/message",
    time: 2700,
    data: { turn: 1, step: 1, stream: [], usage: { outputTokens: 200 } },
  });
  state = applyTurnStatsEvent(state, { type: "turn/end", time: 2800, data: { turn: 1, reason: "success" } });
  assert.equal(turnStatsView(state).decodeMs, 2000, "decode spans the first attempt's first token");
});

test("the cache rate is token-weighted, not an average of per-step rates", () => {
  let state = initialTurnStatsState();
  state = step(state, { turn: 1, step: 1, first: 1000, message: 2000, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 } });
  state = step(state, { turn: 1, step: 2, first: 3000, message: 4000, usage: { inputTokens: 400, outputTokens: 1 } });
  state = applyTurnStatsEvent(state, { type: "turn/end", time: 4001, data: { turn: 1, reason: "success" } });
  const view = turnStatsView(state);
  // Weighted: 90 / (100 + 400) = 18%. Averaging the two step rates would say 45%.
  assert.equal(view.cacheReadTokens, 90);
  assert.equal(view.billedInputTokens, 500);
  assert.equal((view.cacheReadTokens / view.billedInputTokens) * 100, 18);
});

test("a Turn that never settled a step leaves the previous Turn's figures alone", () => {
  const committed = oneStepTurn();
  const noSteps = applyTurnStatsEvent(committed, { type: "turn/end", time: 9999, data: { turn: 2, reason: "cancelled" } });
  assert.deepEqual(turnStatsView(noSteps), turnStatsView(committed));

  const enteredButUnsettled = applyTurnStatsEvent(committed, { type: "step/start", time: 9000, data: { turn: 2, step: 1 } });
  const afterEnd = applyTurnStatsEvent(enteredButUnsettled, { type: "turn/end", time: 9999, data: { turn: 2, reason: "cancelled" } });
  assert.deepEqual(turnStatsView(afterEnd), turnStatsView(committed));
  assert.equal(afterEnd.open, null, "the abandoned Turn stops being folded");
});

test("an abandoned Turn is dropped, never frozen into a partial figure", () => {
  let state = oneStepTurn();
  // Turn 2 opens, settles nothing, and never sends turn/end — restart, crash,
  // or a user interrupting mid-stream. Turn 3's first step must not inherit it.
  state = applyTurnStatsEvent(state, { type: "step/start", time: 20_000, data: { turn: 2, step: 1 } });
  state = step(state, { turn: 3, step: 1, first: 21_000, message: 22_000, usage: { inputTokens: 7, outputTokens: 70 } });
  state = applyTurnStatsEvent(state, { type: "turn/end", time: 22_001, data: { turn: 3, reason: "success" } });
  const view = turnStatsView(state);
  assert.equal(view.turn, 3);
  assert.equal(view.decodeMs, 1000, "turn 2's unfinished wall time is not charged to turn 3");
  assert.equal(view.decodeTokens, 70);
});

test("time running backwards cannot subtract from the decode window", () => {
  let state = initialTurnStatsState();
  state = step(state, { turn: 1, step: 1, first: 5000, message: 4000, usage: { outputTokens: 10 } });
  state = applyTurnStatsEvent(state, { type: "turn/end", time: 5001, data: { turn: 1, reason: "success" } });
  assert.equal(turnStatsView(state).decodeMs, 0);
});

test("events the fold does not consume return the identical reference", () => {
  const state = oneStepTurn();
  for (const event of [
    { type: "user/message", time: 1, data: { message: {} } },
    { type: "tool/call", time: 2, data: { callId: "call_1" } },
    { type: "tool/result", time: 3, data: { message: { source: { callId: "call_1" } } } },
    { type: "llm/retry-started", time: 4, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 5, data: { turn: 9, step: 9, stream: [] } },
    { type: "turn/end", time: 6, data: { turn: 9, reason: "success" } },
  ]) {
    assert.equal(applyTurnStatsEvent(state, event), state, `${event.type} must not produce a new state object`);
  }
});

test("malformed log rows are ignored rather than folded into NaN", () => {
  const state = initialTurnStatsState();
  const junk = [
    { type: "step/start", time: 1, data: {} },
    { type: "step/start", time: 1, data: { turn: 1 } },
    { type: "assistant/message", time: 1, data: { turn: 1, step: 1, stream: null, usage: undefined } },
    { type: "assistant/message", time: "soon", data: { turn: 1, step: 1, stream: [] } },
    { type: "turn/end", time: 1, data: {} },
    null,
    {},
  ];
  let folded = state;
  for (const event of junk) folded = applyTurnStatsEvent(folded, event);
  assert.equal(turnStatsView(folded), null);

  // A negative or non-finite provider count behaves as absent, not as a debt.
  let negative = initialTurnStatsState();
  negative = step(negative, { turn: 1, step: 1, first: 1000, message: 2000, usage: { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: Number.POSITIVE_INFINITY } });
  negative = applyTurnStatsEvent(negative, { type: "turn/end", time: 2001, data: { turn: 1, reason: "success" } });
  const view = turnStatsView(negative);
  assert.deepEqual(view, { turn: 1, decodeMs: 0, decodeTokens: 0, cacheReadTokens: 0, billedInputTokens: 0 });
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
  assert.equal(turnStatsView(fold()).turn, 3);
});

test("the projection unit keeps its key, version and empty-state view contract", () => {
  assert.equal(turnStatsProjectionDefinition.key, TURN_STATS_KEY);
  assert.equal(typeof turnStatsProjectionDefinition.stateVersion, "number");
  assert.deepEqual(turnStatsProjectionDefinition.init(), { open: null, last: null });
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
    step(initialTurnStatsState(), { turn: 1, step: 1, first: 1000, message: 2000, usage: { inputTokens: 1, outputTokens: 1 } }),
    oneStepTurn(),
    applyTurnStatsEvent(oneStepTurn(), { type: "turn/end", time: 9, data: { turn: 2, reason: "cancelled" } }),
  ];
  for (const [index, state] of states.entries()) {
    const parsed = viewSchema.safeParse(view(state));
    assert.equal(parsed.success, true, `state #${index} 的 view 过不了自己的 viewSchema：${JSON.stringify(parsed.error?.issues)}`);
  }
});

test("both schemas are the boundaries they claim to be", () => {
  const { stateSchema, wire } = turnStatsProjectionDefinition;
  // The state schema guards persisted rows, so it must accept a folded state…
  const folded = oneStepTurn();
  assert.equal(stateSchema.safeParse(folded).success, true);
  assert.equal(stateSchema.safeParse(folded.open).success, false, "a bare bucket is not a state");
  // …and reject a field a newer build wrote, instead of reading it silently.
  assert.equal(stateSchema.safeParse({ ...folded, extra: 1 }).success, false);
  // The view schema guards the wire: exactly the published figures, nothing else.
  assert.equal(wire.viewSchema.safeParse(turnStatsView(folded)).success, true);
  assert.equal(wire.viewSchema.safeParse({ ...turnStatsView(folded), settledSteps: 1 }).success, false);
});
