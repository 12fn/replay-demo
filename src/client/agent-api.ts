import type {BudgetLimit, Allowance} from '../inference/allowance';
// Client contract for /api/agents/*. Mirrors src/server/agent-routes.ts. Only fields the panel renders are declared.
import { ApiError, type Side, type StaffTask } from './api';

export type ToolKind = 'query' | 'action';
export type ToolScope = 'player' | 'staff';
export type WatchKind = 'provenance-watch' | 'model-staff-agent';

export interface ToolSpec { name: string; kind: ToolKind; description: string; args: { type: 'object'; properties: Record<string, unknown>; required: string[] } }

export interface Budget { allowance?: Allowance; requestsUsed: number; maxRequests: BudgetLimit; committedUsd: number; maxUsd: BudgetLimit }

export interface ToolCatalog {
  exerciseId: string;
  side: Side;
  scope: ToolScope;
  tools: ToolSpec[];
  /** Names of the read-only tools a staff watch may use. */
  staffTools: string[];
  /** Capabilities that deliberately do not exist (code execution, shell, network, opposing records). */
  unavailable: string[];
  pulseBudget: { maxSteps: number; maxCompletions: number };
  opponent: { enabled: boolean; playstyle: string; model: string };
  budget: Budget;
}

/** Watch fields beyond the base StaffTask. Older rows may lack them; treat every field as optional. */
export interface WatchTask extends StaffTask {
  objective?: string;
  watchConfig?: {schema: 'replay.watch-config/1'; kind: 'reserve' | 'objective-control' | 'report-provenance'};
  interpretation?: string;
  kind?: WatchKind;
  phase?: string;
  modelEnabled?: boolean;
  lastObservedTick?: number | null;
  lastMethod?: string | null;
  lastReceiptId?: string | null;
  modelResult?: {eventId:string;tick:number;observedTick:number|null;text:string;sourceIds:string[];receiptId:string|null} | null;
}

export interface TraceEntry { id: string; tick: number; kind: string; summary: string; receiptId: string | null; method: string | null; errors: string[] | null; recordedAt?: string }

export class AgentApiError extends ApiError {
  readonly unknown: string[];
  readonly receiptId: string | null;
  constructor(status: number, message: string, extra: { unknown?: unknown; receiptId?: unknown } = {}) {
    super(status, message);
    this.name = 'AgentApiError';
    this.unknown = Array.isArray(extra.unknown) ? extra.unknown.filter((e): e is string => typeof e === 'string') : [];
    this.receiptId = typeof extra.receiptId === 'string' ? extra.receiptId : null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new AgentApiError(0, 'Backend unreachable');
  }
  if (!res.ok) {
    let body: { error?: unknown; unknown?: unknown; receiptId?: unknown } = {};
    try { body = (await res.json()) as typeof body; } catch { /* non-JSON error body */ }
    throw new AgentApiError(res.status, typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`.trim(), body);
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

export const agentApi = {
  tools: (side: Side, signal?: AbortSignal) => request<ToolCatalog>(`/api/agents/tools?side=${side}`, { signal, cache: 'no-store' }),
  /** Enabling is paid (bounded pulses on material events); disabling keeps the free deterministic watch. */
  setTaskModel: (taskId: string, enabled: boolean) => post<{ task: WatchTask; budget: Budget }>(`/api/agents/tasks/${encodeURIComponent(taskId)}/model`, { enabled }),
  task: (taskId: string, signal?: AbortSignal) => request<{ task: WatchTask; trace: TraceEntry[] }>(`/api/agents/tasks/${encodeURIComponent(taskId)}`, { signal, cache: 'no-store' }),
};
