export interface PresetQuery {
  label: string;
  sql: string;
}

// NOTE: jev functions do one HTTP request per evaluated row, so LIMIT must be
// applied in a subquery BEFORE the jev_* projection — otherwise jev_ask runs on
// every bar (hundreds of rows) instead of just the handful being displayed.
export const DEFAULT_QUERY = `WITH market AS (
    SELECT * FROM longbridge_history_bars('700.HK', 'day', DATE '2026-08-21', DATE '2026-09-21')
),
features AS (
    SELECT *, avg(close) OVER (ORDER BY "timestamp" ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
           lead(close) OVER (ORDER BY "timestamp") AS next_close
    FROM market
),
recent AS (
    SELECT * FROM features ORDER BY "timestamp" DESC LIMIT 10
),
scored AS (
    SELECT "timestamp", close, round(ma20, 2) AS ma20, next_close,
           jev_ask(concat('Symbol: 700.HK', chr(10), 'Close: ', close, chr(10), 'MA20: ', ma20),
                   {action: MAP{'buy': 'conditions support buying', 'hold': 'conditions support holding', 'sell': 'conditions support selling'},
                    risk: ['low', 'medium', 'high']}) AS signal
    FROM recent
)
SELECT "timestamp", close, ma20, signal,
       CASE signal.action
           WHEN 'buy'  THEN round((next_close - close) / close * 100, 2)
           WHEN 'sell' THEN round((close - next_close) / close * 100, 2)
       END AS next_day_pnl_pct
FROM scored
ORDER BY "timestamp" DESC;`;

export const PRESET_QUERIES: PresetQuery[] = [
  { label: '700.HK · MA20 + AI signal (longbridge × jev)', sql: DEFAULT_QUERY },
  {
    label: '700.HK · MA20 crossover signals (pure SQL)',
    sql: `WITH market AS (
    SELECT * FROM longbridge_history_bars('700.HK', 'day', DATE '2026-08-21', DATE '2026-09-21')
),
features AS (
    SELECT *, avg(close) OVER (ORDER BY "timestamp" ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20
    FROM market
),
signals AS (
    SELECT *,
           lag(close) OVER (ORDER BY "timestamp") AS prev_close,
           lag(ma20) OVER (ORDER BY "timestamp") AS prev_ma20
    FROM features
)
SELECT "timestamp", close, round(ma20, 2) AS ma20,
       CASE
           WHEN prev_close <= prev_ma20 AND close > ma20 THEN 'buy'
           WHEN prev_close >= prev_ma20 AND close < ma20 THEN 'sell'
           ELSE 'hold'
       END AS signal
FROM signals
WHERE prev_ma20 IS NOT NULL
ORDER BY "timestamp" DESC;`,
  },
  {
    label: 'AAPL.US · latest 10 daily bars + jev_choice classification',
    sql: `WITH bars AS (
    SELECT * FROM longbridge_bars('AAPL.US', 'day', 30)
),
recent AS (
    SELECT * FROM bars ORDER BY "timestamp" DESC LIMIT 10
)
SELECT "timestamp", close, volume,
       jev_choice(concat('Symbol: AAPL.US', chr(10), 'Close: ', close, chr(10), 'Volume: ', volume),
                  MAP{'bullish': 'price action looks strong', 'bearish': 'price action looks weak',
                      'neutral': 'no clear direction'}) AS sentiment
FROM recent
ORDER BY "timestamp" DESC;`,
  },
  {
    label: '700.HK · buy→sell signal P&L backtest (pure SQL)',
    sql: `WITH market AS (
    SELECT * FROM longbridge_history_bars('700.HK', 'day', DATE '2026-08-21', DATE '2026-09-21')
),
features AS (
    SELECT *, avg(close) OVER (ORDER BY "timestamp" ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20
    FROM market
),
events AS (
    SELECT "timestamp", close, signal,
           lead("timestamp") OVER (ORDER BY "timestamp") AS exit_ts,
           lead(close) OVER (ORDER BY "timestamp") AS exit_close
    FROM (
        SELECT "timestamp", close,
               CASE
                   WHEN lag(close) OVER w <= lag(ma20) OVER w AND close > ma20 THEN 'buy'
                   WHEN lag(close) OVER w >= lag(ma20) OVER w AND close < ma20 THEN 'sell'
               END AS signal
        FROM features
        WINDOW w AS (ORDER BY "timestamp")
    )
    WHERE signal IS NOT NULL
),
trades AS (
    SELECT "timestamp" AS buy_ts, close AS buy_close,
           exit_ts AS sell_ts, exit_close AS sell_close,
           (exit_close - close) / close AS ret
    FROM events
    WHERE signal = 'buy' AND exit_ts IS NOT NULL
)
SELECT buy_ts, buy_close, sell_ts, sell_close,
       round(ret * 100, 2) AS pnl_pct,
       round((exp(sum(ln(1 + ret)) OVER (ORDER BY buy_ts)) - 1) * 100, 2) AS cum_pnl_pct
FROM trades
ORDER BY buy_ts;`,
  },
  {
    label: '700.HK · whole-table AI signal in 1 API call (jev, ~4s → ~1s)',
    // One-shot variant of the default query: the 10 recent bars (with MA20)
    // are packed into a single JSON state string, so jev_ask is evaluated on
    // exactly one row = one HTTP round-trip instead of ten. On the browser
    // (serial HTTP) this cuts the AI step from ~4s to under ~1s.
    // NB: built with string_agg/format rather than json_group_array — the
    // duckdb-wasm bundle autoloads the 'json' extension for those, and the
    // same-origin extension repo only ships longbridge/jev.
    sql: `WITH market AS (
    SELECT * FROM longbridge_history_bars('700.HK', 'day', DATE '2026-01-01', DATE '2026-09-21')
),
features AS (
    SELECT *, avg(close) OVER (ORDER BY "timestamp" ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20
    FROM market
),
recent AS (
    SELECT * FROM features ORDER BY "timestamp" DESC LIMIT 10
)
SELECT jev_ask((SELECT concat('Symbol: 700.HK recent daily bars (newest first):', chr(10), '[',
                              string_agg(format('{{"timestamp": "{}", "open": {}, "high": {}, "low": {}, "close": {}, "volume": {}, "ma20": {}}}',
                                                "timestamp", open, high, low, close, volume, round(ma20, 2)),
                                         ','),
                              ']')
                FROM recent),
               {action: MAP{'buy': 'conditions support buying', 'hold': 'conditions support holding', 'sell': 'conditions support selling'},
                risk: ['low', 'medium', 'high']}) AS signal
FROM (VALUES (1)) _(x);`,
  },
  {
    label: 'jev_usage() · AI cost check',
    sql: `SELECT * FROM jev_usage();`,
  },
];
