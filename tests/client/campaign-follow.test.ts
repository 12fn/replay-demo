import { describe, expect, it } from 'vitest';
import {
  acceptHeldTransition,
  applyCampaignUpdate,
  initialFollowState,
  orderCarryoverRefusal,
  setFollowing,
  setPlaybackTick,
  simulatedElapsedLabel,
  simulatedMinutes,
  userSelectedExercise,
  type CampaignFollowUpdate,
  type FollowState,
} from '../../src/client/campaign-follow';

const update = (o: Partial<CampaignFollowUpdate> & { revision: number }): CampaignFollowUpdate => ({
  campaignId: 'camp-1',
  activeExerciseId: 'ex-2',
  missionIndex: 1,
  missionTitle: 'Crossing',
  ...o,
});

function liveFollower(): FollowState {
  const s = initialFollowState({ activeExerciseId: 'ex-1' });
  return { ...s, appliedRevision: 2, selection: { exerciseId: 'ex-1', selectedTile: 42, pendingOrder: { type: 'attack', troops: 100 }, observationReceipt: 'rcpt-ex1' } };
}

describe('live follower', () => {
  it('moves to the new mission, clears every per-exercise selection and announces a fresh map', () => {
    const { state, effects } = applyCampaignUpdate(liveFollower(), update({ revision: 3 }));
    expect(state.activeExerciseId).toBe('ex-2');
    expect(state.appliedRevision).toBe(3);
    expect(state.selection).toEqual({ exerciseId: 'ex-2', selectedTile: null, pendingOrder: null, observationReceipt: null });
    expect(effects.map((e) => e.type)).toEqual(['clear-selection', 'select-exercise', 'announce']);
    const announce = effects.find((e) => e.type === 'announce');
    expect(announce && announce.type === 'announce' && announce.transition).toMatchObject({
      kind: 'fresh-mission',
      fromExerciseId: 'ex-1',
      toExerciseId: 'ex-2',
      missionNumber: 2,
    });
    expect(announce && announce.type === 'announce' ? announce.transition.message : '').toMatch(/Mission 2: Crossing has started\. This is a new map with new forces/);
  });

  it('the same transition applied twice is idempotent: no second move, no second announcement', () => {
    const first = applyCampaignUpdate(liveFollower(), update({ revision: 3 }));
    const second = applyCampaignUpdate(first.state, update({ revision: 3 }));
    expect(second.effects).toEqual([]);
    expect(second.state).toBe(first.state);
    // Even a later revision that still names the same mission announces nothing new.
    const third = applyCampaignUpdate(first.state, update({ revision: 4 }));
    expect(third.effects).toEqual([]);
    expect(third.state.activeExerciseId).toBe('ex-2');
  });

  it('out-of-order revisions never rewind the target', () => {
    const moved = applyCampaignUpdate(liveFollower(), update({ revision: 5, activeExerciseId: 'ex-3', missionIndex: 2 }));
    expect(moved.state.activeExerciseId).toBe('ex-3');
    const stale = applyCampaignUpdate(moved.state, update({ revision: 3, activeExerciseId: 'ex-2', missionIndex: 1 }));
    expect(stale.effects).toEqual([]);
    expect(stale.state.activeExerciseId).toBe('ex-3');
    expect(stale.state.appliedRevision).toBe(5);
  });

  it('a race where the user already selected the new mission by hand does not re-announce or reset their view', () => {
    const s = userSelectedExercise(liveFollower(), 'ex-2');
    const announced: FollowState = { ...s, announcedExerciseId: 'ex-2' };
    const r = applyCampaignUpdate(announced, update({ revision: 3 }));
    expect(r.effects).toEqual([]);
    expect(r.state.activeExerciseId).toBe('ex-2');
  });

  it('an awaiting-mission update (no active exercise) leaves the follower where they are', () => {
    const r = applyCampaignUpdate(liveFollower(), update({ revision: 3, activeExerciseId: null, missionIndex: null }));
    expect(r.effects).toEqual([]);
    expect(r.state.activeExerciseId).toBe('ex-1');
    expect(r.state.selection?.selectedTile).toBe(42);
  });
});

