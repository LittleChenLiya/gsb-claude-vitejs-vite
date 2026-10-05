import { describe, expect, test, vi } from 'vitest'
import {
  VIRTUAL_MODULE_REGISTRY_PREFIX,
  canonicalizeQuery,
  createVirtualModuleRegistry,
  decodeVirtualModuleId,
  encodeVirtualModuleId,
  hasVirtualModuleRegistryPrefix,
} from '../virtualModuleRegistry'
import { exampleVirtualConfigPlugin } from './fixtures/virtualModuleRegistry/exampleVirtualConfigPlugin'

const NUL = String.fromCharCode(0)

describe('virtual module identity encoding', () => {
  test('uses the reserved NUL-prefixed scheme so file ids cannot collide', () => {
    expect(VIRTUAL_MODULE_REGISTRY_PREFIX).toBe(NUL + 'vmr:')
    const id = encodeVirtualModuleId({ plugin: 'p', name: 'n' })
    expect(id.startsWith(NUL)).toBe(true)
  })

  test('names containing ":" do not collide across plugin/name boundary', () => {
    const a = encodeVirtualModuleId({ plugin: 'a:b', name: 'c' })
    const b = encodeVirtualModuleId({ plugin: 'a', name: 'b:c' })
    // naive concatenation would make both "a:b:c"
    expect(a).not.toBe(b)
  })

  test('names containing "/" do not collide across plugin/name boundary', () => {
    const a = encodeVirtualModuleId({ plugin: 'a/b', name: 'c' })
    const b = encodeVirtualModuleId({ plugin: 'a', name: 'b/c' })
    expect(a).not.toBe(b)
  })

  test('names containing "?" do not collide with the query part', () => {
    const a = encodeVirtualModuleId({ plugin: 'p', name: 'x?y=z' })
    const b = encodeVirtualModuleId({
      plugin: 'p',
      name: 'x',
      query: { y: 'z' },
    })
    // naive concatenation would make both "p:x?y=z"
    expect(a).not.toBe(b)
  })

  test('combinations of ":", "/" and "?" stay distinct', () => {
    const specs = [
      { plugin: 'p:1', name: 'a/b?c' },
      { plugin: 'p', name: '1:a/b?c' },
      { plugin: 'p:1:a', name: 'b?c' },
      { plugin: 'p', name: '1', query: { 'a/b': 'c' } },
      { plugin: 'p/?:', name: 'x' },
      { plugin: 'p', name: '/?:x' },
    ] as const
    const ids = specs.map((s) => encodeVirtualModuleId(s))
    expect(new Set(ids).size).toBe(specs.length)
  })

  test('encode -> decode round-trips exactly', () => {
    const cases = [
      { plugin: 'my-plugin', name: 'virtual-module' },
      { plugin: 'a:b/c?d', name: 'e:f/g?h' },
      { plugin: 'p', name: 'n', query: { lang: 'ts', env: 'dev' } },
      { plugin: 'p', name: 'n', query: [['k', 'v&=?%x']] as const },
      { plugin: 'uni:p', name: 'mod/u?le', query: { key: 'v?/:' } },
      { plugin: 'p', name: 'n', query: { empty: '' } },
    ]
    for (const spec of cases) {
      const id = encodeVirtualModuleId(spec)
      const decoded = decodeVirtualModuleId(id)
      expect(decoded).not.toBeNull()
      expect(decoded!.plugin).toBe(spec.plugin)
      expect(decoded!.name).toBe(spec.name)
      expect(decoded!.query).toEqual(canonicalizeQuery(spec.query))
      // decoding is a pure inverse: re-encoding yields the same id
      expect(
        encodeVirtualModuleId({
          plugin: decoded!.plugin,
          name: decoded!.name,
          query: decoded!.query,
        }),
      ).toBe(id)
    }
  })

  test('same spec always produces the same id (deterministic)', () => {
    const spec = {
      plugin: 'p',
      name: 'n',
      query: { b: '2', a: '1' },
    } as const
    expect(encodeVirtualModuleId(spec)).toBe(encodeVirtualModuleId(spec))
  })

  test('query parameter order is canonicalized: order-insensitive ids', () => {
    const a = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: { a: '1', b: '2' },
    })
    const b = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: { b: '2', a: '1' },
    })
    const c = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: [
        ['b', '2'],
        ['a', '1'],
      ],
    })
    expect(a).toBe(b)
    expect(a).toBe(c)
    // and the canonical order is by key, then value
    expect(a.endsWith('?a=1&b=2')).toBe(true)
  })

  test('repeated keys are canonicalized by (key, value) and kept', () => {
    const id = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: { tag: ['b', 'a'] },
    })
    expect(id.endsWith('?tag=a&tag=b')).toBe(true)
    expect(decodeVirtualModuleId(id)!.query).toEqual([
      ['tag', 'a'],
      ['tag', 'b'],
    ])
  })

  test('undefined query values are dropped', () => {
    const withUndef = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: { a: '1', b: undefined },
    })
    const without = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: { a: '1' },
    })
    expect(withUndef).toBe(without)
  })

  test('query keys/values are percent-encoded so separators stay unambiguous', () => {
    const id = encodeVirtualModuleId({
      plugin: 'p',
      name: 'n',
      query: { 'a&b': 'c=d' },
    })
    expect(id.endsWith('?a%26b=c%3Dd')).toBe(true)
    expect(decodeVirtualModuleId(id)!.query).toEqual([['a&b', 'c=d']])
  })

  test('invalid specs are rejected at encode time', () => {
    expect(() => encodeVirtualModuleId({ plugin: '', name: 'n' })).toThrow()
    expect(() => encodeVirtualModuleId({ plugin: 'p', name: '' })).toThrow()
    expect(() =>
      encodeVirtualModuleId({ plugin: 'p' + NUL, name: 'n' }),
    ).toThrow()
    expect(() =>
      encodeVirtualModuleId({ plugin: 'p', name: 'n', query: { '': 'v' } }),
    ).toThrow()
  })
})

