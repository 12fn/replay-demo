import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchImpl } from '../../src/platform/client.ts';
import { KamiwazaError } from '../../src/platform/errors.ts';
import { SIGNED_IDENTITY_HEADERS } from '../../src/platform/forward-auth.ts';
import { openNativeModelRuntime, type NativeModelRuntimeOptions } from '../../src/platform/model-runtime.ts';

const API = 'http://core.internal:8000/api';
const DEPLOYMENT = '2d3eb592-0b82-48e9-bc3f-efe896e9158e';
const SERVE = '/64800810-7c73-4cd9-a36c-3106fe48776d';
const TOKEN = 'synthetic-member-bearer';
const SIGNATURE = 'synthetic-private-signature';
const STABLE = 'synthetic-stable-signature';
const AUTH_TOKEN = 'synthetic-auth-token';
const COOKIE = 'synthetic-private-cookie';
const MAX = 1024 * 1024;
const signed: Record<string, string> = Object.fromEntries(SIGNED_IDENTITY_HEADERS.map(name => [name, `value-${name}`]));
Object.assign(signed, { 'x-user-id': 'member', 'x-workroom-id': 'room', 'x-verified-workroom-scope': 'room',
  'x-authz-outcome': 'allowed', 'x-user-signature': SIGNATURE, 'x-user-signature-stable': STABLE,
  'x-auth-token': AUTH_TOKEN, 'x-user-signature-ts': '1726200000' });
const defaults: Omit<NativeModelRuntimeOptions, 'fetchImpl'> = {
  apiBase: API, forwardedHost: 'core.example:443', workroomId: 'room', subject: 'member',
  deploymentId: DEPLOYMENT, servePath: SERVE, token: TOKEN, method: 'GET',
};
type Call = { url: string; init: RequestInit; headers: Headers };
type Reply = () => Response | Promise<Response>;
function harness(auth?: Reply, target?: Reply) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    calls.push({ url, init, headers: new Headers(init.headers) });
    return calls.length === 1
      ? (auth ? auth() : new Response(null, { headers: { ...signed, 'x-request-id': 'native-auth-123' } }))
      : (target ? target() : new Response('data: hello\n\n', { headers: {
        'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'provider-id',
        'set-cookie': COOKIE, 'x-private': AUTH_TOKEN,
      } }));
  });
  return { calls, fetchImpl, open: (overrides: Partial<NativeModelRuntimeOptions> = {}) =>
    openNativeModelRuntime({ ...defaults, fetchImpl, ...overrides }) };
}
function live() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const pulled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull: pulled, cancel: cancelled }, { highWaterMark: 0 });
  return { body, controller: () => controller, cancelled, pulled };
}
function noSecrets(value: unknown) {
  const text = JSON.stringify(value) + (value instanceof Error ? value.stack : '');
  for (const secret of [TOKEN, SIGNATURE, STABLE, AUTH_TOKEN, COOKIE]) expect(text).not.toContain(secret);
}
async function errorOf(pending: Promise<unknown>) {
  try { await pending; } catch (error) {
    expect(error).toBeInstanceOf(KamiwazaError); noSecrets(error); return error as KamiwazaError;
  }
  throw new Error('Expected a transport error');
}
async function consume(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let length = 0;
  try { while (true) { const next = await reader.read(); if (next.done) return length; length += next.value.byteLength; } }
  finally { reader.releaseLock(); }
}
afterEach(() => vi.useRealTimers());

