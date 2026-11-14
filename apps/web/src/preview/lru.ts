/**
 * Size-bounded LRU cache (decoded audio segments, images, LUT textures). Uses Map insertion
 * order for recency, so get/set are O(1). `onEvict` releases external resources (GPU
 * textures, ImageBitmaps) deterministically instead of waiting for GC.
 */
export class LruCache<K, V> {
  readonly #map = new Map<K, { value: V; size: number }>()
  #total = 0
  readonly maxSize: number
  readonly #onEvict: ((key: K, value: V) => void) | undefined

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    this.maxSize = maxSize
    this.#onEvict = onEvict
  }

  get size(): number {
    return this.#total
  }

  get count(): number {
    return this.#map.size
  }

  has(key: K): boolean {
    return this.#map.has(key)
  }

  /** Get and mark as most recently used. */
  get(key: K): V | undefined {
    const e = this.#map.get(key)
    if (!e) return undefined
    this.#map.delete(key)
    this.#map.set(key, e)
    return e.value
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.#map.get(key)?.value
  }

  set(key: K, value: V, size: number): void {
    const old = this.#map.get(key)
    if (old) {
      this.#map.delete(key)
      this.#total -= old.size
      if (old.value !== value) this.#onEvict?.(key, old.value)
    }
    this.#map.set(key, { value, size })
    this.#total += size
    this.#trim(key)
  }

  delete(key: K): boolean {
    const e = this.#map.get(key)
    if (!e) return false
    this.#map.delete(key)
    this.#total -= e.size
    this.#onEvict?.(key, e.value)
    return true
  }

  clear(): void {
    for (const [k, e] of this.#map) this.#onEvict?.(k, e.value)
    this.#map.clear()
    this.#total = 0
  }

  /** Evict least recently used entries until within budget (never the entry just added). */
  #trim(keep: K): void {
    for (const [k, e] of this.#map) {
      if (this.#total <= this.maxSize) return
      if (k === keep) continue
      this.#map.delete(k)
      this.#total -= e.size
      this.#onEvict?.(k, e.value)
    }
  }
}
