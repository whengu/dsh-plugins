// Drive the dock component with synthetic Remote answers and assert the tree it
// builds. This executes the component function, not the browser: it verifies the
// render logic (chips, sections, failure copy) without any live page.
//
// Each case is a FRESH MOUNT: every component's hook slots are cleared per case, so
// state cannot leak between scenarios.
//
// The hook runtime is deliberately faithful in two ways, because transitions inside
// one mount are part of the contract being tested (see "live to stale" below):
//   - slots belong to a component instance, so the detail panel and the strip cannot
//     read each other's state;
//   - `useEffect`/`useCallback`/`useMemo` compare dependency arrays, so a mount effect
//     does not re-fire on every render. Without that, a stub-specific extra read can
//     overwrite the very transition under test and make a broken feature look fixed.
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
/** Package root: this script lives in <root>/scripts. */
const pkgDir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(pkgDir, "lib/client.js"), "utf8");

// A minimal DOM surface: the bundle reads `document.body` as the portal target.
// Only the parts the component actually touches are stubbed; nothing renders.
// `addEventListener` is a no-op because the client no longer registers any
// document-level listeners (the visibility handler left with the change stream).
const BODY = { nodeType: 1, tagName: "BODY" };
globalThis.document = {
	body: BODY,
	addEventListener() {},
	removeEventListener() {},
};
// Intervals are CAPTURED, never scheduled: this is the tripwire that proves the
// strip runs no self-refresh timer. Any entry here is a regression, and case 7
// fails on the spot. `setTimeout` is real (the read timeout uses it), so only
// intervals are captured — a stray interval has no way to hide.
const timers = [];
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};
// `EventSource` is a tripwire, not a harness: the client must NOT open one any
// more (the change stream was removed with 0.10.0). The class exists only so a
// regression that re-adds streaming shows up in `sources` and fails case 7.
const sources = [];
class FakeEventSource {
	constructor(url) {
		this.url = url;
		sources.push(this);
	}
}
// Window events are recorded so a check can re-trigger the panel's placement
// effect (a resize) and prove the flip-down branch — the stub otherwise has no
// way to fire a layout change.
const windowListeners = {};
globalThis.window = {
  __ModuleLoader__: { load(r) { globalThis.__reg = r; } },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener(type, fn) {
    (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener(type, fn) {
    const bucket = windowListeners[type] ?? [];
    const index = bucket.indexOf(fn);
    if (index >= 0) bucket.splice(index, 1);
  },
  dispatchEvent() {
    for (const fn of [...(windowListeners.resize ?? [])]) fn();
    return true;
  },
};
/**
 * Build one element node.
 *
 * Children land in `props.children` the way React puts them there: a single child
 * as the value itself, several as an array. The plugin's own components destructure
 * `children` from props (React's contract), so a stub that only kept them on the
 * node would silently render nothing. They stay on the node too, because the
 * assertion helpers walk that form.
 */
const createElement = (type, props, ...children) => {
  const flat = children.flat(Infinity);
  const base = props ?? {};
  const resolved = flat.length === 0 ? base : { ...base, children: flat.length === 1 ? flat[0] : flat };
  const node = { type, props: resolved, children: flat };
  // The detail panel measures its anchor and re-places on layout changes. The
  // stub can't render, so a ref prop is wired to the node and the node carries
  // a replaceable rect — that is what lets the placement branches be exercised.
  if (typeof resolved.ref === 'object' && resolved.ref !== null) {
    resolved.ref.current = node;
  }
  node.rect = { top: 400, left: 400, width: 60, height: 22 };
  node.getBoundingClientRect = () => node.rect;
  return node;
};
// --- hook runtime (per component instance) --------------------------------
// Two fidelity rules, both load-bearing for anything that has to observe a change
// inside one mount:
//
//   1. Hook slots belong to a component instance, not to the whole render pass. A
//      single shared array lets the detail panel's useState() land in the strip's
//      slot, so the panel opening would silently reset the strip's state.
//   2. `useEffect`/`useCallback`/`useMemo` compare their dependency arrays, because
//      React does. Without that, `useCallback` returns a fresh function every render,
//      the mount effect's `[run, sessionId]` looks changed every time, and the stub
//      fires an extra non-silent read — which can overwrite the very transition a
//      test is trying to observe, making a broken feature look fixed.
const hookStores = new Map();
let activeStore = null;
let effectQueue = [];
let cleanups = [];

/** Shallow dependency comparison, the way React decides to reuse a memo. */
function sameDeps(previous, next) {
	if (previous === next) return true;
	if (!Array.isArray(previous) || !Array.isArray(next)) return false;
	if (previous.length !== next.length) return false;
	for (let index = 0; index < previous.length; index += 1) {
		if (!Object.is(previous[index], next[index])) return false;
	}
	return true;
}

/**
 * Run one function component inside its own hook frame.
 * @param type - the component function.
 * @param props - its props.
 * @param children - its children (usually empty; the panel passes props.children).
 * @returns whatever the component returned.
 */
function invokeComponent(type, props, children) {
	let store = hookStores.get(type);
	if (store === undefined) {
		store = { slots: [], cursor: 0 };
		hookStores.set(type, store);
	}
	store.cursor = 0;
	const outerStore = activeStore;
	activeStore = store;
	try {
		return children.length > 0 ? type(props, ...children) : type(props);
	} finally {
		activeStore = outerStore;
	}
}

/** The slot bag of the component currently rendering. */
function useSlots() {
	if (activeStore === null) throw new Error("hook used outside a component");
	return activeStore;
}

const React = {
	createElement,
	useState(initial) {
		const store = useSlots();
		const index = store.cursor++;
		if (!(index in store.slots)) {
			store.slots[index] = { value: typeof initial === "function" ? initial() : initial };
		}
		// The setter writes the slot rather than a captured array index: that is what
		// makes a later render of this component see the update while a sibling keeps
		// its own value.
		const set = (next) => {
			const slot = store.slots[index];
			slot.value = typeof next === "function" ? next(slot.value) : next;
		};
		return [store.slots[index].value, set];
	},
	useRef(initial) {
		const store = useSlots();
		const index = store.cursor++;
		if (!(index in store.slots)) store.slots[index] = { current: initial };
		return store.slots[index];
	},
	useCallback(fn, deps) {
		const store = useSlots();
		const index = store.cursor++;
		const slot = store.slots[index];
		if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.fn;
		store.slots[index] = { fn, deps };
		return fn;
	},
	useMemo(fn, deps) {
		const store = useSlots();
		const index = store.cursor++;
		const slot = store.slots[index];
		if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value;
		const value = fn();
		store.slots[index] = { value, deps };
		return value;
	},
	useEffect(fn, deps) {
		const store = useSlots();
		const index = store.cursor++;
		const slot = store.slots[index] ?? { deps: undefined, cleanup: undefined };
		store.slots[index] = slot;
		// No dependency array means "after every render", exactly like React.
		if (deps !== undefined && slot.deps !== undefined && sameDeps(slot.deps, deps)) return;
		slot.deps = deps;
		effectQueue.push(async () => {
			// React runs the previous cleanup before re-running an effect.
			if (typeof slot.cleanup === "function") {
				const cleanup = slot.cleanup;
				slot.cleanup = undefined;
				await cleanup();
			}
			const cleanup = await fn();
			if (typeof cleanup === "function") slot.cleanup = cleanup;
			return undefined;
		});
	},
};

// A primitive stub that PRESERVES children, so text inside Tag/Button survives.
const primitive = (key) => (props, ...children) => ({
  type: key,
  props: props ?? {},
  children: children.flat(Infinity),
});
// `Modal` is the one primitive whose behaviour matters here: a closed dialog
// renders nothing at all. A generic stub would leak its text into every check and
// make "no dialog" impossible to assert.
const stubs = new Proxy(
  {
    Modal: (props, ...children) => {
      if (props?.open !== true) return null;
      return { type: "Modal", props: props ?? {}, children: children.flat(Infinity) };
    },
  },
  {
    get: (target, key) => {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return primitive(key);
    },
  },
);

// `react-dom`'s only use here is createPortal: record the target and return the
// child tree so the panel's contents stay assertable.
const ReactDOM = {
  createPortal(children, container) {
    return { type: "Portal", props: { container }, children: [].concat(children) };
  },
};

new Function("window", "document", source)(globalThis.window, globalThis.document);
const exportsObj = globalThis.__reg.factory((id) =>
  id === "react" ? React : id === "react-dom" ? ReactDOM : stubs,
);

let Component;
exportsObj.apply({
  remote: {},
  slots: {
    inject(_name, register) { register(); return () => {}; },
    register(_options, component) { Component = component; return () => {}; },
  },
});

/** Fresh mount: every component starts with empty slots, as a new tree would. */
function mount(props) {
  hookStores.clear();
  activeStore = null;
  effectQueue = [];
  cleanups = [];
  return render(props);
}

/** Re-render the current mount (keeps per-component state, re-runs the component). */
function render(props) {
  effectQueue = [];
  return invokeComponent(Component, props, []);
}

/** Flush the effects recorded by the render pass just completed. */
async function settle() {
  const pending = [...effectQueue];
  effectQueue = [];
  for (const fn of pending) await fn();
  await new Promise((r) => setImmediate(r));
}

/** Run every mounted component's effect cleanups (what React does on unmount). */
async function unmount() {
  for (const store of [...hookStores.values()].reverse()) {
    for (const slot of [...store.slots].reverse()) {
      if (typeof slot?.cleanup === "function") {
        const cleanup = slot.cleanup;
        slot.cleanup = undefined;
        await cleanup();
      }
    }
  }
}

/** Let a microtask-queued read enter the stub's `load`. */
const flush = () => new Promise((r) => setImmediate(r));


/** Collect every string/number leaf in a built tree, expanding function components. */
function textOf(node) {
  if (node === null || node === undefined) return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (typeof node !== "object") return [];
  // A function component has not been invoked yet: call it so its markup counts.
  if (typeof node.type === "function") {
    let out;
    try {
      out = invokeComponent(node.type, node.props, node.children);
    } catch {
      return [];
    }
    return textOf(out);
  }
  return textOf(node.children);
}

/**
 * Every rendered element in a built tree, with function components invoked.
 *
 * `textOf` flattens text and stops there, so it cannot answer "did this icon
 * render as real svg, and did its colour override survive". This walks the same
 * way but collects the element nodes themselves.
 * @param node - built tree root.
 * @returns the rendered elements, outermost first.
 */
function collectElements(node) {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (typeof node.type === "function") {
    let out;
    try {
      out = invokeComponent(node.type, node.props, node.children);
    } catch {
      return [];
    }
    return collectElements(out);
  }
  return [node, ...collectElements(node.children)];
}

/**
 * Depth-first search for an interactive node by label. Matches the rendered text
 * or the accessible name, because the strip's buttons are icon-only.
 */
/**
 * Find the fault dialog's rendered element, if it is open.
 *
 * The plugin draws its own modal (it loads no Harness Client package), so the
 * dialog is located by the accessibility contract it puts in the DOM rather than
 * by a component name: a node carrying `role="dialog"` and `aria-modal="true"`.
 * Function components are invoked on the way down because the dialog only becomes
 * markup once the modal component runs, and the portal is descended through
 * because that is where the modal mounts its tree.
 * @param node - built tree root.
 * @returns the rendered dialog element when the dialog is open, otherwise undefined.
 */
function findDialog(node) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findDialog(child);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node.type === "Portal") return findDialog(node.children);
  if (typeof node.type === "function") {
    let produced;
    try {
      produced = invokeComponent(node.type, node.props, node.children);
    } catch {
      return undefined;
    }
    return findDialog(produced);
  }
  if (node.props?.role === "dialog" && node.props?.["aria-modal"] === "true") return node;
  return findDialog(node.children);
}

