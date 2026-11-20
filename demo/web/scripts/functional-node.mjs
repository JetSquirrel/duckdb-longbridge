// Functional check (Node, blocking bindings): LOAD both extensions, then call
// longbridge_bars against the local sidecar.
//
//   node scripts/functional-node.mjs
//
// LOAD goes through the seeded Node extension cache (see smoke.mjs — every
// other delivery path deadlocks in the blocking Node runtime, duckdb-wasm
// issue #2252). duckdb-wasm's HTTP layer uses synchronous XMLHttpRequest,
// which does not exist in Node, so the query is expected to fail at the
// network layer. Success criterion: the table function is registered, binds
// its arguments, and reaches the HTTP layer — an XHR-ish network error is an
// ACCEPTABLE outcome, a Catalog/Binder/ABI error is not.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const duckdb = require('@duckdb/duckdb-wasm/blocking');
const { createDuckDB, VoidLogger, NODE_RUNTIME } = duckdb;

const mainModule = join(root, 'node_modules', '@duckdb/duckdb-wasm', 'dist', 'duckdb-eh.wasm');
const extDir = join(root, 'public', 'v1.5.4', 'wasm_eh');
const nodeExtCache = join(homedir(), '.duckdb', 'extensions', 'extensions.duckdb.org', 'v1.5.4', 'wasm_eh');

const db = await createDuckDB({ eh: { mainModule } }, new VoidLogger(), NODE_RUNTIME);
await db.instantiate();
db.open({ allowUnsignedExtensions: true });
const conn = db.connect();

for (const name of ['longbridge', 'jev']) {
  const file = `${name}.duckdb_extension.wasm`;
  mkdirSync(nodeExtCache, { recursive: true });
  copyFileSync(join(extDir, file), join(nodeExtCache, file));
  conn.query(`LOAD ${name};`);
  console.log(`LOAD ${name} -> ok`);
}

const funcs = conn.query(
  `SELECT function_name FROM duckdb_functions() WHERE function_name LIKE 'longbridge%' OR function_name LIKE 'jev%' ORDER BY 1;`,
);
console.log(`registered longbridge/jev functions (${funcs.numRows}):`);
for (const row of funcs.toArray()) console.log(`  ${row.function_name}`);
if (funcs.numRows === 0) {
  console.error('no longbridge/jev functions registered');
  process.exit(1);
}

conn.query(`SET longbridge_base_url = 'http://localhost:8787';`);
console.log(`SET longbridge_base_url -> ok`);

let exitCode = 0;
try {
  const t = conn.query(`SELECT count(*) AS n FROM longbridge_bars('700.HK', 'day', 5);`);
  console.log(`longbridge_bars -> count = ${t.getChild('n').get(0)} (Node satisfied the HTTP request!)`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const xhrish = /xhr|xmlhttprequest|network|http|fetch|emscripten|send|io error|connection/i.test(msg);
  if (xhrish) {
    console.log(`longbridge_bars -> reached HTTP layer, failed at network as expected in Node:`);
    console.log(`  ${msg.split('\n')[0]}`);
    console.log(`ACCEPTABLE: function registered, bound, and reached the HTTP layer.`);
  } else {
    console.error(`longbridge_bars -> UNEXPECTED failure (not a network-layer error):`);
    console.error(`  ${msg}`);
    exitCode = 1;
  }
}

process.exit(exitCode);
