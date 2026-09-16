// Client contract for the optional practice campaign (/api/campaigns/*). Kept apart from api.ts so the
// exercise contract stays unchanged. Field names follow the actual backend (src/server/campaign-service.ts
// and campaign-routes.ts). Nothing in this file touches storage, tokens or credentials; authority is a
// server capability resolved from the signed-in session, and every campaign is scoped server-side to the
// owner subject in the configured workroom (other subjects receive 404).

import { ApiError } from './api';
import type { CampaignSession } from '../campaign/session';

/** Progress figures as computed by the server's `campaignProgress`; the client never recomputes budget. */
export interface CampaignProgress {
  completedTicks: number;
  inProgressTicks: number;
  elapsedTicks: number;
  remainingTicks: number;
  budgetReached: boolean;
  missionCount: number;
}

/** Why automatic progression is not running. `reason` is server text; `at` is null after a restart. */
export interface CampaignPause {
  reason: string;
  at: string | null;
}

/** Server-side description of the latest mission (mirrors `TransitionNotice` in campaign-service.ts). */
export interface CampaignTransitionNotice {
  /** One-based mission number. */
  missionIndex: number;
  exerciseId: string;
  name: string;
  scenarioId: string;
  scenarioTitle: string;
  openedAt: string;
  freshWorld: true;
  previous: { exerciseId: string; reason: string; elapsedTicks: number } | null;
  text: string;
}

/**
 * Known pause reasons the panel renders in plain language. The server sends free text; the client maps
 * only the exact owner-pause message and shows everything else verbatim so no cause is invented.
 */
export type CampaignPauseReason = 'participant-pause' | 'restart' | 'authority-revoked' | 'authority-check-failed' | 'fault' | string;

/* ---------------- shared membership (additive; src/server/campaign-membership-service.ts `MembershipView`) ---------------- */

/** Ordered point in campaign time: mission index (zero-based) then canonical tick. */
export interface CampaignMissionPoint {
  missionIndex: number;
  tick: number;
}

export type CampaignMemberRole = 'owner' | 'participant';
export type CampaignMemberStatus = 'active' | 'withdrawn' | 'revoked';

export interface CampaignMemberView {
  subject: string;
  name: string;
  organization: string;
  role: CampaignMemberRole;
  /** Historical label recorded at enrollment. The server never reads it for a decision, and neither may the client. */
  roleAtJoin: string;
  status: CampaignMemberStatus;
  since: CampaignMissionPoint | null;
  until: CampaignMissionPoint | null;
  /** The owner lifted a removal; the subject must rejoin with a current invite. */
  rejoinRequired: boolean;
}

export interface CampaignMissionMembershipView {
  missionIndex: number;
  exerciseId: string;
  /** Exercise lifecycle status, or null when the row is gone. */
  status: string | null;
  /** Subjects seated from membership when the mission opened; null when no record exists (legacy mission). */
  carried: string[] | null;
  excluded: { subject: string; outcome: 'denied' | 'unavailable'; detail: string | null }[] | null;
  recorded: boolean;
  /** The campaign ended but this mission still runs as an ordinary exercise. */
  detached: boolean;
}

export interface CampaignMembershipView {
  version: number;
  maxParticipants: number;
  activeParticipants: number;
  currentPoint: CampaignMissionPoint;
  /** The signed-in subject's own standing. `canManage` is the server's owner decision for this viewer. */
  viewer: { subject: string; role: CampaignMemberRole; status: CampaignMemberStatus; canManage: boolean };
  members: CampaignMemberView[];
  missions: CampaignMissionMembershipView[];
  detached: { exerciseId: string; note: string } | null;
  /** Honest runtime limitations, verbatim from the server. */
  limits: string[];
}

export interface CampaignView {
  /** False when newer session navigation was preserved during creation. */
  navigationSelected?: boolean;
  campaign: CampaignSession;
  /** True while the server holds a fresh write authority for this campaign and will open the next mission. */
  enabled: boolean;
  /** Currently attached, unfinished mission exercise, or null while awaiting / after the end. */
  activeExerciseId: string | null;
  progress: CampaignProgress;
  transitionNotice: CampaignTransitionNotice | null;
  /** Present when `enabled` is false and the campaign is not finished. */
  paused: CampaignPause | null;
  /**
   * Client-derived from `paused` (see `pauseReasonOf` in useCampaign.ts). Present so the panel can show
   * the pause in plain language; never sent by the server.
   */
  pauseReason?: CampaignPauseReason | null;
  /**
   * Roster, per-mission carry record and the viewer's own standing. Always sent by the current server;
   * optional here so older fixtures and servers that predate shared enrollment still type-check.
   */
  membership?: CampaignMembershipView;
}

