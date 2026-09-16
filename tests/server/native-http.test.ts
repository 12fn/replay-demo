import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type express from "express";
import { GameService } from "../../src/server/service";
import {DeterministicClient} from '../../src/inference/index';
import {mountLearningRoutes} from '../../src/server/learning-routes';
import {mountShowcaseRoutes} from '../../src/server/showcase-routes';
import { NativeSessionError, type NativeContext, type NativeIdentity, type NativeResolution, type NativeResolved, type NativeSessionMetadata, type ResolveOptions, type ScenarioRole } from "../../src/server/native-session.ts";
import { LoginRateLimiter, NativeConfigError, createApp, readAppConfig, type AppConfig, type KamiwazaConfig, type NativeSessionPort } from "../../src/server/native-http.ts";

console.debug = () => {};

const WORKROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const OTHER_WORKROOM = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const PASSWORD = "pw-SECRET-correct-horse";
const TOKEN_MARKER = "access-token-SECRET-never-serialized";

// ---------------------------------------------------------------------------
// Fake native session port: platform decisions are scripted per subject.
// ---------------------------------------------------------------------------

interface FakeUser {
  password: string;
  subject: string;
  name: string;
  nativeRole: string;
  canEdit: boolean;
  canRunAgents: boolean;
  canShare: boolean;
  interactionMode: string;
  accessState: string;
  revoked: boolean;
}

const ROLE_MAP: Record<string, ScenarioRole> = { owner: "instructor", editor: "commander", operator: "commander", viewer: "intelligence" };

class FakeNative implements NativeSessionPort {
  readonly workroomId = WORKROOM;
  readonly users = new Map<string, FakeUser>();
  readonly sessions = new Map<string, string>(); // sessionId -> username
  readonly resolveCalls: { sessionId: string; opts: ResolveOptions }[] = [];

  user(username: string, overrides: Partial<FakeUser> = {}): FakeUser {
    const u: FakeUser = { password: PASSWORD, subject: `sub-${username}`, name: `Native ${username}`, nativeRole: "editor", canEdit: true, canRunAgents: true, canShare:true, interactionMode: "write", accessState: "active", revoked: false, ...overrides };
    this.users.set(username, u);
    return u;
  }

  async login(sessionId: string, credentials: { username: string; password: string }): Promise<NativeResolution> {
    const u = this.users.get(credentials.username);
    if (!u || u.password !== credentials.password) throw new NativeSessionError("login_failed", 401, "native login rejected the credentials");
    this.sessions.set(sessionId, credentials.username);
    const r = await this.resolve(sessionId);
    return { identity: r.identity, context: r.context, nativeReceipts: r.nativeReceipts, metadata: r.metadata };
  }

  async acceptPlatformSession(sessionId:string, token:string):Promise<NativeResolution>{
    const username=token==='header.alice.signature'?'alice':token==='header.bob.signature'?'bob':null;
    if(!username||!this.users.has(username))throw new NativeSessionError('signed_out',401,'Platform rejected session');
    this.sessions.set(sessionId,username);return this.resolve(sessionId);
  }

  async resolve(sessionId: string, opts: ResolveOptions = {}): Promise<NativeResolved> {
    this.resolveCalls.push({ sessionId, opts });
    const username = this.sessions.get(sessionId);
    const u = username ? this.users.get(username) : undefined;
    if (!u) throw new NativeSessionError("signed_out", 401, "no native session; sign in to Kamiwaza");
    if (u.revoked) {
      this.sessions.delete(sessionId);
      throw new NativeSessionError("signed_out", 401, "native platform rejected the session token; signed out");
    }
    if (u.interactionMode === "blocked" || u.accessState === "archived") throw new NativeSessionError("access_blocked", 403, `native workroom access is ${u.accessState} (${u.interactionMode})`);
    const canEdit = u.canEdit && u.accessState === "active" && u.interactionMode !== "readonly";
    const canRunAgents = u.canRunAgents && canEdit;
    if (opts.requireWrite && !canEdit) throw new NativeSessionError("read_only", 403, "native workroom context does not permit writes (archival hold)");
    if (opts.requireAgents && !canRunAgents) throw new NativeSessionError("agents_blocked", 403, "native workroom context does not permit running agents");
    const mappedRole = ROLE_MAP[u.nativeRole] ?? "intelligence";
    const identity: NativeIdentity = { subject: u.subject, name: u.name, role: mappedRole, organization: "Decision Advantage Workroom", mode: "kamiwaza" };
    const context: NativeContext = {
      workroomId: WORKROOM,
      workroomName: "Decision Advantage Workroom",
      nativeRole: u.nativeRole,
      mappedRole,
      profileApplied: false,
      accessState: u.accessState,
      interactionMode: u.interactionMode,
      lifecycleState: "active",
      canEdit,
      canRunAgents,
      canShare: u.canShare,
      readOnlyReason: canEdit ? null : "archival hold",
      statusBanner: null,
      fresh: !!(opts.requireWrite || opts.requireAgents),
      validatedAt: "2026-09-13T12:00:00.000Z",
    };
    const platformClient = { token: TOKEN_MARKER, me: async () => ({ token: TOKEN_MARKER }) } as unknown as NativeResolved["platformClient"];
    return {
      identity,
      context,
      nativeReceipts: [{ clientRequestId: "c1", requestId: "r1", target: { method: "GET", path: `/workrooms/${WORKROOM}/runtime/context` }, status: 200, durationMs: 3, validatedAt: context.validatedAt, signatureTs: "1789280140" }],
      metadata: this.metadata(sessionId),
      platformClient,
    };
  }

  metadata(sessionId: string): NativeSessionMetadata {
    const username = this.sessions.get(sessionId);
    const u = username ? this.users.get(username) : undefined;
    if (!u) return { signedIn: false, subject: null, username: null, workroomId: WORKROOM, accessExpiresAt: null, refreshable: false, binding: null, createdAt: null };
    return { signedIn: true, subject: u.subject, username: username!, workroomId: WORKROOM, accessExpiresAt: null, refreshable: true, binding: "session", createdAt: "2026-09-13T12:00:00.000Z" };
  }

  readonly logoutPlatformCalls:string[]=[];
  async logoutPlatform(cookie:string){this.logoutPlatformCalls.push(cookie);return {sessionTerminationRequested:true};}

