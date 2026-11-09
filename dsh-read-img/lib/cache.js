/**
 * Bounded LRU cache. Insertion order doubles as recency: a hit is re-inserted
 * at the tail, and the head is evicted once the limit is exceeded.
 */
export class LruCache {
  /** @param {number} limit - maximum number of retained entries. */
  constructor(limit) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`LruCache: invalid limit ${limit}`);
    /** @type {number} */
    this.limit = limit;
    /** @type {Map<string, unknown>} */
    this.map = new Map();
  }

  /** @param {string} key */
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}
