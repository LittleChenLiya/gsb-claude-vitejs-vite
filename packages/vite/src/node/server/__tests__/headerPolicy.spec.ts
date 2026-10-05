import { afterEach, describe, expect, test } from 'vitest'
import type { InlineConfig, ViteDevServer } from '../..'
import { createServer } from '../..'
import {
  HEADER_POLICY_PRIORITY,
  HeaderPolicyRegistry,
  createHeaderPolicyRegistry,
  getResponseHeaderSources,
} from '../headerPolicy'

const fixtureDir = `${import.meta.dirname}/fixtures/header-policy`

// `server.listen()` would otherwise start a dep scan that crawls every HTML fixture under `__tests__`
const optimizeDeps: InlineConfig['optimizeDeps'] = {
  noDiscovery: true,
  include: [],
}

describe('HeaderPolicyRegistry', () => {
  test('rejects registrations for internally managed headers', () => {
    const registry = new HeaderPolicyRegistry()
    expect(() =>
      registry.register({
        name: 'Content-Length',
        value: '100',
        source: 'test',
        priority: HEADER_POLICY_PRIORITY.user,
        scopes: ['static'],
      }),
    ).toThrow(/content-length/i)
  })

  test('rejects same-priority conflicts from different sources', () => {
    const registry = new HeaderPolicyRegistry()
    registry.register({
      name: 'x-a',
      value: '1',
      source: 'one',
      priority: 10,
      scopes: ['static'],
    })
    // different value, same priority, overlapping scope -> conflict
    expect(() =>
      registry.register({
        name: 'X-A',
        value: '2',
        source: 'two',
        priority: 10,
        scopes: ['static', 'transform'],
      }),
    ).toThrow(/Conflicting registrations for response header "x-a"/)
    // same value is not a conflict
    registry.register({
      name: 'x-a',
      value: '1',
      source: 'two',
      priority: 10,
      scopes: ['static'],
    })
    // different priority is resolved explicitly
    registry.register({
      name: 'x-a',
      value: '2',
      source: 'two',
      priority: 20,
      scopes: ['static'],
    })
    // non-overlapping scopes at the same priority are fine
    registry.register({
      name: 'x-b',
      value: '1',
      source: 'one',
      priority: 10,
      scopes: ['static'],
    })
    registry.register({
      name: 'x-b',
      value: '2',
      source: 'two',
      priority: 10,
      scopes: ['error'],
    })
  })

  test('resolves the highest priority registration as the winner', () => {
    const registry = new HeaderPolicyRegistry()
    registry.register({
      name: 'cache-control',
      value: 'user-value',
      source: 'user',
      priority: HEADER_POLICY_PRIORITY.user,
      scopes: ['static'],
    })
    registry.register({
      name: 'cache-control',
      value: 'policy-value',
      source: 'policy',
      priority: HEADER_POLICY_PRIORITY.policy,
      scopes: ['static'],
    })
    const resolved = registry.resolve('static', {
      'cache-control': 'internal-value',
    })
    expect(resolved.get('cache-control')).toEqual({
      name: 'cache-control',
      value: 'policy-value',
      source: 'policy',
    })
    // scoped registrations do not leak into other scopes
    expect(registry.resolve('transform').has('cache-control')).toBe(false)
  })

  test('preserves set-cookie as separate values instead of joining them', () => {
    const registry = new HeaderPolicyRegistry()
    registry.register({
      name: 'set-cookie',
      value: 'a=1',
      source: 'user',
      priority: HEADER_POLICY_PRIORITY.user,
      scopes: ['static'],
    })
    // same priority from another source must not throw: values accumulate
    registry.register({
      name: 'set-cookie',
      value: ['b=2', 'c=3'],
      source: 'policy',
      priority: HEADER_POLICY_PRIORITY.policy,
      scopes: ['static'],
    })
    const resolved = registry.resolve('static')
    expect(resolved.get('set-cookie')!.value).toEqual(['a=1', 'b=2', 'c=3'])
    expect(resolved.get('set-cookie')!.source).toBe('user + policy')
  })

  test('combines list-based headers per RFC 9110', () => {
    const registry = new HeaderPolicyRegistry()
    registry.register({
      name: 'vary',
      value: 'Accept-Encoding',
      source: 'user',
      priority: HEADER_POLICY_PRIORITY.user,
      scopes: ['transform'],
    })
    registry.register({
      name: 'vary',
      value: 'Accept-Encoding, Sec-Fetch-Dest',
      source: 'policy',
      priority: HEADER_POLICY_PRIORITY.policy,
      scopes: ['transform'],
    })
    const resolved = registry.resolve('transform')
    expect(resolved.get('vary')!.value).toBe('Accept-Encoding, Sec-Fetch-Dest')
  })

  test('createHeaderPolicyRegistry maps config sources and priorities', () => {
    const registry = createHeaderPolicyRegistry({
      headers: { 'x-shared': 'user' },
      headerPolicy: {
        static: { 'x-shared': 'static-policy' },
        transform: { 'x-only-transform': 'yes' },
      },
    })
    expect(registry.resolve('static').get('x-shared')).toMatchObject({
      value: 'static-policy',
      source: 'server.headerPolicy.static',
    })
    expect(registry.resolve('error').get('x-shared')).toMatchObject({
      value: 'user',
      source: 'server.headers',
    })
    expect(registry.resolve('transform').get('x-only-transform')).toMatchObject(
      { source: 'server.headerPolicy.transform' },
    )
    expect(registry.resolve('static').has('x-only-transform')).toBe(false)
  })
})

