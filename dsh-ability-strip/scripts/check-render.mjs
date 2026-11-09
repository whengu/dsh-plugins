// Drive the dock component with synthetic Remote answers and assert the tree it
// builds. This executes the component function, not the browser: it verifies the
// render logic (chips, sections, failure copy) without any live page.
//
// Each case is a FRESH MOUNT: hook storage is reset per case so state cannot leak
// between scenarios.
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
/** Package root: this script lives in <root>/scripts. */
const pkgDir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(pkgDir, "lib/client.js"), "utf8");

// A minimal DOM surface: the bundle reads `document.body` as the portal target,
// measures the anchor row, and watches visibility. All are stubbed so the
// component can be executed without a browser; nothing here renders.
const BODY = { nodeType: 1, tagName: "BODY" };
const documentListeners = [];
globalThis.document = {
  body: BODY,
  // The strip reads only while the tab is visible.
  visibilityState: "visible",
  addEventListener(type, listener) {
    documentListeners.push({ type, listener });
  },
  removeEventListener(type, listener) {
    const at = documentListeners.findIndex((e) => e.type === type && e.listener === listener);
    if (at >= 0) documentListeners.splice(at, 1);
  },
};
// Intervals are CAPTURED, never scheduled: this is the tripwire that proves the
// strip no longer runs one. A change stream replaced the 15 s poll, so any entry
// here is a regression, and case 7 fails on the spot.
const timers = [];
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};
// `EventSource` is the push channel. Captured rather than connected: the checks
// drive frames directly and would otherwise hold a live connection open.
const sources = [];
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this.closed = false;
    this.listeners = new Map();
    sources.push(this);
  }
  addEventListener(type, listener) {
    const bucket = this.listeners.get(type);
    if (bucket === undefined) this.listeners.set(type, [listener]);
    else bucket.push(listener);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
    this.closed = true;
  }
  /**
   * Deliver one event. `open` moves the source to OPEN the way the real one does;
   * every other type leaves `readyState` alone, so a check can stage a transient
   * drop (CONNECTING) and a fatal one (CLOSED) before firing `error`.
   */
  emit(type, data) {
    if (type === "open") this.readyState = FakeEventSource.OPEN;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data, type });
  }
}
globalThis.EventSource = FakeEventSource;
globalThis.window = {
  __ModuleLoader__: { load(r) { globalThis.__reg = r; } },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
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
  const resolved = flat.length === 0
    ? base
    : { ...base, children: flat.length === 1 ? flat[0] : flat };
  return { type, props: resolved, children: flat };
};

// --- hook runtime ---------------------------------------------------------
let hookState = [];
let hookIndex = 0;
let effects = [];
let cleanups = [];

const React = {
  createElement,
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
    const set = (next) => {
      hookState[i] = typeof next === "function" ? next(hookState[i]) : next;
    };
    return [hookState[i], set];
  },
  useRef(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = { current: initial };
    return hookState[i];
  },
  useCallback(fn) {
    hookIndex++;
    return fn;
  },
  // Recompute every render: the stub has no dependency tracking, and the checks
  // only care about the value, not about referential stability.
  useMemo(fn) {
    hookIndex++;
    return fn();
  },
  useEffect(fn) {
    hookIndex++;
    effects.push(fn);
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

/** Fresh mount: clears hook storage so no state leaks between cases. */
function mount(props) {
  hookState = [];
  hookIndex = 0;
  effects = [];
  cleanups = [];
  return render(props);
}

/** Re-render the current mount (keeps state, re-runs the component). */
function render(props) {
  hookIndex = 0;
  effects = [];
  return Component(props);
}

/** Flush effects of the current mount, recording any cleanup they return. */
async function settle() {
  const pending = [...effects];
  for (const fn of pending) {
    const cleanup = await fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  await new Promise((r) => setImmediate(r));
}

/** Run the mount's recorded effect cleanups (what React does on unmount). */
async function unmount() {
  const pending = cleanups.reverse();
  cleanups = [];
  for (const fn of pending) await fn();
}

/** Let a microtask-queued read enter the stub's `load`. */
const flush = () => new Promise((r) => setImmediate(r));

/** Fire `visibilitychange` on the listeners the current mount registered. */
const fireVisibility = () => {
  for (const entry of [...documentListeners]) {
    if (entry.type === "visibilitychange") entry.listener();
  }
};

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
      out = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
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
      out = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
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
      produced = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
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
      out = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
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
      out = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
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
    scope: "global",
  },
};
const okProps = { sessionId: "s1", load: async () => payloadOk };
const disconnectedProps = { sessionId: "s1", load: async () => payloadDisconnected };