/**
 * Depth-first search for a node carrying an exact accessible name or title.
 *
 * The push-down marker on the collapsed row is an icon with no text, so `textOf`
 * cannot see it: its accessible name is the only thing there is to assert on.
 * @param node - built tree root.
 * @param label - exact `aria-label` (or `title`) to match.
 * @returns the matching node, or undefined.
 */
function findByLabel(node, label) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByLabel(child, label);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node.type === "Portal") return findByLabel(node.children, label);
  if (typeof node.type === "function") {
    let out;
    try {
      out = invokeComponent(node.type, node.props, node.children);
    } catch {
      return undefined;
    }
    return findByLabel(out, label);
  }
  if (node.props?.["aria-label"] === label || node.props?.title === label) return node;
  return findByLabel(node.children, label);
}

/**
 * The words a collapsed mark carries in its tooltip instead of printing them.
 *
 * The row is icons-only, so "未连接 / 连接故障 / 读取失败" live in the chip's `title`
 * (and the same sentence reaches the panel heading). These helpers read that, so a
 * state assertion does not need the words to be visible in the row.
 * @param tree - built tree root.
 * @param label - the mark's exact `aria-label` (`MCP` / `技能` / `工具`).
 * @returns the tooltip text, or an empty string when the mark is absent.
 */
function markTitle(tree, label) {
	const node = findByLabel(tree, label);
	return typeof node?.props?.title === "string" ? node.props.title : "";
}

/** @returns the MCP mark's tooltip, e.g. `MCP：未连接`. */
const mcpStateOf = (tree) => markTitle(tree, "MCP");
/** @returns the skill mark's tooltip, e.g. `技能清单读取失败`. */
const skillStateOf = (tree) => markTitle(tree, "技能");

