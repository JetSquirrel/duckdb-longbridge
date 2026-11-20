// Smoke check for the DuckDB-Wasm build used by the demo.
// Runs outside the browser with the blocking Node bindings.
//
//   node scripts/smoke.mjs
//
// Prints SELECT version() (expect v1.5.4, matching the extensions) and, when
// public/v1.5.4/wasm_eh/*.wasm exist, tries to LOAD both unsigned extensions
// from the local files.

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
if (!existsSync(mainModule)) {
  console.error(`duckdb-eh.wasm not found at ${mainModule} — run npm install first.`);
  process.exit(1);
}

const extDir = join(root, 'public', 'v1.5.4', 'wasm_eh');
const extensions = ['longbridge', 'jev'];
const found = extensions.filter((name) =>
  existsSync(join(extDir, `${name}.duckdb_extension.wasm`)),
);

// In the blocking Node runtime, LOAD only completes when the extension bytes
// are fetched through duckdb-wasm's Node extension cache — registerFileBuffer
// + LOAD, local custom_extension_repository and loopback HTTP all deadlock the
// synchronous bridge (upstream bug: duckdb-wasm issue #2252). The Node fetch
// shim reads ~/.duckdb/extensions/extensions.duckdb.org/<ver>/<platform>/<file>
// BEFORE going to the network, so seeding that cache makes LOAD work offline.
const nodeExtCache = join(
  homedir(),
  '.duckdb',
  'extensions',
  'extensions.duckdb.org',
  'v1.5.4',
  'wasm_eh',
);
for (const name of found) {
  const file = `${name}.duckdb_extension.wasm`;
  mkdirSync(nodeExtCache, { recursive: true });
  copyFileSync(join(extDir, file), join(nodeExtCache, file));
}

const db = await createDuckDB({ eh: { mainModule } }, new VoidLogger(), NODE_RUNTIME);
await db.instantiate();
// Unsigned extensions must be allowed at open() time; only needed when the
// extension wasm files are present.
db.open(found.length > 0 ? { allowUnsignedExtensions: true } : {});

const conn = db.connect();
const version = conn.query('SELECT version() AS v;').getChild('v').get(0);
console.log(`SELECT version() -> ${version}`);
if (!String(version).startsWith('v1.5.4')) {
  console.error(`unexpected DuckDB version (extensions are built against v1.5.4)`);
  process.exit(1);
}

if (found.length === 0) {
  console.log(
    `no extension wasm in public/v1.5.4/wasm_eh/ yet — skipping LOAD check (run the wasm build first).`,
  );
  process.exit(0);
}

for (const name of found) {
  try {
    // Bare-name LOAD: resolves to the (seeded) Node extension cache.
    conn.query(`LOAD ${name};`);
    console.log(`LOAD ${name} -> ok`);
  } catch (err) {
    console.log(`LOAD ${name} -> failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
