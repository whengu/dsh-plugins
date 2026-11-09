/**
 * Turning what the model passed as `path` into bytes or a URL.
 *
 * Accepted forms: absolute path, path relative to the session working
 * directory, `file://` URL, `http(s)://` URL.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

/** Media types we can infer from a file extension. */
const MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);

const HTTP_URL = /^https?:\/\//i;
const FILE_URL = /^file:\/\//i;

/**
 * Sniff a media type from leading bytes, for paths without a usable extension
 * (screenshots written as `shot` or `.bin` are common).
 * @param {Buffer} bytes
 * @returns {string | undefined}
 */
export function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return undefined;
}

/**
 * Resolve the media type of a local image: extension first, magic bytes as the
 * fallback, `image/png` only as the last resort (the endpoint sniffs again).
 * @param {string} filePath
 * @param {Buffer} bytes
 * @returns {string}
 */
export function mimeOf(filePath, bytes) {
  return MIME_BY_EXT.get(extname(filePath).toLowerCase()) ?? sniffMime(bytes) ?? "image/png";
}

/**
 * Classify the model-supplied target.
 * @param {unknown} value
 * @param {string} cwd - session working directory for relative paths.
 * @returns {{ kind: "url", url: string } | { kind: "file", path: string }}
 * @throws {Error} when the value is empty or not a string.
 */
export function toTarget(value, cwd) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("read_img: path is required");
  }
  const raw = value.trim();
  if (HTTP_URL.test(raw)) return { kind: "url", url: raw };
  if (FILE_URL.test(raw)) return { kind: "file", path: fileURLToPath(raw) };
  return { kind: "file", path: isAbsolute(raw) ? raw : resolvePath(cwd, raw) };
}

/**
 * Read one local image, enforcing the size budget before loading it.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<{ bytes: Buffer, mime: string, size: number }>}
 */
export async function readImageFile(filePath, maxBytes) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`read_img: 文件不存在或不可读：${filePath}`);
  }
  if (!info.isFile()) throw new Error(`read_img: 不是普通文件：${filePath}`);
  if (info.size > maxBytes) {
    throw new Error(`read_img: 图片 ${info.size} 字节，超过上限 ${maxBytes}；请先缩小或裁剪。`);
  }
  const bytes = await readFile(filePath);
  return { bytes, mime: mimeOf(filePath, bytes), size: bytes.length };
}
