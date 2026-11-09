/**
 * Host half of dsh-ability-strip.
 *
 * The browser can read the skill catalog and the Loader inventory on its own, but
 * it has **no** way to see the tool registry: which tools are actually registered,
 * and therefore whether each configured MCP server really connected. A server
 * that fails to connect registers no `mcp__<server>__*` tools, so the registry is
 * the only browser-visible evidence of a live MCP connection.
 *
 * This half answers one question and nothing else — *what does the tool registry
 * hold for this session* — and it answers it in three parts:
 *
 *   - read `ctx.tools.schemas(agent)` for the session's agent, which is the same
 *     call the real executors make, so `restrict()` masks and scoped shadowing are
 *     applied exactly as a model step sees them;
 *   - split that catalog into the MCP servers (names follow `mcp__<server>__<tool>`)
 *     and everything else, keeping each tool's own description so the panel can say
 *     what a tool is for;
 *   - serve the result on one exact, owner-only Connection route, plus one
 *     Server-Sent Events stream per browser tab that says "the registry moved" the
 *     moment it does, so the strip never has to run a timer.
 *
 * What it reports is the REGISTRY, not the request. A plugin may filter `tools` out
 * of the LLM request afterwards (`dsh-read-img` hides `read_image` that way), and
 * that filter is invisible here; the browser half states this in the panel rather
 * than pretending the two are the same thing.
 *
 * It is read-only: it registers no tool, mutates no registry, edits no config, and
 * holds no state between requests beyond a bounded catalog cache.
 *
 * @module dsh-ability-strip
 */

/** Stable plugin id for the Loader row. */
export const name = "ability-strip";

/**
 * Services this half waits for. `connection` provides the owner-only Fetch route
 * registry; `tools` is the registry being read. Declaring both keeps activation
 * behind real availability instead of failing on first use.
 */
export const inject = ["connection", "tools"];

/** Carrier channel: the shared `/api` route the Connection mounts itself. */
export const ROUTE_CHANNEL = "/api";

/**
 * Endpoint this plugin owns inside that channel. `connection.rpc.call` posts to
 * `<channel>/<endpoint>`, so this value and the client's must stay identical.
 */
export const ROUTE_ENDPOINT = "ability-strip";

/**
 * Endpoint carrying the registry **change** signal, as a Server-Sent Events
 * stream. A sub-path rather than a second method on {@link ROUTE_ENDPOINT}: the
 * answer route is request/response and POST-only (`rpc.call` has no other
 * verb), while this one is an open GET stream, and giving each its own path
 * keeps both contracts readable and independently testable.
 */
