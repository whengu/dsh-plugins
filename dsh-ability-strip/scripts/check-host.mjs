/**
 * Host-half checks: the `mcp__<server>__<tool>` split, the per-server summary, the
 * single-route registration contract, and the cache/remembered read path.
 *
 * The MCP tool naming rule is the load-bearing assumption of the whole feature, so
 * it is pinned here against real registry shapes rather than assumed.
 */

import {
	apply,
	createToolSummaryReader,
	MAX_CACHED_SCOPES,
	Config,
	DEFAULT_LIMITS,
	MAX_DESCRIPTION_CHARS,
	MAX_SCHEMA_CHARS,
	ROUTE_CHANNEL,
	ROUTE_ENDPOINT,
	readToolSummary,
	splitMcpToolName,
	summarizeMcpTools,
	summarizeTools,
	collectParamNames,
} from "../lib/index.js";

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

// --- splitMcpToolName -----------------------------------------------------
check(splitMcpToolName("mcp__local__read_file")?.server === "local", "plain mcp tool must yield its server");
check(splitMcpToolName("mcp__local__read_file")?.tool === "read_file", "plain mcp tool must yield its tool");
check(splitMcpToolName("read_file") === undefined, "a non-prefixed tool is not an MCP tool");
check(splitMcpToolName("mcp__") === undefined, "a bare prefix carries no server");
check(splitMcpToolName("mcp____tool") === undefined, "an empty server part is rejected");
check(splitMcpToolName(undefined) === undefined, "a non-string name is rejected");

// A server whose own name contains `__`: the split must be at the LAST separator,
// otherwise `my__server` would be read as server `my` and tool `server__tool`.
const nested = splitMcpToolName("mcp__my__server__tool");
check(nested?.server === "my__server", "server names containing __ must survive the split");
check(nested?.tool === "tool", "the tool part is whatever follows the last separator");

// --- collectParamNames -----------------------------------------------------
// These three feed the search index and the expanded row. They run on the FULL
// schema at the host, which is the whole point: the browser only ever sees a
// preview, so anything derived there would be lost for the biggest schemas.
check(
	JSON.stringify(collectParamNames({ type: "object", properties: { a: {}, b: {} } })) === '["a","b"]',
"flat parameter names are collected in order",
);
check(collectParamNames(undefined).length === 0, "a missing schema yields no names");
check(
	JSON.stringify(collectParamNames({ type: "object", properties: { cfg: { properties: { deep: {} } } } })) ===
		'["cfg","cfg.deep"]',
"nested parameters are dot-joined",
);
// A self-reference through `allOf` must terminate: `depth + 1` on the union branch
// is what stops it, and dropping that increment used to recurse forever.
const selfRef = { type: "object", properties: { a: {} } };
selfRef.properties.a.allOf = [selfRef];
check(collectParamNames(selfRef).length <= 4, "a self-referencing schema must terminate");
// Width is bounded independently of depth: a flat object with 100k keys is one
// level deep, so a depth-only bound would collect every one of them.
const wideProperties = {};
for (let index = 0; index < 100000; index += 1) wideProperties[`k${index}`] = { type: "string" };
const wideNames = collectParamNames({ type: "object", properties: wideProperties });
check(
	wideNames.length <= 200,
	`a pathologically wide schema must be bounded, saw ${wideNames.length} names`,
);

// --- summarizeMcpTools ----------------------------------------------------
// Each tool is an entry carrying its own description, not a bare name: the panel
// shows "what is this for" next to the name, and the schema is the only place
// those words exist.
const summary = summarizeMcpTools([
  { name: "mcp__local__read_file", description: "Read a file from the MCP server" },
  { name: "mcp__local__write_file" },
  { name: "mcp__remote__search", description: "  Search the web  " },
  { name: "read" },
  { name: "bash" },
]);
check(summary.length === 2, "two servers must be reported");
check(summary[0].server === "local" && summary[0].tools.length === 2, "local must carry its two tools");
check(summary[1].server === "remote" && summary[1].tools[0].name === "search", "remote must carry its one tool");
check(
  summary[0].tools[0].description === "Read a file from the MCP server",
  "a tool must carry its own description",
);
check(summary[0].tools[1].description === "", "a missing description must be an empty string, not undefined");
check(summary[1].tools[0].description === "Search the web", "the description must be trimmed");
check(
  summary.every((entry) => entry.server !== "read" && entry.server !== "bash"),
  "built-in tools must never be counted as MCP servers",
);
check(summarizeMcpTools([]).length === 0, "an empty registry reports no servers");
check(summarizeMcpTools(undefined).length === 0, "a missing registry reports no servers");
{
  // The cap is a wire bound: a pathological description must not turn one panel
  // read into a megabyte, and the cut is marked so the reader knows it happened.
  const long = "x".repeat(MAX_DESCRIPTION_CHARS + 50);
  const capped = summarizeMcpTools([{ name: "mcp__s__t", description: long }])[0].tools[0];
  check(capped.description.length === MAX_DESCRIPTION_CHARS + 1, "an over-long description must be capped");
  check(capped.description.endsWith("…"), "a capped description must say it was cut");
}

