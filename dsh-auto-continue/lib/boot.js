/**
 * Boot scan orchestration for dsh-auto-continue.
 *
 * Runs ONCE per Host start (scheduled by `lib/index.js`): list persisted
 * sessions, rank the newest N by artifact mtime, skip live ones, read each
 * candidate's tail window, decode the last turn boundary, and resume + followup
 * the crash leftovers. Everything it learns is returned in memory for the read
 *-only status route; NOTHING is written to disk and no state survives the call.
 *
 * All I/O is behind injectable `deps` so a test can drive the whole flow with
 * stubs (and assert the byte ceiling, the N ceiling, live skips, resume+followup,
 * double-check and dispose collection) without a Host.
 *
 * @module dsh-auto-continue/boot
 */

import { open } from 'node:fs/promises'

import { canContinue, rankRecent } from './detect.js'
import { decodeTailFrames } from './frames.js'

/** How many newest sessions to inspect by default. */
export const DEFAULT_RECENT = 10

/** Tail window in bytes: the scan cost is constant regardless of log size. */
export const DEFAULT_WINDOW = 64 * 1024

/**
 * Read at most `window` trailing bytes of a file (default implementation).
 *
 * @param path - artifact path.
 * @param window - maximum bytes to read.
 * @returns the tail Buffer (length <= window).
 */
export async function defaultReadTail(path, window) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const start = Math.max(0, size - window)
    const length = size - start
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/**
 * Render a thrown value without assuming it is an Error.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one boot scan.
 *
 * @param ctx - plugin context carrying `agents` and `sessionPersistence`.
 * @param deps - injectable I/O + hooks (all optional).
 * @returns `{candidates, resumed, skipped}` held only in memory for the UI.
 */
export async function runBoot(ctx, deps = {}) {
  const recentN = Number.isFinite(deps.recent) ? deps.recent : DEFAULT_RECENT
  const window = Number.isFinite(deps.window) ? deps.window : DEFAULT_WINDOW
  const statFn = deps.stat ?? (async (path) => {
    const { stat } = await import('node:fs/promises')
    return stat(path)
  })
  const readTail = deps.readTail ?? defaultReadTail
  const makeMessage = deps.continuationMessage
  const handles = deps.handles
  const warn = typeof deps.warn === 'function' ? deps.warn : () => undefined

  const result = { candidates: [], resumed: [], skipped: [] }

  let snapshots
  try {
    snapshots = await ctx.sessionPersistence.list()
  } catch (error) {
    warn(`list failed: ${describe(error)}`)
    return result
  }

  const entries = []
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const id = snapshot?.header?.id
    const path = snapshot?.location?.path
    // Pending (not yet materialized) snapshots have no location — nothing is
    // on disk to inspect, so skip them. This is correct, not a missed case.
    if (typeof id !== 'string' || id.length === 0 || typeof path !== 'string' || path.length === 0) continue
    let mtimeMs
    try {
      mtimeMs = (await statFn(path)).mtimeMs
    } catch {
      continue // A vanished artifact does not compete for a slot.
    }
    entries.push({ id, path, mtimeMs })
  }

  const recent = rankRecent(entries, recentN)

  // Phase 1 — identify crash leftovers. Each session is isolated so one bad
  // read/parse cannot abort the whole scan.
  const needContinue = []
  for (const entry of recent) {
    if (ctx.agents.get(entry.id) !== undefined) {
      result.skipped.push({ id: entry.id, why: 'live' })
      continue
    }
    let head = []
    try {
      const tail = await readTail(entry.path, window)
      head = decodeTailFrames(tail).events
    } catch (error) {
      warn(`${entry.id}: tail read failed: ${describe(error)}`)
      result.skipped.push({ id: entry.id, why: 'unreadable' })
      continue
    }
    if (!canContinue(head)) {
      result.skipped.push({ id: entry.id, why: 'no-open-turn' })
      continue
    }
    needContinue.push({ id: entry.id })
  }
  result.candidates = needContinue.map((entry) => entry.id)

  // Phase 2 — resume + followup. Second liveness check guards against a
  // session that became live during the scan.
  for (const entry of needContinue) {
    if (ctx.agents.get(entry.id) !== undefined) {
      result.skipped.push({ id: entry.id, why: 'became-live' })
      continue
    }
    let handle
    try {
      handle = await ctx.agents.resume({ resumeSessionId: entry.id })
    } catch (error) {
      warn(`${entry.id}: resume failed: ${describe(error)}`)
      result.skipped.push({ id: entry.id, why: 'resume-failed' })
      continue
    }
    // Hold every handle we created so the plugin can dispose them on unload,
    // even if the ownership check below decides not to follow up.
    handles?.add(handle)
    // Ownership check: if another resume won the race, our handle is not the
    // registered agent — do not queue a followup onto a session we no longer own.
    if (ctx.agents.get(entry.id) !== handle.agent) {
      result.skipped.push({ id: entry.id, why: 'ownership-mismatch' })
      continue
    }
    try {
      handle.agent.followup(makeMessage ? makeMessage() : undefined)
      result.resumed.push(entry.id)
    } catch (error) {
      warn(`${entry.id}: followup failed: ${describe(error)}`)
      result.skipped.push({ id: entry.id, why: 'followup-failed' })
    }
  }

  return result
}
