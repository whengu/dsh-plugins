/**
 * Self-check for dsh-auto-continue v0.2. Run via `pnpm check` (or `node scripts/check.mjs`).
 *
 * Portable by construction: no machine paths, no real sessions. Frames come
 * from SYNTHETIC multi-frame zstd built with zstdCompressSync (the design's
 * real-artifact probe was a one-off measurement, not a test fixture). Layers:
 *
 *   1. frames  — locate frame boundaries, decompress each frame independently,
 *                skip a残缺 first frame when the window starts mid-frame,
 *                tolerate frames with no content-size field.
 *   2. detect  — turn/start => continue, turn/end / none => skip, rankRecent N.
 *   3. boot    — stub ctx; assert A2/A3/A4/A6/A9 and failure isolation.
 *   4. static  — lib/*.js and client contain no write calls and no Harness imports.
 *   5. prompt  — advisory semantics (auto-injected / reference-only / model decides
 *                / don't repeat) present in the continuation message.
 */

import { zstdCompressSync } from 'node:zlib'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { decodeTailFrames, scanZstdFrames } from '../lib/frames.js'
import { canContinue, lastTurnBoundary, rankRecent } from '../lib/detect.js'
import { defaultReadTail, runBoot } from '../lib/boot.js'
import {
  apply,
  continuationMessage,
  inject,
  name,
  STATUS_PATH,
  VERSION,
} from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

