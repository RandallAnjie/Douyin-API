// Shared client module: player state machine + URL helpers. HMAC is
// minted server-side; these helpers only compose already-signed links.
import { playerTransition, installClientUi, CLIENT_JS } from '../src/service/ui.js'
import { proxyPath, proxyQuery, proxyLink } from '../src/utils/proxy-link.js'
import { sign, canonical } from '../src/utils/auth.js'
import { buildConfig } from '../src/config.js'
import { feedCard } from '../src/douyin/app/crawler.js'

let failed = 0
const check = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

// --- state machine ---
check('idle + start -> loading', playerTransition('idle', 'start') === 'loading')
check('loading + playing -> playing', playerTransition('loading', 'playing') === 'playing')
check('playing + waiting -> stalled', playerTransition('playing', 'waiting') === 'stalled')
check('stalled + playing -> playing', playerTransition('stalled', 'playing') === 'playing')
check('loading + canplay -> playing', playerTransition('loading', 'canplay') === 'playing')
check('playing + canplay stays playing', playerTransition('playing', 'canplay') === 'playing')
check('any + error -> error', playerTransition('playing', 'error') === 'error')
check('error + waiting stays error', playerTransition('error', 'waiting') === 'error')
check('error + retry -> loading', playerTransition('error', 'retry') === 'loading')
check('playing + close -> idle', playerTransition('playing', 'close') === 'idle')
check('unknown event is a no-op', playerTransition('playing', 'noop') === 'playing')

const g = { location: { origin: 'https://x' } }
const DT = installClientUi(g)
check('installClientUi exports DT', g.DT === DT && typeof DT.playSrc === 'function')
check('playerTransition on DT matches export', DT.playerTransition('idle', 'start') === 'loading')

check('downloadUrl appends download=1', DT.downloadUrl('/proxy?a=1') === '/proxy?a=1&download=1')
check('downloadUrl adds ? when needed', DT.downloadUrl('/proxy') === '/proxy?download=1')
check('workUrl is path-only', DT.workUrl('douyin', '99') === '/work?platform=douyin&id=99')
check('parseUrl has no token when omitted', !DT.parseUrl('https://www.douyin.com/video/1').includes('token='))
check('parseUrl adds token only as query', /[?&]token=secret$/.test(DT.parseUrl('https://www.douyin.com/video/1', 'secret')))
check('ingestUrl is hybrid parse', DT.ingestUrl('douyin', '99').includes('/api/hybrid/video_data') && DT.ingestUrl('douyin', '99').includes('minimal=true'))

const min = {
  play: '/proxy?platform=douyin&id=1&kind=nwm&auth=abc',
  video_data: { nwm_video_url_HQ: 'https://cdn.example/nwm.mp4', width: 1080, height: 1920 }
}
check('playSrc prefers row.play', DT.playSrc(min) === min.play)
check('playSrc falls back to nwm', DT.playSrc({ video_data: min.video_data }) === min.video_data.nwm_video_url_HQ)

const slides = DT.slidesFromRow({ play: min.play, cover: '/c.jpg', extra: { width: 1080, height: 1920 } })
check('slidesFromRow video has poster + size', slides[0]?.type === 'video' && slides[0].poster === '/c.jpg' && slides[0].width === 1080)
check('slidesFromRow images', DT.slidesFromRow({ extra: { images: ['/a.jpg', '/b.jpg'] } }).length === 2)
check('slidesFromRow empty', DT.slidesFromRow({}).length === 0)

check('CLIENT_JS is an IIFE', CLIENT_JS.startsWith('(function') && CLIENT_JS.includes('(window)'))
check('CLIENT_JS has mountPlayer + clickToPlay', CLIENT_JS.includes('mountPlayer') && CLIENT_JS.includes('clickToPlay'))
check('CLIENT_JS has state names', ['idle', 'loading', 'playing', 'stalled', 'error'].every(s => CLIENT_JS.includes("'" + s + "'") || CLIENT_JS.includes('"' + s + '"') || CLIENT_JS.includes(s)))
check('CLIENT_JS has playsinline', CLIENT_JS.includes('playsinline'))
check('CLIENT_JS never embeds a master token placeholder', !CLIENT_JS.includes('secret123') && !CLIENT_JS.includes('DOUYIN_API_TOKEN'))

// --- server URL helpers (HMAC, never master token) ---
const ctx = { config: buildConfig({ DOUYIN_API_TOKEN: 'secret123' }) }
const id = '7372484719365098803'
const q = proxyQuery(ctx, 'douyin', id, 'nwm')
const params = new URLSearchParams(q)
const expected = sign(canonical('proxy', 'douyin', id), 'secret123')
check('proxyQuery kind=nwm', params.get('kind') === 'nwm' && params.get('id') === id)
check('proxyQuery HMAC matches requireProxyAuth canonical', params.get('auth') === expected)
check('proxyQuery has no token=', !params.has('token') && !q.includes('secret123'))
check('proxyPath is same-origin', proxyPath(ctx, 'douyin', id, 'nwm') === '/proxy?' + q)

const req = new Request('https://x/api/douyin/hot')
const abs = proxyLink(req, ctx, 'douyin', id, 'nwm')
check('proxyLink is absolute + same query', abs.startsWith('https://x/proxy?') && abs.endsWith(q))

const card = feedCard({
  aweme_id: id,
  desc: 'hello',
  aweme_type: 4,
  author: { nickname: 'n' },
  statistics: { digg_count: 3 },
  video: { width: 1080, height: 1920, cover: { url_list: ['https://p.com/c.jpg'] }, play_addr: { uri: 'u', url_list: [] } }
})
check('feedCard keeps width/height', card.width === 1080 && card.height === 1920 && card.type === 'video')
const imgCard = feedCard({ aweme_id: 'i', aweme_type: 2, images: [{}], video: {} })
check('feedCard image type', imgCard.type === 'image')

console.log(failed === 0 ? '\nAll ui tests passed.' : `\n${failed} ui test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
