/**
 * Request-scoped native bearer resolution for the REPLAY MCP surface.
 *
 * Tomo (Kaizen 0.4.1) forwards the calling member's own platform bearer and an
 * `x-workroom-id` header to `POST /mcp` (docs/process/tomo-native-contract.md §1,
 * tomo-auth-registration-contract.md §3). This module turns those two inbound
 * values into the same `NativeIdentity` / `NativeContext` pair that
 * `NativeSessions.resolve()` produces for a browser session, with these
 * deliberate differences:
 *
 *  - No session. Nothing is written to `NativeSessions`, to disk, or to any
 *    cache. The token lives in one closure for the duration of one call and is
 *    blanked in `finally`.
 *  - No login, no `POST /auth/refresh`, no `POST /workrooms/{id}/enter`, and no
 *    owner or service credential. An expired or rejected bearer is a 401 for
 *    this call; Tomo surfaces the tool error and the member re-authenticates
 *    with the platform, not with REPLAY.
 *  - Reads only. `can_edit` / `can_run_agents` are reported but never required.
 *
 * Identity is derived solely from the platform-signed ForwardAuth headers that
 * the adapter copies on `GET /workrooms/{id}/runtime/context`, cross-checked
 * against the context body, exactly as `NativeSessions.assertScope` does.
 * Inbound `x-user-*`, `x-auth-*`, `x-forwarded-*` and `cookie` headers are
 * never read for identity; the adapter refuses to forward caller-supplied ones.
 *
 * Role mapping and operator profiles (`attributes.replay_profiles`) follow
 * `native-session.ts` byte for byte: a profile never promotes a non-owner to
 * the instructor seat.
 *
 * Nothing is logged. No token, signature or header value appears in errors.
 */
import {
  KamiwazaClient,
  KamiwazaError,
  redactSecrets,
  type FetchImpl,
  type KamiwazaClientOptions,
  type KamiwazaErrorCode,
  type RequestReceipt,
  type VerifiedIdentity,
  type WorkroomResponse,
  type WorkroomRuntimeContextResponse,
} from "../platform/index.ts";
import { NativeSessionError, ROLE_MAP, type NativeContext, type NativeIdentity, type ScenarioRole } from "./native-session.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpAuthOptions {
  /** Platform API base ending in `/api` (same value as `REPLAY_KAMIWAZA_API`). */
  apiBase: string;
  validationApiBase?:string;
  /** The single workroom this deployment serves (`REPLAY_WORKROOM_ID`). */
  workroomId: string;
  /** `X-Forwarded-Host` for ForwardAuth (`REPLAY_FORWARDED_HOST`). */
  forwardedHost: string;
  forwardedProto?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  /** Client factory override for tests. */
  clientFactory?: (opts: KamiwazaClientOptions) => KamiwazaClient;
  /** Installation-scoped exact-token refusal; does not replace native identity/workroom validation. */
  assertTokenAllowed?: (token:string)=>void;
}

/** Inbound header view. Only `authorization` and `x-workroom-id` are ever read. */
export type InboundHeaders = Record<string, string | string[] | undefined>;

/** What one authenticated MCP request runs as. Contains no credential and is safe to serialize. */
export interface McpPrincipal {
  identity: NativeIdentity;
  context: NativeContext;
  nativeReceipts: RequestReceipt[];
}

export type McpAuthErrorCode =
  | "missing_bearer"
  | "workroom_mismatch"
  | "subject_mismatch"
  | "access_blocked"
  | "forbidden"
  | "token_rejected"
  | "invalid_request"
  | "platform_unavailable";

export type McpAuthHttpStatus = 400 | 401 | 403 | 503;

