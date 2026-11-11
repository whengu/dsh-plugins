/**
 * Integration check against the REAL projection registry.
 *
 * The unit tests exercise the fold; this one exercises the seam the fold ships
 * through, because that seam has two behaviours no local test can see:
 *
 *   - `register()` rejects a `stateVersion` that is not a non-negative safe
 *     integer, and calls `init(header, inheritedEventCount)`;
 *   - every client-facing read runs `wire.viewSchema.parse(view(state))` with no
 *     guard, inside a snapshot that computes ALL of a session's units at once.
 *
 * So this test builds a real cordis context, installs the host's
 * `SessionProjectionRegistry`, activates `lib/index.js` against it, replays
 * events through the same `session/event` the Session Controller publishes, and
 * reads the result through `registry.snapshot(session, keys)` — the call the
 * browser's projection store rides. A wrong injection name, a schema the
 * registry cannot use, or an out-of-schema view fails HERE instead of on the
 * user's open session.
 *
 * Nothing is stubbed except the Session itself: the registry only ever touches
 * `header`, `inheritedEventCount`, `seq`, `snapshotEvents` and `eventAt`, and the
 * seq/offset types are branded numbers at runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { registerHostModules } from "./host-packages.mjs";

const entries = registerHostModules();
const { Context } = await import(/* @vite-ignore */ entries["@deepseek-ai/cordis"]);
const { SessionProjectionRegistry } = await import(/* @vite-ignore */ entries["@deepseek-ai/dsh-session-projection"]);
const { apply } = await import("../lib/index.js");
const { TURN_STATS_KEY, turnStatsView } = await import("../lib/turn-stats.js");

/** A committed-log stand-in carrying exactly what the registry reads. */
function fakeSession() {
  const log = [];
  return {
    header: { id: "ses_integration", cwd: process.cwd() },
    inheritedEventCount: 0,
    get seq() {
      return log.length;
    },
    snapshotEvents: (from = 0, to = log.length) => log.slice(Number(from), Number(to)),
    eventAt: (seq) => log[Number(seq)],
    /** Committed order is the only invariant the registry checks per seq. */
    append: (event) => {
      const row = { ...event, seq: log.length };
      log.push(row);
      return row;
    },
  };
}

/** Assemble a context with the host registry installed and our plugin applied. */
async function assemble() {
  const ctx = new Context();
  const registry = new SessionProjectionRegistry(ctx);
  await apply(ctx);
  return { ctx, registry };
}

const stream = (time) => [{ type: "chunk", time, chunk: { type: "text-delta", text: "hi" } }];

test("the host half registers its unit on a real context without throwing", async () => {
  const { ctx, registry } = await assemble();
  // Activation is the failure mode being guarded: a bad `inject` list or a
  // definition the registry refuses would have thrown above. `ctx.sessionProjections`
  // is cordis' traceable proxy around the service, not the instance, so identity
  // is not the assertion — the surface and the registered key are.
  assert.equal(typeof ctx.sessionProjections.snapshot, "function", "宿主半边没拿到 sessionProjections 服务面");
  const snapshot = registry.snapshot(fakeSession(), [TURN_STATS_KEY]);
  assert.deepEqual(Object.keys(snapshot.values), [TURN_STATS_KEY], "注册成功但快照里没有这个 key，客户端永远读不到");
  assert.equal(snapshot.values[TURN_STATS_KEY], null, "空会话的线格式必须是 null，不是缺席、不是抛错");
});

test("figures published through the wire equal the fold's own view", async () => {
  const { ctx, registry } = await assemble();
  const session = fakeSession();
  const publish = (event) => ctx.emit("session/event", session, session.append(event));

  publish({ type: "turn/start", time: 900, data: { turn: 1 } });
  publish({ type: "step/start", time: 1000, data: { turn: 1, step: 1 } });
  publish({
    type: "assistant/message",
    time: 3000,
    data: { turn: 1, step: 1, stream: stream(1200), usage: { inputTokens: 400, cacheReadTokens: 100, outputTokens: 900 } },
  });

  // v2: the call has settled, so the wire already carries it — the Turn is still
  // running, and that no longer delays anything. This is the whole point of 0.2.0.
  const midTurn = registry.snapshot(session, [TURN_STATS_KEY]).values[TURN_STATS_KEY];
  assert.deepEqual(midTurn, {
    turn: 1,
    decodeMs: 1800,
    decodeTokens: 900,
    cacheReadTokens: 100,
    billedInputTokens: 500,
  });

  publish({ type: "step/end", time: 3100, data: { turn: 1, step: 1 } });
  publish({ type: "turn/end", time: 3200, data: { turn: 1, reason: "success" } });
  const value = registry.snapshot(session, [TURN_STATS_KEY]).values[TURN_STATS_KEY];
  assert.deepEqual(value, midTurn, "轮末不再改写数值：结算那一刻就是最终值");
  // The snapshot is the client-facing value; the fold's view is the same object.
  assert.deepEqual(value, turnStatsView({ last: value }));

  // The rate the pill will print, at the pill's own precision rule.
  assert.equal(Math.round(value.decodeTokens / (value.decodeMs / 1e3)), 500);
});

test("the change feed fires on each settled call and not on events that change nothing", async () => {
  const { ctx, registry } = await assemble();
  const session = fakeSession();
  const seen = [];
  // Signature is (session, key, value, seq) — one call per changed unit.
  registry.onChanged((_session, key, value) => {
    if (key === TURN_STATS_KEY) seen.push(value);
  });
  const publish = (event) => ctx.emit("session/event", session, session.append(event));

  publish({ type: "user/message", time: 100, data: { message: {} } });
  publish({ type: "step/start", time: 1000, data: { turn: 1, step: 1 } });
  publish({ type: "assistant/attempt", time: 1100, data: { turn: 1, step: 1, stream: stream(1050) } });
  assert.deepEqual(seen, [], "v2 只认 assistant/message，开步与重试不该惊动这个 key");

  publish({
    type: "assistant/message",
    time: 2000,
    data: { turn: 1, step: 1, stream: stream(1500), usage: { inputTokens: 10, outputTokens: 10 } },
  });
  assert.equal(seen.length, 1, "第一次调用结算就该出数");
  assert.equal(seen[0]?.decodeMs, 500);

  // A second call inside the same Turn refreshes the pill again — v1 waited for
  // `turn/end`, which is exactly the delay v2 removed.
  publish({ type: "step/start", time: 2100, data: { turn: 1, step: 2 } });
  publish({
    type: "assistant/message",
    time: 3000,
    data: { turn: 1, step: 2, stream: stream(2600), usage: { inputTokens: 20, outputTokens: 40 } },
  });
  assert.equal(seen.length, 2, "同轮第二次调用结算应再刷新一次");
  assert.equal(seen[1].decodeTokens, 40);
  assert.equal(seen[1].decodeMs, 400);

  publish({ type: "turn/end", time: 3100, data: { turn: 1, reason: "success" } });
  assert.equal(seen.length, 2, "轮末不再惊动任何东西：它不再改变状态");
});
