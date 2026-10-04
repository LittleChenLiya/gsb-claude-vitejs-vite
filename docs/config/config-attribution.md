# Config Attribution

When troubleshooting configuration, it is useful to know **which plugin
`config` hook** is responsible for the final value of a config path (for
example, who set `server.port`, or who changed `resolve.alias`). Vite provides
an opt-in **config attribution diagnostic mode** that answers this without
changing any resolution behavior.

The diagnostic:

- takes an **immutable snapshot of the watched paths before and after every
  `config` hook**, during the normal hook execution;
- reports each change as a `set` (newly added), `delete` (removed), or
  `replace` (value changed), together with the **plugin name** and hook order;
- detects hooks that **mutate the config in place** (returning nothing);
- represents values that cannot be stably serialized — **functions,
  `RegExp`, symbols** — only by an explicit **identity digest**. They are
  never invoked, and `RegExp` patterns are never printed;
- **never re-runs hooks**: hooks still run exactly once, in the existing
  order, and `mergeConfig` behavior is unchanged;
- masks sensitive paths, and preserves the last completed attribution
  records when a hook fails.

## Enabling the diagnostic

Pass `configAttribution` to `resolveConfig` (or the Vite Node API). It is not
read from the config file itself, because it is a diagnostic of the
config-loading process.

```ts
import { resolveConfig } from 'vite'

const resolved = await resolveConfig(
  {
    configFile: false,
    configAttribution: {
      paths: ['server.port', 'resolve.alias'],
      // sensitive paths; their literal values never appear in the report
      redactedPaths: ['env', 'server.proxy'],
    },
    plugins: [setServerPortPlugin(), mutateAliasPlugin()],
  },
  'serve',
)

console.log(resolved.configAttributionReport)
```

`configAttribution: true` uses a default watch list
(`server.port`, `server.host`, `resolve.alias`, `base`, `publicDir`) and the
default sensitive prefixes (`env`, `server.proxy`).

## Report shape

```ts
interface ConfigAttributionReport {
  paths: string[]
  hooks: Array<{
    plugin: string
    order: number
    changes: ConfigAttributionChange[]
    error?: { name: string; message: string }
  }>
  // last hook that touched each watched path wins
  final: Record<string, ConfigAttributionChange>
  failedHook?: { plugin: string; order: number; error: { name: string; message: string } }
}
```

Example output for two small plugins — one returning `{ server: { port: 4321 } }`
and one mutating `resolve.alias` in place:

```json
{
  "final": {
    "server.port": {
      "path": "server.port",
      "kind": "set",
      "plugin": "fixture-set-server-port",
      "order": 1,
      "after": { "type": "number", "value": 4321 }
    },
    "resolve.alias": {
      "path": "resolve.alias",
      "kind": "set",
      "plugin": "fixture-mutate-resolve-alias",
      "order": 2,
      "after": { "type": "object", "valueJson": { "@": "/src" }, "digest": "396357bb54" }
    }
  }
}
```

Change kinds:

- **`set`** — the path did not exist before the hook and exists afterwards;
- **`replace`** — the path existed on both sides with a different value (this
  covers in-place mutation of arrays/objects);
- **`delete`** — the path existed before and is gone afterwards.

## Non-serializable values

Plain JSON-able values are captured literally. Values without a stable
serialization are represented by **identity only**:

```json
{ "find": { "__unstable": "regexp", "digest": "a1b2c3d4e5" },
  "replacement": { "__unstable": "function", "digest": "f6g7h8i9j0" } }
```

The same object keeps the same digest across the before/after snapshots, so
replacement vs. untouched identity can still be told apart. Functions are
never called, and a `RegExp`'s source is never part of the report.

## Sensitive paths

Paths under `redactedPaths` (exact match or any sub-path) are reported with
`redacted: true` and only a type + identity digest; literals such as tokens
in `env` never appear anywhere in the serialized report.

## Failing hooks

If a `config` hook throws, the error is re-thrown unchanged, but the
attribution report covering every hook that completed is attached to the
error as `err.configAttributionReport`, and `report.failedHook` names the
offending hook.

## Demo and local verification

A self-contained demo that only loads two tiny fixture plugins (no config
file, no server, no network) lives at
`packages/vite/src/node/__tests__/fixtures/config-attribution/`.

Run the demo locally (no Docker) after building the Vite bundle:

```bash
pnpm --filter vite run build-bundle
TEMP=D:/Codex/tmp TMP=D:/Codex/tmp \
  pnpm exec tsx packages/vite/src/node/__tests__/fixtures/config-attribution/demo.ts
```

Run the focused tests only:

```bash
TEMP=D:/Codex/tmp TMP=D:/Codex/tmp \
  pnpm exec vitest run packages/vite/src/node/__tests__/configAttribution.spec.ts
```