function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;

  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label);
      if (hit) return hit;
    }
    return undefined;
  }
  // A portal node holds the panel; its children are not invoked components.
  if (node.type === "Portal") return findButton(node.children, label);
  // A function component must be invoked before its controls can be found.
  if (typeof node.type === "function") {
    let out;
    try {
      out = invokeComponent(node.type, node.props, node.children);
    } catch {
      return undefined;
    }
    return findButton(out, label);
  }
  if (typeof node.props?.onClick === "function") {
    const ownText = textOf(node.children).join("");
    const name = node.props["aria-label"];
    if (ownText.includes(label) || (typeof name === "string" && name.includes(label))) return node;
  }
  return findButton(node.children, label);
}

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };
/** Substring test over the collected text leaves (Array#includes is exact). */
const has = (text, needle) => text.some((t) => t.includes(needle));
const log = (label, tree) => console.log(`${label}: ${JSON.stringify(textOf(tree).join(" | "))}`);

const mcpEntry = { entryId: "include:mcp-local", moduleName: "@deepseek-ai/dsh-mcp-client", enabled: true, fiberPhase: "active" };
const resourcesEntry = { entryId: "mcp-resources", moduleName: "@deepseek-ai/dsh-mcp-resources", enabled: true, fiberPhase: "active" };
const payloadOk = {
  skills: { entries: [
    { name: "anti-process-theater", description: "stops theater", modelInvocable: true, whenToUse: "when a subagent flow looks staged" },
    { name: "code-review", description: "review", modelInvocable: false },
  ] },
  inventory: { snapshot: { entries: [mcpEntry, resourcesEntry] } },
  bundles: { bundles: [{ name: "dsh-base", enabled: true, version: "0.2.1-rc.2", rows: [1, 2] }] },
  // What the host half reports: `local` connected with two registered tools, plus
  // three non-MCP tools. 2 + 3 = 5 keeps `totalTools` honest against the buckets.
  // Each tool carries its own description, which is what the panel prints.
  tools: {
    servers: [
      {
        server: "local",
        tools: [
          { name: "read_file", description: "Read a file over MCP" },
          { name: "write_file", description: "Write a file over MCP" },
        ],
      },
    ],
    totalTools: 5,
    local: [
      { name: "bash", description: "Run a shell command" },
      { name: "read", description: "Read a file" },
      { name: "read_img", description: "Describe an image with the vision model" },
    ],
    scope: "agent",
  },
  mcpRows: [mcpEntry],
  mcpResources: resourcesEntry,
  loadedAt: "12:00:00",
};
// The resource plugin is mounted once for all servers, so it must never be
// counted or listed as a server.
const payloadNoResources = { ...payloadOk, inventory: { snapshot: { entries: [mcpEntry] } }, mcpResources: null };
// A configured server whose tools never registered: present in the Loader,
// absent from the registry. This is the case 有/无 must get right.
const payloadDisconnected = {
  ...payloadOk,
  tools: {
    servers: [],
    totalTools: 3,
    local: [
      { name: "bash", description: "Run a shell command" },
      { name: "read", description: "Read a file" },
      { name: "read_img", description: "Describe an image with the vision model" },
    ],
    // A fault claim requires a CURRENT agent-scope answer: this fixture is the
    // session's own view — its agent is live and simply registered no MCP tools.
    scope: "agent",
  },
};
const okProps = { sessionId: "s1", load: async () => payloadOk };
const disconnectedProps = { sessionId: "s1", load: async () => payloadDisconnected };
// The deployment catalog: same emptiness, but it is NOT this session's view, so it
// must never be rendered as current connectivity and must never raise a fault.
const payloadGlobal = { ...payloadOk, tools: { ...payloadDisconnected.tools, scope: "global" } };
const globalProps = { sessionId: "s1g", load: async () => payloadGlobal };

// --- Case 1: first paint, nothing read yet --------------------------------
let tree = mount(okProps);
log("case1 (first paint)", tree);
let text = textOf(tree);
// The marks are icons only now: the dock is a shared row and every label cost the
// width the numbers needed. Meaning survives through the glyph and an accessible
// name, so that is what is pinned — plus the flat ban on word labels below.
check(findByLabel(tree, "技能") !== undefined, "the skill mark must carry an accessible name");
check(findByLabel(tree, "MCP") !== undefined, "the MCP mark must carry an accessible name");
// A pending read must not claim anything about the session: `scope` read off a
// missing payload is undefined, which is not "agent" — that made the tooltip say
// "no active agent" before the first answer arrived.
check(
	(markTitle(tree, "工具") ?? "").includes("读取中"),
	`a pending read must say 读取中, saw ${JSON.stringify(markTitle(tree, "工具"))}`,
);
check(
	!(markTitle(tree, "工具") ?? "").includes("暂无活跃 agent"),
	"a pending read must not claim the session has no agent",
);
check(findByLabel(tree, "工具") !== undefined, "the tools mark must carry an accessible name");
check(text.includes("…"), "first paint must show a pending placeholder");
check(!text.includes("未连接"), "first paint must NOT claim MCP is disconnected before reading");
// The strip carries no title word of its own; the two marks name themselves.
check(!text.includes("能力"), "the strip must not print a title word");
check(!text.includes("技能"), "the collapsed row must use the word skill, not 技能");

// --- Case 2: loaded, collapsed -------------------------------------------
await settle();
tree = render(okProps);
log("case2 (loaded, collapsed)", tree);
text = textOf(tree);
check(text.includes("2"), "skill count 2 must render");
// No word labels anywhere in the collapsed row, by explicit request: the three
// numbers sit next to their own icons instead of "skill 2" / "MCP 28" / "tools 40".
check(!/\bskill\b/.test(text.join(" ")), "the collapsed row must not print the word skill");
check(!/\btools\b/.test(text.join(" ")), "the collapsed row must not print the word tools");
check(!text.includes("MCP"), "the collapsed row must not print MCP");
check(!text.includes("mcp-local"), "the collapsed row must not print server ids");
check(!text.includes("…"), "no placeholder once data arrived");
// MCP is a yes/no answer about the live registry, not a roster.
check(!text.includes("已连接"), "the chip must not repeat the icon state as text");
check(!text.includes("未连接"), "a connected server must not read 未连接");
check(!has(text, "已启用 · "), "the collapsed row must not print Loader phases");
// The third mark: total tools offered, which is the whole point of asking "what
// does the model actually get". It must not be the MCP subset repeated.
check(text.includes("5"), "the tools mark must show the total, not the MCP subset");
// Collapsed must not build the detail trees: they are skipped for cost, since the
// dock re-renders on every composer keystroke.
check(!has(text, "插件包"), "collapsed must not build the bundles section");
check(!has(text, "anti-process-theater"), "collapsed must not build skill rows");
// Narrow layout guard. The composer dock is a shared flex row, so a full-width
// claim here pushes every sibling widget and pulls the strip off to one side.
const rootStyle = tree.props?.style ?? {};
check(rootStyle.width !== "100%", "the strip wrapper must not claim full width");
check(rootStyle.flex === "0 1 auto", "the strip wrapper must size to its content");
const collapsedExpand = findButton(tree, "展开明细");
check(collapsedExpand !== undefined, "the row must be clickable with an accessible name");
check(
  findButton(tree, "刷新能力信息") === undefined,
  "the collapsed row must not carry a refresh control (it lives in the detail)",
);