describe('native model authority and pinned routes', () => {
  it.each(['GET', 'POST'] as const)('validates exact %s native URI and forwards the unchanged signed envelope to Core', async method => {
    const h = harness();
    const result = await h.open({ method, ...(method === 'POST' ? { body: { messages: [], stream: true } } : {}) });
    const suffix = method === 'GET' ? '/v1/models' : '/v1/chat/completions';
    const [auth, target] = h.calls;
    expect(auth.url).toBe(`${API}/auth/forward/validate`);
    expect(auth.init.method).toBe('GET');
    expect(Object.fromEntries(auth.headers)).toEqual({ accept: 'application/json', authorization: `Bearer ${TOKEN}`,
      'x-forwarded-method': method, 'x-forwarded-uri': `/runtime/models/${DEPLOYMENT}${suffix}`,
      'x-forwarded-host': 'core.example:443', 'x-forwarded-proto': 'https', 'x-workroom-id': 'room' });
    expect(target.url).toBe(`http://core.internal:8000${SERVE}${suffix}`);
    expect(target.init.method).toBe(method);
    expect(target.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    for (const name of SIGNED_IDENTITY_HEADERS) expect(target.headers.get(name)).toBe(signed[name]);
    expect([...target.headers.keys()].sort()).toEqual([...SIGNED_IDENTITY_HEADERS, 'authorization',
      ...(method === 'POST' ? ['content-type'] : [])].sort());
    expect(target.init.body).toBe(method === 'POST' ? '{"messages":[],"stream":true}' : undefined);
    for (const call of h.calls) {
      expect(call.init.credentials).toBe('omit'); expect(call.init.redirect).toBe('error');
      expect(call.headers.has('cookie')).toBe(false);
    }
    expect(result.receipt).toEqual({ clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/), requestId: 'native-auth-123',
      target: { method, path: `/runtime/models/${DEPLOYMENT}${suffix}` }, status: 200, durationMs: expect.any(Number),
      validatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), signatureTs: '1726200000' });
    expect(result.contentType).toBe('text/event-stream');
    expect(Object.keys(result).sort()).toEqual(['body', 'cancel', 'contentType', 'receipt', 'status']);
    noSecrets(result); expect(await consume(result.body)).toBe(13);
    expect(h.calls).toHaveLength(2);
  });

  it.each([401, 403, 404, 429, 500, 302, 204])('auth status %s never reaches serving and cancels its body', async status => {
    const stream = live();
    const h = harness(() => new Response(status === 204 ? null : stream.body, { status, headers: signed }));
    const error = await errorOf(h.open());
    expect(error.code).toBe(status === 401 || status === 403 ? 'auth_denied' : 'auth_error');
    expect(h.calls).toHaveLength(1);
    if (status !== 204) expect(stream.cancelled).toHaveBeenCalledOnce();
    expect(h.calls[0].init.signal!.aborted).toBe(true);
  });

  it.each<Record<string, string>>([
    { 'x-user-id': 'attacker' }, { 'x-workroom-id': 'other-room' }, { 'x-workroom-id': '' },
    { 'x-verified-workroom-scope': 'other-room' }, { 'x-authz-outcome': 'deny' },
    { 'x-user-signature': '' }, { 'x-user-id': '' },
  ])('rejects missing signatures and cross-identity scope %#', async mismatch => {
    const stream = live();
    const h = harness(() => new Response(stream.body, { headers: { ...signed, ...mismatch } }));
    await errorOf(h.open()); expect(h.calls).toHaveLength(1); expect(stream.cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    'ftp://core.internal/api', 'https://user:password@core.internal/api', 'https://@core.internal/api',
    'https://core.internal/api?', 'https://core.internal/api#', 'https://core.internal/api?target=evil',
    'https://core.internal/api#secret', 'https://core.internal/other/api', 'https://core.internal/api/',
    'https://core.internal/x/../api', '//core.internal/api', 'https://core.internal\\evil/api',
    ' https://core.internal/api',
  ])('rejects prohibited API base %# without I/O', async apiBase => {
    const h = harness(); expect((await errorOf(h.open({ apiBase }))).code).toBe('invalid_config'); expect(h.calls).toHaveLength(0);
  });

  it.each(['', '/', '//evil.example', '/api', `${SERVE}/`, `${SERVE}/v1/models`, `${SERVE}?x=1`, `${SERVE}#x`,
    '/%2e%2e', '/%252e%252e', `/../${DEPLOYMENT}`, `https://evil.example${SERVE}`, `${SERVE}\n`])('rejects servePath %# without I/O', async servePath => {
    const h = harness(); await errorOf(h.open({ servePath })); expect(h.calls).toHaveLength(0);
  });
  it.each(['', 'not-a-uuid', `${DEPLOYMENT}/v1/models`, `${DEPLOYMENT}?x=1`, `/${DEPLOYMENT}`, `%2f${DEPLOYMENT}`, `${DEPLOYMENT}\n`])(
    'rejects deployment ID %# without I/O', async deploymentId => {
      const h = harness(); await errorOf(h.open({ deploymentId })); expect(h.calls).toHaveLength(0);
    });
  it.each([{ method: 'DELETE' }, { method: 'get' }, { subject: '' }, { workroomId: '' }, { token: '' },
    { token: 'bad\r\nheader' }, { forwardedHost: 'https://evil.example' }, { forwardedHost: 'host\nforged' },
    { forwardedProto: 'file' }, { body: {} }, { subject: 'member\n' }, { workroomId: 'room\n' },
    { token: `${TOKEN}\n` }, { forwardedHost: 'core.example\n' }])('rejects invalid request/configuration %# before I/O', async overrides => {
    const h = harness(); await errorOf(h.open(overrides as Partial<NativeModelRuntimeOptions>)); expect(h.calls).toHaveLength(0);
  });

  it('ignores undeclared URL/path/header overrides and snapshots configuration before serialization', async () => {
    const h = harness();
    const options = { ...defaults, fetchImpl: h.fetchImpl, method: 'POST' as const,
      path: '/admin/delete', url: 'https://evil.example', headers: { authorization: 'forged' },
      body: { toJSON() { options.apiBase = 'https://evil.example/api'; options.servePath = '/admin';
        options.subject = 'attacker'; options.token = 'forged'; return { stream: true }; } } };
    const result = await openNativeModelRuntime(options);
    expect(h.calls[1].url).toBe(`http://core.internal:8000${SERVE}/v1/chat/completions`);
    expect(h.calls[1].headers.get('authorization')).toBe(`Bearer ${TOKEN}`); result.cancel();
  });
});

