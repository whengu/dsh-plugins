/**
 * dsh-ability-strip — browser half.
 *
 * A thin strip docked under the composer, inside the input bar's own dock. It
 * answers one question: *what does THIS session actually have available?* — as
 * three marks that never merge:
 *
 *   - **skill**  how many human-invocable skills this session sees (`skills/list`)
 *   - **MCP**    whether any MCP server actually connected, judged by whether
 *                `mcp__<server>__*` tools are registered in the live tool registry
 *                (read via this package's own host half over `/api/ability-strip`)
 *   - **tools**  how many tools the model is offered in total, MCP included. The
 *                host reads `tools.schemas(agent)` for this session, so the count
 *                and the listed names carry the same restrictions a model step sees.
 *
 * The detail panel floats above the page (portalled, fixed) and lists the skills,
 * the connected MCP servers with tool counts, the non-MCP tool names, the
 * configured Loader rows, and the profile's enabled bundles. A fault (MCP enabled
 * but zero tools) opens a dialog on its own.
 *
 * Read-only by construction: it calls three read-only Remotes and reads its own
 * host half (the single POST route serving the tool registry summary). It registers
 * no tool, writes no setting, and changes no content. Nothing here runs on a timer
 * and no connection is held open: the strip reads when it mounts, when the session
 * changes, when the panel opens, and when the reader presses refresh.
 *
 * Lazy-CJS bundle form: executing this script only registers the factory;
 * every module-body side effect lives inside it.
 */
window.__ModuleLoader__.load({
	id: "dsh-ability-strip",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;

		/**
		 * Local UI kit — no Harness Client package is loaded.
		 *
		 * DSH's own guidance for plugin authors (`references/practices.md` in the
		 * shipped `cordis-plugin-development` skill) is explicit: a plugin must not
		 * `require("@deepseek-ai/dsh-client-ui-primitives")`. Those packages change
		 * without notice, a plain-JS plugin gets no type check, and a component that
		 * throws blanks the whole slot entry. The guidance says to write the
		 * controls here instead — copy the markup, CSS, and behaviour, and keep only
		 * `--dsw-alias-*` theme tokens — which is what this section is.
		 *
		 * The tokens are the only styling contract. Every name below was read from a
		 * live page: they resolve on `<body>` and inherit down into the composer
		 * dock, so a theme switch repaints these controls with everything else.
		 * Nothing here depends on a host class name, so a host restyle cannot move
		 * this strip's layout.
		 */
		const TOKEN = {
			warn: "var(--dsw-alias-state-warn-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			success: "var(--dsw-alias-state-success-primary)",
			label: "var(--dsw-alias-label-primary)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary)",
			surface: "var(--dsw-alias-bg-layer-1)",
			surfaceBase: "var(--dsw-alias-bg-base)",
			mask: "var(--dsw-alias-bg-mask-1)",
			border: "var(--dsw-alias-border-l2)",
			primaryFill: "var(--dsw-alias-button-primary-fill)",
		};

		/**
		 * One 16x16 outline icon: a single stroked path, so it needs no stylesheet
		 * and no font. `currentColor` keeps it on the text colour it sits in, and
		 * `vectorEffect: non-scaling-stroke` keeps the stroke even at the 11-13 px
		 * sizes the strip uses. Purely decorative, hence `aria-hidden`.
		 * @param props.size - rendered edge length in px.
		 * @param props.d - path data in the 16x16 viewBox.
		 * @param props.spin - draws a rotating arc instead (a loading mark).
		 * @param props.style - colour overrides, merged over the defaults.
		 */
		function Icon({ size = 16, d, spin = false, style, ...rest }) {
			return h(
				"svg",
				{
					...rest,
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
					focusable: false,
					style: { flex: "0 0 auto", display: "block", overflow: "visible", ...style },
				},
				h("path", {
					d,
					vectorEffect: "non-scaling-stroke",
				}, spin
					? h("animateTransform", {
							attributeName: "transform",
							type: "rotate",
							from: "0 8 8",
							to: "360 8 8",
							dur: "0.9s",
							repeatCount: "indefinite",
						})
					: null),
			);
		}

		/* 16x16 outline geometry, one path each. */
		const PATH = {
			check: "M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9M5.2 8.2l2 2 3.6-3.9",
			clock: "M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9M8 4.6V8l2.5 1.5",
			close: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6",
			plugin: "M4.2 5.9h7.6v5.3H4.2zM6.1 5.9V3.4M9.9 5.9V3.4M8 11.2v1.9",
			globe: "M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9M1.9 8h12.2M8 1.9c1.9 1.9 1.9 10.3 0 12.2M8 1.9c-1.9 1.9-1.9 10.3 0 12.2",
			loading: "M8 1.9a6.1 6.1 0 0 1 6.1 6.1",
			pause: "M6.1 4.2v7.6M9.9 4.2v7.6",
			refresh: "M13.2 8A5.2 5.2 0 1 1 11.5 4M13.2 2.9v3.3h-3.3",
			skill: "M8 2.1l1.6 4.3 4.3 1.6-4.3 1.6L8 13.9 6.4 9.6 2.1 8l4.3-1.6z",
			warn: "M8 2.3l5.5 9.7H2.5zM8 6.1v2.9M8 10.6v.7",
			tools: "M11.3 2.4a3 3 0 0 0-3.7 3.8L2.9 10.9a1.4 1.4 0 1 0 2 2l4.7-4.7a3 3 0 0 0 3.8-3.7l-1.8 1.8-1.7-.4-.4-1.7z",
			// "We could not read this" — deliberately a different shape from `warn`.
			// The two used to share the warning triangle, which made a failed read
			// indistinguishable from a configured-but-broken MCP deployment once the
			// collapsed row stopped printing words.
			unknown: "M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9M6.4 6.4a1.6 1.6 0 1 1 2.1 1.5c-.5.2-.7.6-.7 1.1v.3M8 11.4v.5",
		};

		/* Named components keep the call sites readable. */
		const IconCheckCircleOutlineRegular = (p) => h(Icon, { ...p, d: PATH.check });
		const IconClockOutlineRegular = (p) => h(Icon, { ...p, d: PATH.clock });
		const IconCloseOutlineRegular = (p) => h(Icon, { ...p, d: PATH.close });
		const IconCordisPluginOutlineRegular = (p) => h(Icon, { ...p, d: PATH.plugin });
		const IconGlobeOutlineRegular = (p) => h(Icon, { ...p, d: PATH.globe });
		const IconLoadingOutlineRegular = (p) => h(Icon, { ...p, d: PATH.loading, spin: true });
		const IconPauseOutlineRegular = (p) => h(Icon, { ...p, d: PATH.pause });
		const IconRefreshOutlineRegular = (p) => h(Icon, { ...p, d: PATH.refresh });
		const IconSkillOutlineRegular = (p) => h(Icon, { ...p, d: PATH.skill });
		const IconWarningOutlineRegular = (p) => h(Icon, { ...p, d: PATH.warn });
		const IconUnknownOutlineRegular = (p) => h(Icon, { ...p, d: PATH.unknown });
		const IconToolOutlineRegular = (p) => h(Icon, { ...p, d: PATH.tools });

		/** Tone palette for {@link Tag}: the host's state colours, nothing else. */
		const TAG_TONE = {
			neutral: { color: TOKEN.labelSecondary, border: TOKEN.border },
			quiet: { color: TOKEN.labelTertiary, border: TOKEN.border },
			success: { color: TOKEN.success, border: TOKEN.success },
			danger: { color: TOKEN.error, border: TOKEN.error },
		};

		/**
		 * A small state pill.
		 * @param props.tone - `neutral` | `quiet` | `success` | `danger`.
		 * @param props.children - the label.
		 */
		function Tag({ tone = "neutral", children }) {
			const palette = TAG_TONE[tone] ?? TAG_TONE.neutral;
			return h("span", {
				style: {
					fontSize: 10.5,
					lineHeight: 1.5,
					padding: "0 6px",
					borderRadius: 999,
					border: `1px solid ${palette.border}`,
					color: palette.color,
					whiteSpace: "nowrap",
					fontVariantNumeric: "tabular-nums",
					flex: "0 0 auto",
				},
			}, children);
		}

		/** Variant palette for {@link Button}. */
		const BUTTON_VARIANT = {
			primary: { background: TOKEN.primaryFill, color: TOKEN.surfaceBase, border: "1px solid transparent" },
			ghost: { background: "transparent", color: TOKEN.labelSecondary, border: "1px solid transparent" },
		};

		/**
		 * A real `<button>`, so keyboard activation, focus rings, and `disabled`
		 * come from the browser rather than from re-implemented semantics. Every
		 * prop other than `variant`/`size`/`style` lands on the DOM node, which is
		 * how `aria-label`, `title`, `onClick`, and `disabled` reach it.
		 * @param props.variant - `primary` | `ghost`.
		 * @param props.size - `sm` | `md`.
		 */
		function Button({ variant = "ghost", size = "md", style, children, ...rest }) {
			const palette = BUTTON_VARIANT[variant] ?? BUTTON_VARIANT.ghost;
			return h("button", {
				type: "button",
				...rest,
				style: {
					...palette,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 4,
					font: "inherit",
					fontSize: size === "sm" ? 11.5 : 12.5,
					padding: size === "sm" ? "2px 6px" : "5px 11px",
					borderRadius: 6,
					cursor: rest.disabled === true ? "default" : "pointer",
					opacity: rest.disabled === true ? 0.5 : 1,
					...style,
				},
			}, children);
		}

		/**
		 * A modal dialog: portalled to `<body>`, `aria-modal`, Escape to close,
		 * backdrop click to close, focus moved in and restored on close, and Tab
		 * kept inside. Written here rather than imported for the reason in the kit
		 * header; the behaviour is deliberately the same as the host's modal so the
		 * plugin feels like part of the application.
		 *
		 * The `[role="dialog"][aria-modal]` marker matters beyond accessibility: the
		 * detail panel's own Escape and outside-click handlers look for it to avoid
		 * reacting to keys and clicks that belong to this dialog.
		 * @param props.open - renders nothing unless exactly `true`.
		 * @param props.onClose - invoked by Escape, the close button, or the backdrop.
		 * @param props.title - dialog heading and accessible name.
		 * @param props.closeLabel - accessible label for the close button.
		 * @param props.footer - optional action row.
		 */
		function Modal({ open, onClose, title, closeLabel = "关闭", footer, children }) {
			const dialogRef = React.useRef(null);
			const returnTo = React.useRef(null);

			React.useEffect(() => {
				if (open !== true) return void 0;
				returnTo.current = document.activeElement;
				const dialog = dialogRef.current;
				dialog?.focus();
				return () => {
					const previous = returnTo.current;
					if (previous !== null && typeof previous?.focus === "function") previous.focus();
				};
			}, [open]);

			React.useEffect(() => {
				if (open !== true) return void 0;
				/**
				 * Capture phase, and the event is consumed: a dialog owns the keyboard
				 * while it is open, so neither the panel behind it nor the page reacts.
				 */
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose?.();
						return;
					}
					if (event.key !== "Tab") return;
					const dialog = dialogRef.current;
					if (dialog === null) return;
					const focusable = dialog.querySelectorAll(
						'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
					);
					if (focusable.length === 0) return;
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					const active = document.activeElement;
					if (event.shiftKey && (active === first || active === dialog)) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && active === last) {
						event.preventDefault();
						first.focus();
					}
				};
				document.addEventListener("keydown", onKey, true);
				return () => document.removeEventListener("keydown", onKey, true);
			}, [open, onClose]);

			if (open !== true) return null;

			return ReactDOM.createPortal(
				h(
					"div",
					{
						style: {
							position: "fixed",
							inset: 0,
							background: TOKEN.mask,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							padding: 16,
							zIndex: 2147483000,
						},
						onMouseDown: (event) => {
							if (event.target === event.currentTarget) onClose?.();
						},
					},
					h(
						"div",
						{
							ref: dialogRef,
							role: "dialog",
							"aria-modal": "true",
							"aria-label": title,
							tabIndex: -1,
							style: {
								background: TOKEN.surface,
								color: TOKEN.label,
								border: `1px solid ${TOKEN.border}`,
								borderRadius: 10,
								boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
								padding: 14,
								width: "100%",
								maxWidth: 460,
								display: "flex",
								flexDirection: "column",
								gap: 10,
								outline: "none",
							},
						},
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 8 } },
							h("span", { style: { fontSize: 13, fontWeight: 600 } }, title),
							h(
								Button,
								{
									variant: "ghost",
									size: "sm",
									style: { marginLeft: "auto" },
									onClick: onClose,
									"aria-label": closeLabel,
									title: closeLabel,
								},
								h(IconCloseOutlineRegular, { size: 12 }),
							),
						),
						h("div", { style: { fontSize: 12.5, lineHeight: 1.6 } }, children),
						footer === void 0
							? null
							: h(
									"div",
									{ style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
									footer,
								),
					),
				),
				document.body,
			);
		}

		/* The kit's public surface, assembled where the host import used to be. */
		const ui = {
			Button,
			Tag,
			Modal,
			IconCheckCircleOutlineRegular,
			IconClockOutlineRegular,
			IconCloseOutlineRegular,
			IconCordisPluginOutlineRegular,
			IconGlobeOutlineRegular,
			IconLoadingOutlineRegular,
			IconPauseOutlineRegular,
			IconRefreshOutlineRegular,
			IconSkillOutlineRegular,
			IconWarningOutlineRegular,
			IconUnknownOutlineRegular,
			IconToolOutlineRegular,
		};

		/**
		 * Cordis services this plugin waits for. Cordis gates every service read
		 * behind a declared name, so each Remote namespace the strip reads is
		 * listed here beside the base `remote` service. `sessions` is absent on
		 * purpose: the session id arrives as a built-in standard prop of the
		 * session-scoped dock slot, so the sessions service is never read and
		 * declaring it would only delay activation behind an unused service.
		 */
		const inject = [
			"slots",
			"remote",
			"remote.skills",
			"remote.pluginInventory",
			"remote.pluginManager",
			// The Connection carrier: how this half reaches its own host half to read
			// the tool registry, which no browser Remote exposes.
			"connection",
		];

		/** MCP client module specifier; a Loader row naming it is one MCP server. */
		const MCP_MODULE = "@deepseek-ai/dsh-mcp-client";

		/**
		 * MCP resource plugin. Shipped profiles mount it once for all servers, so it
		 * is NOT a server row: it never joins the server list, but its presence is
		 * still worth stating, because without it a configured server exposes tools
		 * and no readable resources.
		 */
		const MCP_RESOURCES_MODULE = "@deepseek-ai/dsh-mcp-resources";

		/**
		 * Carrier channel both halves use: the shared `/api` route the client
		 * `Connection` mounts. The leading slash is load-bearing — see
		 * same slice is applied here deliberately, not for symmetry. See `readTools`.
		 */
		const API_CHANNEL = "/api";

		/**
		 * Endpoint this package's host half owns inside the shared `/api` channel.
		 * Must stay identical to `ROUTE_ENDPOINT` in `lib/index.js`: the host
		 * registers `path: /api/<endpoint>` and `rpc.call` posts to the same pair.
		 */
		const TOOL_ENDPOINT = "ability-strip";


		/** Muted inline text for a pending or absent answer. */
		/**
 * Render a timestamp for a remembered reading.
 *
 * A remembered answer is only useful if the reader can judge how old it is, so the
 * time is shown next to it rather than hidden. Anything unparseable degrades to
 * "时间未知" instead of "Invalid Date".
 * @param iso - ISO timestamp from the host, or undefined.
 * @returns a short local string.
 */
