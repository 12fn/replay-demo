/**
 * Ontology routes: the shared workroom domain graph, read and published.
 *
 * Mounted by main through `createApp({ mount })`, after the session middleware
 * has set `res.locals.session` and, in native mode, `res.locals.native`
 * (`NativeLocals`: identity, context, receipts and a non-enumerable
 * `platformClient`). Nothing here trusts the browser for identity, role, group
 * or permissions.
 *
 *   GET  /api/ontology          read-only; no paid call. Local definition, canonical
 *                               source metadata, native health, bounded native subgraph,
 *                               publish state and cached ingestion receipts.
 *   POST /api/ontology/publish  instructor seat with fresh native can_edit + can_run_agents.
 *                               Sends ONE modelling batch to the workroom Graphiti. Graphiti's
 *                               extraction is paid through REPLAY's metered graph bridge under
 *                               the project cap. Never retried automatically.
 *
 * Truthfulness rules:
 *  - No native session, or no REPLAY_ONTOLOGY_ID: reported as unconfigured/local. No graph
 *    is fabricated and the local definition is labelled as such.
 *  - A platform error is returned as an error block with its native request id; nodes and
 *    edges are then empty, never synthesized.
 *  - Health and subgraph reads are cached per workroom for `healthCacheMs` (default 15 s)
 *    so a busy page cannot load the platform; the cache marks itself `cached: true`.
 *  - Publish persists a `pending` record BEFORE the native call. `accepted` needs an actual
 *    `added_count >= 1` with no backend error; a timeout, transport failure or 5xx after the
 *    request was sent is `uncertain` (the batch may have been ingested and billed); a
 *    denial or 4xx is `failed`. `uncertain` blocks further publishes until an operator
 *    explicitly acknowledges the duplicate-billing risk.
 *  - Request bodies may not choose the group: the group is always the configured workroom.
 *  - Responses never contain the platform client, tokens, secrets or configuration maps.
 */
import type express from "express";
import { z } from "zod";
import { GRAPH_DEFAULT_PURPOSE } from "./graph-bridge.ts";
import { KamiwazaError, type AddKnowledgeResult, type NativePlatformAdapter, type RequestReceipt, type RequestSpec, type SignedResult } from "../platform/index.ts";
import { GameService, ServiceError, type Session } from "./service.ts";
import {
  DOMAIN_ONTOLOGY,
  buildKnowledgeRequest,
  ingestionKey,
  ingestionKeyPrefix,
  isUuid,
  localDefinitionGraph,
  sourceMetadata,
  type LocalDefinitionGraph,
  type SourceMetadata,
} from "../ontology/index.ts";

// ---------------------------------------------------------------------------
// Public types (mirrored in src/client/ontology-api.ts)
// ---------------------------------------------------------------------------

export type PublishStatus = "pending" | "accepted" | "uncertain" | "failed";

export interface PublishError {
  code: string;
  httpStatus: number | null;
  requestId: string | null;
  message: string;
}

export interface PublishRecord {
  schema: "replay.ontology-publish/1";
  key: string;
  workroomId: string;
  ontologyId: string;
  groupId: string;
  sourceId: string;
  sourceVersion: string;
  sourceHash: string;
  status: PublishStatus;
  attempt: number;
  requestedByRole: "instructor";
  startedAt: string;
  finishedAt: string | null;
  /** Native receipt of the knowledge call, when a response was received. */
  receipt: RequestReceipt | null;
  result: { addedCount: number; groupId: string; backend: unknown } | null;
  error: PublishError | null;
  /** Human explanation of the state, safe to display. */
  note: string;
}

export interface NativeErrorBlock {
  code: string;
  httpStatus: number | null;
  requestId: string | null;
  message: string;
}

export type HealthState = "ready" | "degraded" | "unavailable" | "unknown" | "error";

export interface HealthBlock {
  state: HealthState;
  checkedAt: string;
  cached: boolean;
  receipt: RequestReceipt | null;
  /** Platform health body as returned (open object per the installed schema), bounded. */
  raw: Record<string, unknown> | null;
  error: NativeErrorBlock | null;
}

export interface SubgraphNode {
  uuid: string;
  name: string;
  type: string;
  summary: string | null;
}

export interface SubgraphEdge {
  fact_uuid: string;
  source_uuid: string;
  target_uuid: string;
  fact: string;
  name: string | null;
  valid_at: string | null;
  invalid_at: string | null;
}

