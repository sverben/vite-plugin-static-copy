// based on https://github.com/vitejs/vite/blob/7edabb46de3ce63e078e0cda7cd3ed9e5cdd0f2a/packages/vite/src/node/server/middlewares/static.ts#L19-L46
// MIT License
// Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors
// https://github.com/vitejs/vite/blob/7edabb46de3ce63e078e0cda7cd3ed9e5cdd0f2a/LICENSE

// based on https://github.com/lukeed/sirv/blob/886cc962a345780cd78f8910cdcf218db2a8d955/packages/sirv/index.js
// MIT License
// Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (https://lukeed.com)
// https://github.com/lukeed/sirv/blob/886cc962a345780cd78f8910cdcf218db2a8d955/license

import { parse } from '@polka/url'
import { lookup } from 'mrmime'
import type { Stats } from 'node:fs'
import { statSync, createReadStream, existsSync } from 'node:fs'
import type { Connect, ServerOptions } from 'vite'
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse
} from 'node:http'
import { join, resolve } from 'node:path'
import type { FileMap } from './serve'
import type { TransformOptionObject } from './options'
import {
  calculateMd5Base64,
  getTransformedContent,
  resolveTransformOption
} from './utils'

function shouldServeOverwriteCheck(
  overwrite: boolean | 'error',
  srcAbsolutePath: string,
  root: string,
  publicDir: string,
  dest: string
) {
  const publicDirDisabled = publicDir === ''
  if (overwrite === true || publicDirDisabled) {
    return true
  }

  const publicFile = resolve(publicDir, dest)
  if (existsSync(publicFile)) {
    if (overwrite === 'error' && existsSync(srcAbsolutePath)) {
      const destAbsolutePath = resolve(root, dest)
      throw new Error(
        `File ${destAbsolutePath} will be copied from ${publicFile} (overwrite option is set to "error")`
      )
    }
    return false
  }
  return true
}

function viaLocal(
  root: string,
  publicDir: string,
  fileMap: FileMap,
  uri: string
) {
  if (uri.endsWith('/')) {
    uri = uri.slice(0, -1)
  }

  const files = fileMap.get(uri)
  if (files && files[0]) {
    const file = files[0]
    const filepath = resolve(root, file.src)
    const overwriteCheck = shouldServeOverwriteCheck(
      file.overwrite,
      filepath,
      root,
      publicDir,
      file.dest
    )
    if (overwriteCheck === false) {
      return undefined // public middleware will serve instead
    }
    const stats = statSync(filepath)
    return { filepath, stats, transform: file.transform }
  }

  for (const [key, vals] of fileMap) {
    const dir = key.endsWith('/') ? key : `${key}/`
    if (!uri.startsWith(dir)) continue

    for (const val of vals) {
      const filepath = resolve(root, val.src, uri.slice(dir.length))
      const overwriteCheck = shouldServeOverwriteCheck(
        val.overwrite,
        filepath,
        root,
        publicDir,
        join(val.dest, uri.slice(dir.length))
      )
      if (overwriteCheck === false) {
        return undefined // public middleware will serve instead
      }
      const stats = statSync(filepath, { throwIfNoEntry: false })
      if (stats) {
        return { filepath, stats }
      }
    }
    // no entry matched for this prefix
    return undefined
  }

  return undefined
}

function getStaticHeaders(name: string, stats: Stats) {
  let ctype = lookup(name) || ''
  if (ctype === 'text/html') ctype += ';charset=utf-8'

  const headers: OutgoingHttpHeaders = {
    'Content-Length': stats.size,
    'Content-Type': ctype,
    'Last-Modified': stats.mtime.toUTCString(),
    ETag: `W/"${stats.size}-${stats.mtime.getTime()}"`,
    'Cache-Control': 'no-cache'
  }

  return headers
}

function getTransformHeaders(
  name: string,
  encoding: BufferEncoding | 'buffer',
  content: string | Buffer
) {
  let ctype = lookup(name) || ''
  if (ctype === 'text/html') ctype += ';charset=utf-8'

  const headers: OutgoingHttpHeaders = {
    'Content-Length': Buffer.byteLength(
      content,
      encoding === 'buffer' ? undefined : encoding
    ),
    'Content-Type': ctype,
    ETag: `W/"${calculateMd5Base64(content)}"`,
    'Cache-Control': 'no-cache'
  }

  return headers
}

