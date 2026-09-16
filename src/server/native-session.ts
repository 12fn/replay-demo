/**
 * Native Kamiwaza session binding for REPLAY.
 *
 * Binds an opaque per-browser session id to a native Kamiwaza login. Tokens are
 * held encrypted at rest (AES-256-GCM, key file 0600 under dataDir) and only
 * decrypted into process memory. Every resolve re-validates against the
 * platform through the signed ForwardAuth path of `src/platform`; nothing here
 * grants identity or role from browser input or from unverified JWT claims.
 *
 * Application behaviour documented here:
 *  - Role mapping (native `effective_workroom_role` -> scenario seat):
 *      owner            -> instructor
 *      editor, operator -> commander
 *      viewer, other    -> intelligence   (least privilege default)
 *  - Operators may tailor the scenario seat per subject through the workroom
 *    attribute `replay_profiles[<subject>] = {role?, name?, organization?}`.
 *    A profile changes only the presented seat, name and organization. Native
 *    `can_edit` / `can_run_agents` (fetched fresh for every write) still gate
 *    actions; a "commander" profile never confers write or agent permission.
 *  - Reads may use a runtime-context cache of at most 5 s and a workroom
 *    attribute cache of at most 30 s. Writes always fetch fresh context.
 *  - Token renewal uses the installed `POST /auth/refresh` which, per the
 *    installed OpenAPI, accepts only a `refresh_token` query parameter. The
 *    request is built privately; the URL never appears in errors or receipts.
 *    Renewal is single-flight per session and triggers within 45 s of expiry.
 *
 * Nothing is logged. No credential, token or signature appears in results,
 * errors or `toJSON()` output.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {requestNativeLogout,type PlatformLogoutResult} from './native-platform-logout';
import {
  KamiwazaClient,
  KamiwazaError,
  decodeJwtClaims,
  redactSecrets,
  type FetchImpl,
  type KamiwazaClientOptions,
  type KamiwazaErrorCode,
  type NativePlatformAdapter,
  type RequestReceipt,
  type TokenResponse,
  type VerifiedIdentity,
  type WorkroomResponse,
  type WorkroomRuntimeContextResponse,
} from "../platform/index.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ScenarioRole = "commander" | "intelligence" | "instructor";

export interface NativeIdentity {
  subject: string;
  name: string;
  role: ScenarioRole;
  organization: string;
  mode: "kamiwaza";
}

/** Public, non-secret view of the native runtime context that authorized this resolve. */
export interface NativeContext {
  workroomId: string;
  workroomName: string | null;
  /** Native `effective_workroom_role`, verbatim. */
  nativeRole: string;
  /** Seat derived from `nativeRole` before any operator profile. */
  mappedRole: ScenarioRole;
  /** True when an operator profile from `attributes.replay_profiles` was applied. */
  profileApplied: boolean;
  accessState: string;
  interactionMode: string;
  lifecycleState: string;
  canEdit: boolean;
  canRunAgents: boolean;
  canShare: boolean;
  readOnlyReason: string | null;
  statusBanner: string | null;
  /** True when the runtime context was fetched for this call rather than served from the read cache. */
  fresh: boolean;
  /** ISO time the runtime context was validated by the platform. */
  validatedAt: string;
}

/** Minimal public metadata about a session. Never contains tokens or signatures. */
export interface NativeSessionMetadata {
  signedIn: boolean;
  subject: string | null;
  username: string | null;
  workroomId: string;
  /** Access token expiry hint (ISO) derived from `expires_in` / JWT `exp`. Informational only. */
  accessExpiresAt: string | null;
  refreshable: boolean;
  binding: "session" | "claim" | "none" | null;
  createdAt: string | null;
}

export interface NativeResolution {
  identity: NativeIdentity;
  context: NativeContext;
  nativeReceipts: RequestReceipt[];
  metadata: NativeSessionMetadata;
}

export interface NativeResolved extends NativeResolution {
  /** Session-scoped platform client. Its token provider follows rotation automatically. */
  platformClient: NativePlatformAdapter;
}

export interface ResolveOptions {
  /** Bypass read caches without requiring or granting write capability. */
  fresh?: boolean;
  requireWrite?: boolean;
  requireAgents?: boolean;
}

export interface NativeSessionsOptions {
  dataDir: string;
  apiBase: string;
  validationApiBase?: string;
  workroomId: string;
  forwardedHost: string;
  fetchImpl?: FetchImpl;
  forwardedProto?: string;
  timeoutMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Client factory override for tests. */
  clientFactory?: (opts: KamiwazaClientOptions) => KamiwazaClient;
}