export interface SubgraphSource {
  fact_uuid: string;
  sources: { source_id: string; chunk_id: string | null; source_urn: string | null; score: number | null }[];
}

export interface SubgraphBlock {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  sources: SubgraphSource[];
  /** Platform-reported cap hit, or this module's own bound applied. */
  truncated: boolean;
  /** Edges dropped because an endpoint was not in the node set. */
  danglingEdges: number;
  bounds: { maxNodes: number; maxEdges: number };
  checkedAt: string;
  cached: boolean;
  receipt: RequestReceipt | null;
  error: NativeErrorBlock | null;
}

export interface OntologyReadResponse {
  mode: "local-demo" | "kamiwaza";
  configured: boolean;
  ontologyId: string | null;
  workroomId: string | null;
  source: SourceMetadata;
  definition: LocalDefinitionGraph;
  native: {
    identity: { nativeRole: string | null; canEdit: boolean; canRunAgents: boolean; validatedAt: string | null };
    health: HealthBlock;
    subgraph: SubgraphBlock;
  } | null;
  publish: {
    status: "unpublished" | PublishStatus;
    ingestionKey: string | null;
    record: PublishRecord | null;
    history: PublishRecord[];
    canPublish: boolean;
    reason: string;
  };
  budget: Budget;
}

export interface Budget {
  requestsUsed: number;
  maxRequests: number;
  committedUsd: number;
  maxUsd: number;
  /** Paid calls Graphiti has made through the metered bridge (ledger rows with the bridge purpose). */
  bridgeRequests: number;
  bridgePurpose: string;
}

export interface OntologyRoutesOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Read cache lifetime for health and subgraph, per workroom. Default 15 s. */
  healthCacheMs?: number;
  maxNodes?: number;
  maxEdges?: number;
}

export interface OntologyRoutes {
  ontologyId: string | null;
  invalidate(): void;
}

export class OntologyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OntologyConfigError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ONTOLOGY_ID_ENV = "REPLAY_ONTOLOGY_ID";
export const DEFAULT_HEALTH_CACHE_MS = 15_000;
export const DEFAULT_MAX_NODES = 200;
export const DEFAULT_MAX_EDGES = 600;
const PLATFORM_MAX_NODES = 500;
const PLATFORM_MAX_EDGES = 2500;
const MAX_RAW_BYTES = 4 * 1024;
const MAX_HISTORY = 20;

