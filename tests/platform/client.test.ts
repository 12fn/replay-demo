import { describe, expect, it, vi } from "vitest";
import {
  FORWARD_AUTH_PATH,
  KamiwazaClient,
  KamiwazaError,
  SIGNED_IDENTITY_HEADERS,
  type FetchImpl,
} from "../../src/platform/index.ts";

const API_BASE = "https://kamiwaza.example/api";
const PAT = "kz_pat_SECRET-token-value-0123456789abcdef";
const SIGNATURE = "sig-SECRET-v1-9f8e7d6c5b4a";
const STABLE_SIGNATURE = "stable-SECRET-1a2b3c4d";
const USER_ID = "6b26c9c6-52db-41b0-aec4-333e62c34907";
const WORKROOM_ID = "280d6347-c0f5-4123-8dd4-93a53c3045e5";

function b64url(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}
const SESSION_JWT = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: USER_ID, sid: "sess-SECRET-77", exp: 9_999_999_999 })}.signatureSECRETpart1234`;
const PAT_JWT = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: USER_ID, typ: "pat", exp: 9_999_999_999 })}.signatureSECRETpart5678`;

function identityHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "x-user-id": USER_ID,
    "x-user-name": "finn",
    "x-user-roles": "authenticated, operator",
    "x-workroom-id": WORKROOM_ID,
    "x-user-workroom-role": "owner",
    "x-user-signature": SIGNATURE,
    "x-user-signature-stable": STABLE_SIGNATURE,
    "x-user-signature-ts": "1757740000",
    "x-auth-token": PAT,
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/** Mock platform: routes the validate call and the target call separately. */
function mockPlatform(opts: {
  validate?: (call: Call) => Response | Promise<Response>;
  target?: (call: Call) => Response | Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  const validate = opts.validate ?? (() => new Response(null, { status: 200, headers: identityHeaders() }));
  const target = opts.target ?? (() => json(200, { ok: true }, { "x-request-id": "req-1" }));
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, init, headers };
    calls.push(call);
    return url === `${API_BASE}${FORWARD_AUTH_PATH}` ? validate(call) : target(call);
  });
  return { fetchImpl, calls, validateCalls: () => calls.filter((c) => c.url.endsWith(FORWARD_AUTH_PATH)), targetCalls: () => calls.filter((c) => !c.url.endsWith(FORWARD_AUTH_PATH)) };
}

function client(fetchImpl: FetchImpl, extra: Partial<ConstructorParameters<typeof KamiwazaClient>[0]> = {}) {
  return new KamiwazaClient({ apiBase: API_BASE, getToken: () => PAT, fetchImpl, timeoutMs: 5_000, ...extra });
}

async function capture(p: Promise<unknown>): Promise<KamiwazaError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KamiwazaError);
    return e as KamiwazaError;
  }
  throw new Error("expected rejection");
}

function assertNoSecrets(value: unknown) {
  const dump = JSON.stringify(value) + (value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : "");
  for (const s of [PAT, SIGNATURE, STABLE_SIGNATURE, "SECRET"]) expect(dump).not.toContain(s);
}

