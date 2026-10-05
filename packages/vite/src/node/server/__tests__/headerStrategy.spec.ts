import http from 'node:http'
import { describe, expect, test } from 'vitest'
import { createHeaderStrategy } from '../headerStrategy'

function mockResponse(): http.ServerResponse {
  return new http.ServerResponse({} as http.IncomingMessage)
}

describe('headerStrategy', () => {
  test('resolves headers by declaration priority', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'global',
      { 'Cache-Control': 'max-age=60' },
      'business',
      'business:server.headers',
    )
    strategy.register(
      'transform',
      { 'Cache-Control': 'no-cache' },
      'strategy',
      'strategy:transform',
    )
    strategy.freeze()

    const res = mockResponse()
    const winners = strategy.apply(res, 'transform')

    expect(res.getHeader('Cache-Control')).toBe('no-cache')
    const cc = winners.find((w) => w.name === 'cache-control')
    expect(cc?.source).toBe('strategy:transform')
    expect(cc?.priority).toBe('strategy')
  })

  test('business headers win when no strategy declaration exists', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'global',
      { 'X-Custom': 'yes' },
      'business',
      'business:server.headers',
    )
    strategy.freeze()

    const res = mockResponse()
    const winners = strategy.apply(res, 'static')

    expect(res.getHeader('X-Custom')).toBe('yes')
    const x = winners.find((w) => w.name === 'x-custom')
    expect(x?.source).toBe('business:server.headers')
  })

  test('rejects same-priority conflicts at startup', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'transform',
      { 'Cache-Control': 'no-cache' },
      'strategy',
      'source:a',
    )
    strategy.register(
      'transform',
      { 'Cache-Control': 'max-age=60' },
      'strategy',
      'source:b',
    )

    expect(() => strategy.freeze()).toThrow(
      /same-priority header conflict for "cache-control" in category "transform"/,
    )
  })

  test('does not reject same-priority conflicts across different categories', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'static',
      { 'Cache-Control': 'no-cache' },
      'strategy',
      'strategy:static',
    )
    strategy.register(
      'transform',
      { 'Cache-Control': 'max-age=60' },
      'strategy',
      'strategy:transform',
    )

    expect(() => strategy.freeze()).not.toThrow()
  })

  test('preserves multi-value Set-Cookie headers per protocol', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'global',
      { 'Set-Cookie': 'a=1' },
      'business',
      'business:server.headers',
    )
    strategy.register(
      'transform',
      { 'Set-Cookie': 'b=2' },
      'strategy',
      'strategy:transform',
    )
    strategy.freeze()

    const res = mockResponse()
    strategy.apply(res, 'transform')

    const cookies = res.getHeader('Set-Cookie')
    expect(Array.isArray(cookies)).toBe(true)
    expect(cookies).toEqual(['a=1', 'b=2'])
  })

  test('Content-Length is computed from body and protected from business', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'global',
      { 'Content-Length': '999' },
      'business',
      'business:server.headers',
    )
    strategy.freeze()

    const res = mockResponse()
    const body = 'hello world'
    const winners = strategy.apply(res, 'transform', body)

    expect(res.getHeader('Content-Length')).toBe(Buffer.byteLength(body))
    const cl = winners.find((w) => w.name === 'content-length')
    expect(cl?.source).toBe('builtin:content-length')
    expect(cl?.priority).toBe('builtin')
  })

  test('records the actual winning source per request', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'static',
      { 'Cache-Control': 'no-cache' },
      'strategy',
      'strategy:static',
    )
    strategy.register(
      'global',
      { 'X-Powered-By': 'vite' },
      'business',
      'business:server.headers',
    )
    strategy.freeze()

    const res = mockResponse()
    strategy.apply(res, 'static')

    const winners = strategy.getWinners(res)
    const cc = winners.find((w) => w.name === 'cache-control')
    expect(cc?.source).toBe('strategy:static')
    const xpb = winners.find((w) => w.name === 'x-powered-by')
    expect(xpb?.source).toBe('business:server.headers')
  })

  test('runtime headers override frozen category defaults', () => {
    const strategy = createHeaderStrategy()
    strategy.register(
      'transform',
      { 'Cache-Control': 'no-cache' },
      'strategy',
      'strategy:transform',
    )
    strategy.freeze()

    const res = mockResponse()
    const winners = strategy.apply(res, 'transform', undefined, [
      {
        name: 'Cache-Control',
        value: 'max-age=31536000,immutable',
        source: 'runtime:send:cache-control',
      },
    ])

    expect(res.getHeader('Cache-Control')).toBe('max-age=31536000,immutable')
    const cc = winners.find((w) => w.name === 'cache-control')
    expect(cc?.source).toBe('runtime:send:cache-control')
  })

  test('throws when registering after freeze', () => {
    const strategy = createHeaderStrategy()
    strategy.freeze()

    expect(() =>
      strategy.register('static', { 'X-Test': '1' }, 'strategy', 'late:source'),
    ).toThrow(/after the strategy has been frozen/)
  })
})
