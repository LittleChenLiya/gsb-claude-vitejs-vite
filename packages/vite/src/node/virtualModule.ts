/**
 * Explicit virtual module registrar.
 *
 * The registrar gives plugin authors a safe, collision-free way to declare
 * virtual modules. Instead of hand-rolling `virtual:` ids and string
 * concatenation, a plugin registers a logical module name together with a
 * load callback and resolves it to an internal id produced by
 * {@link encodeVirtualModuleId}.
 *
 * The internal id encodes three distinct fields:
 *
 * - the plugin name (who owns the module)
 * - the module logical name (what the plugin calls it)
 * - the query parameters (a canonical, order-independent list of key/value pairs)
 *
 * The fields are serialized into a structured payload and base64url encoded, so
 * names containing `:`, `/`, `?` or any other character can never collide by
 * construction. A reserved prefix plus strict reverse decoding ensures that
 * only ids produced by the registrar are accepted; external file ids (or any
 * other forged string) cannot impersonate a registered module.
 */

/**
 * Reserved prefix for internal virtual module ids produced by the registrar.
 *
 * It reuses the rollup `\0` virtual module convention and adds a
 * `vite:virtual:` namespace so that registrar ids are unambiguous and cannot
 * be confused with user-authored `virtual:` ids or real files on disk.
 */
export const VIRTUAL_MODULE_ID_PREFIX = '\0vite:virtual:'

/**
 * Current payload version. Bump when the payload shape changes.
 */
const VIRTUAL_MODULE_PAYLOAD_VERSION = 1

/**
 * A single canonical query entry: `[key, value]`.
 */
export type VirtualModuleQueryEntry = readonly [string, string]

/**
 * Accepted forms for query parameters.
 */
export type VirtualModuleQuery =
  | Readonly<Record<string, string>>
  | URLSearchParams
  | ReadonlyArray<VirtualModuleQueryEntry>

/**
 * The decoded identity of a virtual module id.
 */
export interface VirtualModuleIdParts {
  /** The plugin that owns the module. */
  pluginName: string
  /** The logical module name registered by the plugin. */
  moduleName: string
  /** Canonical, order-independent query entries. */
  query: VirtualModuleQueryEntry[]
}

/**
 * The result of loading a virtual module.
 *
 * Mirrors the shape accepted by the `load` hook: a string, `null`, or an
 * object with `code` and an optional sourcemap.
 */
export type VirtualModuleLoadResult =
  | string
  | null
  | {
      code: string
      map?: {
        version: number
        mappings: string
        sources?: string[]
        names?: string[]
      } | null
    }

/**
 * A callback that produces the contents of a registered virtual module.
 * It receives the canonical query entries of the resolved id.
 */
export type VirtualModuleLoadFn = (
  query: VirtualModuleQueryEntry[],
) => VirtualModuleLoadResult | Promise<VirtualModuleLoadResult>

/**
 * A registrar owns the virtual modules of a single plugin.
 *
 * `resolve` and `load` share the same registration snapshot: a module that was
 * registered can be resolved and then loaded, and a module that was never
 * registered (or an id that fails validation) is rejected.
 */
export interface VirtualModuleRegistrar {
  /** The plugin name this registrar belongs to. */
  readonly pluginName: string
  /**
   * Register a virtual module under a logical name.
   * Throws if a module with the same name is already registered.
   */
  register(moduleName: string, loadFn: VirtualModuleLoadFn): this
  /** Whether a module with the given logical name is registered. */
  has(moduleName: string): boolean
  /**
   * Resolve a logical module name (and optional query) to an internal id.
   * Throws if the module is not registered.
   */
  resolve(moduleName: string, query?: VirtualModuleQuery): string
  /**
   * Load a previously resolved internal id.
   * Returns `null` if the id is not a valid, registered virtual module.
   */
  load(id: string): Promise<VirtualModuleLoadResult>
}

function toQueryEntries(
  query: VirtualModuleQuery | undefined,
): VirtualModuleQueryEntry[] {
  if (!query) {
    return []
  }
  if (Array.isArray(query)) {
    return query.map(([key, value]) => [String(key), String(value)])
  }
  if (query instanceof URLSearchParams) {
    return [...query.entries()].map(([key, value]) => [key, value])
  }
  return Object.entries(query).map(([key, value]) => [key, String(value)])
}

/**
 * Canonicalize query entries so the internal id is independent of the order
 * in which the user wrote the query string.
 *
 * Entries are sorted lexicographically by key and then by value. This makes
 * `?a=1&b=2` and `?b=2&a=1` resolve to the same internal id while keeping
 * duplicate keys with different values distinct.
 */
function canonicalizeQuery(
  query: VirtualModuleQuery | undefined,
): VirtualModuleQueryEntry[] {
  const entries = toQueryEntries(query)
  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey !== bKey) {
      return aKey < bKey ? -1 : 1
    }
    if (aValue !== bValue) {
      return aValue < bValue ? -1 : 1
    }
    return 0
  })
  return entries
}

function base64urlEncode(input: string): string {
  // btoa is available in Node 20+ and modern browsers.
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return atob(padded + pad)
}

