// lib/prng.js
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashSeed(...parts) {
  return fnv1a(parts.join("|"));
}

// lib/demo.js
var DAY_MS = 864e5;
var ORIGIN = Date.UTC(2020, 0, 2);
var SESSION_START_MIN = 9 * 60 + 30;
var SESSION_END_MIN = 16 * 60;
var MINUTE_PERIODS = /* @__PURE__ */ new Set([1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 120, 180, 240]);
var KNOWN = {
  "700.HK": { anchor: 600, name_en: "Tencent Holdings", name_cn: "\u817E\u8BAF\u63A7\u80A1", name_hk: "\u9A30\u8A0A\u63A7\u80A1", exchange: "HKEX", currency: "HKD", lot_size: 100 },
  "9988.HK": { anchor: 120, name_en: "Alibaba Group", name_cn: "\u963F\u91CC\u5DF4\u5DF4", name_hk: "\u963F\u91CC\u5DF4\u5DF4", exchange: "HKEX", currency: "HKD", lot_size: 100 },
  "0005.HK": { anchor: 95, name_en: "HSBC Holdings", name_cn: "\u6C47\u4E30\u63A7\u80A1", name_hk: "\u532F\u8C50\u63A7\u80A1", exchange: "HKEX", currency: "HKD", lot_size: 400 },
  "AAPL.US": { anchor: 230, name_en: "Apple Inc", name_cn: "\u82F9\u679C", name_hk: "\u860B\u679C", exchange: "NASDAQ", currency: "USD", lot_size: 1 },
  "NVDA.US": { anchor: 150, name_en: "NVIDIA Corp", name_cn: "\u82F1\u4F1F\u8FBE", name_hk: "\u82F1\u5049\u9054", exchange: "NASDAQ", currency: "USD", lot_size: 1 },
  "MSFT.US": { anchor: 430, name_en: "Microsoft Corp", name_cn: "\u5FAE\u8F6F", name_hk: "\u5FAE\u8EDF", exchange: "NASDAQ", currency: "USD", lot_size: 1 },
  "TSLA.US": { anchor: 250, name_en: "Tesla Inc", name_cn: "\u7279\u65AF\u62C9", name_hk: "\u7279\u65AF\u62C9", exchange: "NASDAQ", currency: "USD", lot_size: 1 }
};
function meta(symbol) {
  if (KNOWN[symbol]) return KNOWN[symbol];
  const suffix = symbol.split(".")[1] || "";
  return {
    anchor: 100,
    name_en: symbol,
    name_cn: symbol,
    name_hk: symbol,
    exchange: suffix === "HK" ? "HKEX" : suffix === "US" ? "NASDAQ" : suffix || "UNKNOWN",
    currency: suffix === "HK" ? "HKD" : "USD",
    lot_size: suffix === "HK" ? 100 : 1
  };
}
var fmt3 = (x) => x.toFixed(3);
var isWeekday = (ms) => {
  const d = new Date(ms).getUTCDay();
  return d >= 1 && d <= 5;
};
var dailyCache = /* @__PURE__ */ new Map();
function dailySeries(symbol) {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const cached = dailyCache.get(symbol);
  if (cached && cached.today === today) return cached.rows;
  const { anchor } = meta(symbol);
  const rand = mulberry32(hashSeed(symbol));
  const rows = [];
  let close = anchor * (0.6 + rand() * 0.4);
  for (let day = ORIGIN; day <= today; day += DAY_MS) {
    if (!isWeekday(day)) continue;
    const ret = (rand() - 0.5) * 0.04;
    const prevClose = close;
    close = Math.max(0.01, prevClose * (1 + ret));
    const open = prevClose * (1 + (rand() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    const volume = Math.round(anchor * 3e4 * (0.5 + rand()));
    const turnover = volume * (open + high + low + close) / 4;
    rows.push({ day, open, high, low, close, volume, turnover });
  }
  dailyCache.set(symbol, { today, rows });
  return rows;
}
function dailyCandle(row) {
  return {
    close: fmt3(row.close),
    open: fmt3(row.open),
    low: fmt3(row.low),
    high: fmt3(row.high),
    volume: row.volume,
    turnover: fmt3(row.turnover),
    timestamp: Math.floor(row.day / 1e3),
    trade_session: 0
  };
}
function aggregate(rows, period) {
  const keyOf = (ms) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    if (period === 3e3) return `${y}-${d.getUTCMonth()}`;
    if (period === 3500) return `${y}-Q${Math.floor(d.getUTCMonth() / 3)}`;
    if (period === 4e3) return `${y}`;
    const monday = ms - (d.getUTCDay() + 6) % 7 * DAY_MS;
    return `W${monday}`;
  };
  const groups = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const k = keyOf(row.day);
    let g = groups.get(k);
    if (!g) {
      g = { day: row.day, open: row.open, high: row.high, low: row.low, close: row.close, volume: 0, turnover: 0 };
      groups.set(k, g);
    }
    g.high = Math.max(g.high, row.high);
    g.low = Math.min(g.low, row.low);
    g.close = row.close;
    g.volume += row.volume;
    g.turnover += row.turnover;
  }
  return [...groups.values()];
}
function intradayCandles(symbol, period, dayIndex, rows) {
  const row = rows[dayIndex];
  const prevClose = dayIndex > 0 ? rows[dayIndex - 1].close : row.open;
  const n = Math.max(1, Math.floor((SESSION_END_MIN - SESSION_START_MIN) / period));
  const rand = mulberry32(hashSeed(symbol, period, row.day));
  const scale = row.close * 3e-3;
  const weights = Array.from({ length: n }, () => 0.3 + rand());
  const wSum = weights.reduce((a, b) => a + b, 0);
  const out = [];
  let w = 0;
  let last = prevClose;
  for (let i = 0; i < n; i++) {
    w += rand() - 0.5;
    const drift = prevClose + (row.close - prevClose) * ((i + 1) / n);
    const close = Math.max(0.01, drift + w * scale);
    const open = last;
    const high = Math.max(open, close) * (1 + rand() * 2e-3);
    const low = Math.min(open, close) * (1 - rand() * 2e-3);
    const volume = Math.round(row.volume * weights[i] / wSum);
    out.push({
      close: fmt3(close),
      open: fmt3(open),
      low: fmt3(low),
      high: fmt3(high),
      volume,
      turnover: fmt3(volume * (open + high + low + close) / 4),
      timestamp: Math.floor(row.day / 1e3) + (SESSION_START_MIN + i * period) * 60,
      trade_session: 0
    });
    last = close;
  }
  return out;
}
function dailyLikeCandles(symbol, period) {
  const rows = dailySeries(symbol);
  if (period === 1e3) return rows.map(dailyCandle);
  return aggregate(rows, period).map(dailyCandle);
}
function isDailyPeriod(period) {
  return period === 1e3 || period === 2e3 || period === 3e3 || period === 3500 || period === 4e3;
}
function parseYmd(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}
function demoCandlestick(symbol, period, count) {
  if (isDailyPeriod(period)) {
    return { symbol, candlesticks: dailyLikeCandles(symbol, period).slice(-count) };
  }
  const rows = dailySeries(symbol);
  const slotsPerDay = Math.max(1, Math.floor((SESSION_END_MIN - SESSION_START_MIN) / period));
  const daysNeeded = Math.min(rows.length, Math.ceil(count / slotsPerDay) + 1);
  const startIdx = rows.length - daysNeeded;
  const candles = [];
  for (let i = startIdx; i < rows.length; i++) candles.push(...intradayCandles(symbol, period, i, rows));
  return { symbol, candlesticks: candles.slice(-count) };
}
function demoHistoryCandlestick(symbol, period, startDate, endDate) {
  const start = parseYmd(startDate);
  const end = parseYmd(endDate);
  if (isDailyPeriod(period)) {
    let candles2 = dailyLikeCandles(symbol, period);
    if (start !== null) candles2 = candles2.filter((c) => c.timestamp * 1e3 >= start);
    if (end !== null) candles2 = candles2.filter((c) => c.timestamp * 1e3 <= end + DAY_MS - 1);
    return { symbol, candlesticks: candles2.slice(-1e3) };
  }
  const rows = dailySeries(symbol);
  let lo = 0;
  let hi = rows.length - 1;
  if (start !== null) while (lo < rows.length && rows[lo].day < start) lo++;
  if (end !== null) while (hi >= 0 && rows[hi].day > end) hi--;
  const candles = [];
  for (let i = lo; i <= hi; i++) candles.push(...intradayCandles(symbol, period, i, rows));
  return { symbol, candlesticks: candles.slice(-1e3) };
}
function demoQuote(symbols) {
  const list = symbols.map((symbol) => {
    const rows = dailySeries(symbol);
    const cur = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : cur;
    return {
      symbol,
      last_done: fmt3(cur.close),
      prev_close: fmt3(prev.close),
      open: fmt3(cur.open),
      high: fmt3(cur.high),
      low: fmt3(cur.low),
      volume: cur.volume,
      turnover: fmt3(cur.turnover),
      timestamp: Math.floor(cur.day / 1e3),
      trade_status: 0
      // Normal
    };
  });
  return { list };
}
function demoStatic(symbols) {
  const list = symbols.map((symbol) => {
    const m = meta(symbol);
    const rows = dailySeries(symbol);
    const price = rows[rows.length - 1].close;
    return {
      symbol,
      name_en: m.name_en,
      name_cn: m.name_cn,
      name_hk: m.name_hk,
      exchange: m.exchange,
      currency: m.currency,
      lot_size: m.lot_size,
      total_shares: 96e8,
      circulating_shares: 92e8,
      hk_shares: m.currency === "HKD" ? 96e8 : 0,
      eps: fmt3(price * 0.05),
      eps_ttm: fmt3(price * 0.05),
      bps: fmt3(price * 0.4),
      dividend_yield: fmt3(price * 8e-3),
      board: m.currency === "HKD" ? "HKMainBoard" : "USMainBoard"
    };
  });
  return { list };
}
function demoAssetAccount() {
  return {
    list: [
      {
        currency: "HKD",
        cash_infos: [
          {
            currency: "HKD",
            withdraw_cash: "1000000.000",
            available_cash: "1000000.000",
            frozen_cash: "0.000",
            settling_cash: "0.000"
          }
        ],
        net_assets: "1250000.000",
        init_margin: "0.000",
        maintenance_margin: "0.000",
        buy_power: "1000000.000"
      }
    ]
  };
}
function demoAssetStock() {
  return { list: [] };
}
function isValidPeriod(period) {
  return MINUTE_PERIODS.has(period) || [1e3, 2e3, 3e3, 3500, 4e3].includes(period);
}