// --- Case 1: first paint, nothing read yet --------------------------------
let tree = mount(okProps);
log("case1 (first paint)", tree);
let text = textOf(tree);
// The marks are icons only now: the dock is a shared row and every label cost the
// width the numbers needed. Meaning survives through the glyph and an accessible
// name, so that is what is pinned — plus the flat ban on word labels below.
check(findByLabel(tree, "技能") !== undefined, "the skill mark must carry an accessible name");
check(findByLabel(tree, "MCP") !== undefined, "the MCP mark must carry an accessible name");
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
check(mcpStateOf(render(emptyProps)).includes("未连接"), "an empty successful read must read 未连接");
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
check(mcpStateOf(render(disabledProps)).includes("未连接"), "a disabled MCP row reads 未连接, not a fault");

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
check(text.includes("…"), "a thrown load leaves the counts unknown, not zero");

// --- Case 7: no timer, one change stream ----------------------------------
// This is the mechanism upgrade, stated as a check: the strip used to re-read the
// Host on a permanent page-side interval every 15 s whether or not anything had
// changed. There must now be no interval at all — in any state — and one open
// change stream instead.
let loadCount = 0;
const countingProps = {
  sessionId: "s7",
  load: async () => {
    loadCount += 1;
    return payloadOk;
  },
};
const sourcesBefore = sources.length;
mount(countingProps);
await settle();
check(timers.length === 0, `the strip must not register an interval, saw ${timers.length}`);
check(sources.length === sourcesBefore + 1, "the strip must open exactly one change stream");
const stream = sources[sources.length - 1];
// Document-relative (no leading slash: routes resolve below the app's base path),
// and written out rather than derived — the host half pins the same literal, so a
// rename on either side fails a check instead of silently never connecting.
const EVENTS_WIRE_PATH = "api/ability-strip/events";
check(
  stream.url === EVENTS_WIRE_PATH,
  `the stream must open the host half's own route, saw ${stream.url}`,
);
check(stream.closed === false, "the stream must stay open while the strip is mounted");
check(loadCount === 1, `mounting must read once, saw ${loadCount}`);

// --- Case 7a: a hidden tab must not spend a read on a frame ---------------
let beforeHidden = loadCount;
globalThis.document.visibilityState = "hidden";
stream.emit("message", '{"version":2}');
await flush();
check(loadCount === beforeHidden, "a hidden tab must not spend a read on a frame");
// Coming back must pick up what was dropped while hidden.
globalThis.document.visibilityState = "visible";
fireVisibility();
await flush();
check(loadCount > beforeHidden, "returning to the tab must read what a hidden tab skipped");
// A visible tab re-reads on the frame that reports a change.
beforeHidden = loadCount;
stream.emit("message", '{"version":3}');
await flush();
check(loadCount > beforeHidden, "a visible tab must re-read when the registry changes");

// --- Case 7b: a dead stream is stated, and costs exactly one read ---------
// An `EventSource` that fails can stop for good (a fatal status is never retried),
// and then nothing would ever push again: the row would freeze at its last numbers
// and read exactly like "nothing changed" — the blind spot this plugin exists to
// remove, moved into its own transport. So an error must re-read once, be visible,
// and must not turn every retry into another read.
let errReads = 0;
const errProps = {
  sessionId: "s7b",
  load: async () => {
    errReads += 1;
    return payloadOk;
  },
};
mount(errProps);
await settle();
const errStream = sources[sources.length - 1];
check(sources.length > 0, "case 7b must open a stream");
check(
  findByLabel(render(errProps), "变更推送已断开") === undefined,
  "a live stream must not claim the push is down",
);
const readsBeforeError = errReads;
// A transient drop: `EventSource` will retry on its own (readyState stays CONNECTING).
errStream.readyState = FakeEventSource.CONNECTING;
errStream.emit("error");
await flush();
check(
  errReads === readsBeforeError + 1,
  `the first error must re-read exactly once, saw ${errReads} (before ${readsBeforeError})`,
);
check(
  findByLabel(render(errProps), "变更推送已断开") !== undefined,
  "an error must be visible on the collapsed row",
);
// A retry that fails again must NOT read again: one outage, one read.
errStream.emit("error");
await flush();
check(errReads === readsBeforeError + 1, `a repeated error must not re-read, saw ${errReads}`);
// The detail panel states it in words, not just as an 11 px mark.
const expand7b = findButton(render(errProps), "明细");
if (expand7b) expand7b.props.onClick();
await flush();
check(
  has(textOf(render(errProps)), "变更推送已断开：下面这些数字不会再自动更新"),
  "the detail panel must state that the pushed numbers stopped updating",
);
// Coming back re-arms the one-shot read and clears the mark.
errStream.emit("open");
await flush();
check(
  findByLabel(render(errProps), "变更推送已断开") === undefined,
  "a reopened stream must clear the mark",
);
const readsBeforeSecondOutage = errReads;
errStream.readyState = FakeEventSource.CLOSED;
errStream.emit("error");
await flush();
check(
  errReads === readsBeforeSecondOutage + 1,
  `a second outage must re-read again, saw ${errReads} (before ${readsBeforeSecondOutage})`,
);