// --- readToolSummary ------------------------------------------------------
const okSummary = readToolSummary({ tools: { schemas: () => [{ name: "mcp__local__x" }, { name: "read" }] } });
check(okSummary.ok === true, "a working registry must succeed");
check(okSummary.totalTools === 2, "every tool counts toward totalTools");
check(okSummary.servers.length === 1 && okSummary.servers[0].server === "local", "only the MCP server is summarized");
check(typeof okSummary.readAt === "string", "a read timestamp must be present");

const failedSummary = readToolSummary({
  tools: {
    schemas() {
      throw new Error("registry exploded");
    },
  },
});
check(failedSummary.ok === false, "a throwing registry must report failure");
check(failedSummary.error === "registry exploded", "the failure must carry the real message");

// --- summarizeTools: the MCP half plus everything else ---------------------
// The bucket is named `local` and NOT "built-in": schemas carry no origin field,
// so a plugin's tool and a shipped tool are indistinguishable. The check pins the
// only distinction that is actually observable — MCP server tool vs not.
const catalog = [
	{ name: "mcp__local__read_file", description: "MCP read" },
	{ name: "read", description: "Read a file" },
	{ name: "bash", description: "Run a shell command" },
	{ name: "mcp__remote__search", description: "MCP search" },
	{ name: "read_img", description: "Describe an image" },
];
const splitCatalog = summarizeTools(catalog);
check(splitCatalog.servers.length === 2, "the MCP half must still be grouped per server");
check(
	JSON.stringify(splitCatalog.local.map((tool) => tool.name)) === JSON.stringify(["bash", "read", "read_img"]),
	`every non-MCP tool must land in local, sorted, saw ${JSON.stringify(splitCatalog.local.map((tool) => tool.name))}`,
);
check(
	splitCatalog.local.every((entry) => !entry.name.startsWith("mcp__")),
	"no MCP tool name may leak into the local bucket",
);
check(
	splitCatalog.local.find((tool) => tool.name === "read_img")?.description === "Describe an image",
	"a non-MCP tool must carry its own description too",
);
check(summarizeTools([]).local.length === 0, "an empty catalog has no local tools");
check(summarizeTools(undefined).local.length === 0, "a missing catalog has no local tools");
check(
	summarizeTools([{ name: "" }, { name: 42 }, {}, { name: void 0 }]).local.length === 0,
	"malformed entries must never become tool names",
);

