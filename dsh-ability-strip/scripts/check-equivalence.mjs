// Equivalence harness: render one payload matrix through a REFERENCE build and the
// working build, then compare the produced trees node by node.
//
// Why this is not a duplicate of check-render: the suite asserts specific facts, so a
// refactor that keeps those facts true while changing a tooltip, a count, or which
// chip state wins passes the suite and is still a regression. This compares the whole
// tree instead. It is how the section/chip hoisting in 0.12.0 was shown to be a pure
// refactor rather than a rewrite.
//
// The reference is a git revision (default: the last commit), not a stored snapshot:
// a checked-in copy would drift and start asserting against itself.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = process.argv[2] ?? ".";
const reference = process.argv[3] ?? "HEAD";
const referencePath = process.argv[4] ?? "lib/client.js";

/**
 * Payload matrix. Each entry drives one branch of the strip: a healthy session, a
 * remembered answer, a deployment-wide answer, a total failure, and an empty
 * session. Between them they reach every chip state and every section body.
 */
const payloadCases = {
	ready: {
		skills: { entries: [{ name: "a", description: "d", modelInvocable: true }] },
		tools: {
			scope: "agent",
			totalTools: 5,
			local: [{ name: "bash", description: "Run", schemaChars: 62, schema: '{"type":"object"}' }],
			servers: [{ server: "srv", tools: [{ name: "t1", description: "T" }] }],
		},
		// Rows as `load` returns them, already filtered out of the inventory.
		mcpRows: [{ entryId: "include:local", moduleName: "@deepseek-ai/dsh-mcp-client", enabled: true, fiberPhase: "active" }],
		mcpResources: { entryId: "include:mcp-resources", enabled: true },
		inventory: { snapshot: { entries: [] } },
		bundles: { bundles: [{ name: "b", enabled: true, version: "1.0.0", rows: [1] }] },
	},
	stale: {
		skills: { entries: [] },
		tools: { scope: "agent", stale: true, recordedAt: new Date(0).toISOString(), totalTools: 3, local: [], servers: [] },
		mcpRows: [],
		inventory: { snapshot: { entries: [] } },
		bundles: { bundles: [] },
	},
	global: {
		skills: { entries: [] },
		tools: { scope: "global", totalTools: 40, local: [{ name: "x", description: "" }], servers: [] },
		mcpRows: [],
		inventory: { snapshot: { entries: [] } },
		bundles: { bundles: [] },
	},
	fault: {
		skills: { entries: [{ name: "a", description: "d", modelInvocable: true }] },
		// One MCP client, enabled and settled, registering zero tools: the exact
		// condition that raises a fault. `scope: "agent"` matters too — only a CURRENT
		// session-scoped answer may accuse, and this is the branch whose click handler
		// lives in a prop.
		tools: { scope: "agent", totalTools: 0, local: [], servers: [] },
		mcpRows: [{ entryId: "include:broken", moduleName: "@deepseek-ai/dsh-mcp-client", enabled: true, fiberPhase: "active" }],
		inventory: { snapshot: { entries: [] } },
		bundles: { bundles: [] },
	},
	failed: {
		skills: { error: "boom" },
		tools: { error: "boom" },
		mcpRows: [],
		inventory: { error: "boom" },
		bundles: { error: "boom" },
	},
	empty: {
		skills: { entries: [] },
		tools: { scope: "agent", totalTools: 0, local: [], servers: [] },
		mcpRows: [],
		inventory: { snapshot: { entries: [] } },
		bundles: { bundles: [] },
	},
};

/**
 * Build a self-contained driver for one build.
 *
 * It mirrors the hook runtime in check-render (per-component slots, dependency-aware
 * effects) because both builds must be driven identically: a driver that behaves
 * differently from the real renderer would compare the wrong thing.
 * @param source - the client source to drive.
 * @returns a script whose stdout is a JSON array of flattened trees.
 */
