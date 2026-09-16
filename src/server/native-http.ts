import {SCENARIOS} from '../scenarios/catalog';
/**
 * REPLAY HTTP application factory with native Kamiwaza session integration.
 *
 * `createApp` builds the Express app without listening so that tests and the
 * entrypoint share one wiring. Two authentication modes exist and are never
 * mixed:
 *
 *  - `local-demo`: the original persona selector. Identity is a labelled demo
 *    persona kept in the local session store.
 *  - `kamiwaza`: identity comes only from `NativeSessions.resolve()` on every
 *    protected request. The browser holds one opaque, HttpOnly session id; platform cookies remain HttpOnly; app JavaScript never sees their tokens. The id is rotated after login and logout.
 *
 * Native mode is selected by `REPLAY_AUTH_MODE=kamiwaza` or by providing both
 * `REPLAY_KAMIWAZA_API` and `REPLAY_WORKROOM_ID`. A partial or invalid native
 * configuration is a startup error, never a silent fall back to local-demo.
 *
 * Authorization vocabulary used below:
 *  - session navigation (select, seek): needs a valid native session only.
 *  - world mutation (create, orders, tasks, staff, branch, finish, inject):
 *    needs a fresh native context with `can_edit`.
 *  - agent control: needs a fresh native context with `can_run_agents`.
 *
 * Exercise scope in native mode is enforced server side from persisted row
 * options (`ownerSubject`, `workroomId`); see `ExerciseScope`.
 *
 * Request bodies are never logged by this module.
 */
import express from "express";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RequestReceipt } from "../platform/index.ts";
import { NativeSessionError, type NativeContext, type NativeIdentity, type NativeResolution, type NativeResolved, type NativeSessionMetadata, type ResolveOptions } from "./native-session.ts";
import {ServiceError, type GameService, type Identity, type Session} from "./service.ts";
import type { ExerciseRow } from "./store.ts";
import {TeamError} from './exercise-teams';
import {nativeCookieExpirations,type PlatformLogoutResult} from './native-platform-logout';
import {NativeTokenRevocations} from './native-token-revocations';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LocalConfig {
  mode: "local-demo";
  allowedOrigins: string[];
  cookieSecure: boolean;
  publicOrigin?: string;
}

export interface KamiwazaConfig {
  mode: "kamiwaza";
  apiBase: string;
  validationApiBase?:string;
  platformSso?:boolean;
  /** Browser-facing native login origin; independent of the signed ForwardAuth host. */
  loginOrigin?:string;
  workroomId: string;
  forwardedHost: string;
  forwardedProto: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  publicOrigin?: string;
  /** Instructors may read local recordings that carry no workroom/owner. Off by default. */
  allowLegacyRecordings: boolean;
}

export type AppConfig = LocalConfig | KamiwazaConfig;

export class NativeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeConfigError";
  }
}

/**
 * Read the authentication configuration from environment variables. Throws
 * `NativeConfigError` when native mode is requested or implied but incomplete,
 * so that a misconfigured deployment cannot start as a local demo.
 */
export function readAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.REPLAY_AUTH_MODE ?? "").trim().toLowerCase();
  const apiBase = (env.REPLAY_KAMIWAZA_API ?? "").trim();
  const workroomId = (env.REPLAY_WORKROOM_ID ?? "").trim();
  const allowedOrigins = parseOrigins(env.REPLAY_ALLOWED_ORIGINS);
  const publicOrigin=env.REPLAY_PUBLIC_ORIGIN?.trim()||undefined;
  const loginOrigin=env.REPLAY_LOGIN_ORIGIN?.trim()||undefined;
  if(loginOrigin)validatedLoginOrigin(loginOrigin,allowedOrigins);
  if(publicOrigin){
    let u:URL;try{u=new URL(publicOrigin);}catch{throw new NativeConfigError('REPLAY_PUBLIC_ORIGIN must be an HTTPS origin');}
    if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new NativeConfigError('REPLAY_PUBLIC_ORIGIN must be an HTTPS origin');
    if(!allowedOrigins.includes(u.origin.toLowerCase()))throw new NativeConfigError('REPLAY_PUBLIC_ORIGIN must be included in REPLAY_ALLOWED_ORIGINS');
  }
  const wantsNative = mode === "kamiwaza" || (apiBase.length > 0 && workroomId.length > 0);
  const partial = !wantsNative && (apiBase.length > 0 || workroomId.length > 0);
  if (mode && mode !== "kamiwaza" && mode !== "local-demo" && mode !== "local") {
    throw new NativeConfigError(`REPLAY_AUTH_MODE must be "kamiwaza" or "local-demo" (got "${mode}")`);
  }
  if (partial) {
    throw new NativeConfigError("REPLAY_KAMIWAZA_API and REPLAY_WORKROOM_ID must both be set for native mode; refusing to start as local-demo with a partial native configuration");
  }
  if (!wantsNative) {
    if(loginOrigin)throw new NativeConfigError('REPLAY_LOGIN_ORIGIN requires native authentication');
    return { mode: "local-demo", allowedOrigins, publicOrigin, cookieSecure: parseBool(env.REPLAY_COOKIE_SECURE, false) };
  }
  if (mode === "local-demo" || mode === "local") {
    throw new NativeConfigError("REPLAY_AUTH_MODE=local-demo conflicts with REPLAY_KAMIWAZA_API/REPLAY_WORKROOM_ID; remove one side to make the intent explicit");
  }
  if (!apiBase) throw new NativeConfigError("REPLAY_AUTH_MODE=kamiwaza requires REPLAY_KAMIWAZA_API");
  if (!workroomId) throw new NativeConfigError("REPLAY_AUTH_MODE=kamiwaza requires REPLAY_WORKROOM_ID");
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new NativeConfigError("REPLAY_KAMIWAZA_API must be an absolute URL ending in /api");
  }
  if (!/\/api\/?$/.test(url.pathname)) throw new NativeConfigError("REPLAY_KAMIWAZA_API must be an absolute URL ending in /api");
  if (!/^[A-Za-z0-9._~-]{8,128}$/.test(workroomId)) throw new NativeConfigError("REPLAY_WORKROOM_ID is not a plausible workroom identifier");
  const forwardedHost = (env.REPLAY_FORWARDED_HOST ?? "").trim();
  if (!forwardedHost) throw new NativeConfigError("REPLAY_FORWARDED_HOST (public platform host used for ForwardAuth) is required in native mode");
  const forwardedProto = (env.REPLAY_FORWARDED_PROTO ?? "https").trim().toLowerCase();
  if (forwardedProto !== "https" && forwardedProto !== "http") throw new NativeConfigError("REPLAY_FORWARDED_PROTO must be https or http");
  return {
    mode: "kamiwaza",
    publicOrigin,
    loginOrigin:loginOrigin?new URL(loginOrigin).origin:undefined,
    apiBase: apiBase.replace(/\/+$/, ""),
    validationApiBase:env.REPLAY_KAMIWAZA_VALIDATION_API,
    platformSso:parseBool(env.REPLAY_PLATFORM_SSO,false),
    workroomId,
    forwardedHost,
    forwardedProto,
    allowedOrigins,
    cookieSecure: parseBool(env.REPLAY_COOKIE_SECURE, forwardedProto === "https"),
    allowLegacyRecordings: parseBool(env.REPLAY_ALLOW_LEGACY_RECORDINGS, false),
  };
}

