/** Caché local acotada. La autorización debe resolverse ANTES de construir la clave. */
export class ReadCache {
  private entries = new Map<string, { until: number; promise: Promise<unknown> }>();
  private ttlMs: number;
  private maxEntries: number;
  constructor(ttlMs: number, maxEntries = 32) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const found = this.entries.get(key);
    if (found && found.until > Date.now()) return structuredClone(await found.promise) as T;
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
    const entry = { until: Date.now() + this.ttlMs, promise: load() };
    this.entries.set(key, entry);
    try {
      return structuredClone(await entry.promise);
    } catch (e) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw e;
    }
  }
}
