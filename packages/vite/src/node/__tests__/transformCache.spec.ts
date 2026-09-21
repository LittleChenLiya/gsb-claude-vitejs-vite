import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from '..'
import type { Plugin, ViteDevServer } from '..'
import { promiseWithResolvers } from '../../shared/utils'

const optimizeDeps = { noDiscovery: true, include: [] as string[] }

const pad = (code: string, size: number): string => {
  const comment = `/*${'x'.repeat(Math.max(0, size - code.length - 5))}*/`
  return `${code}\n${comment}`
}

// All modules are exactly 100 bytes of utf-8 code
const moduleCode: Record<string, string> = {
  '/virtual/a.js': pad('export const a = 1', 100),
  '/virtual/b.js': pad('export const b = 2', 100),
  '/virtual/c.js': pad('export const c = 3', 100),
  '/virtual/mapmod.js': 'export const mapmod = 4',
  '/virtual/gated.js': 'export const gated = 5',
  '/virtual/fail.js': 'export const fail = 6',
}

const bigMap = {
  version: 3,
  sources: [],
  names: ['x'.repeat(4000)],
  mappings: '',
}

interface PluginState {
  transformCounts: Map<string, number>
  fail: Set<string>
  gateEntered?: ReturnType<typeof promiseWithResolvers<void>>
  gateRelease?: ReturnType<typeof promiseWithResolvers<void>>
}

function createTestPlugin(state: PluginState): Plugin {
  return {
    name: 'transform-cache-test',
    resolveId(id) {
      if (id in moduleCode) return '\0' + id
    },
    load(id) {
      if (id.startsWith('\0/virtual/')) {
        return moduleCode[id.slice(1)]
      }
    },
    async transform(code, id) {
      if (!id.startsWith('\0/virtual/')) return
      const key = `${this.environment.name}:${id}`
      state.transformCounts.set(key, (state.transformCounts.get(key) ?? 0) + 1)
      if (state.fail.has(id)) {
        throw new Error(`transform failed for ${id}`)
      }
      if (
        id === '\0/virtual/gated.js' &&
        state.gateEntered &&
        state.gateRelease
      ) {
        state.gateEntered.resolve()
        await state.gateRelease.promise
      }
      if (id === '\0/virtual/mapmod.js') {
        return { code: code + '\n// mapped', map: bigMap }
      }
    },
  }
}

const billed = (result: { code: string; map: unknown }): number =>
  Buffer.byteLength(result.code, 'utf8') +
  (result.map ? Buffer.byteLength(JSON.stringify(result.map), 'utf8') : 0)

function transformCount(
  state: PluginState,
  url: string,
  env = 'client',
): number {
  return state.transformCounts.get(`${env}:\0${url}`) ?? 0
}