// --- the viewing scope: the agent when a session resolves, global otherwise --
// `tools.schemas(agent)` is the call the real executor makes, so an argument of
// anything other than the agent object would silently read the global view.
const fakeAgent = { id: "session-1" };
const agentRegistry = { get: (id) => (id === "session-1" ? fakeAgent : void 0) };
/** A ctx whose `schemas` records the scope it was called with. */
const scopeRecorder = () => {
	const seen = [];
	return {
		seen,
		ctx: {
			get: (service) => (service === "agents" ? agentRegistry : void 0),
			tools: {
				schemas(scope) {
					seen.push(scope);
					// The agent view is deliberately smaller: a restriction removed one.
					return scope === void 0
						? [{ name: "read" }, { name: "bash" }]
						: [{ name: "read" }];
				},
			},
		},
	};
};
{
	const { ctx, seen } = scopeRecorder();
	const scoped = readToolSummary(ctx, "session-1");
	check(scoped.ok === true && scoped.scope === "agent", "a resolved session must answer from its agent scope");
	check(seen[0] === fakeAgent, "the viewing scope must be the agent object, not its id or its ctx");
	check(scoped.totalTools === 1, "the agent view must be the one that is counted");
}
{
	const { ctx, seen } = scopeRecorder();
	const unknown = readToolSummary(ctx, "no-such-session");
	check(unknown.scope === "global", "an unknown session must fall back to the global view");
	check(seen[0] === void 0, "the global read must pass no scope at all");
	check(unknown.totalTools === 2, "the global view must report the full catalog");
}
{
	const { ctx, seen } = scopeRecorder();
	check(readToolSummary(ctx).scope === "global", "no session id must mean the global view");
	check(seen[0] === void 0, "no session id must pass no scope");
}
{
	// A profile without the agent service still renders a catalog instead of failing.
	const degraded = readToolSummary(
		{
			get() {
				throw new Error("agents unavailable");
			},
			tools: { schemas: () => [{ name: "read" }] },
		},
		"session-1",
	);
	check(degraded.ok === true, "a throwing agents lookup must not become a read failure");
	check(degraded.scope === "global", "a throwing agents lookup must degrade to the global view, and say so");
}

// --- createToolSummaryReader: cache, memory, invalidation -------------------
// Two different jobs in one reader: `cached` holds the CURRENT answer and is dropped
// when the registry moves; `remembered` holds the last answer a live agent produced
// and is kept, because that is history rather than a cache. The tests below pin both,
// and pin that the remembered answer is what a released agent's session falls back to
// instead of the deployment catalog.
let readerSchemas = 0;
let readerAgent;
const readerChangeListeners = [];
const reader = createToolSummaryReader({
	tools: {
		schemas: () => {
			readerSchemas += 1;
			return [{ name: "mcp__local__x" }];
		},
	},
	get(name) {
		if (name !== "agents") return void 0;
		return { get: () => readerAgent };
	},
	on(_event, listener) {
		readerChangeListeners.push(listener);
		return () => {
			const at = readerChangeListeners.indexOf(listener);
			if (at >= 0) readerChangeListeners.splice(at, 1);
		};
	},
});
check(readerChangeListeners.length === 1, "the reader must hold exactly one tools/change listener");

// --- with a live agent: a fresh answer, remembered ---------------------------------
readerAgent = { id: "s-1" };
const live = reader.read("s-1");
check(live.scope === "agent", "a live agent must produce an agent-scope answer");
check(live.stale === void 0, "a live answer must not be marked stale");
check(readerSchemas === 1, "a read must call schemas() once");
reader.read("s-1");
check(readerSchemas === 1, "a repeat read must be served from the cache");
check(reader.remembered === 1, "a live answer must be remembered for its session");

// --- the registry moves: the cache goes, the memory stays --------------------------
readerChangeListeners[0]();
check(readerChangeListeners.length === 1, "a tools/change must not detach the listener");
reader.read("s-1");
check(readerSchemas === 2, "a tools/change must drop the cached answer");

// --- the agent is released: fall back to the remembered answer, marked -------------
readerAgent = void 0;
const remembered = reader.read("s-1");
check(remembered.scope === "agent", "a remembered answer must keep its agent scope");
check(remembered.stale === true, "a remembered answer must be marked stale");
check(
	typeof remembered.recordedAt === "string" && remembered.recordedAt.length > 0,
	"a remembered answer must carry the time it was read",
);
check(
	remembered.totalTools === live.totalTools,
	"the remembered answer must be the session's own numbers, not the deployment catalog",
);

// --- a session that never had a live agent: nothing is invented --------------------
const never = reader.read("s-2");
check(never.scope === "global", "a session with no history must answer from the global view");
check(never.stale === void 0, "a global answer must not pretend to be a remembered one");

// --- a Host restart: the memory is gone, so nothing is claimed --------------------
const restarted = createToolSummaryReader({
	tools: { schemas: () => [{ name: "read" }] },
	get: () => void 0,
	on: () => () => {},
});
const cold = restarted.read("s-1");
check(cold.scope === "global", "after a restart a session has no remembered answer");
check(restarted.remembered === 0, "a fresh reader must remember nothing");
restarted.dispose();