  logout(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// HTTP harness with a per-browser cookie jar
// ---------------------------------------------------------------------------

interface Browser {
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  cookie: string | null;
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function harness(overrides: Omit<Partial<KamiwazaConfig>, "mode"> & { mode?: "kamiwaza" | "local-demo"; mount?: (app: express.Express) => void; limiter?: LoginRateLimiter; mountInternal?: (app:express.Express)=>void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-native-http-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Public auth tests require only authored process content; no private build journal is read.
  const fixtureRoot = path.join(dir, 'synthetic-app-root');
  fs.mkdirSync(path.join(fixtureRoot, 'docs/stages'), {recursive:true});
  fs.mkdirSync(path.join(fixtureRoot, 'docs/process'), {recursive:true});
  fs.writeFileSync(path.join(fixtureRoot, 'docs/stages/status.json'), JSON.stringify({schema:'synthetic-process/1', stage:'unit-test'}));
  fs.writeFileSync(path.join(fixtureRoot, 'docs/process/BUILD-JOURNAL.md'), '# Synthetic test process journal\nNo private sessions or development history.\n');
  const service = new GameService(dir);
  cleanup.push(() => service.close());
  await service.init(false);
  const native = new FakeNative();
  const { mode, mount, limiter, mountInternal, ...configOverrides } = overrides;
  const config: AppConfig =
    mode === "local-demo"
      ? { mode: "local-demo", allowedOrigins: configOverrides.allowedOrigins ?? [], cookieSecure: false }
      : { mode: "kamiwaza", apiBase: "https://kamiwaza.example/api", workroomId: WORKROOM, forwardedHost: "kamiwaza.example", forwardedProto: "https", allowedOrigins: [], cookieSecure: false, allowLegacyRecordings: false, ...configOverrides };
  const app = createApp({ service, config, native: config.mode === "kamiwaza" ? native : null, root: fixtureRoot, mountInternal, mount:app=>{app.use('/api/learning',app.locals.guards.requireActive,(req,res,next)=>req.method==='GET'?next():app.locals.guards.requireWrite(req,res,next));mountLearningRoutes(app,service);mountShowcaseRoutes(app,service);mount?.(app);}, loginLimiter: limiter });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const browser = (): Browser => {
    const b: Browser = {
      cookie: null,
      async get(p, headers = {}) {
        const res = await fetch(base + p, { headers: { ...(b.cookie ? { cookie: b.cookie } : {}), ...headers } });
        return finish(res);
      },
      async post(p, body = {}, headers = {}) {
        const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(b.cookie ? { cookie: b.cookie } : {}), ...headers }, body: JSON.stringify(body) });
        return finish(res);
      },
    };
    const finish = async (res: Response) => {
      const set = res.headers.get("set-cookie");
      if (set) b.cookie = set.split(";")[0]!;
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status: res.status, body, headers: res.headers };
    };
    return b;
  };

  const signIn = async (username: string, overrides: Partial<FakeUser> = {}) => {
    native.user(username, overrides);
    const b = browser();
    await b.get("/api/native/status");
    const r = await b.post("/api/native/login", { username, password: PASSWORD });
    expect(r.status).toBe(200);
    // Like the client, load the overview once so the session points at an exercise inside this person's scope.
    const ov = await b.get("/api/overview");
    expect(ov.status, `overview after sign-in for ${username}`).toBe(200);
    return b;
  };

  return { service, native, app, config, base, browser, signIn, legacyId: service.store.exercises()[0]!.id };
}

const cookieId = (b: Browser) => b.cookie?.split("=")[1] ?? null;

it('projects organization context from the resolved native role, ignoring role and pack query spoofing',async()=>{
  const {signIn,native}=await harness();const b=await signIn('context-player');
  const before=await b.get('/api/overview?role=instructor&packId=crosscurrent-island-network');
  expect(before.status).toBe(200);expect(before.body.organizationContext.roleView.role).toBe('commander');
  expect(before.body.organizationContext.packId).toBe('crosscurrent-joint-coordination');
  native.users.get('context-player')!.nativeRole='viewer';native.users.get('context-player')!.canEdit=false;
  const after=await b.get('/api/overview?role=commander');
  expect(after.status).toBe(200);expect(after.body.organizationContext.roleView.role).toBe('intelligence');
  expect(after.body.organizationContext.authority).toBe('presentation-only');
  expect((await b.post('/api/commands',{intent:{type:'attack',targetID:null,troops:1}})).status).toBe(403);
});

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("selects native mode from REPLAY_AUTH_MODE or a complete API+workroom pair and never downgrades a partial native config", () => {
    expect(readAppConfig({}).mode).toBe("local-demo");
    const full = readAppConfig({ REPLAY_KAMIWAZA_API: "http://core-api.kamiwaza.svc:7777/api", REPLAY_WORKROOM_ID: WORKROOM, REPLAY_FORWARDED_HOST: "kamiwaza-harness.localhost", REPLAY_ALLOWED_ORIGINS: "http://127.0.0.1:5180" });
    expect(full).toMatchObject({ mode: "kamiwaza", workroomId: WORKROOM, forwardedProto: "https", cookieSecure: true, allowLegacyRecordings: false, allowedOrigins: ["http://127.0.0.1:5180"] });
    expect(() => readAppConfig({ REPLAY_AUTH_MODE: "kamiwaza" })).toThrow(NativeConfigError);
    expect(() => readAppConfig({ REPLAY_KAMIWAZA_API: "http://core-api.kamiwaza.svc:7777/api" })).toThrow(/both be set/);
    expect(() => readAppConfig({ REPLAY_WORKROOM_ID: WORKROOM })).toThrow(NativeConfigError);
    expect(() => readAppConfig({ REPLAY_AUTH_MODE: "kamiwaza", REPLAY_KAMIWAZA_API: "http://x/api", REPLAY_WORKROOM_ID: WORKROOM })).toThrow(/REPLAY_FORWARDED_HOST/);
    expect(() => readAppConfig({ REPLAY_AUTH_MODE: "kamiwaza", REPLAY_KAMIWAZA_API: "not a url", REPLAY_WORKROOM_ID: WORKROOM, REPLAY_FORWARDED_HOST: "h" })).toThrow(/absolute URL/);
    expect(() => readAppConfig({ REPLAY_AUTH_MODE: "local-demo", REPLAY_KAMIWAZA_API: "http://x/api", REPLAY_WORKROOM_ID: WORKROOM })).toThrow(/conflicts/);
    expect(() => readAppConfig({ REPLAY_AUTH_MODE: "something" })).toThrow(NativeConfigError);
    expect(() => readAppConfig({ REPLAY_ALLOWED_ORIGINS: "http://127.0.0.1:5180/app" })).toThrow(/scheme:\/\/host/);
  });
});

