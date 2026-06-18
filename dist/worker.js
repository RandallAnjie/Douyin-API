// src/middleware/logger.js
var LEVEL_PRIORITY = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
var DEFAULT_LEVEL = "info";
function makeLogger(bindings = {}, minLevel = DEFAULT_LEVEL) {
  const threshold = LEVEL_PRIORITY[minLevel] ?? LEVEL_PRIORITY.info;
  function emit(level, payload, message) {
    const prio = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.info;
    if (prio < threshold) return;
    const obj = typeof payload === "object" && payload !== null ? payload : {};
    const msg = typeof payload === "string" ? payload : message || "";
    const out = {
      time: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      ...bindings,
      ...obj,
      msg
    };
    try {
      console.log(JSON.stringify(out));
    } catch {
      console.log(`[${level}] ${msg}`);
    }
  }
  return {
    trace: (p, m) => emit("trace", p, m),
    debug: (p, m) => emit("debug", p, m),
    info: (p, m) => emit("info", p, m),
    warn: (p, m) => emit("warn", p, m),
    error: (p, m) => emit("error", p, m),
    fatal: (p, m) => emit("fatal", p, m),
    child: (extra) => makeLogger({ ...bindings, ...extra }, minLevel)
  };
}
var logger = makeLogger();
var generateRequestId = () => Math.random().toString(36).slice(2, 9);
var withRequestLogger = (handler2) => {
  return async (request, ctx = {}) => {
    const requestId = generateRequestId();
    const startTime = Date.now();
    const url = new URL(request.url);
    const reqInfo = {
      method: request.method,
      url: url.pathname,
      headers: Object.fromEntries(request.headers)
    };
    const requestScopedLogger = makeLogger(
      { req: reqInfo },
      ctx.config?.log?.level || DEFAULT_LEVEL
    );
    ctx.logger = requestScopedLogger;
    ctx.requestId = requestId;
    ctx.responseHeaders = new Headers();
    ctx.error = null;
    let response = await handler2(request, ctx);
    const mergedHeaders = new Headers(response.headers);
    for (const [key, value] of ctx.responseHeaders) {
      mergedHeaders.set(key, value);
    }
    mergedHeaders.set("x-request-id", requestId);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: mergedHeaders
    });
    const responseTime = Date.now() - startTime;
    const responseHeaders = {};
    for (const [key, value] of response.headers.entries()) {
      responseHeaders[key] = value;
    }
    const bindings = {
      reqId: requestId,
      res: { status: response.status, headers: responseHeaders },
      responseTime
    };
    const level = ctx.error ? "error" : "info";
    const message = ctx.error?.message || "Request completed";
    requestScopedLogger[level](bindings, message);
    return response;
  };
};

// src/middleware/errors.js
function withErrorHandler(handler2) {
  return async (request, ctx) => {
    try {
      return await handler2(request, ctx);
    } catch (err) {
      const status = err?.status || 500;
      const requestLogger = ctx?.logger ?? logger;
      const url = new URL(request.url);
      const debugMode = ctx?.config?.log?.level === "debug" || ctx?.config?.log?.level === "trace" || ctx?.env?.DEBUG_ERRORS === "1" || ctx?.env?.DEBUG_ERRORS === "true";
      const logPayload = {
        error: {
          message: err?.message,
          stack: err?.stack,
          name: err?.name,
          status
        },
        request: {
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          userAgent: request.headers.get("user-agent"),
          ip: request.headers.get("cf-connecting-ip") || request.headers.get("rf-connecting-ip") || request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown"
        }
      };
      if (ctx?.requestId) {
        logPayload.request.requestId = ctx.requestId;
      }
      requestLogger.error(logPayload, "Request error occurred");
      try {
        console.error("[errors] " + (err?.name || "Error") + ": " + (err?.message || "(no message)"));
        if (err?.stack) console.error(err.stack);
      } catch {
      }
      if (ctx?.responseHeaders) {
        ctx.responseHeaders.set("x-error-message", encodeURIComponent(err?.message || ""));
        ctx.error = err;
      }
      const body = {
        code: status,
        message: err?.message || "(no message)",
        path: url.pathname
      };
      if (debugMode && err?.stack) body.stack = err.stack;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
  };
}

// src/utils/http-exception.js
var HTTPException = class extends Error {
  constructor(status, options = {}) {
    super(options.message || "Unknown Error");
    this.status = status;
    this.name = "HTTPException";
  }
};

// src/utils/respond.js
function jsonResponse(data, { status = 200, headers: headers2 = {}, router: router2 = "", params = {} } = {}) {
  const body = {
    code: status,
    router: router2,
    params,
    data
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers2 }
  });
}
function rawJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// src/lib/sha1.js
var rol = (n, c) => (n << c | n >>> 32 - c) >>> 0;
function sha1Bytes(input) {
  const bytes = Array.from(input, (b) => b & 255);
  const ml = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(ml / 4294967296);
  const lo = ml >>> 0;
  for (let i = 3; i >= 0; i--) bytes.push(hi >>> i * 8 & 255);
  for (let i = 3; i >= 0; i--) bytes.push(lo >>> i * 8 & 255);
  let h0 = 1732584193;
  let h1 = 4023233417;
  let h2 = 2562383102;
  let h3 = 271733878;
  let h4 = 3285377520;
  const w = new Array(80);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j2 = off + i * 4;
      w[i] = (bytes[j2] << 24 | bytes[j2 + 1] << 16 | bytes[j2 + 2] << 8 | bytes[j2 + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) {
        f = b & c | ~b & d;
        k = 1518500249;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (i < 60) {
        f = b & c | b & d | c & d;
        k = 2400959708;
      } else {
        f = b ^ c ^ d;
        k = 3395469782;
      }
      const t = rol(a, 5) + f + e + k + w[i] >>> 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = t;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
  }
  const out = [];
  for (const h of [h0, h1, h2, h3, h4]) {
    out.push(h >>> 24 & 255, h >>> 16 & 255, h >>> 8 & 255, h & 255);
  }
  return out;
}
var toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
var sha1Hex = (input) => toHex(sha1Bytes(input));
function hmacSha1Hex(secret, message) {
  const enc = new TextEncoder();
  let key = Array.from(enc.encode(secret));
  if (key.length > 64) key = sha1Bytes(key);
  while (key.length < 64) key.push(0);
  const ipad = key.map((b) => b ^ 54);
  const opad = key.map((b) => b ^ 92);
  const msg = Array.from(enc.encode(message));
  const inner = sha1Bytes(ipad.concat(msg));
  return toHex(sha1Bytes(opad.concat(inner)));
}

// src/utils/auth.js
var sign = (message, secret) => hmacSha1Hex(secret, message);
var canonical = (platform, route, primaryId = "") => `${platform}${route}${primaryId}`;
var getClientIp = (request) => request.headers.get("cf-connecting-ip") || request.headers.get("rf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
function isAuthorised(request, ctx, platform, route, primaryId = "") {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token") || "";
  const queryAuth = url.searchParams.get("auth") || "";
  const secret = ctx.config.auth.token;
  if (queryToken && queryToken === secret) return true;
  if (queryAuth && queryAuth === sign(canonical(platform, route, primaryId), secret)) return true;
  return false;
}
function requireProxyAuth(request, ctx, platform, id) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const authp = url.searchParams.get("auth") || "";
  const exp = url.searchParams.get("exp") || "";
  const secret = ctx.config.auth.token;
  if (token && token === secret) return;
  if (authp) {
    if (exp) {
      const expected = sign(`${canonical("proxy", platform, id)}${exp}`, secret);
      if (authp === expected) {
        if (Date.now() <= Number(exp) * 1e3) return;
        throw new HTTPException(403, { message: "\u94FE\u63A5\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u89E3\u6790 / link expired" });
      }
    } else if (authp === sign(canonical("proxy", platform, id), secret)) {
      return;
    }
  }
  throw new HTTPException(401, { message: "proxy: bad or expired auth" });
}
function requireAuth2(request, ctx, platform, route, primaryId = "") {
  if (isAuthorised(request, ctx, platform, route, primaryId)) return;
  const url = new URL(request.url);
  const sent = url.searchParams.get("auth") || url.searchParams.get("token") || "(none)";
  throw new HTTPException(401, {
    message: `Unauthorized: bad token/auth for ${platform}/${route}. Pass ?token=<secret> or ?auth=HMAC-SHA1(secret,"${canonical(platform, route, primaryId)}"). Received: ${sent.slice(0, 12)}\u2026`
  });
}

// src/lib/sm3.js
var IV = [
  1937774191,
  1226093241,
  388252375,
  3666478592,
  2842636476,
  372324522,
  3817729613,
  2969243214
];
var rotl = (x, n) => {
  n %= 32;
  return (x << n | x >>> 32 - n) >>> 0;
};
var p0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
var p1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
var tj = (j2) => j2 < 16 ? 2043430169 : 2055708042;
var ff = (j2, x, y, z) => (j2 < 16 ? x ^ y ^ z : x & y | x & z | y & z) >>> 0;
var gg = (j2, x, y, z) => (j2 < 16 ? x ^ y ^ z : x & y | ~x & z) >>> 0;
function cf(v, b) {
  const w = new Array(68);
  for (let i = 0; i < 16; i++) {
    w[i] = (b[4 * i] << 24 | b[4 * i + 1] << 16 | b[4 * i + 2] << 8 | b[4 * i + 3]) >>> 0;
  }
  for (let j2 = 16; j2 < 68; j2++) {
    w[j2] = (p1((w[j2 - 16] ^ w[j2 - 9] ^ rotl(w[j2 - 3], 15)) >>> 0) ^ rotl(w[j2 - 13], 7) ^ w[j2 - 6]) >>> 0;
  }
  const w1 = new Array(64);
  for (let j2 = 0; j2 < 64; j2++) w1[j2] = (w[j2] ^ w[j2 + 4]) >>> 0;
  let [a, bb, c, d, e, f, g, h] = v;
  for (let j2 = 0; j2 < 64; j2++) {
    const ss1 = rotl((rotl(a, 12) + e >>> 0) + rotl(tj(j2), j2) >>> 0, 7);
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
    const tt1 = (ff(j2, a, bb, c) + d >>> 0) + (ss2 + w1[j2] >>> 0) >>> 0;
    const tt2 = (gg(j2, e, f, g) + h >>> 0) + (ss1 + w[j2] >>> 0) >>> 0;
    d = c;
    c = rotl(bb, 9);
    bb = a;
    a = tt1 >>> 0;
    h = g;
    g = rotl(f, 19);
    f = e;
    e = p0(tt2) >>> 0;
  }
  const o = [a, bb, c, d, e, f, g, h];
  return o.map((x, i) => (x ^ v[i]) >>> 0);
}
var toHex32 = (x) => (x >>> 0).toString(16).padStart(8, "0");
function sm3Hash(msg) {
  const length = msg.length * 8;
  const m = Array.from(msg);
  m.push(128);
  while (m.length % 64 !== 56) m.push(0);
  for (let i = 0; i < 8; i++) {
    const shift = 8 * (7 - i);
    m.push(Math.floor(length / Math.pow(2, shift)) & 255);
  }
  let v = IV.slice();
  for (let i = 0; i < m.length; i += 64) {
    v = cf(v, m.slice(i, i + 64));
  }
  return v.map(toHex32).join("");
}

// src/lib/md5.js
var add32 = (a, b) => a + b & 4294967295;
var rol2 = (n, c) => n << c | n >>> 32 - c;
function cmn(q3, a, b, x, s, t) {
  a = add32(add32(a, q3), add32(x, t));
  return add32(rol2(a, s), b);
}
var ff2 = (a, b, c, d, x, s, t) => cmn(b & c | ~b & d, a, b, x, s, t);
var gg2 = (a, b, c, d, x, s, t) => cmn(b & d | c & ~d, a, b, x, s, t);
var hh = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
var ii = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);
function cycle(state, blk) {
  let [a, b, c, d] = state;
  a = ff2(a, b, c, d, blk[0], 7, -680876936);
  d = ff2(d, a, b, c, blk[1], 12, -389564586);
  c = ff2(c, d, a, b, blk[2], 17, 606105819);
  b = ff2(b, c, d, a, blk[3], 22, -1044525330);
  a = ff2(a, b, c, d, blk[4], 7, -176418897);
  d = ff2(d, a, b, c, blk[5], 12, 1200080426);
  c = ff2(c, d, a, b, blk[6], 17, -1473231341);
  b = ff2(b, c, d, a, blk[7], 22, -45705983);
  a = ff2(a, b, c, d, blk[8], 7, 1770035416);
  d = ff2(d, a, b, c, blk[9], 12, -1958414417);
  c = ff2(c, d, a, b, blk[10], 17, -42063);
  b = ff2(b, c, d, a, blk[11], 22, -1990404162);
  a = ff2(a, b, c, d, blk[12], 7, 1804603682);
  d = ff2(d, a, b, c, blk[13], 12, -40341101);
  c = ff2(c, d, a, b, blk[14], 17, -1502002290);
  b = ff2(b, c, d, a, blk[15], 22, 1236535329);
  a = gg2(a, b, c, d, blk[1], 5, -165796510);
  d = gg2(d, a, b, c, blk[6], 9, -1069501632);
  c = gg2(c, d, a, b, blk[11], 14, 643717713);
  b = gg2(b, c, d, a, blk[0], 20, -373897302);
  a = gg2(a, b, c, d, blk[5], 5, -701558691);
  d = gg2(d, a, b, c, blk[10], 9, 38016083);
  c = gg2(c, d, a, b, blk[15], 14, -660478335);
  b = gg2(b, c, d, a, blk[4], 20, -405537848);
  a = gg2(a, b, c, d, blk[9], 5, 568446438);
  d = gg2(d, a, b, c, blk[14], 9, -1019803690);
  c = gg2(c, d, a, b, blk[3], 14, -187363961);
  b = gg2(b, c, d, a, blk[8], 20, 1163531501);
  a = gg2(a, b, c, d, blk[13], 5, -1444681467);
  d = gg2(d, a, b, c, blk[2], 9, -51403784);
  c = gg2(c, d, a, b, blk[7], 14, 1735328473);
  b = gg2(b, c, d, a, blk[12], 20, -1926607734);
  a = hh(a, b, c, d, blk[5], 4, -378558);
  d = hh(d, a, b, c, blk[8], 11, -2022574463);
  c = hh(c, d, a, b, blk[11], 16, 1839030562);
  b = hh(b, c, d, a, blk[14], 23, -35309556);
  a = hh(a, b, c, d, blk[1], 4, -1530992060);
  d = hh(d, a, b, c, blk[4], 11, 1272893353);
  c = hh(c, d, a, b, blk[7], 16, -155497632);
  b = hh(b, c, d, a, blk[10], 23, -1094730640);
  a = hh(a, b, c, d, blk[13], 4, 681279174);
  d = hh(d, a, b, c, blk[0], 11, -358537222);
  c = hh(c, d, a, b, blk[3], 16, -722521979);
  b = hh(b, c, d, a, blk[6], 23, 76029189);
  a = hh(a, b, c, d, blk[9], 4, -640364487);
  d = hh(d, a, b, c, blk[12], 11, -421815835);
  c = hh(c, d, a, b, blk[15], 16, 530742520);
  b = hh(b, c, d, a, blk[2], 23, -995338651);
  a = ii(a, b, c, d, blk[0], 6, -198630844);
  d = ii(d, a, b, c, blk[7], 10, 1126891415);
  c = ii(c, d, a, b, blk[14], 15, -1416354905);
  b = ii(b, c, d, a, blk[5], 21, -57434055);
  a = ii(a, b, c, d, blk[12], 6, 1700485571);
  d = ii(d, a, b, c, blk[3], 10, -1894986606);
  c = ii(c, d, a, b, blk[10], 15, -1051523);
  b = ii(b, c, d, a, blk[1], 21, -2054922799);
  a = ii(a, b, c, d, blk[8], 6, 1873313359);
  d = ii(d, a, b, c, blk[15], 10, -30611744);
  c = ii(c, d, a, b, blk[6], 15, -1560198380);
  b = ii(b, c, d, a, blk[13], 21, 1309151649);
  a = ii(a, b, c, d, blk[4], 6, -145523070);
  d = ii(d, a, b, c, blk[11], 10, -1120210379);
  c = ii(c, d, a, b, blk[2], 15, 718787259);
  b = ii(b, c, d, a, blk[9], 21, -343485551);
  state[0] = add32(a, state[0]);
  state[1] = add32(b, state[1]);
  state[2] = add32(c, state[2]);
  state[3] = add32(d, state[3]);
}
function bytesToWords(bytes, start) {
  const w = new Array(16);
  for (let i = 0; i < 16; i++) {
    const j2 = start + i * 4;
    w[i] = bytes[j2] | bytes[j2 + 1] << 8 | bytes[j2 + 2] << 16 | bytes[j2 + 3] << 24;
  }
  return w;
}
var toHexLE = (n) => {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += (n >>> i * 8 & 255).toString(16).padStart(2, "0");
  }
  return s;
};
function md5HexOfBytes(input) {
  const bytes = Array.from(input, (b) => b & 255);
  const len = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 0; i + 64 <= len; i += 64) {
    cycle(state, bytesToWords(bytes, i));
  }
  const tail = bytes.slice(i);
  tail.push(128);
  if (tail.length > 56) {
    while (tail.length < 64) tail.push(0);
    cycle(state, bytesToWords(tail, 0));
    tail.length = 0;
  }
  while (tail.length < 56) tail.push(0);
  const bitLen = len * 8;
  for (let k = 0; k < 4; k++) tail.push(bitLen >>> k * 8 & 255);
  const high = Math.floor(len / 536870912);
  for (let k = 0; k < 4; k++) tail.push(high >>> k * 8 & 255);
  cycle(state, bytesToWords(tail, 0));
  return toHexLE(state[0]) + toHexLE(state[1]) + toHexLE(state[2]) + toHexLE(state[3]);
}

// src/sign/_common.js
var strToBytes = (s) => {
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
};
var bytesToStr = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
  return s;
};
function rc4(key, data) {
  const s = new Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j2 = 0;
  for (let i = 0; i < 256; i++) {
    j2 = (j2 + s[i] + key[i % key.length]) % 256;
    const t = s[i];
    s[i] = s[j2];
    s[j2] = t;
  }
  const out = new Array(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) % 256;
    b = (b + s[a]) % 256;
    const t = s[a];
    s[a] = s[b];
    s[b] = t;
    out[k] = data[k] ^ s[(s[a] + s[b]) % 256];
  }
  return out;
}
var md5HexOfBytes2 = (bytes) => md5HexOfBytes(bytes);

