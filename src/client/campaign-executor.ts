/**
 * Asynchronous executor for the optional practice campaign. Framework-free so its races can be tested
 * with deferred promises; `useCampaign.ts` is a thin React adapter over it.
 *
 * It owns: the bound campaign id, the polled view, the owned-campaign list, the pure follow reducer
 * state (campaign-follow.ts) and every campaign network call. The reducer decides *whether* the session
 * moves; this module performs the move and defends it against everything that can happen while
 * `/api/select` is on the wire.
 *
 * Global session selection contract (src/server/native-http.ts): `POST /api/select {exerciseId}` writes the
 * per-cookie session's activeId / playbackTick / selectedSide; without `expected` it is unconditional and
 * last writer wins. With `expected: {activeId, playbackTick, revision}` (navigation-commit-contract.md) the
 * server refuses with 409 when the session moved meanwhile. Other writers of the same fields are
 * `/api/replay`, `/api/exercises`, `/api/branches`, `/api/exercises/join`, `POST /api/campaigns` and the
 * overview fallback. Aborting the fetch never cancels a server write. See docs/process/campaign-race-notes.md.
 *
 * Rules implemented here:
 *  - Scope: identity, mode or workroom change clears all campaign state; results from the old scope are dropped.
 *  - Intent generation: every explicit user intent (manual exercise select, Review visit, scrub/freeze, follow
 *    toggle, campaign select/clear/start, accept, open mission) bumps `intentGen`. An automatic transition is
 *    only *sent* against the generation it was decided in, and after `/api/select` returns it is only
 *    *delivered* (announced, navigated) if the generation is still unchanged.
 *  - Superseded moves: if the server accepted an automatic select but a stay-put intent (Review visit,
 *    freeze, follow off) happened meanwhile, the previous exercise is re-selected and the transition is
 *    held as a retryable notice. If a go-elsewhere intent happened (manual select, campaign switch), the
 *    session is reconciled from the overview and the transition is held instead of being marked delivered.
 *  - Review never auto-switches, even when playbackTick is null. A frozen tick is never moved.
 *  - A refused /api/select keeps the user where they were and retains the transition for a manual retry.
 *  - One campaign poll in flight; explicit campaign actions abort it and invalidate its response.
 *  - List loads and campaign actions are sequence-checked so a late response never repopulates older state.
 *  - Nothing is created automatically and no campaign is selected without an explicit user choice.
 */
import { ApiError, errorMessage, type ExerciseSummary } from './api';
import type { CampaignListItem, CampaignPause, CampaignView } from './campaign-api';
import {
  acceptHeldTransition,
  applyCampaignUpdate,
  freshMissionMessage,
  initialFollowState,
  setFollowing,
  setPlaybackTick,
  userSelectedExercise,
  type CampaignFollowUpdate,
  type FollowEffect,
  type FollowResult,
  type FollowState,
  type FreshMissionTransition,
} from './campaign-follow';
import type { View } from './components/Header';

export const CAMPAIGN_POLL_MS = 2000;

/* ---------------- pure helpers (unit-tested) ---------------- */

/**
 * Maps the server's free-text pause reason to the panel's known keys. Only the exact owner-pause text is
 * mapped; anything else (restart-or-pause ambiguity, authority failures, faults) is shown verbatim so the
 * client never claims a cause the server did not state.
 */
export function pauseReasonOf(paused: CampaignPause | null | undefined): string | null {
  if (!paused) return null;
  const reason = paused.reason.trim();
  if (/^paused by the campaign owner$/i.test(reason)) return 'participant-pause';
  return reason;
}

export function normalizeCampaignView(raw: CampaignView): CampaignView {
  return { ...raw, pauseReason: pauseReasonOf(raw.paused) };
}

/** Reduces a server view to what the follow reducer needs. Mission index is zero-based from the ledger. */
export function followUpdateFrom(view: CampaignView): CampaignFollowUpdate {
  const idx = view.campaign.missions.findIndex((m) => m.exerciseId === view.activeExerciseId && !m.end);
  const notice = view.transitionNotice;
  return {
    campaignId: view.campaign.id,
    revision: view.campaign.revision,
    activeExerciseId: view.activeExerciseId,
    missionIndex: idx >= 0 ? idx : null,
    missionTitle: notice && notice.exerciseId === view.activeExerciseId ? notice.scenarioTitle : null,
  };
}

