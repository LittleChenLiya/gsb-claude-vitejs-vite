import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Plugin } from '..'
import { resolveConfig } from '../config'
import {
  ConfigAttributionSession,
  setConfigAttributionEnabled,
} from '../configAttribution'

/**
 * Returns the lines written to stderr that belong to the config hook
 * attribution logger.
 */
function attributionOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .join('')
    .split('\n')
    .filter((line) => line.includes('vite:config-attribution'))
    .join('\n')
}

afterEach(() => {
  setConfigAttributionEnabled(false)
  vi.restoreAllMocks()
})

describe('config hook attribution', () => {
  test('snapshots are immutable and report add/delete/replace', () => {
    const session = new ConfigAttributionSession()
    const live: any = {
      server: { port: 3000 },
      resolve: { alias: [{ find: 'a', replacement: '/a' }] },
      keep: 1,
    }
    const before = session.snapshot(live)

    // mutate the live config after the snapshot was taken
    live.server.port = 4000
    live.resolve.alias.push({ find: 'b', replacement: '/b' })
    live.keep = 2
    live.added = true

    const after = session.snapshot(live)
    session.record('mutator', before, after)
    const report = session.render().join('\n')

    // the snapshot is immutable: it still holds the original values
    expect(report).toContain('~ server.port: 3000 => 4000')
    expect(report).toContain('+ resolve.alias[1]')
    expect(report).toContain('~ keep: 1 => 2')
    expect(report).toContain('+ added: true')
    // the live mutation is attributed to the mutator plugin
    expect(report).toContain('plugin "mutator":')
  })

  test('attributes returned config and in-place mutations to the right plugin', () => {
    const session = new ConfigAttributionSession()
    const conf: any = { resolve: { alias: [] } }

    // plugin 1 returns a partial config (server.port)
    const before1 = session.snapshot(conf)
    const conf1 = { ...conf, server: { port: 3000 } }
    const after1 = session.snapshot(conf1)
    session.record('port-plugin', before1, after1)

    // plugin 2 mutates resolve.alias in place
    const before2 = session.snapshot(conf1)
    conf1.resolve = { alias: [{ find: 'demo', replacement: '/demo' }] }
    const after2 = session.snapshot(conf1)
    session.record('alias-plugin', before2, after2)

    const report = session.render().join('\n')
    expect(report).toContain('plugin "port-plugin":')
    expect(report).toContain('+ server.port: 3000')
    expect(report).toContain('plugin "alias-plugin":')
    expect(report).toContain('resolve.alias[0]')
    expect(report).toContain('demo')
  })

  test('functions and RegExp are represented by identity digests and never executed', () => {
    const session = new ConfigAttributionSession()
    const fn = vi.fn(() => 'result')
    const re = /foo.*/g
    const before = session.snapshot({})
    const after = session.snapshot({ fn, re } as any)
    session.record('ref-plugin', before, after)

    const report = session.render().join('\n')
    expect(report).toContain('[Function#')
    expect(report).toContain('[RegExp#')
    // diagnostics must never execute the values they snapshot
    expect(fn).not.toHaveBeenCalled()

    // the same references keep the same identity across snapshots
    const afterAgain = session.snapshot({ fn, re } as any)
    session.record('ref-plugin-2', after, afterAgain)
    const report2 = session.render().join('\n')
    expect(report2).toContain('plugin "ref-plugin-2": no config changes')
  })

  test('masks sensitive config paths', () => {
    const session = new ConfigAttributionSession()
    const before = session.snapshot({ server: { port: 3000 } })
    const after = session.snapshot({
      server: { port: 3000 },
      apiKey: 'super-secret-key',
      password: 'hunter2',
      token: 'tok-123',
    } as any)
    session.record('leak-plugin', before, after)

    const report = session.render().join('\n')
    expect(report).toContain('apiKey: ***')
    expect(report).toContain('password: ***')
    expect(report).toContain('token: ***')
    expect(report).not.toContain('super-secret-key')
    expect(report).not.toContain('hunter2')
    expect(report).not.toContain('tok-123')
  })

  test('integration: returned server.port and in-place resolve.alias are attributed; final config matches non-diagnostic run', async () => {
    const makePlugins = () => {
      const portHook = vi.fn((_conf: any) => ({ server: { port: 3000 } }))
      const aliasHook = vi.fn((conf: any) => {
        conf.resolve ??= {}
        conf.resolve.alias = [{ find: 'demo', replacement: '/demo/path' }]
      })
      const plugins: Plugin[] = [
        { name: 'demo-port', config: portHook },
        { name: 'demo-alias', config: aliasHook },
      ]
      return { plugins, portHook, aliasHook }
    }

    // run with attribution enabled
    setConfigAttributionEnabled(true)
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    const { plugins, portHook, aliasHook } = makePlugins()
    const withAttribution = await resolveConfig({ plugins }, 'serve')

    // each hook ran exactly once (diagnostics never re-run hooks)
    expect(portHook).toHaveBeenCalledTimes(1)
    expect(aliasHook).toHaveBeenCalledTimes(1)

    const output = attributionOutput(stderrSpy)
    expect(output).toContain('vite:config-attribution')
    expect(output).toContain('demo-port')
    expect(output).toContain('server.port')
    expect(output).toContain('3000')
    expect(output).toContain('demo-alias')
    expect(output).toContain('resolve.alias')
    expect(output).toContain('demo')

    // run the same config without diagnostics
    setConfigAttributionEnabled(false)
    const { plugins: plugins2 } = makePlugins()
    const withoutAttribution = await resolveConfig(
      { plugins: plugins2 },
      'serve',
    )

    // the final config is identical with and without diagnostics
    expect(withAttribution.server.port).toBe(3000)
    expect(withAttribution.resolve.alias).toContainEqual({
      find: 'demo',
      replacement: '/demo/path',
    })
    expect(withAttribution.server.port).toBe(withoutAttribution.server.port)
    expect(withAttribution.resolve.alias).toEqual(
      withoutAttribution.resolve.alias,
    )
  })

  test('integration: a failing hook keeps the last completed attribution record', async () => {
    setConfigAttributionEnabled(true)
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)

    const boom = new Error('boom')
    await expect(
      resolveConfig(
        {
          plugins: [
            {
              name: 'ok-plugin',
              config: () => ({ server: { port: 4000 } }),
            },
            {
              name: 'boom-plugin',
              config: () => {
                throw boom
              },
            },
          ],
        },
        'serve',
      ),
    ).rejects.toThrow('boom')

    const output = attributionOutput(stderrSpy)
    // the record completed before the failure is present
    expect(output).toContain('ok-plugin')
    expect(output).toContain('server.port')
    expect(output).toContain('4000')
    // the failure is reported with the plugin name and error
    expect(output).toContain('boom-plugin')
    expect(output).toContain('FAILED')
    expect(output).toContain('boom')
  })

  test('integration: a hook that changes nothing is reported as no config changes', async () => {
    setConfigAttributionEnabled(true)
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)

    await resolveConfig(
      {
        plugins: [
          {
            name: 'noop-plugin',
            config: () => null,
          },
        ],
      },
      'serve',
    )

    const output = attributionOutput(stderrSpy)
    expect(output).toContain('noop-plugin')
    expect(output).toContain('no config changes')
  })
})