export const ROUTE_EVENTS_ENDPOINT = "ability-strip/events";

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
export function summarizeMcpTools(schemas) {
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
 * One tool as the panel needs it: name plus its own description.
 * @param name - the tool name without any MCP server prefix.
 * @param schema - the schema that carried it.
 * @returns the entry, with the description trimmed and capped.
 */
function toolEntry(name, schema) {
	const raw = typeof schema?.description === "string" ? schema.description.trim() : "";
	return {
		name,
		description: raw.length > MAX_DESCRIPTION_CHARS ? `${raw.slice(0, MAX_DESCRIPTION_CHARS)}…` : raw,
	};
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
export function summarizeTools(schemas) {
	/** @type {{ name: string, description: string }[]} */
	const local = [];
	for (const schema of Array.isArray(schemas) ? schemas : []) {
		const name = schema?.name;
		if (typeof name !== "string" || name.length === 0) continue;
		// A name that parses as an MCP tool belongs to a server, not to `local`.
		if (splitMcpToolName(name) !== void 0) continue;
		local.push(toolEntry(name, schema));
	}
	return {
		servers: summarizeMcpTools(schemas),
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
export function readToolSummary(ctx, sessionId) {
	try {
		const agent = resolveAgent(ctx, sessionId);
		// Omitting the scope is the documented global view; passing the agent is
		// the same call the tool executor makes for a real model step.
		const schemas = agent === void 0 ? ctx.tools.schemas() : ctx.tools.schemas(agent);
		const { servers, local } = summarizeTools(schemas);
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
 * How many viewing scopes keep a cached answer.
 *
 * The cache is keyed by session id and dropped wholesale on `tools/change`, but a
 * host can outlive many sessions without any registry change, and each entry holds
 * a whole catalog including descriptions. Without a bound the map would grow with
 * the number of sessions ever opened; with it, the cost of eviction is one
 * `schemas()` read for a scope that comes back, and nothing becomes stale.
 */
export const MAX_CACHED_SCOPES = 8;

/**
 * Wrap {@link readToolSummary} in a cache invalidated by the registry itself, and
 * hand out the same invalidation as a change signal.
 *
 * `ctx.tools.schemas()` deep-clones every visible tool, so calling it on each read
 * would copy the whole catalog. The Host already knows when the answer changes: it
 * emits `tools/change` on every registration, unregistration, and scoped
 * restriction. Hooking that event makes the cache exact — it is dropped precisely
 * when it could be stale, never on a timer.
 *
 * The same single listener feeds {@link createToolSummaryReader}'s change version,
 * which is what the browser's event stream relays. One `tools/change` subscription
 * serves both purposes: an invalidation and a notification are the same fact.
 * @param ctx - Host context providing `tools`.
 * @returns the current summary reader, its change subscriptions, and its disposer.
 */
export function createToolSummaryReader(ctx) {
	/**
	 * One cached answer per viewing scope, keyed by session id.
	 *
	 * The answer is scope-dependent: `schemas(agent)` applies that agent's
	 * restrictions while the global view does not, so a single slot would serve one
	 * tab's answer to another tab whose agent sees a different set. The empty string
	 * keys the global view (a caller with no session id).
	 * @type {Map<string, object>}
	 */
	let cached = new Map();
	/** Bumped once per `tools/change`; read by the event stream, never by a read. */
	let version = 0;
	/** Open change streams (one per browser tab) waiting for the next bump. */
	const listeners = new Set();
	const invalidate = () => {
		// Every cached scope goes together: `tools/change` fires on registration,
		// unregistration, and scoped restriction alike, and this listener cannot
		// tell which agent moved. Dropping the whole map is the cheap exact answer.
		cached.clear();
		version += 1;
		// A copy, so a listener that detaches while being notified cannot disturb
		// the set being walked.
		for (const listener of [...listeners]) listener(version);
	};
	const off = ctx.on("tools/change", invalidate);
	return {
		read(sessionId) {
			// Cache only successful reads. A transient failure (registry not yet
			// ready, a momentary error) must not stick: the next read should retry,
			// not keep serving the stale error until the next `tools/change`.
			const key = typeof sessionId === "string" ? sessionId : "";
			const hit = cached.get(key);
			if (hit !== void 0) return hit;
			const result = readToolSummary(ctx, sessionId);
			if (result.ok) {
				cached.set(key, result);
				// Bound the cache. `Map` iterates in insertion order, so dropping the first
				// key evicts the scope that was cached longest ago. This is insertion
				// order, not true LRU — a hit does not re-order — which is deliberate: it
				// costs one line instead of a recency list, and the worst case is one extra
				// `schemas()` read for a session that returns.
				while (cached.size > MAX_CACHED_SCOPES) {
					const oldest = cached.keys().next();
					if (oldest.done === true) break;
					cached.delete(oldest.value);
				}
			}
			return result;
		},
		/**
		 * Subscribe to registry changes without reading the registry.
		 *
		 * The listener runs once per change and never on subscribe: a new stream
		 * writes the current version itself, which is what lets a browser close
		 * the gap between its own read and this stream opening.
		 * @param listener - called with the new version on every change.
		 * @returns the disposer detaching this listener.
		 */
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Current change version: starts at 0, one bump per registry change. */
		get version() {
			return version;
		},
		/**
		 * How many change streams are currently attached.
		 *
		 * Read-only introspection, and the one thing that makes the leak invariant
		 * testable: every way a stream can end must leave this at 0, or a dead tab's
		 * subscriber outlives its stream for the life of the process.
		 */
		get subscribers() {
			return listeners.size;
		},
		dispose() {
			off();
			listeners.clear();
		},
	};
}

/**
 * Plugin body: register the answer route and the change stream.
 *
 * The answer route speaks the shared `/api` carrier's client-request envelope,
 * which is what `connection.rpc.call(channel, endpoint, payload)` puts on the wire:
 *
 *   request   { type: 'client-request',  rpcId, payload: { sessionId } }
 *   response  { type: 'server-response', rpcId, result }
 *
 * where `result` is `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 * @param ctx - Host context.
 */
export function apply(ctx) {
	ctx.effect(() => {
		// One reader per Loader row: cached, invalidated by `tools/change`, and the
		// single owner of the change subscription both routes share.
		const reader = createToolSummaryReader(ctx);
		// Streams this row has open right now. The carrier tears the routes down on
		// unload, but an open `ReadableStream` has no idea its route is gone: it
		// would keep the response body (and any subscriber) alive forever.
		const streams = new Set();
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
					// read from that session's agent (restrictions applied). Without it
					// the answer is the deployment's global view and says so.
					const sessionId = envelope.payload?.sessionId;
					result = { ok: true, value: reader.read(sessionId) };
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
		const disposeEvents = ctx.connection.fetch.register({
			path: `${ROUTE_CHANNEL}/${ROUTE_EVENTS_ENDPOINT}`,
			// A browser `EventSource` opens this with GET and keeps it open.
			methods: ["GET"],
			requestBody: "buffered",
			// Nothing here reads the registry: the stream carries the change counter
			// only, so opening or holding it costs no `schemas()` clone.
			fetch: (request) => openEventStream(reader, request, streams),
		});
		// `register` returns an async disposer; Cordis awaits it on unload. The
		// `tools/change` listener must go with it, or an unloaded row would keep a
		// listener on a live service; the open streams must go too, or they outlive
		// the routes that serve them.
		return () => {
			for (const shutdown of [...streams]) shutdown();
			reader.dispose();
			void disposeSummary();
			void disposeEvents();
		};
	}, "ability-strip: tool route + change stream");
}

/**
 * Serialize one Server-Sent Events data frame.
 * @param payload - JSON-safe frame body.
 * @returns the complete frame, terminator included.
 */
function sseFrame(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Serve one registry change stream to one browser tab.
 *
 * The stream says *that* the registry moved, never *what* it now holds: the
 * browser answers a frame by calling the answer route, so this path stays free of
 * registry reads and of any per-client state beyond an open response body.
 *
 * End points by path:
 *   - the browser goes away            request signal aborts → close the body
 *   - the plugin unloads              `streams` disposer → close the body
 *   - the consumer cancels the body   `cancel` → detach the subscriber
 *
 * Closing the body matters for more than tidiness: the carrier's request bridge
 * drains the response body until it ends, so a body nobody closes would leak one
 * responder and one subscriber per abandoned tab.
 *
 * Exported so the leak invariant can be proven per teardown path (the reader the
 * route gets is created inside `apply` and is not reachable from outside).
 * @param reader - the shared registry reader and its change subscription.
 * @param request - the open GET request (its signal tracks the browser).
 * @param streams - open-stream registry, so unload can end this one.
 * @returns the streaming response.
 */
export function openEventStream(reader, request, streams) {
	const encoder = new TextEncoder();
	let controller;
	let detach = () => {};
	// The single teardown gate. One flag, not two: a separate "closed" flag would
	// have to be set by the same paths that must still run the teardown, and any
	// path that set it without tearing down would leave the subscriber attached
	// for the lifetime of the process.
	let cleaned = false;
	const shutdown = () => {
		if (cleaned) return;
		cleaned = true;
		streams.delete(shutdown);
		detach();
		try {
			controller?.close();
		} catch {
			// Already errored or cancelled: nothing left to close.
		}
	};
	const body = new ReadableStream({
		start(target) {
			controller = target;
			const send = (text) => {
				if (cleaned) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// The body no longer accepts writes, so this stream is over. Tearing
					// it down here (rather than only flagging it) is the whole point of
					// the catch: a flagged-but-not-torn-down stream would keep its
					// subscriber and its `streams` entry forever.
					shutdown();
				}
			};
			streams.add(shutdown);
			// Any frame means "re-read". The one written on connect closes the gap
			// between the browser's own read and this stream opening — and the gap a
			// dropped stream leaves behind, since `EventSource` reconnects by itself.
			// The number is for anyone reading the wire, not for the browser.
			detach = reader.subscribe((version) => send(sseFrame({ version })));
			send(": ability-strip\n\n");
			send(sseFrame({ version: reader.version }));
			request.signal?.addEventListener("abort", shutdown, { once: true });
			if (request.signal?.aborted === true) shutdown();
		},
		cancel() {
			shutdown();
		},
	});
	return new Response(body, {
		status: 200,
		headers: {
			// The exact prefix the Host's gzip filter skips, so the body is never
			// buffered into one lump by the compression middleware.
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
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
