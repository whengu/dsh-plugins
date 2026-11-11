/**
 * `turnStats` — the most recent model call's decode speed and cache-hit inputs.
 *
 * Why this unit exists: the host ships two statistics projections
 * (`sessionStats`, `tokenUsage`) and both publish whole-session sums only —
 * their `wire.view` returns scalars accumulated since the first event, which is
 * why the composer pills stop moving in a long session. The durable log already
 * carries every input this fold needs at *call* granularity, so the fix is a
 * narrower aggregation, not a client-side guess: the Host keeps computing and
 * the browser keeps reading a projection value (`practices.md:38` — the Client
 * must not fold session events itself).
 *
 * Measurement rules are copied field for field from the host's own fold
 * (`dsh-session-stats/lib/types/projection.js`) so the two views of the same
 * session cannot disagree:
 *
 * - a decode span runs from the first token to `assistant/message`, and only a
 *   call whose usage reported `outputTokens` is timed at all — an untimed call
 *   contributes to neither side of the ratio, which is what keeps the quotient
 *   honest;
 * - the first token time comes from `assistantStreamFirstTokenTime`, imported
 *   from `@deepseek-ai/dsh-llm` rather than re-implemented, so the token
 *   predicate (`isTokenDelta`) and the compact-record walk stay the host's;
 * - the cache denominator is the three disjoint prompt buckets
 *   (`inputTokens + cacheReadTokens + cacheWriteTokens`); they are disjoint by
 *   contract — `inputTokens` is uncached input only — so their sum is the billed
 *   input. Within one call the token-weighting the host applies across steps
 *   degenerates to that call's own ratio; the arithmetic is unchanged, so nobody
 *   should "simplify" it into an average of percentages later.
 *
 * Publishing rule, from the product decision (REQUIREMENTS §6, v2): a call's
 * figures appear the moment that call settles. `assistant/message` is the only
 * event this fold consumes, and each one *overwrites* the published figures.
 * v1 summed the calls of a Turn and committed at `turn/end`; a Turn can run for
 * hours, so the pills showed nothing usable for hours — and the per-call
 * numbers it needed were already complete in every single `assistant/message`.
 * Removing the summation is what made v2 smaller than v1, not larger.
 *
 * What v2 deliberately does not do: render a rate while a call is still
 * streaming. No committed event carries usage before settlement (`usage` arrives
 * with `assistant/message`), so anything shown earlier would be the frontend
 * guessing that requirement 2.4 forbids. The official live source
 * (`agent/assistant-stream`) is rejected for the same reason plus one more: the
 * cache buckets are unavailable before settlement either, so one pill would move
 * live while its neighbour stayed step-wise — see DESIGN §7.
 *
 * A call that cannot be timed honestly — no reported `outputTokens`, or no first
 * token recoverable from its stream — publishes **nothing**: the previous call's
 * figures stay on screen rather than a fabricated zero or an empty pill.
 *
 * @module turn-stats
 */

import { assistantStreamFirstTokenTime } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

/** Projection key this plugin owns. Read on the client with `useProjection`. */
export const TURN_STATS_KEY = "turnStats";

/**
 * 2 — v2 replaced the per-Turn sum with the last settled call and dropped the
 * `open` accumulator from the persisted state. Bump whenever a state field or a
 * fold rule changes: the registry rejects a re-registration under a key whose
 * `stateVersion` disagrees with a cached cell, and discards stale checkpoints.
 */
export const TURN_STATS_STATE_VERSION = 2;

/** The projection's client-facing shape: one settled model call's figures. */
export const turnStatsSchema = z
  .object({
    /** The Turn this call belongs to; informational, for debugging and tests. */
    turn: z.number().int().nonnegative(),
    /** Decode wall time (first token → `assistant/message`) in ms. */
    decodeMs: z.number().nonnegative(),
    /** Provider output tokens for this call, timed on the same window. */
    decodeTokens: z.number().nonnegative(),
    /** Cache-read input tokens reported by this call. */
    cacheReadTokens: z.number().nonnegative(),
    /** This call's billed input: the three disjoint prompt buckets added. */
    billedInputTokens: z.number().nonnegative(),
  })
  .strict();

/** Fold state: the last settled call, and nothing else. */
export const turnStatsStateSchema = z
  .object({
    last: turnStatsSchema.nullable(),
  })
  .strict();