/** Validate the ontology instance id from the environment. Set-but-invalid is a startup error. */
export function readOntologyConfig(env: NodeJS.ProcessEnv = process.env): { ontologyId: string | null } {
  const raw = (env[ONTOLOGY_ID_ENV] ?? "").trim();
  if (!raw) return { ontologyId: null };
  if (!isUuid(raw)) throw new OntologyConfigError(`${ONTOLOGY_ID_ENV} must be the UUID of the workroom's ontology instance`);
  return { ontologyId: raw.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Locals
// ---------------------------------------------------------------------------

interface NativeLocalsView {
  identity?: { subject?: string };
  context?: { workroomId?: string; nativeRole?: string; canEdit?: boolean; canRunAgents?: boolean; readOnlyReason?: string | null; validatedAt?: string };
  nativeReceipts?: RequestReceipt[];
  platformClient?: unknown;
}

interface Guards {
  requireAgents?: express.RequestHandler;
  requireActive?: express.RequestHandler;
}

function sessionOf(res: express.Response): Session {
  const s = res.locals.session as Session | undefined;
  if (!s || !s.identity || !s.activeId) throw new ServiceError(401, "No exercise session");
  const native = res.locals.native as NativeLocalsView | null | undefined;
  if (native?.identity?.subject && native.identity.subject !== s.identity.subject) throw new ServiceError(403, "Native identity does not match the exercise session");
  return s;
}

function nativeOf(res: express.Response): NativeLocalsView | null {
  const native = res.locals.native as NativeLocalsView | null | undefined;
  return native && typeof native === "object" && native.context ? native : null;
}

/** The platform client is a non-enumerable property; read it directly and never re-expose it. */
function clientOf(native: NativeLocalsView): NativePlatformAdapter | null {
  const c = native.platformClient;
  return c && typeof c === "object" ? (c as NativePlatformAdapter) : null;
}

function send(res: express.Response, err: unknown) {
  if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Request did not match the expected schema" });
  const message = String((err as Error)?.message ?? "Request failed").replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]");
  return res.status(400).json({ error: message });
}

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (h: Handler): express.RequestHandler => async (req, res) => {
  try {
    await h(req, res);
  } catch (e) {
    send(res, e);
  }
};
const passthrough: express.RequestHandler = (_req, _res, next) => next();

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountOntologyRoutes(app: express.Express | express.Router, service: GameService, opts: OntologyRoutesOptions = {}): OntologyRoutes {
  const { ontologyId } = readOntologyConfig(opts.env ?? process.env);
  const now = opts.now ?? (() => Date.now());
  const cacheMs = opts.healthCacheMs ?? DEFAULT_HEALTH_CACHE_MS;
  const maxNodes = clampInt(opts.maxNodes ?? DEFAULT_MAX_NODES, 1, PLATFORM_MAX_NODES);
  const maxEdges = clampInt(opts.maxEdges ?? DEFAULT_MAX_EDGES, 1, PLATFORM_MAX_EDGES);
  const guards = ((app as { locals?: { guards?: Guards } }).locals?.guards ?? {}) as Guards;
  const requireActive = guards.requireActive ?? passthrough;
  const requireAgents = guards.requireAgents ?? passthrough;
  // Both Express and Router accept (path, ...handlers); the union type only exposes the two-argument overload.
  const router = app as express.Router;

  const reads = new Map<string, { at: number; health: HealthBlock; subgraph: SubgraphBlock }>();
  const readsInFlight = new Map<string, Promise<{ health: HealthBlock; subgraph: SubgraphBlock }>>();
  const publishInFlight = new Map<string, Promise<PublishRecord>>();

  const settings = {
    get(key: string): PublishRecord | null {
      const row = service.store.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as unknown as { value: string } | undefined;
      if (!row) return null;
      try {
        const rec = JSON.parse(row.value) as PublishRecord;
        return rec && rec.schema === "replay.ontology-publish/1" ? rec : null;
      } catch {
        return null;
      }
    },
    put(record: PublishRecord): void {
      service.store.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(record.key, JSON.stringify(record));
    },
    history(prefix: string): PublishRecord[] {
      const rows = service.store.db.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY key").all(`${prefix.replace(/[%_]/g, "\\$&")}%`) as unknown as { value: string }[];
      const out: PublishRecord[] = [];
      for (const r of rows) {
        try {
          const rec = JSON.parse(r.value) as PublishRecord;
          if (rec && rec.schema === "replay.ontology-publish/1") out.push(rec);
        } catch {
          /* ignore foreign rows */
        }
      }
      return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)).slice(0, MAX_HISTORY);
    },
  };

  const budget = (): Budget => {
    const s = service.ledger.summary();
    const bridgeRequests = service.ledger.listReceipts().filter((r) => r.purpose === GRAPH_DEFAULT_PURPOSE).length;
    return { requestsUsed: s.requestsUsed, maxRequests: s.maxRequests, committedUsd: s.committedUsd, maxUsd: s.maxUsd, bridgeRequests, bridgePurpose: GRAPH_DEFAULT_PURPOSE };
  };

  // ---- reads ----------------------------------------------------------------

  async function readNative(workroomId: string, client: NativePlatformAdapter): Promise<{ health: HealthBlock; subgraph: SubgraphBlock; cached: boolean }> {
    const key = `${workroomId}:${ontologyId}`;
    const hit = reads.get(key);
    if (hit && now() - hit.at <= cacheMs) return { health: { ...hit.health, cached: true }, subgraph: { ...hit.subgraph, cached: true }, cached: true };
    let run = readsInFlight.get(key);
    if (!run) {
      run = (async () => {
        const [health, subgraph] = await Promise.all([fetchHealth(workroomId, client), fetchSubgraph(workroomId, client)]);
        reads.set(key, { at: now(), health, subgraph });
        return { health, subgraph };
      })().finally(() => readsInFlight.delete(key));
      readsInFlight.set(key, run);
    }
    const r = await run;
    return { ...r, cached: false };
  }

  async function fetchHealth(workroomId: string, client: NativePlatformAdapter): Promise<HealthBlock> {
    const checkedAt = new Date(now()).toISOString();
    try {
      const r = await client.ontologyHealth(ontologyId!, { workroomId });
      const raw = boundRaw(r.data);
      return { state: healthState(raw), checkedAt, cached: false, receipt: r.receipt, raw, error: null };
    } catch (err) {
      return { state: "error", checkedAt, cached: false, receipt: null, raw: null, error: errorBlock(err) };
    }
  }

  async function fetchSubgraph(workroomId: string, client: NativePlatformAdapter): Promise<SubgraphBlock> {
    const checkedAt = new Date(now()).toISOString();
    const empty: SubgraphBlock = { nodes: [], edges: [], sources: [], truncated: false, danglingEdges: 0, bounds: { maxNodes, maxEdges }, checkedAt, cached: false, receipt: null, error: null };
    // The adapter interface declares only named methods; the installed client also exposes the generic signed `request`.
    const generic = client as unknown as { request?: (spec: RequestSpec) => Promise<SignedResult<unknown>> };
    if (typeof generic.request !== "function") {
      return { ...empty, error: { code: "adapter_unsupported", httpStatus: null, requestId: null, message: "The platform client in use does not expose the signed request escape hatch needed for the subgraph read" } };
    }
    try {
      const r = await generic.request.call(client, {
        method: "GET",
        path: `/context/ontologies/${encodeURIComponent(ontologyId!)}/workrooms/${encodeURIComponent(workroomId)}/subgraph`,
        query: { max_nodes: maxNodes, max_edges: maxEdges },
        workroomId,
        capability: "knowledge",
      });
      return { ...parseSubgraph(r.data, maxNodes, maxEdges), bounds: { maxNodes, maxEdges }, checkedAt, cached: false, receipt: r.receipt, error: null };
    } catch (err) {
      return { ...empty, error: errorBlock(err) };
    }
  }

  // ---- publish --------------------------------------------------------------

  async function publish(key: string, workroomId: string, client: NativePlatformAdapter, attempt: number): Promise<PublishRecord> {
    const meta = sourceMetadata(DOMAIN_ONTOLOGY);
    const record: PublishRecord = {
      schema: "replay.ontology-publish/1",
      key,
      workroomId,
      ontologyId: ontologyId!,
      groupId: workroomId,
      sourceId: meta.sourceId,
      sourceVersion: meta.version,
      sourceHash: meta.hash,
      status: "pending",
      attempt,
      requestedByRole: "instructor",
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      receipt: null,
      result: null,
      error: null,
      note: "Batch handed to the platform; waiting for the knowledge result.",
    };
    // Durable BEFORE the native call: a crash after this line leaves an honest `pending` row.
    settings.put(record);
    const request = buildKnowledgeRequest(workroomId, DOMAIN_ONTOLOGY);
    let outcome: SignedResult<AddKnowledgeResult>;
    try {
      outcome = await client.addKnowledge(ontologyId!, request, { workroomId });
    } catch (err) {
      const e = errorBlock(err);
      record.error = e;
      record.finishedAt = new Date(now()).toISOString();
      if (sentAndUnanswered(err)) {
        record.status = "uncertain";
        record.note = "The platform did not return a definite answer after the batch was sent. It may or may not have been ingested and billed. Nothing is retried automatically; an operator must inspect the workroom graph before publishing again.";
      } else {
        record.status = "failed";
        record.note = "The platform refused the batch before processing it. Nothing was ingested or billed by REPLAY's bridge for this attempt.";
      }
      settings.put(record);
      reads.delete(`${workroomId}:${ontologyId}`);
      return record;
    }
    record.receipt = outcome.receipt;
    record.finishedAt = new Date(now()).toISOString();
    const data = outcome.data;
    const backendError = typeof data.error === "string" && data.error.trim().length > 0 ? data.error.trim().slice(0, 240) : null;
    if (backendError || !(Number.isFinite(data.added_count) && data.added_count >= 1)) {
      record.status = "failed";
      record.error = { code: "backend_rejected", httpStatus: outcome.receipt.status, requestId: outcome.receipt.requestId, message: backendError ?? "The platform processed zero messages" };
      record.result = { addedCount: Number.isFinite(data.added_count) ? data.added_count : 0, groupId: data.group_id, backend: boundRaw(data.result ?? null) };
      record.note = "The platform answered but did not accept the batch. Check the native request id with the platform operator before publishing again.";
    } else {
      record.status = "accepted";
      record.result = { addedCount: data.added_count, groupId: data.group_id, backend: boundRaw(data.result ?? null) };
      record.note = "The platform accepted the batch. Graphiti extracts entities asynchronously through REPLAY's metered bridge; the subgraph below shows what the platform currently holds.";
    }
    settings.put(record);
    reads.delete(`${workroomId}:${ontologyId}`);
    return record;
  }

  // ---- routes ---------------------------------------------------------------

  router.get(
    "/api/ontology",
    requireActive,
    wrap(async (_req, res) => {
      const session = sessionOf(res);
      const native = nativeOf(res);
      const source = sourceMetadata(DOMAIN_ONTOLOGY);
      const definition = localDefinitionGraph(DOMAIN_ONTOLOGY);
      const base = { configured: ontologyId !== null, ontologyId, source, definition, budget: budget() };

      if (!native) {
        const reason = session.identity.mode === "kamiwaza" ? "No native workroom context was resolved for this session." : "Publishing needs a native Kamiwaza session; this instance runs local demo identities.";
        const out: OntologyReadResponse = { ...base, mode: "local-demo", workroomId: null, native: null, publish: { status: "unpublished", ingestionKey: null, record: null, history: [], canPublish: false, reason } };
        res.json(out);
        return;
      }

      const workroomId = native.context!.workroomId;
      if (!isUuid(workroomId)) throw new ServiceError(503, "The native workroom id is not a UUID; refusing to address the platform graph");
      const identity = { nativeRole: native.context!.nativeRole ?? null, canEdit: native.context!.canEdit === true, canRunAgents: native.context!.canRunAgents === true, validatedAt: native.context!.validatedAt ?? null };
      const checkedAt = new Date(now()).toISOString();

      if (!ontologyId) {
        const unconfigured: NativeErrorBlock = { code: "unconfigured", httpStatus: null, requestId: null, message: `${ONTOLOGY_ID_ENV} is not configured on the server; no graph was read` };
        const out: OntologyReadResponse = {
          ...base,
          mode: "kamiwaza",
          workroomId: workroomId.toLowerCase(),
          native: {
            identity,
            health: { state: "unknown", checkedAt, cached: false, receipt: null, raw: null, error: unconfigured },
            subgraph: { nodes: [], edges: [], sources: [], truncated: false, danglingEdges: 0, bounds: { maxNodes, maxEdges }, checkedAt, cached: false, receipt: null, error: unconfigured },
          },
          publish: { status: "unpublished", ingestionKey: null, record: null, history: [], canPublish: false, reason: `${ONTOLOGY_ID_ENV} is not configured on the server.` },
        };
        res.json(out);
        return;
      }

      const client = clientOf(native);
      const key = ingestionKey(workroomId, ontologyId, DOMAIN_ONTOLOGY);
      const record = settings.get(key);
      const history = settings.history(ingestionKeyPrefix(workroomId, ontologyId));
      const status: OntologyReadResponse["publish"]["status"] = publishInFlight.has(key) ? "pending" : (record?.status ?? "unpublished");
      const { canPublish, reason } = publishability(session, native, status);

      let health: HealthBlock;
      let subgraph: SubgraphBlock;
      if (!client) {
        const e: NativeErrorBlock = { code: "no_platform_client", httpStatus: null, requestId: null, message: "The native session carries no platform client; the graph was not read" };
        health = { state: "unknown", checkedAt, cached: false, receipt: null, raw: null, error: e };
        subgraph = { nodes: [], edges: [], sources: [], truncated: false, danglingEdges: 0, bounds: { maxNodes, maxEdges }, checkedAt, cached: false, receipt: null, error: e };
      } else {
        ({ health, subgraph } = await readNative(workroomId.toLowerCase(), client));
      }
      const out: OntologyReadResponse = {
        ...base,
        mode: "kamiwaza",
        workroomId: workroomId.toLowerCase(),
        native: { identity, health, subgraph },
        publish: { status, ingestionKey: key, record, history, canPublish, reason },
      };
      res.json(out);
    }),
  );

  router.post(
    "/api/ontology/publish",
    requireActive,
    requireAgents,
    wrap(async (req, res) => {
      const session = sessionOf(res);
      const native = nativeOf(res);
      if (!native) throw new ServiceError(409, "Publishing needs a native Kamiwaza session; this instance is not connected to a workroom graph", { code: "native_required" });
      if (!ontologyId) throw new ServiceError(409, `${ONTOLOGY_ID_ENV} is not configured on the server`, { code: "unconfigured" });
      if (session.identity.role !== "instructor") throw new ServiceError(403, "Only the instructor seat can publish the shared domain ontology", { code: "role_required" });
      if (native.context!.canEdit !== true || native.context!.canRunAgents !== true) {
        throw new ServiceError(403, `Your native workroom seat does not permit writes and agent runs${native.context!.readOnlyReason ? ` (${native.context!.readOnlyReason})` : ""}`, { code: "native_permission" });
      }
      const workroomId = native.context!.workroomId;
      if (!isUuid(workroomId)) throw new ServiceError(503, "The native workroom id is not a UUID; refusing to address the platform graph", { code: "invalid_workroom" });
      const client = clientOf(native);
      if (!client) throw new ServiceError(503, "The native session carries no platform client", { code: "no_platform_client" });
      // Only the acknowledgement flag is read. Group ids, ontology ids or anything else in the body are ignored.
      const body = z.object({ acknowledgeDuplicateRisk: z.boolean().optional() }).parse(req.body ?? {});

      const group = workroomId.toLowerCase();
      const key = ingestionKey(group, ontologyId, DOMAIN_ONTOLOGY);
      const existing = settings.get(key);
      const inFlight = publishInFlight.get(key);
      if (!inFlight) {
        if (existing?.status === "accepted") {
          res.status(200).json({ status: "accepted", already: true, record: existing, budget: budget() });
          return;
        }
        const unresolved = existing?.status === "uncertain" || existing?.status === "pending";
        if (unresolved && body.acknowledgeDuplicateRisk !== true) {
          throw new ServiceError(409, "The previous publish attempt has no definite outcome. It is not retried automatically because a second batch could be billed twice; acknowledge that risk explicitly to publish again.", { code: "unresolved_previous", record: existing });
        }
      }
      let run = inFlight;
      if (!run) {
        run = publish(key, group, client, (existing?.attempt ?? 0) + 1).finally(() => publishInFlight.delete(key));
        publishInFlight.set(key, run);
      }
      const record = await run;
      const status = record.status === "accepted" ? 201 : 502;
      res.status(status).json({ status: record.status, already: false, record, budget: budget() });
    }),
  );

  return {
    ontologyId,
    invalidate() {
      reads.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publishability(session: Session, native: NativeLocalsView, status: OntologyReadResponse["publish"]["status"]): { canPublish: boolean; reason: string } {
  if (session.identity.role !== "instructor") return { canPublish: false, reason: "Only the instructor seat can publish the shared domain ontology." };
  if (native.context?.canEdit !== true || native.context?.canRunAgents !== true) return { canPublish: false, reason: "Your native workroom seat does not permit writes and agent runs." };
  switch (status) {
    case "pending":
      return { canPublish: false, reason: "A publish is in flight." };
    case "accepted":
      return { canPublish: false, reason: "This version of the source is already in the workroom graph." };
    case "uncertain":
      return { canPublish: true, reason: "The last attempt had no definite outcome; publishing again requires acknowledging the duplicate-billing risk." };
    case "failed":
      return { canPublish: true, reason: "The last attempt was refused before processing; it can be sent again." };
    default:
      return { canPublish: true, reason: "This version has not been published to the workroom graph." };
  }
}

function clampInt(v: number, min: number, max: number): number {
  return Number.isSafeInteger(v) ? Math.min(max, Math.max(min, v)) : max;
}

/** Errors after the request left the process: the platform may have acted. */
function sentAndUnanswered(err: unknown): boolean {
  if (!(err instanceof KamiwazaError)) return true;
  switch (err.code) {
    case "timeout":
    case "network_error":
    case "malformed_response":
      return true;
    case "http_error":
      return typeof err.httpStatus === "number" && err.httpStatus >= 500;
    default:
      return false; // auth_denied, auth_error, missing_signature, invalid_*, forged_header, missing_credentials, session_required: target never processed
  }
}

function errorBlock(err: unknown): NativeErrorBlock {
  if (err instanceof KamiwazaError) {
    return { code: err.code, httpStatus: err.httpStatus ?? null, requestId: err.requestId, message: redact(err.message) };
  }
  const message = err instanceof Error ? err.message : "unknown error";
  return { code: "unexpected", httpStatus: null, requestId: null, message: redact(message).slice(0, 200) };
}

function redact(text: string): string {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]").replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]");
}

