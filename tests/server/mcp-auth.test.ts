import { describe, expect, it, vi } from "vitest";
import { FORWARD_AUTH_PATH, KamiwazaClient, type FetchImpl, type KamiwazaClientOptions } from "../../src/platform/index.ts";
import { McpAuthError, McpBearerResolver, extractBearer, extractWorkroom } from "../../src/server/mcp-auth.ts";

const API_BASE = "https://kamiwaza.example/api";
const HOST = "kamiwaza-harness.localhost";
const WORKROOM_ID = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const OTHER_WORKROOM = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const USER_ID = "6b26c9c6-52db-41b0-aec4-333e62c34907";
const OTHER_USER = "11111111-2222-4333-8444-555555555555";
const TOKEN = "tomo-bearer-SECRET-0123456789abcdef";
const SIGNATURE = "sig-SECRET-v1-9f8e7d6c5b4a";
const STABLE_SIGNATURE = "stable-SECRET-1a2b3c4d";
const FORGED_USER = "forged-user-from-tomo-header";

interface Call { path: string; method: string; headers: Record<string, string>; }

/** Fake installed platform: ForwardAuth validate with signed headers, then the two target reads the resolver uses. */
function fakePlatform() {
  const state = {
    validTokens: new Set<string>([TOKEN]),
    signedSub: USER_ID,
    signedScope: WORKROOM_ID as string | null,
    signedName: "POC poc-viewer" as string | null,
    omitSignature: false,
    validateStatus: 200,
    context: {
      workroom_id: WORKROOM_ID,
      user_id: USER_ID,
      effective_workroom_role: "viewer",
      workroom_lifecycle_state: "active",
      interaction_mode: "write",
      access_state: "active",
      can_edit: false,
      can_share: false,
      can_run_agents: false,
      read_only_reason: null as string | null,
      status_banner: null as string | null,
    },
    contextStatus: 200,
    workroom: { id: WORKROOM_ID, tenant_id: "t1", owner_user_id: OTHER_USER, name: "Decision Advantage Workroom", type: "standard", status: "active", created_at: "2026-09-13T00:00:00Z", attributes: {} as Record<string, unknown> },
    workroomStatus: 200,
    calls: [] as Call[],
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": `req-${state.calls.length}` } });
  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const path = new URL(url).pathname;
    state.calls.push({ path, method: init.method ?? "GET", headers });
    const token = headers.authorization?.startsWith("Bearer ") ? headers.authorization.slice(7) : null;
    if (path === `/api${FORWARD_AUTH_PATH}`) {
      if (state.validateStatus !== 200) return json(state.validateStatus, { detail: `validate refused token ${token}` });
      if (!token || !state.validTokens.has(token)) return json(401, { detail: `token rejected: ${token}` });
      const identity: Record<string, string> = { "x-user-id": state.signedSub, "x-user-roles": "offline_access, user", "x-user-signature-stable": STABLE_SIGNATURE, "x-user-signature-ts": "1789000000", "x-auth-token": token };
      if (!state.omitSignature) identity["x-user-signature"] = SIGNATURE;
      if (state.signedName) identity["x-user-name"] = state.signedName;
      if (state.signedScope) { identity["x-workroom-id"] = state.signedScope; identity["x-user-workroom-role"] = state.context.effective_workroom_role; }
      return new Response(null, { status: 200, headers: identity });
    }
    if (headers["x-user-signature"] !== SIGNATURE || !headers["x-user-id"]) return json(401, { detail: "unsigned target request" });
    if (!token || !state.validTokens.has(token)) return json(401, { detail: `target token rejected: ${token}` });
    if (path === `/api/workrooms/${WORKROOM_ID}/runtime/context`) return state.contextStatus === 200 ? json(200, state.context) : json(state.contextStatus, { detail: "context refused" });
    if (path === `/api/workrooms/${WORKROOM_ID}`) return state.workroomStatus === 200 ? json(200, state.workroom) : json(state.workroomStatus, { detail: "workroom refused" });
    return json(404, { detail: `no route ${path}` });
  });
  return { state, fetchImpl };
}

function harness() {
  const platform = fakePlatform();
  const clients: { opts: KamiwazaClientOptions }[] = [];
  const resolver = new McpBearerResolver({
    apiBase: API_BASE,
    workroomId: WORKROOM_ID,
    forwardedHost: HOST,
    fetchImpl: platform.fetchImpl,
    timeoutMs: 5_000,
    clientFactory: (opts) => { clients.push({ opts }); return new KamiwazaClient(opts); },
  });
  const headers = (extra: Record<string, string | string[] | undefined> = {}) => ({ authorization: `Bearer ${TOKEN}`, "x-workroom-id": WORKROOM_ID, ...extra });
  return { platform, resolver, clients, headers };
}