/**
 * A non-negative finite number, the way the host fold guards provider counts.
 * @param {unknown} value
 * @returns {number | undefined} `undefined` when the bucket is absent or unusable.
 */
function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}

/** @returns {number} 0 for an absent or unusable bucket — it adds nothing to a sum. */
function counted(value) {
  return count(value) ?? 0;
}

/**
 * The same boundary the host fold uses, read from the settled call's own
 * compact stream.
 * @param {unknown} stream
 * @returns {number | null} `null` when no token time can be recovered.
 */
function firstTokenOf(stream) {
  if (!Array.isArray(stream)) return null;
  const time = assistantStreamFirstTokenTime(stream);
  return typeof time === "number" && Number.isFinite(time) && time >= 0 ? time : null;
}

/** @returns {import('./turn-stats.js').z.infer<typeof turnStatsStateSchema>} */
export function initialTurnStatsState() {
  return { last: null };
}

/**
 * Fold one durable event.
 *
 * Only `assistant/message` is consumed; every other event — `step/start`,
 * `assistant/attempt`, `turn/end`, tools, everything — returns the identical
 * reference. That identity is load-bearing: the projection registry gates its
 * change feed on `Object.is`, so returning a fresh-but-equal object would push a
 * wire update per event for free. It also proves the fold has no prerequisite:
 * a settled call is self-contained, which is what keeps a mid-Turn window
 * boundary (paging, a reconnect baseline, compaction) from losing the figures.
 *
 * @param {import('./turn-stats.js').z.infer<typeof turnStatsStateSchema>} state
 * @param {any} event - one durable Session event.
 * @returns the same state, or the folded successor.
 */
export function applyTurnStatsEvent(state, event) {
  if (event?.type !== "assistant/message") return state;

  const turn = count(event.data?.turn);
  const time = count(event.time);
  // Without a Turn this call cannot be attributed, and without an event time
  // the decode window would be a guess.
  if (turn === void 0 || time === void 0) return state;

  const usage = event.data?.usage;
  const outputTokens = count(usage?.outputTokens);
  const firstToken = firstTokenOf(event.data?.stream);
  // An untimed call has no honest rate. Publish nothing: DESIGN §5 chose "keep
  // showing the previous call" over "blank the pills" or "show 0".
  if (outputTokens === void 0 || firstToken === null) return state;

  return {
    last: {
      turn,
      decodeMs: Math.max(0, time - firstToken),
      decodeTokens: outputTokens,
      cacheReadTokens: counted(usage?.cacheReadTokens),
      billedInputTokens:
        counted(usage?.inputTokens) + counted(usage?.cacheReadTokens) + counted(usage?.cacheWriteTokens),
    },
  };
}

/**
 * The wire view: the last settled call, or `null` before the first one.
 *
 * `null`, not `undefined`, and this is not a style choice. The registry reads a
 * cell as `wire.viewSchema.parse(wire.view(state))` with no guard
 * (`dsh-session-projection/lib/index.js:584-589`), and `snapshot()` computes
 * every client-visible unit for one session in a single pass — so a view that
 * returned `undefined` would throw inside the *session's* snapshot, taking the
 * host's own pills down with it. The shipped empty-view precedent is exactly
 * this shape: `viewSchema: worktreeSchema.nullable()` with
 * `view: (state) => … : null` (`dsh-experimental-client-ui-forge/lib/index.js:947-950`).
 *
 * @param {import('./turn-stats.js').z.infer<typeof turnStatsStateSchema>} state
 * @returns {import('./turn-stats.js').z.infer<typeof turnStatsSchema> | null}
 */
export function turnStatsView(state) {
  return state.last ?? null;
}

/** The `turnStats` unit registered on `ctx.sessionProjections`. */
export const turnStatsProjectionDefinition = {
  key: TURN_STATS_KEY,
  stateVersion: TURN_STATS_STATE_VERSION,
  stateSchema: turnStatsStateSchema,
  init: initialTurnStatsState,
  apply: applyTurnStatsEvent,
  wire: {
    // Nullable because the view is null before the first settled call; see
    // `turnStatsView` for why an absent value is not an option here.
    viewSchema: turnStatsSchema.nullable(),
    view: turnStatsView,
    // Same as the host's `sessionStats`: these figures belong to one open
    // session, not to a list row, so they stay out of summary payloads.
    summary: false,
  },
};
