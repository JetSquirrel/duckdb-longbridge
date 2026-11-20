# duckdb-longbridge — DuckDB Extension Trading Lab

Two composable DuckDB extensions that run natively **and** inside DuckDB-Wasm in the
browser, plus a thin demo web app:

```
Web UI (demo/web, thin SQL workspace)
  └── DuckDB-Wasm (official eh bundle, DuckDB v1.5.4)
        ├── longbridge extension (wasm side module) ──HTTP──> sidecar ──WS──> LongPort OpenAPI
        └── jev extension (wasm side module)        ──HTTP──> sidecar ──> api.typesafe.ai
```

The point of the demo: **extensions compose in SQL** — market data in, window functions
for features, typed AI decisions out, all in one query:

```sql
WITH market AS (
    SELECT * FROM longbridge_history_bars('700.HK', 'day', DATE '2026-01-01', DATE '2026-09-21')
),
features AS (
    SELECT *, avg(close) OVER (ORDER BY "timestamp" ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20
    FROM market
),
recent AS (
    SELECT * FROM features ORDER BY "timestamp" DESC LIMIT 10
)
SELECT "timestamp", close, round(ma20, 2) AS ma20,
       jev_ask(concat('Symbol: 700.HK', chr(10), 'Close: ', close, chr(10), 'MA20: ', ma20),
               {action: MAP{'buy': 'conditions support buying', 'hold': 'conditions support holding',
                            'sell': 'conditions support selling'},
                risk: ['low', 'medium', 'high']}) AS signal
FROM recent
ORDER BY "timestamp" DESC;
```

(`jev_*` does one HTTP request per evaluated row — the `LIMIT` lives in the `recent`
subquery so jev only sees the 10 displayed rows, not all ~190 bars.)

## Repository layout