// src/sign/abogus.js
var UA_CODE = [
  76,
  98,
  15,
  131,
  97,
  245,
  224,
  133,
  122,
  199,
  241,
  166,
  79,
  34,
  90,
  191,
  128,
  126,
  122,
  98,
  66,
  11,
  14,
  40,
  49,
  110,
  110,
  173,
  67,
  96,
  138,
  252
];
var BROWSER = "1536|742|1536|864|0|0|0|0|1536|864|1536|864|1536|742|24|24|MacIntel";
var BROWSER_CODE = Array.from(BROWSER, (c) => c.charCodeAt(0));
var END_STRING = "cus";
var S4 = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe";
var sm3ToArrayFromStr = (str) => {
  const bytes = typeof str === "string" ? Array.from(new TextEncoder().encode(str)) : str;
  const hex = sm3Hash(bytes);
  const out = new Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
var doubleSm3 = (str) => sm3ToArrayFromStr(sm3ToArrayFromStr(str + END_STRING));
function randomList(a, b, c, d, e, f, g) {
  const r = a || Math.random() * 1e4;
  const ri = Math.trunc(r);
  const v0 = ri & 255;
  const v1 = ri >> 8;
  return [
    v0 & b | d,
    v0 & c | e,
    v1 & b | f,
    v1 & c | g
  ];
}
var list1 = (n) => randomList(n, 170, 85, 1, 2, 5, 45 & 170);
var list2 = (n) => randomList(n, 170, 85, 1, 0, 0, 0);
var list3 = (n) => randomList(n, 170, 85, 1, 0, 5, 0);
var b256 = (v, sh) => Math.floor(v / Math.pow(2, sh)) % 256;
function list4(a, b, c, d, e, f, g, h, i, j2, k, m, n, o, p, q3, r) {
  return [
    44,
    a,
    0,
    0,
    0,
    0,
    24,
    b,
    n,
    0,
    c,
    d,
    0,
    0,
    0,
    1,
    0,
    239,
    e,
    o,
    f,
    g,
    0,
    0,
    0,
    0,
    h,
    0,
    0,
    14,
    i,
    j2,
    0,
    k,
    m,
    3,
    p,
    1,
    q3,
    1,
    r,
    0,
    0,
    0
  ];
}
var endCheckNum = (arr) => arr.reduce((acc, x) => acc ^ x, 0);
function generateString2Codes(urlParams, method, startTime, endTime) {
  const paramsArray = doubleSm3(urlParams);
  const methodArray = doubleSm3(method);
  const a = list4(
    b256(endTime, 24),
    paramsArray[21],
    UA_CODE[23],
    b256(endTime, 16),
    paramsArray[22],
    UA_CODE[24],
    b256(endTime, 8),
    b256(endTime, 0),
    b256(startTime, 24),
    b256(startTime, 16),
    b256(startTime, 8),
    b256(startTime, 0),
    methodArray[21],
    methodArray[22],
    Math.floor(endTime / 4294967296),
    Math.floor(startTime / 4294967296),
    BROWSER.length
  );
  const e = endCheckNum(a);
  const full = a.concat(BROWSER_CODE);
  full.push(e);
  return rc4([121], full);
}
function generateResult(codes, table) {
  const r = [];
  const js = [18, 12, 6, 0];
  const ks = [16515072, 258048, 4032, 63];
  for (let i = 0; i < codes.length; i += 3) {
    let n;
    if (i + 2 < codes.length) n = codes[i] << 16 | codes[i + 1] << 8 | codes[i + 2];
    else if (i + 1 < codes.length) n = codes[i] << 16 | codes[i + 1] << 8;
    else n = codes[i] << 16;
    for (let t = 0; t < 4; t++) {
      const j2 = js[t];
      if (j2 === 6 && i + 1 >= codes.length) break;
      if (j2 === 0 && i + 2 >= codes.length) break;
      r.push(table[(n & ks[t]) >> j2]);
    }
  }
  r.push("=".repeat((4 - r.length % 4) % 4));
  return r.join("");
}
function getABogus(urlParams, method = "GET", opts = {}) {
  const r1 = opts.random1 ?? Math.random();
  const r2 = opts.random2 ?? Math.random();
  const r3 = opts.random3 ?? Math.random();
  const startTime = opts.startTime ?? Date.now();
  const endTime = opts.endTime ?? startTime + Math.floor(Math.random() * 5) + 4;
  const string1 = list1(r1).concat(list2(r2)).concat(list3(r3));
  const string2 = generateString2Codes(urlParams, method, startTime, endTime);
  const codes = string1.concat(string2);
  return generateResult(codes, S4);
}

// src/sign/xbogus.js
var CHARACTER = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=";
var UA_KEY = [0, 1, 12];
var HEX = new Array(128).fill(null);
for (let i = 0; i < 10; i++) HEX["0".charCodeAt(0) + i] = i;
for (let i = 0; i < 6; i++) HEX["a".charCodeAt(0) + i] = 10 + i;
for (let i = 0; i < 6; i++) HEX["A".charCodeAt(0) + i] = 10 + i;
function md5StrToArray(s) {
  if (typeof s === "string" && s.length > 32) {
    const out2 = new Array(s.length);
    for (let i = 0; i < s.length; i++) out2[i] = s.charCodeAt(i);
    return out2;
  }
  const out = [];
  for (let idx = 0; idx < s.length; idx += 2) {
    out.push(HEX[s.charCodeAt(idx)] << 4 | HEX[s.charCodeAt(idx + 1)]);
  }
  return out;
}
function md5(input) {
  let arr;
  if (typeof input === "string") arr = md5StrToArray(input);
  else arr = input;
  return md5HexOfBytes2(arr);
}
var md5Encrypt = (urlPath) => md5StrToArray(md5(md5StrToArray(md5(urlPath))));
function encodingConversion(a, b, c, e, d, t, f, r, n, o, i, _, x, u, s, l, v, h, p) {
  const y = [a, Math.floor(i), b, _, c, x, e, u, d, s, t, l, f, v, r, h, n, p, o];
  return bytesToStr(y);
}
var encodingConversion2 = (a, b, c) => String.fromCharCode(a) + String.fromCharCode(b) + c;
function calculation(character, a1, a2, a3) {
  const x1 = (a1 & 255) << 16;
  const x2 = (a2 & 255) << 8;
  const x3 = x1 | x2 | a3;
  return character[(x3 & 16515072) >> 18] + character[(x3 & 258048) >> 12] + character[(x3 & 4032) >> 6] + character[x3 & 63];
}
function getXBogus(urlPath, userAgent, timer) {
  const ua = userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0";
  if (timer === void 0) timer = Math.floor(Date.now() / 1e3);
  const rc4ua = rc4(UA_KEY, strToBytes(ua));
  const b64 = typeof btoa === "function" ? btoa(bytesToStr(rc4ua)) : globalThis.Buffer.from(rc4ua.map((b) => b & 255)).toString("base64");
  const array1 = md5StrToArray(md5(b64));
  const array2 = md5StrToArray(md5(md5StrToArray("d41d8cd98f00b204e9800998ecf8427e")));
  const urlPathArray = md5Encrypt(urlPath);
  const ct = 536919696;
  const newArray = [
    64,
    390625e-8,
    1,
    12,
    urlPathArray[14],
    urlPathArray[15],
    array2[14],
    array2[15],
    array1[14],
    array1[15],
    timer >> 24 & 255,
    timer >> 16 & 255,
    timer >> 8 & 255,
    timer & 255,
    ct >> 24 & 255,
    ct >> 16 & 255,
    ct >> 8 & 255,
    ct & 255
  ];
  let xor = newArray[0];
  for (let i = 1; i < newArray.length; i++) {
    let b = newArray[i];
    if (!Number.isInteger(b)) b = Math.floor(b);
    xor ^= b;
  }
  newArray.push(xor);
  const array3 = [];
  const array4 = [];
  for (let idx = 0; idx < newArray.length; idx += 2) {
    array3.push(newArray[idx]);
    if (idx + 1 < newArray.length) array4.push(newArray[idx + 1]);
  }
  const mergeArray = array3.concat(array4);
  const garbled = encodingConversion2(
    2,
    255,
    bytesToStr(rc4([255], strToBytes(encodingConversion(...mergeArray))))
  );
  let xb = "";
  for (let idx = 0; idx < garbled.length; idx += 3) {
    xb += calculation(
      CHARACTER,
      garbled.charCodeAt(idx),
      garbled.charCodeAt(idx + 1),
      garbled.charCodeAt(idx + 2)
    );
  }
  return { params: `${urlPath}&X-Bogus=${xb}`, xBogus: xb };
}

// src/utils/params.js
var SAFE = /[A-Za-z0-9_.\-~]/;
function quotePlus(value) {
  const s = String(value);
  let out = "";
  for (const ch of s) {
    if (SAFE.test(ch)) out += ch;
    else if (ch === " ") out += "+";
    else {
      for (const b of new TextEncoder().encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}
function urlencode(obj) {
  return Object.entries(obj).map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
}
function rawJoin(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("&");
}
function baseRequestParams(msToken = "") {
  return {
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    pc_client_type: "1",
    version_code: "290100",
    version_name: "29.1.0",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Chrome",
    browser_version: "130.0.0.0",
    browser_online: "true",
    engine_name: "Blink",
    engine_version: "130.0.0.0",
    os_name: "Windows",
    os_version: "10",
    cpu_core_num: "12",
    device_memory: "8",
    platform: "PC",
    downlink: "10",
    effective_type: "4g",
    from_user_page: "1",
    locate_query: "false",
    need_time_list: "1",
    pc_libra_divert: "Windows",
    publish_video_strategy_type: "2",
    round_trip_time: "0",
    show_live_replay_strategy: "1",
    time_list_query: "0",
    whale_cut_token: "",
    update_version_code: "170400",
    msToken
  };
}
function baseLiveParams() {
  return {
    aid: "6383",
    app_name: "douyin_web",
    live_id: "1",
    device_platform: "web",
    language: "zh-CN",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Edge",
    browser_version: "119.0.0.0",
    enter_source: "",
    is_need_double_stream: "false"
  };
}
function baseLive2Params(verifyFp, msToken) {
  return {
    verifyFp,
    type_id: "0",
    live_id: "1",
    sec_user_id: "",
    version_code: "99.99.99",
    app_id: "1128",
    msToken
  };
}

// src/utils/base-crawler.js
function buildHeaders({ userAgent, referer, cookie, extra = {} }) {
  const h = {
    "User-Agent": userAgent,
    "Accept-Language": "zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2",
    ...extra
  };
  if (referer) h.Referer = referer;
  if (cookie) h.Cookie = cookie;
  return h;
}
async function parseJson(resp, url) {
  const text = await resp.text();
  if (!resp.ok) {
    throw new HTTPException(resp.status === 404 ? 404 : 502, {
      message: `Upstream ${resp.status} for ${url}: ${text.slice(0, 200)}`
    });
  }
  if (!text) {
    throw new HTTPException(502, {
      message: `Upstream returned an empty body for ${url} \u2014 usually a bad/expired cookie or blocked signature.`
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HTTPException(502, {
      message: `Upstream returned non-JSON for ${url}: ${text.slice(0, 200)}`
    });
  }
}
async function fetchGetJson(url, headers2) {
  const resp = await fetch(url, { method: "GET", headers: headers2, redirect: "follow" });
  return parseJson(resp, url);
}

// src/utils/tokens.js
var RANDOM_BASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-";
function genRandomStr(len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += RANDOM_BASE[Math.floor(Math.random() * RANDOM_BASE.length)];
  }
  return s;
}
var genFalseMsToken = () => genRandomStr(126) + "==";
var VFP_BASE = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function genVerifyFp() {
  const t = VFP_BASE.length;
  let ms = Date.now();
  let base36 = "";
  while (ms > 0) {
    const rem = ms % 36;
    base36 = (rem < 10 ? String(rem) : String.fromCharCode(97 + rem - 10)) + base36;
    ms = Math.floor(ms / 36);
  }
  const o = new Array(36).fill("");
  o[8] = o[13] = o[18] = o[23] = "_";
  o[14] = "4";
  for (let i = 0; i < 36; i++) {
    if (!o[i]) {
      let n = Math.floor(Math.random() * t);
      if (i === 19) n = 3 & n | 8;
      o[i] = VFP_BASE[n];
    }
  }
  return "verify_" + base36 + "_" + o.join("");
}
var genSVWebId = () => genVerifyFp();
var TTWID_URL = "https://ttwid.bytedance.com/ttwid/union/register/";
var TTWID_DATA = '{"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com","migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}';
async function genTtwid() {
  try {
    const resp = await fetch(TTWID_URL, {
      method: "POST",
      body: TTWID_DATA,
      headers: { "content-type": "text/plain;charset=UTF-8" }
    });
    const setCookie = resp.headers.get("set-cookie") || "";
    const m = setCookie.match(/ttwid=([^;]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
var MSTOKEN_URL = "https://mssdk.bytedance.com/web/report";
var MSTOKEN_PAYLOAD = {
  magic: 538969122,
  version: 1,
  dataType: 8,
  strData: "",
  tspFromClient: 0
};
async function genRealMsToken() {
  try {
    const payload = { ...MSTOKEN_PAYLOAD, tspFromClient: Date.now() };
    const resp = await fetch(MSTOKEN_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" }
    });
    const setCookie = resp.headers.get("set-cookie") || "";
    const m = setCookie.match(/msToken=([^;]+)/);
    if (m && (m[1].length === 120 || m[1].length === 128)) return m[1];
    return genFalseMsToken();
  } catch {
    return genFalseMsToken();
  }
}

// src/douyin/endpoints.js
var DOUYIN = "https://www.douyin.com";
var LIVE = "https://live.douyin.com";
var LIVE2 = "https://webcast.amemv.com";
var DouyinEndpoints = {
  POST_DETAIL: `${DOUYIN}/aweme/v1/web/aweme/detail/`,
  GENERAL_SEARCH: `${DOUYIN}/aweme/v1/web/general/search/single/`,
  HOT_SEARCH: `${DOUYIN}/aweme/v1/web/hot/search/list/`,
  USER_POST: `${DOUYIN}/aweme/v1/web/aweme/post/`,
  USER_FAVORITE_A: `${DOUYIN}/aweme/v1/web/aweme/favorite/`,
  USER_DETAIL: `${DOUYIN}/aweme/v1/web/user/profile/other/`,
  MIX_AWEME: `${DOUYIN}/aweme/v1/web/mix/aweme/`,
  POST_COMMENT: `${DOUYIN}/aweme/v1/web/comment/list/`,
  POST_COMMENT_REPLY: `${DOUYIN}/aweme/v1/web/comment/list/reply/`,
  LIVE_INFO: `${LIVE}/webcast/room/web/enter/`,
  LIVE_INFO_ROOM_ID: `${LIVE2}/webcast/room/reflow/info/`,
  LIVE_GIFT_RANK: `${LIVE}/webcast/ranklist/audience/`
};
var DOUYIN_REFERER = "https://www.douyin.com/";

// src/douyin/crawler.js
async function douyinHeaders(ctx) {
  let cookie = ctx.config.douyin.cookie;
  if (!cookie) {
    const ttwid = await genTtwid();
    if (ttwid) cookie = `ttwid=${ttwid}`;
  }
  return buildHeaders({
    userAgent: ctx.config.douyin.userAgent,
    referer: DOUYIN_REFERER,
    cookie
  });
}
async function aBogusGet(ctx, baseUrl, params) {
  const paramStr = urlencode(params);
  const aBogus = getABogus(paramStr, "GET");
  const url = `${baseUrl}?${paramStr}&a_bogus=${encodeURIComponent(aBogus)}`;
  return fetchGetJson(url, await douyinHeaders(ctx));
}
function fetchOneVideo(ctx, awemeId) {
  const params = { ...baseRequestParams(""), aweme_id: awemeId };
  return aBogusGet(ctx, DouyinEndpoints.POST_DETAIL, params);
}
var SHARE_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
async function fetchShareDetail(ctx, awemeId) {
  const url = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  let html;
  try {
    const resp = await fetch(url, { headers: { "User-Agent": SHARE_MOBILE_UA, Referer: "https://www.iesdouyin.com/" } });
    html = await resp.text();
  } catch {
    return { aweme_detail: null };
  }
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{.+?\})<\/script>/s);
  if (!m) return { aweme_detail: null };
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return { aweme_detail: null };
  }
  const page = data.loaderData && data.loaderData["video_(id)/page"];
  const res = page && page.videoInfoRes;
  return {
    aweme_detail: res && res.item_list && res.item_list[0] || null,
    filter_detail: res && res.filter_list && res.filter_list[0] || null
  };
}
function fetchUserPostVideos(ctx, secUserId, maxCursor, count) {
  const params = { ...baseRequestParams(""), max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId };
  return aBogusGet(ctx, DouyinEndpoints.USER_POST, params);
}
function fetchUserLikeVideos(ctx, secUserId, maxCursor, count) {
  const params = { ...baseRequestParams(""), max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId };
  return aBogusGet(ctx, DouyinEndpoints.USER_FAVORITE_A, params);
}
function fetchGeneralSearch(ctx, keyword, offset = 0, count = 10) {
  const params = {
    // Empty msToken (like the working fetch_one_video call); a FAKE msToken
    // can itself trip risk control (2483).
    ...baseRequestParams(""),
    search_channel: "aweme_general",
    enable_history: "1",
    keyword,
    search_source: "normal_search",
    query_correct_type: "1",
    is_filter_search: "0",
    from_group_id: "",
    offset: String(offset),
    count: String(count),
    need_filter_settings: "1",
    list_type: "multi"
  };
  return aBogusGet(ctx, DouyinEndpoints.GENERAL_SEARCH, params);
}
function fetchHotSearchList(ctx) {
  const params = { ...baseRequestParams(genFalseMsToken()), detail_list: "1" };
  return xBogusGet(ctx, DouyinEndpoints.HOT_SEARCH, params);
}
async function xBogusGet(ctx, baseUrl, params) {
  const paramStr = rawJoin(params);
  const { xBogus } = getXBogus(paramStr, ctx.config.douyin.userAgent);
  const url = `${baseUrl}?${paramStr}&X-Bogus=${xBogus}`;
  return fetchGetJson(url, await douyinHeaders(ctx));
}
function handlerUserProfile(ctx, secUserId) {
  const params = { ...baseRequestParams(genFalseMsToken()), sec_user_id: secUserId };
  return xBogusGet(ctx, DouyinEndpoints.USER_DETAIL, params);
}
function fetchUserMixVideos(ctx, mixId, cursor, count) {
  const params = { ...baseRequestParams(genFalseMsToken()), cursor: String(cursor), count: String(count), mix_id: mixId };
  return xBogusGet(ctx, DouyinEndpoints.MIX_AWEME, params);
}
function fetchVideoComments(ctx, awemeId, cursor, count) {
  const params = {
    ...baseRequestParams(genFalseMsToken()),
    aweme_id: awemeId,
    cursor: String(cursor),
    count: String(count),
    item_type: "0",
    insert_ids: "",
    whale_cut_token: "",
    cut_version: "1",
    rcFT: ""
  };
  return xBogusGet(ctx, DouyinEndpoints.POST_COMMENT, params);
}
function fetchVideoCommentReplies(ctx, itemId, commentId, cursor, count) {
  const params = {
    ...baseRequestParams(genFalseMsToken()),
    item_id: itemId,
    comment_id: commentId,
    cursor: String(cursor),
    count: String(count),
    item_type: "0"
  };
  return xBogusGet(ctx, DouyinEndpoints.POST_COMMENT_REPLY, params);
}
function fetchUserLiveVideos(ctx, webcastId) {
  const params = { ...baseLiveParams(), web_rid: webcastId, room_id_str: "" };
  return xBogusGet(ctx, DouyinEndpoints.LIVE_INFO, params);
}
function fetchUserLiveVideosByRoomId(ctx, roomId) {
  const params = { ...baseLive2Params(genVerifyFp(), genFalseMsToken()), room_id: roomId };
  return xBogusGet(ctx, DouyinEndpoints.LIVE_INFO_ROOM_ID, params);
}
function fetchLiveGiftRanking(ctx, roomId, rankType) {
  const params = {
    ...baseRequestParams(genFalseMsToken()),
    webcast_sdk_version: "2450",
    room_id: String(roomId),
    rank_type: String(rankType)
  };
  return xBogusGet(ctx, DouyinEndpoints.LIVE_GIFT_RANK, params);
}

// src/utils/ids.js
var URL_RE = /https?:\/\/\S+/;
function extractValidUrl(input) {
  if (typeof input !== "string") return null;
  const m = input.match(URL_RE);
  return m ? m[0] : null;
}
async function resolveUrl(url) {
  const resp = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    }
  });
  return resp.url || url;
}
function firstMatch(str, patterns) {
  for (const re of patterns) {
    const m = str.match(re);
    if (m) return m[1];
  }
  return null;
}
var AWEME_PATTERNS = [
  /video\/([^/?]+)/,
  /[?&]vid=(\d+)/,
  /note\/([^/?]+)/,
  /modal_id=(\d+)/
];
async function getAwemeId(rawUrl) {
  const url = extractValidUrl(rawUrl);
  if (!url) throw new HTTPException(400, { message: "Invalid URL" });
  let id = firstMatch(url, AWEME_PATTERNS);
  if (id) return id;
  const finalUrl = await resolveUrl(url);
  id = firstMatch(finalUrl, AWEME_PATTERNS);
  if (id) return id;
  throw new HTTPException(404, { message: `aweme_id not found in ${finalUrl}` });
}
var SEC_UID_PATTERNS = [
  /user\/([^/?]+)/,
  /sec_uid=([^&]+)/
];
async function getSecUserId(rawUrl) {
  const url = extractValidUrl(rawUrl);
  if (!url) throw new HTTPException(400, { message: "Invalid URL" });
  let id = firstMatch(url, SEC_UID_PATTERNS);
  if (id) return id;
  const finalUrl = await resolveUrl(url);
  id = firstMatch(finalUrl, SEC_UID_PATTERNS);
  if (id) return id;
  throw new HTTPException(404, { message: `sec_user_id not found in ${finalUrl}` });
}
var WEBCAST_PATTERNS = [
  /live\/([^/?]+)/,
  /https?:\/\/live\.douyin\.com\/(\d+)/,
  /reflow\/([^/?]+)/
];
async function getWebcastId(rawUrl) {
  const url = extractValidUrl(rawUrl);
  if (!url) throw new HTTPException(400, { message: "Invalid URL" });
  let id = firstMatch(url, WEBCAST_PATTERNS);
  if (id) return id;
  const finalUrl = await resolveUrl(url);
  id = firstMatch(finalUrl, WEBCAST_PATTERNS);
  if (id) return id;
  throw new HTTPException(404, { message: `webcast_id not found in ${finalUrl}` });
}
var TIKTOK_ID_PATTERNS = [
  /\/video\/(\d+)/,
  /\/photo\/(\d+)/,
  /item_id=(\d+)/,
  /modal_id=(\d+)/
];
async function getTiktokAwemeId(rawUrl) {
  const url = extractValidUrl(rawUrl);
  if (!url) throw new HTTPException(400, { message: "Invalid URL" });
  let id = firstMatch(url, TIKTOK_ID_PATTERNS);
  if (id) return id;
  const finalUrl = await resolveUrl(url);
  id = firstMatch(finalUrl, TIKTOK_ID_PATTERNS);
  if (id) return id;
  throw new HTTPException(404, { message: `tiktok aweme_id not found in ${finalUrl}` });
}
var TIKTOK_UNIQUE_PATTERNS = [/@([^/?]+)/];
async function getTiktokUniqueId(rawUrl) {
  const url = extractValidUrl(rawUrl);
  if (!url) throw new HTTPException(400, { message: "Invalid URL" });
  let id = firstMatch(url, TIKTOK_UNIQUE_PATTERNS);
  if (id) return id;
  const finalUrl = await resolveUrl(url);
  id = firstMatch(finalUrl, TIKTOK_UNIQUE_PATTERNS);
  if (id) return id;
  throw new HTTPException(404, { message: `unique_id not found in ${finalUrl}` });
}

// src/utils/r2cache.js
var mediaKey = (platform, id, kind) => `media/${platform}/${encodeURIComponent(String(id))}/${kind}`;
var metaKey = (platform, id) => `meta/${platform}/${encodeURIComponent(String(id))}.json`;
function parseRangeHeader(header, totalSize) {
  if (!header) return null;
  const m = String(header).trim().match(/^bytes=(\d+)-(\d*)$/i);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === "" ? totalSize - 1 : Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= totalSize) return null;
  if (end < start) return null;
  const cappedEnd = Math.min(end, totalSize - 1);
  return { start, end: cappedEnd, length: cappedEnd - start + 1 };
}
async function serveFromR2(bucket, request, key, contentType, minSize = 0) {
  if (!bucket || typeof bucket.head !== "function") return null;
  let head;
  try {
    head = await bucket.head(key);
  } catch {
    return null;
  }
  if (!head) return null;
  if (minSize && (Number(head.size) || 0) < minSize) return null;
  const totalSize = Number(head.size) || 0;
  const storedType = head.httpMetadata?.contentType || contentType || "application/octet-stream";
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;
  if (range) {
    let obj2;
    try {
      obj2 = await bucket.get(key, { range: { offset: range.start, length: range.length } });
    } catch {
      return null;
    }
    if (!obj2) return null;
    return new Response(obj2.body, {
      status: 206,
      headers: {
        "content-type": storedType,
        "content-length": String(range.length),
        "content-range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=300",
        "x-cache-source": "r2"
      }
    });
  }
  let obj;
  try {
    obj = await bucket.get(key);
  } catch {
    return null;
  }
  if (!obj) return null;
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": storedType,
      "content-length": String(totalSize),
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=300",
      "x-cache-source": "r2"
    }
  });
}
function teeIntoCache(bucket, ctx, key, upstreamResponse, contentType) {
  if (!bucket || !upstreamResponse.ok || !upstreamResponse.body) return upstreamResponse;
  const finalType = contentType || upstreamResponse.headers.get("content-type") || "application/octet-stream";
  const lenHeader = upstreamResponse.headers.get("content-length");
  const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
  let userBranch, r2Branch;
  try {
    [userBranch, r2Branch] = upstreamResponse.body.tee();
  } catch {
    return upstreamResponse;
  }
  const put = total != null && total > PART_SIZE ? r2PutMultipart(bucket, key, r2Branch, { httpMetadata: { contentType: finalType } }) : bucket.put(key, r2Branch, { httpMetadata: { contentType: finalType } }).catch((e) => {
    try {
      console.error("[r2] put failed", key, e?.message || e);
    } catch {
    }
  });
  if (ctx?.waitUntil) ctx.waitUntil(put);
  const out = new Headers();
  out.set("content-type", finalType);
  if (total != null) out.set("content-length", String(total));
  out.set("accept-ranges", "bytes");
  out.set("cache-control", "public, max-age=300");
  out.set("x-cache-source", "upstream-tee");
  return new Response(userBranch, { status: upstreamResponse.status, headers: out });
}
async function getJson(bucket, key, ttlSeconds) {
  if (!bucket || typeof bucket.get !== "function") return null;
  let obj;
  try {
    obj = await bucket.get(key);
  } catch {
    return null;
  }
  if (!obj) return null;
  if (ttlSeconds && obj.uploaded) {
    const age = (Date.now() - new Date(obj.uploaded).getTime()) / 1e3;
    if (age > ttlSeconds) return null;
  }
  try {
    const text = obj.body ? await new Response(obj.body).text() : await obj.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}
var PART_SIZE = 8 * 1024 * 1024;
async function r2PutMultipart(bucket, key, stream, opts = {}, partSize = PART_SIZE) {
  if (!bucket || !stream) return false;
  if (typeof bucket.createMultipartUpload !== "function") {
    return r2PutRetry(bucket, key, () => stream, opts, 1);
  }
  let upload;
  try {
    upload = await bucket.createMultipartUpload(key, opts);
  } catch (e) {
    try {
      console.error("[r2] multipart create failed", key, e?.message || e);
    } catch {
    }
    return false;
  }
  const reader = stream.getReader();
  const parts = [];
  let partNumber = 1;
  let buf = new Uint8Array(0);
  const concat = (a, b) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
  };
  const flush = async (chunk) => {
    parts.push(await upload.uploadPart(partNumber, chunk));
    partNumber++;
  };
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        buf = buf.length ? concat(buf, value) : value;
        while (buf.length >= partSize) {
          await flush(buf.subarray(0, partSize));
          buf = buf.subarray(partSize);
        }
      }
    }
    if (buf.length > 0 || parts.length === 0) await flush(buf);
    await upload.complete(parts);
    return true;
  } catch (e) {
    try {
      await upload.abort();
    } catch {
    }
    try {
      console.error("[r2] multipart upload failed", key, e?.message || e);
    } catch {
    }
    return false;
  }
}
async function warmUrl(ctx, bucket, key, url, headers2, contentType, { lockTtl = 300 } = {}) {
  if (!bucket || !url) return;
  try {
    const h = await bucket.head(key);
    if (h && (Number(h.size) || 0) > 256) return;
  } catch {
  }
  const kv = ctx?.config?.kv;
  const lock = `warm:${key}`;
  try {
    if (kv) {
      if (await kv.get(lock)) return;
      await kv.put(lock, "1", { expirationTtl: lockTtl });
    }
  } catch {
  }
  const job = (async () => {
    try {
      const f = await fetch(url, { headers: headers2 });
      if (!f.ok || !f.body) return;
      await r2PutMultipart(bucket, key, f.body, { httpMetadata: { contentType } });
    } catch (e) {
      try {
        console.error("[r2] warm failed", key, e?.message || e);
      } catch {
      }
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(job);
  else await job;
}
async function r2PutRetry(bucket, key, makeBody, opts, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      await bucket.put(key, makeBody(), opts);
      return true;
    } catch (e) {
      if (i === tries - 1) {
        try {
          console.error("[r2] put gave up", key, e?.message || e);
        } catch {
        }
        return false;
      }
    }
  }
  return false;
}
function putJson(bucket, ctx, key, obj) {
  if (!bucket) return;
  const json2 = JSON.stringify(obj);
  const p = r2PutRetry(
    bucket,
    key,
    () => new Response(json2).body,
    { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    2
  );
  if (ctx?.waitUntil) ctx.waitUntil(p);
}

// src/tiktok/app/crawler.js
var HOME_FEED = "https://api22-normal-c-alisg.tiktokv.com/aweme/v1/feed/";
function feedParams(awemeId) {
  return {
    iid: "7318518857994389254",
    device_id: "7318517321748022790",
    channel: "googleplay",
    app_name: "musical_ly",
    version_code: "300904",
    device_platform: "android",
    device_type: "SM-ASUS_Z01QD",
    os_version: "9",
    aweme_id: awemeId
  };
}
async function fetchTrendingFeed(ctx, count = 12) {
  const params = { ...feedParams(""), count: String(count) };
  delete params.aweme_id;
  const url = `${HOME_FEED}?${urlencode(params)}`;
  const headers2 = buildHeaders({
    userAgent: ctx.config.tiktok.userAgent,
    referer: "https://www.tiktok.com/",
    cookie: ctx.config.tiktok.cookie || "CykaBlyat=XD",
    extra: { "x-ladon": "Hello From Evil0ctal!" }
  });
  const data = await fetchGetJson(url, headers2);
  return Array.isArray(data.aweme_list) ? data.aweme_list : [];
}
async function fetchOneVideo2(ctx, awemeId) {
  const url = `${HOME_FEED}?${urlencode(feedParams(awemeId))}`;
  const headers2 = buildHeaders({
    userAgent: ctx.config.tiktok.userAgent,
    referer: "https://www.tiktok.com/",
    cookie: ctx.config.tiktok.cookie || "CykaBlyat=XD",
    extra: { "x-ladon": "Hello From Evil0ctal!" }
  });
  const data = await fetchGetJson(url, headers2);
  const list = data.aweme_list;
  if (!Array.isArray(list) || list.length === 0) {
    throw new HTTPException(404, { message: `No aweme in feed for ${awemeId}` });
  }
  const aweme = list[0];
  if (aweme.aweme_id !== awemeId) {
    throw new HTTPException(404, { message: `Video ID mismatch (got ${aweme.aweme_id})` });
  }
  return aweme;
}

// src/utils/meta-cache.js
async function fetchDouyinDetailCached(ctx, awemeId, refresh = false) {
  const bucket = ctx.config.mediaR2;
  const key = metaKey("douyin", awemeId);
  if (bucket && !refresh) {
    const cached = await getJson(bucket, key, ctx.config.cache.metaTtl);
    if (cached) return { data: cached, cached: true };
  }
  const data = await fetchOneVideo(ctx, awemeId);
  if (!data.aweme_detail) {
    const share = await fetchShareDetail(ctx, awemeId);
    if (share.aweme_detail) data.aweme_detail = share.aweme_detail;
    else if (!data.filter_detail && share.filter_detail) data.filter_detail = share.filter_detail;
  }
  if (data.aweme_detail) putJson(bucket, ctx, key, data);
  return { data, cached: false };
}
async function fetchTiktokAwemeCached(ctx, awemeId, refresh = false) {
  const bucket = ctx.config.mediaR2;
  const key = metaKey("tiktok", awemeId);
  if (bucket && !refresh) {
    const cached = await getJson(bucket, key, ctx.config.cache.metaTtl);
    if (cached) return { data: cached, cached: true };
  }
  const data = await fetchOneVideo2(ctx, awemeId);
  putJson(bucket, ctx, key, data);
  return { data, cached: false };
}

// src/service/douyin.js
var PLATFORM = "douyin";
var truthy = (v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
var q = (request, key, dflt = "") => new URL(request.url).searchParams.get(key) ?? dflt;
var requireQ = (request, key) => {
  const v = new URL(request.url).searchParams.get(key);
  if (v === null || v === "") throw new HTTPException(400, { message: `Missing query param: ${key}` });
  return v;
};
async function douyinWebService(route, request, ctx) {
  const method = request.method;
  if (method === "GET" && route === "fetch_one_video") {
    const awemeId = requireQ(request, "aweme_id");
    requireAuth2(request, ctx, PLATFORM, route, awemeId);
    const { data, cached } = await fetchDouyinDetailCached(ctx, awemeId, truthy(q(request, "refresh")));
    return jsonResponse(data, { router: route, params: { aweme_id: awemeId }, headers: { "x-cache": cached ? "hit" : "miss" } });
  }
  if (method === "GET" && route === "fetch_user_post_videos") {
    const secUserId = requireQ(request, "sec_user_id");
    requireAuth2(request, ctx, PLATFORM, route, secUserId);
    const maxCursor = q(request, "max_cursor", "0");
    const count = q(request, "count", "20");
    return jsonResponse(await fetchUserPostVideos(ctx, secUserId, maxCursor, count), { router: route });
  }
  if (method === "GET" && route === "fetch_user_like_videos") {
    const secUserId = requireQ(request, "sec_user_id");
    requireAuth2(request, ctx, PLATFORM, route, secUserId);
    const maxCursor = q(request, "max_cursor", "0");
    const count = q(request, "counts", q(request, "count", "20"));
    return jsonResponse(await fetchUserLikeVideos(ctx, secUserId, maxCursor, count), { router: route });
  }
  if (method === "GET" && route === "fetch_user_mix_videos") {
    const mixId = requireQ(request, "mix_id");
    requireAuth2(request, ctx, PLATFORM, route, mixId);
    const cursor = q(request, "max_cursor", q(request, "cursor", "0"));
    const count = q(request, "counts", q(request, "count", "20"));
    return jsonResponse(await fetchUserMixVideos(ctx, mixId, cursor, count), { router: route });
  }
  if (method === "GET" && route === "handler_user_profile") {
    const secUserId = requireQ(request, "sec_user_id");
    requireAuth2(request, ctx, PLATFORM, route, secUserId);
    return jsonResponse(await handlerUserProfile(ctx, secUserId), { router: route });
  }
  if (method === "GET" && route === "fetch_video_comments") {
    const awemeId = requireQ(request, "aweme_id");
    requireAuth2(request, ctx, PLATFORM, route, awemeId);
    const cursor = q(request, "cursor", "0");
    const count = q(request, "count", "20");
    return jsonResponse(await fetchVideoComments(ctx, awemeId, cursor, count), { router: route });
  }
  if (method === "GET" && route === "fetch_video_comment_replies") {
    const itemId = requireQ(request, "item_id");
    requireAuth2(request, ctx, PLATFORM, route, itemId);
    const commentId = requireQ(request, "comment_id");
    const cursor = q(request, "cursor", "0");
    const count = q(request, "count", "20");
    return jsonResponse(await fetchVideoCommentReplies(ctx, itemId, commentId, cursor, count), { router: route });
  }
  if (method === "GET" && route === "fetch_user_live_videos") {
    const webcastId = requireQ(request, "webcast_id");
    requireAuth2(request, ctx, PLATFORM, route, webcastId);
    return jsonResponse(await fetchUserLiveVideos(ctx, webcastId), { router: route });
  }
  if (method === "GET" && route === "fetch_user_live_videos_by_room_id") {
    const roomId = requireQ(request, "room_id");
    requireAuth2(request, ctx, PLATFORM, route, roomId);
    return jsonResponse(await fetchUserLiveVideosByRoomId(ctx, roomId), { router: route });
  }
  if (method === "GET" && route === "fetch_live_gift_ranking") {
    const roomId = requireQ(request, "room_id");
    requireAuth2(request, ctx, PLATFORM, route, roomId);
    const rankType = q(request, "rank_type", "30");
    return jsonResponse(await fetchLiveGiftRanking(ctx, roomId, rankType), { router: route });
  }
  if (method === "GET" && route === "generate_real_msToken") {
    return jsonResponse({ msToken: await genRealMsToken() }, { router: route });
  }
  if (method === "GET" && route === "generate_ttwid") {
    return jsonResponse({ ttwid: await genTtwid() }, { router: route });
  }
  if (method === "GET" && route === "generate_verify_fp") {
    return jsonResponse({ verify_fp: genVerifyFp() }, { router: route });
  }
  if (method === "GET" && route === "generate_s_v_web_id") {
    return jsonResponse({ s_v_web_id: genSVWebId() }, { router: route });
  }
  if (method === "GET" && route === "generate_x_bogus") {
    const url = requireQ(request, "url");
    const ua = q(request, "user_agent", ctx.config.douyin.userAgent);
    const r = getXBogus(url, ua);
    return jsonResponse({ url: r.params, x_bogus: r.xBogus, user_agent: ua }, { router: route });
  }
  if (method === "GET" && route === "generate_a_bogus") {
    const url = requireQ(request, "url");
    const ua = q(request, "user_agent", ctx.config.douyin.userAgent);
    const [endpoint, query = ""] = url.split("?");
    const params = {};
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const idx = pair.indexOf("=");
      params[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    params.msToken = "";
    const paramStr = urlencode(params);
    const aBogus = getABogus(paramStr, "GET");
    return jsonResponse({
      url: `${endpoint}?${paramStr}&a_bogus=${encodeURIComponent(aBogus)}`,
      a_bogus: aBogus,
      user_agent: ua
    }, { router: route });
  }
  if (method === "GET" && route === "get_aweme_id") {
    return jsonResponse(await getAwemeId(requireQ(request, "url")), { router: route });
  }
  if (method === "GET" && route === "get_sec_user_id") {
    return jsonResponse(await getSecUserId(requireQ(request, "url")), { router: route });
  }
  if (method === "GET" && route === "get_webcast_id") {
    return jsonResponse(await getWebcastId(requireQ(request, "url")), { router: route });
  }
  if (method === "POST" && route === "get_all_aweme_id") {
    return jsonResponse(await mapUrls(request, getAwemeId), { router: route });
  }
  if (method === "POST" && route === "get_all_sec_user_id") {
    return jsonResponse(await mapUrls(request, getSecUserId), { router: route });
  }
  if (method === "POST" && route === "get_all_webcast_id") {
    return jsonResponse(await mapUrls(request, getWebcastId), { router: route });
  }
  throw new HTTPException(404, { message: `Unknown douyin/web route: ${route}` });
}
async function mapUrls(request, fn) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HTTPException(400, { message: "Body must be a JSON array of urls" });
  }
  const urls = Array.isArray(body) ? body : Array.isArray(body?.url) ? body.url : null;
  if (!urls) throw new HTTPException(400, { message: "Body must be a JSON array of urls" });
  const valid = urls.map(extractValidUrl).filter(Boolean);
  return Promise.all(valid.map((u) => fn(u)));
}

// src/tiktok/web/endpoints.js
var T = "https://www.tiktok.com";
var TikTokWebEndpoints = {
  USER_DETAIL: `${T}/api/user/detail/`,
  USER_POST: `${T}/api/post/item_list/`,
  USER_LIKE: `${T}/api/favorite/item_list/`,
  USER_COLLECT: `${T}/api/user/collect/item_list/`,
  USER_PLAY_LIST: `${T}/api/user/playlist/`,
  USER_MIX: `${T}/api/mix/item_list/`,
  USER_FOLLOW: `${T}/api/user/list/`,
  USER_FANS: `${T}/api/user/list/`,
  POST_DETAIL: `${T}/api/item/detail/`,
  POST_COMMENT: `${T}/api/comment/list/`,
  POST_COMMENT_REPLY: `${T}/api/comment/list/reply/`
};
var TIKTOK_WEB_REFERER = "https://www.tiktok.com/";

// src/tiktok/web/crawler.js
var fakeMsToken = () => genRandomStr(146) + "==";
function baseParams(msToken) {
  return {
    WebIdLastTime: String(Math.floor(Date.now() / 1e3)),
    aid: "1988",
    app_language: "en",
    app_name: "tiktok_web",
    browser_language: "en-US",
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: "Win32",
    browser_version: "5.0%20%28Windows%29",
    channel: "tiktok_web",
    cookie_enabled: "true",
    device_id: "7380187414842836523",
    odinId: "7404669909585003563",
    device_platform: "web_pc",
    focus_state: "true",
    from_page: "user",
    history_len: "4",
    is_fullscreen: "false",
    is_page_visible: "true",
    language: "en",
    os: "windows",
    priority_region: "US",
    referer: "",
    region: "US",
    root_referer: "https%3A%2F%2Fwww.tiktok.com%2F",
    screen_height: "1080",
    screen_width: "1920",
    webcast_language: "en",
    tz_name: "America%2FTijuana",
    msToken
  };
}
function headers(ctx) {
  return buildHeaders({
    userAgent: ctx.config.tiktok.userAgent,
    referer: TIKTOK_WEB_REFERER,
    cookie: ctx.config.tiktok.cookie
  });
}
async function xbGet(ctx, baseUrl, params) {
  const paramStr = rawJoin(params);
  const { xBogus } = getXBogus(paramStr, ctx.config.tiktok.userAgent);
  const url = `${baseUrl}?${paramStr}&X-Bogus=${xBogus}`;
  return fetchGetJson(url, headers(ctx));
}
function fetchOneVideo3(ctx, itemId) {
  return xbGet(ctx, TikTokWebEndpoints.POST_DETAIL, { ...baseParams(fakeMsToken()), itemId });
}
function fetchUserProfile(ctx, secUid, uniqueId) {
  return xbGet(ctx, TikTokWebEndpoints.USER_DETAIL, { ...baseParams(fakeMsToken()), secUid, uniqueId });
}
function fetchUserLike(ctx, secUid, cursor, count, coverFormat) {
  return xbGet(ctx, TikTokWebEndpoints.USER_LIKE, {
    ...baseParams(fakeMsToken()),
    coverFormat: String(coverFormat),
    count: String(count),
    cursor: String(cursor),
    secUid
  });
}
function fetchUserMix(ctx, mixId, cursor, count) {
  return xbGet(ctx, TikTokWebEndpoints.USER_MIX, {
    ...baseParams(fakeMsToken()),
    count: String(count),
    cursor: String(cursor),
    mixId
  });
}
function fetchPostComment(ctx, awemeId, cursor, count, currentRegion) {
  return xbGet(ctx, TikTokWebEndpoints.POST_COMMENT, {
    ...baseParams(fakeMsToken()),
    aweme_id: awemeId,
    count: String(count),
    cursor: String(cursor),
    current_region: currentRegion
  });
}
function fetchPostCommentReply(ctx, itemId, commentId, cursor, count, currentRegion) {
  return xbGet(ctx, TikTokWebEndpoints.POST_COMMENT_REPLY, {
    ...baseParams(fakeMsToken()),
    item_id: itemId,
    comment_id: commentId,
    count: String(count),
    cursor: String(cursor),
    current_region: currentRegion
  });
}
function fetchUserFans(ctx, secUid, count, maxCursor, minCursor) {
  return xbGet(ctx, TikTokWebEndpoints.USER_FANS, {
    ...baseParams(fakeMsToken()),
    secUid,
    count: String(count),
    maxCursor: String(maxCursor),
    minCursor: String(minCursor),
    scene: "67"
  });
}
function fetchUserFollow(ctx, secUid, count, maxCursor, minCursor) {
  return xbGet(ctx, TikTokWebEndpoints.USER_FOLLOW, {
    ...baseParams(fakeMsToken()),
    secUid,
    count: String(count),
    maxCursor: String(maxCursor),
    minCursor: String(minCursor),
    scene: "21"
  });
}
function fetchUserPost(ctx, secUid, cursor, count, coverFormat) {
  const params = {
    WebIdLastTime: "1714385892",
    aid: "1988",
    app_language: "zh-Hans",
    app_name: "tiktok_web",
    browser_language: "zh-CN",
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: "Win32",
    browser_version: "5.0%20%28Windows%29",
    channel: "tiktok_web",
    cookie_enabled: "true",
    count: String(count),
    coverFormat: String(coverFormat),
    cursor: String(cursor),
    data_collection_enabled: "true",
    device_id: "7380187414842836523",
    device_platform: "web_pc",
    focus_state: "true",
    from_page: "user",
    history_len: "3",
    is_fullscreen: "false",
    is_page_visible: "true",
    language: "zh-Hans",
    locate_item_id: "",
    needPinnedItemIds: "true",
    odinId: "7404669909585003563",
    os: "windows",
    post_item_list_request_type: "0",
    priority_region: "US",
    referer: "",
    region: "US",
    screen_height: "827",
    screen_width: "1323",
    secUid,
    tz_name: "America%2FLos_Angeles",
    user_is_login: "true",
    webcast_language: "zh-Hans",
    msToken: "SXtP7K0MMFlQmzpuWfZoxAlAaKqt-2p8oAbOHFBw-k3TA2g4jE_FXrFKf3i38lR-xNh_bV1_qfTPRnj4PXbkBfrVD2iAazeUkASIASHT0pu-Bx2_POx7O3nBBHZe2SI7CPsanerdclxHht1hcoUTlg%3D%3D",
    _signature: "_02B4Z6wo000017oyWOQAAIDD9xNhTSnfaDu6MFxAAIlj23"
  };
  return xbGet(ctx, TikTokWebEndpoints.USER_POST, params);
}
function fetchUserPlayList(ctx, secUid, cursor, count) {
  return xbGet(ctx, TikTokWebEndpoints.USER_PLAY_LIST, {
    ...baseParams(fakeMsToken()),
    count: String(count),
    cursor: String(cursor),
    secUid
  });
}

// src/service/tiktok.js
var PLATFORM2 = "tiktok";
var q2 = (request, key, dflt = "") => new URL(request.url).searchParams.get(key) ?? dflt;
var requireQ2 = (request, key) => {
  const v = new URL(request.url).searchParams.get(key);
  if (v === null || v === "") throw new HTTPException(400, { message: `Missing query param: ${key}` });
  return v;
};
var fakeMsToken2 = () => genRandomStr(146) + "==";
async function resolveTiktokSecUid(rawUrl) {
  const url = extractValidUrl(rawUrl);
  if (!url) throw new HTTPException(400, { message: "Invalid URL" });
  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" }
  });
  const html = await resp.text();
  const m = html.match(/"secUid":"([^"]+)"/);
  if (!m) throw new HTTPException(404, { message: "secUid not found on page" });
  return m[1];
}
async function genTiktokTtwid(cookie) {
  try {
    const resp = await fetch("https://www.tiktok.com/ttwid/check/", {
      method: "POST",
      body: cookie || "",
      headers: { "content-type": "text/plain" }
    });
    const sc = resp.headers.get("set-cookie") || "";
    const m = sc.match(/ttwid=([^;]+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
async function tiktokWebService(route, request, ctx) {
  const method = request.method;
  if (method === "GET" && route === "fetch_one_video") {
    const itemId = requireQ2(request, "itemId");
    requireAuth2(request, ctx, PLATFORM2, route, itemId);
    return jsonResponse(await fetchOneVideo3(ctx, itemId), { router: route });
  }
  if (method === "GET" && route === "fetch_user_profile") {
    const secUid = q2(request, "secUid", "");
    const uniqueId = q2(request, "uniqueId", "");
    if (!secUid && !uniqueId) throw new HTTPException(400, { message: "Provide secUid or uniqueId" });
    requireAuth2(request, ctx, PLATFORM2, route, secUid || uniqueId);
    return jsonResponse(await fetchUserProfile(ctx, secUid, uniqueId), { router: route });
  }
  if (method === "GET" && route === "fetch_user_post") {
    const secUid = requireQ2(request, "secUid");
    requireAuth2(request, ctx, PLATFORM2, route, secUid);
    return jsonResponse(await fetchUserPost(ctx, secUid, q2(request, "cursor", "0"), q2(request, "count", "35"), q2(request, "coverFormat", "2")), { router: route });
  }
  if (method === "GET" && route === "fetch_user_like") {
    const secUid = requireQ2(request, "secUid");
    requireAuth2(request, ctx, PLATFORM2, route, secUid);
    return jsonResponse(await fetchUserLike(ctx, secUid, q2(request, "cursor", "0"), q2(request, "count", "35"), q2(request, "coverFormat", "2")), { router: route });
  }
  if (method === "GET" && route === "fetch_user_mix") {
    const mixId = requireQ2(request, "mixId");
    requireAuth2(request, ctx, PLATFORM2, route, mixId);
    return jsonResponse(await fetchUserMix(ctx, mixId, q2(request, "cursor", "0"), q2(request, "count", "30")), { router: route });
  }
  if (method === "GET" && route === "fetch_user_play_list") {
    const secUid = requireQ2(request, "secUid");
    requireAuth2(request, ctx, PLATFORM2, route, secUid);
    return jsonResponse(await fetchUserPlayList(ctx, secUid, q2(request, "cursor", "0"), q2(request, "count", "30")), { router: route });
  }
  if (method === "GET" && route === "fetch_post_comment") {
    const awemeId = requireQ2(request, "aweme_id");
    requireAuth2(request, ctx, PLATFORM2, route, awemeId);
    return jsonResponse(await fetchPostComment(ctx, awemeId, q2(request, "cursor", "0"), q2(request, "count", "20"), q2(request, "current_region", "")), { router: route });
  }
  if (method === "GET" && route === "fetch_post_comment_reply") {
    const itemId = requireQ2(request, "item_id");
    requireAuth2(request, ctx, PLATFORM2, route, itemId);
    return jsonResponse(await fetchPostCommentReply(ctx, itemId, requireQ2(request, "comment_id"), q2(request, "cursor", "0"), q2(request, "count", "20"), q2(request, "current_region", "")), { router: route });
  }
  if (method === "GET" && route === "fetch_user_fans") {
    const secUid = requireQ2(request, "secUid");
    requireAuth2(request, ctx, PLATFORM2, route, secUid);
    return jsonResponse(await fetchUserFans(ctx, secUid, q2(request, "count", "30"), q2(request, "maxCursor", "0"), q2(request, "minCursor", "0")), { router: route });
  }
  if (method === "GET" && route === "fetch_user_follow") {
    const secUid = requireQ2(request, "secUid");
    requireAuth2(request, ctx, PLATFORM2, route, secUid);
    return jsonResponse(await fetchUserFollow(ctx, secUid, q2(request, "count", "30"), q2(request, "maxCursor", "0"), q2(request, "minCursor", "0")), { router: route });
  }
  if (method === "GET" && route === "generate_real_msToken") {
    return jsonResponse({ msToken: fakeMsToken2() }, { router: route });
  }
  if (method === "GET" && route === "generate_ttwid") {
    return jsonResponse({ ttwid: await genTiktokTtwid(q2(request, "cookie", ctx.config.tiktok.cookie)) }, { router: route });
  }
  if (method === "GET" && route === "generate_xbogus") {
    const url = requireQ2(request, "url");
    const ua = q2(request, "user_agent", ctx.config.tiktok.userAgent);
    const r = getXBogus(url, ua);
    return jsonResponse({ url: r.params, x_bogus: r.xBogus, user_agent: ua }, { router: route });
  }
  if (method === "GET" && route === "get_aweme_id") {
    return jsonResponse(await getTiktokAwemeId(requireQ2(request, "url")), { router: route });
  }
  if (method === "GET" && route === "get_unique_id") {
    return jsonResponse(await getTiktokUniqueId(requireQ2(request, "url")), { router: route });
  }
  if (method === "GET" && route === "get_sec_user_id") {
    return jsonResponse(await resolveTiktokSecUid(requireQ2(request, "url")), { router: route });
  }
  if (method === "POST" && route === "get_all_aweme_id") {
    return jsonResponse(await mapUrls2(request, getTiktokAwemeId), { router: route });
  }
  if (method === "POST" && route === "get_all_unique_id") {
    return jsonResponse(await mapUrls2(request, getTiktokUniqueId), { router: route });
  }
  if (method === "POST" && route === "get_all_sec_user_id") {
    return jsonResponse(await mapUrls2(request, resolveTiktokSecUid), { router: route });
  }
  throw new HTTPException(404, { message: `Unknown tiktok/web route: ${route}` });
}
async function tiktokAppService(route, request, ctx) {
  if (request.method === "GET" && route === "fetch_one_video") {
    const awemeId = requireQ2(request, "aweme_id");
    requireAuth2(request, ctx, PLATFORM2, "app_fetch_one_video", awemeId);
    const refresh = ["1", "true", "yes", "on"].includes(String(q2(request, "refresh")).toLowerCase());
    const { data, cached } = await fetchTiktokAwemeCached(ctx, awemeId, refresh);
    return jsonResponse(data, { router: `app/${route}`, headers: { "x-cache": cached ? "hit" : "miss" } });
  }
  throw new HTTPException(404, { message: `Unknown tiktok/app route: ${route}` });
}
async function mapUrls2(request, fn) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HTTPException(400, { message: "Body must be a JSON array of urls" });
  }
  const urls = Array.isArray(body) ? body : Array.isArray(body?.url) ? body.url : null;
  if (!urls) throw new HTTPException(400, { message: "Body must be a JSON array of urls" });
  const valid = urls.map(extractValidUrl).filter(Boolean);
  return Promise.all(valid.map((u) => fn(u)));
}

// src/hybrid/crawler.js
var URL_TYPE = {
  0: "video",
  2: "image",
  4: "video",
  68: "image",
  // Douyin
  51: "video",
  55: "video",
  58: "video",
  61: "video",
  150: "image"
  // TikTok
};
function detectPlatform(url) {
  if (url.includes("douyin")) return "douyin";
  if (url.includes("tiktok")) return "tiktok";
  return null;
}
async function resolvePlatformId(url) {
  if (/\/proxy\?/.test(url) || /[?&]kind=/.test(url)) {
    throw new HTTPException(400, { message: "\u8FD9\u662F\u89E3\u6790\u7ED3\u679C\u94FE\u63A5\uFF0C\u8BF7\u7C98\u8D34\u6296\u97F3/TikTok \u7684\u539F\u59CB\u5206\u4EAB\u53E3\u4EE4" });
  }
  const platform = detectPlatform(url);
  if (platform === "douyin") return { platform, id: await getAwemeId(url) };
  if (platform === "tiktok") return { platform, id: await getTiktokAwemeId(url) };
  throw new HTTPException(400, { message: "Cannot determine platform (expected a douyin or tiktok URL)" });
}
async function fetchRawById(ctx, platform, id, refresh = false) {
  if (platform === "douyin") {
    const { data, cached } = await fetchDouyinDetailCached(ctx, id, refresh);
    const raw = data.aweme_detail;
    if (!raw) {
      const reason = data.filter_detail?.filter_reason || "";
      if (/vr|360/i.test(reason)) {
        throw new HTTPException(422, { message: "\u8FD9\u662F\u6296\u97F3 360\xB0/VR \u5168\u666F\u89C6\u9891\uFF0C\u6296\u97F3\u4EC5\u5141\u8BB8\u5728 App \u5185\u89C2\u770B\uFF0C\u7F51\u9875 / \u5206\u4EAB\u63A5\u53E3\u5747\u4E0D\u8FD4\u56DE\u5A92\u4F53\u5730\u5740\uFF0C\u6682\u65E0\u6CD5\u89E3\u6790\u3002" });
      }
      if (reason) {
        const notice = data.filter_detail?.notice || data.filter_detail?.detail_msg || "";
        throw new HTTPException(422, { message: `\u6296\u97F3\u62D2\u7EDD\u8FD4\u56DE\u8BE5\u4F5C\u54C1\uFF08${reason}${notice ? "\uFF1A" + notice : ""}\uFF09` });
      }
      throw new HTTPException(502, { message: "Douyin returned no aweme_detail (bad cookie/signature?)" });
    }
    return { raw, cached };
  }
  if (platform === "tiktok") {
    const { data, cached } = await fetchTiktokAwemeCached(ctx, id, refresh);
    return { raw: data, cached };
  }
  throw new HTTPException(400, { message: `Unknown platform: ${platform}` });
}
function toMinimal(platform, videoId, data) {
  const type = URL_TYPE[data.aweme_type] || "video";
  const result = {
    type,
    platform,
    video_id: videoId,
    desc: data.desc,
    create_time: data.create_time,
    author: data.author,
    music: data.music,
    statistics: data.statistics,
    cover_data: {
      cover: data.video?.cover,
      origin_cover: data.video?.origin_cover,
      dynamic_cover: data.video?.dynamic_cover
    },
    hashtags: data.text_extra
  };
  if (platform === "douyin") {
    if (type === "video") {
      const uri = data.video.play_addr.uri;
      const wmHQ = data.video.play_addr.url_list[0];
      result.video_data = {
        wm_video_url: `https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${uri}&radio=1080p&line=0`,
        wm_video_url_HQ: wmHQ,
        nwm_video_url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`,
        nwm_video_url_HQ: wmHQ.replace("playwm", "play")
      };
    } else {
      const nwm = [];
      const wm = [];
      for (const i of data.images) {
        nwm.push(i.url_list[0]);
        wm.push(i.download_url_list[0]);
      }
      result.image_data = { no_watermark_image_list: nwm, watermark_image_list: wm };
    }
  } else {
    if (type === "video") {
      const wm = data.video?.download_addr?.url_list?.[0] ?? null;
      result.video_data = {
        wm_video_url: wm,
        wm_video_url_HQ: wm,
        nwm_video_url: data.video.play_addr.url_list[0],
        nwm_video_url_HQ: data.video.bit_rate[0].play_addr.url_list[0]
      };
    } else {
      const nwm = [];
      const wm = [];
      for (const i of data.image_post_info.images) {
        nwm.push(i.display_image.url_list[0]);
        wm.push(i.owner_watermark_image.url_list[0]);
      }
      result.image_data = { no_watermark_image_list: nwm, watermark_image_list: wm };
    }
  }
  return result;
}
async function hybridParseSingleVideo(ctx, url, minimal = false, refresh = false) {
  const { platform, id } = await resolvePlatformId(url);
  const { raw } = await fetchRawById(ctx, platform, id, refresh);
  if (!minimal) return raw;
  return toMinimal(platform, id, raw);
}
function mediaCandidates(platform, raw, kind) {
  const out = [];
  const push = (arr) => {
    if (Array.isArray(arr)) {
      for (const u of arr) if (typeof u === "string" && u) out.push(u);
    }
  };
  const video = raw.video || {};
  if (kind === "nwm") {
    push(video.play_addr?.url_list);
    if (Array.isArray(video.bit_rate)) for (const b of video.bit_rate) push(b?.play_addr?.url_list);
    const uri = video.play_addr?.uri;
    if (uri) out.push(`https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`);
  } else if (kind === "wm") {
    push(video.download_addr?.url_list);
    push(video.play_addr?.url_list);
  } else if (kind === "cover") {
    push(video.cover?.url_list);
    push(video.origin_cover?.url_list);
    if (platform === "douyin") push(raw.images?.[0]?.url_list);
    else push(raw.image_post_info?.images?.[0]?.display_image?.url_list);
  } else if (kind === "avatar") {
    push(raw.author?.avatar_larger?.url_list);
    push(raw.author?.avatar_thumb?.url_list);
  } else if (/^image(wm)?\d+$/.test(kind)) {
    const wm = kind.startsWith("imagewm");
    const idx = Number(kind.replace(/^image(wm)?/, ""));
    if (platform === "douyin") {
      const im = raw.images?.[idx];
      push(wm ? im?.download_url_list : im?.url_list);
    } else {
      const im = raw.image_post_info?.images?.[idx];
      push(wm ? im?.owner_watermark_image?.url_list : im?.display_image?.url_list);
    }
  }
  return [...new Set(out.map((u) => u.replace(/^http:/, "https:")))];
}

// src/utils/proxy-link.js
function proxyBase(request, ctx) {
  const u = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("x-forwarded-host") || u.host;
  return `${proto}://${host}${ctx.config.http.prefix}`;
}
function imgProxyLink(request, ctx, srcUrl) {
  if (!srcUrl) return null;
  const params = new URLSearchParams({ u: srcUrl, auth: sign(`img${srcUrl}`, ctx.config.auth.token) });
  return `${proxyBase(request, ctx)}/img?${params.toString()}`;
}
function proxyLink(request, ctx, platform, id, kind, expSec) {
  const secret = ctx.config.auth.token;
  const params = new URLSearchParams({ platform, id: String(id), kind });
  if (expSec) {
    const exp = Math.floor(Date.now() / 1e3) + expSec;
    params.set("exp", String(exp));
    params.set("auth", sign(`${canonical("proxy", platform, id)}${exp}`, secret));
  } else {
    params.set("auth", sign(canonical("proxy", platform, id), secret));
  }
  return `${proxyBase(request, ctx)}/proxy?${params.toString()}`;
}
function rewriteMinimalToProxy(minimal, request, ctx, expSec) {
  const { platform, video_id: id } = minimal;
  const L = (kind) => proxyLink(request, ctx, platform, id, kind, expSec);
  if (minimal.video_data) {
    const nwm = L("nwm");
    const wm = L("wm");
    minimal.video_data = {
      ...minimal.video_data,
      nwm_video_url: nwm,
      nwm_video_url_HQ: nwm,
      wm_video_url: wm,
      wm_video_url_HQ: wm
    };
  }
  if (minimal.image_data) {
    minimal.image_data = {
      no_watermark_image_list: minimal.image_data.no_watermark_image_list.map((_, i) => L(`image${i}`)),
      watermark_image_list: minimal.image_data.watermark_image_list.map((_, i) => L(`imagewm${i}`))
    };
  }
  if (minimal.cover_data) {
    minimal.cover_data = { ...minimal.cover_data, cover: L("cover") };
  }
  return minimal;
}

// src/utils/db.js
var schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    video_id TEXT NOT NULL,
    type TEXT,
    author TEXT,
    author_id TEXT,
    description TEXT,
    original_url TEXT,
    cover TEXT,
    play TEXT,
    duration INTEGER,
    create_time INTEGER,
    tags TEXT,
    music TEXT,
    parts TEXT,
    extra TEXT,
    hits INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(platform, video_id)
  )`).run();
  for (const col of ["duration INTEGER", "extra TEXT", "create_time INTEGER", "author_id TEXT", "tags TEXT", "music TEXT", "parts TEXT"]) {
    try {
      await db.prepare(`ALTER TABLE queries ADD COLUMN ${col}`).run();
    } catch {
    }
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS authors (
    platform TEXT NOT NULL, author_id TEXT NOT NULL, name TEXT, avatar TEXT,
    extra TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(platform, author_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
    video_id TEXT NOT NULL, ts INTEGER NOT NULL, stats TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS author_stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
    author_id TEXT NOT NULL, ts INTEGER NOT NULL, follower INTEGER, extra TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL,
    video_id TEXT NOT NULL, comment_id TEXT NOT NULL, parent_id TEXT,
    author TEXT, author_id TEXT, avatar TEXT, text TEXT, likes INTEGER,
    ctime INTEGER, fetched_at INTEGER NOT NULL, UNIQUE(platform, video_id, comment_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS kv_meta (
    k TEXT PRIMARY KEY, v TEXT, ts INTEGER NOT NULL
  )`).run();
  for (const sql of [
    "CREATE INDEX IF NOT EXISTS idx_stats_vid ON stats_history (platform, video_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_astats ON author_stats_history (platform, author_id, ts)",
    "CREATE INDEX IF NOT EXISTS idx_cmt ON comments (platform, video_id, likes)"
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
    }
  }
  schemaReady = true;
}
var COLS = "platform, video_id, type, author, author_id, description, original_url, cover, play, duration, create_time, tags, music, parts, extra, hits, created_at, updated_at";
var JSON_COLS = ["extra", "tags", "music", "parts"];
var parseRow = (r) => {
  if (!r) return r;
  for (const c of JSON_COLS) {
    if (typeof r[c] === "string") {
      try {
        r[c] = JSON.parse(r[c]);
      } catch {
        r[c] = null;
      }
    }
  }
  return r;
};
var j = (v) => v == null ? null : JSON.stringify(v);
async function metaGet(ctx, k) {
  const db = ctx.config.d1;
  if (!db) return null;
  try {
    await ensureSchema(db);
    const r = await db.prepare("SELECT v, ts FROM kv_meta WHERE k = ?").bind(k).all();
    return r?.results?.[0] || null;
  } catch {
    return null;
  }
}
async function metaSet(ctx, k, v) {
  const db = ctx.config.d1;
  if (!db) return;
  try {
    await ensureSchema(db);
    await db.prepare("INSERT INTO kv_meta (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = ?, ts = ?").bind(k, String(v ?? ""), Date.now(), String(v ?? ""), Date.now()).run();
  } catch {
  }
}
async function logQuery(ctx, row) {
  const db = ctx.config.d1;
  if (!db) return;
  try {
    await ensureSchema(db);
    const now = Date.now();
    const extra = j(row.extra);
    const tags = j(row.tags);
    const music = j(row.music);
    const parts = j(row.parts);
    const authorId = row.authorInfo?.id || null;
    await db.prepare(`INSERT INTO queries
      (platform, video_id, type, author, author_id, description, original_url, cover, play, duration, create_time, tags, music, parts, extra, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(platform, video_id) DO UPDATE SET
        hits = hits + 1, updated_at = ?, type = ?, author = ?, author_id = ?,
        description = ?, original_url = ?, cover = ?, play = ?, duration = ?, create_time = ?, tags = ?, music = ?, parts = ?, extra = ?`).bind(
      row.platform,
      row.video_id,
      row.type,
      row.author,
      authorId,
      row.description,
      row.original_url,
      row.cover,
      row.play,
      row.duration ?? null,
      row.create_time ?? null,
      tags,
      music,
      parts,
      extra,
      now,
      now,
      now,
      row.type,
      row.author,
      authorId,
      row.description,
      row.original_url,
      row.cover,
      row.play,
      row.duration ?? null,
      row.create_time ?? null,
      tags,
      music,
      parts,
      extra
    ).run();
    if (authorId) {
      const a = row.authorInfo;
      const aExtra = j(a.extra);
      await db.prepare(`INSERT INTO authors (platform, author_id, name, avatar, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, author_id) DO UPDATE SET name = ?, avatar = ?, extra = ?, updated_at = ?`).bind(row.platform, authorId, a.name ?? null, a.avatar ?? null, aExtra, now, a.name ?? null, a.avatar ?? null, aExtra, now).run();
      const follower = a.extra?.follower;
      if (follower != null) {
        const last = await db.prepare("SELECT ts, follower FROM author_stats_history WHERE platform = ? AND author_id = ? ORDER BY ts DESC LIMIT 1").bind(row.platform, authorId).all();
        const p = last?.results?.[0];
        if (!p || p.follower !== follower || now - p.ts > 216e5) {
          await db.prepare("INSERT INTO author_stats_history (platform, author_id, ts, follower) VALUES (?, ?, ?, ?)").bind(row.platform, authorId, now, follower).run();
        }
      }
    }
    if (row.stats && Object.keys(row.stats).length) {
      const statsStr = JSON.stringify(row.stats);
      const last = await db.prepare("SELECT ts, stats FROM stats_history WHERE platform = ? AND video_id = ? ORDER BY ts DESC LIMIT 1").bind(row.platform, row.video_id).all();
      const prev = last?.results?.[0];
      const fresh = prev && now - prev.ts < 3e5 && prev.stats === statsStr;
      if (!fresh) {
        await db.prepare("INSERT INTO stats_history (platform, video_id, ts, stats) VALUES (?, ?, ?, ?)").bind(row.platform, row.video_id, now, statsStr).run();
      }
    }
  } catch (e) {
    try {
      console.error("[d1] logQuery failed", e?.message || e);
    } catch {
    }
  }
}
async function pageQueries(ctx, where, binds, order, limit, offset) {
  const db = ctx.config.d1;
  if (!db) return { rows: [], total: 0 };
  try {
    await ensureSchema(db);
    const res = await db.prepare(`SELECT ${COLS} FROM queries ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all();
    const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM queries ${where}`).bind(...binds).all();
    return { rows: (res?.results || []).map(parseRow), total: cnt?.results?.[0]?.n || 0 };
  } catch (e) {
    try {
      console.error("[d1] pageQueries failed", e?.message || e);
    } catch {
    }
    return { rows: [], total: 0 };
  }
}
var recentQueries = (ctx, limit = 10, offset = 0) => pageQueries(ctx, "", [], "updated_at DESC", limit, offset);
var discoverQueries = (ctx, sort = "recent", limit = 12, offset = 0) => pageQueries(ctx, "", [], sort === "hot" ? "hits DESC, updated_at DESC" : "updated_at DESC", limit, offset);
function searchQueries(ctx, q3, platform, limit = 12, offset = 0) {
  const like = `%${String(q3 || "").trim()}%`;
  if (platform) return pageQueries(ctx, "WHERE platform = ? AND (description LIKE ? OR author LIKE ? OR tags LIKE ?)", [platform, like, like, like], "hits DESC, updated_at DESC", limit, offset);
  return pageQueries(ctx, "WHERE description LIKE ? OR author LIKE ? OR tags LIKE ?", [like, like, like], "hits DESC, updated_at DESC", limit, offset);
}
async function getWork(ctx, platform, videoId) {
  const db = ctx.config.d1;
  if (!db) return null;
  try {
    await ensureSchema(db);
    const q3 = await db.prepare(`SELECT ${COLS} FROM queries WHERE platform = ? AND video_id = ?`).bind(platform, videoId).all();
    const row = parseRow(q3?.results?.[0]);
    if (!row) return null;
    let author = null;
    if (row.author_id) {
      const a = await db.prepare("SELECT platform, author_id, name, avatar, extra, updated_at FROM authors WHERE platform = ? AND author_id = ?").bind(platform, row.author_id).all();
      author = parseRow(a?.results?.[0]) || null;
    }
    const h = await db.prepare("SELECT ts, stats FROM stats_history WHERE platform = ? AND video_id = ? ORDER BY ts ASC LIMIT 500").bind(platform, videoId).all();
    const history = (h?.results || []).map((r) => {
      let s = {};
      try {
        s = JSON.parse(r.stats);
      } catch {
      }
      return { ts: r.ts, stats: s };
    });
    return { work: row, author, history };
  } catch (e) {
    try {
      console.error("[d1] getWork failed", e?.message || e);
    } catch {
    }
    return null;
  }
}
async function getAuthor(ctx, platform, authorId, limit = 24, offset = 0) {
  const db = ctx.config.d1;
  if (!db) return null;
  try {
    await ensureSchema(db);
    const a = await db.prepare("SELECT platform, author_id, name, avatar, extra, updated_at FROM authors WHERE platform = ? AND author_id = ?").bind(platform, authorId).all();
    const author = parseRow(a?.results?.[0]);
    if (!author) return null;
    const works = await pageQueries(ctx, "WHERE platform = ? AND author_id = ?", [platform, authorId], "create_time DESC, updated_at DESC", limit, offset);
    const fh = await db.prepare("SELECT ts, follower FROM author_stats_history WHERE platform = ? AND author_id = ? ORDER BY ts ASC LIMIT 500").bind(platform, authorId).all();
    return { author, works: works.rows, total: works.total, follower_history: fh?.results || [] };
  } catch (e) {
    try {
      console.error("[d1] getAuthor failed", e?.message || e);
    } catch {
    }
    return null;
  }
}
async function storeComments(ctx, platform, videoId, comments) {
  const db = ctx.config.d1;
  if (!db || !comments?.length) return 0;
  try {
    await ensureSchema(db);
    const now = Date.now();
    let n = 0;
    for (const c of comments) {
      if (!c.comment_id) continue;
      try {
        await db.prepare(`INSERT INTO comments (platform, video_id, comment_id, parent_id, author, author_id, avatar, text, likes, ctime, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(platform, video_id, comment_id) DO UPDATE SET likes = ?, text = ?, fetched_at = ?`).bind(platform, videoId, String(c.comment_id), c.parent_id ?? null, c.author ?? null, c.author_id ?? null, c.avatar ?? null, c.text ?? null, c.likes ?? 0, c.ctime ?? null, now, c.likes ?? 0, c.text ?? null, now).run();
        n++;
      } catch {
      }
    }
    await metaSet(ctx, `cmt:${platform}:${videoId}`, now);
    return n;
  } catch (e) {
    try {
      console.error("[d1] storeComments failed", e?.message || e);
    } catch {
    }
    return 0;
  }
}
async function getComments(ctx, platform, videoId, limit = 20, offset = 0) {
  const db = ctx.config.d1;
  if (!db) return { rows: [], total: 0 };
  try {
    await ensureSchema(db);
    const r = await db.prepare("SELECT comment_id, parent_id, author, author_id, avatar, text, likes, ctime FROM comments WHERE platform = ? AND video_id = ? ORDER BY likes DESC, ctime DESC LIMIT ? OFFSET ?").bind(platform, videoId, limit, offset).all();
    const cnt = await db.prepare("SELECT COUNT(*) AS n FROM comments WHERE platform = ? AND video_id = ?").bind(platform, videoId).all();
    return { rows: r?.results || [], total: cnt?.results?.[0]?.n || 0 };
  } catch (e) {
    try {
      console.error("[d1] getComments failed", e?.message || e);
    } catch {
    }
    return { rows: [], total: 0 };
  }
}
async function rateLimitHit(ctx, ip, limit, windowSec) {
  if (ctx.config.kv) return rateLimitKV(ctx.config.kv, ip, limit, windowSec);
  if (ctx.config.d1) return rateLimitD1(ctx.config.d1, ip, limit, windowSec);
  return { allowed: false, reason: "no-store" };
}
async function rateLimitKV(kv, ip, limit, windowSec) {
  try {
    const nowSec = Math.floor(Date.now() / 1e3);
    const bucket = Math.floor(nowSec / windowSec);
    const key = `rl:${ip}:${bucket}`;
    let n = 0;
    try {
      const v = await kv.get(key);
      if (v) n = parseInt(v, 10) || 0;
    } catch {
    }
    n += 1;
    await kv.put(key, String(n), { expirationTtl: Math.max(60, windowSec) });
    return { allowed: n <= limit, count: n, limit, resetSec: (bucket + 1) * windowSec - nowSec };
  } catch (e) {
    try {
      console.error("[kv] rateLimitHit failed", e?.message || e);
    } catch {
    }
    return { allowed: false, reason: "error" };
  }
}
var rateSchemaReady = false;
async function rateLimitD1(db, ip, limit, windowSec) {
  try {
    if (!rateSchemaReady) {
      await db.prepare("CREATE TABLE IF NOT EXISTS rate (ip TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ip, bucket))").run();
      rateSchemaReady = true;
    }
    const nowSec = Math.floor(Date.now() / 1e3);
    const bucket = Math.floor(nowSec / windowSec);
    await db.prepare("INSERT INTO rate (ip, bucket, n) VALUES (?, ?, 1) ON CONFLICT(ip, bucket) DO UPDATE SET n = n + 1").bind(ip, bucket).run();
    const res = await db.prepare("SELECT n FROM rate WHERE ip = ? AND bucket = ?").bind(ip, bucket).all();
    const count = res?.results?.[0]?.n || 1;
    return { allowed: count <= limit, count, limit, resetSec: (bucket + 1) * windowSec - nowSec };
  } catch (e) {
    try {
      console.error("[d1] rateLimitHit failed", e?.message || e);
    } catch {
    }
    return { allowed: false, reason: "error" };
  }
}

// src/utils/ingest.js
function warmMedia(ctx, platform, id, raw, min, warmVideo) {
  const bucket = ctx.config.mediaR2;
  if (!bucket) return;
  const headers2 = {
    "User-Agent": platform === "douyin" ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: platform === "douyin" ? "https://www.douyin.com/" : "https://www.tiktok.com/"
  };
  const kinds = ["cover", "avatar"];
  if (min.type === "image" && min.image_data) {
    min.image_data.no_watermark_image_list.forEach((_, i) => kinds.push(`image${i}`));
  } else if (warmVideo) {
    kinds.push("nwm");
  }
  for (const kind of kinds) {
    const cands = mediaCandidates(platform, raw, kind);
    const ct = kind === "nwm" ? "video/mp4" : "image/jpeg";
    if (cands.length) warmUrl(ctx, bucket, mediaKey(platform, id, kind), cands[0], headers2, ct);
  }
}
async function ingestWork(ctx, request, platform, id, target, refresh = false, opts = {}) {
  const { raw, cached } = opts.raw ? { raw: opts.raw, cached: false } : await fetchRawById(ctx, platform, id, refresh);
  const min = toMinimal(platform, id, raw);
  const a = min.author || {};
  const s = min.statistics || {};
  await logQuery(ctx, {
    platform,
    video_id: id,
    type: min.type,
    author: a.nickname || null,
    authorInfo: a.sec_uid || a.uid ? {
      id: a.sec_uid || String(a.uid),
      name: a.nickname || null,
      avatar: proxyLink(request, ctx, platform, id, "avatar"),
      extra: { follower: a.follower_count, signature: a.signature, uid: a.uid, sec_uid: a.sec_uid }
    } : null,
    create_time: min.create_time || null,
    stats: {
      play: s.play_count,
      digg: s.digg_count,
      comment: s.comment_count,
      share: s.share_count,
      collect: s.collect_count
    },
    tags: Array.isArray(raw.text_extra) ? raw.text_extra.map((t) => t.hashtag_name).filter(Boolean) : null,
    music: raw.music ? { id: raw.music.id, title: raw.music.title, author: raw.music.author } : null,
    description: min.desc || null,
    original_url: target,
    cover: proxyLink(request, ctx, platform, id, "cover"),
    play: min.type === "video" ? proxyLink(request, ctx, platform, id, "nwm") : null,
    duration: raw.duration ? Math.round(raw.duration / 1e3) : null,
    extra: {
      stats: min.statistics || null,
      images: min.type === "image" && min.image_data ? min.image_data.no_watermark_image_list.map((_, i) => proxyLink(request, ctx, platform, id, `image${i}`)) : void 0
    }
  });
  warmMedia(ctx, platform, id, raw, min, opts.warmVideo !== false);
  return { raw, min, cached };
}

// src/utils/comments.js
var TTL = 6 * 3600 * 1e3;
function normalize(resp) {
  const list = resp?.comments || [];
  return list.map((c) => ({
    comment_id: c.cid,
    parent_id: null,
    text: c.text,
    author: c.user?.nickname || null,
    author_id: c.user?.sec_uid || (c.user?.uid != null ? String(c.user.uid) : null),
    avatar: c.user?.avatar_thumb?.url_list?.[0] || null,
    likes: c.digg_count ?? 0,
    ctime: c.create_time ?? null
  })).filter((c) => c.comment_id);
}
async function fetchRaw(ctx, platform, id, count) {
  if (platform === "tiktok") return fetchPostComment(ctx, id, 0, count, "");
  return fetchVideoComments(ctx, id, 0, count);
}
async function fetchAndStoreComments(ctx, platform, id, { count = 50 } = {}) {
  try {
    const resp = await fetchRaw(ctx, platform, id, count);
    return await storeComments(ctx, platform, id, normalize(resp));
  } catch (e) {
    try {
      console.error("[comments] fetch failed", platform, id, e?.message || e);
    } catch {
    }
    return 0;
  }
}
async function maybeFetchComments(ctx, platform, id) {
  const m = await metaGet(ctx, `cmt:${platform}:${id}`);
  if (m && Date.now() - m.ts < TTL) return 0;
  return fetchAndStoreComments(ctx, platform, id);
}

// src/service/hybrid.js
var PLATFORM3 = "hybrid";
var truthy2 = (v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
async function hybridService(route, request, ctx) {
  if (request.method === "GET" && route === "video_data") {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) throw new HTTPException(400, { message: "Missing query param: url" });
    const authed = isAuthorised(request, ctx, PLATFORM3, "video_data", target);
    let guest = false;
    if (!authed) {
      const g = ctx.config.guest;
      if (!g.enabled) {
        throw new HTTPException(401, { message: "Unauthorized: pass ?token=<secret>" });
      }
      const rl = await rateLimitHit(ctx, getClientIp(request), g.limit, g.windowSec);
      if (rl.reason === "no-store") {
        throw new HTTPException(503, { message: "\u6E38\u5BA2\u6A21\u5F0F\u9700\u8981 D1 \u624D\u80FD\u9650\u6D41\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u7ED1\u5B9A / guest mode needs a D1 binding" });
      }
      if (!rl.allowed) {
        return new Response(JSON.stringify({ code: 429, message: `\u6E38\u5BA2\u6BCF ${Math.round(g.windowSec / 60)} \u5206\u949F\u9650 ${g.limit} \u6B21\uFF0C\u8BF7 ${rl.resetSec}s \u540E\u518D\u8BD5\u6216\u586B\u5165\u8BBF\u95EE\u94A5\u5319` }), {
          status: 429,
          headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(rl.resetSec || g.windowSec) }
        });
      }
      guest = true;
    }
    const minimal = guest ? true : truthy2(url.searchParams.get("minimal") ?? "false");
    const proxy = guest ? true : truthy2(url.searchParams.get("proxy") ?? "false");
    const refresh = guest ? false : truthy2(url.searchParams.get("refresh") ?? "false");
    const linkTtl = guest ? ctx.config.guest.linkTtlSec : void 0;
    const { platform, id } = await resolvePlatformId(target);
    const { raw, min } = await ingestWork(ctx, request, platform, id, target, refresh);
    if (ctx.waitUntil) ctx.waitUntil(maybeFetchComments(ctx, platform, id));
    let data = minimal ? min : raw;
    if (minimal && proxy) data = rewriteMinimalToProxy(data, request, ctx, linkTtl);
    return jsonResponse(data, { router: "hybrid/video_data", params: { url: target, minimal, proxy, guest } });
  }
  if (request.method === "POST" && route === "update_cookie") {
    throw new HTTPException(501, {
      message: "update_cookie is not supported in the worker \u2014 set DOUYIN_COOKIE / TIKTOK_COOKIE env bindings instead."
    });
  }
  throw new HTTPException(404, { message: `Unknown hybrid route: ${route}` });
}
async function downloadService(request, ctx) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) throw new HTTPException(400, { message: "Missing query param: url" });
  requireAuth(request, ctx, PLATFORM3, "download", target);
  const withWatermark = truthy2(url.searchParams.get("with_watermark") ?? "false");
  const data = await hybridParseSingleVideo(ctx, target, true);
  let fileUrl, ext;
  if (data.type === "video") {
    fileUrl = withWatermark ? data.video_data.wm_video_url_HQ || data.video_data.wm_video_url : data.video_data.nwm_video_url_HQ || data.video_data.nwm_video_url;
    ext = "mp4";
  } else {
    const list = withWatermark ? data.image_data.watermark_image_list : data.image_data.no_watermark_image_list;
    fileUrl = list[0];
    ext = "jpeg";
  }
  if (!fileUrl) throw new HTTPException(404, { message: "No downloadable URL found" });
  const upstream = await fetch(fileUrl, {
    headers: {
      "User-Agent": ctx.config.douyin.userAgent,
      Referer: data.platform === "douyin" ? "https://www.douyin.com/" : "https://www.tiktok.com/"
    }
  });
  if (!upstream.ok || !upstream.body) {
    throw new HTTPException(502, { message: `Failed to fetch media (${upstream.status})` });
  }
  const filename = `${data.platform}_${data.video_id}.${ext}`;
  const headers2 = new Headers();
  headers2.set("content-type", upstream.headers.get("content-type") || (ext === "mp4" ? "video/mp4" : "image/jpeg"));
  const len = upstream.headers.get("content-length");
  if (len) headers2.set("content-length", len);
  headers2.set("content-disposition", `attachment; filename="${filename}"`);
  return new Response(upstream.body, { status: 200, headers: headers2 });
}