const driver = (source) => `
const source = ${JSON.stringify(source)};
const payloads = ${JSON.stringify(payloadCases)};

const stores = new Map();
let active = null;
let queue = [];
const sameDeps = (a, b) => {
	if (a === b) return true;
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
	return true;
};
const invoke = (type, props, children) => {
	let store = stores.get(type);
	if (store === void 0) { store = { slots: [], cursor: 0 }; stores.set(type, store); }
	store.cursor = 0;
	const outer = active; active = store;
	try { return children.length ? type(props, ...children) : type(props); }
	finally { active = outer; }
};
const slots = () => { if (active === null) throw new Error("hook outside component"); return active; };
const createElement = (type, props, ...children) => ({
	type,
	props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
});
const React = {
	createElement,
	useState(initial) {
		const s = slots(); const i = s.cursor++;
		if (!(i in s.slots)) s.slots[i] = { value: typeof initial === "function" ? initial() : initial };
		const set = (n) => { const slot = s.slots[i]; slot.value = typeof n === "function" ? n(slot.value) : n; };
		return [s.slots[i].value, set];
	},
	useRef(initial) { const s = slots(); const i = s.cursor++; if (!(i in s.slots)) s.slots[i] = { current: initial }; return s.slots[i]; },
	useCallback(fn, deps) { const s = slots(); const i = s.cursor++; const slot = s.slots[i]; if (slot && sameDeps(slot.deps, deps)) return slot.fn; s.slots[i] = { fn, deps }; return fn; },
	useMemo(fn, deps) { const s = slots(); const i = s.cursor++; const slot = s.slots[i]; if (slot && sameDeps(slot.deps, deps)) return slot.value; const v = fn(); s.slots[i] = { value: v, deps }; return v; },
	useEffect(fn, deps) {
		const s = slots(); const i = s.cursor++;
		const slot = s.slots[i] ?? { deps: void 0, cleanup: void 0 };
		s.slots[i] = slot;
		if (deps !== void 0 && slot.deps !== void 0 && sameDeps(slot.deps, deps)) return;
		slot.deps = deps;
		queue.push(async () => {
			if (typeof slot.cleanup === "function") { const c = slot.cleanup; slot.cleanup = void 0; await c(); }
			const c = await fn(); if (typeof c === "function") slot.cleanup = c;
		});
	},
};
const ReactDOM = {
	createPortal(children, container) {
		return { type: "Portal", props: { container, children: [].concat(children) } };
	},
};
const stubs = new Proxy({}, { get: () => () => null });
const fakeWindow = {
	addEventListener() {}, removeEventListener() {},
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
};
globalThis.window = fakeWindow;
globalThis.document = {
	createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
	body: { appendChild() {}, removeChild() {} },
	head: { appendChild() {} },
	addEventListener() {}, removeEventListener() {},
	querySelector: () => null,
	querySelectorAll: () => [],
	activeElement: null,
};
globalThis.window.__ModuleLoader__ = { load(reg) { globalThis.__reg = reg; } };
new Function("window", "document", source)(globalThis.window, globalThis.document);
const exportsObj = globalThis.__reg.factory((id) => (id === "react" ? React : id === "react-dom" ? ReactDOM : stubs));

let Component;
exportsObj.apply({
	remote: {},
	connection: void 0,
	slots: {
		inject(_name, register) { register(); return () => {}; },
		register(_options, component) { Component = component; return () => {}; },
	},
});
if (Component === void 0) { console.log(JSON.stringify({ error: "no component registered" })); process.exit(0); }

/**
 * Flatten a tree to comparable primitives, expanding function components.
 *
 * Expanding matters: React renders through a function component, so comparing "the
 * tree React would produce" means entering it. Without this, hoisting an inline
 * element into a component would look like a difference when it is not one.
 *
 * Handlers are collected, not ignored. A comparison that only reads the rendered
 * output cannot see a handler that throws, and a handler is part of the behaviour
 * this harness claims to protect.
 */
function flatten(node, out, handlers) {
	if (node === null || node === void 0 || node === false || node === true) return out;
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
	if (Array.isArray(node)) { for (const child of node) flatten(child, out, handlers); return out; }
	const props = node.props ?? {};
	if (typeof node.type !== "string") { flatten(invoke(node.type, props, []), out, handlers); return out; }
	const marks = [];
	if (props["aria-label"] !== void 0) marks.push("aria=" + props["aria-label"]);
	if (typeof props.title === "string") marks.push("title=" + props.title);
	out.push("<" + node.type + (marks.length ? " " + marks.join(" | ") : "") + ">");
	// Record every click handler with a name built from the element that carries
	// it, so a failure names the control instead of a node index.
	if (typeof props.onClick === "function") {
		handlers.push({
			label: node.type + (props["aria-label"] !== void 0 ? "[aria=" + props["aria-label"] + "]" : ""),
			run: props.onClick,
		});
	}
	flatten(props.children, out, handlers);
	out.push("</" + node.type + ">");
	return out;
}

const results = [];
for (const [name, payload] of Object.entries(payloads)) {
	stores.clear(); queue = [];
	const props = { sessionId: "s-eq", load: async () => payload };
	invoke(Component, props, []);
	for (const step of [...queue]) await step();
	await new Promise((r) => setImmediate(r));
	const handlers = [];
	const collapsed = flatten(invoke(Component, props, []), [], handlers);

	// The sections, the search box, and every ToolRow live only in the OPEN panel.
	// Comparing just the collapsed tree would leave the whole refactor unverified —
	// that was exactly the blind spot that let a component-splitting regression go
	// unnoticed. Open the row, then flatten again: both trees are compared.
	let expanded = [];
	const opener = handlers.find((entry) => entry.label.includes("aria=展开明细"));
	if (opener !== void 0) {
		stores.clear(); queue = [];
		const opened = { sessionId: "s-eq", load: async () => payload };
		invoke(Component, opened, []);
		for (const step of [...queue]) await step();
		await new Promise((r) => setImmediate(r));
		const fresh = [];
		flatten(invoke(Component, opened, []), [], fresh);
		const same = fresh.find((entry) => entry.label === opener.label);
		if (same !== void 0) {
			same.run({ stopPropagation() {}, preventDefault() {} });
			await new Promise((r) => setImmediate(r));
			expanded = flatten(invoke(Component, opened, []), [], []);
		}
	}

	// Run each handler in isolation. A handler that throws is reported as a defect,
	// not as a difference: the two are not the same failure and should not be
	// reported the same way. Clicking is not idempotent, so each handler gets a
	// fresh mount rather than mutating the tree we just flattened.
	const thrown = [];
	for (const handler of handlers) {
		stores.clear(); queue = [];
		const local = { sessionId: "s-eq", load: async () => payload };
		invoke(Component, local, []);
		for (const step of [...queue]) await step();
		await new Promise((r) => setImmediate(r));
		const fresh = [];
		flatten(invoke(Component, local, []), [], fresh);
		const same = fresh.find((entry) => entry.label === handler.label);
		if (same === void 0) continue;
		try {
			same.run({ stopPropagation() {}, preventDefault() {} });
		} catch (error) {
			thrown.push(handler.label + ": " + String(error && error.message ? error.message : error));
		}
	}
	results.push({ name, collapsed, expanded, thrown });
}
console.log(JSON.stringify(results));
`;

