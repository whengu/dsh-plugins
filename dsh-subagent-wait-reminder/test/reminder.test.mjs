/**
 * Behaviour tests for dsh-subagent-wait-reminder.
 *
 * The plugin exposes one seam: `apply(ctx)`. It registers a `tools/post-execute`
 * waterfall and an `agent/pre-step` hook; classification, the per-step latch and
 * the reminder text stay internal. Every test therefore drives the registered
 * listeners the way the registry does — stub context, synthetic executions,
 * results and agents, a `next()` whose answer the test owns — and asserts on the
 * decision the listener returns.
 *
 * What this proves: the plugin's own logic (wiring, classification, the isError
 * skip, the rename fallback, the per-step latch, and the shape of what it
 * injects). What it does NOT prove: that the live runtime delivers these events
 * with these payloads, or that the session log accepts this message shape. That
 * contract is documented in README「机制」 and was checked in a real session; it
 * is not covered here.
 *
 * Node built-ins only (node:test + node:assert), no third-party framework.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { apply } from "../lib/index.js";

/** The only two events this plugin may use (both waterfalls; payloads in README). */
const POST_EXECUTE = "tools/post-execute";
const PRE_STEP = "agent/pre-step";

/** Accept-variant post-tool decision: what `next()` resolves to for an ordinary call. */
function accept(extra = {}) {
  return { kind: "accept", ...extra };
}

/**
 * A cordis-shaped plugin context.
 *
 * `on` records listeners and returns a disposer, like the real context does.
 * `effect` exists on every real context but this plugin never calls it; it is
 * recorded so that "no disposables are registered" is observed, not assumed.
 */
function createContext() {
  const listeners = new Map();
  const effects = [];
  return {
    effects,
    on(event, listener) {
      assert.equal(typeof listener, "function", `监听器必须是函数：${event}`);
      const bucket = listeners.get(event);
      if (bucket === undefined) listeners.set(event, [listener]);
      else bucket.push(listener);
      return () => {
        const registered = listeners.get(event) ?? [];
        const at = registered.indexOf(listener);
        if (at >= 0) registered.splice(at, 1);
      };
    },
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
    /** Registered event names, in registration order. */
    events() {
      return [...listeners.keys()];
    },
    /** The single listener for `event`: more than one would double every reminder. */
    listenerOf(event) {
      const bucket = listeners.get(event);
      assert.ok(bucket !== undefined && bucket.length > 0, `未注册监听器：${event}`);
      assert.equal(bucket.length, 1, `${event} 应只注册一个监听器，实际 ${bucket.length}`);
      return bucket[0];
    },
  };
}

/** Two distinct agents: the latch is keyed by agent identity, not by name. */
const AGENT_A = { id: "agent-a" };
const AGENT_B = { id: "agent-b" };

let callSeq = 0;

/** One completed tool call (`ToolExecution`): name plus the optional caller agent. */
function exec(name, agent = AGENT_A, extra = {}) {
  callSeq += 1;
  return {
    callId: `call-${callSeq}`,
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
    ...extra,
  };
}

/** `agent` is optional on the real type, so a call may omit the property entirely. */
function execWithoutAgent(name) {
  const call = exec(name);
  delete call.agent;
  return call;
}

/** A successful result whose content is one text block. */
function okText(text, extra = {}) {
  return { isError: false, value: null, content: [{ type: "text", text }], ...extra };
}

/** The dispatch tool's fixed render: `started subagent <id>`. */
function startedSubagent(id = "sub-1") {
  return okText(`started subagent ${id}`);
}

/** A failed call (`ToolExecutionFailure`): content channel unchanged, isError true. */
function failed(text, extra = {}) {
  return {
    isError: true,
    error: { message: "tool call failed" },
    content: [{ type: "text", text }],
    ...extra,
  };
}

/**
 * Apply the plugin to a fresh stub context and expose both waterfalls.
 *
 * Each test mounts its own instance: the latch is created per `apply` call, so
 * no state can leak between tests.
 */