// --- Case 3: expanded -----------------------------------------------------
const expand = findButton(tree, "明细");
console.log("expand button found:", expand !== undefined);
check(expand !== undefined, "明细 button must exist");
if (expand) expand.props.onClick();
// Opening the panel reads (see case 11). Settle it here so this case owns its own
// read: the stub has no unmount isolation, and a read left in flight would land in
// the next case's state slot.
await flush();
tree = render(okProps);
log("case3 (expanded)", tree);
text = textOf(tree);
check(has(text, "anti-process-theater"), "expanded must list skill names");
check(has(text, "/anti-process-theater"), "a skill name must render in composer form");
check(has(text, "when a subagent flow looks staged"), "whenToUse must be shown when present");
check(has(text, "code-review"), "expanded must list every skill");
  check(has(text, "已启用 · active"), "expanded MCP row must show its Loader phase");
check(text.includes("dsh-base"), "expanded must list bundle names");
check(text.includes("插件包"), "bundles group must have its own heading");
check(text.includes("技能") && text.includes("MCP"), "both group headings present in the detail");
check(text.includes("工具"), "the tools group must have its own heading");
check(has(text, "read_img"), "the detail must list non-MCP tool names");
check(has(text, "bash"), "every non-MCP tool must be listed, not only the interesting ones");
// The description is the tool author's own words from the schema, which is the
// only place they exist — so the detail must print them, for both halves.
check(has(text, "Describe an image with the vision model"), "a non-MCP tool must show its description");
check(has(text, "Read a file over MCP"), "an MCP tool must show its description too");
// The heading count must be the length of the list under it, and the breakdown line
// must account for every tool. This is the defect a reader hit: the heading said the
// grand total while the list held only the non-MCP half, so the numbers looked wrong.
// The number in the heading itself, read from the rendered order (heading icon has no
// text, so "工具" is followed by the count). Asserting only the prose below would let a
// regression back to the grand total pass unnoticed — it did, on my first attempt.
const toolsHeadingAt = text.indexOf("工具");
check(
	toolsHeadingAt >= 0 && text[toolsHeadingAt + 1] === "3",
	`the tools heading must count its own rows (3), saw ${JSON.stringify(text.slice(toolsHeadingAt, toolsHeadingAt + 2))}`,
);
check(has(text, "下列 3 个非 MCP"), "the breakdown must state how many rows are listed here");
check(has(text, "上方 MCP 分区 2 个"), "the breakdown must state the MCP count it delegates upward");
check(has(text, "共 5 个"), "the breakdown must still account for the grand total");
check(
	!has(text, "其余 2 个 MCP"),
	"the MCP count must be counted, not derived by subtracting from the total",
);
check(
  has(text, "本会话 agent 视图"),
  "an agent-scoped answer must name its scope, because that is the view with restrictions applied",
);
// The section reads the REGISTRY, so it must say that a request-level filter is
// invisible here — that difference is why `read_image` still appears even though
// dsh-read-img removes it from the LLM request.
check(
  has(text, "请求层再次过滤"),
  "the tools section must state that request-level filtering is not reflected",
);
check(has(text, "资源工具：已挂载"), "the resource plugin must be stated when mounted");
check(findButton(tree, "刷新能力信息") !== undefined, "the detail must offer a refresh control");
// It is mounted once for all servers, so it must never render as a server row:
// a server row is the ONLY place the `enabled · <phase>` label appears.
  const serverRows = text.filter((t) => t.includes("已启用 · ") || t.includes("已停用 · "));
check(serverRows.length === 1, `expected one MCP server row, saw ${serverRows.length}`);
check(
  !text.some((t) => t.includes("mcp-resources") && (t.includes("已启用 · ") || t.includes("已停用 · "))),
  "the resource plugin must not be listed as a server",
);

// --- Case 3a: an older host that sends bare tool names ---------------------
// The browser half updates on a refresh; the host half only on a restart. During
// that window the payload still carries `["read_file"]` rather than objects, and
// the panel must degrade to "names, no descriptions" instead of empty rows.
const legacyShapeProps = {
  sessionId: "s-legacy",
  load: async () => ({
    ...payloadOk,
    tools: {
      ...payloadOk.tools,
      servers: [{ server: "local", tools: ["read_file"] }],
      local: ["bash"],
    },
  }),
};
{
  mount(legacyShapeProps);
  await settle();
  const legacyTree = render(legacyShapeProps);
  const openLegacy = findButton(legacyTree, "明细");
  if (openLegacy) openLegacy.props.onClick();
  await flush();
  const legacyText = textOf(render(legacyShapeProps));
  check(has(legacyText, "read_file"), "a bare tool name from an older host must still render");
  check(has(legacyText, "bash"), "a bare non-MCP tool name must still render");
  check(!has(legacyText, "undefined"), "an older host's shape must never print undefined");
}
// --- Case 3b: no resource plugin -----------------------------------------
const noResProps = { sessionId: "s1b", load: async () => payloadNoResources };
mount(noResProps);
await settle();
text = textOf(render(noResProps));
log("case3b (no resources)", render(noResProps));
check(!has(text, "资源工具"), "no resource line when the plugin is absent");
check(mcpStateOf(tree).length > 0, "the MCP mark survives without the resource plugin");

// --- Case 4: tool registry read failed -----------------------------------
const badProps = { sessionId: "s2", load: async () => ({ ...payloadOk, tools: { error: "boom" } }) };
mount(badProps);
await settle();
// Full commit sequence: this case carries enabled rows and an unreadable registry,
// which is exactly the shape that must NOT be called a fault. Without the commit
// stage a wrongly-opened dialog would stay invisible and the check would lie.
render(badProps);
await settle();
render(badProps);
text = textOf(render(badProps));
log("case4 (tools failed)", render(badProps));
check(mcpStateOf(render(badProps)).includes("读取失败"), "a failed tool-registry read must report 读取失败 (in the tooltip; the row is icons-only)");
check(!text.includes("未连接"), "a failed registry read must not be reported as disconnected");
check(findDialog(render(badProps)) === undefined, "a failed registry read must NOT be called a fault");
check(!has(text, "资源工具"), "a failed registry read must not invent a resource line");

