# jev

Vendored from [colliber/duckdb-jev](https://github.com/colliber/duckdb-jev)
(commit `fad67eb4a1def91fcf1efbc96bdf5e6e11208644`), MIT licensed (see `LICENSE`).

DuckDB extension exposing LLM-judgement scalar functions (`jev_choice`,
`jev_score`, `jev_noul`, `jev_ask`), the `jev_usage()` table function and a
`CREATE SECRET (TYPE jev, API_KEY ... [, ENDPOINT ...] [, MODEL ...])` secret
type. See the upstream repository for documentation.

Local changes relative to upstream:

- The HTTP layer uses `duckdb::HTTPUtil` instead of the vendored cpp-httplib
  OpenSSL client, so the extension also works as a DuckDB-Wasm (wasm_eh)
  loadable extension, where duckdb-wasm overrides `HTTPUtil` with a sync-XHR
  implementation. Natively this requires the `httpfs` extension to be loaded
  (`LOAD httpfs`), since DuckDB's core built-in HTTPUtil cannot POST.
- No OpenSSL / vcpkg dependency anywhere.
- The per-chunk 16-way thread pool is compiled out under `__EMSCRIPTEN__`;
  rows are requested sequentially in the single-threaded wasm build.
