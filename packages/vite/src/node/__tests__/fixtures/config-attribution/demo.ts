/**
 * Minimal, standalone demo of the config attribution diagnostic.
 *
 * It only loads the two tiny fixture plugins in this folder (no full Vite
 * config file, no network, no dev server):
 *   - `fixture-set-server-port`     returns `{ server: { port } }`
 *   - `fixture-mutate-resolve-alias` mutates `resolve.alias` in place
 *
 * Run locally (no Docker), from the repository root after
 * `pnpm --filter vite run build-bundle`:
 *   TEMP=D:/Codex/tmp-1005-052/tmp TMP=D:/Codex/tmp-1005-052/tmp \
 *   pnpm exec tsx packages/vite/src/node/__tests__/fixtures/config-attribution/demo.ts
 */
// The demo consumes the built public Vite API like an end user would.
import { resolveConfig } from 'vite'
import type { ConfigAttributionReport } from 'vite'
import {
  failingConfigPlugin,
  mutateResolveAliasPlugin,
  setServerPortPlugin,
} from './plugins'

function printReport(title: string, report: ConfigAttributionReport) {
  console.log(`\n=== ${title} ===`)
  for (const hook of report.hooks) {
    for (const change of hook.changes) {
      console.log(
        `  [${change.kind.padEnd(7)}] ${change.path} <- ${change.plugin}` +
          ` (hook #${change.order})`,
      )
      if (change.before) {
        console.log(`             before: ${safeStringify(change.before)}`)
      }
      if (change.after) {
        console.log(`             after : ${safeStringify(change.after)}`)
      }
    }
    if (hook.error) {
      console.log(
        `  [error  ] ${hook.plugin} (hook #${hook.order}) threw: ${hook.error.name}: ${hook.error.message}`,
      )
    }
  }
  if (report.failedHook) {
    console.log(
      `  failed hook: ${report.failedHook.plugin} #${report.failedHook.order}`,
    )
  }
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, null, 0)
}

async function main() {
  // 1) Happy path: one hook returns server.port, another mutates alias.
  const resolved = await resolveConfig(
    {
      configFile: false,
      logLevel: 'error',
      configAttribution: {
        paths: ['server.port', 'resolve.alias'],
      },
      plugins: [
        setServerPortPlugin(4321),
        mutateResolveAliasPlugin('@', '/src'),
      ],
    },
    'serve',
  )

  console.log('final server.port  =', resolved.server.port)
  console.log('final resolve.alias =', resolved.resolve.alias)
  printReport(
    'config hook attribution (set + in-place mutation)',
    resolved.configAttributionReport!,
  )

  // 2) Failure path: the last hook throws; previous attributions survive.
  try {
    await resolveConfig(
      {
        configFile: false,
        logLevel: 'error',
        configAttribution: {
          paths: ['server.port'],
        },
        plugins: [setServerPortPlugin(4321), failingConfigPlugin()],
      },
      'serve',
    )
  } catch (err) {
    const report = (
      err as { configAttributionReport?: ConfigAttributionReport }
    ).configAttributionReport
    if (report) {
      printReport('attribution recovered after a failing hook', report)
    }
    console.log('\nrethrown error:', (err as Error).message)
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
