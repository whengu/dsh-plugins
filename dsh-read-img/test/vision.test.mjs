import test from "node:test";
import assert from "node:assert/strict";
import { answerText, callVision, requestSignal, VisionError } from "../lib/vision.js";

const CONFIG = {
  baseURL: "http://vision.test/v1/",
  apiKey: "k-123",
  model: "group/vision",
  maxTokens: 128,
  timeoutMs: 5_000,
  thinking: false,
  prompt: "describe it",
};

/** Reply with a JSON body and capture the outgoing request. */
function stubFetch({ status = 200, body = {}, throwError } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throwError !== undefined) throw throwError;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

test("answerText: plain string, content parts, and empty responses", () => {
  assert.equal(answerText({ choices: [{ message: { content: " hi " } }] }), "hi");
  assert.equal(
    answerText({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }),
    "ab",
  );
  assert.throws(
    () => answerText({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
    (error) => error instanceof VisionError && /finish_reason=length/.test(error.message),
  );
  assert.throws(() => answerText({}), /空内容/);
});

test("callVision: builds the OpenAI-compatible request", async () => {
  const { impl, calls } = stubFetch({ body: { choices: [{ message: { content: "a cat" } }] } });
  const answer = await callVision(CONFIG, "data:image/png;base64,AAA", "what is it?", undefined, impl);

  assert.equal(answer, "a cat");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://vision.test/v1/chat/completions"); // trailing slash collapsed
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k-123");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "group/vision");
  assert.equal(body.max_tokens, 128);
  assert.equal(body.messages[0].content[0].text, "what is it?");
  assert.equal(body.messages[0].content[1].image_url.url, "data:image/png;base64,AAA");
});

test("callVision: omits the auth header when no key is configured", async () => {
  const { impl, calls } = stubFetch({ body: { choices: [{ message: { content: "ok" } }] } });
  await callVision({ ...CONFIG, apiKey: "" }, "data:image/png;base64,AAA", "", undefined, impl);
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

test("callVision: falls back to the default prompt for an empty question", async () => {
  const { impl, calls } = stubFetch({ body: { choices: [{ message: { content: "ok" } }] } });
  await callVision(CONFIG, "data:image/png;base64,AAA", "", undefined, impl);
  assert.equal(JSON.parse(calls[0].init.body).messages[0].content[0].text, "describe it");
});

test("callVision: surfaces HTTP errors with status and body", async () => {
  const { impl } = stubFetch({ status: 401, body: { error: "no key" } });
  await assert.rejects(
    callVision(CONFIG, "data:image/png;base64,AAA", "", undefined, impl),
    /HTTP 401.*no key/s,
  );
});

test("callVision: rejects non-JSON responses", async () => {
  const { impl } = stubFetch({ body: "<html>oops</html>" });
  await assert.rejects(callVision(CONFIG, "data:image/png;base64,AAA", "", undefined, impl), /不是 JSON/);
});

test("callVision: reports our own deadline as a timeout", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const { impl } = stubFetch({ throwError: timeout });
  await assert.rejects(
    callVision(CONFIG, "data:image/png;base64,AAA", "", undefined, impl),
    /无法完成对 http:\/\/vision\.test\/v1\/chat\/completions 的请求：超时（上限 5000ms）/,
  );
});

test("callVision: reports caller cancellation as cancelled, not as a timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  const { impl } = stubFetch({ throwError: aborted });
  await assert.rejects(
    callVision(CONFIG, "data:image/png;base64,AAA", "", controller.signal, impl),
    /请求：已取消/,
  );
});

test("callVision: refuses an oversized response before reading it", async () => {
  const impl = async () =>
    new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } });
  await assert.rejects(callVision(CONFIG, "data:image/png;base64,AAA", "", undefined, impl), /响应 5242880 字节/);
});

test("requestSignal: always has a deadline, and honours caller cancellation", () => {
  const deadline = requestSignal(undefined, 10);
  assert.equal(deadline.aborted, false);

  const controller = new AbortController();
  const combined = requestSignal(controller.signal, 60_000);
  assert.equal(combined.aborted, false);
  controller.abort();
  assert.equal(combined.aborted, true);
});

test("callVision: disables thinking by default", async () => {
  const { impl, calls } = stubFetch({ body: { choices: [{ message: { content: "ok" } }] } });
  await callVision(CONFIG, "data:image/png;base64,AAA", "q", undefined, impl);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.max_tokens, 128);
});

test("callVision: leaves the thinking switch out when thinking is enabled", async () => {
  const { impl, calls } = stubFetch({ body: { choices: [{ message: { content: "ok" } }] } });
  await callVision({ ...CONFIG, thinking: true }, "data:image/png;base64,AAA", "q", undefined, impl);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.reasoning_effort, undefined);
});
