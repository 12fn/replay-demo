/**
 * Shared campaign membership UI: projection tests against the server's actual `MembershipView` shape and
 * behavioural tests for the membership controller driven with deferred promises (late answers after a
 * campaign switch, join binding deferred until the tab shows the joined mission, leave dropping the
 * executor binding). No DOM: the components render from these projections and callbacks.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/client/api';
import type { CampaignInviteCode, CampaignJoinResult, CampaignMembershipView, CampaignView } from '../../src/client/campaign-api';
import {
  createMembershipController,
  joinBindDecision,
  joinSeamOf,
  memberRows,
  missionMembershipRows,
  pointLabel,
  preferNewerMembership,
  seatSummary,
  viewerCapabilities,
  type MembershipPorts,
} from '../../src/client/campaign-membership-ui';

/* ---------------- fixtures (shape of campaign-membership-service.ts `view()`) ---------------- */

function membership(over: Partial<CampaignMembershipView> = {}): CampaignMembershipView {
  return {
    version: 5,
    maxParticipants: 15,
    activeParticipants: 1,
    currentPoint: { missionIndex: 1, tick: 340 },
    viewer: { subject: 'sub-owner', role: 'owner', status: 'active', canManage: true },
    members: [
      { subject: 'sub-owner', name: 'Owner One', organization: 'Synthetic', role: 'owner', roleAtJoin: 'commander', status: 'active', since: { missionIndex: 0, tick: 1 }, until: null, rejoinRequired: false },
      { subject: 'sub-b', name: 'Bea', organization: 'Synthetic', role: 'participant', roleAtJoin: 'intelligence', status: 'active', since: { missionIndex: 0, tick: 120 }, until: null, rejoinRequired: false },
      { subject: 'sub-c', name: 'Cal', organization: 'Synthetic', role: 'participant', roleAtJoin: 'commander', status: 'withdrawn', since: { missionIndex: 0, tick: 1 }, until: { missionIndex: 0, tick: 500 }, rejoinRequired: false },
      { subject: 'sub-d', name: 'Dee', organization: 'Synthetic', role: 'participant', roleAtJoin: 'unknown', status: 'revoked', since: { missionIndex: 0, tick: 1 }, until: { missionIndex: 1, tick: 1 }, rejoinRequired: false },
      { subject: 'sub-e', name: 'Eve', organization: 'Synthetic', role: 'participant', roleAtJoin: 'unknown', status: 'withdrawn', since: { missionIndex: 0, tick: 1 }, until: { missionIndex: 1, tick: 1 }, rejoinRequired: true },
    ],
    missions: [
      { missionIndex: 0, exerciseId: 'ex-1', status: 'completed', carried: null, excluded: null, recorded: false, detached: false },
      { missionIndex: 1, exerciseId: 'ex-2', status: 'running', carried: ['sub-owner', 'sub-b'], excluded: [{ subject: 'sub-e', outcome: 'denied', detail: 'Native workroom access state is blocked' }], recorded: true, detached: false },
    ],
    detached: null,
    limits: ['Seats come from consented campaign membership only.'],
    ...over,
  };
}

function view(over: Partial<CampaignView> = {}, m: CampaignMembershipView = membership()): CampaignView {
  return {
    campaign: {
      schema: 'replay.campaign-session/1',
      id: 'camp-1',
      name: 'Evening practice',
      ownerSubject: 'sub-owner',
      workroomId: 'room',
      rules: { id: 'test/1', targetTicks: 36000, maxMissions: 24, scenarioIds: ['crosscurrent-crossing/1'] },
      revision: 4,
      status: 'running',
      playedTicks: 600,
      reservation: null,
      missions: [],
    } as unknown as CampaignView['campaign'],
    enabled: true,
    activeExerciseId: 'ex-2',
    progress: { completedTicks: 600, inProgressTicks: 10, elapsedTicks: 610, remainingTicks: 35390, budgetReached: false, missionCount: 2 },
    transitionNotice: null,
    paused: null,
    membership: m,
    ...over,
  };
}

const asParticipant = (m: CampaignMembershipView = membership()): CampaignMembershipView => ({ ...m, viewer: { subject: 'sub-b', role: 'participant', status: 'active', canManage: false } });

/* ---------------- projections ---------------- */

