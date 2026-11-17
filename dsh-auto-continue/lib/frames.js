/**
 * Zstd frame triangulation for the boot-time tail read (pure module).
 *
 * A JSONL session artifact is a concatenation of independently decodable,
 * checksummed Zstandard frames. To decide whether a session crashed mid-turn we
 * only read the tail window, so the window usually starts in the MIDDLE of a
 * frame. `scanZstdFrames` here locates only structurally complete frames whose
 * magic starts at a byte we can trust, using the same block-header walk as DSH's
 * own persistence backend (`dsh-session-persistence-jsonl/lib/index.js`,
 * `scanZstdFrames`): magic -> frame descriptor -> repeated 3-byte block headers
 * -> frame [start, end). No content-size field is required — zstd frames do not
 * have to carry one (the backend's `contentSizeBytes` is 0 when content size is
 * absent and the frame is not single-segment).
 *
 * Design choice vs. the old implementation: we do NOT "find the first magic and
 * decompress to EOF". The backend proved that cannot reconstruct frame
 * boundaries. We walk each frame's block headers and decompress each frame
 * independently, which is what makes 84/84 tail frames decode in the design's
 * probe.
 *
 * This module imports only `node:zlib`; it imports no Harness package and never
 * touches the filesystem. Callers hand it a Buffer.
 *
 * @module dsh-auto-continue/frames
 */

import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic, little-endian (28 B5 2F FD on the wire). */
const ZSTD_MAGIC = 4247762216

/**
 * Walk one artifact's bytes and return structurally complete frame ranges.
 *
 * Ported from DSH `scanZstdFrames` (block-header traversal). A byte that is not
 * a magic at the current offset stops the walk: on a TAIL WINDOW the leading
 * bytes are a partial frame, so callers first trim the buffer to its last
 * magic-aligned boundary before calling this (see `tailFrames`).
 *
 * @param buffer - bytes that begin at a real frame magic.
 * @param maxFrames - optional cap on complete frames returned.
 * @returns `{frames:[{start,end}], tornStart?}`; `tornStart` marks an incomplete tail.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      // Not a magic at this offset: the walk cannot trust the structure any
      // further (this is the tail-window partial-frame case).
      return { frames, tornStart: start }
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('corrupt Zstandard frame: reserved frame-header bit')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('corrupt Zstandard frame: reserved block type')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if ((descriptor & 4) !== 0) {
      // Checksum flag: 4 trailing bytes belong to this frame.
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Indices of every 4-byte zstd magic in a buffer, in ascending order.
 *
 * A magic can appear inside compressed bytes by coincidence, so an index is
 * only a CANDIDATE start: `scanZstdFrames` decides whether a structure really
 * parses. We try candidates from the last backwards and keep the latest one
 * that yields a clean, complete scan to EOF — that is the first frame the tail
 * window actually contains in full, skipping the残缺 first frame the window
 * cut into.
 *
 * @param buffer - the tail window.
 * @returns ascending magic offsets.
 */
function magicOffsets(buffer) {
  const result = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) result.push(i)
  }
  return result
}

/**
 * Decode the complete zstd frames in a tail window into events.
 *
 * Tail-window handling: the window's first bytes usually belong to a frame
 * that started before the window, so we must skip that残缺 leading frame. Also,
 * the crash we are hunting for may have left a TORN FINAL frame (a frame being
 * appended when the process died) — that tail must be ignored, NOT allowed to
 * discard the complete frames before it (the last complete frame is exactly
 * where the open `turn/start` lives).
 *
 * Strategy: try every magic candidate as a frame start; a real frame start
 * yields the MOST complete frames (a coincidental magic inside compressed data
 * yields at most one), so pick the scan with the greatest complete-frame count,
 * preferring a clean-to-EOF scan and then the earliest start on ties. Decompress
 * only the complete frames; the torn tail is `scan.tornStart` and is ignored.
 *
 * @param buffer - the tail window (Buffer).
 * @returns `{frames, events}` where events are `{type, seq, time, data}` in frame order.
 */
export function decodeTailFrames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { frames: [], events: [] }
  const offsets = magicOffsets(buffer)
  let chosen = null
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = buffer.subarray(offsets[i])
    let scan
    try {
      scan = scanZstdFrames(slice)
    } catch {
      continue
    }
    if (scan.frames.length === 0) continue
    const clean = scan.tornStart === undefined
    if (chosen === null
      || scan.frames.length > chosen.frames.length
      || (scan.frames.length === chosen.frames.length && clean && !chosen.clean)) {
      chosen = { base: offsets[i], frames: scan.frames, clean }
    }
  }
  if (chosen === null) return { frames: [], events: [] }

  const events = []
  for (const frame of chosen.frames) {
    const raw = buffer.subarray(chosen.base + frame.start, chosen.base + frame.end)
    let text
    try {
      text = zstdDecompressSync(raw).toString('utf8')
    } catch {
      // One corrupt frame must not abort the whole tail: skip it.
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const value = JSON.parse(trimmed)
        if (value === null || typeof value !== 'object') continue
        events.push({
          type: typeof value.type === 'string' ? value.type : '',
          seq: typeof value.seq === 'number' ? value.seq : undefined,
          time: typeof value.time === 'number' ? value.time : value.ts,
          data: value.data,
        })
      } catch {
        // A torn line at a frame boundary is not an event.
      }
    }
  }
  return { frames: chosen.frames, events }
}