function healthState(raw: Record<string, unknown> | null): HealthState {
  if (!raw) return "unknown";
  const state = typeof raw.state === "string" ? raw.state.toLowerCase() : null;
  if (state === "ready" || state === "degraded" || state === "unavailable") return state;
  const status = typeof raw.status === "string" ? raw.status.toLowerCase() : null;
  if (status === "healthy" || status === "ok" || status === "ready" || status === "running") return "ready";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy" || status === "unavailable" || status === "failed" || status === "stopped") return "unavailable";
  if (raw.healthy === true) return "ready";
  if (raw.healthy === false) return "unavailable";
  return "unknown";
}

/** Keep open platform objects, but never more than a few KB and never anything shaped like a credential. */
function boundRaw(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(k)) continue;
    out[k] = v;
  }
  let json = JSON.stringify(out);
  if (json.length <= MAX_RAW_BYTES) return out;
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    trimmed[k] = typeof v === "string" ? v.slice(0, 200) : typeof v === "number" || typeof v === "boolean" || v === null ? v : "[omitted]";
  }
  json = JSON.stringify(trimmed);
  return json.length <= MAX_RAW_BYTES ? trimmed : { truncated: true };
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Validate the installed `WorkroomSubgraph` shape field by field and apply this module's bounds. */
export function parseSubgraph(data: unknown, maxNodes: number, maxEdges: number): Pick<SubgraphBlock, "nodes" | "edges" | "sources" | "truncated" | "danglingEdges"> {
  const rec = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const rawNodes = Array.isArray(rec.nodes) ? rec.nodes : [];
  const rawEdges = Array.isArray(rec.edges) ? rec.edges : [];
  const rawSources = Array.isArray(rec.sources) ? rec.sources : [];
  let truncated = rec.truncated === true;

  const nodes: SubgraphNode[] = [];
  const seen = new Set<string>();
  for (const n of rawNodes) {
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    if (typeof o.uuid !== "string" || typeof o.name !== "string" || typeof o.type !== "string" || seen.has(o.uuid)) continue;
    seen.add(o.uuid);
    nodes.push({ uuid: o.uuid, name: o.name.slice(0, 200), type: o.type.slice(0, 80), summary: str(o.summary)?.slice(0, 1000) ?? null });
    if (nodes.length >= maxNodes) {
      if (rawNodes.length > maxNodes) truncated = true;
      break;
    }
  }

  const edges: SubgraphEdge[] = [];
  let danglingEdges = 0;
  for (const e of rawEdges) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.fact_uuid !== "string" || typeof o.source_uuid !== "string" || typeof o.target_uuid !== "string" || typeof o.fact !== "string") continue;
    if (!seen.has(o.source_uuid) || !seen.has(o.target_uuid)) {
      danglingEdges++;
      continue;
    }
    edges.push({ fact_uuid: o.fact_uuid, source_uuid: o.source_uuid, target_uuid: o.target_uuid, fact: o.fact.slice(0, 1000), name: str(o.name)?.slice(0, 120) ?? null, valid_at: str(o.valid_at), invalid_at: str(o.invalid_at) });
    if (edges.length >= maxEdges) {
      if (rawEdges.length > maxEdges) truncated = true;
      break;
    }
  }

  const factIds = new Set(edges.map((e) => e.fact_uuid));
  const sources: SubgraphSource[] = [];
  for (const s of rawSources) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o.fact_uuid !== "string" || !factIds.has(o.fact_uuid)) continue;
    const refs = Array.isArray(o.sources) ? o.sources : [];
    const list: SubgraphSource["sources"] = [];
    for (const r of refs) {
      if (!r || typeof r !== "object") continue;
      const ro = r as Record<string, unknown>;
      if (typeof ro.source_id !== "string") continue;
      list.push({ source_id: ro.source_id.slice(0, 200), chunk_id: str(ro.chunk_id), source_urn: str(ro.source_urn)?.slice(0, 300) ?? null, score: typeof ro.score === "number" && Number.isFinite(ro.score) ? ro.score : null });
      if (list.length >= 5) break;
    }
    sources.push({ fact_uuid: o.fact_uuid, sources: list });
  }
  return { nodes, edges, sources, truncated, danglingEdges };
}