describe('viewer capabilities come from the server view only', () => {
  it('owner: progression and admission; no leave', () => {
    expect(viewerCapabilities(view())).toMatchObject({ shared: true, role: 'owner', canManage: true, canProgress: true, canAdmit: true, canLeave: false, viewerInactive: false });
  });

  it('participant: no progression or admission, may leave; a stale inactive standing removes leave too', () => {
    expect(viewerCapabilities(view({}, asParticipant()))).toMatchObject({ role: 'participant', canManage: false, canProgress: false, canAdmit: false, canLeave: true });
    const gone = asParticipant();
    gone.viewer = { ...gone.viewer, status: 'withdrawn' };
    expect(viewerCapabilities(view({}, gone))).toMatchObject({ canLeave: false, viewerInactive: true });
  });

  it('canManage is taken from the server flag, not from the role label', () => {
    const odd = membership({ viewer: { subject: 'sub-owner', role: 'owner', status: 'active', canManage: false } });
    expect(viewerCapabilities(view({}, odd))).toMatchObject({ canManage: false, canProgress: false, canAdmit: false });
  });

  it('a finished campaign keeps the owner from inviting; a legacy view without membership behaves owner-only', () => {
    const ended = view({ campaign: { ...view().campaign, status: 'stopped' } });
    expect(viewerCapabilities(ended)).toMatchObject({ canProgress: false, canAdmit: false, terminal: true });
    const { membership: _omitted, ...legacy } = view();
    expect(viewerCapabilities(legacy as CampaignView)).toMatchObject({ shared: false, canManage: true, canProgress: true, canAdmit: false });
    expect(viewerCapabilities(null).canManage).toBe(false);
  });
});

describe('roster rows', () => {
  it('order owner, active, lifted, left, removed; tags and terms use one-based mission numbers', () => {
    const rows = memberRows(membership(), true);
    expect(rows.map((r) => [r.name, r.standing, r.tag])).toEqual([
      ['Owner One', 'owner', 'owner'],
      ['Bea', 'active', null],
      ['Eve', 'rejoin-required', 'removal lifted · must rejoin'],
      ['Cal', 'withdrawn', 'left'],
      ['Dee', 'revoked', 'removed'],
    ]);
    expect(rows[1]!.term).toBe('since mission 1 · tick 120');
    expect(rows[3]!.term).toBe('since mission 1 start · until mission 1 · tick 500');
    expect(rows[0]!.isViewer).toBe(true);
    expect(rows[0]!.term).toBe('campaign owner');
  });

  it('owner may remove active members and lift removals only; a participant gets no actions at all', () => {
    const owner = memberRows(membership(), true);
    expect(owner.map((r) => [r.name, r.canRevoke, r.canReinstate])).toEqual([
      ['Owner One', false, false],
      ['Bea', true, false],
      ['Eve', false, false],
      ['Cal', false, false],
      ['Dee', false, true],
    ]);
    const peer = memberRows(asParticipant(), false);
    expect(peer.every((r) => !r.canRevoke && !r.canReinstate)).toBe(true);
    expect(peer.find((r) => r.name === 'Bea')?.isViewer).toBe(true);
  });

  it('nothing is invented for a missing term', () => {
    const m = membership({ members: [{ ...membership().members[1]!, since: null, until: null }] });
    expect(memberRows(m, true)[0]!.term).toBe('term not recorded');
  });
});

describe('mission carry rows', () => {
  it('legacy missions say so; recorded ones list carried names without the owner and explain exclusions', () => {
    const rows = missionMembershipRows(membership());
    expect(rows[0]).toMatchObject({ number: 1, legacy: true, carried: [], excluded: [], summary: 'no membership record' });
    expect(rows[1]).toMatchObject({ number: 2, legacy: false, carried: ['Bea'], summary: '1 carried · 1 not seated' });
    expect(rows[1]!.excluded).toEqual([{ name: 'Eve', outcome: 'denied', detail: 'Native workroom access state is blocked' }]);
  });

  it('owner-only and detached missions are labelled', () => {
    const m = membership({ missions: [{ missionIndex: 2, exerciseId: 'ex-3', status: 'running', carried: ['sub-owner'], excluded: [], recorded: true, detached: true }] });
    expect(missionMembershipRows(m)[0]!.summary).toBe('owner only · continues after the campaign ended');
  });

  it('seat summary and point labels', () => {
    expect(seatSummary(membership())).toBe('1 of 15 participant seats in use');
    expect(seatSummary(membership({ maxParticipants: 1 }))).toBe('1 of 1 participant seat in use');
    expect(seatSummary(membership({ maxParticipants: 0, activeParticipants: 0 }))).toBe('no participant seats (owner only)');
    expect(pointLabel({ missionIndex: 0, tick: 1 })).toBe('mission 1 start');
    expect(pointLabel(null)).toBe('');
  });
});