async function denial(p: Promise<unknown>): Promise<McpAuthError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(McpAuthError); return e as McpAuthError; }
  throw new Error("expected denial");
}

function assertNoSecrets(value: unknown) {
  const dump = JSON.stringify(value) + (value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : "");
  for (const s of [TOKEN, SIGNATURE, STABLE_SIGNATURE, "SECRET"]) expect(dump).not.toContain(s);
}

describe("McpBearerResolver: local refusals before any platform call", () => {
  it("refuses a missing, malformed or oversized Authorization header with 401 and no network", async () => {
    const { platform, resolver } = harness();
    for (const auth of [undefined, "", "Basic abc", "Bearer", "Bearer short", `Bearer ${"x".repeat(17_000)}`, ["Bearer a", "Bearer b"]]) {
      const err = await denial(resolver.resolve({ authorization: auth as string | string[] | undefined, "x-workroom-id": WORKROOM_ID }));
      expect(err.code).toBe("missing_bearer");
      expect(err.httpStatus).toBe(401);
    }
    expect(platform.fetchImpl).not.toHaveBeenCalled();
  });

  it("pins the workroom: a missing or foreign x-workroom-id is 403 before any network call", async () => {
    const { platform, resolver, headers } = harness();
    for (const room of [undefined, OTHER_WORKROOM, "", "not a room id !!"]) {
      const err = await denial(resolver.resolve(headers({ "x-workroom-id": room })));
      expect(err.code).toBe("workroom_mismatch");
      expect(err.httpStatus).toBe(403);
      assertNoSecrets(err);
    }
    expect(platform.fetchImpl).not.toHaveBeenCalled();
  });

  it("exposes the header extractors and reads nothing but authorization and x-workroom-id", () => {
    expect(extractBearer({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
    expect(extractBearer({ Authorization: `Bearer ${TOKEN}`, authorization: `bearer ${TOKEN}` })).toBe(TOKEN);
    expect(extractWorkroom({ "x-workroom-id": ` ${WORKROOM_ID} ` })).toBe(WORKROOM_ID);
    expect(extractWorkroom({})).toBeNull();
    expect(() => extractBearer({ "x-auth-token": TOKEN, cookie: `access_token=${TOKEN}` })).toThrow(McpAuthError);
  });
});

describe("McpBearerResolver: signed platform resolution", () => {
  it("derives identity from the signed ForwardAuth headers and runtime context, never from inbound x-user-* headers", async () => {
    const { platform, resolver, headers } = harness();
    const principal = await resolver.resolve(headers({ "x-user-id": FORGED_USER, "x-user-name": "Forged Name", "x-user-roles": "admin", "x-user-workroom-role": "owner", cookie: "access_token=other" }));
    expect(principal.identity).toEqual({ subject: USER_ID, name: "POC poc-viewer", role: "intelligence", organization: "Decision Advantage Workroom", mode: "kamiwaza" });
    expect(principal.context).toMatchObject({ workroomId: WORKROOM_ID, workroomName: "Decision Advantage Workroom", nativeRole: "viewer", mappedRole: "intelligence", profileApplied: false, canEdit: false, canRunAgents: false, canShare: false, fresh: true, accessState: "active" });
    expect(principal.nativeReceipts.map((r) => r.target.path)).toEqual([`/workrooms/${WORKROOM_ID}/runtime/context`, `/workrooms/${WORKROOM_ID}`]);
    // Exactly validate+target twice; no login, refresh, enter, or me.
    expect(platform.state.calls.map((c) => c.path)).toEqual([`/api${FORWARD_AUTH_PATH}`, `/api/workrooms/${WORKROOM_ID}/runtime/context`, `/api${FORWARD_AUTH_PATH}`, `/api/workrooms/${WORKROOM_ID}`]);
    // Inbound forged values never travel to the platform.
    for (const c of platform.state.calls) {
      expect(JSON.stringify(c.headers)).not.toContain(FORGED_USER);
      expect(JSON.stringify(c.headers)).not.toContain("Forged Name");
      expect(c.headers.cookie).toBeUndefined();
    }
    assertNoSecrets(principal);
  });

  it("uses the bearer only for the request and blanks it afterwards; nothing is cached between calls", async () => {
    const { platform, resolver, clients, headers } = harness();
    await resolver.resolve(headers());
    await resolver.resolve(headers());
    expect(clients).toHaveLength(3); // construction probe + one transient client per request
    for (const c of clients.slice(1)) expect(await c.opts.getToken()).toBe("");
    // Second request re-validated everything: 8 platform calls, not 4.
    expect(platform.state.calls).toHaveLength(8);
    expect(JSON.stringify(resolver)).not.toContain(TOKEN);
    expect(Object.keys(resolver)).not.toContain("live");
  });

  it("maps owner/editor/operator/viewer roles like native sessions and applies operator profiles without instructor promotion", async () => {
    const { platform, resolver, headers } = harness();
    const run = async (nativeRole: string, profile?: Record<string, unknown>) => {
      platform.state.context.effective_workroom_role = nativeRole;
      platform.state.workroom.attributes = profile ? { replay_profiles: { [USER_ID]: profile } } : {};
      return resolver.resolve(headers());
    };
    expect((await run("owner")).identity.role).toBe("instructor");
    expect((await run("editor")).identity.role).toBe("commander");
    expect((await run("operator")).identity.role).toBe("commander");
    expect((await run("viewer")).identity.role).toBe("intelligence");
    expect((await run("something-new")).identity.role).toBe("intelligence");
    const promoted = await run("viewer", { role: "instructor", name: "Prof. X", organization: "Unit 1" });
    expect(promoted.identity).toMatchObject({ role: "intelligence", name: "Prof. X", organization: "Unit 1" });
    expect(promoted.context.profileApplied).toBe(true);
    const seated = await run("viewer", { role: "commander" });
    expect(seated.identity.role).toBe("commander");
    expect(seated.context).toMatchObject({ mappedRole: "intelligence", canEdit: false });
    const ownerProfile = await run("owner", { role: "instructor" });
    expect(ownerProfile.identity.role).toBe("instructor");
    const foreignProfile = await run("viewer", undefined);
    platform.state.workroom.attributes = { replay_profiles: { [OTHER_USER]: { role: "commander" } } };
    expect((await resolver.resolve(headers())).identity.role).toBe(foreignProfile.identity.role);
  });

  it("falls back to the subject as display name when the platform signs no x-user-name", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.signedName = null;
    expect((await resolver.resolve(headers())).identity.name).toBe(USER_ID);
  });

  it("reports read-only and non-active contexts as canEdit=false without denying reads", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.context = { ...platform.state.context, can_edit: true, can_run_agents: true, interaction_mode: "read_only", access_state: "read_only", read_only_reason: "workroom frozen" };
    const p = await resolver.resolve(headers());
    expect(p.context).toMatchObject({ canEdit: false, canRunAgents: false, readOnlyReason: "workroom frozen", accessState: "read_only" });
  });
});

describe("McpBearerResolver: platform denials", () => {
  it("denies a rejected bearer with 401 and never attempts login, refresh or enter", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.validTokens.clear();
    const err = await denial(resolver.resolve(headers()));
    expect(err).toMatchObject({ code: "token_rejected", httpStatus: 401, nativeCode: "auth_denied" });
    expect(platform.state.calls.map((c) => c.path)).toEqual([`/api${FORWARD_AUTH_PATH}`]);
    assertNoSecrets(err);
    assertNoSecrets(err.toJSON());
  });

  it("denies a validate 200 without a signature (nothing is sent to the target)", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.omitSignature = true;
    const err = await denial(resolver.resolve(headers()));
    expect(err).toMatchObject({ code: "platform_unavailable", httpStatus: 503, nativeCode: "missing_signature" });
    expect(platform.state.calls).toHaveLength(1);
  });

  it("denies a signed scope that differs from the configured workroom", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.signedScope = OTHER_WORKROOM;
    platform.state.context.workroom_id = OTHER_WORKROOM;
    const err = await denial(resolver.resolve(headers()));
    expect(err).toMatchObject({ code: "workroom_mismatch", httpStatus: 403 });
    platform.state.signedScope = null;
    expect((await denial(resolver.resolve(headers()))).code).toBe("workroom_mismatch");
  });

  it("denies when the signed subject and the runtime context subject disagree, on either signed call", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.context.user_id = OTHER_USER;
    expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "subject_mismatch", httpStatus: 403 });
    platform.state.context.user_id = USER_ID;
    let n = 0;
    const original = platform.fetchImpl.getMockImplementation()!;
    platform.fetchImpl.mockImplementation(async (url, init) => {
      // Third call is the validate for the workroom read; sign it as another user.
      if (++n === 3) platform.state.signedSub = OTHER_USER;
      const r = await original(url, init);
      platform.state.signedSub = USER_ID;
      return r;
    });
    expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "subject_mismatch", httpStatus: 403 });
  });

  it("denies blocked, archived and unbound contexts, and treats a 404/409 context as access revoked", async () => {
    const { platform, resolver, headers } = harness();
    for (const patch of [{ interaction_mode: "blocked" }, { access_state: "archived" }, { access_state: "unbound" }] as const) {
      platform.state.context = { ...platform.state.context, interaction_mode: "write", access_state: "active", ...patch };
      const err = await denial(resolver.resolve(headers()));
      expect(err).toMatchObject({ code: "access_blocked", httpStatus: 403 });
      expect(platform.state.calls.filter((c) => c.path === `/api/workrooms/${WORKROOM_ID}`)).toHaveLength(0);
    }
    platform.state.context = { ...platform.state.context, interaction_mode: "write", access_state: "active" };
    for (const status of [404, 409]) {
      platform.state.contextStatus = status;
      expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "access_blocked", httpStatus: 403 });
    }
  });

  it("classifies ForwardAuth 403, platform 5xx and workroom-read failures without leaking the bearer", async () => {
    const { platform, resolver, headers } = harness();
    platform.state.validateStatus = 403;
    expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "forbidden", httpStatus: 403 });
    platform.state.validateStatus = 500;
    expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "platform_unavailable", httpStatus: 503 });
    platform.state.validateStatus = 200;
    platform.state.contextStatus = 503;
    expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "platform_unavailable", httpStatus: 503 });
    platform.state.contextStatus = 200;
    platform.state.workroomStatus = 403;
    const err = await denial(resolver.resolve(headers()));
    expect(err).toMatchObject({ code: "forbidden", httpStatus: 403 });
    assertNoSecrets(err);
    platform.fetchImpl.mockRejectedValueOnce(new Error(`socket reset while sending Bearer ${TOKEN}`));
    const net = await denial(resolver.resolve(headers()));
    expect(net.httpStatus).toBe(503);
    assertNoSecrets(net);
  });

  it("refuses a malformed configuration at construction", () => {
    expect(() => new McpBearerResolver({ apiBase: "", workroomId: WORKROOM_ID, forwardedHost: HOST })).toThrow(McpAuthError);
    expect(() => new McpBearerResolver({ apiBase: API_BASE, workroomId: "short", forwardedHost: HOST })).toThrow(McpAuthError);
    expect(() => new McpBearerResolver({ apiBase: "https://kamiwaza.example/", workroomId: WORKROOM_ID, forwardedHost: HOST })).toThrow();
  });
});