/**
 * Encode a virtual module identity into an internal id.
 *
 * The payload is a structured tuple `[version, pluginName, moduleName, query]`
 * serialized to JSON and base64url encoded, so the three fields can never be
 * confused with one another regardless of the characters they contain.
 */
export function encodeVirtualModuleId(
  pluginName: string,
  moduleName: string,
  query?: VirtualModuleQuery,
): string {
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    throw new Error(
      'encodeVirtualModuleId: pluginName must be a non-empty string',
    )
  }
  if (typeof moduleName !== 'string' || moduleName.length === 0) {
    throw new Error(
      'encodeVirtualModuleId: moduleName must be a non-empty string',
    )
  }
  const payload = JSON.stringify([
    VIRTUAL_MODULE_PAYLOAD_VERSION,
    pluginName,
    moduleName,
    canonicalizeQuery(query),
  ])
  return VIRTUAL_MODULE_ID_PREFIX + base64urlEncode(payload)
}

function isQueryEntry(value: unknown): value is VirtualModuleQueryEntry {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  )
}

/**
 * Reverse an internal id produced by {@link encodeVirtualModuleId}.
 *
 * The reserved prefix is checked first, then the payload is decoded and
 * strictly validated. Returns `null` for any id that is not a well-formed
 * registrar virtual module id, including external file ids and forged strings.
 */
export function decodeVirtualModuleId(id: string): VirtualModuleIdParts | null {
  if (typeof id !== 'string' || !id.startsWith(VIRTUAL_MODULE_ID_PREFIX)) {
    return null
  }
  const body = id.slice(VIRTUAL_MODULE_ID_PREFIX.length)
  if (body.length === 0) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(base64urlDecode(body))
  } catch {
    return null
  }
  if (!Array.isArray(payload) || payload.length !== 4) {
    return null
  }
  const [version, pluginName, moduleName, query] = payload
  if (version !== VIRTUAL_MODULE_PAYLOAD_VERSION) {
    return null
  }
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    return null
  }
  if (typeof moduleName !== 'string' || moduleName.length === 0) {
    return null
  }
  if (!Array.isArray(query) || !query.every(isQueryEntry)) {
    return null
  }
  return { pluginName, moduleName, query }
}

/**
 * Parse a user-facing virtual module source (e.g. `virtual:my-module?foo=bar`)
 * into a logical module name and query entries.
 *
 * Returns `null` when the source does not start with the given prefix.
 */
export function parseVirtualModuleSource(
  source: string,
  prefix = 'virtual:',
): { moduleName: string; query: VirtualModuleQueryEntry[] } | null {
  if (typeof source !== 'string' || !source.startsWith(prefix)) {
    return null
  }
  const rest = source.slice(prefix.length)
  const queryIndex = rest.indexOf('?')
  const moduleName = queryIndex === -1 ? rest : rest.slice(0, queryIndex)
  if (moduleName.length === 0) {
    return null
  }
  const queryString = queryIndex === -1 ? '' : rest.slice(queryIndex + 1)
  const query = canonicalizeQuery(
    queryString.length > 0
      ? ([
          ...new URLSearchParams(queryString).entries(),
        ] as VirtualModuleQueryEntry[])
      : undefined,
  )
  return { moduleName, query }
}

/**
 * Create a {@link VirtualModuleRegistrar} for a plugin.
 *
 * The registrar keeps a single registration snapshot that is shared by
 * `resolve` and `load`: modules registered through `register` can be resolved
 * to internal ids and then loaded, while any id that fails validation or was
 * not registered is rejected.
 */
export function createVirtualModuleRegistrar(
  pluginName: string,
): VirtualModuleRegistrar {
  if (typeof pluginName !== 'string' || pluginName.length === 0) {
    throw new Error(
      'createVirtualModuleRegistrar: pluginName must be a non-empty string',
    )
  }

  const modules = new Map<string, VirtualModuleLoadFn>()

  const registrar: VirtualModuleRegistrar = {
    pluginName,

    register(moduleName, loadFn) {
      if (typeof moduleName !== 'string' || moduleName.length === 0) {
        throw new Error(
          'createVirtualModuleRegistrar: moduleName must be a non-empty string',
        )
      }
      if (modules.has(moduleName)) {
        throw new Error(
          `createVirtualModuleRegistrar: module "${moduleName}" is already registered for plugin "${pluginName}"`,
        )
      }
      modules.set(moduleName, loadFn)
      return registrar
    },

    has(moduleName) {
      return modules.has(moduleName)
    },

    resolve(moduleName, query) {
      if (!modules.has(moduleName)) {
        throw new Error(
          `createVirtualModuleRegistrar: module "${moduleName}" is not registered for plugin "${pluginName}"`,
        )
      }
      return encodeVirtualModuleId(pluginName, moduleName, query)
    },

    async load(id) {
      const parts = decodeVirtualModuleId(id)
      if (!parts || parts.pluginName !== pluginName) {
        return null
      }
      const loadFn = modules.get(parts.moduleName)
      if (!loadFn) {
        return null
      }
      return loadFn(parts.query)
    },
  }

  return registrar
}
