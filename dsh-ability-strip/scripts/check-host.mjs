/**
 * Host-half checks: the `mcp__<server>__<tool>` split, the per-server summary, the
 * two-route registration contract, and the change stream that replaced polling.
 *
 * The MCP tool naming rule is the load-bearing assumption of the whole feature, so
 * it is pinned here against real registry shapes rather than assumed.
 */

import {
	apply,
	createToolSummaryReader,
	inject,
	MAX_DESCRIPTION_CHARS,
	name,
	openEventStream,
	ROUTE_CHANNEL,
	ROUTE_ENDPOINT,
	ROUTE_EVENTS_ENDPOINT,
	readToolSummary,
	splitMcpToolName,
	summarizeMcpTools,
	summarizeTools,
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

// --- createToolSummaryReader: one listener, two jobs -----------------------
// The cache invalidation and the browser's change signal are the same fact, so
// they must come from ONE `tools/change` subscription. This pins that: subscribers
// hear a change exactly once, never on subscribe, and never after detaching.
let readerSchemas = 0;
const readerChangeListeners = [];
const reader = createToolSummaryReader({
	tools: {
		schemas: () => {
			readerSchemas += 1;
			return [{ name: "mcp__local__x" }];
		},
	},
	on(_event, listener) {
		readerChangeListeners.push(listener);
		return () => {
			const at = readerChangeListeners.indexOf(listener);
			if (at >= 0) readerChangeListeners.splice(at, 1);
		};
	},
});
check(reader.version === 0, "the change version must start at 0");
check(readerChangeListeners.length === 1, "the reader must hold exactly one tools/change listener");
const heard = [];
const detach = reader.subscribe((version) => heard.push(version));
check(heard.length === 0, "subscribing must not announce a change that did not happen");
check(readerSchemas === 0, "subscribing must not read the registry");
reader.read();
check(readerSchemas === 1, "a read must call schemas() once");
reader.read();
check(readerSchemas === 1, "a repeat read must be served from the cache");
readerChangeListeners[0]();
check(reader.version === 1, "a tools/change must bump the version");
check(heard.length === 1 && heard[0] === 1, `a tools/change must notify subscribers once with the new version, saw ${JSON.stringify(heard)}`);
detach();
readerChangeListeners[0]();
check(heard.length === 1, "a detached subscriber must stop hearing changes");
check(reader.version === 2, "the version must keep counting after a detach");
reader.dispose();
check(readerChangeListeners.length === 0, "dispose must drop the tools/change listener");

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
  effect(callback) {
    const disposer = callback();
    // Cordis owns this disposer; the check drives it to prove unload cleanup.
    fakeCtx.effectDisposer = disposer;
    return disposer;
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
};

apply(fakeCtx);
// Two routes, two verbs, two shapes: the answer route answers a request, the
// change stream stays open and pushes. Keeping them apart is a contract, not a
// detail — a GET stream must never be reachable through `rpc.call`.
// The wire path, written out rather than derived: the browser half hardcodes the
// same string, and the two halves only work together if both say exactly this.
const EVENTS_WIRE_PATH = "/api/ability-strip/events";
check(
	`${ROUTE_CHANNEL}/${ROUTE_EVENTS_ENDPOINT}` === EVENTS_WIRE_PATH,
	"the exported stream path must stay the wire contract the browser half opens",
);
const summaryRoute = registered.find((entry) => entry.path === `${ROUTE_CHANNEL}/${ROUTE_ENDPOINT}`);
const eventsRoute = registered.find((entry) => entry.path === EVENTS_WIRE_PATH);
check(registered.length === 2, `apply must register exactly two routes, saw ${registered.length}`);
check(summaryRoute !== undefined, "the answer route must sit at channel/endpoint");
check(eventsRoute !== undefined, "the change stream must sit at channel/<endpoint>/events");
check(summaryRoute !== eventsRoute, "the two routes must be distinct");

// Everything below drives those two routes, so stop here with the reason rather than
// crashing on `undefined` and reporting a TypeError.
if (summaryRoute === undefined || eventsRoute === undefined) {
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

check(eventsRoute.path.startsWith("/api/"), "the change stream must use the same authenticated channel");
check(
	Array.isArray(eventsRoute.methods) && eventsRoute.methods.length === 1 && eventsRoute.methods[0] === "GET",
	"a browser EventSource opens the change stream with GET, so it is GET-only",
);
check(eventsRoute.requestBody === "buffered", "the change stream declares a buffered (empty) request body");
check(typeof eventsRoute.fetch === "function", "the change stream must expose a fetch handler");

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

// --- the change stream ----------------------------------------------------
// Decode one SSE frame. `EventSource` ignores comment lines, so the stream opens
// with one: it proves the channel is live before anything has changed.
const decoder = new TextDecoder();
const frameValue = (text) => {
	const line = text.split("\n").find((part) => part.startsWith("data: "));
	return line === void 0 ? void 0 : JSON.parse(line.slice("data: ".length));
};
const openStream = async () => {
	const abort = new AbortController();
	const opened = await eventsRoute.fetch(
		new Request("http://localhost" + eventsRoute.path, { method: "GET", signal: abort.signal }),
	);
	return { abort, opened };
};

// Invalidate first, so the cache is COLD when the stream opens: any registry read
// during that open would then be visible as a `schemas()` call, instead of being
// hidden by a warm cache.
changeListeners[0]();
const callsBeforeStream = schemasCalls;
const live = await openStream();
check(
	schemasCalls === callsBeforeStream,
	`opening the change stream must not consult the registry at all (it relays a counter, not the catalog): saw ${schemasCalls - callsBeforeStream} schemas() call(s)`,
);
check(live.opened.status === 200, "the change stream must answer 200");
check(
	live.opened.headers.get("content-type") === "text/event-stream",
	"the change stream must declare text/event-stream",
);
check(
	(live.opened.headers.get("cache-control") ?? "").includes("no-cache"),
	"a change stream must not be cached",
);
const streamReader = live.opened.body.getReader();
const preamble = decoder.decode((await streamReader.read()).value);
check(preamble.startsWith(": "), "the stream must open with an SSE comment, not with a change claim");
const greeting = frameValue(decoder.decode((await streamReader.read()).value));
check(typeof greeting?.version === "number", "the first data frame must carry the current change version");
// The cache is still cold, so this read must reach the registry exactly once: that
// is the change that invalidated it being honoured, and no other read in between.
await readSummary("rpc-4");
check(
	schemasCalls === callsBeforeStream + 1,
	`the change that invalidated the cache must make the next read fresh, saw ${schemasCalls - callsBeforeStream} schemas() call(s)`,
);

// The registry moving is the only thing that pushes: one frame, carrying the bumped
// version, with no request from the browser.
const versionBeforeChange = greeting.version;
const callsBeforePush = schemasCalls;
changeListeners[0]();
const pushed = frameValue(decoder.decode((await streamReader.read()).value));
check(pushed?.version === versionBeforeChange + 1, `a tools/change must push the next version, saw ${JSON.stringify(pushed)}`);
check(
	schemasCalls === callsBeforePush,
	"pushing a frame must not read the registry either",
);

/**
 * Read one chunk, or give up after a beat.
 *
 * A stream that should have ended but did not would otherwise leave this script
 * awaiting forever — Node exits 13 with no message at all. A broken end-of-stream
 * must fail with a readable problem instead of looking like a hang.
 * @param reader - reader on the response body.
 * @param ms - how long to wait before declaring the stream still open.
 * @returns the read result, or `{ done: false, timedOut: true }`.
 */
async function readWithin(reader, ms = 2000) {
	let timer;
	const expired = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ done: false, timedOut: true }), ms);
	});
	const result = await Promise.race([reader.read(), expired]);
	clearTimeout(timer);
	return result;
}

