/**
 * Resolver hook installed by `host-packages.mjs` (tests only).
 *
 * The two host packages the plugin imports are aliased to the files inside the
 * installed dsh; every other specifier — relative imports and the host packages'
 * own dependencies — falls through to Node's resolver unchanged.
 */

/** @type {Map<string, string>} */
let aliases = new Map();

/**
 * @param {{ entries?: Record<string, string> } | undefined} data
 */
export async function initialize(data) {
  aliases = new Map(Object.entries(data?.entries ?? {}));
}

/**
 * @param {string} specifier
 * @param {object} context
 * @param {(specifier: string, context: object) => Promise<{ url: string }>} nextResolve
 */
export async function resolve(specifier, context, nextResolve) {
  const url = aliases.get(specifier);
  if (url !== undefined) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
