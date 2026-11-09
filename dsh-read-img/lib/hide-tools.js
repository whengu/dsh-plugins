/**
 * Keep tools this deployment cannot use out of the model's view.
 *
 * Why: `read_image` ships with the host (`dsh-tool-fs`), always registers, and
 * only refuses at execution time — on a text-only route it hands back an image
 * block that the request projection replaces with
 * `[image omitted because this model accepts text only; …]`. The model sees a
 * plausible tool, calls it, and burns a turn on a placeholder. Filtering the
 * declaration stops that at the source; the pre-execute guard turns a call that
 * still happens (history, hallucination) into a redirect instead of a dead end.
 *
 * Failure policy: fail open. Every path is wrapped, and anything unexpected
 * returns `next()` — a hider that cannot understand the request must never
 * break the request.
 */

/** Name list → Set, for callers that prune repeatedly. */
export function hiddenSet(names) {
  return new Set((names ?? []).filter((name) => typeof name === "string" && name.length > 0));
}

/**
 * Drop hidden tools from a declaration list.
 * @param {readonly {name?: unknown}[] | undefined} tools
 * @param {Set<string>} hidden
 * @returns {readonly {name?: unknown}[] | undefined} the same array when nothing matched.
 */
export function filterTools(tools, hidden) {
  if (!Array.isArray(tools) || hidden.size === 0) return tools;
  if (!tools.some((tool) => hidden.has(tool?.name))) return tools;
  return tools.filter((tool) => !hidden.has(tool?.name));
}

/**
 * Install the request filter and the execution guard.
 * @param {any} ctx - cordis context carrying `llm` and `tools`.
 * @param {() => { hideTools: string[] }} getConfig
 */
export function installToolHider(ctx, getConfig) {
  ctx.on("llm/stream", (options, next) => {
    try {
      const hidden = hiddenSet(getConfig().hideTools);
      if (hidden.size === 0) return next();
      const tools = filterTools(options?.tools, hidden);
      if (tools === options?.tools) return next();
      // Re-enter the waterfall with the pruned request. The filter is
      // idempotent, so the second pass finds nothing to remove and takes
      // `next()` — no recursion.
      return ctx.llm.stream({ ...options, tools });
    } catch {
      return next();
    }
  });

  ctx.on("tools/pre-execute", (exec, next) => {
    try {
      const name = exec?.name;
      if (typeof name !== "string") return next();
      if (!hiddenSet(getConfig().hideTools).has(name)) return next();
      return {
        kind: "deny",
        reason:
          `${name} is hidden in this deployment: the chat model cannot accept image input, so this tool only returns a placeholder. ` +
          "Use read_img with the image's path instead.",
      };
    } catch {
      return next();
    }
  });
}