// --- Case 4b: configured server whose tools never registered -------------
// The fault case, and the reason this plugin exists: the Loader carries the row
// and marks it enabled, but no `mcp__local__*` tool is registered. The reader
// must be told, not left to discover it.
mount(disconnectedProps);
await settle();
// The fault effect is keyed on the payload-derived fault key, so it first runs on
// the render AFTER the read landed. It then calls setAlertOpen(true), whose value
// only appears on the following render — which is exactly React's commit order.
render(disconnectedProps);
await settle();
// One more render shows the committed `alertOpen: true`.
render(disconnectedProps);
text = textOf(render(disconnectedProps));
log("case4b (configured but disconnected)", render(disconnectedProps));
check(mcpStateOf(render(disconnectedProps)).includes("连接故障"), "a configured server with no registered tools must claim 连接故障");
check(!text.includes("未连接"), "a real fault must not be softened to 未连接");
check(mcpStateOf(render(disconnectedProps)).includes("连接故障"), "a configured-but-disconnected server must claim 连接故障");
// The dialog must open by itself — this is the whole point of the feature.
const dialogNode = findDialog(render(disconnectedProps));
check(dialogNode !== undefined, "the fault dialog must open on its own when a configured server registers no tools");
check(dialogNode?.props?.["aria-label"] === "MCP 连接故障", "the dialog must be titled as a fault");
const dialogText = dialogNode === undefined ? [] : textOf(dialogNode.children);
check(has(dialogText, "没有任何一个注册了工具"), "the dialog must state the fault plainly");
check(has(dialogText, "mcp-local"), "the dialog must name the affected servers");
check(has(dialogText, "知道了"), "the dialog must be dismissible");
// The bundle draws its own controls now, so the icon has to be real svg markup and
// a call site's colour override has to survive the component: an icon that drops
// `style` renders in the inherited colour and the fault loses its red cue.
const dialogSvgs = dialogNode === undefined ? [] : collectElements(dialogNode).filter((n) => n.type === "svg");
check(dialogSvgs.length > 0, "the fault mark must render as real svg markup");
check(
  dialogSvgs.some((n) => String(n.props.style?.color ?? "").includes("state-error-primary")),
  "an icon's colour override must pass through to the rendered svg",
);
const expand4b = findButton(render(disconnectedProps), "明细");
if (expand4b) expand4b.props.onClick();
await flush();
text = textOf(render(disconnectedProps));
check(has(text, "没有 MCP 服务器注册工具"), "the panel must state that no server registered tools");
check(has(text, "已配置 1 个客户端条目"), "the configured row must still be listed apart");

// The fault dialog has a keyboard-reachable equivalent inside the panel: the row
// toggle is one button and the chip click is mouse-only, so a keyboard reader who
// dismissed the dialog needs a real button here to reopen it.
// The panel is one of possibly two dialogs (the fault Modal may be open); the
// whole tree is what counts here — the button must exist somewhere.
check(
	has(textOf(render(disconnectedProps)), "查看故障原因"),
	"the panel must offer a real button to reopen the fault dialog",
);

// --- Case 5: empty but successful ----------------------------------------
// No MCP configured at all. This is NOT a fault: nagging about a feature the
// reader does not use is noise, and noise gets a plugin uninstalled.
const emptyProps = { sessionId: "s3", load: async () => ({ ...payloadOk, tools: { servers: [], totalTools: 0 }, inventory: { snapshot: { entries: [] } }, mcpRows: [], mcpResources: null }) };
mount(emptyProps);
await settle();
// Full commit sequence: a negative check that never reaches the commit stage
// would pass even if the dialog wrongly opened.
render(emptyProps);
await settle();
render(emptyProps);
text = textOf(render(emptyProps));
check(
	mcpStateOf(render(emptyProps)).includes("部署级注册表"),
	"a deployment-scope empty read must say which view it is, not claim this session is disconnected",
);
check(
	!mcpStateOf(render(emptyProps)).includes("未连接"),
	"a deployment-scope read must not claim 未连接 about the session",
);
check(findDialog(render(emptyProps)) === undefined, "no MCP configured must NOT open the fault dialog");
check(!text.includes("连接故障"), "no MCP configured must NOT read 连接故障");

// --- Case 5a: every MCP row disabled -------------------------------------
// Configured but deliberately switched off is also not a fault.
const disabledProps = {
  sessionId: "s3a",
  load: async () => ({
    ...payloadOk,
    tools: { servers: [], totalTools: 0 },
    inventory: { snapshot: { entries: [{ ...mcpEntry, enabled: false }] } },
    mcpRows: [{ ...mcpEntry, enabled: false }],
    mcpResources: null,
  }),
};
mount(disabledProps);
await settle();
render(disabledProps);
await settle();
render(disabledProps);
text = textOf(render(disabledProps));
check(findDialog(render(disabledProps)) === undefined, "a disabled MCP row must NOT open the fault dialog");
check(
	!mcpStateOf(render(disabledProps)).includes("连接故障"),
	"a disabled MCP row must not be a fault",
);

// --- Case 5a2: registry read failed, rows enabled ------------------------
// The strip cannot tell whether this is a fault, so it must not accuse.
const unreadableProps = {
  sessionId: "s3b",
  load: async () => ({ ...payloadOk, tools: { error: "boom" } }),
};
mount(unreadableProps);
await settle();
// The full commit sequence, or a dialog that SHOULD have opened would not appear
// and this negative check would pass for the wrong reason.
render(unreadableProps);
await settle();
render(unreadableProps);
text = textOf(render(unreadableProps));
check(findDialog(render(unreadableProps)) === undefined, "an unreadable registry must NOT open the fault dialog");
check(mcpStateOf(render(unreadableProps)).includes("读取失败"), "an unreadable registry still reports 读取失败");

// --- Case 5b: skills read failed -----------------------------------------
// Each block fails independently, so a skills failure must not blank MCP.
const skillsBadProps = {
  sessionId: "s5",
  load: async () => ({ ...payloadOk, skills: { error: "denied" } }),
};
mount(skillsBadProps);
await settle();
text = textOf(render(skillsBadProps));
log("case5b (skills failed)", render(skillsBadProps));
check(skillStateOf(render(skillsBadProps)).includes("读取失败"), "a failed skills read must report 读取失败 (tooltip; the row is icons-only)");
check(mcpStateOf(render(skillsBadProps)).length > 0, "a skills failure must not blank the MCP mark");
const expand5b = findButton(render(skillsBadProps), "明细");
if (expand5b) expand5b.props.onClick();
await flush();
text = textOf(render(skillsBadProps));
check(has(text, "skills/list 读取失败"), "the expanded skills block must name its failing Remote");

// --- Case 5c: bundles read failed ----------------------------------------
const bundlesBadProps = {
  sessionId: "s6",
  load: async () => ({ ...payloadOk, bundles: { error: "no manager" } }),
};
mount(bundlesBadProps);
await settle();
render(bundlesBadProps);
const expand5c = findButton(render(bundlesBadProps), "明细");
if (expand5c) expand5c.props.onClick();
await flush();
text = textOf(render(bundlesBadProps));
log("case5c (bundles failed)", render(bundlesBadProps));
check(has(text, "pluginManager/listBundles 读取失败"), "a failed bundle read must name its failing Remote");
check(has(text, "MCP"), "a bundle failure must not blank MCP");

// --- Case 6: load throws --------------------------------------------------
const throwProps = { sessionId: "s4", load: async () => { throw new Error("network down"); } };
mount(throwProps);
await settle();
text = textOf(render(throwProps));
log("case6 (throw)", render(throwProps));
check(text.some((t) => t.includes("读取失败：network down")), "a thrown load must be shown");
	// The chips must not linger on "…" after the whole load threw: the error text
	// sits below the fold, so the collapsed row has to carry the failure itself.
	// Each mark turns into the failure glyph instead of a forever-pending ellipsis.
	check(!text.includes("…"), "a thrown load must not leave the chips on a forever-pending ellipsis");
	check(
		findByLabel(render(throwProps), "技能") !== undefined &&
			findByLabel(render(throwProps), "MCP") !== undefined &&
			findByLabel(render(throwProps), "工具") !== undefined,
		"all three marks must still exist after a thrown load",
	);

