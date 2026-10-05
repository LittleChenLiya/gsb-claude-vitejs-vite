/**
 * Explicit virtual module registry with a collision-safe identity encoding.
 *
 * A virtual module identity is a triple of:
 *   - plugin: the owning plugin's name
 *   - name:   the module's logical name inside that plugin
 *   - query:  an unordered set of key/value pairs
 *
 * The three components are NOT joined by naive string concatenation
 * (plugin + ':' + name + '?' + query), because names containing ':', '/'
 * or '?' would let two different triples collapse onto the same id.
 * Instead each variable-length component is length-prefixed:
 *
 *   id = PREFIX + len(plugin) + ':' + plugin
 *              + len(name)   + ':' + name
 *              + ('?' + canonicalQuery | '')
 *
 * where PREFIX is a reserved, non-file id prefix (a NUL byte followed by
 * `vmr:`). Real file ids never start with a NUL byte, so external files
 * cannot impersonate registry entries, and decodeVirtualModuleId strictly
 * validates the reserved prefix and the full structure before returning
 * anything.
 *
 * Query canonicalization strategy (explicit): pairs are flattened, pairs
 * with undefined values are dropped, then sorted by key and then value
 * using code-unit order, and each key/value is percent-encoded (unreserved
 * chars A-Z a-z 0-9 - _ . ~ kept, everything else %XX uppercase hex, UTF-8).
 * Joined as k=v&k=v. Therefore the same spec always produces the same id,
 * regardless of the order the query parameters were written in.
 */

/**
 * Reserved prefix for registry-managed virtual module ids.
 * The leading NUL byte follows the Rollup/Vite virtual module convention:
 * such ids can never be real file paths or valid import URLs.
 */
export const VIRTUAL_MODULE_REGISTRY_PREFIX = '\u0000vmr:'

export type VirtualModuleQueryInput =
  | ReadonlyArray<readonly [string, string]>
  | Readonly<Record<string, string | readonly string[] | undefined>>

export interface VirtualModuleSpec {
  /** Owning plugin name. Must be non-empty and must not contain NUL. */
  readonly plugin: string
  /** Logical module name. Must be non-empty and must not contain NUL. */
  readonly name: string
  /** Query parameters. Order-insensitive; canonicalized before encoding. */
  readonly query?: VirtualModuleQueryInput
}

export interface DecodedVirtualModuleId {
  readonly plugin: string
  readonly name: string
  /** Canonical (sorted) query pairs. */
  readonly query: ReadonlyArray<readonly [string, string]>
}

const unreservedRE = /^[\w.~-]$/

function percentEncode(value: string): string {
  let out = ''
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte)
    out += unreservedRE.test(ch)
      ? ch
      : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

const hexDigitRE = /^[0-9A-F]{2}$/

function strictPercentDecode(value: string): string | null {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '%') {
      const hex = value.slice(i + 1, i + 3)
      if (!hexDigitRE.test(hex)) return null
      bytes.push(parseInt(hex, 16))
      i += 2
    } else if (unreservedRE.test(ch)) {
      bytes.push(ch.charCodeAt(0))
    } else {
      // not a canonical encoding produced by percentEncode
      return null
    }
  }
  try {
    // fatal: reject invalid UTF-8 sequences
    return new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(bytes),
    )
  } catch {
    return null
  }
}

function comparePairs(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
  return 0
}

/**
 * Flatten and canonicalize query input into sorted pairs.
 * Strategy: drop undefined values, sort by (key, value) in code-unit
 * order. Identical duplicate pairs are preserved.
 */
