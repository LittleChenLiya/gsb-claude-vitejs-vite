import { describe, expect, onTestFinished, test } from 'vitest'
import type { InlineConfig, Plugin, ViteDevServer } from '../..'
import { createServer } from '../..'
import { promiseWithResolvers } from '../../../shared/utils'
import type { TransformResult } from '../transformRequest'

const virtualPrefix = 'virtual:'

interface TestPluginOptions {
  /** Padded size of the transformed code in bytes */
  codeSize?: number
  /** Source map returned by the transform hook */
  map?: object | null
  /** Append a per-transform counter to the code so each transform differs */
  versioned?: boolean
  /** Number of times the transform hook ran, keyed by `env:id` */
  transformCounts: Map<string, number>
  /** Extra hook invoked inside transform, e.g. to control timing */
  onTransform?: (id: string) => void | Promise<void>
}

function testPlugin(options: TestPluginOptions): Plugin {
  return {
    name: 'test-transform-cache',
    resolveId(id) {
      if (id.startsWith(virtualPrefix)) return id
      if (id.startsWith('/' + virtualPrefix)) return id.slice(1)
    },
    load(id) {
      if (id.startsWith(virtualPrefix)) {
        return 'export default 1'
      }
    },
    async transform(_code, id) {
      if (!id.startsWith(virtualPrefix)) return null
      const key = `${this.environment.name}:${id}`
      const count = (options.transformCounts.get(key) ?? 0) + 1
      options.transformCounts.set(key, count)
      await options.onTransform?.(id)
      // pad with a string literal so the size survives esbuild reprinting
      const size = options.codeSize ?? 1000
      const content = options.versioned ? `${count}:` : ''
      const code = `export default "${(content + 'a'.repeat(size)).slice(0, size - 17)}"`
      return { code, map: options.map ?? null }
    },
  }
}

function accountedSize(result: TransformResult): number {
  return (
    Buffer.byteLength(result.code, 'utf8') +
    (result.map ? Buffer.byteLength(JSON.stringify(result.map), 'utf8') : 0)
  )
}

async function createTestServer(
  config: InlineConfig,
  plugin: Plugin,
): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    root: import.meta.dirname,
    logLevel: 'error',
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ...config,
    plugins: [plugin],
  })
  onTestFinished(() => server.close())
  return server
}