function validatedLoginOrigin(value:string,allowedOrigins:string[]):string {
  let url:URL;try{url=new URL(value);}catch{throw new NativeConfigError('REPLAY_LOGIN_ORIGIN must be an HTTPS origin');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new NativeConfigError('REPLAY_LOGIN_ORIGIN must be an HTTPS origin');
  if(!allowedOrigins.includes(url.origin.toLowerCase()))throw new NativeConfigError('REPLAY_LOGIN_ORIGIN must be included in REPLAY_ALLOWED_ORIGINS');
  return url.origin;
}

/** Fixed native route accepted by Kamiwaza's same-origin login redirect policy. */
export function nativeLoginUrl(config:KamiwazaConfig):string {
  const origin=config.loginOrigin?validatedLoginOrigin(config.loginOrigin,config.allowedOrigins):`${config.forwardedProto}://${config.forwardedHost}`;
  const parsed=new URL(origin);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new NativeConfigError('Platform SSO requires an HTTPS native login origin');
  const url=new URL('/login',parsed.origin);url.searchParams.set('redirect','/runtime/apps/replay');return url.href;
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new NativeConfigError(`REPLAY_ALLOWED_ORIGINS entry is not an absolute origin: "${s}"`);
    }
    if (!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname !== "/" || u.search || u.hash) throw new NativeConfigError('REPLAY_ALLOWED_ORIGINS entry must be HTTP(S) scheme://host[:port] without credentials, path, query or fragment');
    out.push(u.origin.toLowerCase());
  }
  return out;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new NativeConfigError(`boolean environment value expected, got "${raw}"`);
}

// ---------------------------------------------------------------------------
// Native session port (structural subset of NativeSessions; mockable in tests)
// ---------------------------------------------------------------------------

export interface NativeSessionPort {
  readonly workroomId: string;
  login(sessionId: string, credentials: { username: string; password: string }): Promise<NativeResolution>;
  acceptPlatformSession?(sessionId:string,token:string):Promise<NativeResolution>;
  resolve(sessionId: string, opts?: ResolveOptions): Promise<NativeResolved>;
  metadata(sessionId: string): NativeSessionMetadata;
  logout(sessionId: string): void;
  /** Native revocation and qualified expiration headers; no credentials are returned to the client. */
  logoutPlatform?(cookieHeader:string):Promise<PlatformLogoutResult>;
}

/** Public, serializable view of a resolved native session placed on `res.locals.native`. */
export interface NativeLocals {
  identity: NativeIdentity;
  context: NativeContext;
  nativeReceipts: RequestReceipt[];
  metadata: NativeSessionMetadata;
  /** Session-scoped platform client. Non-enumerable: never serialized. */
  readonly platformClient: NativeResolved["platformClient"];
}

export interface AuthLocals {
  sessionId: string;
  session: Session;
  identity: Identity;
  /** Null in local-demo mode. */
  native: NativeLocals | null;
}

// ---------------------------------------------------------------------------
// Typed HTTP errors
// ---------------------------------------------------------------------------

export type HttpErrorCode =
  | "invalid_request"
  | "cross_origin"
  | "rate_limited"
  | "platform_sign_in_required"
  | "native_disabled"
  | "role_switch_rejected"
  | "exercise_not_found"
  | "exercise_forbidden"
  | "no_exercise"
  | "historical_read_only"
  | "navigation_changed"
  | "side_forbidden"
  | "role_required"
  | "task_forbidden"
  | "task_not_found"
  | "not_active";

export class HttpError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;
  constructor(status: number, code: HttpErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Login rate limit (in-memory, per client key)
// ---------------------------------------------------------------------------

export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 10, private readonly windowMs = 60_000, private readonly now: () => number = () => Date.now()) {}

  /** Returns 0 when allowed, otherwise the number of ms until the next attempt is allowed. */
  check(key: string): number {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return Math.max(1, this.windowMs - (t - list[0]!));
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value!);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Exercise scope
// ---------------------------------------------------------------------------

export const SCENARIO_ID = "crosscurrent";
export const CURRICULUM_VERSION = "0.1.0";

export type Attribution = "owned" | "shared" | "workroom" | "unattributed";

export interface ExerciseScope {
  /** Whether the identity may read and select this row. */
  visible(row: ExerciseRow): boolean;
  attribution(row: ExerciseRow): Attribution;
}