describe("MCP auth regression boundaries", () => {
  it("checks signed workroom scope again on the profile read and clears failed clients", async () => {
    const { platform, resolver, clients, headers } = harness();
    const original = platform.fetchImpl.getMockImplementation()!;
    let n = 0;
    platform.fetchImpl.mockImplementation(async (url, init) => {
      if (++n === 3) platform.state.signedScope = OTHER_WORKROOM;
      return original(url, init);
    });
    expect(await denial(resolver.resolve(headers()))).toMatchObject({ code: "workroom_mismatch", httpStatus: 403 });
    for (const c of clients.slice(1)) expect(await c.opts.getToken()).toBe("");
  });

  it("keeps overlapping member requests separate and never substitutes the owner", async () => {
    const { platform, resolver, headers, clients } = harness();
    const otherToken = "second-member-fixture-0123456789";
    platform.state.validTokens.add(otherToken);
    const original = platform.fetchImpl.getMockImplementation()!;
    platform.fetchImpl.mockImplementation(async (url, init) => {
      const second = new Headers(init.headers).get("authorization") === `Bearer ${otherToken}`;
      const response = await original(url, init);
      const path = new URL(url).pathname;
      if (path.endsWith(FORWARD_AUTH_PATH)) {
        const h = new Headers(response.headers);
        h.set("x-user-id", second ? OTHER_USER : USER_ID);
        return new Response(null, { status: response.status, headers: h });
      }
      if (path.endsWith("/runtime/context")) return new Response(JSON.stringify({ ...platform.state.context, user_id: second ? OTHER_USER : USER_ID }), { headers: response.headers });
      return response;
    });
    const [one, two] = await Promise.all([resolver.resolve(headers()), resolver.resolve(headers({ authorization: `Bearer ${otherToken}` }))]);
    expect(one.identity.subject).toBe(USER_ID);
    expect(two.identity.subject).toBe(OTHER_USER);
    expect(one.identity.role).toBe("intelligence");
    expect(two.identity.role).toBe("intelligence");
    for (const c of clients.slice(1)) expect(await c.opts.getToken()).toBe("");
    assertNoSecrets([one, two]);
    expect(JSON.stringify([one, two])).not.toContain(otherToken);
  });
});
