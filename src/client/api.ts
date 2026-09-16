import type {KeyMoment,KeyMomentScope} from '../learning/key-moments';
// Client-side contract for the REPLAY backend. Mirrors the interface agreed with the server builder.

export type Side = 'blue' | 'red';
export type Role = 'commander' | 'intelligence' | 'instructor';
export type IdentityMode = 'local-demo' | 'kamiwaza';
export type ExerciseKind = 'live' | 'recorded' | 'branch';

export interface Identity {
  subject: string;
  name: string;
  role: Role;
  organization: string;
  mode: IdentityMode;
}

export interface ExerciseSummary {
  options?: {scenario?:import('../scenarios/catalog').ExerciseScenario;map?:string};
  id: string;
  name: string;
  kind: ExerciseKind;
  /** Backend lifecycle status: running | completed | fault. */
  status: string;
  tick: number;
  /** Side the assigned human controls in this exercise (authoritative). */
  humanSide: Side;
  /** Whether the paid model opponent is currently enabled (authoritative). */
  agentEnabled?: boolean;
  createdAt?: string;
  parentId?: string;
  forkTick?: number;
}

export interface Attack {
  id: string;
  target: string | null;
  troops: number;
}

export interface Unit {
  id: number;
  type: string;
  tile: number;
  level: number;
}

export interface PlayerState {
  side: Side;
  id: string;
  name: string;
  smallId: number;
  tiles: number;
  troops: number;
  gold: number;
  maxTroops: number;
  spawn: number | null;
  alive: boolean;
  attacks: Attack[];
  units: Unit[];
}

export interface GameState {
  tick: number;
  fingerprint: string;
  simulationId: string;
  map: string;
  width: number;
  height: number;
  spawning: boolean;
  players: PlayerState[];
  owners: number[];
  land: number[];
}

export interface TimelineEvent {
  id: string;
  sequence: number;
  tick: number;
  kind: string;
  actor: string;
  summary: string;
  side?: Side;
  /** Structured record details (command intent, before/after resources, receipts). Shape varies by kind. */
  details?: unknown;
  recordedAt?: string;
}

export interface Report {
  packet?:import('../scenarios/evidence-records').PacketRecord['packet'];
  evidenceStatus?:'current'|'superseded'|'disputed';
  supersededBy?:string;
  disputedWith?:string[];
  id: string;
  tick: number;
  title: string;
  body: string;
  source: string;
  confidence: string;
  supersedes?: string;
  side: Side;
  /** True for synthetic engine observations or explicitly authored scenario claims. */
  synthetic?: boolean;
  /** For reports copied into a branch: the id of the report in the source exercise. */
  parentSourceId?: string;
  observedTroops?: number;
  observedTiles?: number;
}

export interface StaffTask {
  id: string;
  owner: string;
  side: Side;
  title: string;
  status: string;
  cursor: number;
  createdTick?: number;
  lastResult?: string | null;
  sourceIds: string[];
}

export interface Finding {
  id: string;
  tick: number;
  title: string;
  label: string;
  confidence: string;
  criterion: string;
  evidenceIds: string[];
  explanation: string;
  alternative: string;
  side: Side;
}

export interface Dossier {
  summary: string;
  strengths: string[];
  practice: string[];
  priorAttempts: { id: string; name: string; kind: ExerciseKind }[];
  limitations: string[];
}

export interface PlatformStatus {
  inferenceRoute?: 'kamiwaza-local' | 'external-api';
  mode: string;
  version?: string;
  nativeConnected: boolean;
  model: string;
  requests: number;
  spentUsd: number;
  capUsd: number;
  traceCount: number;
  ontologyStatus: string;
  details: string[];
}

