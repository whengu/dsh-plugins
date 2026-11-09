/**
 * The one HTTP call this plugin makes: OpenAI-compatible
 * `/chat/completions` with a text part and an `image_url` part.
 */

/** Error whose message is safe to show to the model verbatim. */
export class VisionError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = "VisionError";
  }
}

/**
 * Pull the assistant text out of a chat-completions body.
 * @param {unknown} body
 * @returns {string}
 * @throws {VisionError} when the response carries no usable text.
 */
export function answerText(body) {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (joined.length > 0) return joined;
  }
  const finish = choice?.finish_reason;
  throw new VisionError(
    `read_img: 视觉模型返回了空内容${finish ? `（finish_reason=${finish}）` : ""}；` +
      "检查模型 id、maxTokens 是否足够，或该端点是否支持图片输入。",
  );
}

/**
 * Combine caller cancellation with the per-request deadline.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
export function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Call the vision endpoint once.
 * @param {object} config - normalized plugin config.
 * @param {string} imageUrl - data URL or http(s) URL.
 * @param {string} question - caller question, empty for the default prompt.
 * @param {AbortSignal | undefined} signal
 * @param {typeof fetch} [fetchImpl] - injectable for tests.
 * @returns {Promise<string>}
 */
export async function callVision(config, imageUrl, question, signal, fetchImpl = globalThis.fetch) {
  const base = config.baseURL.replace(/\/+$/, "");
  const endpoint = `${base}/chat/completions`;
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    // Thinking is switched by the vLLM-style template flag. Measured on
    // group/vision: baseline reasons 539 chars; `reasoning_effort: "none"` only
    // shortens that to 265; `chat_template_kwargs.enable_thinking: false` stops
    // it outright (6 completion tokens, empty reasoning_content, ~0.4s).
    // So only the flag that actually works is sent — no decorative parameters.
    ...(config.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question.length > 0 ? question : config.prompt },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  };

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey.length > 0 ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: requestSignal(signal, config.timeoutMs),
    });
  } catch (error) {
    const reason =
      error?.name === "TimeoutError" || error?.name === "AbortError"
        ? `超时或已取消（上限 ${config.timeoutMs}ms）`
        : (error?.message ?? String(error));
    throw new VisionError(`read_img: 无法完成对 ${endpoint} 的请求：${reason}`, { cause: error });
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new VisionError(`read_img: 视觉端点返回 HTTP ${response.status}：${raw.slice(0, 300)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VisionError(`read_img: 视觉端点返回的不是 JSON：${raw.slice(0, 200)}`);
  }
  return answerText(parsed);
}