// The browser going away must end the stream. The carrier's request bridge drains
// the response body until it ends, so a body left open would leak a responder and a
// subscriber per closed tab.
live.abort.abort();
const afterAbort = await readWithin(streamReader);
check(afterAbort.done === true, "aborting the request must end the change stream (it was still open afterwards)");

// Unloading must drop the listener, or a dead row keeps watching a live service,
// and must end every stream this row opened, or a closed row keeps a body open.
const effectDisposer = fakeCtx.effectDisposer;
check(typeof effectDisposer === "function", "apply must register one effect");
const doomed = await openStream();
const doomedReader = doomed.opened.body.getReader();
// An open stream has already queued its two opening frames (the comment preamble
// and the initial version), so drain them before asking whether it is still open.
await doomedReader.read();
await doomedReader.read();
await effectDisposer();
check(changeListeners.length === 0, "unloading must drop the tools/change listener");
check(disposed.length === 2, `unloading must dispose both routes, saw ${disposed.length}`);
const afterUnload = await readWithin(doomedReader);
check(afterUnload.done === true, "unloading must end every open change stream (it was still open afterwards)");

check(name === "ability-strip", "the plugin id must stay stable");
check(Array.isArray(inject) && inject.includes("connection") && inject.includes("tools"), "inject must name both services");

