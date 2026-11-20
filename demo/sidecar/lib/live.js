// LIVE mode: real LongPort quotes via the official Node SDK (longport),
// which wraps the Rust protobuf/WebSocket core via napi.
//
// Activated only when LONGPORT_APP_KEY + LONGPORT_APP_SECRET +
// LONGPORT_ACCESS_TOKEN are all set. Any failure surfaces as an error
// envelope to the caller; it must never crash the server.

const PERIOD_MAP = {
  1: 'Min_1', 2: 'Min_2', 3: 'Min_3', 5: 'Min_5', 10: 'Min_10', 15: 'Min_15',
  20: 'Min_20', 30: 'Min_30', 45: 'Min_45', 60: 'Min_60', 120: 'Min_120',
  180: 'Min_180', 240: 'Min_240', 1000: 'Day', 2000: 'Week', 3000: 'Month',
  3500: 'Quarter', 4000: 'Year',
};

let LP = null;
let ctx = null;

export function liveEnabled() {
  return Boolean(
    process.env.LONGPORT_APP_KEY &&
      process.env.LONGPORT_APP_SECRET &&
      process.env.LONGPORT_ACCESS_TOKEN
  );
}

async function getCtx() {
  if (ctx) return ctx;
  LP = await import('longport');
  const config = LP.Config.fromApikey(
    process.env.LONGPORT_APP_KEY,
    process.env.LONGPORT_APP_SECRET,
    process.env.LONGPORT_ACCESS_TOKEN
  );
  ctx = LP.QuoteContext.new(config);
  return ctx;
}

const dec = (d) => {
  const n = Number(d?.toString?.() ?? d);
  return Number.isFinite(n) ? n.toFixed(3) : String(d);
};
const secs = (d) => Math.floor(new Date(d).getTime() / 1000);

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
    trade_session: Number(c.tradeSession ?? 0),
  };
}

function parseYmd(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}

export async function liveCandlestick({ symbol, period, count, adjustType, tradeSession }) {
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

export async function liveHistoryCandlestick({ symbol, period, adjustType, startDate, endDate }) {
  const q = await getCtx();
  const s = parseYmd(startDate);
  const e = parseYmd(endDate);
  const rows = await q.historyCandlesticksByDate(
    symbol,
    mapPeriod(period),
    mapAdjust(adjustType),
    s ? new LP.NaiveDate(s.y, s.mo, s.d) : null,
    e ? new LP.NaiveDate(e.y, e.mo, e.d) : null,
    LP.TradeSessions.Intraday
  );
  // nearest end_date, max 1000
  return { symbol, candlesticks: rows.map(mapCandle).slice(-1000) };
}

export async function liveQuote(symbols) {
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
    trade_status: Number(r.tradeStatus ?? 0),
  }));
  return { list };
}

export async function liveStatic(symbols) {
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
    board: String(r.board ?? ''),
  }));
  return { list };
}
