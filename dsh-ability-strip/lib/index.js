/**
 * Host half of dsh-ability-strip.
 *
 * The browser can read the skill catalog and the Loader inventory on its own, but
 * it has **no** way to see the tool registry: which tools are actually registered,
 * and therefore whether each configured MCP server really connected. A server that
 * fails to connect registers no `mcp__<server>__*` tools, so the registry is the
 * only browser-visible evidence of a live MCP connection.
 *
 * This half answers one question and nothing else — *what does this session's model
 * get offered* — in three parts:
 *
 *   - read `ctx.tools.schemas(agent)` for the session's agent, which is the same
 *     call the real executors make, so `restrict()` masks and scoped shadowing are
 *     applied exactly as a model step sees them;
 *   - split that catalog into the MCP servers (names follow `mcp__<server>__<tool>`)
 *     and everything else, keeping each tool's own description so the panel can say
 *     what a tool is for;
 *   - answer on one exact, owner-only Connection route.
 *
 * ## No change stream, by decision
 *
 * This half used to hold one Server-Sent Events stream per browser tab and push a
 * frame whenever the registry moved. It does not any more. The strip is a
 * read-on-demand view now: it reads when it mounts, when the session changes, when
 * the panel opens, and when the reader asks for a refresh. Nothing is pushed, no
 * timer runs, and there is no open connection per tab.
 *
 * ## What survives without a live agent
 *
 * `agents.get(sessionId)` resolves only while that session's agent is alive in this
 * Host process — the session controller resumes one on demand. When there is no
 * agent, there is no current answer, and this half will not invent one from the
 * deployment catalog.
 *
 * It CAN answer from memory: whenever a read is served by a live agent, the answer
 * is remembered per session (bounded), so a session whose agent has since been
 * released still shows the numbers it really had — marked `stale` with the time it
 * was read. That memory lives and dies with this process. After a Host restart
 * there is nothing to remember, and the browser is told exactly that.
 *
 * Deliberately NOT done: reading the persisted session log to recover a past
 * declaration. Those logs are zstd-compressed and run to tens of megabytes, so
 * folding one per panel open is not a cost this view may impose, and a read-only
 * display plugin should not be writing sidecar files to reconstruct it either.
 *
 * @module dsh-ability-strip
 */

import z from "@deepseek-ai/schemastery";

/** Stable plugin id for the Loader row. */
export const name = "ability-strip";

/**
 * Services this half waits for. `connection` provides the owner-only Fetch route
 * registry; `tools` is the registry being read. Declaring both keeps activation
 * behind real availability instead of failing on first use.
 */
export const inject = ["connection", "tools"];

/**
 * How many viewing scopes keep a cached answer, and how many remember their last
 * agent answer. Both are bounded so a long-lived Host serving many sessions cannot
 * accumulate catalogs without limit.
 */
export const MAX_CACHED_SCOPES = 8;

/**
 * Longest parameter schema carried to the browser, in characters.
 *
 * The panel shows a tool's `parameters` because that is the part that actually
 * costs context on every request — a name and a description are noise next to a
 * nested object schema. It is capped for the same reason the description is: one
 * pathological schema must not turn a panel read into a megabyte. A cut schema is
 * reported as `schemaTruncated`, so the panel can say "this is a preview" instead
 * of silently showing half a JSON document.
 */
export const MAX_SCHEMA_CHARS = 6000;

/**
 * Longest description carried to the browser, exclusive of the ellipsis.
 *
 * The catalog is the only place a tool's own words exist, and the panel shows them
 * next to the name — that is the answer to "what is this tool actually for". The
 * cap is a wire bound, not a judgement: a pathological description cannot turn one
 * panel read into a megabyte. A cut description keeps `MAX_DESCRIPTION_CHARS`
 * characters **plus** the `…` marker, so the marker is never what got trimmed off.
 */
export const MAX_DESCRIPTION_CHARS = 400;

/**
 * Deployment knobs. Every one of these is a bound this half already enforced as a
 * literal; exposing them turns "I wish the panel showed the whole schema" into a
 * config edit instead of a fork, and makes the values visible in `cordis.patch.yml`
 * where an operator is already looking.
 *
 * Deliberately absent: anything that would change WHAT is reported. The strip's
 * job is to state what the registry holds, and a knob that let it report something
 * else would make the number untrustworthy. These only widen or narrow how much
 * detail travels, and how long an answer is kept.
 */