// lib/live.js
var PERIOD_MAP = {
  1: "Min_1",
  2: "Min_2",
  3: "Min_3",
  5: "Min_5",
  10: "Min_10",
  15: "Min_15",
  20: "Min_20",
  30: "Min_30",
  45: "Min_45",
  60: "Min_60",
  120: "Min_120",
  180: "Min_180",
  240: "Min_240",
  1e3: "Day",
  2e3: "Week",
  3e3: "Month",
  3500: "Quarter",
  4e3: "Year"
};
var LP = null;
var ctx = null;
function liveEnabled() {
  return Boolean(
    process.env.LONGPORT_APP_KEY && process.env.LONGPORT_APP_SECRET && process.env.LONGPORT_ACCESS_TOKEN
  );
}
async function getCtx() {
  if (ctx) return ctx;
  LP = await import("longport");
  const config = LP.Config.fromApikey(
    process.env.LONGPORT_APP_KEY,
    process.env.LONGPORT_APP_SECRET,
    process.env.LONGPORT_ACCESS_TOKEN
  );
  ctx = LP.QuoteContext.new(config);
  return ctx;
}
var dec = (d) => {
  const n = Number(d?.toString?.() ?? d);
  return Number.isFinite(n) ? n.toFixed(3) : String(d);
};
var secs = (d) => Math.floor(new Date(d).getTime() / 1e3);
function mapPeriod(period) {
  const name = PERIOD_MAP[period];
  if (!name) throw Object.assign(new Error(`invalid period: ${period}`), { code: 400 });
  return LP.Period[name];
}
function mapAdjust(adjustType) {
  return Number(adjustType) === 1 ? LP.AdjustType.ForwardAdjust : LP.AdjustType.NoAdjust;
}
function mapTradeSessions(tradeSession) {
  return Number(tradeSession) === 1 ? LP.TradeSessions.All : LP.TradeSessions.Intraday;
}
function mapCandle(c) {
  return {
    close: dec(c.close),
    open: dec(c.open),
    low: dec(c.low),
    high: dec(c.high),
    volume: c.volume,
    turnover: dec(c.turnover),
    timestamp: secs(c.timestamp),
    trade_session: Number(c.tradeSession ?? 0)
  };
}
function parseYmd2(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}
async function liveCandlestick({ symbol, period, count, adjustType, tradeSession }) {
  const q = await getCtx();
  const rows = await q.candlesticks(
    symbol,
    mapPeriod(period),
    count,
    mapAdjust(adjustType),
    mapTradeSessions(tradeSession)
  );
  return { symbol, candlesticks: rows.map(mapCandle) };
}
async function liveHistoryCandlestick({ symbol, period, adjustType, startDate, endDate }) {
  const q = await getCtx();
  const s = parseYmd2(startDate);
  const e = parseYmd2(endDate);
  const rows = await q.historyCandlesticksByDate(
    symbol,
    mapPeriod(period),
    mapAdjust(adjustType),
    s ? new LP.NaiveDate(s.y, s.mo, s.d) : null,
    e ? new LP.NaiveDate(e.y, e.mo, e.d) : null,
    LP.TradeSessions.Intraday
  );
  return { symbol, candlesticks: rows.map(mapCandle).slice(-1e3) };
}
async function liveQuote(symbols) {
  const q = await getCtx();
  const rows = await q.quote(symbols);
  const list = rows.map((r) => ({
    symbol: r.symbol,
    last_done: dec(r.lastDone),
    prev_close: dec(r.prevClose),
    open: dec(r.open),
    high: dec(r.high),
    low: dec(r.low),
    volume: r.volume,
    turnover: dec(r.turnover),
    timestamp: secs(r.timestamp),
    trade_status: Number(r.tradeStatus ?? 0)
  }));
  return { list };
}
async function liveStatic(symbols) {
  const q = await getCtx();
  const rows = await q.staticInfo(symbols);
  const list = rows.map((r) => ({
    symbol: r.symbol,
    name_en: r.nameEn,
    name_cn: r.nameCn,
    name_hk: r.nameHk,
    exchange: r.exchange,
    currency: r.currency,
    lot_size: r.lotSize,
    total_shares: r.totalShares,
    circulating_shares: r.circulatingShares,
    hk_shares: r.hkShares,
    eps: dec(r.eps),
    eps_ttm: dec(r.epsTtm),
    bps: dec(r.bps),
    dividend_yield: dec(r.dividendYield),
    board: String(r.board ?? "")
  }));
  return { list };
}

