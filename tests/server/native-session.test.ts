import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FORWARD_AUTH_PATH, type FetchImpl } from "../../src/platform/index.ts";
import { ATTRIBUTES_CACHE_MS, CONTEXT_CACHE_MS, NativeSessionError, NativeSessions, REFRESH_LEAD_MS } from "../../src/server/native-session.ts";

const API_BASE = "https://kamiwaza.example/api";
const HOST = "kamiwaza-harness.localhost";
const WORKROOM_ID = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const OTHER_WORKROOM = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const USER_ID = "6b26c9c6-52db-41b0-aec4-333e62c34907";
const OTHER_USER = "11111111-2222-4333-8444-555555555555";
const PASSWORD = "pw-SECRET-correct-horse";
const SIGNATURE = "sig-SECRET-v1-9f8e7d6c5b4a";
const STABLE_SIGNATURE = "stable-SECRET-1a2b3c4d";
const SESSION_A = "browser-session-aaaaaaaa";
const SESSION_B = "browser-session-bbbbbbbb";

function b64url(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}
function jwt(claims: Record<string, unknown>, tag: string): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sigSECRET${tag}${"x".repeat(12)}`;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Stateful fake of the installed platform: exempt login/refresh, ForwardAuth
 * validate with signed identity headers, then the target endpoints used by
 * NativeSessions. All tokens are opaque to the session module; the fake is
 * the only thing that knows which token is valid.
 */
function fakePlatform(clock: () => number) {
  const state = {
    tokens: new Map<string, { sub: string; sid: string | null; kind: "session" | "pat" }>(),
    refreshTokens: new Map<string, string>(), // refresh -> sub
    revoked: new Set<string>(),
    nextTokenSerial: 1,
    expiresIn: 300,
    signedScope: WORKROOM_ID as string | null,
    signedSub: USER_ID,
    meSub: USER_ID,
    context: {
      workroom_id: WORKROOM_ID,
      user_id: USER_ID,
      effective_workroom_role: "owner",
      workroom_lifecycle_state: "active",
      interaction_mode: "write",
      access_state: "active",
      can_edit: true,
      can_share: true,
      can_run_agents: true,
      read_only_reason: null as string | null,
      status_banner: null as string | null,
    },
    workroom: {
      id: WORKROOM_ID,
      tenant_id: "t1",
      owner_user_id: USER_ID,
      name: "Decision Advantage Workroom",
      type: "standard",
      status: "active",
      created_at: "2026-09-13T00:00:00Z",
      attributes: {} as Record<string, unknown>,
    },
    refreshStatus: 200 as number,
    contextFailure: 0 as number,
    refreshDelayMs: 0,
    calls: [] as Call[],
  };

  function issue(sub: string, sid: string | null): { access_token: string; refresh_token: string; expires_in: number } {
    const serial = state.nextTokenSerial++;
    const access = jwt({ sub, sid, exp: Math.floor(clock() / 1000) + state.expiresIn, serial }, `acc${serial}`);
    const refresh = `refresh-SECRET-${serial}-${"r".repeat(20)}`;
    state.tokens.set(access, { sub, sid, kind: "session" });
    state.refreshTokens.set(refresh, sub);
    return { access_token: access, refresh_token: refresh, expires_in: state.expiresIn };
  }

  function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": `req-${state.calls.length}`, ...headers } });
  }

  function bearer(headers: Record<string, string>): string | null {
    const auth = headers.authorization;
    return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  }

  const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : null };
    state.calls.push(call);
    const u = new URL(url);
    const p = u.pathname;

    if (p === "/api/auth/token") {
      const form = new URLSearchParams(call.body ?? "");
      if (form.get("password") !== PASSWORD) return json(401, { detail: `invalid credentials for ${form.get("username")} with ${form.get("password")}` });
      return json(200, { ...issue(USER_ID, `sid-${state.nextTokenSerial}`), token_type: "bearer" });
    }
    if (p === "/api/auth/refresh") {
      if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
      const rt = u.searchParams.get("refresh_token");
      if (state.refreshStatus !== 200) return json(state.refreshStatus, { detail: `refresh failed for ${rt}` });
      const sub = rt ? state.refreshTokens.get(rt) : undefined;
      if (!sub || (rt && state.revoked.has(rt))) return json(401, { detail: `unknown refresh token ${rt}` });
      state.refreshTokens.delete(rt!);
      // Same Keycloak session id survives a refresh.
      const prevSid = [...state.tokens.values()].find((t) => t.sub === sub)?.sid ?? null;
      return json(200, { ...issue(sub, prevSid), token_type: "bearer" });
    }
    if (p === `/api${FORWARD_AUTH_PATH}`) {
      const token = bearer(headers);
      const known = token ? state.tokens.get(token) : undefined;
      if (!token || !known || state.revoked.has(token)) return json(401, { detail: `token rejected: ${token}` });
      const scope = state.signedScope;
      const identity: Record<string, string> = {
        "x-user-id": state.signedSub,
        "x-user-name": "POC poc-viewer",
        "x-user-roles": "offline_access, user",
        "x-user-signature": SIGNATURE,
        "x-user-signature-stable": STABLE_SIGNATURE,
        "x-user-signature-ts": String(Math.floor(clock() / 1000)),
        "x-auth-token": token,
      };
      if (scope) {
        identity["x-workroom-id"] = scope;
        identity["x-user-workroom-role"] = state.context.effective_workroom_role;
      }
      return new Response(null, { status: 200, headers: identity });
    }
    // Targets: require the signed headers to have been forwarded.
    if (headers["x-user-signature"] !== SIGNATURE || !headers["x-user-id"]) return json(401, { detail: "unsigned target request" });
    const token = bearer(headers);
    if (!token || !state.tokens.has(token) || state.revoked.has(token)) return json(401, { detail: `target token rejected: ${token}` });

    if (p === "/api/auth/users/me") return json(200, { username: "poc-viewer", sub: state.meSub, roles: ["user"], email: "poc-viewer@harness.example.com" });
    const enter = p.match(/^\/api\/workrooms\/([^/]+)\/enter$/);
    if (enter && call.method === "POST") {
      const known = state.tokens.get(token)!;
      if (known.kind !== "session" || !known.sid) return json(400, { detail: "session required" });
      return json(200, { workroom_id: decodeURIComponent(enter[1]!), message: "Workroom session bound" });
    }
    if (p === `/api/workrooms/${WORKROOM_ID}/runtime/context`) return state.contextFailure ? json(state.contextFailure,{detail:{code:'session_conflict',detail:'Private platform diagnostic'}}) : json(200, state.context);
    if (p === `/api/workrooms/${WORKROOM_ID}`) return json(200, state.workroom);
    return json(404, { detail: `no route ${p}` });
  });

  return {
    state,
    fetchImpl,
    issuePat(sub = USER_ID): string {
      const serial = state.nextTokenSerial++;
      const pat = jwt({ sub, typ: "pat", exp: Math.floor(clock() / 1000) + 86_400, serial }, `pat${serial}`);
      state.tokens.set(pat, { sub, sid: null, kind: "pat" });
      return pat;
    },
    revokeAll() {
      for (const t of state.tokens.keys()) state.revoked.add(t);
      for (const r of state.refreshTokens.keys()) state.revoked.add(r);
    },
    calls(pathSuffix: string | RegExp) {
      return state.calls.filter((c) => (typeof pathSuffix === "string" ? new URL(c.url).pathname.endsWith(pathSuffix) : pathSuffix.test(new URL(c.url).pathname)));
    },
    latestAccessToken(): string {
      return [...state.tokens.keys()].at(-1)!;
    },
  };
}

const dirs: string[] = [];
const open: NativeSessions[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function harness(overrides: { dataDir?: string; clockStart?: number } = {}) {
  let now = overrides.clockStart ?? Date.parse("2026-09-13T12:00:00Z");
  const clock = () => now;
  const platform = fakePlatform(clock);
  const dataDir = overrides.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "replay-native-session-"));
  if (!overrides.dataDir) dirs.push(dataDir);
  const make = (fetchImpl: FetchImpl = platform.fetchImpl) => {
    const s = new NativeSessions({ dataDir, apiBase: API_BASE, workroomId: WORKROOM_ID, forwardedHost: HOST, fetchImpl, now: clock, timeoutMs: 5_000 });
    open.push(s);
    return s;
  };
  return { platform, dataDir, sessions: make(), make, advance: (ms: number) => (now += ms), clock };
}

async function capture(p: Promise<unknown>): Promise<NativeSessionError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(NativeSessionError);
    return e as NativeSessionError;
  }
  throw new Error("expected rejection");
}

function assertNoSecrets(value: unknown, extra: string[] = []) {
  const dump = JSON.stringify(value) + (value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : "");
  for (const s of [PASSWORD, SIGNATURE, STABLE_SIGNATURE, "SECRET", "refresh_token=", ...extra]) expect(dump).not.toContain(s);
}

function rawDb(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, "native-sessions.sqlite"));
  try {
    return db.prepare("SELECT session_id, nonce, ciphertext, tag, updated_at FROM native_session_tokens").all() as { session_id: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array }[];
  } finally {
    db.close();
  }
}

describe("login and signed identity", () => {
  it("logs in with runtime-only credentials, validates me + enter + context through ForwardAuth, and returns a mapped identity", async () => {
    const { platform, sessions } = harness();
    const res = await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });

    expect(res.identity).toEqual({ subject: USER_ID, name: "POC poc-viewer", role: "instructor", organization: "Decision Advantage Workroom", mode: "kamiwaza" });
    expect(res.context).toMatchObject({ workroomId: WORKROOM_ID, nativeRole: "owner", mappedRole: "instructor", profileApplied: false, accessState: "active", canEdit: true, canRunAgents: true });
    expect(res.metadata).toMatchObject({ signedIn: true, subject: USER_ID, username: "poc-viewer", workroomId: WORKROOM_ID, refreshable: true, binding: "session" });
    expect(res.nativeReceipts.map((r) => `${r.target.method} ${r.target.path}`)).toEqual([
      "GET /auth/users/me",
      `POST /workrooms/${WORKROOM_ID}/enter`,
      `GET /workrooms/${WORKROOM_ID}/runtime/context`,
      `GET /workrooms/${WORKROOM_ID}`,
    ]);
    // Every protected target was preceded by a validate for that exact URI.
    const validates = platform.calls(FORWARD_AUTH_PATH);
    expect(validates.map((v) => v.headers["x-forwarded-uri"])).toEqual([
      "/api/auth/users/me",
      `/api/workrooms/${WORKROOM_ID}/enter`,
      `/api/workrooms/${WORKROOM_ID}/runtime/context`,
      `/api/workrooms/${WORKROOM_ID}`,
    ]);
    expect(validates.every((v) => v.headers["x-forwarded-host"] === HOST)).toBe(true);
    // Login itself is exempt and posts the form once; the password is not retained anywhere public.
    expect(platform.calls("/auth/token")).toHaveLength(1);
    assertNoSecrets(res);
    assertNoSecrets(sessions);
    expect(JSON.stringify(sessions)).toContain(WORKROOM_ID);
  });

  it("rejects bad credentials with a 401 that never echoes the password", async () => {
    const { sessions } = harness();
    const err = await capture(sessions.login(SESSION_A, { username: "poc-viewer", password: "pw-SECRET-wrong" }));
    expect(err).toMatchObject({ code: "login_failed", httpStatus: 401, nativeCode: "http_error" });
    assertNoSecrets(err, ["pw-SECRET-wrong"]);
    assertNoSecrets(err.toJSON(), ["pw-SECRET-wrong"]);
    expect(sessions.metadata(SESSION_A).signedIn).toBe(false);
    expect((await capture(sessions.login(SESSION_A, { username: "", password: "x" }))).httpStatus).toBe(400);
    expect((await capture(sessions.login("bad id!", { username: "u", password: "p" }))).httpStatus).toBe(400);
  });

  it("refuses a login whose signed identity disagrees with the user record, persisting nothing", async () => {
    const { platform, sessions, dataDir } = harness();
    platform.state.meSub = OTHER_USER;
    const err = await capture(sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD }));
    expect(err).toMatchObject({ code: "subject_mismatch", httpStatus: 403 });
    expect(rawDb(dataDir)).toHaveLength(0);
    expect(platform.calls("/enter")).toHaveLength(0);
  });

  it("rejects a session whose platform-signed scope is a different workroom than configured", async () => {
    const { platform, sessions, dataDir } = harness();
    platform.state.signedScope = OTHER_WORKROOM;
    const err = await capture(sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD }));
    expect(err).toMatchObject({ code: "workroom_mismatch", httpStatus: 403 });
    expect(rawDb(dataDir)).toHaveLength(0);

    // An unscoped signature (no x-workroom-id) is not an acceptable fallback either.
    platform.state.signedScope = null;
    const err2 = await capture(sessions.login(SESSION_B, { username: "poc-viewer", password: PASSWORD }));
    expect(err2).toMatchObject({ code: "workroom_mismatch", httpStatus: 403 });
    expect(sessions.metadata(SESSION_B).signedIn).toBe(false);
  });

  it("attachToken binds an operator PAT without enter and without a refresh token", async () => {
    const { platform, sessions } = harness();
    const pat = platform.issuePat();
    const res = await sessions.attachToken(SESSION_A, pat);
    expect(res.metadata).toMatchObject({ binding: "none", refreshable: false, subject: USER_ID });
    expect(platform.calls("/enter")).toHaveLength(0);
    const resolved = await sessions.resolve(SESSION_A, { requireWrite: true });
    expect(resolved.identity.role).toBe("instructor");
    assertNoSecrets(res, [pat]);
    expect((await capture(sessions.attachToken(SESSION_B, "short"))).httpStatus).toBe(400);
  });
});

describe("encrypted at rest", () => {
  it("stores tokens only as AES-256-GCM ciphertext under a 0600 key file and never in plaintext", async () => {
    const { platform, sessions, dataDir } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const access = platform.latestAccessToken();
    const refresh = [...platform.state.refreshTokens.keys()][0]!;

    const keyFile = path.join(dataDir, "native-sessions.key");
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64")).toHaveLength(32);

    const rows = rawDb(dataDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe(SESSION_A);
    expect(rows[0]!.nonce).toHaveLength(12);
    expect(rows[0]!.tag).toHaveLength(16);
    const onDisk = fs.readFileSync(path.join(dataDir, "native-sessions.sqlite"));
    const wal = path.join(dataDir, "native-sessions.sqlite-wal");
    const bytes = fs.existsSync(wal) ? Buffer.concat([onDisk, fs.readFileSync(wal)]) : onDisk;
    for (const secret of [access, refresh, PASSWORD, USER_ID, "poc-viewer"]) expect(bytes.includes(secret)).toBe(false);
  });

  it("rejects a tampered row and a row moved to another session id, treating both as signed out", async () => {
    const { sessions, dataDir, make } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    sessions.close();
    open.splice(open.indexOf(sessions), 1);

    const db = new DatabaseSync(path.join(dataDir, "native-sessions.sqlite"));
    const row = db.prepare("SELECT nonce, ciphertext, tag FROM native_session_tokens WHERE session_id = ?").get(SESSION_A) as { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };
    const flipped = Buffer.from(row.ciphertext);
    flipped[0] = flipped[0]! ^ 0xff;
    // Same ciphertext under another session id (AAD mismatch).
    db.prepare("INSERT INTO native_session_tokens(session_id, nonce, ciphertext, tag, updated_at) VALUES(?,?,?,?,?)").run(SESSION_B, row.nonce, row.ciphertext, row.tag, "x");
    db.prepare("UPDATE native_session_tokens SET ciphertext = ? WHERE session_id = ?").run(flipped, SESSION_A);
    db.close();

    const restarted = make();
    expect((await capture(restarted.resolve(SESSION_A))).code).toBe("signed_out");
    expect((await capture(restarted.resolve(SESSION_B))).code).toBe("signed_out");
    expect(rawDb(dataDir)).toHaveLength(0);
  });

  it("restores a legitimate session after restart and re-validates it natively", async () => {
    const { platform, sessions, dataDir, make } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    sessions.close();
    open.splice(open.indexOf(sessions), 1);
    const before = platform.state.calls.length;

    const restarted = make();
    const res = await restarted.resolve(SESSION_A, { requireWrite: true });
    expect(res.identity.subject).toBe(USER_ID);
    expect(res.context.fresh).toBe(true);
    expect(platform.calls("/auth/token").length).toBe(1); // no re-login
    expect(platform.state.calls.length).toBeGreaterThan(before); // context was fetched, not trusted from disk
    expect(rawDb(dataDir)).toHaveLength(1);

    // A different key file cannot open the row.
    restarted.close();
    open.splice(open.indexOf(restarted), 1);
    fs.writeFileSync(path.join(dataDir, "native-sessions.key"), Buffer.alloc(32, 7).toString("base64"), { mode: 0o600 });
    expect((await capture(make().resolve(SESSION_A))).code).toBe("signed_out");
  });

  it("logout discards the session from memory and disk", async () => {
    const { sessions, dataDir } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    sessions.logout(SESSION_A);
    expect(rawDb(dataDir)).toHaveLength(0);
    expect((await capture(sessions.resolve(SESSION_A))).httpStatus).toBe(401);
    expect(sessions.metadata(SESSION_A)).toMatchObject({ signedIn: false, subject: null });
  });
});

describe("authorization follows the native context, never the browser", () => {
  it("maps native roles to seats and defaults unknown roles to intelligence", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    for (const [native, seat] of [["owner", "instructor"], ["editor", "commander"], ["operator", "commander"], ["viewer", "intelligence"], ["auditor", "intelligence"]] as const) {
      platform.state.context.effective_workroom_role = native;
      advance(CONTEXT_CACHE_MS + 1);
      expect((await sessions.resolve(SESSION_A)).identity.role).toBe(seat);
    }
  });

  it("blocks writes immediately when native context is read-only or revoked, and blocks everything when interaction is blocked", async () => {
    const { platform, sessions } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    expect((await sessions.resolve(SESSION_A, { requireWrite: true })).context.canEdit).toBe(true);

    // Operator flips the workroom to read-only: the very next write is denied even though the read cache is warm.
    Object.assign(platform.state.context, { access_state: "read_only", interaction_mode: "readonly", can_edit: false, can_run_agents: false, read_only_reason: "archival hold" });
    const denied = await capture(sessions.resolve(SESSION_A, { requireWrite: true }));
    expect(denied).toMatchObject({ code: "read_only", httpStatus: 403 });
    expect(denied.message).toContain("archival hold");
    const read = await sessions.resolve(SESSION_A);
    expect(read.context).toMatchObject({ canEdit: false, canRunAgents: false, accessState: "read_only" });

    // can_edit true but interaction_mode readonly still blocks writes; agents need can_run_agents.
    Object.assign(platform.state.context, { access_state: "active", interaction_mode: "readonly", can_edit: true, can_run_agents: true });
    expect((await capture(sessions.resolve(SESSION_A, { requireWrite: true }))).code).toBe("read_only");
    Object.assign(platform.state.context, { interaction_mode: "write", can_edit: true, can_run_agents: false });
    expect((await capture(sessions.resolve(SESSION_A, { requireAgents: true }))).code).toBe("agents_blocked");
    expect((await sessions.resolve(SESSION_A, { requireWrite: true })).context.canRunAgents).toBe(false);

    // Blocked interaction denies reads too.
    Object.assign(platform.state.context, { interaction_mode: "blocked" });
    expect((await capture(sessions.resolve(SESSION_A, { requireWrite: true }))).code).toBe("access_blocked");
    Object.assign(platform.state.context, { interaction_mode: "write", access_state: "archived" });
    expect((await capture(sessions.resolve(SESSION_A, { requireWrite: true }))).code).toBe("access_blocked");

    // Native revocation: token and refresh token die; the write fails 401 and the session is gone.
    Object.assign(platform.state.context, { access_state: "active" });
    platform.revokeAll();
    const out = await capture(sessions.resolve(SESSION_A, { requireWrite: true }));
    expect(out).toMatchObject({ code: "signed_out", httpStatus: 401 });
    expect(sessions.metadata(SESSION_A).signedIn).toBe(false);
    assertNoSecrets(out);
  });

  it("applies an operator replay_profile for the authenticated subject only, without conferring native permission", async () => {
    const { platform, sessions, advance } = harness();
    platform.state.context.effective_workroom_role = "viewer";
    Object.assign(platform.state.context, { can_edit: false, can_run_agents: false });
    platform.state.workroom.attributes = {
      replay_profiles: {
        [USER_ID]: { role: "commander", name: "CDR Morgan", organization: "1st Decision Cell" },
        [OTHER_USER]: { role: "instructor", name: "Should not apply" },
      },
    };
    const res = await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    expect(res.identity).toEqual({ subject: USER_ID, name: "CDR Morgan", role: "commander", organization: "1st Decision Cell", mode: "kamiwaza" });
    expect(res.context).toMatchObject({ nativeRole: "viewer", mappedRole: "intelligence", profileApplied: true, canEdit: false });
    // The commander profile does not make the viewer writable.
    expect((await capture(sessions.resolve(SESSION_A, { requireWrite: true }))).code).toBe("read_only");
    expect((await capture(sessions.resolve(SESSION_A, { requireAgents: true }))).code).toBe("agents_blocked");

    // Scenario metadata cannot grant instructor access to other participants' private records.
    platform.state.workroom.attributes = {replay_profiles:{[USER_ID]:{role:'instructor'}}};
    advance(ATTRIBUTES_CACHE_MS + 1);
    expect((await sessions.resolve(SESSION_A)).identity.role).toBe('intelligence');
    // Invalid role values are ignored; other fields still apply.
    platform.state.workroom.attributes = { replay_profiles: { [USER_ID]: { role: "admin", organization: "  Cell B  " } } };
    advance(ATTRIBUTES_CACHE_MS + 1);
    const next = await sessions.resolve(SESSION_A);
    expect(next.identity).toMatchObject({ role: "intelligence", name: "POC poc-viewer", organization: "Cell B" });

    // No profile for this subject: defaults.
    platform.state.workroom.attributes = { replay_profiles: { [OTHER_USER]: { role: "instructor" } } };
    advance(ATTRIBUTES_CACHE_MS + 1);
    expect((await sessions.resolve(SESSION_A)).identity.role).toBe("intelligence");
  });

  it("signs out when the platform's signed subject stops matching the bound session", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    platform.state.signedSub = OTHER_USER;
    platform.state.context.user_id = OTHER_USER;
    advance(CONTEXT_CACHE_MS + 1);
    expect((await capture(sessions.resolve(SESSION_A))).code).toBe("subject_mismatch");
    expect(sessions.metadata(SESSION_A).signedIn).toBe(false);
  });

  it("caches runtime context for reads at most 5 s and workroom attributes at most 30 s; writes are always fresh", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const ctxCalls = () => platform.calls("/runtime/context").length;
    const attrCalls = () => platform.calls(new RegExp(`/api/workrooms/${WORKROOM_ID}$`)).length;
    const [c0, a0] = [ctxCalls(), attrCalls()];

    expect((await sessions.resolve(SESSION_A)).context.fresh).toBe(false);
    expect([ctxCalls(), attrCalls()]).toEqual([c0, a0]);
    advance(CONTEXT_CACHE_MS + 1);
    expect((await sessions.resolve(SESSION_A)).context.fresh).toBe(true);
    expect([ctxCalls(), attrCalls()]).toEqual([c0 + 1, a0]);
    advance(ATTRIBUTES_CACHE_MS + 1);
    await sessions.resolve(SESSION_A);
    expect([ctxCalls(), attrCalls()]).toEqual([c0 + 2, a0 + 1]);
    // Writes refetch both regardless of cache age.
    await sessions.resolve(SESSION_A, { requireWrite: true });
    await sessions.resolve(SESSION_A, { requireAgents: true });
    expect([ctxCalls(), attrCalls()]).toEqual([c0 + 4, a0 + 3]);
  });

  it("refreshes read authority and profile immediately without granting or requiring writes", async () => {
    const { platform, sessions } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    expect((await sessions.resolve(SESSION_A)).context.fresh).toBe(false);
    Object.assign(platform.state.context, { access_state: "read_only", interaction_mode: "readonly", can_edit: false, can_run_agents: false });
    platform.state.workroom.attributes = { replay_profiles: { [USER_ID]: { role: "intelligence", name: "Current analyst" } } };
    const read = await sessions.resolve(SESSION_A, { fresh: true });
    expect(read.context).toMatchObject({ fresh: true, canEdit: false, canRunAgents: false, accessState: "read_only" });
    expect(read.identity).toMatchObject({ role: "intelligence", name: "Current analyst" });
    Object.assign(platform.state.context, { access_state: "archived" });
    expect((await capture(sessions.resolve(SESSION_A, { fresh: true }))).code).toBe("access_blocked");
  });

  it.each([404,409])('treats native runtime context HTTP %s as an access interruption and drops stale read context',async status=>{
    const {platform,sessions}=harness();await sessions.login(SESSION_A,{username:'poc-viewer',password:PASSWORD});platform.state.contextFailure=status;
    const first=await capture(sessions.resolve(SESSION_A,{requireWrite:true}));expect(first).toMatchObject({code:'access_blocked',httpStatus:403});expect(first.message).toContain('Sign in again');
    const read=await capture(sessions.resolve(SESSION_A));expect(read.httpStatus).toBe(403);expect(first.message).not.toContain('Private platform diagnostic');
  });

  it("classifies platform outages as 503 without signing the session out", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const real = platform.fetchImpl.getMockImplementation()!;
    platform.fetchImpl.mockImplementation(async (url, init) => (url.endsWith(FORWARD_AUTH_PATH) ? new Response("down", { status: 503 }) : real(url, init)));
    advance(CONTEXT_CACHE_MS + 1);
    const err = await capture(sessions.resolve(SESSION_A));
    expect(err).toMatchObject({ code: "platform_unavailable", httpStatus: 503, nativeCode: "auth_error" });
    expect(sessions.metadata(SESSION_A).signedIn).toBe(true);
    platform.fetchImpl.mockImplementation(real);
    expect((await sessions.resolve(SESSION_A)).identity.subject).toBe(USER_ID);
  });
});

describe("renewal", () => {
  it("refreshes within 45 s of expiry with a single flight per session, rotating both tokens and persisting them", async () => {
    const { platform, sessions, advance, dataDir, make } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const firstAccess = platform.latestAccessToken();
    const firstRefresh = [...platform.state.refreshTokens.keys()][0]!;
    expect(platform.calls("/auth/refresh")).toHaveLength(0);

    advance(300_000 - REFRESH_LEAD_MS + 1_000); // inside the 45 s lead
    platform.state.refreshDelayMs = 20;
    const [a, b, c] = await Promise.all([sessions.resolve(SESSION_A), sessions.resolve(SESSION_A, { requireWrite: true }), sessions.resolve(SESSION_A)]);
    expect(platform.calls("/auth/refresh")).toHaveLength(1);
    expect([a, b, c].every((r) => r.identity.subject === USER_ID)).toBe(true);

    // Vendor-required query form was sent, and only there.
    const refreshCall = platform.calls("/auth/refresh")[0]!;
    expect(refreshCall.method).toBe("POST");
    expect(new URL(refreshCall.url).searchParams.get("refresh_token")).toBe(firstRefresh);
    expect(refreshCall.headers.authorization).toBeUndefined();

    // Subsequent signed calls use the rotated access token; the old one is gone.
    const rotated = platform.latestAccessToken();
    expect(rotated).not.toBe(firstAccess);
    const lastValidate = platform.calls(FORWARD_AUTH_PATH).at(-1)!;
    expect(lastValidate.headers.authorization).toBe(`Bearer ${rotated}`);
    expect(platform.state.refreshTokens.has(firstRefresh)).toBe(false);

    // The rotated pair survives restart; the old refresh token is not reused.
    sessions.close();
    open.splice(open.indexOf(sessions), 1);
    const restarted = make();
    await restarted.resolve(SESSION_A, { requireWrite: true });
    expect(platform.calls(FORWARD_AUTH_PATH).at(-1)!.headers.authorization).toBe(`Bearer ${rotated}`);
    const bytes = fs.readFileSync(path.join(dataDir, "native-sessions.sqlite"));
    expect(bytes.includes(rotated)).toBe(false);
    expect(bytes.includes(firstRefresh)).toBe(false);
  });

  it("renews transparently inside the session-scoped platform client", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const { platformClient } = await sessions.resolve(SESSION_A);
    advance(300_000 - 10_000);
    const me = await platformClient.me();
    expect(me.identity.userId).toBe(USER_ID);
    expect(platform.calls("/auth/refresh")).toHaveLength(1);
    expect(platform.calls("/auth/users/me").at(-1)!.headers.authorization).toBe(`Bearer ${platform.latestAccessToken()}`);
    assertNoSecrets(platformClient);
  });

  it("falls to signed-out when the refresh token is rejected, and never puts the refresh URL or token in the error", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const refresh = [...platform.state.refreshTokens.keys()][0]!;
    platform.state.revoked.add(refresh);
    advance(300_000 - 5_000);
    const err = await capture(sessions.resolve(SESSION_A));
    expect(err).toMatchObject({ code: "signed_out", httpStatus: 401 });
    assertNoSecrets(err, [refresh, "/auth/refresh?"]);
    assertNoSecrets(err.toJSON(), [refresh]);
    expect(sessions.metadata(SESSION_A).signedIn).toBe(false);
  });

  it("keeps the session on a transient refresh outage and signs out once an unrenewable token has expired", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    advance(300_000 - 5_000);
    platform.state.refreshStatus = 502;
    const err = await capture(sessions.resolve(SESSION_A));
    expect(err).toMatchObject({ code: "platform_unavailable", httpStatus: 503 });
    assertNoSecrets(err, ["/auth/refresh?"]);
    expect(sessions.metadata(SESSION_A).signedIn).toBe(true);
    platform.state.refreshStatus = 200;
    expect((await sessions.resolve(SESSION_A)).identity.subject).toBe(USER_ID);

    // PAT sessions have no refresh token: they run until their exp hint passes, then sign out locally.
    const pat = platform.issuePat();
    await sessions.attachToken(SESSION_B, pat);
    advance(86_400_000 + 1_000);
    expect((await capture(sessions.resolve(SESSION_B))).code).toBe("signed_out");
    expect(sessions.metadata(SESSION_B).signedIn).toBe(false);
  });

  it("retries once through refresh when the platform rejects a still-unexpired token, then signs out if it is rejected again", async () => {
    const { platform, sessions, advance } = harness();
    await sessions.login(SESSION_A, { username: "poc-viewer", password: PASSWORD });
    const first = platform.latestAccessToken();
    platform.state.revoked.add(first); // access revoked, refresh still valid
    advance(CONTEXT_CACHE_MS + 1);
    const res = await sessions.resolve(SESSION_A, { requireWrite: true });
    expect(res.identity.subject).toBe(USER_ID);
    expect(platform.calls("/auth/refresh")).toHaveLength(1);

    platform.revokeAll();
    expect((await capture(sessions.resolve(SESSION_A, { requireWrite: true }))).code).toBe("signed_out");
    expect(sessions.metadata(SESSION_A).signedIn).toBe(false);
  });
});
