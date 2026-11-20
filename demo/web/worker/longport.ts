// LongPort quote socket client for Cloudflare Workers.
//
// Implements the binary protobuf-over-WebSocket protocol documented at
// https://open.longportapp.com/docs/socket/protocol/overview by hand:
//   1. HMAC-signed HTTP GET /v1/socket/token -> one-time password (OTP)
//   2. wss://openapi-quote.longportapp.com/v2?version=1&codec=1&platform=9
//   3. Auth (control command 2) with the OTP as the first packet
//   4. Business commands, paired to responses by request_id
//      (10 static info, 11 realtime quote, 19 candlestick,
//      27 history candlestick)
//
// Cloudflare Workers scope every I/O object to its request handler, so a
// socket cannot be shared between HTTP requests: each command runs over its
// own short-lived connection (OTP -> connect -> Auth -> command -> close).
//
// Packet layout (all integers big-endian):
//   byte 0   header: type (low nibble: 1=request, 2=response, 3=push),
//            verify bit 0x10, gzip bit 0x20
//   request: cmd u8, request_id u32, timeout u16 (ms), body_len u24, body
//   response: cmd u8, request_id u32, status u8, body_len u24, body
//   push: cmd u8, body_len u24, body
// Error responses carry a control.Error body { uint64 code = 1; string msg = 2 }.

export interface LongPortCreds {
  appKey: string;
  appSecret: string;
  accessToken: string;
}

export class LongPortError extends Error {
  code: number;
  retriable: boolean;
  constructor(message: string, code = -1, retriable = true) {
    super(message);
    this.code = code;
    // retriable = the connection broke (worth reconnecting and trying once
    // more); upstream status errors are authoritative and must not be retried.
    this.retriable = retriable;
  }
}

// --------------------------------------------------------- protobuf ----

const te = new TextEncoder();
const td = new TextDecoder();

class PbWriter {
  private parts: number[] = [];

  private pushVarint(v: number | bigint): void {
    let x = typeof v === 'bigint' ? v : BigInt(v);
    while (x > 0x7fn) {
      this.parts.push(Number(x & 0x7fn) | 0x80);
      x >>= 7n;
    }
    this.parts.push(Number(x));
  }

  varintField(field: number, v: number | bigint): this {
    this.pushVarint(BigInt(field) << 3n);
    this.pushVarint(v);
    return this;
  }

  bytesField(field: number, bytes: Uint8Array): this {
    this.pushVarint((field << 3) | 2);
    this.pushVarint(bytes.length);
    for (const b of bytes) this.parts.push(b);
    return this;
  }

  stringField(field: number, s: string): this {
    if (s === '') return this;
    return this.bytesField(field, te.encode(s));
  }

  messageField(field: number, w: PbWriter): this {
    return this.bytesField(field, w.finish());
  }