// src/service/proxy.js
var BUFFER_CAP = 8 * 1024 * 1024;
var MIN_CACHE_BYTES = 1024;
var minSizeForKind = (kind) => kind === "nwm" || kind === "wm" ? 1e4 : 256;
var REFERER = { douyin: "https://www.douyin.com/", tiktok: "https://www.tiktok.com/" };
async function proxyService(request, ctx) {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") || "";
  const id = url.searchParams.get("id") || url.searchParams.get("aweme_id") || "";
  const kind = url.searchParams.get("kind") || "nwm";
  if (!["douyin", "tiktok"].includes(platform)) {
    throw new HTTPException(400, { message: "platform must be douyin or tiktok" });
  }
  if (!id) throw new HTTPException(400, { message: "Missing query param: id" });
  requireProxyAuth(request, ctx, platform, id);
  const refresh = ["1", "true", "yes"].includes(String(url.searchParams.get("refresh")).toLowerCase());
  const download = ["1", "true", "yes"].includes(String(url.searchParams.get("download")).toLowerCase());
  const bucket = ctx.config.mediaR2;
  const key = mediaKey(platform, id, kind);
  if (bucket && !refresh) {
    const hit = await serveFromR2(bucket, request, key, void 0, minSizeForKind(kind));
    if (hit) return withDisposition(hit, download, platform, id, kind);
  }
  const isVideo = kind === "nwm" || kind === "wm";
  const contentType = isVideo ? "video/mp4" : "image/jpeg";
  const ext = isVideo ? "mp4" : "jpeg";
  const reqHeaders = {
    "User-Agent": platform === "douyin" ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: REFERER[platform]
  };
  const rangeHeader = request.headers.get("range");
  const probe = async (cands) => {
    for (const u of cands) {
      let r;
      try {
        r = await fetch(u, { headers: rangeHeader ? { ...reqHeaders, range: rangeHeader } : reqHeaders });
      } catch {
        continue;
      }
      if (looksLikeMedia(r, kind, !!rangeHeader)) return { upstream: r, usedUrl: u };
      try {
        await r.body?.cancel();
      } catch {
      }
    }
    return { upstream: null, usedUrl: null };
  };
  let { raw } = await fetchRawById(ctx, platform, id, refresh);
  let candidates = mediaCandidates(platform, raw, kind);
  if (!candidates.length && refresh) throw new HTTPException(404, { message: `No media url for kind=${kind}` });
  let { upstream, usedUrl } = candidates.length ? await probe(candidates) : { upstream: null, usedUrl: null };
  if (!upstream && !refresh) {
    ;
    ({ raw } = await fetchRawById(ctx, platform, id, true));
    candidates = mediaCandidates(platform, raw, kind);
    if (!candidates.length) throw new HTTPException(404, { message: `No media url for kind=${kind}` });
    ({ upstream, usedUrl } = await probe(candidates));
  }
  if (!upstream) {
    throw new HTTPException(502, { message: `All ${candidates.length} candidate url(s) failed for kind=${kind}` });
  }
  const openFromZero = /^bytes=0-$/.test((rangeHeader || "").trim());
  if (rangeHeader && !openFromZero) {
    if (bucket) warmUrl(ctx, bucket, key, usedUrl, reqHeaders, contentType);
    return withDisposition(wrapMedia(upstream, contentType, "upstream-range"), download, platform, id, kind, ext);
  }
  if (openFromZero) {
    try {
      await upstream.body?.cancel();
    } catch {
    }
    try {
      upstream = await fetch(usedUrl, { headers: reqHeaders });
    } catch {
      upstream = null;
    }
    if (!upstream || !looksLikeMedia(upstream, kind, false)) {
      throw new HTTPException(502, { message: `re-fetch failed for kind=${kind}` });
    }
  }
  if (!bucket) {
    return withDisposition(wrapMedia(upstream, contentType, "upstream-plain"), download, platform, id, kind, ext);
  }
  const cl = Number(upstream.headers.get("content-length") || 0);
  if (cl > BUFFER_CAP) {
    return withDisposition(teeIntoCache(bucket, ctx, key, upstream, contentType), download, platform, id, kind, ext);
  }
  const buf = await upstream.arrayBuffer();
  const size = buf.byteLength;
  if (size >= MIN_CACHE_BYTES && ctx?.waitUntil) {
    ctx.waitUntil(r2PutRetry(bucket, key, () => new Response(buf).body, { httpMetadata: { contentType } }, 2));
  }
  const out = new Headers({
    "content-type": contentType,
    "content-length": String(size),
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=300",
    "x-cache-source": "upstream-buffer"
  });
  return withDisposition(new Response(buf, { status: 200, headers: out }), download, platform, id, kind, ext);
}
function looksLikeMedia(resp, kind, isRange) {
  if (!resp.ok || !resp.body) return false;
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/json") || ct.includes("text/xml") || ct.includes("text/plain")) return false;
  if (!isRange) {
    const len = Number(resp.headers.get("content-length") || 0);
    if (len && len < minSizeForKind(kind)) return false;
  }
  return true;
}
function wrapMedia(upstream, contentType, source) {
  const out = new Headers();
  out.set("content-type", upstream.headers.get("content-type") || contentType || "application/octet-stream");
  const cl = upstream.headers.get("content-length");
  if (cl) out.set("content-length", cl);
  const cr = upstream.headers.get("content-range");
  if (cr) out.set("content-range", cr);
  out.set("accept-ranges", upstream.headers.get("accept-ranges") || "bytes");
  out.set("cache-control", "public, max-age=300");
  out.set("x-cache-source", source);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
function withDisposition(resp, download, platform, id, kind, ext) {
  if (!download) return resp;
  const headers2 = new Headers(resp.headers);
  const e = ext || (kind === "cover" || kind.startsWith("image") ? "jpeg" : "mp4");
  headers2.set("content-disposition", `attachment; filename="${platform}_${id}_${kind}.${e}"`);
  return new Response(resp.body, { status: resp.status, headers: headers2 });
}

// src/service/admin.js
async function adminRecentService(request, ctx) {
  const url = new URL(request.url);
  if ((url.searchParams.get("token") || "") !== ctx.config.auth.token) {
    throw new HTTPException(401, { message: "token required" });
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 10));
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const { rows, total } = await recentQueries(ctx, limit, (page - 1) * limit);
  return rawJsonResponse({ code: 200, page, limit, total, pages: Math.ceil(total / limit) || 1, count: rows.length, data: rows });
}
async function adminPageService(request, ctx) {
  return new Response(ADMIN_HTML, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
var ADMIN_HTML = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>\u6863\u6848 \xB7 \u8FD1\u671F\u89E3\u7801</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 8px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(34px,9vw,60px);line-height:.95;margin:0;letter-spacing:.04em}
.bar{display:flex;gap:10px;align-items:center;margin:22px 0 18px;flex-wrap:wrap}
.bar input{flex:1;min-width:180px;background:var(--panel);border:1px solid var(--line);color:var(--ink);font-family:var(--mono);font-size:13px;padding:10px 13px;border-radius:9px}
.bar a,.bar button{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-decoration:none;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);padding:10px 14px;border-radius:8px}
.bar a:hover,.bar button:hover{border-color:var(--teal);color:var(--teal)}
input:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:0 2px 16px;min-height:1.3em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.item{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.thumb{flex:0 0 64px;width:64px;height:96px;border-radius:8px;object-fit:cover;background:#0e0d12;border:1px solid var(--line)}
.info{min-width:0;display:flex;flex-direction:column;gap:4px}
.info .top{display:flex;gap:8px;align-items:center}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--teal);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.who{font-family:var(--serif);font-size:15px}
.dsc{color:var(--muted);font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row{margin-top:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:11px;color:var(--faint)}
.row a{color:var(--muted);text-decoration:none}
.row a:hover{color:var(--teal)}
.pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:20px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pager button{font-family:var(--mono);font-size:12px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 14px;border-radius:8px}
.pager button:hover:not(:disabled){border-color:var(--teal);color:var(--teal)}
.pager button:disabled{opacity:.35;cursor:default}
footer{margin-top:30px;font-family:var(--mono);font-size:11px;color:var(--faint)}
footer a{color:var(--muted)}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN \xB7 TIKTOK \u6863\u6848</p>
  <h1>\u8FD1\u671F\u89E3\u7801</h1>
  <div class=bar>
    <input id=key type=password autocomplete=off placeholder="\u8BBF\u95EE\u5BC6\u94A5 (API Token)">
    <button id=refresh>\u5237\u65B0</button>
    <a href="/">\u2190 \u89E3\u6790\u53F0</a>
  </div>
  <p id=status class=status>\u8F93\u5165\u5BC6\u94A5\u540E\u81EA\u52A8\u52A0\u8F7D</p>
  <div id=grid class=grid></div>
  <div id=pager class=pager></div>
  <footer>\u81EA\u6258\u7BA1\u4E8E RandallFlare \xB7 \u6BCF\u9875 10 \u6761 \xB7 \u91CD\u590D\u89E3\u6790\u5408\u5E76\u8BA1\u6B21</footer>
</main>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var KEY='dt_key'
  var keyInput=$('#key'),statusEl=$('#status'),grid=$('#grid'),pager=$('#pager')
  try{var k=localStorage.getItem(KEY);if(k)keyInput.value=k}catch(e){}
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function ago(ms){var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+'\u79D2\u524D';if(s<3600)return Math.floor(s/60)+'\u5206\u524D';if(s<86400)return Math.floor(s/3600)+'\u65F6\u524D';return Math.floor(s/86400)+'\u5929\u524D'}
  async function load(page){
    page=page||1
    var key=(keyInput.value||'').trim()
    if(!key){statusEl.textContent='\u5148\u586B\u8BBF\u95EE\u5BC6\u94A5';return}
    try{localStorage.setItem(KEY,key)}catch(e){}
    statusEl.textContent='\u52A0\u8F7D\u4E2D\u2026';grid.innerHTML='';pager.innerHTML=''
    try{
      var r=await fetch('/api/admin/recent?limit=10&page='+page+'&token='+encodeURIComponent(key))
      if(r.status!==200){statusEl.textContent='\u52A0\u8F7D\u5931\u8D25 HTTP '+r.status;return}
      var j=await r.json();var rows=j.data||[]
      statusEl.textContent=j.total?('\u5171 '+j.total+' \u6761 \xB7 \u7B2C '+j.page+'/'+j.pages+' \u9875'):'\u8FD8\u6CA1\u6709\u67E5\u8BE2\u8BB0\u5F55'
      rows.forEach(function(row){grid.appendChild(card(row))})
      renderPager(j.page,j.pages)
    }catch(e){statusEl.textContent='\u7F51\u7EDC\u9519\u8BEF\uFF1A'+e.message}
  }
  function renderPager(page,pages){
    if(!pages||pages<=1)return
    var prev=el('button',null,'\u2190 \u4E0A\u4E00\u9875');prev.disabled=page<=1;prev.addEventListener('click',function(){load(page-1)})
    var info=el('span',null,page+' / '+pages)
    var next=el('button',null,'\u4E0B\u4E00\u9875 \u2192');next.disabled=page>=pages;next.addEventListener('click',function(){load(page+1)})
    pager.appendChild(prev);pager.appendChild(info);pager.appendChild(next)
  }
  function card(row){
    var it=el('div','item')
    var im=el('img','thumb');im.loading='lazy';if(row.cover)im.src=row.cover;im.alt='';it.appendChild(im)
    var info=el('div','info')
    var top=el('div','top');top.appendChild(el('span','tag',(row.platform||'')+' \xB7 '+(row.type==='image'?'\u56FE\u96C6':'\u89C6\u9891')));info.appendChild(top)
    info.appendChild(el('div','who',row.author||'\u672A\u77E5\u4F5C\u8005'))
    if(row.description)info.appendChild(el('div','dsc',row.description))
    var rowEl=el('div','row')
    rowEl.appendChild(el('span',null,'\xD7'+(row.hits||1)+' \xB7 '+ago(row.updated_at)))
    var re=el('a',null,'\u91CD\u89E3');re.href='/?u='+encodeURIComponent(row.original_url||'');rowEl.appendChild(re)
    if(row.play){var p=el('a',null,'\u770B\u89C6\u9891');p.href=row.play;p.target='_blank';p.rel='noopener';rowEl.appendChild(p)}
    if(row.original_url){var o=el('a',null,'\u539F\u94FE');o.href=row.original_url;o.target='_blank';o.rel='noopener';rowEl.appendChild(o)}
    info.appendChild(rowEl)
    it.appendChild(info)
    return it
  }
  $('#refresh').addEventListener('click',function(){load(1)})
  keyInput.addEventListener('keydown',function(e){if(e.key==='Enter')load(1)})
  if(keyInput.value)load(1)
})();
</script>
</body>
</html>`;

// src/service/discover.js
async function discoverApiService(request, ctx) {
  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "hot" ? "hot" : "recent";
  const limit = Math.min(48, Math.max(1, Number(url.searchParams.get("limit")) || 12));
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const { rows, total } = await discoverQueries(ctx, sort, limit, (page - 1) * limit);
  return rawJsonResponse({ code: 200, sort, page, limit, total, pages: Math.ceil(total / limit) || 1, count: rows.length, data: rows });
}
async function discoverPageService(request, ctx) {
  return new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
var PAGE = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>\u53D1\u73B0 \xB7 \u6296\u97F3 / TikTok \u89E3\u6790</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 8px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(36px,9vw,64px);line-height:.95;margin:0;letter-spacing:.04em}
.sub{color:var(--muted);font-size:14px;margin:12px 0 0}
.bar{display:flex;gap:8px;align-items:center;margin:22px 0 18px;flex-wrap:wrap}
.tab{font-family:var(--mono);font-size:12px;letter-spacing:.1em;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--muted);padding:8px 16px;border-radius:999px}
.tab.on{border-color:var(--coral);color:var(--coral)}
.spacer{flex:1}
.bar a{font-family:var(--mono);font-size:11px;color:var(--faint);text-decoration:none}
.bar a:hover{color:var(--teal)}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:0 2px 16px;min-height:1.3em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px}
.card{display:block;text-decoration:none;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;transition:border-color .15s}
.card:hover{border-color:var(--teal)}
.thumb{position:relative;width:100%;aspect-ratio:3/4;background:#0e0d12;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;left:8px;top:8px;font-family:var(--mono);font-size:10px;letter-spacing:.08em;background:rgba(20,18,26,.8);color:var(--teal);padding:2px 7px;border-radius:5px;backdrop-filter:blur(4px)}
.hot{position:absolute;right:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(255,93,108,.9);color:#1a0c0f;font-weight:700;padding:2px 7px;border-radius:5px}
.datalink{position:absolute;right:8px;bottom:8px;font-size:13px;background:rgba(20,18,26,.8);padding:3px 7px;border-radius:6px;text-decoration:none;backdrop-filter:blur(4px)}
.datalink:hover{background:var(--teal)}
.info{padding:10px}
.who{font-family:var(--mono);font-size:11px;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ttl{font-size:13px;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.when{font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:6px}
.pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:24px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pager button{font-family:var(--mono);font-size:12px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 14px;border-radius:8px}
.pager button:disabled{opacity:.35;cursor:default}
.pager button:hover:not(:disabled){border-color:var(--teal);color:var(--teal)}
footer{margin-top:32px;font-family:var(--mono);font-size:11px;color:var(--faint)}
footer a{color:var(--muted)}
/* lightbox */
.lb{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(8,7,11,.92);backdrop-filter:blur(6px)}
.lb.on{display:flex}
.lb-stage{position:relative;max-width:min(1000px,94vw);max-height:90vh;display:flex;align-items:center;justify-content:center}
.lb-stage video,.lb-stage img{max-width:94vw;max-height:90vh;border-radius:10px;display:block;background:#000}
.lb-close{position:fixed;top:16px;right:18px;width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;font-size:20px;cursor:pointer;line-height:40px}
.lb-close:hover{background:var(--coral);color:#1a0c0f}
.lb-nav{position:fixed;top:50%;transform:translateY(-50%);width:48px;height:64px;border:0;border-radius:10px;background:rgba(255,255,255,.08);color:#fff;font-size:26px;cursor:pointer}
.lb-nav:hover{background:rgba(255,255,255,.18)}
.lb-prev{left:14px} .lb-next{right:14px}
.lb-idx{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:12px;color:#cdd6e2;background:rgba(8,7,11,.6);padding:4px 12px;border-radius:999px}
@media(max-width:560px){.lb-nav{width:40px;height:52px;font-size:20px}}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN \xB7 TIKTOK \u53D1\u73B0</p>
  <h1>\u5927\u5BB6\u5728\u89E3\u6790</h1>
  <p class=sub>\u6700\u8FD1\u88AB\u89E3\u6790\u7684\u4F5C\u54C1\uFF0C\u76F4\u63A5\u6765\u81EA\u7F13\u5B58\u2014\u2014\u70B9\u5F00\u5373\u770B\uFF0C\u4E0D\u518D\u6253\u6270\u539F\u7AD9\u3002</p>
  <div class=bar>
    <button class="tab on" data-sort=recent id=tabRecent>\u6700\u8FD1</button>
    <button class=tab data-sort=hot id=tabHot>\u70ED\u5EA6</button>
    <span class=spacer></span>
    <a href="/search">\u641C\u7D22</a>
    <a href="/">\u2190 \u53BB\u89E3\u6790</a>
  </div>
  <p id=status class=status>\u52A0\u8F7D\u4E2D\u2026</p>
  <div id=grid class=grid></div>
  <div id=pager class=pager></div>
  <footer>\u81EA\u6258\u7BA1\u4E8E RandallFlare \xB7 <a href="/">\u89E3\u6790\u53F0</a> \xB7 <a href="/docs">\u63A5\u53E3</a></footer>
</main>
<div id=lb class=lb>
  <button class=lb-close id=lbClose aria-label=\u5173\u95ED>\xD7</button>
  <button class="lb-nav lb-prev" id=lbPrev aria-label=\u4E0A\u4E00\u5F20>\u2039</button>
  <div class=lb-stage id=lbStage></div>
  <button class="lb-nav lb-next" id=lbNext aria-label=\u4E0B\u4E00\u5F20>\u203A</button>
  <div class=lb-idx id=lbIdx></div>
</div>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var grid=$('#grid'),statusEl=$('#status'),pager=$('#pager')
  var sort='recent',page=1
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function ago(ms){var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+'\u79D2\u524D';if(s<3600)return Math.floor(s/60)+'\u5206\u524D';if(s<86400)return Math.floor(s/3600)+'\u65F6\u524D';return Math.floor(s/86400)+'\u5929\u524D'}
  function dur(d){if(!d)return '';var m=Math.floor(d/60),s=d%60;return m+':'+(s<10?'0':'')+s}
  function card(row){
    var a=el('div','card');a.style.cursor='pointer';a.addEventListener('click',function(){openModal(row)})
    var th=el('div','thumb')
    if(row.cover){var im=el('img');im.loading='lazy';im.src=row.cover;im.alt='';th.appendChild(im)}
    th.appendChild(el('span','badge',(row.type==='image'?'\u56FE\u96C6':'\u89C6\u9891')))
    th.appendChild(el('span','hot','\u{1F525}'+(row.hits||1)))
    var dl=el('a','datalink','\u{1F4CA}');dl.href='/work?platform='+encodeURIComponent(row.platform)+'&id='+encodeURIComponent(row.video_id);dl.title='\u6570\u636E\u5206\u6790';dl.addEventListener('click',function(e){e.stopPropagation()});th.appendChild(dl)
    a.appendChild(th)
    var info=el('div','info')
    if(row.author_id){var wa=el('a','who',row.author||'\u672A\u77E5\u4F5C\u8005');wa.href='/author?platform='+encodeURIComponent(row.platform)+'&id='+encodeURIComponent(row.author_id);wa.style.textDecoration='none';wa.addEventListener('click',function(e){e.stopPropagation()});info.appendChild(wa)}
    else info.appendChild(el('div','who',row.author||'\u672A\u77E5\u4F5C\u8005'))
    info.appendChild(el('div','ttl',row.description||'(\u65E0\u6807\u9898)'))
    var d=dur(row.duration);info.appendChild(el('div','when',ago(row.updated_at)+(d?(' \xB7 '+d):'')))
    a.appendChild(info)
    return a
  }
  async function load(){
    statusEl.textContent='\u52A0\u8F7D\u4E2D\u2026';grid.innerHTML='';pager.innerHTML=''
    try{
      var r=await fetch('/api/discover?sort='+sort+'&page='+page+'&limit=12')
      var j=await r.json();var rows=j.data||[]
      statusEl.textContent=j.total?('\u5171 '+j.total+' \u6761 \xB7 \u7B2C '+j.page+'/'+j.pages+' \u9875'):'\u8FD8\u6CA1\u6709\u89E3\u6790\u8BB0\u5F55\uFF0C\u53BB\u89E3\u6790\u53F0\u8BD5\u8BD5'
      rows.forEach(function(row){grid.appendChild(card(row))})
      if(j.pages>1){
        var prev=el('button',null,'\u2190 \u4E0A\u4E00\u9875');prev.disabled=j.page<=1;prev.addEventListener('click',function(){page--;load()})
        var next=el('button',null,'\u4E0B\u4E00\u9875 \u2192');next.disabled=j.page>=j.pages;next.addEventListener('click',function(){page++;load()})
        pager.appendChild(prev);pager.appendChild(el('span',null,j.page+' / '+j.pages));pager.appendChild(next)
      }
    }catch(e){statusEl.textContent='\u52A0\u8F7D\u5931\u8D25\uFF1A'+e.message}
  }
  function setSort(s){if(sort===s)return;sort=s;page=1;$('#tabRecent').classList.toggle('on',s==='recent');$('#tabHot').classList.toggle('on',s==='hot');load()}
  $('#tabRecent').addEventListener('click',function(){setSort('recent')})
  $('#tabHot').addEventListener('click',function(){setSort('hot')})

  // lightbox
  var lb=$('#lb'),lbStage=$('#lbStage'),lbIdx=$('#lbIdx'),lbPrev=$('#lbPrev'),lbNext=$('#lbNext')
  var slides=[],cur=0
  function openModal(row){
    slides=[]
    if(row.play)slides=[{type:'video',url:row.play}]
    else if(row.extra&&row.extra.images&&row.extra.images.length)slides=row.extra.images.map(function(u){return{type:'image',url:u}})
    else if(row.cover)slides=[{type:'image',url:row.cover}]
    else{location.href='/?u='+encodeURIComponent(row.original_url||'');return}
    cur=0;renderSlide();lb.classList.add('on');document.body.style.overflow='hidden'
  }
  function renderSlide(){
    var s=slides[cur];lbStage.innerHTML=''
    if(s.type==='video'){var v=document.createElement('video');v.controls=true;v.autoplay=true;v.setAttribute('playsinline','');v.src=s.url;lbStage.appendChild(v)}
    else{var im=document.createElement('img');im.src=s.url;im.alt='';lbStage.appendChild(im)}
    var multi=slides.length>1
    lbPrev.style.display=multi?'':'none';lbNext.style.display=multi?'':'none'
    lbIdx.style.display=multi?'':'none';lbIdx.textContent=(cur+1)+' / '+slides.length
  }
  function go(d){if(slides.length<2)return;cur=(cur+d+slides.length)%slides.length;renderSlide()}
  function closeModal(){lb.classList.remove('on');lbStage.innerHTML='';document.body.style.overflow=''}
  lbPrev.addEventListener('click',function(e){e.stopPropagation();go(-1)})
  lbNext.addEventListener('click',function(e){e.stopPropagation();go(1)})
  $('#lbClose').addEventListener('click',closeModal)
  lb.addEventListener('click',function(e){if(e.target===lb)closeModal()})
  document.addEventListener('keydown',function(e){if(!lb.classList.contains('on'))return;if(e.key==='Escape')closeModal();else if(e.key==='ArrowLeft')go(-1);else if(e.key==='ArrowRight')go(1)})
  var tx=0
  lb.addEventListener('touchstart',function(e){tx=e.changedTouches[0].clientX},{passive:true})
  lb.addEventListener('touchend',function(e){var dx=e.changedTouches[0].clientX-tx;if(Math.abs(dx)>40)go(dx<0?1:-1)},{passive:true})

  load()
})();
</script>
</body>
</html>`;