describe('transformCacheBudget', () => {
  const servers: ViteDevServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  async function createBudgetServer(
    devOptions: {
      transformCacheBudget?: number
    } = {},
    options: {
      ssrBudget?: number
      listen?: boolean
    } = {},
  ) {
    const state: PluginState = {
      transformCounts: new Map(),
      fail: new Set(),
    }
    const server = await createServer({
      configFile: false,
      root: path.join(import.meta.dirname, 'fixtures', 'transform-cache'),
      logLevel: 'silent',
      optimizeDeps,
      dev: devOptions,
      environments:
        options.ssrBudget !== undefined
          ? { ssr: { dev: { transformCacheBudget: options.ssrBudget } } }
          : undefined,
      server: options.listen
        ? { port: 0, strictPort: false, ws: false, watch: null }
        : { middlewareMode: true, ws: false, watch: null },
      plugins: [createTestPlugin(state)],
    })
    servers.push(server)
    if (options.listen) {
      await server.listen()
    }
    return { server, state, env: server.environments.client }
  }

  test('no budget keeps the default behavior', async () => {
    const { server, state, env } = await createBudgetServer()

    await env.transformRequest('/virtual/a.js')
    await env.transformRequest('/virtual/a.js')
    expect(transformCount(state, '/virtual/a.js')).toBe(1)

    const mod =
      await server.environments.client.moduleGraph.getModuleByUrl(
        '/virtual/a.js',
      )
    expect(mod?.transformResult).not.toBeNull()
    // stats stay at zero when no budget is set
    expect(env.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })
  })

  test('evicts least recently used results and tracks stats', async () => {
    const { server, state, env } = await createBudgetServer({
      transformCacheBudget: 250,
    })
    const graph = server.environments.client.moduleGraph
    const getMod = (url: string) => graph.getModuleByUrl(url)

    const resultA = await env.transformRequest('/virtual/a.js')
    const sizeA = Buffer.byteLength(resultA!.code, 'utf8')
    expect(sizeA).toBe(100)

    await env.transformRequest('/virtual/b.js')
    expect(env.transformCacheStats).toEqual({
      entries: 2,
      bytes: 200,
      evictions: 0,
    })

    // adding c evicts a (the least recently used)
    await env.transformRequest('/virtual/c.js')
    expect(env.transformCacheStats).toEqual({
      entries: 2,
      bytes: 200,
      evictions: 1,
    })
    expect((await getMod('/virtual/a.js'))?.transformResult).toBeNull()
    expect((await getMod('/virtual/b.js'))?.transformResult).not.toBeNull()
    // module graph nodes and dependency edges are kept
    expect(graph.urlToModuleMap.size).toBe(3)

    // cache hit: b is not re-transformed and becomes the most recently used
    await env.transformRequest('/virtual/b.js')
    expect(transformCount(state, '/virtual/b.js')).toBe(1)
    expect(env.transformCacheStats.bytes).toBe(200)

    // adding a again evicts c (b was just used)
    await env.transformRequest('/virtual/a.js')
    expect(transformCount(state, '/virtual/a.js')).toBe(2)
    expect(env.transformCacheStats).toEqual({
      entries: 2,
      bytes: 200,
      evictions: 2,
    })
    expect((await getMod('/virtual/c.js'))?.transformResult).toBeNull()
    expect((await getMod('/virtual/b.js'))?.transformResult).not.toBeNull()
  })

  test('bills the serialized source map', async () => {
    const { state, env } = await createBudgetServer({
      transformCacheBudget: 10000,
    })

    const result = await env.transformRequest('/virtual/mapmod.js')
    expect(result?.map).toBeTruthy()
    const expected = billed(result!)
    // the map dominates the billed size
    expect(expected).toBeGreaterThan(4000)
    expect(env.transformCacheStats).toEqual({
      entries: 1,
      bytes: expected,
      evictions: 0,
    })

    // cached: no re-transform
    await env.transformRequest('/virtual/mapmod.js')
    expect(transformCount(state, '/virtual/mapmod.js')).toBe(1)
  })

  test('a single result bigger than the budget is served but not cached', async () => {
    const { state, env } = await createBudgetServer({
      transformCacheBudget: 1000,
    })

    const result = await env.transformRequest('/virtual/mapmod.js')
    expect(result?.code).toContain('export const mapmod = 4')
    // the result is too big to ever fit, it isn't kept in the cache
    expect(env.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })

    // a small result still fits
    await env.transformRequest('/virtual/a.js')
    expect(env.transformCacheStats.entries).toBe(1)

    // the oversized result is re-transformed on the next request
    await env.transformRequest('/virtual/mapmod.js')
    expect(transformCount(state, '/virtual/mapmod.js')).toBe(2)
    expect(env.transformCacheStats.entries).toBe(1)
  })

  test('zero budget keeps no results but still shares pending requests', async () => {
    const { state, env } = await createBudgetServer({
      transformCacheBudget: 0,
    })

    const [result1, result2] = await Promise.all([
      env.transformRequest('/virtual/a.js'),
      env.transformRequest('/virtual/a.js'),
    ])
    expect(result1?.code).toBe(result2?.code)
    // concurrent requests for the same url share the pending transformation
    expect(transformCount(state, '/virtual/a.js')).toBe(1)
    expect(env.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })

    // completed results are not kept, the next request re-transforms
    await env.transformRequest('/virtual/a.js')
    expect(transformCount(state, '/virtual/a.js')).toBe(2)
  })

  test('failed transforms are not cached', async () => {
    const { state, env } = await createBudgetServer({
      transformCacheBudget: 10000,
    })

    state.fail.add('\0/virtual/fail.js')
    await expect(env.transformRequest('/virtual/fail.js')).rejects.toThrow(
      'transform failed',
    )
    expect(env.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })

    state.fail.delete('\0/virtual/fail.js')
    await env.transformRequest('/virtual/fail.js')
    expect(transformCount(state, '/virtual/fail.js')).toBe(2)
    expect(env.transformCacheStats.entries).toBe(1)
  })

  test('a result invalidated during transform is not written back', async () => {
    const { server, state, env } = await createBudgetServer({
      transformCacheBudget: 10000,
    })
    state.gateEntered = promiseWithResolvers()
    state.gateRelease = promiseWithResolvers()
    const graph = server.environments.client.moduleGraph

    const req1 = env.transformRequest('/virtual/gated.js')
    await state.gateEntered.promise

    // invalidate the module while the transform is in flight
    const mod = (await graph.getModuleByUrl('/virtual/gated.js'))!
    graph.invalidateModule(mod)
    moduleCode['/virtual/gated.js'] = 'export const gated = 6'

    state.gateRelease.resolve()
    const result1 = await req1
    expect(result1?.code).toContain('export const gated = 5')

    // the stale result is not written back to the cache
    expect(mod.transformResult).toBeNull()
    expect(env.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })

    // the next request re-transforms and only the new version is billed
    const result2 = await env.transformRequest('/virtual/gated.js')
    expect(result2?.code).toContain('export const gated = 6')
    expect(transformCount(state, '/virtual/gated.js')).toBe(2)
    expect(env.transformCacheStats).toEqual({
      entries: 1,
      bytes: Buffer.byteLength(result2!.code, 'utf8'),
      evictions: 0,
    })
  })

  test('a stale etag does not get a 304 after eviction', async () => {
    const { server, env } = await createBudgetServer(
      { transformCacheBudget: 250 },
      { listen: true },
    )
    const base = server.resolvedUrls!.local[0]
    const url = new URL('/virtual/a.js', base)

    const res1 = await fetch(url)
    expect(res1.status).toBe(200)
    const etag = res1.headers.get('etag')!
    expect(etag).toBeTruthy()

    // fresh cache: conditional request gets a 304
    const res2 = await fetch(url, { headers: { 'if-none-match': etag } })
    expect(res2.status).toBe(304)

    // evict the cached result of a.js
    await env.transformRequest('/virtual/b.js')
    await env.transformRequest('/virtual/c.js')
    expect(env.transformCacheStats.evictions).toBe(1)

    // the stale etag must not produce a 304, the module is re-transformed.
    // the module content changed, so a 304 would be a stale cache hit
    moduleCode['/virtual/a.js'] = pad('export const a = 10', 100)
    const res3 = await fetch(url, { headers: { 'if-none-match': etag } })
    expect(res3.status).toBe(200)
    expect(await res3.text()).toContain('export const a = 10')
  })

  test('client and ssr environments have independent budgets', async () => {
    const { server, state } = await createBudgetServer(
      { transformCacheBudget: 250 },
      { ssrBudget: 10000 },
    )
    const client = server.environments.client
    const ssr = server.environments.ssr

    await client.transformRequest('/virtual/a.js')
    await client.transformRequest('/virtual/b.js')
    await client.transformRequest('/virtual/c.js')
    expect(client.transformCacheStats).toEqual({
      entries: 2,
      bytes: 200,
      evictions: 1,
    })

    // the ssr environment has its own budget and counters
    const ssrResult = await ssr.transformRequest('/virtual/a.js')
    await ssr.transformRequest('/virtual/b.js')
    expect(ssr.transformCacheStats.entries).toBe(2)
    expect(ssr.transformCacheStats.bytes).toBe(2 * billed(ssrResult!))
    expect(ssr.transformCacheStats.evictions).toBe(0)
    // client stats are not affected by ssr transforms
    expect(client.transformCacheStats).toEqual({
      entries: 2,
      bytes: 200,
      evictions: 1,
    })
    expect(transformCount(state, '/virtual/a.js', 'ssr')).toBe(1)

    // closing the server resets the counters of every environment
    await server.close()
    expect(client.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })
    expect(ssr.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })
  })
})
