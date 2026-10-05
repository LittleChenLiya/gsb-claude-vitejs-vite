import { defineConfig, createVirtualModuleRegistrar } from 'vite'
import type { Plugin } from 'vite'

const virtualModuleId = 'virtual:env'

function envPlugin(): Plugin {
  const registrar = createVirtualModuleRegistrar('env-plugin')

  registrar.register('env', (query) => {
    const map = Object.fromEntries(query)
    return `export const env = ${JSON.stringify({
      mode: process.env.NODE_ENV,
      ...map,
    })}`
  })

  return {
    name: 'env-plugin',
    resolveId(source) {
      if (
        source === virtualModuleId ||
        source.startsWith(virtualModuleId + '?')
      ) {
        const parsed = parseSource(source)
        if (parsed) {
          return registrar.resolve(parsed.moduleName, parsed.query)
        }
      }
    },
    load(id) {
      return registrar.load(id)
    },
  }
}

function parseSource(source: string) {
  const prefix = 'virtual:'
  if (!source.startsWith(prefix)) return null
  const rest = source.slice(prefix.length)
  const queryIndex = rest.indexOf('?')
  const moduleName = queryIndex === -1 ? rest : rest.slice(0, queryIndex)
  if (moduleName.length === 0) return null
  const queryString = queryIndex === -1 ? '' : rest.slice(queryIndex + 1)
  const query = queryString
    ? ([...new URLSearchParams(queryString).entries()] as [string, string][])
    : undefined
  return { moduleName, query }
}

export default defineConfig({
  plugins: [envPlugin()],
})