describe('transformCacheBudget', () => {
  test('evicts least recently used results and tracks stats', async () => {
    const transformCounts = new Map<string, number>()
    const server = await createTestServer(
      { environments: { client: { dev: { transformCacheBudget: 2500 } } } },
      testPlugin({ transformCounts }),
    )
    const environment = server.environments.client
    const stats = () => environment.transformCacheStats

    const resultA = await environment.transformRequest('virtual:a')
    const resultB = await environment.transformRequest('virtual:b')
    expect(stats()).toEqual({
      entries: 2,
      bytes: accountedSize(resultA!) + accountedSize(resultB!),
      evictions: 0,
    })

    // cache hit: not transformed again, and becomes most recently used
    await environment.transformRequest('virtual:a')
    expect(transformCounts.get('client:virtual:a')).toBe(1)

    // adding c evicts b (the least recently used), not a
    await environment.transformRequest('virtual:c')
    expect(stats().entries).toBe(2)
    expect(stats().evictions).toBe(1)

    // b was evicted and is transformed again, evicting a
    await environment.transformRequest('virtual:b')
    expect(transformCounts.get('client:virtual:b')).toBe(2)
    expect(stats().evictions).toBe(2)

    // a is still cached after the hit above? no: a was evicted by b's write
    await environment.transformRequest('virtual:a')
    expect(transformCounts.get('client:virtual:a')).toBe(2)
    expect(stats().evictions).toBe(3)
  })

  test('accounts serialized map bytes', async () => {
    const transformCounts = new Map<string, number>()
    const map = {
      version: 3,
      sources: ['input.js'],
      names: [],
      mappings: 'AAAA',
    }
    const server = await createTestServer(
      { environments: { client: { dev: { transformCacheBudget: 100000 } } } },
      testPlugin({ transformCounts, map }),
    )
    const environment = server.environments.client

    const result = await environment.transformRequest('virtual:a')
    expect(result!.map).toBeTruthy()
    const stats = environment.transformCacheStats
    expect(stats.entries).toBe(1)
    // the accounted bytes include the serialized map, not only the code
    expect(stats.bytes).toBe(accountedSize(result!))
    expect(stats.bytes).toBeGreaterThan(Buffer.byteLength(result!.code, 'utf8'))
  })

  test('serves but does not cache a result larger than the budget', async () => {
    const transformCounts = new Map<string, number>()
    const server = await createTestServer(
      { environments: { client: { dev: { transformCacheBudget: 50 } } } },
      testPlugin({ transformCounts }),
    )
    const environment = server.environments.client

    const result = await environment.transformRequest('virtual:big')
    // the current request still gets the result
    expect(result!.code).toContain('export default')
    expect(environment.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })

    // not kept in cache, so the next request transforms again
    await environment.transformRequest('virtual:big')
    expect(transformCounts.get('client:virtual:big')).toBe(2)
  })

  test('does not cache when the map alone pushes the result over the budget', async () => {
    const transformCounts = new Map<string, number>()
    const map = {
      version: 3,
      sources: ['input.js'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: ['x'.repeat(5000)],
    }
    const server = await createTestServer(
      // the code alone would fit the budget, code + map does not
      { environments: { client: { dev: { transformCacheBudget: 2000 } } } },
      testPlugin({ transformCounts, codeSize: 1000, map }),
    )
    const environment = server.environments.client

    const result = await environment.transformRequest('virtual:a')
    expect(accountedSize(result!)).toBeGreaterThan(2000)
    expect(environment.transformCacheStats.entries).toBe(0)
    await environment.transformRequest('virtual:a')
    expect(transformCounts.get('client:virtual:a')).toBe(2)
  })

  test('zero budget keeps no results but reuses pending requests', async () => {
    const transformCounts = new Map<string, number>()
    const gate = promiseWithResolvers<void>()
    const server = await createTestServer(
      { environments: { client: { dev: { transformCacheBudget: 0 } } } },
      testPlugin({
        transformCounts,
        onTransform: () => gate.promise,
      }),
    )
    const environment = server.environments.client

    // concurrent requests for the same url share the pending transform
    const req1 = environment.transformRequest('virtual:a')
    const req2 = environment.transformRequest('virtual:a')
    gate.resolve()
    const [result1, result2] = await Promise.all([req1, req2])
    expect(result1!.code).toBe(result2!.code)
    expect(transformCounts.get('client:virtual:a')).toBe(1)

    // but completed results are never kept
    expect(environment.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })
    await environment.transformRequest('virtual:a')
    expect(transformCounts.get('client:virtual:a')).toBe(2)
  })

  test('failed transforms are not cached', async () => {
    const transformCounts = new Map<string, number>()
    let shouldFail = true
    const server = await createTestServer(
      { environments: { client: { dev: { transformCacheBudget: 100000 } } } },
      testPlugin({
        transformCounts,
        onTransform(id) {
          if (id === 'virtual:fail' && shouldFail) {
            throw new Error('transform failed')
          }
        },
      }),
    )
    const environment = server.environments.client

    await expect(environment.transformRequest('virtual:fail')).rejects.toThrow(
      'transform failed',
    )
    expect(environment.transformCacheStats.entries).toBe(0)

    // the failure is not cached, the next request retries the transform
    shouldFail = false
    await environment.transformRequest('virtual:fail')
    expect(transformCounts.get('client:virtual:fail')).toBe(2)
    expect(environment.transformCacheStats.entries).toBe(1)
  })

  test('does not cache results invalidated while transforming', async () => {
    const transformCounts = new Map<string, number>()
    const started = promiseWithResolvers<void>()
    const gate = promiseWithResolvers<void>()
    const server = await createTestServer(
      { environments: { client: { dev: { transformCacheBudget: 100000 } } } },
      testPlugin({
        transformCounts,
        onTransform: async (id) => {
          if (id === 'virtual:slow') {
            started.resolve()
            await gate.promise
          }
        },
      }),
    )
    const environment = server.environments.client

    const request = environment.transformRequest('virtual:slow')
    await started.promise
    const mod = (await environment.moduleGraph.getModuleByUrl('virtual:slow'))!
    environment.moduleGraph.invalidateModule(mod)
    gate.resolve()

    // the stale request still resolves for its caller...
    const staleResult = await request
    expect(staleResult).not.toBeNull()
    // ...but is not written back to the cache
    expect(mod.transformResult).toBeNull()
    expect(environment.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })

    // the next request transforms again and only the new version is accounted
    const freshResult = await environment.transformRequest('virtual:slow')
    expect(transformCounts.get('client:virtual:slow')).toBe(2)
    expect(environment.transformCacheStats).toEqual({
      entries: 1,
      bytes: accountedSize(freshResult!),
      evictions: 0,
    })
  })

  test('budgets are independent per environment and reset on close', async () => {
    const transformCounts = new Map<string, number>()
    const server = await createTestServer(
      {
        environments: {
          client: { dev: { transformCacheBudget: 2500 } },
          ssr: { dev: { transformCacheBudget: 100000 } },
        },
      },
      testPlugin({ transformCounts }),
    )
    const client = server.environments.client
    const ssr = server.environments.ssr

    await client.transformRequest('virtual:a')
    await client.transformRequest('virtual:b')
    await ssr.transformRequest('virtual:a')
    expect(client.transformCacheStats.entries).toBe(2)
    expect(client.transformCacheStats.evictions).toBe(0)
    expect(ssr.transformCacheStats.entries).toBe(1)

    // the client budget evicts while the larger ssr budget does not,
    // and evictions in one environment do not affect the other
    await client.transformRequest('virtual:c')
    expect(client.transformCacheStats.evictions).toBe(1)
    expect(ssr.transformCacheStats.evictions).toBe(0)
    expect(ssr.transformCacheStats.entries).toBe(1)
    await ssr.transformRequest('virtual:b')
    await ssr.transformRequest('virtual:c')
    expect(ssr.transformCacheStats.entries).toBe(3)
    expect(ssr.transformCacheStats.evictions).toBe(0)
    expect(client.transformCacheStats.entries).toBe(2)

    // closing the server closes the environments and resets the stats
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

  test('keeps previous behavior when no budget is configured', async () => {
    const transformCounts = new Map<string, number>()
    const server = await createTestServer({}, testPlugin({ transformCounts }))
    const environment = server.environments.client

    await environment.transformRequest('virtual:a')
    await environment.transformRequest('virtual:a')
    expect(transformCounts.get('client:virtual:a')).toBe(1)
    // the budget is disabled, nothing is tracked
    expect(environment.transformCacheStats).toEqual({
      entries: 0,
      bytes: 0,
      evictions: 0,
    })
  })

  test('does not serve 304 for evicted results', async () => {
    const transformCounts = new Map<string, number>()
    const server = await createServer({
      configFile: false,
      root: import.meta.dirname,
      logLevel: 'error',
      server: { ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      environments: { client: { dev: { transformCacheBudget: 2500 } } },
      plugins: [testPlugin({ transformCounts, versioned: true })],
    })
    onTestFinished(() => server.close())
    await server.listen()
    const address = server.httpServer!.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const environment = server.environments.client

    const url = `http://localhost:${port}/virtual:a.js`
    const response1 = await fetch(url)
    expect(response1.status).toBe(200)
    const etag = response1.headers.get('etag')!
    expect(etag).toBeTruthy()

    // a matching If-None-Match returns 304 while the result is cached
    const response2 = await fetch(url, {
      headers: { 'if-none-match': etag },
    })
    expect(response2.status).toBe(304)

    // evict the cached result by filling the budget with other modules
    const mod = (await environment.moduleGraph.getModuleByUrl('/virtual:a.js'))!
    for (let i = 0; mod.transformResult != null && i < 50; i++) {
      await environment.transformRequest(`virtual:evict-${i}.js`)
    }
    expect(mod.transformResult).toBeNull()
    expect(environment.transformCacheStats.evictions).toBeGreaterThan(0)

    // the stale etag must not match anymore: the module is re-transformed
    // (producing new content and a new etag) instead of a 304 reply
    const response3 = await fetch(url, {
      headers: { 'if-none-match': etag },
    })
    expect(response3.status).toBe(200)
    expect(response3.headers.get('etag')).not.toBe(etag)
  })
})
