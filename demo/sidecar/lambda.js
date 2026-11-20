// AWS Lambda adapter for the sidecar gateway (Function URL / HTTP API v2
// payload format). CORS is handled by handler.js itself, so the Function URL
// is created WITHOUT a CORS block — otherwise the platform's headers would
// be duplicated with ours.

import { handleRequest } from './handler.js';

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const rawPath = event.rawPath ?? event.path ?? '/';
  const rawQuery = event.rawQueryString ?? '';
  const url = new URL(rawPath + (rawQuery ? `?${rawQuery}` : ''), 'https://lambda.local');

  let body = event.body;
  if (event.isBase64Encoded && body) body = Buffer.from(body, 'base64').toString('utf8');

  const out = await handleRequest({ method, url, headers: event.headers ?? {}, body });
  return { statusCode: out.status, headers: out.headers, body: out.body };
}
