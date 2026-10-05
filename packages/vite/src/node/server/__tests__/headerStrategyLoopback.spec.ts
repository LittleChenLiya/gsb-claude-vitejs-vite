import http from 'node:http'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from '../..'
import type { ViteDevServer } from '../..'

const fixtureRoot = path.join(
  import.meta.dirname,
  'fixtures',
  'header-strategy',
)

function get(
  server: ViteDevServer,
  url: string,
  accept = '*/*',
): Promise<{
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}> {
  return new Promise((resolve, reject) => {
    const port = (server.httpServer!.address() as { port: number }).port
    http
      .get(
        {
          hostname: 'localhost',
          port,
          path: url,
          headers: { accept },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          })
        },
      )
      .on('error', reject)
  })
}

describe('header strategy loopback', () => {
  let server: ViteDevServer

  afterEach(async () => {
    await server?.close()
  })

  test('static and transform responses get their own category cache headers', async () => {
    server = await createServer({
      configFile: false,
      root: fixtureRoot,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        port: 0,
        strictPort: false,
        ws: false,
        headers: { 'X-Custom': 'business' },
      },
    })
    await server.listen()

    // Static public file
    const staticRes = await get(server, '/public.txt')
    expect(staticRes.status).toBe(200)
    expect(staticRes.headers['cache-control']).toBe('no-cache')
    expect(staticRes.headers['x-custom']).toBe('business')

    // Transform module
    const transformRes = await get(server, '/main.js')
    expect(transformRes.status).toBe(200)
    expect(transformRes.headers['cache-control']).toBe('no-cache')
    expect(transformRes.headers['x-custom']).toBe('business')
  })

  test('Content-Length is computed from body and protected from business', async () => {
    server = await createServer({
      configFile: false,
      root: fixtureRoot,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        port: 0,
        ws: false,
        headers: { 'Content-Length': '999' },
      },
    })
    await server.listen()

    const res = await get(server, '/main.js')
    expect(res.status).toBe(200)
    const expected = Buffer.byteLength(res.body)
    expect(res.headers['content-length']).toBe(String(expected))
    expect(res.headers['content-length']).not.toBe('999')
  })

  test('Set-Cookie multi-value headers are preserved per protocol', async () => {
    server = await createServer({
      configFile: false,
      root: fixtureRoot,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        port: 0,
        ws: false,
        headers: { 'Set-Cookie': 'a=1' },
      },
    })
    await server.listen()

    const res = await get(server, '/main.js')
    expect(res.status).toBe(200)
    const cookies = res.headers['set-cookie']
    expect(Array.isArray(cookies)).toBe(true)
    expect(cookies).toContain('a=1')
  })

  test('error responses get their own cache strategy', async () => {
    server = await createServer({
      configFile: false,
      root: fixtureRoot,
      appType: 'mpa',
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        port: 0,
        ws: false,
        headers: { 'X-Custom': 'business' },
      },
    })
    await server.listen()

    const res = await get(server, '/does-not-exist.txt', 'application/json')
    expect(res.status).toBe(404)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.headers['x-custom']).toBe('business')
  })

  test('winning source is recorded per request', async () => {
    let capturedRes: http.ServerResponse | undefined
    server = await createServer({
      configFile: false,
      root: fixtureRoot,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        port: 0,
        ws: false,
        headers: { 'X-Custom': 'business' },
      },
      plugins: [
        {
          name: 'capture-response',
          configureServer(server) {
            server.middlewares.use((_req, res, next) => {
              capturedRes = res
              next()
            })
          },
        },
      ],
    })
    await server.listen()

    await get(server, '/main.js')

    expect(capturedRes).toBeDefined()
    const winners = server.headerStrategy.getWinners(capturedRes!)
    const cc = winners.find((w) => w.name === 'cache-control')
    expect(cc).toBeDefined()
    expect(cc!.source).toMatch(/strategy:transform|runtime:send:cache-control/)
    const xCustom = winners.find((w) => w.name === 'x-custom')
    expect(xCustom?.source).toBe('business:server.headers')
    const cl = winners.find((w) => w.name === 'content-length')
    expect(cl?.source).toBe('builtin:content-length')
  })
})