// --- Case 7: no timer, no stream, one read on mount ----------------------
// The strip reads on demand now: mounting reads once, and nothing is pushed.
// `timers` is the harness's fake `setInterval` (a self-refresh timer would land
// there) and `sources` its fake `EventSource` (a change stream would land there).
{
	const sourcesBefore = sources.length;
	let loads = 0;
	const countingProps = {
		sessionId: "s-count",
		load: async () => {
			loads += 1;
			return payloadOk;
		},
	};
	mount(countingProps);
	await settle();
	check(timers.length === 0, `the strip must not register an interval, saw ${timers.length}`);
	check(
		sources.length === sourcesBefore,
		`the strip must not open a change stream any more, saw ${sources.length - sourcesBefore}`,
	);
	check(loads === 1, `mounting must read exactly once, saw ${loads}`);
	await unmount();
}

// --- Case 10: a slow read must not stack requests -------------------------
// Now that reads are triggered by the reader (panel open, refresh) rather than by
// a pushed frame, the case that matters is a second trigger while the first read is
// still pending: the strip must not ask the Host again, and the trigger must collapse
// into exactly one follow-up read once the pending one settles.
let slowCalls = 0;
let release;
const gate = new Promise((resolve) => {
	release = resolve;
});
const slowProps = {
	sessionId: "s10",
	load: async () => {
		slowCalls += 1;
		await gate;
		return payloadOk;
	},
};
mount(slowProps);
// Flush the effects so the mount read is STARTED; it stays pending on the gate.
for (const fn of [...effectQueue]) await fn();
await flush();
const callsBeforeOpen = slowCalls;
check(callsBeforeOpen >= 1, "the mount read must have started");
// Opening the panel is a second trigger while the first read is still pending.
const row10 = findByLabel(render(slowProps), "展开明细");
row10?.props?.onClick?.();
await flush();
check(
	slowCalls === callsBeforeOpen,
	`a trigger during an in-flight read must not start another (saw ${slowCalls}, before ${callsBeforeOpen})`,
);
// Releasing the gate lets the pending read finish; the extra trigger collapses into
// ONE follow-up read rather than one per trigger.
release();
await flush();
await flush();
check(
	slowCalls === callsBeforeOpen + 1,
	`triggers during a read must collapse into one follow-up read, saw ${slowCalls} (before ${callsBeforeOpen})`,
);

// --- Case 11: opening the panel reads -------------------------------------
// The MCP answer is pushed, but skills and bundles have no change signal of their
// own: opening the panel is the reader asking for detail, so it re-reads once.
let openCount = 0;
const openProps = {
  sessionId: "s11",
  load: async () => {
    openCount += 1;
    return payloadOk;
  },
};
mount(openProps);
await settle();
const beforeExpand = openCount;
const expandCase11 = findButton(render(openProps), "明细");
check(expandCase11 !== undefined, "case 11 must find the expand control");
if (expandCase11) expandCase11.props.onClick();
await flush();
check(openCount === beforeExpand + 1, `opening the panel must read once, saw ${openCount} (before ${beforeExpand})`);
// Collapsing is not a request for data.
const reopenCount = openCount;
const collapseCase11 = findButton(render(openProps), "明细");
if (collapseCase11) collapseCase11.props.onClick();
await flush();
check(openCount === reopenCount, "closing the panel must not read");

// --- The mechanism, stated once more over every case above ----------------
// Any of the mounts above reintroducing a self-refresh timer fails here, whatever
// it was for.
check(timers.length === 0, `no mount may register an interval, saw ${timers.length}`);




// --- The detail panel opens the way that fits its anchor --------------------
// Placement is the panel's only branching logic, so it was lifted into a pure
// function: it can then be asserted here, from the shipped source itself, instead
// of through a hook stub that shares one state array across components.
// A panel forced upward with no headroom pushes its header (refresh/close) off
// screen, which is a dead control — that is the case this pins.
const computePlacement = (() => {
  const start = source.indexOf('function computePlacement(');
  if (start < 0) return undefined;
  // The function ends at the first line that is exactly `}` at column 0.
  const rest = source.slice(start);
  const end = rest.search(/\n\}/);
  if (end < 0) return undefined;
  return new Function(`${rest.slice(0, end + 2)}; return computePlacement;`)();
})();
check(typeof computePlacement === 'function', 'the shipped source must define computePlacement');
if (typeof computePlacement === 'function') {
  const viewport = { width: 1200, height: 800 };
  // A composer row near the bottom: plenty of room above, so it opens upward.
  const low = computePlacement({ top: 700, left: 600, width: 60, bottom: 722 }, viewport);
  check(typeof low.bottom === 'number', 'with room above, the panel must open upward');
  check(low.top === undefined, 'an upward panel must not also carry a top');
  // Pinned near the top of the viewport: no headroom, so it must flip downward.
  const high = computePlacement({ top: 12, left: 600, width: 60, bottom: 34 }, viewport);
  check(typeof high.top === 'number', 'an anchor near the top must flip the panel downward');
  check(high.bottom === undefined, 'a downward panel must not also carry a bottom');
  check(high.top > 34, 'a downward panel must start below its anchor');
  // The header must stay on screen in both orientations.
  check(low.maxHeight >= 120 && low.maxHeight <= 420, 'the panel height must stay bounded');
  check(high.maxHeight >= 120 && high.maxHeight <= 420, 'the flipped panel height must stay bounded');
}



