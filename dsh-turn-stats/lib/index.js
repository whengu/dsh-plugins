/**
 * dsh-turn-stats — host half.
 *
 * Registers the `turnStats` projection unit so the browser can read one
 * completed Turn's decode speed and cache-hit inputs the same way it reads the
 * host's own whole-session figures. Nothing else is registered: no route, no
 * tool, no prompt or message rewriting. The visual half lives in `./client`.
 *
 * Why a projection instead of client-side maths: `practices.md:38` states the
 * Client must not fold session events itself — a value derived from a session is
 * declared as a `wire.view` on the Host projection. It is also the only way to
 * see the whole log: a browser holds a paged window, and a window-scoped fold
 * silently changes meaning as the reader scrolls or the session compacts.
 *
 * @module dsh-turn-stats
 */

import { turnStatsProjectionDefinition } from "./turn-stats.js";

export const name = "dsh-turn-stats";

/** Registration needs the projection registry and nothing else. */
export const inject = ["sessionProjections"];

/**
 * Plugin entry.
 *
 * Awaiting the registration (rather than returning it) is the current contract:
 * the runtime value of `register()` is a callable thenable, and assimilating it
 * into a returned handle is rejected as `Invalid effect`. The owning fiber
 * releases the registration when this plugin unloads.
 *
 * @param {any} ctx - cordis context carrying `sessionProjections`.
 */
export async function apply(ctx) {
  await ctx.sessionProjections.register(turnStatsProjectionDefinition);
}