/**
 * Applies a poll with the Review rule: while the Review view is open the session is treated as not
 * following for this decision only, so the transition is held as a notice and the user's follow
 * preference is untouched. Live playback (playbackTick null) inside Review still never moves.
 */
export function applyPoll(state: FollowState, update: CampaignFollowUpdate, inReview: boolean): FollowResult {
  if (!inReview) return applyCampaignUpdate(state, update);
  const r = applyCampaignUpdate(setFollowing(state, false), update);
  return { state: { ...r.state, following: state.following }, effects: r.effects };
}

/**
 * The reducer already moved to `transition.toExerciseId` but the session did not end up there (the server
 * rejected /api/select, or the move was superseded and undone). Keep the user where they were (view,
 * selection, playback) and retain the transition as a held, retryable notice. The applied revision stays
 * advanced so the same poll result is not re-applied automatically.
 */
export function retainTransitionAfterFailedMove(before: FollowState, moved: FollowState, transition: FreshMissionTransition): FollowState {
  return {
    ...moved,
    activeExerciseId: before.activeExerciseId,
    announcedExerciseId: before.announcedExerciseId,
    selection: before.selection,
    playbackTick: before.playbackTick,
    heldTransition: transition,
  };
}

/**
 * The server accepted an automatic move but the user went somewhere else by hand while it was on the wire.
 * Whichever write landed last on the server, the overview reconciles `activeExerciseId`; the transition
 * is not marked delivered unless the user is already on the new mission.
 */
export function holdSupersededTransition(current: FollowState, before: FollowState, transition: FreshMissionTransition): FollowState {
  if (current.activeExerciseId === transition.toExerciseId) return { ...current, heldTransition: null };
  return { ...current, announcedExerciseId: before.announcedExerciseId, heldTransition: transition };
}

/** The notice shown right after the owner starts a campaign and the server moved them to mission one. */
export function startTransition(view: CampaignView, fromExerciseId: string | null): FreshMissionTransition | null {
  if (!view.activeExerciseId) return null;
  const idx = view.campaign.missions.findIndex((m) => m.exerciseId === view.activeExerciseId);
  const n = (idx >= 0 ? idx : 0) + 1;
  const title = view.transitionNotice?.exerciseId === view.activeExerciseId ? view.transitionNotice.scenarioTitle : null;
  return { kind: 'fresh-mission', campaignId: view.campaign.id, fromExerciseId, toExerciseId: view.activeExerciseId, missionNumber: n, message: freshMissionMessage(n, title) };
}

const STATUS_LABEL: Record<CampaignView['campaign']['status'], string> = {
  'awaiting-mission': 'Opening next mission',
  running: 'Running',
  completed: 'Finished',
  stopped: 'Stopped',
  fault: 'Stopped (fault)',
};
export const campaignStatusLabel = (s: CampaignView['campaign']['status']) => STATUS_LABEL[s];
const FINISHED = new Set<CampaignView['campaign']['status']>(['completed', 'stopped', 'fault']);

/** One-line summary for the collapsed control. Truthful about paused/stopped progression. */
export function campaignSummary(view: CampaignView | null, opts: { following: boolean; held: boolean }): string {
  if (!view) return 'Practice campaign · optional';
  const c = view.campaign;
  if (FINISHED.has(c.status)) return `${c.name} · ${STATUS_LABEL[c.status]}`;
  const activeIdx = c.missions.findIndex((m) => m.exerciseId === view.activeExerciseId && !m.end);
  const parts = [c.name];
  parts.push(activeIdx >= 0 ? `Mission ${activeIdx + 1} of up to ${c.rules.maxMissions}` : STATUS_LABEL[c.status]);
  if (!view.enabled) parts.push('progression paused');
  else if (opts.following) parts.push('following');
  if (opts.held) parts.push('new mission waiting');
  return parts.join(' · ');
}

