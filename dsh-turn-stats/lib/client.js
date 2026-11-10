/**
 * dsh-turn-stats — browser half.
 *
 * Replaces the two composer statistics pills in place, so the same two slots
 * keep their exact position and show the last completed Turn's figures instead
 * of the whole session's. The replacement is the framework's own shadowing
 * mechanism, not a DOM patch: `conversation.composer.dock` is a list slot whose
 * cell key is `options.id`, and an entry that reuses a shipped id joins THAT
 * cell; the renderer sorts a list slot by `priority` ascending and then by
 * `order`, and renders the first live entry of each cell. Two consequences, both
 * read from the runtime rather than assumed:
 *
 *   1. same id + same priority throws at registration
 *      (`list slot "…" already has an entry with id "…"`), and an installed
 *      Client module is NOT auto-assigned a negative priority — only
 *      dynamically registered definitions are. The host's two pills sit at
 *      priority 0, so `priority: -1` is load-bearing: without it this plugin
 *      fails to activate, and with it the winner is ours while `order` 0 and 1
 *      keep the pills in the same order and the same place.
 *   2. returning `null` is not an abdication. Abdication happens when a
 *      component throws, and only then does a cell fall back to the entry it
 *      shadowed. A silent fallback would look like "installed but nothing
 *      changed", so the pills stay honest: no figures, no pill.
 *
 * No Harness Client package is required (practices.md:35): the pill markup, the
 * pill CSS and both formatters are copied from the host and re-owned here, the
 * glyph comes from the sprite the shell already ships, and only `--dsw-alias-*`
 * tokens are referenced. Copying is the sanctioned route; importing the
 * primitives is not, and a component that throws blanks the whole slot entry.
 *
 * Lazy-CJS bundle form: executing this script only registers the factory; every
 * module-body side effect lives inside it.
 */
