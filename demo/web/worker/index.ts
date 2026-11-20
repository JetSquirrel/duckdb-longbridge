// DuckDB Trading Lab — Cloudflare Worker gateway.
//
//   /v1/quote/*  REAL LongPort market data over the quote socket protocol
//                (binary protobuf over WebSocket, see worker/longport.ts) when
//                LONGPORT_APP_KEY/SECRET/ACCESS_TOKEN are set; deterministic
//                synthetic data otherwise, and as fallback on any live failure
//                (x-data-source: live|synthetic|fallback)
//   /v1/asset/*  passthrough to https://openapi.longbridge.com when an
//                Authorization header is present, small synthetic payloads otherwise
//   /jev/*       proxy to https://api.typesafe.ai when the request carries
//                Authorization or TYPESAFE_API_KEY is set; deterministic
//                synthetic answers otherwise
//   /healthz     status probe
// Everything else (including /v1.5.4/wasm_eh/*.wasm) falls through to static assets.

import { lpCandlestick, lpHistoryCandlestick, lpQuote, lpStatic, LongPortCreds } from './longport';

export interface Env {
  ASSETS: Fetcher;
  TYPESAFE_API_KEY?: string;
  LONGPORT_APP_KEY?: string;
  LONGPORT_APP_SECRET?: string;
  LONGPORT_ACCESS_TOKEN?: string;
}

function longportCreds(env: Env): LongPortCreds | null {
  if (env.LONGPORT_APP_KEY && env.LONGPORT_APP_SECRET && env.LONGPORT_ACCESS_TOKEN) {
    return {
      appKey: env.LONGPORT_APP_KEY,
      appSecret: env.LONGPORT_APP_SECRET,
      accessToken: env.LONGPORT_ACCESS_TOKEN,
    };
  }
  return null;
}

// ---------------------------------------------------------------- prng ----

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(...parts: (string | number)[]): number {
  return fnv1a(parts.join('|'));
}

// ------------------------------------------------------- synthetic data ----

const DAY_MS = 86400000;
const ORIGIN = Date.UTC(2020, 0, 2);
const SESSION_START_MIN = 9 * 60 + 30;
const SESSION_END_MIN = 16 * 60;

const MINUTE_PERIODS = new Set([1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 120, 180, 240]);

interface SymbolMeta {
  anchor: number;
  name_en: string;
  name_cn: string;
  name_hk: string;
  exchange: string;
  currency: string;
  lot_size: number;
}

const KNOWN: Record<string, SymbolMeta> = {
  '700.HK': { anchor: 600, name_en: 'Tencent Holdings', name_cn: '腾讯控股', name_hk: '騰訊控股', exchange: 'HKEX', currency: 'HKD', lot_size: 100 },
  '9988.HK': { anchor: 120, name_en: 'Alibaba Group', name_cn: '阿里巴巴', name_hk: '阿里巴巴', exchange: 'HKEX', currency: 'HKD', lot_size: 100 },
  '0005.HK': { anchor: 95, name_en: 'HSBC Holdings', name_cn: '汇丰控股', name_hk: '匯豐控股', exchange: 'HKEX', currency: 'HKD', lot_size: 400 },
  'AAPL.US': { anchor: 230, name_en: 'Apple Inc', name_cn: '苹果', name_hk: '蘋果', exchange: 'NASDAQ', currency: 'USD', lot_size: 1 },
  'NVDA.US': { anchor: 150, name_en: 'NVIDIA Corp', name_cn: '英伟达', name_hk: '英偉達', exchange: 'NASDAQ', currency: 'USD', lot_size: 1 },
  'MSFT.US': { anchor: 430, name_en: 'Microsoft Corp', name_cn: '微软', name_hk: '微軟', exchange: 'NASDAQ', currency: 'USD', lot_size: 1 },
  'TSLA.US': { anchor: 250, name_en: 'Tesla Inc', name_cn: '特斯拉', name_hk: '特斯拉', exchange: 'NASDAQ', currency: 'USD', lot_size: 1 },
};

function meta(symbol: string): SymbolMeta {
  if (KNOWN[symbol]) return KNOWN[symbol];
  const suffix = symbol.split('.')[1] || '';
  return {
    anchor: 100,
    name_en: symbol,
    name_cn: symbol,
    name_hk: symbol,
    exchange: suffix === 'HK' ? 'HKEX' : suffix === 'US' ? 'NASDAQ' : suffix || 'UNKNOWN',
    currency: suffix === 'HK' ? 'HKD' : 'USD',
    lot_size: suffix === 'HK' ? 100 : 1,
  };
}

