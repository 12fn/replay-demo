import type { FetchImpl, RequestReceipt } from './client.ts';
import { KamiwazaError, redactSecrets } from './errors.ts';
import { buildForwardAuthHeaders, extractSignedIdentity } from './forward-auth.ts';

export interface NativeModelRuntimeOptions {
  /** Trusted operator configuration: the same Core API used for authentication. */
  apiBase: string;
  workroomId: string;
  forwardedHost: string;
  forwardedProto?: string;
  /** Operator-pinned native inventory pair; neither value comes from a browser. */
  deploymentId: string;
  servePath: string;
  subject: string;
  token: string;
  method: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
}

export interface NativeModelRuntimeResult {
  body: ReadableStream<Uint8Array>;
  status: number;
  contentType: string;
  /** requestId is the actual Core ForwardAuth request ID, not a provider ID. */
  receipt: RequestReceipt;
  cancel(): void;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const MAX_REQUEST = 64 * 1024;
const MAX_STREAM = 1024 * 1024;
const HEADER_MS = 15_000;
const OVERALL_MS = 90_000;

function discard(body: ReadableStream<Uint8Array> | null): void {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

/** Only short plain metadata survives; never substitute an invented native ID. */
function metadata(value: string | null, secrets: string[], timestamp = false): string | null {
  if (!value || value.trim() !== value || !(timestamp ? /^\d{1,20}(?:\.\d{1,9})?$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).test(value)) return null;
  if (secrets.some(secret => secret.length > 0 && value.includes(secret)) || redactSecrets(value) !== value) return null;
  return value;
}

function privateValues(headers: Headers): string[] {
  const publicNames = new Set(['x-request-id', 'x-user-signature-ts', 'content-type', 'content-length']);
  return [...headers].filter(([name]) => !publicNames.has(name)).map(([, value]) => value);
}

/**
 * One native authorization followed by one Core registered serving request.
 * No retries, provider authority, discovery, or arbitrary URL/path input.
 * The caller owns fresh member/agent permission checks before and after reading.
 */
export async function openNativeModelRuntime(options: NativeModelRuntimeOptions): Promise<NativeModelRuntimeResult> {
  // Snapshot before serialization can execute caller code or any await can yield.
  const { apiBase, workroomId, forwardedHost, forwardedProto = 'https', deploymentId,
    servePath, subject, token, method, body: inputBody, signal, fetchImpl = fetch } = options;
  let base: URL;
  try {
    base = new URL(apiBase);
    // Strict spelling also rejects URL normalization, empty ?/# and credential URLs.
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
        base.pathname !== '/api' || base.search || base.hash || base.href !== apiBase ||
        !/^https?:\/\/[^/@?#\\]+\/api$/.test(apiBase)) throw new Error();
  } catch { throw new KamiwazaError('invalid_config', 'Invalid configured Core API base'); }
  if (typeof deploymentId !== 'string' || deploymentId.length !== 36 || !new RegExp(`^${UUID}$`).test(deploymentId) ||
      typeof servePath !== 'string' || servePath.length !== 37 || !new RegExp(`^/${UUID}$`).test(servePath))
    throw new KamiwazaError('invalid_config', 'Invalid configured native model inventory pair');
  if (typeof forwardedHost !== 'string' || forwardedHost.trim() !== forwardedHost || !/^[A-Za-z0-9.\-\[\]:]{1,253}$/.test(forwardedHost) ||
      !['http', 'https'].includes(forwardedProto))
    throw new KamiwazaError('invalid_config', 'Invalid configured forwarded authority');
  if (![subject, workroomId].every(value => typeof value === 'string' && value.trim() === value && /^[\x21-\x7e]{1,256}$/.test(value)) ||
      !['GET', 'POST'].includes(method) || (method === 'GET' && inputBody !== undefined))
    throw new KamiwazaError('invalid_request', 'Invalid native model request');
  if (typeof token !== 'string' || token.trim() !== token || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token))
    throw new KamiwazaError('missing_credentials', 'A member bearer is required');

  const started = performance.now();
  let body: string | undefined;
  try {
    if (inputBody !== undefined) {
      body = JSON.stringify(inputBody);
      if (body === undefined || new TextEncoder().encode(body).byteLength > MAX_REQUEST) throw new Error();
    }
  } catch { throw new KamiwazaError('invalid_request', 'Native model JSON request exceeds its bound or is not serializable'); }
  const suffix = method === 'GET' ? '/v1/models' : '/v1/chat/completions';
  const path = `/runtime/models/${deploymentId}${suffix}`;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  let failure: KamiwazaError | undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    clearTimeout(overallTimer);
    clearTimeout(headerTimer);
    signal?.removeEventListener('abort', abort);
  };
  const stop = (error: KamiwazaError) => {
    if (finished) return;
    finished = true;
    failure = error;
    dispose();
    output?.error(error);
    controller.abort(); // Never forward a caller's potentially private abort reason.
    if (reader) {
      const owned = reader;
      void owned.cancel().catch(() => {}).finally(() => owned.releaseLock());
    }
  };
  const abort = () => stop(new KamiwazaError('timeout', 'Native model request cancelled'));
  const overallTimer = setTimeout(() => stop(new KamiwazaError('timeout', 'Native model overall deadline exceeded')),
    Math.max(0, OVERALL_MS - (performance.now() - started)));
  signal?.addEventListener('abort', abort, { once: true });

  // Race injected fetch implementations too; discard any response arriving late.
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    if (failure) throw failure;
    headerTimer = setTimeout(() => stop(new KamiwazaError('timeout', 'Native model header deadline exceeded')), HEADER_MS);
    try {
      return await new Promise<Response>((resolve, reject) => {
        const cancelled = () => {
          controller.signal.removeEventListener('abort', cancelled);
          reject(failure!);
        };
        controller.signal.addEventListener('abort', cancelled, { once: true });
        Promise.resolve().then(() => {
          if (failure) throw failure;
          return fetchImpl(url, { ...init, signal: controller.signal, credentials: 'omit', redirect: 'error' });
        }).then(response => {
          if (failure) { discard(response.body); reject(failure); }
          else resolve(response);
        }, () => reject(failure ?? new KamiwazaError('network_error', 'Native model transport failed')))
          .finally(() => controller.signal.removeEventListener('abort', cancelled));
      });
    } finally { clearTimeout(headerTimer); }
  };

