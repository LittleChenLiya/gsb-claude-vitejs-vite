import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'

/**
 * Explicit dev-response header policy layer.
 *
 * Instead of letting every middleware write headers directly and hoping the
 * last write wins, headers are registered up front per response category
 * ("scope"): static assets, transformed modules and error responses. Every
 * registration declares a priority and a source. Conflicts at the same
 * priority are rejected before the server starts, HTTP multi-value rules are
 * preserved (e.g. `Set-Cookie` is never joined into a single line), headers
 * that Vite determines internally (e.g. `Content-Length`) cannot be
 * overridden by business configuration, and the actual winning source is
 * recorded for every request.
 */

/**
 * The response categories a header policy can be registered for.
 * - `static`: responses served from the filesystem (public dir, project root, `/@fs/`)
 * - `transform`: responses produced by the transform pipeline (modules, source maps)
 * - `error`: error responses (500 overlay page, 403 restricted, 504 outdated requests)
 */
export type HeaderPolicyScope = 'static' | 'transform' | 'error'

export const headerPolicyScopes: readonly HeaderPolicyScope[] = [
  'static',
  'transform',
  'error',
]

/**
 * Scoped header policies for dev server responses. Each category is applied
 * on top of `server.headers` and Vite's internal defaults.
 */
export interface HeaderPolicyOptions {
  /** Headers applied to static asset responses. */
  static?: OutgoingHttpHeaders
  /** Headers applied to transformed module responses. */
  transform?: OutgoingHttpHeaders
  /** Headers applied to error responses. */
  error?: OutgoingHttpHeaders
}

/**
 * Well-known priorities for header registrations. A registration with a
 * higher priority wins over a lower priority one for the same header name.
 */
export const HEADER_POLICY_PRIORITY = {
  /** Vite-internal defaults such as `Content-Type`, `Etag` and the default `Cache-Control`. */
  internal: 0,
  /** Business headers configured via `server.headers`. */
  user: 10,
  /** Scoped policy headers configured via `server.headerPolicy.*`. */
  policy: 20,
} as const

/**
 * Headers whose value is determined by Vite (or the underlying HTTP server)
 * for each response and can never be registered by business configuration.
 */
const lockedHeaders = new Set(['content-length'])

/**
 * Headers that must never be combined into a single comma-separated line.
 * Every registered value is emitted as its own header field line.
 * (RFC 9110 section 5.3: `Set-Cookie` is not a list-based header.)
 */
const multiValueHeaders = new Set(['set-cookie'])

/**
 * List-based headers whose values may be combined with `, ` per RFC 9110
 * section 5.3 when several registrations apply to the same response.
 */
const combinableHeaders = new Set(['vary'])

export interface HeaderRegistration {
  /** Header name (case-insensitive, stored lowercased). */
  name: string
  value: string | number | string[]
  /**
   * Who registered the header, e.g. `server.headers`,
   * `server.headerPolicy.static` or a plugin name. Recorded as the winning
   * source when this registration is applied to a response.
   */
  source: string
  /** Higher priority wins. Same-priority conflicts are rejected. */
  priority: number
  /** The response categories this registration applies to. */
  scopes: readonly HeaderPolicyScope[]
}

export interface ResolvedHeader {
  name: string
  value: string | number | string[]
  /** The source(s) that produced the winning value. */
  source: string
}

const internalSource = 'vite:internal'

function headerValuesEqual(
  a: string | number | string[],
  b: string | number | string[],
): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => v === b[i])
    )
  }
  return String(a) === String(b)
}

function scopesOverlap(
  a: readonly HeaderPolicyScope[],
  b: readonly HeaderPolicyScope[],
): boolean {
  return a.some((scope) => b.includes(scope))
}

export class HeaderPolicyRegistry {
  #registrations: HeaderRegistration[] = []

  /**
   * Register a header. Throws when the header is locked (managed internally)
   * or when another source already registered a different value for the same
   * header at the same priority in an overlapping scope. Registrations happen
   * before the server starts listening, so misconfiguration is rejected at
   * startup instead of being decided by middleware write order.
   */
  register(registration: HeaderRegistration): void {
    const name = registration.name.toLowerCase()
    if (!name || /[\r\n:]/.test(name)) {
      throw new Error(
        `[vite] Invalid response header name ${JSON.stringify(registration.name)} registered by "${registration.source}".`,
      )
    }
    if (lockedHeaders.has(name)) {
      throw new Error(
        `[vite] The "${name}" response header is determined internally by Vite and cannot be overridden (registered by "${registration.source}"). Remove it from the header configuration.`,
      )
    }
    if (!multiValueHeaders.has(name) && !combinableHeaders.has(name)) {
      for (const existing of this.#registrations) {
        if (
          existing.name === name &&
          existing.priority === registration.priority &&
          existing.source !== registration.source &&
          scopesOverlap(existing.scopes, registration.scopes) &&
          !headerValuesEqual(existing.value, registration.value)
        ) {
          throw new Error(
            `[vite] Conflicting registrations for response header "${name}" at priority ${registration.priority}: ` +
              `"${existing.source}" and "${registration.source}" declare different values for an overlapping scope. ` +
              `Declare distinct priorities to make the winner explicit.`,
          )
        }
      }
    }
    this.#registrations.push({ ...registration, name })
  }