describe('strict decoding (validation before reverse decoding)', () => {
  test('external file ids never decode', () => {
    const fileIds = [
      '/abs/path/module.ts',
      'C:\\repo\\src\\main.ts',
      './relative/entry.js',
      'virtual:some-plugin/module',
      '/@id/' + '__x00__' + 'virtual:wrapped',
      'https://example.com/mod.js',
      '',
    ]
    for (const id of fileIds) {
      expect(decodeVirtualModuleId(id)).toBeNull()
      expect(hasVirtualModuleRegistryPrefix(id)).toBe(false)
    }
  })

  test('prefix alone is not enough: malformed bodies are rejected', () => {
    const P = VIRTUAL_MODULE_REGISTRY_PREFIX
    const malformed = [
      P, // empty body
      P + 'p', // no length prefix
      P + '1:p', // missing name
      P + '1:p1', // truncated length prefix
      P + '2:p1:n', // plugin length mismatch
      P + '01:p1:n', // non-canonical length (leading zero)
      P + '1:p1:nextra', // trailing garbage
      P + '1:p1:n?', // empty query
      P + '1:p1:n?k', // missing '='
      P + '1:p1:n?=v', // empty key
      P + '1:p1:n?k=v=x', // extra literal '='
      P + '1:p1:n?k=%2', // truncated percent escape
      P + '1:p1:n?k=%2g', // invalid hex
      P + '1:p1:n?k=%2f', // non-canonical lowercase hex
      P + '1:p1:n?k=a b', // raw char outside unreserved set
      P + '1:p1:n?b=2&a=1', // non-canonical query order
      P + '1:p1:n?k=%ff%ff', // invalid UTF-8
      P + '1:p' + NUL + '1:n', // stray NUL byte
    ]
    for (const id of malformed) {
      expect(decodeVirtualModuleId(id)).toBeNull()
    }
  })

  test('every id produced by encode decodes (no false negatives)', () => {
    const id = encodeVirtualModuleId({
      plugin: 'a:b',
      name: 'c/d?e',
      query: { f: 'g&h' },
    })
    expect(decodeVirtualModuleId(id)).toEqual({
      plugin: 'a:b',
      name: 'c/d?e',
      query: [['f', 'g&h']],
    })
  })
})