export type NativeSessionErrorCode =
  | "invalid_request"
  | "signed_out"
  | "login_failed"
  | "forbidden"
  | "workroom_mismatch"
  | "subject_mismatch"
  | "access_blocked"
  | "read_only"
  | "agents_blocked"
  | "platform_unavailable";

export type NativeSessionHttpStatus = 400 | 401 | 403 | 503;

/** Typed, redacted denial. Safe to serialize to a browser. */
export class NativeSessionError extends Error {
  readonly code: NativeSessionErrorCode;
  readonly httpStatus: NativeSessionHttpStatus;
  readonly nativeCode: KamiwazaErrorCode | null;
  readonly requestId: string | null;

  constructor(code: NativeSessionErrorCode, httpStatus: NativeSessionHttpStatus, message: string, init: { nativeCode?: KamiwazaErrorCode; requestId?: string | null } = {}) {
    super(message);
    this.name = "NativeSessionError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.nativeCode = init.nativeCode ?? null;
    this.requestId = init.requestId ?? null;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, httpStatus: this.httpStatus, message: this.message, nativeCode: this.nativeCode, requestId: this.requestId };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ROLE_MAP: Readonly<Record<string, ScenarioRole>> = Object.freeze({
  owner: "instructor",
  editor: "commander",
  operator: "commander",
  viewer: "intelligence",
});
const DEFAULT_ROLE: ScenarioRole = "intelligence";
const SCENARIO_ROLES: readonly ScenarioRole[] = ["commander", "intelligence", "instructor"];

export const CONTEXT_CACHE_MS = 5_000;
export const ATTRIBUTES_CACHE_MS = 30_000;
export const REFRESH_LEAD_MS = 45_000;

const KEY_FILE = "native-sessions.key";
const DB_FILE = "native-sessions.sqlite";
const RECORD_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{8,256}$/;
const BLOCKED_INTERACTION_MODES = new Set(["blocked"]);
const READONLY_INTERACTION_MODES = new Set(["readonly", "read_only", "read-only"]);

// ---------------------------------------------------------------------------
// Internal record shapes
// ---------------------------------------------------------------------------

/** Encrypted at rest. Never leaves the process in plaintext. */
interface SessionRecord {
  v: typeof RECORD_VERSION;
  sessionId: string;
  subject: string;
  username: string;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. Hint only; the platform validates every call. */
  accessExpiresAt: number | null;
  sid: string | null;
  /** How the workroom binding was established: Keycloak session (`session`), re-minted JWT (`claim`), or a PAT (`none`). */
  binding: "session" | "claim" | "none";
  createdAt: string;
  updatedAt: string;
}

interface ContextCacheEntry {
  at: number;
  context: WorkroomRuntimeContextResponse;
  identity: VerifiedIdentity;
  receipt: RequestReceipt;
}

interface AttributesCacheEntry {
  at: number;
  workroom: WorkroomResponse;
  receipt: RequestReceipt;
}

interface LiveSession {
  record: SessionRecord;
  client: KamiwazaClient;
  refreshInFlight: Promise<void> | null;
  contextCache: ContextCacheEntry | null;
  attributesCache: AttributesCacheEntry | null;
}

interface Profile {
  role: ScenarioRole | null;
  name: string | null;
  organization: string | null;
}

// ---------------------------------------------------------------------------
// NativeSessions
// ---------------------------------------------------------------------------

export class NativeSessions {
  readonly dataDir: string;
  readonly apiBase: string;
  readonly validationApiBase: string | undefined;
  readonly workroomId: string;
  readonly forwardedHost: string;
  readonly forwardedProto: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly clientFactory: (opts: KamiwazaClientOptions) => KamiwazaClient;
  private readonly key: Buffer;
  private readonly db: DatabaseSync;
  private readonly live = new Map<string, LiveSession>();
  private closed = false;