// --- A silent read must carry the strip from live to stale ----------------
// End-to-end inside ONE mount: the first read is answered by a live agent, then
// that agent is released and the host serves its remembered answer. Opening the
// panel is what issues the second (silent) read, exactly as in the browser — so a
// stub that shared one hook array across components could never show this: the
// panel's own hooks would reset the strip's cursor and the state would be lost.
// Nothing here is a source-level assertion; the component really renders twice.
const livePayload = { ...payloadOk, tools: { ...payloadOk.tools, scope: "agent" } };
const staleRecordedAt = new Date(Date.now() - 5 * 60000).toISOString();
const stalePayload = {
	...payloadOk,
	tools: { ...payloadOk.tools, scope: "agent", stale: true, recordedAt: staleRecordedAt },
};
let transitionCalls = 0;
const transitionProps = {
	sessionId: "s-live-to-stale",
	load: async () => {
		// The host answers live on the first read and from memory afterwards.
		transitionCalls += 1;
		return transitionCalls === 1 ? livePayload : stalePayload;
	},
};
{
	mount(transitionProps);
	await settle();
	await flush();
	// State 1: the agent is alive, so the chip states the live total.
	const liveTree = render(transitionProps);
	check(
		(markTitle(liveTree, "工具") ?? "").includes("本会话 agent"),
		`the first read must render as live, saw ${JSON.stringify(markTitle(liveTree, "工具"))}`,
	);
	// Opening the panel is the user action that triggers the silent re-read.
	const openRow = findByLabel(liveTree, "展开明细");
	check(openRow !== undefined, "the collapsed row must be found before opening");
	openRow?.props?.onClick?.();
	await flush();
	await settle();
	await flush();
	check(
		transitionCalls >= 2,
		`opening the panel must issue a second read, saw ${transitionCalls} call(s)`,
	);
	// State 2: same mount, same component instance — the answer is now a past one.
	const staleTree = render(transitionProps);
	const staleTitle = markTitle(staleTree, "工具") ?? "";
	check(
		staleTitle.includes("上次活跃时"),
		`a live->stale transition must reach the collapsed chip, saw ${JSON.stringify(staleTitle)}`,
	);
	check(
		staleTitle.includes("当前无活跃 agent"),
		"the stale chip must say the agent is gone, not merely show an old number",
	);
	// The MCP mark obeys the same rule: a remembered answer is not current state.
	const staleMcp = textOf(findByLabel(staleTree, "MCP") ?? []).join("");
	check(
		!/\d/.test(staleMcp),
		`a remembered MCP answer must not print a live-looking count, saw ${JSON.stringify(staleMcp)}`,
	);
	// The panel dates the reading rather than implying it is now.
	const stalePanel = textOf(staleTree);
	check(has(stalePanel, "上次活跃时"), "the open panel must date the remembered reading");
	check(
		has(stalePanel, "不是现在的部署注册表"),
		"the panel must say the remembered list is not the deployment catalog",
	);
	// A second silent read keeps the same answer: the transition is idempotent.
	const callsBefore = transitionCalls;
	const rowAgain = findByLabel(render(transitionProps), "收起明细");
	rowAgain?.props?.onClick?.();
	await flush();
	await settle();
	check(
		(markTitle(render(transitionProps), "工具") ?? "").includes("上次活跃时"),
		"re-reading a stale answer must not flip it back to looking live",
	);
	check(transitionCalls >= callsBefore, "the close/reopen cycle must stay coherent");
}


// --- The panel's state must be its own, not the strip's --------------------
// The panel is a separate component with its own `useState` (placement) and
// `useRef` (its DOM node). One shared hook bag makes its `pos` read the strip's
// slot, and the panel then renders with neither the hidden placeholder nor a real
// placement — while its render can also overwrite the strip's payload. This pins
// the isolation itself: without it, the live->stale case above is only accidentally
// green, because a corrupted render can still produce the right words.
{
	mount(okProps);
	await settle();
	const opener = findByLabel(render(okProps), "展开明细");
	opener?.props?.onClick?.();
	await flush();
	// Let the panel's placement effect run, so its own state has been written.
	await settle();
	const tree = render(okProps);
	const panelNode = collectElements(tree).find((n) => n?.props?.id === "ability-strip-detail");
	check(panelNode !== undefined, "the open panel must carry its own id");
	const panelStyle = panelNode?.props?.style ?? {};
	// Exactly one of the two honest states: not measured yet (hidden placeholder),
	// or measured (a numeric height plus an anchor edge). Anything else is a panel
	// reading state that belongs to another component.
	const hiddenPending = panelStyle.visibility === "hidden";
	const placed =
		typeof panelStyle.maxHeight === "number" &&
		(typeof panelStyle.bottom === "number" || typeof panelStyle.top === "number");
	check(
		hiddenPending || placed,
		`the panel's placement state must be its own, saw ${JSON.stringify(panelStyle)}`,
	);
	// And the strip's own state must survive the panel's render.
	check(
		(markTitle(tree, "工具") ?? "").includes("本会话 agent"),
		"rendering the panel must not disturb the strip's payload",
	);
}

// --- No markdown leaks into the rendered text ------------------------------
// Panel copy is a plain JS string, not markdown: `**bold**` would print its
// asterisks to the reader. A reader hit exactly that, so it is pinned here.
{
  mount(okProps);
  await settle();
  const open = findButton(render(okProps), '明细');
  if (open) open.props.onClick();
  await flush();
  const rendered = textOf(render(okProps));
  const withAsterisks = rendered.filter((t) => t.includes('**'));
  check(
    withAsterisks.length === 0,
    `no rendered string may contain markdown asterisks, saw ${JSON.stringify(withAsterisks.slice(0, 2))}`,
  );
}

// --- The collapsed row is one control, not several ------------------------
// It carries `role="button"`, so it must answer the keyboard. A role that takes a
// tab stop and ignores Enter/Space is a trap: focus lands there and nothing happens.
{
	mount(okProps);
	await settle();
	const keyboardTree = render(okProps);
	const row = findByLabel(keyboardTree, "展开明细");
	check(row !== undefined, "the row must expose its expanded state in its label");
	check(typeof row?.props?.onKeyDown === "function", "a role=button row must handle keys");
	let prevented = 0;
	row?.props?.onKeyDown?.({ key: "Enter", preventDefault: () => { prevented += 1; } });
	check(prevented === 1, "Enter must be consumed, not left to the page");
	await flush();
	const opened = render(okProps);
	check(
		findByLabel(opened, "收起明细") !== undefined,
		"Enter on the row must actually open the detail panel",
	);
	// Space is the other key a button answers to, and the one that scrolls by default.
	const openRow = findByLabel(opened, "收起明细");
	openRow?.props?.onKeyDown?.({ key: " ", preventDefault: () => {} });
	await flush();
	check(findByLabel(render(okProps), "展开明细") !== undefined, "Space must toggle it back");
}

// --- A read failure must not borrow the fault glyph -----------------------
// Both used to render the warning triangle, so "we could not read the registry" and
// "MCP is configured but nothing connected" looked identical once the row lost its
// words. They are different facts and must stay visually distinct.
const chipGlyph = (tree) => {
	const chip = findByLabel(tree, "MCP");
	if (chip === undefined) return undefined;
	const svgs = collectElements(chip).filter((node) => node.type === "svg");
	// The chip draws its mark first and its state second, so the LAST svg is the
	// glyph that differs between states.
	const stateSvg = svgs[svgs.length - 1];
	return stateSvg?.children?.[0]?.props?.d;
};
{
	mount(disconnectedProps);
	await settle();
	const faultGlyph = chipGlyph(render(disconnectedProps));
	mount(badProps);
	await settle();
	const failureGlyph = chipGlyph(render(badProps));
	check(faultGlyph !== undefined && failureGlyph !== undefined, "both states must draw a glyph");
	check(
		faultGlyph !== failureGlyph,
		"a registry read failure must not render the same glyph as an MCP fault",
	);
}

