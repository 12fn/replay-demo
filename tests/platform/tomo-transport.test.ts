import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KamiwazaClient, type FetchImpl, type RuntimeReadSpec, type RuntimeInvokeSpec,
  type RuntimeEventsSpec, type NativePlatformAdapter,
} from '../../src/platform/client.ts';
import { SIGNED_IDENTITY_HEADERS } from '../../src/platform/forward-auth.ts';
import { KamiwazaError } from '../../src/platform/errors.ts';

// Synthetic strings only; every HTTP operation is injected.
const API = 'https://core.example/api';
const TOKEN = 'synthetic-private-bearer';
const SIGNATURE = 'synthetic-private-signature';
const STABLE = 'synthetic-private-stable';
const AUTH_TOKEN = 'synthetic-private-auth-token';
const COOKIE = 'synthetic-private-cookie';
const UUID = '12345678-1234-4234-8234-123456789abc';
const MAX = 8 * 1024 * 1024;
const scope: RuntimeReadSpec = { extension: 'replay-tomo', origin: 'http://tomo.example:8000', path: '/api/conversations', subject: 'member' };
const invokeSpec: RuntimeInvokeSpec = { ...scope, idempotencyKey: 'retry-1' };
const eventsSpec: RuntimeEventsSpec = { ...scope, path: `/api/conversations/${UUID}/events?after=cursor%2B1%3A2` };
const signed: Record<string, string> = {
  ...Object.fromEntries(SIGNED_IDENTITY_HEADERS.map(name => [name, `signed-${name}`])),
  'x-user-id': 'member', 'x-workroom-id': 'room', 'x-user-signature': SIGNATURE,
  'x-user-signature-stable': STABLE, 'x-auth-token': AUTH_TOKEN, 'x-user-signature-ts': '12345',
};
const exposedHeaders = {
  'set-cookie': COOKIE, authorization: `Bearer ${TOKEN}`, 'x-user-signature': SIGNATURE,
  'x-user-signature-stable': STABLE, 'x-auth-token': AUTH_TOKEN, 'x-request-id': 'req-tomo',
};
interface Call { url: string; init: RequestInit; headers: Headers }
function harness(opts: {
  auth?: () => Response | Promise<Response>;
  target?: (call: Call) => Response | Promise<Response>;
  getToken?: () => string | Promise<string>;
  workroomId?: string | null;
  timeoutMs?: number;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    const call = { url, init, headers: new Headers(init.headers) }; calls.push(call);
    if (url === `${API}/auth/forward/validate`)
      return opts.auth ? opts.auth() : new Response(null, { headers: { ...signed, 'set-cookie': COOKIE, 'x-untrusted': 'drop-me' } });
    return opts.target ? opts.target(call) : new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', ...exposedHeaders } });
  });
  const client = new KamiwazaClient({ apiBase: API, fetchImpl, getToken: opts.getToken ?? (() => TOKEN),
    workroomId: opts.workroomId === undefined ? 'room' : opts.workroomId, timeoutMs: opts.timeoutMs ?? 1000 });
  return { client, calls, fetchImpl, targets: () => calls.filter(c => c.url !== `${API}/auth/forward/validate`) };
}
function liveBody() {
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(c) { upstream = c; }, cancel: cancelled }, { highWaterMark: 0 });
  return { body, upstream: () => upstream, cancelled };
}
function sse(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', ...exposedHeaders, ...headers } });
}
function noSecrets(value: unknown) {
  const dump = JSON.stringify(value) + (value instanceof Error ? value.stack : '');
  for (const secret of [TOKEN, SIGNATURE, STABLE, AUTH_TOKEN, COOKIE]) expect(dump).not.toContain(secret);
}
async function errorOf(pending: Promise<unknown>) {
  try { await pending; } catch (error) { expect(error).toBeInstanceOf(KamiwazaError); return error as KamiwazaError; }
  throw new Error('Expected transport failure');
}
const bytes = (text: string) => new TextEncoder().encode(text);
afterEach(() => vi.useRealTimers());