| Path | What |
|---|---|
| `src/` | `longbridge` extension: `longbridge_bars`, `longbridge_history_bars`, `longbridge_quote`, `longbridge_instruments`, `longbridge_account`, `longbridge_positions` |
| `jev/` | `jev` extension, vendored from [colliber/duckdb-jev](https://github.com/colliber/duckdb-jev) (MIT) and patched: cpp-httplib/OpenSSL replaced by `duckdb::HTTPUtil`, single-threaded under Emscripten. Functions: `jev_ask`, `jev_choice`, `jev_score`, `jev_noul`, `jev_usage`; `CREATE SECRET (TYPE jev, ...)` |
| `httpfs/` | clone of duckdb/duckdb-httpfs @ `c3f215a` (the commit DuckDB v1.5.4 pins). Needed natively because DuckDB-core's built-in HTTP client cannot POST; not needed in duckdb-wasm |
| `demo/sidecar/` | local gateway (Node, port 8787): serves LongPort-shaped `/v1/quote/*` JSON (real LongPort data is protobuf-over-WebSocket; the sidecar translates via the official SDK), proxies `/v1/asset/*` and `/jev/*`, adds CORS, and has a zero-credentials **demo mode** with deterministic synthetic data |
| `demo/web/` | "DuckDB Trading Lab" web app (Vite + React): loads both unsigned wasm extensions into official `@duckdb/duckdb-wasm@1.33.1-dev57.0`, SQL workspace + result grid |
| `test/sql/` | sqllogictests (`make test_debug`) |

The `longbridge` extension itself builds against **DuckDB v2.0.0** (the duckdb submodule)
and is published as a DuckDB community extension (`INSTALL longbridge FROM community`;
draft entry in `community/description.yml`).

The trading-lab demo is pinned to **DuckDB v1.5.4** (httpfs commit, jev upstream,
duckdb-wasm npm) and **emsdk 3.1.71** — extension and engine versions must match exactly
for wasm side-module loading, so build the lab with the duckdb submodule checked out at
`v1.5.4` (`git -C duckdb checkout v1.5.4`, and `extension-ci-tools` at `v1.5.4`).

## Run the demo (no API keys needed)

The prebuilt wasm extensions are already in `demo/web/public/v1.5.4/wasm_eh/`.

```sh
cd demo/sidecar && npm install && npm start        # terminal 1 → http://localhost:8787 (demo mode)
cd demo/web && npm install && npm run dev          # terminal 2 → http://localhost:5173
```

Click "Connect / Reload extensions" (both pills should turn green), then Run the default
query. Demo mode serves synthetic market data and synthetic Jev answers; enter a real
TypeSafe API key in the config panel (or export `TYPESAFE_API_KEY` for the sidecar) and
real LongPort credentials (`LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` /
`LONGPORT_ACCESS_TOKEN` for the sidecar) to go live. See `demo/sidecar/README.md`.

## Build

`extension_config.cmake` builds `longbridge` only — that is what DuckDB's
community-extensions CI and `MainDistributionPipeline` build. The lab build that also
bundles `jev` and `httpfs` is `extension_config_lab.cmake`; pass it as `EXT_CONFIG`.

Native extension only (macOS arm64, shell + unittest at `build/release/`):

```sh
GEN=ninja make release
make test_release
```

Native lab shell with jev + httpfs (at `build/debug/`, duckdb submodule at v1.5.4):

```sh
make debug EXT_CONFIG=$PWD/extension_config_lab.cmake
make test_debug EXT_CONFIG=$PWD/extension_config_lab.cmake
```

The native lab shell needs `LOAD httpfs;` before jev functions (DuckDB-core's built-in HTTP
client cannot POST; httpfs installs a POST-capable `HTTPUtil`).

Wasm loadable extensions (wasm_eh side modules):

```sh
source .cache/emsdk/emsdk_env.sh                   # emsdk 3.1.71 (install: .cache/emsdk)
export EMSDK=$PWD/.cache/emsdk
export VCPKG_ROOT=$PWD/.cache/vcpkg                # vcpkg @ 84bab45, bootstrapped
export VCPKG_TOOLCHAIN_PATH=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
export VCPKG_TARGET_TRIPLET=wasm32-emscripten
export VCPKG_OVERLAY_PORTS=$PWD/extension-ci-tools/vcpkg_ports
export VCPKG_OVERLAY_TRIPLETS=$PWD/extension-ci-tools/toolchains
GEN=ninja make wasm_eh EXT_CONFIG=$PWD/extension_config_lab.cmake  # configures (emmake step then fails — known ci-tools quirk)
ninja -C build/wasm_eh                             # actually builds
cp build/wasm_eh/extension/longbridge/longbridge.duckdb_extension.wasm \
   build/wasm_eh/extension/jev/jev.duckdb_extension.wasm \
   demo/web/public/v1.5.4/wasm_eh/
```

Host prerequisites: `pkgconf` (Homebrew), cmake, ninja. The web app loads the unsigned
extensions with `allowUnsignedExtensions: true` + `SET custom_extension_repository`,
which fetches `<origin>/v1.5.4/wasm_eh/<name>.duckdb_extension.wasm`.

## Verification

- `make test_debug` — sqllogictests (live blocks skipped without `LONGBRIDGE_ACCESS_TOKEN`)
- `node demo/web/scripts/smoke.mjs` — version + LOAD check of both wasm extensions (Node)
- `node demo/web/scripts/functional-node.mjs` — function registration + bind path (Node)
- `node demo/web/scripts/e2e-browser.mjs` — headless-Chrome end-to-end: sidecar + dev
  server, loads both extensions, runs the default query, asserts the grid

## Deployment

The demo is deployed to Cloudflare Workers at **https://duck-trader.jetsquirrel.cloud**
(worker `duck-trader`, config `demo/web/wrangler.jsonc`). The Worker
(`demo/web/worker/index.ts`) replaces the local sidecar:

- serves the built SPA and the wasm extension repository (`/v1.5.4/wasm_eh/*`)
  from Workers static assets;
- answers `/v1/quote/*` with **real LongPort market data**: the Worker speaks
  the LongPort quote socket protocol itself (binary protobuf over WebSocket,
  implemented from scratch in `demo/web/worker/longport.ts` — HMAC-signed OTP
  fetch, `wss://openapi-quote.longportapp.com/v2?version=1&codec=1&platform=9`,
  Auth, then multiplexed request/response commands). Enabled when the
  `LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` / `LONGPORT_ACCESS_TOKEN` Worker
  secrets are set. On **any** live failure (socket connect, auth, upstream
  error code, timeout) the affected request falls back to the same
  deterministic synthetic data as the sidecar's demo mode; every quote
  response carries `x-data-source: live|synthetic|fallback` (and
  `x-live-error` with the upstream message on fallback);
- answers `/jev/v1/systemone` and `/jev/v1/models` with deterministic synthetic
  answers, or proxies to `https://api.typesafe.ai` when the request carries an
  `Authorization` header or `TYPESAFE_API_KEY` is set as a Worker secret;
- `/v1/asset/*` passes through to `https://openapi.longbridge.com` when an
  `Authorization` header is present, and returns small synthetic account/stock
  payloads otherwise;
- `/healthz` reports `{"status":"ok","mode":"live","quotes":"live","jev":"live"}`
  (`mode`/`quotes` are `demo` when the LongPort secrets are absent).

The DuckDB engine wasm (35.9 MB, over the 25 MiB static-asset limit) is loaded
from the official jsDelivr CDN bundles; the two unsigned extension wasm files
are served same-origin as before.

Redeploy:

```sh
cd demo/web
npm run build
npx wrangler deploy
```

Secrets (`grep` from the sidecar `.env` so values never hit the terminal):

```sh
cd demo/web
grep '^LONGPORT_APP_KEY=' ../sidecar/.env | cut -d= -f2- | npx wrangler secret put LONGPORT_APP_KEY
grep '^LONGPORT_APP_SECRET=' ../sidecar/.env | cut -d= -f2- | npx wrangler secret put LONGPORT_APP_SECRET
grep '^LONGPORT_ACCESS_TOKEN=' ../sidecar/.env | cut -d= -f2- | npx wrangler secret put LONGPORT_ACCESS_TOKEN
```

The LongPort access token **expires 2026-09-28**. To rotate: generate a new
token on the LongPort developer site, put it in `demo/sidecar/.env`, re-run the
`LONGPORT_ACCESS_TOKEN` line above (and refresh `demo/web/.dev.vars` for local
dev) — no redeploy needed, secrets are read per invocation. If the token lapses
and isn't rotated, quote endpoints silently fall back to synthetic data
(`x-data-source: fallback`).

For live Jev answers without per-user keys: `npx wrangler secret put
TYPESAFE_API_KEY` (then `/healthz` reports `"jev":"live"`). A TypeSafe key
entered in the config panel is forwarded per-request and works without the
secret. Local dev is unchanged: `npm run dev` still proxies to the sidecar;
`npx wrangler dev` runs the Worker locally (needs `--compatibility-date`
≤ the local workerd's newest supported date if it lags behind, e.g.
`--compatibility-date 2026-07-15`; `.dev.vars` supplies the LongPort creds).

## Notes & caveats

- LongPort quote data (candlesticks, quotes, static info) is **not** available over REST —
  only via the socket protocol. The extension always speaks HTTP+JSON; the deployed Worker
  and the local sidecar both terminate the socket protocol and re-serve it as HTTP+JSON
  (the Worker implements the protocol in `demo/web/worker/longport.ts`; the sidecar uses
  the official Node SDK). Hit the real host directly only for `/v1/asset/*`.
- jev does one HTTP POST per row; in the browser this is a synchronous XHR per row on the
  engine worker. Keep result sets small (the default query uses `LIMIT 10`).
- `src/ws_client.cpp`, `src/lb_protocol*.cpp` are earlier direct-WebSocket experiments,
  not part of the build.
