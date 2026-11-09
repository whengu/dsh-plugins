import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mimeOf, readImageFile, sniffMime, toTarget } from "../lib/image.js";

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

test("toTarget: classifies plain paths, file URLs and http URLs", () => {
  assert.deepEqual(toTarget("/tmp/a.png", "/work"), { kind: "file", path: "/tmp/a.png" });
  assert.deepEqual(toTarget("  shots/a.png  ", "/work"), { kind: "file", path: "/work/shots/a.png" });
  assert.deepEqual(toTarget("file:///tmp/a.png", "/work"), { kind: "file", path: "/tmp/a.png" });
  assert.deepEqual(toTarget("https://example.com/a.png", "/work"), {
    kind: "url",
    url: "https://example.com/a.png",
  });
});

test("toTarget: rejects empty and non-string values", () => {
  assert.throws(() => toTarget("", "/work"), /path is required/);
  assert.throws(() => toTarget("   ", "/work"), /path is required/);
  assert.throws(() => toTarget(undefined, "/work"), /path is required/);
  assert.throws(() => toTarget(42, "/work"), /path is required/);
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
