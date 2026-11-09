import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../lib/cache.js";

test("LruCache: hit refreshes recency", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // "a" becomes most recent
  cache.set("c", 3); // evicts "b", not "a"
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("LruCache: evicts oldest beyond the limit", () => {
  const cache = new LruCache(3);
  for (const key of ["a", "b", "c", "d"]) cache.set(key, key);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined);
  assert.deepEqual(["b", "c", "d"].map((k) => cache.get(k)), ["b", "c", "d"]);
});

test("LruCache: overwriting a key does not grow the cache", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  cache.set("a", 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), 2);
});

test("LruCache: rejects a non-positive limit", () => {
  assert.throws(() => new LruCache(0), /invalid limit/);
  assert.throws(() => new LruCache(-1), /invalid limit/);
  assert.throws(() => new LruCache(1.5), /invalid limit/);
});

test("LruCache: clear empties the cache", () => {
  const cache = new LruCache(2);
  cache.set("a", 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});