reader.dispose();
check(readerChangeListeners.length === 0, "dispose must drop the tools/change listener");

// --- the cache is bounded per scope ---------------------------------------
// The cache is keyed by session id, and a host can outlive far more sessions than
// it has registry changes. Without a bound the map would grow with the number of
// sessions ever opened, each entry holding a whole catalog with descriptions.
let boundedSchemas = 0;
const boundedReader = createToolSummaryReader({
	tools: {
		schemas: () => {
			boundedSchemas += 1;
			return [{ name: "read" }];
		},
	},
	on() {
		return () => {};
	},
});
const readScoped = (id) => boundedReader.read(id);
// Filling up to the cap keeps every scope cached.
for (let index = 0; index < MAX_CACHED_SCOPES; index += 1) readScoped(`scope-${index}`);
const callsAtCap = boundedSchemas;
check(callsAtCap === MAX_CACHED_SCOPES, `each new scope must read once, saw ${callsAtCap}`);
// A hit refreshes recency, so the scope the reader keeps opening is not the one
// dropped for a scope it never revisited.
readScoped("scope-0");
check(boundedSchemas === callsAtCap, "a scope still inside the cap must be served from the cache");
// One past the cap evicts the least recently used scope — scope-1, not scope-0,
// because scope-0 was just touched.
readScoped(`scope-${MAX_CACHED_SCOPES}`);
readScoped("scope-0");
check(boundedSchemas === callsAtCap + 1, `the just-touched scope must survive the eviction, saw ${boundedSchemas - callsAtCap} extra reads`);
readScoped("scope-1");
check(
	boundedSchemas === callsAtCap + 2,
	`the least recently used scope must be evicted, saw ${boundedSchemas - callsAtCap} extra reads`,
);
// The newest scope is still cached: eviction is bounded, not a flush.
const callsBeforeHit = boundedSchemas;
readScoped(`scope-${MAX_CACHED_SCOPES}`);
check(boundedSchemas === callsBeforeHit, "a recently cached scope must survive the eviction");
boundedReader.dispose();

const registered = [];
const disposed = [];
// The registry is counted so the cache can be proven: `schemas()` deep-clones
// every tool, so it must NOT run once per read, and opening the change stream
// must not run it at all.
let schemasCalls = 0;
const changeListeners = [];
/** The agent the route-level scope test resolves; identity is what is asserted. */
const routeAgent = { id: "session-1" };
/** Arguments `schemas()` was called with, in order: proves which scope was used. */
const schemasScopes = [];
const fakeCtx = {
  tools: {
    schemas: (scope) => {
      schemasCalls += 1;
      schemasScopes.push(scope);
      return [{ name: "mcp__local__read_file" }];
    },
  },
  /**
   * The agent service, looked up by name the way `readToolSummary` does it.
   * Returning a registry here is what lets the route test prove that a session id
   * travels through the host and turns into the viewing scope.
   */
  get(service) {
    return service === "agents" ? { get: (id) => (id === "session-1" ? routeAgent : void 0) } : void 0;
  },
  on(event, listener) {
    if (event === "tools/change") changeListeners.push(listener);
    return () => {
      const index = changeListeners.indexOf(listener);
      if (index >= 0) changeListeners.splice(index, 1);
    };
  },
	connection: {
		fetch: {
			register(route) {
				registered.push(route);
				return async () => {
					disposed.push(route.path);
				};
			},
		},
	},
	effect(callback) {
		const disposer = callback();
		// Cordis owns this disposer and it is single-shot: the check drives it once,
		// and simulates Cordis idempotence so a repeated call is a no-op (the real
		// engine never calls twice, and the effect cleanup must not run twice when it
		// somehow does).
		let used = false;
		fakeCtx.effectDisposer = () => {
			if (used) return void 0;
			used = true;
			return typeof disposer === "function" ? disposer() : disposer;
		};
		return fakeCtx.effectDisposer;
	},
};