function mount() {
  const ctx = createContext();
  apply(ctx);
  const postExecute = ctx.listenerOf(POST_EXECUTE);
  const preStep = ctx.listenerOf(PRE_STEP);
  let step = 0;

  return {
    ctx,
    /**
     * Drive one completed call through the waterfall.
     * @returns the decision produced and how often the listener called `next`.
     */
    async run(call, result, downstream = accept()) {
      let nextCalls = 0;
      const decision = await postExecute(call, result, () => {
        nextCalls += 1;
        return Promise.resolve(downstream);
      });
      return { decision, nextCalls, downstream };
    },
    /**
     * Drive one step boundary for `agent` (payload shape from the event signature).
     * @returns the pre-step decision and the answer `next()` handed back.
     */
    async beginStep(agent) {
      step += 1;
      const entered = { kind: "enter", messages: [] };
      let nextCalls = 0;
      const decision = await preStep(
        {
          agent,
          messages: [],
          turn: 1,
          step,
          signal: new AbortController().signal,
          modelSelection: {},
        },
        () => {
          nextCalls += 1;
          return Promise.resolve(entered);
        },
      );
      return { decision, nextCalls, entered };
    },
  };
}

/** The contexts the listener injected; an untouched downstream carries none. */
function injected(decision) {
  const contexts = decision?.additionalContexts;
  if (contexts === undefined) return [];
  assert.ok(Array.isArray(contexts), "additionalContexts 必须是数组");
  return contexts;
}

/** The reminder text carried by one injected user message. */
function reminderText(message) {
  assert.equal(message.role, "user", "提醒必须是 user 角色消息");
  assert.ok(Array.isArray(message.content), "消息 content 必须是数组");
  const blocks = message.content.filter((block) => block?.type === "text");
  assert.ok(blocks.length > 0, "提醒必须含至少一个 text 块");
  return blocks.map((block) => block.text).join("\n");
}

/** Wording constraints from the requirement, asserted rather than assumed. */
function assertDispatchReminder(message) {
  const text = reminderText(message);
  assert.ok(text.startsWith("<system-reminder>"), `提醒必须以 <system-reminder> 开头：${text}`);
  for (const marker of ["你刚派发了子智能体", "与是否查询无关", "避免用 list_agents", "interrupt_agent"]) {
    assert.ok(text.includes(marker), `派发提醒必须包含「${marker}」，实际：${text}`);
  }
  assert.equal(text.includes("禁止"), false, "提醒不得用「禁止」（需求：对 list_agents 用「避免」）");
  assert.equal(message.source.kind, "subagent-wait-reminder");
  assert.equal(message.source.form, "notice");
  assert.match(message.source.summary, /dispatch/);
}

function assertPollReminder(message) {
  const text = reminderText(message);
  assert.ok(text.startsWith("<system-reminder>"), `提醒必须以 <system-reminder> 开头：${text}`);
  for (const marker of ["你刚查询了子智能体状态", "与是否查询无关", "避免再次查询"]) {
    assert.ok(text.includes(marker), `轮询提醒必须包含「${marker}」，实际：${text}`);
  }
  assert.equal(text.includes("禁止"), false, "提醒不得用「禁止」（需求：对 list_agents 用「避免」）");
  assert.equal(message.source.kind, "subagent-wait-reminder");
  assert.equal(message.source.form, "notice");
  assert.match(message.source.summary, /poll/);
}

// --- wiring --------------------------------------------------------------

test("wiring: registers the two waterfall hooks and nothing that intercepts calls", () => {
  const ctx = createContext();
  apply(ctx);
  assert.deepEqual(
    ctx.events().sort(),
    [PRE_STEP, POST_EXECUTE].sort(),
    "只允许这两个事件：任何 tools/pre-execute / tools/guard 都会拦截调用，与需求冲突",
  );
  ctx.listenerOf(POST_EXECUTE);
  ctx.listenerOf(PRE_STEP);
  assert.deepEqual(ctx.effects, [], "插件不持有需要释放的资源，不应注册 effect");
});

