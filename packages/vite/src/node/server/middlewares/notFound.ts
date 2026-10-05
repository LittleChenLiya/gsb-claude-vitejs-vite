import type { Connect } from '#dep-types/connect'
import type { ViteDevServer } from '../..'

export function notFoundMiddleware(
  server?: ViteDevServer,
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function vite404Middleware(_, res) {
    if (server?.headerStrategy) {
      // Apply the error-category strategy so 404 responses get their own
      // cache headers and business headers cannot override builtin values.
      server.headerStrategy.apply(res, 'error')
    }
    res.statusCode = 404
    res.end()
  }
}
