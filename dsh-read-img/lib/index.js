/**
 * dsh-read-img — one tool that reads a local image file with an external
 * OpenAI-compatible vision model.
 *
 * The deployed chat models are text-only. When the agent takes a screenshot or
 * is handed an image path, this tool is how it learns what the picture
 * contains. Nothing else is registered: no prompt rewriting, no message hooks,
 * no bridge, no UI.
 */

import { createHash } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { LruCache } from "./cache.js";
import { readImageFile, toTarget } from "./image.js";
import { callVision } from "./vision.js";
import { installToolHider } from "./hide-tools.js";

export const name = "dsh-read-img";

/** Tool name exposed to the model. */
export const TOOL_NAME = "read_img";

/** Defaults; `Config` and `normalizeConfig` both derive from this object. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  baseURL: "http://frps:18080/llm-router-buss/v1",
  apiKey: "",
  model: "group/vision",
  maxTokens: 20_000,
  timeoutMs: 120_000,
  maxImageBytes: 10 * 1024 * 1024,
  thinking: false,
  hideTools: ["read_image"],
  prompt: "详细描述这张图片的内容；如果图中有文字，逐字转录。",
});

/** Longest accepted question, in characters. Bounds both prompt and cache key. */
export const MAX_QUESTION_CHARS = 1_000;

/** Entries kept in the answer cache. */
export const CACHE_LIMIT = 64;

/** Runtime schema for the read-img row. */
export const Config = z.object({
  /** Master switch; false registers no tool at all. */
  enabled: z.boolean().default(DEFAULTS.enabled),
  /** OpenAI-compatible base URL. The plugin appends `/chat/completions`. */
  baseURL: z.string().default(DEFAULTS.baseURL),
  /** API key sent as `Authorization: Bearer`; empty sends no auth header. */
  apiKey: z.string().default(DEFAULTS.apiKey).role("secret"),
  /** Vision model id served by that endpoint. */
  model: z.string().default(DEFAULTS.model),
  /** Max output tokens for one answer. */
  maxTokens: z.number().default(DEFAULTS.maxTokens),
  /** Per-request deadline in milliseconds. */
  timeoutMs: z.number().default(DEFAULTS.timeoutMs),
  /** Largest local image accepted, in bytes. */
  maxImageBytes: z.number().default(DEFAULTS.maxImageBytes),
  /**
   * Whether the vision model may think before answering. Off by default: the
   * description task does not need reasoning, and thinking eats the output
   * budget (and can return empty content when maxTokens runs out).
   */
  thinking: z.boolean().default(DEFAULTS.thinking),
  /** Tool names kept out of the model's declarations and refused if called. */
  hideTools: z.array(z.string()).default(DEFAULTS.hideTools),
  /** Instruction used when the caller supplies no question. */
  prompt: z.string().default(DEFAULTS.prompt),
});

/**
 * Fill defaults once, so the tool never sees a half-populated config.
 * @param {Record<string, unknown> | undefined} config
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(config) {
  const raw = config ?? {};
  const pick = (key) => (raw[key] === undefined ? DEFAULTS[key] : raw[key]);
  const normalized = {
    enabled: pick("enabled") !== false,
    baseURL: String(pick("baseURL")),
    apiKey: String(pick("apiKey")),
    model: String(pick("model")),
    maxTokens: Number(pick("maxTokens")),
    timeoutMs: Number(pick("timeoutMs")),
    maxImageBytes: Number(pick("maxImageBytes")),
    thinking: pick("thinking") === true,
    hideTools: Array.isArray(raw.hideTools) ? raw.hideTools.filter((n) => typeof n === "string" && n.length > 0) : DEFAULTS.hideTools,
    prompt: String(pick("prompt")),
  };
  assertPositive(normalized.maxTokens, "maxTokens");
  assertPositive(normalized.timeoutMs, "timeoutMs");
  assertPositive(normalized.maxImageBytes, "maxImageBytes");
  if (normalized.model.trim().length === 0) throw new Error("read-img: model 不能为空");
  if (normalized.baseURL.trim().length === 0) throw new Error("read-img: baseURL 不能为空");
  return normalized;
}

/** @param {number} value @param {string} field */
function assertPositive(value, field) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`read-img: ${field} 必须是正数`);
}

