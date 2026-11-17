/**
 * Host half of dsh-auto-continue.
 *
 * Once per Host start it runs a pure-read scan (see lib/boot.js): rank the
 * newest persisted sessions, skip live ones, read each tail window, resume the
 * sessions whose last turn boundary is an open `turn/start`, and queue one
 * "good-will hint" message that hands the continue/no-continue decision back to
 * the model. The plugin writes no files, keeps no ledger, and touches no log
 * content — DSH's `resume` owns the repair and the write lock.
 *
 * Loading the plugin IS the enable switch; disabling it means disabling the
 * plugin itself. There is no per-plugin on/off setting and no toggle route.
 *
 * A read-only, owner-only status route exposes the last scan result held in
 * memory for the optional browser half. Owner admission is guaranteed by the
 * Connection carrier, which returns 403 for non-owners.
 *
 * Zero runtime dependencies: only `node:*` and local modules; the host services
 * are reached exclusively through `ctx` (no Harness package imports).
 *
 * @module dsh-auto-continue
 */

import { randomUUID } from 'node:crypto'

import { runBoot } from './boot.js'

/** Stable plugin id for the Loader row. */
export const name = 'auto-continue'

/** Hard service dependencies; absence leaves this row inactive. */
export const inject = ['agents', 'sessionPersistence']

/** Plugin version reported on the status route (kept in sync with package.json). */
export const VERSION = '0.2.4'

/** Delay before the one-shot boot scan, so other startup components settle. */
export const BOOT_DELAY_MS = 5000

/** The owner-only status route the browser half reads. */
export const STATUS_PATH = '/api/auto-continue/status'

/**
 * The continuation instruction: an automatically injected, advisory hint — not
 * an order. It states what the log actually supports (a mid-turn crash leaves
 * an open turn, and an uncompleted tool call's effect is unknown), hands the
 * decision back to the model, and tells it not to repeat finished work.
 */
export const CONTINUATION_TEXT = [
  '[系统自动提示 · 仅供参考]',
  '这是系统自动注入的一条提示：上次进程异常退出后由系统自动加入，仅供参考，不是用户的真实指令。',
  '请自行判断：当前任务是否仍应继续推进。',
  '- 若你判断任务尚未完成，可以从当前工作区与会话历史出发继续；',
  '- 若你判断任务已经完成，或继续会有风险，请直接结束，不要重复执行任何步骤；',
  '- 对于上次中断时结果不明的工具调用（可能有副作用），请先核实外部状态，不要盲目重试。',
  '是否继续、如何继续，完全由你决定。',
].join('\n')

/** Producer tag on the queued message; the log requires only a non-empty kind. */
const PRODUCER = Object.freeze({ kind: 'auto-continue' })

/**
 * Build the one user-role hint queued onto a resumed session.
 *
 * The `id` is MANDATORY, not decoration: `followup()` routes this object through
 * the inbox into `session.append("user/message", message)`, and the persistence
 * layer's cold-read validation (`assertMessageEventShape`) rejects any
 * `user/message` whose message lacks a non-empty string id — that would make the
 * resumed session permanently unreadable. DSH's own `createUserMessage` injects
 * `id: brandString(randomUUID())`; `brandString` is the identity at runtime, so
 * a plain `node:crypto.randomUUID()` produces the same wire value without any
 * Harness import (T1). The object is deeply frozen because it is published to
 * the session log.
 *
 * Exported for the check script (A7 asserts the advisory semantics and the id).
 *
 * @returns a frozen, fully identified user message carrying the advisory text.
 */
export function continuationMessage() {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: CONTINUATION_TEXT })]),
    source: PRODUCER,
  })
}

/** Render a thrown value without assuming it is an Error. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Best-effort warn that never lets logging break boot. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`auto-continue: ${message}`)
  } catch {
    // A throwing logger must not turn a diagnostic into a startup failure.
  }
}

/**
 * Parse a Connection client-request envelope (the carrier's rpc.call shape).
 *
 * @param request - incoming Fetch API request.
 * @returns `{rpcId, payload}` or undefined when the envelope is unparseable.
 */
async function readClientRequest(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return undefined
  }
  if (body?.type !== 'client-request' || typeof body.rpcId !== 'string') return undefined
  return { rpcId: body.rpcId, payload: body.payload }
}

/**
 * Plugin body: schedule one boot scan, own the handles it creates, and expose
 * the read-only status route.
 *
 * @param ctx - Host context carrying `agents`, `sessionPersistence`, optionally `connection`.
 */
export function apply(ctx) {
  const handles = new Set()
  /** Last scan result, held only in memory for the status route. */
  const state = { lastScan: null, version: VERSION }

  ctx.effect(() => {
    let timer
    const disposers = []

    const scan = async () => {
      timer = undefined
      try {
        state.lastScan = await runBoot(ctx, {
          handles,
          continuationMessage,
          warn: (message) => warn(ctx, message),
        })
      } catch (error) {
        warn(ctx, `scan failed: ${describe(error)}`)
      }
    }

    timer = setTimeout(scan, BOOT_DELAY_MS)
    // A boot scan must not keep a shutting-down process alive.
    timer.unref?.()

    // Status route: read via ctx.get (connection is not in the frozen inject
    // list). Owner-only admission is enforced by the carrier (non-owner -> 403).
    // It is optional show-and-tell; a profile without Connection simply has no UI.
    let connection
    try {
      connection = ctx.get?.('connection')
    } catch {
      connection = undefined
    }
    if (connection?.fetch?.register !== undefined) {
      try {
        disposers.push(connection.fetch.register({
          path: STATUS_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const envelope = await readClientRequest(request)
            if (envelope === undefined) {
              return new Response('invalid client-request envelope', { status: 400 })
            }
            return Response.json({
              type: 'server-response',
              rpcId: envelope.rpcId,
              result: { ok: true, value: { lastScan: state.lastScan, version: VERSION } },
            })
          },
        }))
      } catch (error) {
        warn(ctx, `status route registration failed: ${describe(error)}`)
      }
    }

    return () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* teardown is best-effort */ }
      }
      // The agents this plugin resumed are its own to release on unload.
      for (const handle of handles) {
        try {
          Promise.resolve(handle.dispose()).catch((error) => warn(ctx, `dispose failed: ${describe(error)}`))
        } catch (error) {
          warn(ctx, `dispose failed: ${describe(error)}`)
        }
      }
      handles.clear()
    }
  }, 'auto-continue: boot scan')
}
