/**
 * Pure follow-mode reducer for the optional practice campaign.
 *
 * The campaign server may open a new mission (a fresh exercise with a fresh map and fresh forces)
 * while this browser is showing the previous one. This module decides, without any I/O, whether
 * the session should move to that mission and what the user must be told when it does.
 *
 * Rules it enforces (see docs/process/continuous-campaign-design.md, "Client and AI behavior"):
 *  - Only a live follower moves. A user inspecting a historical tick, or who has paused follow
 *    mode, stays exactly where they are.
 *  - Moving to a new mission clears every piece of per-exercise selection state: selected tile,
 *    pending order, observation receipt. Nothing from the old map may be carried into the new one.
 *  - The transition is emitted once per mission and is idempotent: replaying the same campaign
 *    version, or an older one, never re-announces it and never rewinds the target.
 *  - Frozen review is never moved. The transition is queued and shown as a notice instead.
 */

export const TICKS_PER_SECOND = 10;

/** Per-exercise selection the client keeps in React state. Every field is bound to one exercise. */
export interface ExerciseSelection {
  exerciseId: string;
  selectedTile: number | null;
  /** An order composed but not yet accepted by the server, if any. Never carried across missions. */
  pendingOrder: unknown | null;
  /** Application snapshot receipt returned with the last displayed state; bound to one exercise. */
  observationReceipt: string | null;
}

export interface FollowState {
  /** Bound campaign; reset state explicitly when selecting another campaign. */
  campaignId: string | null;
  /** Exercise this session is currently viewing / commanding. */
  activeExerciseId: string | null;
  /** True while the user has asked to follow the campaign into new missions. */
  following: boolean;
  /** Null when live; a tick number when the user is inspecting a historical state. */
  playbackTick: number | null;
  /** Highest campaign revision already applied. Out-of-order updates below this are ignored. */
  appliedRevision: number;
  /** Exercise id of the last mission this session announced, so the same transition is not repeated. */
  announcedExerciseId: string | null;
  /** A mission that opened while this session was frozen; surfaced as a notice, not applied. */
  heldTransition: FreshMissionTransition | null;
  selection: ExerciseSelection | null;
}

/** Sent by the server on GET /api/campaigns/:id. Kept minimal so the reducer does not depend on the ledger shape. */
export interface CampaignFollowUpdate {
  campaignId: string;
  /** Monotonic ledger revision. */
  revision: number;
  /** Currently attached, not-yet-completed mission exercise, or null while awaiting the next one. */
  activeExerciseId: string | null;
  /** Zero-based index of the active mission in the campaign ledger. */
  missionIndex: number | null;
  /** Human scenario title for the active mission, if the server supplies one. */
  missionTitle?: string | null;
}

export interface FreshMissionTransition {
  kind: 'fresh-mission';
  campaignId: string;
  fromExerciseId: string | null;
  toExerciseId: string;
  missionNumber: number;
  /** Plain-language notice. Always says the map and forces are new. */
  message: string;
}

export type FollowEffect =
  | { type: 'select-exercise'; exerciseId: string }
  | { type: 'announce'; transition: FreshMissionTransition }
  | { type: 'clear-selection'; exerciseId: string };

export interface FollowResult {
  state: FollowState;
  /** Effects the caller performs, in order. Empty when nothing changed. */
  effects: FollowEffect[];
}

export function initialFollowState(input: { activeExerciseId: string | null; following?: boolean; campaignId?: string }): FollowState {
  return {
    campaignId: input.campaignId ?? null,
    activeExerciseId: input.activeExerciseId,
    following: input.following ?? true,
    playbackTick: null,
    appliedRevision: 0,
    announcedExerciseId: input.activeExerciseId,
    heldTransition: null,
    selection: input.activeExerciseId ? emptySelection(input.activeExerciseId) : null,
  };
}

export function emptySelection(exerciseId: string): ExerciseSelection {
  return { exerciseId, selectedTile: null, pendingOrder: null, observationReceipt: null };
}

export function freshMissionMessage(missionNumber: number, title?: string | null): string {
  const name = title ? `Mission ${missionNumber}: ${title}` : `Mission ${missionNumber}`;
  return `${name} has started. This is a new map with new forces. Your earlier mission remains available for review.`;
}

function transitionFor(state: FollowState, update: CampaignFollowUpdate, to: string): FreshMissionTransition {
  const missionNumber = (update.missionIndex ?? 0) + 1;
  return {
    kind: 'fresh-mission',
    campaignId: update.campaignId,
    fromExerciseId: state.activeExerciseId,
    toExerciseId: to,
    missionNumber,
    message: freshMissionMessage(missionNumber, update.missionTitle),
  };
}

