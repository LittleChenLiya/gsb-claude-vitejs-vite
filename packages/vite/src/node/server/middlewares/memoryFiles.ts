import * as mrmime from 'mrmime'
import type { Connect } from '#dep-types/connect'
import type { ViteDevServer } from '..'
import { cleanUrl } from '../../../shared/utils'
import { applyResponseHeaders } from '../headerPolicy'

export function memoryFilesMiddleware(
  server: ViteDevServer,
): Connect.NextHandleFunction {
  const bundledDev = server.environments.client.bundledDev
  const memoryFiles = bundledDev?.memoryFiles
  if (!bundledDev || !memoryFiles) {
    throw new Error('memoryFilesMiddleware can only be used for fullBundleMode')
  }

  return function viteMemoryFilesMiddleware(req, res, next) {
    const cleanedUrl = cleanUrl(req.url!)
    if (cleanedUrl.endsWith('.html')) {
      return next()
    }

    let pathname
    try {
      pathname = decodeURIComponent(cleanedUrl)
    } catch {
      // ignore malformed URI
      return next()
    }
    const filePath = pathname.slice(1) // remove first /

    const file = memoryFiles.get(filePath)
    if (file) {
      if (file.etag) {
        if (req.headers['if-none-match'] === file.etag) {
          res.statusCode = 304
          res.end()
          return
        }
      }

      const mime = mrmime.lookup(filePath)

      applyResponseHeaders(server.headerRegistry, res, 'static', {
        ...(file.etag ? { Etag: file.etag } : {}),
        ...(mime ? { 'Content-Type': mime } : {}),
      })

      return res.end(file.source)
    }
    next()
  }
}
