/**
 * In-memory TTL cache with LRU eviction (Map keeps insertion order). Per-process: fine for a
 * single instance; swap for Redis or similar when running more than one.
 */
export class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