describe('native model bounds and lifecycle', () => {
  it('accepts exactly 64 KiB of serialized UTF-8 and rejects one extra byte before auth', async () => {
    const accepted = harness();
    const result = await accepted.open({ method: 'POST', body: 'é'.repeat(32767) });
    expect(new TextEncoder().encode(accepted.calls[1].init.body as string).length).toBe(65536); result.cancel();
    const denied = harness(); await errorOf(denied.open({ method: 'POST', body: 'é'.repeat(32767) + 'x' }));
    expect(denied.calls).toHaveLength(0);
  });
  it('rejects non-JSON requests without leaking serialization errors', async () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const body of [cyclic, 1n, () => {}, { toJSON() { throw new Error(TOKEN); } }]) {
      const h = harness(); expect((await errorOf(h.open({ method: 'POST', body }))).code).toBe('invalid_request');
      expect(h.calls).toHaveLength(0);
    }
  });
  it.each([200, 401, 429, 500])('returns bounded response bodies with status %s without interpreting them', async status => {
    const h = harness(undefined, () => new Response(new Uint8Array(MAX), { status }));
    const result = await h.open(); expect(result.status).toBe(status); expect(result.receipt.status).toBe(status);
    expect(await consume(result.body)).toBe(MAX);
  });
  it.each(['declared', 'chunk', 'aggregate'] as const)('rejects oversized %s and cancels upstream', async kind => {
    const stream = live(); const h = harness(undefined, () => new Response(stream.body, {
      headers: kind === 'declared' ? { 'content-length': String(MAX + 1) } : {},
    }));
    if (kind === 'declared') expect((await errorOf(h.open())).code).toBe('malformed_response');
    else {
      const result = await h.open(), reader = result.body.getReader();
      stream.controller().enqueue(new Uint8Array(kind === 'chunk' ? MAX + 1 : MAX));
      if (kind === 'aggregate') { expect((await reader.read()).value?.length).toBe(MAX); stream.controller().enqueue(new Uint8Array(1)); }
      expect((await errorOf(reader.read())).code).toBe('malformed_response');
    }
    expect(stream.cancelled).toHaveBeenCalledOnce(); expect(h.calls[1].init.signal!.aborted).toBe(true);
  });
  it.each(['auth', 'target'] as const)('times out stalled %s headers after 15 seconds, including fetch ignoring abort', async stage => {
    vi.useFakeTimers(); let resolve!: (r: Response) => void;
    const stalled = () => new Promise<Response>(r => { resolve = r; });
    const h = harness(stage === 'auth' ? stalled : undefined, stage === 'target' ? stalled : undefined);
    const pending = errorOf(h.open()); await vi.advanceTimersByTimeAsync(14999);
    expect(h.calls.at(-1)!.init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).code).toBe('timeout');
    expect(h.calls).toHaveLength(stage === 'auth' ? 1 : 2); expect(vi.getTimerCount()).toBe(0);
    const late = live(); resolve(new Response(late.body, { headers: signed })); await vi.advanceTimersByTimeAsync(0);
    expect(late.cancelled).toHaveBeenCalledOnce(); expect(h.calls).toHaveLength(stage === 'auth' ? 1 : 2);
  });
  it.each([true, false])('enforces the 90-second overall deadline including auth and unread=%s streaming', async unread => {
    vi.useFakeTimers(); const stream = live();
    const h = harness(() => new Promise(r => setTimeout(() => r(new Response(null, { headers: signed })), 10000)),
      () => new Response(stream.body));
    const opening = h.open(); await vi.advanceTimersByTimeAsync(10000); const result = await opening;
    const pending = unread ? undefined : errorOf(result.body.getReader().read());
    await vi.advanceTimersByTimeAsync(79999); expect(h.calls[1].init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await (pending ?? errorOf(result.body.getReader().read()))).code).toBe('timeout');
    expect(stream.cancelled).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['signal', 'result', 'reader'] as const)('propagates %s cancellation safely during a pending read', async kind => {
    const stream = live(), caller = new AbortController(); const h = harness(undefined, () => new Response(stream.body));
    const result = await h.open({ signal: caller.signal }), reader = result.body.getReader();
    const pending = kind === 'reader' ? reader.read() : errorOf(reader.read());
    if (kind === 'signal') caller.abort(new Error(TOKEN));
    else if (kind === 'result') { result.cancel(); result.cancel(); }
    else await reader.cancel(new Error(SIGNATURE));
    const value = await pending;
    if (kind === 'reader') expect(value).toMatchObject({ done: true });
    expect(stream.cancelled).toHaveBeenCalledOnce(); expect(stream.cancelled.mock.calls[0]).toEqual([undefined]);
    expect(h.calls[1].init.signal!.aborted).toBe(true);
  });
  it.each(['before', 'auth', 'target'] as const)('propagates caller abort at %s with no later upstream attempt', async stage => {
    const caller = new AbortController(); let resolve!: (r: Response) => void;
    const stalled = () => new Promise<Response>(r => { resolve = r; });
    const h = harness(stage === 'auth' ? stalled : undefined, stage === 'target' ? stalled : undefined);
    if (stage === 'before') caller.abort(TOKEN);
    const pending = errorOf(h.open({ signal: caller.signal }));
    if (stage !== 'before') { await vi.waitFor(() => expect(h.calls).toHaveLength(stage === 'auth' ? 1 : 2)); caller.abort(TOKEN); }
    expect((await pending).code).toBe('timeout');
    if (stage === 'before') expect(h.calls).toHaveLength(0);
    else { const late = live(); resolve(new Response(late.body, { headers: signed }));
      await vi.waitFor(() => expect(late.cancelled).toHaveBeenCalledOnce()); }
    expect(h.calls).toHaveLength(stage === 'before' ? 0 : stage === 'auth' ? 1 : 2);
  });
  it('does not prefetch, delivers before EOF, and removes timers/listeners on completion', async () => {
    vi.useFakeTimers(); const stream = live(), caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const h = harness(undefined, () => new Response(stream.body));
    const result = await h.open({ signal: caller.signal }); await Promise.resolve(); expect(stream.pulled).not.toHaveBeenCalled();
    const reader = result.body.getReader(); stream.controller().enqueue(new Uint8Array([1, 2]));
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    await vi.advanceTimersByTimeAsync(16000); expect(h.calls[1].init.signal!.aborted).toBe(false);
    stream.controller().close(); expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalled(); caller.abort(); result.cancel();
    expect(h.calls[1].init.signal!.aborted).toBe(false); expect(stream.cancelled).not.toHaveBeenCalled();
  });
  it('returns a usable empty stream for a bodyless response', async () => {
    const h = harness(undefined, () => new Response(null, { status: 204 }));
    const result = await h.open(); expect(await consume(result.body)).toBe(0); expect(result.status).toBe(204);
  });
});