// src/service/work.js
async function workApiService(request, ctx) {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") || "";
  const id = url.searchParams.get("id") || "";
  if (!platform || !id) throw new HTTPException(400, { message: "platform and id required" });
  const data = await getWork(ctx, platform, id);
  if (!data) throw new HTTPException(404, { message: "not found (parse it first)" });
  return rawJsonResponse({ code: 200, ...data });
}
async function workPageService(request, ctx) {
  return new Response(PAGE2, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
var PAGE2 = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>\u4F5C\u54C1\u6570\u636E\u5206\u6790</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1100px 560px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:840px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--coral);margin:0}
a.back{font-family:var(--mono);font-size:11px;color:var(--faint);text-decoration:none}
a.back:hover{color:var(--teal)}
.head{display:flex;gap:18px;margin:14px 0 0;flex-wrap:wrap}
.frame{flex:0 0 200px;width:200px;aspect-ratio:3/4;border-radius:10px;overflow:hidden;background:#0e0d12;border:1px solid var(--line)}
.frame img,.frame video{width:100%;height:100%;object-fit:cover;display:block}
.meta{flex:1;min-width:240px}
.title{font-family:var(--serif);font-size:22px;line-height:1.3;margin:0}
.author{display:flex;align-items:center;gap:10px;margin:12px 0}
.author img{width:38px;height:38px;border-radius:50%;object-fit:cover;background:#0e0d12;border:1px solid var(--line)}
.author .nm{font-size:15px} .author .fo{font-family:var(--mono);font-size:11px;color:var(--faint)}
.facts{font-family:var(--mono);font-size:12px;color:var(--muted);line-height:1.9}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 0}
.chip{font-family:var(--mono);font-size:11px;color:var(--teal);border:1px solid var(--line);border-radius:999px;padding:2px 9px;text-decoration:none}
.acts{margin-top:12px;display:flex;gap:9px;flex-wrap:wrap}
.btn{display:inline-block;text-decoration:none;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);font-family:var(--mono);font-size:12px;padding:8px 13px;border-radius:8px}
.btn.go{border-color:var(--coral);background:var(--coral);color:#1a0c0f;font-weight:700}
.btn:hover{border-color:var(--teal);color:var(--teal)}
.now{display:flex;gap:22px;flex-wrap:wrap;margin:26px 0 0}
.kpi{display:flex;flex-direction:column}
.kpi b{font-family:var(--mono);font-size:22px}
.kpi i{font-style:normal;font-size:11px;color:var(--faint);letter-spacing:.08em}
h2{font-size:15px;margin:34px 0 6px;font-family:var(--serif);letter-spacing:.04em}
.chartwrap{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;font-family:var(--mono);font-size:11px}
.legend span{display:flex;align-items:center;gap:6px;color:var(--muted)}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
svg{width:100%;height:220px;display:block}
.hint{font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:8px}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:20px 2px}
.cmts{display:flex;flex-direction:column;gap:12px;margin-top:8px}
.cmt{display:flex;gap:10px}
.cmt img{width:32px;height:32px;border-radius:50%;object-fit:cover;background:#0e0d12;border:1px solid var(--line);flex:0 0 32px}
.cmt .cb{min-width:0}
.cmt .ca{font-family:var(--mono);font-size:12px;color:var(--teal)}
.cmt .ct{font-size:14px;margin:2px 0;word-break:break-word}
.cmt .cm{font-family:var(--mono);font-size:11px;color:var(--faint)}
</style>
</head>
<body>
<main class=wrap>
  <div style="display:flex;justify-content:space-between;align-items:center">
    <p class=eyebrow>\u4F5C\u54C1\u6570\u636E\u5206\u6790</p>
    <a class=back href="/discover">\u2190 \u53D1\u73B0</a>
  </div>
  <div id=app><p class=status>\u52A0\u8F7D\u4E2D\u2026</p></div>
</main>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var q=new URLSearchParams(location.search)
  var platform=q.get('platform'),id=q.get('id')
  var COLORS={play:'#3fe0c5',digg:'#ff5d6c',comment:'#e7b15a',share:'#7aa2ff',collect:'#c08bff',danmaku:'#5bd6a8',coin:'#ffd166'}
  var LABELS={play:'\u64AD\u653E',digg:'\u70B9\u8D5E',comment:'\u8BC4\u8BBA',share:'\u8F6C\u53D1',collect:'\u6536\u85CF',danmaku:'\u5F39\u5E55',coin:'\u6295\u5E01'}
  var SERIES=['play','digg','comment','share','danmaku','coin','collect']
  function fmt(n){n=Number(n)||0;return n>=10000?(n/10000).toFixed(1)+'w':String(n)}
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function tstr(ms){if(!ms)return '\u2014';var d=new Date(ms);return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
  function datestr(sec){if(!sec)return '\u2014';return tstr(sec*1000).slice(0,10)}

  function lineChart(history){
    var allKeys=SERIES.filter(function(k){return history.some(function(h){return Number(h.stats&&h.stats[k])>0})})
    if(!allKeys.length)return '<div class=hint>\u6682\u65E0\u53EF\u7528\u6570\u636E</div>'
    // collapse consecutive snapshots with no change (drop duplicate/flat runs)
    var hist=[]
    history.forEach(function(h){var p=hist[hist.length-1];if(!p||allKeys.some(function(k){return Number(h.stats&&h.stats[k])!==Number(p.stats&&p.stats[k])}))hist.push(h)})
    // keep only metrics that actually move
    var keys=allKeys.filter(function(k){var vs=hist.map(function(h){return Number(h.stats&&h.stats[k])||0});return Math.min.apply(null,vs)!==Math.max.apply(null,vs)})
    if(hist.length<2||!keys.length)return '<div class=hint>\u6570\u636E\u6682\u65E0\u660E\u663E\u53D8\u5316\uFF08'+hist.length+' \u4E2A\u4E0D\u540C\u5FEB\u7167\uFF09\u3002\u7B49\u6570\u503C\u968F\u65F6\u95F4\u53D8\u5316\u540E\u4F1A\u51FA\u73B0\u8D8B\u52BF\u66F2\u7EBF\u3002</div>'
    var W=760,H=220,padL=8,padR=8,padT=14,padB=18,inner=H-padT-padB
    var n=hist.length
    var t0=hist[0].ts,tN=hist[n-1].ts,span=tN-t0
    var xs=function(i){return n<2?W/2:(span>0?padL+(W-padL-padR)*((hist[i].ts-t0)/span):padL+(W-padL-padR)*i/(n-1))}
    var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio=none>'
    svg+='<line x1='+padL+' y1='+(H-padB)+' x2='+(W-padR)+' y2='+(H-padB)+' stroke="#36313f" stroke-width=1 />'
    keys.forEach(function(k){
      var vals=hist.map(function(h){return Number(h.stats&&h.stats[k])||0})
      var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals)
      var ys=function(v){var t=mx===mn?0.5:(v-mn)/(mx-mn);return padT+inner*(1-t)}
      var d=''
      vals.forEach(function(v,i){d+=(i?'L':'M')+xs(i).toFixed(1)+' '+ys(v).toFixed(1)+' '})
      svg+='<path d="'+d+'" fill=none stroke="'+COLORS[k]+'" stroke-width=2 stroke-linejoin=round stroke-linecap=round />'
      vals.forEach(function(v,i){svg+='<circle cx='+xs(i).toFixed(1)+' cy='+ys(v).toFixed(1)+' r=2.5 fill="'+COLORS[k]+'" />'})
    })
    svg+='</svg>'
    var legend='<div class=legend>'+keys.map(function(k){return '<span><i style="background:'+COLORS[k]+'"></i>'+LABELS[k]+' '+fmt(hist[n-1].stats[k])+'</span>'}).join('')+'</div>'
    var axis='<div class=hint>'+tstr(hist[0].ts)+' \u2192 '+tstr(hist[n-1].ts)+' \xB7 '+n+' \u4E2A\u6709\u53D8\u5316\u7684\u6570\u636E\u70B9\uFF08\u6BCF\u6761\u7EBF\u6309\u5404\u81EA\u8303\u56F4\u7F29\u653E\uFF09</div>'
    return legend+svg+axis
  }

  async function load(){
    if(!platform||!id){$('#app').innerHTML='<p class=status>\u7F3A\u5C11 platform / id</p>';return}
    try{
      var r=await fetch('/api/work?platform='+encodeURIComponent(platform)+'&id='+encodeURIComponent(id))
      if(r.status!==200){var j=await r.json().catch(function(){return{}});$('#app').innerHTML='<p class=status>'+(j.message||('HTTP '+r.status))+'</p>';return}
      var d=await r.json();render(d)
    }catch(e){$('#app').innerHTML='<p class=status>\u52A0\u8F7D\u5931\u8D25\uFF1A'+e.message+'</p>'}
  }
  function render(d){
    var w=d.work||{},au=d.author||{},hist=d.history||[]
    var app=$('#app');app.innerHTML=''
    var head=el('div','head')
    var frame=el('div','frame')
    if(w.play){var v=document.createElement('video');v.controls=true;v.setAttribute('playsinline','');v.preload='metadata';if(w.cover)v.poster=w.cover;v.src=w.play;frame.appendChild(v)}
    else if(w.cover){var im=el('img');im.src=w.cover;frame.appendChild(im)}
    head.appendChild(frame)
    var meta=el('div','meta')
    meta.appendChild(el('div','title',w.description||'(\u65E0\u6807\u9898)'))
    var aex=au.extra||{}
    var ab=el('div','author')
    if(au.avatar){var av=el('img');av.src=au.avatar;ab.appendChild(av)}
    var ai=el('div')
    if(w.author_id){var na=el('a','nm',(au.name||w.author||'\u672A\u77E5\u4F5C\u8005'));na.href='/author?platform='+encodeURIComponent(w.platform)+'&id='+encodeURIComponent(w.author_id);na.style.color='var(--ink)';na.style.textDecoration='none';ai.appendChild(na)}
    else ai.appendChild(el('div','nm',(au.name||w.author||'\u672A\u77E5\u4F5C\u8005')))
    if(aex.follower!=null)ai.appendChild(el('div','fo','\u7C89\u4E1D '+fmt(aex.follower)))
    ab.appendChild(ai);meta.appendChild(ab)
    var facts=el('div','facts')
    facts.innerHTML='\u5E73\u53F0 '+w.platform+' \xB7 '+(w.type==='image'?'\u56FE\u96C6':'\u89C6\u9891')+'<br>\u53D1\u5E03 '+datestr(w.create_time)+(w.duration?(' \xB7 \u65F6\u957F '+w.duration+'s'):'')+'<br>\u89E3\u6790 '+w.hits+' \u6B21 \xB7 \u9996\u6B21 '+tstr(w.created_at)
    meta.appendChild(facts)
    if(w.music&&(w.music.title||w.music.author))meta.appendChild(el('div','facts','BGM \u266A '+[w.music.title,w.music.author].filter(Boolean).join(' - ')))
    if(Array.isArray(w.parts)&&w.parts.length>1)meta.appendChild(el('div','facts','\u5206P '+w.parts.length+' \u4E2A'))
    if(Array.isArray(w.tags)&&w.tags.length){var tg=el('div','chips');w.tags.slice(0,15).forEach(function(t){var c=el('a','chip','#'+t);c.href='/search?q='+encodeURIComponent(t);tg.appendChild(c)});meta.appendChild(tg)}
    var acts=el('div','acts')
    var go=el('a','btn go','\u91CD\u65B0\u89E3\u6790(\u52A0\u4E00\u4E2A\u6570\u636E\u70B9)');go.href='/?u='+encodeURIComponent(w.original_url||'');acts.appendChild(go)
    if(w.original_url){var o=el('a','btn','\u539F\u94FE');o.href=w.original_url;o.target='_blank';o.rel='noopener';acts.appendChild(o)}
    meta.appendChild(acts)
    head.appendChild(meta)
    app.appendChild(head)
    // current stats
    var cur=hist.length?hist[hist.length-1].stats:(w.extra&&w.extra.stats)||{}
    var now=el('div','now')
    ;SERIES.forEach(function(k){if(cur[k]!=null){var c=el('div','kpi');c.appendChild(el('b',null,fmt(cur[k])));c.appendChild(el('i',null,LABELS[k]));now.appendChild(c)}})
    if(now.children.length)app.appendChild(now)
    // chart
    app.appendChild(el('h2',null,'\u6570\u636E\u8D8B\u52BF'))
    var cw=el('div','chartwrap')
    if(hist.length<2){cw.innerHTML='<div class=hint>\u5DF2\u6709 '+hist.length+' \u4E2A\u6570\u636E\u70B9\u3002\u591A\u89E3\u6790\u51E0\u6B21\uFF08\u6216\u8FC7\u6BB5\u65F6\u95F4\u518D\u89E3\u6790\uFF09\u5373\u53EF\u5F62\u6210\u8D8B\u52BF\u66F2\u7EBF\u3002</div>'}
    else cw.innerHTML=lineChart(hist)
    app.appendChild(cw)
    // comments
    app.appendChild(el('h2',null,'\u70ED\u95E8\u8BC4\u8BBA'))
    var cm=el('div','cmts');cm.id='cmts';cm.appendChild(el('div','hint','\u52A0\u8F7D\u4E2D\u2026'));app.appendChild(cm)
    loadComments(w.platform,w.video_id)
  }
  async function loadComments(platform,id){
    var box=$('#cmts');if(!box)return
    try{
      var r=await fetch('/api/comments?platform='+encodeURIComponent(platform)+'&id='+encodeURIComponent(id)+'&limit=30')
      var j=await r.json();var rows=j.data||[]
      box.innerHTML=''
      if(!rows.length){box.appendChild(el('div','hint','\u6682\u65E0\u8BC4\u8BBA\uFF08\u6216\u6B63\u5728\u6293\u53D6\uFF0C\u7A0D\u540E\u5237\u65B0\uFF09'));return}
      rows.forEach(function(c){
        var it=el('div','cmt')
        if(c.avatar){var im=el('img');im.referrerPolicy='no-referrer';im.src=c.avatar;im.loading='lazy';it.appendChild(im)}
        var b=el('div','cb')
        b.appendChild(el('div','ca',c.author||'\u533F\u540D'))
        b.appendChild(el('div','ct',c.text||''))
        b.appendChild(el('div','cm','\u8D5E '+fmt(c.likes)+(c.ctime?(' \xB7 '+datestr(c.ctime)):'')))
        it.appendChild(b);box.appendChild(it)
      })
    }catch(e){box.innerHTML='<div class=hint>\u8BC4\u8BBA\u52A0\u8F7D\u5931\u8D25\uFF1A'+e.message+'</div>'}
  }
  load()
})();
</script>
</body>
</html>`;

// src/service/comments.js
async function commentsApiService(request, ctx) {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") || "";
  const id = url.searchParams.get("id") || "";
  if (!platform || !id) throw new HTTPException(400, { message: "platform and id required" });
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  let { rows, total } = await getComments(ctx, platform, id, limit, (page - 1) * limit);
  if (!total && page === 1) {
    const g = ctx.config.guest;
    const rl = await rateLimitHit(ctx, getClientIp(request), g.limit, g.windowSec);
    if (rl.allowed) {
      await maybeFetchComments(ctx, platform, id);
      ({ rows, total } = await getComments(ctx, platform, id, limit, 0));
    }
  }
  const data = rows.map((r) => ({ ...r, avatar: r.avatar ? imgProxyLink(request, ctx, r.avatar) : null }));
  return rawJsonResponse({ code: 200, platform, id, page, limit, total, count: data.length, data });
}

// src/service/search.js
async function searchApiService(request, ctx) {
  const url = new URL(request.url);
  const q3 = (url.searchParams.get("q") || "").trim();
  const platform = url.searchParams.get("platform") || "";
  const limit = Math.min(48, Math.max(1, Number(url.searchParams.get("limit")) || 12));
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  if (!q3) return rawJsonResponse({ code: 200, q: q3, page, total: 0, pages: 1, data: [] });
  const { rows, total } = await searchQueries(ctx, q3, platform || void 0, limit, (page - 1) * limit);
  return rawJsonResponse({ code: 200, q: q3, page, limit, total, pages: Math.ceil(total / limit) || 1, count: rows.length, data: rows });
}
async function searchPageService(request, ctx) {
  return new Response(PAGE3, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
var PAGE3 = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>\u641C\u7D22 \xB7 \u6296\u97F3 / TikTok \u89E3\u6790</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 8px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(34px,9vw,60px);line-height:.95;margin:0;letter-spacing:.04em}
.box{display:flex;gap:8px;margin:22px 0 18px}
.box input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--ink);font-size:15px;padding:12px 15px;border-radius:10px}
.box input:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.box button{border:1px solid var(--coral);background:var(--coral);color:#1a0c0f;font-family:var(--mono);font-weight:700;font-size:13px;padding:0 20px;border-radius:10px;cursor:pointer}
.bar a{font-family:var(--mono);font-size:11px;color:var(--faint);text-decoration:none;margin-right:14px}
.bar a:hover{color:var(--teal)}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:6px 2px 16px;min-height:1.3em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px}
.card{display:block;cursor:pointer;text-decoration:none;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.card:hover{border-color:var(--teal)}
.thumb{position:relative;width:100%;aspect-ratio:3/4;background:#0e0d12;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;left:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(20,18,26,.8);color:var(--teal);padding:2px 7px;border-radius:5px}
.hot{position:absolute;right:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(255,93,108,.9);color:#1a0c0f;font-weight:700;padding:2px 7px;border-radius:5px}
.datalink{position:absolute;right:8px;bottom:8px;font-size:13px;background:rgba(20,18,26,.8);padding:3px 7px;border-radius:6px;text-decoration:none}
.datalink:hover{background:var(--teal)}
.info{padding:10px}
.who{font-family:var(--mono);font-size:11px;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ttl{font-size:13px;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pager{display:flex;gap:10px;justify-content:center;margin-top:24px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pager button{font-family:var(--mono);font-size:12px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 14px;border-radius:8px}
.pager button:disabled{opacity:.35}
.lb{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(8,7,11,.92);backdrop-filter:blur(6px)}
.lb.on{display:flex}
.lb-stage{position:relative;max-width:min(1000px,94vw);max-height:90vh;display:flex;align-items:center;justify-content:center}
.lb-stage video,.lb-stage img{max-width:94vw;max-height:90vh;border-radius:10px;display:block;background:#000}
.lb-close{position:fixed;top:16px;right:18px;width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;font-size:20px;cursor:pointer}
.lb-nav{position:fixed;top:50%;transform:translateY(-50%);width:48px;height:64px;border:0;border-radius:10px;background:rgba(255,255,255,.08);color:#fff;font-size:26px;cursor:pointer}
.lb-prev{left:14px}.lb-next{right:14px}
.lb-idx{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:12px;color:#cdd6e2;background:rgba(8,7,11,.6);padding:4px 12px;border-radius:999px}
footer{margin-top:30px;font-family:var(--mono);font-size:11px;color:var(--faint)}
footer a{color:var(--muted)}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN \xB7 TIKTOK \u641C\u7D22</p>
  <h1>\u7AD9\u5185\u641C\u7D22</h1>
  <div class=box><input id=q placeholder="\u641C\u6807\u9898 / \u4F5C\u8005 / \u8BDD\u9898\u2026" autofocus><button id=go>\u641C\u7D22</button></div>
  <div class=bar><a href="/discover">\u53D1\u73B0</a><a href="/">\u89E3\u6790\u53F0</a></div>
  <p id=status class=status></p>
  <div id=grid class=grid></div>
  <div id=pager class=pager></div>
  <footer>\u81EA\u6258\u7BA1\u4E8E RandallFlare \xB7 \u4EC5\u641C\u7D22\u7AD9\u5185\u5DF2\u89E3\u6790\u7684\u5185\u5BB9</footer>
</main>
<div id=lb class=lb><button class=lb-close id=lbClose>\xD7</button><button class="lb-nav lb-prev" id=lbPrev>\u2039</button><div class=lb-stage id=lbStage></div><button class="lb-nav lb-next" id=lbNext>\u203A</button><div class=lb-idx id=lbIdx></div></div>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var grid=$('#grid'),statusEl=$('#status'),pager=$('#pager'),qIn=$('#q')
  var q='',page=1
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function card(row){
    var a=el('div','card');a.addEventListener('click',function(){openModal(row)})
    var th=el('div','thumb')
    if(row.cover){var im=el('img');im.loading='lazy';im.src=row.cover;th.appendChild(im)}
    th.appendChild(el('span','badge',row.type==='image'?'\u56FE\u96C6':'\u89C6\u9891'))
    th.appendChild(el('span','hot','\u{1F525}'+(row.hits||1)))
    var dl=el('a','datalink','\u{1F4CA}');dl.href='/work?platform='+encodeURIComponent(row.platform)+'&id='+encodeURIComponent(row.video_id);dl.addEventListener('click',function(e){e.stopPropagation()});th.appendChild(dl)
    a.appendChild(th)
    var info=el('div','info')
    if(row.author_id){var wa=el('a','who',row.author||'\u672A\u77E5\u4F5C\u8005');wa.href='/author?platform='+encodeURIComponent(row.platform)+'&id='+encodeURIComponent(row.author_id);wa.style.textDecoration='none';wa.addEventListener('click',function(e){e.stopPropagation()});info.appendChild(wa)}
    else info.appendChild(el('div','who',row.author||'\u672A\u77E5\u4F5C\u8005'))
    info.appendChild(el('div','ttl',row.description||'(\u65E0\u6807\u9898)'));a.appendChild(info)
    return a
  }
  async function run(p){
    page=p||1;q=(qIn.value||'').trim()
    if(!q){statusEl.textContent='\u8F93\u5165\u5173\u952E\u8BCD\u641C\u7D22';grid.innerHTML='';pager.innerHTML='';return}
    history.replaceState(null,'','/search?q='+encodeURIComponent(q))
    statusEl.textContent='\u641C\u7D22\u4E2D\u2026';grid.innerHTML='';pager.innerHTML=''
    try{
      var r=await fetch('/api/search?q='+encodeURIComponent(q)+'&page='+page+'&limit=12')
      var jj=await r.json();var rows=jj.data||[]
      statusEl.textContent=jj.total?('\u201C'+q+'\u201D \u5171 '+jj.total+' \u6761 \xB7 \u7B2C '+jj.page+'/'+jj.pages+' \u9875'):'\u6CA1\u641C\u5230\u201C'+q+'\u201D\uFF0C\u6362\u4E2A\u8BCD\u6216\u5148\u53BB\u89E3\u6790'
      rows.forEach(function(row){grid.appendChild(card(row))})
      if(jj.pages>1){var pv=el('button',null,'\u2190 \u4E0A\u4E00\u9875');pv.disabled=jj.page<=1;pv.addEventListener('click',function(){run(page-1)});var nx=el('button',null,'\u4E0B\u4E00\u9875 \u2192');nx.disabled=jj.page>=jj.pages;nx.addEventListener('click',function(){run(page+1)});pager.appendChild(pv);pager.appendChild(el('span',null,jj.page+' / '+jj.pages));pager.appendChild(nx)}
    }catch(e){statusEl.textContent='\u641C\u7D22\u5931\u8D25\uFF1A'+e.message}
  }
  $('#go').addEventListener('click',function(){run(1)})
  qIn.addEventListener('keydown',function(e){if(e.key==='Enter')run(1)})
  // lightbox (shared shape with discover)
  var lb=$('#lb'),lbStage=$('#lbStage'),lbIdx=$('#lbIdx'),lbPrev=$('#lbPrev'),lbNext=$('#lbNext'),slides=[],cur=0
  function openModal(row){slides=[];if(row.play)slides=[{type:'video',url:row.play}];else if(row.extra&&row.extra.images&&row.extra.images.length)slides=row.extra.images.map(function(u){return{type:'image',url:u}});else if(row.cover)slides=[{type:'image',url:row.cover}];else return;cur=0;rs();lb.classList.add('on');document.body.style.overflow='hidden'}
  function rs(){var s=slides[cur];lbStage.innerHTML='';if(s.type==='video'){var v=document.createElement('video');v.controls=true;v.setAttribute('playsinline','');v.autoplay=true;v.src=s.url;lbStage.appendChild(v)}else{var im=document.createElement('img');im.src=s.url;lbStage.appendChild(im)}var m=slides.length>1;lbPrev.style.display=m?'':'none';lbNext.style.display=m?'':'none';lbIdx.style.display=m?'':'none';lbIdx.textContent=(cur+1)+' / '+slides.length}
  function go(d){if(slides.length<2)return;cur=(cur+d+slides.length)%slides.length;rs()}
  function close(){lb.classList.remove('on');lbStage.innerHTML='';document.body.style.overflow=''}
  lbPrev.addEventListener('click',function(e){e.stopPropagation();go(-1)});lbNext.addEventListener('click',function(e){e.stopPropagation();go(1)})
  $('#lbClose').addEventListener('click',close);lb.addEventListener('click',function(e){if(e.target===lb)close()})
  document.addEventListener('keydown',function(e){if(!lb.classList.contains('on'))return;if(e.key==='Escape')close();else if(e.key==='ArrowLeft')go(-1);else if(e.key==='ArrowRight')go(1)})
  var tx=0;lb.addEventListener('touchstart',function(e){tx=e.changedTouches[0].clientX},{passive:true});lb.addEventListener('touchend',function(e){var dx=e.changedTouches[0].clientX-tx;if(Math.abs(dx)>40)go(dx<0?1:-1)},{passive:true})
  // init from ?q=
  var pre=new URLSearchParams(location.search).get('q');if(pre){qIn.value=pre;run(1)}
})();
</script>
</body>
</html>`;

