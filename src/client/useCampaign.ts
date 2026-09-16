/**
 * React adapter for the optional practice campaign. All behaviour lives in campaign-executor.ts (pure TS,
 * tested with deferred promises); this hook only feeds it the session inputs, wires the network ports and
 * exposes its snapshot through useSyncExternalStore. Public helpers are re-exported so the existing
 * import sites (App, CampaignControl, tests) are unchanged.
 *
 * Safety rules (implemented in the executor, summarised in docs/process/campaign-race-notes.md):
 *  - Scope: identity, mode or workroom change clears all campaign state; results from the old scope are dropped.
 *  - Intent generation: an automatic transition is only sent and only delivered while no explicit intent
 *    (manual select, Review visit, scrub, follow toggle, campaign action) has happened since it was decided.
 *  - Review never auto-switches, even when playbackTick is null. A frozen tick is never moved.
 *  - A rejected or superseded /api/select does not mark the transition delivered; it is retained for a retry.
 *  - Nothing is created automatically and no campaign is selected without an explicit user choice.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api, type Overview } from './api';
import { campaignApi } from './campaign-api';
import { createCampaignExecutor, type CampaignExecutor, type CampaignPorts } from './campaign-executor';
import type { FollowState, FreshMissionTransition } from './campaign-follow';
import type { CampaignListItem, CampaignView } from './campaign-api';
import type { View } from './components/Header';
import { nativeOf } from './native-api';

export {
  CAMPAIGN_POLL_MS,
  applyPoll,
  campaignIdOfExercise,
  campaignStatusLabel,
  campaignSummary,
  followUpdateFrom,
  holdSupersededTransition,
  normalizeCampaignView,
  pauseReasonOf,
  retainTransitionAfterFailedMove,
  sortCampaignsForRecovery,
  startTransition,
} from './campaign-executor';

/** Identity + mode + workroom. Any change means every piece of campaign UI state must be cleared. */
export function campaignScopeKey(ov: Overview | undefined): string {
  if (!ov?.identity?.subject) return '';
  const native = nativeOf(ov);
  return `${ov.identity.mode}:${ov.identity.subject}:${native?.workroomId ?? 'local'}`;
}

export interface CampaignController {
  campaignId: string | null;
  view: CampaignView | null;
  list: CampaignListItem[];
  listError: string | null;
  busy: boolean;
  error: string | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  follow: FollowState;
  lastTransition: FreshMissionTransition | null;
  selectCampaign: (id: string) => void;
  clearCampaign: () => void;
  reloadList: () => void;
  start: (name: string) => Promise<void>;
  join: (code: string) => Promise<void>;
  resume: () => Promise<void>;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  setFollowing: (following: boolean) => void;
  acceptTransition: () => void;
  dismissTransition: () => void;
  openMission: (exerciseId: string) => void;
}

export interface UseCampaignInput {
  ov: Overview | undefined;
  /** False while the overview is refused or absent: polling stops and state is cleared. */
  enabled: boolean;
  view: View;
  refresh: () => Promise<void>;
  setSelectedTile: (t: number | null) => void;
  navigate: (v: View) => void;
}

export function useCampaign(input: UseCampaignInput): CampaignController {
  const { ov, enabled, view: viewMode, refresh, setSelectedTile, navigate } = input;
  const scopeKey = enabled ? campaignScopeKey(ov) : '';

  // App callbacks may change identity between renders; the executor is created once and reads the latest.
  const callbacks = useRef({ refresh, setSelectedTile, navigate });
  callbacks.current = { refresh, setSelectedTile, navigate };
  const initialActiveId = useRef(ov?.activeId ?? null);

  const exec = useMemo<CampaignExecutor>(() => {
    const ports: CampaignPorts = {
      select: (req) => api.select(req.exerciseId, req.expected),
      getCampaign: (id, signal) => campaignApi.get(id, signal),
      listCampaigns: () => campaignApi.list(),
      createCampaign: (name) => campaignApi.create(name),
      joinCampaign: (code) => campaignApi.join(code),
      pauseCampaign: (id) => campaignApi.pause(id),
      resumeCampaign: (id) => campaignApi.resume(id),
      stopCampaign: (id) => campaignApi.stop(id),
      refresh: () => callbacks.current.refresh(),
      setSelectedTile: (t) => callbacks.current.setSelectedTile(t),
      navigate: (v) => callbacks.current.navigate(v),
    };
    return createCampaignExecutor(ports, { activeId: initialActiveId.current });
  }, []);
  useEffect(() => { exec.activate(); return () => exec.dispose(); }, [exec]);

  const activeId = ov?.activeId ?? null;
  const playbackTick = ov?.playbackTick ?? null;
  // Old clients/servers may omit the revision.
  const rawRevision = (ov as { navigationRevision?: unknown } | undefined)?.navigationRevision;
  const navigationRevision = typeof rawRevision === 'number' ? rawRevision : null;
  useEffect(() => {
    exec.setInputs({ scopeKey, activeId, playbackTick, navigationRevision, view: viewMode });
  }, [exec, scopeKey, activeId, playbackTick, navigationRevision, viewMode]);

  const snap = useSyncExternalStore(exec.subscribe, exec.getSnapshot, exec.getSnapshot);

  const native = nativeOf(ov);
  const readOnly = native ? !native.context.canEdit : false;
  const readOnlyReason = native?.context.readOnlyReason ?? null;

  return useMemo<CampaignController>(
    () => ({
      campaignId: snap.campaignId,
      view: snap.view,
      list: snap.list,
      listError: snap.listError,
      busy: snap.busy,
      error: snap.actionError ?? snap.pollError,
      readOnly,
      readOnlyReason,
      follow: snap.follow,
      lastTransition: snap.lastTransition,
      selectCampaign: exec.selectCampaign,
      clearCampaign: exec.clearCampaign,
      reloadList: exec.reloadList,
      start: exec.start,
      join: exec.join,
      resume: exec.resume,
      pause: exec.pause,
      stop: exec.stop,
      setFollowing: exec.setFollowing,
      acceptTransition: () => void exec.acceptTransition(),
      dismissTransition: exec.dismissTransition,
      openMission: (id) => void exec.openMission(id),
    }),
    [snap, readOnly, readOnlyReason, exec],
  );
}