/** Typed, redacted denial. Safe to return to the MCP client. */
export class McpAuthError extends Error {
  readonly code: McpAuthErrorCode;
  readonly httpStatus: McpAuthHttpStatus;
  readonly nativeCode: KamiwazaErrorCode | null;
  readonly requestId: string | null;
  constructor(code: McpAuthErrorCode, httpStatus: McpAuthHttpStatus, message: string, init: { nativeCode?: KamiwazaErrorCode; requestId?: string | null } = {}) {
    super(message);
    this.name = "McpAuthError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.nativeCode = init.nativeCode ?? null;
    this.requestId = init.requestId ?? null;
  }
  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, httpStatus: this.httpStatus, message: this.message, nativeCode: this.nativeCode, requestId: this.requestId };
  }
}

/** Structural port so routes and tests can substitute a scripted resolver. */
export interface McpAuthPort {
  readonly workroomId: string;
  resolve(headers: InboundHeaders): Promise<McpPrincipal>;
}

// ---------------------------------------------------------------------------
// Constants (mirroring native-session.ts)
// ---------------------------------------------------------------------------

const DEFAULT_ROLE: ScenarioRole = "intelligence";
const SCENARIO_ROLES: readonly ScenarioRole[] = ["commander", "intelligence", "instructor"];
const BLOCKED_INTERACTION_MODES = new Set(["blocked"]);
const READONLY_INTERACTION_MODES = new Set(["readonly", "read_only", "read-only"]);
/** Same ceiling as `verifyGraphitiWorkload`; a longer header is not a plausible platform token. */
const MAX_AUTHORIZATION_LENGTH = 16_384;
const WORKROOM_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;