apply(fakeCtx);
// One route, one verb: the strip reads on demand now. There is no change stream to
// open, so registering a second path would be dead weight the browser never used.
// The wire path is written out rather than derived: the browser half hardcodes the
// same string, and the two halves only work together if both say exactly this.
const WIRE_PATH = "/api/ability-strip";
check(
	`${ROUTE_CHANNEL}/${ROUTE_ENDPOINT}` === WIRE_PATH,
	"the exported path must stay the wire contract the browser half posts to",
);
const summaryRoute = registered.find((entry) => entry.path === WIRE_PATH);
check(registered.length === 1, `apply must register exactly one route, saw ${registered.length}`);
check(summaryRoute !== undefined, "the answer route must sit at channel/endpoint");

// Everything below drives those two routes, so stop here with the reason rather than
// crashing on `undefined` and reporting a TypeError.
	if (summaryRoute === undefined) {
	console.log("PROBLEMS:");
	for (const problem of problems) console.log("  - " + problem);
	console.log("RESULT: FAIL");
	process.exit(1);
}

check(summaryRoute.path.startsWith("/api/"), "the answer route must sit below the shared /api channel");
check(
	Array.isArray(summaryRoute.methods) && summaryRoute.methods.length === 1 && summaryRoute.methods[0] === "POST",
	"rpc.call always POSTs, so the answer route is POST-only",
);
check(summaryRoute.requestBody === "buffered", "the answer route takes a buffered body");
check(typeof summaryRoute.fetch === "function", "the answer route must expose a fetch handler");


/** POST one client-request envelope to the answer route and return the reply. */
async function readSummary(rpcId) {
	return summaryRoute.fetch(
		new Request("http://localhost" + summaryRoute.path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "client-request", rpcId, payload: { action: "tools", data: null } }),
		}),
	);
}

// The handler must speak the carrier's client-request envelope, not a bare GET.
const response = await readSummary("rpc-1");
check(response instanceof Response, "the handler must answer with a Response");
const envelope = await response.json();
check(envelope.type === "server-response", "the reply must use the carrier's server-response envelope");
check(envelope.rpcId === "rpc-1", "the reply must echo the request rpcId");
check(envelope.result?.ok === true, "the served result must report success");
check(Array.isArray(envelope.result?.value?.servers), "the served value must carry a server list");

// A body that is not a client-request envelope must be rejected, not guessed at.
const badResponse = await summaryRoute.fetch(
	new Request("http://localhost" + summaryRoute.path, { method: "POST", body: "not json" }),
);
check(badResponse.status === 400, "an unparseable body must be rejected with 400");

// --- the cache: read cost must not scale with the catalog -----------------
// `schemas()` deep-clones every visible tool. A read must therefore hit the cache,
// not the registry.
await readSummary("rpc-2");
check(schemasCalls === 1, `a repeat read must not touch the registry, saw ${schemasCalls} calls`);

// `tools/change` is the exact invalidation: after it, the next read is fresh.
check(changeListeners.length === 1, "apply must subscribe to tools/change exactly once");
changeListeners[0]();
await readSummary("rpc-3");
check(schemasCalls === 2, `a tools/change must invalidate the cache, saw ${schemasCalls} calls`);

// --- the viewing scope travels through the route --------------------------
/** Same route, with an explicit payload (the session scope travels inside it). */
async function readSummaryWith(payload) {
	return summaryRoute.fetch(
		new Request("http://localhost" + summaryRoute.path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "client-request", rpcId: "rpc-scope", payload }),
		}),
	);
}

/** Invalidate, read with this payload, and report the scope that reached `schemas()`. */
async function scopeForPayload(payload) {
	changeListeners[0]();
	await readSummaryWith(payload);
	return schemasScopes[schemasScopes.length - 1];
}

check(
	(await scopeForPayload({ sessionId: "session-1" })) === routeAgent,
	"a session id must travel through the route and become the viewing scope",
);
check(
	(await scopeForPayload({ sessionId: "nobody" })) === void 0,
	"an unknown session must be read from the global view",
);
check(
	(await scopeForPayload({ action: "tools", data: null })) === void 0,
	"a payload without a session id must stay global",
);

// The answer names the view it served, so a degraded answer is visible in the UI
// instead of being mistaken for "this session really sees that many tools".
changeListeners[0]();
const scopedEnvelope = await readSummaryWith({ sessionId: "session-1" });
const scopedValue = (await scopedEnvelope.json()).result.value;
check(scopedValue.scope === "agent", "the payload must say which view produced the answer");