export interface Overview {
  sourceDesk?:{packetId:string;title:string;focus:string;notice:string};
  organizationContext?:import('../context/organization-packs').ResolvedOrganizationPack|null;
  keyMoments?: {schema:string;exerciseId:string;cutoff:number;scope:KeyMomentScope;selected:KeyMoment[];candidateCount:number;limitations:string[]};
  navigationRevision?:number;
  executionOrders?:import('../review/execution').OrderProgress[];
  campaign?:import('../campaign/network').NetworkView|null;
  identity: Identity;
  activeId: string;
  exercises: ExerciseSummary[];
  state: GameState;
  /** Application-issued snapshot receipt returned with an order; not proof of human attention. */
  observationReceipt?: string;
  timeline: TimelineEvent[];
  reports: Report[];
  tasks: StaffTask[];
  findings: Finding[];
  dossier: Dossier;
  platform: PlatformStatus;
  /** Side assigned to this session in the active exercise. Authoritative; the client never overrides it. */
  selectedSide: Side;
  /** Null when the live state is displayed; otherwise the historical tick being shown. */
  playbackTick: number | null;
}

export type BuildableUnit = 'City' | 'Defense Post' | 'Port';
export type {ActionOptionsSnapshot} from '../server/action-options-routes';
export const BUILDABLE_UNITS: BuildableUnit[] = ['City', 'Defense Post', 'Port'];

export type Intent =
  | { type: 'attack'; targetID: string | null; troops: number }
  | { type: 'build_unit'; unit: BuildableUnit | 'Warship'; tile: number }
  | { type: 'upgrade_structure'; unit: string; unitId: number }
  | { type: 'cancel_boat'; unitID: number }
  | { type: 'move_warship'; unitIds: number[]; tile: number }
  | { type: 'cancel_attack'; attackID: string }
  | { type: 'boat'; dst: number; troops: number };

export interface StaffReply {
  text: string;
  sourceIds: string[];
  taskId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const msg = parsed.error ?? parsed.message;
    if (typeof msg === 'string') return msg;
  } catch {
    /* plain text body */
  }
  return text.slice(0, 300);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Backend unreachable');
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type DecisionTraceResponse=import('../review/decision-trace').DecisionTrace&{review:{viewTick:number;scope:'as-of'|'later-outcomes'}};

export const api = {
  decisionTrace:(exerciseId:string,eventId:string,side:Side,cutoffTick:number,signal?:AbortSignal,includeLater=false)=>request<DecisionTraceResponse>(`/api/review/decision-trace?${new URLSearchParams({exerciseId,eventId,side,cutoffTick:String(cutoffTick),includeLater:String(includeLater)})}`,{signal,cache:'no-store'}),
  actionOptions: (exerciseId:string,signal?:AbortSignal)=>request<import('../server/action-options-routes').ActionOptionsSnapshot>(`/api/action-options?exerciseId=${encodeURIComponent(exerciseId)}`,{signal,cache:'no-store'}),
  overview: (signal?: AbortSignal) => request<Overview>('/api/overview', { signal, cache: 'no-store' }),
  session: (role: Role) => post<unknown>('/api/session', { role }),
  createExercise: (name?: string, scenarioId?:string) => post<unknown>('/api/exercises', {...(name?{name}:{}),...(scenarioId?{scenarioId}:{})}),
  select: (exerciseId: string, expected?:{activeId:string;playbackTick:number|null;revision:number}) => post<{selected:string;navigationRevision?:number}>('/api/select', { exerciseId,...(expected?{expected}:{}) }),
  command: (side: Side, intent: Intent, idempotencyKey = newIdempotencyKey(), evidence?: {rationale?:string;sourceIds?:string[];observationReceipt?:string}) =>
    post<unknown>('/api/commands', { idempotencyKey, side, intent, ...evidence }),
  createTask: (title: string, side: Side) => post<unknown>('/api/tasks', { title, side }),
  cancelTask: (id: string) => post<unknown>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
  staff: (message: string, side: Side) => post<StaffReply>('/api/staff', { message, side }),
  replay: (tick: number | null, exerciseId?:string) => post<unknown>('/api/replay', { tick,...(exerciseId?{exerciseId}:{}) }),
  branch: (tick: number, side: Side) => post<unknown>('/api/branches', { tick, side }),
  injectReport: () => post<unknown>('/api/reports/inject', {}),
  agent: (enabled: boolean) => post<unknown>('/api/agent', { enabled }),
  /** Ends the active exercise; it becomes a read-only record for review. */
  finish: (exerciseId: string) => post<ExerciseSummary>(`/api/exercises/${encodeURIComponent(exerciseId)}/finish`, {}),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