function rowOwner(row: ExerciseRow): string | null {
  const v = row.options?.ownerSubject;
  return typeof v === "string" && v.length > 0 ? v : null;
}
function rowWorkroom(row: ExerciseRow): string | null {
  const v = row.options?.workroomId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function exerciseScope(config: AppConfig, identity: Identity, enrolled:(row:ExerciseRow)=>boolean=()=>false): ExerciseScope {
  if (config.mode === "local-demo") {
    return {
      visible: () => true,
      attribution: (row) => (rowOwner(row) === identity.subject ? "owned" : rowOwner(row) === null ? "unattributed" : "workroom"),
    };
  }
  const instructor = identity.role === "instructor";
  return {
    visible(row) {
      const room = rowWorkroom(row);
      if (room === null) return instructor && config.allowLegacyRecordings && rowOwner(row) === null;
      if (room !== config.workroomId) return false;
      return instructor || rowOwner(row) === identity.subject || enrolled(row);
    },
    attribution(row) {
      if (rowWorkroom(row) === null || rowOwner(row) === null) return "unattributed";
      return rowOwner(row) === identity.subject ? "owned" : enrolled(row)?"shared":"workroom";
    },
  };
}

/** Ownership and curriculum fields persisted on rows created through the HTTP API. */
export function ownershipOptions(config: AppConfig, identity: Identity, parent?: ExerciseRow): Record<string, unknown> {
  return {
    ownerSubject: identity.subject,
    workroomId: config.mode === "kamiwaza" ? config.workroomId : null,
    scenarioId: typeof parent?.options?.scenarioId === "string" ? parent.options.scenarioId : SCENARIO_ID,
    curriculumVersion: typeof parent?.options?.curriculumVersion === "string" ? parent.options.curriculumVersion : CURRICULUM_VERSION,
    assistance: "unknown",
  };
}

// ---------------------------------------------------------------------------
// Origin policy for mutations
// ---------------------------------------------------------------------------

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Reject cross-origin mutations. A browser `Origin` must match the request
 * `Host` or an explicitly allowed origin (for dev proxies on other ports).
 * `Sec-Fetch-Site: cross-site` is rejected even without an Origin. Requests
 * without either header (non-browser clients) rely on the SameSite=Strict
 * cookie, which browsers never send cross-site.
 */
export function originGuard(allowedOrigins: readonly string[]): express.RequestHandler {
  const allowed = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  return (req, _res, next) => {
    if (!MUTATING.has(req.method)) return next();
    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site.toLowerCase() === "cross-site") return next(new HttpError(403, "cross_origin", "Cross-site requests cannot change exercise state"));
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin.length === 0) return next();
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return next(new HttpError(403, "cross_origin", "Malformed Origin header"));
    }
    const host = (req.headers.host ?? "").toLowerCase();
    if (o.host.toLowerCase() === host && host.length > 0) return next();
    if (allowed.has(o.origin.toLowerCase())) return next();
    return next(new HttpError(403, "cross_origin", "Origin is not allowed to change exercise state"));
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export interface CreateAppOptions {
  service: GameService;
  config: AppConfig;
  /** Required in kamiwaza mode. */
  native?: NativeSessionPort | null;
  /** Repository root for static assets and the process log. */
  root?: string;
  now?: () => number;
  loginLimiter?: LoginRateLimiter;
  /**
   * Called after the API routes and before the static catch-all, with auth
   * locals already in place. Use it to mount additional API routes.
   */
  mount?: (app: express.Express) => void;
  /** Machine routes supply their own authentication and run before browser body/session handling. */
  mountInternal?: (app: express.Express) => void;
  /** Authenticated middleware that must run before the core exercise endpoints. */
  mountAuthorized?: (app: express.Express) => void;
  /** Local operator qualification: permits choosing a short-lived credentials file in the sign-in UI. */
  operatorFileImport?: boolean;
}

/** Guards attached at `app.locals.guards` for additional routes mounted through `mount`. */
export interface AuthGuards {
  /** Uncached read authority; does not require can_edit. */
  requireFreshRead?: express.RequestHandler;
  /** Fresh native `can_edit` (no-op in local-demo mode). */
  requireWrite: express.RequestHandler;
  /** Fresh native `can_edit` and `can_run_agents` (no-op in local-demo mode). */
  requireAgents: express.RequestHandler;
  /** The session's active exercise must still be within the identity's scope. */
  requireActive: express.RequestHandler;
}

const SESSION_COOKIE = "replay_session";
const sideSchema = z.enum(["blue", "red"]);
const roleSchema = z.enum(["commander", "intelligence", "instructor"]);