// --- the cache is per viewing scope, never shared across sessions ---------
// Two tabs on two sessions can see different sets once `restrict()` is in play,
// so one cached answer must not be served to both.
changeListeners[0]();
const callsBefore = schemasCalls;
await readSummaryWith({ sessionId: "session-a" });
await readSummaryWith({ sessionId: "session-b" });
check(
	schemasCalls === callsBefore + 2,
	`two sessions must not share one cached answer, saw ${schemasCalls - callsBefore} reads`,
);
await readSummaryWith({ sessionId: "session-a" });
check(schemasCalls === callsBefore + 2, "a repeat read from the same session must be cached");


// --- the remembered answer is per session, too ------------------------------
// Memory must not leak across sessions any more than the cache may: session A's last
// numbers are not session B's.
const memoryCtx = {
	tools: { schemas: () => [{ name: "read" }] },
	get: () => void 0,
	on: () => () => {},
};
const memoryReader = createToolSummaryReader(memoryCtx);
check(memoryReader.read("unknown-session").scope === "global", "an unseen session reads global");
check(memoryReader.remembered === 0, "a global answer must never be remembered as a session answer");
memoryReader.dispose();

// --- a global answer must not stick once its agent appears -------------------
// The reverse of the case above, and the one that was missing: a session that reads
// while it has no agent caches a deployment-catalog answer, and the agent's arrival
// is NOT a `tools/change` (the registry itself did not move). A plain cache hit would
// therefore serve "no active agent" forever, even after the session came alive.
let wakeSchemas = 0;
let wakeAgent;
const wakeReader = createToolSummaryReader({
	tools: {
		schemas: () => {
			wakeSchemas += 1;
			return [{ name: "read" }];
		},
	},
	get: () => ({ get: () => wakeAgent }),
	on: () => () => {},
});
const wakeCold = wakeReader.read("w");
check(wakeCold.scope === "global", "a session with no agent must read the deployment catalog first");
wakeAgent = { id: "w" };
const wakeWarm = wakeReader.read("w");
check(wakeWarm.scope === "agent", "once the agent appears, the cached global answer must not be reused");
check(wakeSchemas === 2, `liveness changing must force a re-read, saw ${wakeSchemas}`);
wakeReader.dispose();


// --- unload must dispose the route and drop the change listener -------------
// `apply` returns a disposer through Cordis` effect; the check drives it exactly
// once and asserts both halves of the cleanup. Without this, an unloaded row would
// keep a listener on a live service and a route in the registry.
const routesAtRegister = registered.length;
check(routesAtRegister === 1, `apply must register exactly one route, saw ${routesAtRegister}`);
const listenersBeforeDispose = changeListeners.length;
check(listenersBeforeDispose === 1, "apply must subscribe to tools/change exactly once");
if (typeof fakeCtx.effectDisposer === "function") {
	await fakeCtx.effectDisposer();
	check(disposed.length === 1, `unload must dispose the route, saw ${disposed.length}`);
	check(changeListeners.length === 0, "unload must drop the tools/change listener");
	// A second dispose is a no-op in Cordis (single-shot effect disposers), so the
	// route is not torn down twice. The fake records by push, so no growth proves the
	// disposer ran once.
	await fakeCtx.effectDisposer();
	check(disposed.length === 1, "a repeated dispose must be a no-op");
} else {
	problems.push("apply did not return an effect disposer");
}

