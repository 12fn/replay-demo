/**
 * Fail-closed coverage for the Graphiti workload validator.
 *
 * `verifyGraphitiWorkload` builds a KamiwazaClient without a fetch override, so
 * these tests stub the global fetch with a mock platform that answers the
 * native ForwardAuth path (`GET /auth/forward/validate` with signed identity
 * headers) and the target (`GET /auth/users/me`). No real network is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORWARD_AUTH_PATH } from "../../src/platform/index.ts";
import { verifyGraphitiWorkload, type WorkloadAuthConfig } from "../../src/server/workload-auth.ts";

const API_BASE = "https://kamiwaza.example/api";
const FORWARDED_HOST = "kamiwaza-harness.example";
const SUBJECT = "6b26c9c6-52db-41b0-aec4-333e62c34907";
const OTHER_SUBJECT = "a1b2c3d4-0000-4000-8000-000000000001";
const TOKEN = "kz_pat_SECRET-workload-token-0123456789abcdef";
const SIGNATURE = "sig-SECRET-v1-9f8e7d6c5b4a";
const STABLE_SIGNATURE = "stable-SECRET-1a2b3c4d";

interface Call {
  url: string;
  headers: Record<string, string>;
}

interface Platform {
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  calls: Call[];
  validateCalls: () => Call[];
  targetCalls: () => Call[];
}

function identityHeaders(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    "x-user-id": SUBJECT,
    "x-user-name": "replay-graphiti",
    "x-user-roles": "authenticated, service",
    "x-user-signature": SIGNATURE,
    "x-user-signature-stable": STABLE_SIGNATURE,
    "x-user-signature-ts": "1757740000",
    "x-auth-token": TOKEN,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const meBody = (overrides: Record<string, unknown> = {}) => ({ username: "replay-graphiti", sub: SUBJECT, roles: ["service"], ...overrides });

/** Mock platform installed on globalThis.fetch; routes validate and target separately. */
function mockPlatform(opts: { validate?: (call: Call) => Response | Promise<Response>; target?: (call: Call) => Response | Promise<Response> } = {}): Platform {
  const calls: Call[] = [];
  const validate = opts.validate ?? (() => new Response(null, { status: 200, headers: identityHeaders() }));
  const target = opts.target ?? (() => json(200, meBody(), { "x-request-id": "req-me" }));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { url, headers };
    calls.push(call);
    return url === `${API_BASE}${FORWARD_AUTH_PATH}` ? validate(call) : target(call);
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, calls, validateCalls: () => calls.filter((c) => c.url.endsWith(FORWARD_AUTH_PATH)), targetCalls: () => calls.filter((c) => !c.url.endsWith(FORWARD_AUTH_PATH)) };
}

const config = (overrides: Partial<WorkloadAuthConfig> = {}): WorkloadAuthConfig => ({ apiBase: API_BASE, subject: SUBJECT, forwardedHost: FORWARDED_HOST, ...overrides });
const verify = (authorization: string | undefined, overrides: Partial<WorkloadAuthConfig> = {}) => verifyGraphitiWorkload(authorization, config(overrides));

function assertNoSecrets(value: unknown) {
  const dump = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of [TOKEN, SIGNATURE, STABLE_SIGNATURE, "SECRET"]) expect(dump).not.toContain(s);
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe("verifyGraphitiWorkload: accepted contract", () => {
  it("accepts only after native ForwardAuth signed the exact subject with the service role and /me agrees", async () => {
    const p = mockPlatform();
    const result = await verify(`Bearer ${TOKEN}`);
    expect(result).toEqual({ subject: SUBJECT, receipt: expect.objectContaining({ requestId: "req-me", status: 200, target: { method: "GET", path: "/auth/users/me" } }) });

    // Validate first, then the target; the target carries the signed headers unchanged.
    expect(p.calls.map((c) => c.url)).toEqual([`${API_BASE}${FORWARD_AUTH_PATH}`, `${API_BASE}/auth/users/me`]);
    const [validate, target] = p.calls;
    expect(validate!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-forwarded-method": "GET",
      "x-forwarded-uri": "/api/auth/users/me",
      "x-forwarded-host": FORWARDED_HOST,
      "x-forwarded-proto": "https",
    });
    expect(validate!.headers["x-workroom-id"]).toBeUndefined();
    expect(target!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "x-user-id": SUBJECT, "x-user-signature": SIGNATURE, "x-user-roles": "authenticated, service" });

    // The accepted result never carries the bearer, the signature or any header material.
    assertNoSecrets(result);
    expect(result).not.toHaveProperty("identity");
    expect(result).not.toHaveProperty("token");
  });

  it("uses the configured forwarded host and falls back to the harness host only when none is configured", async () => {
    const p = mockPlatform();
    await verify(`Bearer ${TOKEN}`, { forwardedHost: undefined });
    expect(p.validateCalls()[0]!.headers["x-forwarded-host"]).toBe("kamiwaza-harness.localhost");
  });
});

