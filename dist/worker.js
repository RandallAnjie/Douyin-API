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
      const j = off + i * 4;
      w[i] = (bytes[j] << 24 | bytes[j + 1] << 16 | bytes[j + 2] << 8 | bytes[j + 3]) >>> 0;
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
var tj = (j) => j < 16 ? 2043430169 : 2055708042;
var ff = (j, x, y, z) => (j < 16 ? x ^ y ^ z : x & y | x & z | y & z) >>> 0;
var gg = (j, x, y, z) => (j < 16 ? x ^ y ^ z : x & y | ~x & z) >>> 0;
function cf(v, b) {
  const w = new Array(68);
  for (let i = 0; i < 16; i++) {
    w[i] = (b[4 * i] << 24 | b[4 * i + 1] << 16 | b[4 * i + 2] << 8 | b[4 * i + 3]) >>> 0;
  }
  for (let j = 16; j < 68; j++) {
    w[j] = (p1((w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) >>> 0) ^ rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
  }
  const w1 = new Array(64);
  for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0;
  let [a, bb, c, d, e, f, g, h] = v;
  for (let j = 0; j < 64; j++) {
    const ss1 = rotl((rotl(a, 12) + e >>> 0) + rotl(tj(j), j) >>> 0, 7);
    const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
    const tt1 = (ff(j, a, bb, c) + d >>> 0) + (ss2 + w1[j] >>> 0) >>> 0;
    const tt2 = (gg(j, e, f, g) + h >>> 0) + (ss1 + w[j] >>> 0) >>> 0;
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
    const j = start + i * 4;
    w[i] = bytes[j] | bytes[j + 1] << 8 | bytes[j + 2] << 16 | bytes[j + 3] << 24;
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
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) % 256;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
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
function list4(a, b, c, d, e, f, g, h, i, j, k, m, n, o, p, q3, r) {
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
    j,
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
      const j = js[t];
      if (j === 6 && i + 1 >= codes.length) break;
      if (j === 0 && i + 2 >= codes.length) break;
      r.push(table[(n & ks[t]) >> j]);
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
function fetchUserPostVideos(ctx, secUserId, maxCursor, count) {
  const params = { ...baseRequestParams(""), max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId };
  return aBogusGet(ctx, DouyinEndpoints.USER_POST, params);
}
function fetchUserLikeVideos(ctx, secUserId, maxCursor, count) {
  const params = { ...baseRequestParams(""), max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId };
  return aBogusGet(ctx, DouyinEndpoints.USER_FAVORITE_A, params);
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
async function serveFromR2(bucket, request, key, contentType) {
  if (!bucket || typeof bucket.head !== "function") return null;
  let head;
  try {
    head = await bucket.head(key);
  } catch {
    return null;
  }
  if (!head) return null;
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
  const put = bucket.put(key, r2Branch, { httpMetadata: { contentType: finalType } }).catch((e) => {
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
async function cachePopulateAside(bucket, ctx, key, rangeFetcher, fullFetcher, contentType) {
  const userPromise = rangeFetcher();
  if (bucket && ctx?.waitUntil) {
    ctx.waitUntil(r2PutRetry(
      bucket,
      key,
      // Re-fetch per attempt (the plane PUT 502s intermittently).
      async () => {
        const full = await fullFetcher();
        if (!full || !full.ok || !full.body) throw new Error("aside fetch not ok");
        return full.body;
      },
      { httpMetadata: { contentType: contentType || "application/octet-stream" } },
      2
    ));
  }
  return userPromise;
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
function putJson(bucket, key, obj) {
  if (!bucket) return Promise.resolve(false);
  const json = JSON.stringify(obj);
  return r2PutRetry(
    bucket,
    key,
    () => new Response(json).body,
    { httpMetadata: { contentType: "application/json; charset=utf-8" } }
  );
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
  await putJson(bucket, key, data);
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
  await putJson(bucket, key, data);
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
  const platform = detectPlatform(url);
  if (platform === "douyin") return { platform, id: await getAwemeId(url) };
  if (platform === "tiktok") return { platform, id: await getTiktokAwemeId(url) };
  throw new HTTPException(400, { message: "Cannot determine platform (expected a douyin or tiktok URL)" });
}
async function fetchRawById(ctx, platform, id, refresh = false) {
  if (platform === "douyin") {
    const { data, cached } = await fetchDouyinDetailCached(ctx, id, refresh);
    const raw = data.aweme_detail;
    if (!raw) throw new HTTPException(502, { message: "Douyin returned no aweme_detail (bad cookie/signature?)" });
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
function resolveKindUrl(minimal, kind) {
  const isImageKind = /^image(wm)?\d+$/.test(kind);
  if (kind === "nwm" || kind === "wm") {
    const vd = minimal.video_data;
    if (!vd) throw new HTTPException(404, { message: "No video for this resource" });
    const url = kind === "nwm" ? vd.nwm_video_url_HQ || vd.nwm_video_url : vd.wm_video_url_HQ || vd.wm_video_url;
    return { url, contentType: "video/mp4", ext: "mp4" };
  }
  if (kind === "cover") {
    const url = minimal.cover_data?.cover?.url_list?.[0] || minimal.cover_data?.cover;
    return { url: pickUrl(url), contentType: "image/jpeg", ext: "jpeg" };
  }
  if (isImageKind) {
    const wm = kind.startsWith("imagewm");
    const idx = Number(kind.replace(/^image(wm)?/, ""));
    const list = wm ? minimal.image_data?.watermark_image_list : minimal.image_data?.no_watermark_image_list;
    if (!list || !list[idx]) throw new HTTPException(404, { message: `No image at index ${idx}` });
    return { url: list[idx], contentType: "image/jpeg", ext: "jpeg" };
  }
  throw new HTTPException(400, { message: `Unknown kind: ${kind}` });
}
var pickUrl = (v) => typeof v === "string" ? v : v?.url_list?.[0] ?? null;

// src/utils/proxy-link.js
function proxyBase(request, ctx) {
  const u = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const host = request.headers.get("x-forwarded-host") || u.host;
  return `${proto}://${host}${ctx.config.http.prefix}`;
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
    description TEXT,
    original_url TEXT,
    cover TEXT,
    play TEXT,
    hits INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(platform, video_id)
  )`).run();
  schemaReady = true;
}
async function logQuery(ctx, row) {
  const db = ctx.config.d1;
  if (!db) return;
  try {
    await ensureSchema(db);
    const now = Date.now();
    await db.prepare(`INSERT INTO queries
      (platform, video_id, type, author, description, original_url, cover, play, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(platform, video_id) DO UPDATE SET
        hits = hits + 1, updated_at = ?, type = ?, author = ?,
        description = ?, original_url = ?, cover = ?, play = ?`).bind(
      row.platform,
      row.video_id,
      row.type,
      row.author,
      row.description,
      row.original_url,
      row.cover,
      row.play,
      now,
      now,
      now,
      row.type,
      row.author,
      row.description,
      row.original_url,
      row.cover,
      row.play
    ).run();
  } catch (e) {
    try {
      console.error("[d1] logQuery failed", e?.message || e);
    } catch {
    }
  }
}
async function recentQueries(ctx, limit = 10, offset = 0) {
  const db = ctx.config.d1;
  if (!db) return { rows: [], total: 0 };
  try {
    await ensureSchema(db);
    const res = await db.prepare(
      `SELECT platform, video_id, type, author, description, original_url, cover, play, hits, created_at, updated_at
       FROM queries ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    const cnt = await db.prepare("SELECT COUNT(*) AS n FROM queries").all();
    return { rows: res?.results || [], total: cnt?.results?.[0]?.n || 0 };
  } catch (e) {
    try {
      console.error("[d1] recentQueries failed", e?.message || e);
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
    const { raw } = await fetchRawById(ctx, platform, id, refresh);
    const min = toMinimal(platform, id, raw);
    await logQuery(ctx, {
      platform,
      video_id: id,
      type: min.type,
      author: min.author && min.author.nickname || null,
      description: min.desc || null,
      original_url: target,
      cover: proxyLink(request, ctx, platform, id, "cover"),
      play: min.type === "video" ? proxyLink(request, ctx, platform, id, "nwm") : null
    });
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
var BUFFER_CAP = 20 * 1024 * 1024;
var SMALL_MEDIA = 2 * 1024 * 1024;
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
    const hit = await serveFromR2(bucket, request, key);
    if (hit) return withDisposition(hit, download, platform, id, kind);
  }
  const { raw } = await fetchRawById(ctx, platform, id, refresh);
  const minimal = toMinimal(platform, id, raw);
  const { url: cdnUrl, contentType, ext } = resolveKindUrl(minimal, kind);
  if (!cdnUrl) throw new HTTPException(404, { message: `No media url for kind=${kind}` });
  const reqHeaders = {
    "User-Agent": platform === "douyin" ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: REFERER[platform]
  };
  const rangeHeader = request.headers.get("range");
  if (rangeHeader && bucket) {
    const resp = await cachePopulateAside(
      bucket,
      ctx,
      key,
      () => fetch(cdnUrl, { headers: { ...reqHeaders, range: rangeHeader } }).then((r) => wrapMedia(r, contentType, "upstream-range")),
      () => fetch(cdnUrl, { headers: reqHeaders }),
      contentType
    );
    return withDisposition(resp, download, platform, id, kind, ext);
  }
  const upstream = await fetch(cdnUrl, { headers: rangeHeader ? { ...reqHeaders, range: rangeHeader } : reqHeaders });
  if (!upstream.ok || !upstream.body) {
    throw new HTTPException(502, { message: `Upstream media fetch failed (${upstream.status})` });
  }
  if (!bucket || rangeHeader) {
    return withDisposition(wrapMedia(upstream, contentType, "upstream-plain"), download, platform, id, kind, ext);
  }
  const cl = Number(upstream.headers.get("content-length") || 0);
  if (cl <= BUFFER_CAP) {
    const buf = await upstream.arrayBuffer();
    const size = buf.byteLength;
    const putP = r2PutRetry(bucket, key, () => new Response(buf).body, { httpMetadata: { contentType } });
    if (size <= SMALL_MEDIA) {
      try {
        await putP;
      } catch {
      }
    } else if (ctx?.waitUntil) {
      ctx.waitUntil(putP);
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
  return withDisposition(teeIntoCache(bucket, ctx, key, upstream, contentType), download, platform, id, kind, ext);
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
    <input id=key type=password autocomplete=off placeholder="\u8BBF\u95EE\u94A5\u5319 (API Token)">
    <button id=refresh>\u5237\u65B0</button>
    <a href="/">\u2190 \u89E3\u6790\u53F0</a>
  </div>
  <p id=status class=status>\u8F93\u5165\u94A5\u5319\u540E\u81EA\u52A8\u52A0\u8F7D</p>
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
    if(!key){statusEl.textContent='\u5148\u586B\u8BBF\u95EE\u94A5\u5319';return}
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

// src/service/app.js
async function appService(request, ctx) {
  return new Response(PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
var PAGE = `<!doctype html>
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
.keywrap.hidden{display:none}
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
    <button id=keytoggle type=button class=keylink>\u94A5\u5319</button>
  </div>
  <div id=keywrap class=keywrap hidden>
    <input id=key type=password autocomplete=off spellcheck=false placeholder="\u8BBF\u95EE\u94A5\u5319">
  </div>

  <div class=slot>
    <textarea id=paste placeholder="\u628A\u6296\u97F3\u5206\u4EAB\u53E3\u4EE4\u7C98\u5230\u8FD9\u91CC\uFF0C\u4E00\u7C98\u5C31\u89E3\u6790\u2026&#10;\u4F8B\uFF1A7.91 \u590D\u5236\u6253\u5F00\u6296\u97F3\uFF0C\u770B\u770B\u3010\u4F5C\u8005\u7684\u4F5C\u54C1\u3011 https://v.douyin.com/xxxxxx/"></textarea>
    <button id=go class=go>\u89E3\u6790</button>
  </div>

  <p id=status class=status>\u7B49\u5F85\u53E3\u4EE4</p>
  <div id=out></div>

  <footer>\u81EA\u6258\u7BA1\u4E8E RandallFlare \xB7 <a href="/admin">\u6863\u6848</a> \xB7 <a href="/docs">\u63A5\u53E3\u6587\u6863</a></footer>
</main>

<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var KEY='dt_key'
  var keyInput=$('#key'),pasteBox=$('#paste'),statusEl=$('#status'),out=$('#out'),goBtn=$('#go')
  var keytoggle=$('#keytoggle'),keywrap=$('#keywrap')
  try{var k=localStorage.getItem(KEY);if(k){keyInput.value=k;keywrap.classList.remove('hidden')}}catch(e){}
  keyInput.addEventListener('input',function(){try{localStorage.setItem(KEY,keyInput.value)}catch(e){}})
  keytoggle.addEventListener('click',function(){keywrap.classList.toggle('hidden');if(!keywrap.classList.contains('hidden'))keyInput.focus()})

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
      if(r.status===429){setStatus((j&&j.message)||'\u6E38\u5BA2\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u586B\u5165\u8BBF\u95EE\u94A5\u5319','warn');return}
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
  if (pathname === "/" && request.method === "GET") {
    return appService(request, ctx);
  }
  if (pathname === "/docs" && request.method === "GET") {
    return docsService(request, ctx);
  }
  if (pathname === "/admin" && request.method === "GET") {
    return adminPageService(request, ctx);
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
