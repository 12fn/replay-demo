/**
 * Native Kamiwaza 1.2 REST adapter.
 *
 * Guarantees:
 *  - Every protected call is preceded by a native ForwardAuth validation
 *    (`GET /auth/forward/validate`) for that exact method and URI. The target
 *    request is sent only when validation returned 200 with signed identity.
 *  - Signed identity headers are copied from the platform unchanged. The
 *    adapter never manufactures identity, signatures or workroom scope, and
 *    never lets the caller overwrite them.
 *  - The original bearer token is sent on the target request alongside the
 *    signed identity headers, matching what the ingress gateway does.
 *  - One timeout covers validation plus target. On timeout, denial or missing
 *    signature the target is not sent.
 *  - Errors are redacted: no headers, tokens, passwords or raw bodies.
 *  - Nothing is logged. Nothing happens at import time or on construction.
 */
import { CapabilityRegistry, type CapabilitySnapshot, type PlatformCapability } from "./capabilities.ts";
import { KamiwazaError, extractErrorDetail, redactSecrets } from "./errors.ts";
import {
  assertCallerHeaders,
  buildForwardAuthHeaders,
  extractSignedIdentity,
  type ForwardAuthResult,
  type VerifiedIdentity,
} from "./forward-auth.ts";
import type {
  AddKnowledgeRequest,
  AddKnowledgeResult,
  CheckRequest,
  CheckResponse,
  ContextHealth,
  CreateExtension,
  EnterWorkroomResponse,
  EpisodesResult,
  Extension,
  KnowledgeSearchResult,
  LeaveWorkroomResponse,
  LoginRequest,
  OntologyHealth,
  OntologyInstance,
  RebacRelation,
  SearchKnowledgeRequest,
  TokenResponse,
  UserInfo,
  WorkroomResponse,
  WorkroomRuntimeContextResponse,
} from "./types.ts";
import { REBAC_RELATIONS } from "./types.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const FORWARD_AUTH_PATH = "/auth/forward/validate";

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Returns the caller's bearer token (PAT or login session token). Never stored by the adapter. */
export type TokenProvider = () => string | Promise<string>;

export interface KamiwazaClientOptions {
  /** Platform API base, e.g. `https://kamiwaza.example/api`. Must end with `/api`. */
  apiBase: string;
  /** Optional platform ingress for validation; signed targets still use apiBase. */
  validationApiBase?: string;
  getToken: TokenProvider;
  fetchImpl?: FetchImpl;
  /** Total budget for validate + target, in milliseconds. */
  timeoutMs?: number;
  /** `X-Forwarded-Host` sent to ForwardAuth. Defaults to the host of `apiBase`. */
  forwardedHost?: string;
  /** `X-Forwarded-Proto` sent to ForwardAuth. Defaults to `https`. */
  forwardedProto?: string;
  /** Default `X-Workroom-ID` context hint for ForwardAuth. The platform decides the signed scope. */
  workroomId?: string | null;
}

export interface RequestSpec {
  /** Bounded per-operation timeout; graph extraction can take longer than ordinary reads. */
  timeoutMs?: number;
  method: HttpMethod;
  /** Path relative to `apiBase`, starting with `/`. Path parameters must already be encoded. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body. Sent as `application/json`. */
  body?: unknown;
  /** Per-call `X-Workroom-ID` context hint. `null` suppresses the client default. */
  workroomId?: string | null;
  /** Additional non-reserved headers. Gateway, identity and credential headers are rejected. */
  headers?: Record<string, string>;
  /** Capability to label `native` on success. */
  capability?: PlatformCapability;
}

export interface RequestReceipt {
  /** Adapter-generated id, always present. */
  clientRequestId: string;
  /** Platform `x-request-id` from the target response, when present. */
  requestId: string | null;
  target: { method: HttpMethod; path: string };
  status: number;
  durationMs: number;
  /** ISO timestamp at which ForwardAuth returned the signed identity. */
  validatedAt: string;
  /** Platform signature timestamp header, verbatim. Not a secret. */
  signatureTs: string | null;
}

/** Result of a signed platform call. Signatures are not exposed; only public identity fields are. */
export interface SignedResult<T> {
  data: T;
  identity: VerifiedIdentity;
  receipt: RequestReceipt;
}

export interface LoginReceipt {
  clientRequestId: string;
  requestId: string | null;
  status: number;
  durationMs: number;
}

/** Result of the exempt login call. Contains tokens: keep server-side, never log. */
export interface LoginResult {
  data: TokenResponse;
  receipt: LoginReceipt;
}

export interface EnterWorkroomOptions {
  /** Login session token (JWT with `sid`). Defaults to the configured token provider. */
  sessionToken?: string;
}

/** Native platform operations exposed to the application. */
export interface RuntimeReadSpec {
  extension: string;
  /** Fixed origin supplied by the server, never an untrusted browser target. */
  origin: string;
  path: string;
  subject: string;
}
export interface RuntimeReadResult {
  body: Uint8Array;
  status: number;
  contentType: string;
  identity: VerifiedIdentity;
  receipt: RequestReceipt;
}

export interface RuntimeInvokeSpec extends RuntimeReadSpec {
  /** Required opaque retry key, 1..200 visible ASCII characters. */
  idempotencyKey: string;
  body?: unknown;
}

export interface RuntimeEventsSpec extends RuntimeReadSpec {
  /** Resume with an `after` query parameter in path, never a caller header. */
  signal?: AbortSignal;
}

export interface RuntimeEventsResult {
  body: ReadableStream<Uint8Array>;
  status: number;
  contentType: string;
  identity: VerifiedIdentity;
  receipt: RequestReceipt;
  cancel(): void;
}

export interface CatalogDatasetMetadata {
  urn: string; workroom_id: string; content_revision?: number; properties?: Record<string,string>;
}
export interface CatalogObjectMetadata { logical_path: string; state: string; etag: string; item_id?: string; size_bytes?: number }