function formatWhen(iso) {
	const at = typeof iso === "string" ? new Date(iso) : void 0;
	if (at === void 0 || Number.isNaN(at.getTime())) return "时间未知";
	const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return at.toLocaleString();
}

/**
 * The tools heading's state word.
 *
 * Kept as a function rather than a nested ternary in the tree: five states nested
 * four deep is where the wrong branch gets picked, and this one decides whether the
 * reader is looking at now or at the past.
 * @param tools - the payload's tools block, or undefined.
 * @param failed - whether the tools read reported an error.
 * @returns the note text, or an empty string when it must be omitted.
 */
function toolsNote(tools, failed) {
	if (failed) return "读取失败";
	if (tools === void 0) return "";
	if (tools.stale === true) return `上次活跃时 · ${formatWhen(tools.recordedAt)}`;
	if (tools.scope === "agent") return "注册表 · 本会话 agent 视图";
	return "无活跃 agent · 部署注册表";
}

const MUTED = { fontSize: 11, opacity: 0.55 };

// Host reads must end. A Host that never answers (a wedged route, a hung fetch)
// must not leave the strip refusing every refresh forever: the read is cancelled
// past this ceiling and reported as a timeout instead.
const READ_TIMEOUT_MS = 20000;

/**
 * Where the floating detail panel goes, for one anchor rect and one viewport.
 *
 * Pure on purpose: this is the only part of the panel with branches (above or
 * below, and how tall), and a pure function is the only form of it that can be
 * reasoned about — and asserted — without a layout engine.
 *
 * It opens upward by default, because the anchor is a composer row near the bottom
 * of the screen. When the anchor sits so high that there is no room above, it flips
 * downward: a panel whose header (refresh/close) is pushed off screen is a dead
 * control, and clamping the height while keeping the top negative does exactly that.
 * @param rect - the anchor's viewport rect (`top`, `left`, `width`, `bottom`).
 * @param viewport - `{ width, height }` of the window.
 * @returns a `position: fixed` style fragment: `bottom` when opening upward, `top`
 *   when opening downward, plus `left`, `width`, and `maxHeight`.
 */