function getMergeHeaders(headers: OutgoingHttpHeaders, res: ServerResponse) {
  headers = { ...headers }

  for (const key in headers) {
    const tmp = res.getHeader(key)
    if (tmp) headers[key] = tmp
  }

  const contentTypeHeader = res.getHeader('content-type')
  if (contentTypeHeader) {
    headers['Content-Type'] = contentTypeHeader
  }
  return headers
}

function sendStatic(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  stats: Stats,
  server: ServerOptions
) {
  const staticHeaders = getStaticHeaders(file, stats)
  if (server.headers) Object.assign(staticHeaders, server.headers)
  console.log(server.headers, staticHeaders)

  if (req.headers['if-none-match'] === staticHeaders['ETag']) {
    res.writeHead(304)
    res.end()
    return
  }

  let code = 200
  const headers = getMergeHeaders(staticHeaders, res)
  const opts: { start?: number; end?: number } = {}

  if (req.headers.range) {
    code = 206
    const [x, y] = req.headers.range.replace('bytes=', '').split('-')
    let end = (y ? parseInt(y, 10) : 0) || stats.size - 1
    const start = (x ? parseInt(x, 10) : 0) || 0
    opts.end = end
    opts.start = start

    if (end >= stats.size) {
      end = stats.size - 1
    }

    if (start >= stats.size) {
      res.setHeader('Content-Range', `bytes */${stats.size}`)
      res.statusCode = 416
      res.end()
      return
    }

    headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`
    headers['Content-Length'] = end - start + 1
    headers['Accept-Ranges'] = 'bytes'
  }

  res.writeHead(code, headers)
  createReadStream(file, opts).pipe(res)
}

async function sendTransform(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  transform: TransformOptionObject,
  server: ServerOptions
): Promise<boolean> {
  const transformedContent = await getTransformedContent(file, transform)
  if (transformedContent === null) {
    return false
  }

  const transformHeaders = getTransformHeaders(
    file,
    transform.encoding,
    transformedContent
  )
  if (server.headers) Object.assign(transformHeaders, server.headers)

  if (req.headers['if-none-match'] === transformHeaders['ETag']) {
    res.writeHead(304)
    res.end()
    return true
  }

  const code = 200
  const headers = getMergeHeaders(transformHeaders, res)

  res.writeHead(code, headers)
  res.end(transformedContent)
  return true
}

function return404(res: ServerResponse, next: Connect.NextFunction) {
  if (next) {
    next()
    return
  }
  res.statusCode = 404
  res.end()
}

export function serveStaticCopyMiddleware(
  {
    root,
    publicDir,
    server
  }: { root: string; publicDir: string; server: ServerOptions },
  fileMap: FileMap
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteServeStaticCopyMiddleware(req, res, next) {
    let pathname = parse(req).pathname
    if (pathname.includes('%')) {
      try {
        pathname = decodeURI(pathname)
      } catch (err) {
        /* malform uri */
      }
    }

    try {
      const data = viaLocal(root, publicDir, fileMap, pathname)
      if (!data || data.stats.isDirectory()) {
        return404(res, next)
        return
      }

      // Matches js, jsx, ts, tsx.
      // The reason this is done, is that the .ts file extension is reserved
      // for the MIME type video/mp2t. In almost all cases, we can expect
      // these files to be TypeScript files, and for Vite to serve them with
      // this Content-Type.
      if (/\.[tj]sx?$/.test(pathname)) {
        res.setHeader('Content-Type', 'application/javascript')
      }

      const transformOption = resolveTransformOption(data.transform)
      if (transformOption) {
        const sent = await sendTransform(
          req,
          res,
          data.filepath,
          transformOption,
          server
        )
        if (!sent) {
          return404(res, next)
          return
        }
        return
      }

      sendStatic(req, res, data.filepath, data.stats, server)
    } catch (e) {
      if (e instanceof Error) {
        next(e)
        return
      }
      throw e
    }
  }
}
