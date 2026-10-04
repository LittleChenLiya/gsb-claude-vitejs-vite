import { defineConfig } from 'vite'

/**
 * Small demo fixture for config hook attribution diagnostics.
 *
 * It registers two plugins:
 *  - "demo-server-port" returns a partial config that sets server.port
 *  - "demo-alias-in-place" mutates resolve.alias in place (no return value)
 *
 * Run with `DEBUG=vite:config-attribution` to see the attribution report.
 */
export default defineConfig({
  plugins: [
    {
      name: 'demo-server-port',
      config() {
        return {
          server: { port: 3000 },
        }
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
