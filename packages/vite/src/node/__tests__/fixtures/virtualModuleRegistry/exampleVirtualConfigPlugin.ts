/**
 * Example: a `virtual:config`-style plugin built on the explicit virtual
 * module registry.
 *
 * Public import specifiers (`virtual:config`, `virtual:config?env=prod`)
 * are translated into collision-safe internal ids by the registry. The
 * plugin's `resolveId`/`load` hooks are the registry snapshot's hooks, so
 * both hooks share one frozen registration map, and any id that was never
 * registered (forged ids, real file paths, other plugins' virtual modules)
 * falls through untouched.
 */
import {
  createVirtualModuleRegistry,
  type VirtualModuleRegistry,
  type VirtualModuleRegistrySnapshot,
  type VirtualModuleSpec,
} from '../../../virtualModuleRegistry'

export interface ExamplePlugin {
  name: string
  resolveId(id: string): string | null
  load(id: string): unknown
}

const PUBLIC_PREFIX = 'virtual:config'

export function parsePublicSpecifier(id: string): VirtualModuleSpec | null {
  if (id !== PUBLIC_PREFIX && !id.startsWith(PUBLIC_PREFIX + '?')) {
    return null
  }
  const queryString = id.slice(PUBLIC_PREFIX.length).replace(/^\?/, '')
  const query: Array<readonly [string, string]> = []
  if (queryString) {
    for (const segment of queryString.split('&')) {
      const eq = segment.indexOf('=')
      const rawKey = eq === -1 ? segment : segment.slice(0, eq)
      const rawValue = eq === -1 ? '' : segment.slice(eq + 1)
      query.push([decodeURIComponent(rawKey), decodeURIComponent(rawValue)])
    }
  }
  return { plugin: 'example-config-plugin', name: 'config', query }
}

export function exampleVirtualConfigPlugin(
  values: Record<string, unknown>,
  registry: VirtualModuleRegistry = createVirtualModuleRegistry(),
): ExamplePlugin & { registry: VirtualModuleRegistry } {
  // Register the module once; the returned id is the canonical internal id.
  registry.register(
    { plugin: 'example-config-plugin', name: 'config' },
    () => `export default ${JSON.stringify(values, null, 2)}`,
  )
  registry.register(
    {
      plugin: 'example-config-plugin',
      name: 'config',
      query: { env: 'prod' },
    },
    () =>
      `export default ${JSON.stringify({ ...values, mode: 'production' }, null, 2)}`,
  )

  // One frozen snapshot shared by resolveId and load.
  const snapshot: VirtualModuleRegistrySnapshot = registry.snapshot()

  return {
    name: 'example-config-plugin',
    registry,
    resolveId(id) {
      // Public specifier? Translate spec -> internal id via the snapshot.
      const spec = parsePublicSpecifier(id)
      if (spec) return snapshot.resolveSpec(spec)
      // Already an internal id? Only claim it if it is registered here.
      return snapshot.resolveId(id)
    },
    load(id) {
      return snapshot.load(id)
    },
  }
}
