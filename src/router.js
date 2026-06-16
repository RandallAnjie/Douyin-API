// Manual path router (no framework), mirroring the FastAPI mount
// layout of the upstream project:
//   /api/douyin/web/*   -> douyinWebService
//   /api/tiktok/web/*   -> tiktokWebService
//   /api/tiktok/app/*   -> tiktokAppService
//   /api/hybrid/*       -> hybridService
//   /download           -> downloadService
//   /  (root)           -> docs page
//
// An optional HTTP_PREFIX (e.g. "/v1") is stripped before matching so
// the worker can be mounted under a sub-path.
import douyinWebService from './service/douyin.js'
import { tiktokWebService, tiktokAppService } from './service/tiktok.js'
import { hybridService, downloadService } from './service/hybrid.js'
import { proxyService } from './service/proxy.js'
import { cacheDebugService } from './service/debug.js'
import appService from './service/app.js'
import docsService from './service/docs.js'
import { HTTPException } from './utils/http-exception.js'

export async function router (request, ctx) {
  const url = new URL(request.url)
  const prefix = ctx.config.http.prefix
  let pathname = url.pathname

  if (prefix && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length)
  }
  if (pathname === '') pathname = '/'

  if (pathname === '/' && request.method === 'GET') {
    return appService(request, ctx)
  }
  if (pathname === '/docs' && request.method === 'GET') {
    return docsService(request, ctx)
  }

  if (pathname.startsWith('/api/douyin/web/')) {
    return douyinWebService(pathname.slice('/api/douyin/web/'.length), request, ctx)
  }
  if (pathname.startsWith('/api/tiktok/web/')) {
    return tiktokWebService(pathname.slice('/api/tiktok/web/'.length), request, ctx)
  }
  if (pathname.startsWith('/api/tiktok/app/')) {
    return tiktokAppService(pathname.slice('/api/tiktok/app/'.length), request, ctx)
  }
  if (pathname.startsWith('/api/hybrid/')) {
    return hybridService(pathname.slice('/api/hybrid/'.length), request, ctx)
  }
  if (pathname === '/download') {
    return downloadService(request, ctx)
  }
  if (pathname === '/proxy') {
    return proxyService(request, ctx)
  }
  if (pathname === '/__cachedebug') {
    return cacheDebugService(request, ctx)
  }

  throw new HTTPException(404, { message: `No route for ${pathname}` })
}