const fmt3 = (x: number) => x.toFixed(3);
const isWeekday = (ms: number) => {
  const d = new Date(ms).getUTCDay();
  return d >= 1 && d <= 5;
};

interface DayRow {
  day: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

const dailyCache = new Map<string, { today: number; rows: DayRow[] }>();

function dailySeries(symbol: string): DayRow[] {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const cached = dailyCache.get(symbol);
  if (cached && cached.today === today) return cached.rows;

  const { anchor } = meta(symbol);
  const rand = mulberry32(hashSeed(symbol));
  const rows: DayRow[] = [];
  let close = anchor * (0.6 + rand() * 0.4);
  for (let day = ORIGIN; day <= today; day += DAY_MS) {
    if (!isWeekday(day)) continue;
    const ret = (rand() - 0.5) * 0.04;
    const prevClose = close;
    close = Math.max(0.01, prevClose * (1 + ret));
    const open = prevClose * (1 + (rand() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    const volume = Math.round(anchor * 30000 * (0.5 + rand()));
    const turnover = (volume * (open + high + low + close)) / 4;
    rows.push({ day, open, high, low, close, volume, turnover });
  }
  dailyCache.set(symbol, { today, rows });
  return rows;
}

interface Candle {
  close: string;
  open: string;
  low: string;
  high: string;
  volume: number;
  turnover: string;
  timestamp: number;
  trade_session: number;
}

function dailyCandle(row: DayRow): Candle {
  return {
    close: fmt3(row.close),
    open: fmt3(row.open),
    low: fmt3(row.low),
    high: fmt3(row.high),
    volume: row.volume,
    turnover: fmt3(row.turnover),
    timestamp: Math.floor(row.day / 1000),
    trade_session: 0,
  };
}

function aggregate(rows: DayRow[], period: number): DayRow[] {
  const keyOf = (ms: number) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    if (period === 3000) return `${y}-${d.getUTCMonth()}`;
    if (period === 3500) return `${y}-Q${Math.floor(d.getUTCMonth() / 3)}`;
    if (period === 4000) return `${y}`;
    const monday = ms - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    return `W${monday}`;
  };
  const groups = new Map<string, DayRow>();
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

function intradayCandles(symbol: string, period: number, dayIndex: number, rows: DayRow[]): Candle[] {
  const row = rows[dayIndex];
  const prevClose = dayIndex > 0 ? rows[dayIndex - 1].close : row.open;
  const n = Math.max(1, Math.floor((SESSION_END_MIN - SESSION_START_MIN) / period));
  const rand = mulberry32(hashSeed(symbol, period, row.day));
  const scale = row.close * 0.003;
  const weights = Array.from({ length: n }, () => 0.3 + rand());
  const wSum = weights.reduce((a, b) => a + b, 0);
  const out: Candle[] = [];
  let w = 0;
  let last = prevClose;
  for (let i = 0; i < n; i++) {
    w += rand() - 0.5;
    const drift = prevClose + (row.close - prevClose) * ((i + 1) / n);
    const close = Math.max(0.01, drift + w * scale);
    const open = last;
    const high = Math.max(open, close) * (1 + rand() * 0.002);
    const low = Math.min(open, close) * (1 - rand() * 0.002);
    const volume = Math.round((row.volume * weights[i]) / wSum);
    out.push({
      close: fmt3(close),
      open: fmt3(open),
      low: fmt3(low),
      high: fmt3(high),
      volume,
      turnover: fmt3((volume * (open + high + low + close)) / 4),
      timestamp: Math.floor(row.day / 1000) + (SESSION_START_MIN + i * period) * 60,
      trade_session: 0,
    });
    last = close;
  }
  return out;
}

function dailyLikeCandles(symbol: string, period: number): Candle[] {
  const rows = dailySeries(symbol);
  if (period === 1000) return rows.map(dailyCandle);
  return aggregate(rows, period).map(dailyCandle);
}

function isDailyPeriod(period: number): boolean {
  return period === 1000 || period === 2000 || period === 3000 || period === 3500 || period === 4000;
}

function parseYmd(s: string | null): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function demoCandlestick(symbol: string, period: number, count: number) {
  if (isDailyPeriod(period)) {
    return { symbol, candlesticks: dailyLikeCandles(symbol, period).slice(-count) };
  }
  const rows = dailySeries(symbol);
  const slotsPerDay = Math.max(1, Math.floor((SESSION_END_MIN - SESSION_START_MIN) / period));
  const daysNeeded = Math.min(rows.length, Math.ceil(count / slotsPerDay) + 1);
  const startIdx = rows.length - daysNeeded;
  const candles: Candle[] = [];
  for (let i = startIdx; i < rows.length; i++) candles.push(...intradayCandles(symbol, period, i, rows));
  return { symbol, candlesticks: candles.slice(-count) };
}

function demoHistoryCandlestick(symbol: string, period: number, startDate: string | null, endDate: string | null) {
  const start = parseYmd(startDate);
  const end = parseYmd(endDate);
  if (isDailyPeriod(period)) {
    let candles = dailyLikeCandles(symbol, period);
    if (start !== null) candles = candles.filter((c) => c.timestamp * 1000 >= start);
    if (end !== null) candles = candles.filter((c) => c.timestamp * 1000 <= end + DAY_MS - 1);
    return { symbol, candlesticks: candles.slice(-1000) };
  }
  const rows = dailySeries(symbol);
  let lo = 0;
  let hi = rows.length - 1;
  if (start !== null) while (lo < rows.length && rows[lo].day < start) lo++;
  if (end !== null) while (hi >= 0 && rows[hi].day > end) hi--;
  const candles: Candle[] = [];
  for (let i = lo; i <= hi; i++) candles.push(...intradayCandles(symbol, period, i, rows));
  return { symbol, candlesticks: candles.slice(-1000) };
}

function demoQuote(symbols: string[]) {
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
      timestamp: Math.floor(cur.day / 1000),
      trade_status: 0,
    };
  });
  return { list };
}