describe('merging the polled view with an action response', () => {
  it('prefers the newer membership version, the polled view on ties, and never mixes campaigns', () => {
    const polled = view({}, membership({ version: 5 }));
    const newer = view({}, membership({ version: 6 }));
    const older = view({}, membership({ version: 4 }));
    expect(preferNewerMembership(polled, newer)).toBe(newer);
    expect(preferNewerMembership(polled, older)).toBe(polled);
    expect(preferNewerMembership(polled, view({}, membership({ version: 5 })))).toBe(polled);
    const other = view({ campaign: { ...view().campaign, id: 'camp-9' } }, membership({ version: 99 }));
    expect(preferNewerMembership(polled, other)).toBe(polled);
    expect(preferNewerMembership(null, newer)).toBe(newer);
    expect(preferNewerMembership(polled, null)).toBe(polled);
  });
});

describe('join binding decision and executor seam detection', () => {
  it('binds at once only when the tab already shows the joined mission or none is running', () => {
    expect(joinBindDecision({ campaignId: 'c', activeExerciseId: 'ex-2' }, 'ex-1')).toBe('wait-for-selection');
    expect(joinBindDecision({ campaignId: 'c', activeExerciseId: 'ex-2' }, 'ex-2')).toBe('bind-now');
    expect(joinBindDecision({ campaignId: 'c', activeExerciseId: null }, 'ex-1')).toBe('bind-now');
  });

  it('uses the executor join only when main provides a function', () => {
    expect(joinSeamOf({ selectCampaign: () => {} })).toBeNull();
    expect(joinSeamOf({ join: async () => {} })).not.toBeNull();
    expect(joinSeamOf(null)).toBeNull();
  });
});

/* ---------------- controller ---------------- */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function harness() {
  const codes: { id: string; d: Deferred<CampaignInviteCode> }[] = [];
  const revokes: { id: string; subject: string; d: Deferred<CampaignView> }[] = [];
  const limits: { id: string; max: number; d: Deferred<CampaignView> }[] = [];
  const reinstates: { id: string; subject: string; d: Deferred<CampaignView> }[] = [];
  const withdraws: { id: string; d: Deferred<unknown> }[] = [];
  const joins: { code: string; d: Deferred<CampaignJoinResult> }[] = [];
  const bound: string[] = [];
  const refreshes: Deferred<void>[] = [];
  let cleared = 0;
  let reloaded = 0;
  const ports: MembershipPorts = {
    issueCode: (id) => {
      const d = deferred<CampaignInviteCode>();
      codes.push({ id, d });
      return d.promise;
    },
    withdraw: (id) => {
      const d = deferred<unknown>();
      withdraws.push({ id, d });
      return d.promise;
    },
    setLimit: (id, max) => {
      const d = deferred<CampaignView>();
      limits.push({ id, max, d });
      return d.promise;
    },
    revoke: (id, subject) => {
      const d = deferred<CampaignView>();
      revokes.push({ id, subject, d });
      return d.promise;
    },
    reinstate: (id, subject) => {
      const d = deferred<CampaignView>();
      reinstates.push({ id, subject, d });
      return d.promise;
    },
    join: (code) => {
      const d = deferred<CampaignJoinResult>();
      joins.push({ code, d });
      return d.promise;
    },
    bindCampaign: (id) => {
      bound.push(id);
    },
    clearCampaign: () => {
      cleared += 1;
    },
    reloadList: () => {
      reloaded += 1;
    },
    refresh: () => {
      const d = deferred<void>();
      refreshes.push(d);
      return d.promise;
    },
  };
  const ctrl = createMembershipController(ports);
  return { ctrl, codes, revokes, limits, reinstates, withdraws, joins, bound, refreshes, get cleared() { return cleared; }, get reloaded() { return reloaded; }, snap: () => ctrl.getSnapshot() };
}