window.__ModuleLoader__.load({
	id: "dsh-turn-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Locale namespace this plugin owns. */
		const NS = "turnStats";

		/** The Host projection this half reads; see `lib/turn-stats.js`. */
		const PROJECTION_KEY = "turnStats";

		/** Slot and cell identities taken from the shipped entries being shadowed. */
		const SLOT = "conversation.composer.dock";
		const ACTIVITY_ID = "activity";
		const USAGE_ID = "usage";
		/** Below the shipped entries' implicit 0, so each cell resolves to us. */
		const SHADOW_PRIORITY = -1;

		/**
		 * Copied from `@deepseek-ai/dsh-client-ui-chat`'s `StatsPills.module.css`,
		 * with the hashed class prefix replaced by a stable one of ours. Values are
		 * untouched so the pill keeps its metrics; the shipped file's `button.` rules
		 * are dropped because this half renders no button (no dialog in Compact mode).
		 */
		const CSS = ".dshTurnStats-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}.dshTurnStats-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}.dshTurnStats-pill svg{flex:none;width:14px;height:14px}.dshTurnStats-label{text-overflow:ellipsis;min-width:0;overflow:hidden}";
		const CSS_TAG = "dsh-turn-stats/StatsPills.css";
		const css = {
			anchor: "dshTurnStats-anchor",
			pill: "dshTurnStats-pill",
			label: "dshTurnStats-label",
		};

		/** Injected once per document; the shipped packages tag their own style the same way. */
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-turn-stats";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * The shell ships its glyphs as one sprite of `<symbol>` elements whose ids
		 * are `dsw-icon-<name>-<size>`, and every icon component is an `<svg><use>`
		 * into it. Referencing the same symbol is what keeps the glyph identical
		 * without importing the icon package; if a future shell renames or drops a
		 * symbol, the pill renders its text alone rather than a broken box.
		 * @param {string} name - icon name without the `dsw-icon-` prefix.
		 * @returns {string | undefined} a symbol id present in this document.
		 */
		function symbolIdOf(name) {
			if (typeof document === "undefined") return void 0;
			const preferred = `dsw-icon-${name}-regular`;
			if (document.getElementById(preferred) !== null) return preferred;
			const fallback = document.querySelector(`symbol[id^="dsw-icon-${name}-"]`);
			return fallback?.id;
		}

		/**
		 * Decode-throughput figure: whole tokens from ten up, one decimal below.
		 * Copied from the shipped chat package so the same speed reads the same way
		 * here and in the Turn-tail.
		 * @param {number} tps - Tokens per second.
		 * @returns {string} display number without unit.
		 */
		function formatTokensPerSecond(tps) {
			const clamped = Math.max(0, tps);
			return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
		}

		/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
		function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
			const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
			const doubledScale = scale * 2;
			const denominatorQuotient = Math.floor(denominator / doubledScale);
			const denominatorRemainder = denominator % doubledScale;
			let lower = 0;
			let upper = scale;
			while (lower < upper) {
				const candidate = Math.floor((lower + upper + 1) / 2);
				const factor = candidate * 2 - 1;
				if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil((factor * denominatorRemainder) / doubledScale)) lower = candidate;
				else upper = candidate - 1;
			}
			return lower;
		}

		function displayPercentUnits(units, decimalPlaces) {
			if (decimalPlaces === 0) return String(units);
			const whole = Math.floor(units / 10);
			const tenths = units % 10;
			return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
		}

		/**
		 * Display-ready cache-hit share without rounding a partial hit to 100%.
		 * Copied verbatim from the shipped chat package: the honesty rules there
		 * (a 99.97% hit must not read as 100) are arithmetic, not taste, and a
		 * re-implementation would be a second opinion on the same digits.
		 * @param {number} cacheReadTokens - exact prompt tokens served from cache.
		 * @param {number} promptTokens - exact aggregate prompt tokens.
		 * @param {number} [decimalPlaces] - ordinary-ratio precision.
		 * @returns {string | null} percentage text, or null when there was no prompt input.
		 */
		function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
			if (promptTokens === 0) return null;
			const missedInputTokens = promptTokens - cacheReadTokens;
			if (missedInputTokens === 0) return "100";
			const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
			if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
			let distinguishingPlaces = 1;
			let scaledDoubleGap = missedInputTokens * 200;
			const denominatorTens = Math.floor(promptTokens / 10);
			while (scaledDoubleGap <= denominatorTens) {
				scaledDoubleGap *= 10;
				distinguishingPlaces += 1;
			}
			const denominatorOnes = promptTokens % 10;
			let roundedLoss = 5;
			for (let loss = 1; loss < 5; loss += 1) {
				const factor = loss * 2 + 1;
				const threshold = factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10);
				if (scaledDoubleGap <= threshold) {
					roundedLoss = loss;
					break;
				}
			}
			return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
		}

		/**
		 * One pill: the shipped `PlainPill` shape (anchor span → pill span → glyph +
		 * label) with the shipped `data-composer-stat` marker, so anything that finds
		 * these pills by that attribute keeps finding them.
		 *
		 * The shipped pill wraps itself in the primitives `Tooltip` with
		 * `onlyWhenClipped`, which cannot be imported here. The observable contract
		 * — a full reading offered only when the label is actually cut — is kept by
		 * measuring on hover and setting the native title then; the browser's own
		 * delay and the shipped 200 ms one are close enough to be indistinguishable
		 * in use, and nothing appears when the text fits.
		 * @param {{ stat: string, symbol?: string, text: string }} props
		 */
		function Pill({ stat, symbol, text }) {
			return h(
				"span",
				{
					className: css.anchor,
					"data-composer-stat": stat,
					onMouseOver: (event) => {
						const pill = event.currentTarget.querySelector(`.${css.label}`);
						if (pill === null) return;
						if (pill.scrollWidth > pill.clientWidth) pill.setAttribute("title", text);
						else pill.removeAttribute("title");
					},
				},
				h(
					"span",
					{ className: css.pill },
					symbol === void 0 ? null : h("svg", { "data-icon": symbol, "aria-hidden": "true" }, h("use", { href: `#${symbol}` })),
					h("span", { className: css.label }, text),
				),
			);
		}

		/**
		 * Decode speed for the last completed Turn.
		 * @param {{ useProjection: (key: string) => any, t: (key: string, options?: any) => string }} props
		 */
		function ActivityPill({ useProjection, t }) {
			const stats = useProjection(PROJECTION_KEY);
			// `null` is the wire's empty value (the fold has no completed Turn yet);
			// `undefined` covers a snapshot that has not carried the key at all.
			if (stats == null) return null;
			// The same gate the shipped pill uses: a Turn with no decode window has no
			// speed, and 0 tok/s would be a claim, not an absence.
			if (!(stats.decodeMs > 0)) return null;
			const tps = stats.decodeTokens / (stats.decodeMs / 1e3);
			return h(Pill, {
				stat: ACTIVITY_ID,
				symbol: symbolIdOf("gauge-outline"),
				text: t("speed", { tps: formatTokensPerSecond(tps) }),
			});
		}

		/**
		 * Cache-hit share for the last completed Turn.
		 * @param {{ useProjection: (key: string) => any, t: (key: string, options?: any) => string }} props
		 */
		function UsagePill({ useProjection, t }) {
			const stats = useProjection(PROJECTION_KEY);
			if (stats == null) return null;
			const percent = formatCacheHitPercent(stats.cacheReadTokens, stats.billedInputTokens);
			if (percent === null) return null;
			return h(Pill, {
				stat: USAGE_ID,
				symbol: symbolIdOf("database-outline"),
				text: t("cacheHit", { percent }),
			});
		}

		/**
		 * Copy taken from the shipped strings, in this plugin's own namespace, so a
		 * host rename of `message.tokensPerSecond` cannot blank these pills.
		 */
		const DICTIONARIES = {
			zh: {
				title: "本轮统计",
				description: "把输入框下方的速率与缓存命中率改为按本轮统计。",
				speed: "{tps} tok/s",
				cacheHit: "缓存命中 {percent}%",
			},
			en: {
				title: "Per-turn statistics",
				description: "Re-scope the composer speed and cache-hit pills to the current turn.",
				speed: "{tps} tok/s",
				cacheHit: "Cache hit {percent}%",
			},
		};

		/**
		 * Declared services: the slot surface to shadow the pills on, and the locale
		 * surface that turns our dictionary into the `t` seat.
		 */
		const inject = ["slots", "locale"];

		/**
		 * @param {any} ctx - client root context.
		 */
		function apply(ctx) {
			ensureCss();
			// `register` returns the disposer and requires both baseline locales, which
			// is why one call carries the whole dictionary pair.
			ctx.effect(() => ctx.locale.register(NS, DICTIONARIES));
			// A generator so both registrations get their own effect scope: yielding
			// each registration is how the shipped packages register several entries.
			ctx.slots.inject(SLOT, function* () {
				yield ctx.slots.register(
					{
						name: SLOT,
						id: ACTIVITY_ID,
						order: 0,
						priority: SHADOW_PRIORITY,
						locale: NS,
					},
					ActivityPill,
				);
				yield ctx.slots.register(
					{
						name: SLOT,
						id: USAGE_ID,
						order: 1,
						priority: SHADOW_PRIORITY,
						locale: NS,
					},
					UsagePill,
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