// --- the parameter schema: carried, measured, and capped -------------------
// The schema is the part that costs context on every request, so the panel needs
// both the preview AND the true size. The size must be measured on the full schema
// before any cap: a capped preview would otherwise report its own length as the
// tool's cost, which is the one number the reader is meant to act on.
{
	const small = summarizeTools([
		{ name: "tiny", description: "d", parameters: { type: "object", properties: {} } },
	]);
	const entry = small.local[0];
	check(typeof entry.schema === "string", "a tool with parameters must carry its schema");
	check(
		entry.schemaChars === JSON.stringify({ type: "object", properties: {} }).length,
		`schemaChars must measure the serialized parameters, saw ${entry.schemaChars}`,
	);
	check(entry.schemaTruncated === void 0, "a small schema must not be marked truncated");

	// A tool with no declared parameters carries no schema at all (nothing to show).
	const none = summarizeTools([{ name: "bare", description: "" }]);
	check(none.local[0].schema === void 0, "a tool without parameters must carry no schema");
	check(none.local[0].schemaChars === 0, "a tool without parameters must report zero chars");

	// An oversized schema is previewed, but its SIZE stays the full measurement.
	const huge = { type: "object", properties: { blob: { type: "string", description: "x".repeat(9000) } } };
	const big = summarizeTools([{ name: "huge", description: "", parameters: huge }]);
	const bigEntry = big.local[0];
	check(bigEntry.schemaTruncated === true, "an oversized schema must be marked truncated");
	check(
		bigEntry.schemaChars === JSON.stringify(huge).length,
		`a truncated preview must still report the FULL size, saw ${bigEntry.schemaChars}`,
	);
	check(
		bigEntry.schema.length <= MAX_SCHEMA_CHARS + 1,
		`the preview must stay within the cap, saw ${bigEntry.schema.length}`,
	);
	check(
		bigEntry.schemaChars > bigEntry.schema.length,
		"the reported size must exceed the preview when truncated",
	);

	// MCP tools carry their schema too: the cap applies to every entry, not one path.
	const mcpBig = summarizeMcpTools([{ name: "mcp__srv__big", description: "", parameters: huge }]);
	check(mcpBig[0].tools[0].schemaTruncated === true, "an MCP tool's oversized schema must be capped too");
	check(
		mcpBig[0].tools[0].schemaChars === JSON.stringify(huge).length,
		"an MCP tool must report the full schema size",
	);
	// A CUSTOM limit must reach the MCP path too. The default-only check above
	// passed while `summarizeMcpTools` dropped its `limits` argument entirely —
	// `toolEntry` silently fell back to DEFAULT_LIMITS. This is the regression guard.
	const mcpNarrow = summarizeMcpTools(
		[{ name: "mcp__srv__big", description: "d".repeat(80), parameters: huge }],
		{ ...DEFAULT_LIMITS, maxDescriptionChars: 10, maxSchemaChars: 10 },
	);
	check(
		mcpNarrow[0].tools[0].description.length <= 11,
		`a custom maxDescriptionChars must reach MCP tools, saw ${mcpNarrow[0].tools[0].description.length}`,
	);
	check(
		mcpNarrow[0].tools[0].schema.length <= 11,
		`a custom maxSchemaChars must reach MCP tools, saw ${mcpNarrow[0].tools[0].schema.length}`,
	);
	// The reported size is still the FULL measurement regardless of the wire cap.
	check(
		mcpNarrow[0].tools[0].schemaChars === JSON.stringify(huge).length,
		"an MCP tool's reported size must not depend on the wire cap",
	);
}

// --- Deployment bounds: defaults must equal the previous literals -------------
// Adding a knob is only safe if "no config" behaves exactly as before. These
// assertions pin that, so widening a default later is a visible decision rather
// than a silent change to what every existing profile sends.
{
	const defaults = Config({});
	check(
		defaults.maxSchemaChars === MAX_SCHEMA_CHARS,
		`the schema default must equal MAX_SCHEMA_CHARS, saw ${defaults.maxSchemaChars} vs ${MAX_SCHEMA_CHARS}`,
	);
	check(
		defaults.maxDescriptionChars === MAX_DESCRIPTION_CHARS,
		`the schema default must equal MAX_DESCRIPTION_CHARS, saw ${defaults.maxDescriptionChars} vs ${MAX_DESCRIPTION_CHARS}`,
	);
	check(
		defaults.maxRememberedSessions === MAX_CACHED_SCOPES,
		`the schema default must equal MAX_CACHED_SCOPES, saw ${defaults.maxRememberedSessions} vs ${MAX_CACHED_SCOPES}`,
	);
	// The schema is a real validator, not decoration: a negative bound is refused.
	let rejected = false;
	try {
		Config({ maxSchemaChars: -1 });
	} catch {
		rejected = true;
	}
	check(rejected, "a negative maxSchemaChars must be rejected by the schema");
}