function computePlacement(rect, viewport) {
	const width = Math.min(480, viewport.width - 24);
	const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, viewport.width - width - 12));
	const headSpace = rect.top - 18; // room for the panel header above the anchor
	const floorSpace = viewport.height - rect.bottom - 8; // room below
	const clamp = (space) => Math.max(120, Math.min(viewport.height * 0.6, 420, space));
	if (headSpace >= 120 || headSpace >= floorSpace) {
		return { left, width, maxHeight: clamp(headSpace), bottom: viewport.height - rect.top + 6 };
	}
	return { left, width, maxHeight: clamp(floorSpace), top: rect.bottom + 8 };
}

		/** The skill count: tabular figures so the width does not jitter per value. */
		const COUNT = { fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 10 };
		/**
		 * Layout for one collapsed mark: icon, then a number or a state glyph.
		 *
		 * The row carries no word labels on purpose. The dock is a shared flex row
		 * with other widgets, so every label cost width the numbers needed; each mark
		 * is now identified by its own glyph (sparkle / globe / wrench) plus an
		 * `aria-label` and a tooltip, so the meaning survives without the text.
		 */
		const CHIP = { display: "flex", alignItems: "center", gap: 3, minWidth: 0, flex: "0 0 auto" };

		/**
		 * Hairline divider drawn from the inherited text color, so it follows the
		 * theme. The vertical form takes an explicit height instead of stretching:
		 * a stretching divider would be as tall as the tallest sibling line.
		 */
		function Divider({ vertical }) {
			return h("span", {
				"aria-hidden": true,
				style: vertical
					? { flex: "0 0 auto", width: 1, height: 12, background: "currentColor", opacity: 0.16 }
					: { flex: "0 0 auto", height: 1, width: "100%", background: "currentColor", opacity: 0.16 },
			});
		}

		/**
		 * Copy one thrown value into a short line.
		 * @param error - whatever the call threw.
		 * @returns one-line diagnostic.
		 */
		function describeError(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}

		/**
		 * Compare two payloads by the fields the strip actually renders.
		 *
		 * A silent refresh exists to notice a changed answer, so an identical answer
	 * A silent refresh exists to notice a changed answer, so an identical answer
	 * must not reach `setState`: that would rebuild the row, invalidate the memo,
		 * visible change (a tool registration touches several layers), so this is
	 * The panel is the point of a silent refresh being *silent*: every field it
	 * renders is compared, so the only tolerated identity is a genuinely
	 * unchanged answer.
		 * `loadedAt` is deliberately excluded — it always differs, and suppressing it
		 * means the panel's "读取于" timestamp reflects when the visible content was
		 * actually obtained, not when the last read happened.
		 * @param previous - payload currently on screen, possibly undefined.
		 * @param next - payload just read.
		 * @returns true when nothing the reader sees has changed.
		 */
		function samePayload(previous, next) {
			if (previous === void 0 || next === void 0) return previous === next;
			// Errors are compared by message: a different failure is news.
			// Optional chaining throughout: `loadAll` guarantees these fields, but a
			// defensive read costs nothing and prevents a throw from a malformed payload.
			if (previous.skills?.error !== next.skills?.error) return false;
			if (previous.inventory?.error !== next.inventory?.error) return false;
			if (previous.bundles?.error !== next.bundles?.error) return false;
			if (previous.tools?.error !== next.tools?.error) return false;
			if ((previous.skills?.entries?.length ?? 0) !== (next.skills?.entries?.length ?? 0)) {
				return false;
			}
			// Skill entry content matters too: a rewritten description or a changed
			// `whenToUse` is news the reader should see.
			const prevSkills = previous.skills?.entries ?? [];
			const nextSkills = next.skills?.entries ?? [];
			for (let index = 0; index < prevSkills.length; index += 1) {
				if (prevSkills[index]?.name !== nextSkills[index]?.name) return false;
				if (prevSkills[index]?.description !== nextSkills[index]?.description) return false;
				if (prevSkills[index]?.whenToUse !== nextSkills[index]?.whenToUse) return false;
				if (prevSkills[index]?.modelInvocable !== nextSkills[index]?.modelInvocable) return false;
			}
			// The tools block carries claims the panel prints verbatim: which view
			// answered, whether it is a past reading, the total, and the non-MCP list.
			// Comparing only the server roster swallowed exactly the transitions this
			// version exists to show (live -> stale, global -> agent) whenever the roster
			// stayed equal — which is always true for a profile with no MCP tools, and
			// true here because the host's remembered answer keeps the same servers.
			if (previous.tools?.scope !== next.tools?.scope) return false;
			if (previous.tools?.stale !== next.tools?.stale) return false;
			if (previous.tools?.recordedAt !== next.tools?.recordedAt) return false;
			if ((previous.tools?.totalTools ?? 0) !== (next.tools?.totalTools ?? 0)) return false;
			const prevLocal = previous.tools?.local ?? [];
			const nextLocal = next.tools?.local ?? [];
			if (prevLocal.length !== nextLocal.length) return false;
			for (let index = 0; index < prevLocal.length; index += 1) {
				if (prevLocal[index]?.name !== nextLocal[index]?.name) return false;
				if (prevLocal[index]?.description !== nextLocal[index]?.description) return false;
				// The schema is rendered too, so a silent re-read that changes it must
				// count as news. Comparing only name and description left a stale schema
				// on screen while claiming the answer was unchanged.
				if (prevLocal[index]?.schemaChars !== nextLocal[index]?.schemaChars) return false;
				if (prevLocal[index]?.schema !== nextLocal[index]?.schema) return false;
				if (prevLocal[index]?.schemaTruncated !== nextLocal[index]?.schemaTruncated) return false;
			}
			// MCP is the field that changes in practice: compare the server list, each
			// server's tool count, and each tool by value (two fetches never share
			// objects, so a reference compare would say "changed" every single time).
			const before = previous.tools?.servers ?? [];
			const after = next.tools?.servers ?? [];
			if (before.length !== after.length) return false;
			for (let index = 0; index < before.length; index += 1) {
				if (before[index].server !== after[index].server) return false;
				const prevTools = before[index].tools ?? [];
				const nextTools = after[index].tools ?? [];
				if (prevTools.length !== nextTools.length) return false;
				for (let t = 0; t < prevTools.length; t += 1) {
					if (prevTools[t]?.name !== nextTools[t]?.name) return false;
					if (prevTools[t]?.description !== nextTools[t]?.description) return false;
					// Same three fields as the non-MCP list: one path must not be more
					// forgiving than the other about what counts as a change.
					if (prevTools[t]?.schemaChars !== nextTools[t]?.schemaChars) return false;
					if (prevTools[t]?.schema !== nextTools[t]?.schema) return false;
					if (prevTools[t]?.schemaTruncated !== nextTools[t]?.schemaTruncated) return false;
				}
			}
			// Loader rows: enablement and phase are what the panel prints.
			const prevRows = previous.mcpRows ?? [];
			const nextRows = next.mcpRows ?? [];
			if (prevRows.length !== nextRows.length) return false;
			for (let index = 0; index < prevRows.length; index += 1) {
				if (prevRows[index].entryId !== nextRows[index].entryId) return false;
				if (prevRows[index].enabled !== nextRows[index].enabled) return false;
				if (prevRows[index].fiberPhase !== nextRows[index].fiberPhase) return false;
			}
			if ((previous.mcpResources == null) !== (next.mcpResources == null)) return false;
			if (
				previous.mcpResources != null &&
				next.mcpResources != null
			) {
				if (previous.mcpResources.enabled !== next.mcpResources.enabled) return false;
				if (previous.mcpResources.entryId !== next.mcpResources.entryId) return false;
			}
			const beforeBundles = previous.bundles?.bundles ?? [];
			const afterBundles = next.bundles?.bundles ?? [];
			if (beforeBundles.length !== afterBundles.length) return false;
			for (let index = 0; index < beforeBundles.length; index += 1) {
				if (beforeBundles[index].name !== afterBundles[index].name) return false;
				if (beforeBundles[index].enabled !== afterBundles[index].enabled) return false;
				if (beforeBundles[index].version !== afterBundles[index].version) return false;
				if ((beforeBundles[index].rows?.length ?? 0) !== (afterBundles[index].rows?.length ?? 0)) {
					return false;
				}
			}
			return true;
		}

		/**
		 * Read one session-addressed skill catalog.
		 * @param remote - the client remote service.
		 * @param sessionId - session whose composition selects the catalog view.
		 * @returns the catalog, or a diagnostic instead of a throw.
		 */
		async function readSkills(remote, sessionId) {
			const skills = remote?.skills;
			if (skills === void 0) return { error: "skills Remote 未挂载" };
			try {
				const result = await skills.list({ sessionId });
				if (!result.ok) {
					return { error: `${result.error.code}: ${result.error.message}` };
				}
				return { entries: result.value.skills };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Read the Loader inventory (every non-group entry plus preset rows).
		 * @param remote - the client remote service.
		 * @returns the snapshot, or a diagnostic instead of a throw.
		 */
		async function readInventory(remote) {
			const inventory = remote?.pluginInventory;
			if (inventory === void 0) return { error: "pluginInventory Remote 未挂载" };
			try {
				const result = await inventory.list();
				if (!result.ok) {
					return { error: `${result.error.code}: ${result.error.message}` };
				}
				return { snapshot: result.value };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Read the profile's bundles and the patch rows each one declares.
		 * @param remote - the client remote service.
		 * @returns the bundle list, or a diagnostic instead of a throw.
		 */
		async function readBundles(remote) {
			const manager = remote?.pluginManager;
			if (manager === void 0) return { error: "pluginManager Remote 未挂载" };
			try {
				const result = await manager.listBundles();
				if (!result.ok) {
					return { error: `${result.error.code}: ${result.error.message}` };
				}
				return { bundles: result.value };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Render a Loader entry id the way its patch spells it: the composed tree
		 * prefixes rows with their owning include, which is noise in this list.
		 * @param entryId - composed Loader entry identity.
		 * @returns the row id without a leading `include:` segment.
		 */
		function rowLabel(entryId) {
			const text = String(entryId);
			return text.startsWith("include:") ? text.slice("include:".length) : text;
		}

		/**
		 * Per-row MCP mark. A phase icon replaces a bare status dot: the dot read as
		 * an unlabeled bullet, while these icons carry the same meaning as the
		 * Loader phase vocabulary. This is a LOADER phase, not connection health —
		 * an active row whose server is down still shows the active icon.
		 * @param row - one inventory entry naming the MCP client module.
		 * @returns the icon element for that row.
		 */
		function mcpPhaseIcon(row) {
			const size = 13;
			if (!row.enabled) return h(ui.IconPauseOutlineRegular, { size });
			if (row.fiberPhase === "failed") return h(ui.IconWarningOutlineRegular, { size });
			if (row.fiberPhase === "active") return h(ui.IconCheckCircleOutlineRegular, { size });
			if (row.fiberPhase === "loading") return h(ui.IconLoadingOutlineRegular, { size });
			return h(ui.IconClockOutlineRegular, { size });
		}

		/**
		 * Read the live tool registry from this plugin's own host half.
		 *
		 * The session id is what makes the answer *this* session's: the host
		 * resolves that session's agent and reads `tools.schemas(agent)`, which is
		 * the call the real tool executor makes, so `restrict()` masks and scoped
		 * shadowing are applied exactly as they are for a model step. Without it the
		 * host answers from the global view and labels the payload `scope: "global"`.
		 * @param connection - the client Connection service (host tool route).
		 * @param sessionId - session whose agent defines the viewing scope.
		 * @param signal - optional abort for the underlying `rpc.call`.
		 * @returns the catalog, or a diagnostic instead of a throw.
		 */
		async function readTools(connection, sessionId, signal) {
			if (connection === void 0) return { error: "connection 服务未挂载" };
			try {
				// The same channel/endpoint pair `TOOL_ENDPOINT` names.
				// `rpc.call` composes `${channel}/${endpoint}` and slices the leading
				// slash, so `API_CHANNEL` must keep it: "api" alone becomes "pi/..."
				// and misses the route entirely.
				const response = await connection.rpc.call(API_CHANNEL, TOOL_ENDPOINT, {
					sessionId,
				}, signal);
				if (!response.ok) {
					return { error: `${response.error?.code ?? "unknown"}: ${response.error?.message ?? "连接失败"}` };
				}
				const value = response.value;
				// The host half answers `{ ok, ... }` inside the envelope; a failed
				// registry read arrives here rather than as a transport error.
				if (value?.ok === false) {
					return { error: typeof value.error === "string" ? value.error : "宿主读取工具清单失败" };
				}
				// Shape-validate instead of normalizing into a plausible answer. A null/
				// string/partial value would otherwise become "global, 0 tools, nothing
				// connected" — a perfectly coherent lie about the deployment. Anything
				// unrecognizable is a read failure, never a catalog.
				if (
					value === null ||
					typeof value !== "object" ||
					!Array.isArray(value.servers) ||
					!Array.isArray(value.local) ||
					typeof value.totalTools !== "number"
				) {
					return { error: "宿主返回了无法识别的工具清单" };
				}
				if (value.scope !== "agent" && value.scope !== "global") {
					return { error: "宿主返回了未知的工具视图标记" };
				}
				// Tool entries are normalized where they are rendered, not here: the
				// component must not assume which shape its payload arrived in.
				return {
					servers: value.servers,
					totalTools: value.totalTools,
					// Non-MCP tools. The schemas carry no origin field, so this bucket
					// means "not an MCP server's tool", not "ships with the Harness".
					local: value.local,
					// `agent` means restrictions applied; `global` means the host had no
					// agent for this session and answered from the deployment catalog.
					scope: value.scope,
					// The host remembers the last answer a live agent gave for this session.
					// When it answers from that memory instead of a live agent, the numbers
					// are this session's own but no longer current — so they carry the time
					// they were read and must be presented as a past reading, not as now.
					stale: value.stale === true,
					recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : void 0,
				};
			} catch (error) {
				if (signal?.aborted === true) return { error: "读取已取消" };
				return { error: describeError(error) };
			}
		}

		/**
		 * Load the strip's whole payload. Blocks fail independently so one missing
		 * Remote never blanks the other group.
		 * @param remote - the client remote service.
		 * @param sessionId - session to read the skill catalog for.
		 * @param connection - the client Connection service (host tool route).
		 * @param signal - optional abort, forwarded to the host route read.
		 * @returns one settled payload for the strip.
		 */
		async function loadAll(remote, sessionId, connection, signal) {
			const [skills, inventory, bundles, tools] = await Promise.all([
				readSkills(remote, sessionId),
				readInventory(remote),
				readBundles(remote),
				readTools(connection, sessionId, signal),
			]);
			// Shape-validate the inventory snapshot here, at the load boundary: the
			// panel below assumes it is an array and would otherwise throw (and a throw
			// from `load` blanks the whole slot). A missing or malformed snapshot is
			// "no rows", not a crash.
			const entries = Array.isArray(inventory?.snapshot?.entries) ? inventory.snapshot.entries : [];
			return {
				skills,
				inventory,
				bundles,
				tools,
				mcpRows: entries.filter((entry) => entry.moduleName === MCP_MODULE),
				// The resource plugin is mounted once, not per server; keep it apart so
				// it never inflates the server list.
				mcpResources:
					entries.find((entry) => entry.moduleName === MCP_RESOURCES_MODULE) ?? null,
				loadedAt: new Date().toLocaleTimeString(),
			};
		}

		/**
		 * One skill row. The name renders as `/name` because that is how the
		 * composer references a human-invocable skill; `whenToUse` is the catalog's
		 * optional extra routing guidance and is shown under the description.
		 */
		function SkillRow({ entry }) {
			const muted = { fontSize: 11.5, opacity: 0.66, lineHeight: 1.5 };
			return h(
				"div",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 1,
						padding: "5px 0",
						borderBottom: "1px solid currentColor",
						borderBottomColor: "color-mix(in srgb, currentColor 10%, transparent)",
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
					h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, `/${entry.name}`),
					h(
						ui.Tag,
						{ tone: entry.modelInvocable ? "neutral" : "quiet" },
						entry.modelInvocable ? "model+user" : "user-only",
					),
				),
				entry.description !== "" && entry.description !== void 0
					? h("div", { style: muted }, entry.description)
					: null,
				entry.whenToUse !== "" && entry.whenToUse !== void 0
					? h("div", { style: { ...muted, opacity: 0.55 } }, entry.whenToUse)
					: null,
			);
		}

		/** One configured MCP client row: dot, row id, and its Loader state. */
		function McpRow({ row }) {
			const state = row.enabled ? "已启用" : "已停用";
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "5px 0",
						borderBottom: "1px solid currentColor",
						borderBottomColor: "color-mix(in srgb, currentColor 10%, transparent)",
					},
				},
				h("span", { style: { display: "flex", alignItems: "center" } }, mcpPhaseIcon(row)),
				h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, rowLabel(row.entryId)),
				h("span", { style: { marginLeft: "auto" } }, h(
					ui.Tag,
					{ tone: row.enabled ? (row.fiberPhase === "failed" ? "danger" : "success") : "quiet" },
					`${state} · ${row.fiberPhase ?? "无状态"}`,
				)),
			);
		}

		/**
		 * Normalize one tool entry.
		 *
		 * This version's host sends `{ name, description }`. An older host still
		 * installed sends bare name strings, and the two halves update at different
		 * times — the browser half on a refresh, the host half only on a restart — so
		 * that window is real. Normalizing here means such a payload degrades to
		 * "names, no descriptions" instead of rendering rows of `undefined`.
		 * @param tool - a `{ name, description }` entry or a bare name string.
		 * @returns an entry whose fields are always strings.
		 */
		function asTool(tool) {
			if (typeof tool === "string") return { name: tool, description: "", schemaChars: 0 };
			return {
				name: typeof tool?.name === "string" ? tool.name : "",
				description: typeof tool?.description === "string" ? tool.description : "",
				// The parameter schema and its size. `schemaChars` is measured on the
				// full schema by the host; `schema` may be a capped preview, so the two
				// must not be confused (the size is the number worth acting on).
				schema: typeof tool?.schema === "string" ? tool.schema : void 0,
				schemaChars: typeof tool?.schemaChars === "number" ? tool.schemaChars : 0,
				schemaTruncated: tool?.schemaTruncated === true,
			};
		}

		/**
		 * One non-MCP tool: name plus the tool's own description.
		 *
		 * The description is the tool author's own words, taken from the schema that
		 * the model sees — so this answers "what is this for" without inventing
		 * anything. It is clamped to two lines so a long description cannot push the
		 * rest of the list out of view; the tooltip shows the same (already truncated-at-the-host) text, so nothing is lost beyond the host's own cap.
		 */
		function ToolRow({ tool }) {
			// The schema is the part that actually costs context on every request, so it
			// is collapsed by default and its SIZE is shown even when collapsed: the
			// number is what tells the reader whether this tool is worth its price.
			const [showSchema, setShowSchema] = React.useState(false);
			const size = tool.schemaChars ?? 0;
			// Three cases, all reachable: a measurable size, the host's explicit "could
			// not serialize it" (-1), and no declared parameters at all. The gate below
			// must therefore be `size !== 0`, not `size > 0` — otherwise the unknown case
			// silently renders as if this tool cost nothing.
			const sizeLabel =
				size < 0 ? "参数体量未知" : `${size.toLocaleString()} 字符参数`;
			return h(
				"div",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 1,
						padding: "4px 0",
						borderBottom: "1px solid currentColor",
						borderBottomColor: "color-mix(in srgb, currentColor 10%, transparent)",
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: 6 } },
					h(
						"span",
						{
							title: tool.description === "" ? tool.name : `${tool.name}\n${tool.description}`,
							style: {
								fontSize: 12,
								fontWeight: 600,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								minWidth: 0,
							},
						},
						tool.name,
					),
					// The size sits on the name row so a long list is scannable without
					// expanding anything: big schemas are the ones to look at. `!== 0`
					// rather than `> 0` so an unmeasurable schema still says so.
					size !== 0
						? h(
								"span",
								{ style: { marginLeft: "auto", fontSize: 10, opacity: 0.5, flexShrink: 0 } },
								sizeLabel,
							)
						: null,
				),
				tool.description === ""
					? null
					: h(
							"span",
							{
								style: {
									fontSize: 11,
									opacity: 0.62,
									lineHeight: 1.45,
									display: "-webkit-box",
									WebkitLineClamp: 2,
									WebkitBoxOrient: "vertical",
									overflow: "hidden",
								},
							},
							tool.description,
						),
				// Only rendered when there is something to show: a tool with no declared
				// parameters has nothing to expand, and an empty toggle is a dead control.
				tool.schema === void 0
					? null
					: h(
							"div",
							{ style: { paddingTop: 1 } },
							h(
								"button",
								{
									type: "button",
									onClick: () => setShowSchema((previous) => !previous),
									"aria-expanded": showSchema,
									style: {
										display: "inline-flex",
										alignItems: "center",
										gap: 3,
										padding: 0,
										border: "none",
										background: "none",
										font: "inherit",
										fontSize: 10.5,
										opacity: 0.55,
										cursor: "pointer",
										color: "inherit",
									},
								},
								showSchema ? "▾ 收起参数" : "▸ 展开参数",
							),
							showSchema
								? h(
										"pre",
										{
											style: {
												margin: "3px 0 0",
												padding: "5px 6px",
												fontSize: 10,
												lineHeight: 1.45,
												opacity: 0.8,
												whiteSpace: "pre-wrap",
												wordBreak: "break-all",
												maxHeight: 220,
												overflowY: "auto",
												background: "color-mix(in srgb, currentColor 6%, transparent)",
												borderRadius: 6,
											},
										},
										// Pretty-printed when it parses: a raw one-line schema is
										// unreadable, and the reader came here to read it.
										(() => {
											try {
												return JSON.stringify(JSON.parse(tool.schema), null, 2);
											} catch {
												return tool.schema;
											}
										})(),
										tool.schemaTruncated ? "\n… （参数过长，仅显示前 6000 字符）" : "",
									)
								: null,
						),
			);
		}