// --- the leak invariant, per teardown path --------------------------------
// The reader the route uses is created inside `apply` and is unreachable from
// outside, so `openEventStream` is driven directly here with a counting reader.
// The invariant is the same one `apply`'s disposer relies on: however a stream
// ends, it must leave no subscriber behind and no entry in the unload set, or a
// dead tab's subscriber outlives its stream for the life of the process.
const countingReader = {
	version: 7,
	/** Live frame handlers, exactly what `createToolSummaryReader` keeps. */
	subs: new Set(),
	subscribe(listener) {
		this.subs.add(listener);
		return () => this.subs.delete(listener);
	},
	/** Deliver one change the way `invalidate` does. */
	fire() {
		for (const listener of [...this.subs]) listener(this.version);
	},
};
const openStandalone = async () => {
	const abort = new AbortController();
	const streams = new Set();
	const opened = openEventStream(countingReader, { signal: abort.signal }, streams);
	return { abort, streams, opened, reader: opened.body.getReader() };
};

// Path 1: the browser goes away (request signal aborts).
const gone = await openStandalone();
check(countingReader.subs.size === 1, `one open stream must hold one subscriber, saw ${countingReader.subs.size}`);
check(gone.streams.size === 1, `one open stream must be recorded for unload, saw ${gone.streams.size}`);
const firstFrame = decoder.decode((await gone.reader.read()).value);
check(firstFrame.startsWith(": "), "a standalone stream must open with the same SSE comment");
// Drain the opening version frame before firing, and bump the version so the pushed
// frame cannot be mistaken for it — a same-version assertion would pass on the
// greeting alone and prove nothing.
const greetingFrame = frameValue(decoder.decode((await gone.reader.read()).value));
check(greetingFrame?.version === 7, `the opening frame must carry the current version, saw ${JSON.stringify(greetingFrame)}`);
countingReader.version = 8;
countingReader.fire();
const pushedFrame = frameValue(decoder.decode((await gone.reader.read()).value));
check(
	pushedFrame?.version === 8,
	`a change must push the reader's new version, saw ${JSON.stringify(pushedFrame)}`,
);
gone.abort.abort();
check((await readWithin(gone.reader)).done === true, "abort must end a standalone stream");
check(countingReader.subs.size === 0, `abort must remove the subscriber, saw ${countingReader.subs.size} left`);
check(gone.streams.size === 0, `abort must leave nothing for unload to close, saw ${gone.streams.size}`);

// Path 2: the consumer cancels the body.
const cancelled = await openStandalone();
await cancelled.reader.read();
await cancelled.reader.cancel();
check(countingReader.subs.size === 0, `cancelling the body must remove the subscriber, saw ${countingReader.subs.size} left`);
check(cancelled.streams.size === 0, `cancelling the body must leave nothing for unload, saw ${cancelled.streams.size}`);

// Path 3: the plugin unloads and closes the set.
const unloaded = await openStandalone();
const entries = [...unloaded.streams];
check(entries.length === 1, `an open stream must be the one entry in the unload set, saw ${entries.length}`);
// Hold the frame handler across the teardown: a subscriber that outlived its stream
// must be an inert no-op, not a throw into the registry's `tools/change` emit.
const staleHandler = [...countingReader.subs][0];
for (const shutdown of entries) shutdown();
check(countingReader.subs.size === 0, `unload must remove the subscriber, saw ${countingReader.subs.size} left`);
check(unloaded.streams.size === 0, `unload must empty the set it walked, saw ${unloaded.streams.size}`);
let staleThrew = false;
try {
	staleHandler(99);
} catch (error) {
	staleThrew = error;
}
check(staleThrew === false, `a frame arriving after teardown must be a no-op, saw ${String(staleThrew)}`);
check(countingReader.subs.size === 0, "a stale frame must not re-attach a subscriber");
// Teardown is idempotent: a second pass over an already-closed stream must not
// reach back into the reader (e.g. re-adding a subscriber).
entries[0]();
check(countingReader.subs.size === 0, "a repeated teardown must not resurrect a subscriber");
// Nothing is left behind by any of the three paths.
check(countingReader.subs.size === 0, `no teardown path may leak a subscriber, saw ${countingReader.subs.size}`);

console.log("--- host half ---");
console.log("servers:", JSON.stringify(summary));
console.log("answer route:", summaryRoute.path, JSON.stringify(summaryRoute.methods));
console.log("change stream:", eventsRoute.path, JSON.stringify(eventsRoute.methods), live.opened.headers.get("content-type"));
console.log("schemas() calls across 5 reads, 3 tools/change and 2 streams:", schemasCalls);
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const problem of problems) console.log("  - " + problem);
  console.log("RESULT: FAIL");
  process.exitCode = 1;
} else {
  console.log("RESULT: PASS");
}