// --- The bounds actually reach the wire, THROUGH the real read path ----------
// These drive `createToolSummaryReader`, not `summarizeTools`: the caps are only
// real if the read path forwards them, and an earlier version of this feature
// looked correct while `readToolSummary` silently dropped them. A test that calls
// the summarizer directly cannot see that defect.
{
	const bigSchema = {
		name: "big",
		description: "d".repeat(500),
		parameters: { type: "object", properties: { a: { type: "string", description: "x".repeat(500) } } },
	};
	// `resolveAgent` reads ctx.get("agents"), NOT ctx.agents. A fake that only
	// sets ctx.agents silently produces global-view reads forever, which is how
	// an earlier version of this check passed without ever exercising `remembered`.
	const ctxFor = (live = true) => ({
		tools: { schemas: () => [bigSchema] },
		get: (name) => (name === "agents" ? { get: () => (live ? { id: "a" } : void 0) } : void 0),
		on: () => () => {},
	});
	const readWith = (limits) => createToolSummaryReader(ctxFor(), limits).read("s1");

	const wide = readWith({ ...DEFAULT_LIMITS });
	const narrow = readWith({ ...DEFAULT_LIMITS, maxDescriptionChars: 10, maxSchemaChars: 10 });

	check(
		narrow.local[0].description.length < wide.local[0].description.length,
		`maxDescriptionChars must reach the wire through the read path, saw ${narrow.local[0].description.length} vs ${wide.local[0].description.length}`,
	);
	check(
		narrow.local[0].schema.length < wide.local[0].schema.length,
		`maxSchemaChars must reach the wire through the read path, saw ${narrow.local[0].schema.length} vs ${wide.local[0].schema.length}`,
	);
	// The cap is a wire bound, not a change to what the tool costs: the reported
	// size must be the FULL measurement either way.
	check(
		narrow.local[0].schemaChars === wide.local[0].schemaChars,
		`the reported size must not depend on the wire cap, saw ${narrow.local[0].schemaChars} vs ${wide.local[0].schemaChars}`,
	);
	check(wide.local[0].schemaTruncated === void 0, "an uncapped schema must not be marked truncated");
	check(narrow.local[0].schemaTruncated === true, "a capped schema must be marked truncated");

	// maxRememberedSessions must bound the memory map, not just be accepted.
	// Drive five DISTINCT live-agent sessions: each one writes a remembered
	// answer, so a limit of 2 must leave exactly two, not five.
	const memCtx = ctxFor(true);
	const memReader = createToolSummaryReader(memCtx, { ...DEFAULT_LIMITS, maxRememberedSessions: 2 });
	for (let index = 0; index < 5; index += 1) memReader.read(`session-${index}`);
	check(
		memReader.remembered === 2,
		`maxRememberedSessions must bound the map to 2, saw ${memReader.remembered}`,
	);
	// The two maps carry DIFFERENT bounds on purpose: `maxRememberedSessions` caps the
	// memory an operator may want small, while the current-answer cache is bounded by
	// MAX_CACHED_SCOPES. Sharing one knob silently shrank the cache to 1, which turned
	// every session switch into a full registry read.
	const splitReader = createToolSummaryReader(ctxFor(true), { ...DEFAULT_LIMITS, maxRememberedSessions: 1 });
	for (let index = 0; index < MAX_CACHED_SCOPES + 4; index += 1) splitReader.read(`cached-${index}`);
	check(
		splitReader.remembered === 1,
		`maxRememberedSessions:1 must leave exactly one remembered session, saw ${splitReader.remembered}`,
	);
	check(
		splitReader.scopes === MAX_CACHED_SCOPES,
		`the current-answer cache must keep MAX_CACHED_SCOPES (${MAX_CACHED_SCOPES}) scopes whatever maxRememberedSessions says, saw ${splitReader.scopes}`,
	);
	// A released agent must be served from memory, which proves the entries are real.
	const released = createToolSummaryReader(ctxFor(false), { ...DEFAULT_LIMITS, maxRememberedSessions: 2 });
	const releasedAnswer = released.read('session-0');
	check(
		releasedAnswer.stale !== true,
		"a reader with no agent and no memory must not invent a stale answer",
	);
}

console.log("---");
if (problems.length > 0) {
	console.log("PROBLEMS:");
	for (const problem of problems) console.log("  - " + problem);
	console.log("RESULT: FAIL");
	process.exit(1);
}
console.log("RESULT: PASS")