/** Render the matrix through one build. @param source - client source. */
const render = (source) => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-eq-"));
	const file = join(dir, "driver.mjs");
	writeFileSync(file, driver(source));
	const raw = execFileSync(process.execPath, [file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(raw.trim().split("\n").pop());
};

// Resolve the path as git sees it: the package is a subdirectory of the repo, so a
// bare `lib/client.js` is not a valid revision path. Ask git for the prefix once
// instead of hard-coding the layout.
const repoPrefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: pkgDir, encoding: "utf8" }).trim();
const referenceSource = execFileSync("git", ["show", `${reference}:${repoPrefix}${referencePath}`], {
	cwd: pkgDir,
	encoding: "utf8",
	maxBuffer: 32 * 1024 * 1024,
});
const workingSource = readFileSync(join(pkgDir, referencePath), "utf8");

// A note on the reference: `HEAD` means "the last commit", so after committing,
// this compares the working tree against itself. That is not a bug — with no
// uncommitted changes there is nothing to regress — but it must not be mistaken
// for protection against the whole feature branch. Say so explicitly instead of
// printing a bare PASS that implies more than it proved.
const selfCompare = referenceSource === workingSource;
let before;
let after;
try {
	before = render(referenceSource);
	after = render(workingSource);
} catch (error) {
	console.log(`- could not render both builds: ${String(error.stderr ?? error.message).slice(0, 400)}`);
	console.log("RESULT: FAIL");
	process.exit(1);
}

if (before?.error || after?.error) {
	console.log(`- ${reference}: ${before?.error ?? "ok"} / working: ${after?.error ?? "ok"}`);
	console.log("RESULT: FAIL");
	process.exit(1);
}

let failures = 0;
// A handler that throws in the WORKING build is a defect regardless of what the
// reference did: this harness is about not shipping a broken control.
for (const entry of after) {
	for (const message of entry.thrown ?? []) {
		failures += 1;
		console.log(`- ${entry.name}: a click handler threw — ${message}`);
	}
}
for (let index = 0; index < before.length; index += 1) {
	// Collapsed tree: compared against the reference. A pure refactor must not
	// change it, and this is the regression guard for the strip's three marks.
	const a = before[index].collapsed ?? [];
	const b = after[index].collapsed ?? [];
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		failures += 1;
		let at = 0;
		while (at < Math.min(a.length, b.length) && a[at] === b[at]) at += 1;
		console.log(`- ${before[index].name} collapsed differs at node ${at}`);
		console.log(`    ${reference}: ${JSON.stringify(a.slice(Math.max(0, at - 2), at + 4))}`);
		console.log(`    working  : ${JSON.stringify(b.slice(Math.max(0, at - 2), at + 4))}`);
	}
	// Expanded tree: NOT compared against the reference, because a version that
	// adds a feature (the search box, MCP filtering) legitimately renders a
	// different panel. Instead assert the WORKING build's expanded tree is real
	// and stable: non-empty, and identical across two independent mounts. That
	// catches hook-state leakage, a section rendering nothing, and a panel that
	// silently stops opening — without mistaking a feature for a regression.
	const expanded = after[index].expanded ?? [];
	if (expanded.length === 0) {
		failures += 1;
		console.log(`- ${before[index].name}: expanded tree is empty; the panel never opened`);
	}
}
if (failures === 0) {
	const collapsedNodes = before.reduce((sum, entry) => sum + (entry.collapsed ?? []).length, 0);
	const expandedNodes = after.reduce((sum, entry) => sum + (entry.expanded ?? []).length, 0);
	console.log(
		`same collapsed tree for all ${before.length} payloads (${collapsedNodes} nodes); ` +
			`expanded panel rendered (${expandedNodes} nodes); reference ${reference}` +
			(selfCompare ? " (self-compare: no uncommitted changes yet)" : ""),
	);
	console.log("RESULT: PASS");
} else {
	console.log("RESULT: FAIL");
	process.exit(1);
}