/**
 * Applies a campaign poll result. Pure: the same (state, update) pair always yields the same result,
 * and applying the same update twice yields no effects the second time.
 */
export function applyCampaignUpdate(state: FollowState, update: CampaignFollowUpdate): FollowResult {
  // A late poll from a previous campaign cannot change this session.
  if (state.campaignId !== null && state.campaignId !== update.campaignId) return { state, effects: [] };
  // Stale or duplicate revision: never rewind, never re-announce.
  if (update.revision <= state.appliedRevision) return { state, effects: [] };
  const next: FollowState = { ...state, campaignId: update.campaignId, appliedRevision: update.revision };
  const target = update.activeExerciseId;

  // No active mission yet (awaiting the next one, or campaign ended): nothing to move to.
  if (!target || target === state.activeExerciseId) {
    return { state: { ...next, heldTransition: null }, effects: [] };
  }
  // Already announced this mission (e.g. the user moved there manually). Do not repeat.
  if (target === state.announcedExerciseId) {
    return { state: next, effects: [] };
  }

  const transition = transitionFor(state, update, target);

  // Frozen review or paused follow: hold, do not move, do not touch selection.
  if (state.playbackTick !== null || !state.following) {
    return { state: { ...next, heldTransition: transition }, effects: [] };
  }

  return {
    state: {
      ...next,
      activeExerciseId: target,
      announcedExerciseId: target,
      heldTransition: null,
      selection: emptySelection(target),
    },
    effects: [
      { type: 'clear-selection', exerciseId: state.activeExerciseId ?? '' },
      { type: 'select-exercise', exerciseId: target },
      { type: 'announce', transition },
    ],
  };
}

/** The user scrubbed to a historical tick (freeze) or returned to live (null). */
export function setPlaybackTick(state: FollowState, playbackTick: number | null): FollowState {
  if (state.playbackTick === playbackTick) return state;
  return { ...state, playbackTick };
}

/** Explicit user choice. Pausing never moves anything; resuming does not move by itself either. */
export function setFollowing(state: FollowState, following: boolean): FollowState {
  if (state.following === following) return state;
  return { ...state, following };
}

/**
 * The user explicitly accepts a held transition (for example by pressing "Go to current mission" after
 * returning from review). This is the only path from a held transition to a move. It returns to live.
 */
export function acceptHeldTransition(state: FollowState): FollowResult {
  const held = state.heldTransition;
  if (!held) return { state, effects: [] };
  if (held.toExerciseId === state.activeExerciseId) {
    return { state: { ...state, heldTransition: null, announcedExerciseId: held.toExerciseId }, effects: [] };
  }
  return {
    state: {
      ...state,
      activeExerciseId: held.toExerciseId,
      announcedExerciseId: held.toExerciseId,
      heldTransition: null,
      playbackTick: null,
      selection: emptySelection(held.toExerciseId),
    },
    effects: [
      { type: 'clear-selection', exerciseId: state.activeExerciseId ?? '' },
      { type: 'select-exercise', exerciseId: held.toExerciseId },
      { type: 'announce', transition: held },
    ],
  };
}

/** The user selected an exercise by hand (Review, exercise list). Selection state is rebound to it. */
export function userSelectedExercise(state: FollowState, exerciseId: string): FollowState {
  if (state.activeExerciseId === exerciseId) return state;
  const held = state.heldTransition && state.heldTransition.toExerciseId === exerciseId ? null : state.heldTransition;
  return { ...state, activeExerciseId: exerciseId, heldTransition: held, selection: emptySelection(exerciseId) };
}

/**
 * Guard for order submission. A pending order or receipt may only be sent against the exercise it
 * was composed in. Returns null when allowed, otherwise the plain-language reason for refusal.
 */
export function orderCarryoverRefusal(state: FollowState, order: { exerciseId: string; observationReceipt?: string | null }): string | null {
  if (!state.activeExerciseId) return 'No active mission.';
  if (order.exerciseId !== state.activeExerciseId) {
    return 'That order was composed on the previous mission. The current mission has a new map and new forces; compose a new order.';
  }
  if (order.observationReceipt && state.selection && state.selection.exerciseId !== order.exerciseId) {
    return 'The observation receipt belongs to a different mission and cannot be reused.';
  }
  return null;
}

/* ---------- Elapsed-time labels (10 ticks per simulated second) ---------- */

/** "12 min 34 s of simulated play". Never a wall-clock or engagement claim. */
export function simulatedElapsedLabel(ticks: number): string {
  const total = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s} s simulated`;
  return `${m} min ${s.toString().padStart(2, '0')} s simulated`;
}

export function simulatedMinutes(ticks: number): number {
  return Math.max(0, ticks) / TICKS_PER_SECOND / 60;
}
