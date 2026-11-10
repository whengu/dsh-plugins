// Load the browser bundle against a stub module loader and assert the contract
// DSH's client module system relies on:
//   - the script registers exactly one factory whose id equals the package name
//   - the factory requires only baseline modules
//   - the exported inject list and apply() shape are what Cordis expects
//   - apply() registers into the dock slot with the documented options
// No browser, no DSH runtime: only the contract is exercised.
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
/** Package root: this script lives in <root>/scripts. */
const pkgDir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(pkgDir, "lib/client.js"), "utf8");

const problems = [];
const registrations = [];

// Minimal `window.__ModuleLoader__`.
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};

/**
 * Modules the bundle may load.
 *
 * Deliberately only React: the shipped `cordis-plugin-development` guidance
 * (`references/practices.md`) forbids a plugin module from loading any Harness
 * Client package — they change without notice, a plain-JS plugin gets no type
 * check, and a component that throws blanks the slot entry. This bundle therefore
 * carries its own controls and references only `--dsw-alias-*` theme tokens. A
 * narrower allowlist turns that rule into a failing check instead of a comment.
 */
const BASELINE = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
]);

const required = [];

/** A pass-through JSX-ish stub: enough to build a tree, not to render it. */
const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children,
});

const hooks = { state: [], index: 0 };
const React = {
  createElement,
  useState(initial) {
    const i = hooks.index++;
    if (hooks.state[i] === undefined) hooks.state[i] = initial;
    const set = (next) => {
      hooks.state[i] = typeof next === "function" ? next(hooks.state[i]) : next;
    };
    return [hooks.state[i], set];
  },
  useRef(initial) {
    const i = hooks.index++;
    if (hooks.state[i] === undefined) hooks.state[i] = { current: initial };
    return hooks.state[i];
  },
  useCallback(fn) {
    hooks.index++;
    return fn;
  },
  useEffect() {
    hooks.index++;
  },
};

const moduleStub = (id) => {
  if (id === "react") return React;
  return {};
};

// Evaluate the bundle.
new Function("window", source)(globalThis.window);

if (registrations.length !== 1) {
  problems.push(`expected exactly 1 registration, saw ${registrations.length}`);
}
const registration = registrations[0];
if (registration === undefined) {
  console.log("FATAL: bundle registered nothing");
  process.exit(1);
}
if (registration.id !== pkg.name) {
  problems.push(`registration id ${JSON.stringify(registration.id)} != package name ${JSON.stringify(pkg.name)}`);
}
console.log(`factory id: ${registration.id}`);
console.log(`package name: ${pkg.name}`);

const exportsObj = registration.factory((specifier) => {
  required.push(specifier);
  if (!BASELINE.has(specifier)) {
    problems.push(`requires non-baseline module ${JSON.stringify(specifier)} (needs dsh.client.external)`);
  }
  return moduleStub(specifier);
});

console.log("required modules:", JSON.stringify(required));

// The official rule, stated as its own check so the message names the reason
// rather than only the allowlist. A Harness Client package loaded here would make
// this bundle depend on internals that may be renamed, merged, or removed in any
// release, and a component that throws at that point blanks the whole slot.
const harnessModules = required.filter((specifier) => specifier.startsWith("@deepseek-ai/"));
if (harnessModules.length > 0) {
  problems.push(
    `loads Harness Client package(s) ${JSON.stringify(harnessModules)}; the shipped `
      + `cordis-plugin-development guidance (references/practices.md) forbids this — carry the `
      + `controls locally and keep only --dsw-alias-* theme tokens`,
  );
}
if (!required.includes("react")) problems.push("the bundle must load react");
console.log("exported keys:", JSON.stringify(Object.keys(exportsObj).sort()));

if (typeof exportsObj.apply !== "function") problems.push("missing apply()");
if (!Array.isArray(exportsObj.inject)) problems.push("inject must be an array");

const injectList = exportsObj.inject ?? [];
console.log("inject list:", JSON.stringify(injectList));
if (!injectList.includes("slots")) problems.push("inject must include 'slots'");
// `connection` carries the call to this package's own host half (tool registry).
if (!injectList.includes("connection")) problems.push("inject must include 'connection' (host tool route)");
for (const ns of ["remote.skills", "remote.pluginInventory", "remote.pluginManager"]) {
  if (!injectList.includes(ns)) problems.push(`inject must include ${ns} (read at runtime)`);
}
if (injectList.includes("sessions")) problems.push("inject lists 'sessions' but the bundle never reads it");