// lib/jev.js
var UPSTREAM = "https://api.typesafe.ai";
function jevAuth(incoming) {
  const own = incoming && incoming !== "Bearer demo" ? incoming : null;
  if (!process.env.TYPESAFE_API_KEY) return null;
  if (own) return own;
  return `Bearer ${process.env.TYPESAFE_API_KEY}`;
}
function jevHasAuth(incoming) {
  return jevAuth(incoming) !== null;
}
async function jevProxy(path, method, incomingAuth, body) {
  const headers = { authorization: jevAuth(incomingAuth) };
  let payload;
  if (body !== void 0) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${UPSTREAM}${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text };
}
function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}
function normalizedProbs(rand, keys) {
  const raw = keys.map(() => 0.05 + rand());
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => round4(r / sum));
}
function synthAnswer(name, q, bodyKey) {
  const rand = mulberry32(hashSeed(bodyKey, name));
  const type = q?.type;
  if (type === "choice") {
    const options = Object.keys(q.criteria || {});
    if (options.length === 0) return { choice: "", probabilities: {}, confidence: 0 };
    const probs = normalizedProbs(rand, options);
    let pick = rand();
    let idx = 0;
    for (let i = 0; i < probs.length; i++) {
      pick -= probs[i];
      if (pick <= 0) {
        idx = i;
        break;
      }
    }
    const probabilities = Object.fromEntries(options.map((o, i) => [o, probs[i]]));
    return { choice: options[idx], probabilities, confidence: probs[idx] };
  }
  if (type === "score") {
    const rubric = Array.isArray(q.criteria) ? q.criteria : [];
    const max = Math.max(rubric.length - 1, 0);
    const probs = normalizedProbs(rand, rubric.length ? rubric : [0]);
    const score = max === 0 ? 0 : round4(rand() * max);
    const idx = Math.min(Math.round(score), probs.length - 1);
    return {
      score,
      legend: rubric,
      probabilities: probs,
      confidence: probs[Math.max(idx, 0)] ?? 0
    };
  }
  if (type === "noul") {
    return { noul: round4(rand()) };
  }
  return { noul: round4(rand()) };
}
function jevSynthSystemone(rawBody) {
  let parsed = {};
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
  }
  const questions = parsed.questions && typeof parsed.questions === "object" ? parsed.questions : {};
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    answers[name] = synthAnswer(name, q, rawBody || "");
  }
  const answersJson = JSON.stringify(answers);
  return {
    model: "jev-1.13.0",
    answers,
    usage: {
      input_tokens: Math.ceil((rawBody || "").length / 4),
      output_tokens: Math.ceil(answersJson.length / 4)
    }
  };
}
function jevSynthModels() {
  return [{ id: "jev-latest" }];
}