describe('membership controller: scoped actions and late answers', () => {
  it('an invite issued for one campaign never shows up after switching to another, and is cleared on switch', async () => {
    const h = harness();
    h.ctrl.bind('camp-1');
    const issuing = h.ctrl.issueCode();
    expect(h.snap().busy).toBe('code');
    expect(h.codes[0]!.id).toBe('camp-1');
    h.ctrl.bind('camp-2');
    expect(h.snap()).toMatchObject({ campaignId: 'camp-2', busy: null, invite: null });
    h.codes[0]!.d.resolve({ code: 'a'.repeat(32), expiresAt: '2026-09-14T00:00:00Z' });
    await issuing;
    expect(h.snap().invite).toBeNull();
    expect(h.snap().error).toBeNull();
    // A fresh issue on the new campaign is shown once and dropped on dismiss or on another switch.
    const again = h.ctrl.issueCode();
    h.codes[1]!.d.resolve({ code: 'b'.repeat(32), expiresAt: '2026-09-14T00:00:00Z' });
    await again;
    expect(h.snap().invite?.code).toBe('b'.repeat(32));
    h.ctrl.dismissInvite();
    expect(h.snap().invite).toBeNull();
  });

  it('a revoke answer is applied only while still bound to that campaign; it also drops the shown invite', async () => {
    const h = harness();
    h.ctrl.bind('camp-1');
    const issued = h.ctrl.issueCode();
    h.codes[0]!.d.resolve({ code: 'c'.repeat(32), expiresAt: 'x' });
    await issued;
    const revoking = h.ctrl.revoke('sub-b');
    expect(h.revokes[0]).toMatchObject({ id: 'camp-1', subject: 'sub-b' });
    h.revokes[0]!.d.resolve(view({}, membership({ version: 6 })));
    await revoking;
    expect(h.snap().invite).toBeNull();
    expect(h.snap().actionView?.membership?.version).toBe(6);
    expect(h.snap().notice).toMatch(/invite code was rotated/);
    // Same action after unbinding: the late answer is dropped entirely.
    const late = h.ctrl.revoke('sub-b');
    h.ctrl.bind(null);
    h.revokes[1]!.d.resolve(view({}, membership({ version: 7 })));
    await late;
    expect(h.snap()).toMatchObject({ campaignId: null, actionView: null, busy: null, notice: null });
  });

  it('a newer action supersedes an older one still on the wire', async () => {
    const h = harness();
    h.ctrl.bind('camp-1');
    const first = h.ctrl.setLimit(3);
    const second = h.ctrl.setLimit(5);
    expect(h.limits.map((l) => l.max)).toEqual([3, 5]);
    h.limits[1]!.d.resolve(view({}, membership({ version: 9, maxParticipants: 5 })));
    await second;
    h.limits[0]!.d.resolve(view({}, membership({ version: 8, maxParticipants: 3 })));
    await first;
    expect(h.snap().actionView?.membership?.maxParticipants).toBe(5);
    expect(h.snap().busy).toBeNull();
    expect(h.snap().notice).toBe('Participant limit set to 5.');
  });

  it('a failed action reports the server message and clears busy; a failure after a switch is silent', async () => {
    const h = harness();
    h.ctrl.bind('camp-1');
    const lifting = h.ctrl.reinstate('sub-d');
    h.reinstates[0]!.d.reject(new ApiError(403, 'Only the campaign owner can do this'));
    await lifting;
    expect(h.snap()).toMatchObject({ busy: null, error: 'Only the campaign owner can do this' });
    const again = h.ctrl.reinstate('sub-d');
    h.ctrl.bind('camp-2');
    h.reinstates[1]!.d.reject(new ApiError(409, 'late'));
    await again;
    expect(h.snap().error).toBeNull();
  });

  it('leaving drops the executor binding so it cannot poll into a 404, and reloads the list', async () => {
    const h = harness();
    h.ctrl.bind('camp-1');
    const leaving = h.ctrl.withdraw();
    expect(h.withdraws[0]!.id).toBe('camp-1');
    h.withdraws[0]!.d.resolve({ withdrawn: true, campaignId: 'camp-1' });
    await leaving;
    expect(h.cleared).toBe(1);
    expect(h.reloaded).toBe(1);
    expect(h.snap().notice).toMatch(/You left the campaign/);
  });

  it('nothing runs without a bound campaign', async () => {
    const h = harness();
    await h.ctrl.issueCode();
    await h.ctrl.withdraw();
    expect(h.codes).toHaveLength(0);
    expect(h.withdraws).toHaveLength(0);
  });
});

