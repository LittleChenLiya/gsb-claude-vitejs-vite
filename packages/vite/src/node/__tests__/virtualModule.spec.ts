import { describe, expect, test } from 'vitest'
import {
  createVirtualModuleRegistrar,
  decodeVirtualModuleId,
  encodeVirtualModuleId,
  parseVirtualModuleSource,
  VIRTUAL_MODULE_ID_PREFIX,
} from '../virtualModule'

describe('virtual module identity encoding', () => {
  test('roundtrips plugin name, module name and query', () => {
    const id = encodeVirtualModuleId('my-plugin', 'my-module', {
      foo: 'bar',
      baz: 'qux',
    })
    expect(id.startsWith(VIRTUAL_MODULE_ID_PREFIX)).toBe(true)
    expect(decodeVirtualModuleId(id)).toEqual({
      pluginName: 'my-plugin',
      moduleName: 'my-module',
      query: [
        ['baz', 'qux'],
        ['foo', 'bar'],
      ],
    })
  })

  test('roundtrips names containing colons, slashes and question marks', () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ['a', 'b/c?d', {}],
      ['a/b', 'c?d', {}],
      ['a/b?c', 'd', {}],
      ['a:b', 'c', {}],
      ['a', 'b:c', {}],
      ['plugin/name?x=1', 'mod/ule:name?y=2', { 'k?': 'v/' }],
    ]
    for (const [pluginName, moduleName, query] of cases) {
      const id = encodeVirtualModuleId(pluginName, moduleName, query)
      expect(decodeVirtualModuleId(id)).toEqual({
        pluginName,
        moduleName,
        query: Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1)),
      })
    }
  })

  test('two groups of inputs with special characters do not collide', () => {
    const ids = new Set<string>()
    const inputs: Array<[string, string]> = [
      ['a', 'b/c?d'],
      ['a/b', 'c?d'],
      ['a/b?c', 'd'],
      ['a:b', 'c'],
      ['a', 'b:c'],
      ['a', 'b?c'],
      ['a?b', 'c'],
    ]
    for (const [pluginName, moduleName] of inputs) {
      const id = encodeVirtualModuleId(pluginName, moduleName)
      expect(ids.has(id)).toBe(false)
      ids.add(id)
    }
    expect(ids.size).toBe(inputs.length)
  })

  test('query order is canonicalized (order independent)', () => {
    const a = encodeVirtualModuleId('p', 'm', { foo: '1', bar: '2' })
    const b = encodeVirtualModuleId('p', 'm', { bar: '2', foo: '1' })
    expect(a).toBe(b)
    expect(decodeVirtualModuleId(a)?.query).toEqual([
      ['bar', '2'],
      ['foo', '1'],
    ])
  })

  test('duplicate query keys with different values stay distinct', () => {
    const a = encodeVirtualModuleId('p', 'm', [
      ['k', '1'],
      ['k', '2'],
    ])
    const b = encodeVirtualModuleId('p', 'm', [['k', '1']])
    expect(a).not.toBe(b)
    expect(decodeVirtualModuleId(a)?.query).toEqual([
      ['k', '1'],
      ['k', '2'],
    ])
  })

  test('URLSearchParams and arrays are accepted', () => {
    const fromObject = encodeVirtualModuleId('p', 'm', { a: '1', b: '2' })
    const fromParams = encodeVirtualModuleId(
      'p',
      'm',
      new URLSearchParams('a=1&b=2'),
    )
    const fromArray = encodeVirtualModuleId('p', 'm', [
      ['b', '2'],
      ['a', '1'],
    ])
    expect(fromObject).toBe(fromParams)
    expect(fromObject).toBe(fromArray)
  })
})

describe('virtual module id validation', () => {
  test('rejects external file ids', () => {
    expect(decodeVirtualModuleId('/absolute/path/to/file.ts')).toBe(null)
    expect(decodeVirtualModuleId('C:\\path\\to\\file.ts')).toBe(null)
    expect(decodeVirtualModuleId('relative/file.ts')).toBe(null)
    expect(decodeVirtualModuleId('./file.ts')).toBe(null)
  })

  test('rejects forged ids that only mimic the prefix', () => {
    expect(decodeVirtualModuleId(VIRTUAL_MODULE_ID_PREFIX)).toBe(null)
    expect(
      decodeVirtualModuleId(VIRTUAL_MODULE_ID_PREFIX + 'not-base64!'),
    ).toBe(null)
    expect(decodeVirtualModuleId(VIRTUAL_MODULE_ID_PREFIX + '%%%%')).toBe(null)
  })

  test('rejects ids with a wrong payload version', () => {
    const payload = JSON.stringify([2, 'p', 'm', []])
    const body = btoa(payload)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(decodeVirtualModuleId(VIRTUAL_MODULE_ID_PREFIX + body)).toBe(null)
  })

  test('rejects ids with a malformed payload', () => {
    const payloads = [
      JSON.stringify(['p', 'm']),
      JSON.stringify([1, 'p']),
      JSON.stringify([1, '', 'm', []]),
      JSON.stringify([1, 'p', '', []]),
      JSON.stringify([1, 'p', 'm', 'not-array']),
      JSON.stringify([1, 'p', 'm', [['k']]]),
      JSON.stringify([1, 'p', 'm', [['k', 1]]]),
    ]
    for (const payload of payloads) {
      const body = btoa(payload)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      expect(decodeVirtualModuleId(VIRTUAL_MODULE_ID_PREFIX + body)).toBe(null)
    }
  })

  test('rejects non-string input', () => {
    expect(decodeVirtualModuleId(null as unknown as string)).toBe(null)
    expect(decodeVirtualModuleId(undefined as unknown as string)).toBe(null)
    expect(decodeVirtualModuleId(123 as unknown as string)).toBe(null)
  })
})