describe('native catalog read transport',()=>{
  const urn='urn:li:dataset:(urn:li:dataPlatform:kamiwaza,replay-model-evidence-test,DEV)', item='11111111-1111-4111-8111-111111111111';
  it('reads exact binary bytes with fresh signed scope and a no-redirect transport on every call',async()=>{
    const bytes=new Uint8Array([31,139,0,255,7]);
    const p=mockPlatform({target:()=>new Response(bytes,{headers:{'content-type':'application/gzip','x-request-id':'archive-1'}})}),c=client(p.fetchImpl);
    for(let i=0;i<2;i++){
      const r=await c.catalogObjectContent(urn,item,WORKROOM_ID,bytes.length);expect(r.data).toEqual(bytes);assertNoSecrets(r.receipt);
      expect(r.identity.userId).toBe(USER_ID);
    }
    expect(p.validateCalls()).toHaveLength(2);
    for(const call of p.targetCalls()){expect(call.url).toBe(`${API_BASE}/catalog/datasets/v2/${encodeURIComponent(urn)}/objects/${item}/content`);expect(call.init.redirect).toBe('error');expect(call.init.cache).toBe('no-store');expect(call.headers['x-workroom-id']).toBe(WORKROOM_ID);}
  });
  it.each([401,403])('does not read bytes when ForwardAuth returns %i',async(status)=>{
    const p=mockPlatform({validate:()=>json(status,{detail:'denied'})});
    expect((await capture(client(p.fetchImpl).catalogObjectContent(urn,item,WORKROOM_ID,5))).httpStatus).toBe(status);expect(p.targetCalls()).toHaveLength(0);
  });
  it('does not follow a signed identity into another workroom',async()=>{
    const p=mockPlatform({validate:()=>new Response(null,{headers:identityHeaders({'x-workroom-id':'different'})})});
    expect((await capture(client(p.fetchImpl).catalogObjectContent(urn,item,WORKROOM_ID,5))).httpStatus).toBe(403);expect(p.targetCalls()).toHaveLength(0);
  });
  it.each([true,false])('bounds bytes with or without a declared length (%s)',async(declared)=>{
    const p=mockPlatform({target:()=>new Response(new Uint8Array(10),{headers:declared?{'content-length':'10'}:{}})});
    expect((await capture(client(p.fetchImpl).catalogObjectContent(urn,item,WORKROOM_ID,5))).code).toBe('malformed_response');
  });
  it('redacts content endpoint failures without reading the response body',async()=>{
    const p=mockPlatform({target:()=>json(403,{detail:PAT})});
    const e=await capture(client(p.fetchImpl).catalogObjectContent(urn,item,WORKROOM_ID,5));expect(e.httpStatus).toBe(403);assertNoSecrets(e);
  });
  it.each([0,9*1024*1024,1.5])('rejects unsafe byte bounds %i before network',async(max)=>{
    const p=mockPlatform();await capture(client(p.fetchImpl).catalogObjectContent(urn,item,WORKROOM_ID,max));expect(p.calls).toHaveLength(0);
  });
  it('cancels a stalled content stream at the transport deadline',async()=>{
    let cancelled=false;const p=mockPlatform({target:()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});
    const e=await capture(client(p.fetchImpl,{timeoutMs:25}).catalogObjectContent(urn,item,WORKROOM_ID,5));expect(e.code).toBe('timeout');expect(cancelled).toBe(true);
  });
  it('performs fresh ForwardAuth for both exact dataset read targets',async()=>{
    const urn='urn:li:dataset:(urn:li:dataPlatform:kamiwaza,replay-model-evidence-test,DEV)';
    const platform=mockPlatform({target:c=>json(200,c.url.includes('/by-urn')?{urn,workroom_id:WORKROOM_ID}:[{logical_path:'graph.json',state:'live',etag:'sha256:fixture'}])});
    const c=client(platform.fetchImpl);
    expect((await c.catalogDataset(urn,WORKROOM_ID)).data.urn).toBe(urn);
    expect((await c.catalogObjects(urn,WORKROOM_ID)).data[0].logical_path).toBe('graph.json');
    const targets=platform.targetCalls();expect(targets).toHaveLength(2);expect(platform.validateCalls()).toHaveLength(2);
    expect(new URL(targets[0].url).searchParams.get('urn')).toBe(urn);
    expect(targets[1].url).toBe(`${API_BASE}/catalog/datasets/v2/${encodeURIComponent(urn)}/objects?state=live`);
    for(const t of targets){expect(t.init.method).toBe('GET');expect(t.headers['x-workroom-id']).toBe(WORKROOM_ID);}
    assertNoSecrets((await c.catalogDataset(urn,WORKROOM_ID)).receipt);
  });
  it('stops before reading the archive when native authorization denies access',async()=>{
    const p=mockPlatform({validate:()=>json(403,{detail:'denied'})});
    const e=await capture(client(p.fetchImpl).catalogDataset('fixture',WORKROOM_ID));expect(e.httpStatus).toBe(403);expect(p.targetCalls()).toHaveLength(0);
  });
});