describe('native model safe metadata and failures', () => {
  it.each(['auth', 'target'] as const)('suppresses raw %s fetch errors, even forged adapter errors, and never retries', async stage => {
    const fail = () => { throw new KamiwazaError('http_error', `${TOKEN} ${SIGNATURE} ${COOKIE}`); };
    const h = harness(stage === 'auth' ? fail : undefined, stage === 'target' ? fail : undefined);
    expect((await errorOf(h.open())).code).toBe('network_error'); expect(h.calls).toHaveLength(stage === 'auth' ? 1 : 2);
  });
  it('suppresses raw stream failures and aborts fetch', async () => {
    const stream = live(); const h = harness(undefined, () => new Response(stream.body));
    const result = await h.open(), pending = errorOf(result.body.getReader().read());
    stream.controller().error(new Error(`${TOKEN} ${SIGNATURE}`)); expect((await pending).code).toBe('network_error');
    expect(h.calls[1].init.signal!.aborted).toBe(true);
  });
  it.each([TOKEN, SIGNATURE, STABLE, AUTH_TOKEN, COOKIE, '<script>alert(1)</script>', 'a'.repeat(129), 'header: Bearer secret']) (
    'drops unsafe receipt header %# while preserving the signed envelope', async bad => {
      const h = harness(() => new Response(null, { headers: { ...signed, 'x-request-id': bad, 'x-user-signature-ts': bad,
        'set-cookie': COOKIE } }));
      const result = await h.open(); expect(result.receipt.requestId).toBeNull(); expect(result.receipt.signatureTs).toBeNull();
      expect(h.calls[1].headers.get('x-user-signature-ts')).toBe(bad); noSecrets(result); result.cancel();
    });
  it('does not fall back to the provider request ID when auth omitted it', async () => {
    const h = harness(() => new Response(null, { headers: signed })); const result = await h.open();
    expect(result.receipt.requestId).toBeNull(); result.cancel();
  });
  it.each([302, 307, 308])('refuses target redirect %s and cancels its body', async status => {
    const stream = live(); const h = harness(undefined, () => new Response(stream.body, { status,
      headers: { location: 'https://evil.example', 'set-cookie': COOKIE } }));
    expect((await errorOf(h.open())).code).toBe('http_error'); expect(stream.cancelled).toHaveBeenCalledOnce();
    expect(h.calls).toHaveLength(2);
  });
});