export const Config = z.object({
	/** Longest parameter schema sent to the browser; a longer one is previewed. */
	maxSchemaChars: z.number().step(1).min(0).default(MAX_SCHEMA_CHARS),
	/** Longest tool description sent to the browser; a longer one is truncated. */
	maxDescriptionChars: z.number().step(1).min(0).default(MAX_DESCRIPTION_CHARS),
	/** How many sessions' remembered answers may be held at once. */
	maxRememberedSessions: z.number().step(1).min(1).default(MAX_CACHED_SCOPES),
});

/** Carrier channel: the shared `/api` route the Connection mounts itself. */
export const ROUTE_CHANNEL = "/api";

/**
 * Endpoint this plugin owns inside that channel. `connection.rpc.call` posts to
 * `<channel>/<endpoint>`, so this value and the client's must stay identical.
 */
export const ROUTE_ENDPOINT = "ability-strip";

/** Prefix the MCP client puts on every tool it registers. */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * Split an MCP tool name into its server and tool parts.
 *
 * The MCP client names tools `mcp__<server>__<tool>`. This is a **heuristic**
 * reverse of that convention: the harness never parses the public name back
 * (`dsh-mcp-client` documents "the public name is never parsed to recover it"),
 * so there is no authoritative rule to mirror. The split at the **last**
 * separator handles server names that themselves contain `__`. Known limitation:
 * a tool whose raw name contains `__` is ambiguous and may be attributed to the
 * wrong server.
 * @param toolName - a registered tool name.
 * @returns the server name and tool name, or undefined for a non-MCP tool.
 */
export function splitMcpToolName(toolName) {
	if (typeof toolName !== "string" || !toolName.startsWith(MCP_TOOL_PREFIX)) {
		return void 0;
	}
	const separator = toolName.lastIndexOf("__");
	// A separator at or before the prefix means the name carries no server part.
	if (separator <= MCP_TOOL_PREFIX.length - 1) return void 0;
	const server = toolName.slice(MCP_TOOL_PREFIX.length, separator);
	if (server.length === 0) return void 0;
	const tool = toolName.slice(separator + 2);
	return { server, tool };
}

/**
 * The bounds in force when the deployment says nothing.
 *
 * One object rather than three separate constants: these travel together through
 * `toolEntry` and both summarizers, and a call site that had to name them one by
 * one would eventually pass two out of three.
 *
 * `maxRememberedSessions` is declared here even though only the reader uses it, so
 * that every limit has exactly one default and a caller never has to know which
 * fields are optional.
 */
export const DEFAULT_LIMITS = Object.freeze({
	maxDescriptionChars: MAX_DESCRIPTION_CHARS,
	maxSchemaChars: MAX_SCHEMA_CHARS,
	maxRememberedSessions: MAX_CACHED_SCOPES,
});

/**
 * One tool as the panel needs it: name, its own description, its parameter schema,
 * and how big that schema is.
 *
 * `schemaChars` is measured on the FULL schema, before any cap, because it is the
 * number the reader is meant to act on: it is a proxy for what every request pays.
 * @param name - the tool name without any MCP server prefix.
 * @param schema - the schema that carried it.
 * @returns the entry, with description and schema capped for the wire.
 */
function toolEntry(name, schema, limits = DEFAULT_LIMITS) {
	const raw = typeof schema?.description === "string" ? schema.description.trim() : "";
	const description =
		raw.length > limits.maxDescriptionChars
			? `${raw.slice(0, limits.maxDescriptionChars)}…`
			: raw;
	// `parameters` is a JSON-Schema object; serializing it is the only honest way to
	// size it. A tool without parameters still costs something (an empty object), so
	// the measurement is of what would actually be sent.
	let schemaText = "";
	let schemaChars = 0;
	try {
		schemaText = schema?.parameters === void 0 ? "" : JSON.stringify(schema.parameters);
		schemaChars = schemaText.length;
	} catch {
		// A cyclic or otherwise unserializable schema cannot be sized; report it as
		// unknown rather than guessing a number.
		schemaChars = -1;
	}
	const schemaTruncated = schemaChars > limits.maxSchemaChars;
	return {
		name,
		description,
		schemaChars,
		...(schemaText === "" ? {} : { schema: schemaTruncated ? `${schemaText.slice(0, limits.maxSchemaChars)}…` : schemaText }),
		...(schemaTruncated ? { schemaTruncated: true } : {}),
	};
}

