// Shared browser UI for every public page (解析台 / 热榜 / 发现 / 搜索 /
// 作者 / 作品). Served as /ui.js. Pages keep their own CSS + list
// rendering; player, lightbox, parse, share, and URL helpers live here.
//
// CLIENT_JS is built from Function#toString so the worker and the
// browser run the same source. installClientUi must only close over
// `playerTransition` (prepended as a var in CLIENT_JS).

// idle -> loading -> playing <-> stalled -> error (retry -> loading)
export function playerTransition (state, event) {
  if (event === 'close' || event === 'destroy') return 'idle'
  if (event === 'start' || event === 'loadstart' || event === 'retry') return 'loading'
  if (event === 'playing') return 'playing'
  if (event === 'canplay') return (state === 'loading' || state === 'stalled') ? 'playing' : state
  if (event === 'waiting' || event === 'stalled') return state === 'error' ? state : 'stalled'
  if (event === 'error') return 'error'
  return state
}

export function installClientUi (global) {
  var document = global.document
  var location = global.location
  var DT = {}

  function playerTransition (state, event) {
    if (event === 'close' || event === 'destroy') return 'idle'
    if (event === 'start' || event === 'loadstart' || event === 'retry') return 'loading'
    if (event === 'playing') return 'playing'
    if (event === 'canplay') return (state === 'loading' || state === 'stalled') ? 'playing' : state
    if (event === 'waiting' || event === 'stalled') return state === 'error' ? state : 'stalled'
    if (event === 'error') return 'error'
    return state
  }

  DT.playerTransition = playerTransition

  function qs (s, root) { return (root || document).querySelector(s) }
  function el (t, c, x) {
    var e = document.createElement(t)
    if (c) e.className = c
    if (x != null) e.textContent = x
    return e
  }
  DT.qs = qs
  DT.el = el

  DT.fmt = function (n) {
    n = Number(n) || 0
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿'
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
    return String(n)
  }
  DT.fmtW = function (n) {
    n = Number(n) || 0
    return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n)
  }
  DT.ago = function (ms) {
    var s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return s + '秒前'
    if (s < 3600) return Math.floor(s / 60) + '分前'
    if (s < 86400) return Math.floor(s / 3600) + '时前'
    return Math.floor(s / 86400) + '天前'
  }

  // URL helpers. HMAC is minted server-side on play/proxy links; the
  // client never sees the master token and only appends flags.
  function withFlag (href, flag) {
    if (!href) return href
    return href + (href.indexOf('?') > -1 ? '&' : '?') + flag
  }
  DT.withFlag = withFlag
  DT.downloadUrl = function (href) { return withFlag(href, 'download=1') }
  DT.workUrl = function (platform, id) {
    return '/work?platform=' + encodeURIComponent(platform || '') + '&id=' + encodeURIComponent(id || '')
  }
  DT.authorUrl = function (platform, id) {
    return '/author?platform=' + encodeURIComponent(platform || '') + '&id=' + encodeURIComponent(id || '')
  }
  DT.workPageUrl = function (platform, id) {
    return (location && location.origin ? location.origin : '') + DT.workUrl(platform, id)
  }
  DT.shareUrl = function (raw) {
    return '/?u=' + encodeURIComponent(raw || '')
  }
  DT.ingestUrl = function (platform, id, token) {
    var share = platform === 'tiktok'
      ? 'https://www.tiktok.com/@/video/' + id
      : 'https://www.douyin.com/video/' + id
    return DT.parseUrl(share, token)
  }
  DT.parseUrl = function (shareUrl, token) {
    var api = '/api/hybrid/video_data?minimal=true&proxy=1&url=' + encodeURIComponent(shareUrl)
    if (token) api += '&token=' + encodeURIComponent(token)
    return api
  }
  DT.commentsUrl = function (platform, id) {
    return '/api/comments?platform=' + encodeURIComponent(platform || '') + '&id=' + encodeURIComponent(id || '') + '&limit=30'
  }
  DT.playSrc = function (d) {
    if (!d) return ''
    if (d.play) return d.play
    var vd = d.video_data || {}
    return vd.nwm_video_url_HQ || vd.nwm_video_url || vd.wm_video_url_HQ || vd.wm_video_url || ''
  }
  DT.imagesFromParse = function (d) {
    if (!d) return []
    if (d.images && d.images.length) return d.images
    if (d.image_data && d.image_data.no_watermark_image_list) return d.image_data.no_watermark_image_list
    if (d.extra && d.extra.images) return d.extra.images
    return []
  }
  DT.slidesFromRow = function (row) {
    if (!row) return []
    var w = row.width || (row.extra && row.extra.width) || 0
    var h = row.height || (row.extra && row.extra.height) || 0
    if (row.play) return [{ type: 'video', url: row.play, poster: row.cover || '', width: w, height: h }]
    var imgs = DT.imagesFromParse(row)
    if (imgs.length) return imgs.map(function (u) { return { type: 'image', url: u } })
    if (row.cover) return [{ type: 'image', url: row.cover }]
    return []
  }

  var ingestInflight = {}
  DT.getJson = function (url) {
    return fetch(url).then(function (r) {
      return r.json().then(function (j) {
        if (j && typeof j === 'object') j.__status = r.status
        return j
      }, function () { return { __status: r.status } })
    })
  }
  DT.ingest = function (platform, id, token) {
    var key = String(platform) + ':' + String(id) + ':' + (token || '')
    if (!ingestInflight[key]) {
      ingestInflight[key] = DT.getJson(DT.ingestUrl(platform, id, token)).then(function (j) {
        delete ingestInflight[key]
        return j
      }, function (e) {
        delete ingestInflight[key]
        throw e
      })
    }
    return ingestInflight[key]
  }
  DT.parseShare = function (shareUrl, token) {
    return DT.getJson(DT.parseUrl(shareUrl, token))
  }

  DT.toast = function (msg) {
    var t = el('div', 'toast', msg)
    document.body.appendChild(t)
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t) }, 1600)
  }
  function fallbackCopy (text, done) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    var ok = false
    try { ok = document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
    if (ok) done()
  }
  DT.copyText = function (text, done) {
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done) })
    } else fallbackCopy(text, done)
  }
  DT.copied = function (btn) {
    var old = btn.textContent
    btn.textContent = '已复制'
    DT.toast('已复制')
    setTimeout(function () { btn.textContent = old }, 1200)
  }
  DT.copyButton = function (label, text, cls) {
    var b = el('button', cls || 'btn ghost', label)
    b.addEventListener('click', function () {
      DT.copyText(text, function () { DT.copied(b) })
    })
    return b
  }
  DT.shareButton = function (platform, id, cls) {
    var b = el('button', cls || 'btn ghost', '分享')
    b.addEventListener('click', function () {
      DT.copyText(DT.workPageUrl(platform, id), function () { DT.copied(b) })
    })
    return b
  }
  DT.downloadLink = function (href, label, cls) {
    var a = el('a', cls || 'btn', label || '下载')
    a.href = DT.downloadUrl(href)
    a.setAttribute('download', '')
    return a
  }

  DT.applyAspect = function (frame, w, h) {
    w = Number(w) || 0
    h = Number(h) || 0
    if (!(w > 0 && h > 0)) return
    frame.style.aspectRatio = w + ' / ' + h
    if (w >= h) frame.classList.add('is-h')
    else frame.classList.remove('is-h')
  }

  function attachVideo (host, opts) {
    var v = document.createElement('video')
    v.controls = true
    v.autoplay = true
    v.playsInline = true
    v.preload = opts.preload || 'auto'
    v.setAttribute('playsinline', '')
    v.setAttribute('webkit-playsinline', '')
    if (opts.poster) v.poster = opts.poster
    var src = document.createElement('source')
    src.src = opts.src
    src.type = 'video/mp4'
    v.appendChild(src)
    host.appendChild(v)
    return v
  }

  function showErrorActions (host, onRetry, onRetryParse) {
    var box = el('div', 'lb-msg')
    box.appendChild(document.createTextNode('播放失败 '))
    var retry = el('a', null, '重试')
    retry.href = '#'
    retry.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()
      if (onRetry) onRetry()
    })
    box.appendChild(retry)
    if (onRetryParse) {
      box.appendChild(document.createTextNode(' · '))
      var fb = el('a', null, '跑解析后再播')
      fb.href = '#'
      fb.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
        onRetryParse()
      })
      box.appendChild(fb)
    }
    host.appendChild(box)
  }

  // Immediate streaming player. play() must be called from the click
  // handler's synchronous turn (element + src set, no await first).
  DT.mountPlayer = function (host, opts) {
    opts = opts || {}
    var state = 'idle'
    var video = null
    var dead = false

    function setState (event) {
      if (dead) return
      state = playerTransition(state, event)
      if (opts.onState) opts.onState(state, video)
      if (state === 'error') {
        var old = host.querySelector('.lb-msg')
        if (old && old.parentNode) old.parentNode.removeChild(old)
        showErrorActions(host, api.retry, opts.onRetryParse)
      }
    }

    function build () {
      host.innerHTML = ''
      var w = Number(opts.width) || 0
      var h = Number(opts.height) || 0
      if (w > 0 && h > 0) host.style.aspectRatio = w + ' / ' + h
      video = attachVideo(host, opts)
      video.addEventListener('loadstart', function () { setState('loadstart') })
      video.addEventListener('waiting', function () { setState('waiting') })
      video.addEventListener('stalled', function () { setState('stalled') })
      video.addEventListener('playing', function () {
        video.preload = 'auto'
        setState('playing')
      })
      video.addEventListener('canplay', function () { setState('canplay') })
      video.addEventListener('error', function () { setState('error') })
      video.addEventListener('loadedmetadata', function () {
        if (video.videoWidth && video.videoHeight && opts.onMeta) {
          opts.onMeta(video.videoWidth, video.videoHeight)
        }
      })
      return video
    }

    function tryPlay () {
      if (dead) return
      if (!video) build()
      setState('start')
      var p = video.play()
      if (p && p.catch) {
        p.catch(function () {
          video.muted = true
          var p2 = video.play()
          if (p2 && p2.catch) p2.catch(function () { setState('error') })
        })
      }
    }

    var api = {
      play: tryPlay,
      retry: function () { build(); tryPlay() },
      destroy: function () {
        dead = true
        state = 'idle'
        if (video) {
          try { video.pause() } catch {}
          video.removeAttribute('src')
          try { video.load() } catch {}
        }
        video = null
        host.innerHTML = ''
      },
      get state () { return state },
      get video () { return video }
    }
    return api
  }

  // Cover + ▶ until click, then the same streaming player (解析台 / work).
  DT.clickToPlay = function (frame, cover, playUrl, w, h, extra) {
    extra = extra || {}
    DT.applyAspect(frame, w, h)
    if (cover || extra.alwaysCover) {
      var im = el('img')
      im.src = cover || ''
      im.alt = extra.alt || '预览'
      if (extra.lazy) im.loading = 'lazy'
      frame.appendChild(im)
    }
    frame.appendChild(el('span', 'playhint', '▶'))
    frame.style.cursor = 'pointer'
    var started = false
    var player = null
    function startPlay () {
      if (started) return
      started = true
      frame.style.cursor = ''
      frame.innerHTML = ''
      player = DT.mountPlayer(frame, {
        src: playUrl,
        poster: cover,
        width: w,
        height: h,
        preload: 'metadata',
        onMeta: function (vw, vh) { DT.applyAspect(frame, vw, vh) }
      })
      player.play()
      if (extra.badge) frame.appendChild(el('span', 'badge', extra.badge))
    }
    frame.addEventListener('click', startPlay)
    return startPlay
  }

  DT.bindLightbox = function (opts) {
    opts = opts || {}
    var root = typeof opts.root === 'string' ? qs(opts.root) : opts.root
    var stage = typeof opts.stage === 'string' ? qs(opts.stage) : (opts.stage || qs('#lbStage', root))
    var cap = opts.cap ? (typeof opts.cap === 'string' ? qs(opts.cap) : opts.cap) : qs('#lbCap', root)
    var idx = opts.idx ? (typeof opts.idx === 'string' ? qs(opts.idx) : opts.idx) : qs('#lbIdx', root)
    var prev = opts.prev ? (typeof opts.prev === 'string' ? qs(opts.prev) : opts.prev) : qs('#lbPrev', root)
    var next = opts.next ? (typeof opts.next === 'string' ? qs(opts.next) : opts.next) : qs('#lbNext', root)
    var closeBtn = opts.close ? (typeof opts.close === 'string' ? qs(opts.close) : opts.close) : qs('#lbClose', root)
    var slides = []
    var cur = 0
    var gen = 0
    var player = null
    var extra = {}

    function destroyPlayer () {
      if (player) { player.destroy(); player = null }
    }

    function paint () {
      destroyPlayer()
      if (!stage) return
      stage.innerHTML = ''
      var s = slides[cur]
      if (!s) return
      if (s.type === 'video' && s.url) {
        player = DT.mountPlayer(stage, {
          src: s.url,
          poster: s.poster || '',
          width: s.width,
          height: s.height,
          onRetryParse: extra.onRetryParse
        })
        player.play()
      } else if (s.url) {
        var im = document.createElement('img')
        im.src = s.url
        im.alt = ''
        stage.appendChild(im)
      }
      var multi = slides.length > 1
      if (prev) prev.style.display = multi ? '' : 'none'
      if (next) next.style.display = multi ? '' : 'none'
      if (idx) {
        idx.style.display = multi ? '' : 'none'
        idx.textContent = (cur + 1) + ' / ' + slides.length
      }
    }

    function open (list, more) {
      slides = list || []
      cur = 0
      gen += 1
      extra = more || {}
      if (root) root.classList.add('on')
      document.body.style.overflow = 'hidden'
      if (cap && extra.caption != null) cap.innerHTML = extra.caption
      paint()
      return gen
    }

    function close () {
      gen += 1
      extra = {}
      destroyPlayer()
      if (root) root.classList.remove('on')
      if (stage) stage.innerHTML = ''
      if (cap) cap.innerHTML = ''
      document.body.style.overflow = ''
    }

    function go (d) {
      if (slides.length < 2) return
      cur = (cur + d + slides.length) % slides.length
      paint()
    }

    function replace (list) {
      slides = list || []
      cur = 0
      paint()
    }

    function setCaption (html) {
      if (cap) cap.innerHTML = html == null ? '' : html
    }

    if (closeBtn) closeBtn.addEventListener('click', close)
    if (root) {
      root.addEventListener('click', function (e) { if (e.target === root) close() })
    }
    if (prev) prev.addEventListener('click', function (e) { e.stopPropagation(); go(-1) })
    if (next) next.addEventListener('click', function (e) { e.stopPropagation(); go(1) })
    document.addEventListener('keydown', function (e) {
      if (!root || !root.classList.contains('on')) return
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    })
    var tx = 0
    if (root) {
      root.addEventListener('touchstart', function (e) {
        tx = e.changedTouches[0].clientX
      }, { passive: true })
      root.addEventListener('touchend', function (e) {
        var dx = e.changedTouches[0].clientX - tx
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
      }, { passive: true })
    }

    return {
      open: open,
      close: close,
      go: go,
      replace: replace,
      setCaption: setCaption,
      generation: function () { return gen }
    }
  }

  global.DT = DT
  return DT
}

export const CLIENT_JS = '(' + installClientUi.toString() + ')(window);\n'

export function uiScriptService () {
  return new Response(CLIENT_JS, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60'
    }
  })
}
