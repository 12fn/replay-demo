import { describe, expect, it } from 'vitest';
import type { CampaignView } from '../../src/client/campaign-api';
import type { Overview } from '../../src/client/api';
import { acceptHeldTransition, initialFollowState, setPlaybackTick, userSelectedExercise, type FollowState } from '../../src/client/campaign-follow';
import {
  applyPoll,
  campaignIdOfExercise,
  campaignScopeKey,
  campaignSummary,
  followUpdateFrom,
  holdSupersededTransition,
  normalizeCampaignView,
  pauseReasonOf,
  retainTransitionAfterFailedMove,
  sortCampaignsForRecovery,
  startTransition,
} from '../../src/client/useCampaign';

/** A view shaped like the real backend (campaign-service.ts `view()`), two missions, second one active. */
function serverView(over: Partial<CampaignView> = {}): CampaignView {
  return {
    campaign: {
      schema: 'replay.campaign-session/1',
      id: 'camp-1',
      name: 'Evening practice',
      ownerSubject: 'sub-owner',
      workroomId: 'room',
      rules: { id: 'test/1', targetTicks: 36000, maxMissions: 24, scenarioIds: ['crosscurrent-network/1', 'crosscurrent-crossing/1'] },
      revision: 4,
      status: 'running',
      playedTicks: 600,
      reservation: null,
      missions: [
        { reservation: { key: 'camp-1:mission:0', index: 0, scenarioId: 'crosscurrent-network/1', remainingTicks: 36000 }, exerciseId: 'ex-1', startTick: 1, startFingerprint: 'f1', end: { tick: 601, fingerprint: 'f601', reason: 'facilitator-end', elapsedTicks: 600 } },
        { reservation: { key: 'camp-1:mission:1', index: 1, scenarioId: 'crosscurrent-crossing/1', remainingTicks: 35400 }, exerciseId: 'ex-2', startTick: 1, startFingerprint: 'f2' },
      ],
    },
    enabled: true,
    activeExerciseId: 'ex-2',
    progress: { completedTicks: 600, inProgressTicks: 10, elapsedTicks: 610, remainingTicks: 35390, budgetReached: false, missionCount: 2 },
    transitionNotice: { missionIndex: 2, exerciseId: 'ex-2', name: 'Evening practice · mission 2', scenarioId: 'crosscurrent-crossing/1', scenarioTitle: 'Crossing', openedAt: '', freshWorld: true, previous: { exerciseId: 'ex-1', reason: 'facilitator-end', elapsedTicks: 600 }, text: '…' },
    paused: null,
    ...over,
  };
}

const liveOnEx1 = (): FollowState => ({ ...initialFollowState({ activeExerciseId: 'ex-1', campaignId: 'camp-1' }), appliedRevision: 3 });

describe('server view → follow update (actual backend schema)', () => {
  it('uses the ledger revision, the zero-based active mission index and the notice title only when it names the active mission', () => {
    expect(followUpdateFrom(serverView())).toEqual({ campaignId: 'camp-1', revision: 4, activeExerciseId: 'ex-2', missionIndex: 1, missionTitle: 'Crossing' });
    const stale = serverView({ transitionNotice: { ...serverView().transitionNotice!, exerciseId: 'ex-1' } });
    expect(followUpdateFrom(stale).missionTitle).toBeNull();
    const ended = serverView({ activeExerciseId: null });
    expect(followUpdateFrom(ended)).toMatchObject({ activeExerciseId: null, missionIndex: null });
  });

  it('maps only the exact owner-pause text; other server reasons are shown verbatim', () => {
    expect(pauseReasonOf(null)).toBeNull();
    expect(pauseReasonOf({ reason: 'Paused by the campaign owner', at: '2026-09-13T00:00:00Z' })).toBe('participant-pause');
    const restart = 'Progression is paused until the campaign owner resumes it (server restart or explicit pause)';
    expect(pauseReasonOf({ reason: restart, at: null })).toBe(restart);
    expect(normalizeCampaignView(serverView({ enabled: false, paused: { reason: 'Native write revoked', at: 'x' } })).pauseReason).toBe('Native write revoked');
    expect(normalizeCampaignView(serverView()).pauseReason).toBeNull();
  });
});

