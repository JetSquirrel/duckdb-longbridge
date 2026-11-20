# duckdb-trading-lab-sidecar

Local sidecar gateway for the DuckDB Longbridge/Jev trading demo. A DuckDB
extension (native or duckdb-wasm in a browser) makes plain HTTP GET/POST calls
to this service; the sidecar answers with LongPort market quotes, proxies
`/v1/asset/*` to the real REST host, proxies Jev AI requests to
`api.typesafe.ai`, and adds CORS headers to everything.

No build step. Node >= 20 (developed on v26.5.0), plain ESM, one dependency
(the official `longport` Node SDK).

## Quick start

```bash
cd demo/sidecar
npm install
npm start          # listens on http://localhost:8787
```

With **no environment variables set** the service runs in zero-credentials
DEMO mode: deterministic synthetic market data and synthesized Jev answers.
The whole demo runs without any API keys.

## Modes

| Concern | LIVE mode (credentials present) | DEMO mode (no credentials) |
|---|---|---|
| `/v1/quote/*` | Real LongPort data via the official Node SDK | Deterministic synthetic random-walk data |
| `/v1/asset/*` | Verbatim passthrough to `https://openapi.longbridge.com` | Synthetic account / empty positions |
| `/jev/*` | Proxied to `https://api.typesafe.ai` (incoming Authorization header, or `TYPESAFE_API_KEY` injected when absent) | synthesized |

### Environment variables

| Variable | Effect |
|---|---|
| `PORT` | Listen port (default `8787`) |
| `LONGPORT_APP_KEY` | LongPort app key — enables LIVE quote mode when all three are set |
| `LONGPORT_APP_SECRET` | LongPort app secret |
| `LONGPORT_ACCESS_TOKEN` | LongPort access token |
| `TYPESAFE_API_KEY` | Injected as `Authorization: Bearer ...` for `/jev/*` when the request carries no Authorization header |

Env vars are also read from a local `.env` file (`node --env-file-if-exists`, gitignored).
The placeholder `Authorization: Bearer demo` (sent by the web app when no key is entered)
is treated as absent in both modes, so a server-side `TYPESAFE_API_KEY` still applies.

## Endpoints

Envelope for all `/v1/*` endpoints: `{"code":0,"message":"success","data":...}`.
Upstream failures return HTTP 200 with `{"code":<code>,"message":<msg>,"data":null}`
(LongPort upstream error codes are passed through).

- `GET /v1/quote/candlestick?symbol=700.HK&period=1000&count=100&adjust_type=0[&trade_session=0]`
  → `data: {"symbol", "candlesticks": [{close, open, low, high, volume, turnover, timestamp, trade_session}]}`.
  Prices/turnover are strings, volume/timestamp ints, timestamp = unix seconds.
  `period`: 1,2,3,5,10,15,20,30,45,60,120,180,240 (minutes), 1000=day, 2000=week,
  3000=month, 3500=quarter, 4000=year. `adjust_type`: 0=no, 1=forward
  (ignored in demo mode). `count` capped at 1000.
- `GET /v1/quote/history_candlestick?symbol&period&adjust_type&query_type=2&start_date=YYYYMMDD&end_date=YYYYMMDD`
  → same candlestick shape; candles within the date range, max 1000 nearest `end_date`.
- `GET /v1/quote/quote?symbol=700.HK[&symbol=AAPL.US...]` (repeated param, max 500)
  → `data: {"list": [{symbol, last_done, prev_close, open, high, low, volume, turnover, timestamp, trade_status}]}`.
- `GET /v1/quote/static?symbol=...&symbol=...`
  → `data: {"list": [{symbol, name_en, name_cn, name_hk, exchange, currency, lot_size, ...}]}`.
- `ANY /v1/asset/*` — LIVE: passthrough to `https://openapi.longbridge.com`
  (method, query string, body and all `x-api-*` / `authorization` / `content-type`
  headers forwarded verbatim; upstream status + body returned). DEMO:
  synthetic account for `/v1/asset/account`, empty list for `/v1/asset/stock`,
  empty object for everything else.
- `POST /jev/v1/systemone` — in LIVE mode (TYPESAFE_API_KEY set) proxied to
  `https://api.typesafe.ai/v1/systemone` (Authorization passthrough, or the env
  key injected when the request carries none). In DEMO mode (no env key),
  answers are **synthesized deterministically** (seeded from the
  request body hash): `choice` → `{choice, probabilities, confidence}`,
  `score` → `{score, legend, probabilities, confidence}`, `noul` → `{noul}`.
  Response shape: `{"model":"jev-1.13.0","answers":{...},"usage":{...}}`.
- `GET /jev/v1/models` — proxied, or synthetic `[{"id":"jev-latest"}]`.
- `GET /healthz` — `{"status":"ok","mode":"live|demo","jev":"proxy|synthetic"}`.

CORS on **all** endpoints: `Access-Control-Allow-Origin: *`; OPTIONS preflight
allows headers `authorization,content-type,x-api-key,x-timestamp,x-api-signature`.

## Live mode status

**Implemented via option (1): the official `longport` Node SDK** (v4.3.7,
napi wrapper around the Rust protobuf/WebSocket core). It installs and loads
cleanly on macOS arm64 / Node 26. The raw-protocol fallback (option 2) was
therefore not needed and is not implemented.

Verified on this machine: the SDK connects and authenticates far enough to
receive a real upstream auth error — with dummy credentials the endpoints
return `{"code":401004,"message":"openapi error: code=401004: token invalid","data":null}`
(HTTP 200) and the server keeps running. It has **not** been verified against
a real funded LongPort account; if your account's quote level lacks a
permission, the upstream error code/message is passed through in the same way.

Live-mode mapping notes:

- `period` numbers map to the SDK's `Period` enum (`1000→Day`, `60→Min_60`, ...).
- `trade_session=0→TradeSessions.Intraday`, `1→TradeSessions.All`.
- Decimals are rendered with 3 decimal places (`"362.000"` style).

## Demo mode notes

- Seeded PRNG (mulberry32 over `fnv1a(symbol)`) random-walk from a fixed
  origin (2020-01-02): every candle is a pure function of
  (symbol, period, date), so output is **identical across restarts**.
- Anchors: `700.HK≈600`, `AAPL.US≈230`, `NVDA.US≈150`, everything else ≈100
  (plus built-in names for 9988.HK, 0005.HK, MSFT.US, TSLA.US).
- Weekends are skipped; intraday periods emit candles only within a
  09:30–16:00 (UTC) session on weekdays. For minute periods that do not divide
  the 390-minute session evenly, the tail of the session is simply not covered.
- `adjust_type` is accepted but ignored (synthetic data needs no adjustment).

## Files

```
demo/sidecar/
├── package.json      # npm start → node server.js; dep: longport
├── server.js         # HTTP server, routing, CORS, asset proxy
├── lib/demo.js       # deterministic synthetic market data
├── lib/live.js       # LongPort SDK wrapper (lazy-loaded, LIVE mode only)
├── lib/jev.js        # Jev proxy + deterministic synthesis
└── lib/prng.js       # fnv1a / mulberry32 helpers
```