  /** Register every header of a `OutgoingHttpHeaders` map from one source. */
  registerAll(
    headers: OutgoingHttpHeaders,
    options: {
      source: string
      priority: number
      scopes: readonly HeaderPolicyScope[]
    },
  ): void {
    for (const name in headers) {
      const value = headers[name]
      if (value === undefined) continue
      this.register({ name, value, ...options })
    }
  }

  /**
   * Resolve the winning headers for a response category. `internal` holds the
   * per-response values determined by Vite (e.g. `Content-Type`, `Etag`);
   * they participate at the lowest priority and win ties against same
   * priority registrations so resolution never depends on write order.
   */
  resolve(
    scope: HeaderPolicyScope,
    internal?: OutgoingHttpHeaders,
  ): Map<string, ResolvedHeader> {
    interface Candidate {
      value: string | number | string[]
      source: string
      priority: number
    }
    const candidates = new Map<string, Candidate[]>()
    const add = (name: string, candidate: Candidate) => {
      const key = name.toLowerCase()
      let list = candidates.get(key)
      if (!list) {
        list = []
        candidates.set(key, list)
      }
      list.push(candidate)
    }
    if (internal) {
      for (const name in internal) {
        const value = internal[name]
        if (value === undefined) continue
        add(name, {
          value,
          source: internalSource,
          priority: HEADER_POLICY_PRIORITY.internal,
        })
      }
    }
    for (const registration of this.#registrations) {
      if (registration.scopes.includes(scope)) {
        add(registration.name, {
          value: registration.value,
          source: registration.source,
          priority: registration.priority,
        })
      }
    }

    const resolved = new Map<string, ResolvedHeader>()
    for (const [name, list] of candidates) {
      if (multiValueHeaders.has(name)) {
        // Preserve every value as its own header field line, lowest
        // priority first so higher priority values are sent last.
        const sorted = [...list].sort((a, b) => a.priority - b.priority)
        const value = sorted.flatMap((candidate) =>
          Array.isArray(candidate.value)
            ? candidate.value
            : [String(candidate.value)],
        )
        const source = [...new Set(sorted.map((c) => c.source))].join(' + ')
        resolved.set(name, { name, value, source })
      } else if (combinableHeaders.has(name)) {
        // List-based header: combine distinct tokens, highest priority first.
        const sorted = [...list].sort((a, b) => b.priority - a.priority)
        const tokens = [
          ...new Set(
            sorted.flatMap((candidate) =>
              (Array.isArray(candidate.value)
                ? candidate.value
                : [String(candidate.value)]
              )
                .flatMap((v) => v.split(','))
                .map((token) => token.trim())
                .filter(Boolean),
            ),
          ),
        ]
        const source = [...new Set(sorted.map((c) => c.source))].join(' + ')
        resolved.set(name, { name, value: tokens.join(', '), source })
      } else {
        // Single winner: highest priority. Ties are impossible between
        // registrations (rejected at registration time); internal defaults
        // are listed first and therefore win ties deterministically.
        let winner = list[0]!
        for (const candidate of list) {
          if (candidate.priority > winner.priority) {
            winner = candidate
          }
        }
        resolved.set(name, {
          name,
          value: winner.value,
          source: winner.source,
        })
      }
    }
    return resolved
  }
}

/**
 * Create the registry for a dev server from the resolved config.
 * `server.headers` keeps its default behavior (applies to every response
 * category); `server.headerPolicy.*` registrations are scoped per category
 * and win over `server.headers` by priority. Throws on same-priority
 * conflicts and on attempts to override internally managed headers, so the
 * server refuses to start with an ambiguous header configuration.
 */
export function createHeaderPolicyRegistry(server: {
  headers?: OutgoingHttpHeaders
  headerPolicy?: HeaderPolicyOptions
}): HeaderPolicyRegistry {
  const registry = new HeaderPolicyRegistry()
  if (server.headers) {
    registry.registerAll(server.headers, {
      source: 'server.headers',
      priority: HEADER_POLICY_PRIORITY.user,
      scopes: headerPolicyScopes,
    })
  }
  if (server.headerPolicy) {
    for (const scope of headerPolicyScopes) {
      const headers = server.headerPolicy[scope]
      if (headers) {
        registry.registerAll(headers, {
          source: `server.headerPolicy.${scope}`,
          priority: HEADER_POLICY_PRIORITY.policy,
          scopes: [scope],
        })
      }
    }
  }
  return registry
}

/**
 * Per-request record of the source that won each applied header, keyed by
 * the (lowercased) header name. Stored in a WeakMap so the record is
 * collected together with the response.
 */
const responseHeaderSources = new WeakMap<
  ServerResponse,
  Record<string, string>
>()

/**
 * Get the winning source of each header the policy layer applied to this
 * response, e.g. `{ 'cache-control': 'server.headerPolicy.transform' }`.
 * Returns `undefined` if no policy-managed header was applied.
 */
export function getResponseHeaderSources(
  res: ServerResponse,
): Record<string, string> | undefined {
  return responseHeaderSources.get(res)
}

/**
 * Resolve the registered policy for `scope` and write the winning headers to
 * the response, recording the winning source of each header for the request.
 */
export function applyResponseHeaders(
  registry: HeaderPolicyRegistry,
  res: ServerResponse,
  scope: HeaderPolicyScope,
  internal?: OutgoingHttpHeaders,
): void {
  const resolved = registry.resolve(scope, internal)
  if (resolved.size === 0) return
  const record = responseHeaderSources.get(res) ?? {}
  for (const [name, header] of resolved) {
    res.setHeader(name, header.value)
    record[name] = header.source
  }
  responseHeaderSources.set(res, record)
}
