/**
 * Static profile plugin for dsh (not a cordis dynamic package's host half).
 *
 * It imports `node:crypto`, so it must be installed as a normal profile
 * dependency and activated by an entry in the profile's `cordis.patch.yml`;
 * dynamic packages run where Node built-ins are unavailable.
 *
 * Problem: after a `subagent` dispatch the parent's tool result is the bare
 * text `started subagent <id>` — a dead end. The completion notice is
 * reliable, but nothing at the decision point tells the model to wait for it,
 * so it reaches for `list_agents` to feel like it is making progress.
 *
 * Fix: on the step boundary after either watched action — creating a subagent
 * (`subagent` / `subagent_fork`) or checking status (`list_agents`) — deliver
 * one reminder telling the model to wait for the completion notice instead of
 * polling.
 *
 * Mechanism, verified against the runtime this targets (dsh 0.2.1-rc.5):
 *
 *   - `tools/post-execute` is a waterfall over every completed call
 *     (event signature in api-catalog:4476-4482). It fires once per actual
 *     execution, so no per-call de-duplication state is needed.
 *   - A `PostToolDecision` may carry `additionalContexts: UserMessage[]`
 *     (api-catalog:6384). The registry merges them onto the result
 *     (dsh-tools:3601-3626); the loop accepts each at the step boundary
 *     (`acceptContext`, documented in dsh-agent-loop:504, consumed :572), so
 *     the reminder is present in the model's next request.
 *   - `agent/pre-step` is NOT usable for detection: its payload is
 *     `messages: UserMessage[]` taken from `inbox.claim()` — inbound user
 *     traffic (api-catalog:4006, :6424; dsh-agent-loop:906-912). `tool-call`
 *     blocks live in AssistantMessage and results in `role: 'tool'`, so
 *     neither can appear there. The canonical reminder plugin detects in
 *     post-execute and uses the pre-step batch only to spot real user input
 *     (dsh-repeat-tool-reminder lib/index.js:2247-2264).
 *
 * Detection is by tool name, with one fallback: the dispatch tool's fixed
 * result render survives a reconfigured `toolName`. `list_agents` has no such
 * fallback — a renamed status tool is not detected (known limitation).
 *
 * Scope: listeners bind to the root context, so a subagent that dispatches or
 * polls its own children gets the same reminder. That is intentional: the
 * anti-polling rule applies to any agent orchestrating children.
 *
 * Zero runtime dependencies beyond `node:crypto`.
 *
 * @module dsh-subagent-wait-reminder
 */

import { randomUUID } from 'node:crypto'

/** Stable plugin id for the Loader row. */
export const name = 'subagent-wait-reminder'

/** Source tag for injected messages; `form: 'notice'` is the runtime vocabulary. */
const REMINDER_SOURCE = { kind: 'subagent-wait-reminder' }

/** Tools whose completion injects the dispatch reminder (`subagent` is the delegation default). */
const DISPATCH_TOOLS = new Set(['subagent', 'subagent_fork'])

/** The status-query tool whose call injects the poll reminder. */
const POLL_TOOLS = new Set(['list_agents'])

/** Fixed render of a successful dispatch (`started subagent <id>`), the rename fallback. */
const DISPATCH_RENDER_PREFIX = 'started subagent '

const DISPATCH_REMINDER = [
  '<system-reminder>',
  '你刚派发了子智能体。子智能体完成时，系统会主动把完成通知送进本会话——通知与是否查询无关，不需要任何查询来触发。',
  '避免用 list_agents 查看运行中状态，不要反复确认它是否还在跑。',
  '等待期间继续做独立工作；没有独立工作就结束本轮，收到通知后再继续。',
  '只有需要中止时才用 interrupt_agent。',
  '</system-reminder>',
].join('\n')

const POLL_REMINDER = [
  '<system-reminder>',
  '你刚查询了子智能体状态。查询到的运行中状态不改变你要做的事：等系统送达的完成通知。',
  '完成通知由系统在子智能体结束时主动送达，与是否查询无关；重复查询不会加速它结束。',
  '避免再次查询——继续做独立工作，没有独立工作就结束本轮。',
  '</system-reminder>',
].join('\n')

/**
 * Build one frozen reminder message.
 *
 * The shape mirrors what the runtime's own factory produces (`role: 'user'`,
 * text content blocks, a producer-named source). Frozen here because context
 * messages are published to the session log.
 *
 * @param action - which watched action triggered this reminder.
 * @returns a user-role message carrying the reminder text.
 */
function reminderMessage(action) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([
      Object.freeze({ type: 'text', text: action === 'dispatch' ? DISPATCH_REMINDER : POLL_REMINDER }),
    ]),
    source: Object.freeze({
      ...REMINDER_SOURCE,
      form: 'notice',
      summary: action === 'dispatch'
        ? 'subagent dispatch: wait for the completion notice'
        : 'subagent status poll: avoid repeating it',
    }),
  })
}

/**
 * Classify one completed call, or return null when it is not a watched action.
 *
 * Failed or denied calls carry no live child to wait for, so they get no
 * reminder; denied calls still flow through this waterfall.
 *
 * @param exec - the tool execution (carries `name`, `agent`).
 * @param result - the tool result (carries `content`, `isError`).
 * @returns 'dispatch' | 'poll' | null.
 */
function classify(exec, result) {
  if (result.isError === true) return null
  if (DISPATCH_TOOLS.has(exec.name)) return 'dispatch'
  if (POLL_TOOLS.has(exec.name)) return 'poll'
  // Rename fallback: only the dispatch tool renders this fixed text.
  const text = (result.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  return text.startsWith(DISPATCH_RENDER_PREFIX) ? 'dispatch' : null
}

/**
 * Register the listeners.
 *
 * De-duplication is per step and per action kind: a step that fans out five
 * children gets one reminder, not five identical ones. `tools/post-execute`
 * fires once per execution and carries no step identity, so the latch is
 * cleared at `agent/pre-step`. Pre-step is used here only to reset state —
 * never to detect calls, whose records cannot appear in its payload (see the
 * header note).
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /** Action kinds already announced for an agent within its current step. */
  const latched = new WeakMap()

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const action = exec.agent === void 0 ? null : classify(exec, result)
    const downstream = await next()
    if (action === null) return downstream
    const agent = exec.agent
    let held = latched.get(agent)
    if (held === void 0) {
      held = new Set()
      latched.set(agent, held)
    }
    if (held.has(action)) return downstream
    held.add(action)
    return {
      ...downstream,
      additionalContexts: [reminderMessage(action), ...downstream.additionalContexts ?? []],
    }
  })

  // Each step boundary begins a fresh step: allow one reminder per action again.
  ctx.on('agent/pre-step', ({ agent }, next) => {
    latched.delete(agent)
    return next()
  })
}
