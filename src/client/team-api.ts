// Client contract for the shared-exercise team endpoints (/api/team/*). Kept apart from api.ts so
// the exercise contract stays unchanged. Join codes are held only in transient dialog state; nothing
// here touches storage, the URL, tokens or passwords. Mirrors the contract main is building.

import { ApiError, type Role, type Side } from './api';

export interface TeamParticipant {
  subject: string;
  name: string;
  /** Seat recorded at enrollment. Not a permission grant; live ability comes from the native context. */
  roleAtJoin: Role | string;
  organization: string;
  source?: 'campaign-carryover' | 'campaign-join';
  joinedTick: number;
  active: boolean;
  owner: boolean;
}

export interface TeamView {
  exerciseId: string;
  name: string;
  side: Side;
  /** Backend lifecycle status: running | completed | fault. */
  status: string;
  /** True when this session may issue or rotate join codes and remove participants. */
  canManage: boolean;
  participants: TeamParticipant[];
}

export interface JoinCode {
  code: string;
  expiresAt: string;
}

export interface JoinResult {
  exerciseId: string;
  side: Side;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* plain text */
  }
  return text.slice(0, 300);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: 'no-store', headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Backend unreachable');
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

export const teamApi = {
  /** Roster and management rights for the active exercise. */
  get: (signal?: AbortSignal) => request<TeamView>('/api/team', { signal }),
  /** Creates or rotates the 24-hour, same-workroom join code. Owner or sharing-capable instructor only. */
  code: () => post<JoinCode>('/api/team/code', {}),
  /** Joins the exercise the code belongs to and selects it for this session. */
  join: (code: string) => post<JoinResult>('/api/team/join', { code }),
  /** Removes a non-owner participant; the backend revokes the current join code as a side effect. */
  remove: (subject: string) => post<{ removed: true }>('/api/team/remove', { subject }),
};