export interface NativePlatformAdapter {
  catalogDataset?(urn: string, workroomId: string): Promise<SignedResult<CatalogDatasetMetadata>>;
  catalogObjects?(urn: string, workroomId: string): Promise<SignedResult<CatalogObjectMetadata[]>>;
  catalogObjectContent?(urn: string, itemId: string, workroomId: string, maxBytes: number): Promise<SignedResult<Uint8Array>>;
  /** Optional native extension read transport; unavailable adapters fail closed. */
  runtimeRead?(spec: RuntimeReadSpec): Promise<RuntimeReadResult>;
  /** Optional, server-owned Tomo conversation POST transport. */
  runtimeInvoke?(spec: RuntimeInvokeSpec): Promise<RuntimeReadResult>;
  /** Optional Tomo SSE transport; the caller owns framing and fresh-session checks. */
  runtimeEvents?(spec: RuntimeEventsSpec): Promise<RuntimeEventsResult>;
  me(): Promise<SignedResult<UserInfo>>;
  workroom(workroomId: string): Promise<SignedResult<WorkroomResponse>>;
  workroomContext(workroomId: string): Promise<SignedResult<WorkroomRuntimeContextResponse>>;
  enterWorkroom(workroomId: string, opts?: EnterWorkroomOptions): Promise<SignedResult<EnterWorkroomResponse>>;
  leaveWorkroom(opts?: EnterWorkroomOptions): Promise<SignedResult<LeaveWorkroomResponse>>;
  check(req: CheckRequest): Promise<SignedResult<CheckResponse>>;
  listExtensions(opts?: { workroomId?: string }): Promise<SignedResult<Extension[]>>;
  createExtension(spec: CreateExtension): Promise<SignedResult<Extension>>;
  listOntologies(opts?: { workroomId?: string | null }): Promise<SignedResult<OntologyInstance[]>>;
  ontologyHealth(ontologyId: string, opts?: { workroomId?: string | null }): Promise<SignedResult<OntologyHealth>>;
  contextHealth(): Promise<SignedResult<ContextHealth>>;
  addKnowledge(ontologyId: string, req: AddKnowledgeRequest, opts?: { workroomId?: string | null }): Promise<SignedResult<AddKnowledgeResult>>;
  searchOntology(ontologyId: string, req: SearchKnowledgeRequest, opts?: { workroomId?: string | null }): Promise<SignedResult<KnowledgeSearchResult>>;
  episodes(ontologyId: string, groupId: string, opts?: { lastN?: number; workroomId?: string | null }): Promise<SignedResult<EpisodesResult>>;
  capabilities(): CapabilitySnapshot;
}

const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const SESSION_MIN_BEARER_LENGTH = 16;
const RUNTIME_MAX_BYTES = 8 * 1024 * 1024;
const TOMO_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TOMO_CONVERSATION_ID = `(?:[0-9a-fA-F]{32}|${TOMO_UUID})`;
const TOMO_INVOKE_PATH = new RegExp(`^/api/conversations(?:/${TOMO_CONVERSATION_ID}/inputs)?$`);
const TOMO_EVENTS_PATH = new RegExp(`^/api/conversations/${TOMO_CONVERSATION_ID}/events$`);

type Parser<T> = (json: unknown, target: string) => T;
type Secrets = readonly (string | null | undefined)[];

export class KamiwazaClient implements NativePlatformAdapter {
  readonly apiBase: string;
  readonly validationApiBase: string;
  readonly apiPrefix: string;
  readonly forwardedHost: string;
  readonly forwardedProto: string;
  readonly timeoutMs: number;
  private readonly defaultWorkroomId: string | null;
  private readonly getToken: TokenProvider;
  private readonly fetchImpl: FetchImpl;
  private readonly registry = new CapabilityRegistry();

  constructor(opts: KamiwazaClientOptions) {
    if (!opts || typeof opts !== "object") throw new KamiwazaError("invalid_config", "KamiwazaClient options are required");
    if (typeof opts.getToken !== "function") throw new KamiwazaError("invalid_config", "getToken must be a function");
    const base = typeof opts.apiBase === "string" ? opts.apiBase.trim().replace(/\/+$/, "") : "";
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new KamiwazaError("invalid_config", "apiBase must be an absolute URL ending in /api");
    }
    if (!/\/api$/.test(url.pathname) || url.search || url.hash) {
      throw new KamiwazaError("invalid_config", "apiBase must be an absolute URL ending in /api");
    }
    this.apiBase = base;
    this.validationApiBase = opts.validationApiBase?.replace(/\/+$/, '') ?? base;
    const validationUrl=new URL(this.validationApiBase);
    if(!['https:','http:'].includes(validationUrl.protocol)||validationUrl.username||validationUrl.password||validationUrl.search||validationUrl.hash||!validationUrl.pathname.endsWith('/api'))throw new KamiwazaError('invalid_config','validationApiBase must be an HTTP(S) API origin ending in /api');
    this.apiPrefix = url.pathname;
    this.forwardedHost = opts.forwardedHost ?? url.host;
    this.forwardedProto = opts.forwardedProto ?? "https";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new KamiwazaError("invalid_config", "timeoutMs must be > 0");
    this.defaultWorkroomId = typeof opts.workroomId === "string" && opts.workroomId.length > 0 ? opts.workroomId : null;
    this.getToken = opts.getToken;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Never serializes the token provider or any credential. */
  toJSON(): Record<string, unknown> {
    return {
      apiBase: this.apiBase,
      forwardedHost: this.forwardedHost,
      forwardedProto: this.forwardedProto,
      timeoutMs: this.timeoutMs,
      capabilities: this.registry.snapshot(),
    };
  }

  capabilities(): CapabilitySnapshot {
    return this.registry.snapshot();
  }