test("waterfall: next() is reached exactly once for every call, watched or not", async () => {
  const p = mount();
  const cases = [
    ["watched success", exec("subagent"), startedSubagent()],
    ["unwatched tool", exec("read_file"), okText("file body")],
    ["failed watched call", exec("list_agents"), failed("denied")],
    ["call without an agent", execWithoutAgent("subagent"), startedSubagent()],
  ];
  for (const [label, call, result] of cases) {
    const { nextCalls } = await p.run(call, result);
    assert.equal(nextCalls, 1, `${label}: 必须恰好调用一次 next()，否则整条瀑布被吞掉`);
  }
});

// --- dispatch detection --------------------------------------------------

test("dispatch: a successful subagent call injects one dispatch reminder", async () => {
  const p = mount();
  const { decision, nextCalls } = await p.run(exec("subagent"), startedSubagent("sub-1"));

  assert.equal(nextCalls, 1);
  const contexts = injected(decision);
  assert.equal(contexts.length, 1, "一次派发只注入一条提醒");
  assertDispatchReminder(contexts[0]);
  assert.equal(decision.kind, "accept", "下游的 accept 变体必须保留");
});

test("dispatch: subagent_fork is the same action as subagent", async () => {
  const p = mount();
  const { decision } = await p.run(exec("subagent_fork"), startedSubagent("sub-fork"));
  const contexts = injected(decision);
  assert.equal(contexts.length, 1);
  assertDispatchReminder(contexts[0]);
});

test("rename fallback: an unknown tool name with the fixed render text counts as a dispatch", async () => {
  const p = mount();
  const { decision } = await p.run(exec("delegate_task"), startedSubagent("sub-renamed"));
  const contexts = injected(decision);
  assert.equal(contexts.length, 1, "派发工具改名后仍须靠固定返回文本命中");
  assertDispatchReminder(contexts[0]);
});

test("rename fallback: only text blocks are scanned for the render prefix", async () => {
  const p = mount();
  // Shaped after the declared ImageBlock arm; only `type` matters to the filter.
  const imageOnly = {
    isError: false,
    value: null,
    content: [{ type: "image", attachment: { id: "attachment-1" } }],
  };
  const noText = await p.run(exec("delegate_task"), imageOnly);
  assert.deepEqual(injected(noText.decision), [], "没有 text 块就没有可匹配的渲染文本");

  const mixed = {
    isError: false,
    value: null,
    content: [
      { type: "image", attachment: { id: "attachment-1" } },
      { type: "text", text: "started subagent sub-mixed" },
    ],
  };
  const withText = await p.run(exec("delegate_task"), mixed);
  const contexts = injected(withText.decision);
  assert.equal(contexts.length, 1, "混在非 text 块之间的渲染文本仍须命中");
  assertDispatchReminder(contexts[0]);
});

test("rename fallback: a prefix that is not at the start of the text does not count", async () => {
  const p = mount();
  for (const text of ["note: started subagent sub-5", "started subagent"]) {
    const { decision } = await p.run(exec("read_file"), okText(text));
    assert.deepEqual(injected(decision), [], `「${text}」不是固定渲染文本，不应命中`);
  }
});

test("failed calls: isError skips the reminder for every watched action", async (t) => {
  const cases = [
    { label: "subagent", name: "subagent" },
    { label: "subagent_fork", name: "subagent_fork" },
    // Even a failure whose text looks like the render must be skipped: no child is running.
    { label: "renamed dispatch tool whose failure text starts with the render prefix", name: "delegate_task" },
  ];
  for (const c of cases) {
    await t.test(c.label, async () => {
      const p = mount();
      const { decision, nextCalls } = await p.run(exec(c.name), failed("started subagent never-happened"));
      assert.equal(nextCalls, 1);
      assert.deepEqual(injected(decision), [], "失败/被拒的调用没有子智能体在跑，不得注入提醒");
      assert.equal(decision.kind, "accept");
    });
  }
});

test("a call with no caller agent injects nothing and does not throw", async () => {
  const p = mount();
  const { decision, nextCalls } = await p.run(execWithoutAgent("subagent"), startedSubagent());
  assert.equal(nextCalls, 1);
  assert.deepEqual(injected(decision), [], "没有 agent 就没有可提醒的对象");
  assert.equal(decision.kind, "accept");
});