// handler.js
var ASSET_UPSTREAM = "https://openapi.longbridge.com";
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-api-key,x-timestamp,x-api-signature"
};
function response(status, body, extraHeaders = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders
    },
    body: text
  };
}
var ok = (data) => response(200, { code: 0, message: "success", data });
var fail = (code, message) => response(200, { code, message, data: null });
function requireSymbol(url) {
  const symbol = url.searchParams.get("symbol");
  if (!symbol) throw Object.assign(new Error("missing required parameter: symbol"), { code: 400 });
  return symbol;
}
function requirePeriod(url) {
  const period = Number(url.searchParams.get("period"));
  if (!isValidPeriod(period)) {
    throw Object.assign(new Error(`invalid or missing period: ${url.searchParams.get("period")}`), { code: 400 });
  }
  return period;
}
function requireSymbols(url) {
  const symbols = url.searchParams.getAll("symbol").filter(Boolean).slice(0, 500);
  if (symbols.length === 0) {
    throw Object.assign(new Error("missing required parameter: symbol (repeated, max 500)"), { code: 400 });
  }
  return symbols;
}
async function handleQuote(url) {
  const live = liveEnabled();
  switch (url.pathname) {
    case "/v1/quote/candlestick": {
      const symbol = requireSymbol(url);
      const period = requirePeriod(url);
      const count = Math.min(Math.max(Number(url.searchParams.get("count")) || 100, 1), 1e3);
      const params = {
        symbol,
        period,
        count,
        adjustType: Number(url.searchParams.get("adjust_type")) || 0,
        tradeSession: Number(url.searchParams.get("trade_session")) || 0
      };
      const data = live ? await liveCandlestick(params) : demoCandlestick(symbol, period, count);
      return ok(data);
    }
    case "/v1/quote/history_candlestick": {
      const symbol = requireSymbol(url);
      const period = requirePeriod(url);
      const params = {
        symbol,
        period,
        adjustType: Number(url.searchParams.get("adjust_type")) || 0,
        startDate: url.searchParams.get("start_date"),
        endDate: url.searchParams.get("end_date")
      };
      const data = live ? await liveHistoryCandlestick(params) : demoHistoryCandlestick(symbol, period, params.startDate, params.endDate);
      return ok(data);
    }
    case "/v1/quote/quote": {
      const symbols = requireSymbols(url);
      const data = live ? await liveQuote(symbols) : demoQuote(symbols);
      return ok(data);
    }
    case "/v1/quote/static": {
      const symbols = requireSymbols(url);
      const data = live ? await liveStatic(symbols) : demoStatic(symbols);
      return ok(data);
    }
    default:
      return fail(404, `unknown endpoint: ${url.pathname}`);
  }
}
async function handleAsset(method, url, headers, body) {
  if (!liveEnabled()) {
    if (url.pathname === "/v1/asset/account") return ok(demoAssetAccount());
    if (url.pathname === "/v1/asset/stock") return ok(demoAssetStock());
    return ok({});
  }
  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("x-api-") || key === "authorization" || key === "content-type") {
      upstreamHeaders[key] = v;
    }
  }
  const upstreamBody = method === "GET" || method === "HEAD" ? void 0 : body;
  try {
    const upstream = await fetch(`${ASSET_UPSTREAM}${url.pathname}${url.search}`, {
      method,
      headers: upstreamHeaders,
      body: upstreamBody
    });
    const text = await upstream.text();
    return response(upstream.status, text);
  } catch (err) {
    return fail(-1, `asset upstream error: ${err.message}`);
  }
}
async function handleJev(method, url, headers, body) {
  if (url.pathname === "/jev/v1/systemone" && method === "POST") {
    if (jevHasAuth(headers.authorization)) {
      try {
        const r = await jevProxy("/v1/systemone", "POST", headers.authorization, body);
        return response(r.status, r.body);
      } catch (err) {
        return response(502, { error: "jev_upstream_error", message: err.message });
      }
    }
    return response(200, jevSynthSystemone(body));
  }
  if (url.pathname === "/jev/v1/models" && method === "GET") {
    if (jevHasAuth(headers.authorization)) {
      try {
        const r = await jevProxy("/v1/models", "GET", headers.authorization);
        return response(r.status, r.body);
      } catch (err) {
        return response(502, { error: "jev_upstream_error", message: err.message });
      }
    }
    return response(200, jevSynthModels());
  }
  return response(404, { error: "not_found", message: `unknown endpoint: ${url.pathname}` });
}
async function handleRequest({ method, url, headers = {}, body }) {
  try {
    if (method === "OPTIONS") {
      return { status: 204, headers: CORS_HEADERS, body: "" };
    }
    if (url.pathname === "/healthz") {
      return response(200, {
        status: "ok",
        mode: liveEnabled() ? "live" : "demo",
        jev: jevHasAuth(null) ? "proxy" : "synthetic"
      });
    }
    if (url.pathname.startsWith("/v1/quote/")) return await handleQuote(url);
    if (url.pathname.startsWith("/v1/asset/")) return await handleAsset(method, url, headers, body);
    if (url.pathname.startsWith("/jev/")) return await handleJev(method, url, headers, body);
    return response(404, { code: 404, message: `unknown endpoint: ${url.pathname}`, data: null });
  } catch (err) {
    const message = String(err?.message || err);
    let code = typeof err?.code === "number" ? err.code : -1;
    const m = /\bcode=(\d+)\b/.exec(message);
    if (code === -1 && m) code = Number(m[1]);
    return fail(code, message);
  }
}

// lambda.js
async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const rawPath = event.rawPath ?? event.path ?? "/";
  const rawQuery = event.rawQueryString ?? "";
  const url = new URL(rawPath + (rawQuery ? `?${rawQuery}` : ""), "https://lambda.local");
  let body = event.body;
  if (event.isBase64Encoded && body) body = Buffer.from(body, "base64").toString("utf8");
  const out = await handleRequest({ method, url, headers: event.headers ?? {}, body });
  return { statusCode: out.status, headers: out.headers, body: out.body };
}
export {
  handler
};
