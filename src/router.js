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
import { adminPageService, adminRecentService } from './service/admin.js'
import { discoverPageService, discoverApiService } from './service/discover.js'
import { hotPageService, hotApiService } from './service/hot.js'
import { workPageService, workApiService } from './service/work.js'
import { commentsApiService } from './service/comments.js'
import { searchPageService, searchApiService } from './service/search.js'
import { authorPageService, authorApiService } from './service/author.js'
import { cronService } from './service/cron.js'
import { imgService } from './service/img.js'
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

  if (pathname === '/favicon.ico') {
    return new Response(null, { status: 204 })
  }
  if (pathname === '/__edge_cron' && request.method === 'POST') {
    return cronService(request, ctx)
  }
  // Admin manual trigger (master token) — run the cron synchronously for
  // testing hot-board refresh + media caching. ?only=hot|grow narrows it.
  if (pathname === '/api/admin/cron') {
    if (url.searchParams.get('token') !== ctx.config.auth.token) {
      return new Response(JSON.stringify({ code: 401, message: 'token required' }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8' } })
    }
    return cronService(request, ctx)
  }
  if (pathname === '/' && request.method === 'GET') {
    return appService(request, ctx)
  }
  if (pathname === '/docs' && request.method === 'GET') {
    return docsService(request, ctx)
  }
  if (pathname === '/admin' && request.method === 'GET') {
    return adminPageService(request, ctx)
  }
  if (pathname === '/discover' && request.method === 'GET') {
    return discoverPageService(request, ctx)
  }
  if (pathname === '/hot' && request.method === 'GET') {
    return hotPageService(request, ctx)
  }
  if (pathname === '/api/douyin/hot' && request.method === 'GET') {
    return hotApiService(request, ctx)
  }
  if (pathname === '/api/discover' && request.method === 'GET') {
    return discoverApiService(request, ctx)
  }
  if (pathname === '/work' && request.method === 'GET') {
    return workPageService(request, ctx)
  }
  if (pathname === '/api/work' && request.method === 'GET') {
    return workApiService(request, ctx)
  }
  if (pathname === '/api/comments' && request.method === 'GET') {
    return commentsApiService(request, ctx)
  }
  if (pathname === '/search' && request.method === 'GET') {
    return searchPageService(request, ctx)
  }
  if (pathname === '/api/search' && request.method === 'GET') {
    return searchApiService(request, ctx)
  }
  if (pathname === '/author' && request.method === 'GET') {
    return authorPageService(request, ctx)
  }
  if (pathname === '/api/author' && request.method === 'GET') {
    return authorApiService(request, ctx)
  }
  if (pathname === '/api/admin/recent' && request.method === 'GET') {
    return adminRecentService(request, ctx)
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
  if (pathname === '/img') {
    return imgService(request, ctx)
  }

  throw new HTTPException(404, { message: `No route for ${pathname}` })
}