// src/service/author.js
async function authorApiService(request, ctx) {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") || "";
  const id = url.searchParams.get("id") || "";
  if (!platform || !id) throw new HTTPException(400, { message: "platform and id required" });
  const limit = Math.min(48, Math.max(1, Number(url.searchParams.get("limit")) || 24));
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const data = await getAuthor(ctx, platform, id, limit, (page - 1) * limit);
  if (!data) throw new HTTPException(404, { message: "author not found (parse one of their works first)" });
  return rawJsonResponse({ code: 200, page, limit, pages: Math.ceil(data.total / limit) || 1, ...data });
}
async function authorPageService(request, ctx) {
  return new Response(PAGE4, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
var PAGE4 = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>\u4F5C\u8005\u4E3B\u9875</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1100px 560px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1000px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--coral);margin:0}
a.back{font-family:var(--mono);font-size:11px;color:var(--faint);text-decoration:none}
a.back:hover{color:var(--teal)}
.hd{display:flex;gap:18px;align-items:center;margin:16px 0 0;flex-wrap:wrap}
.hd .av{width:84px;height:84px;border-radius:50%;object-fit:cover;background:#0e0d12;border:1px solid var(--line);flex:0 0 84px}
.hd .nm{font-family:var(--serif);font-size:26px;margin:0}
.hd .sub{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:6px}
.hd .sig{font-size:13px;color:var(--muted);margin-top:8px;max-width:560px;white-space:pre-wrap}
.trend{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:22px}
.trend .cap{font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:8px}
svg{width:100%;height:170px;display:block}
h2{font-size:15px;margin:30px 0 12px;font-family:var(--serif);letter-spacing:.04em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px}
.card{display:block;cursor:pointer;text-decoration:none;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.card:hover{border-color:var(--teal)}
.thumb{position:relative;width:100%;aspect-ratio:3/4;background:#0e0d12;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;left:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(20,18,26,.8);color:var(--teal);padding:2px 7px;border-radius:5px}
.hot{position:absolute;right:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(255,93,108,.9);color:#1a0c0f;font-weight:700;padding:2px 7px;border-radius:5px}
.datalink{position:absolute;right:8px;bottom:8px;font-size:13px;background:rgba(20,18,26,.8);padding:3px 7px;border-radius:6px;text-decoration:none}
.datalink:hover{background:var(--teal)}
.info{padding:10px}
.who{font-family:var(--mono);font-size:11px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ttl{font-size:13px;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pager{display:flex;gap:10px;justify-content:center;margin-top:24px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pager button{font-family:var(--mono);font-size:12px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 14px;border-radius:8px}
.pager button:disabled{opacity:.35}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:20px 2px}
.lb{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(8,7,11,.92);backdrop-filter:blur(6px)}
.lb.on{display:flex}
.lb-stage{position:relative;max-width:min(1000px,94vw);max-height:90vh;display:flex;align-items:center;justify-content:center}
.lb-stage video,.lb-stage img{max-width:94vw;max-height:90vh;border-radius:10px;display:block;background:#000}
.lb-close{position:fixed;top:16px;right:18px;width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;font-size:20px;cursor:pointer}
.lb-nav{position:fixed;top:50%;transform:translateY(-50%);width:48px;height:64px;border:0;border-radius:10px;background:rgba(255,255,255,.08);color:#fff;font-size:26px;cursor:pointer}
.lb-prev{left:14px}.lb-next{right:14px}
.lb-idx{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);font-family:var(--mono);font-size:12px;color:#cdd6e2;background:rgba(8,7,11,.6);padding:4px 12px;border-radius:999px}
</style>
</head>
<body>
<main class=wrap>
  <div style="display:flex;justify-content:space-between;align-items:center">
    <p class=eyebrow>\u4F5C\u8005\u4E3B\u9875</p>
    <a class=back href="/discover">\u2190 \u53D1\u73B0</a>
  </div>
  <div id=app><p class=status>\u52A0\u8F7D\u4E2D\u2026</p></div>
</main>
<div id=lb class=lb><button class=lb-close id=lbClose>\xD7</button><button class="lb-nav lb-prev" id=lbPrev>\u2039</button><div class=lb-stage id=lbStage></div><button class="lb-nav lb-next" id=lbNext>\u203A</button><div class=lb-idx id=lbIdx></div></div>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var q=new URLSearchParams(location.search)
  var platform=q.get('platform'),id=q.get('id'),page=Math.max(1,Number(q.get('page'))||1)
  function fmt(n){n=Number(n)||0;return n>=10000?(n/10000).toFixed(1)+'w':String(n)}
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function tstr(ms){if(!ms)return '\u2014';var d=new Date(ms);return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
  function followerChart(fh){
    var vals=fh.map(function(p){return Number(p.follower)||0}),n=fh.length
    var W=760,H=150,padL=8,padR=8,padT=12,padB=18
    var mn=Math.min.apply(null,vals),mx=Math.max.apply(null,vals)
    var xs=function(i){return n<2?W/2:padL+(W-padL-padR)*i/(n-1)}
    var ys=function(v){var t=mx===mn?0.5:(v-mn)/(mx-mn);return padT+(H-padT-padB)*(1-t)}
    var d='';vals.forEach(function(v,i){d+=(i?'L':'M')+xs(i).toFixed(1)+' '+ys(v).toFixed(1)+' '})
    var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio=none>'
    svg+='<path d="'+d+'" fill=none stroke="#ff5d6c" stroke-width=2 stroke-linejoin=round />'
    vals.forEach(function(v,i){svg+='<circle cx='+xs(i).toFixed(1)+' cy='+ys(v).toFixed(1)+' r=2.5 fill="#ff5d6c"/>'})
    svg+='</svg>'
    return '<div class=cap>\u7C89\u4E1D\u8D8B\u52BF '+tstr(fh[0].ts)+' \u2192 '+tstr(fh[n-1].ts)+' \xB7 \u5F53\u524D '+fmt(vals[n-1])+'</div>'+svg
  }
  function card(row){
    var a=el('div','card');a.addEventListener('click',function(){openModal(row)})
    var th=el('div','thumb')
    if(row.cover){var im=el('img');im.loading='lazy';im.src=row.cover;th.appendChild(im)}
    th.appendChild(el('span','badge',row.type==='image'?'\u56FE\u96C6':'\u89C6\u9891'))
    th.appendChild(el('span','hot','\u{1F525}'+(row.hits||1)))
    var dl=el('a','datalink','\u{1F4CA}');dl.href='/work?platform='+encodeURIComponent(row.platform)+'&id='+encodeURIComponent(row.video_id);dl.addEventListener('click',function(e){e.stopPropagation()});th.appendChild(dl)
    a.appendChild(th)
    var info=el('div','info');info.appendChild(el('div','who',tstr((row.create_time||0)*1000)));info.appendChild(el('div','ttl',row.description||'(\u65E0\u6807\u9898)'));a.appendChild(info)
    return a
  }
  async function load(){
    if(!platform||!id){$('#app').innerHTML='<p class=status>\u7F3A\u5C11 platform / id</p>';return}
    try{
      var r=await fetch('/api/author?platform='+encodeURIComponent(platform)+'&id='+encodeURIComponent(id)+'&page='+page+'&limit=24')
      if(r.status!==200){var j=await r.json().catch(function(){return{}});$('#app').innerHTML='<p class=status>'+(j.message||('HTTP '+r.status))+'</p>';return}
      render(await r.json())
    }catch(e){$('#app').innerHTML='<p class=status>\u52A0\u8F7D\u5931\u8D25\uFF1A'+e.message+'</p>'}
  }
  function render(d){
    var au=d.author||{},ex=au.extra||{},works=d.works||[],fh=d.follower_history||[]
    var app=$('#app');app.innerHTML=''
    var hd=el('div','hd')
    if(au.avatar){var av=el('img','av');av.src=au.avatar;hd.appendChild(av)}
    var box=el('div')
    box.appendChild(el('div','nm',au.name||'\u672A\u77E5\u4F5C\u8005'))
    var sub='\u5E73\u53F0 '+platform+(ex.follower!=null?(' \xB7 \u7C89\u4E1D '+fmt(ex.follower)):'')+' \xB7 \u7AD9\u5185\u6536\u5F55 '+d.total+' \u4E2A\u4F5C\u54C1'
    box.appendChild(el('div','sub',sub))
    if(ex.signature)box.appendChild(el('div','sig',ex.signature))
    hd.appendChild(box);app.appendChild(hd)
    if(fh.length>=2){var tr=el('div','trend');tr.innerHTML=followerChart(fh);app.appendChild(tr)}
    app.appendChild(el('h2',null,'\u4F5C\u54C1 ('+d.total+')'))
    var grid=el('div','grid');works.forEach(function(w){grid.appendChild(card(w))});app.appendChild(grid)
    if(d.pages>1){var pg=el('div','pager')
      var pv=el('button',null,'\u2190 \u4E0A\u4E00\u9875');pv.disabled=page<=1;pv.addEventListener('click',function(){location.search='?platform='+encodeURIComponent(platform)+'&id='+encodeURIComponent(id)+'&page='+(page-1)})
      var nx=el('button',null,'\u4E0B\u4E00\u9875 \u2192');nx.disabled=page>=d.pages;nx.addEventListener('click',function(){location.search='?platform='+encodeURIComponent(platform)+'&id='+encodeURIComponent(id)+'&page='+(page+1)})
      pg.appendChild(pv);pg.appendChild(el('span',null,page+' / '+d.pages));pg.appendChild(nx);app.appendChild(pg)}
  }
  // lightbox
  var lb=$('#lb'),lbStage=$('#lbStage'),lbIdx=$('#lbIdx'),lbPrev=$('#lbPrev'),lbNext=$('#lbNext'),slides=[],cur=0
  function openModal(row){slides=[];if(row.play)slides=[{type:'video',url:row.play}];else if(row.extra&&row.extra.images&&row.extra.images.length)slides=row.extra.images.map(function(u){return{type:'image',url:u}});else if(row.cover)slides=[{type:'image',url:row.cover}];else return;cur=0;rs();lb.classList.add('on');document.body.style.overflow='hidden'}
  function rs(){var s=slides[cur];lbStage.innerHTML='';if(s.type==='video'){var v=document.createElement('video');v.controls=true;v.setAttribute('playsinline','');v.autoplay=true;v.src=s.url;lbStage.appendChild(v)}else{var im=document.createElement('img');im.src=s.url;lbStage.appendChild(im)}var m=slides.length>1;lbPrev.style.display=m?'':'none';lbNext.style.display=m?'':'none';lbIdx.style.display=m?'':'none';lbIdx.textContent=(cur+1)+' / '+slides.length}
  function go(dr){if(slides.length<2)return;cur=(cur+dr+slides.length)%slides.length;rs()}
  function close(){lb.classList.remove('on');lbStage.innerHTML='';document.body.style.overflow=''}
  lbPrev.addEventListener('click',function(e){e.stopPropagation();go(-1)});lbNext.addEventListener('click',function(e){e.stopPropagation();go(1)})
  $('#lbClose').addEventListener('click',close);lb.addEventListener('click',function(e){if(e.target===lb)close()})
  document.addEventListener('keydown',function(e){if(!lb.classList.contains('on'))return;if(e.key==='Escape')close();else if(e.key==='ArrowLeft')go(-1);else if(e.key==='ArrowRight')go(1)})
  var tx=0;lb.addEventListener('touchstart',function(e){tx=e.changedTouches[0].clientX},{passive:true});lb.addEventListener('touchend',function(e){var dx=e.changedTouches[0].clientX-tx;if(Math.abs(dx)>40)go(dx<0?1:-1)},{passive:true})
  load()
})();
</script>
</body>
</html>`;

// src/service/cron.js
var THROTTLE_MS = 50 * 1e3;
var TT_BATCH = 10;
var DY_KEYWORDS = 3;
var DY_PER_KEYWORD = 5;
async function cronService(request, ctx) {
  const url = new URL(request.url);
  const sync = url.searchParams.get("sync") === "1" && url.searchParams.get("token") === ctx.config.auth.token;
  const expr = request.headers.get("x-edge-cron-expression") || "default";
  const last = await metaGet(ctx, `cron:last:${expr}`);
  const now = Date.now();
  if (last && now - last.ts < THROTTLE_MS && !sync) {
    return json({ code: 200, skipped: "throttled", expr });
  }
  await metaSet(ctx, `cron:last:${expr}`, now);
  if (!ctx.config.d1) return json({ code: 200, skipped: "no-d1", expr });
  const run = (async () => {
    let tiktok = 0;
    let dy = 0;
    const errors = [];
    if (ctx.config.cron.tiktokHot || sync) try {
      const feed = await fetchTrendingFeed(ctx, TT_BATCH);
      for (const aweme of feed) {
        if (tiktok >= TT_BATCH) break;
        const id = aweme?.aweme_id;
        if (!id) continue;
        try {
          await ingestWork(ctx, request, "tiktok", id, `https://www.tiktok.com/@/video/${id}`, false, { raw: aweme });
          tiktok++;
        } catch (e) {
          errors.push(`tiktok ${id} ${e?.message || e}`);
        }
      }
    } catch (e) {
      errors.push(`tiktok-feed ${e?.message || e}`);
    }
    if (ctx.config.cron.douyinHot || sync) try {
      const hot = await fetchHotSearchList(ctx);
      const words = (hot?.data?.word_list || []).map((w) => w.word).filter(Boolean).slice(0, DY_KEYWORDS);
      for (const kw of words) {
        try {
          const sr = await fetchGeneralSearch(ctx, kw, 0, 10);
          if (sr?.status_code && sr.status_code !== 0) {
            errors.push(`search "${kw}" status_code ${sr.status_code} (risk control?)`);
            continue;
          }
          const arr = Array.isArray(sr?.data) ? sr.data : sr?.data?.data || [];
          const ids = arr.map((x) => x.aweme_info?.aweme_id || x.aweme?.aweme_id || x.aweme_id).filter(Boolean).slice(0, DY_PER_KEYWORD);
          for (const id of ids) {
            try {
              await ingestWork(ctx, request, "douyin", id, `https://www.douyin.com/video/${id}`, false);
              dy++;
            } catch (e) {
              errors.push(`douyin ${id} ${e?.message || e}`);
            }
          }
        } catch (e) {
          errors.push(`search "${kw}" ${e?.message || e}`);
        }
      }
    } catch (e) {
      errors.push(`douyin-hot ${e?.message || e}`);
    }
    await metaSet(ctx, `cron:hot:${expr}`, now);
    return { tiktok, douyin: dy, errors: errors.slice(0, 6) };
  })();
  if (ctx.waitUntil && !sync) {
    ctx.waitUntil(run);
    return json({ code: 200, expr, started: true, ttBatch: TT_BATCH, dyKeywords: DY_KEYWORDS });
  }
  return json({ code: 200, expr, ...await run });
}
function json(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

// src/service/img.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
var ALLOW = ["hdslb.com", "douyinpic.com", "pstatp.com", "byteimg.com", "ibyteimg.com", "bytecdn", "bytedance", "douyincdn", "bdxiguavod", "tiktokcdn", "ttwstatic"];
var MIN_BYTES = 256;
async function imgService(request, ctx) {
  const url = new URL(request.url);
  const u = url.searchParams.get("u") || "";
  const auth = url.searchParams.get("auth") || "";
  const token = url.searchParams.get("token") || "";
  const secret = ctx.config.auth.token;
  if (!u) throw new HTTPException(400, { message: "Missing query param: u" });
  if (token !== secret && auth !== sign(`img${u}`, secret)) {
    throw new HTTPException(401, { message: "img: bad auth" });
  }
  let host;
  try {
    host = new URL(u).hostname;
  } catch {
    throw new HTTPException(400, { message: "bad url" });
  }
  if (!ALLOW.some((h) => host.includes(h))) throw new HTTPException(403, { message: `host not allowed: ${host}` });
  const bucket = ctx.config.mediaR2;
  const key = `img/${sha1Hex(u)}`;
  if (bucket) {
    const hit = await serveFromR2(bucket, request, key, void 0, MIN_BYTES);
    if (hit) return hit;
  }
  const referer = host.includes("hdslb") ? "https://www.bilibili.com/" : host.includes("tiktokcdn") || host.includes("ttwstatic") ? "https://www.tiktok.com/" : "https://www.douyin.com/";
  let upstream;
  try {
    upstream = await fetch(u, { headers: { "User-Agent": UA, Referer: referer } });
  } catch (e) {
    throw new HTTPException(502, { message: `img fetch failed: ${e?.message || e}` });
  }
  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  if (!upstream.ok || !upstream.body || !ct.startsWith("image")) {
    try {
      await upstream.body?.cancel();
    } catch {
    }
    throw new HTTPException(502, { message: `img upstream not an image (${upstream.status})` });
  }
  const contentType = upstream.headers.get("content-type") || "image/jpeg";
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength >= MIN_BYTES && bucket && ctx?.waitUntil) {
    ctx.waitUntil(r2PutRetry(bucket, key, () => new Response(buf).body, { httpMetadata: { contentType } }, 2));
  }
  return new Response(buf, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(buf.byteLength),
      "cache-control": "public, max-age=86400",
      "x-cache-source": "upstream-buffer"
    }
  });
}

