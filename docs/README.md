# Longbridge DuckDB Extension

A DuckDB extension that turns the [Longbridge OpenAPI](https://open.longbridge.com/) into SQL table functions: query quotes, instrument metadata, candlestick (K-line) history, account balances and stock positions straight from DuckDB.

## Install & load

```sql
INSTALL longbridge FROM community;
LOAD longbridge;
```

For a local development build, run `make debug` (or `GEN=ninja make`), then start the shell at `./build/debug/duckdb` — the extension is linked in, just `LOAD longbridge;`.

## Configuring credentials

All functions require a Longbridge OpenAPI app key, app secret and access token. Provide them either as DuckDB extension options:

```sql
SET longbridge_app_key = '<key>';
SET longbridge_app_secret = '<secret>';
SET longbridge_access_token = '<token>';
SET longbridge_region = 'cn';   -- optional; 'cn' selects openapi.longbridge.cn, anything else openapi.longbridge.com
```

or as environment variables (`LONGBRIDGE_APP_KEY`, `LONGBRIDGE_APP_SECRET`, `LONGBRIDGE_ACCESS_TOKEN`, `LONGBRIDGE_REGION`; the legacy `LONGPORT_*` variants are also accepted). Extension options take precedence over environment variables.

## Function reference

### `longbridge_quote(symbol)` → real-time quotes

`symbol` is a `VARCHAR` (e.g. `'700.HK'`) or a `LIST(VARCHAR)` for a batch (max 500 per request, chunked automatically).

```sql
SELECT * FROM longbridge_quote('700.HK');
SELECT * FROM longbridge_quote(['700.HK', 'AAPL.US']);
```

Columns: `symbol`, `last_done`, `prev_close`, `open`, `high`, `low`, `timestamp`, `volume`, `turnover`, `trade_status`.

### `longbridge_instruments(symbol)` → static instrument info

Same argument shape as `longbridge_quote`.

```sql
SELECT symbol, name_en, exchange, currency, lot_size FROM longbridge_instruments('AAPL.US');
```

Columns: `symbol`, `name_cn`, `name_en`, `name_hk`, `exchange`, `currency`, `lot_size`, `total_shares`, `circulating_shares`, `eps`, `eps_ttm`, `bps`, `dividend_yield`, `board`.

### `longbridge_bars(symbol, period [, count [, adjust_type]])` → recent candlesticks

- `period`: `1m` … `60m`, `1h`–`4h`, `day`, `week`, `month`, `quarter`, `year` (case-insensitive)
- `count`: 1–1000, default 100
- `adjust_type`: `'no'` (default) or `'forward'`

```sql
SELECT * FROM longbridge_bars('700.HK', 'day', 30);
SELECT * FROM longbridge_bars('AAPL.US', '60m', 100, 'forward');
```

### `longbridge_history_bars(symbol, period, start_date, end_date [, adjust_type])` → candlesticks by date range

`start_date`/`end_date` are `DATE`s (sent to the API as `YYYYMMDD` with `query_type=2`).

```sql
SELECT * FROM longbridge_history_bars('700.HK', 'day', DATE '2024-01-01', DATE '2024-03-01');
```

Both bar functions return: `symbol`, `timestamp`, `open`, `high`, `low`, `close`, `volume`, `turnover`, `trade_session`.

### `longbridge_account()` → account balances

One row per account × currency, with cash breakdown, financing and margin figures.

```sql
SELECT currency, total_cash, available_cash, buy_power, net_assets FROM longbridge_account();
```

### `longbridge_positions()` → stock positions

One row per held position across all account channels.

```sql
SELECT symbol, symbol_name, quantity, available_quantity, cost_price FROM longbridge_positions();
```

## API surface status

- **Asset endpoints** (`/v1/asset/account`, `/v1/asset/stock` — backing `longbridge_account` / `longbridge_positions`) work against the live gateway today.
- **Quote endpoints** (`/v1/quote/quote`, `/v1/quote/static`, `/v1/quote/candlestick`, `/v1/quote/history_candlestick` — backing `longbridge_quote` / `longbridge_instruments` / `longbridge_bars` / `longbridge_history_bars`) currently return `404 api not found` from the gateway: Longbridge moved quote pull to the WebSocket (WSS) protocol. These four functions are implemented against the documented REST scheme and will start working once a WSS transport is added (planned).

## Running the tests

```sh
make test        # or: build/debug/test/unittest "test/*"
```

Live-call assertions in the SQL tests are gated behind `require-env LONGBRIDGE_ACCESS_TOKEN` and are skipped unless real credentials are present in the environment.