describe('registry: shared resolve/load snapshot', () => {
  test('resolveId and load share one registration snapshot', () => {
    const registry = createVirtualModuleRegistry()
    const loader = vi.fn((_mod: unknown) => 'export default 1')
    const id = registry.register({ plugin: 'p', name: 'n' }, loader)
    const snapshot = registry.snapshot()

    expect(snapshot.resolveId(id)).toBe(id)
    expect(snapshot.load(id)).toBe('export default 1')
    expect(loader).toHaveBeenCalledTimes(1)
    // the loader receives the decoded identity
    expect(loader.mock.calls[0][0]).toMatchObject({
      id,
      plugin: 'p',
      name: 'n',
      query: [],
    })
  })

  test('registrations after the snapshot are invisible to it', () => {
    const registry = createVirtualModuleRegistry()
    const idA = registry.register({ plugin: 'p', name: 'a' }, () => 'A')
    const snapshot = registry.snapshot()
    const idB = registry.register({ plugin: 'p', name: 'b' }, () => 'B')

    expect(snapshot.size).toBe(1)
    expect(snapshot.resolveId(idA)).toBe(idA)
    expect(snapshot.resolveId(idB)).toBeNull()
    expect(snapshot.load(idB)).toBeNull()

    const fresh = registry.snapshot()
    expect(fresh.size).toBe(2)
    expect(fresh.resolveId(idB)).toBe(idB)
    expect(fresh.load(idB)).toBe('B')
  })

  test('forged ids never trigger load', () => {
    const registry = createVirtualModuleRegistry()
    const loader = vi.fn(() => 'code')
    const realId = registry.register(
      { plugin: 'p', name: 'n', query: { a: '1' } },
      loader,
    )
    const snapshot = registry.snapshot()
    const P = VIRTUAL_MODULE_REGISTRY_PREFIX

    const forged = [
      // real file ids trying to pass through
      '/etc/passwd',
      'C:\\Windows\\system32\\drivers\\etc\\hosts',
      // well-formed registry encoding, but never registered
      encodeVirtualModuleId({ plugin: 'p', name: 'n' }), // no query
      encodeVirtualModuleId({ plugin: 'p', name: 'n', query: { a: '2' } }),
      encodeVirtualModuleId({ plugin: 'evil', name: 'n' }),
      // hand-crafted strings wearing the reserved prefix
      P + '1:p1:n?a=1&a=1',
      P + '1:p1:n?a=1extra',
      realId + '?extra=1',
      realId.slice(0, -1),
      realId.toUpperCase(),
    ]
    for (const id of forged) {
      expect(snapshot.resolveId(id)).toBeNull()
      expect(snapshot.load(id)).toBeNull()
    }
    expect(loader).not.toHaveBeenCalled()
    // sanity: the real id still works
    expect(snapshot.resolveId(realId)).toBe(realId)
    expect(snapshot.load(realId)).toBe('code')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  test('resolveSpec maps specs to registered ids only', () => {
    const registry = createVirtualModuleRegistry()
    const id = registry.register(
      { plugin: 'p', name: 'n', query: { b: '2', a: '1' } },
      () => 'code',
    )
    const snapshot = registry.snapshot()
    // query order in the lookup does not matter
    expect(
      snapshot.resolveSpec({
        plugin: 'p',
        name: 'n',
        query: { a: '1', b: '2' },
      }),
    ).toBe(id)
    expect(snapshot.resolveSpec({ plugin: 'p', name: 'other' })).toBeNull()
    expect(snapshot.resolveSpec({ plugin: '', name: 'n' })).toBeNull()
  })

  test('plugins not using the registry are unaffected (fall-through)', () => {
    const registry = createVirtualModuleRegistry()
    registry.register({ plugin: 'p', name: 'n' }, () => 'code')
    const snapshot = registry.snapshot()

    const foreign = [
      'virtual:other-plugin/module',
      NUL + 'virtual:other-plugin',
      '/src/main.js',
      'react',
      NUL + 'some-other-scheme:1:a1:b',
    ]
    for (const id of foreign) {
      expect(snapshot.resolveId(id)).toBeNull()
      expect(snapshot.load(id)).toBeNull()
      expect(snapshot.has(id)).toBe(false)
    }
  })

  test('re-registering the same spec keeps the id and replaces the loader', () => {
    const registry = createVirtualModuleRegistry()
    const spec = { plugin: 'p', name: 'n' } as const
    const id1 = registry.register(spec, () => 'first')
    const id2 = registry.register(spec, () => 'second')
    expect(id1).toBe(id2)
    expect(registry.snapshot().load(id1)).toBe('second')
  })
})

describe('example: virtual:config plugin built on the registry', () => {
  test('resolves public specifiers and loads registered modules', () => {
    const plugin = exampleVirtualConfigPlugin({ version: '1.0.0' })

    const id = plugin.resolveId('virtual:config')
    expect(id).not.toBeNull()
    expect(hasVirtualModuleRegistryPrefix(id!)).toBe(true)
    expect(plugin.load(id!)).toContain('"version": "1.0.0"')

    const prodId = plugin.resolveId('virtual:config?env=prod')
    expect(prodId).not.toBeNull()
    expect(plugin.load(prodId!)).toContain('"mode": "production"')

    // unknown queries simply do not resolve
    expect(plugin.resolveId('virtual:config?env=staging')).toBeNull()
  })

  test('forged ids cannot load the example module', () => {
    const plugin = exampleVirtualConfigPlugin({ secret: 's3cr3t' })
    const forged = encodeVirtualModuleId({
      plugin: 'example-config-plugin',
      name: 'config',
      query: { env: 'prod', admin: 'true' },
    })
    expect(plugin.resolveId(forged)).toBeNull()
    expect(plugin.load(forged)).toBeNull()
    // a real file id never reaches the loader either
    expect(plugin.resolveId('/project/src/config.ts')).toBeNull()
    expect(plugin.load('/project/src/config.ts')).toBeNull()
  })
})