/**
 * The skills group: one row per visible skill, or the reason there are none.
 *
 * A component rather than an IIFE in the strip body: it takes exactly what it
 * renders, so a change to the strip's internals cannot silently change this tree.
 * @param props - the payload's `skills` block.
 */
function SkillsSection({ skills }) {
	const entries = skills.entries ?? [];
	return h(
		"div",
		null,
		h(GroupHeading, {
			icon: h(ui.IconSkillOutlineRegular, { size: 13 }),
			name: "技能",
			// A failed read gets NO badge, not a "0": "could not read" and "there are
			// none" are different claims, and the section body already states which one
			// this is. Printing 0 would turn our own failure into a fact about the
			// session.
			count: skills.error === void 0 ? entries.length : void 0,
			note: "本会话可见",
		}),
		skills.error !== void 0
			? h(
					"div",
					{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
					`skills/list 读取失败：${skills.error}`,
				)
			: entries.length === 0
				? h(
						"div",
						{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
						"该会话没有可见技能。",
					)
				: entries.map((entry) => h(SkillRow, { key: `${entry.name}:${entry.path ?? ""}`, entry })),
	);
}

/**
 * The MCP group: which servers actually registered tools, the Loader rows behind
 * them, and the one control this group owns (reopening the fault dialog).
 *
 * Everything it renders is a prop. The seven values it used to read out of the
 * strip's enclosing scope are now an explicit list, so a change inside the strip
 * cannot silently change this tree.
 * @param props - connected servers, configured rows, the state words, and the
 *   callback that reopens the fault explanation.
 */
function McpSection({ tools, inventory, mcpResources, mcpRows, connectedServers, stateLabel, fault, onShowFault }) {
	return h(
		"div",
		null,
		h(GroupHeading, {
			icon: h(ui.IconGlobeOutlineRegular, { size: 13 }),
			name: "MCP",
			count: connectedServers.length,
			// The words the collapsed mark no longer prints: this heading is where
			// "连接故障 / 未连接 / 读取失败 / N 个工具" is spelled out.
			note: stateLabel,
		}),
		// The connected list is the answer to "does it actually work": these servers
		// have tools registered in the live registry.
		tools.error !== void 0
			? h(
					"div",
					{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
					`工具清单读取失败：${tools.error}`,
				)
			: connectedServers.length === 0
				? h(
						"div",
						{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
						"没有 MCP 服务器注册工具——即当前没有连上的服务器。",
					)
				: connectedServers.map((server) => h(McpServerBlock, { key: server.server, server })),
		// Configured rows the Loader carries, shown apart so a configured server with
		// no tools is visible as exactly that.
		inventory.error !== void 0
			? h(
					"div",
					{ style: { fontSize: 11.5, opacity: 0.7, padding: "6px 0 0" } },
					`Loader 条目读取失败：${inventory.error}`,
				)
			: mcpRows.length === 0
				? null
				: h(
						"div",
						null,
						h(
							"div",
							{ style: { fontSize: 11, opacity: 0.6, padding: "8px 0 2px" } },
							`已配置 ${mcpRows.length} 个客户端条目：`,
						),
						mcpRows.map((row) => h(McpRow, { key: row.entryId, row })),
					),
		// The resource plugin decides whether configured servers expose readable
		// resources at all, so its absence is information.
		mcpResources == null
			? null
			: h(
					"div",
					{ style: { fontSize: 11.5, opacity: 0.7, padding: "5px 0 0" } },
					`资源工具：${mcpResources.enabled ? "已挂载" : "已禁用"}（${rowLabel(mcpResources.entryId)}）`,
				),
		h(
			"div",
			{ style: { fontSize: 11, opacity: 0.6, lineHeight: 1.5, paddingTop: 5 } },
			"判据是工具注册表里存在 mcp__<server>__* 工具；注册表变化不会自动推送过来，这里只在你打开明细或点刷新时重读。",
			"连不上、或连上但被本会话的工具限制挡住，都会让这个视图里没有它的工具——所以「本会话视图里没有」不等于「服务器没连上」。",
		),
		// The fault dialog is the one thing this section cannot restate, and a
		// keyboard reader who dismissed it has no way to reopen it from the row (the
		// row is one button; the mark inside it carries a mouse-only click). A real
		// button here gives the dialog an equivalent, reachable path.
		fault
			? h(
					"div",
					{ style: { paddingTop: 4 } },
					h(
						ui.Button,
						{
							variant: "ghost",
							size: "sm",
							"aria-label": "查看 MCP 故障原因",
							onClick: onShowFault,
						},
						"查看故障原因",
					),
				)
			: null,
	);
}

/**
 * One connected MCP server: its tool count, and the tools themselves.
 * @param props - the server entry from the host's summary.
 */
function McpServerBlock({ server }) {
	return h(
		"div",
		{ style: { padding: "3px 0" } },
		h(
			"div",
			{ style: { display: "flex", alignItems: "center", gap: 6 } },
			h(ui.IconCheckCircleOutlineRegular, {
				size: 13,
				style: { color: "var(--dsw-alias-state-success-primary)" },
			}),
			h("span", { style: { fontSize: 12, fontWeight: 600 } }, server.server),
			h(
				"span",
				{ style: { marginLeft: "auto", fontSize: 11, opacity: 0.65 } },
				`${server.tools.length} 个工具`,
			),
		),
		server.tools.length > 0
			? h(
					"div",
					{ style: { paddingLeft: 19, display: "flex", flexDirection: "column" } },
					// Same row as the non-MCP list: the whole point of asking "what does
					// the model get" includes what each tool is for.
					// Index in the key, not just the name: an MCP tool whose raw name is
					// empty (`mcp__srv__`) and its non-MCP twin both render as "". Since
					// `ToolRow` owns a `useState` (the schema toggle), a duplicated key
					// would let one row's expansion state appear on another.
					server.tools.map((tool, index) => h(ToolRow, { key: `${index}:${tool.name}`, tool })),
				)
			: null,
	);
}

/**
 * The plugin-bundle group: the profile's enabled bundles.
 * @param props - the payload's `bundles` block.
 */
function BundlesSection({ bundles }) {
	// A failed read states its reason like the other groups; hiding the block would
	// read as "no bundles" and defeat the panel's purpose.
	if (bundles?.error !== void 0) {
		return h(
			"div",
			null,
			h(GroupHeading, {
				icon: h(ui.IconCordisPluginOutlineRegular, { size: 13 }),
				name: "插件包",
			}),
			h(
				"div",
				{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
				`pluginManager/listBundles 读取失败：${bundles.error}`,
			),
		);
	}
	const enabled = (bundles?.bundles ?? []).filter((bundle) => bundle.enabled);
	return h(
		"div",
		null,
		h(GroupHeading, {
			icon: h(ui.IconCordisPluginOutlineRegular, { size: 13 }),
			name: "插件包",
			count: enabled.length,
			note: "profile 已启用",
		}),
		enabled.map((bundle) =>
			h(
				"div",
				{
					key: bundle.name,
					style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 0" },
				},
				h("span", { style: { fontSize: 12 } }, bundle.name),
				h("span", { style: { marginLeft: "auto", fontSize: 11, opacity: 0.6 } }, `${bundle.version ?? "-"} · ${bundle.rows?.length ?? 0} rows`),
			),
		),
	);
}

/**
 * The non-MCP tool group: the deployment's own tools, with the arithmetic that
 * explains why this list is shorter than the collapsed mark's total.
 *
 * The MCP count is passed in rather than derived by subtraction. Subtraction would
 * present an unverified invariant as a fact: a schema whose name is empty or not a
 * string is counted in `totalTools` but skipped by both buckets, so "the rest are
 * MCP" would be wrong by exactly that amount.
 * @param props - the host's `tools` block and the connected MCP servers.
 */
function ToolsSection({ tools, connectedServers }) {
	const local = (tools?.local ?? []).map(asTool);
	const failed = tools?.error !== void 0;
	const mcpCount = connectedServers.reduce((sum, server) => sum + server.tools.length, 0);
	const total = tools?.totalTools ?? 0;
	const unclassified = Math.max(0, total - local.length - mcpCount);
	const metaStyle = { fontSize: 10.5, opacity: 0.55, lineHeight: 1.5 };
	/** Muted explanatory lines, kept out of the children array as data. */
	const meta = failed
		? []
		: [
				// The one case that must never read as "your session's tools": a stale answer
				// is what that agent saw when it was last alive, and a global answer is the
				// deployment catalog because this session has no agent to answer for it.
				...(tools !== void 0 && tools.stale === true
					? [
							`该会话当前没有活跃 agent。下面是它上次活跃时（${formatWhen(tools.recordedAt)}）读到的工具清单，不是现在的部署注册表。在会话里发一条消息后点刷新即可读到当前值。`,
						]
					: []),
				...(tools !== void 0 && tools.stale !== true && tools.scope !== "agent"
					? [
							"该会话当前没有活跃 agent（重启后尚未在本进程运行过，或它已被释放），因此读不到它自己的工具视图。下面是部署级注册表，不是本会话的数字；在会话里发一条消息后点刷新即可读到。",
						]
					: []),
				// Make the arithmetic visible, so "40 shown, eleven listed" cannot be read as
				// a bug: the total is split across two sections.
				`共 ${total} 个：下列 ${local.length} 个非 MCP` +
					`，上方 MCP 分区 ${mcpCount} 个` +
					(unclassified > 0 ? `，另有 ${unclassified} 个名字不可解析` : "") +
					"。",
				// Without this line the section over-claims: `dsh-read-img` hides
				// `read_image` by filtering `options.tools` inside `llm/stream`, and a guard
				// refuses residual calls — the registry still lists it, so the panel does
				// too. Saying so beats silently looking wrong.
				"这里是工具注册表。插件可以在请求层再次过滤（例如 dsh-read-img 会隐藏 read_image 并拒绝调用），这类过滤在此视图中看不到。",
			];

	// Three distinct states, kept apart on purpose: unreadable, read but empty, and a
	// list. Folding the first into the second would turn our own failure into a claim
	// about the deployment.
	let body;
	if (failed) {
		body = h("div", { style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } }, `工具清单读取失败：${tools.error}`);
	} else if (tools === void 0) {
		body = h("div", { style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } }, "尚未读到工具清单。");
	} else if (local.length === 0) {
		body = h(
			"div",
			{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
			mcpCount > 0 ? "除 MCP 工具外没有注册工具。" : "注册表里没有任何工具。",
		);
	} else {
		body = h(
			"div",
			{ style: { display: "flex", flexDirection: "column" } },
			local.map((tool, index) => h(ToolRow, { key: `${index}:${tool.name}`, tool })),
		);
	}

	return h(
		"div",
		null,
		h(GroupHeading, {
			icon: h(ui.IconToolOutlineRegular, { size: 13 }),
			name: "工具",
			// The count must match the list right under it. Showing the grand total here
			// is what made the row count look wrong: the MCP tools are listed in the MCP
			// section above, so this section holds only the rest.
			count: failed ? void 0 : local.length,
			// The scope, stated rather than implied. It says "视图", not "可见": this reads
			// the REGISTRY, so a plugin that filters tools out of the LLM request
			// afterwards is not reflected here.
			note: toolsNote(tools, failed),
		}),
		meta.map((text, index) => h("div", { key: `meta-${index}`, style: metaStyle }, text)),
		body,
	);
}

/**
 * The skills mark: a count, or the icon that says why there is no count.
 *
 * A component taking plain data, not a closure over the strip's state: the three
 * branches (unreadable / still loading / counted) are the whole contract, and a
 * test can drive each one without mounting the strip.
 * @param props - load phase, payload, and whether the load threw outright.
 */
function SkillChip({ state, payload, loadFailed, skillCount }) {
		const skills = payload?.skills;
		let body;
		if (skills?.error !== void 0)
			body = h(ui.IconUnknownOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-error-primary)" },
			});
		else if (loadFailed)
			// The whole load threw; there is no skills block to read. Saying
			// "读取失败" beats a permanent "…".
			body = h(ui.IconUnknownOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-error-primary)" },
			});
		else if (skillCount === void 0) body = h("span", MUTED, "…");
		else body = h("span", COUNT, String(skillCount));
		return h(
			"span",
			{
				style: CHIP,
				title:
					skills?.error !== void 0 || loadFailed
						? state.phase === "failed" && state.error !== void 0
							? `读取失败：${state.error}`
							: "技能清单读取失败"
						: "本会话可见的 skill 数量",
				"aria-label": "技能",
			},
			h(ui.IconSkillOutlineRegular, { size: 12 }),
			body,
		);
}