// src/service/app.js
async function appService(request, ctx) {
  return new Response(PAGE5, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
var PAGE5 = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>\u89E3\u6790\u53F0 \xB7 \u6296\u97F3\u65E0\u6C34\u5370</title>
<style>
:root{
  --bg:#15141b; --panel:#1d1b25; --panel2:#221f2a; --line:#36313f;
  --ink:#ece7db; --muted:#938da0; --faint:#615b6e;
  --coral:#ff5d6c; --teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:
    radial-gradient(1200px 600px at 50% -10%, #221f2c 0%, transparent 60%),
    var(--bg);
  color:var(--ink); font-family:var(--sans); line-height:1.55;
  min-height:100dvh; padding:max(20px,5vh) 18px 60px;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:760px;margin:0 auto}

/* header */
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 10px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(40px,11vw,76px);line-height:.95;margin:0;letter-spacing:.04em}
.sub{color:var(--muted);margin:14px 0 0;font-size:15px}

/* key (collapsed) */
.keyrow{display:flex;justify-content:flex-end;margin:20px 0 0}
.keylink{background:transparent;border:0;color:var(--faint);font-family:var(--mono);font-size:11px;letter-spacing:.22em;cursor:pointer;padding:4px 2px}
.keylink:hover{color:var(--teal)}
.keywrap{margin:10px 0 0}
.keywrap input{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--ink);font-family:var(--mono);font-size:13px;padding:11px 13px;border-radius:9px;letter-spacing:.04em}
input:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:1px;border-color:transparent}