function demoStatic(symbols: string[]) {
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
      total_shares: 9600000000,
      circulating_shares: 9200000000,
      hk_shares: m.currency === 'HKD' ? 9600000000 : 0,
      eps: fmt3(price * 0.05),
      eps_ttm: fmt3(price * 0.05),
      bps: fmt3(price * 0.4),
      dividend_yield: fmt3(price * 0.008),
      board: m.currency === 'HKD' ? 'HKMainBoard' : 'USMainBoard',
    };
  });
  return { list };
}

function demoAssetAccount() {
  return {
    list: [
      {
        currency: 'HKD',
        cash_infos: [
          {
            currency: 'HKD',
            withdraw_cash: '1000000.000',
            available_cash: '1000000.000',
            frozen_cash: '0.000',
            settling_cash: '0.000',
          },
        ],
        net_assets: '1250000.000',
        init_margin: '0.000',
        maintenance_margin: '0.000',
        buy_power: '1000000.000',
      },
    ],
  };
}

function isValidPeriod(period: number): boolean {
  return MINUTE_PERIODS.has(period) || [1000, 2000, 3000, 3500, 4000].includes(period);
}

// ------------------------------------------------------------- jev synth ----

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function normalizedProbs(rand: () => number, keys: unknown[]): number[] {
  const raw = keys.map(() => 0.05 + rand());
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => round4(r / sum));
}

function synthAnswer(name: string, q: any, bodyKey: string) {
  const rand = mulberry32(hashSeed(bodyKey, name));
  const type = q?.type;
  if (type === 'choice') {
    const options = Object.keys(q.criteria || {});
    if (options.length === 0) return { choice: '', probabilities: {}, confidence: 0 };
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
  if (type === 'score') {
    const rubric = Array.isArray(q.criteria) ? q.criteria : [];
    const max = Math.max(rubric.length - 1, 0);
    const probs = normalizedProbs(rand, rubric.length ? rubric : [0]);
    const score = max === 0 ? 0 : round4(rand() * max);
    const idx = Math.min(Math.round(score), probs.length - 1);
    return {
      score,
      legend: rubric,
      probabilities: probs,
      confidence: probs[Math.max(idx, 0)] ?? 0,
    };
  }
  if (type === 'noul') {
    return { noul: round4(rand()) };
  }
  return { noul: round4(rand()) };
}

function jevSynthSystemone(rawBody: string) {
  let parsed: any = {};
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    /* keep empty */
  }
  const questions = parsed.questions && typeof parsed.questions === 'object' ? parsed.questions : {};
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    answers[name] = synthAnswer(name, q, rawBody || '');
  }
  const answersJson = JSON.stringify(answers);
  return {
    model: 'jev-1.13.0',
    answers,
    usage: {
      input_tokens: Math.ceil((rawBody || '').length / 4),
      output_tokens: Math.ceil(answersJson.length / 4),
    },
  };
}

// --------------------------------------------------------------- routing ----

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key,x-timestamp,x-api-signature',
};

function send(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

const ok = (data: unknown, extraHeaders: Record<string, string> = {}) =>
  send(200, { code: 0, message: 'success', data }, extraHeaders);
const fail = (code: number, message: string) => send(200, { code, message, data: null });

class HttpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function requireSymbol(url: URL): string {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) throw new HttpError(400, 'missing required parameter: symbol');
  return symbol;
}