  // -------------------------------------------------------------------------
  // Exempt endpoint: login
  // -------------------------------------------------------------------------

  /**
   * `POST /auth/token` (auth-exempt). Authenticates native credentials held in
   * runtime memory and returns Keycloak tokens. Server-side use only. The
   * adapter does not retain the credentials or the tokens.
   */
  async login(req: LoginRequest): Promise<LoginResult> {
    if (!req || typeof req.username !== "string" || req.username.length === 0 || typeof req.password !== "string" || req.password.length === 0) {
      throw new KamiwazaError("invalid_request", "login requires username and password");
    }
    const secrets = [req.password, req.client_secret];
    const form = new URLSearchParams();
    form.set("username", req.username);
    form.set("password", req.password);
    if (req.grant_type !== undefined) form.set("grant_type", req.grant_type);
    if (req.scope !== undefined) form.set("scope", req.scope);
    if (typeof req.client_id === "string") form.set("client_id", req.client_id);
    if (typeof req.client_secret === "string") form.set("client_secret", req.client_secret);

    const target = "POST /auth/token";
    const clientRequestId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();
    try {
      const response = await this.send(
        `${this.apiBase}/auth/token`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        },
        target,
        controller,
        secrets,
      );
      const requestId = response.headers.get("x-request-id");
      const json = await this.readJson(response, target, controller, secrets, requestId);
      if (!response.ok) {
        throw new KamiwazaError("http_error", `login failed with HTTP ${response.status}`, {
          httpStatus: response.status,
          target,
          requestId,
          detail: extractErrorDetail(json, secrets),
        });
      }
      const data = parseTokenResponse(json, target);
      return {
        data,
        receipt: { clientRequestId, requestId, status: response.status, durationMs: elapsed(started) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Protected endpoints
  // -------------------------------------------------------------------------

  async me(): Promise<SignedResult<UserInfo>> {
    return this.request({ method: "GET", path: "/auth/users/me", capability: "identity" }, parseUserInfo);
  }

  async workroom(workroomId: string): Promise<SignedResult<WorkroomResponse>> {
    const id = requireId(workroomId, "workroomId");
    return this.request(
      { method: "GET", path: `/workrooms/${encodeURIComponent(id)}`, workroomId: id, capability: "workroom" },
      requireFields<WorkroomResponse>(["id", "tenant_id", "owner_user_id", "name", "type", "status", "created_at"]),
    );
  }

  async workroomContext(workroomId: string): Promise<SignedResult<WorkroomRuntimeContextResponse>> {
    const id = requireId(workroomId, "workroomId");
    return this.request(
      { method: "GET", path: `/workrooms/${encodeURIComponent(id)}/runtime/context`, workroomId: id, capability: "workroom" },
      requireFields<WorkroomRuntimeContextResponse>([
        "workroom_id",
        "user_id",
        "effective_workroom_role",
        "workroom_lifecycle_state",
        "interaction_mode",
        "access_state",
      ]),
    );
  }

  /**
   * `POST /workrooms/{id}/enter`: bind the login session to a workroom.
   * Requires a session token carrying a `sid` claim. A personal access token
   * cannot bind and is rejected before any network call.
   */
  async enterWorkroom(workroomId: string, opts: EnterWorkroomOptions = {}): Promise<SignedResult<EnterWorkroomResponse>> {
    const id = requireId(workroomId, "workroomId");
    const token = await this.resolveSessionToken(opts.sessionToken);
    return this.request(
      { method: "POST", path: `/workrooms/${encodeURIComponent(id)}/enter`, workroomId: id, capability: "workroom" },
      requireFields<EnterWorkroomResponse>(["workroom_id"]),
      token,
    );
  }

  /** `POST /workrooms/leave`: return the login session to no-workroom scope. */
  async leaveWorkroom(opts: EnterWorkroomOptions = {}): Promise<SignedResult<LeaveWorkroomResponse>> {
    const token = await this.resolveSessionToken(opts.sessionToken);
    return this.request(
      { method: "POST", path: "/workrooms/leave", workroomId: null, capability: "workroom" },
      requireFields<LeaveWorkroomResponse>(["workroom_id"]),
      token,
    );
  }

  /** `POST /auth/check`: native ReBAC decision. */
  async check(req: CheckRequest): Promise<SignedResult<CheckResponse>> {
    if (!req || !isNamespacedId(req.subject) || !isNamespacedId(req.object)) {
      throw new KamiwazaError("invalid_request", "check requires subject and object with namespace and id");
    }
    if (!REBAC_RELATIONS.includes(req.relation as RebacRelation)) {
      throw new KamiwazaError("invalid_request", `relation must be one of the installed relations: ${REBAC_RELATIONS.join(", ")}`);
    }
    const body: CheckRequest = {
      subject: { namespace: req.subject.namespace, id: req.subject.id },
      relation: req.relation,
      object: { namespace: req.object.namespace, id: req.object.id },
    };
    return this.request({ method: "POST", path: "/auth/check", body, capability: "rebac" }, parseCheckResponse);
  }

  async listExtensions(opts: { workroomId?: string } = {}): Promise<SignedResult<Extension[]>> {
    return this.request(
      { method: "GET", path: "/extensions", query: { workroom_id: opts.workroomId }, workroomId: opts.workroomId, capability: "extensions" },
      requireArrayOf<Extension>(["name", "type", "version"]),
    );
  }

  /** `POST /extensions` (201). Persist the returned `name`; it may be scoped by the platform. */
  async createExtension(spec: CreateExtension): Promise<SignedResult<Extension>> {
    if (!spec || typeof spec.name !== "string" || typeof spec.type !== "string" || typeof spec.version !== "string" || !Array.isArray(spec.services) || spec.services.length === 0) {
      throw new KamiwazaError("invalid_request", "createExtension requires name, type, version and at least one service");
    }
    return this.request(
      { method: "POST", path: "/extensions", body: spec, workroomId: spec.workroom_id ?? undefined, capability: "extensions" },
      requireFields<Extension>(["name", "type", "version"]),
    );
  }

  async catalogDataset(urn: string, workroomId: string): Promise<SignedResult<CatalogDatasetMetadata>> {
    const id = requireId(urn, 'datasetUrn');
    return this.request({method:'GET',path:'/catalog/datasets/by-urn',query:{urn:id},workroomId:requireId(workroomId,'workroomId')}, requireFields<CatalogDatasetMetadata>(['urn','workroom_id']));
  }

  async catalogObjects(urn: string, workroomId: string): Promise<SignedResult<CatalogObjectMetadata[]>> {
    const id = requireId(urn, 'datasetUrn');
    return this.request({method:'GET',path:`/catalog/datasets/v2/${encodeURIComponent(id)}/objects`,query:{state:'live'},workroomId:requireId(workroomId,'workroomId')}, requireArrayOf<CatalogObjectMetadata>(['logical_path','state','etag']));
  }

  /** Bounded native object bytes, freshly authorized for the exact content URI. No redirect or cache. */
  async catalogObjectContent(urn: string, itemId: string, workroomId: string, maxBytes: number): Promise<SignedResult<Uint8Array>> {
    if (!/^urn:li:dataset:\(urn:li:dataPlatform:kamiwaza,[a-zA-Z0-9_-]{1,200},DEV\)$/.test(urn) ||
        !new RegExp(`^${TOMO_UUID}$`).test(itemId) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024)
      throw new KamiwazaError('invalid_request', 'Invalid managed catalog content request');
    const room = requireId(workroomId, 'workroomId');
    const pathname = `/catalog/datasets/v2/${encodeURIComponent(urn)}/objects/${itemId}/content`, target = `GET ${pathname}`;
    const token = await this.resolveToken(), secrets = [token], controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs), started = performance.now(), clientRequestId = crypto.randomUUID();
    try {
      const auth = await this.forwardAuth({token, method:'GET', uri:`${this.apiPrefix}${pathname}`, workroomHint:room, target, controller, secrets});
      if (auth.identity.workroomId !== room) throw new KamiwazaError('auth_denied', 'Catalog workroom identity mismatch', {httpStatus:403});
      const validatedAt = new Date().toISOString();
      const response = await this.send(`${this.apiBase}${pathname}`, {method:'GET', redirect:'error', cache:'no-store', signal:controller.signal,
        headers:{accept:'application/octet-stream', authorization:`Bearer ${token}`, ...auth.forwardHeaders}}, target, controller, secrets);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new KamiwazaError('http_error', 'Native catalog content read failed', {httpStatus:response.status, target});
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        await response.body?.cancel(); throw new KamiwazaError('malformed_response', 'Catalog content exceeds the byte limit');
      }
      const reader = response.body?.getReader(), chunks:Uint8Array[] = []; let length = 0;
      if (!reader) throw new KamiwazaError('malformed_response', 'Catalog content is empty');
      try {
        for (;;) {
          const next = await runtimeAwait(reader.read(), controller.signal); if (next.done) break;
          length += next.value.byteLength;
          if (length > maxBytes) throw new KamiwazaError('malformed_response', 'Catalog content exceeds the byte limit');
          chunks.push(next.value);
        }
      } catch (error) { controller.abort(); void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const data = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      return {data, identity:auth.identity, receipt:{clientRequestId, requestId:response.headers.get('x-request-id'), target:{method:'GET',path:pathname},
        status:response.status, durationMs:elapsed(started), validatedAt, signatureTs:auth.signatureTs}};
    } catch (error) {
      if (error instanceof KamiwazaError) throw error;
      throw new KamiwazaError(controller.signal.aborted ? 'timeout' : 'network_error', 'Native catalog content read failed');
    } finally { clearTimeout(timer); }
  }

  async listOntologies(opts: { workroomId?: string | null } = {}): Promise<SignedResult<OntologyInstance[]>> {
    return this.request(
      { method: "GET", path: "/context/ontologies", workroomId: opts.workroomId, capability: "ontology" },
      requireArrayOf<OntologyInstance>(["id", "name", "backend", "status", "created_at"]),
    );
  }

  async ontologyHealth(ontologyId: string, opts: { workroomId?: string | null } = {}): Promise<SignedResult<OntologyHealth>> {
    const id = requireId(ontologyId, "ontologyId");
    return this.request(
      { method: "GET", path: `/context/ontologies/${encodeURIComponent(id)}/health`, workroomId: opts.workroomId, capability: "ontology" },
      requireFields<OntologyHealth>([]),
    );
  }

  async contextHealth(): Promise<SignedResult<ContextHealth>> {
    return this.request({ method: "GET", path: "/context/health", capability: "ontology" }, (json) => json);
  }

  async addKnowledge(ontologyId: string, req: AddKnowledgeRequest, opts: { workroomId?: string | null } = {}): Promise<SignedResult<AddKnowledgeResult>> {
    const id = requireId(ontologyId, "ontologyId");
    if (!req || typeof req.group_id !== "string" || req.group_id.length === 0 || !Array.isArray(req.messages)) {
      throw new KamiwazaError("invalid_request", "addKnowledge requires group_id and messages");
    }
    for (const m of req.messages) {
      if (!m || typeof m.content !== "string") throw new KamiwazaError("invalid_request", "every message requires string content");
    }
    return this.request(
      { method: "POST", path: `/context/ontologies/${encodeURIComponent(id)}/knowledge`, body: req, workroomId: opts.workroomId, capability: "knowledge", timeoutMs:120_000 },
      requireFields<AddKnowledgeResult>(["added_count", "group_id"]),
    );
  }

  async searchOntology(ontologyId: string, req: SearchKnowledgeRequest, opts: { workroomId?: string | null } = {}): Promise<SignedResult<KnowledgeSearchResult>> {
    const id = requireId(ontologyId, "ontologyId");
    if (!req || typeof req.query !== "string" || !Array.isArray(req.group_ids)) {
      throw new KamiwazaError("invalid_request", "searchOntology requires query and group_ids");
    }
    if (req.max_results !== undefined && (!Number.isSafeInteger(req.max_results) || req.max_results < 1 || req.max_results > 100)) {
      throw new KamiwazaError("invalid_request", "max_results must be an integer in [1, 100]");
    }
    return this.request(
      { method: "POST", path: `/context/ontologies/${encodeURIComponent(id)}/search`, body: req, workroomId: opts.workroomId, capability: "knowledge" },
      requireFields<KnowledgeSearchResult>(["query", "total_count"]),
    );
  }

  async episodes(ontologyId: string, groupId: string, opts: { lastN?: number; workroomId?: string | null } = {}): Promise<SignedResult<EpisodesResult>> {
    const id = requireId(ontologyId, "ontologyId");
    const group = requireId(groupId, "groupId");
    if (opts.lastN !== undefined && (!Number.isSafeInteger(opts.lastN) || opts.lastN < 1)) {
      throw new KamiwazaError("invalid_request", "lastN must be a positive integer");
    }
    return this.request(
      {
        method: "GET",
        path: `/context/ontologies/${encodeURIComponent(id)}/episodes/${encodeURIComponent(group)}`,
        query: { last_n: opts.lastN },
        workroomId: opts.workroomId,
        capability: "knowledge",
      },
      requireFields<EpisodesResult>(["group_id", "count"]),
    );
  }

  // -------------------------------------------------------------------------
  // Core: ForwardAuth then target
  // -------------------------------------------------------------------------

  /**
   * Perform a signed platform request: validate with native ForwardAuth for
   * this exact method and URI, then send the target with the original bearer
   * plus the signed identity headers copied unchanged.
   */
  async request<T = unknown>(spec: RequestSpec, parse: Parser<T> = (json) => json as T, tokenOverride?: string): Promise<SignedResult<T>> {
    if (!spec || typeof spec.path !== "string" || !SAFE_PATH.test(spec.path) || spec.path.includes("//") || spec.path.includes("..")) {
      throw new KamiwazaError("invalid_request", "path must start with / and contain only URL path characters");
    }
    if (spec.path === FORWARD_AUTH_PATH) {
      throw new KamiwazaError("invalid_request", "the ForwardAuth endpoint is not a target; it is called automatically");
    }
    const method = spec.method;
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new KamiwazaError("invalid_request", "unsupported HTTP method");
    }
    const callerHeaders = assertCallerHeaders(spec.headers);
    const token = tokenOverride ?? (await this.resolveToken());
    const secrets = [token];
    const query = buildQuery(spec.query);
    const pathWithQuery = `${spec.path}${query}`;
    const target = `${method} ${spec.path}`;
    const workroomHint = spec.workroomId === undefined ? this.defaultWorkroomId : spec.workroomId;

    const clientRequestId = crypto.randomUUID();
    const controller = new AbortController();
    const requestTimeout=spec.timeoutMs??this.timeoutMs;
    if(!Number.isFinite(requestTimeout)||requestTimeout<=0||requestTimeout>120000)throw new KamiwazaError('invalid_request','Timeout must be within 1..120000 ms');
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    const started = performance.now();
    try {
      // 1. Native ForwardAuth for this exact target.
      const auth = await this.forwardAuth({ token, method, uri: `${this.apiPrefix}${pathWithQuery}`, workroomHint, target, controller, secrets });
      const validatedAt = new Date().toISOString();

      // 2. Target request: original bearer + signed identity headers, unchanged.
      const headers: Record<string, string> = {
        ...callerHeaders,
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...auth.forwardHeaders,
      };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (spec.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(spec.body);
      }
      const response = await this.send(`${this.apiBase}${pathWithQuery}`, init, target, controller, secrets);
      const requestId = response.headers.get("x-request-id");
      const json = await this.readJson(response, target, controller, secrets, requestId);
      if (!response.ok) {
        throw new KamiwazaError("http_error", `platform responded with HTTP ${response.status} for ${target}`, {
          httpStatus: response.status,
          target,
          requestId,
          detail: extractErrorDetail(json, secrets),
        });
      }
      const data = parse(json, target);
      const receipt: RequestReceipt = {
        clientRequestId,
        requestId,
        target: { method, path: spec.path },
        status: response.status,
        durationMs: elapsed(started),
        validatedAt,
        signatureTs: auth.signatureTs,
      };
      if (spec.capability) this.registry.markNative(spec.capability, { target, requestId, at: validatedAt });
      return { data, identity: auth.identity, receipt };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Server-owned extension origin only. Never returns credentials or upstream cookies/redirects. */
  async runtimeRead(spec: RuntimeReadSpec): Promise<RuntimeReadResult> {
    const { origin, pathname } = this.validateRuntimeScope(spec);
    const token = await this.resolveToken(), secrets = [token];
    const controller = new AbortController(), started = performance.now(), clientRequestId = crypto.randomUUID();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const target = 'GET native extension resource';
    try {
      const auth = await this.forwardAuth({ token, method: 'GET', uri: `/runtime/apps/${spec.extension}${spec.path}`, workroomHint: this.defaultWorkroomId, target, controller, secrets });
      const validatedAt = new Date().toISOString();
      if (auth.identity.userId !== spec.subject || auth.identity.workroomId !== this.defaultWorkroomId)
        throw new KamiwazaError('auth_denied', 'Runtime signed identity does not match the current session', { httpStatus: 403 });
      const response = await this.send(origin.origin + spec.path, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}`, ...auth.forwardHeaders }, signal: controller.signal }, target, controller, secrets);
      const declared = Number(response.headers.get('content-length') ?? 0), max = 8 * 1024 * 1024;
      if (declared > max) { await response.body?.cancel(); throw new KamiwazaError('malformed_response', 'Runtime resource is too large'); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0;
      if (reader) try {
        while (true) { const result = await reader.read(); if (result.done) break; length += result.value.length;
          if (length > max) { await reader.cancel(); throw new KamiwazaError('malformed_response', 'Runtime resource is too large'); } chunks.push(result.value); }
      } finally { reader.releaseLock(); }
      const body = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
      return { body, status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', identity: auth.identity,
        receipt: { clientRequestId, requestId: response.headers.get('x-request-id'), target: { method: 'GET', path: `/runtime/apps/${spec.extension}${pathname}` }, status: response.status,
          durationMs: elapsed(started), validatedAt, signatureTs: auth.signatureTs } };
    } catch (error) {
      if (error instanceof KamiwazaError) throw error;
      throw new KamiwazaError(controller.signal.aborted ? 'timeout' : 'network_error', 'Native runtime resource read failed');
    } finally { clearTimeout(timer); }
  }

  /** Only conversation creation and input submission; no caller-supplied headers. */
  async runtimeInvoke(spec: RuntimeInvokeSpec): Promise<RuntimeReadResult> {
    // Snapshot before serialization/token resolution can yield or run caller code.
    spec = { extension: spec.extension, origin: spec.origin, path: spec.path, subject: spec.subject,
      idempotencyKey: spec.idempotencyKey, body: spec.body };
    const scope = this.validateTomoScope(spec);
    if (!TOMO_INVOKE_PATH.test(scope.pathname) || typeof spec.idempotencyKey !== 'string' ||
        !/^[\x21-\x7e]{1,200}$/.test(spec.idempotencyKey))
      throw new KamiwazaError('invalid_request', 'Invalid Tomo invocation path or idempotency key');
    let body: string | undefined;
    try {
      if (spec.body !== undefined) {
        body = JSON.stringify(spec.body);
        if (body === undefined) throw new Error();
      }
    } catch { throw new KamiwazaError('invalid_request', 'Tomo invocation requires a JSON body'); }
    const opened = await this.openRuntimeTransport(spec, scope, 'POST', {
      'idempotency-key': spec.idempotencyKey,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, body);
    const { response, controller, dispose, identity, receipt } = opened;
    try {
      if (Number(response.headers.get('content-length') ?? 0) > RUNTIME_MAX_BYTES)
        throw new KamiwazaError('malformed_response', 'Runtime resource is too large');
      const stream = runtimeStream(response, controller, dispose);
      const reader = stream.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > RUNTIME_MAX_BYTES)
            throw new KamiwazaError('malformed_response', 'Runtime resource is too large');
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { body: bytes, status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        identity, receipt: { ...receipt, durationMs: receipt.durationMs + elapsed(opened.headersAt) } };
    } catch (error) {
      controller.abort();
      if (!response.body?.locked) void response.body?.cancel().catch(() => {});
      throw safeRuntimeError(error);
    } finally { dispose(); }
  }

  /** Streams without accumulating events or imposing a lifetime timeout after headers. */
  async runtimeEvents(spec: RuntimeEventsSpec): Promise<RuntimeEventsResult> {
    spec = { extension: spec.extension, origin: spec.origin, path: spec.path, subject: spec.subject, signal: spec.signal };
    const scope = this.validateTomoScope(spec);
    const query = new URLSearchParams(spec.path.includes('?') ? spec.path.slice(spec.path.indexOf('?') + 1) : '');
    if (!TOMO_EVENTS_PATH.test(scope.pathname) || [...query.keys()].some(key => key !== 'after') || query.getAll('after').length > 1)
      throw new KamiwazaError('invalid_request', 'Invalid Tomo event path or cursor query');
    const opened = await this.openRuntimeTransport(spec, scope, 'GET', { accept: 'text/event-stream' }, undefined, spec.signal);
    const { response, controller, dispose, identity, receipt } = opened;
    opened.releaseTimeout();
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.split(';')[0].trim().toLowerCase() !== 'text/event-stream' || !response.body) {
      controller.abort();
      void response.body?.cancel().catch(() => {});
      dispose();
      throw new KamiwazaError('malformed_response', 'Runtime did not return an event stream');
    }
    const body = runtimeStream(response, controller, dispose);
    return { body, status: response.status, contentType, identity, receipt, cancel: () => controller.abort() };
  }

  private async openRuntimeTransport(
    spec: RuntimeReadSpec, scope: { origin: URL; pathname: string }, method: 'GET' | 'POST',
    extraHeaders: Record<string, string>, body?: string, signal?: AbortSignal,
  ) {
    const controller = new AbortController(), started = performance.now(), clientRequestId = crypto.randomUUID();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    const releaseTimeout = () => clearTimeout(timer);
    const dispose = () => { releaseTimeout(); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      if (controller.signal.aborted) throw new KamiwazaError('timeout', 'Native runtime request cancelled');
      const token = await runtimeAwait(this.resolveToken(), controller.signal), secrets = [token];
      const target = `${method} native extension resource`;
      const auth = await runtimeAwait(this.forwardAuth({ token, method, uri: `/runtime/apps/${spec.extension}${spec.path}`,
        workroomHint: this.defaultWorkroomId, target, controller, secrets, runtimeTransport: true }), controller.signal);
      const validatedAt = new Date().toISOString();
      if (auth.identity.userId !== spec.subject || auth.identity.workroomId !== this.defaultWorkroomId)
        throw new KamiwazaError('auth_denied', 'Runtime signed identity does not match the current session', { httpStatus: 403 });
      if (controller.signal.aborted) throw new KamiwazaError('timeout', 'Native runtime request cancelled');
      const response = await runtimeAwait(this.send(scope.origin.origin + spec.path, {
        method, redirect: 'error', credentials: 'omit', signal: controller.signal, body,
        headers: { ...extraHeaders, authorization: `Bearer ${token}`, ...auth.forwardHeaders },
      }, target, controller, secrets).then(response => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      }), controller.signal);
      // Also reject redirects from injected HTTP implementations that ignore redirect: error.
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        throw new KamiwazaError('http_error', 'Native runtime redirect refused');
      }
      const receipt: RequestReceipt = { clientRequestId, requestId: response.headers.get('x-request-id'),
        target: { method, path: `/runtime/apps/${spec.extension}${scope.pathname}` }, status: response.status,
        durationMs: elapsed(started), validatedAt, signatureTs: auth.signatureTs };
      return { response, controller, releaseTimeout, dispose, identity: auth.identity, receipt, headersAt: performance.now() };
    } catch (error) {
      controller.abort();
      dispose();
      throw safeRuntimeError(error);
    }
  }

  private validateTomoScope(spec: RuntimeReadSpec): { origin: URL; pathname: string } {
    const scope = this.validateRuntimeScope(spec);
    const url = scope.origin.origin + spec.path;
    // Fetch must send precisely the URI Core signed, including its encoded query.
    if (new URL(url).href !== url)
      throw new KamiwazaError('invalid_request', 'Runtime path must be URL encoded without normalization');
    return scope;
  }

  private validateRuntimeScope(spec: RuntimeReadSpec): { origin: URL; pathname: string } {
    let origin: URL;
    try { origin = new URL(spec.origin); } catch { throw new KamiwazaError('invalid_request', 'Invalid runtime origin'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new KamiwazaError('invalid_request', 'Runtime origin must be an HTTP origin without credentials');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(spec.extension) || !spec.subject || !this.defaultWorkroomId)
      throw new KamiwazaError('invalid_request', 'A bound runtime extension and subject are required');
    if (typeof spec.path !== 'string' || spec.path.length > 4096 || !spec.path.startsWith('/') || spec.path.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(spec.path))
      throw new KamiwazaError('invalid_request', 'Invalid runtime path');
    const pathname = spec.path.split('?')[0];
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { throw new KamiwazaError('invalid_request', 'Invalid runtime encoding'); }
    if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('//') || decoded.split('/').some(p => p === '.' || p === '..') || /[?#\x00-\x20\x7f]/.test(decoded))
      throw new KamiwazaError('invalid_request', 'Ambiguous runtime path');
    return { origin, pathname };
  }

  private async forwardAuth(args: {
    token: string;
    method: HttpMethod;
    uri: string;
    workroomHint: string | null;
    target: string;
    controller: AbortController;
    secrets: Secrets;
    /** Runtime writes/streams never follow redirects or read a raw auth response body. */
    runtimeTransport?: boolean;
  }): Promise<ForwardAuthResult> {
    const headers = buildForwardAuthHeaders({
      token: args.token,
      method: args.method,
      uri: args.uri,
      host: this.forwardedHost,
      proto: this.forwardedProto,
      workroomId: args.workroomHint,
    });
    const authTarget = `GET ${FORWARD_AUTH_PATH} (for ${args.target})`;
    const response = await this.send(
      `${this.validationApiBase}${FORWARD_AUTH_PATH}`,
      { method: "GET", headers, signal: args.controller.signal, ...(args.runtimeTransport ? { redirect: 'error' as const, credentials: 'omit' as const } : {}) },
      authTarget,
      args.controller,
      args.secrets,
    );
    if (args.runtimeTransport) {
      void response.body?.cancel().catch(() => {});
      if (args.controller.signal.aborted) throw new KamiwazaError('timeout', 'Native runtime validation cancelled');
      if (response.status !== 200)
        throw new KamiwazaError(response.status === 401 || response.status === 403 ? 'auth_denied' : 'auth_error',
          'Native runtime validation failed; target request not sent', { httpStatus: response.status });
      return extractSignedIdentity(response.headers);
    }
    if (response.status !== 200) {
      const requestId = response.headers.get("x-request-id");
      let detail: string | undefined;
      try {
        detail = extractErrorDetail(await response.json(), args.secrets);
      } catch {
        detail = undefined;
      }
      const denied = response.status === 401 || response.status === 403;
      throw new KamiwazaError(
        denied ? "auth_denied" : "auth_error",
        denied
          ? `ForwardAuth denied ${args.target} (HTTP ${response.status}); target request not sent`
          : `ForwardAuth failed for ${args.target} (HTTP ${response.status}); target request not sent`,
        { httpStatus: response.status, target: args.target, requestId, detail },
      );
    }
    // Drain the body so the connection can be reused; the identity lives in headers.
    try {
      await response.arrayBuffer();
    } catch {
      /* body is irrelevant */
    }
    if (args.controller.signal.aborted) {
      throw new KamiwazaError("timeout", `request exceeded ${this.timeoutMs} ms during ForwardAuth; target request not sent`, { target: args.target });
    }
    return extractSignedIdentity(response.headers);
  }

  private async send(url: string, init: RequestInit, target: string, controller: AbortController, secrets: Secrets): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new KamiwazaError("timeout", `request exceeded ${this.timeoutMs} ms (${target})`, { target });
      }
      const reason = err instanceof Error ? redactSecrets(err.message, secrets) : "unknown error";
      throw new KamiwazaError("network_error", `network error before a response was received (${target}): ${truncate(reason)}`, { target });
    }
  }

  private async readJson(response: Response, target: string, controller: AbortController, secrets: Secrets, requestId: string | null): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (controller.signal.aborted) throw new KamiwazaError("timeout", `request exceeded ${this.timeoutMs} ms while reading ${target}`, { target, requestId });
      throw new KamiwazaError("malformed_response", `unreadable body from ${target} (HTTP ${response.status})`, { httpStatus: response.status, target, requestId });
    }
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new KamiwazaError("malformed_response", `non-JSON body from ${target} (HTTP ${response.status})`, {
        httpStatus: response.status,
        target,
        requestId,
        detail: redactSecrets(truncate(text), secrets),
      });
    }
  }

  private async resolveToken(): Promise<string> {
    let token: unknown;
    try {
      token = await this.getToken();
    } catch {
      throw new KamiwazaError("missing_credentials", "token provider failed");
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new KamiwazaError("missing_credentials", "no bearer token available for the platform");
    }
    return token.trim();
  }

  /** Workroom binding needs a login session (JWT with `sid`), not a PAT. */
  private async resolveSessionToken(explicit: string | undefined): Promise<string> {
    const token = explicit !== undefined ? explicit.trim() : await this.resolveToken();
    if (token.length < SESSION_MIN_BEARER_LENGTH) {
      throw new KamiwazaError("missing_credentials", "no bearer token available for the platform");
    }
    const claims = decodeJwtClaims(token);
    if (!claims || typeof claims.sid !== "string" || claims.sid.length === 0) {
      throw new KamiwazaError(
        "session_required",
        "workroom binding requires a login session token with a sid claim; a personal access token cannot bind",
      );
    }
    return token;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop upstream messages, causes, headers and bodies, including unknown signed secrets. */
function safeRuntimeError(error: unknown): KamiwazaError {
  return new KamiwazaError(error instanceof KamiwazaError ? error.code : 'network_error',
    'Native runtime request failed', { httpStatus: error instanceof KamiwazaError ? error.httpStatus : undefined });
}

function runtimeAwait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new KamiwazaError('timeout', 'Native runtime request cancelled or timed out'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
  });
}

/** At most one upstream read per pull; no retained history and no total SSE byte limit. */
function runtimeStream(response: Response, controller: AbortController, dispose: () => void): ReadableStream<Uint8Array> {
  const reader = response.body?.getReader();
  let stopped = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const finish = (mode: 'close' | 'cancel' | 'error', error?: KamiwazaError) => {
    if (stopped) return;
    stopped = true;
    controller.signal.removeEventListener('abort', abort);
    dispose();
    if (mode !== 'close') void reader?.cancel().catch(() => {});
    reader?.releaseLock();
    if (mode === 'error') output.error(error);
    else if (mode === 'close') output.close();
  };
  const abort = () => finish('error', new KamiwazaError('timeout', 'Native runtime request cancelled or timed out'));
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      output = streamController;
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    },
    async pull() {
      try {
        const next = await reader?.read();
        if (stopped) return;
        if (!next || next.done) { finish('close'); return; }
        if (next.value.byteLength > RUNTIME_MAX_BYTES)
          throw new KamiwazaError('malformed_response', 'Runtime stream chunk is too large');
        output.enqueue(next.value);
      } catch (error) {
        if (!stopped) { finish('error', safeRuntimeError(error)); controller.abort(); }
      }
    },
    cancel() { finish('cancel'); controller.abort(); },
  }, { highWaterMark: 0 });
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function truncate(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildQuery(query: RequestSpec["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function requireId(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new KamiwazaError("invalid_request", `${name} is required`);
  return value.trim();
}

function isNamespacedId(v: unknown): v is { namespace: string; id: string } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).namespace === "string" &&
    ((v as Record<string, unknown>).namespace as string).length > 0 &&
    typeof (v as Record<string, unknown>).id === "string" &&
    ((v as Record<string, unknown>).id as string).length > 0
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parser that checks the platform's declared required fields are present. */
function requireFields<T>(fields: readonly string[]): Parser<T> {
  return (json, target) => {
    const rec = asRecord(json);
    if (!rec) throw new KamiwazaError("malformed_response", `${target} did not return a JSON object`, { target });
    for (const f of fields) {
      if (!(f in rec) || rec[f] === undefined) {
        throw new KamiwazaError("malformed_response", `${target} response is missing required field "${f}"`, { target });
      }
    }
    return rec as T;
  };
}

function requireArrayOf<T>(fields: readonly string[]): Parser<T[]> {
  const item = requireFields<T>(fields);
  return (json, target) => {
    if (!Array.isArray(json)) throw new KamiwazaError("malformed_response", `${target} did not return a JSON array`, { target });
    return json.map((entry) => item(entry, target));
  };
}

function parseUserInfo(json: unknown, target: string): UserInfo {
  const rec = requireFields<Record<string, unknown>>(["username", "sub"])(json, target);
  if (typeof rec.username !== "string" || typeof rec.sub !== "string") {
    throw new KamiwazaError("malformed_response", `${target} returned non-string username/sub`, { target });
  }
  return rec as unknown as UserInfo;
}

function parseCheckResponse(json: unknown, target: string): CheckResponse {
  const rec = requireFields<Record<string, unknown>>(["allow", "decision_id", "reason"])(json, target);
  if (typeof rec.allow !== "boolean" || typeof rec.decision_id !== "string" || typeof rec.reason !== "string") {
    throw new KamiwazaError("malformed_response", `${target} returned a malformed decision`, { target });
  }
  return { allow: rec.allow, decision_id: rec.decision_id, reason: rec.reason };
}

function parseTokenResponse(json: unknown, target: string): TokenResponse {
  const rec = requireFields<Record<string, unknown>>(["access_token", "expires_in"])(json, target);
  if (typeof rec.access_token !== "string" || rec.access_token.length === 0 || !Number.isFinite(rec.expires_in)) {
    throw new KamiwazaError("malformed_response", `${target} returned a malformed token response`, { target });
  }
  return rec as unknown as TokenResponse;
}

/** Decode JWT claims without verifying. Used only to detect a login session (`sid`). */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}