/**
 * Group the registry's tool names into per-server MCP counts.
 *
 * A server appears here only because at least one of its tools is registered
 * right now. That is deliberately the ONLY evidence used: `dsh-mcp-client` keeps
 * its connection object (`ready`, `connectedAt`, the retry supervisor) private,
 * so a server that connected successfully but exposes **no** tools is
 * indistinguishable from one that never connected — both register nothing.
 * The strip therefore reports both as not connected, which is the safe reading:
 * a server whose tools are unavailable is not usable even if its socket is up.
 * @param schemas - model-facing tool schemas from `ctx.tools.schemas(...)`.
 * @returns one entry per server that has a registered tool, each tool carrying its
 * description; servers sorted by name, tools sorted by name.
 */
export function summarizeMcpTools(schemas, limits = DEFAULT_LIMITS) {
	/** @type {Map<string, { name: string, description: string }[]>} */
	const byServer = new Map();
	for (const schema of Array.isArray(schemas) ? schemas : []) {
		const split = splitMcpToolName(schema?.name);
		if (split === void 0) continue;
		const entry = toolEntry(split.tool, schema);
		const tools = byServer.get(split.server);
		if (tools === void 0) byServer.set(split.server, [entry]);
		else tools.push(entry);
	}
	return [...byServer.entries()]
		.map(([server, tools]) => ({
			server,
			tools: tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
		}))
		.sort((left, right) => (left.server < right.server ? -1 : left.server > right.server ? 1 : 0));
}

/**
 * Split one catalog into its MCP half and everything else.
 *
 * "Everything else" is deliberately called `local` rather than "built-in": the
 * schemas carry no origin field, so a tool registered by a plugin and one
 * shipped with the Harness are indistinguishable here. Naming the bucket after
 * what is actually known (not an MCP server) avoids inventing a distinction the
 * registry does not expose.
 * @param schemas - model-facing tool schemas from `ctx.tools.schemas(...)`.
 * @returns per-server MCP tools plus the sorted non-MCP tools, each with its description.
 */
export function summarizeTools(schemas, limits = DEFAULT_LIMITS) {
	/** @type {{ name: string, description: string }[]} */
	const local = [];
	for (const schema of Array.isArray(schemas) ? schemas : []) {
		const name = schema?.name;
		if (typeof name !== "string" || name.length === 0) continue;
		// A name that parses as an MCP tool belongs to a server, not to `local`.
		if (splitMcpToolName(name) !== void 0) continue;
		local.push(toolEntry(name, schema, limits));
	}
	return {
		servers: summarizeMcpTools(schemas, limits),
		local: local.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)),
	};
}

/**
 * Resolve the Agent a session id names, so the catalog can be read from that
 * agent's point of view.
 *
 * `ctx.tools.schemas(agent)` is what the real executors use
 * (`dsh-tool-executor-ptc`: `tools.schemas(exec.agent, exec.toolSet)`,
 * `dsh-tool-cordis`: `ctx.tools.schemas(context.agent)`), and passing the agent
 * is what applies `ctx.tools.restrict()` masks and scoped shadowing. Omitting it
 * yields the global view, which is what a caller with no session gets.
 *
 * `agents` is read through `ctx.get` rather than added to `inject`: a profile
 * without the agent service should still render the global catalog instead of
 * leaving this row inactive.
 * @param ctx - Host context.
 * @param sessionId - the session whose agent should be the viewing scope.
 * @returns the live agent, or undefined for the global view.
 */
function resolveAgent(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
	try {
		return ctx.get?.("agents")?.get?.(sessionId);
	} catch {
		// A throwing lookup degrades to the global view; the payload says which
		// view it served, so a degraded answer is visible rather than silent.
		return void 0;
	}
}

