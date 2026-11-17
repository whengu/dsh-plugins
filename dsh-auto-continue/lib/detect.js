/**
 * Pure decision helpers for dsh-auto-continue.
 *
 * No Harness import, no filesystem, no state: the boot orchestrator feeds it
 * plain data (decoded event arrays, stat-derived entries) and it answers three
 * questions — what is the last turn boundary, which entries are newest, and is
 * the last boundary an open turn that warrants a continuation.
 *
 * The boundary scan is exact, not a heuristic: `turn/start` and `turn/end`
 * alternate and the LAST boundary decides the tail state. A tail left at
 * `turn/start` means the process died mid-turn (crash leftover); `turn/end`
 * (or no boundary at all) means nothing to continue.
 *
 * @module dsh-auto-continue/detect
 */

/** Boundary type that opens a turn. */
const TURN_START = 'turn/start'

/** Boundary type that closes a turn. */
const TURN_END = 'turn/end'

/**
 * Find the last turn boundary in an event list.
 *
 * @param events - decoded events, oldest first.
 * @returns `{type, seq, time, ...}` of the last `turn/start` | `turn/end`, or null.
 */
export function lastTurnBoundary(events) {
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === TURN_START || event?.type === TURN_END) return event
  }
  return null
}

/**
 * Whether the last turn boundary is an open `turn/start` (a crash leftover).
 *
 * @param events - decoded events, oldest first.
 * @returns true only when the last boundary opens an unfinished turn.
 */
export function canContinue(events) {
  const boundary = lastTurnBoundary(events)
  return boundary !== null && boundary.type === TURN_START
}

/**
 * Rank entries by modification time, newest first, and take the top N.
 *
 * Entries without a finite `mtimeMs` are dropped: a backend that cannot report
 * when an artifact was last written cannot say which session was running, and
 * guessing would be worse than doing nothing. Input is not mutated.
 *
 * @param entries - `{ id, path, mtimeMs }` records (mtimeMs may be absent).
 * @param n - how many of the newest to keep.
 * @returns the newest entries, newest first, at most `n` long.
 */
export function rankRecent(entries, n) {
  if (!Array.isArray(entries)) return []
  const known = entries.filter((entry) => typeof entry?.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs))
  known.sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (!Number.isFinite(n) || n <= 0) return []
  return known.slice(0, n)
}
