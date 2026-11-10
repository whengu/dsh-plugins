/**
 * `turnStats` — one Turn's decode speed and cache-hit inputs.
 *
 * Why this unit exists: the host ships two statistics projections
 * (`sessionStats`, `tokenUsage`) and both publish whole-session sums only —
 * their `wire.view` returns scalars accumulated since the first event, which is
 * why the composer pills stop moving in a long session. The durable log already
 * carries every input this fold needs at step granularity, so the fix is a
 * narrower aggregation, not a client-side guess: the Host keeps computing and
 * the browser keeps reading a projection value (`practices.md:38` — the Client
 * must not fold session events itself).
 *
 * Measurement rules are copied field for field from the host's own fold
 * (`dsh-session-stats/lib/types/projection.js`) so the two views of the same
 * session cannot disagree:
 *
 * - decode spans first token → `assistant/message`, and only on steps whose
 *   usage reported `outputTokens` — an untimed step adds to neither side of the
 *   ratio, which is what keeps the quotient honest;
 * - the first token time comes from `assistantStreamFirstTokenTime`, imported
 *   from `@deepseek-ai/dsh-llm` rather than re-implemented, so the token
 *   predicate (`isTokenDelta`) and the compact-record walk stay the host's;
 * - the cache denominator is the three disjoint prompt buckets
 *   (`inputTokens + cacheReadTokens + cacheWriteTokens`); they are disjoint by
 *   contract — `inputTokens` is uncached input only — so their sum is the billed
 *   input, and summing before dividing makes the rate token-weighted rather
 *   than an average of per-step percentages.
 *
 * Publishing rule, from the product decision: a Turn's figures appear when the
 * Turn completes. `turn/end` is the only commit point, so a Turn in flight
 * shows the previous Turn's numbers instead of half-billed ones — a step that
 * has not settled has no usage record at all yet (`usage` arrives with
 * `assistant/message`, and the `usage` stream chunk precedes the terminal
 * finish), and reporting a partial numerator over a partial denominator would
 * be exactly the frontend guessing requirement 2.4 forbids. A Turn that never
 * entered a step commits nothing and leaves the previous figures standing.
 *
 * @module turn-stats
 */

import { assistantStreamFirstTokenTime } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

/** Projection key this plugin owns. Read on the client with `useProjection`. */
export const TURN_STATS_KEY = "turnStats";

/**
 * Bump whenever a state field or a fold rule changes: the registry rejects a
 * re-registration under a key whose `stateVersion` disagrees with a cached cell.
 */
export const TURN_STATS_STATE_VERSION = 1;

/** The projection's client-facing shape: one completed Turn's figures. */
export const turnStatsSchema = z
  .object({
    /** The Turn these figures belong to; informational, for debugging and tests. */
    turn: z.number().int().nonnegative(),
    /** Summed decode wall time (first token → `assistant/message`) in ms. */
    decodeMs: z.number().nonnegative(),
    /** Provider output tokens over the same decode-timed steps. */
    decodeTokens: z.number().nonnegative(),
    /** Summed cache-read input tokens. */
    cacheReadTokens: z.number().nonnegative(),
    /** Summed billed input: the three disjoint prompt buckets added together. */
    billedInputTokens: z.number().nonnegative(),
  })
  .strict();

/** One step's lifecycle boundary, mirroring the host fold's `openStep`. */
const stepBoundarySchema = z
  .object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    firstTokenTime: z.number().nonnegative().nullable(),
  })
  .strict();

/** One Turn's accumulators plus the step currently being folded. */
const openTurnSchema = turnStatsSchema
  .extend({
    /** Steps that settled (`assistant/message`) in this Turn, for the commit gate. */
    settledSteps: z.number().int().nonnegative(),
    step: stepBoundarySchema.nullable(),
  })
  .strict();