/**
 * The MCP mark: the connected-server count, or the icon naming the fault.
 *
 * `toolsCurrent` is what keeps this honest — a remembered or deployment-wide
 * answer must not print a live-looking server count.
 * @param props - load phase, payload, connected servers, and the currentness gate.
 */
function McpChip({
	state,
	payload,
	loadFailed,
	connected,
	enabledMcpRows,
	mcpFault,
	totalMcpTools,
	toolsCurrent,
	mcpStateLabel,
	onShowFault,
}) {
		let body;
		if (payload === void 0)
			body = loadFailed
				? h(ui.IconUnknownOutlineRegular, {
						size: 12,
						style: { color: "var(--dsw-alias-state-error-primary)" },
					})
				: h("span", MUTED, "…");
		else if (payload.tools?.error !== void 0)
			body = h(ui.IconUnknownOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-error-primary)" },
			});
		// Amber question mark: this answer is not the session's current state
		// (deployment catalog, or a remembered reading). Printing the count in
		// green here is what made a deployment number look like this session's.
		else if (!toolsCurrent)
			body = h(ui.IconUnknownOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-warn-primary)" },
			});
		else if (connected)
			body = h(
				"span",
				{ style: { ...COUNT, color: "var(--dsw-alias-state-success-primary)" } },
				String(totalMcpTools),
			);
		else if (mcpFault)
			// Red, not amber: amber reads as "not configured", red as
			// "configured and broken".
			body = h(ui.IconWarningOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-error-primary)" },
			});
		// Configured rows that registered nothing: still connecting, or masked out
		// of this session's view by `tools.restrict()`. The strip cannot tell which,
		// so it shows "unknown" rather than accusing the deployment of being down.
		else if (enabledMcpRows.length > 0)
			body = h(ui.IconUnknownOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-warn-primary)" },
			});
		else
			body = h(ui.IconCloseOutlineRegular, {
				size: 12,
				style: { color: "var(--dsw-alias-state-warn-primary)" },
			});
		const label = h(
			"span",
			{ style: CHIP, title: `MCP：${mcpStateLabel}`, "aria-label": "MCP" },
			h(ui.IconGlobeOutlineRegular, { size: 12 }),
			body,
		);
		// A fault is the one case where the mark must be actionable: clicking it
		// re-opens the explanation, so a reader who dismissed the dialog can get
		// it back without hunting for it.
		//
		// It is a `span`, not a `<button>`, on purpose: this sits inside the row
		// that is itself `role="button"`, and a native button inside a button-like
		// element is invalid nesting — two tab stops for one visual row, and
		// screen readers disagree about which one wins. The keyboard path to the
		// dialog is the row itself (which opens the panel, whose MCP section states
		// the fault) plus the dialog that opens by itself; this click is a mouse
		// convenience layered on that, so it carries no role and no tab stop.
		if (!mcpFault) return label;
		return h(
			"span",
			{
				onClick: (event) => {
					event.stopPropagation();
					// The handler arrives as a prop. Reaching for the strip's own
					// `setAlertOpen` here would be a ReferenceError: this component is a
					// top-level sibling, not a closure inside RuntimeStrip.
					onShowFault();
				},
				title: "MCP 连接故障：点击查看原因",
				style: {
					...CHIP,
					cursor: "pointer",
				},
			},
			label,
		);
}