describe('header policy startup validation', () => {
  test('refuses to start when business config overrides Content-Length', async () => {
    await expect(
      createServer({
        root: fixtureDir,
        logLevel: 'silent',
        optimizeDeps,
        server: {
          ws: false,
          watch: null,
          headers: { 'content-length': '100' },
        },
      }),
    ).rejects.toThrow(/content-length.*cannot be overridden/i)
  })

  test('refuses to start on same-priority conflicts', async () => {
    await expect(
      createServer({
        root: fixtureDir,
        logLevel: 'silent',
        optimizeDeps,
        server: {
          ws: false,
          watch: null,
          headers: { 'x-user-header': 'user' },
        },
        plugins: [
          {
            name: 'conflicting-header-plugin',
            configureServer(server) {
              server.headerRegistry.register({
                name: 'x-user-header',
                value: 'plugin-value',
                source: 'conflicting-header-plugin',
                priority: HEADER_POLICY_PRIORITY.user,
                scopes: ['static'],
              })
            },
          },
        ],
      }),
    ).rejects.toThrow(/Conflicting registrations for response header/)
  })
})

describe('header policy over loopback requests', () => {
  let server: ViteDevServer | undefined

  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  async function startServer(inlineConfig: InlineConfig = {}) {
    // records the winning header sources of every request, keyed by url
    const headerSources: Record<string, Record<string, string>> = {}
    server = await createServer({
      root: fixtureDir,
      logLevel: 'silent',
      optimizeDeps,
      ...inlineConfig,
      server: {
        port: 0,
        ws: false,
        ...inlineConfig.server,
      },
      plugins: [
        ...(inlineConfig.plugins ?? []),
        {
          name: 'capture-header-sources',
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              res.on('finish', () => {
                const sources = getResponseHeaderSources(res)
                if (sources) headerSources[req.url!] = sources
              })
              next()
            })
          },
        },
      ],
    })
    await server.listen()
    const base = server.resolvedUrls!.local[0]!
    return { server, base, headerSources }
  }

  test('keeps the default server.headers behavior without a policy', async () => {
    const { base, headerSources } = await startServer({
      server: { headers: { 'x-user-header': 'user' } },
    })
    const res = await fetch(`${base}main.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-user-header')).toBe('user')
    expect(headerSources['/main.js']).toMatchObject({
      'cache-control': 'vite:internal',
      'x-user-header': 'server.headers',
    })
  })

  test('applies scoped cache headers to module and static responses', async () => {
    const { base, headerSources } = await startServer({
      server: {
        headers: {
          'cache-control': 'user-value',
          'x-user-header': 'user',
          'set-cookie': 'user=1',
        },
        headerPolicy: {
          static: {
            'cache-control': 'max-age=60',
            'set-cookie': 'static=1',
          },
          transform: {
            'cache-control': 'no-store',
            'set-cookie': 'transform=1',
          },
          error: {
            'cache-control': 'no-store',
            'x-error-policy': 'yes',
          },
        },
      },
    })

    // transformed module response
    const moduleRes = await fetch(`${base}main.js`)
    expect(moduleRes.status).toBe(200)
    expect(moduleRes.headers.get('cache-control')).toBe('no-store')
    expect(moduleRes.headers.get('x-user-header')).toBe('user')
    // Set-Cookie values from both sources are preserved as separate lines
    expect(moduleRes.headers.getSetCookie()).toEqual(['user=1', 'transform=1'])
    expect(headerSources['/main.js']).toMatchObject({
      'cache-control': 'server.headerPolicy.transform',
      'content-type': 'vite:internal',
      etag: 'vite:internal',
      'x-user-header': 'server.headers',
      'set-cookie': 'server.headers + server.headerPolicy.transform',
    })

    // static asset response
    const staticRes = await fetch(`${base}static.txt`)
    expect(staticRes.status).toBe(200)
    expect(staticRes.headers.get('cache-control')).toBe('max-age=60')
    expect(staticRes.headers.get('x-user-header')).toBe('user')
    expect(staticRes.headers.getSetCookie()).toEqual(['user=1', 'static=1'])
    // the transform policy must not leak into static responses
    expect(staticRes.headers.get('cache-control')).not.toBe('no-store')
    expect(headerSources['/static.txt']).toMatchObject({
      'cache-control': 'server.headerPolicy.static',
      'x-user-header': 'server.headers',
    })

    // error response (transform of the broken module fails)
    const errorRes = await fetch(`${base}broken.js`)
    expect(errorRes.status).toBe(500)
    expect(errorRes.headers.get('cache-control')).toBe('no-store')
    expect(errorRes.headers.get('x-error-policy')).toBe('yes')
    expect(errorRes.headers.getSetCookie()).toEqual(['user=1'])
    expect(headerSources['/broken.js']).toMatchObject({
      'cache-control': 'server.headerPolicy.error',
      'x-error-policy': 'server.headerPolicy.error',
      'x-user-header': 'server.headers',
    })
  })
})