/* drop slot \u2014 the signature */
.slot{position:relative;margin-top:14px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:0;overflow:hidden}
.slot::before{
  content:"\u53E3\u4EE4\u6295\u9012\u53E3";position:absolute;top:0;left:0;right:0;height:34px;line-height:34px;padding:0 14px;
  font-family:var(--mono);font-size:11px;letter-spacing:.22em;color:var(--muted);
  background:repeating-linear-gradient(45deg,var(--panel2),var(--panel2) 9px,#26222e 9px,#26222e 18px);
  border-bottom:1px dashed var(--line);
}
textarea{
  width:100%;min-height:128px;resize:vertical;border:0;background:transparent;color:var(--ink);
  font-family:var(--mono);font-size:14px;line-height:1.7;padding:46px 15px 56px;display:block;
}
textarea::placeholder{color:var(--faint)}
.slot .go{
  position:absolute;right:12px;bottom:12px;border:0;cursor:pointer;
  background:var(--coral);color:#1a0c0f;font-family:var(--mono);font-weight:700;font-size:13px;
  letter-spacing:.12em;padding:9px 18px;border-radius:8px;
}
.slot .go:active{transform:translateY(1px)}

/* status */
.status{font-family:var(--mono);font-size:12px;letter-spacing:.06em;color:var(--muted);margin:14px 2px;min-height:1.4em}
.status::before{content:"\u203A ";color:var(--faint)}
.status.load{color:var(--teal)} .status.ok{color:var(--teal)}
.status.err{color:var(--coral)} .status.warn{color:#e7b15a}

/* result */
#out{margin-top:6px}
.card{display:flex;gap:20px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
@media(max-width:560px){.card{flex-direction:column}}
.frame{position:relative;flex:0 0 200px;aspect-ratio:9/16;border-radius:10px;overflow:hidden;background:#0e0d12;border:1px solid var(--line)}
.frame img,.frame video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.badge{position:absolute;left:10px;top:10px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;background:rgba(20,18,26,.78);color:var(--teal);padding:3px 8px;border-radius:6px;backdrop-filter:blur(4px)}
.meta{flex:1;min-width:0;display:flex;flex-direction:column}
.nick{font-family:var(--serif);font-size:20px;letter-spacing:.02em}
.desc{color:var(--muted);font-size:14px;margin:8px 0 0;white-space:pre-wrap;word-break:break-word}
.stats{display:flex;gap:18px;margin:14px 0 0}
.stat{display:flex;flex-direction:column;line-height:1.2}
.stat b{font-family:var(--mono);font-size:16px} .stat i{font-style:normal;font-size:11px;color:var(--faint);letter-spacing:.1em}
.acts{display:flex;flex-wrap:wrap;gap:9px;margin-top:auto;padding-top:16px}
.btn{
  display:inline-block;cursor:pointer;text-decoration:none;border:1px solid var(--coral);
  background:var(--coral);color:#1a0c0f;font-family:var(--mono);font-weight:700;font-size:12px;letter-spacing:.08em;
  padding:9px 14px;border-radius:8px;
}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{border-color:var(--teal);color:var(--teal)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-top:14px}
.gallery a{display:block}
.gallery img{width:100%;aspect-ratio:.7;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
pre#raw{margin-top:14px;background:#0f0e13;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-family:var(--mono);font-size:11.5px;color:var(--muted);max-height:300px}

/* decode flash on render */
@keyframes scan{from{clip-path:inset(0 0 100% 0);opacity:.4}to{clip-path:inset(0 0 0 0);opacity:1}}
.card{animation:scan .42s cubic-bezier(.2,.7,.2,1)}
@media(prefers-reduced-motion:reduce){.card{animation:none}}

footer{margin-top:34px;font-family:var(--mono);font-size:11px;color:var(--faint);letter-spacing:.08em}
footer a{color:var(--muted)}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN \xB7 TIKTOK \u89E3\u7801</p>
  <h1>\u89E3\u6790\u53F0</h1>
  <p class=sub>\u7C98\u8D34\u6296\u97F3 / TikTok \u5206\u4EAB\u53E3\u4EE4\uFF0C\u81EA\u52A8\u53D6\u56DE\u65E0\u6C34\u5370\u89C6\u9891\u4E0E\u56FE\u96C6\u3002</p>

  <div class=keyrow>
    <button id=keytoggle type=button class=keylink>\u5BC6\u94A5</button>
  </div>
  <div id=keywrap class=keywrap hidden>
    <input id=key type=password autocomplete=off spellcheck=false placeholder="\u8BBF\u95EE\u5BC6\u94A5">
  </div>

  <div class=slot>
    <textarea id=paste placeholder="\u628A\u6296\u97F3\u5206\u4EAB\u53E3\u4EE4\u7C98\u5230\u8FD9\u91CC\uFF0C\u4E00\u7C98\u5C31\u89E3\u6790\u2026&#10;\u4F8B\uFF1A7.91 \u590D\u5236\u6253\u5F00\u6296\u97F3\uFF0C\u770B\u770B\u3010\u4F5C\u8005\u7684\u4F5C\u54C1\u3011 https://v.douyin.com/xxxxxx/"></textarea>
    <button id=go class=go>\u89E3\u6790</button>
  </div>

  <p id=status class=status>\u7B49\u5F85\u53E3\u4EE4</p>
  <div id=out></div>

  <footer>\u81EA\u6258\u7BA1\u4E8E RandallFlare \xB7 <a href="/discover">\u53D1\u73B0</a> \xB7 <a href="/search">\u641C\u7D22</a> \xB7 <a href="/admin">\u6863\u6848</a> \xB7 <a href="/docs">\u63A5\u53E3\u6587\u6863</a></footer>
</main>

<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var KEY='dt_key'
  var keyInput=$('#key'),pasteBox=$('#paste'),statusEl=$('#status'),out=$('#out'),goBtn=$('#go')
  var keytoggle=$('#keytoggle'),keywrap=$('#keywrap')
  try{var k=localStorage.getItem(KEY);if(k){keyInput.value=k;keywrap.hidden=false}}catch(e){}
  keyInput.addEventListener('input',function(){try{localStorage.setItem(KEY,keyInput.value)}catch(e){}})
  keytoggle.addEventListener('click',function(){keywrap.hidden=!keywrap.hidden;if(!keywrap.hidden)keyInput.focus()})

  function extractUrl(t){var m=String(t||'').match(/https?:\\/\\/[^\\s]+/);return m?m[0]:''}
  function setStatus(s,kind){statusEl.textContent=s;statusEl.className='status'+(kind?' '+kind:'')}
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  function fmt(n){n=Number(n)||0;return n>=10000?(n/10000).toFixed(1)+'w':String(n)}

  var inflight=0
  var lastGuest=false
  async function parse(text){
    var url=extractUrl(text)
    if(!url){setStatus('\u6CA1\u627E\u5230\u94FE\u63A5\uFF0C\u786E\u8BA4\u7C98\u7684\u662F\u5206\u4EAB\u53E3\u4EE4','warn');return}
    var key=(keyInput.value||'').trim()
    lastGuest=!key
    var my=++inflight
    setStatus(key?'\u89E3\u7801\u4E2D\u2026':'\u89E3\u7801\u4E2D\u2026\uFF08\u6E38\u5BA2\u6A21\u5F0F\uFF09','load');out.innerHTML=''
    try{
      var api='/api/hybrid/video_data?minimal=true&proxy=1&url='+encodeURIComponent(url)
      if(key)api+='&token='+encodeURIComponent(key)
      var r=await fetch(api)
      var j=await r.json()
      if(my!==inflight)return
      if(r.status===429){setStatus((j&&j.message)||'\u6E38\u5BA2\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u586B\u5165\u8BBF\u95EE\u5BC6\u94A5','warn');return}
      if(r.status!==200){setStatus('\u5931\u8D25\uFF1A'+((j&&j.message)||('HTTP '+r.status)),'err');return}
      render(j.data)
      setStatus((key?'\u5DF2\u89E3\u7801':'\u5DF2\u89E3\u7801\uFF08\u6E38\u5BA2 \xB7 \u94FE\u63A5\u4E34\u65F6\u6709\u6548\uFF09')+' \xB7 '+(j.data&&j.data.platform||''),'ok')
    }catch(e){if(my===inflight)setStatus('\u7F51\u7EDC\u9519\u8BEF\uFF1A'+e.message,'err')}
  }

  function withDownload(href){return href+(href.indexOf('?')>-1?'&':'?')+'download=1'}
  function dlBtn(href,label){var a=el('a','btn',label);a.href=withDownload(href);a.setAttribute('download','');return a}
  function copyBtn(text,label){
    var b=el('button','btn ghost',label)
    b.addEventListener('click',function(){navigator.clipboard.writeText(text).then(function(){var o=b.textContent;b.textContent='\u5DF2\u590D\u5236';setTimeout(function(){b.textContent=o},1200)})})
    return b
  }
  function stat(label,n){var w=el('span','stat');w.appendChild(el('b',null,fmt(n)));w.appendChild(el('i',null,label));return w}

  function render(d){
    out.innerHTML=''
    if(!d){setStatus('\u7A7A\u7ED3\u679C','warn');return}
    var card=el('div','card')
    var frame=el('div','frame')
    var cover=d.cover_data&&d.cover_data.cover?d.cover_data.cover:''
    var firstImg=(d.image_data&&(d.image_data.no_watermark_image_list||[])[0])||''
    if(d.type==='video'&&d.video_data&&d.video_data.nwm_video_url){
      var v=el('video');v.controls=true;v.playsInline=true;v.preload='metadata';v.setAttribute('playsinline','')
      if(cover)v.poster=cover
      v.src=d.video_data.nwm_video_url
      frame.appendChild(v)
    }else{
      var im0=el('img');im0.src=cover||firstImg;im0.alt='\u9884\u89C8';im0.loading='lazy';frame.appendChild(im0)
    }
    frame.appendChild(el('span','badge',d.type==='image'?'\u56FE\u96C6':'\u89C6\u9891'))
    card.appendChild(frame)

    var meta=el('div','meta')
    meta.appendChild(el('div','nick',(d.author&&d.author.nickname)||'\u672A\u77E5\u4F5C\u8005'))
    if(d.desc)meta.appendChild(el('p','desc',d.desc))
    if(d.statistics){var s=d.statistics,st=el('div','stats')
      st.appendChild(stat('\u8D5E',s.digg_count));st.appendChild(stat('\u8BC4',s.comment_count))
      st.appendChild(stat('\u85CF',s.collect_count));st.appendChild(stat('\u8F6C',s.share_count))
      meta.appendChild(st)}

    var acts=el('div','acts')
    if(d.type==='video'&&d.video_data){
      acts.appendChild(dlBtn(d.video_data.nwm_video_url,'\u4E0B\u8F7D\u65E0\u6C34\u5370'))
      acts.appendChild(copyBtn(d.video_data.nwm_video_url,'\u590D\u5236\u76F4\u94FE'))
    }
    if(d.type==='image'&&d.image_data){
      (d.image_data.no_watermark_image_list||[]).forEach(function(u,i){acts.appendChild(dlBtn(u,'\u56FE'+(i+1)))})
    }
    if(!lastGuest){
      var raw=el('button','btn ghost','\u539F\u59CB JSON')
      raw.addEventListener('click',function(){var p=$('#raw');if(!p){p=el('pre');p.id='raw';out.appendChild(p)}p.textContent=JSON.stringify(d,null,2)})
      acts.appendChild(raw)
    }
    meta.appendChild(acts)
    card.appendChild(meta)
    out.appendChild(card)

    if(d.type==='image'&&d.image_data){
      var g=el('div','gallery')
      ;(d.image_data.no_watermark_image_list||[]).forEach(function(u){var a=el('a');a.href=u;a.target='_blank';a.rel='noopener';var im=el('img');im.src=u;im.loading='lazy';a.appendChild(im);g.appendChild(a)})
      out.appendChild(g)
    }
  }

  pasteBox.addEventListener('paste',function(){setTimeout(function(){parse(pasteBox.value)},0)})
  goBtn.addEventListener('click',function(){parse(pasteBox.value)})
  pasteBox.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter')parse(pasteBox.value)})

  // Prefill + auto-parse from ?u= (used by the admin "\u91CD\u89E3" link).
  var pre=new URLSearchParams(location.search).get('u')
  if(pre){pasteBox.value=pre;if((keyInput.value||'').trim())parse(pre)}
})();
</script>
</body>
</html>`;

// src/service/docs.js
async function docsService(request, ctx) {
  const tokenSource = ctx.config.auth.tokenSource;
  const html = renderDocs(tokenSource);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
function renderDocs(tokenSource) {
  return DOCS_HTML.replace("{{TOKEN_SOURCE}}", tokenSource);
}
var DOCS_HTML = `<!doctype html>
<html lang=zh>
<head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Douyin / TikTok API</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1c1c1e;background:#fbfbfa}
  h1{font-size:24px;margin-bottom:4px}
  h2{font-size:17px;margin-top:32px;border-bottom:1px solid #e5e3df;padding-bottom:6px}
  code{background:#f0eeea;padding:1px 5px;border-radius:4px;font-size:13px}
  .route{margin:6px 0}
  .m{display:inline-block;width:46px;font-weight:600;color:#8a6d3b}
  .lock{color:#b94a48}
  small{color:#8a857c}
  a{color:#3b6ea5}
</style></head>
<body>
<h1>Douyin / TikTok API</h1>
<small>RandallFlare worker \xB7 port of Evil0ctal/Douyin_TikTok_Download_API \xB7 token source: <code>{{TOKEN_SOURCE}}</code></small>

<h2>\u9274\u6743 / Auth</h2>
<p>\u5E26 <span class=lock>\u9501</span> \u7684\u63A5\u53E3\u9700\u8981\u9274\u6743\uFF0C\u4E24\u79CD\u65B9\u5F0F\u4EFB\u9009\u5176\u4E00\uFF08\u4E0E Meting-API \u4E00\u81F4\uFF09\uFF1A</p>
<ul>
  <li>master key\uFF1A<code>?token=&lt;DOUYIN_API_TOKEN&gt;</code></li>
  <li>per-request HMAC\uFF1A<code>?auth=&lt;HMAC-SHA1(secret, "{platform}{route}{primaryId}")&gt;</code>\uFF08hex\uFF09</li>
</ul>
<p>primaryId \u4E3A\u8BE5\u63A5\u53E3\u4E3B\u6807\u8BC6\uFF08\u5982 fetch_one_video \u7684 aweme_id\u3001tiktok fetch_one_video \u7684 itemId\u3001hybrid \u7684 url\uFF09\u3002</p>

<h2>Douyin Web <small>/api/douyin/web</small></h2>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_one_video?aweme_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_post_videos?sec_user_id=&max_cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_like_videos?sec_user_id=&max_cursor=0&counts=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_mix_videos?mix_id=&max_cursor=0&counts=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/handler_user_profile?sec_user_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_video_comments?aweme_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_video_comment_replies?item_id=&comment_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_live_videos?webcast_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_live_videos_by_room_id?room_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_live_gift_ranking?room_id=&rank_type=30</code></div>
<div class=route><span class=m>GET</span> <code>/generate_real_msToken</code> \xB7 <code>/generate_ttwid</code> \xB7 <code>/generate_verify_fp</code> \xB7 <code>/generate_s_v_web_id</code></div>
<div class=route><span class=m>GET</span> <code>/generate_x_bogus?url=&user_agent=</code> \xB7 <code>/generate_a_bogus?url=&user_agent=</code></div>
<div class=route><span class=m>GET</span> <code>/get_aweme_id?url=</code> \xB7 <code>/get_sec_user_id?url=</code> \xB7 <code>/get_webcast_id?url=</code></div>
<div class=route><span class=m>POST</span> <code>/get_all_aweme_id</code> \xB7 <code>/get_all_sec_user_id</code> \xB7 <code>/get_all_webcast_id</code> <small>(body: ["url", ...])</small></div>

<h2>TikTok Web <small>/api/tiktok/web</small></h2>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_one_video?itemId=</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_profile?secUid=&uniqueId=</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_post?secUid=&cursor=0&count=35</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_like?secUid=&cursor=0&count=35</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_mix?mixId=&cursor=0&count=30</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_post_comment?aweme_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_post_comment_reply?item_id=&comment_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_user_fans?secUid=&count=30</code> \xB7 <code>/fetch_user_follow?secUid=&count=30</code></div>
<div class=route><span class=m>GET</span> <code>/generate_real_msToken</code> \xB7 <code>/generate_ttwid?cookie=</code> \xB7 <code>/generate_xbogus?url=&user_agent=</code></div>
<div class=route><span class=m>GET</span> <code>/get_aweme_id?url=</code> \xB7 <code>/get_sec_user_id?url=</code> \xB7 <code>/get_unique_id?url=</code> (+ POST get_all_*)</div>

<h2>TikTok App <small>/api/tiktok/app</small></h2>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/fetch_one_video?aweme_id=</code></div>

<h2>Hybrid <small>/api/hybrid</small></h2>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/video_data?url=&minimal=false&refresh=0&proxy=0</code> <small>\u81EA\u52A8\u8BC6\u522B douyin/tiktok</small></div>
<small>minimal=true \u8FD4\u56DE\u7EDF\u4E00\u7CBE\u7B80\u7ED3\u6784\uFF1Bproxy=1\uFF08\u9700 minimal=true\uFF09\u628A\u5A92\u4F53\u76F4\u94FE\u6539\u5199\u6210\u4E0B\u9762\u7684 /proxy \u7F13\u5B58\u94FE\u63A5\uFF1Brefresh=1 \u8DF3\u8FC7\u5143\u6570\u636E\u7F13\u5B58\u5F3A\u5237\u3002</small>

<h2>Download</h2>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/download?url=&with_watermark=false</code> <small>\u76F4\u63A5 stream \u89C6\u9891/\u56FE\u7247</small></div>

<h2>\u53CD\u4EE3 + R2 \u7F13\u5B58 <small>/proxy</small></h2>
<div class=route><span class=m>GET</span><span class=lock>\u{1F512}</span> <code>/proxy?platform=douyin|tiktok&id=&kind=nwm&download=0&refresh=0</code></div>
<small>
\u6309 ID \u7A33\u5B9A\u7F13\u5B58\u7684\u5A92\u4F53\u53CD\u4EE3\uFF1Aworker \u7528\u6B63\u786E\u7684 Referer \u62C9\u53D6 CDN \u5B57\u8282\u5E76\u5B58\u5165 R2\uFF08key = <code>media/{platform}/{id}/{kind}</code>\uFF09\uFF0C\u7B7E\u540D url \u8FC7\u671F\u4E5F\u7167\u6837\u547D\u4E2D\uFF1B\u652F\u6301 Range\uFF08\u89C6\u9891\u62D6\u52A8\uFF09\u3002<br>
kind: <code>nwm</code>\uFF08\u65E0\u6C34\u5370\u89C6\u9891 HQ\uFF09\xB7 <code>wm</code>\uFF08\u6709\u6C34\u5370\u89C6\u9891\uFF09\xB7 <code>cover</code>\uFF08\u5C01\u9762\uFF09\xB7 <code>image0/1/\u2026</code>\uFF08\u65E0\u6C34\u5370\u56FE\uFF09\xB7 <code>imagewm0/1/\u2026</code>\uFF08\u6709\u6C34\u5370\u56FE\uFF09\u3002<br>
\u9274\u6743\u7B7E\u540D\u4E32\u4E3A <code>"proxy{platform}{id}"</code>\uFF08\u4E0E kind \u65E0\u5173\uFF0C\u4E00\u4E2A auth \u8986\u76D6\u8BE5\u4F5C\u54C1\u6240\u6709 kind\uFF09\u3002video_data?proxy=1 \u91CD\u5199\u51FA\u7684\u94FE\u63A5\u5DF2\u81EA\u5E26 <code>&auth=</code>\uFF0C\u53EF\u76F4\u63A5\u5F53\u64AD\u653E\u5668 src\u3002<br>
\u5143\u6570\u636E\uFF08\u89E3\u6790\u540E\u7684\u89C6\u9891\u4FE1\u606F\uFF09\u4EE5 JSON \u6587\u4EF6\u7F13\u5B58\u5728 R2 <code>meta/{platform}/{id}.json</code>\uFF0C\u9ED8\u8BA4 1 \u5C0F\u65F6\uFF08env <code>META_CACHE_TTL</code> \u53EF\u8C03\uFF0C<code>?refresh=1</code> \u5F3A\u5237\uFF09\u3002\u9700\u8981\u7ED1\u5B9A R2\uFF1Aenv <code>DOUYIN_R2</code>\uFF08\u672A\u7ED1\u5B9A\u5219\u5168\u90E8\u9000\u5316\u4E3A\u4E0D\u7F13\u5B58\u3001\u5B9E\u65F6\u76F4\u8FDE\uFF09\u3002
</small>

</body></html>`;

// src/router.js
async function router(request, ctx) {
  const url = new URL(request.url);
  const prefix = ctx.config.http.prefix;
  let pathname = url.pathname;
  if (prefix && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length);
  }
  if (pathname === "") pathname = "/";
  if (pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }
  if (pathname === "/__edge_cron" && request.method === "POST") {
    return cronService(request, ctx);
  }
  if (pathname === "/" && request.method === "GET") {
    return appService(request, ctx);
  }
  if (pathname === "/docs" && request.method === "GET") {
    return docsService(request, ctx);
  }
  if (pathname === "/admin" && request.method === "GET") {
    return adminPageService(request, ctx);
  }
  if (pathname === "/discover" && request.method === "GET") {
    return discoverPageService(request, ctx);
  }
  if (pathname === "/api/discover" && request.method === "GET") {
    return discoverApiService(request, ctx);
  }
  if (pathname === "/work" && request.method === "GET") {
    return workPageService(request, ctx);
  }
  if (pathname === "/api/work" && request.method === "GET") {
    return workApiService(request, ctx);
  }
  if (pathname === "/api/comments" && request.method === "GET") {
    return commentsApiService(request, ctx);
  }
  if (pathname === "/search" && request.method === "GET") {
    return searchPageService(request, ctx);
  }
  if (pathname === "/api/search" && request.method === "GET") {
    return searchApiService(request, ctx);
  }
  if (pathname === "/author" && request.method === "GET") {
    return authorPageService(request, ctx);
  }
  if (pathname === "/api/author" && request.method === "GET") {
    return authorApiService(request, ctx);
  }
  if (pathname === "/api/admin/recent" && request.method === "GET") {
    return adminRecentService(request, ctx);
  }
  if (pathname.startsWith("/api/douyin/web/")) {
    return douyinWebService(pathname.slice("/api/douyin/web/".length), request, ctx);
  }
  if (pathname.startsWith("/api/tiktok/web/")) {
    return tiktokWebService(pathname.slice("/api/tiktok/web/".length), request, ctx);
  }
  if (pathname.startsWith("/api/tiktok/app/")) {
    return tiktokAppService(pathname.slice("/api/tiktok/app/".length), request, ctx);
  }
  if (pathname.startsWith("/api/hybrid/")) {
    return hybridService(pathname.slice("/api/hybrid/".length), request, ctx);
  }
  if (pathname === "/download") {
    return downloadService(request, ctx);
  }
  if (pathname === "/proxy") {
    return proxyService(request, ctx);
  }
  if (pathname === "/img") {
    return imgService(request, ctx);
  }
  throw new HTTPException(404, { message: `No route for ${pathname}` });
}

// src/config.js
var DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36";
var toNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};
function buildConfig(env) {
  env = env || {};
  return {
    http: {
      prefix: env.HTTP_PREFIX || ""
    },
    // HMAC secret shared with callers. `tokenSource` is stamped on
    // responses so we can spot an env-binding flake where a fresh
    // isolate ships with no token bound and silently uses the
    // placeholder 'token' to mint/verify HMACs.
    auth: {
      token: env.DOUYIN_API_TOKEN || "token",
      tokenSource: env.DOUYIN_API_TOKEN ? "env" : "default"
    },
    douyin: {
      cookie: env.DOUYIN_COOKIE || "",
      userAgent: env.DEFAULT_USER_AGENT || DEFAULT_UA
    },
    tiktok: {
      cookie: env.TIKTOK_COOKIE || "",
      userAgent: env.TIKTOK_USER_AGENT || env.DEFAULT_USER_AGENT || DEFAULT_UA
    },
    // R2 bucket binding for caching media bytes + metadata JSON. When
    // bound, /proxy serves video/image bytes from R2 (content keyed by
    // platform/id/kind, so signed-CDN-url rotation still hits cache),
    // and parsed video metadata is cached as JSON files under meta/.
    // Absent (null) → everything still works, just uncached.
    mediaR2: env.DOUYIN_R2 || env.MEDIA_R2 || null,
    // D1 database binding for the query log (recent parses shown in
    // /admin). Absent (null) → logging + admin degrade to no-ops.
    d1: env.DOUYIN_D1 || env.DB || null,
    // KV namespace binding for guest rate limiting (preferred over D1
    // for counters: TTL auto-expires the window, no table growth).
    // Absent → rate limiting falls back to D1.
    kv: env.DOUYIN_KV || env.KV || null,
    // Cron hot-grow toggles. Douyin keyword search returns risk-control
    // 2483 and the TikTok feed device-id is rate-limited (429), so both are
    // OFF by default to avoid hammering walls hourly. Flip on (env=1) if you
    // supply a full logged-in cookie that clears risk control.
    cron: {
      // Douyin search hits risk-control 2483 (cookie can't clear it) → off
      // by default. TikTok trending feed works (ingested directly from the
      // batch) → on by default; set TIKTOK_HOT_CRON=0 to disable.
      douyinHot: env.DOUYIN_HOT_CRON === "1",
      tiktokHot: env.TIKTOK_HOT_CRON !== "0"
    },
    cache: {
      // Metadata JSON freshness in seconds (default 1h). ?refresh=1
      // on a request bypasses + repopulates.
      metaTtl: toNumber(env.META_CACHE_TTL, 3600)
    },
    // Guest mode: unauthenticated callers can parse (hybrid/video_data)
    // and get TEMPORARY proxied download links, but never raw JSON, the
    // raw per-platform endpoints, or /admin. Rate-limited per IP via D1
    // (so guest access requires a D1 binding — without one we can't
    // enforce limits and guests are refused). Default on.
    guest: {
      enabled: !["0", "false", "no", "off"].includes(String(env.GUEST_ENABLED ?? "").toLowerCase()),
      limit: toNumber(env.GUEST_RATE_LIMIT, 20),
      windowSec: toNumber(env.GUEST_RATE_WINDOW, 3600),
      linkTtlSec: toNumber(env.GUEST_LINK_TTL, 7200)
    },
    log: {
      level: env.LOG_LEVEL || "info"
    },
    rawEnv: env
  };
}
var config_default = buildConfig({});

// src/worker.js
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "access-control-max-age": "86400"
};
function addCorsHeaders(response) {
  const headers2 = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers2.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers2
  });
}
var handler = withRequestLogger(withErrorHandler(router));
var worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const config = buildConfig(env);
    const innerCtx = {
      config,
      env,
      waitUntil: typeof ctx?.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : null
    };
    const response = await handler(request, innerCtx);
    return addCorsHeaders(response);
  }
};
export {
  worker_default as default,
  logger
};
