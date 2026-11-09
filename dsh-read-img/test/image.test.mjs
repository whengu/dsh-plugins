import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mimeOf, readImageFile, sniffMime, toTarget } from "../lib/image.js";

/**
 * `toTarget` answers in native paths, so every expectation below is derived with
 * `node:path` instead of being written as a POSIX literal: the same test expresses
 * the same behaviour on Windows (`D:\…`, drive letters, backslash) and POSIX
 * (`/…`). Only the two genuine platform differences (drive letters in `file:`
 * URLs, the meaning of a UNC path) branch on the platform, and they are named.
 */
const IS_WINDOWS = process.platform === "win32";
const CWD = resolve(tmpdir(), "read-img-cwd");
const OTHER_CWD = resolve(tmpdir(), "read-img-other-cwd");
const ABSOLUTE = resolve(CWD, "shots", "a.png");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from("GIF89a", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
const BMP = Buffer.from([0x42, 0x4d, 0x00, 0x00]);

test("sniffMime: recognises the five supported formats by magic bytes", () => {
  assert.equal(sniffMime(PNG), "image/png");
  assert.equal(sniffMime(JPEG), "image/jpeg");
  assert.equal(sniffMime(GIF), "image/gif");
  assert.equal(sniffMime(WEBP), "image/webp");
  assert.equal(sniffMime(BMP), "image/bmp");
  assert.equal(sniffMime(Buffer.from("not an image")), undefined);
  assert.equal(sniffMime(Buffer.alloc(0)), undefined);
});

test("mimeOf: extension wins, magic bytes are the fallback", () => {
  assert.equal(mimeOf("/tmp/shot.PNG", Buffer.from("nope")), "image/png");
  assert.equal(mimeOf("/tmp/shot", PNG), "image/png");
  assert.equal(mimeOf("/tmp/shot.bin", JPEG), "image/jpeg");
  assert.equal(mimeOf("/tmp/shot", Buffer.from("nope")), "image/png"); // last resort
});

test("toTarget: resolves a relative path against the session cwd", () => {
  assert.deepEqual(toTarget("shots/a.png", CWD), { kind: "file", path: ABSOLUTE });
  assert.deepEqual(toTarget("  shots/a.png  ", CWD), { kind: "file", path: ABSOLUTE }, "the value is trimmed");
});

test("toTarget: keeps an absolute path as written", () => {
  assert.deepEqual(toTarget(ABSOLUTE, OTHER_CWD), { kind: "file", path: ABSOLUTE });
});

test("toTarget: converts a file URL built for this platform", () => {
  const href = pathToFileURL(ABSOLUTE).href;
  assert.deepEqual(toTarget(href, OTHER_CWD), { kind: "file", path: ABSOLUTE });
  // `file://localhost/<path>` names the same file: the URL parser normalises the
  // host to empty, so both forms reach the same check.
  assert.deepEqual(toTarget(href.replace("file:///", "file://localhost/"), CWD), { kind: "file", path: ABSOLUTE });
});

test("toTarget: http(s) URLs are passed through untouched", () => {
  assert.deepEqual(toTarget("https://example.com/a.png", CWD), { kind: "url", url: "https://example.com/a.png" });
  assert.deepEqual(toTarget("HTTP://example.com/a.png", CWD), { kind: "url", url: "HTTP://example.com/a.png" });
});

test("mimeOf: magic bytes beat a misleading extension", () => {
  assert.equal(mimeOf("/tmp/shot.png", JPEG), "image/jpeg");
  assert.equal(mimeOf("/tmp/shot.jpg", PNG), "image/png");
});

test("toTarget: a file URL with a host is refused with a readable message", () => {
  // The rule is the plugin's own, not `fileURLToPath`'s: on Windows Node turns
  // `file://server/share/a.png` into the UNC path \\server\share\a.png, while on
  // POSIX the same URL throws. Both platforms must refuse it here, and the
  // message must name the offending host — the conversion fallback would have
  // thrown too, so asserting the reason keeps the host rule itself covered.
  assert.throws(() => toTarget("file://server/share/a.png", CWD), /不支持的 file URL.*主机名 "server"/);
  assert.throws(() => toTarget("file://example.com/x.png", CWD), /不支持的 file URL.*不是本机/);
  assert.throws(() => toTarget("file://127.0.0.1/x.png", CWD), /主机名 "127\.0\.0\.1"/);
  // The refusal names the form that still works: the share path itself.
  assert.throws(() => toTarget("file://server/share/a.png", CWD), /UNC/);
});

test(
  "toTarget: a Windows UNC path is taken as an absolute path",
  { skip: IS_WINDOWS ? false : "UNC paths do not exist on this platform" },
  () => {
    // Same share as the refused `file://server/share/a.png`, reached as a plain
    // path — the reason refusing the host form costs no capability on Windows.
    const unc = String.raw`\\server\share\a.png`;
    assert.deepEqual(toTarget(unc, CWD), { kind: "file", path: unc });
  },
);

test("toTarget: a drive-less file URL is a POSIX path and a refused one on Windows", () => {
  if (IS_WINDOWS) {
    // win32 `fileURLToPath` needs a drive letter; the message says what to pass.
    assert.throws(() => toTarget("file:///tmp/a.png", CWD), /不支持的 file URL.*盘符/);
  } else {
    assert.deepEqual(toTarget("file:///tmp/a.png", CWD), { kind: "file", path: "/tmp/a.png" });
  }
});

test("toTarget: rejects empty and non-string values", () => {
  assert.throws(() => toTarget("", CWD), /path is required/);
  assert.throws(() => toTarget("   ", CWD), /path is required/);
  assert.throws(() => toTarget(undefined, CWD), /path is required/);
  assert.throws(() => toTarget(42, CWD), /path is required/);
});

test("readImageFile: reads bytes and infers the media type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-img-"));
  try {
    const file = join(dir, "shot.png");
    await writeFile(file, PNG);
    const result = await readImageFile(file, 1024);
    assert.equal(result.mime, "image/png");
    assert.equal(result.size, PNG.length);
    assert.ok(result.bytes.equals(PNG));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readImageFile: missing file and directory produce distinct errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-img-"));
  try {
    await assert.rejects(readImageFile(join(dir, "nope.png"), 1024), /文件不存在或不可读/);
    await assert.rejects(readImageFile(dir, 1024), /不是普通文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readImageFile: enforces the byte budget before reading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-img-"));
  try {
    const file = join(dir, "big.png");
    await writeFile(file, Buffer.concat([PNG, Buffer.alloc(64)]));
    await assert.rejects(readImageFile(file, 16), /超过上限/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
