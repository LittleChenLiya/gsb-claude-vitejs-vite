import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { createDebugger } from '../utils'

const debug = createDebugger('vite:header-strategy')

/**
 * # Header Strategy Layer
 *
 * Explicit development-response header strategy layer. Headers are registered
 * per response category (`static`, `transform`, `error`) and resolved by
 * declaration priority, so the final winning value does not depend on
 * middleware write order ("last writer wins" is replaced by explicit
 * priority resolution).
 *
 * ## Design
 *
 * - **Declaration priority** (`builtin` > `strategy` > `business`):
 *   - `builtin`  – internally determined headers (e.g. `Content-Length`
 *     computed from the response body). Cannot be overridden by business
 *     headers.
 *   - `strategy` – category-specific headers (e.g. per-category cache
 *     headers). Registered for a specific category.
 *   - `business` – user-provided `server.headers`. Registered globally.
 * - **Startup conflict rejection**: same-priority declarations for the same
 *   header within a category are rejected when the strategy is frozen
 *   (server startup), not at request time.
 * - **Multi-value preservation**: headers that may appear multiple times per
 *   HTTP (e.g. `Set-Cookie`) are accumulated additively and never combined
 *   into a single comma-separated value, which would corrupt cookie values.
 * - **Content-Length protection**: the internally determined `Content-Length`
 *   is always computed from the response body at `builtin` priority and cannot
 *   be overridden by business headers.
 * - **Per-request winner recording**: the actual winning source for each
 *   header is recorded on the response object for debugging and verification.
 *
 * ## Attribution
 *
 * This module is part of the Vite dev server. It was introduced to replace
 * the previous ad-hoc header application (where the final value depended on
 * middleware write order) with an explicit, priority-based strategy layer.
 */

/**
 * The response category a header is registered for.
 *
 * - static    - static assets served by sirv (public dir, root, /@fs)
 * - transform - transformed modules served by the transform middleware
 * - error     - error responses (4xx/5xx)
 */
export type HeaderCategory = 'static' | 'transform' | 'error'

/**
 * Declaration priority. Higher priority wins when multiple sources declare
 * the same header.
 *
 * - builtin  - internally determined headers (e.g. Content-Length from the
 *   body). Cannot be overridden by business headers.
 * - strategy - category-specific headers (e.g. per-category cache headers).
 * - business - user-provided server.headers.
 */
export type HeaderPriority = 'builtin' | 'strategy' | 'business'

const PRIORITY_RANK: Record<HeaderPriority, number> = {
  builtin: 3,
  strategy: 2,
  business: 1,
}

export interface HeaderDeclaration {
  name: string
  value: string | string[] | number
  priority: HeaderPriority
  source: string
  category: HeaderCategory | 'global'
}

export interface WinningHeader {
  name: string
  value: string | string[] | number
  source: string
  priority: HeaderPriority
}

export interface RuntimeHeader {
  name: string
  value: string | string[] | number
  source: string
}

export interface HeaderStrategy {
  register(
    category: HeaderCategory | 'global',
    headers: OutgoingHttpHeaders,
    priority: HeaderPriority,
    source: string,
  ): void
  freeze(): void
  apply(
    res: ServerResponse,
    category: HeaderCategory,
    body?: string | Buffer,
    runtime?: RuntimeHeader[],
  ): WinningHeader[]
  getWinners(res: ServerResponse): WinningHeader[]
}

const MULTI_VALUE_HEADERS = new Set(['set-cookie'])

const winnersSymbol = Symbol('vite.headerWinners')

