import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { loadConfigFromFile, resolveConfig } from '../config'
import { setConfigAttributionEnabled } from '../configAttribution'

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url))

/**
 * Demo: load the small `config-attribution` fixture (two plugins — one
 * returns `server.port`, one mutates `resolve.alias` in place) and print the
 * config hook attribution report.
 *
 * Run with:
 *   pnpm demo:config-attribution
 */
describe('config hook attribution demo (small fixture)', () => {
  afterEach(() => {
    setConfigAttributionEnabled(false)
    vi.restoreAllMocks()
  })

  test('loads the fixture and prints the attribution report', async () => {
    setConfigAttributionEnabled(true)
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)

    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      undefined,
      path.join(fixtureRoot, 'fixtures', 'config-attribution'),
    )
    expect(loaded).not.toBeNull()

    const resolved = await resolveConfig(loaded!.config, 'serve', 'development')

    // the final config carries both plugin contributions
    expect(resolved.server.port).toBe(3000)
    expect(resolved.resolve.alias).toContainEqual({
      find: 'demo-pkg',
      replacement: '/demo/path',
    })

    // print the attribution report so the demo output is visible
    const report = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .join('')
      .split('\n')
      .filter((line) => line.includes('vite:config-attribution'))
      .join('\n')
    process.stdout.write(`\n${report}\n`)

    // the report attributes both changes to the right plugins
    expect(report).toContain('demo-server-port')
    expect(report).toContain('server.port')
    expect(report).toContain('3000')
    expect(report).toContain('demo-alias-in-place')
    expect(report).toContain('resolve.alias')
    expect(report).toContain('demo-pkg')
  })
})