describe('poll application in App', () => {
  it('a live follower on the Exercise view is moved and told the map is new', () => {
    const r = applyPoll(liveOnEx1(), followUpdateFrom(serverView()), false);
    expect(r.effects.map((e) => e.type)).toEqual(['clear-selection', 'select-exercise', 'announce']);
    expect(r.state.activeExerciseId).toBe('ex-2');
    const announce = r.effects[2];
    expect(announce.type === 'announce' && announce.transition.message).toMatch(/Mission 2: Crossing has started\. This is a new map with new forces/);
  });

  it('Review never auto-switches, even at playbackTick null, and the follow preference is preserved', () => {
    const s = liveOnEx1();
    expect(s.playbackTick).toBeNull();
    const r = applyPoll(s, followUpdateFrom(serverView()), true);
    expect(r.effects).toEqual([]);
    expect(r.state.activeExerciseId).toBe('ex-1');
    expect(r.state.following).toBe(true);
    expect(r.state.heldTransition?.toExerciseId).toBe('ex-2');
    expect(r.state.appliedRevision).toBe(4);
    // Leaving Review afterwards does not move by itself; the held notice is the only path.
    const again = applyPoll(r.state, followUpdateFrom(serverView()), false);
    expect(again.effects).toEqual([]);
    expect(again.state.heldTransition?.toExerciseId).toBe('ex-2');
    const accepted = acceptHeldTransition(r.state);
    expect(accepted.effects.map((e) => e.type)).toEqual(['clear-selection', 'select-exercise', 'announce']);
  });

  it('a frozen tick inside Exercise is held as well', () => {
    const r = applyPoll(setPlaybackTick(liveOnEx1(), 40), followUpdateFrom(serverView()), false);
    expect(r.effects).toEqual([]);
    expect(r.state.heldTransition?.toExerciseId).toBe('ex-2');
  });

  it('a poll from another campaign id (late response after switching campaigns) is ignored', () => {
    const other = { ...liveOnEx1(), campaignId: 'camp-9' };
    const r = applyPoll(other, followUpdateFrom(serverView()), false);
    expect(r.state).toBe(other);
    expect(r.effects).toEqual([]);
  });
});

describe('rejected /api/select keeps the transition retryable', () => {
  it('restores view, selection and playback but retains the held notice; the same poll is not re-applied', () => {
    const before: FollowState = { ...liveOnEx1(), selection: { exerciseId: 'ex-1', selectedTile: 7, pendingOrder: null, observationReceipt: 'r1' } };
    const moved = applyPoll(before, followUpdateFrom(serverView()), false);
    const transition = moved.effects.find((e) => e.type === 'announce');
    const retained = retainTransitionAfterFailedMove(before, moved.state, transition && transition.type === 'announce' ? transition.transition : (null as never));
    expect(retained.activeExerciseId).toBe('ex-1');
    expect(retained.announcedExerciseId).toBe('ex-1');
    expect(retained.selection).toEqual(before.selection);
    expect(retained.heldTransition?.toExerciseId).toBe('ex-2');
    expect(retained.appliedRevision).toBe(4);
    expect(applyPoll(retained, followUpdateFrom(serverView()), false).effects).toEqual([]);
    // Retry path: accepting the held notice re-issues the same move.
    const retry = acceptHeldTransition(retained);
    expect(retry.effects.map((e) => e.type)).toEqual(['clear-selection', 'select-exercise', 'announce']);
    expect(retry.state.activeExerciseId).toBe('ex-2');
    // A manual visit to the new mission clears the retained notice without re-announcing.
    expect(userSelectedExercise(retained, 'ex-2').heldTransition).toBeNull();
  });

  it('a move superseded by a manual selection is held, not delivered, unless the user is already there', () => {
    const before = liveOnEx1();
    const moved = applyPoll(before, followUpdateFrom(serverView()), false);
    const transition = moved.effects.find((e) => e.type === 'announce');
    const t = transition && transition.type === 'announce' ? transition.transition : (null as never);
    const elsewhere = holdSupersededTransition(userSelectedExercise(moved.state, 'ex-3'), before, t);
    expect(elsewhere).toMatchObject({ activeExerciseId: 'ex-3', announcedExerciseId: 'ex-1' });
    expect(elsewhere.heldTransition?.toExerciseId).toBe('ex-2');
    expect(holdSupersededTransition(moved.state, before, t)).toMatchObject({ activeExerciseId: 'ex-2', announcedExerciseId: 'ex-2', heldTransition: null });
  });
});

