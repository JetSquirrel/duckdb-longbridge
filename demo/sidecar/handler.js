// duckdb-trading-lab-sidecar — transport-agnostic request handler.
//
// Pure function shared by the local Node server (server.js) and the AWS
// Lambda adapter (lambda.js): takes a parsed request, returns a response
// object. Never touches node:http.

import {
  demoCandlestick,
  demoHistoryCandlestick,
  demoQuote,
  demoStatic,
  demoAssetAccount,
  demoAssetStock,
  isValidPeriod,
} from './lib/demo.js';
import {
  liveEnabled,
  liveCandlestick,
  liveHistoryCandlestick,
  liveQuote,
  liveStatic,
} from './lib/live.js';
import {
  jevHasAuth,
  jevProxy,
  jevSynthSystemone,
  jevSynthModels,
} from './lib/jev.js';

const ASSET_UPSTREAM = 'https://openapi.longbridge.com';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key,x-timestamp,x-api-signature',
};

function response(status, body, extraHeaders = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
    body: text,
  };
}

const ok = (data) => response(200, { code: 0, message: 'success', data });
const fail = (code, message) => response(200, { code, message, data: null });

function requireSymbol(url) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) throw Object.assign(new Error('missing required parameter: symbol'), { code: 400 });
  return symbol;
}

function requirePeriod(url) {
  const period = Number(url.searchParams.get('period'));
  if (!isValidPeriod(period)) {
    throw Object.assign(new Error(`invalid or missing period: ${url.searchParams.get('period')}`), { code: 400 });
  }
  return period;
}

function requireSymbols(url) {
  const symbols = url.searchParams.getAll('symbol').filter(Boolean).slice(0, 500);
  if (symbols.length === 0) {
    throw Object.assign(new Error('missing required parameter: symbol (repeated, max 500)'), { code: 400 });
  }
  return symbols;
}

async function handleQuote(url) {
  const live = liveEnabled();
  switch (url.pathname) {
    case '/v1/quote/candlestick': {
      const symbol = requireSymbol(url);
      const period = requirePeriod(url);
      const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 100, 1), 1000);
      const params = {
        symbol,
        period,
        count,
        adjustType: Number(url.searchParams.get('adjust_type')) || 0,
        tradeSession: Number(url.searchParams.get('trade_session')) || 0,
      };
      const data = live ? await liveCandlestick(params) : demoCandlestick(symbol, period, count);
      return ok(data);
    }
    case '/v1/quote/history_candlestick': {
      const symbol = requireSymbol(url);
      const period = requirePeriod(url);
      const params = {
        symbol,
        period,
        adjustType: Number(url.searchParams.get('adjust_type')) || 0,
        startDate: url.searchParams.get('start_date'),
        endDate: url.searchParams.get('end_date'),
      };
      const data = live
        ? await liveHistoryCandlestick(params)
        : demoHistoryCandlestick(symbol, period, params.startDate, params.endDate);
      return ok(data);
    }
    case '/v1/quote/quote': {
      const symbols = requireSymbols(url);
      const data = live ? await liveQuote(symbols) : demoQuote(symbols);
      return ok(data);
    }
    case '/v1/quote/static': {
      const symbols = requireSymbols(url);
      const data = live ? await liveStatic(symbols) : demoStatic(symbols);
      return ok(data);
    }
    default:
      return fail(404, `unknown endpoint: ${url.pathname}`);
  }
}

async function handleAsset(method, url, headers, body) {
  if (!liveEnabled()) {
    if (url.pathname === '/v1/asset/account') return ok(demoAssetAccount());
    if (url.pathname === '/v1/asset/stock') return ok(demoAssetStock());
    return ok({});
  }
  // live: passthrough to the real REST host, verbatim
  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith('x-api-') || key === 'authorization' || key === 'content-type') {
      upstreamHeaders[key] = v;
    }
  }
  const upstreamBody = method === 'GET' || method === 'HEAD' ? undefined : body;
  try {
    const upstream = await fetch(`${ASSET_UPSTREAM}${url.pathname}${url.search}`, {
      method,
      headers: upstreamHeaders,
      body: upstreamBody,
    });
    const text = await upstream.text();
    return response(upstream.status, text);
  } catch (err) {
    return fail(-1, `asset upstream error: ${err.message}`);
  }
}

async function handleJev(method, url, headers, body) {
  if (url.pathname === '/jev/v1/systemone' && method === 'POST') {
    if (jevHasAuth(headers.authorization)) {
      try {
        const r = await jevProxy('/v1/systemone', 'POST', headers.authorization, body);
        return response(r.status, r.body);
      } catch (err) {
        return response(502, { error: 'jev_upstream_error', message: err.message });
      }
    }
    return response(200, jevSynthSystemone(body));
  }
  if (url.pathname === '/jev/v1/models' && method === 'GET') {
    if (jevHasAuth(headers.authorization)) {
      try {
        const r = await jevProxy('/v1/models', 'GET', headers.authorization);
        return response(r.status, r.body);
      } catch (err) {
        return response(502, { error: 'jev_upstream_error', message: err.message });
      }
    }
    return response(200, jevSynthModels());
  }
  return response(404, { error: 'not_found', message: `unknown endpoint: ${url.pathname}` });
}

// method: uppercase HTTP method; url: WHATWG URL with path + query;
// headers: plain object (any casing); body: string | undefined.
export async function handleRequest({ method, url, headers = {}, body }) {
  try {
    if (method === 'OPTIONS') {
      return { status: 204, headers: CORS_HEADERS, body: '' };
    }

    if (url.pathname === '/healthz') {
      return response(200, {
        status: 'ok',
        mode: liveEnabled() ? 'live' : 'demo',
        jev: jevHasAuth(null) ? 'proxy' : 'synthetic',
      });
    }

    if (url.pathname.startsWith('/v1/quote/')) return await handleQuote(url);
    if (url.pathname.startsWith('/v1/asset/')) return await handleAsset(method, url, headers, body);
    if (url.pathname.startsWith('/jev/')) return await handleJev(method, url, headers, body);

    return response(404, { code: 404, message: `unknown endpoint: ${url.pathname}`, data: null });
  } catch (err) {
    // never crash; surface upstream/validation failures as an envelope
    const message = String(err?.message || err);
    let code = typeof err?.code === 'number' ? err.code : -1;
    // longport SDK errors look like "openapi error: code=401004: token invalid"
    const m = /\bcode=(\d+)\b/.exec(message);
    if (code === -1 && m) code = Number(m[1]);
    return fail(code, message);
  }
}