export function createApp(opts: CreateAppOptions): express.Express {
  const { service, config } = opts;
  const root = opts.root ?? process.cwd();
  const now = opts.now ?? (() => Date.now());
  const native = config.mode === "kamiwaza" ? opts.native ?? null : null;
  if (config.mode === "kamiwaza" && !native) throw new NativeConfigError("kamiwaza mode requires a NativeSessions instance");
  if (native && native.workroomId !== (config as KamiwazaConfig).workroomId) throw new NativeConfigError("NativeSessions workroom differs from the configured workroom");
  const limiter = opts.loginLimiter ?? new LoginRateLimiter(10, 60_000, now);

  const platformSso=config.mode==='kamiwaza'&&config.platformSso===true;
  if(platformSso&&(!native?.acceptPlatformSession||!config.cookieSecure))throw new NativeConfigError('Platform SSO requires native session validation and secure cookies');
  const platformLoginUrl=platformSso&&config.mode==='kamiwaza'?nativeLoginUrl(config):undefined;
  const revokedTokens=platformSso?new NativeTokenRevocations(service.store.db,now):null;
  const platformToken=(req:express.Request):string|null=>{
    const entries=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('access_token='));
    if(entries.length!==1)return null;
    const value=entries[0].slice('access_token='.length);
    return value.length<=16384&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)?value:null;
  };
  const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
  const currentPlatformToken=(req:express.Request):string|null=>{const token=platformToken(req);if(token)revokedTokens?.assertAllowed(token);return token;};
  const ssoStatus=(req:express.Request)=>{
    if(!platformSso||config.mode!=='kamiwaza')return {};
    let available=false;try{available=!!currentPlatformToken(req);}catch{/* Denial is reported by native/status, never treated as a session. */}
    return {platformSso:true,platformSessionAvailable:available,platformLoginUrl,platformSwitchAvailable:!!native?.logoutPlatform&&!!platformToken(req)};
  };

  const app = express();
  // Shared exact-token refusal also applies when the same native JWT arrives as a machine-route bearer.
  app.locals.assertNativeTokenAllowed=(token:string)=>revokedTokens?.assertAllowed(token);
  app.disable("x-powered-by");
  app.set("etag", false);
  // Tomo is mounted before the JSON/session middleware because it reads streaming bodies.
  // Bind every browser surface to the current native platform cookie before that mount.
  if(platformSso)app.use('/runtime/apps/replay-tomo',(req,res,next)=>{
    const entries=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('replay_session='));
    const id=entries.length===1?entries[0].slice('replay_session='.length):'';
    const session=/^[a-f0-9-]{36}$/.test(id)?service.store.session(id) as Session|null:null;
    const token=currentPlatformToken(req);
    if(!session||!token||session.platformSsoSignedOut||session.platformSessionHash!==tokenHash(token))return res.status(401).set('Cache-Control','no-store').json({error:'Continue with your current Kamiwaza session'});
    next();
  });
  opts.mountInternal?.(app);
  app.use(express.json({ limit: "32kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  if(config.publicOrigin){
    // App Garden's managed prefix launches the dedicated same-site app host.
    app.use('/runtime/apps/replay',(req,res,next)=>{
      if(req.method==='GET'||req.method==='HEAD')return res.redirect(302,config.publicOrigin+'/');
      next();
    });
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      product: "REPLAY",
      engine: "OpenFront",
      authMode: config.mode,
      native: config.mode === "kamiwaza" ? { configured: true, workroomId: config.workroomId, legacyRecordings: config.allowLegacyRecordings } : { configured: false },
      // Live platform reachability is only established per request through a native session; health never claims it.
      nativeConnected: null,
    });
  });

  // ---- session cookie + identity resolution -------------------------------

  const setCookie = (res: express.Response, id: string) => {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${config.cookieSecure ? "; Secure" : ""}`);
  };
  const cookieId = (req: express.Request): string | null => {
    const raw = req.headers.cookie?.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    return raw && /^[a-f0-9-]{36}$/.test(raw) ? raw : null;
  };
  const save = (res: express.Response) => service.store.putSession(res.locals.sessionId as string, res.locals.session as Session);
  const locals = (res: express.Response) => res.locals as unknown as AuthLocals;

  const PUBLIC_NATIVE = new Set(["/native/status", "/native/login", "/native/logout", "/native/platform-session", "/native/switch-user"]);

  app.use("/api", originGuard(config.allowedOrigins));
  app.use("/api", (req, res, next) => {
    const existing = cookieId(req);
    const id = existing ?? randomUUID();
    let session = service.store.session(id) as Session | null;
    if (!session) {
      session = service.defaultSession();
      if (config.mode === "kamiwaza") session.identity = placeholderIdentity();
      service.store.putSession(id, session);
    }
    if (!existing) setCookie(res, id);
    res.locals.sessionId = id;
    res.locals.session = session;
    res.locals.native = null;
    res.locals.identity = session.identity;
    if(native)Object.defineProperty(res.locals,'resolveAgentAuthority',{enumerable:false,value:()=>native.resolve(id,{requireWrite:true,requireAgents:true})});
    if (config.mode === "local-demo" || PUBLIC_NATIVE.has(req.path)) return next();
    if(platformSso){
      const token=currentPlatformToken(req);
      if(!token||session.platformSsoSignedOut||session.platformSessionHash!==tokenHash(token))return next(new NativeSessionError('signed_out',401,'Continue with your current Kamiwaza session'));
      Object.defineProperty(res.locals,'assertCurrentPlatformSession',{enumerable:false,value:()=>revokedTokens?.assertAllowed(token)});
    }
    // Native mode: every other API request resolves a native identity (read level). Failure is a typed denial.
    void resolveInto(res, {}).then(() => next(), next);
  });

  async function resolveInto(res: express.Response, o: ResolveOptions): Promise<NativeLocals> {
    res.locals.assertCurrentPlatformSession?.();
    const r = await native!.resolve(res.locals.sessionId as string, o);
    res.locals.assertCurrentPlatformSession?.();
    const view: NativeLocals = { identity: r.identity, context: r.context, nativeReceipts: r.nativeReceipts, metadata: r.metadata } as NativeLocals;
    Object.defineProperty(view, "platformClient", { value: r.platformClient, enumerable: false, writable: false });
    const session = res.locals.session as Session;
    session.identity = r.identity; // derived per request; never authoritative from the store
    res.locals.native = view;
    res.locals.identity = r.identity;
    return view;
  }

  /** Route guard for world mutation (fresh `can_edit`) or agent control (fresh `can_run_agents`). */
  const guard = (o: ResolveOptions): express.RequestHandler => (_req, res, next) => {
    if (!native) return next();
    resolveInto(res, o).then(() => next(), next);
  };
  const requireWrite = guard({ requireWrite: true });
  const requireAgents = guard({ requireWrite: true, requireAgents: true });

  // ---- exercise scope helpers ---------------------------------------------

  const scopeOf = (res: express.Response) => exerciseScope(config, locals(res).identity,row=>service.teams.includes(row,locals(res).identity.subject));
  const visibleRow = (res: express.Response, id: string): ExerciseRow => {
    const row = service.store.exercise(id);
    if (!row) throw new HttpError(404, "exercise_not_found", "Exercise not found");
    if (!scopeOf(res).visible(row)) throw new HttpError(403, "exercise_forbidden", "This exercise is not assigned to you in this workroom");
    return row;
  };
  /** The active world, re-checked against scope on every call so a revoked seat fails closed. */
  const activeWorld = (res: express.Response) => {
    const s = locals(res).session;
    visibleRow(res, s.activeId);
    return service.world(s.activeId);
  };
  const instructor = (res: express.Response) => locals(res).identity.role === "instructor";
  const requireActive: express.RequestHandler = (_req, res, next) => {
    try {
      activeWorld(res);
      next();
    } catch (err) {
      next(err);
    }
  };
  const guards: AuthGuards = { requireWrite, requireAgents, requireActive, requireFreshRead: guard({fresh:true}) };
  app.locals.guards = guards;
  opts.mountAuthorized?.(app);
  const persistOwnership = (row: ExerciseRow, res: express.Response, parent?: ExerciseRow) => {
    row.options = { ...row.options, ...ownershipOptions(config, locals(res).identity, parent??row) };
    service.store.putExercise(row);
    service.teams.enroll(row,locals(res).identity,row.forkTick??1);
  };

  // Joining adds exercise enrollment only; native workroom identity and role remain authoritative.
  const joinLimiter=new LoginRateLimiter();
  const managesTeam=(res:express.Response,row:ExerciseRow)=>
    !row.options?.campaignId&&(instructor(res)||rowOwner(row)===locals(res).identity.subject)&&(!native||locals(res).native?.context.canShare===true);
  app.get('/api/team',requireActive,(_req,res)=>{
    const row=activeWorld(res).row;
    res.json({exerciseId:row.id,name:row.name,side:row.humanSide,status:row.status,canManage:managesTeam(res,row),participants:service.teams.participants(row)});
  });
  app.post('/api/team/code',requireWrite,requireActive,(_req,res,next)=>{
    try{const row=activeWorld(res).row;if(!managesTeam(res,row))throw new HttpError(403,'role_required','The exercise owner or instructor needs native sharing permission');res.json(service.teams.issueCode(row,locals(res).identity.subject));}catch(e){next(e);}
  });
  app.post('/api/team/join',requireWrite,(req,res,next)=>{
    try{
      const wait=joinLimiter.check(locals(res).identity.subject||clientKey(req));
      if(wait)throw new HttpError(429,'rate_limited','Too many exercise-code attempts; try again in a minute');
      const code=z.string().trim().regex(/^[a-f0-9]{32}$/i).parse(req.body?.code);
      const row=service.teams.lookupCode(code,config.mode==='kamiwaza'?config.workroomId:null);
      const identity=locals(res).identity,w=service.world(row.id),already=service.teams.includes(row,identity.subject);
      const member=service.teams.enroll(row,identity,w.engine.game.ticks());
      if(!already)service.store.event(row.id,w.engine.game.ticks(),'participant_joined',identity.subject,'Participant joined the exercise',{subject:identity.subject,roleAtJoin:member.roleAtJoin,joinedTick:member.joinedTick},row.humanSide);
      const s=locals(res).session;s.activeId=row.id;s.playbackTick=null;s.selectedSide=row.humanSide;save(res);
      res.json({exerciseId:row.id,side:row.humanSide});
    }catch(e){next(e);}
  });
  app.post('/api/team/remove',requireWrite,requireActive,(req,res,next)=>{
    try{
      const row=activeWorld(res).row;if(!managesTeam(res,row))throw new HttpError(403,'role_required','The exercise owner or instructor needs native sharing permission');
      const subject=z.string().min(1).max(200).parse(req.body?.subject);
      service.removeParticipant(row.id,subject,locals(res).identity.subject);
      res.json({removed:true});
    }catch(e){next(e);}
  });

  // ---- native endpoints ---------------------------------------------------

  async function enterPlatformSession(req:express.Request,res:express.Response):Promise<NativeResolution>{
    if(!platformSso||!native?.acceptPlatformSession)throw new HttpError(409,'native_disabled','Platform session handoff is not enabled');
    const token=currentPlatformToken(req);
    if(!token)throw new NativeSessionError('signed_out',401,'Sign in to Kamiwaza to continue');
    const wait=limiter.check(clientKey(req));
    if(wait>0)throw new HttpError(429,'rate_limited','Too many session handoff attempts; try again shortly');
    const oldId=res.locals.sessionId as string,newId=randomUUID();
    const r=await native.acceptPlatformSession(newId,token);
    try{revokedTokens?.assertAllowed(token);}catch(err){native.logout(newId);throw err;}
    const session={...(res.locals.session as Session),identity:r.identity,platformSessionHash:tokenHash(token),platformSsoSignedOut:false};
    service.store.putSession(newId,session);service.store.db.prepare('DELETE FROM sessions WHERE id=?').run(oldId);
    native.logout(oldId);setCookie(res,newId);res.locals.sessionId=newId;res.locals.session=session;
    return r;
  }
  app.post('/api/native/platform-session',async(req,res,next)=>{
    try{const r=await enterPlatformSession(req,res);res.json({signedIn:true,identity:r.identity,context:r.context,metadata:r.metadata,receipts:r.nativeReceipts});}catch(e){next(e);}
  });

  app.get("/api/native/status", async (req, res, next) => {
    try {
      if (!native) return res.json({ mode: "local-demo", signedIn: false, workroomId: null, identity: null, context: null, metadata: null, denial: null });
      let id = res.locals.sessionId as string;
      try {
        if(platformSso){
          const token=currentPlatformToken(req),session=res.locals.session as Session;
          if(!token||session.platformSsoSignedOut)throw new NativeSessionError('signed_out',401,'Continue with your Kamiwaza session');
          if(session.platformSessionHash!==tokenHash(token)||!native.metadata(id).signedIn){await enterPlatformSession(req,res);id=res.locals.sessionId as string;}
        }
        const r = await native.resolve(id);
        if(platformSso)currentPlatformToken(req);
        return res.json({ ...ssoStatus(req),mode: "kamiwaza", operatorFileImport:opts.operatorFileImport===true, signedIn: true, workroomId: native.workroomId, identity: r.identity, context: r.context, metadata: r.metadata, denial: null });
      } catch (err) {
        if (!(err instanceof NativeSessionError)) throw err;
        const metadata = native.metadata(id);
        return res.json({ ...ssoStatus(req),mode: "kamiwaza", operatorFileImport:opts.operatorFileImport===true, signedIn: platformSso?false:metadata.signedIn, workroomId: native.workroomId, identity: null, context: null, metadata, denial: { code: err.code, httpStatus: err.httpStatus, message: err.message } });
      }
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/native/login", async (req, res, next) => {
    try {
      if (!native) throw new HttpError(409, "native_disabled", "Native sign-in is not configured; this instance runs local demo identities");
      if(platformSso)throw new HttpError(409,'platform_sign_in_required','Sign in through Kamiwaza for this deployment');
      const wait = limiter.check(clientKey(req));
      if (wait > 0) {
        res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
        throw new HttpError(429, "rate_limited", "Too many sign-in attempts; try again shortly");
      }
      const body = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1024) }).safeParse(req.body);
      if (!body.success) throw new HttpError(400, "invalid_request", "username and password are required");
      const oldId = res.locals.sessionId as string;
      const newId = randomUUID();
      const r = await native.login(newId, body.data);
      // Rotate the browser session id: carry navigation state forward, drop the pre-login id.
      const session = { ...(res.locals.session as Session), identity: r.identity };
      service.store.putSession(newId, session);
      service.store.db.prepare("DELETE FROM sessions WHERE id=?").run(oldId);
      try {
        native.logout(oldId);
      } catch {
        /* nothing bound to the old id */
      }
      setCookie(res, newId);
      res.json({ signedIn: true, identity: r.identity, context: r.context, metadata: r.metadata, receipts: r.nativeReceipts });
    } catch (err) {
      next(err);
    }
  });

  function signOutApp(res:express.Response):void {
      if (!native) throw new HttpError(409, "native_disabled", "Native sign-in is not configured");
      const oldId = res.locals.sessionId as string;
      native.logout(oldId);
      service.store.db.prepare("DELETE FROM sessions WHERE id=?").run(oldId);
      const fresh = service.defaultSession();
      fresh.identity = placeholderIdentity();
      if(platformSso)fresh.platformSsoSignedOut=true;
      const newId = randomUUID();
      service.store.putSession(newId, fresh);
      setCookie(res, newId);
      res.locals.sessionId=newId;res.locals.session=fresh;
  }
  app.post("/api/native/logout", (_req, res, next) => {
    try {
      signOutApp(res);
      res.json({ signedIn: false });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/native/switch-user',async(req,res,next)=>{
    try {
      if(!platformSso||!native?.logoutPlatform)throw new HttpError(409,'native_disabled','Native account switching is not configured');
      if(!z.object({}).strict().safeParse(req.body).success)throw new HttpError(400,'invalid_request','This endpoint accepts no identity, credentials or redirect input');
      const token=platformToken(req),previous=res.locals.session as Session;
      // This binding is written only after Core verified a handoff. It remains proof of this exact
      // token when the app gate is stale/blocked; resolving protected workroom data is not required.
      const previouslyVerified=!!token&&previous.identity.mode==='kamiwaza'&&previous.platformSessionHash===tokenHash(token);
      if(previouslyVerified){
        const wait=limiter.check(clientKey(req));
        if(wait>0){res.setHeader('Retry-After',String(Math.ceil(wait/1000)));throw new HttpError(429,'rate_limited','Too many native session attempts; try again shortly');}
      }
      signOutApp(res); // Fail closed locally even when native revocation is unavailable.
      const hostname=new URL(`https://${(config as KamiwazaConfig).forwardedHost}`).hostname;
      res.append('Set-Cookie',nativeCookieExpirations(hostname));
      // Never let unauthenticated input consume the global refusal table or native-login rate quota.
      if(!previouslyVerified)return res.status(401).json({signedIn:false,replayTokenBlocked:false,platformCookiesCleared:true,nativeSessionTerminationRequested:false,loginUrl:platformLoginUrl,error:'REPLAY is signed out and browser cookies are cleared. No previously verified current session was available to request native termination.'});
      revokedTokens!.revoke(token!); // Persist proven-token refusal before the native logout network call.
      let result:PlatformLogoutResult;
      try{result=await native.logoutPlatform(req.headers.cookie??'');}
      catch{result={sessionTerminationRequested:false};}
      // Cookies are cleared even on failure. No later cookie-less retry can claim the former session was revoked.
      const response={signedIn:false,replayTokenBlocked:!!token,platformCookiesCleared:true,nativeSessionTerminationRequested:result.sessionTerminationRequested,loginUrl:platformLoginUrl};
      if(!result.sessionTerminationRequested)return res.status(502).json({...response,error:'REPLAY is signed out and browser cookies are cleared. Kamiwaza session termination was not confirmed.'});
      // A newly issued platform cookie can establish a newly verified identity; the switched-out token remains refused.
      (res.locals.session as Session).platformSsoSignedOut=false;save(res);
      return res.json(response);
    }catch(err){next(err);}
  });

  // ---- overview -----------------------------------------------------------

  app.get("/api/overview", async (_req, res, next) => {
    try {
      const l = locals(res);
      const scope = scopeOf(res);
      let rows = service.store.exercises().filter((r) => scope.visible(r) && service.worlds.has(r.id));
      if (!rows.some((r) => r.id === l.session.activeId)) {
        if (rows.length === 0) {
          if (native) {
            // A first exercise for this person requires native write permission.
            try {
              await resolveInto(res, { requireWrite: true });
            } catch (err) {
              if (err instanceof NativeSessionError && err.code === "read_only") {
                throw new HttpError(403, "no_exercise", "No exercise is assigned to you in this workroom and your seat is read-only, so one cannot be created. Ask the workroom operator for write access or an instructor-run exercise.");
              }
              throw err;
            }
          }
          const row = await service.create();
          persistOwnership(row, res);
          rows = [row];
        }
        l.session.activeId = rows[0]!.id;
        l.session.playbackTick = null;
        l.session.selectedSide = rows[0]!.humanSide;
        save(res);
      }
      const ov = await service.overview(l.session);
      const visibleIds = new Set(rows.map((r) => r.id));
      const exercises = ov.exercises
        .filter((e) => visibleIds.has(e.id))
        .map((e) => ({ ...e, ownerSubject: rowOwner(e as ExerciseRow), attribution: scope.attribution(e as ExerciseRow) }));
      const dossier = { ...ov.dossier, priorAttempts: ov.dossier.priorAttempts.filter((p) => visibleIds.has(p.id)) };
      const platform = l.native
        ? {
            ...ov.platform,
            mode: "kamiwaza",
            nativeConnected: true,
            version: process.env.REPLAY_KAMIWAZA_VERSION ?? 'Not reported by runtime context',
            ontologyStatus: process.env.REPLAY_ONTOLOGY_ID ? 'Native Graphiti configured · live health and contents shown above' : 'Application source projection · native graph unconfigured',
            native: { workroomId: l.native.context.workroomId, context: l.native.context, metadata: l.native.metadata, receipts: l.native.nativeReceipts },
            details: [
              ...ov.platform.details.filter((d) => !/subsequent qualification gate/.test(d)),
              `Native identity resolved through Kamiwaza ForwardAuth at ${l.native.context.validatedAt}`,
              `Workroom ${l.native.context.workroomId} role ${l.native.context.nativeRole} mapped to ${l.native.context.mappedRole} seat`,
              "Exercise records are scoped to the authenticated subject and configured workroom",
            ],
          }
        : { ...ov.platform, mode: "local-demo", nativeConnected: false };
      res.json({ ...ov, navigationRevision:l.session.navigationRevision??0, identity: l.identity, exercises, dossier, platform });
    } catch (err) {
      next(err);
    }
  });

  // ---- local persona selector (rejected in native mode) -------------------

  app.post("/api/session", (req, res, next) => {
    try {
      if (native) throw new HttpError(403, "role_switch_rejected", "Native assignments come from the Kamiwaza workroom and cannot be changed by a persona selector");
      const role = roleSchema.parse(req.body?.role);
      const old = res.locals.session as Session;
      res.locals.session = { ...old, identity: service.defaultSession(role).identity };
      save(res);
      res.json({ identity: (res.locals.session as Session).identity });
    } catch (err) {
      next(err);
    }
  });

  // ---- session navigation (no write permission needed) --------------------

  const navigationExpectation=z.object({activeId:z.string().min(1).max(100),playbackTick:z.number().int().nonnegative().nullable(),revision:z.number().int().nonnegative()}).strict();
  // Native resolution and historical reconstruction can yield. Read the durable navigation at
  // commit time so an older request cannot overwrite a newer selection or freeze operation.
  const latestNavigation=(res:express.Response):Session=>{
    const latest=service.store.session(locals(res).sessionId) as Session|null;
    if(!latest||latest.identity.subject!==locals(res).identity.subject)throw new HttpError(409,'navigation_changed','Session changed; refresh before navigating');
    return {...latest,identity:locals(res).identity};
  };
  const navigationMatches=(s:Session,e:{activeId:string;playbackTick:number|null;revision:number})=>s.activeId===e.activeId&&s.playbackTick===e.playbackTick&&(s.navigationRevision??0)===e.revision;
  const commitNavigation=(res:express.Response,s:Session)=>{
    s.navigationRevision=(s.navigationRevision??0)+1;res.locals.session=s;save(res);
  };

  app.post("/api/select", (req, res, next) => {
    try {
      const id = z.string().min(1).max(100).parse(req.body?.exerciseId);
      const row = visibleRow(res, id);
      const w = service.world(row.id);
      const expected=req.body?.expected===undefined?null:navigationExpectation.parse(req.body.expected);
      const s = latestNavigation(res);
      if(expected&&!navigationMatches(s,expected))throw new HttpError(409,'navigation_changed','Your view changed; the waiting mission was not opened');
      s.activeId = row.id;
      s.playbackTick = w.row.kind === "recorded" ? w.engine.game.ticks() : null;
      s.selectedSide = w.row.humanSide;
      commitNavigation(res,s);
      res.json({ selected: row.id, ...(expected?{navigationRevision:s.navigationRevision}:{}) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/replay", async (req, res, next) => {
    try {
      const tick = z.number().int().nonnegative().nullable().parse(req.body?.tick);
      const s = latestNavigation(res);res.locals.session=s;
      const expected={activeId:s.activeId,playbackTick:s.playbackTick,revision:s.navigationRevision??0};
      if(req.body?.exerciseId!==undefined&&z.string().min(1).max(100).parse(req.body.exerciseId)!==s.activeId)throw new HttpError(409,'navigation_changed','The exercise changed; refresh before seeking');
      const w = activeWorld(res);
      if (tick !== null) await service.historical(w.row.id, tick);
      const latest=latestNavigation(res);
      if(!navigationMatches(latest,expected))throw new HttpError(409,'navigation_changed','Your view changed while this historical position was loading');
      latest.playbackTick = tick;
      commitNavigation(res,latest);
      res.json({ playbackTick: tick });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/record/:id", (req, res, next) => {
    try {
      const row = visibleRow(res, String(req.params.id));
      if(row.status!=='completed'&&!instructor(res))throw new HttpError(403,'side_forbidden','Complete replay inputs are released after the exercise ends or to the instructor');
      res.json(service.record(row.id));
    } catch (err) {
      next(err);
    }
  });

  // ---- world mutation -----------------------------------------------------

  app.post("/api/exercises", requireWrite, async (req, res, next) => {
    try {
      const input = z.object({name:z.string().max(100).optional(),scenarioId:z.string().refine(id=>SCENARIOS.some(s=>s.id===id),'Unknown exercise scenario').optional()}).strict().parse(req.body??{});
      const row = await service.create(input.name,'world',undefined,input.scenarioId);
      persistOwnership(row, res);
      const s = locals(res).session;
      s.activeId = row.id;
      s.playbackTick = null;
      s.selectedSide = "blue";
      save(res);
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/commands", requireWrite, (req, res, next) => {
    try {
      const l = locals(res);
      const w = activeWorld(res);
      if (l.session.playbackTick !== null) throw new HttpError(409, "historical_read_only", "Historical view is read-only; create a branch to issue new orders");
      const body = z.object({ side: sideSchema, intent: z.unknown(), idempotencyKey: z.string().min(8).max(100), rationale: z.string().max(2000).optional(), sourceIds: z.array(z.string().max(200)).max(20).optional(), observationReceipt: z.string().max(4096).optional() }).parse(req.body);
      const receipt = service.command(w.row.id, body.side, body.intent, body.idempotencyKey, l.identity, 'human', {rationale:body.rationale,sourceIds:body.sourceIds,observationReceipt:body.observationReceipt});
      res.status(202).json(receipt);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks", requireWrite, (req, res, next) => {
    try {
      const l = locals(res);
      const w = activeWorld(res);
      if (l.session.playbackTick !== null) throw new HttpError(409, "historical_read_only", "Create staff work in a live exercise or new branch");
      const b = z.object({ title: z.string().min(1).max(500), side: sideSchema }).parse(req.body);
      if (b.side !== w.row.humanSide && !instructor(res)) throw new HttpError(403, "side_forbidden", "Task side is outside your assignment");
      res.status(201).json(service.createTask(w.row.id, l.identity, b.title, b.side));
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/tasks/:id/cancel", requireWrite, (req, res, next) => {
    try {
      const l = locals(res);
      const w = activeWorld(res);
      const task = service.store.tasks(w.row.id).find((t) => t.id === req.params.id);
      if (!task) throw new HttpError(404, "task_not_found", "Task not found");
      if (task.owner !== l.identity.subject && !instructor(res)) throw new HttpError(403, "task_forbidden", "Task belongs to another participant");
      task.status = "cancelled";
      service.store.putTask(w.row.id, task);
      res.json(task);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/staff", requireWrite, async (req, res, next) => {
    try {
      const l = locals(res);
      const w = activeWorld(res);
      const b = z.object({ message: z.string().min(1).max(3000), side: sideSchema }).parse(req.body);
      // Opposing staff context is released only for a completed exercise or to the instructor, whatever tick is displayed.
      if (b.side !== w.row.humanSide && !instructor(res) && w.row.status !== "completed") throw new HttpError(403, "side_forbidden", "Staff context is outside your assignment");
      const resolver=native?async()=>{
        const r=await native.resolve(res.locals.sessionId as string,{requireWrite:true,requireAgents:true});
        if(!exerciseScope(config,r.identity,row=>service.teams.includes(row,r.identity.subject)).visible(w.row)||b.side!==w.row.humanSide&&r.identity.role!=='instructor'&&w.row.status!=='completed')throw new HttpError(403,'exercise_forbidden','Staff context is no longer assigned to you');
        return r;
      }:undefined;
      res.json(await service.staff(l.session, b.message, b.side,resolver));
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/branches", requireWrite, async (req, res, next) => {
    try {
      const l = locals(res);
      const parent = activeWorld(res);
      const b = z.object({ tick: z.number().int().min(1), side: sideSchema }).parse(req.body);
      // Branching as the opposing side replays that side's staff records; same release rule as staff, regardless of tick.
      if (b.side !== parent.row.humanSide && !instructor(res) && parent.row.status !== "completed") throw new HttpError(403, "side_forbidden", "Opposing-side branches open after the exercise completes or for the instructor");
      const row = await service.branch(parent.row.id, b.tick, b.side);
      persistOwnership(row, res, parent.row);
      l.session.activeId = row.id;
      l.session.playbackTick = null;
      l.session.selectedSide = b.side;
      save(res);
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/reports/inject", requireWrite, (_req, res, next) => {
    try {
      const w = activeWorld(res);
      if (!instructor(res)) throw new HttpError(403, "role_required", "Instructor assignment required");
      service.injectReport(w.row.id);
      res.json({ released: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/agent", requireAgents, (req, res, next) => {
    try {
      const l = locals(res);
      const w = activeWorld(res);
      if (l.identity.role === "intelligence") throw new HttpError(403, "role_required", "Commander or instructor assignment required");
      const enabled = z.boolean().parse(req.body?.enabled);
      const singlePulse=z.boolean().optional().parse(req.body?.singlePulse)===true;
      if(enabled&&singlePulse)w.row.options.agentRunMode='single-pulse/1';else delete w.row.options.agentRunMode;
      w.row.agentEnabled = enabled;
      service.store.putExercise(w.row);
      service.store.event(w.row.id, w.engine.game.ticks(), "controller_changed", l.identity.subject, enabled ? "Luna controller enabled under project budget" : "Luna stopped; recorded scenario controller resumed", { enabled,...(singlePulse&&enabled?{runMode:'single-pulse/1'}:{}) });
      res.json({ enabled, budget: service.ledger.summary() });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/exercises/:id/finish", requireWrite, (req, res, next) => {
    try {
      const l = locals(res);
      if (l.identity.role === "intelligence") throw new HttpError(403, "role_required", "Active exercise commander or instructor required");
      if (l.session.activeId !== req.params.id) throw new HttpError(409, "not_active", "Only the active exercise can be ended");
      const w = activeWorld(res);
      w.row.status = "completed";
      w.row.kind = w.row.kind === "branch" ? "branch" : "recorded";
      w.row.agentEnabled = false;
      service.store.putExercise(w.row);
      service.store.event(w.row.id, w.engine.game.ticks(), "exercise_ended", l.identity.subject, "Exercise ended for review");
      res.json(w.row);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/process", (_req, res, next) => {
    try {
      if (native && !instructor(res)) throw new HttpError(403, "role_required", "The build process log is available to the instructor seat");
      res.json({ stage: JSON.parse(fs.readFileSync(path.join(root, "docs/stages/status.json"), "utf8")), journal: fs.readFileSync(path.join(root, "docs/process/BUILD-JOURNAL.md"), "utf8") });
    } catch (err) {
      next(err);
    }
  });

  // ---- additional API routes (learning routes are mounted here by the entrypoint) ----

  opts.mount?.(app);

  // ---- static assets (public) ---------------------------------------------

  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) => {
    const index = path.join(root, "dist/index.html");
    if (fs.existsSync(index)) res.sendFile(index);
    else res.status(200).type("text").send("REPLAY API is running. Start the frontend on port 5180.");
  });

  // ---- error handler (no request body logging) ----------------------------

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof NativeSessionError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, nativeCode: error.nativeCode, requestId: error.requestId });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof ServiceError) return res.status(error.status).json({error:error.message,...error.extra});
    if (error instanceof TeamError) return res.status(error.status).json({error:error.message});
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Request did not match the expected schema", code: "invalid_request" });
    if (error && typeof error === "object" && (error as { type?: string }).type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON", code: "invalid_request" });
    if (error && typeof error === "object" && (error as { type?: string }).type === "entity.too.large") return res.status(413).json({ error: "Request body too large", code: "invalid_request" });
    const message = String((error as { message?: unknown })?.message ?? "Request failed");
    res.status(400).json({ error: message.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]") });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Identity stored for an unauthenticated native-mode browser session. Never used for authorization. */
function placeholderIdentity(): Identity {
  return { subject: "", name: "Not signed in", role: "intelligence", organization: "", mode: "kamiwaza" };
}

function clientKey(req: express.Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}