/**
 * Read the live tool registry and summarize it.
 *
 * Never throws: a registry read failure becomes `error`, so the browser can state
 * the failure instead of silently reporting "no MCP tools".
 * @param ctx - Host context providing `tools`.
 * @param sessionId - optional session whose agent defines the viewing scope.
 * @returns the summary, or a diagnostic instead of a throw.
 */
export function readToolSummary(ctx, sessionId, limits = DEFAULT_LIMITS) {
	try {
		const agent = resolveAgent(ctx, sessionId);
		// Omitting the scope is the documented global view; passing the agent is
		// the same call the tool executor makes for a real model step.
		const schemas = agent === void 0 ? ctx.tools.schemas() : ctx.tools.schemas(agent);
		const { servers, local } = summarizeTools(schemas, limits);
		return {
			ok: true,
			/**
			 * Which view answered. `agent` means restrictions and scoped shadowing
			 * were applied; `global` means the session's agent was not available
			 * (no session id, or no live agent for it), so the answer describes the
			 * deployment's registered catalog instead.
			 */
			scope: agent === void 0 ? "global" : "agent",
			totalTools: Array.isArray(schemas) ? schemas.length : 0,
			servers,
			local,
			readAt: new Date().toISOString(),
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Wrap {@link readToolSummary} in a cache plus a per-session memory of the last
 * answer a **live agent** produced.
 *
 * Two different maps, for two different jobs:
 *
 *   - `cached` holds the current answer per scope and is dropped whenever the
 *     registry moves (`tools/change`), because that is exactly when it can go
 *     stale;
 *   - `remembered` holds the last agent-scope answer per session and is NOT dropped
 *     on registry change, because it is history, not a cache. It is what lets the
 *     strip keep showing a session's real numbers after its agent was released.
 *
 * @param ctx - Host context providing `tools`.
 * @returns the reader and its disposer.
 */
export function createToolSummaryReader(ctx, limits = DEFAULT_LIMITS) {
	/** @type {Map<string, object>} */
	let cached = new Map();
	/**
	 * Last answer a live agent produced, per session id.
	 *
	 * Written only when `scope === "agent"`, so it can never hold a deployment-catalog
	 * answer dressed up as a session answer. Survives `tools/change` on purpose.
	 * @type {Map<string, { summary: object, at: string }>}
	 */
	let remembered = new Map();
	/** Drop caches only: the registry moved, so current answers are stale. */
	const invalidate = () => {
		cached.clear();
	};
	const off = ctx.on("tools/change", invalidate);
	/** Bound a map by dropping the oldest inserted key. */
	const bound = (map) => {
		while (map.size > (limits.maxRememberedSessions ?? MAX_CACHED_SCOPES)) {
			const oldest = map.keys().next();
			if (oldest.done === true) break;
			map.delete(oldest.value);
		}
	};
	return {
		/**
		 * Answer for one viewing scope.
		 *
		 * Order of preference: the cached answer for this session, then a fresh read
		 * (which remembers itself when a live agent served it), then the remembered
		 * answer marked `stale`, then the deployment catalog marked `global`.
		 * @param sessionId - the session whose agent should answer, if any.
		 * @returns the summary the browser renders.
		 */
		read(sessionId) {
			const key = typeof sessionId === "string" ? sessionId : "";
			// Liveness is part of the answer, not just a hint: "this is what your session
			// has now" is false the moment its agent is released, and equally false the
			// other way round. A session whose first read happened while it had no agent
			// caches a `global` answer; when the agent is later resumed there is no
			// `tools/change` to clear it (the registry itself did not move), so a cached
			// `global` answer would be served forever and the strip would be stuck at
			// "no active agent" even after the session came alive. A hit is therefore only
			// reusable when its scope still matches reality; the check is one map lookup
			// and no registry clone.
			const alive = resolveAgent(ctx, sessionId) !== void 0;
			const hit = cached.get(key);
			if (hit !== void 0 && (hit.scope === "agent") === alive) {
				// Refresh insertion order so eviction is least-recently-USED, not
				// first-come: a session the reader keeps opening must not be the one
				// dropped for an older one they never revisited.
				cached.delete(key);
				cached.set(key, hit);
				return hit;
			}
			const result = readToolSummary(ctx, sessionId, limits);
			if (result.ok !== true) return result;
			if (result.scope === "agent") {
				remembered.delete(key);
				remembered.set(key, { summary: result, at: result.readAt });
				bound(remembered);
			} else {
				// No live agent this time. A remembered answer is this session's own
				// numbers from when it did have one, so it beats the deployment catalog —
				// and it is marked, with its own timestamp, so the browser can say so.
				const past = remembered.get(key);
				if (past !== void 0) {
					// Not cached: the next read must be free to find a live agent again.
					return { ...past.summary, stale: true, recordedAt: past.at };
				}
			}
			// Cache only successful current answers. A transient failure must not stick,
			// and a stale answer must not be cached (a fresh read should win next time).
			cached.set(key, result);
			bound(cached);
			return result;
		},
		/** How many sessions currently remember a last-known answer (introspection). */
		get remembered() {
			return remembered.size;
		},
		dispose() {
			off();
			cached.clear();
			remembered.clear();
		},
	};
}

/**
 * Plugin body: register the answer route.
 *
 * The route speaks the shared `/api` carrier's client-request envelope, which is
 * what `connection.rpc.call(channel, endpoint, payload)` puts on the wire:
 *
 *   request   { type: 'client-request',  rpcId, payload: { sessionId } }
 *   response  { type: 'server-response', rpcId, result }
 *
 * where `result` is `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 * @param ctx - Host context.
 */
export function apply(ctx, config) {
	// Resolve the deployment's bounds once, at activation.
	//
	// `config` may be absent entirely (a patch layer that omits `config:`), or hold
	// only some keys (a hand-written layer that bypasses the schema). Both are
	// legitimate, so each bound falls back independently rather than assuming the
	// schema already filled the object in.
	const limits = Object.freeze({
		maxDescriptionChars: config?.maxDescriptionChars ?? DEFAULT_LIMITS.maxDescriptionChars,
		maxSchemaChars: config?.maxSchemaChars ?? DEFAULT_LIMITS.maxSchemaChars,
		maxRememberedSessions: config?.maxRememberedSessions ?? DEFAULT_LIMITS.maxRememberedSessions,
	});
	ctx.effect(() => {
		// One reader per Loader row: caches the current answer and remembers each
		// session's last agent-scope answer.
		const reader = createToolSummaryReader(ctx, limits);
		const disposeSummary = ctx.connection.fetch.register({
			path: `${ROUTE_CHANNEL}/${ROUTE_ENDPOINT}`,
			// `rpc.call` always POSTs. The body carries only the carrier's envelope,
			// whose `payload` names the viewing session and nothing else.
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const envelope = await readClientRequest(request);
				if (envelope === void 0) {
					return new Response("invalid client-request envelope", { status: 400 });
				}
				// `readToolSummary` never throws: a registry failure becomes
				// `{ ok: false, error }`, which the browser shows as 读取失败. It is
				// still wrapped because an envelope this plugin cannot see must not
				// become a 500 the browser would report as a transport failure.
				let result;
				try {
					// The browser sends the session it is displaying, so the catalog is
					// read from that session's agent (restrictions applied, and the answer
					// remembered for when that agent is gone).
					result = { ok: true, value: reader.read(envelope.payload?.sessionId) };
				} catch (error) {
					result = {
						ok: false,
						error: {
							code: "internal",
							message: error instanceof Error ? error.message : String(error),
							details: {},
						},
					};
				}
				return Response.json({
					type: "server-response",
					rpcId: envelope.rpcId,
					result,
				});
			},
		});
		return () => {
			reader.dispose();
			void disposeSummary();
		};
	}, "ability-strip: tool route");
}

/**
 * Extract this plugin's fields from the carrier's client-request envelope.
 * The carrier has already validated transport-level shape.
 * @param request - incoming Fetch API request.
 * @returns the rpc id and the caller's payload, or undefined when unparseable.
 */
async function readClientRequest(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return void 0;
	}
	if (body?.type !== "client-request" || typeof body.rpcId !== "string") return void 0;
	// The payload carries the caller's arguments (`rpc.call(channel, endpoint, payload)`).
	// The answer route only uses it to name the viewing session, but it is passed
	// through intact so the shape stays the carrier's, not a private convention.
	return { rpcId: body.rpcId, payload: body.payload };
}