describe('membership controller: join binds the executor only once the tab shows the joined mission', () => {
  const joined = (activeExerciseId: string | null, joinedNow = true): CampaignJoinResult => ({ campaignId: 'camp-1', joined: joinedNow, activeExerciseId, view: view() });

  it('waits for the overview to report the mission, then binds through the existing controller', async () => {
    const h = harness();
    h.ctrl.observeSelection('ex-1');
    const joining = h.ctrl.join('  ABCDEF0123456789abcdef0123456789 ');
    expect(h.joins[0]!.code).toBe('ABCDEF0123456789abcdef0123456789');
    expect(h.snap().busy).toBe('join');
    h.joins[0]!.d.resolve(joined('ex-2'));
    await flush();
    expect(h.snap().pendingBind).toEqual({ campaignId: 'camp-1', exerciseId: 'ex-2' });
    expect(h.snap().notice).toBe('Joined Evening practice. Your session now shows its running mission.');
    expect(h.reloaded).toBe(1);
    expect(h.refreshes).toHaveLength(1);
    expect(h.bound).toEqual([]);
    h.ctrl.observeSelection('ex-1'); // overview not there yet
    expect(h.bound).toEqual([]);
    h.refreshes[0]!.resolve();
    await joining;
    expect(h.snap().busy).toBeNull();
    h.ctrl.observeSelection('ex-2');
    expect(h.bound).toEqual(['camp-1']);
    expect(h.snap().pendingBind).toBeNull();
  });

  it('binds immediately when the campaign has no running mission', async () => {
    const h = harness();
    const joining = h.ctrl.join('x'.repeat(32));
    h.joins[0]!.d.resolve(joined(null));
    await flush();
    h.refreshes[0]!.resolve();
    await joining;
    expect(h.bound).toEqual(['camp-1']);
    expect(h.snap().notice).toMatch(/next mission will seat you/);
  });

  it('an already-active member is told their seat was restored', async () => {
    const h = harness();
    const joining = h.ctrl.join('x'.repeat(32));
    h.joins[0]!.d.resolve(joined('ex-2', false));
    await flush();
    h.refreshes[0]!.resolve();
    await joining;
    expect(h.snap().notice).toBe('You were already a member of Evening practice; your seat was restored.');
  });

  it('a join answer that lands after the user opened another campaign binds nothing', async () => {
    const h = harness();
    const joining = h.ctrl.join('x'.repeat(32));
    h.ctrl.bind('camp-7');
    h.joins[0]!.d.resolve(joined('ex-2'));
    await joining;
    expect(h.snap().pendingBind).toBeNull();
    h.ctrl.observeSelection('ex-2');
    expect(h.bound).toEqual([]);
    expect(h.refreshes).toHaveLength(0);
  });

  it('a pending bind is dropped once the executor is already on that campaign, and a rejected code is reported', async () => {
    const h = harness();
    const joining = h.ctrl.join('x'.repeat(32));
    h.joins[0]!.d.resolve(joined('ex-2'));
    await flush();
    h.refreshes[0]!.resolve();
    await joining;
    h.ctrl.bind('camp-1'); // main's executor bound it by other means
    expect(h.snap().pendingBind).toBeNull();
    const bad = h.ctrl.join('nope');
    h.joins[1]!.d.reject(new ApiError(404, 'Campaign code is invalid, expired, or unavailable in this workroom'));
    await bad;
    expect(h.snap()).toMatchObject({ busy: null, error: 'Campaign code is invalid, expired, or unavailable in this workroom' });
    expect(h.bound).toEqual([]);
  });

  it('after dispose nothing is applied; a StrictMode replay (dispose, activate) drops the old answer and works again', async () => {
    const h = harness();
    const joining = h.ctrl.join('x'.repeat(32));
    h.ctrl.dispose();
    h.ctrl.activate();
    h.joins[0]!.d.resolve(joined(null));
    await joining;
    expect(h.bound).toEqual([]);
    expect(h.snap()).toMatchObject({ pendingBind: null, busy: null });
    const again = h.ctrl.join('y'.repeat(32));
    h.joins[1]!.d.resolve(joined(null));
    await flush();
    h.refreshes[0]!.resolve();
    await again;
    expect(h.bound).toEqual(['camp-1']);
  });
});