  let response: Response | undefined;
  try {
    if (signal?.aborted) abort();
    if (performance.now() - started >= OVERALL_MS) stop(new KamiwazaError('timeout', 'Native model overall deadline exceeded'));
    const authResponse = await send(`${apiBase}/auth/forward/validate`, {
      method: 'GET', headers: buildForwardAuthHeaders({ token, method, uri: path,
        host: forwardedHost, proto: forwardedProto, workroomId }),
    });
    discard(authResponse.body); // Validation bodies are neither read nor reported.
    if (authResponse.status !== 200 || authResponse.redirected)
      throw new KamiwazaError(authResponse.status === 401 || authResponse.status === 403 ? 'auth_denied' : 'auth_error',
        'Native model authorization refused', { httpStatus: authResponse.status });
    const auth = extractSignedIdentity(authResponse.headers);
    const verifiedScope = auth.forwardHeaders['x-verified-workroom-scope'];
    if (auth.identity.userId !== subject || auth.identity.workroomId !== workroomId ||
        (verifiedScope !== undefined && verifiedScope !== workroomId) ||
        (auth.forwardHeaders['x-authz-outcome'] !== undefined && auth.forwardHeaders['x-authz-outcome'] !== 'allowed'))
      throw new KamiwazaError('auth_denied', 'Native model signed identity does not match the current session', { httpStatus: 403 });
    const validatedAt = new Date().toISOString();
    response = await send(`${base.origin}${servePath}${suffix}`, {
      method, body, headers: { authorization: `Bearer ${token}`, ...auth.forwardHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    if (failure) throw failure;
    if (response.redirected || (response.status >= 300 && response.status < 400))
      throw new KamiwazaError('http_error', 'Native model redirect refused');
    if (Number(response.headers.get('content-length') ?? 0) > MAX_STREAM)
      throw new KamiwazaError('malformed_response', 'Native model response exceeds its byte bound');
    const secrets = [token, ...privateValues(authResponse.headers), ...privateValues(response.headers)];
    const receipt: RequestReceipt = {
      clientRequestId: crypto.randomUUID(), requestId: metadata(authResponse.headers.get('x-request-id'), secrets),
      target: { method, path }, status: response.status, durationMs: Math.round(performance.now() - started),
      validatedAt, signatureTs: metadata(auth.signatureTs, secrets, true),
    };
    // Expose only recognized MIME types, never arbitrary response header text.
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const contentType = mime === 'application/json' || mime === 'text/event-stream' ? mime : 'application/octet-stream';
    reader = response.body?.getReader();
    let length = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { output = c; },
      async pull(c) {
        try {
          const next = reader ? await reader.read() : { done: true as const };
          if (finished) return;
          if (next.done) {
            finished = true; dispose(); reader?.releaseLock(); c.close(); return;
          }
          if (!(next.value instanceof Uint8Array) || next.value.byteLength > MAX_STREAM ||
              (length += next.value.byteLength) > MAX_STREAM) {
            stop(new KamiwazaError('malformed_response', 'Native model response exceeds its byte bound')); return;
          }
          c.enqueue(next.value);
        } catch { stop(new KamiwazaError('network_error', 'Native model response stream failed')); }
      },
      cancel() { abort(); },
    }, { highWaterMark: 0 });
    return { body: stream, status: response.status, contentType, receipt, cancel: abort };
  } catch (error) {
    const safe = error instanceof KamiwazaError ? error : new KamiwazaError('network_error', 'Native model transport failed');
    stop(safe);
    if (response) discard(response.body);
    throw safe;
  }
}