function requirePeriod(url: URL): number {
  const period = Number(url.searchParams.get('period'));
  if (!isValidPeriod(period)) {
    throw new HttpError(400, `invalid or missing period: ${url.searchParams.get('period')}`);
  }
  return period;
}

function requireSymbols(url: URL): string[] {
  const symbols = url.searchParams.getAll('symbol').filter(Boolean).slice(0, 500);
  if (symbols.length === 0) {
    throw new HttpError(400, 'missing required parameter: symbol (repeated, max 500)');
  }
  return symbols;
}

// Runs the live LongPort call and falls back to the synthetic generator on
// ANY failure (socket, auth, upstream error code, timeout), tagging the
// response with x-data-source so callers can tell which path served it.
async function quoteWithFallback<T>(
  creds: LongPortCreds | null,
  live: (c: LongPortCreds) => Promise<T>,
  demo: () => T,
): Promise<{ data: T; headers: Record<string, string> }> {
  if (!creds) return { data: demo(), headers: { 'x-data-source': 'synthetic' } };
  try {
    return { data: await live(creds), headers: { 'x-data-source': 'live' } };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    console.log(`longport live quote failed, falling back to synthetic: ${message}`);
    return {
      data: demo(),
      headers: { 'x-data-source': 'fallback', 'x-live-error': message.slice(0, 200) },
    };
  }
}

async function handleQuote(url: URL, env: Env): Promise<Response> {
  const creds = longportCreds(env);
  switch (url.pathname) {
    case '/v1/quote/candlestick': {
      const symbol = requireSymbol(url);
      const period = requirePeriod(url);
      const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 100, 1), 1000);
      const adjustType = Number(url.searchParams.get('adjust_type')) === 1 ? 1 : 0;
      const tradeSession = Number(url.searchParams.get('trade_session')) === 1 ? 1 : 0;
      const { data, headers } = await quoteWithFallback(
        creds,
        (c) => lpCandlestick(c, { symbol, period, count, adjustType, tradeSession }),
        () => demoCandlestick(symbol, period, count),
      );
      return ok(data, headers);
    }
    case '/v1/quote/history_candlestick': {
      const symbol = requireSymbol(url);
      const period = requirePeriod(url);
      const adjustType = Number(url.searchParams.get('adjust_type')) === 1 ? 1 : 0;
      const startDate = url.searchParams.get('start_date') || '';
      const endDate = url.searchParams.get('end_date') || '';
      const { data, headers } = await quoteWithFallback(
        creds,
        (c) => lpHistoryCandlestick(c, { symbol, period, adjustType, startDate, endDate }),
        () => demoHistoryCandlestick(symbol, period, url.searchParams.get('start_date'), url.searchParams.get('end_date')),
      );
      return ok(data, headers);
    }
    case '/v1/quote/quote': {
      const symbols = requireSymbols(url);
      const { data, headers } = await quoteWithFallback(
        creds,
        (c) => lpQuote(c, symbols),
        () => demoQuote(symbols),
      );
      return ok(data, headers);
    }
    case '/v1/quote/static': {
      const symbols = requireSymbols(url);
      const { data, headers } = await quoteWithFallback(
        creds,
        (c) => lpStatic(c, symbols),
        () => demoStatic(symbols),
      );
      return ok(data, headers);
    }
    default:
      return fail(404, `unknown endpoint: ${url.pathname}`);
  }
}

// Per-endpoint TTLs (seconds) for quote responses. Only successful LIVE
// payloads are cached: synthetic data is instant anyway, and fallback
// responses must stay self-healing once the upstream recovers. Entries are
// validated against their stored x-cache-ts on read (caches.default does not
// expire entries on its own).
const QUOTE_CACHE_TTL_SECONDS: Record<string, number> = {
  '/v1/quote/candlestick': 300,
  '/v1/quote/history_candlestick': 300,
  '/v1/quote/quote': 30,
  '/v1/quote/static': 86400,
};

async function cachedQuote(
  url: URL,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const ttl = QUOTE_CACHE_TTL_SECONDS[url.pathname];
  if (!ttl) return handleQuote(url, env);
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    const ageMs = Date.now() - Number(hit.headers.get('x-cache-ts') || 0);
    if (ageMs >= 0 && ageMs < ttl * 1000) {
      const headers = new Headers(hit.headers);
      headers.set('x-cache', 'HIT');
      return new Response(hit.body, { status: 200, headers });
    }
  }
  const res = await handleQuote(url, env);
  if (res.headers.get('x-data-source') === 'live') {
    const headers = new Headers(res.headers);
    headers.set('x-cache-ts', String(Date.now()));
    const entry = new Response(res.clone().body, { status: 200, headers });
    ctx.waitUntil(caches.default.put(cacheKey, entry));
  }
  res.headers.set('x-cache', 'MISS');
  return res;
}