describe('frozen review stays frozen', () => {
  it('does not move a user inspecting a historical tick; holds the transition as a notice', () => {
    const frozen = setPlaybackTick(liveFollower(), 1200);
    const { state, effects } = applyCampaignUpdate(frozen, update({ revision: 3 }));
    expect(effects).toEqual([]);
    expect(state.activeExerciseId).toBe('ex-1');
    expect(state.playbackTick).toBe(1200);
    expect(state.selection?.selectedTile).toBe(42);
    expect(state.heldTransition?.toExerciseId).toBe('ex-2');
    expect(state.appliedRevision).toBe(3);
  });

  it('returning to live after the mission changed does not move by itself; the user must accept', () => {
    const frozen = setPlaybackTick(liveFollower(), 1200);
    const held = applyCampaignUpdate(frozen, update({ revision: 3 })).state;
    const live = setPlaybackTick(held, null);
    expect(live.activeExerciseId).toBe('ex-1');
    expect(live.heldTransition?.toExerciseId).toBe('ex-2');
    const accepted = acceptHeldTransition(live);
    expect(accepted.state.activeExerciseId).toBe('ex-2');
    expect(accepted.state.heldTransition).toBeNull();
    expect(accepted.state.selection?.pendingOrder).toBeNull();
    expect(accepted.effects.map((e) => e.type)).toEqual(['clear-selection', 'select-exercise', 'announce']);
    // Accepting again is a no-op.
    expect(acceptHeldTransition(accepted.state).effects).toEqual([]);
  });

  it('a paused follower is not moved either', () => {
    const paused = setFollowing(liveFollower(), false);
    const r = applyCampaignUpdate(paused, update({ revision: 3 }));
    expect(r.effects).toEqual([]);
    expect(r.state.activeExerciseId).toBe('ex-1');
    expect(r.state.heldTransition?.toExerciseId).toBe('ex-2');
  });

  it('a held transition is superseded by a newer one and cleared when the user gets there by hand', () => {
    const frozen = setPlaybackTick(liveFollower(), 10);
    const h1 = applyCampaignUpdate(frozen, update({ revision: 3 })).state;
    const h2 = applyCampaignUpdate(h1, update({ revision: 4, activeExerciseId: 'ex-3', missionIndex: 2 })).state;
    expect(h2.heldTransition?.toExerciseId).toBe('ex-3');
    const manual = userSelectedExercise(h2, 'ex-3');
    expect(manual.heldTransition).toBeNull();
    expect(manual.selection).toEqual({ exerciseId: 'ex-3', selectedTile: null, pendingOrder: null, observationReceipt: null });
  });
});

describe('old snapshot / order carryover is refused', () => {
  it('refuses an order composed on the previous mission', () => {
    const moved = applyCampaignUpdate(liveFollower(), update({ revision: 3 })).state;
    expect(orderCarryoverRefusal(moved, { exerciseId: 'ex-1', observationReceipt: 'rcpt-ex1' })).toMatch(/previous mission/);
    expect(orderCarryoverRefusal(moved, { exerciseId: 'ex-2' })).toBeNull();
  });

  it('refuses a receipt bound to a different mission than the selection', () => {
    const s: FollowState = { ...liveFollower(), activeExerciseId: 'ex-2', selection: { exerciseId: 'ex-1', selectedTile: null, pendingOrder: null, observationReceipt: 'rcpt-ex1' } };
    expect(orderCarryoverRefusal(s, { exerciseId: 'ex-2', observationReceipt: 'rcpt-ex1' })).toMatch(/different mission/);
  });

  it('refuses when there is no active mission', () => {
    expect(orderCarryoverRefusal(initialFollowState({ activeExerciseId: null }), { exerciseId: 'ex-1' })).toBe('No active mission.');
  });
});

describe('simulated time labels (10 ticks per second)', () => {
  it('labels elapsed ticks as simulated minutes and seconds', () => {
    expect(simulatedElapsedLabel(0)).toBe('0 s simulated');
    expect(simulatedElapsedLabel(599)).toBe('59 s simulated');
    expect(simulatedElapsedLabel(600)).toBe('1 min 00 s simulated');
    expect(simulatedElapsedLabel(36000)).toBe('60 min 00 s simulated');
    expect(simulatedElapsedLabel(-5)).toBe('0 s simulated');
  });
  it('converts ticks to fractional simulated minutes', () => {
    expect(simulatedMinutes(36000)).toBe(60);
    expect(simulatedMinutes(300)).toBe(0.5);
  });
});


it('clears a held mission that finished before the reviewer accepted it', () => {
 const frozen = setPlaybackTick(liveFollower(), 10);
 const held = applyCampaignUpdate(frozen, update({revision: 3})).state;
 expect(held.heldTransition?.toExerciseId).toBe('ex-2');
 const ended = applyCampaignUpdate(held, update({revision: 4, activeExerciseId: null, missionIndex: null}));
 expect(ended.state.activeExerciseId).toBe('ex-1');
 expect(ended.state.playbackTick).toBe(10);
 expect(ended.state.heldTransition).toBeNull();
 expect(acceptHeldTransition(ended.state).effects).toEqual([]);
});
it('ignores an outstanding response from another campaign even if its revision is higher', () => {
 const current = initialFollowState({activeExerciseId:'ex-new',campaignId:'camp-new'});
 const stale = applyCampaignUpdate(current, update({revision:99}));
 expect(stale.state).toBe(current);expect(stale.effects).toEqual([]);
});