export function createHeaderStrategy(): HeaderStrategy {
  const declarations: HeaderDeclaration[] = []
  let frozen = false

  function register(
    category: HeaderCategory | 'global',
    headers: OutgoingHttpHeaders,
    priority: HeaderPriority,
    source: string,
  ): void {
    if (frozen) {
      throw new Error(
        `[vite:header-strategy] cannot register headers after the strategy has been frozen (source: ${source})`,
      )
    }
    for (const rawName in headers) {
      const name = rawName.toLowerCase()
      const value = headers[rawName]!
      declarations.push({ name, value, priority, source, category })
    }
  }

  function freeze(): void {
    if (frozen) return
    frozen = true
    validateConflicts()
  }

  function validateConflicts(): void {
    for (const category of [
      'static',
      'transform',
      'error',
    ] as HeaderCategory[]) {
      const applicable = declarations.filter(
        (d) => d.category === 'global' || d.category === category,
      )
      const groups = new Map<string, HeaderDeclaration[]>()
      for (const decl of applicable) {
        if (MULTI_VALUE_HEADERS.has(decl.name)) continue
        const group = groups.get(decl.name)
        if (group) group.push(decl)
        else groups.set(decl.name, [decl])
      }
      for (const [name, group] of groups) {
        const maxRank = Math.max(...group.map((d) => PRIORITY_RANK[d.priority]))
        const winners = group.filter(
          (d) => PRIORITY_RANK[d.priority] === maxRank,
        )
        if (winners.length > 1) {
          throw new Error(
            `[vite:header-strategy] same-priority header conflict for "${name}" in category "${category}": ${winners
              .map((w) => `"${w.source}" (${w.priority})`)
              .join(', ')}`,
          )
        }
      }
    }
  }

  function resolve(
    category: HeaderCategory,
    runtime?: RuntimeHeader[],
  ): {
    winners: Map<string, HeaderDeclaration>
    multiValues: Map<string, { values: (string | number)[]; sources: string[] }>
  } {
    const applicable = declarations.filter(
      (d) => d.category === 'global' || d.category === category,
    )
    const all: HeaderDeclaration[] = [...applicable]
    if (runtime) {
      for (const r of runtime) {
        all.push({
          name: r.name.toLowerCase(),
          value: r.value,
          priority: 'strategy',
          source: r.source,
          category,
        })
      }
    }

    const winners = new Map<string, HeaderDeclaration>()
    const multiValues = new Map<
      string,
      { values: (string | number)[]; sources: string[] }
    >()

    for (const decl of all) {
      if (MULTI_VALUE_HEADERS.has(decl.name)) {
        const values = Array.isArray(decl.value) ? decl.value : [decl.value]
        const existing = multiValues.get(decl.name)
        if (existing) {
          existing.values.push(...values)
          existing.sources.push(decl.source)
        } else {
          multiValues.set(decl.name, {
            values: [...values],
            sources: [decl.source],
          })
        }
        continue
      }
      // Content-Length is always builtin. Business/strategy declarations are
      // ignored so the internally determined value cannot be overridden.
      if (decl.name === 'content-length' && decl.priority !== 'builtin') {
        continue
      }
      const rank = PRIORITY_RANK[decl.priority]
      const existing = winners.get(decl.name)
      // Later declarations win on equal priority: runtime headers are more
      // specific than frozen category defaults.
      if (!existing || rank >= PRIORITY_RANK[existing.priority]) {
        winners.set(decl.name, decl)
      }
    }

    return { winners, multiValues }
  }

  function apply(
    res: ServerResponse,
    category: HeaderCategory,
    body?: string | Buffer,
    runtime?: RuntimeHeader[],
  ): WinningHeader[] {
    if (!frozen) freeze()
    const { winners, multiValues } = resolve(category, runtime)

    // Content-Length is computed from the body at builtin priority so it
    // cannot be overridden by business headers.
    if (body !== undefined) {
      winners.set('content-length', {
        name: 'content-length',
        value: Buffer.byteLength(body),
        priority: 'builtin',
        source: 'builtin:content-length',
        category,
      })
    }

    // Apply multi-value headers first (additive, never combined).
    for (const [name, { values }] of multiValues) {
      for (const v of values) {
        res.appendHeader(name, String(v))
      }
    }

    // Apply single-value headers.
    for (const [name, decl] of winners) {
      res.setHeader(name, decl.value as string | number | string[])
    }

    const recorded: WinningHeader[] = [
      ...[...winners.values()].map((d) => ({
        name: d.name,
        value: d.value,
        source: d.source,
        priority: d.priority,
      })),
      ...[...multiValues.entries()].map(([name, { values, sources }]) => ({
        name,
        value: values as string[],
        source: sources.join(','),
        priority: 'business' as HeaderPriority,
      })),
    ]
    ;(res as unknown as Record<symbol, unknown>)[winnersSymbol] = recorded
    debug?.(
      `[${category}] winning headers: ${recorded
        .map((w) => `${w.name}=${w.source}`)
        .join(', ')}`,
    )
    return recorded
  }

  function getWinners(res: ServerResponse): WinningHeader[] {
    return (
      (res as unknown as Record<symbol, WinningHeader[]>)[winnersSymbol] || []
    )
  }

  return { register, freeze, apply, getWinners }
}