  finish(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

class PbReader {
  pos = 0;
  constructor(private buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  readTag(): { field: number; wire: number } {
    const tag = Number(this.readVarint());
    return { field: tag >>> 3, wire: tag & 7 };
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new LongPortError('protobuf: truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new LongPortError('protobuf: varint too long');
    }
  }

  readVarintNum(): number {
    return Number(this.readVarint());
  }

  readBytes(): Uint8Array {
    const len = this.readVarintNum();
    if (this.pos + len > this.buf.length) throw new LongPortError('protobuf: truncated bytes');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readString(): string {
    return td.decode(this.readBytes());
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.pos += 8;
        return;
      case 2: {
        const len = this.readVarintNum();
        this.pos += len;
        return;
      }
      case 5:
        this.pos += 4;
        return;
      default:
        throw new LongPortError(`protobuf: unsupported wire type ${wire}`);
    }
  }
}

// ------------------------------------------------------------ hmac ----

function hex(buf: ArrayBuffer): string {
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

async function sha1Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', te.encode(data)));
}

async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    te.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', k, te.encode(msg)));
}

// Canonical-string scheme from https://open.longportapp.com/docs/how-to-access-api
async function signedHeaders(
  method: string,
  path: string,
  query: string,
  body: string,
  creds: LongPortCreds,
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  let canonical =
    `${method.toUpperCase()}|${path}|${query}|` +
    `authorization:${creds.accessToken}\n` +
    `x-api-key:${creds.appKey}\n` +
    `x-timestamp:${ts}\n` +
    `|authorization;x-api-key;x-timestamp|`;
  if (body !== '') canonical += await sha1Hex(body);
  const signStr = `HMAC-SHA256|${await sha1Hex(canonical)}`;
  const signature = await hmacSha256Hex(creds.appSecret, signStr);
  return {
    'X-Api-Key': creds.appKey,
    Authorization: creds.accessToken,
    'X-Timestamp': ts,
    'X-Api-Signature': `HMAC-SHA256 SignedHeaders=authorization;x-api-key;x-timestamp, Signature=${signature}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
}

const OTP_URL = 'https://openapi.longportapp.com/v1/socket/token';

async function fetchOtp(creds: LongPortCreds): Promise<string> {
  const headers = await signedHeaders('GET', '/v1/socket/token', '', '', creds);
  let res: Response;
  try {
    res = await fetch(OTP_URL, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new LongPortError(`longport otp request failed: ${err instanceof Error ? err.message : err}`);
  }
  const json: any = await res.json().catch(() => null);
  const otp = json?.data?.otp;
  if (json?.code !== 0 || typeof otp !== 'string') {
    throw new LongPortError(
      `longport otp failed: http=${res.status} code=${json?.code ?? 'n/a'} msg=${json?.message ?? json?.msg ?? 'n/a'}`,
      Number(json?.code ?? -1),
    );
  }
  const { online, limit } = json.data;
  if (typeof online === 'number' && typeof limit === 'number' && online >= limit) {
    throw new LongPortError(`longport otp: connections limitation is hit (online=${online} limit=${limit})`, 403);
  }
  return otp;
}

// ---------------------------------------------------------- packets ----

const PACKET_TYPE_RESPONSE = 2;
const PACKET_TYPE_PUSH = 3;

const CMD_CLOSE = 0;
const CMD_AUTH = 2;
const CMD_STATIC_INFO = 10;
const CMD_QUOTE = 11;
const CMD_CANDLESTICK = 19;
const CMD_HISTORY_CANDLESTICK = 27;

const REQUEST_TIMEOUT_MS = 10_000;

function encodeRequestPacket(cmd: number, requestId: number, timeoutMs: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + body.length);
  const dv = new DataView(out.buffer);
  out[0] = 0x01; // type=request, no verify, no gzip
  out[1] = cmd;
  dv.setUint32(2, requestId >>> 0);
  dv.setUint16(6, timeoutMs);
  out[8] = (body.length >> 16) & 0xff;
  out[9] = (body.length >> 8) & 0xff;
  out[10] = body.length & 0xff;
  out.set(body, 11);
  return out;
}

interface ResponsePacket {
  kind: 'response';
  cmd: number;
  requestId: number;
  status: number;
  body: Uint8Array;
}

interface PushPacket {
  kind: 'push';
  cmd: number;
  body: Uint8Array;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodePacket(data: ArrayBuffer): Promise<ResponsePacket | PushPacket | null> {
  const buf = new Uint8Array(data);
  if (buf.length < 2) return null;
  const header = buf[0];
  const type = header & 0x0f;
  const gzip = (header & 0x20) !== 0;
  const rest = buf.subarray(1);
  const dv = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
  // Only the body is gzip-compressed; the packet fields stay in the clear.
  const maybeGunzip = (body: Uint8Array) => (gzip ? gunzip(body) : Promise.resolve(body));

  if (type === PACKET_TYPE_RESPONSE) {
    if (rest.length < 9) return null;
    const cmd = rest[0];
    const requestId = dv.getUint32(1);
    const status = rest[5];
    const bodyLen = (rest[6] << 16) | (rest[7] << 8) | rest[8];
    const body = await maybeGunzip(rest.subarray(9, 9 + bodyLen));
    return { kind: 'response', cmd, requestId, status, body };
  }
  if (type === PACKET_TYPE_PUSH) {
    if (rest.length < 4) return null;
    const cmd = rest[0];
    const bodyLen = (rest[1] << 16) | (rest[2] << 8) | rest[3];
    const body = await maybeGunzip(rest.subarray(4, 4 + bodyLen));
    return { kind: 'push', cmd, body };
  }
  return null;
}

function decodeErrorBody(body: Uint8Array): { code: number; msg: string } {
  try {
    const r = new PbReader(body);
    let code = -1;
    let msg = '';
    while (!r.done) {
      const { field, wire } = r.readTag();
      if (field === 1) code = r.readVarintNum();
      else if (field === 2) msg = r.readString();
      else r.skip(wire);
    }
    return { code, msg };
  } catch {
    return { code: -1, msg: '' };
  }
}

// ------------------------------------------------------ ws connection ----
//
// Cloudflare Workers tie every I/O object to the request handler that created
// it ("Cannot perform I/O on behalf of a different request"), so a WebSocket
// can never be shared across HTTP requests — not even on the edge. Each quote
// command therefore runs over its own short-lived connection: OTP -> connect
// -> Auth -> command -> close. Within one connection, packets are multiplexed
// by request_id through the pending map.

const WS_URL = 'wss://openapi-quote.longportapp.com/v2?version=1&codec=1&platform=9';
const OPEN_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (body: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class QuoteConnection {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextRequestId = 1;

  constructor(private creds: LongPortCreds) {}

  async connect(): Promise<void> {
    const otp = await fetchOtp(this.creds);

    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // Outbound WebSockets in Workers must be accepted before I/O flows.
    try {
      (ws as unknown as { accept?: () => void }).accept?.();
    } catch {
      /* newer workerd auto-accepts */
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new LongPortError('longport: websocket open timed out'));
      }, OPEN_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new LongPortError('longport: websocket connect failed'));
      });
      ws.addEventListener('close', (ev) => {
        clearTimeout(timer);
        reject(new LongPortError(`longport: websocket closed during connect (${ev.code})`));
      });
    });

    // Wire the steady-state handlers before auth so the auth response is seen.
    ws.addEventListener('message', (ev) => {
      void this.onMessage(ev.data).catch((err) =>
        console.log(`longport: message handling error: ${err instanceof Error ? err.message : err}`),
      );
    });
    ws.addEventListener('error', () => this.teardown(new LongPortError('longport: websocket error')));
    ws.addEventListener('close', (ev) =>
      this.teardown(new LongPortError(`longport: websocket closed (${ev.code} ${ev.reason || ''})`.trim())),
    );

    // First packet on the connection must be Auth.
    const authBody = new PbWriter().stringField(1, otp).finish();
    await this.sendAndWait(CMD_AUTH, authBody);
  }

  sendAndWait(cmd: number, body: Uint8Array): Promise<Uint8Array> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new LongPortError('longport: not connected'));
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0xffffffff ? 1 : this.nextRequestId + 1;

    return new Promise<Uint8Array>((resolve, reject) => {
      // Slightly longer than the in-packet timeout so a server-side timeout
      // status surfaces as an upstream error rather than a local one.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LongPortError(`longport: request ${id} (cmd ${cmd}) timed out`));
      }, REQUEST_TIMEOUT_MS + 2_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(encodeRequestPacket(cmd, id, REQUEST_TIMEOUT_MS, body).buffer);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.teardown(new LongPortError(`longport: send failed: ${err instanceof Error ? err.message : err}`));
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async onMessage(data: unknown): Promise<void> {
    if (typeof data === 'string') return;
    const packet = await decodePacket(data as ArrayBuffer);
    if (!packet) return;

    if (packet.kind === 'push') {
      if (packet.cmd === CMD_CLOSE) {
        const { code, msg } = decodeErrorBody(packet.body);
        console.log(`longport: server sent close: code=${code} reason=${msg}`);
        this.teardown(new LongPortError(`longport: server closed connection: ${msg || code}`, code));
      }
      return; // other pushes (subscriptions) are not used
    }

    const pending = this.pending.get(packet.requestId);
    if (!pending) return;
    this.pending.delete(packet.requestId);
    clearTimeout(pending.timer);

    if (packet.status === 0) {
      pending.resolve(packet.body);
    } else {
      const { code, msg } = decodeErrorBody(packet.body);
      pending.reject(
        new LongPortError(`longport upstream error: status=${packet.status} code=${code} msg=${msg}`, code, false),
      );
    }
  }

  private teardown(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  close(): void {
    this.teardown(new LongPortError('longport: connection closed by client'));
  }
}

// --------------------------------------------------------- dispatch ----

// Runs one business command over its own short-lived connection. Connection-
// level failures get exactly one retry on a fresh connection; upstream status
// errors are authoritative and propagate immediately.
async function runCommand(creds: LongPortCreds, cmd: number, body: Uint8Array): Promise<Uint8Array> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = new QuoteConnection(creds);
    try {
      await conn.connect();
      return await conn.sendAndWait(cmd, body);
    } catch (err) {
      lastErr = err instanceof Error ? err : new LongPortError(String(err));
      if (lastErr instanceof LongPortError && !lastErr.retriable) throw lastErr;
      console.log(`longport: cmd ${cmd} attempt ${attempt + 1} failed: ${lastErr.message}`);
    } finally {
      conn.close();
    }
  }
  throw lastErr ?? new LongPortError('longport: request failed');
}

// ---------------------------------------------------------- mapping ----

// Prices come back from the socket as decimal strings already ("426.200");
// they pass through verbatim so the DuckDB extension sees the API's values.
// Per-share ratios from static info come with full double precision from the
// API; render them to 3 decimals to match the sidecar/SDK ground truth.
function dec3(s: string): string {
  if (s === '') return s;
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(3) : s;
}
interface CandleRow {
  close: string;
  open: string;
  low: string;
  high: string;
  volume: number;
  turnover: string;
  timestamp: number;
  trade_session: number;
}

function decodeCandle(buf: Uint8Array): CandleRow {
  const r = new PbReader(buf);
  const c: CandleRow = { close: '', open: '', low: '', high: '', volume: 0, turnover: '', timestamp: 0, trade_session: 0 };
  while (!r.done) {
    const { field, wire } = r.readTag();
    switch (field) {
      case 1:
        c.close = r.readString();
        break;
      case 2:
        c.open = r.readString();
        break;
      case 3:
        c.low = r.readString();
        break;
      case 4:
        c.high = r.readString();
        break;
      case 5:
        c.volume = r.readVarintNum();
        break;
      case 6:
        c.turnover = r.readString();
        break;
      case 7:
        c.timestamp = r.readVarintNum();
        break;
      case 8:
        c.trade_session = r.readVarintNum();
        break;
      default:
        r.skip(wire);
    }
  }
  return c;
}

function decodeCandlestickResponse(body: Uint8Array): { symbol: string; candlesticks: CandleRow[] } {
  const r = new PbReader(body);
  let symbol = '';
  const candlesticks: CandleRow[] = [];
  while (!r.done) {
    const { field, wire } = r.readTag();
    if (field === 1) symbol = r.readString();
    else if (field === 2) candlesticks.push(decodeCandle(r.readBytes()));
    else r.skip(wire);
  }
  return { symbol, candlesticks };
}

// TradeSessions: Intraday = 0, All = 100 (per the official SDK enum).
function mapTradeSession(tradeSession: number): number {
  return tradeSession === 1 ? 100 : 0;
}

export async function lpCandlestick(
  creds: LongPortCreds,
  opts: { symbol: string; period: number; count: number; adjustType: number; tradeSession: number },
): Promise<{ symbol: string; candlesticks: CandleRow[] }> {
  const body = new PbWriter()
    .stringField(1, opts.symbol)
    .varintField(2, opts.period)
    .varintField(3, opts.count)
    .varintField(4, opts.adjustType)
    .varintField(5, mapTradeSession(opts.tradeSession))
    .finish();
  const resp = await runCommand(creds, CMD_CANDLESTICK, body);
  return decodeCandlestickResponse(resp);
}

export async function lpHistoryCandlestick(
  creds: LongPortCreds,
  opts: { symbol: string; period: number; adjustType: number; startDate: string; endDate: string },
): Promise<{ symbol: string; candlesticks: CandleRow[] }> {
  const dateQuery = new PbWriter().stringField(1, opts.startDate).stringField(2, opts.endDate);
  const body = new PbWriter()
    .stringField(1, opts.symbol)
    .varintField(2, opts.period)
    .varintField(3, opts.adjustType)
    .varintField(4, 2) // HistoryCandlestickQueryType.QUERY_BY_DATE
    .messageField(6, dateQuery)
    .varintField(7, 0) // TradeSessions.Intraday, matching the sidecar
    .finish();
  const resp = await runCommand(creds, CMD_HISTORY_CANDLESTICK, body);
  const decoded = decodeCandlestickResponse(resp);
  return { symbol: decoded.symbol, candlesticks: decoded.candlesticks.slice(-1000) };
}

export async function lpQuote(
  creds: LongPortCreds,
  symbols: string[],
): Promise<{ list: Record<string, unknown>[] }> {
  const w = new PbWriter();
  for (const s of symbols) w.stringField(1, s);
  const resp = await runCommand(creds, CMD_QUOTE, w.finish());

  const outer = new PbReader(resp);
  const list: Record<string, unknown>[] = [];
  while (!outer.done) {
    const { field, wire } = outer.readTag();
    if (field !== 1) {
      outer.skip(wire);
      continue;
    }
    const r = new PbReader(outer.readBytes());
    const q: Record<string, unknown> = { symbol: '', last_done: '', prev_close: '', open: '', high: '', low: '', volume: 0, turnover: '', timestamp: 0, trade_status: 0 };
    while (!r.done) {
      const f = r.readTag();
      switch (f.field) {
        case 1:
          q.symbol = r.readString();
          break;
        case 2:
          q.last_done = r.readString();
          break;
        case 3:
          q.prev_close = r.readString();
          break;
        case 4:
          q.open = r.readString();
          break;
        case 5:
          q.high = r.readString();
          break;
        case 6:
          q.low = r.readString();
          break;
        case 7:
          q.timestamp = r.readVarintNum();
          break;
        case 8:
          q.volume = r.readVarintNum();
          break;
        case 9:
          q.turnover = r.readString();
          break;
        case 10:
          q.trade_status = r.readVarintNum();
          break;
        default:
          r.skip(f.wire); // pre/post/overnight market quotes
      }
    }
    list.push(q);
  }
  return { list };
}

export async function lpStatic(
  creds: LongPortCreds,
  symbols: string[],
): Promise<{ list: Record<string, unknown>[] }> {
  const w = new PbWriter();
  for (const s of symbols) w.stringField(1, s);
  const resp = await runCommand(creds, CMD_STATIC_INFO, w.finish());

  const outer = new PbReader(resp);
  const list: Record<string, unknown>[] = [];
  while (!outer.done) {
    const { field, wire } = outer.readTag();
    if (field !== 1) {
      outer.skip(wire);
      continue;
    }
    const r = new PbReader(outer.readBytes());
    const info: Record<string, unknown> = {
      symbol: '', name_en: '', name_cn: '', name_hk: '', exchange: '', currency: '',
      lot_size: 0, total_shares: 0, circulating_shares: 0, hk_shares: 0,
      eps: '', eps_ttm: '', bps: '', dividend_yield: '', board: '',
    };
    while (!r.done) {
      const f = r.readTag();
      switch (f.field) {
        case 1:
          info.symbol = r.readString();
          break;
        case 2:
          info.name_cn = r.readString();
          break;
        case 3:
          info.name_en = r.readString();
          break;
        case 4:
          info.name_hk = r.readString();
          break;
        case 6:
          info.exchange = r.readString();
          break;
        case 7:
          info.currency = r.readString();
          break;
        case 8:
          info.lot_size = r.readVarintNum();
          break;
        case 9:
          info.total_shares = r.readVarintNum();
          break;
        case 10:
          info.circulating_shares = r.readVarintNum();
          break;
        case 11:
          info.hk_shares = r.readVarintNum();
          break;
        case 12:
          info.eps = dec3(r.readString());
          break;
        case 13:
          info.eps_ttm = dec3(r.readString());
          break;
        case 14:
          info.bps = dec3(r.readString());
          break;
        case 15:
          info.dividend_yield = dec3(r.readString());
          break;
        case 17:
          info.board = r.readString();
          break;
        default:
          r.skip(f.wire); // listing_date, stock_derivatives
      }
    }
    list.push(info);
  }
  return { list };
}
