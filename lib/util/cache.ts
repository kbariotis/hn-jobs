/**
 * In-memory TTL cache (optional per-entry TTL) with LRU eviction (Map keeps insertion order).
 * Per-process: fine for a single instance; use Redis (lib/web/limits.ts) for more than one.
 */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) {
      return undefined;
    }
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value!);
    }
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