describe("verifyGraphitiWorkload: local rejections make no platform call", () => {
  const cases: Array<[string, string | undefined, Partial<WorkloadAuthConfig>]> = [
    ["missing header", undefined, {}],
    ["empty header", "", {}],
    ["Basic scheme", `Basic ${Buffer.from(`svc:${TOKEN}`).toString("base64")}`, {}],
    ["lower-case scheme", `bearer ${TOKEN}`, {}],
    ["scheme without space", `Bearer${TOKEN}`, {}],
    ["bare token", TOKEN, {}],
    ["header over 16 KiB", `Bearer ${"a".repeat(16384)}`, {}],
    ["empty configured subject", `Bearer ${TOKEN}`, { subject: "" }],
  ];

  it.each(cases)("rejects %s without contacting the platform", async (_label, authorization, overrides) => {
    const p = mockPlatform();
    expect(await verify(authorization, overrides)).toBeNull();
    expect(p.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a bearer whose token is blank and never sends an empty credential", async () => {
    const p = mockPlatform();
    expect(await verify("Bearer ")).toBeNull();
    expect(await verify("Bearer    ")).toBeNull();
    expect(p.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("verifyGraphitiWorkload: native denials fail closed", () => {
  it("rejects when ForwardAuth denies the token and never sends the target request", async () => {
    for (const status of [401, 403]) {
      const p = mockPlatform({ validate: () => json(status, { detail: `denied for ${TOKEN}` }) });
      expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
      expect(p.validateCalls()).toHaveLength(1);
      expect(p.targetCalls()).toHaveLength(0);
      vi.unstubAllGlobals();
    }
  });

  it("rejects when ForwardAuth errors or answers 200 without a signed identity", async () => {
    const unsigned = mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-signature": undefined }) }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    expect(unsigned.targetCalls()).toHaveLength(0);
    vi.unstubAllGlobals();

    const noUser = mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-id": undefined }) }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    expect(noUser.targetCalls()).toHaveLength(0);
    vi.unstubAllGlobals();

    const outage = mockPlatform({ validate: () => json(503, { detail: "gateway unavailable" }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    expect(outage.targetCalls()).toHaveLength(0);
  });

  it("rejects a signed identity for a different subject even when /me claims the configured subject", async () => {
    const p = mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-id": OTHER_SUBJECT }) }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    expect(p.targetCalls()).toHaveLength(1);
  });

  it("rejects when the signed identity matches but /me reports a different subject", async () => {
    mockPlatform({ target: () => json(200, meBody({ sub: OTHER_SUBJECT })) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
  });

  it("rejects a subject that only matches case-insensitively or with surrounding whitespace", async () => {
    mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-id": SUBJECT.toUpperCase() }) }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    vi.unstubAllGlobals();
    mockPlatform();
    expect(await verify(`Bearer ${TOKEN}`, { subject: ` ${SUBJECT}` })).toBeNull();
  });

  it("requires the service role in the signed roles header, not in the /me body", async () => {
    // Signed roles lack service; the body claims it.
    mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-roles": "authenticated, user" }) }), target: () => json(200, meBody({ roles: ["service"] })) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    vi.unstubAllGlobals();

    // No roles header at all.
    mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-roles": undefined }) }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    vi.unstubAllGlobals();

    // A role that merely contains the word is not the role.
    mockPlatform({ validate: () => new Response(null, { status: 200, headers: identityHeaders({ "x-user-roles": "service-reader, Service" }) }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    vi.unstubAllGlobals();

    // Signed service role with a body that omits roles still passes: the signed header is authoritative.
    mockPlatform({ target: () => json(200, { username: "replay-graphiti", sub: SUBJECT }) });
    expect(await verify(`Bearer ${TOKEN}`)).toMatchObject({ subject: SUBJECT });
  });

  it("rejects when /me fails, is malformed or rejects the forwarded bearer", async () => {
    mockPlatform({ target: () => json(401, { detail: "target token rejected" }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    vi.unstubAllGlobals();

    mockPlatform({ target: () => json(200, { username: "replay-graphiti" }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
    vi.unstubAllGlobals();

    mockPlatform({ target: () => new Response("<html>SECRET</html>", { status: 200, headers: { "content-type": "text/html" } }) });
    expect(await verify(`Bearer ${TOKEN}`)).toBeNull();
  });

  it("rejects on a network failure instead of throwing, and the failure never escapes with the token", async () => {
    const p = mockPlatform({ validate: () => { throw new Error(`ECONNREFUSED while sending Bearer ${TOKEN}`); } });
    await expect(verify(`Bearer ${TOKEN}`)).resolves.toBeNull();
    expect(p.targetCalls()).toHaveLength(0);
  });

  it("rejects on timeout: an unresponsive platform yields null within the 5 s budget", async () => {
    vi.useFakeTimers();
    // The platform never answers; the client aborts at its 5 s budget and the mock rejects afterwards, as fetch does.
    const p = mockPlatform({ validate: () => new Promise<Response>((_resolve, reject) => setTimeout(() => reject(new DOMException("aborted", "AbortError")), 10_000)) });
    const pending = verify(`Bearer ${TOKEN}`);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(await pending).toBeNull();
    expect(p.targetCalls()).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe("verifyGraphitiWorkload: output hygiene", () => {
  it("never surfaces the bearer, signatures or identity headers in an accepted result or on the wire beyond the platform calls", async () => {
    const p = mockPlatform();
    const result = await verify(`Bearer ${TOKEN}`);
    assertNoSecrets(result);
    // Only the two expected platform calls were made; nothing else received the token.
    expect(p.fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of p.calls) expect(call.url.startsWith(API_BASE)).toBe(true);
  });
});