export function canonicalizeQuery(
  input: VirtualModuleQueryInput | undefined,
): Array<readonly [string, string]> {
  if (!input) return []
  const pairs: Array<readonly [string, string]> = []
  if (Array.isArray(input)) {
    const list = input as ReadonlyArray<readonly [string, string]>
    for (const pair of list) {
      pairs.push([pair[0], pair[1]])
    }
  } else {
    const record = input as Record<
      string,
      string | readonly string[] | undefined
    >
    for (const key of Object.keys(record)) {
      const value = record[key]
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const v of value as readonly string[]) pairs.push([key, v])
      } else {
        pairs.push([key, value as string])
      }
    }
  }
  for (const [k, v] of pairs) {
    if (k.length === 0) {
      throw new Error('[virtual-module-registry] query keys must not be empty')
    }
    assertNoNul(k, 'query key')
    assertNoNul(v, 'query value')
  }
  return pairs.sort(comparePairs)
}

function assertNoNul(value: string, what: string): void {
  if (value.includes('\u0000')) {
    throw new Error(
      '[virtual-module-registry] ' + what + ' must not contain NUL characters',
    )
  }
}

function encodeLengthPrefixed(value: string): string {
  return value.length + ':' + value
}

/**
 * Encode a virtual module spec into its internal id.
 * Deterministic: the same spec always yields the same id.
 */
export function encodeVirtualModuleId(spec: VirtualModuleSpec): string {
  const { plugin, name } = spec
  if (typeof plugin !== 'string' || plugin.length === 0) {
    throw new Error('[virtual-module-registry] plugin name must be non-empty')
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('[virtual-module-registry] module name must be non-empty')
  }
  assertNoNul(plugin, 'plugin name')
  assertNoNul(name, 'module name')
  const pairs = canonicalizeQuery(spec.query)
  let id =
    VIRTUAL_MODULE_REGISTRY_PREFIX +
    encodeLengthPrefixed(plugin) +
    encodeLengthPrefixed(name)
  if (pairs.length > 0) {
    id +=
      '?' +
      pairs.map(([k, v]) => percentEncode(k) + '=' + percentEncode(v)).join('&')
  }
  return id
}

/**
 * Check whether an id carries the reserved registry prefix.
 * This is a cheap pre-filter; it does NOT prove the id is well-formed
 * or registered — use decodeVirtualModuleId for that.
 */
export function hasVirtualModuleRegistryPrefix(id: string): boolean {
  return id.startsWith(VIRTUAL_MODULE_REGISTRY_PREFIX)
}

/**
 * Strictly decode a registry id. Returns null for anything that was not
 * produced by encodeVirtualModuleId: missing reserved prefix, malformed
 * length prefixes, non-canonical lengths (leading zeros), non-canonical
 * percent-encoding, non-canonical query ordering, stray NUL bytes, or
 * trailing garbage. External file ids therefore never decode.
 */
export function decodeVirtualModuleId(
  id: string,
): DecodedVirtualModuleId | null {
  if (typeof id !== 'string' || !hasVirtualModuleRegistryPrefix(id)) {
    return null
  }
  let rest = id.slice(VIRTUAL_MODULE_REGISTRY_PREFIX.length)
  if (rest.includes('\u0000')) return null

  const plugin = readLengthPrefixed()
  if (plugin == null || plugin.length === 0) return null
  const name = readLengthPrefixed()
  if (name == null || name.length === 0) return null

  const query: Array<readonly [string, string]> = []
  if (rest.length > 0) {
    if (!rest.startsWith('?')) return null
    const rawQuery = rest.slice(1)
    rest = ''
    if (rawQuery.length === 0) return null
    const segments = rawQuery.split('&')
    let prev: readonly [string, string] | null = null
    for (const segment of segments) {
      const eq = segment.indexOf('=')
      // exactly one literal '=' separator; key must be non-empty
      if (eq <= 0 || segment.includes('=', eq + 1)) return null
      const key = strictPercentDecode(segment.slice(0, eq))
      const value = strictPercentDecode(segment.slice(eq + 1))
      if (key == null || value == null || key.length === 0) return null
      const pair: readonly [string, string] = [key, value]
      // enforce canonical (non-decreasing) order so each spec has
      // exactly one valid id
      if (prev != null && comparePairs(prev, pair) > 0) return null
      prev = pair
      query.push(pair)
    }
  }

  return { plugin, name, query }

  function readLengthPrefixed(): string | null {
    let i = 0
    while (i < rest.length && rest[i] >= '0' && rest[i] <= '9') i++
    // need at least one digit followed by ':'
    if (i === 0 || i >= rest.length || rest[i] !== ':') return null
    const digits = rest.slice(0, i)
    // canonical decimal: no leading zeros
    if (digits.length > 1 && digits[0] === '0') return null
    const len = Number(digits)
    if (!Number.isSafeInteger(len)) return null
    const start = i + 1
    if (rest.length - start < len) return null
    const value = rest.slice(start, start + len)
    rest = rest.slice(start + len)
    return value
  }
}

