import type { Plugin } from '../../../index'

/**
 * Tiny fixture plugins used by the config attribution tests/demo.
 * Each module exports a `calls` counter so tests can assert that every
 * `config` hook ran exactly once.
 */

export const setPortCalls = { count: 0 }

/**
 * Small plugin that returns a partial config setting `server.port`
 * (the normal "return a new partial config" style of config hook).
 */
export function setServerPortPlugin(port = 4321): Plugin {
  return {
    name: 'fixture-set-server-port',
    config() {
      setPortCalls.count++
      return {
        server: {
          port,
        },
      }
    },
  }
}

export const mutateAliasCalls = { count: 0 }

/**
 * Small plugin that mutates `resolve.alias` in place instead of returning
 * a new partial config. The attribution diagnostic must still detect it.
 */
export function mutateResolveAliasPlugin(
  find: string,
  replacement: string,
): Plugin {
  return {
    name: 'fixture-mutate-resolve-alias',
    config(conf) {
      mutateAliasCalls.count++
      conf.resolve ??= {}
      const alias = ((conf.resolve as Record<string, unknown>).alias ??= {})
      ;(alias as Record<string, string>)[find] = replacement
    },
  }
}

export const explodeCalls = { count: 0 }

/** Small plugin whose `config` hook always fails. */
export function failingConfigPlugin(): Plugin {
  return {
    name: 'fixture-failing-config',
    config() {
      explodeCalls.count++
      throw new Error('boom from config hook')
    },
  }
}
