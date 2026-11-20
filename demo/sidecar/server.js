// duckdb-trading-lab-sidecar
//
// Local sidecar gateway for the DuckDB Longbridge/Jev trading demo.
// Node >= 20, ESM, no build step. All routing lives in handler.js; this is
// just the node:http transport. See README.md for details.

import http from 'node:http';

import { handleRequest } from './handler.js';
import { liveEnabled } from './lib/live.js';
import { jevHasAuth } from './lib/jev.js';

const PORT = Number(process.env.PORT || 8787);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const out = await handleRequest({ method: req.method, url, headers: req.headers, body });
  res.writeHead(out.status, out.headers);
  res.end(out.body);
});

server.listen(PORT, () => {
  const mode = liveEnabled() ? 'LIVE (LongPort SDK)' : 'DEMO (synthetic data)';
  const jev = jevHasAuth(null) ? 'proxy to api.typesafe.ai' : 'synthetic (no key)';
  console.log(`[sidecar] listening on http://localhost:${PORT}`);
  console.log(`[sidecar] quote mode: ${mode}`);
  console.log(`[sidecar] jev mode:   ${jev}`);
});