export interface VirtualModuleToLoad extends DecodedVirtualModuleId {
  /** The full internal id (as produced by encodeVirtualModuleId). */
  readonly id: string
}

export type VirtualModuleLoader = (module: VirtualModuleToLoad) => unknown

interface RegistryEntry {
  readonly spec: DecodedVirtualModuleId
  readonly loader: VirtualModuleLoader
}

/**
 * A frozen view of the registrations at a point in time.
 * resolveId, resolveSpec and load of one snapshot all read the same
 * frozen registration map, so a module that resolves is always loadable and
 * vice versa. Registrations added after the snapshot was taken are invisible
 * to it. Ids that do not belong to the registry (external files, other
 * plugins' virtual modules) always yield null, leaving plugins that do not
 * use the registry completely unaffected.
 */
export interface VirtualModuleRegistrySnapshot {
  /** Number of registrations captured in this snapshot. */
  readonly size: number
  /** True only for well-formed ids registered in this snapshot. */
  has(id: string): boolean
  /**
   * Resolve an incoming id. Returns the id unchanged when it is a
   * well-formed registry id present in this snapshot, otherwise null
   * (letting other plugins / the default resolver handle it).
   */
  resolveId(id: string): string | null
  /**
   * Look up the internal id for a spec. Returns null when the spec was
   * not registered in this snapshot. Useful to translate public import
   * specifiers (e.g. virtual:my-plugin/config) into internal ids.
   */
  resolveSpec(spec: VirtualModuleSpec): string | null
  /**
   * Load a module. Returns the loader's result for registered ids and
   * null for everything else — in particular, forged ids that were never
   * registered never trigger a loader.
   */
  load(id: string): unknown
}

export interface VirtualModuleRegistry {
  /**
   * Register a virtual module. Returns its internal id.
   * Registering the same spec twice replaces the previous loader; the id
   * stays identical because the encoding is deterministic.
   */
  register(spec: VirtualModuleSpec, loader: VirtualModuleLoader): string
  /** Capture the current registrations as a frozen snapshot. */
  snapshot(): VirtualModuleRegistrySnapshot
}

export function createVirtualModuleRegistry(): VirtualModuleRegistry {
  const entries = new Map<string, RegistryEntry>()

  return {
    register(spec, loader) {
      if (typeof loader !== 'function') {
        throw new Error('[virtual-module-registry] loader must be a function')
      }
      const id = encodeVirtualModuleId(spec)
      const decoded = decodeVirtualModuleId(id)!
      entries.set(id, { spec: decoded, loader })
      return id
    },

    snapshot(): VirtualModuleRegistrySnapshot {
      // frozen copy: resolve and load share exactly this map
      const frozen: ReadonlyMap<string, RegistryEntry> = new Map(entries)
      return {
        size: frozen.size,
        has(id) {
          return typeof id === 'string' && frozen.has(id)
        },
        resolveId(id) {
          if (typeof id !== 'string' || !frozen.has(id)) return null
          return id
        },
        resolveSpec(spec) {
          let id: string
          try {
            id = encodeVirtualModuleId(spec)
          } catch {
            return null
          }
          return frozen.has(id) ? id : null
        },
        load(id) {
          if (typeof id !== 'string') return null
          const entry = frozen.get(id)
          if (!entry) return null
          return entry.loader({ ...entry.spec, id })
        },
      }
    },
  }
}