describe('scope, recovery and labels', () => {
  const ov = (o: Partial<Overview> & { native?: unknown }): Overview =>
    ({ identity: { subject: 'sub-a', name: 'A', role: 'commander', organization: 'x', mode: 'kamiwaza' }, activeId: 'ex-1', exercises: [], platform: { mode: 'kamiwaza', native: o.native }, playbackTick: null } as unknown as Overview);
  const native = (workroomId: string) => ({ workroomId, context: { canEdit: true }, metadata: {}, receipts: [] });

  it('scope key changes on subject, mode or workroom change and is empty without an identity', () => {
    const a = campaignScopeKey(ov({ native: native('room-1') }));
    expect(a).toBe('kamiwaza:sub-a:room-1');
    expect(campaignScopeKey(ov({ native: native('room-2') }))).not.toBe(a);
    expect(campaignScopeKey({ ...ov({ native: native('room-1') }), identity: { subject: 'sub-b', name: 'B', role: 'commander', organization: 'x', mode: 'kamiwaza' } })).not.toBe(a);
    expect(campaignScopeKey(ov({}))).toBe('kamiwaza:sub-a:local');
    expect(campaignScopeKey(undefined)).toBe('');
  });

  it('lists unfinished campaigns first and never picks one', () => {
    const items = [
      { id: 'c-done', name: 'Done', status: 'completed' as const, revision: 9, missionCount: 3, playedTicks: 36000, targetTicks: 36000, enabled: false },
      { id: 'c-live', name: 'Live', status: 'running' as const, revision: 2, missionCount: 1, playedTicks: 0, targetTicks: 36000, enabled: true },
    ];
    expect(sortCampaignsForRecovery(items).map((i) => i.id)).toEqual(['c-live', 'c-done']);
  });

  it('reads the campaign id the server stamped on the active exercise, as a hint only', () => {
    expect(campaignIdOfExercise({ id: 'ex', name: 'n', kind: 'live', status: 'running', tick: 0, humanSide: 'blue', options: { campaignId: 'camp-1' } as never })).toBe('camp-1');
    expect(campaignIdOfExercise({ id: 'ex', name: 'n', kind: 'live', status: 'running', tick: 0, humanSide: 'blue' })).toBeNull();
    expect(campaignIdOfExercise(undefined)).toBeNull();
  });

  it('collapsed summary is truthful about paused and stopped progression', () => {
    expect(campaignSummary(null, { following: true, held: false })).toBe('Practice campaign · optional');
    expect(campaignSummary(serverView(), { following: true, held: false })).toBe('Evening practice · Mission 2 of up to 24 · following');
    expect(campaignSummary(serverView({ enabled: false, paused: { reason: 'Paused by the campaign owner', at: 'x' } }), { following: true, held: true })).toBe('Evening practice · Mission 2 of up to 24 · progression paused · new mission waiting');
    const stopped = serverView({ enabled: false, activeExerciseId: null, campaign: { ...serverView().campaign, status: 'stopped', endReason: 'participant-stop' } });
    expect(campaignSummary(stopped, { following: true, held: false })).toBe('Evening practice · Stopped');
  });

  it('start notice names mission one as a fresh map and needs no client-side select', () => {
    const created = serverView({ campaign: { ...serverView().campaign, revision: 2, missions: [serverView().campaign.missions[1]] }, activeExerciseId: 'ex-2', transitionNotice: { ...serverView().transitionNotice!, missionIndex: 1, previous: null } });
    const t = startTransition(created, 'ex-old');
    expect(t).toMatchObject({ kind: 'fresh-mission', fromExerciseId: 'ex-old', toExerciseId: 'ex-2', missionNumber: 1 });
    expect(t?.message).toMatch(/Mission 1: Crossing has started\. This is a new map with new forces/);
    expect(startTransition(serverView({ activeExerciseId: null }), null)).toBeNull();
  });
});