let failures = 0
/** Assert one expectation, printing pass/fail. */
function check(label, condition, detail) {
  if (condition) {
    process.stdout.write(`✔ ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

// ---------------------------------------------------------------------------
// Fixtures: synthetic zstd frames, one JSON event per frame.
// ---------------------------------------------------------------------------

/** Compress one event into its own independently decodable zstd frame. */
function frameOf(event, { noContentSize = false } = {}) {
  const params = noContentSize ? { [200 /* ZSTD_c_contentSizeFlag */]: 0 } : {}
  return zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'), { params })
}

const event = (type, seq, extra = {}) => ({ type, seq, time: 1000 + seq, ...extra })

// A multi-frame artifact: a closed turn, then an open turn at the tail.
const FRAME_EVENTS = [
  event('turn/start', 1),
  event('user/message', 2, { data: { text: 'hi' } }),
  event('turn/end', 3),
  event('turn/start', 4),
]
const ARTIFACT = Buffer.concat(FRAME_EVENTS.map((e) => frameOf(e)))

// ---------------------------------------------------------------------------
// 1. frames
// ---------------------------------------------------------------------------

const scanned = scanZstdFrames(ARTIFACT)
check('frames: scanZstdFrames finds every complete frame', scanned.frames.length === FRAME_EVENTS.length, `got ${scanned.frames.length}`)
check('frames: scan has no torn tail on a complete artifact', scanned.tornStart === undefined)
check('frames: each frame range starts with the zstd magic at its offset', scanned.frames.every((f) => ARTIFACT.readUInt32LE(f.start) === 4247762216))

const full = decodeTailFrames(ARTIFACT)
check('frames: decode yields one event per frame', full.events.length === FRAME_EVENTS.length, `got ${full.events.length}`)
check('frames: events keep their type/seq/time/data fields', JSON.stringify(full.events) === JSON.stringify(FRAME_EVENTS.map((e) => ({
  type: e.type, seq: e.seq, time: e.time, data: e.data,
}))), JSON.stringify(full.events))
check('frames: last decoded event is the trailing turn/start', lastTurnBoundary(full.events)?.seq === 4)

// Window starting mid-first-frame: prefix a partial frame, then the real frames.
const partialPrefix = frameOf(event('step/start', 0)).subarray(0, 7) // < full frame magic+descriptor
const windowWithPartial = Buffer.concat([partialPrefix, ARTIFACT])
const trimmed = decodeTailFrames(windowWithPartial)
check('frames: a残缺 first frame in the tail window is skipped', trimmed.events.length === FRAME_EVENTS.length, `got ${trimmed.events.length}`)
check('frames: skipping the partial frame still finds the real trailing turn/start', lastTurnBoundary(trimmed.events)?.seq === 4)

// Coincidental magic bytes before a frame must not fool the scanner.
const noiseWindow = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]), ARTIFACT])
check('frames: a bogus trailing magic does not add events', decodeTailFrames(noiseWindow).events.length === FRAME_EVENTS.length)

// Frames without a content-size field still parse via block headers.
const noSize = Buffer.concat([
  frameOf(event('turn/start', 10), { noContentSize: true }),
  frameOf(event('turn/end', 11), { noContentSize: true }),
])
const noSizeDecoded = decodeTailFrames(noSize)
check('frames: content-size-less frames are located and decoded', noSizeDecoded.events.length === 2 && lastTurnBoundary(noSizeDecoded.events)?.type === 'turn/end', JSON.stringify(noSizeDecoded.events))

// A torn final frame (crash mid-append) must be IGNORED without discarding the
// complete frames before it — the last complete frame holds the open turn/start.
const torn = decodeTailFrames(ARTIFACT.subarray(0, ARTIFACT.length - 8))
check('frames: a torn final frame is not decompressed', torn.events.length === FRAME_EVENTS.length - 1, `got ${torn.events.length}`)
check('frames: complete frames before a torn tail are kept', lastTurnBoundary(torn.events)?.seq === 3, JSON.stringify(lastTurnBoundary(torn.events)))

check('frames: empty input yields no events', decodeTailFrames(Buffer.alloc(0)).events.length === 0)

// ---------------------------------------------------------------------------
// 2. detect
// ---------------------------------------------------------------------------

const ev = (type, seq) => ({ type, seq, time: seq })
check('detect: turn/start can continue', canContinue([ev('turn/start', 1)]) === true)
check('detect: turn/end is skipped', canContinue([ev('turn/start', 1), ev('turn/end', 2)]) === false)
check('detect: no boundary is skipped', canContinue([ev('user/message', 1)]) === false)
check('detect: last boundary decides (start,end,start)', canContinue([ev('turn/start', 1), ev('turn/end', 2), ev('turn/start', 3)]) === true)
check('detect: lastTurnBoundary returns the boundary object', lastTurnBoundary([ev('user/message', 1), ev('turn/end', 9)])?.seq === 9)
check('detect: lastTurnBoundary returns null for no boundary', lastTurnBoundary([ev('user/message', 1)]) === null)

const ranked = rankRecent([
  { id: 'old', mtimeMs: 100 },
  { id: 'new', mtimeMs: 900 },
  { id: 'mid', mtimeMs: 500 },
  { id: 'pending' },
], 2)
check('detect: rankRecent takes the newest N', ranked.map((e) => e.id).join(',') === 'new,mid', JSON.stringify(ranked))
check('detect: rankRecent drops entries without mtime', !ranked.some((e) => e.id === 'pending'))
check('detect: rankRecent with N<=0 takes nothing', rankRecent([{ id: 'a', mtimeMs: 1 }], 0).length === 0)

// ---------------------------------------------------------------------------
// 3. boot (stub ctx) — A2 / A3 / A4 / A6 / A9 + isolation
// ---------------------------------------------------------------------------

/**
 * Build a stub ctx whose logs are synthetic zstd artifacts and which records
 * every tail read, stat, resume, followup and dispose.
 *
 * @param specs - [{id, path, tailBuffer, mtimeMs, live}].
 */
function stubCtx(specs, overrides = {}) {
  const readTails = []
  const stats = []
  const resumed = []
  const followed = []
  const disposed = []
  const live = new Set(specs.filter((s) => s.live).map((s) => s.id))
  const refusing = new Set(overrides.refuse ?? [])

  const ctx = {
    sessionPersistence: {
      list: async () => specs.map((s) => (s.noLocation
        ? { header: { id: s.id } }
        : { header: { id: s.id }, location: { path: s.path } })),
    },
    agents: {
      get: (id) => (live.has(id) ? { id } : undefined),
      resume: async ({ resumeSessionId }) => {
        if (refusing.has(resumeSessionId)) throw new Error('already owned')
        resumed.push(resumeSessionId)
        const agent = { followup: (msg) => followed.push({ id: resumeSessionId, msg }) }
        // Model the registry publishing the agent under its id on resume.
        return { agent, dispose: async () => { disposed.push(resumeSessionId) } }
      },
    },
    logger: { warn: () => undefined },
  }

  const deps = {
    recent: overrides.recent,
    window: overrides.window,
    stat: async (path) => {
      stats.push(path)
      const found = specs.find((s) => s.path === path)
      if (!found) throw new Error('missing')
      return { mtimeMs: found.mtimeMs }
    },
    readTail: async (path, window) => {
      readTails.push({ path, window })
      const found = specs.find((s) => s.path === path)
      if (!found) throw new Error('missing')
      return found.tailBuffer
    },
    // F-02: use the REAL continuationMessage so followup carries a real,
    // persistence-admissible message (with id) rather than a toy stub.
    continuationMessage,
    handles: new Set(),
    warn: () => undefined,
  }
  return { ctx, deps, readTails, stats, resumed, followed, disposed }
}

// A real crash tail: a complete turn/start frame, then a torn frame being
// appended when the Host died. The torn frame must be ignored; the last COMPLETE
// frame is an open turn/start => crash leftover.
const OPEN_TAIL = Buffer.concat([
  frameOf(event('turn/start', 1)),
  frameOf(event('user/message', 2)).subarray(0, 9),
])
const CLOSED_TAIL = Buffer.concat([
  frameOf(event('turn/start', 1)),
  frameOf(event('turn/end', 2)),
]) // cleanly closed

const now = Date.now()
const specs = [
  { id: 'open-1', path: '/v/open-1', tailBuffer: OPEN_TAIL, mtimeMs: now - 1000 },
  { id: 'closed-1', path: '/v/closed-1', tailBuffer: CLOSED_TAIL, mtimeMs: now - 2000 },
  { id: 'live-1', path: '/v/live-1', tailBuffer: OPEN_TAIL, mtimeMs: now - 3000, live: true },
  { id: 'open-2', path: '/v/open-2', tailBuffer: OPEN_TAIL, mtimeMs: now - 4000 },
  { id: 'pending-1', path: '/v/pending-1', tailBuffer: OPEN_TAIL, mtimeMs: now, noLocation: true },
  { id: 'old-open', path: '/v/old-open', tailBuffer: OPEN_TAIL, mtimeMs: now - 999999 },
]

// The post-resume ownership check needs agents.get to publish the resumed
// agent. Model the registry: initial live ids are present from the start, and
// a successful resume publishes its handle.agent under the session id.
{
  // recent=4 so both open tails are inside the window even though the live
  // session (ranked 4th by mtime after pending) consumes one slot without a read.
  const run = stubCtx(specs, { recent: 4, window: 64 * 1024 })
  const published = new Map()
  for (const s of specs.filter((x) => x.live)) published.set(s.id, { id: s.id })
  run.ctx.agents.get = (id) => published.get(id)
  const origResume = run.ctx.agents.resume
  run.ctx.agents.resume = async (opts) => {
    const handle = await origResume(opts)
    published.set(opts.resumeSessionId, handle.agent)
    return handle
  }

  const result = await runBoot(run.ctx, run.deps)

  check('boot: only the newest N candidates are read', run.readTails.length === 3, `tail reads = ${run.readTails.length}`)
  check('boot: A2 tail read never exceeds the window', run.readTails.every((r) => r.window === 64 * 1024), JSON.stringify(run.readTails))
  check('boot: A3 N outside the window is not read (old-open)', !run.readTails.some((r) => r.path === '/v/old-open'))
  check('boot: pending snapshot with no location is skipped', !run.readTails.some((r) => r.path === '/v/pending-1'))
  check('boot: A4 live session is never resumed', !run.resumed.includes('live-1'), run.resumed.join(','))
  check('boot: A6 resume+followup is called for crash leftovers', run.resumed.length === 2 && run.followed.length === 2, `resumed=${run.resumed.join(',')} followed=${run.followed.length}`)
  check('boot: resumed set is the two open tails', run.resumed.join(',') === 'open-1,open-2', run.resumed.join(','))
  check('boot: cleanly closed session is skipped', result.skipped.some((s) => s.id === 'closed-1' && s.why === 'no-open-turn'))
  // F-03: assert candidate CONTENT, not merely its type (which was tautological).
  check('boot: result.candidates exactly lists the open tails beyond the first check', result.candidates.join(',') === 'open-1,open-2', JSON.stringify(result.candidates))
  check('boot: A9 handles are collected for dispose', run.deps.handles.size === 2, `handles = ${run.deps.handles.size}`)
  for (const handle of run.deps.handles) await handle.dispose()
  check('boot: A9 collected handles call dispose', run.disposed.length === 2, `disposed = ${run.disposed.length}`)

  // F-02: followup must carry the REAL continuation message, including a
  // non-empty string id — the field cold-read persistence validation enforces.
  check('boot: followup receives the real continuation message', run.followed.every((f) => f.msg?.role === 'user' && Array.isArray(f.msg?.content) && f.msg?.source?.kind === 'auto-continue'))
  check('boot: F-01 every followed message has a non-empty string id', run.followed.length === 2 && run.followed.every((f) => typeof f.msg?.id === 'string' && f.msg.id.length > 0), JSON.stringify(run.followed.map((f) => f.msg?.id)))
}

// A resume failure must be isolated and recorded in skipped.
{
  const run = stubCtx([specs[0], specs[3]], { recent: 2 })
  const published = new Map()
  run.ctx.agents.get = (id) => published.get(id)
  run.ctx.agents.resume = async ({ resumeSessionId }) => {
    if (resumeSessionId === 'open-1') throw new Error('boom')
    const agent = { followup: () => undefined }
    published.set(resumeSessionId, agent)
    return { agent, dispose: async () => undefined }
  }
  const result = await runBoot(run.ctx, run.deps)
  check('boot: a failing resume is isolated (other still resumes)', result.resumed.join(',') === 'open-2', result.resumed.join(','))
  check('boot: a failing resume is recorded in skipped', result.skipped.some((s) => s.id === 'open-1' && s.why === 'resume-failed'))
}

// Immediate listing failure is a clean no-op.
{
  const run = stubCtx(specs)
  run.ctx.sessionPersistence.list = async () => { throw new Error('down') }
  const result = await runBoot(run.ctx, run.deps)
  check('boot: list failure is a clean no-op', result.resumed.length === 0 && result.candidates.length === 0)
}

// ---------------------------------------------------------------------------
// 3b. F-04: behavioral assertion of the REAL defaultReadTail byte ceiling.
// The stub readTail ignores `window`, so only a real file can prove the bound.
// ---------------------------------------------------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-continue-tail-'))
  try {
    const big = join(dir, 'big.jsonl.zstd')
    // 200 KB file: fill with 0x41, put a unique marker in the very last byte so
    // "returns the TAIL" is provable, not just a length check.
    const size = 4 * 64 * 1024
    const content = Buffer.alloc(size, 0x41)
    content[size - 1] = 0x5a
    await writeFile(big, content)
    const window = 64 * 1024
    const tail = await defaultReadTail(big, window)
    check('boot: F-04 defaultReadTail reads at most window bytes', tail.length === window, `got ${tail.length}`)
    check('boot: F-04 defaultReadTail returns the file TAIL (unique last byte)', tail[tail.length - 1] === 0x5a, `got ${tail[tail.length - 1]}`)
    // A window larger than the file returns the whole file, never more.
    const whole = await defaultReadTail(big, 1024 * 1024)
    check('boot: F-04 defaultReadTail never exceeds file size', whole.length === size && whole[whole.length - 1] === 0x5a, `got ${whole.length}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 4. static assertions
// ---------------------------------------------------------------------------

for (const file of ['index.js', 'client.js', 'frames.js', 'detect.js', 'boot.js']) {
  const source = await readFile(join(LIB, file), 'utf8')
  check(`static: ${file} has no file-writing calls`, !/writeFile|appendFile|mkdir|createWriteStream|unlink|rmdir/.test(source))
  check(`static: ${file} has no Harness package imports`, !/@deepseek-ai\//.test(source))
}

const clientSource = await readFile(join(LIB, 'client.js'), 'utf8')
check('static: client registers a lazy-CJS factory via __ModuleLoader__', /__ModuleLoader__\.load\(\{/.test(clientSource) && /factory:\s*\(require\)/.test(clientSource))

// Incident-001 guard: the client module id MUST equal the package name.
// dsh-client-modules keys factories by `stripClientSuffix(registration.id)` and
// the boot manifest's entry id is the package name; a mismatched id registers a
// factory nobody looks up, so the bundle import fails and the whole web boot
// reports "entry did not activate". This is a判-可失败 static gate, not a comment.
const pkg = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'))
const clientIdMatch = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(clientSource)
check('static: client load id equals package name (incident-001)', clientIdMatch !== null && clientIdMatch[1] === pkg.name,
  `client id=${clientIdMatch?.[1] ?? '(none)'} package name=${pkg.name}`)
check('static: client uses only --dsw-alias theme tokens', !/--(?!dsw-alias-)/.test(clientSource))
check('static: client has no enable/disable toggle control', !/disabled|enabled|switch|toggle/i.test(clientSource))

const indexSource = await readFile(join(LIB, 'index.js'), 'utf8')
check('static: no config.enabled switch exists', !/config\.enabled|Config\s*=/.test(indexSource))
check('static: route path is owner-only /api status endpoint', STATUS_PATH === '/api/auto-continue/status' && /fetch\.register\(/.test(indexSource))

// ---------------------------------------------------------------------------
// 5. prompt (A7)
// ---------------------------------------------------------------------------

const msg = continuationMessage()
const text = msg.content?.[0]?.text ?? ''
// F-01: mirror DSH assertMessageEventShape's user/message invariants — this is
// the invariant that cold-read persistence enforces on the appended message.
check('F-01: message has a non-empty string id (cold-read contract)', typeof msg.id === 'string' && msg.id.length > 0, JSON.stringify(msg.id))
check('F-01: message role is exactly "user"', msg.role === 'user', String(msg.role))
check('F-01: message source.kind is a non-empty string', typeof msg.source?.kind === 'string' && msg.source.kind.length > 0)
check('F-01: message content is a non-empty array', Array.isArray(msg.content) && msg.content.length > 0)
check('F-01: message is deeply frozen for log publication', Object.isFrozen(msg) && Object.isFrozen(msg.content) && Object.isFrozen(msg.content[0]))
check('F-01: two calls produce distinct ids (fresh identity per message)', continuationMessage().id !== continuationMessage().id)
check('prompt: message is an advisory semantic, not a command', msg.role === 'user' && typeof text === 'string' && text.length > 0)
check('prompt: declares automatic injection ("系统自动注入")', text.includes('系统自动注入'))
check('prompt: says reference-only ("仅供参考")', text.includes('仅供参考'))
check('prompt: hands decision to the model ("完全由你决定")', text.includes('完全由你决定'))
check('prompt: forbids repeating finished work ("不要重复执行")', text.includes('不要重复执行'))
check('prompt: preserves the verify-before-retry / unknown-outcome caveat', text.includes('核实外部状态') && text.includes('不要盲目重试'))
check('manifest: name / inject / version are correct', name === 'auto-continue' && inject.join(',') === 'agents,sessionPersistence' && VERSION === pkg.version)
check('manifest: apply is exported', typeof apply === 'function')

// ---------------------------------------------------------------------------

process.stdout.write(failures === 0 ? '\nRESULT: PASS\n' : `\nRESULT: FAIL (${failures})\n`)
process.exit(failures === 0 ? 0 : 1)