// --- poll detection ------------------------------------------------------

test("poll: a successful list_agents call injects one poll reminder", async () => {
  const p = mount();
  const { decision } = await p.run(exec("list_agents"), okText("sub-1: running"));
  const contexts = injected(decision);
  assert.equal(contexts.length, 1);
  assertPollReminder(contexts[0]);
});

test("unrelated tools: the downstream decision is returned untouched", async () => {
  const p = mount();
  const downstream = accept({ content: [{ type: "text", text: "file body" }] });
  const { decision } = await p.run(exec("read_file"), okText("file body"), downstream);
  assert.equal(decision, downstream, "无关工具必须原样返回下游决策（同一引用，不克隆）");
});

// --- the per-step latch --------------------------------------------------

test("step latch: a fan-out of three dispatches in one step is reminded once", async () => {
  const p = mount();
  const first = await p.run(exec("subagent"), startedSubagent("sub-a"));
  assert.equal(injected(first.decision).length, 1, "本步第一次派发必须提醒");

  for (const id of ["sub-b", "sub-c"]) {
    const later = await p.run(exec("subagent"), startedSubagent(id));
    assert.equal(injected(later.decision).length, 0, `同一 step 内第 N 个派发（${id}）不得重复提醒`);
    assert.equal(later.nextCalls, 1, "去重不得跳过下游瀑布");
  }
});

test("step latch: both dispatch tool names share one latch", async () => {
  const p = mount();
  const canonical = await p.run(exec("subagent"), startedSubagent("sub-a"));
  const forked = await p.run(exec("subagent_fork"), startedSubagent("sub-b"));
  const renamed = await p.run(exec("delegate_task"), startedSubagent("sub-c"));

  assert.equal(injected(canonical.decision).length, 1, "第一次派发提醒");
  assert.equal(injected(forked.decision).length, 0, "subagent_fork 与 subagent 是同一类动作");
  assert.equal(injected(renamed.decision).length, 0, "文本兜底命中的也是同一类动作");
});

test("step latch: agent/pre-step re-arms the reminder for the next step", async () => {
  const p = mount();
  const stepOne = await p.run(exec("subagent"), startedSubagent("sub-a"));
  assert.equal(injected(stepOne.decision).length, 1);

  const boundary = await p.beginStep(AGENT_A);
  assert.equal(boundary.nextCalls, 1, "pre-step 也必须走完瀑布");

  const stepTwo = await p.run(exec("subagent"), startedSubagent("sub-b"));
  assert.equal(injected(stepTwo.decision).length, 1, "新 step 必须重新提醒");

  await p.beginStep(AGENT_A);
  const stepThree = await p.run(exec("subagent"), startedSubagent("sub-c"));
  assert.equal(injected(stepThree.decision).length, 1, "连续跨步，每一步都重新提醒");
});

test("step latch: the latch is per agent, not global", async () => {
  const p = mount();
  const a = await p.run(exec("subagent", AGENT_A), startedSubagent("sub-a"));
  const b = await p.run(exec("subagent", AGENT_B), startedSubagent("sub-b"));
  const aAgain = await p.run(exec("subagent", AGENT_A), startedSubagent("sub-a2"));

  assert.equal(injected(a.decision).length, 1);
  assert.equal(injected(b.decision).length, 1, "另一个 agent 的同类动作有自己的闩");
  assert.equal(injected(aAgain.decision).length, 0, "回到第一个 agent，闩仍然有效");
});

test("step latch: another agent's step boundary does not re-arm this agent", async () => {
  const p = mount();
  await p.run(exec("subagent", AGENT_A), startedSubagent("sub-a"));
  await p.beginStep(AGENT_B);
  const again = await p.run(exec("subagent", AGENT_A), startedSubagent("sub-a2"));
  assert.equal(injected(again.decision).length, 0, "pre-step 只能清它自己那个 agent 的闩");
});

