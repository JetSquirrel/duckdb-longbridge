# DuckDB loadable extensions (wasm)

`longbridge.duckdb_extension.wasm` and `jev.duckdb_extension.wasm` go here.

They are **not** checked in. They are produced by the extension wasm build
(Emscripten side modules, unsigned, built against DuckDB v1.5.4) in the repo
root — copy the two files into this directory after running that build.

At runtime the app executes:

```sql
SET custom_extension_repository = '<origin>';
INSTALL longbridge; LOAD longbridge;
INSTALL jev; LOAD jev;
```

and duckdb-wasm fetches:

- `<origin>/v1.5.4/wasm_eh/longbridge.duckdb_extension.wasm`
- `<origin>/v1.5.4/wasm_eh/jev.duckdb_extension.wasm`

If these files are missing, the app surfaces a clear error in the Extensions
panel instead of failing silently.
