import type { EnvironmentModuleNode } from './moduleGraph'
import type { TransformResult } from './transformRequest'

export interface TransformCacheStats {
  /**
   * Number of transform results currently kept in the cache
   */
  entries: number
  /**
   * Total accounted bytes of the cached results. This is a reproducible
   * estimate of the cached content (UTF-8 encoded code plus the serialized
   * source map), not a measurement of the process heap usage.
   */
  bytes: number
  /**
   * Number of results evicted by the LRU budget since the environment started
   */
  evictions: number
}

/**
 * Computes the accounted size of a transform result: the UTF-8 byte length
 * of the code plus the UTF-8 byte length of the serialized source map.
 */
export function getTransformResultSize(result: TransformResult): number {
  let size = Buffer.byteLength(result.code, 'utf8')
  if (result.map) {
    size += Buffer.byteLength(JSON.stringify(result.map), 'utf8')
  }
  return size
}

/**
 * Tracks the memory budget of cached transform results for a single dev
 * environment. Completed results are accounted by their UTF-8 encoded code
 * and serialized map size, and evicted in least-recently-used order when the
 * total exceeds the configured budget. In-flight requests are never tracked
 * here, only completed results.
 */
export class TransformCacheBudget {
  private _entries: Map<EnvironmentModuleNode, number> = new Map()
  private _bytes: number = 0
  private _evictions: number = 0

  constructor(
    private readonly budget: number | undefined,
    private readonly onEvict: (mod: EnvironmentModuleNode) => void,
  ) {}

  get enabled(): boolean {
    return this.budget !== undefined
  }

  /**
   * Read-only stats snapshot. It intentionally only exposes the number of
   * entries, the accounted bytes and the eviction count, never the cached
   * content itself.
   */
  get stats(): Readonly<TransformCacheStats> {
    return Object.freeze({
      entries: this._entries.size,
      bytes: this._bytes,
      evictions: this._evictions,
    })
  }

  /**
   * Record a cache hit, marking the entry as most recently used.
   */
  read(mod: EnvironmentModuleNode): void {
    const size = this._entries.get(mod)
    if (size !== undefined) {
      this._entries.delete(mod)
      this._entries.set(mod, size)
    }
  }

  /**
   * Stop tracking a module, e.g. when its transform result is invalidated.
   */
  delete(mod: EnvironmentModuleNode): void {
    const size = this._entries.get(mod)
    if (size !== undefined) {
      this._entries.delete(mod)
      this._bytes -= size
    }
  }

  /**
   * Track a freshly computed result, evicting least recently used entries
   * until the total accounted bytes fit the budget. Returns false when the
   * result must not be kept in the cache: when it alone exceeds the budget,
   * or when the budget is zero.
   */
  write(mod: EnvironmentModuleNode, result: TransformResult): boolean {
    const budget = this.budget!
    const size = getTransformResultSize(result)
    if (budget === 0 || size > budget) {
      return false
    }
    this._entries.set(mod, size)
    this._bytes += size
    while (this._bytes > budget) {
      const oldest = this._entries.keys().next().value!
      const oldestSize = this._entries.get(oldest)!
      this._entries.delete(oldest)
      this._bytes -= oldestSize
      this._evictions++
      this.onEvict(oldest)
    }
    return true
  }

  /**
   * Drop all tracked results and reset every counter to zero.
   */
  clear(): void {
    for (const mod of this._entries.keys()) {
      this.onEvict(mod)
    }
    this._entries.clear()
    this._bytes = 0
    this._evictions = 0
  }
}
