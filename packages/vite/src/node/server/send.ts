import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http'
import path from 'node:path'
import convertSourceMap from 'convert-source-map'
import getEtag from 'etag'
import MagicString from 'magic-string'
import type { SourceMap } from 'rolldown'
import { createDebugger, removeTimestampQuery } from '../utils'
import type { HeaderStrategy, RuntimeHeader } from './headerStrategy'
import { getCodeWithSourcemap } from './sourcemap'

const debug = createDebugger('vite:send', {
  onlyWhenFocused: true,
})

const alias: Record<string, string | undefined> = {
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json',
}

export interface SendOptions {
  etag?: string
  cacheControl?: string
  headers?: OutgoingHttpHeaders
  map?: SourceMap | { mappings: '' } | null
  /**
   * Explicit header strategy. When provided, headers are resolved by
   * declaration priority instead of being written last-write-wins.
   */
  strategy?: HeaderStrategy
}

export function send(
  req: IncomingMessage,
  res: ServerResponse,
  content: string | Buffer,
  type: string,
  options: SendOptions,
): void {
  const {
    etag = getEtag(content, { weak: true }),
    cacheControl = 'no-cache',
    headers,
    map,
    strategy,
  } = options

  if (res.writableEnded) {
    return
  }

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  // inject source map reference (may mutate content)
  if (map && 'version' in map && map.mappings) {
    if (type === 'js' || type === 'css') {
      content = getCodeWithSourcemap(type, content.toString(), map)
    }
  }
  // inject fallback sourcemap for js for improved debugging
  // https://github.com/vitejs/vite/pull/13514#issuecomment-1592431496
  else if (type === 'js' && (!map || map.mappings !== '')) {
    const code = content.toString()
    // if the code has existing inline sourcemap, assume it's correct and skip
    if (convertSourceMap.mapFileCommentRegex.test(code)) {
      debug?.(`Skipped injecting fallback sourcemap for ${req.url}`)
    } else {
      const urlWithoutTimestamp = removeTimestampQuery(req.url!)
      const ms = new MagicString(code)
      content = getCodeWithSourcemap(
        type,
        code,
        ms.generateMap({
          source: path.basename(urlWithoutTimestamp),
          hires: 'boundary',
          includeContent: true,
        }) as SourceMap,
      )
    }
  }

  const contentType = alias[type] || type

  if (strategy) {
    // Route headers through the explicit strategy layer so the winning value
    // is determined by declaration priority, not middleware write order.
    // Applied after source-map injection so Content-Length reflects the
    // final body.
    const runtime: RuntimeHeader[] = [
      {
        name: 'Content-Type',
        value: contentType,
        source: 'runtime:send:content-type',
      },
      {
        name: 'Cache-Control',
        value: cacheControl,
        source: 'runtime:send:cache-control',
      },
      { name: 'Etag', value: etag, source: 'runtime:send:etag' },
    ]
    strategy.apply(res, 'transform', content, runtime)
  } else {
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', cacheControl)
    res.setHeader('Etag', etag)

    if (headers) {
      for (const name in headers) {
        res.setHeader(name, headers[name]!)
      }
    }
  }

  res.statusCode = 200
  if (req.method === 'HEAD') {
    res.end()
  } else {
    res.end(content)
  }
  return
}