  constructor(opts: NativeSessionsOptions) {
    if (!opts || typeof opts !== "object") throw new NativeSessionError("invalid_request", 400, "NativeSessions options are required");
    for (const field of ["dataDir", "apiBase", "workroomId", "forwardedHost"] as const) {
      if (typeof opts[field] !== "string" || opts[field].trim().length === 0) {
        throw new NativeSessionError("invalid_request", 400, `NativeSessions requires ${field}`);
      }
    }
    this.dataDir = opts.dataDir;
    this.apiBase = opts.apiBase.trim().replace(/\/+$/, "");
    this.validationApiBase=opts.validationApiBase;
    this.workroomId = opts.workroomId.trim();
    this.forwardedHost = opts.forwardedHost.trim();
    this.forwardedProto = opts.forwardedProto ?? "https";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.clientFactory = opts.clientFactory ?? ((o) => new KamiwazaClient(o));
    // Validate platform configuration eagerly so misconfiguration fails at construction.
    this.clientFactory(this.clientOptions(() => "unused-config-probe-token"));

    fs.mkdirSync(this.dataDir, { recursive: true });
    this.key = loadOrCreateKey(path.join(this.dataDir, KEY_FILE));
    this.db = new DatabaseSync(path.join(this.dataDir, DB_FILE));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS native_session_tokens(
        session_id TEXT PRIMARY KEY,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        tag BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );`);
  }

  /** Configuration only. Never credentials or session material. */
  toJSON(): Record<string, unknown> {
    return { apiBase: this.apiBase, workroomId: this.workroomId, forwardedHost: this.forwardedHost, forwardedProto: this.forwardedProto, timeoutMs: this.timeoutMs, sessions: this.live.size };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Authenticate native credentials for a browser session. Credentials live
   * only in this call's frame; they are neither stored nor logged.
   */
  async login(sessionId: string, credentials: { username: string; password: string }): Promise<NativeResolution> {
    this.assertOpen();
    const id = assertSessionId(sessionId);
    if (!credentials || typeof credentials.username !== "string" || credentials.username.trim().length === 0 || typeof credentials.password !== "string" || credentials.password.length === 0) {
      throw new NativeSessionError("invalid_request", 400, "username and password are required");
    }
    const username = credentials.username.trim();
    const bootstrap = this.clientFactory(this.clientOptions(() => ""));
    let tokens: TokenResponse;
    try {
      tokens = (await bootstrap.login({ username, password: credentials.password })).data;
    } catch (err) {
      throw this.classify(err, [credentials.password], { loginFailure: true });
    }
    return this.establish(id, tokens.access_token, tokens.refresh_token ?? null, expiresAtFrom(tokens, this.now()), username);
  }

  /**
   * Operator qualification only: bind an already-issued native token (login
   * session or PAT) to a session id. Not a public API; main must not route it
   * to browsers.
   */
  async attachToken(sessionId: string, sessionToken: string): Promise<NativeResolution> {
    this.assertOpen();
    const id = assertSessionId(sessionId);
    if (typeof sessionToken !== "string" || sessionToken.trim().length < 16) {
      throw new NativeSessionError("invalid_request", 400, "a native bearer token is required");
    }
    const token = sessionToken.trim();
    return this.establish(id, token, null, jwtExpiryHint(token), null);
  }

  /** Accept only the platform's cookie bearer; Core verifies it before any identity is adopted. */
  async acceptPlatformSession(sessionId:string,sessionToken:string):Promise<NativeResolution>{
    return this.attachToken(sessionId,sessionToken);
  }

  /**
   * Resolve a session to a platform-verified identity and runtime context.
   * Writes and agent runs always fetch fresh native context and are gated by
   * native `can_edit` / `can_run_agents`; reads may use a short cache.
   */
  async resolve(sessionId: string, opts: ResolveOptions = {}): Promise<NativeResolved> {
    this.assertOpen();
    const id = assertSessionId(sessionId);
    const session = this.load(id);
    if (!session) throw new NativeSessionError("signed_out", 401, "no native session; sign in to Kamiwaza");
    const receipts: RequestReceipt[] = [];
    const requireWrite = opts.requireWrite === true;
    const requireAgents = opts.requireAgents === true;
    const mustBeFresh = opts.fresh === true || requireWrite || requireAgents;

    await this.ensureFreshToken(id, session);

    let ctx: ContextCacheEntry;
    let fresh: boolean;
    const cached = session.contextCache;
    if (!mustBeFresh && cached && this.now() - cached.at <= CONTEXT_CACHE_MS) {
      ctx = cached;
      fresh = false;
    } else {
      ctx = await this.fetchContext(id, session);
      fresh = true;
      receipts.push(ctx.receipt);
    }
    this.assertScope(id, session, ctx.identity, ctx.context);

    const context = ctx.context;
    if (BLOCKED_INTERACTION_MODES.has(context.interaction_mode) || context.access_state === "archived" || context.access_state === "unbound") {
      throw new NativeSessionError("access_blocked", 403, `native workroom access is ${context.access_state} (${context.interaction_mode})`, { requestId: ctx.receipt.requestId });
    }
    const canEdit = context.can_edit === true && context.access_state === "active" && !READONLY_INTERACTION_MODES.has(context.interaction_mode);
    const canRunAgents = context.can_run_agents === true && canEdit;
    if (requireWrite && !canEdit) {
      throw new NativeSessionError("read_only", 403, `native workroom context does not permit writes (${context.read_only_reason ?? context.interaction_mode})`, { requestId: ctx.receipt.requestId });
    }
    if (requireAgents && !canRunAgents) {
      throw new NativeSessionError("agents_blocked", 403, "native workroom context does not permit running agents", { requestId: ctx.receipt.requestId });
    }

    const attrs = await this.workroomAttributes(id, session, mustBeFresh, receipts);
    const mappedRole = ROLE_MAP[context.effective_workroom_role] ?? DEFAULT_ROLE;
    const profile = readProfile(attrs?.workroom.attributes, session.record.subject);
    const identity: NativeIdentity = {
      subject: session.record.subject,
      name: profile.name ?? session.record.displayName,
      role: profile.role === "instructor" && mappedRole !== "instructor" ? mappedRole : profile.role ?? mappedRole,
      organization: profile.organization ?? attrs?.workroom.name ?? "Kamiwaza workroom",
      mode: "kamiwaza",
    };
    const publicContext: NativeContext = {
      workroomId: context.workroom_id,
      workroomName: attrs?.workroom.name ?? null,
      nativeRole: context.effective_workroom_role,
      mappedRole,
      profileApplied: profile.role !== null || profile.name !== null || profile.organization !== null,
      accessState: context.access_state,
      interactionMode: context.interaction_mode,
      lifecycleState: context.workroom_lifecycle_state,
      canEdit,
      canRunAgents,
      canShare: context.can_share === true,
      readOnlyReason: context.read_only_reason ?? null,
      statusBanner: context.status_banner ?? null,
      fresh,
      validatedAt: ctx.receipt.validatedAt,
    };
    return { identity, context: publicContext, nativeReceipts: receipts, metadata: this.metadataOf(session.record), platformClient: session.client };
  }

  /** Public metadata for a session. Never tokens or signatures. */
  metadata(sessionId: string): NativeSessionMetadata {
    this.assertOpen();
    const session = this.load(assertSessionId(sessionId));
    return session ? this.metadataOf(session.record) : { signedIn: false, subject: null, username: null, workroomId: this.workroomId, accessExpiresAt: null, refreshable: false, binding: null, createdAt: null };
  }

  /** Forget the session locally. Native tokens are discarded from memory and disk. */
  logout(sessionId: string): void {
    this.assertOpen();
    this.forget(assertSessionId(sessionId));
  }

  /** Uses the browser's native cookie set privately; never returns tokens or native redirect URLs. */
  async logoutPlatform(cookieHeader:string):Promise<PlatformLogoutResult> {
    this.assertOpen();
    return requestNativeLogout({apiBase:this.validationApiBase??this.apiBase,forwardedHost:this.forwardedHost,forwardedProto:this.forwardedProto,cookieHeader,fetchImpl:this.fetchImpl,timeoutMs:this.timeoutMs});
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.live.values()) wipe(s.record);
    this.live.clear();
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Establishing a session
  // -------------------------------------------------------------------------

  private async establish(id: string, initialToken: string, refreshToken: string | null, accessExpiresAt: number | null, username: string | null): Promise<NativeResolution> {
    const holder = { token: initialToken };
    const client = this.clientFactory(this.clientOptions(() => holder.token));
    const receipts: RequestReceipt[] = [];
    const secrets = [initialToken, refreshToken];
    try {
      // 1. Signed identity from the platform. `me` must agree with the ForwardAuth identity.
      const me = await client.me();
      receipts.push(me.receipt);
      if (me.identity.userId !== me.data.sub) {
        throw new NativeSessionError("subject_mismatch", 403, "signed identity does not match the platform user record", { requestId: me.receipt.requestId });
      }
      const subject = me.identity.userId;

      // 2. Workroom binding. Login sessions (sid) bind through enter; PATs cannot and are validated by scope alone.
      const claims = decodeJwtClaims(holder.token);
      const sid = typeof claims?.sid === "string" && claims.sid.length > 0 ? claims.sid : null;
      let binding: SessionRecord["binding"] = "none";
      if (sid) {
        const entered = await client.enterWorkroom(this.workroomId, { sessionToken: holder.token });
        receipts.push(entered.receipt);
        if (entered.data.workroom_id !== this.workroomId) {
          throw new NativeSessionError("workroom_mismatch", 403, "platform bound the session to a different workroom than configured", { requestId: entered.receipt.requestId });
        }
        if (typeof entered.data.access_token === "string" && entered.data.access_token.length > 0) {
          holder.token = entered.data.access_token;
          secrets.push(holder.token);
          binding = "claim";
          if (typeof entered.data.expires_in === "number") accessExpiresAt = this.now() + entered.data.expires_in * 1_000;
        } else {
          binding = "session";
        }
      }

      // 3. Runtime context must confirm workroom and subject.
      const ctx = await client.workroomContext(this.workroomId);
      receipts.push(ctx.receipt);
      const record: SessionRecord = {
        v: RECORD_VERSION,
        sessionId: id,
        subject,
        username: me.data.username,
        displayName: me.identity.userName ?? me.data.username,
        accessToken: holder.token,
        refreshToken,
        accessExpiresAt,
        sid,
        binding,
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };
      const session = this.liveSession(id, record);
      this.assertScope(id, session, ctx.identity, ctx.data);

      // 4. Persist encrypted, then answer through the normal resolve path (read cache primed).
      const prior = this.live.get(id);
      if (prior) wipe(prior.record);
      this.live.set(id, session);
      this.persist(record);
      session.contextCache = { at: this.now(), context: ctx.data, identity: ctx.identity, receipt: ctx.receipt };
      const resolved = await this.resolve(id);
      return { identity: resolved.identity, context: resolved.context, nativeReceipts: [...receipts, ...resolved.nativeReceipts], metadata: resolved.metadata };
    } catch (err) {
      throw this.classify(err, secrets);
    } finally {
      holder.token = "";
    }
  }

  // -------------------------------------------------------------------------
  // Scope and subject consistency
  // -------------------------------------------------------------------------

  private assertScope(id: string, session: LiveSession, identity: VerifiedIdentity, context: WorkroomRuntimeContextResponse): void {
    const subject = session.record.subject;
    if (identity.userId !== subject || context.user_id !== subject) {
      this.forget(id);
      throw new NativeSessionError("subject_mismatch", 403, "platform identity no longer matches the bound session subject; signed out");
    }
    if (identity.workroomId !== this.workroomId || context.workroom_id !== this.workroomId) {
      throw new NativeSessionError("workroom_mismatch", 403, "platform signed a workroom scope that differs from the configured workroom");
    }
  }

  // -------------------------------------------------------------------------
  // Platform fetches with one auth-retry via refresh
  // -------------------------------------------------------------------------

  private async fetchContext(id: string, session: LiveSession): Promise<ContextCacheEntry> {
    let res;
    try{res=await this.withAuthRetry(id, session, () => session.client.workroomContext(this.workroomId));}
    catch(error){session.contextCache=null;session.attributesCache=null;throw error;}
    const entry: ContextCacheEntry = { at: this.now(), context: res.data, identity: res.identity, receipt: res.receipt };
    session.contextCache = entry;
    return entry;
  }

  private async workroomAttributes(id: string, session: LiveSession, fresh: boolean, receipts: RequestReceipt[]): Promise<AttributesCacheEntry | null> {
    const cached = session.attributesCache;
    if (!fresh && cached && this.now() - cached.at <= ATTRIBUTES_CACHE_MS) return cached;
    const res = await this.withAuthRetry(id, session, () => session.client.workroom(this.workroomId));
    if (res.identity.userId !== session.record.subject) {
      this.forget(id);
      throw new NativeSessionError("subject_mismatch", 403, "platform identity no longer matches the bound session subject; signed out");
    }
    if (res.data.id !== this.workroomId) {
      throw new NativeSessionError("workroom_mismatch", 403, "platform returned a different workroom than configured", { requestId: res.receipt.requestId });
    }
    const entry: AttributesCacheEntry = { at: this.now(), workroom: res.data, receipt: res.receipt };
    session.attributesCache = entry;
    receipts.push(res.receipt);
    return entry;
  }

  /** Run a signed call; on a native 401 try one refresh and retry; a second 401 signs the session out. */
  private async withAuthRetry<T>(id: string, session: LiveSession, call: () => Promise<T>): Promise<T> {
    const secrets = () => [session.record.accessToken, session.record.refreshToken];
    try {
      return await call();
    } catch (first) {
      if (!isNative401(first)) throw this.classify(first, secrets());
      if (!session.record.refreshToken) {
        this.forget(id);
        throw new NativeSessionError("signed_out", 401, "native platform rejected the session token and no renewal is possible; signed out", { nativeCode: (first as KamiwazaError).code });
      }
      await this.refresh(id, session);
      try {
        return await call();
      } catch (second) {
        if (isNative401(second)) {
          this.forget(id);
          throw new NativeSessionError("signed_out", 401, "native platform rejected the renewed session token; signed out", { nativeCode: (second as KamiwazaError).code });
        }
        throw this.classify(second, secrets());
      }
    }
  }

  // -------------------------------------------------------------------------
  // Renewal
  // -------------------------------------------------------------------------

  private async ensureFreshToken(id: string, session: LiveSession): Promise<void> {
    const { accessExpiresAt, refreshToken } = session.record;
    if (accessExpiresAt === null) return;
    const remaining = accessExpiresAt - this.now();
    if (remaining > REFRESH_LEAD_MS) return;
    if (!refreshToken) {
      if (remaining <= 0) {
        this.forget(id);
        throw new NativeSessionError("signed_out", 401, "native session expired and cannot be renewed; sign in again");
      }
      return; // Platform will decide on the next call.
    }
    await this.refresh(id, session);
  }

  /** Single-flight per session. Rotated tokens replace both access and refresh tokens. */
  private refresh(id: string, session: LiveSession): Promise<void> {
    if (session.refreshInFlight) return session.refreshInFlight;
    const run = this.refreshOnce(id, session).finally(() => {
      session.refreshInFlight = null;
    });
    session.refreshInFlight = run;
    return run;
  }

  private async refreshOnce(id: string, session: LiveSession): Promise<void> {
    const oldRefresh = session.record.refreshToken;
    const oldAccess = session.record.accessToken;
    if (!oldRefresh) {
      this.forget(id);
      throw new NativeSessionError("signed_out", 401, "native session cannot be renewed; sign in again");
    }
    let tokens: TokenResponse;
    try {
      tokens = await this.refreshHttp(oldRefresh, [oldAccess]);
    } catch (err) {
      if (err instanceof NativeSessionError) {
        if (err.httpStatus === 401 || err.httpStatus === 403) this.forget(id);
        throw err;
      }
      throw err;
    }
    const r = session.record;
    r.accessToken = tokens.access_token;
    r.refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0 ? tokens.refresh_token : oldRefresh;
    r.accessExpiresAt = expiresAtFrom(tokens, this.now());
    r.updatedAt = new Date(this.now()).toISOString();
    session.contextCache = null;

    // Preserve workroom binding when the renewed token no longer carries it.
    const claims = decodeJwtClaims(r.accessToken);
    const newSid = typeof claims?.sid === "string" && claims.sid.length > 0 ? claims.sid : null;
    const needsEnter =
      (r.binding === "session" && newSid !== null && newSid !== r.sid) ||
      (r.binding === "claim" && claims !== null && claims.workroom_id !== this.workroomId);
    if (needsEnter && newSid) {
      let entered: Awaited<ReturnType<KamiwazaClient["enterWorkroom"]>>;
      try {
        entered = await session.client.enterWorkroom(this.workroomId, { sessionToken: r.accessToken });
      } catch (err) {
        throw this.classify(err, [r.accessToken, r.refreshToken]);
      }
      if (entered.data.workroom_id !== this.workroomId) {
        this.forget(id);
        throw new NativeSessionError("workroom_mismatch", 403, "platform rebound the renewed session to a different workroom; signed out");
      }
      if (typeof entered.data.access_token === "string" && entered.data.access_token.length > 0) {
        r.accessToken = entered.data.access_token;
        if (typeof entered.data.expires_in === "number") r.accessExpiresAt = this.now() + entered.data.expires_in * 1_000;
      }
    }
    r.sid = newSid ?? r.sid;
    this.persist(r);
  }

  /**
   * Private renewal call. The installed OpenAPI declares `POST /auth/refresh`
   * with `refresh_token` as a query parameter and no body or cookie form, so
   * the token must travel in the URL. The URL is built here and discarded;
   * errors carry only the target label `POST /auth/refresh`.
   */
  private async refreshHttp(refreshToken: string, extraSecrets: readonly (string | null)[]): Promise<TokenResponse> {
    const target = "POST /auth/refresh";
    const secrets = [refreshToken, ...extraSecrets];
    const query = new URLSearchParams({ refresh_token: refreshToken });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.apiBase}/auth/refresh?${query.toString()}`, {
          method: "POST",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new NativeSessionError("platform_unavailable", 503, `native renewal timed out (${target})`);
        const reason = err instanceof Error ? redactSecrets(err.message, secrets) : "unknown error";
        throw new NativeSessionError("platform_unavailable", 503, `native renewal failed before a response (${target}): ${reason.slice(0, 120)}`);
      }
      const requestId = response.headers.get("x-request-id");
      let body: unknown = null;
      try {
        const text = await response.text();
        body = text.length ? JSON.parse(text) : null;
      } catch {
        if (controller.signal.aborted) throw new NativeSessionError("platform_unavailable", 503, `native renewal timed out (${target})`, { requestId });
        if (response.ok) throw new NativeSessionError("platform_unavailable", 503, `native renewal returned a non-JSON body (${target})`, { requestId });
      }
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new NativeSessionError("signed_out", 401, "native platform rejected the renewal; sign in again", { requestId });
      }
      if (!response.ok) {
        throw new NativeSessionError("platform_unavailable", 503, `native renewal failed with HTTP ${response.status} (${target})`, { requestId });
      }
      const rec = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      if (!rec || typeof rec.access_token !== "string" || rec.access_token.length === 0 || !Number.isFinite(rec.expires_in)) {
        throw new NativeSessionError("platform_unavailable", 503, `native renewal returned a malformed token response (${target})`, { requestId });
      }
      return rec as unknown as TokenResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Error classification
  // -------------------------------------------------------------------------

