import {afterEach, describe, expect, it} from 'vitest';
import http, {type IncomingHttpHeaders, type RequestListener, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
// @ts-expect-error The standalone production entrypoint is plain Node ESM, without a TypeScript build.
import {createProxy} from '../../services/mcp-proxy/server.mjs';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();}));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function fixture(handler: RequestListener, timeoutMs = 20_000) {
  const upstream = await listen(http.createServer(handler));
  const proxy = await listen(createProxy({upstream: `${upstream}/mcp`, timeoutMs}));
  return {upstream, proxy};
}
const rpc = JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/list'});
function request(url: string, options: {method?: string; headers?: Record<string, string>; chunks?: (string | Buffer)[]; unfinished?: boolean} = {}) {
  return new Promise<{status: number; headers: IncomingHttpHeaders; body: string}>((resolve, reject) => {
    const req = http.request(url, {method: options.method ?? 'POST', headers: {'content-type': 'application/json', ...options.headers}}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {resolve({status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString()}); req.destroy();});
    });
    req.on('error', reject);
    for (const chunk of options.chunks ?? [rpc]) req.write(chunk);
    if (options.unfinished) req.flushHeaders(); else req.end();
  });
}
function json(res: http.ServerResponse, body: unknown) {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));}

describe('standalone MCP proxy', () => {
  it.each([
    undefined, '', 'file:///mcp', 'ftp://example.invalid/mcp', 'http://example.invalid',
    'http://example.invalid/mcp/', 'http://example.invalid/a/../mcp', 'http://example.invalid/%6dcp',
    'http://example.invalid/mcp?x=1', 'http://example.invalid/mcp?', 'http://example.invalid/mcp#x',
    'http://example.invalid/mcp#', 'http://user:pass@example.invalid/mcp', 'http://user@example.invalid/mcp',
    'http://@example.invalid/mcp', 'http://example.invalid\t/mcp',
    'http://example.invalid\\other/mcp',
  ])('rejects invalid fixed configuration without echoing it (%#)', upstream => {
    expect(() => createProxy({upstream})).toThrow('REPLAY_MCP_UPSTREAM must be an http(s) URL with exact /mcp and no userinfo, query or fragment');
  });

  it('accepts http/https configuration without listening or reading runtime configuration on import', () => {
    for (const upstream of ['http://127.0.0.1:5181/mcp', 'https://example.invalid/mcp']) {
      const server = createProxy({upstream});
      expect(server.listening).toBe(false);
    }
    expect(() => createProxy({upstream: 'http://example.invalid/mcp', timeoutMs: 20_001})).toThrow('Invalid proxy timeout');
  });

  it('forwards opaque authorization and exact JSON only to the fixed target with no identity/header leakage', async () => {
    let received: {headers: IncomingHttpHeaders; body: string; url?: string; method?: string} | undefined;
    const {proxy, upstream} = await fixture((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received = {headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url, method: req.method};
        res.setHeader('Set-Cookie', 'secret-cookie');
        res.setHeader('Authorization', 'secret-response-auth');
        res.setHeader('X-User', 'secret-response-user');
        res.setHeader('X-Debug', 'secret-debug');
        res.setHeader('Cache-Control', 'public, max-age=999');
        json(res, {jsonrpc: '2.0', id: 7, result: {tools: []}});
      });
    });
    const bearer = 'Bearer opaque-fixture-value.with-no-decoding';
    const response = await request(`${proxy}/mcp`, {headers: {authorization: bearer, 'x-workroom-id': 'fixture-room', accept: 'application/json, text/event-stream', cookie: 'browser=secret', 'x-user-id': 'forged', 'x-user': 'forged', 'x-forwarded-for': 'forged', 'x-forwarded-host': 'attacker.invalid', host: 'attacker.invalid', 'x-upstream': 'http://attacker.invalid/mcp', 'mcp-session-id': 'browser-session', origin: 'https://attacker.invalid'}});
    expect(received).toMatchObject({body: rpc, url: '/mcp', method: 'POST'});
    expect(received!.headers).toEqual({authorization: bearer, 'x-workroom-id': 'fixture-room', 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: new URL(upstream).host, 'content-length': String(Buffer.byteLength(rpc)), connection: 'close'});
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({jsonrpc: '2.0', id: 7, result: {tools: []}});
    expect(response.headers['cache-control']).toBe('no-store');
    for (const name of ['set-cookie', 'authorization', 'x-user', 'x-debug']) expect(response.headers[name]).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('exposes static health and denies other paths and methods without contacting upstream', async () => {
    let calls = 0;
    const {proxy} = await fixture((_req, res) => {calls++; json(res, {});});
    expect(await request(`${proxy}/health`, {method: 'GET', chunks: []})).toMatchObject({status: 200, body: '{"status":"ok"}'});
    for (const path of ['/mcp?upstream=other', '/mcp/', '/health?x=1', '/', '/api/overview']) expect((await request(`${proxy}${path}`)).status).toBe(404);
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) expect((await request(`${proxy}/mcp`, {method, chunks: []})).status).toBe(405);
    expect((await request(`${proxy}/health`)).status).toBe(405);
    expect(calls).toBe(0);
  });

  it('leaves missing bearer authentication to the upstream app and returns a generic denial', async () => {
    let calls = 0;
    const {proxy} = await fixture((req, res) => {calls++; expect(req.headers.authorization).toBeUndefined(); res.writeHead(401, {'WWW-Authenticate': 'secret-challenge'}); res.end('secret-auth-error');});
    const response = await request(`${proxy}/mcp`);
    expect(calls).toBe(1);
    expect(response).toMatchObject({status: 401, body: '{"error":"Upstream request failed"}'});
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('supports notification 202 with no response body or upstream headers', async () => {
    const {proxy} = await fixture((_req, res) => {res.writeHead(202, {'Set-Cookie': 'secret'}); res.end();});
    expect(await request(`${proxy}/mcp`, {chunks: ['{"jsonrpc":"2.0","method":"notifications/initialized"}']})).toMatchObject({status: 202, body: ''});
  });

  it.each([false, true])('enforces the request byte bound before forwarding (content-length: %s)', async declared => {
    let calls = 0;
    const {proxy} = await fixture((req, res) => {calls++; req.resume(); req.on('end', () => json(res, {}));});
    const atLimit = Buffer.alloc(16 * 1024, 'x');
    expect((await request(`${proxy}/mcp`, {chunks: [atLimit]})).status).toBe(200);
    const response = await request(`${proxy}/mcp`, {headers: declared ? {'content-length': String(atLimit.length + 1)} : {}, chunks: [atLimit, 'x']});
    expect(response.status).toBe(413);
    expect(calls).toBe(1);
  });

  it.each([false, true])('bounds upstream responses before releasing bytes (content-length: %s)', async declared => {
    let oversized = false;
    const payload = JSON.stringify('x'.repeat(256 * 1024 - 2));
    const {proxy} = await fixture((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (declared) res.setHeader('Content-Length', String(Buffer.byteLength(payload) + (oversized ? 1 : 0)));
      res.write(payload);
      res.end(oversized ? 'x' : undefined);
    });
    const allowed = await request(`${proxy}/mcp`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe(payload);
    oversized = true;
    expect(await request(`${proxy}/mcp`)).toMatchObject({status: 502, body: '{"error":"Upstream response too large"}'});
  });

  it.each([301, 302, 307, 308, 403, 500])('does not follow or reflect upstream redirects/errors (%s)', async status => {
    let destinationCalls = 0;
    const destination = await listen(http.createServer((_req, res) => {destinationCalls++; json(res, {});}));
    const {proxy} = await fixture((_req, res) => {res.writeHead(status, 'secret-status', {Location: `${destination}/secret`, 'X-Debug': 'secret'}); res.end('secret-upstream-body');});
    const response = await request(`${proxy}/mcp`);
    expect(response.status).toBe(status < 400 ? 502 : status);
    expect(destinationCalls).toBe(0);
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(response.headers.location).toBeUndefined();
  });

  it('removes JSON-RPC error messages/data while preserving caller correlation and numeric code', async () => {
    const {proxy} = await fixture((_req, res) => json(res, {jsonrpc: '2.0', id: 'secret-id', error: {code: -32603, message: 'secret-message', data: 'secret-data'}, debug: 'secret-extra'}));
    const response = await request(`${proxy}/mcp`);
    expect(JSON.parse(response.body)).toEqual({jsonrpc: '2.0', id: 7, error: {code: -32603, message: 'Upstream request failed'}});
    expect(response.body).not.toContain('secret');
  });

  it.each(['invalid-json', 'sse', 'compressed', 'disconnect'])('returns a generic error for %s', async mode => {
    const {proxy} = await fixture((_req, res) => {
      if (mode === 'disconnect') return res.destroy();
      res.setHeader('Content-Type', mode === 'sse' ? 'text/event-stream' : 'application/json');
      if (mode === 'compressed') res.setHeader('Content-Encoding', 'gzip');
      res.end('secret-invalid-response');
    });
    const response = await request(`${proxy}/mcp`);
    expect(response.status).toBe(502);
    expect(response.body).not.toContain('secret');
  });

  it.each(['upload', 'upstream'])('times out the entire %s operation without exposing diagnostics', async mode => {
    let calls = 0;
    const {proxy} = await fixture((_req, _res) => {calls++;}, 40);
    const response = await request(`${proxy}/mcp`, {unfinished: mode === 'upload'});
    expect(response).toMatchObject({status: 504, body: '{"error":"Proxy request timed out"}'});
    expect(calls).toBe(mode === 'upload' ? 0 : 1);
  });
});