describe('parseVirtualModuleSource', () => {
  test('parses user-facing virtual sources', () => {
    expect(parseVirtualModuleSource('virtual:my-module')).toEqual({
      moduleName: 'my-module',
      query: [],
    })
    expect(
      parseVirtualModuleSource('virtual:my-module?foo=bar&baz=qux'),
    ).toEqual({
      moduleName: 'my-module',
      query: [
        ['baz', 'qux'],
        ['foo', 'bar'],
      ],
    })
  })

  test('returns null for non-virtual sources', () => {
    expect(parseVirtualModuleSource('/path/to/file.ts')).toBe(null)
    expect(parseVirtualModuleSource('my-module')).toBe(null)
    expect(parseVirtualModuleSource('virtual:')).toBe(null)
  })

  test('accepts a custom prefix', () => {
    expect(parseVirtualModuleSource('custom:mod?a=1', 'custom:')).toEqual({
      moduleName: 'mod',
      query: [['a', '1']],
    })
  })
})

describe('VirtualModuleRegistrar', () => {
  test('resolves and loads a registered module', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('msg', () => 'export const msg = "hello"')

    const id = registrar.resolve('msg')
    expect(id.startsWith(VIRTUAL_MODULE_ID_PREFIX)).toBe(true)
    await expect(registrar.load(id)).resolves.toBe('export const msg = "hello"')
  })

  test('resolves and loads with query', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('env', (query) => {
      const map = Object.fromEntries(query)
      return `export const env = ${map.NODE_ENV}`
    })

    const id = registrar.resolve('env', { NODE_ENV: 'production' })
    await expect(registrar.load(id)).resolves.toBe(
      'export const env = production',
    )
  })

  test('load returns null for forged ids', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('msg', () => 'content')

    await expect(registrar.load('/path/to/file.ts')).resolves.toBe(null)
    await expect(registrar.load('virtual:msg')).resolves.toBe(null)
    await expect(
      registrar.load(VIRTUAL_MODULE_ID_PREFIX + 'forged'),
    ).resolves.toBe(null)
  })

  test('load returns null for ids owned by another plugin', async () => {
    const a = createVirtualModuleRegistrar('plugin-a')
    const b = createVirtualModuleRegistrar('plugin-b')
    a.register('shared', () => 'from-a')
    b.register('shared', () => 'from-b')

    const idFromA = a.resolve('shared')
    await expect(b.load(idFromA)).resolves.toBe(null)
    await expect(a.load(idFromA)).resolves.toBe('from-a')
  })

  test('load returns null for unregistered modules', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    const id = encodeVirtualModuleId('my-plugin', 'not-registered')
    await expect(registrar.load(id)).resolves.toBe(null)
  })

  test('resolve and load share the registration snapshot', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('a', () => 'a')
    registrar.register('b', () => 'b')

    const idA = registrar.resolve('a')
    const idB = registrar.resolve('b')
    await expect(registrar.load(idA)).resolves.toBe('a')
    await expect(registrar.load(idB)).resolves.toBe('b')

    registrar.register('c', () => 'c')
    const idC = registrar.resolve('c')
    await expect(registrar.load(idC)).resolves.toBe('c')
  })

  test('throws on duplicate registration', () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('msg', () => 'first')
    expect(() => registrar.register('msg', () => 'second')).toThrow(
      /already registered/,
    )
  })

  test('throws when resolving an unregistered module', () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    expect(() => registrar.resolve('missing')).toThrow(/not registered/)
  })

  test('has reflects the registration snapshot', () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    expect(registrar.has('msg')).toBe(false)
    registrar.register('msg', () => 'content')
    expect(registrar.has('msg')).toBe(true)
  })

  test('supports async load functions', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('async', async () => {
      await Promise.resolve()
      return 'async content'
    })
    await expect(registrar.load(registrar.resolve('async'))).resolves.toBe(
      'async content',
    )
  })

  test('supports object load results with code and map', async () => {
    const registrar = createVirtualModuleRegistrar('my-plugin')
    registrar.register('mapped', () => ({
      code: 'export const x = 1',
      map: { version: 3, mappings: '' },
    }))
    const result = await registrar.load(registrar.resolve('mapped'))
    expect(result).toEqual({
      code: 'export const x = 1',
      map: { version: 3, mappings: '' },
    })
  })
})