/** Cache key for a local image: content hash, so re-encoded paths share an entry. */
function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the reader. Separated from `apply` so tests can drive it without cordis.
 * @param {object} deps
 * @param {() => ReturnType<typeof normalizeConfig>} deps.getConfig
 * @param {LruCache} deps.cache
 * @param {typeof fetch} [deps.fetchImpl] - injectable for tests.
 * @param {(filePath: string, maxBytes: number) => Promise<{ bytes: Buffer, mime: string }>} [deps.readFileImpl]
 * @returns {(args: { path?: unknown, question?: unknown }, exec?: { signal?: AbortSignal, agent?: any }) => Promise<string>}
 */
export function createReader({ getConfig, cache, fetchImpl, readFileImpl }) {
  const readFile = readFileImpl ?? readImageFile;

  return async function read(args, exec) {
    const config = getConfig();
    const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
    const target = toTarget(args?.path, cwd);
    const rawQuestion = typeof args?.question === "string" ? args.question.trim() : "";
    const question = rawQuestion.slice(0, MAX_QUESTION_CHARS);

    if (target.kind === "url") {
      const cacheKey = `url\u0000${target.url}\u0000${question}`;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
      const answer = await callVision(config, target.url, question, exec?.signal, fetchImpl);
      cache.set(cacheKey, answer);
      return answer;
    }

    const { bytes, mime } = await readFile(target.path, config.maxImageBytes);
    const cacheKey = `file\u0000${digestOf(bytes)}\u0000${question}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return `${cached}\n\n(image: ${target.path})`;

    const imageUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    const answer = await callVision(config, imageUrl, question, exec?.signal, fetchImpl);
    // Cache the model answer only: the path suffix is per-call, so the same
    // bytes reached through two different paths still report the path asked for.
    cache.set(cacheKey, answer);
    return `${answer}\n\n(image: ${target.path})`;
  };
}

/**
 * Register the single tool.
 * @param {any} ctx - cordis context carrying the `tools` service.
 * @param {() => ReturnType<typeof normalizeConfig>} getConfig
 */
export function registerReadImg(ctx, getConfig) {
  const cache = new LruCache(CACHE_LIMIT);
  const read = createReader({ getConfig, cache });

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        "Read a local image file (or an http(s) image URL) with an external vision model and return what it shows as text. " +
        "Use it whenever you need to see a screenshot, photo, diagram or scanned page — for example right after a browser or " +
        "desktop tool saved a screenshot to a path. The chat model itself cannot view images; this tool is how it learns the content. " +
        "Accepts absolute paths, paths relative to the session working directory, and file:// or http(s) URLs. " +
        "PNG, JPEG, WebP, GIF and BMP are supported.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description:
            "Image to read: an absolute path, a path relative to the session working directory, or a file:// or http(s) URL.",
        },
        question: {
          type: "string",
          description:
            'What to ask about the image, e.g. "读出这个报错弹窗的全部文字" or "这个按钮在哪个位置". ' +
            "Omit for a full description with any visible text transcribed.",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
      },
      // Harness-side budget sits above the configured fetch deadline so the
      // inner timeout produces the error message the model can act on.
      timeoutMs: getConfig().timeoutMs + 15_000,
      async execute(args, exec) {
        return read(args, exec);
      },
    }),
  );
}

/**
 * Plugin entry.
 * @param {any} ctx
 * @param {Record<string, unknown> | undefined} config
 */
export function apply(ctx, config) {
  const normalized = normalizeConfig(config);
  const getConfig = () => normalized;
  ctx.inject(["tools"], (toolCtx) => {
    if (!getConfig().enabled) return;
    registerReadImg(toolCtx, getConfig);
  });
  ctx.inject(["llm"], (llmCtx) => {
    if (!getConfig().enabled) return;
    installToolHider(llmCtx, getConfig);
  });
}
