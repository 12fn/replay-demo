// Client contract for /api/ontology*. Mirrors src/server/ontology-routes.ts; only fields the
// panel renders are declared. The browser never sees a platform token, client or secret.
import { ApiError } from './api';

export type PublishStatus = 'pending' | 'accepted' | 'uncertain' | 'failed';
export type HealthState = 'ready' | 'degraded' | 'unavailable' | 'unknown' | 'error';

export interface NativeReceipt {
  clientRequestId: string;
  requestId: string | null;
  target: { method: string; path: string };
  status: number;
  durationMs: number;
  validatedAt: string;
  signatureTs?: string | null;
}

export interface NativeErrorBlock {
  code: string;
  httpStatus: number | null;
  requestId: string | null;
  message: string;
}

export interface SourceMetadata {
  sourceId: string;
  version: string;
  title: string;
  sourceDate: string;
  hash: string;
  conceptCount: number;
  relationshipCount: number;
  episodeBytes: number;
}

export interface LocalGraphNode {
  id: string;
  name: string;
  type: string;
  summary: string;
}

export interface LocalGraphEdge {
  id: string;
  source: string;
  target: string;
  name: string;
  fact: string;
  theme: string;
}

export interface LocalDefinitionGraph {
  label: string;
  nodes: LocalGraphNode[];
  edges: LocalGraphEdge[];
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

export interface HealthBlock {
  state: HealthState;
  checkedAt: string;
  cached: boolean;
  receipt: NativeReceipt | null;
  raw: Record<string, unknown> | null;
  error: NativeErrorBlock | null;
}

export interface SubgraphBlock {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  sources: SubgraphSource[];
  truncated: boolean;
  danglingEdges: number;
  bounds: { maxNodes: number; maxEdges: number };
  checkedAt: string;
  cached: boolean;
  receipt: NativeReceipt | null;
  error: NativeErrorBlock | null;
}

export interface PublishRecord {
  key: string;
  workroomId: string;
  ontologyId: string;
  groupId: string;
  sourceId: string;
  sourceVersion: string;
  sourceHash: string;
  status: PublishStatus;
  attempt: number;
  requestedByRole: 'instructor';
  startedAt: string;
  finishedAt: string | null;
  receipt: NativeReceipt | null;
  result: { addedCount: number; groupId: string; backend: unknown } | null;
  error: NativeErrorBlock | null;
  note: string;
}

export interface Budget {
  requestsUsed: number;
  maxRequests: number;
  committedUsd: number;
  maxUsd: number;
  bridgeRequests: number;
  bridgePurpose: string;
}

export interface OntologyRead {
  mode: 'local-demo' | 'kamiwaza';
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
    status: 'unpublished' | PublishStatus;
    ingestionKey: string | null;
    record: PublishRecord | null;
    history: PublishRecord[];
    canPublish: boolean;
    reason: string;
  };
  budget: Budget;
}

export interface PublishResponse {
  status: PublishStatus;
  already: boolean;
  record: PublishRecord;
  budget: Budget;
}

/** Server error with the structured extras the publish route attaches. */
export class OntologyApiError extends ApiError {
  readonly code: string | null;
  readonly record: PublishRecord | null;
  constructor(status: number, message: string, extra: { code?: unknown; record?: unknown } = {}) {
    super(status, message);
    this.name = 'OntologyApiError';
    this.code = typeof extra.code === 'string' ? extra.code : null;
    this.record = extra.record && typeof extra.record === 'object' ? (extra.record as PublishRecord) : null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: 'no-store', headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new OntologyApiError(0, 'Backend unreachable');
  }
  let body: { error?: unknown; code?: unknown; record?: unknown } & Record<string, unknown> = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok && !(res.status === 502 && typeof body.status === 'string' && body.record)) {
    throw new OntologyApiError(res.status, typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`.trim(), body);
  }
  return body as unknown as T;
}

export const ontologyApi = {
  /** Read-only. No paid call; the server caches platform reads for ~15 s per workroom. */
  read: (signal?: AbortSignal) => request<OntologyRead>('/api/ontology', { signal }),
  /**
   * Paid. Sends one modelling batch to the workroom Graphiti; its extraction runs through REPLAY's
   * metered bridge under the project cap. The server persists a pending record first and never
   * retries on its own. A 502 with a record (failed / uncertain) is returned, not thrown.
   */
  publish: (opts: { acknowledgeDuplicateRisk?: boolean } = {}) =>
    request<PublishResponse>('/api/ontology/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) }),
};