for (const kind of ['invoke', 'events'] as const) {
  describe(`Tomo ${kind} boundary`, () => {
    const call = (client: KamiwazaClient, overrides: Partial<RuntimeInvokeSpec & RuntimeEventsSpec> = {}) => kind === 'invoke'
      ? client.runtimeInvoke({ ...invokeSpec, ...overrides }) : client.runtimeEvents({ ...eventsSpec, ...overrides });
    it('requires a private bearer before any I/O', async () => {
      const h = harness({ getToken: () => '' });
      expect((await errorOf(call(h.client))).code).toBe('missing_credentials');
      expect(h.calls).toHaveLength(0);
    });
    it.each([
      [401, signed, 'auth_denied'], [403, signed, 'auth_denied'], [500, signed, 'auth_error'],
      [200, { ...signed, 'x-user-signature': '' }, 'missing_signature'],
      [200, { ...signed, 'x-user-id': '' }, 'missing_signature'],
      [200, { ...signed, 'x-user-id': 'other-member' }, 'auth_denied'],
      [200, { ...signed, 'x-workroom-id': 'other-room' }, 'auth_denied'],
      [200, { ...signed, 'x-workroom-id': '' }, 'auth_denied'],
    ] as const)('denies status %s / identity %# before target I/O', async (status, headers, code) => {
      const authBody = liveBody();
      const h = harness({ auth: () => new Response(authBody.body, { status, headers: { ...headers, 'x-request-id': SIGNATURE } }) });
      const error = await errorOf(call(h.client));
      expect(error.code).toBe(code); noSecrets(error);
      expect(h.calls).toHaveLength(1); expect(h.targets()).toHaveLength(0);
      expect(authBody.cancelled).toHaveBeenCalledOnce();
    });
    it.each(['ftp://tomo.example', 'https://name:password@tomo.example', 'https://tomo.example/api',
      'https://tomo.example/?query=1', 'https://tomo.example/#hash', '//tomo.example'])('rejects origin %s without I/O', async origin => {
      const h = harness(); expect((await errorOf(call(h.client, { origin }))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
    });
    it.each(['/api/conversations/../conversations', '/api/%2e%2e/conversations', '/api/%252e%252e/conversations',
      '/api//conversations', '//evil.example/api/conversations', '/api/conversations\\inputs', '/api/%2fconversations',
      '/api/conversations#fragment', '/api/conversations?after=x\ny', '/api/%zz', '/api/conversations%3fadmin',
      '/api/conversations/%00', `/api/conversations/${UUID}/delete`, '/api/conversations/not-a-uuid/events',
      '/api/conversations/' + 'x'.repeat(4100)])('rejects unsafe or unowned path %# before I/O', async path => {
      const h = harness(); expect((await errorOf(call(h.client, { path }))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
    });
    it('requires a bound extension, subject and workroom', async () => {
      for (const override of [{ extension: '../other' }, { subject: '' }]) {
        const h = harness(); expect((await errorOf(call(h.client, override))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
      }
      const h = harness({ workroomId: null }); expect((await errorOf(call(h.client))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
    });
    it.each(['é', "'", '"', '<cursor>'])('rejects query text that fetch would normalize: %s', async cursor => {
      const h = harness(); const path = (kind === 'invoke' ? invokeSpec.path : eventsSpec.path.split('?')[0]) + `?after=${cursor}`;
      expect((await errorOf(call(h.client, { path }))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
    });
    it('uses the validated scope even if the original spec changes during token resolution', async () => {
      let resolve!: (token: string) => void; const live = liveBody();
      const h = harness({ getToken: () => new Promise<string>(r => { resolve = r; }),
        ...(kind === 'events' ? { target: () => sse(live.body) } : {}) });
      const spec = kind === 'invoke' ? { ...invokeSpec } : { ...eventsSpec };
      const path = spec.path;
      const pending = kind === 'invoke' ? h.client.runtimeInvoke(spec as RuntimeInvokeSpec) : h.client.runtimeEvents(spec);
      spec.path = '/api/admin/delete'; spec.origin = 'https://other.example'; spec.subject = 'other-member'; spec.extension = 'other-app';
      resolve(TOKEN); const result = await pending;
      expect(h.calls[0].headers.get('x-forwarded-uri')).toBe(`/runtime/apps/replay-tomo${path}`);
      expect(h.targets()[0].url).toBe(scope.origin + path);
      if ('cancel' in result) result.cancel();
    });
    it('does not expose raw network or upstream auth failures', async () => {
      const h = harness({ target: () => { throw new Error(`${TOKEN} ${SIGNATURE} ${STABLE} ${AUTH_TOKEN} ${COOKIE}`); } });
      const error = await errorOf(call(h.client)); expect(error.code).toBe('network_error'); noSecrets(error);
    });
    it.each(['auth', 'target'] as const)('refuses %s redirects without forwarding cookies', async stage => {
      const redirect = () => new Response(null, { status: 302, headers: { location: 'https://other.example', 'set-cookie': COOKIE } });
      const h = harness(stage === 'auth' ? { auth: redirect } : { target: redirect });
      noSecrets(await errorOf(call(h.client)));
      expect(h.calls).toHaveLength(stage === 'auth' ? 1 : 2);
      for (const request of h.calls) {
        expect(request.init.redirect).toBe('error'); expect(request.init.credentials).toBe('omit'); expect(request.headers.has('cookie')).toBe(false);
      }
    });
    it.each(['auth', 'target'] as const)('enforces the normal response-header timeout at %s', async stage => {
      vi.useFakeTimers();
      const never = () => new Promise<Response>(() => {});
      const h = harness({ timeoutMs: 25, ...(stage === 'auth' ? { auth: never } : { target: never }) });
      const pending = errorOf(call(h.client));
      await vi.advanceTimersByTimeAsync(25);
      expect((await pending).code).toBe('timeout');
      expect(h.calls).toHaveLength(stage === 'auth' ? 1 : 2);
      expect(h.calls.at(-1)!.init.signal!.aborted).toBe(true);
    });
    it('discards and cancels a target response that arrives after the header timeout', async () => {
      vi.useFakeTimers(); let resolve!: (response: Response) => void;
      const h = harness({ timeoutMs: 25, target: () => new Promise<Response>(r => { resolve = r; }) });
      const pending = errorOf(call(h.client)); await vi.advanceTimersByTimeAsync(25);
      expect((await pending).code).toBe('timeout');
      const late = liveBody(); resolve(sse(late.body)); await vi.advanceTimersByTimeAsync(0);
      expect(late.cancelled).toHaveBeenCalledOnce();
    });
  });
}

describe('Tomo POST invocation', () => {
  it.each(['/api/conversations', `/api/conversations/${UUID}/inputs?mode=append`, '/api/conversations/54edeaaf04645a89a71bd1703715b9f9/inputs'])('signs the exact POST URI %s and only forwards allowed fields', async path => {
    const h = harness();
    const result = await h.client.runtimeInvoke({ ...invokeSpec, path, body: { text: 'hello' },
      headers: { authorization: 'forged', cookie: 'forged', 'x-workroom-id': 'forged', 'x-extra': 'forged' }, method: 'DELETE',
    } as RuntimeInvokeSpec);
    const [auth, target] = h.calls;
    expect(auth.headers.get('x-forwarded-method')).toBe('POST');
    expect(auth.headers.get('x-forwarded-uri')).toBe(`/runtime/apps/replay-tomo${path}`);
    expect(auth.headers.get('idempotency-key')).toBeNull();
    expect(target.url).toBe(scope.origin + path); expect(target.init.method).toBe('POST');
    expect(target.init.body).toBe('{"text":"hello"}');
    expect(target.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(target.headers.get('idempotency-key')).toBe('retry-1');
    expect(target.headers.get('content-type')).toBe('application/json');
    for (const name of SIGNED_IDENTITY_HEADERS) expect(target.headers.get(name)).toBe(signed[name]);
    expect([...target.headers.keys()].sort()).toEqual([...SIGNED_IDENTITY_HEADERS, 'authorization', 'idempotency-key', 'content-type'].sort());
    expect(new TextDecoder().decode(result.body)).toBe('{"ok":true}');
    expect(result.status).toBe(201); expect(result.contentType).toBe('application/json');
    expect(result.receipt).toMatchObject({ requestId: 'req-tomo', target: { method: 'POST', path: `/runtime/apps/replay-tomo${path.split('?')[0]}` }, signatureTs: '12345' });
    expect(Object.keys(result).sort()).toEqual(['body', 'status', 'contentType', 'identity', 'receipt'].sort());
    noSecrets(result); noSecrets(h.client);
  });
  it('resolves the rotated bearer independently for every operation', async () => {
    let token = TOKEN;
    const h = harness({ getToken: () => token });
    await h.client.runtimeInvoke(invokeSpec);
    token = 'synthetic-rotated-bearer';
    await h.client.runtimeInvoke(invokeSpec);
    expect(h.calls.map(c => c.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${token}`, `Bearer ${token}`]);
    expect(h.targets()[1].init.body).toBeUndefined();
  });
  it.each([undefined, '', 'x'.repeat(201), 'line\r\nbreak', 'key\u0000', 'clé'])('rejects invalid idempotency key %# before I/O', async key => {
    const h = harness(); expect((await errorOf(h.client.runtimeInvoke({ ...invokeSpec, idempotencyKey: key as string }))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
  });
  it.each(['x', 'x'.repeat(200)])('accepts idempotency boundary %# unchanged', async key => {
    const h = harness(); await h.client.runtimeInvoke({ ...invokeSpec, idempotencyKey: key }); expect(h.targets()[0].headers.get('idempotency-key')).toBe(key);
  });
  it('refuses non-serializable JSON without I/O or raw errors', async () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const body of [cyclic, 1n, () => {}, { toJSON() { throw new Error(SIGNATURE); } }]) {
      const h = harness(); const error = await errorOf(h.client.runtimeInvoke({ ...invokeSpec, body }));
      expect(error.code).toBe('invalid_request'); noSecrets(error); expect(h.calls).toHaveLength(0);
    }
  });
  it.each(['declared', 'chunk', 'aggregate'] as const)('bounds the %s response to 8 MiB and cancels upstream', async kind => {
    const live = liveBody();
    const h = harness({ target: () => new Response(live.body, { headers: kind === 'declared' ? { 'content-length': String(MAX + 1) } : {} }) });
    const pending = errorOf(h.client.runtimeInvoke(invokeSpec));
    if (kind === 'chunk') live.upstream().enqueue(new Uint8Array(MAX + 1));
    if (kind === 'aggregate') { live.upstream().enqueue(new Uint8Array(MAX)); live.upstream().enqueue(new Uint8Array(1)); }
    expect((await pending).code).toBe('malformed_response'); expect(live.cancelled).toHaveBeenCalledOnce();
    expect(h.targets()[0].init.signal!.aborted).toBe(true);
  });
  it('accepts exactly 8 MiB and preserves a non-success target status', async () => {
    const h = harness({ target: () => new Response(new Uint8Array(MAX), { status: 409 }) });
    const result = await h.client.runtimeInvoke(invokeSpec); expect(result.body.byteLength).toBe(MAX); expect(result.status).toBe(409);
  });
  it('keeps the normal timeout active while consuming the POST body', async () => {
    vi.useFakeTimers(); const live = liveBody();
    const h = harness({ timeoutMs: 25, target: () => new Response(live.body) });
    const pending = errorOf(h.client.runtimeInvoke(invokeSpec)); await vi.advanceTimersByTimeAsync(25);
    expect((await pending).code).toBe('timeout'); expect(live.cancelled).toHaveBeenCalledOnce();
  });
});

describe('Tomo live SSE', () => {
  it('delivers chunks before EOF, signs the exact cursor, and stays open beyond the header timeout and 8 MiB total', async () => {
    vi.useFakeTimers(); const live = liveBody();
    const h = harness({ timeoutMs: 25, target: () => sse(live.body, { 'content-length': String(MAX * 20) }) });
    const adapter: NativePlatformAdapter = h.client;
    const result = await adapter.runtimeEvents!({ ...eventsSpec, headers: { 'last-event-id': 'forged', authorization: 'forged' } } as RuntimeEventsSpec);
    const [auth, target] = h.calls;
    expect(auth.headers.get('x-forwarded-method')).toBe('GET');
    expect(auth.headers.get('x-forwarded-uri')).toBe(`/runtime/apps/replay-tomo${eventsSpec.path}`);
    expect(target.url).toBe(scope.origin + eventsSpec.path); expect(target.init.method).toBe('GET');
    expect([...target.headers.keys()].sort()).toEqual([...SIGNED_IDENTITY_HEADERS, 'authorization', 'accept'].sort());
    for (const name of SIGNED_IDENTITY_HEADERS) expect(target.headers.get(name)).toBe(signed[name]);
    expect(target.headers.get('accept')).toBe('text/event-stream');
    noSecrets(result); expect(result.status).toBe(200);
    const reader = result.body.getReader();
    live.upstream().enqueue(bytes('id: 1\ndata: first\n\n'));
    expect((await reader.read()).value).toEqual(bytes('id: 1\ndata: first\n\n'));
    await vi.advanceTimersByTimeAsync(1000); expect(target.init.signal!.aborted).toBe(false);
    for (let i = 0; i < 3; i++) {
      live.upstream().enqueue(new Uint8Array(MAX / 2)); expect((await reader.read()).value?.byteLength).toBe(MAX / 2);
    }
    expect(live.cancelled).not.toHaveBeenCalled(); live.upstream().close(); expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['signal', 'result', 'reader'] as const)('propagates %s cancellation to the pending upstream read and fetch', async kind => {
    const live = liveBody(), caller = new AbortController();
    const h = harness({ target: () => sse(live.body) });
    const result = await h.client.runtimeEvents({ ...eventsSpec, signal: caller.signal });
    const reader = result.body.getReader();
    const pending = reader.read();
    const settled = kind === 'reader' ? pending : errorOf(pending);
    if (kind === 'signal') caller.abort(new Error(SIGNATURE));
    else if (kind === 'result') { result.cancel(); result.cancel(); }
    else await reader.cancel(new Error(SIGNATURE));
    const value = await settled;
    if (kind === 'reader') expect(value).toMatchObject({ done: true }); else noSecrets(value);
    expect(h.targets()[0].init.signal!.aborted).toBe(true); expect(live.cancelled).toHaveBeenCalledOnce();
    expect(live.cancelled.mock.calls[0]).not.toContain(SIGNATURE);
  });
  it('cancels an unread stream immediately', async () => {
    const live = liveBody(); const h = harness({ target: () => sse(live.body) });
    const result = await h.client.runtimeEvents(eventsSpec); result.cancel();
    expect(live.cancelled).toHaveBeenCalledOnce(); noSecrets(await errorOf(result.body.getReader().read()));
  });
  it('does not prefetch upstream data before a consumer reads', async () => {
    const pulls = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ pull: pulls }, { highWaterMark: 0 });
    const h = harness({ target: () => sse(upstream) });
    const result = await h.client.runtimeEvents(eventsSpec);
    await Promise.resolve(); expect(pulls).not.toHaveBeenCalled();
    const reader = result.body.getReader(), pending = errorOf(reader.read());
    await Promise.resolve(); expect(pulls).toHaveBeenCalledOnce(); result.cancel(); await pending;
  });
  it('rejects a single oversized chunk and hides upstream body failures', async () => {
    for (const oversized of [true, false]) {
      const live = liveBody(); const h = harness({ target: () => sse(live.body) });
      const result = await h.client.runtimeEvents(eventsSpec), reader = result.body.getReader();
      const pending = errorOf(reader.read());
      if (oversized) live.upstream().enqueue(new Uint8Array(MAX + 1)); else live.upstream().error(new Error(`${SIGNATURE} ${COOKIE}`));
      const error = await pending; expect(error.code).toBe(oversized ? 'malformed_response' : 'network_error'); noSecrets(error);
      expect(h.targets()[0].init.signal!.aborted).toBe(true);
    }
  });
  it('rejects an already-aborted signal before any I/O', async () => {
    const caller = new AbortController(); caller.abort(new Error(SIGNATURE)); const h = harness();
    noSecrets(await errorOf(h.client.runtimeEvents({ ...eventsSpec, signal: caller.signal }))); expect(h.calls).toHaveLength(0);
  });
  it('cancels during ForwardAuth without contacting the target', async () => {
    const caller = new AbortController(); let resolve!: (r: Response) => void;
    const h = harness({ auth: () => new Promise<Response>(r => { resolve = r; }) });
    const pending = errorOf(h.client.runtimeEvents({ ...eventsSpec, signal: caller.signal }));
    await vi.waitFor(() => expect(h.calls).toHaveLength(1)); caller.abort();
    expect((await pending).code).toBe('timeout'); resolve(new Response(null, { headers: signed }));
    await Promise.resolve(); expect(h.targets()).toHaveLength(0);
  });
  it('disposes the caller abort subscription on normal EOF', async () => {
    const caller = new AbortController(), live = liveBody(); const h = harness({ target: () => sse(live.body) });
    const result = await h.client.runtimeEvents({ ...eventsSpec, signal: caller.signal }); live.upstream().close();
    expect((await result.body.getReader().read()).done).toBe(true); caller.abort();
    expect(h.targets()[0].init.signal!.aborted).toBe(false); expect(live.cancelled).not.toHaveBeenCalled();
  });
  it.each(['/api/conversations', `/api/conversations/${UUID}/inputs`, `/api/conversations/${UUID}/events?lastEventId=1`,
    `/api/conversations/${UUID}/events?after=1&after=2`])('refuses non-event paths/cursor headers represented as query %#', async path => {
    const h = harness(); expect((await errorOf(h.client.runtimeEvents({ ...eventsSpec, path }))).code).toBe('invalid_request'); expect(h.calls).toHaveLength(0);
  });
  it.each(['application/json', 'text/html', 'text/event-streaming'])('rejects non-SSE type %s without exposing the body', async contentType => {
    const live = liveBody(); const h = harness({ target: () => new Response(live.body, { headers: { 'content-type': contentType } }) });
    expect((await errorOf(h.client.runtimeEvents(eventsSpec))).code).toBe('malformed_response'); expect(live.cancelled).toHaveBeenCalledOnce();
  });
});