test("step latch: dispatch and poll are latched separately", async () => {
  const p = mount();
  const dispatch = await p.run(exec("subagent"), startedSubagent("sub-1"));
  const poll = await p.run(exec("list_agents"), okText("sub-1: running"));
  const dispatchAgain = await p.run(exec("subagent"), startedSubagent("sub-2"));
  const pollAgain = await p.run(exec("list_agents"), okText("sub-1: running"));

  assert.equal(injected(dispatch.decision).length, 1);
  assert.equal(injected(poll.decision).length, 1, "一类动作的闩不得压掉另一类");
  assert.equal(injected(dispatchAgain.decision).length, 0);
  assert.equal(injected(pollAgain.decision).length, 0);
});

test("step latch: repeated polls in one step are reminded once", async () => {
  const p = mount();
  const first = await p.run(exec("list_agents"), okText("sub-1: running"));
  const second = await p.run(exec("list_agents"), okText("sub-1: still running"));
  assert.equal(injected(first.decision).length, 1);
  assert.equal(injected(second.decision).length, 0);
});

// --- decision shape ------------------------------------------------------

test("decision shape: the injected message is a user notice with a stable source", async () => {
  const p = mount();
  const dispatch = await p.run(exec("subagent"), startedSubagent("sub-1"));
  const poll = await p.run(exec("list_agents"), okText("sub-1: running"));
  const [dispatchMessage] = injected(dispatch.decision);
  const [pollMessage] = injected(poll.decision);

  for (const message of [dispatchMessage, pollMessage]) {
    assert.equal(message.role, "user");
    assert.equal(typeof message.id, "string", "消息必须带 id");
    assert.ok(message.id.length > 0, "消息 id 不能为空");
    assert.equal(message.source.kind, "subagent-wait-reminder");
    assert.equal(message.source.form, "notice", "form 必须是运行时词汇 notice");
    assert.equal(typeof message.source.summary, "string");
  }

  assert.notEqual(dispatchMessage.id, pollMessage.id, "两条消息必须是不同消息");
  assert.notEqual(dispatchMessage.source.summary, pollMessage.source.summary, "summary 应指明是哪类动作");
});

test("decision shape: existing downstream contexts are kept after the reminder", async () => {
  const p = mount();
  const existing = {
    id: "downstream-context-1",
    role: "user",
    content: [{ type: "text", text: "context added downstream" }],
    source: { kind: "some-other-plugin" },
  };
  const downstreamContent = [{ type: "text", text: "started subagent sub-1" }];
  const downstream = accept({ content: downstreamContent, additionalContexts: [existing] });

  const { decision } = await p.run(exec("subagent"), startedSubagent("sub-1"), downstream);
  const contexts = injected(decision);

  assert.equal(decision.kind, "accept");
  assert.deepEqual(decision.content, downstreamContent, "下游 content 必须保留");
  assert.equal(contexts.length, 2, "提醒 + 下游已有 context");
  assert.equal(contexts[0].source.kind, "subagent-wait-reminder", "提醒排在下游 context 之前");
  assert.equal(contexts[1], existing, "下游 context 原样保留（同一引用）");
  assert.deepEqual(
    downstream.additionalContexts,
    [existing],
    "下游决策本身不得被修改：注册表可能还在别处持有它",
  );
});

test("decision shape: a non-accept downstream decision keeps its variant and fields", async () => {
  const p = mount();
  const feedback = [{ type: "text", text: "blocked by policy" }];
  const downstream = { kind: "block", feedback };

  const { decision } = await p.run(exec("subagent"), startedSubagent("sub-1"), downstream);
  assert.equal(decision.kind, "block", "不得把 block 决策改写成 accept");
  assert.deepEqual(decision.feedback, feedback, "block 变体的 feedback 必须保留");
  assert.equal(injected(decision).length, 1);
});

test("pre-step: the runtime decision is passed through unchanged", async () => {
  const p = mount();
  const { decision, nextCalls, entered } = await p.beginStep(AGENT_A);
  assert.equal(nextCalls, 1, "pre-step 必须调用一次 next()");
  assert.equal(decision, entered, "必须原样返回运行时决策，否则整个 agent loop 的入口被改写");
});