// --- Case 7c: coming back revives a stream that stopped for good ----------
// Without this the row would stay stale until a page reload, and doing it with a
// timer would reintroduce exactly what this design removed. Every other stub
// source in this file is still CONNECTING or OPEN, so the closed one is the only
// one that reopens and the count is exact.
const reopenBefore = sources.length;
globalThis.document.visibilityState = "visible";
errStream.readyState = FakeEventSource.CLOSED;
fireVisibility();
await flush();
check(
  sources.length === reopenBefore + 1,
  `a closed stream must be reopened when the reader comes back, saw ${sources.length} (before ${reopenBefore})`,
);
check(
  sources[sources.length - 1].url === EVENTS_WIRE_PATH,
  "a reopened stream must use the same route",
);
// Coming back with the stream still open must NOT open a second one: that would
// leak a connection per tab switch.
const noDuplicateBefore = sources.length;
const liveAgain = sources[sources.length - 1];
liveAgain.emit("open");
fireVisibility();
await flush();
check(
  sources.length === noDuplicateBefore,
  `coming back with a live stream must not open another, saw ${sources.length} (before ${noDuplicateBefore})`,
);

// --- Case 8: an unchanged frame must not re-render ------------------------
// The same answer arriving again must not reach setState with a NEW object: that
// would rebuild the row and repaint for nothing. A change stream can deliver
// several frames for one visible change, so this suppression is what keeps a burst
// from becoming a burst of repaints. The stub's setState does not re-render, so
// what is counted is the state object identity — a fresh object is exactly the
// re-render React would schedule.
const stablePayload = { ...payloadOk };
const stableProps = { sessionId: "s8", load: async () => stablePayload };
mount(stableProps);
await settle();
const stateSlot8 = hookState[1];
check(stateSlot8?.phase === "ready", "case 8 must have read once before the frame");
const payloadBefore = stateSlot8.payload;
sources[sources.length - 1].emit("message", '{"version":4}');
await flush();
const stateAfterIdenticalFrame = hookState[1];
check(
  stateAfterIdenticalFrame === stateSlot8,
  "a frame carrying an unchanged answer must keep the same state object (no re-render)",
);
check(
  stateAfterIdenticalFrame.payload === payloadBefore,
  "a frame carrying an unchanged answer must keep the same payload reference",
);

// A changed answer MUST produce a new state: suppression must not swallow news.
let flipped = false;
const changingProps = {
  sessionId: "s9",
  load: async () => (flipped ? { ...payloadOk, tools: { servers: [], totalTools: 0 } } : { ...payloadOk }),
};
mount(changingProps);
await settle();
const stateSlot9 = hookState[1];
flipped = true;
sources[sources.length - 1].emit("message", '{"version":5}');
await flush();
check(hookState[1] !== stateSlot9, "a frame carrying a changed answer must produce new state (re-render)");
check(
  (hookState[1].payload?.tools?.servers ?? []).length === 0,
  "a changed frame must show the new answer",
);

// --- Case 10: a slow read must not stack requests -------------------------
// Without the in-flight guard, a frame arriving while a read is still pending would
// ask the Host again, piling up work against a Host that is already struggling.
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
// Flush the effects so the stream is open and the mount read is STARTED. The read
// itself stays pending on the gate, which is the state under test.
for (const fn of [...effects]) await fn();
await flush();
const callsBeforeFrames = slowCalls;
check(callsBeforeFrames >= 1, "the mount read must have started");
// Three frames while the first read is still pending.
const stream10 = sources[sources.length - 1];
stream10.emit("message", '{"version":6}');
stream10.emit("message", '{"version":7}');
stream10.emit("message", '{"version":8}');
await flush();
check(
  slowCalls === callsBeforeFrames,
  `frames during an in-flight read must not start another (saw ${slowCalls}, before ${callsBeforeFrames})`,
);
// Releasing the gate lets the pending read finish; the dropped frames collapse into
// ONE compensating read, not one per frame.
release();
await flush();
check(
  slowCalls === callsBeforeFrames + 1,
  `a burst of frames during a read must collapse into one compensating read, saw ${slowCalls} (before ${callsBeforeFrames})`,
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

// --- Case 12: unmounting closes the stream --------------------------------
// A closed row must not leave an open HTTP response (and its subscriber) behind.
mount(okProps);
await settle();
const stream12 = sources[sources.length - 1];
const visibilityBefore = documentListeners.filter((e) => e.type === "visibilitychange").length;
check(stream12.closed === false, "case 12 must open a stream before unmounting");
await unmount();
check(stream12.closed === true, "unmounting must close the change stream");
check(
  documentListeners.filter((e) => e.type === "visibilitychange").length < visibilityBefore,
  "unmounting must drop the visibility listener",
);

// --- The mechanism, stated once more over every case above ----------------
// Any of the mounts above reintroducing a self-refresh timer fails here, whatever
// it was for.
check(timers.length === 0, `no mount may register an interval, saw ${timers.length}`);

console.log("---");
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log("  - " + p);
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
