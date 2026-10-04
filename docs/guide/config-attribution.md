# Config Hook Attribution

When a plugin's `config` hook changes the resolved configuration, it can be
hard to tell _which_ plugin introduced a given value. The config hook
attribution diagnostics record, for every `config` hook, an immutable
snapshot of the configuration before and after the hook, and report the
additions, deletions and replacements attributed to each plugin.

## Enabling the diagnostics

Set the `vite:config-attribution` debug namespace, for example through the
`DEBUG` environment variable:

```bash
DEBUG=vite:config-attribution vite
```

The diagnostics are opt-in and do not change the resolved configuration.
They never re-run hooks and never execute non-serializable values (functions,
regular expressions, class instances, ...). Those are represented by an
explicit identity digest such as `[Function#1:myPlugin]` instead.

## Example

Given two plugins, one returning `server.port` and one mutating
`resolve.alias` in place:

```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      name: 'demo-server-port',
      config() {
        return { server: { port: 3000 } }
      },
    },
    {
      name: 'demo-alias-in-place',
      config(conf) {
        conf.resolve ??= {}
        conf.resolve.alias = [{ find: 'demo-pkg', replacement: '/demo/path' }]
      },
    },
  ],
})
```

The attribution report is printed to stderr:

```
vite:config-attribution Config hook attribution report (2 hook(s) observed)
vite:config-attribution   plugin "demo-server-port":
vite:config-attribution     + server.port: 3000
vite:config-attribution   plugin "demo-alias-in-place":
vite:config-attribution     + resolve.alias[0].find: "demo-pkg"
vite:config-attribution     + resolve.alias[0].replacement: "/demo/path"
vite:config-attribution End of config hook attribution report
```

The same report is produced whether the hook returns a partial config or
mutates the configuration in place.

## Hook failures

If a `config` hook throws, the diagnostics keep the last completed
attribution record and report the failure with the plugin name and error:

```
vite:config-attribution   plugin "ok-plugin":
vite:config-attribution     + server.port: 4000
vite:config-attribution   plugin "boom-plugin" FAILED: boom
vite:config-attribution   (attribution records completed before the failure are listed above)
```

## Sensitive path masking

Values at sensitive configuration paths are masked in the report. A path is
considered sensitive when its last segment matches one of: `password`,
`passwd`, `secret`, `token`, `apiKey`/`api_key`, `authorization`,
`credential`, `privateKey`/`private_key`, `accessKey`/`access_key`,
`clientSecret`. The value is replaced with `***`; the path itself is still
reported.

## Local commands

The attribution tests and the small-fixture demo can be run locally with:

```bash
# run the attribution unit and integration tests
pnpm test:config-attribution

# run the demo that loads only the small fixture
pnpm demo:config-attribution
```

The demo loads only the small fixture at
`packages/vite/src/node/__tests__/fixtures/config-attribution/`.