interface Profile {
  role: ScenarioRole | null;
  name: string | null;
  organization: string | null;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export class McpBearerResolver implements McpAuthPort {
  readonly apiBase: string;
  readonly validationApiBase:string|undefined;
  readonly workroomId: string;
  readonly forwardedHost: string;
  readonly forwardedProto: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl | undefined;
  private readonly clientFactory: (opts: KamiwazaClientOptions) => KamiwazaClient;
  private readonly assertTokenAllowed:((token:string)=>void)|undefined;

  constructor(opts: McpAuthOptions) {
    if (!opts || typeof opts !== "object") throw new McpAuthError("invalid_request", 400, "MCP auth options are required");
    for (const field of ["apiBase", "workroomId", "forwardedHost"] as const) {
      if (typeof opts[field] !== "string" || opts[field].trim().length === 0) throw new McpAuthError("invalid_request", 400, `MCP auth requires ${field}`);
    }
    this.apiBase = opts.apiBase.trim().replace(/\/+$/, "");
    this.validationApiBase=opts.validationApiBase;
    this.workroomId = opts.workroomId.trim();
    if (!WORKROOM_PATTERN.test(this.workroomId)) throw new McpAuthError("invalid_request", 400, "MCP auth workroomId is not a plausible workroom identifier");
    this.forwardedHost = opts.forwardedHost.trim();
    this.forwardedProto = opts.forwardedProto ?? "https";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl;
    this.assertTokenAllowed=opts.assertTokenAllowed;
    this.clientFactory = opts.clientFactory ?? ((o) => new KamiwazaClient(o));
    // Fail at construction on a malformed platform configuration, like NativeSessions does.
    this.clientFactory(this.clientOptions(() => "unused-config-probe-token"));
  }

  /** Configuration only. Never credentials. */
  toJSON(): Record<string, unknown> {
    return { apiBase: this.apiBase, workroomId: this.workroomId, forwardedHost: this.forwardedHost, forwardedProto: this.forwardedProto, timeoutMs: this.timeoutMs };
  }

  /**
   * Resolve one inbound request. Order of checks:
   *  1. bearer present (no network otherwise),
   *  2. `x-workroom-id` equals the configured workroom (no network otherwise),
   *  3. signed runtime context for that workroom, scope cross-checked,
   *  4. access state not blocked,
   *  5. workroom attributes for the operator profile (always fresh),
   *  6. token blanked.
   */
  async resolve(headers: InboundHeaders): Promise<McpPrincipal> {
    const holder = { token: extractBearer(headers) };
    const secrets: (string | null | undefined)[] = [holder.token];
    const checkToken=()=>{try{this.assertTokenAllowed?.(holder.token);}catch(err){const refused=err instanceof NativeSessionError&&err.httpStatus===401;throw new McpAuthError(refused?'token_rejected':'platform_unavailable',refused?401:503,refused?'This token was refused by REPLAY; sign in again':'Native session safety storage is unavailable');}};
    try {
      checkToken();
      const requested = extractWorkroom(headers);
      if (requested !== this.workroomId) {
        throw new McpAuthError("workroom_mismatch", 403, requested === null ? "x-workroom-id is required and must name the workroom this REPLAY instance serves" : "x-workroom-id does not name the workroom this REPLAY instance serves");
      }
      const client = this.clientFactory(this.clientOptions(() => holder.token));
      const receipts: RequestReceipt[] = [];

      // 3. One signed call proves: bearer valid to Core, subject is a member, platform-signed scope.
      let ctx;
      try {
        ctx = await client.workroomContext(this.workroomId);
        checkToken();
      } catch (err) {
        throw this.classify(err, secrets);
      }
      receipts.push(ctx.receipt);
      const subject = this.assertScope(ctx.identity, ctx.data, ctx.receipt.requestId);

      // 4. Blocked contexts deny even reads, exactly as NativeSessions.resolve does.
      const context = ctx.data;
      if (BLOCKED_INTERACTION_MODES.has(context.interaction_mode) || context.access_state === "archived" || context.access_state === "unbound") {
        throw new McpAuthError("access_blocked", 403, "Native workroom access is blocked", { requestId: ctx.receipt.requestId });
      }
      const canEdit = context.can_edit === true && context.access_state === "active" && !READONLY_INTERACTION_MODES.has(context.interaction_mode);
      const canRunAgents = context.can_run_agents === true && canEdit;

      // 5. Operator profile from workroom attributes; fresh every call (no per-token cache may exist).
      let workroom: WorkroomResponse;
      let attrsReceipt: RequestReceipt;
      try {
        const res = await client.workroom(this.workroomId);
        checkToken();
        workroom = res.data;
        attrsReceipt = res.receipt;
        if (res.identity.userId !== subject) throw new McpAuthError("subject_mismatch", 403, "platform identity changed between signed calls", { requestId: res.receipt.requestId });
        if (res.identity.workroomId !== this.workroomId || res.data.id !== this.workroomId) throw new McpAuthError("workroom_mismatch", 403, "platform returned a different workroom than configured", { requestId: res.receipt.requestId });
      } catch (err) {
        throw this.classify(err, secrets);
      }
      receipts.push(attrsReceipt);

      const mappedRole = ROLE_MAP[context.effective_workroom_role] ?? DEFAULT_ROLE;
      const profile = readProfile(workroom.attributes, subject);
      const identity: NativeIdentity = {
        subject,
        name: profile.name ?? ctx.identity.userName ?? subject,
        role: profile.role === "instructor" && mappedRole !== "instructor" ? mappedRole : profile.role ?? mappedRole,
        organization: profile.organization ?? workroom.name ?? "Kamiwaza workroom",
        mode: "kamiwaza",
      };
      const publicContext: NativeContext = {
        workroomId: context.workroom_id,
        workroomName: workroom.name ?? null,
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
        fresh: true,
        validatedAt: ctx.receipt.validatedAt,
      };
      return { identity, context: publicContext, nativeReceipts: receipts };
    } catch (err) {
      if (err instanceof McpAuthError) {
        err.message = redactSecrets(err.message, secrets);
        throw err;
      }
      throw this.classify(err, secrets);
    } finally {
      // 6. The bearer never outlives the request. Any client still holding the closure now yields ''.
      holder.token = "";
    }
  }

  private assertScope(identity: VerifiedIdentity, context: WorkroomRuntimeContextResponse, requestId: string | null): string {
    if (!identity.userId || identity.userId !== context.user_id) {
      throw new McpAuthError("subject_mismatch", 403, "platform-signed identity does not match the runtime context subject", { requestId });
    }
    if (identity.workroomId !== this.workroomId || context.workroom_id !== this.workroomId) {
      throw new McpAuthError("workroom_mismatch", 403, "platform signed a workroom scope that differs from the configured workroom", { requestId });
    }
    return identity.userId;
  }

  private classify(err: unknown, secrets: readonly (string | null | undefined)[]): McpAuthError {
    if (err instanceof McpAuthError) return err;
    if (err instanceof KamiwazaError) {
      const init = { nativeCode: err.code, requestId: err.requestId };
      switch (err.code) {
        case "auth_denied":
          return err.httpStatus === 403
            ? new McpAuthError("forbidden", 403, `native platform denied ${err.target ?? "the request"}`, init)
            : new McpAuthError("token_rejected", 401, "native platform rejected the bearer; re-authenticate with Kamiwaza", init);
        case "http_error":
          if (err.target === `GET /workrooms/${this.workroomId}/runtime/context` && (err.httpStatus === 404 || err.httpStatus === 409)) {
            return new McpAuthError("access_blocked", 403, "Kamiwaza no longer authorizes this workroom for the caller", init);
          }
          if (err.httpStatus === 401) return new McpAuthError("token_rejected", 401, "native platform rejected the bearer; re-authenticate with Kamiwaza", init);
          if (err.httpStatus === 403) return new McpAuthError("forbidden", 403, `native platform denied ${err.target ?? "the request"}`, init);
          return new McpAuthError("platform_unavailable", 503, `native platform error HTTP ${err.httpStatus} on ${err.target ?? "request"}`, init);
        case "missing_credentials":
        case "session_required":
          return new McpAuthError("missing_bearer", 401, "a native bearer is required", init);
        case "missing_signature":
          return new McpAuthError("platform_unavailable", 503, "native platform validated the bearer without a signed identity; request denied", init);
        case "invalid_request":
        case "invalid_config":
        case "forged_header":
          return new McpAuthError("invalid_request", 400, redactSecrets(err.message, secrets), init);
        default:
          return new McpAuthError("platform_unavailable", 503, `native platform unavailable (${err.code})`, init);
      }
    }
    return new McpAuthError("platform_unavailable", 503, "Native bearer resolution failed");
  }

  private clientOptions(getToken: () => string): KamiwazaClientOptions {
    return { apiBase: this.apiBase, validationApiBase:this.validationApiBase,getToken, fetchImpl: this.fetchImpl, forwardedHost: this.forwardedHost, forwardedProto: this.forwardedProto, timeoutMs: this.timeoutMs, workroomId: this.workroomId };
  }
}

// ---------------------------------------------------------------------------
// Header extraction (the only two inbound headers this module reads)
// ---------------------------------------------------------------------------

function single(headers: InboundHeaders, name: string): string | null {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === "string") return v[0];
  return null;
}

/** `Authorization: Bearer <token>` or a 401 without any platform call. Never logged. */
export function extractBearer(headers: InboundHeaders): string {
  const raw = single(headers, "authorization");
  if (raw === null || raw.length === 0) throw new McpAuthError("missing_bearer", 401, "Authorization: Bearer <platform token> is required");
  if (raw.length > MAX_AUTHORIZATION_LENGTH) throw new McpAuthError("missing_bearer", 401, "Authorization header is not a plausible bearer");
  const m = /^Bearer\s+(\S+)\s*$/i.exec(raw);
  if (!m || m[1]!.length < 16) throw new McpAuthError("missing_bearer", 401, "Authorization must carry a Bearer platform token");
  return m[1]!;
}

/** `x-workroom-id` as sent by Tomo. Absent or malformed reads as `null` (denied by the caller). */
export function extractWorkroom(headers: InboundHeaders): string | null {
  const raw = single(headers, "x-workroom-id");
  if (raw === null) return null;
  const v = raw.trim();
  return WORKROOM_PATTERN.test(v) ? v : null;
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