/**
 * The tools mark: this session's total, or the muted time of a past reading.
 * @param props - load phase, payload, and the currentness gate.
 */
function ToolsChip({ payload, loadFailed }) {
		const tools = payload?.tools;
		/**
		 * What this chip actually knows, as four distinct states.
		 *
		 * Collapsing them is how a wrong claim gets made: `scope` read off a missing
		 * payload is `undefined`, which is not `"agent"`, so a naive check reports
		 * "no active agent" before anything was asked — and a payload without a
		 * tools block would report one too. Each state answers for itself.
		 */
		const chipState =
			payload === void 0
				? loadFailed
					? "unreadable"
					: "pending"
				: tools === void 0 || tools.error !== void 0
					? "unreadable"
					: tools.scope !== "agent"
						? "no-agent"
						: tools.stale === true
							? "stale"
							: "ready";
		const chipStateBody = {
			pending: () => h("span", MUTED, "…"),
			unreadable: () =>
				h(ui.IconUnknownOutlineRegular, {
					size: 12,
					style: { color: "var(--dsw-alias-state-error-primary)" },
				}),
			// No live agent for this session: a mark, never the deployment's number.
			// The panel still shows that catalog, labelled for what it is.
			"no-agent": () =>
				h(ui.IconUnknownOutlineRegular, {
					size: 12,
					style: { color: "var(--dsw-alias-state-warn-primary)" },
				}),
			// A remembered answer is this session's own number from when its agent was
			// alive. Muted, so it never looks like a live reading.
			stale: () =>
				h(
					"span",
					{ ...COUNT, opacity: 0.6 },
					String(tools?.totalTools ?? 0),
				),
			ready: () => h("span", COUNT, String(tools?.totalTools ?? 0)),
		}[chipState];
		const stateTitle = {
			pending: "工具清单读取中",
			unreadable: "工具清单读取失败",
			"no-agent": "该会话暂无活跃 agent，读不到它自己的工具视图（在会话里发一条消息后即可读取）",
			stale: `上次活跃时（${formatWhen(tools?.recordedAt)}）的工具总数：${tools?.totalTools ?? 0}；当前无活跃 agent`,
			ready: `本会话 agent 被提供的工具总数（含 MCP）：${tools?.totalTools ?? 0}`,
		}[chipState];
		return h(
			"span",
			{ style: CHIP, title: stateTitle, "aria-label": "工具" },
			h(ui.IconToolOutlineRegular, { size: 12 }),
			chipStateBody(),
		);
}

		/** Group heading: an icon, the group name, and its count. */
		function GroupHeading({ icon, name, count, note }) {
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "8px 0 4px",
					},
				},
				icon,
				h("span", { style: { fontSize: 12, fontWeight: 600 } }, name),
				count === void 0 ? null : h(ui.Tag, { tone: "neutral" }, String(count)),
				note === void 0
					? null
					: h("span", { style: { marginLeft: "auto", fontSize: 11, opacity: 0.6 } }, note),
			);
		}

		/** The docked strip. */
		function RuntimeStrip(props) {
			const { sessionId, load } = props;
			const [open, setOpen] = React.useState(false);
			const [state, setState] = React.useState({ phase: "idle" });
			// The fault dialog opens itself once per fault, and can be re-opened
			// from the MCP mark (mouse) and from the detail panel (a real button).
			// `acknowledged` remembers the fault the reader has already seen, so a
			// recurring fault cannot nag on every re-read.
			const [alertOpen, setAlertOpen] = React.useState(false);
			const acknowledgedFault = React.useRef(void 0);
			// The floating panel is placed from this row's live rect.
			const anchorRef = React.useRef(null);
			// The focusable element: the row carries `role="button"` and `tabIndex`, while
			// the anchor above it is a plain positioning div. Restoring focus must target
			// THIS node — pointing it at the anchor is a silent no-op, because a div
			// without a tab index cannot take focus.
			const rowRef = React.useRef(null);

			// The renderer caches an inject face per registration × scope binding, so
			// `load` is identity-stable for one Session. A ref keeps the effect keyed
			// on `sessionId` alone rather than on that closure's identity, which keeps
			// the fetch tied to the Session the reader is actually looking at.
			const loadRef = React.useRef(load);
			React.useEffect(() => {
				loadRef.current = load;
			}, [load]);

			// Monotonic request id: a superseded fetch must not overwrite the newer
			// answer when the reader switches sessions mid-flight.
			const requestId = React.useRef(0);
			// In-flight guard. Despite the name, the smoke in this file: a second call
			// while a read is running is dropped and compensated with the LATEST
			// caller's options (not the first one's), so the request that matters wins.
			const inFlight = React.useRef(false);
			// The caller whose read was dropped by the in-flight guard. `finally` runs
			// THIS instead of `options`: a manual refresh dropped behind a silent open
			// must come back as a refresh, not stay silent.
			const pendingOptions = React.useRef(void 0);
			// The in-flight read's abort handle. Two owners: the timeout (a Host that
			// never answers must not leave the strip refusing every refresh forever)
			// and unmount (a read nobody is waiting for must not keep a Host request
			// alive). One read at a time, so a single slot is enough.
			const activeRead = React.useRef(null);

			const run = React.useCallback(
				async (options) => {
					// The session id arrives as a standard prop of this session-scoped
					// slot, so the inject face never has to carry it. Without one there is
					// no catalog to read: stay pending rather than reporting a failure.
					if (sessionId === void 0) return;
					// One read at a time. A slow Host must not be asked again before it
					// answered: this call is dropped (and compensated) instead.
					if (inFlight.current) {
						// Invalidate the in-flight read so its stale result is discarded,
						// and remember the LATEST caller's options for the compensation.
						// A caller with no options is still a caller: storing `undefined`
						// here would make the compensation indistinguishable from "nobody
						// asked", and the pending read would be dropped instead of run.
						requestId.current += 1;
						pendingOptions.current = options ?? {};
						return;
					}
					inFlight.current = true;
					const id = requestId.current + 1;
					requestId.current = id;
					// A silent re-read (opening the panel or a mount) must not flip the
					// strip into its loading state: that would repaint the row and, worse,
					// look like a user-initiated read. Only an explicit refresh shows
					// progress.
					if (options?.silent !== true) {
						// Keep the previous payload while re-reading so a refresh does not
						// blank the strip mid-flight.
						setState((prev) => ({ ...prev, phase: "loading", error: void 0 }));
					}
					// Hard ceiling for one read. `loadAll` forwards this signal to the
					// host route's `rpc.call`, so an abort actually cancels the request
					// instead of only forgetting about it. Unmount aborts the same handle.
					const controller = new AbortController();
					activeRead.current = controller;
					const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
					try {
						const payload = await loadRef.current(sessionId, controller.signal);
						if (id !== requestId.current) return;
						// A silent re-read that returns exactly what is already on screen
						// must not re-render: the same answer would otherwise rebuild the
						// row, invalidate the memo, and repaint for nothing.
						setState((prev) => {
							// An unchanged payload does not re-render — but a previous failure
							// must still be cleared, or the error line outlives the failure it
							// reported (a silent success would leave "读取失败" on screen).
							if (options?.silent === true && prev.phase === "ready" && samePayload(prev.payload, payload)) {
								return prev;
							}
							return { phase: "ready", payload };
						});
					} catch (error) {
						if (id !== requestId.current) return;
						// A thrown load must be visible: the strip exists to remove blind
						// spots, so a silent failure would defeat its only purpose. A failed
						// re-read keeps the last good payload and states the failure. An
						// aborted read names the abort, because "已取消" from a timeout
						// reads like a deliberate stop.
						setState((prev) => ({
							...prev,
							phase: "failed",
							error: controller.signal.aborted ? "读取超时，已取消" : describeError(error),
						}));
					} finally {
						clearTimeout(timer);
						if (activeRead.current === controller) activeRead.current = null;
						inFlight.current = false;
						// If a call arrived while this read was in flight, run it now —
						// with the LATEST caller's options, not this read's.
						const pending = pendingOptions.current;
						pendingOptions.current = void 0;
						if (pending !== void 0) {
							void run(pending);
						}
					}
				},
				[sessionId],
			);

			// Unmount: cancel the in-flight read so it does not keep a Host request
			// alive for a reader nobody is looking at. Late `setState` calls from that
			// read are no-ops after unmount, so the abort's only job is the request.
			React.useEffect(() => {
				return () => activeRead.current?.abort();
			}, []);

			// No change stream. This row used to hold an SSE connection per tab and
			// re-read on every frame. It does not any more, by decision: the strip is a
			// read-on-demand view now — it reads when it mounts, when the session
			// changes, when the panel opens, and when the reader presses refresh.
			// Nothing is pushed, no timer runs, and no connection is held open per tab.
			//
			// First read, once per Session. This is the whole "live" story now: the
			// numbers are a reading, not a subscription, so they can lag until the reader
			// asks again (opening the panel or pressing refresh does exactly that).
			React.useEffect(() => {
				void run();
			}, [run, sessionId]);

			const payload = state.payload;
			// The whole load failed before producing any payload (a thrown `loadAll`).
			// The chips otherwise read `payload === void 0` as "not read yet" and would
			// show "…" forever — the error text exists but sits below the fold. This
			// flag lets every chip say "读取失败" instead of pretending nothing happened.
			const loadFailed = state.phase === "failed" && payload === void 0;
			const skillCount = payload?.skills?.entries?.length;
			const mcpRows = payload?.mcpRows ?? [];
			// The answer the whole MCP mark exists for: does at least one MCP server
			// have a tool registered RIGHT NOW? A server that failed to connect
			// registers none, so this is real connectivity, not configuration.
			// Memoized because the dock re-renders on every composer keystroke.
			const connectedServers = React.useMemo(
				() =>
					(payload?.tools?.servers ?? []).map((server) => ({
						server: server?.server,
						tools: (Array.isArray(server?.tools) ? server.tools : []).map(asTool),
					})),
				[payload],
			);
			const connected = connectedServers.length > 0;
			// Total MCP tools across all connected servers — the number the chip
			// shows when connected (the icon already says "connected").
			const totalMcpTools = connectedServers.reduce(
				(sum, server) => sum + (server.tools?.length ?? 0),
				0,
			);

			// Whether these numbers describe THIS session right now.
			//
			// A `global` answer is the deployment catalog and a `stale` one is this
			// session's own numbers from an earlier moment. Neither may be rendered as
			// current connectivity, and neither may raise a fault dialog: presenting them as
			// "the MCP situation now" is the substitution this plugin refuses to make for the
			// tools mark, and the MCP mark has to hold the same line.
			const toolsState = payload?.tools;
			const toolsCurrent =
				toolsState !== void 0 &&
				toolsState.error === void 0 &&
				toolsState.scope === "agent" &&
				toolsState.stale !== true;

			// A fault, not merely an absence: MCP was CONFIGURED AND ENABLED, and yet
			// nothing registered a tool. That is the case worth interrupting the reader
			// for — it means servers that should work are not working, and the failure
			// is otherwise invisible (it only reaches the Host log).
			//
			// A profile with no MCP rows, or with every row disabled, is NOT a fault:
			// nagging about a feature the reader does not use would be noise, and noise
			// gets the plugin uninstalled. A failed registry read is also not a fault
			// claim — the strip cannot tell, so it must not accuse.
			const enabledMcpRows = mcpRows.filter((row) => row.enabled);
			// A row is "settled" only when its Loader lifecycle reached a terminal
			// state: `active` (it should have registered tools) or `failed` (it could
			// not). Everything else — `pending`, `loading`, `null` (disposed), and
			// `unloading` — is mid-lifecycle or gone, and declaring a fault while a
			// row is not settled would be a false alarm.
			const stillConnecting = !enabledMcpRows.every(
				(row) => row.fiberPhase === "active" || row.fiberPhase === "failed",
			);
			const mcpFault =
				payload !== void 0 &&
				payload.tools?.error === void 0 &&
				// Only a current agent-scoped answer may accuse. A deployment-catalog answer
				// describes a different thing, and a remembered one describes an earlier moment —
				// neither is evidence about this session's MCP wiring now.
				toolsCurrent &&
				enabledMcpRows.length > 0 &&
				!stillConnecting &&
				connectedServers.length === 0;

			// Pop the dialog the first time a fault is observed, and again only when the
			// set of affected servers changes. The identity is the sorted row ids, so a
			// recurring fault after a recovery still speaks up.
			const faultKey = mcpFault
				? enabledMcpRows
						.map((row) => rowLabel(row.entryId))
						.sort()
						.join("|")
				: void 0;
			React.useEffect(() => {
				if (faultKey === void 0) return;
				if (acknowledgedFault.current === faultKey) return;
				acknowledgedFault.current = faultKey;
				setAlertOpen(true);
			}, [faultKey]);
			// When the fault clears, close the dialog and reset the dismissal state so
			// the next occurrence of the same fault speaks up again. Without this,
			// `alertOpen` stays true across the Modal's unmount/remount and the dialog
			// would pop open with no user action.
			React.useEffect(() => {
				if (!mcpFault) {
					setAlertOpen(false);
					acknowledgedFault.current = void 0;
				}
			}, [mcpFault]);

			// Two independent marks, never merged into one count. Each distinguishes
			// three states on purpose: not-read-yet (…), failed (读取失败), and a real
			// answer. Collapsing the first two into "0"/"无" would report a fact the
			// strip has not observed.
			// One sentence for the MCP mark's tooltip and the panel heading. The
			// collapsed row no longer prints it: the dock is a shared row, so the
			// state is a glyph there and the words live in the tooltip and the detail.
			const mcpStateLabel =
				payload === void 0
					? loadFailed
						? "读取失败"
						: "读取中"
					: payload.tools?.error !== void 0
						? "工具清单读取失败"
						: payload.tools?.stale === true
							? `上次活跃时：${totalMcpTools} 个工具（非当前连接状态）`
							: payload.tools?.scope !== "agent"
								? `部署级注册表：${totalMcpTools} 个工具（非本会话视图）`
								: connected
									? `${totalMcpTools} 个工具`
									: mcpFault
										? "连接故障"
										: enabledMcpRows.length > 0
											? "本会话视图里没有 MCP 工具（可能未连接，也可能被本会话的工具限制挡住）"
											: "未连接";

			const renderSkillChip = () => h(SkillChip, { state, payload, loadFailed, skillCount });

			const renderMcpChip = () =>
				h(McpChip, {
					state,
					payload,
					loadFailed,
					connected,
					enabledMcpRows,
					mcpFault,
					totalMcpTools,
					toolsCurrent,
					mcpStateLabel,
					onShowFault: () => setAlertOpen(true),
				});

			// The third mark: how many tools this session's model is offered.
			//
			// `scope` is the whole point here. The host reads `tools.schemas(agent)`, and
			// an agent exists only while its session is live in this Host process — the
			// session controller resumes one on demand. After a restart, or for any
			// session that has not run since, there is no agent, the host falls back to
			// the deployment catalog, and that number is NOT this session's tool view.
			// Printing it here is what made the strip look like it ignored the session,
			// so a global answer renders as "unreadable", never as a count.
			const renderToolsChip = () => h(ToolsChip, { payload, loadFailed });

			// Tools first: it is the group the collapsed mark counts.
			const toolsSection =
				open && payload !== void 0
					? h(ToolsSection, { tools: payload.tools, connectedServers })
					: null;

			// Skills: the only group whose count the strip also shows collapsed.
			const skillsSection = open && payload !== void 0 ? h(SkillsSection, { skills: payload.skills }) : null;

			// MCP: connected servers, then the Loader rows behind them.
			const mcpSection =
				open && payload !== void 0
					? h(McpSection, {
							tools: payload.tools,
							inventory: payload.inventory,
							mcpResources: payload.mcpResources,
							mcpRows,
							connectedServers,
							stateLabel: mcpStateLabel,
							fault: mcpFault,
							onShowFault: () => setAlertOpen(true),
						})
					: null;

			// Bundles last: it is context, not a capability the model is offered.
			const bundlesSection = open && payload !== void 0 ? h(BundlesSection, { bundles: payload.bundles }) : null;

			/**
			 * Open or close the detail panel.
			 *
			 * One function for both input paths, because the row is `role="button"` and
			 * a role="button" that ignores Enter and Space is a keyboard trap in
			 * disguise: it takes a tab stop and then does nothing with it.
			 */
			const toggle = () => {
				// Opening is a request for detail, so it reads — the panel must show
				// what is true now, and opening the panel is the reader asking for it.
				if (!open) void run({ silent: true });
				setOpen((prev) => !prev);
			};

			return h(
				"div",
				{
					// This ref is the anchor the floating detail panel positions itself
					// against. It MUST be on a DOM node: without it `anchorRef.current`
					// stays null, `place()` returns before setting `pos`, and the panel
					// renders permanently `visibility: hidden`.
					ref: anchorRef,
					style: {
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 2,
						padding: "2px 0",
						// Content width, never `100%`: the composer dock is a shared flex row
						// and a full-width claim here would push every sibling widget and
						// leave the strip's own content off to the side.
						flex: "0 1 auto",
						minWidth: 0,
					},
				},
				// The whole row is the toggle: clicking anywhere in the strip opens or
				// closes the detail panel. No separate icon button needed.
				h(
					"div",
					{
						ref: rowRef,
						role: "button",
						tabIndex: 0,
						"aria-expanded": open,
						"aria-controls": "ability-strip-detail",
						"aria-label": open ? "收起明细" : "展开明细",
						title: open ? "收起明细" : "明细",
						onClick: toggle,
						onKeyDown: (event) => {
							// Enter and Space are what a button answers to. Space scrolls the
							// page by default, so it has to be prevented explicitly.
							if (event.key !== "Enter" && event.key !== " ") return;
							event.preventDefault();
							toggle();
						},
						// Returning focus to this row when the panel closes is part of the
						// dialog contract (the panel took focus when it opened), so a
						// keyboard user lands back where they started instead of being
						// dropped at the top of the document.
						onMouseDown: (event) => event.stopPropagation(),
						style: {
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							gap: 5,
							minHeight: 22,
							flexWrap: "nowrap",
							maxWidth: "100%",
							cursor: "pointer",
						},
					},
					renderSkillChip(),
					h("span", { style: { height: 10, display: "flex" } }, h(Divider, { vertical: true })),
					renderMcpChip(),
					h("span", { style: { height: 10, display: "flex" } }, h(Divider, { vertical: true })),
					renderToolsChip(),
				),
				state.phase === "failed"
					? h(
							"div",
							{ style: { fontSize: 11.5, opacity: 0.75, padding: "2px 0" } },
							`读取失败：${state.error}`,
						)
					: null,
				// The detail floats above the page instead of pushing it: a fixed panel
				// anchored to this row. It is portalled to <body> so no ancestor's
				// overflow or stacking context can clip it. `document.body` is checked
				// because the portal target must exist before React can mount into it.
				open && payload !== void 0 && document.body !== null && document.body !== void 0
					? ReactDOM.createPortal(
							h(DetailPanel, {
								anchorRef,
								onClose: () => {
								setOpen(false);
								// Return focus to the toggle row: the panel took it when it
								// opened, so the reader should land back where they started.
								// A timeout lets the portal unmount before the anchor is
								// refocused; focusing an element on the same tick is fine too,
								// so this is defensive, not load-bearing.
								setTimeout(() => rowRef.current?.focus?.(), 0);
							},
								loadedAt: payload.loadedAt,
								loading: state.phase === "loading",
								onRefresh: () => void run(),
								children: [
									h("div", { key: "skills" }, skillsSection),
									h("div", { key: "s1", style: { height: 10 } }),
									h("div", { key: "mcp" }, mcpSection),
									h("div", { key: "s2", style: { height: 10 } }),
									h("div", { key: "tools" }, toolsSection),
									h("div", { key: "s3", style: { height: 10 } }),
									h("div", { key: "bundles" }, bundlesSection),
								],
							}),
							document.body,
						)
					: null,
				// The fault dialog. It is the one interruption this strip is allowed to
				// make, and only for a real fault: MCP was configured and enabled, and
				// nothing registered a tool. The dialog is this bundle's own `Modal`, so
				// focus moving in and back out, the mask, Escape, and the portal are
				// implemented above rather than borrowed from a Harness Client package.
				mcpFault
					? h(
							ui.Modal,
							{
								open: alertOpen,
								onClose: () => setAlertOpen(false),
								title: "MCP 连接故障",
								closeLabel: "关闭",
								footer: h(
									ui.Button,
									{
										variant: "primary",
										size: "sm",
										onClick: () => setAlertOpen(false),
									},
									"知道了",
								),
							},
							h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 } },
								h(
									"div",
									{ style: { lineHeight: 1.6 } },
									`有 ${enabledMcpRows.length} 个已启用的 MCP 客户端，但没有任何一个注册了工具。`,
									"这意味着它们的工具现在全部不可用。",
								),
								h(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: 3 } },
									enabledMcpRows.map((row) =>
										h(
											"div",
																					{
												key: row.entryId,
												style: {
													display: "flex",
													alignItems: "center",
													gap: 6,
													fontSize: 12,
												},
											},
											h(ui.IconWarningOutlineRegular, {
												size: 13,
												style: { color: "var(--dsw-alias-state-error-primary)" },
											}),
											h("span", { style: { fontWeight: 600 } }, rowLabel(row.entryId)),
											h(
												"span",
												{ style: { marginLeft: "auto", opacity: 0.6, fontSize: 11 } },
												row.fiberPhase ?? "无状态",
											),
										),
									),
								),
								h(
									"div",
									{ style: { opacity: 0.7, lineHeight: 1.6, fontSize: 11.5 } },
									"常见原因：服务器进程没起来、地址或鉴权配置错误、连接在启动后掉线。",
									"具体报错只写在宿主日志里，页面上拿不到——这是 DSH 目前的限制。",
								),
							),
						)
					: null,
			);
		}

		/**
		 * The floating detail panel. Positioned above its anchor row and portalled to
		 * <body>, so opening it never changes the composer's height.
		 * @param props - anchor ref, close/refresh callbacks, and the sections.
		 */
		function DetailPanel({ anchorRef, onClose, loadedAt, loading, onRefresh, children }) {
			const [pos, setPos] = React.useState(null);
			const panelRef = React.useRef(null);
			// `onClose` is a new function on every parent render. Holding it in a ref
			// keeps the outside-click effect from tearing down and re-adding its
			// listener on every render (a gap during which a mousedown could slip
			// through unnoticed).
			const onCloseRef = React.useRef(onClose);
			React.useEffect(() => {
				onCloseRef.current = onClose;
			}, [onClose]);

			// Place the panel from the anchor's live rect on open, and keep it placed
			// while the window resizes. `fixed` keeps it put when the page scrolls.
			// Upward with a floor, downward when the anchor sits too high: an anchor
			// near the top of the viewport has no room above it, and a panel whose
			// head (refresh/close buttons) is pushed off screen is a dead control.
			// The direction is decided once per placement with the anchor's live rect.
			React.useEffect(() => {
				const place = () => {
					const anchor = anchorRef.current;
					if (anchor === null) return;
					setPos(
						computePlacement(anchor.getBoundingClientRect(), {
							width: window.innerWidth,
							height: window.innerHeight,
						}),
					);
				};
				place();
				window.addEventListener("resize", place);
				// The composer dock can change height (a textarea growing, a banner), which
				// moves the anchor without a window resize — a fixed panel would then
				// hover at the old spot. Watching the anchor's own box re-places on layout
				// changes it can see; the window resize covers the rest.
				let observer = null;
				const observed = anchorRef.current?.parentElement ?? null;
				if (observed !== null && typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver(place);
					observer.observe(observed);
				}
				return () => {
					window.removeEventListener("resize", place);
					observer?.disconnect();
				};
			}, [anchorRef]);

			// Escape closes it. Capture phase plus stopPropagation keeps the composer's
			// own Escape handling from also firing while the panel is open. If the
			// fault Modal is also open, defer to it: it portals to <body> and owns
			// Escape as its dismissal key.
			React.useEffect(() => {
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					// `aria-modal` distinguishes the fault Modal from this panel (which
					// is also `role="dialog"` but not modal).
					if (document.querySelector('[role="dialog"][aria-modal]')) return;
					event.stopPropagation();
					onCloseRef.current();
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, []);

			// Move focus into the panel once it is placed. A dialog that opens and
			// leaves focus on the toggle button makes the reader tab across the whole
			// page to reach the first control; parking focus here is the dialog
			// contract. The anchor restores focus on close (in the parent's onClose).
			React.useEffect(() => {
				if (pos === null) return void 0;
				panelRef.current?.focus?.();
				return void 0;
			}, [pos]);

			// A click anywhere outside the panel closes it, like every other popover.
			// `mousedown` rather than `click`: a drag that starts inside and ends
			// outside (text selection) must not be read as an outside click. The
			// toggle button is excluded so pressing it once collapses the panel
			// instead of closing here and immediately reopening on that button's own
			// click.
			React.useEffect(() => {
				const onDown = (event) => {
					const panel = panelRef.current;
					if (panel === null) return;
					const target = event.target;
					if (panel.contains(target)) return;
					const anchor = anchorRef.current;
					if (anchor !== null && anchor.contains(target)) return;
					// Clicks inside the fault Modal must not close this panel: the Modal
					// portals to <body> and its mask/buttons are outside the anchor.
					if (target.closest?.('[role="dialog"][aria-modal]')) return;
					onCloseRef.current();
				};
				window.addEventListener("mousedown", onDown);
				return () => window.removeEventListener("mousedown", onDown);
			}, [anchorRef]);

			return h(
				"div",
				{
					ref: panelRef,
					// Focusable so the panel can take focus when it opens (see the
					// focus effect above); the tab order then starts at its controls.
					tabIndex: -1,
					role: "dialog",
					"aria-label": "能力明细",
					id: "ability-strip-detail",
					style: {
						position: "fixed",
						// Nothing is painted until the anchor has been measured, so the
						// panel never flashes at the wrong corner.
						...(pos === null ? { visibility: "hidden", top: 0, left: 0 } : pos),
						width: pos === null ? 480 : pos.width,
						maxHeight: pos === null ? 420 : pos.maxHeight,
						display: "flex",
						flexDirection: "column",
						gap: 2,
						padding: "8px 10px",
						zIndex: 60,
						outline: "none",
						background: "var(--dsw-alias-bg-layer-1, #fff)",
						color: "inherit",
						border: "1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))",
						borderRadius: "var(--dsw-radius-lg, 12px)",
						boxShadow: "0 10px 30px rgba(0, 0, 0, 0.14)",
						fontSize: 12,
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 6 } },
					h(
						"span",
						{ style: { fontSize: 11, opacity: 0.6 } },
						loadedAt !== void 0 ? `读取于 ${loadedAt}` : "尚未记录读取时间",
					),
					h(
						"span",
						{ style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 } },
						h(
							ui.Button,
							{
								variant: "ghost",
								size: "sm",
								onClick: onRefresh,
								disabled: loading,
								"aria-label": "刷新能力信息",
								title: "重新读取",
							},
							h(ui.IconRefreshOutlineRegular, { size: 12 }),
						),
						h(
							ui.Button,
							{
								variant: "ghost",
								size: "sm",
								onClick: onClose,
								"aria-label": "关闭明细",
								title: "关闭",
							},
							h(ui.IconCloseOutlineRegular, { size: 12 }),
						),
					),
				),
				h(Divider, null),
				h("div", { style: { overflowY: "auto", minHeight: 0 } }, children),
			);
		}

		/**
		 * Client plugin body: dock the strip under the composer, in the same bar the
		 * `dsh-persona-dafeiyu` plugin uses.
		 *
		 * `conversation.input.dock` renders INSIDE the composer stack but BEFORE the
		 * input bar, so anything there sits above the box the reader types in.
		 * `conversation.composer.dock` is a child of the input bar's own dock element,
		 * which the bar renders after its input row — under the box.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const remote = ctx.remote;
			// `connection` is provided by the shipped client-connection plugin at
			// runtime (`ctx.provide("connection", handle)`), which is how the strip
			// reaches its own host half. Cordis gates the read behind the declared
			// name in `inject`.
			const connection = ctx.connection;
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "ability-strip",
						// The persona bar registers at 60; 65 keeps this strip directly
						// beneath it instead of depending on registration tie-breaking.
						order: 65,
						// `load` takes the session id as an argument rather than closing over
						// the inject face's one: the component already receives the session id
						// as a built-in standard prop, and that is the value it must read.
						inject: () => ({
							// The renderer calls this with `(sessionId, signal)`; the signal
							// reaches the host route read, so a superseded or unmounted read
							// can be cancelled instead of spending a Host request.
							load: (sessionId, signal) => loadAll(remote, sessionId, connection, signal),
						}),
					},
					RuntimeStrip,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
