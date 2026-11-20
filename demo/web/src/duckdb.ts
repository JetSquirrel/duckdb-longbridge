import * as duckdb from '@duckdb/duckdb-wasm';

export type ExtensionName = 'longbridge' | 'jev';
export type ExtensionState = 'idle' | 'loading' | 'loaded' | 'error';

export interface ExtensionStatus {
  state: ExtensionState;
  message?: string;
}

export interface LabConfig {
  jevApiKey: string;
  jevEndpoint: string;
  longbridgeBaseUrl: string;
}

export interface Lab {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

const esc = (value: string) => value.replace(/'/g, "''");

// Gateway (longbridge quotes + jev AI proxy). Defaults to same-origin (the
// Vite dev proxy or the Cloudflare Worker); on AWS the SPA is on Amplify and
// the gateway is a Lambda Function URL injected at build time.
export const GATEWAY_URL = (
  (import.meta.env.VITE_GATEWAY_URL as string | undefined) || window.location.origin
).replace(/\/+$/, '');

const missingWasmHint = (name: ExtensionName, err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `Failed to INSTALL/LOAD the '${name}' extension. ` +
    `The extension wasm is probably missing — run the wasm build for the extensions and copy ` +
    `'${name}.duckdb_extension.wasm' into public/v1.5.4/wasm_eh/ (see the README.md there). ` +
    `Original error: ${detail}`
  );
};

export async function bootLab(
  config: LabConfig,
  onStatus: (name: ExtensionName, status: ExtensionStatus) => void,
): Promise<Lab> {
  // The engine comes from the official CDN bundles: the local duckdb-eh.wasm
  // (35.9 MB) exceeds the Workers static-assets 25 MiB per-file limit, and in
  // dev this avoids shipping it through Vite too. createWorker blob-wraps the
  // cross-origin worker script so it can be constructed same-origin.
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const worker = await duckdb.createWorker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // Our extensions are unsigned Emscripten side modules; this cannot be
  // enabled later via SQL, it must be set at open() time.
  await db.open({ allowUnsignedExtensions: true });

  const conn = await db.connect();
  const origin = window.location.origin;
  // duckdb-wasm resolves INSTALL to
  // <origin>/v1.5.4/wasm_eh/<name>.duckdb_extension.wasm (served from public/).
  await conn.query(`SET custom_extension_repository = '${esc(origin)}';`);

  for (const name of ['longbridge', 'jev'] as const) {
    onStatus(name, { state: 'loading' });
    try {
      await conn.query(`INSTALL ${name}; LOAD ${name};`);
      onStatus(name, { state: 'loaded' });
    } catch (err) {
      const message = missingWasmHint(name, err);
      onStatus(name, { state: 'error', message });
      await conn.close();
      await db.terminate();
      throw new Error(message);
    }
  }

  // Gateway base URL: same-origin in dev / Cloudflare deploys, or the Lambda
  // Function URL when built with VITE_GATEWAY_URL (AWS deploy).
  await conn.query(`SET longbridge_base_url = '${esc(config.longbridgeBaseUrl)}';`);

  // With no key entered, fall back to the gateway's synthetic demo mode.
  const apiKey = config.jevApiKey.trim() === '' ? 'demo' : config.jevApiKey.trim();
  // Strip trailing slashes: the extension appends '/v1/...' verbatim, so a
  // '/jev/' endpoint would produce '//v1/systemone'.
  const endpoint = (config.jevApiKey.trim() === '' ? `${GATEWAY_URL}/jev` : config.jevEndpoint.trim())
    .replace(/\/+$/, '');
  await conn.query(
    `CREATE OR REPLACE SECRET (TYPE jev, API_KEY '${esc(apiKey)}', ENDPOINT '${esc(endpoint)}');`,
  );

  return { db, conn };
}