/** Fold state: the Turn being folded and the last committed Turn. */
export const turnStatsStateSchema = z
  .object({
    open: openTurnSchema.nullable(),
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
 * @param {number} turn
 * @returns {import('./turn-stats.js').z.infer<typeof openTurnSchema>}
 */
function openBucket(turn) {
  return {
    turn,
    decodeMs: 0,
    decodeTokens: 0,
    cacheReadTokens: 0,
    billedInputTokens: 0,
    settledSteps: 0,
    step: null,
  };
}

/** @returns {import('./turn-stats.js').z.infer<typeof turnStatsStateSchema>} */
export function initialTurnStatsState() {
  return { open: null, last: null };
}

/** Whether one event belongs to the step the fold is currently inside. */
function matchesStep(step, event) {
  return step !== null && step.turn === event.data.turn && step.step === event.data.step;
}

/** The same boundary the host fold uses: a step may report its token time early. */
function firstTokenOf(step, stream) {
  if (step.firstTokenTime !== null) return step.firstTokenTime;
  const time = Array.isArray(stream) ? assistantStreamFirstTokenTime(stream) : void 0;
  return typeof time === "number" && Number.isFinite(time) && time >= 0 ? time : null;
}

/**
 * Fold one durable event.
 *
 * Every event that changes nothing returns the identical reference: the
 * projection registry gates its change feed on `Object.is`, so returning a
 * fresh-but-equal object would push a wire update per event for free.
 *
 * @param {import('./turn-stats.js').z.infer<typeof turnStatsStateSchema>} state
 * @param {any} event - one durable Session event.
 * @returns the same state, or the folded successor.
 */
export function applyTurnStatsEvent(state, event) {
  switch (event?.type) {
    case "step/start": {
      const turn = count(event.data?.turn);
      const step = count(event.data?.step);
      if (turn === void 0 || step === void 0) return state;
      // A new Turn's first step closes the previous chapter: an abandoned Turn
      // is never published, so its partial accumulators are dropped, not frozen.
      const base = state.open !== null && state.open.turn !== turn ? openBucket(turn) : (state.open ?? openBucket(turn));
      return { ...state, open: { ...base, turn, step: { turn, step, firstTokenTime: null } } };
    }

    case "assistant/attempt": {
      const open = state.open;
      if (open === null || !matchesStep(open.step, event)) return state;
      if (open.step.firstTokenTime !== null) return state;
      const time = firstTokenOf(open.step, event.data?.stream);
      if (time === null) return state;
      return { ...state, open: { ...open, step: { ...open.step, firstTokenTime: time } } };
    }

    case "assistant/message": {
      const open = state.open;
      if (open === null || !matchesStep(open.step, event)) return state;
      const time = count(event.time);
      const firstToken = firstTokenOf(open.step, event.data?.stream);
      const usage = event.data?.usage;
      const next = {
        ...open,
        settledSteps: open.settledSteps + 1,
        step: null,
      };
      // Decode time and output tokens move together, exactly as the host fold
      // couples them: a step that never reported output tokens has no honest
      // rate, so it contributes to neither side.
      const outputTokens = count(usage?.outputTokens);
      if (time !== void 0 && firstToken !== null && outputTokens !== void 0) {
        next.decodeMs += Math.max(0, time - firstToken);
        next.decodeTokens += outputTokens;
      }
      next.cacheReadTokens += counted(usage?.cacheReadTokens);
      next.billedInputTokens +=
        counted(usage?.inputTokens) + counted(usage?.cacheReadTokens) + counted(usage?.cacheWriteTokens);
      return { ...state, open: next };
    }

    case "turn/end": {
      const open = state.open;
      if (open === null) return state;
      // No step ever settled (a Turn interrupted before its first model call, or
      // one whose every step failed before assembling a message): nothing
      // provable was produced, so the previous Turn's figures stay on screen —
      // publishing zeros would blank both pills, and the chosen empty state is
      // "show the previous Turn", not "show nothing".
      if (open.settledSteps === 0) return { ...state, open: null };
      const { step: _step, settledSteps: _settled, ...committed } = open;
      return { open: null, last: committed };
    }

    default:
      return state;
  }
}

/**
 * The wire view: the last completed Turn, or `null` before the first one.
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
    // Nullable because the view is null before the first completed Turn; see
    // `turnStatsView` for why an absent value is not an option here.
    viewSchema: turnStatsSchema.nullable(),
    view: turnStatsView,
    // Same as the host's `sessionStats`: these figures belong to one open
    // session, not to a list row, so they stay out of summary payloads.
    summary: false,
  },
};
