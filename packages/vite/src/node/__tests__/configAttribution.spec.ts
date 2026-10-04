import { assert, describe, expect, test } from 'vitest'
import { resolveConfig } from '../config'
import type {
  ConfigAttributionReport,
  ConfigValueSummary,
} from '../configAttribution'
import type { Plugin } from '../index'
import {
  explodeCalls,
  failingConfigPlugin,
  mutateAliasCalls,
  mutateResolveAliasPlugin,
  setPortCalls,
  setServerPortPlugin,
} from './fixtures/config-attribution/plugins'

async function resolveWithAttribution(plugins: Plugin[]) {
  return resolveConfig(
    {
      configFile: false,
      logLevel: 'error',
      configAttribution: {
        paths: ['server.port', 'resolve.alias'],
      },
      plugins,
    },
    'serve',
  )
}

describe('config attribution diagnostic', () => {
  test('attributes server.port (returned) and resolve.alias (in-place)', async () => {
    setPortCalls.count = 0
    mutateAliasCalls.count = 0

    const resolved = await resolveWithAttribution([
      setServerPortPlugin(4321),
      mutateResolveAliasPlugin('@', '/src'),
    ])

    // Both hooks ran exactly once (diagnostic never re-runs hooks).
    expect(setPortCalls.count).toBe(1)
    expect(mutateAliasCalls.count).toBe(1)

    const report = resolved.configAttributionReport
    assert(report)

    // Two hooks recorded, in execution order.
    expect(report.hooks.map((h) => h.plugin)).toEqual([
      'fixture-set-server-port',
      'fixture-mutate-resolve-alias',
    ])

    // Final values are accurately attributed to each plugin.
    const portChange = report.final['server.port']
    expect(portChange).toMatchObject({
      path: 'server.port',
      kind: 'set',
      plugin: 'fixture-set-server-port',
    })
    expect(portChange.after).toMatchObject({ type: 'number', value: 4321 })

    const aliasChange = report.final['resolve.alias']
    expect(aliasChange).toMatchObject({
      path: 'resolve.alias',
      kind: 'set',
      plugin: 'fixture-mutate-resolve-alias',
    })
    expect(aliasChange.after?.valueJson).toEqual({ '@': '/src' })

    // Each hook only carries its own change.
    expect(report.hooks[0].changes.map((c) => c.path)).toEqual(['server.port'])
    expect(report.hooks[1].changes.map((c) => c.path)).toEqual([
      'resolve.alias',
    ])

    // Final resolved config matches a run without the diagnostic.
    const baseline = await resolveConfig(
      {
        configFile: false,
        logLevel: 'error',
        plugins: [
          setServerPortPlugin(4321),
          mutateResolveAliasPlugin('@', '/src'),
        ],
      },
      'serve',
    )
    // The baseline plugins counted a second time for themselves; the hook
    // order/result must nevertheless be identical.
    expect(resolved.server.port).toBe(baseline.server.port)
    expect(resolved.resolve.alias).toEqual(baseline.resolve.alias)
    expect(baseline.configAttributionReport).toBeUndefined()

    // Reset baseline counter influence is irrelevant from here on.
  })

  test('diagnostic on/off produce the same final config', async () => {
    setPortCalls.count = 0
    mutateAliasCalls.count = 0
    const plugins = () => [
      setServerPortPlugin(5005),
      mutateResolveAliasPlugin('@components', '/src/components'),
    ]

    const off = await resolveConfig(
      { configFile: false, logLevel: 'error', plugins: plugins() },
      'serve',
    )
    const on = await resolveConfig(
      {
        configFile: false,
        logLevel: 'error',
        configAttribution: {
          paths: ['server.port', 'resolve.alias'],
        },
        plugins: plugins(),
      },
      'serve',
    )

    expect(on.server.port).toBe(5005)
    expect(on.server.port).toBe(off.server.port)
    expect(on.resolve.alias).toEqual(off.resolve.alias)

    // Exactly one invocation per plugin in the diagnosed run.
    expect(setPortCalls.count).toBe(2) // one off + one on run
    expect(mutateAliasCalls.count).toBe(2)
  })

  test('detects replacement via returned partial and in-place mutation', async () => {
    mutateAliasCalls.count = 0

    const pluginReturningAlias: Plugin = {
      name: 'return-alias',
      config: () => ({ resolve: { alias: { a: '/a' } } }),
    }
    const pluginReplacingInPlace: Plugin = {
      name: 'replace-alias-in-place',
      config(conf) {
        ;(conf.resolve!.alias as Record<string, string>)['a'] = '/changed'
        ;(conf.resolve!.alias as Record<string, string>)['b'] = '/b'
      },
    }

    const resolved = await resolveConfig(
      {
        configFile: false,
        logLevel: 'error',
        configAttribution: { paths: ['resolve.alias'] },
        plugins: [pluginReturningAlias, pluginReplacingInPlace],
      },
      'serve',
    )

    const report = resolved.configAttributionReport!
    const firstSet = report.hooks[0].changes[0]
    expect(firstSet.kind).toBe('set')
    expect(firstSet.after?.valueJson).toEqual({ a: '/a' })

    const replace = report.hooks[1].changes[0]
    expect(replace.kind).toBe('replace') // in-place mutation detected
    expect(replace.before?.valueJson).toEqual({ a: '/a' })
    expect(replace.after?.valueJson).toEqual({ a: '/changed', b: '/b' })

    // Last writer wins for the final attribution.
    expect(report.final['resolve.alias'].plugin).toBe('replace-alias-in-place')
  })

  test('functions and RegExp values are summarized by identity only', async () => {
    let captured: ConfigValueSummary[] = []
    const fn = () => {}
    const re = /secret-pattern/
    const pluginWithUnstable: Plugin = {
      name: 'unstable-values',
      config: () =>
        ({
          resolve: {
            alias: [{ find: re, replacement: fn }],
          },
        }) as any,
    }

    const resolved = await resolveConfig(
      {
        configFile: false,
        logLevel: 'error',
        configAttribution: {
          paths: ['resolve.alias'],
          onRecord: (r) => {
            captured = r.hooks.flatMap((h) => h.changes.map((c) => c.after!))
          },
        },
        plugins: [pluginWithUnstable],
      },
      'serve',
    )

    const report = resolved.configAttributionReport!
    const aliasChange = report.final['resolve.alias']
    expect(aliasChange.kind).toBe('set')
    const arr = aliasChange.after?.valueJson as any[]
    expect(Array.isArray(arr)).toBe(true)
    expect(arr[0]).toEqual({
      find: { __unstable: 'regexp', digest: expect.any(String) },
      replacement: { __unstable: 'function', digest: expect.any(String) },
    })
    // The RegExp source must never leak into the report.
    expect(JSON.stringify(report)).not.toContain('secret-pattern')
    // onRecord callback fired with the same report content.
    expect(captured.length).toBe(1)
  })

  test('redacts sensitive paths and reports last completed hooks on failure', async () => {
    setPortCalls.count = 0
    explodeCalls.count = 0

    const secretPlugin: Plugin = {
      name: 'sets-secret-env',
      config: () => ({ env: { SUPER_SECRET_TOKEN: 'do-not-leak' } }),
    }

    let reportOnError: ConfigAttributionReport | undefined
    let thrown: unknown
    try {
      await resolveConfig(
        {
          configFile: false,
          logLevel: 'error',
          configAttribution: {
            paths: ['env.SUPER_SECRET_TOKEN', 'server.port'],
            redactedPaths: ['env'],
          },
          plugins: [
            secretPlugin,
            setServerPortPlugin(4321),
            failingConfigPlugin(),
          ],
        },
        'serve',
      )
    } catch (err) {
      thrown = err
      reportOnError = (
        err as { configAttributionReport?: ConfigAttributionReport }
      ).configAttributionReport
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('boom')
    expect(setPortCalls.count).toBe(1)
    expect(explodeCalls.count).toBe(1)

    assert(reportOnError)
    // The failing hook is recorded; completed attributions are preserved.
    expect(reportOnError.failedHook).toMatchObject({
      plugin: 'fixture-failing-config',
      order: 3,
    })
    expect(reportOnError.hooks.map((h) => h.plugin)).toEqual([
      'sets-secret-env',
      'fixture-set-server-port',
      'fixture-failing-config',
    ])

    // Sensitive value is masked: only identity digest, no literal leakage.
    const envChange = reportOnError.final['env.SUPER_SECRET_TOKEN']
    expect(envChange.after?.redacted).toBe(true)
    expect(envChange.after?.value).toBeUndefined()
    expect(envChange.after?.valueJson).toBeUndefined()
    expect(envChange.after?.digest).toEqual(expect.any(String))
    expect(JSON.stringify(reportOnError)).not.toContain('do-not-leak')

    // Last completed attribution record for server.port survives.
    expect(reportOnError.final['server.port']).toMatchObject({
      plugin: 'fixture-set-server-port',
      order: 2,
    })
  })
})
