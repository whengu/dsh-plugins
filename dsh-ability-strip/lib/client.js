/**
 * dsh-ability-strip — browser half.
 *
 * A thin strip docked under the composer, inside the input bar's own dock. It
 * answers one question: *what does THIS session actually have available?* — as
 * two marks that never merge:
 *
 *   - **skill**  how many human-invocable skills this session sees (`skills/list`)
 *   - **MCP**    whether any MCP server actually connected, judged by whether
 *                `mcp__<server>__*` tools are registered in the live tool registry
 *                (read via this package's own host half over `/api/ability-strip`)
 *
 * The detail panel floats above the page (portalled, fixed) and lists the skills,
 * the connected MCP servers with tool counts, the configured Loader rows, and the
 * profile's enabled bundles. A fault (MCP enabled but zero tools) opens a dialog
 * on its own.
 *
 * Read-only by construction: it calls three read-only Remotes, reads its own host
 * half, and subscribes to that half's change stream. It registers no tool, writes
 * no setting, and changes no content. Nothing here runs on a timer: the stream
 * pushes when the tool registry moves, and a read is issued only in response to
 * something that actually happened (a frame, opening the panel, returning to the
 * tab, or the reader pressing refresh).
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
			idle: "var(--dsw-alias-state-idle-primary)",
			label: "var(--dsw-alias-label-primary)",
			labelSecondary: "var(--dsw-alias-label-secondary)",
			labelTertiary: "var(--dsw-alias-label-tertiary)",
			surface: "var(--dsw-alias-bg-layer-1)",
			surfaceBase: "var(--dsw-alias-bg-base)",
			mask: "var(--dsw-alias-bg-mask-1)",
			border: "var(--dsw-alias-border-l2)",
			primaryFill: "var(--dsw-alias-button-primary-fill)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
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
		 * {@link EVENTS_PATH} and `readTools`.
		 */
		const API_CHANNEL = "/api";

		/**
		 * Endpoint this package's host half owns inside the shared `/api` channel.
		 * Must stay identical to `ROUTE_ENDPOINT` in `lib/index.js`: the host
		 * registers `path: /api/<endpoint>` and `rpc.call` posts to the same pair.
		 */
		const TOOL_ENDPOINT = "ability-strip";

		/**
		 * Endpoint of the host half's registry **change stream** (`ROUTE_EVENTS_ENDPOINT`
		 * there, which this must equal). The host keeps it open and writes one frame
		 * per `tools/change`; the strip answers a frame by re-reading, so the MCP
		 * answer stays live without any timer on this page.
		 */
		const EVENTS_ENDPOINT = "ability-strip/events";

		/**
		 * Change stream as a **document-relative** path.
		 *
		 * `rpc.call` builds `${channel}/${endpoint}` and then slices the leading
		 * slash off, and web routes are document-relative for the same reason: an app
		 * served below a base path would never match a route resolved from "/". The
		 * same slice is applied here deliberately, not for symmetry.
		 */
		const EVENTS_PATH = `${API_CHANNEL}/${EVENTS_ENDPOINT}`.slice(1);

		/** Muted inline text for a pending or absent answer. */
		const MUTED = { fontSize: 11, opacity: 0.55 };

		/** The skill count: tabular figures so the width does not jitter per value. */
		const COUNT = { fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 10 };

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
		 * must not reach `setState`: that would rebuild the row, invalidate the memo,
		 * and repaint for nothing. A change stream can deliver several frames for one
		 * visible change (a tool registration touches several layers), so this is
		 * what keeps a burst of frames from becoming a burst of repaints.
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
			// MCP is the field that changes in practice, and the reason the poll
			// exists: compare the server list, each server's tool count, and the tool
			// names (a rename is visible in the panel).
			const before = previous.tools?.servers ?? [];
			const after = next.tools?.servers ?? [];
			if (before.length !== after.length) return false;
			for (let index = 0; index < before.length; index += 1) {
				if (before[index].server !== after[index].server) return false;
				const prevTools = before[index].tools ?? [];
				const nextTools = after[index].tools ?? [];
				if (prevTools.length !== nextTools.length) return false;
				for (let t = 0; t < prevTools.length; t += 1) {
					if (prevTools[t] !== nextTools[t]) return false;
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
		 * The browser cannot see the tool registry, and that registry is the only
		 * browser-reachable evidence that an MCP server actually connected: a server
		 * that fails to connect registers no `mcp__<server>__*` tools. The host half
		 * of THIS package serves that answer, so no third-party plugin is involved.
		 * @param connection - the client Connection service.
		 * @returns the tool summary, or a diagnostic instead of a throw.
		 */
		async function readTools(connection) {
			if (connection === void 0) return { error: "connection 服务未挂载" };
			try {
				// The same channel/endpoint pair `EVENTS_PATH` is built from.
				// `rpc.call` composes `${channel}/${endpoint}` and slices the leading
				// slash, so `API_CHANNEL` must keep it: "api" alone becomes "pi/..."
				// and misses the route entirely.
				const response = await connection.rpc.call(API_CHANNEL, TOOL_ENDPOINT, void 0);
				if (!response.ok) {
					return { error: `${response.error?.code ?? "unknown"}: ${response.error?.message ?? "连接失败"}` };
				}
				const value = response.value;
				// The host half answers `{ ok, ... }` inside the envelope; a failed
				// registry read arrives here rather than as a transport error.
				if (value?.ok === false) {
					return { error: typeof value.error === "string" ? value.error : "宿主读取工具清单失败" };
				}
				return { servers: value?.servers ?? [], totalTools: value?.totalTools ?? 0 };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Load the strip's whole payload. Blocks fail independently so one missing
		 * Remote never blanks the other group.
		 * @param remote - the client remote service.
		 * @param sessionId - session to read the skill catalog for.
		 * @param connection - the client Connection service (host tool route).
		 * @returns one settled payload for the strip.
		 */
		async function loadAll(remote, sessionId, connection) {
			const [skills, inventory, bundles, tools] = await Promise.all([
				readSkills(remote, sessionId),
				readInventory(remote),
				readBundles(remote),
				readTools(connection),
			]);
			const entries = inventory.snapshot?.entries ?? [];
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
			// The fault dialog opens itself once per fault, and can be re-opened from
			// the MCP mark. `acknowledged` remembers the fault the reader has already
			// seen, so a change stream that keeps reporting the same fault cannot
			// re-nag on every frame.
			const [alertOpen, setAlertOpen] = React.useState(false);
			const acknowledgedFault = React.useRef(void 0);
			// Whether the change stream is currently believed dead.
			//
			// A dead stream is the one failure this row cannot otherwise show: every
			// number would simply freeze at its last value, which reads exactly like
			// "nothing changed" — the blind spot this plugin exists to remove, just
			// moved into its own transport. Set on an `EventSource` error, cleared when
			// the stream comes back, and rendered in both the collapsed row and the
			// detail panel.
			const [pushLost, setPushLost] = React.useState(false);
			// The floating panel is placed from this row's live rect.
			const anchorRef = React.useRef(null);

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
			// In-flight guard. Without it a stream frame arriving while a read is
			// already running would stack a second read on the same Host.
			const inFlight = React.useRef(false);
			// When `run` is called while a read is in flight (session switch, manual
			// refresh, another frame), the caller's result must replace the in-flight
			// one. Without this the in-flight read's result would be written to the
			// new session's state because `requestId` was never incremented. A boolean
			// rather than a queue on purpose: a burst of frames collapses into one
			// compensating read instead of one read per frame.
			const rerunPending = React.useRef(false);

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
						// and schedule a re-read when it settles.
						requestId.current += 1;
						rerunPending.current = true;
						return;
					}
					inFlight.current = true;
					const id = requestId.current + 1;
					requestId.current = id;
					// A silent re-read (a stream frame, returning to the tab, opening the
					// panel) must not flip the strip into its loading state: that would
					// repaint the row and, worse, look like a user-initiated read. Only an
					// explicit refresh shows progress.
					if (options?.silent !== true) {
						// Keep the previous payload while re-reading so a refresh does not
						// blank the strip mid-flight.
						setState((prev) => ({ ...prev, phase: "loading", error: void 0 }));
					}
					try {
						const payload = await loadRef.current(sessionId);
						if (id !== requestId.current) return;
						// A silent re-read that returns exactly what is already on screen
						// must not re-render: the same answer would otherwise rebuild the
						// row, invalidate the memo, and repaint for nothing.
						setState((prev) =>
							options?.silent === true && samePayload(prev.payload, payload)
								? prev
								: { phase: "ready", payload },
						);
					} catch (error) {
						if (id !== requestId.current) return;
						// A thrown load must be visible: the strip exists to remove blind
						// spots, so a silent failure would defeat its only purpose. A failed
						// re-read keeps the last good payload and states the failure.
						setState((prev) => ({ ...prev, phase: "failed", error: describeError(error) }));
					} finally {
						inFlight.current = false;
						// If a call arrived while this read was in flight, run it now.
						if (rerunPending.current) {
							rerunPending.current = false;
							void run(options);
						}
					}
				},
				[sessionId],
			);

			// The stream's frame handler outlives any single `run` closure (a new
			// Session mints a new one), so it reads the current one from a ref instead
			// of forcing the stream to be torn down and reopened on every switch.
			const runRef = React.useRef(run);
			React.useEffect(() => {
				runRef.current = run;
			}, [run]);

			// First read, once per Session.
			React.useEffect(() => {
				void run();
			}, [run, sessionId]);

			// Live, without a timer: the host half holds a change stream open and writes
			// a frame whenever the tool registry moves, so an MCP server dropping or a
			// new tool appearing reaches this row at the moment it happens. There is no
			// interval anywhere — an idle tab with nothing changing costs one open
			// connection and zero requests.
			//
			// DSH's own `ctx.remote.$on` cannot carry this: the forwarded-event
			// allowlist is a closed array inside `dsh-api-remotes` (no `tools/change`),
			// and `typertGateway.registerRemoteEvents` is a single-application slot
			// that bundle already owns. So the signal travels on this package's own
			// route instead — the same owner-only carrier the answer route uses.
			React.useEffect(() => {
				if (sessionId === void 0) return void 0;
				let source;
				// One compensating read per outage. `EventSource` retries a transient
				// drop on its own schedule, so without this flag every retry would also
				// cost a read; with it, an outage costs exactly one.
				let compensated = false;
				/** The stream is (believed) alive again: re-arm the one-shot read. */
				const live = () => {
					compensated = false;
					setPushLost(false);
				};
				const connect = () => {
					source = new EventSource(EVENTS_PATH);
					source.addEventListener("open", live);
					source.addEventListener("message", () => {
						live();
						// A hidden tab has no reader: skip the read and let the visibility
						// handler below pick it up when the reader comes back.
						if (document.visibilityState === "visible") void runRef.current({ silent: true });
					});
					source.addEventListener("error", () => {
						// Either the browser is about to retry (a transient drop) or it has
						// given up for good (a fatal status, which `EventSource` never
						// retries). Both mean this row is no longer being pushed, so say so
						// — and re-read once, because that read is also the evidence that
						// the transport died rather than the registry.
						setPushLost(true);
						if (compensated) return;
						compensated = true;
						if (document.visibilityState === "visible") void runRef.current({ silent: true });
					});
				};
				connect();
				// Returning to the tab reads immediately, and — since a fatal stream
				// failure makes `EventSource` stop retrying altogether — also reopens a
				// stream that is closed. Neither needs a timer: the reader coming back is
				// the event.
				const onVisible = () => {
					if (document.visibilityState !== "visible") return;
					if (source.readyState === EventSource.CLOSED) connect();
					void runRef.current({ silent: true });
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					source.close();
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [sessionId]);

			const payload = state.payload;
			const skillCount = payload?.skills?.entries?.length;
			const mcpRows = payload?.mcpRows ?? [];
			// The answer the whole MCP mark exists for: does at least one MCP server
			// have a tool registered RIGHT NOW? A server that failed to connect
			// registers none, so this is real connectivity, not configuration.
			// Memoized because the dock re-renders on every composer keystroke.
			const connectedServers = React.useMemo(
				() => payload?.tools?.servers ?? [],
				[payload],
			);
			const connected = connectedServers.length > 0;
			// Total MCP tools across all connected servers — the number the chip
			// shows when connected (the icon already says "connected").
			const totalMcpTools = connectedServers.reduce(
				(sum, server) => sum + (server.tools?.length ?? 0),
				0,
			);

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
			const renderSkillChip = () => {
				const skills = payload?.skills;
				let body;
				if (skills?.error !== void 0) body = h(ui.Tag, { tone: "danger" }, "读取失败");
				else if (skillCount === void 0) body = h("span", MUTED, "…");
				else body = h("span", COUNT, String(skillCount));
				return h(
					"span",
					{ style: { display: "flex", alignItems: "center", gap: 3, minWidth: 0 } },
					h(ui.IconSkillOutlineRegular, { size: 12 }),
					h("span", { style: { fontSize: 11, opacity: 0.7 } }, "skill"),
					body,
				);
			};

			const renderMcpChip = () => {
				let body;
				if (payload === void 0) body = h("span", MUTED, "…");
				else if (payload.tools?.error !== void 0)
					body = h(
						"span",
						{ style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)" } },
						"读取失败",
					);
				else
					body = h(
						"span",
						{
							// Colour carries the answer; the word repeats it for anyone who
							// cannot rely on colour alone. A fault is red, not amber: amber
							// reads as "not configured", red as "configured and broken".
							style: {
								display: "flex",
								alignItems: "center",
								gap: 3,
								fontSize: 11,
								color: connected
									? "var(--dsw-alias-state-success-primary)"
									: mcpFault
										? "var(--dsw-alias-state-error-primary)"
										: "var(--dsw-alias-state-warn-primary)",
							},
						},
						h(connected ? ui.IconCheckCircleOutlineRegular : ui.IconCloseOutlineRegular, {
							size: 12,
						}),
						connected ? String(totalMcpTools) : mcpFault ? "连接故障" : "未连接",
					);
				const label = h(
					"span",
					{ style: { display: "flex", alignItems: "center", gap: 3, minWidth: 0 } },
					h(ui.IconGlobeOutlineRegular, { size: 12 }),
					h("span", { style: { fontSize: 11, opacity: 0.7 } }, "MCP"),
					body,
				);
				// A fault is the one case where the mark must be actionable: clicking it
				// re-opens the explanation, so a reader who dismissed the dialog can get
				// it back without hunting for it.
				if (!mcpFault) return label;
				return h(
					"button",
					{
						type: "button",
						onClick: (event) => {
							event.stopPropagation();
							setAlertOpen(true);
						},
						title: "MCP 连接故障：点击查看原因",
						"aria-label": "MCP 连接故障：点击查看原因",
						style: {
							display: "flex",
							alignItems: "center",
							gap: 3,
							minWidth: 0,
							padding: 0,
							border: "none",
							background: "none",
							font: "inherit",
							color: "inherit",
							cursor: "pointer",
						},
					},
					label,
				);
			};

			const skillsSection = (() => {
				// Collapsed, these trees are never mounted, and the dock re-renders on
				// every composer keystroke: skip the work instead of building it unused.
				if (!open || payload === void 0) return null;
				const { skills } = payload;
				return h(
					"div",
					null,
					h(GroupHeading, {
						icon: h(ui.IconSkillOutlineRegular, { size: 13 }),
						name: "技能",
						count: skills.entries?.length,
						note: "本会话可见",
					}),
					skills.error !== void 0
						? h(
								"div",
								{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
								`skills/list 读取失败：${skills.error}`,
							)
						: (skills.entries?.length ?? 0) === 0
							? h(
									"div",
									{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
									"该会话没有可见技能。",
								)
							: skills.entries.map((entry) =>
									h(SkillRow, { key: `${entry.name}:${entry.path ?? ""}`, entry }),
								),
				);
			})();

			const mcpSection = (() => {
				// Collapsed, these trees are never mounted, and the dock re-renders on
				// every composer keystroke: skip the work instead of building it unused.
				if (!open || payload === void 0) return null;
				const { inventory, tools } = payload;
				return h(
					"div",
					null,
					h(GroupHeading, {
						icon: h(ui.IconGlobeOutlineRegular, { size: 13 }),
						name: "MCP",
						count: connectedServers.length,
						note: connected ? `${totalMcpTools} 个工具` : "未连接",
					}),
					// A dead change stream is stated before the numbers it affects, not
					// after: the reader is about to trust them.
					pushLost
						? h(
								"div",
								{
									style: {
										fontSize: 11.5,
										lineHeight: 1.5,
										padding: "4px 0",
										color: "var(--dsw-alias-state-warn-primary)",
									},
								},
								"变更推送已断开：下面这些数字不会再自动更新。点右上角刷新重读，切回标签页也会重读。",
							)
						: null,
					// The connected list is the answer to "does it actually work":
					// these servers have tools registered in the live registry.
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
							: connectedServers.map((server) =>
									h(
										"div",
										{ key: server.server, style: { padding: "3px 0" } },
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
													{
														style: {
															paddingLeft: 19,
															fontSize: 11,
															opacity: 0.55,
															lineHeight: 1.6,
															wordBreak: "break-all",
														},
													},
													server.tools.join("、"),
												)
											: null,
									),
								),
					// Configured rows the Loader carries, shown apart so a configured
					// server with no tools is visible as exactly that.
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
					// The resource plugin decides whether configured servers expose
					// readable resources at all, so its absence is information.
					payload.mcpResources == null
						? null
						: h(
								"div",
								{ style: { fontSize: 11.5, opacity: 0.7, padding: "5px 0 0" } },
								`资源工具：${payload.mcpResources?.enabled ? "已挂载" : "已禁用"}（${rowLabel(payload.mcpResources?.entryId)}）`,
							),
					h(
						"div",
						{ style: { fontSize: 11, opacity: 0.6, lineHeight: 1.5, paddingTop: 5 } },
						"判据是工具注册表里存在 mcp__<server>__* 工具；工具注册表一变，这里就立刻跟着变（宿主主动推送，不定时轮询）。",
						"连不上、或连上但没暴露工具的服务器，都算未连接——两种情况下它的工具都用不了。",
					),
				);
			})();

			const bundlesSection = (() => {
				// Collapsed, these trees are never mounted, and the dock re-renders on
				// every composer keystroke: skip the work instead of building it unused.
				if (!open || payload === void 0) return null;
				// A failed read states its reason like the other two groups; hiding the
				// block would read as "no bundles" and defeat the panel's purpose.
				if (payload.bundles?.error !== void 0) {
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
							`pluginManager/listBundles 读取失败：${payload.bundles?.error}`,
						),
					);
				}
				const enabled = (payload.bundles?.bundles ?? []).filter((bundle) => bundle.enabled);
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
			})();

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
						role: "button",
						tabIndex: 0,
						"aria-expanded": open,
						"aria-label": open ? "收起明细" : "展开明细",
						title: open ? "收起明细" : "明细",
						onClick: () => {
							// Opening the panel is a request for detail, so it reads: the
							// stream already keeps the MCP answer live, but the skill and
							// plugin blocks have no change signal of their own, and this is
							// the one moment the reader asks to see them.
							if (!open) void run({ silent: true });
							setOpen((prev) => !prev);
						},
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
					// Only present while the stream is dead, so the healthy row keeps the
					// width it was measured at: zero cost when nothing is wrong, and an
					// 11 px mark instead of a silent freeze when something is.
					pushLost
						? h(
								"span",
								{
									title: "变更推送已断开：数字不会自动更新，点开明细查看",
									"aria-label": "变更推送已断开",
									style: {
										display: "flex",
										alignItems: "center",
										color: "var(--dsw-alias-state-warn-primary)",
									},
								},
								h(ui.IconWarningOutlineRegular, { size: 11 }),
							)
						: null,
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
								onClose: () => setOpen(false),
								loadedAt: payload.loadedAt,
								loading: state.phase === "loading",
								onRefresh: () => void run(),
								children: [
									h("div", { key: "skills" }, skillsSection),
									h("div", { key: "s1", style: { height: 10 } }),
									h("div", { key: "mcp" }, mcpSection),
									h("div", { key: "s2", style: { height: 10 } }),
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
			// The panel opens upward, so a short viewport is clamped by height rather
			// than pushing its top off screen.
			React.useEffect(() => {
				const place = () => {
					const anchor = anchorRef.current;
					if (anchor === null) return;
					const rect = anchor.getBoundingClientRect();
					const width = Math.min(480, window.innerWidth - 24);
					const left = Math.max(
						12,
						Math.min(
							rect.left + rect.width / 2 - width / 2,
							window.innerWidth - width - 12,
						),
					);
					const maxHeight = Math.max(
						120,
						Math.min(window.innerHeight * 0.6, 420, rect.top - 18),
					);
					setPos({ left, width, maxHeight, bottom: window.innerHeight - rect.top + 6 });
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
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
					role: "dialog",
					"aria-label": "能力明细",
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
							load: (sessionId) => loadAll(remote, sessionId, connection),
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