describe("KamiwazaClient configuration", () => {
  it("requires an absolute apiBase ending in /api and a token function", () => {
    const fetchImpl = vi.fn<FetchImpl>();
    expect(() => new KamiwazaClient({ apiBase: "https://kamiwaza.example", getToken: () => PAT, fetchImpl })).toThrow(/ending in \/api/);
    expect(() => new KamiwazaClient({ apiBase: "/api", getToken: () => PAT, fetchImpl })).toThrow(/absolute URL/);
    expect(() => new KamiwazaClient({ apiBase: "https://kamiwaza.example/api?x=1", getToken: () => PAT, fetchImpl })).toThrow(/ending in \/api/);
    expect(() => new KamiwazaClient({ apiBase: API_BASE, getToken: undefined as unknown as () => string, fetchImpl })).toThrow(/getToken/);
    expect(() => new KamiwazaClient({ apiBase: API_BASE, getToken: () => PAT, fetchImpl, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a trailing slash and derives forwarded host from apiBase", () => {
    const c = client(vi.fn<FetchImpl>(), { apiBase: "https://kamiwaza.example:8443/api/" });
    expect(c.apiBase).toBe("https://kamiwaza.example:8443/api");
    expect(c.apiPrefix).toBe("/api");
    expect(c.forwardedHost).toBe("kamiwaza.example:8443");
    expect(c.forwardedProto).toBe("https");
  });

  it("does not serialize the token provider or any credential", () => {
    const c = client(vi.fn<FetchImpl>());
    assertNoSecrets(c);
    expect(JSON.stringify(c)).toContain(API_BASE);
  });

  it("refuses to run without a token and never touches the network", async () => {
    const platform = mockPlatform();
    const c = client(platform.fetchImpl, { getToken: () => "   " });
    const err = await capture(c.me());
    expect(err.code).toBe("missing_credentials");
    expect(platform.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ForwardAuth before each protected request", () => {
  it("validates with the exact method and URI, then sends the target with bearer plus signed identity", async () => {
    const platform = mockPlatform({ target: () => json(200, { username: "finn", sub: USER_ID, roles: ["authenticated"] }, { "x-request-id": "req-me" }) });
    const c = client(platform.fetchImpl, { workroomId: WORKROOM_ID });

    const res = await c.me();

    expect(platform.calls).toHaveLength(2);
    const [validate, target] = platform.calls;
    expect(validate!.url).toBe(`${API_BASE}/auth/forward/validate`);
    expect(validate!.init.method).toBe("GET");
    expect(validate!.headers).toMatchObject({
      authorization: `Bearer ${PAT}`,
      "x-forwarded-method": "GET",
      "x-forwarded-uri": "/api/auth/users/me",
      "x-forwarded-host": "kamiwaza.example",
      "x-forwarded-proto": "https",
      "x-workroom-id": WORKROOM_ID,
    });
    expect(target!.url).toBe(`${API_BASE}/auth/users/me`);
    expect(target!.init.method).toBe("GET");
    expect(target!.headers.authorization).toBe(`Bearer ${PAT}`);
    for (const name of SIGNED_IDENTITY_HEADERS) expect(target!.headers[name]).toBe(identityHeaders()[name]);

    expect(res.data).toEqual({ username: "finn", sub: USER_ID, roles: ["authenticated"] });
    expect(res.identity).toEqual({ userId: USER_ID, userName: "finn", roles: ["authenticated", "operator"], workroomId: WORKROOM_ID, workroomRole: "owner" });
    expect(res.receipt).toMatchObject({ requestId: "req-me", target: { method: "GET", path: "/auth/users/me" }, status: 200, signatureTs: "1757740000" });
    expect(typeof res.receipt.clientRequestId).toBe("string");
    expect(typeof res.receipt.durationMs).toBe("number");
    // public identity carries no signature material
    assertNoSecrets(res.identity);
    assertNoSecrets(res.receipt);
  });

  it("validates again for every call, including the query string in the forwarded URI", async () => {
    const platform = mockPlatform({
      target: (call) => (call.url.includes("/episodes/") ? json(200, { group_id: "grp 1", count: 0, episodes: [] }) : json(200, [{ name: "replay-abc", type: "app", version: "1.0.0" }])),
    });
    const c = client(platform.fetchImpl);
    await c.listExtensions({ workroomId: WORKROOM_ID });
    await c.episodes("11111111-1111-4111-8111-111111111111", "grp 1", { lastN: 5 });
    expect(platform.validateCalls()).toHaveLength(2);
    expect(platform.validateCalls()[0]!.headers["x-forwarded-uri"]).toBe(`/api/extensions?workroom_id=${WORKROOM_ID}`);
    expect(platform.validateCalls()[1]!.headers["x-forwarded-uri"]).toBe("/api/context/ontologies/11111111-1111-4111-8111-111111111111/episodes/grp%201?last_n=5");
    expect(platform.targetCalls()[1]!.url).toBe(`${API_BASE}/context/ontologies/11111111-1111-4111-8111-111111111111/episodes/grp%201?last_n=5`);
  });

  it("does not call the target when ForwardAuth denies", async () => {
    const platform = mockPlatform({ validate: () => json(403, { detail: `forbidden for ${PAT}` }, { "x-request-id": "req-deny" }) });
    const c = client(platform.fetchImpl);
    const err = await capture(c.check({ subject: { namespace: "user", id: USER_ID }, relation: "owner", object: { namespace: "workroom", id: WORKROOM_ID } }));
    expect(err.code).toBe("auth_denied");
    expect(err.httpStatus).toBe(403);
    expect(err.requestId).toBe("req-deny");
    expect(err.target).toBe("POST /auth/check");
    expect(err.detail).toBe("forbidden for [redacted]");
    expect(platform.targetCalls()).toHaveLength(0);
    assertNoSecrets(err);
  });

  it("treats a non-denial ForwardAuth failure as auth_error and still skips the target", async () => {
    const platform = mockPlatform({ validate: () => new Response("upstream down", { status: 503 }) });
    const err = await capture(client(platform.fetchImpl).me());
    expect(err.code).toBe("auth_error");
    expect(err.httpStatus).toBe(503);
    expect(platform.targetCalls()).toHaveLength(0);
  });

  it("aborts when ForwardAuth returns 200 without a signature", async () => {
    const platform = mockPlatform({ validate: () => new Response(null, { status: 200, headers: { "x-user-id": USER_ID, "x-user-name": "finn" } }) });
    const err = await capture(client(platform.fetchImpl).me());
    expect(err.code).toBe("missing_signature");
    expect(platform.targetCalls()).toHaveLength(0);
  });

  it("aborts when ForwardAuth returns a signature without a user id", async () => {
    const platform = mockPlatform({ validate: () => new Response(null, { status: 200, headers: { "x-user-signature": SIGNATURE } }) });
    const err = await capture(client(platform.fetchImpl).me());
    expect(err.code).toBe("missing_signature");
    expect(platform.targetCalls()).toHaveLength(0);
    assertNoSecrets(err);
  });
});

describe("signed scope and header integrity", () => {
  it("forwards only the allowlisted identity headers, unchanged, and drops other x- headers", async () => {
    const platform = mockPlatform({
      validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-is-admin": "true", "x-tenant-id": "t1", "set-cookie": "a=b" }) }),
      target: () => json(200, { username: "finn", sub: USER_ID }),
    });
    await client(platform.fetchImpl).me();
    const target = platform.targetCalls()[0]!;
    expect(target.headers["x-user-is-admin"]).toBeUndefined();
    expect(target.headers["x-tenant-id"]).toBeUndefined();
    expect(target.headers["set-cookie"]).toBeUndefined();
    expect(target.headers["x-user-signature"]).toBe(SIGNATURE);
    expect(target.headers["x-user-roles"]).toBe("authenticated, operator");
  });

  it("keeps the platform's signed workroom scope even when the caller hinted a different one", async () => {
    const platform = mockPlatform({
      validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-workroom-id": WORKROOM_ID, "x-user-workroom-role": "viewer" }) }),
      target: () => json(200, []),
    });
    const c = client(platform.fetchImpl, { workroomId: "attacker-picked-workroom" });
    const res = await c.listOntologies();
    expect(platform.validateCalls()[0]!.headers["x-workroom-id"]).toBe("attacker-picked-workroom");
    expect(platform.targetCalls()[0]!.headers["x-workroom-id"]).toBe(WORKROOM_ID);
    expect(res.identity.workroomId).toBe(WORKROOM_ID);
    expect(res.identity.workroomRole).toBe("viewer");
  });

  it("does not manufacture a workroom header when the platform returned none", async () => {
    const headers = identityHeaders();
    delete headers["x-workroom-id"];
    delete headers["x-user-workroom-role"];
    const platform = mockPlatform({ validate: () => new Response(null, { status: 200, headers }), target: () => json(200, []) });
    const res = await client(platform.fetchImpl, { workroomId: WORKROOM_ID }).listOntologies({ workroomId: WORKROOM_ID });
    expect(platform.targetCalls()[0]!.headers["x-workroom-id"]).toBeUndefined();
    expect(res.identity.workroomId).toBeNull();
  });

  it("rejects caller-supplied gateway, identity and credential headers before any network call", async () => {
    const platform = mockPlatform();
    const c = client(platform.fetchImpl);
    for (const forged of ["X-User-Id", "x-user-signature", "X-Workroom-ID", "x-forwarded-uri", "Authorization", "x-auth-token", "cookie"]) {
      const err = await capture(c.request({ method: "GET", path: "/auth/users/me", headers: { [forged]: "spoof" } }));
      expect(err.code).toBe("forged_header");
    }
    expect(platform.fetchImpl).not.toHaveBeenCalled();
  });

  it("passes benign caller headers through without letting them shadow identity", async () => {
    const platform = mockPlatform();
    await client(platform.fetchImpl).request({ method: "GET", path: "/auth/users/me", headers: { "x-replay-branch": "b1", Accept: "text/plain" } });
    const target = platform.targetCalls()[0]!;
    expect(target.headers["x-replay-branch"]).toBe("b1");
    expect(target.headers.accept).toBe("application/json");
    expect(target.headers["x-user-id"]).toBe(USER_ID);
  });

  it("refuses to use the ForwardAuth endpoint as a target and rejects unsafe paths", async () => {
    const platform = mockPlatform();
    const c = client(platform.fetchImpl);
    expect((await capture(c.request({ method: "GET", path: FORWARD_AUTH_PATH }))).code).toBe("invalid_request");
    expect((await capture(c.request({ method: "GET", path: "auth/users/me" }))).code).toBe("invalid_request");
    expect((await capture(c.request({ method: "GET", path: "/../admin" }))).code).toBe("invalid_request");
    expect((await capture(c.request({ method: "GET", path: "/x?y=1" }))).code).toBe("invalid_request");
    expect(platform.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("responses, timeouts and redaction", () => {
  it("fails with malformed_response on non-JSON and on missing required fields, never echoing secrets", async () => {
    const nonJson = mockPlatform({ target: () => new Response(`<html>${PAT}</html>`, { status: 200 }) });
    const e1 = await capture(client(nonJson.fetchImpl).me());
    expect(e1.code).toBe("malformed_response");
    expect(e1.httpStatus).toBe(200);
    assertNoSecrets(e1);

    const missing = mockPlatform({ target: () => json(200, { allow: true, reason: "tuple_match" }) });
    const e2 = await capture(client(missing.fetchImpl).check({ subject: { namespace: "user", id: USER_ID }, relation: "owner", object: { namespace: "workroom", id: WORKROOM_ID } }));
    expect(e2.code).toBe("malformed_response");
    expect(e2.message).toContain("decision_id");

    const wrongType = mockPlatform({ target: () => json(200, { allow: "yes", decision_id: "d", reason: "r" }) });
    const e3 = await capture(client(wrongType.fetchImpl).check({ subject: { namespace: "user", id: USER_ID }, relation: "owner", object: { namespace: "workroom", id: WORKROOM_ID } }));
    expect(e3.code).toBe("malformed_response");

    const notArray = mockPlatform({ target: () => json(200, { items: [] }) });
    expect((await capture(client(notArray.fetchImpl).listExtensions())).code).toBe("malformed_response");
  });

  it("times out during ForwardAuth without calling the target", async () => {
    const fetchImpl = vi.fn<FetchImpl>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException(`aborted ${PAT}`, "AbortError")));
        }),
    );
    const c = client(fetchImpl, { timeoutMs: 20 });
    const started = Date.now();
    const err = await capture(c.me());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err.code).toBe("timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    assertNoSecrets(err);
  });

  it("applies one budget across validate and target", async () => {
    const platform = mockPlatform({
      target: (call) =>
        new Promise((_resolve, reject) => {
          call.init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const err = await capture(client(platform.fetchImpl, { timeoutMs: 20 }).me());
    expect(err.code).toBe("timeout");
    expect(err.target).toBe("GET /auth/users/me");
    expect(platform.calls).toHaveLength(2);
  });

  it("redacts the token, bearer strings and JWTs from network errors and platform error bodies", async () => {
    const network = mockPlatform({ validate: () => { throw new TypeError(`fetch failed: Bearer ${PAT} ${SESSION_JWT}`); } });
    const e1 = await capture(client(network.fetchImpl).me());
    expect(e1.code).toBe("network_error");
    expect(e1.message).toContain("[redacted]");
    assertNoSecrets(e1);

    const denied = mockPlatform({ target: () => json(422, { detail: [{ loc: ["body", "relation"], msg: `bad relation for ${PAT}`, type: "value_error" }] }, { "x-request-id": "req-422" }) });
    const e2 = await capture(client(denied.fetchImpl).me());
    expect(e2).toMatchObject({ code: "http_error", httpStatus: 422, requestId: "req-422", target: "GET /auth/users/me", detail: "body.relation: bad relation for [redacted]" });
    assertNoSecrets(e2);
    assertNoSecrets(e2.toJSON());

    const huge = mockPlatform({ target: () => json(500, { detail: "x".repeat(2_000) }) });
    const e3 = await capture(client(huge.fetchImpl).me());
    expect(e3.detail!.length).toBeLessThan(260);
  });

  it("returns null data for an empty body", async () => {
    const platform = mockPlatform({ target: () => new Response(null, { status: 204 }) });
    const res = await client(platform.fetchImpl).request({ method: "DELETE", path: "/extensions/replay-abc" });
    expect(res.data).toBeNull();
    expect(res.receipt.status).toBe(204);
  });
});

describe("typed methods", () => {
  it("check sends the exact CheckRequest shape and rejects relations outside the installed vocabulary", async () => {
    const platform = mockPlatform({ target: () => json(200, { allow: true, decision_id: "6ade35be-0f75-4884-b8b3-4565366430b7", reason: "tuple_match" }) });
    const c = client(platform.fetchImpl);
    const res = await c.check({ subject: { namespace: "user", id: USER_ID, extra: 1 } as never, relation: "owner", object: { namespace: "workroom", id: WORKROOM_ID } });
    const target = platform.targetCalls()[0]!;
    expect(target.init.method).toBe("POST");
    expect(target.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(target.init.body as string)).toEqual({ subject: { namespace: "user", id: USER_ID }, relation: "owner", object: { namespace: "workroom", id: WORKROOM_ID } });
    expect(res.data).toEqual({ allow: true, decision_id: "6ade35be-0f75-4884-b8b3-4565366430b7", reason: "tuple_match" });

    const err = await capture(c.check({ subject: { namespace: "user", id: USER_ID }, relation: "j2" as never, object: { namespace: "workroom", id: WORKROOM_ID } }));
    expect(err.code).toBe("invalid_request");
    expect(platform.targetCalls()).toHaveLength(1);
  });

  it("workroom record and runtime context use the workroom as the ForwardAuth hint", async () => {
    const platform = mockPlatform({
      target: (call) =>
        call.url.endsWith("/runtime/context")
          ? json(200, { workroom_id: WORKROOM_ID, user_id: USER_ID, effective_workroom_role: "owner", workroom_lifecycle_state: "active", interaction_mode: "collaborative", access_state: "active", can_edit: true })
          : json(200, { id: WORKROOM_ID, tenant_id: "t", owner_user_id: USER_ID, name: "Replay", type: "standard", status: "active", created_at: "2026-09-13T00:00:00Z" }),
    });
    const c = client(platform.fetchImpl);
    const record = await c.workroom(WORKROOM_ID);
    const ctx = await c.workroomContext(WORKROOM_ID);
    expect(record.data.name).toBe("Replay");
    expect(ctx.data.access_state).toBe("active");
    expect(platform.validateCalls().every((v) => v.headers["x-workroom-id"] === WORKROOM_ID)).toBe(true);
    expect(platform.validateCalls()[1]!.headers["x-forwarded-uri"]).toBe(`/api/workrooms/${WORKROOM_ID}/runtime/context`);
  });

  it("extension create posts the spec and lists with workroom filter", async () => {
    const platform = mockPlatform({ target: (call) => (call.init.method === "POST" ? json(201, { name: "replay-a1b2", type: "app", version: "0.1.0", phase: "Provisioning" }) : json(200, [])) });
    const c = client(platform.fetchImpl);
    const spec = { name: "replay", type: "app" as const, version: "0.1.0", services: [{ name: "web", image: "registry.example/replay:0.1.0", primary: true, ports: [{ container_port: 3000 }] }], workroom_id: WORKROOM_ID };
    const created = await c.createExtension(spec);
    expect(created.data.name).toBe("replay-a1b2");
    expect(created.receipt.status).toBe(201);
    expect(JSON.parse(platform.targetCalls()[0]!.init.body as string)).toEqual(spec);
    expect(platform.validateCalls()[0]!.headers["x-forwarded-method"]).toBe("POST");
    const listed = await c.listExtensions();
    expect(listed.data).toEqual([]);
    expect(platform.targetCalls()[1]!.url).toBe(`${API_BASE}/extensions`);
    expect((await capture(c.createExtension({ ...spec, services: [] }))).code).toBe("invalid_request");
  });

  it("ontology list, health, knowledge add, search and episodes hit the documented paths", async () => {
    const platform = mockPlatform({
      target: (call) => {
        if (call.url.endsWith("/context/ontologies")) return json(200, [{ id: "o1", name: "replay", backend: "graphiti", status: "running", created_at: "2026-09-13T00:00:00Z", ingestion_status: "none" }]);
        if (call.url.endsWith("/health")) return json(200, { status: "ok", backend: "graphiti" });
        if (call.url.endsWith("/knowledge")) return json(200, { added_count: 2, group_id: "ex-1", result: { episodes: 2 } });
        if (call.url.endsWith("/search")) return json(200, { query: "hill", total_count: 1, facts: [{ fact_uuid: "f1", content: "Hill 3 was contested" }], sources: [{ fact_uuid: "f1", sources: [{ source_id: "s1" }] }] });
        if (call.url.includes("/episodes/")) return json(200, { group_id: "ex-1", count: 1, episodes: [{ content: "c", source: "message", group_id: "ex-1" }] });
        return json(200, { ok: true });
      },
    });
    const c = client(platform.fetchImpl, { workroomId: WORKROOM_ID });
    const list = await c.listOntologies();
    expect(list.data[0]!.backend).toBe("graphiti");
    const health = await c.ontologyHealth("o1");
    expect(health.data).toEqual({ status: "ok", backend: "graphiti" });
    await c.contextHealth();
    const added = await c.addKnowledge("o1", { group_id: "ex-1", messages: [{ content: "a", role: "user" }, { content: "b", role: "assistant", name: "red" }] });
    expect(added.data.added_count).toBe(2);
    const found = await c.searchOntology("o1", { query: "hill", group_ids: ["ex-1"], max_results: 5 });
    expect(found.data.facts![0]!.fact_uuid).toBe("f1");
    expect(found.data.sources![0]!.sources![0]!.source_id).toBe("s1");
    const eps = await c.episodes("o1", "ex-1", { lastN: 3 });
    expect(eps.data.count).toBe(1);
    expect(platform.targetCalls().map((t) => `${t.init.method} ${t.url.slice(API_BASE.length)}`)).toEqual([
      "GET /context/ontologies",
      "GET /context/ontologies/o1/health",
      "GET /context/health",
      "POST /context/ontologies/o1/knowledge",
      "POST /context/ontologies/o1/search",
      "GET /context/ontologies/o1/episodes/ex-1?last_n=3",
    ]);
    expect((await capture(c.searchOntology("o1", { query: "x", group_ids: ["g"], max_results: 101 }))).code).toBe("invalid_request");
    expect((await capture(c.addKnowledge("o1", { group_id: "", messages: [] }))).code).toBe("invalid_request");
  });
});

describe("login and workroom session binding", () => {
  it("login posts form credentials to the exempt endpoint without ForwardAuth and returns tokens without logging", async () => {
    const platform = mockPlatform({ target: () => json(200, { access_token: SESSION_JWT, token_type: "bearer", expires_in: 300, refresh_token: "refresh-SECRET" }) });
    const c = client(platform.fetchImpl, { getToken: () => "" });
    const res = await c.login({ username: "finn", password: "pw-SECRET-123456" });
    expect(platform.calls).toHaveLength(1);
    const call = platform.calls[0]!;
    expect(call.url).toBe(`${API_BASE}/auth/token`);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.headers.authorization).toBeUndefined();
    expect(new URLSearchParams(call.init.body as string).get("password")).toBe("pw-SECRET-123456");
    expect(res.data.access_token).toBe(SESSION_JWT);
    expect(res.receipt.status).toBe(200);
    expect(c.capabilities().identity.label).toBe("unverified");
  });

  it("login errors redact the password and the token response is validated", async () => {
    const bad = mockPlatform({ target: () => json(401, { detail: "invalid credentials pw-SECRET-123456" }) });
    const e1 = await capture(client(bad.fetchImpl).login({ username: "finn", password: "pw-SECRET-123456" }));
    expect(e1.code).toBe("http_error");
    expect(e1.detail).toBe("invalid credentials [redacted]");
    assertNoSecrets(e1);

    const malformed = mockPlatform({ target: () => json(200, { token_type: "bearer" }) });
    expect((await capture(client(malformed.fetchImpl).login({ username: "finn", password: "x" }))).code).toBe("malformed_response");
    expect((await capture(client(malformed.fetchImpl).login({ username: "finn", password: "" }))).code).toBe("invalid_request");
  });

  it("enterWorkroom requires a session token with sid and rejects a PAT before any network call", async () => {
    const platform = mockPlatform();
    const c = client(platform.fetchImpl);
    const e1 = await capture(c.enterWorkroom(WORKROOM_ID));
    expect(e1.code).toBe("session_required");
    const e2 = await capture(c.enterWorkroom(WORKROOM_ID, { sessionToken: PAT_JWT }));
    expect(e2.code).toBe("session_required");
    expect(platform.fetchImpl).not.toHaveBeenCalled();
    assertNoSecrets(e1);
    assertNoSecrets(e2);
  });

  it("enterWorkroom uses the signed request path with the session token as bearer", async () => {
    const platform = mockPlatform({ target: () => json(200, { workroom_id: WORKROOM_ID, message: "Workroom session bound" }) });
    const c = client(platform.fetchImpl);
    const res = await c.enterWorkroom(WORKROOM_ID, { sessionToken: SESSION_JWT });
    expect(platform.calls).toHaveLength(2);
    expect(platform.validateCalls()[0]!.headers).toMatchObject({ authorization: `Bearer ${SESSION_JWT}`, "x-forwarded-method": "POST", "x-forwarded-uri": `/api/workrooms/${WORKROOM_ID}/enter`, "x-workroom-id": WORKROOM_ID });
    const target = platform.targetCalls()[0]!;
    expect(target.init.method).toBe("POST");
    expect(target.headers.authorization).toBe(`Bearer ${SESSION_JWT}`);
    expect(target.headers["x-user-signature"]).toBe(SIGNATURE);
    expect(res.data.workroom_id).toBe(WORKROOM_ID);

    const left = await c.leaveWorkroom({ sessionToken: SESSION_JWT });
    expect(platform.validateCalls()[1]!.headers["x-workroom-id"]).toBeUndefined();
    expect(platform.targetCalls()[1]!.url).toBe(`${API_BASE}/workrooms/leave`);
    expect(left.data.workroom_id).toBe(WORKROOM_ID);
  });
});

describe("capability labels", () => {
  it("stay unverified until an actual signed call succeeds, and stay unverified after failures", async () => {
    const platform = mockPlatform({
      validate: (call) => (call.headers["x-forwarded-uri"].includes("/auth/check") ? json(403, { detail: "no" }) : new Response(null, { status: 200, headers: identityHeaders() })),
      target: () => json(200, { username: "finn", sub: USER_ID }, { "x-request-id": "req-cap" }),
    });
    const c = client(platform.fetchImpl);
    expect(Object.values(c.capabilities()).every((s) => s.label === "unverified")).toBe(true);

    await capture(c.check({ subject: { namespace: "user", id: USER_ID }, relation: "member", object: { namespace: "workroom", id: WORKROOM_ID } }));
    expect(c.capabilities().rebac.label).toBe("unverified");

    await c.me();
    const snap = c.capabilities();
    expect(snap.identity).toMatchObject({ label: "native", lastTarget: "GET /auth/users/me", lastRequestId: "req-cap" });
    expect(typeof snap.identity.verifiedAt).toBe("string");
    expect(snap.workroom.label).toBe("unverified");
    // snapshot is a copy
    (snap as { identity: { label: string } }).identity.label = "tampered";
    expect(c.capabilities().identity.label).toBe("native");
  });
});

describe('native extension browser reads',()=>{
 const spec={extension:'replay-tomo',origin:'http://tomo.internal:8000',path:'/api/auth/me?q=one',subject:USER_ID};
 it('validates exact runtime URI and preserves new signed fields without leaking transport headers',async()=>{
  const m=mockPlatform({validate:()=>new Response(null,{status:200,headers:identityHeaders({'x-user-preferred-username':'finn','x-requested-workroom-scope':WORKROOM_ID,'x-verified-workroom-scope':WORKROOM_ID,'x-protected-action-type':'read','x-visibility-scope':'workroom','x-authz-outcome':'allow','x-authz-reason-class':'member'})}),target:()=>new Response('native member',{headers:{'content-type':'text/plain','set-cookie':'private-cookie=SECRET','location':'https://untrusted.invalid'}})});
  const r=await client(m.fetchImpl,{workroomId:WORKROOM_ID}).runtimeRead(spec);
  expect(m.validateCalls()[0].headers['x-forwarded-uri']).toBe('/runtime/apps/replay-tomo/api/auth/me?q=one');
  expect(m.targetCalls()[0].url).toBe('http://tomo.internal:8000/api/auth/me?q=one');
  expect(m.targetCalls()[0].headers['x-authz-reason-class']).toBe('member');
  expect(m.targetCalls()[0].headers.authorization).toBe(`Bearer ${PAT}`);
  expect(m.targetCalls()[0].init.redirect).toBe('error');
  expect(new TextDecoder().decode(r.body)).toBe('native member');
  expect(JSON.stringify(r)).not.toContain(PAT);expect(JSON.stringify(r)).not.toContain(SIGNATURE);expect(JSON.stringify(r)).not.toContain('private-cookie');
 });
 it.each([401,403])('does not contact Tomo after Core denial %s',async status=>{
  const m=mockPlatform({validate:()=>json(status,{detail:'denied'})});
  await expect(client(m.fetchImpl,{workroomId:WORKROOM_ID}).runtimeRead(spec)).rejects.toMatchObject({code:'auth_denied'});
  expect(m.targetCalls()).toHaveLength(0);
 });
 it.each<Record<string,string>>([{'x-user-id':'other'},{'x-workroom-id':'other-room'}])('refuses mismatched signed scope %j',async mismatch=>{
  const m=mockPlatform({validate:()=>new Response(null,{status:200,headers:identityHeaders(mismatch)})});
  await expect(client(m.fetchImpl,{workroomId:WORKROOM_ID}).runtimeRead(spec)).rejects.toMatchObject({code:'auth_denied'});expect(m.targetCalls()).toHaveLength(0);
 });
 it.each(['//outside.invalid','/../secret','/%2e%2e/secret','/%252e%252e/secret','/%2f%2foutside','/abc\\def','/x#fragment'])('rejects ambiguous path %s before authentication',async path=>{
  const m=mockPlatform();await expect(client(m.fetchImpl,{workroomId:WORKROOM_ID}).runtimeRead({...spec,path})).rejects.toMatchObject({code:'invalid_request'});expect(m.calls).toHaveLength(0);
 });
 it('bounds streamed resources even when no content length was declared',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(8*1024*1024+1));c.close();}});
  const m=mockPlatform({target:()=>new Response(stream)});
  await expect(client(m.fetchImpl,{workroomId:WORKROOM_ID}).runtimeRead(spec)).rejects.toMatchObject({code:'malformed_response'});
 });
});


it('validates on the configured public Core gateway and sends unchanged signed identity to the internal Core target',async()=>{
 const internal='http://core.kamiwaza.svc:8000/api';const calls:Call[]=[];
 const fetchImpl:FetchImpl=async(url,init)=>{const headers=Object.fromEntries(new Headers(init.headers));calls.push({url,init,headers});return url===API_BASE+FORWARD_AUTH_PATH?new Response(null,{headers:identityHeaders()}):json(200,{username:'alice',sub:USER_ID});};
 const c=new KamiwazaClient({apiBase:internal,validationApiBase:API_BASE,getToken:()=>PAT,fetchImpl,workroomId:WORKROOM_ID,forwardedHost:'kamiwaza.example'});await c.me();
 expect(calls.map(c=>c.url)).toEqual([API_BASE+FORWARD_AUTH_PATH,internal+'/auth/users/me']);expect(calls[1].headers['x-user-signature']).toBe(SIGNATURE);expect(calls[1].headers['x-workroom-id']).toBe(WORKROOM_ID);
});