/** One row of `GET /api/campaigns`: campaigns the signed-in subject owns or has joined in this workroom. */
export interface CampaignListItem {
  id: string;
  name: string;
  status: CampaignSession['status'];
  revision: number;
  missionCount: number;
  playedTicks: number;
  targetTicks: number;
  enabled: boolean;
  /** Absent from servers that predate shared enrollment (owner-only lists). */
  role?: CampaignMemberRole;
}

/** `POST /api/campaigns/:id/code`. Shown once; never stored by the client. */
export interface CampaignInviteCode {
  code: string;
  expiresAt: string;
}

/** `POST /api/campaigns/join`. The server has already selected `activeExerciseId` into this session when it is not null. */
export interface CampaignJoinResult {
  navigationSelected?: boolean;
  campaignId: string;
  /** False when the subject was already an active member (the seat was restored if it was missing). */
  joined: boolean;
  activeExerciseId: string | null;
  view: CampaignView;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const msg = parsed.error ?? parsed.message;
    if (typeof msg === 'string') return msg;
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

const id = (campaignId: string) => `/api/campaigns/${encodeURIComponent(campaignId)}`;

export const campaignApi = {
  /** Campaigns owned by this session's subject in the configured workroom. Used for reload/recovery. */
  list: (signal?: AbortSignal) => request<{ campaigns: CampaignListItem[] }>('/api/campaigns', { signal }).then((r) => r.campaigns ?? []),
  /**
   * Creates a campaign owned by the signed-in subject in the current workroom and enables progression
   * with the caller's current authority. The server reserves and opens the first mission and also makes
   * it the session's active exercise, so the client must not call `/api/select` afterwards.
   */
  create: (name: string) => post<CampaignView>('/api/campaigns', { name }),
  /** Current ledger, enabled flag, active mission and progress. Poll this while a campaign is shown. */
  get: (campaignId: string, signal?: AbortSignal) => request<CampaignView>(id(campaignId), { signal }),
  /** Re-checks the caller's native write authority and re-enables automatic progression. */
  resume: (campaignId: string) => post<CampaignView>(`${id(campaignId)}/resume`, {}),
  /** Stops opening new missions. The current mission keeps running; nothing is ended. */
  pause: (campaignId: string) => post<CampaignView>(`${id(campaignId)}/pause`, {}),
  /** Ends the campaign for good. Does not end or alter the current exercise. */
  stop: (campaignId: string) => post<CampaignView>(`${id(campaignId)}/stop`, {}),

  /* ---- shared membership (additive routes; owner-only ones answer 403 for members, 404 for strangers) ---- */

  /**
   * Joins the campaign an opaque invite code belongs to, with the caller's own fresh identity. The server
   * selects the running mission into this session (like create), so the client must not call `/api/select`.
   */
  join: (code: string) => post<CampaignJoinResult>('/api/campaigns/join', { code: code.trim().toLowerCase() }),
  /** The signed-in member leaves. Needs only a fresh session, not write access. Afterwards the campaign is 404 for them. */
  withdraw: (campaignId: string) => post<{ withdrawn: true; campaignId: string }>(`${id(campaignId)}/withdraw`, {}),
  /** Owner with native sharing permission: issues (or rotates) the 24-hour invite. 409 once the campaign is finished. */
  issueCode: (campaignId: string) => post<CampaignInviteCode>(`${id(campaignId)}/code`, {}),
  /** Owner: participant cap excluding the owner, 0..15. */
  setLimit: (campaignId: string, maxParticipants: number) => post<CampaignView>(`${id(campaignId)}/limit`, { maxParticipants }),
  /** Owner: removes a participant now; the invite code is rotated as a side effect. */
  revoke: (campaignId: string, subject: string) => post<CampaignView>(`${id(campaignId)}/revoke`, { subject }),
  /** Owner: lifts a removal. The subject is not re-seated; they rejoin with a current invite. */
  reinstate: (campaignId: string, subject: string) => post<CampaignView & { rejoinRequired: true }>(`${id(campaignId)}/reinstate`, { subject }),
};