/** Unfinished campaigns first so a reload lands on the one still playing; server order otherwise. */
export function sortCampaignsForRecovery(list: CampaignListItem[]): CampaignListItem[] {
  const rank = (i: CampaignListItem) => (FINISHED.has(i.status) ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/** Campaign id recorded on the active exercise by the server, if any. Read-only hint; never auto-selected. */
export function campaignIdOfExercise(ex: ExerciseSummary | undefined): string | null {
  const id = (ex?.options as { campaignId?: unknown } | undefined)?.campaignId;
  return typeof id === 'string' && id ? id : null;
}

/* ---------------- ports ---------------- */

/**
 * Navigation the request was decided against, in the shape `POST /api/select` accepts as `expected`
 * (docs/process/navigation-commit-contract.md). The server refuses with 409 `navigation_changed` when the
 * session's activeId, playbackTick or navigationRevision differ at commit time, which turns a lost race
 * into a held, retryable transition instead of a silent override of the user's newer choice.
 */
export interface NavigationExpectation {
  activeId: string;
  playbackTick: number | null;
  revision: number;
}

export interface SelectRequest {
  exerciseId: string;
  reason: 'automatic' | 'accept' | 'restore' | 'open-mission';
  /** Absent for explicit user selections (open mission) and when the tab has no revision to assert. */
  expected?: NavigationExpectation;
}

/** `/api/select` answers `{selected, navigationRevision?}`; the revision is present when `expected` was sent. */
export interface SelectResponse {
  navigationRevision?: number;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CampaignPorts {
  select(req: SelectRequest): Promise<SelectResponse | unknown>;
  getCampaign(id: string, signal: AbortSignal): Promise<CampaignView>;
  listCampaigns(): Promise<CampaignListItem[]>;
  createCampaign(name: string): Promise<CampaignView>;
  joinCampaign?(code: string): Promise<import('./campaign-api').CampaignJoinResult>;
  pauseCampaign(id: string): Promise<CampaignView>;
  resumeCampaign(id: string): Promise<CampaignView>;
  stopCampaign(id: string): Promise<CampaignView>;
  /** Re-reads the overview so the app reflects the session's new selection. */
  refresh(): Promise<void>;
  setSelectedTile(t: number | null): void;
  navigate(v: View): void;
  scheduler?: Scheduler;
  pollMs?: number;
}

export interface CampaignInputs {
  /** '' when campaign UI is disabled (no identity, overview refused). Any change clears everything. */
  scopeKey: string;
  activeId: string | null;
  playbackTick: number | null;
  /** `navigationRevision` from the overview; null when the server does not report one (legacy sessions). */
  navigationRevision: number | null;
  view: View;
}

export interface CampaignSnapshot {
  campaignId: string | null;
  view: CampaignView | null;
  list: CampaignListItem[];
  listError: string | null;
  busy: boolean;
  actionError: string | null;
  pollError: string | null;
  follow: FollowState;
  lastTransition: FreshMissionTransition | null;
}

/** How a transition run ended. Exposed for tests and diagnostics; the UI reads the snapshot. */
export type TransitionOutcome =
  /** Selected, announced, refreshed. */
  | 'moved'
  /** Scope or campaign changed, or a newer intent arrived before the select was sent. Nothing was sent. */
  | 'stale'
  /** The server refused the select. User kept in place; transition retained for retry. */
  | 'refused'
  /** The server accepted the select but a newer intent arrived while it was on the wire. */
  | 'superseded';

type IntentKind = 'manual-select' | 'review' | 'freeze' | 'follow' | 'campaign' | 'accept' | 'open-mission' | 'scope';
/** Intents that mean "leave me where I am"; a superseded automatic move is undone for these. */
const STAY_PUT: ReadonlySet<IntentKind> = new Set<IntentKind>(['review', 'freeze', 'follow']);

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface CampaignExecutor {
  getSnapshot(): CampaignSnapshot;
  subscribe(listener: () => void): () => void;
  setInputs(inputs: CampaignInputs): void;
  selectCampaign(id: string): void;
  clearCampaign(): void;
  reloadList(): void;
  start(name: string): Promise<void>;
  join(code: string): Promise<void>;
  resume(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  setFollowing(following: boolean): void;
  acceptTransition(): Promise<TransitionOutcome | null>;
  dismissTransition(): void;
  openMission(exerciseId: string): Promise<void>;
  /** Resolves when the current poll (and any transition it started) has settled. Test aid. */
  settle(): Promise<void>;
  activate(): void;
  dispose(): void;
}

export function createCampaignExecutor(ports: CampaignPorts, initial: { activeId: string | null }): CampaignExecutor {
  const scheduler = ports.scheduler ?? defaultScheduler;
  const pollMs = ports.pollMs ?? CAMPAIGN_POLL_MS;

  let snap: CampaignSnapshot = {
    campaignId: null,
    view: null,
    list: [],
    listError: null,
    busy: false,
    actionError: null,
    pollError: null,
    follow: initialFollowState({ activeExerciseId: initial.activeId }),
    lastTransition: null,
  };
  const listeners = new Set<() => void>();
  const patch = (p: Partial<CampaignSnapshot>) => {
    snap = { ...snap, ...p };
    for (const l of listeners) l();
  };
  const commitFollow = (follow: FollowState) => {
    if (follow !== snap.follow) patch({ follow });
  };

  let inputs: CampaignInputs = { scopeKey: '', activeId: initial.activeId, playbackTick: null, navigationRevision: null, view: 'exercise' };

  /** What the tab believes the session's navigation is right now, for a conditional select. */
  const expectation = (activeId: string | null, playbackTick: number | null, revision: number | null): NavigationExpectation | undefined =>
    activeId !== null && revision !== null ? { activeId, playbackTick, revision } : undefined;
  const revisionOf = (res: SelectResponse | unknown): number | null =>
    typeof (res as SelectResponse | null)?.navigationRevision === 'number' ? (res as SelectResponse).navigationRevision! : null;
  let scopeGen = 0;
  /** Bumped by every explicit user intent. */
  let intentGen = 0;
  /** Bumped by go-elsewhere intents only (manual select, campaign switch, accept, open mission). */
  let elsewhereGen = 0;
  /** Bumped by every explicit campaign action so a poll that started before it cannot overwrite its result. */
  let actionSeq = 0;
  let listSeq = 0;
  let pollAbort: AbortController | null = null;
  let pollTimer: unknown = null;
  let pollLoopId = 0;
  let pollSettled: Promise<void> = Promise.resolve();
  let disposed = false;

  const noteIntent = (kind: IntentKind) => {
    intentGen += 1;
    if (!STAY_PUT.has(kind)) elsewhereGen += 1;
  };

  /* ---------- list ---------- */

  const loadList = async () => {
    const g = scopeGen;
    const seq = ++listSeq;
    try {
      const items = await ports.listCampaigns();
      if (g !== scopeGen || seq !== listSeq) return;
      patch({ list: items, listError: null });
    } catch (e) {
      if (isAbort(e) || g !== scopeGen || seq !== listSeq) return;
      patch({ listError: errorMessage(e) });
    }
  };

  /* ---------- poll ---------- */

  const abortPoll = () => {
    pollAbort?.abort();
    pollAbort = null;
  };
  const stopPolling = () => {
    pollLoopId += 1;
    if (pollTimer !== null) scheduler.clearTimeout(pollTimer);
    pollTimer = null;
    abortPoll();
  };

  const tick = async (cid: string) => {
    if (pollAbort) return;
    const ac = new AbortController();
    pollAbort = ac;
    const g = scopeGen;
    const ig = intentGen;
    const aseq = actionSeq;
    const valid = () => g === scopeGen && snap.campaignId === cid;
    try {
      const raw = await ports.getCampaign(cid, ac.signal);
      // Dropped when the scope or campaign changed, or an explicit action produced a newer view meanwhile.
      if (!valid() || aseq !== actionSeq) return;
      const v = normalizeCampaignView(raw);
      patch({ view: v, pollError: null });
      // Something explicit happened while the request was out; do not move the user on stale intent.
      if (ig !== intentGen) return;
      const before = snap.follow;
      const r = applyPoll(before, followUpdateFrom(v), inputs.view === 'review');
      commitFollow(r.state);
      if (r.effects.length) await runTransition(r.effects, before, { g, ig, cid });
    } catch (err) {
      if (isAbort(err) || !valid()) return;
      if (err instanceof ApiError && err.status === 404) {
        // Not visible to this session any more (other owner/workroom, or removed). Drop it; never guess another.
        stopPolling();
        patch({ campaignId: null, view: null, pollError: 'This campaign is no longer available to your session.' });
        void loadList();
        return;
      }
      patch({ pollError: errorMessage(err) });
    } finally {
      if (pollAbort === ac) pollAbort = null;
    }
  };

  const startPolling = (cid: string) => {
    stopPolling();
    const loopId = pollLoopId;
    const loop = async () => {
      if (disposed || loopId !== pollLoopId) return;
      pollSettled = tick(cid);
      await pollSettled;
      if (disposed || loopId !== pollLoopId) return;
      pollTimer = scheduler.setTimeout(() => void loop(), pollMs);
    };
    void loop();
  };

  /* ---------- transition run ---------- */

  /**
   * Performs reducer effects in order. `before` is the state prior to the move so a rejected or
   * superseded select can restore it with a held notice. `ig` is the intent generation the move was
   * decided in; the select is only sent and only delivered while it is unchanged.
   */
  const runTransition = async (
    effects: FollowEffect[],
    before: FollowState,
    ctx: { g: number; ig: number; cid: string | null; origin?: SelectRequest['reason'] },
  ): Promise<TransitionOutcome> => {
    const { g, ig, cid } = ctx;
    const inScope = () => g === scopeGen && snap.campaignId === cid;
    const current = () => inScope() && ig === intentGen;
    const transition = effects.find((e): e is Extract<FollowEffect, { type: 'announce' }> => e.type === 'announce')?.transition ?? null;
    const eg = elsewhereGen;
    for (const e of effects) {
      if (!current()) return 'stale';
      if (e.type === 'clear-selection') {
        ports.setSelectedTile(null);
      } else if (e.type === 'select-exercise') {
        let committed: number | null;
        try {
          const res = await ports.select({
            exerciseId: e.exerciseId,
            reason: ctx.origin ?? 'automatic',
            expected: expectation(before.activeExerciseId, inputs.playbackTick, inputs.navigationRevision),
          });
          committed = revisionOf(res);
        } catch (err) {
          if (!inScope()) return 'stale';
          if (transition) commitFollow(retainTransitionAfterFailedMove(before, snap.follow, transition));
          const why = err instanceof ApiError && err.status === 409 ? 'your view changed while it was being opened' : errorMessage(err);
          patch({ actionError: `Could not move to the new mission: ${why}. Use "Go to current mission" to try again.` });
          return 'refused';
        }
        if (!inScope()) return 'stale';
        if (ig !== intentGen) return superseded(e.exerciseId, committed, before, transition, eg, ctx);
      } else if (e.type === 'announce') {
        patch({ lastTransition: e.transition });
      }
    }
    if (!current()) return 'stale';
    await ports.refresh().catch(() => {});
    return 'moved';
  };

  /**
   * The server accepted our select, but the user did something explicit while it was on the wire.
   * Stay-put intents (Review visit, freeze, follow off) are honoured by re-selecting the previous exercise;
   * go-elsewhere intents are left to the overview to reconcile. Either way the transition is not
   * marked delivered: it is held so "Go to current mission" can complete it deliberately.
   */
  const superseded = async (
    target: string,
    committedRevision: number | null,
    before: FollowState,
    transition: FreshMissionTransition | null,
    eg: number,
    ctx: { g: number; cid: string | null },
  ): Promise<TransitionOutcome> => {
    const inScope = () => ctx.g === scopeGen && snap.campaignId === ctx.cid;
    const stayPut = eg === elsewhereGen && before.activeExerciseId !== null && before.activeExerciseId !== target;
    if (stayPut && transition && committedRevision !== null) {
      const restoreGen = intentGen;
      const previous = before.activeExerciseId as string;
      try {
        // Undo only our own write: the server told us the revision it committed, so anything newer refuses this.
        await ports.select({ exerciseId: previous, reason: 'restore', expected: expectation(target, null, committedRevision) });
        if (!inScope()) return 'superseded';
        commitFollow(retainTransitionAfterFailedMove(before, snap.follow, transition));
      } catch {
        if (!inScope()) return 'superseded';
        // Could not undo the move (or the session moved on again). The overview reconciles where the user
        // actually is; only when nothing newer happened is the move announced as delivered.
        if (restoreGen === intentGen) {
          patch({ lastTransition: transition });
          commitFollow({ ...snap.follow, activeExerciseId: target, announcedExerciseId: target, heldTransition: null });
        } else {
          commitFollow(holdSupersededTransition(snap.follow, before, transition));
        }
      }
    } else if (transition) {
      commitFollow(holdSupersededTransition(snap.follow, before, transition));
    }
    await ports.refresh().catch(() => {});
    return 'superseded';
  };

  /* ---------- scope + inputs ---------- */

  const resetForScope = () => {
    scopeGen += 1;
    noteIntent('scope');
    actionSeq += 1;
    stopPolling();
    patch({
      campaignId: null,
      view: null,
      list: [],
      listError: null,
      busy: false,
      actionError: null,
      pollError: null,
      lastTransition: null,
      follow: initialFollowState({ activeExerciseId: inputs.activeId }),
    });
  };

  const setInputs = (next: CampaignInputs) => {
    const prev = inputs;
    inputs = next;
    if (next.scopeKey !== prev.scopeKey) {
      resetForScope();
      if (next.scopeKey) void loadList();
    }
    if (next.playbackTick !== prev.playbackTick) {
      // Scrubbing to a historical tick is an explicit "stay here". Returning to live is not a move request.
      if (next.playbackTick !== null) noteIntent('freeze');
      commitFollow(setPlaybackTick(snap.follow, next.playbackTick));
    }
    if (next.activeId !== prev.activeId && next.activeId) {
      // The reducer already holds the exercise this tab expects the session to be on (it is updated before
      // every select this executor issues). Anything else is a selection this executor did not make.
      if (next.activeId !== snap.follow.activeExerciseId) noteIntent('manual-select');
      commitFollow(userSelectedExercise(snap.follow, next.activeId));
    }
    if (next.view !== prev.view && next.view === 'review') noteIntent('review');
  };

  /* ---------- campaign binding ---------- */

  const bind = (id: string, preloaded: CampaignView | null, activeExerciseId: string | null) => {
    noteIntent('campaign');
    actionSeq += 1;
    stopPolling();
    patch({
      campaignId: id,
      view: preloaded,
      actionError: null,
      pollError: null,
      lastTransition: null,
      follow: initialFollowState({ activeExerciseId, campaignId: id, following: snap.follow.following }),
    });
    startPolling(id);
  };

  const selectCampaign = (id: string) => {
    if (!inputs.scopeKey || id === snap.campaignId) return;
    bind(id, null, inputs.activeId);
  };

  const clearCampaign = () => {
    noteIntent('campaign');
    actionSeq += 1;
    stopPolling();
    patch({
      campaignId: null,
      view: null,
      actionError: null,
      pollError: null,
      lastTransition: null,
      follow: initialFollowState({ activeExerciseId: inputs.activeId, following: snap.follow.following }),
    });
  };

  const reloadList = () => {
    if (inputs.scopeKey) void loadList();
  };

  /* ---------- actions ---------- */

  /**
   * Pause/resume/stop: the response is the new view. The in-flight poll is aborted and any poll that
   * started before the action is invalidated, so a pre-action snapshot cannot overwrite the result.
   * The next poll applies any follow consequences.
   */
  const action = async (fn: (id: string) => Promise<CampaignView>) => {
    const g = scopeGen;
    const cid = snap.campaignId;
    if (!cid) return;
    const seq = ++actionSeq;
    abortPoll();
    patch({ busy: true, actionError: null });
    try {
      const v = await fn(cid);
      if (g !== scopeGen || snap.campaignId !== cid || seq !== actionSeq) return;
      patch({ view: normalizeCampaignView(v) });
    } catch (e) {
      if (g === scopeGen && snap.campaignId === cid) patch({ actionError: errorMessage(e) });
    } finally {
      if (g === scopeGen && seq === actionSeq) patch({ busy: false });
    }
  };

  const start = async (name: string) => {
    if (!inputs.scopeKey || disposed) return;
    noteIntent('campaign');
    const seq=++actionSeq;
    abortPoll();
    const g = scopeGen;
    const from = inputs.activeId;
    const ig = intentGen;
    patch({ busy: true, actionError: null });
    try {
      const raw = await ports.createCampaign(name);
      if (g !== scopeGen || seq !== actionSeq || disposed) return;
      const v = normalizeCampaignView(raw);
      // Nothing explicit happened while the create was on the wire; safe to move the view as well.
      const quiet = ig === intentGen;
      // The server already made mission one this session's active exercise; no /api/select here.
      bind(v.campaign.id, v, raw.navigationSelected===false?inputs.activeId:v.activeExerciseId ?? from);
      ports.setSelectedTile(null);
      patch({ busy:false,lastTransition: raw.navigationSelected===false?null:startTransition(v, from) });
      if (!quiet || raw.navigationSelected===false) commitFollow(setFollowing(snap.follow,false));
      if (quiet && raw.navigationSelected!==false) ports.navigate('exercise');
      await ports.refresh().catch(() => {});
      if(g===scopeGen)void loadList();
    } catch (e) {
      if (g !== scopeGen || seq !== actionSeq || disposed) return;
      patch({ actionError: errorMessage(e) });
    } finally {
      if (g === scopeGen && seq===actionSeq) {
        patch({ busy: false });
        void loadList(); // a campaign may exist paused even when mission one failed to open
      }
    }
  };

  const join = async (code: string) => {
    if (!inputs.scopeKey || disposed) return;
    noteIntent('campaign');
    const g=scopeGen, seq=++actionSeq, ig=intentGen, from=inputs.activeId;
    abortPoll();patch({busy:true,actionError:null});
    try {
      if(!ports.joinCampaign)throw new Error('Campaign joining is unavailable');
      const r=await ports.joinCampaign(code);
      if(g!==scopeGen||seq!==actionSeq||disposed)return;
      const v=normalizeCampaignView(r.view),quiet=ig===intentGen;
      const selected=r.navigationSelected!==false&&r.activeExerciseId!==null;
      bind(v.campaign.id,v,selected?r.activeExerciseId:inputs.activeId);
      patch({busy:false});
      if(!quiet||!selected)commitFollow(setFollowing(snap.follow,false));
      if(selected){ports.setSelectedTile(null);patch({lastTransition:startTransition(v,from)});}
      if(quiet&&selected)ports.navigate('exercise');
      await ports.refresh().catch(()=>{});
      void loadList();
    }catch(e){if(g===scopeGen&&seq===actionSeq)patch({actionError:errorMessage(e)});}
    finally{if(g===scopeGen&&seq===actionSeq)patch({busy:false});}
  };

  const resume = () => action((id) => ports.resumeCampaign(id));
  const pause = () => action((id) => ports.pauseCampaign(id));
  const stop = async () => {
    await action((id) => ports.stopCampaign(id));
    reloadList();
  };

  const setFollowingChoice = (following: boolean) => {
    noteIntent('follow');
    commitFollow(setFollowing(snap.follow, following));
  };

  const acceptTransition = async (): Promise<TransitionOutcome | null> => {
    noteIntent('accept');
    const before = snap.follow;
    const r = acceptHeldTransition(before);
    commitFollow(r.state);
    if (!r.effects.length) return null;
    const g = scopeGen;
    const ig = intentGen;
    const cid = snap.campaignId;
    abortPoll();
    const outcome = await runTransition(r.effects, before, { g, ig, cid, origin: 'accept' });
    // /api/select already returned this session to live playback for a running exercise.
    if (outcome === 'moved' && g === scopeGen && ig === intentGen) ports.navigate('exercise');
    return outcome;
  };

  const dismissTransition = () => {
    patch({ lastTransition: null });
    if (snap.follow.heldTransition) commitFollow({ ...snap.follow, heldTransition: null });
  };

  /** Explicit visit to a mission for review. Navigates only if nothing newer happened meanwhile. */
  const openMission = async (exerciseId: string) => {
    noteIntent('open-mission');
    const g = scopeGen;
    const ig = intentGen;
    patch({ actionError: null });
    // Rebind the reducer first so the overview's change to this exercise is read as this intent, not a new one.
    commitFollow(userSelectedExercise(snap.follow, exerciseId));
    try {
      await ports.select({ exerciseId, reason: 'open-mission' });
      await ports.refresh();
      if (g === scopeGen && ig === intentGen) ports.navigate('review');
    } catch (e) {
      if (g === scopeGen && ig === intentGen) patch({ actionError: errorMessage(e) });
    }
  };

  return {
    getSnapshot: () => snap,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setInputs,
    selectCampaign,
    clearCampaign,
    reloadList,
    start,
    join,
    resume,
    pause,
    stop,
    setFollowing: setFollowingChoice,
    acceptTransition,
    dismissTransition,
    openMission,
    settle: () => pollSettled,
    activate: () => {
      if(!disposed)return;
      disposed=false;
      if(inputs.scopeKey)void loadList();
      if(snap.campaignId)startPolling(snap.campaignId);
    },
    dispose: () => {
      scopeGen+=1; intentGen+=1; elsewhereGen+=1; listSeq+=1; actionSeq+=1;
      disposed = true;
      stopPolling();
      listeners.clear();
    },
  };
}