describe("native mode: sign-in and session", () => {
  it("denies every protected API without a native session, while status, health and login stay reachable", async () => {
    const { browser } = await harness();
    const b = browser();
    const health = await b.get("/health");
    expect(health.body).toMatchObject({ status: "ok", authMode: "kamiwaza", native: { configured: true, workroomId: WORKROOM }, nativeConnected: null });
    const ov = await b.get("/api/overview");
    expect(ov.status).toBe(401);
    expect(ov.body).toMatchObject({ code: "signed_out" });
    expect((await b.post("/api/exercises", {})).status).toBe(401);
    expect((await b.post("/api/commands", { side: "blue", intent: {}, idempotencyKey: "abcdefghij" })).status).toBe(401);
    expect((await b.post("/api/select", { exerciseId: "x" })).status).toBe(401);
    expect((await b.get("/api/record/x")).status).toBe(401);
    expect((await b.get("/api/process")).status).toBe(401);
    const status = await b.get("/api/native/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mode: "kamiwaza", signedIn: false, workroomId: WORKROOM, identity: null, denial: { code: "signed_out", httpStatus: 401 } });
    expect(b.cookie).toMatch(/^replay_session=[a-f0-9-]{36}$/);
  });

  it("logs in, rotates the opaque session id, never sends tokens to the browser, and invalidates the pre-login id", async () => {
    const { native, browser } = await harness();
    native.user("morgan");
    const b = browser();
    await b.get("/api/native/status");
    const before = cookieId(b)!;

    const bad = await b.post("/api/native/login", { username: "morgan", password: "pw-SECRET-wrong" });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ code: "login_failed" });
    expect(JSON.stringify(bad.body)).not.toContain("SECRET");
    expect(cookieId(b)).toBe(before);

    const ok = await b.post("/api/native/login", { username: "morgan", password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ signedIn: true, identity: { subject: "sub-morgan", role: "commander", mode: "kamiwaza" }, context: { workroomId: WORKROOM, nativeRole: "editor", canEdit: true } });
    expect(JSON.stringify(ok.body)).not.toContain("SECRET");
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict; Path=\//);
    const after = cookieId(b)!;
    expect(after).not.toBe(before);

    // The pre-login id is no longer a session anywhere.
    const stale = browser();
    stale.cookie = `replay_session=${before}`;
    expect((await stale.get("/api/overview")).status).toBe(401);

    const status = await b.get("/api/native/status");
    expect(status.body).toMatchObject({ signedIn: true, identity: { subject: "sub-morgan" }, metadata: { username: "morgan" }, denial: null });

    const out = await b.post("/api/native/logout");
    expect(out.body).toEqual({ signedIn: false });
    expect(cookieId(b)).not.toBe(after);
    expect((await b.get("/api/overview")).status).toBe(401);
    expect(native.sessions.size).toBe(0);
  });

  it("rejects the local persona selector and any browser-supplied role", async () => {
    const { signIn } = await harness();
    const b = await signIn("morgan");
    const r = await b.post("/api/session", { role: "instructor" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "role_switch_rejected" });
    const ov = await b.get("/api/overview");
    expect(ov.body.identity).toMatchObject({ subject: "sub-morgan", role: "commander", mode: "kamiwaza" });
  });

  it("limits repeated sign-in attempts per client", async () => {
    const { native, browser } = await harness({ limiter: new LoginRateLimiter(3, 60_000) });
    native.user("morgan");
    const b = browser();
    for (let i = 0; i < 3; i++) expect((await b.post("/api/native/login", { username: "morgan", password: "pw-SECRET-wrong" })).status).toBe(401);
    const limited = await b.post("/api/native/login", { username: "morgan", password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("keeps the platform client off the wire: res.locals.native serializes without it", async () => {
    let seen: { json: string; keys: string[]; hasClient: boolean } | null = null;
    const { signIn } = await harness({
      mount: (app) => {
        app.get("/api/probe", (_req, res) => {
          const n = res.locals.native;
          seen = { json: JSON.stringify(n), keys: Object.keys(n), hasClient: typeof n.platformClient?.me === "function" };
          res.json({ ok: true });
        });
      },
    });
    const b = await signIn("morgan");
    expect((await b.get("/api/probe")).status).toBe(200);
    expect(seen!.hasClient).toBe(true);
    expect(seen!.keys).not.toContain("platformClient");
    expect(seen!.json).not.toContain(TOKEN_MARKER);
    expect(seen!.json).toContain("sub-morgan");
  });
});

describe("cross-origin mutation policy", () => {
  it("rejects foreign origins and cross-site fetches, accepts same-host and explicitly allowed origins, and never blocks reads", async () => {
    const { signIn, base } = await harness({ allowedOrigins: ["http://127.0.0.1:5180"] });
    const b = await signIn("morgan");
    const evil = await b.post("/api/replay", { tick: null }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.body).toMatchObject({ code: "cross_origin" });
    const crossSite = await b.post("/api/replay", { tick: null }, { origin: base, "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).toMatchObject({ code: "cross_origin" });
    expect((await b.post("/api/replay", { tick: null }, { origin: "http://127.0.0.1:5180" })).status).toBe(200);
    expect((await b.post("/api/replay", { tick: null }, { origin: base })).status).toBe(200);
    expect((await b.get("/api/overview", { origin: "https://evil.example" })).status).toBe(200);
    // Login is a mutation too.
    const stranger = (await harness({ allowedOrigins: [] })).browser();
    expect((await stranger.post("/api/native/login", { username: "x", password: "y" }, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("exercise scope", () => {
  it("hides the unattributed legacy exercise, creates an owned exercise with persisted ownership, and blocks other subjects", async () => {
    const { service, signIn, legacyId } = await harness();
    const a = await signIn("alpha");
    const ov = await a.get("/api/overview");
    expect(ov.status).toBe(200);
    expect(ov.body.platform).toMatchObject({ mode: "kamiwaza", nativeConnected: true, native: { workroomId: WORKROOM, context: { nativeRole: "editor" } } });
    expect(ov.body.platform.native.receipts).toHaveLength(1);
    expect(ov.body.exercises.map((e: any) => e.id)).not.toContain(legacyId);
    expect(ov.body.exercises).toHaveLength(1);
    const own = ov.body.exercises[0];
    expect(own).toMatchObject({ id: ov.body.activeId, ownerSubject: "sub-alpha", attribution: "owned" });
    expect(service.store.exercise(own.id)!.options).toMatchObject({ ownerSubject: "sub-alpha", workroomId: WORKROOM, scenarioId: "crosscurrent", curriculumVersion: "0.1.0", assistance: "unknown" });
    // The legacy fixture was not silently assigned to the authenticated person.
    expect(service.store.exercise(legacyId)!.options.ownerSubject).toBeUndefined();
    expect(ov.body.dossier.priorAttempts.map((p: any) => p.id)).not.toContain(legacyId);

    // Explicit creation persists the same ownership.
    const created = await a.post("/api/exercises", { name: "Alpha second" });
    expect(created.status).toBe(201);
    expect(created.body.options).toMatchObject({ ownerSubject: "sub-alpha", workroomId: WORKROOM, scenarioId: "crosscurrent" });

    // Another commander in the same workroom sees none of alpha's rows and cannot reach them by id.
    const b = await signIn("bravo");
    const ovB = await b.get("/api/overview");
    expect(ovB.body.exercises.every((e: any) => e.ownerSubject === "sub-bravo")).toBe(true);
    expect((await b.post("/api/select", { exerciseId: own.id })).status).toBe(403);
    expect((await b.post("/api/select", { exerciseId: legacyId })).body).toMatchObject({ code: "exercise_forbidden" });
    expect((await b.get(`/api/record/${own.id}`)).status).toBe(403);
    expect((await b.get(`/api/record/${legacyId}`)).status).toBe(403);
    expect((await b.get("/api/record/does-not-exist")).status).toBe(404);
    const finish = await b.post(`/api/exercises/${own.id}/finish`);
    expect(finish.status).toBe(409);
    expect(service.store.exercise(own.id)!.status).toBe("running");

    // A row from another workroom is invisible even to an instructor.
    const foreign = await service.create("Foreign");
    foreign.options = { ...foreign.options, ownerSubject: "sub-alpha", workroomId: OTHER_WORKROOM };
    service.store.putExercise(foreign);
    const ovA = await a.get("/api/overview");
    expect(ovA.body.exercises.map((e: any) => e.id)).not.toContain(foreign.id);
    const inst = await signIn("chen", { nativeRole: "owner" });
    const ovI = await inst.get("/api/overview");
    const ids = ovI.body.exercises.map((e: any) => e.id);
    expect(ids).not.toContain(foreign.id);
    expect(ids).not.toContain(legacyId);
    expect(ids).toEqual(expect.arrayContaining([own.id, created.body.id]));
    expect(ovI.body.exercises.find((e: any) => e.id === own.id).attribution).toBe("workroom");
  });

  it("releases legacy unattributed recordings to instructors only with REPLAY_ALLOW_LEGACY_RECORDINGS and labels them", async () => {
    const { signIn, legacyId } = await harness({ allowLegacyRecordings: true });
    const commander = await signIn("alpha");
    expect((await commander.get("/api/overview")).body.exercises.map((e: any) => e.id)).not.toContain(legacyId);
    expect((await commander.get(`/api/record/${legacyId}`)).status).toBe(403);
    const inst = await signIn("chen", { nativeRole: "owner" });
    const ov = await inst.get("/api/overview");
    const legacy = ov.body.exercises.find((e: any) => e.id === legacyId);
    expect(legacy).toMatchObject({ attribution: "unattributed", ownerSubject: null });
    expect((await inst.post("/api/select", { exerciseId: legacyId })).status).toBe(200);
    expect((await inst.get(`/api/record/${legacyId}`)).status).toBe(200);
    expect((await inst.get("/api/overview")).body.activeId).toBe(legacyId);
  });

  it("fails closed when native access is revoked or the seat is downgraded", async () => {
    const { native, signIn, legacyId } = await harness({ allowLegacyRecordings: true });
    const inst = await signIn("chen", { nativeRole: "owner" });
    const own = (await inst.post("/api/exercises", { name: "Instructor own" })).body.id as string;
    expect((await inst.post("/api/select", { exerciseId: legacyId })).status).toBe(200);
    expect((await inst.get("/api/process")).status).toBe(200);

    // Operator downgrades the seat: the legacy recording drops out of scope, active exercise re-points to an owned row.
    native.users.get("chen")!.nativeRole = "viewer";
    const ov = await inst.get("/api/overview");
    expect(ov.status).toBe(200);
    expect(ov.body.identity.role).toBe("intelligence");
    expect(ov.body.activeId).toBe(own);
    expect((await inst.get(`/api/record/${legacyId}`)).status).toBe(403);
    expect((await inst.get("/api/process")).body).toMatchObject({ code: "role_required" });

    // Native revocation: every subsequent request is signed out, including a write that was fine a moment ago.
    native.users.get("chen")!.revoked = true;
    expect((await inst.post("/api/replay", { tick: null })).status).toBe(401);
    expect((await inst.get("/api/overview")).body).toMatchObject({ code: "signed_out" });
    expect((await inst.get("/api/native/status")).body).toMatchObject({ signedIn: false });
  });
});

describe("native permissions", () => {
  it('denies paid staff chat without native agent permission while preserving free provenance watches',async()=>{
    const {native,signIn,service}=await harness();const b=await signIn('chat-user',{canRunAgents:false});
    const client=new DeterministicClient({respond:()=>({text:'Synthetic answer',sourceIds:[]})});service.luna=client;
    const denied=await b.post('/api/staff',{message:'Explain available forces',side:'blue'});
    expect(denied.status).toBe(403);expect(client.history).toHaveLength(0);
    const watch=await b.post('/api/staff',{message:'Monitor source changes',side:'blue'});
    expect(watch.status).toBe(200);expect(watch.body.taskId).toBeDefined();expect(client.history).toHaveLength(0);
    native.users.get('chat-user')!.canRunAgents=true;native.resolveCalls.length=0;
    expect((await b.post('/api/staff',{message:'Explain available forces',side:'blue'})).body.text).toBe('Synthetic answer');
    expect(native.resolveCalls.filter(x=>x.opts.requireAgents)).toHaveLength(2);
  });

  it.each(['agent permission','session','opposing perspective'])('withholds the paid staff answer when %s is revoked during inference',async change=>{
    const {native,signIn,service}=await harness();const b=await signIn('chat-user',{nativeRole:'owner'});
    const active=(await b.get('/api/overview')).body.activeId;
    const client=new DeterministicClient({respond:()=>{
      const user=native.users.get('chat-user')!;
      if(change==='agent permission')user.canRunAgents=false;
      else if(change==='session')user.revoked=true;
      else user.nativeRole='editor';
      return {text:'Private synthetic answer that must not be delivered',sourceIds:[]};
    }});service.luna=client;
    const reply=await b.post('/api/staff',{message:'Explain the current reports',side:change==='opposing perspective'?'red':'blue'});
    expect(reply.status).toBe(403);expect(reply.body.receiptId).toBe('synthetic-0');
    expect(JSON.stringify(reply.body)).not.toContain('Private synthetic answer');expect(client.history).toHaveLength(1);
    const events=service.store.events(active);
    expect(events.some(e=>e.kind==='staff_result_discarded'&&e.details.receiptId==='synthetic-0')).toBe(true);
    expect(events.some(e=>e.kind==='staff_answer')).toBe(false);expect(JSON.stringify(events)).not.toContain('Private synthetic answer');
    expect(service.world(active).row.options.assistance).not.toBe('staff-assisted');
  });

  it("lets a read-only seat navigate, seek and select but not mutate; writes always resolve fresh", async () => {
    const { native, signIn, service } = await harness();
    const b = await signIn("alpha");
    const ov = await b.get("/api/overview");
    const first = ov.body.activeId;
    const second = (await b.post("/api/exercises", { name: "Second" })).body.id;

    // Workroom flips to read-only.
    Object.assign(native.users.get("alpha")!, { canEdit: false, canRunAgents: false, interactionMode: "readonly" });
    native.resolveCalls.length = 0;
    expect((await b.get("/api/overview")).status).toBe(200);
    expect((await b.post("/api/select", { exerciseId: first })).status).toBe(200);
    expect((await b.post("/api/replay", { tick: 1 })).body).toEqual({ playbackTick: 1 });
    expect((await b.post("/api/replay", { tick: null })).status).toBe(200);
    expect((await b.get(`/api/record/${second}`)).status).toBe(403);
    const released=service.world(second).row;released.status='completed';service.store.putExercise(released);
    expect((await b.get(`/api/record/${second}`)).status).toBe(200);
    for (const [p, body] of [
      ["/api/exercises", {}],
      ["/api/commands", { side: "blue", intent: { type: "attack", targetID: null, troops: 10 }, idempotencyKey: "readonly-order-1" }],
      ["/api/tasks", { title: "Watch", side: "blue" }],
      ["/api/staff", { message: "Monitor the reports", side: "blue" }],
      ["/api/branches", { tick: 1, side: "blue" }],
      ["/api/reports/inject", {}],
      [`/api/exercises/${first}/finish`, {}],
    ] as const) {
      const r = await b.post(p, body);
      expect(r.status, p).toBe(403);
      expect(r.body.code, p).toBe("read_only");
    }
    expect((await b.post("/api/agent", { enabled: true })).body).toMatchObject({ code: "read_only" });
    expect(native.resolveCalls.filter((c) => c.opts.requireWrite).length).toBe(8);
    expect(service.store.pending(first)).toHaveLength(0);
    expect(service.store.exercises().filter((e) => e.options?.ownerSubject === "sub-alpha")).toHaveLength(2);

    // Back to writable: the very next order is accepted with the fresh context.
    Object.assign(native.users.get("alpha")!, { canEdit: true, interactionMode: "write" });
    const w = service.world(first);
    for (let i = 0; i < 20; i++) service.tick(w);
    const order = await b.post("/api/commands", { side: "blue", intent: { type: "attack", targetID: null, troops: Math.floor(w.engine.player("blue").troops() * 0.2) }, idempotencyKey: "readonly-order-2" });
    expect(order.status).toBe(202);
    expect(service.store.pending(first)[0]).toMatchObject({ actor: "sub-alpha", side: "blue" });
  });

  it("gates the paid opponent on fresh native can_run_agents and the seat role", async () => {
    const { native, signIn, service } = await harness();
    const b = await signIn("alpha", { canRunAgents: false });
    const active = (await b.get("/api/overview")).body.activeId;
    native.resolveCalls.length = 0;
    const denied = await b.post("/api/agent", { enabled: true });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "agents_blocked" });
    expect(native.resolveCalls.at(-1)!.opts).toEqual({ requireWrite: true, requireAgents: true });
    expect(service.store.exercise(active)!.agentEnabled).toBe(false);

    native.users.get("alpha")!.canRunAgents = true;
    const enabled = await b.post("/api/agent", { enabled: true });
    expect(enabled.status).toBe(200);
    expect(service.store.exercise(active)!.agentEnabled).toBe(true);
    expect((await b.post("/api/agent", { enabled: false })).status).toBe(200);

    // A viewer seat with native agent permission still lacks the command role.
    const viewer = await signIn("victor", { nativeRole: "viewer", canEdit: true, canRunAgents: true });
    const role = await viewer.post("/api/agent", { enabled: true });
    expect(role.status).toBe(403);
    expect(role.body).toMatchObject({ code: "role_required" });
    expect((await viewer.post("/api/reports/inject")).body).toMatchObject({ code: "role_required" });
  });

  it("persists a bounded single pulse and rejects malformed settings without changing the controller", async () => {
    const { signIn, service } = await harness();
    const b = await signIn("alpha");
    const active = (await b.get("/api/overview")).body.activeId;
    expect((await b.post("/api/agent", { enabled: true, singlePulse: true })).status).toBe(200);
    expect(service.store.exercise(active)!.options.agentRunMode).toBe('single-pulse/1');
    expect((await b.post("/api/agent", { enabled: false, singlePulse: 'yes' })).status).toBe(400);
    expect(service.store.exercise(active)!.agentEnabled).toBe(true);
    expect(service.store.exercise(active)!.options.agentRunMode).toBe('single-pulse/1');
    expect((await b.post("/api/agent", { enabled: true })).status).toBe(200);
    expect(service.store.exercise(active)!.options.agentRunMode).toBeUndefined();
    expect((await b.post("/api/agent", { enabled: true, singlePulse: true })).status).toBe(200);
    expect((await b.post("/api/agent", { enabled: false })).status).toBe(200);
    expect(service.store.exercise(active)!.options.agentRunMode).toBeUndefined();
    expect(service.store.exercise(active)!.agentEnabled).toBe(false);
  });

  it("closes the live-seek loophole: opposing staff and opposing-side branches open only after completion or for the instructor", async () => {
    const { signIn, service } = await harness();
    const b = await signIn("alpha");
    const active = (await b.get("/api/overview")).body.activeId;
    const w = service.world(active);
    for (let i = 0; i < 20; i++) service.tick(w);
    expect((await b.post("/api/replay", { tick: 5 })).status).toBe(200);
    // Seeking during live play used to unlock the opposing side.
    const staff = await b.post("/api/staff", { message: "Monitor the opponent", side: "red" });
    expect(staff.status).toBe(403);
    expect(staff.body).toMatchObject({ code: "side_forbidden" });
    const branch = await b.post("/api/branches", { tick: 5, side: "red" });
    expect(branch.status).toBe(403);
    expect(branch.body).toMatchObject({ code: "side_forbidden" });
    expect(service.store.exercises().filter((e) => e.parentId === active)).toHaveLength(0);
    // Own-side branch works from the historical view and is owned by the branch creator with the parent's curriculum.
    const mine = await b.post("/api/branches", { tick: 5, side: "blue" });
    expect(mine.status).toBe(201);
    expect(mine.body.options).toMatchObject({ ownerSubject: "sub-alpha", workroomId: WORKROOM, scenarioId: "crosscurrent", curriculumVersion: "0.1.0", assistance: "unknown" });
    expect(service.store.exercise(active)!.options.ownerSubject).toBe("sub-alpha"); // parent options untouched

    // Completed: the opposing branch is released.
    expect((await b.post("/api/select", { exerciseId: active })).status).toBe(200);
    expect((await b.post(`/api/exercises/${active}/finish`)).status).toBe(200);
    const released = await b.post("/api/branches", { tick: 5, side: "red" });
    expect(released.status).toBe(201);
    expect(released.body.humanSide).toBe("red");

    // Instructor branching another person's exercise owns the branch; the original owner cannot see it.
    const inst = await signIn("chen", { nativeRole: "owner" });
    expect((await inst.post("/api/select", { exerciseId: active })).status).toBe(200);
    const theirs = await inst.post("/api/branches", { tick: 5, side: "red" });
    expect(theirs.status).toBe(201);
    expect(theirs.body.options).toMatchObject({ ownerSubject: "sub-chen", scenarioId: "crosscurrent", curriculumVersion: "0.1.0" });
    expect((await b.get("/api/overview")).body.exercises.map((e: any) => e.id)).not.toContain(theirs.body.id);
    expect((await b.post("/api/select", { exerciseId: theirs.body.id })).status).toBe(403);
    // Instructor staff watch on a running exercise's opposing side is allowed and creates no paid call.
    expect((await inst.post("/api/select", { exerciseId: theirs.body.id })).status).toBe(200);
    const watch = await inst.post("/api/staff", { message: "Monitor report provenance", side: "blue" });
    expect(watch.status).toBe(200);
    expect(watch.body.taskId).toBeDefined();
    expect(service.ledger.summary().requestsUsed).toBe(0);
  });

  it("blocks everything when the workroom interaction is blocked", async () => {
    const { native, signIn } = await harness();
    const b = await signIn("alpha");
    native.users.get("alpha")!.interactionMode = "blocked";
    const ov = await b.get("/api/overview");
    expect(ov.status).toBe(403);
    expect(ov.body).toMatchObject({ code: "access_blocked" });
    expect((await b.get("/api/native/status")).body).toMatchObject({ signedIn: true, identity: null, denial: { code: "access_blocked" } });
  });
});

describe('shared native exercise enrollment',()=>{
  it('wires native debrief authority through the actual route before inference and before cache delivery',async()=>{
    const {native,signIn,service}=await harness();const b=await signIn('debrief-owner'),id=(await b.get('/api/overview')).body.activeId,w=service.world(id);for(let n=0;n<25;n++)service.tick(w);
    await b.post('/api/commands',{side:'blue',idempotencyKey:'debrief-route-order',intent:{type:'attack',targetID:null,troops:10}});service.tick(w);const event=service.store.events(id).find(e=>e.kind==='command'&&e.actor==='sub-debrief-owner')!;await b.post(`/api/exercises/${id}/finish`);
    const user=native.users.get('debrief-owner')!;const client=new DeterministicClient({respond:()=>{user.canRunAgents=false;return {};}});service.luna=client;user.canRunAgents=false;
    expect((await b.post('/api/learning/debrief',{eventId:event.id})).status).toBe(403);expect(client.history).toHaveLength(0);user.canRunAgents=true;
    const denied=await b.post('/api/learning/debrief',{eventId:event.id});expect(denied.status).toBe(403);expect(denied.body.receiptId).toBe('synthetic-0');expect(client.history).toHaveLength(1);expect(service.store.events(id).some(e=>e.kind==='debrief_generated')).toBe(false);
  });
  it('keeps enrollment history but refuses access when native workroom membership is revoked',async()=>{
    const {native,signIn,service}=await harness();const owner=await signIn('revocation-owner'),other=await signIn('revocation-member');
    const id=(await owner.get('/api/overview')).body.activeId,code=(await owner.post('/api/team/code')).body.code;
    expect((await other.post('/api/team/join',{code})).status).toBe(200);
    native.users.get('revocation-member')!.interactionMode='blocked';
    expect((await other.get('/api/team')).status).toBe(403);expect((await other.get('/api/learning/dossier')).status).toBe(403);
    expect(service.teams.includes(service.world(id).row,'sub-revocation-member')).toBe(true);
  });
  it('joins commander and intelligence subjects to the same clock while keeping role authority and personal history separate',async()=>{
    const {signIn,service}=await harness();
    const commander=await signIn('team-commander');const original=(await commander.get('/api/overview')).body;
    const id=original.activeId,w=service.world(id);
    for(let n=0;n<20;n++)service.tick(w);
    const unrelated=(await commander.post('/api/exercises',{name:'Commander private history'})).body.id;
    await commander.post('/api/select',{exerciseId:id});
    const analyst=await signIn('team-analyst',{nativeRole:'viewer',canEdit:true,canRunAgents:true});
    expect((await analyst.post('/api/select',{exerciseId:id})).status).toBe(403);
    const code=(await commander.post('/api/team/code')).body.code;
    const fingerprint=w.engine.state().fingerprint;
    expect((await analyst.post('/api/team/join',{code,role:'instructor',side:'red'})).status).toBe(200);
    const intel=(await analyst.get('/api/overview')).body;
    expect(intel.activeId).toBe(id);expect(intel.state.tick).toBe(w.engine.game.ticks());expect(intel.selectedSide).toBe('blue');expect(intel.identity.role).toBe('intelligence');
    expect(intel.exercises.find((e:any)=>e.id===id).attribution).toBe('shared');
    expect(intel.exercises.some((e:any)=>e.id===unrelated)).toBe(false);
    expect((await analyst.post('/api/commands',{side:'blue',idempotencyKey:'analyst-no-command',intent:{type:'attack',targetID:null,troops:10}})).status).toBe(403);
    expect((await analyst.post('/api/team/code')).status).toBe(403);
    const report=intel.reports.find((r:any)=>r.side==='blue');
    const assessment=await analyst.post('/api/learning/assessment',{text:'The current estimate is an observation at tick1, not a permanent fact.',sourceIds:[report.id]});
    expect(assessment.status).toBe(201);
    const c=await commander.post('/api/commands',{side:'blue',idempotencyKey:'shared-commander-order',intent:{type:'attack',targetID:null,troops:10}});
    expect(c.status).toBe(202);service.tick(w);
    const intelDossier=(await analyst.get('/api/learning/dossier')).body;
    const commanderDossier=(await commander.get('/api/learning/dossier')).body;
    expect(intelDossier.attributed).toBe(true);expect(intelDossier.dossier.current.counts.assessmentsLogged).toBe(1);expect(intelDossier.dossier.current.counts.humanCommands).toBe(0);
    expect(intelDossier.dossier.current.counts.reportsReleased).toBe(0); // no penalty for releases before enrollment
    expect(commanderDossier.dossier.current.counts.humanCommands).toBe(1);expect(commanderDossier.dossier.current.counts.assessmentsLogged).toBe(0);
    expect(JSON.stringify(intelDossier)).not.toContain(unrelated);
    expect(service.record(id).fingerprints[21]).toBe(fingerprint);expect(w.row.options.ownerSubject).toBe('sub-team-commander');
  });

  it('requires native sharing permission, rejects codes from another workroom, revokes enrollment and keeps branches private',async()=>{
    const {native,signIn,service}=await harness();const owner=await signIn('owner'),other=await signIn('other');
    const id=(await owner.get('/api/overview')).body.activeId,w=service.world(id);for(let n=0;n<20;n++)service.tick(w);
    native.users.get('owner')!.canShare=false;expect((await owner.post('/api/team/code')).status).toBe(403);native.users.get('owner')!.canShare=true;
    const code=(await owner.post('/api/team/code')).body.code;
    expect((await other.post('/api/team/join',{code})).status).toBe(200);
    const branch=(await owner.post('/api/branches',{tick:21,side:'blue'})).body;
    expect((await other.post('/api/select',{exerciseId:branch.id})).status).toBe(403);
    await owner.post('/api/select',{exerciseId:id});
    expect((await owner.post('/api/team/remove',{subject:'sub-owner'})).status).toBe(409);
    expect((await owner.post('/api/team/remove',{subject:'sub-other'})).status).toBe(200);
    expect((await other.post('/api/select',{exerciseId:id})).status).toBe(403);
    expect((await other.post('/api/team/join',{code})).status).toBe(404);
    const roster=(await owner.get('/api/team')).body.participants;
    expect(roster.find((p:any)=>p.subject==='sub-other').active).toBe(false);
    expect(service.store.events(id).some(e=>e.kind==='participant_joined'&&e.actor==='sub-other')).toBe(true);
    const foreign=await service.create('Foreign','plains');foreign.options.workroomId=OTHER_WORKROOM;foreign.options.ownerSubject='foreign-owner';service.store.putExercise(foreign);
    const foreignCode=service.teams.issueCode(foreign,'foreign-owner').code;
    expect((await other.post('/api/team/join',{code:foreignCode})).status).toBe(404);
    expect(service.teams.includes(foreign,'sub-other')).toBe(false);
  });
});

describe('native scenario selection',()=>{
  it('creates only declared scenarios and preserves their learning identity under native ownership',async()=>{
    const {signIn,service,native,browser}=await harness();const b=await signIn('scenario-commander');
    const created=await b.post('/api/exercises',{name:'Synthetic scenario qualification',scenarioId:'crosscurrent-crossing/1'});
    expect(created.status).toBe(201);expect(created.body.options).toMatchObject({map:'world-500',scenarioId:'crosscurrent-crossing/1',ownerSubject:'sub-scenario-commander',workroomId:WORKROOM,scenario:{controller:'maneuver/1',victory:'last-side-standing/1'}});
    expect(created.body.agentEnabled).toBe(false);
    const objectives=await b.post('/api/exercises',{name:'Objective scenario route regression',scenarioId:'crosscurrent-objectives/1'});
    expect(objectives.status).toBe(201);expect(objectives.body.options).toMatchObject({scenarioId:'crosscurrent-objectives/1',assistance:'unknown',scenario:{controller:'objectives/1',victory:'network-score/1'}});
    const count=service.store.exercises().length;
    for(const input of [{scenarioId:'not-a-scenario'},{scenarioId:'crosscurrent-classic/1',map:'world-2000'},{controller:'anything'},{scenarioId:'crosscurrent-maneuver/1',victory:'immortal'}])expect((await b.post('/api/exercises',input)).status).toBe(400);
    expect(service.store.exercises()).toHaveLength(count);
    const ov=(await b.get('/api/overview')).body;expect(ov.exercises.find((e:any)=>e.id===created.body.id).options.scenario).toEqual(created.body.options.scenario);
    native.user('scenario-readonly',{nativeRole:'viewer',canEdit:false});const readonly=browser();expect((await readonly.post('/api/native/login',{username:'scenario-readonly',password:PASSWORD})).status).toBe(200);expect((await readonly.post('/api/exercises',{scenarioId:'crosscurrent-crossing/1'})).status).toBe(403);
  });

});

describe("local-demo mode", () => {
  it("keeps the labelled local persona flow and reports native sign-in as unavailable", async () => {
    const { browser, service } = await harness({ mode: "local-demo" });
    const b = browser();
    const health = await b.get("/health");
    expect(health.body).toMatchObject({ authMode: "local-demo", native: { configured: false } });
    const ov = await b.get("/api/overview");
    expect(ov.status).toBe(200);
    expect(ov.body.identity).toMatchObject({ mode: "local-demo", role: "commander" });
    expect(ov.body.platform).toMatchObject({ mode: "local-demo", nativeConnected: false });
    expect(ov.body.exercises[0]).toMatchObject({ attribution: "unattributed" });
    expect((await b.post("/api/session", { role: "instructor" })).body.identity.role).toBe("instructor");
    expect((await b.get("/api/overview")).body.identity.role).toBe("instructor");
    expect((await b.get("/api/process")).status).toBe(200);
    expect((await b.get("/api/native/status")).body).toMatchObject({ mode: "local-demo", signedIn: false });
    expect((await b.post("/api/native/login", { username: "x", password: "y" })).body).toMatchObject({ code: "native_disabled" });
    const created = await b.post("/api/exercises", { name: "Local" });
    expect(created.status).toBe(201);
    expect(service.store.exercise(created.body.id)!.options).toMatchObject({ ownerSubject: "demo-instructor", workroomId: null, scenarioId: "crosscurrent" });
    // The staff/branch loophole is closed here too.
    const w = service.world(created.body.id);
    for (let i = 0; i < 20; i++) service.tick(w);
    await b.post("/api/session", { role: "commander" });
    expect((await b.post("/api/replay", { tick: 5 })).status).toBe(200);
    expect((await b.post("/api/staff", { message: "Monitor the opponent", side: "red" })).status).toBe(403);
    expect((await b.post("/api/branches", { tick: 5, side: "red" })).status).toBe(403);
  });
});


it('prepares a durable versioned showcase through fresh native authority without inference and blocks revoked reads/writes',async()=>{
 const {service,native,browser,signIn}=await harness();const anonymous=browser();expect((await anonymous.get('/api/showcase')).status).toBe(401);
 const b=await signIn('showcase-presenter'),budget=service.ledger.summary();
 const initial=await b.get('/api/showcase');expect(initial.status).toBe(200);expect(initial.headers.get('cache-control')).toBe('private, no-store');expect(initial.body.prepared).toBeNull();expect(initial.body.recordedAnalysis.record.references).toHaveLength(28);expect(initial.body.recordedAnalysis.provenance.newModelCalls).toBe(0);expect(initial.body.recordedAnalysis.record.receipt.id).toBe('377d48a7-fc68-4bf8-9d72-a6eb1e795047');
 const created=await b.post('/api/showcase/prepare');expect(created.status).toBe(201);expect(created.body.duplicate).toBe(false);
 expect((await b.post('/api/showcase/prepare')).body).toMatchObject({exerciseId:created.body.exerciseId,duplicate:true});
 await service.branch(created.body.exerciseId,created.body.forkTick,'blue',{subject:'sub-showcase-presenter',name:'Native showcase-presenter',role:'commander',organization:'Test',mode:'kamiwaza'});
 expect((await b.get('/api/showcase')).body.prepared.exerciseId).toBe(created.body.exerciseId);expect(service.store.exercise(created.body.exerciseId)?.options.workroomId).toBe(WORKROOM);
 const second=await signIn('showcase-other');expect((await second.get('/api/showcase')).body.prepared).toBeNull();
 native.users.get('showcase-presenter')!.canEdit=false;expect((await b.post('/api/showcase/prepare')).status).toBe(403);expect((await b.get('/api/showcase')).status).toBe(200);
 native.users.get('showcase-presenter')!.revoked=true;expect((await b.get('/api/showcase')).status).toBe(401);expect(service.ledger.summary()).toEqual(budget);
});


describe('native platform cookie handoff',()=>{
 it('rotates the app session, uses verified identity, and rejects missing/changed cookies on protected routes',async()=>{
  const {browser,native}=await harness({platformSso:true,cookieSecure:true});native.user('alice',{nativeRole:'owner'});native.user('bob',{nativeRole:'viewer'});const b=browser();await b.get('/api/native/status');const old=b.cookie;
  const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});
  const status=await b.get('/api/native/status',header());expect(status.body).toMatchObject({signedIn:true,platformSso:true,identity:{subject:'sub-alice',role:'instructor'}});expect(b.cookie).not.toBe(old);expect(status.headers.get('set-cookie')).toContain('Secure');expect(JSON.stringify(status.body)).not.toContain('header.alice.signature');
  expect((await b.get('/api/overview',header())).status).toBe(200);
  expect((await b.get('/api/overview')).status).toBe(401);
  expect((await b.get('/api/overview',{cookie:b.cookie+'; access_token=header.bob.signature'})).status).toBe(401);
  expect((await b.get('/api/native/status',{cookie:b.cookie+'; access_token=header.bob.signature'})).body.identity.subject).toBe('sub-bob');
 });
 it('does not trust duplicate or forged cookies and retains platform revocation',async()=>{
  const {browser,native}=await harness({platformSso:true,cookieSecure:true});const user=native.user('alice');const b=browser();
  for(const cookie of ['access_token=header.alice.signature; access_token=header.bob.signature','access_token=header.forged.signature'])expect((await b.get('/api/native/status',{cookie})).body.signedIn).toBe(false);
  const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});expect((await b.get('/api/native/status',header())).body.signedIn).toBe(true);user.revoked=true;expect((await b.get('/api/overview',header())).status).toBe(401);
 });
 it('logout remains signed out until explicit platform continuation and rejects app passwords in SSO mode',async()=>{
  const {browser,native}=await harness({platformSso:true,cookieSecure:true});native.user('alice');const b=browser();const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});
  await b.get('/api/native/status',header());expect((await b.post('/api/native/logout',{},header())).status).toBe(200);expect((await b.get('/api/native/status',header())).body.signedIn).toBe(false);expect((await b.get('/api/overview',header())).status).toBe(401);
  expect((await b.post('/api/native/platform-session',{},header())).body.signedIn).toBe(true);expect((await b.post('/api/native/login',{username:'alice',password:PASSWORD},header())).status).toBe(409);
 });
 it('requires secure cookies and rejects cross-origin continuation',async()=>{
  await expect(harness({platformSso:true,cookieSecure:false})).rejects.toThrow('secure cookies');const {browser,native}=await harness({platformSso:true,cookieSecure:true});native.user('alice');const b=browser();expect((await b.post('/api/native/platform-session',{}, {cookie:'access_token=header.alice.signature',origin:'https://attacker.example'})).status).toBe(403);
 });
 it('uses only the configured HTTPS app origin for the App Garden launch',async()=>{
  const {base}=await harness({publicOrigin:'https://replay.kamiwaza.local'});
  const response=await fetch(base+'/runtime/apps/replay?redirect=https://attacker.example',{redirect:'manual'});expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('https://replay.kamiwaza.local/');
  expect(()=>readAppConfig({REPLAY_PUBLIC_ORIGIN:'https://attacker.example'})).toThrow('REPLAY_ALLOWED_ORIGINS');
 });
});

it('binds early-mounted Tomo browser routes to the current platform session as well',async()=>{
 const {browser,native}=await harness({platformSso:true,cookieSecure:true,mountInternal:app=>{app.get('/runtime/apps/replay-tomo/probe',(_req,res)=>res.json({ok:true}));}});native.user('alice');const b=browser();const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});await b.get('/api/native/status',header());expect((await b.get('/runtime/apps/replay-tomo/probe',header())).status).toBe(200);expect((await b.get('/runtime/apps/replay-tomo/probe')).status).toBe(401);expect((await b.get('/runtime/apps/replay-tomo/probe',{cookie:b.cookie+'; access_token=header.bob.signature'})).status).toBe(401);
});

describe('native account switch',()=>{
 const setup=()=>harness({platformSso:true,cookieSecure:true,loginOrigin:'https://public.example',allowedOrigins:['https://public.example'],mountInternal:app=>{app.get('/runtime/apps/replay-tomo/probe',(_req,res)=>res.json({ok:true}));}});
 it('clears both browser sessions, refuses the old still-native-valid token everywhere, and admits a newly verified identity',async()=>{
  const {browser,native,service,config}=await setup();native.user('alice');native.user('bob',{nativeRole:'viewer'});const b=browser();const oldHeader=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});
  await b.get('/api/native/status',oldHeader());await b.get('/api/overview',oldHeader());const prior=b.cookie;const out=await b.post('/api/native/switch-user',{},oldHeader());
  expect(out.status).toBe(200);expect(out.body).toEqual({signedIn:false,replayTokenBlocked:true,platformCookiesCleared:true,nativeSessionTerminationRequested:true,loginUrl:'https://public.example/login?redirect=%2Fruntime%2Fapps%2Freplay'});expect(b.cookie).not.toBe(prior);expect(native.users.get('alice')!.revoked).toBe(false);
  const cookies=out.headers.getSetCookie();expect(cookies).toHaveLength(9);for(const name of ['access_token','access_token_refresh','access_token_refresh_ts','access_token_id'])expect(cookies.filter(c=>c.startsWith(name+'=')&&c.includes('Max-Age=0'))).toHaveLength(2);
  expect((await b.get('/api/native/status',oldHeader())).body).toMatchObject({signedIn:false,platformSessionAvailable:false,denial:{httpStatus:401}});
  expect((await b.get('/api/overview',oldHeader())).status).toBe(401);expect((await b.post('/api/native/platform-session',{},oldHeader())).status).toBe(401);expect((await b.get('/runtime/apps/replay-tomo/probe',oldHeader())).status).toBe(401);
  // A fresh HTTP application reconstructs its guard from the durable store; the unit suite also reopens the SQLite file.
  const restarted=createApp({service,config,native});const server=restarted.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));cleanup.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;const replay=await fetch(base+'/api/native/status',{headers:{cookie:prior+'; access_token=header.alice.signature'}});expect((await replay.json() as any).denial.httpStatus).toBe(401);
  const changed=await b.get('/api/native/status',{cookie:b.cookie+'; access_token=header.bob.signature'});expect(changed.body).toMatchObject({signedIn:true,identity:{subject:'sub-bob',role:'intelligence'}});expect((await b.get('/api/overview',{cookie:b.cookie+'; access_token=header.bob.signature'})).status).toBe(200);
 });
 it('stays signed out on native failure, clears native cookies, and does not convert a retry into success',async()=>{
  const {browser,native}=await setup();native.user('alice');native.logoutPlatform=async cookie=>({sessionTerminationRequested:false});const b=browser();const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});await b.get('/api/native/status',header());
  const out=await b.post('/api/native/switch-user',{},header());expect(out.status).toBe(502);expect(out.body).toMatchObject({signedIn:false,replayTokenBlocked:true,platformCookiesCleared:true,nativeSessionTerminationRequested:false});expect(out.headers.getSetCookie()).toHaveLength(9);expect((await b.get('/api/overview',header())).status).toBe(401);expect((await b.get('/api/native/status',header())).body.signedIn).toBe(false);expect((await b.post('/api/native/switch-user')).body.nativeSessionTerminationRequested).toBe(false);
 });
 it('rejects cross-origin and caller-controlled identity/redirect before sign-out or native network work',async()=>{
  const {browser,native}=await setup();native.user('alice');const b=browser();const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});await b.get('/api/native/status',header());const before=b.cookie;
  expect((await b.post('/api/native/switch-user',{}, {...header(),origin:'https://attacker.example'})).status).toBe(403);expect((await b.post('/api/native/switch-user',{redirect:'https://attacker.example',identity:'owner'},header())).status).toBe(400);expect(native.logoutPlatformCalls).toHaveLength(0);expect(b.cookie).toBe(before);expect((await b.get('/api/overview',header())).status).toBe(200);
 });
 it('fails closed if the persistent refusal write fails, without making the native network call',async()=>{
  const {browser,native,service}=await setup();native.user('alice');const b=browser();const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});await b.get('/api/native/status',header());
  service.store.db.exec("CREATE TRIGGER fail_refusal BEFORE INSERT ON native_switched_tokens BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  const out=await b.post('/api/native/switch-user',{},header());expect(out.status).toBe(503);expect(native.logoutPlatformCalls).toHaveLength(0);expect(out.headers.getSetCookie()).toHaveLength(9);expect((await b.get('/api/overview',header())).status).toBe(503);expect((await b.get('/runtime/apps/replay-tomo/probe',header())).status).toBe(503);
 });
 it('rejects more than the revocation capacity of forged tokens without consuming refusal storage or the legitimate login quota',async()=>{
  const {browser,native,service}=await setup();native.user('alice');const attacker=browser();
  for(let i=0;i<10_001;i++){
   const out=await attacker.post('/api/native/switch-user',{}, {cookie:(attacker.cookie??'')+'; access_token=header.forged'+i+'.signature'});
   expect(out.status).toBe(401);expect(out.body).toMatchObject({signedIn:false,replayTokenBlocked:false,platformCookiesCleared:true,nativeSessionTerminationRequested:false});
  }
  expect(service.store.db.prepare('SELECT COUNT(*) n FROM native_switched_tokens').get()).toEqual({n:0});expect(native.logoutPlatformCalls).toHaveLength(0);expect(native.resolveCalls).toHaveLength(0);
  const legitimate=browser();const status=await legitimate.get('/api/native/status',{cookie:'access_token=header.alice.signature'});expect(status.body).toMatchObject({signedIn:true,identity:{subject:'sub-alice'}});expect((await legitimate.get('/api/overview',{cookie:legitimate.cookie+'; access_token=header.alice.signature'})).status).toBe(200);
 },60_000);
 it('does not add rows or request native termination when no token or only an unbound real native token is supplied',async()=>{
  const {browser,native,service}=await setup();native.user('alice');const b=browser();
  for(let i=0;i<20;i++){const out=await b.post('/api/native/switch-user');expect(out.status).toBe(401);expect(out.body.replayTokenBlocked).toBe(false);}
  expect((await b.post('/api/native/switch-user',{}, {cookie:b.cookie+'; access_token=header.alice.signature'})).status).toBe(401);
  expect(service.store.db.prepare('SELECT COUNT(*) n FROM native_switched_tokens').get()).toEqual({n:0});expect(native.logoutPlatformCalls).toHaveLength(0);
 });
 it.each(['expired','blocked'])('allows a proven bound token to sign out from a %s app gate without reauthorizing protected content',async reason=>{
  const {browser,native,service}=await setup();const user=native.user('alice');const b=browser();const header=()=>({cookie:b.cookie+'; access_token=header.alice.signature'});await b.get('/api/native/status',header());
  if(reason==='expired')native.sessions.clear();else user.interactionMode='blocked';
  expect((await b.get('/api/overview',header())).status).toBe(reason==='expired'?401:403);const resolveCount=native.resolveCalls.length;
  let called=false;native.logoutPlatform=async()=>{called=true;expect(service.store.db.prepare('SELECT COUNT(*) n FROM native_switched_tokens').get()).toEqual({n:1});return {sessionTerminationRequested:true};};
  const result=await b.post('/api/native/switch-user',{},header());expect(result.status).toBe(200);expect(result.body.replayTokenBlocked).toBe(true);expect(called).toBe(true);expect(native.resolveCalls).toHaveLength(resolveCount);
 });
 it('rejects a pending handoff that finishes after the exact token was switched out',async()=>{
  const {browser,native}=await setup();native.user('alice');const other=browser();await other.get('/api/native/status',{cookie:'access_token=header.alice.signature'});const original=native.acceptPlatformSession.bind(native);let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  native.acceptPlatformSession=async(id,token)=>{const result=await original(id,token);entered();await waiting;return result;};const b=browser();const pending=b.get('/api/native/status',{cookie:'access_token=header.alice.signature'});await started;
  expect((await other.post('/api/native/switch-user',{}, {cookie:other.cookie+'; access_token=header.alice.signature'})).status).toBe(200);release();expect((await pending).body.signedIn).toBe(false);expect(native.sessions.size).toBe(0);
 });
});