// Drive apply() against a recording ctx.
const slotCalls = [];
const registered = [];
const ctx = {
  remote: {
    skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    pluginInventory: { list: async () => ({ ok: true, value: { entries: [] } }) },
    pluginManager: { listBundles: async () => ({ ok: true, value: [] }) },
  },
  // The client-connection plugin provides this at runtime; the strip only needs
  // it to reach its own host half, so a recording stub is enough for the contract.
  connection: {
    rpc: {
      call: async () => ({ ok: true, value: { ok: true, servers: [], totalTools: 0 } }),
    },
  },
  slots: {
    inject(name, register) {
      slotCalls.push(name);
      register();
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

const dispose = exportsObj.apply(ctx);
console.log("slots.inject called with:", JSON.stringify(slotCalls));
console.log("slots.register called:", registered.length);

if (slotCalls.length !== 1) problems.push(`expected 1 slots.inject call, saw ${slotCalls.length}`);
if (slotCalls[0] !== "conversation.composer.dock") {
  problems.push(`unexpected slot ${JSON.stringify(slotCalls[0])}`);
}
if (registered.length !== 1) problems.push(`expected 1 registration, saw ${registered.length}`);

const reg = registered[0];
if (reg !== undefined) {
  const o = reg.options;
  console.log("registration options:", JSON.stringify({ name: o.name, id: o.id, order: o.order }));
  if (o.name !== "conversation.composer.dock") problems.push("registration name must match the slot");
  if (typeof o.inject !== "function") problems.push("dock registration needs an inject face for the session id");
  if (typeof reg.component !== "function") problems.push("dock registration needs a component function");
  if (typeof o.inject === "function") {
    const face = o.inject("session-under-test");
    console.log("inject face keys:", JSON.stringify(Object.keys(face)));
    if (typeof face.load !== "function") problems.push("inject face must expose load()");
    // `sessionId` must NOT be returned: it is a built-in standard prop already.
    if (Object.hasOwn(face, "sessionId")) {
      problems.push("inject face must not return sessionId (it would shadow the standard prop)");
    }
  }
}


// The host value is shape-validated before it becomes a payload: a malformed
// answer must read as a failure, never as a plausible "global, 0 tools" lie.
// This is a source-level tripwire so the guard cannot regress silently.
if (!source.includes("value.scope !== \"agent\" && value.scope !== \"global\"")) {
	problems.push("readTools must reject an unrecognizable host value shape");
}
if (!source.includes("typeof value.totalTools !== \"number\"")) {
	problems.push("readTools must require totalTools to be a number");
}
if (!source.includes("value.scope !== \"agent\" && value.scope !== \"global\"")) {
	problems.push("readTools must require a known scope label");
}

// The read path must stay cancellable and bounded, and a dropped trigger must
// carry the LATEST caller intent. These are runtime behaviours that a hook stub
// cannot exercise faithfully, so they are pinned at the source level.
// Each of these must appear as a complete expression, not merely as a name: a
// rename that orphans the call site is exactly the regression this catches.
for (const [label, needle] of [
	["a bounded read", "setTimeout(() => controller.abort(), READ_TIMEOUT_MS)"],
	// The ceiling is only real if EVERY read ends at it: the two Remotes that take no
	// signal are raced against the same handle instead.
	["a raced skills read", "abortable(skills.list({ sessionId }, signal), signal)"],
	["a raced inventory read", "abortable(inventory.list(), signal)"],
	["a raced bundles read", "abortable(manager.listBundles(), signal)"],
	["a raced host read", "abortable(connection.rpc.call(API_CHANNEL, TOOL_ENDPOINT, {"],
	["the ceiling named as a timeout", 'const READ_ABORTED = "读取超时，已取消";'],
	["a cancellable read", "connection.rpc.call(API_CHANNEL, TOOL_ENDPOINT, {"],
	["the abort signal reaching rpc.call", "}, signal)"],
	["the latest dropped trigger", "pendingOptions.current = options"],
	["the compensating read using it", "void run(pending)"],
	["unmount cancelling the read", "activeRead.current?.abort()"],
]) {
		if (!source.includes(needle)) problems.push(`client must keep ${label}: ${needle}`);
}
// --- The ceiling must actually END a read, not merely exist -----------------
// Behavioural, not a string tripwire: the Remotes below NEVER settle, which is the
// one case a source check cannot tell apart from a working one. If `loadAll` does
// not settle, the in-flight guard never clears and the strip stays dead until the
// dock remounts — so this drives the real `load` face and fails on a hang.
{
	const never = () => new Promise(() => {});
	const hung = [];
	const hangCtx = {
		remote: {
			skills: { list: never },
			pluginInventory: { list: never },
			pluginManager: { listBundles: never },
		},
		connection: { rpc: { call: never } },
		slots: {
			inject(_name, register) {
				register();
				return () => {};
			},
			register(options) {
				hung.push({ options });
				return () => {};
			},
		},
	};
	exportsObj.apply(hangCtx);
	const face = hung[0]?.options?.inject?.("session-under-test");
	if (typeof face?.load !== "function") {
		problems.push("the dock registration must expose a load face for the ceiling test");
	} else {
		const controller = new AbortController();
		const pending = face.load("session-under-test", controller.signal);
		controller.abort();
		const outcome = await Promise.race([
			pending.then((payload) => ({ payload }), (error) => ({ error })),
			new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 1000)),
		]);
		const abortedMessage = "读取超时，已取消";
		console.log("cancelled read:", outcome.hung === true ? "did not settle" : "settled");
		if (outcome.hung === true) {
			problems.push("a read whose Remotes never settle must still end at the ceiling");
		} else if (outcome.payload === void 0) {
			problems.push(`a cancelled read must settle as a payload, saw ${String(outcome.error)}`);
		} else {
			for (const block of ["skills", "inventory", "bundles", "tools"]) {
				if (outcome.payload[block]?.error !== abortedMessage) {
					problems.push(
						`a cancelled ${block} read must report ${JSON.stringify(abortedMessage)}, saw ${JSON.stringify(outcome.payload[block]?.error)}`,
					);
				}
			}
		}
	}
}

if (typeof dispose === "function") dispose();

console.log("---");
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log("  - " + p);
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