  private classify(err: unknown, secrets: readonly (string | null | undefined)[], opts: { loginFailure?: boolean } = {}): NativeSessionError {
    if (err instanceof NativeSessionError) return err;
    if (err instanceof KamiwazaError) {
      const requestId = err.requestId;
      const init = { nativeCode: err.code, requestId };
      if (opts.loginFailure) {
        if (err.code === "http_error" && (err.httpStatus === 400 || err.httpStatus === 401 || err.httpStatus === 403)) {
          return new NativeSessionError("login_failed", 401, "native login rejected the credentials", init);
        }
        if (err.code === "invalid_request") return new NativeSessionError("invalid_request", 400, redactSecrets(err.message, secrets), init);
        return new NativeSessionError("platform_unavailable", 503, `native login unavailable (${err.code})`, init);
      }
      switch (err.code) {
        case "auth_denied":
          return err.httpStatus === 403
            ? new NativeSessionError("forbidden", 403, `native platform denied ${err.target ?? "the request"}`, init)
            : new NativeSessionError("signed_out", 401, "native platform rejected the session token; sign in again", init);
        case "http_error":
          // Installed 1.2 returns 404/409 here for revoked access, terminated
          // runtime sessions or context conflicts. Do not mislabel these as outages
          // or silently re-enter/retry an action after a native role change.
          if(err.target===`GET /workrooms/${this.workroomId}/runtime/context`&&(err.httpStatus===404||err.httpStatus===409))return new NativeSessionError("access_blocked",403,"Kamiwaza no longer authorizes this workroom session. Sign in again to resolve your current access.",init);
          if (err.httpStatus === 401) return new NativeSessionError("signed_out", 401, "native platform rejected the session token; sign in again", init);
          if (err.httpStatus === 403) return new NativeSessionError("forbidden", 403, `native platform denied ${err.target ?? "the request"}`, init);
          return new NativeSessionError("platform_unavailable", 503, `native platform error HTTP ${err.httpStatus} on ${err.target ?? "request"}`, init);
        case "session_required":
        case "missing_credentials":
          return new NativeSessionError("signed_out", 401, "a native login session is required", init);
        case "invalid_request":
        case "invalid_config":
        case "forged_header":
          return new NativeSessionError("invalid_request", 400, redactSecrets(err.message, secrets), init);
        default:
          return new NativeSessionError("platform_unavailable", 503, `native platform unavailable (${err.code})`, init);
      }
    }
    const message = err instanceof Error ? redactSecrets(err.message, secrets) : "unknown error";
    return new NativeSessionError("platform_unavailable", 503, `native session failure: ${message.slice(0, 160)}`);
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private clientOptions(getToken: () => string): KamiwazaClientOptions {
    return { apiBase: this.apiBase, validationApiBase:this.validationApiBase, getToken, fetchImpl: this.fetchImpl, forwardedHost: this.forwardedHost, forwardedProto: this.forwardedProto, timeoutMs: this.timeoutMs, workroomId: this.workroomId };
  }

  private load(id: string): LiveSession | null {
    const existing = this.live.get(id);
    if (existing) return existing;
    const row = this.db.prepare("SELECT nonce, ciphertext, tag FROM native_session_tokens WHERE session_id = ?").get(id) as { nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array } | undefined;
    if (!row) return null;
    let record: SessionRecord;
    try {
      record = decryptRecord(this.key, id, Buffer.from(row.nonce), Buffer.from(row.ciphertext), Buffer.from(row.tag));
    } catch {
      // Tampered, foreign-key or corrupt row: treat as signed out and drop it.
      this.db.prepare("DELETE FROM native_session_tokens WHERE session_id = ?").run(id);
      return null;
    }
    const session = this.liveSession(id, record);
    this.live.set(id, session);
    return session;
  }

  /**
   * Build the in-memory session with a client whose token provider follows
   * rotation and renews transparently before each call. Renewal failures are
   * left for the platform to adjudicate on the call itself so that the
   * adapter's error classification stays intact.
   */
  private liveSession(id: string, record: SessionRecord): LiveSession {
    const session: LiveSession = { record, client: undefined as unknown as KamiwazaClient, refreshInFlight: null, contextCache: null, attributesCache: null };
    session.client = this.clientFactory({
      ...this.clientOptions(() => ""),
      getToken: async () => {
        try {
          await this.ensureFreshToken(id, session);
        } catch {
          /* platform validates the current token on the call */
        }
        return session.record.accessToken;
      },
    });
    return session;
  }

  private persist(record: SessionRecord): void {
    const { nonce, ciphertext, tag } = encryptRecord(this.key, record);
    this.db
      .prepare("INSERT INTO native_session_tokens(session_id, nonce, ciphertext, tag, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET nonce=excluded.nonce, ciphertext=excluded.ciphertext, tag=excluded.tag, updated_at=excluded.updated_at")
      .run(record.sessionId, nonce, ciphertext, tag, record.updatedAt);
  }

  private forget(id: string): void {
    const s = this.live.get(id);
    if (s) wipe(s.record);
    this.live.delete(id);
    this.db.prepare("DELETE FROM native_session_tokens WHERE session_id = ?").run(id);
  }

  private metadataOf(r: SessionRecord): NativeSessionMetadata {
    return {
      signedIn: true,
      subject: r.subject,
      username: r.username,
      workroomId: this.workroomId,
      accessExpiresAt: r.accessExpiresAt === null ? null : new Date(r.accessExpiresAt).toISOString(),
      refreshable: r.refreshToken !== null,
      binding: r.binding,
      createdAt: r.createdAt,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new NativeSessionError("platform_unavailable", 503, "native session store is closed");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertSessionId(sessionId: string): string {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new NativeSessionError("invalid_request", 400, "sessionId must be an opaque identifier of 8 to 256 URL-safe characters");
  }
  return sessionId;
}

function isNative401(err: unknown): err is KamiwazaError {
  return err instanceof KamiwazaError && ((err.code === "auth_denied" && err.httpStatus === 401) || (err.code === "http_error" && err.httpStatus === 401));
}

/** JWT `exp` used only as a renewal hint. Never as proof of identity. */
function jwtExpiryHint(token: string): number | null {
  const claims = decodeJwtClaims(token);
  const exp = claims?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : null;
}

function expiresAtFrom(tokens: TokenResponse, now: number): number | null {
  const fromResponse = Number.isFinite(tokens.expires_in) ? now + tokens.expires_in * 1_000 : null;
  const fromJwt = jwtExpiryHint(tokens.access_token);
  if (fromResponse === null) return fromJwt;
  if (fromJwt === null) return fromResponse;
  return Math.min(fromResponse, fromJwt);
}

function readProfile(attributes: Record<string, unknown> | null | undefined, subject: string): Profile {
  const none: Profile = { role: null, name: null, organization: null };
  if (!attributes || typeof attributes !== "object") return none;
  const profiles = attributes.replay_profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return none;
  if (!Object.prototype.hasOwnProperty.call(profiles, subject)) return none;
  const p = (profiles as Record<string, unknown>)[subject];
  if (!p || typeof p !== "object" || Array.isArray(p)) return none;
  const rec = p as Record<string, unknown>;
  const role = typeof rec.role === "string" && SCENARIO_ROLES.includes(rec.role as ScenarioRole) ? (rec.role as ScenarioRole) : null;
  const name = typeof rec.name === "string" && rec.name.trim().length > 0 ? rec.name.trim().slice(0, 120) : null;
  const organization = typeof rec.organization === "string" && rec.organization.trim().length > 0 ? rec.organization.trim().slice(0, 160) : null;
  return { role, name, organization };
}

function wipe(record: SessionRecord): void {
  record.accessToken = "";
  record.refreshToken = null;
}

// AES-256-GCM at rest. AAD binds the ciphertext to its session id so rows cannot be swapped.

function loadOrCreateKey(file: string): Buffer {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new NativeSessionError("platform_unavailable", 503, "native session key file is malformed");
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) fs.chmodSync(file, 0o600);
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString("base64"), { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  return key;
}

function encryptRecord(key: Buffer, record: SessionRecord): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(record.sessionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

function decryptRecord(key: Buffer, sessionId: string, nonce: Buffer, ciphertext: Buffer, tag: Buffer): SessionRecord {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad(sessionId));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  const rec = JSON.parse(plain) as SessionRecord;
  if (rec.v !== RECORD_VERSION || typeof rec.accessToken !== "string" || typeof rec.subject !== "string") throw new Error("unsupported record");
  const idA = Buffer.from(rec.sessionId);
  const idB = Buffer.from(sessionId);
  if (idA.length !== idB.length || !timingSafeEqual(idA, idB)) throw new Error("session id mismatch");
  return rec;
}

function aad(sessionId: string): Buffer {
  return Buffer.from(`replay-native-session:v${RECORD_VERSION}:${sessionId}`, "utf8");
}