// --- No native button inside the row --------------------------------------
// The row is `role="button"`; nesting a real <button> inside it produces two tab
// stops for one visual control and a nested-interactive violation.
{
	mount(disconnectedProps);
	await settle();
	const faultTree = render(disconnectedProps);
	const row = findByLabel(faultTree, "展开明细") ?? findByLabel(faultTree, "收起明细");
	const nested = row === undefined ? [] : collectElements(row).filter((node) => node.type === "button");
	check(
		nested.length === 0,
		`a role=button row must not contain a native button, saw ${nested.length}`,
	);
}


// --- A global answer must never masquerade as this session's tools --------
// The host reads `tools.schemas(agent)`, and an agent exists only while its session
// is live in the Host process. After a restart the fallback is the deployment
// catalog; printing that count where the session's count belongs is precisely the
// misreport the reader hit, so the collapsed chip must show no number at all.
{
	mount(globalProps);
	await settle();
	const globalTree = render(globalProps);
	const toolsChip = findByLabel(globalTree, "工具");
	const chipText = textOf(toolsChip ?? []);
	check(
		!/\d/.test(chipText.join("")),
		`a global answer must not print a count, saw ${JSON.stringify(chipText)}`,
	);
	check(
		(markTitle(globalTree, "工具") ?? "").includes("暂无活跃 agent"),
		"the chip must say WHY it has no number, not just omit it",
	);
	const openGlobal = findButton(globalTree, "明细");
	if (openGlobal) openGlobal.props.onClick();
	await flush();
	const globalText = textOf(render(globalProps));
	check(has(globalText, "没有活跃 agent"), "the panel must explain the missing agent");
	check(has(globalText, "部署级注册表"), "the panel must label the fallback for what it is");
	check(
		!has(globalText, "本会话 agent 视图"),
		"the panel must not claim a session view it does not have",
	);
}


// --- A remembered reading is shown as a reading, with its time -------------
// The host remembers the last answer a live agent gave for a session, so a session
// whose agent has been released still shows its own numbers instead of the
// deployment catalog. Those numbers are no longer current, so the chip keeps them
// muted and the tooltip and the panel both say when they were taken.
const recordedAt = new Date(Date.now() - 42 * 60000).toISOString();
const staleProps = {
	sessionId: "s-stale",
	load: async () => ({
		...payloadOk,
		tools: { ...payloadOk.tools, scope: "agent", stale: true, recordedAt },
	}),
};
{
	mount(staleProps);
	await settle();
	const staleTree = render(staleProps);
	const staleChip = findByLabel(staleTree, "工具");
	const staleText = textOf(staleChip ?? []).join("");
	check(staleText === "5", `a remembered reading must still show its number, saw ${JSON.stringify(staleText)}`);
	check(
		(markTitle(staleTree, "工具") ?? "").includes("上次活跃时"),
		"the tooltip must say the number is a past reading, not a current one",
	);
	check(
		(markTitle(staleTree, "工具") ?? "").includes("42 分钟前"),
		`the tooltip must say how old it is, saw ${JSON.stringify(markTitle(staleTree, "工具"))}`,
	);
	check(
		!(markTitle(staleTree, "工具") ?? "").includes("暂无活跃 agent"),
		"a remembered reading must not be reported as having no data at all",
	);
	const openStale = findButton(staleTree, "明细");
	if (openStale) openStale.props.onClick();
	await flush();
	const stalePanel = textOf(render(staleProps));
	check(has(stalePanel, "上次活跃时"), "the panel heading must date the reading");
	check(
		has(stalePanel, "不是现在的部署注册表"),
		"the panel must say what the remembered list is NOT, so it is never mistaken for the catalog",
	);
}

// --- Every chip state answers only for what it knows ----------------------
// "pending", "unreadable" and "no active agent" are different facts. Folding any of
// them into another is how the strip claimed a session had no agent before it had
// asked, or printed a deployment number where a session number belonged.
const chipState = (props) => ({
	title: markTitle(render(props), "工具") ?? "",
	digits: textOf(findByLabel(render(props), "工具") ?? []).join(""),
});
{
	// pending: nothing has been read yet.
	// A fresh mount, not `render(okProps)`: the harness keeps the last payload on the
	// mounted instance, so re-rendering would show the previous case's answer.
	const pendingTree = mount(okProps);
	const pending = { title: markTitle(pendingTree, "工具") ?? "", digits: textOf(findByLabel(pendingTree, "工具") ?? []).join("") };
	check(pending.title.includes("读取中"), `pending must say 读取中, saw ${JSON.stringify(pending.title)}`);

	// unreadable: an answer arrived but carries no tools block at all.
	const noToolsProps = { sessionId: "s-notools", load: async () => ({ skills: payloadOk.skills }) };
	mount(noToolsProps);
	await settle();
	const unreadable = chipState(noToolsProps);
	check(
		unreadable.title.includes("读取失败"),
		`a payload without a tools block must read as a failure, saw ${JSON.stringify(unreadable.title)}`,
	);
	check(!/\d/.test(unreadable.digits), "an unreadable tools block must not print a count");

	// ready: the session's own count, stated in the tooltip.
	mount(okProps);
	await settle();
	const ready = chipState(okProps);
	check(ready.digits === "5", `a ready chip must print the total, saw ${JSON.stringify(ready.digits)}`);
	check(ready.title.includes("本会话 agent"), "a ready chip must say whose number it is");
}

// --- MCP must hold the same line as the tools mark ------------------------
// The tools mark refuses to present a deployment or remembered number as current.
// The MCP mark reads the same payload, so it must obey the same rule: a non-current
// answer may not print a green count (that is what made a deployment number look
// like this session's connection state) and may not raise a fault.
const chipTitleOf = (props) => markTitle(render(props), "MCP") ?? "";
const chipTextOf = (props) => textOf(findByLabel(render(props), "MCP") ?? []).join("");
{
	// A deployment-catalog answer that DOES carry MCP tools.
	const globalWithServers = { ...payloadOk, tools: { ...payloadOk.tools, scope: "global" } };
	const globalMcpProps = { sessionId: "s-gmcp", load: async () => globalWithServers };
	mount(globalMcpProps);
	await settle();
	check(
		!/\d/.test(chipTextOf(globalMcpProps)),
		`a deployment-scope MCP answer must not print a count as this session's, saw ${JSON.stringify(chipTextOf(globalMcpProps))}`,
	);
	check(
		chipTitleOf(globalMcpProps).includes("部署级"),
		"a deployment-scope MCP answer must say which view it is",
	);

	// A remembered answer with MCP tools: this session's own numbers, but from before.
	const staleWithServers = {
		...payloadOk,
		tools: { ...payloadOk.tools, scope: "agent", stale: true, recordedAt },
	};
	const staleMcpProps = { sessionId: "s-smcp", load: async () => staleWithServers };
	mount(staleMcpProps);
	await settle();
	check(
		!/\d/.test(chipTextOf(staleMcpProps)),
		"a remembered MCP answer must not print a live-looking count",
	);
	check(
		chipTitleOf(staleMcpProps).includes("上次活跃时"),
		"a remembered MCP answer must say it is a past reading",
	);
}

console.log("---");
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log("  - " + p);
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