const ASSET_UPSTREAM = 'https://openapi.longbridge.com';

async function handleAsset(request: Request, url: URL): Promise<Response> {
  if (!request.headers.get('authorization')) {
    if (url.pathname === '/v1/asset/account') return ok(demoAssetAccount());
    if (url.pathname === '/v1/asset/stock') return ok({ list: [] });
    return ok({});
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (key.startsWith('x-api-') || key === 'authorization' || key === 'content-type') {
      headers[key] = value;
    }
  });
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  try {
    const upstream = await fetch(`${ASSET_UPSTREAM}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
    });
    const text = await upstream.text();
    return send(upstream.status, text);
  } catch (err) {
    return fail(-1, `asset upstream error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const JEV_UPSTREAM = 'https://api.typesafe.ai';
// The Worker -> upstream fetch occasionally hangs for tens of seconds while a
// direct connection answers in ~1s. Cap each attempt at 8s and retry twice
// (short fixed backoff) so a stuck socket can't dominate the response time.
const JEV_UPSTREAM_TIMEOUT_MS = 8000;
const JEV_UPSTREAM_RETRIES = 2;

async function fetchJevUpstream(
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= JEV_UPSTREAM_RETRIES; attempt++) {
    try {
      return await fetch(`${JEV_UPSTREAM}${path}`, {
        ...init,
        signal: AbortSignal.timeout(JEV_UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < JEV_UPSTREAM_RETRIES) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

function jevAuth(env: Env, incoming: string | null): string | null {
  if (!env.TYPESAFE_API_KEY) return incoming;
  return incoming ?? `Bearer ${env.TYPESAFE_API_KEY}`;
}

async function handleJev(request: Request, url: URL, env: Env): Promise<Response> {
  // The web app sends the placeholder key 'demo' when no TypeSafe key is
  // entered; like the sidecar's demo mode, that must get synthetic answers,
  // not an upstream 401.
  const rawAuth = request.headers.get('authorization');
  const incoming = rawAuth === 'Bearer demo' ? null : rawAuth;
  const auth = jevAuth(env, incoming);

  if (url.pathname === '/jev/v1/systemone' && request.method === 'POST') {
    const body = await request.text();
    if (auth) {
      try {
        const upstream = await fetchJevUpstream('/v1/systemone', {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body,
        });
        return send(upstream.status, await upstream.text());
      } catch (err) {
        return send(502, { error: 'jev_upstream_error', message: err instanceof Error ? err.message : String(err) });
      }
    }
    return send(200, jevSynthSystemone(body));
  }

  if (url.pathname === '/jev/v1/models' && request.method === 'GET') {
    if (auth) {
      try {
        const upstream = await fetchJevUpstream('/v1/models', {
          method: 'GET',
          headers: { authorization: auth },
        });
        return send(upstream.status, await upstream.text());
      } catch (err) {
        return send(502, { error: 'jev_upstream_error', message: err instanceof Error ? err.message : String(err) });
      }
    }
    return send(200, [{ id: 'jev-latest' }]);
  }

  return send(404, { error: 'not_found', message: `unknown endpoint: ${url.pathname}` });
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    // Collapse repeated slashes so a jev endpoint entered with a trailing
    // slash (…/jev/ + /v1/systemone → /jev//v1/systemone) still routes.
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/healthz') {
        return send(200, {
          status: 'ok',
          mode: longportCreds(env) ? 'live' : 'demo',
          quotes: longportCreds(env) ? 'live' : 'demo',
          jev: env.TYPESAFE_API_KEY ? 'live' : 'synthetic',
        });
      }
      if (url.pathname.startsWith('/v1/quote/')) return await cachedQuote(url, env, ctx);
      if (url.pathname.startsWith('/v1/asset/')) return await handleAsset(request, url);
      if (url.pathname.startsWith('/jev/')) return await handleJev(request, url, env);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      let code = err instanceof HttpError ? err.code : -1;
      const m = /\bcode=(\d+)\b/.exec(message);
      if (code === -1 && m) code = Number(m[1]);
      return fail(code, message);
    }

    // Static assets: the SPA itself and the wasm extension repository
    // (/v1.5.4/wasm_eh/*.duckdb_extension.wasm).
    return env.ASSETS.fetch(request);
  },
};
