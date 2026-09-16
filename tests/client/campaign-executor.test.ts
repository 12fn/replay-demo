/**
 * Behavioural tests for the campaign executor: the real async code path is driven with deferred promises
 * so every race the UI can hit (intent while /api/select is on the wire, late poll after an action, late
 * list load, scope change mid-flight) is exercised end to end, not through helper snapshots.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/client/api';
import type { CampaignListItem, CampaignView } from '../../src/client/campaign-api';
import { createCampaignExecutor, type CampaignExecutor, type CampaignInputs, type CampaignPorts, type Scheduler, type SelectRequest } from '../../src/client/campaign-executor';

/* ---------------- fixtures ---------------- */

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
/** Lets every pending continuation run (several microtask turns plus one macrotask). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const mission = (index: number, exerciseId: string, ended: boolean) => ({
  reservation: { key: `camp-1:mission:${index}`, index, scenarioId: 'crosscurrent-crossing/1', remainingTicks: 36000 },
  exerciseId,
  startTick: 1,
  startFingerprint: `f${index}`,
  ...(ended ? { end: { tick: 601, fingerprint: 'f601', reason: 'facilitator-end', elapsedTicks: 600 } } : {}),
});

/** Campaign view shaped like the backend. `active` is the open mission; earlier ones are ended. */
function view(active: 'ex-1' | 'ex-2' | 'ex-3' | null, revision: number, over: Partial<CampaignView> = {}): CampaignView {
  const ids = ['ex-1', 'ex-2', 'ex-3'] as const;
  const upto = active ? ids.indexOf(active) : ids.length - 1;
  const missions = ids.slice(0, upto + 1).map((id, i) => mission(i, id, id !== active));
  return {
    campaign: {
      schema: 'replay.campaign-session/1',
      id: 'camp-1',
      name: 'Evening practice',
      ownerSubject: 'sub-owner',
      workroomId: 'room',
      rules: { id: 'test/1', targetTicks: 36000, maxMissions: 24, scenarioIds: ['crosscurrent-crossing/1'] },
      revision,
      status: active ? 'running' : 'awaiting-mission',
      playedTicks: 600,
      reservation: null,
      missions,
    } as CampaignView['campaign'],
    enabled: true,
    activeExerciseId: active,
    progress: { completedTicks: 600, inProgressTicks: 10, elapsedTicks: 610, remainingTicks: 35390, budgetReached: false, missionCount: missions.length },
    transitionNotice: active ? { missionIndex: upto + 1, exerciseId: active, name: 'm', scenarioId: 'crosscurrent-crossing/1', scenarioTitle: 'Crossing', openedAt: '', freshWorld: true, previous: null, text: '…' } : null,
    paused: null,
    ...over,
  };
}

const listItem = (status: CampaignListItem['status']): CampaignListItem => ({ id: 'camp-1', name: 'Evening practice', status, revision: 1, missionCount: 1, playedTicks: 0, targetTicks: 36000, enabled: status === 'running' });

/** Fake ports: every network call returns a deferred the test settles by hand; every effect is recorded. */
function harness() {
  const selects: { req: SelectRequest; d: Deferred<unknown> }[] = [];
  const gets: { id: string; signal: AbortSignal; d: Deferred<CampaignView> }[] = [];
  const lists: Deferred<CampaignListItem[]>[] = [];
  const pauses: Deferred<CampaignView>[] = [];
  const refreshes: Deferred<void>[] = [];
  const creates: { name: string; d: Deferred<CampaignView> }[] = [];
  const navigations: string[] = [];
  const tiles: (number | null)[] = [];
  const timers: (() => void)[] = [];
  const scheduler: Scheduler = {
    setTimeout: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as () => void);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const ports: CampaignPorts = {
    select: (req) => {
      const d = deferred<unknown>();
      selects.push({ req, d });
      return d.promise;
    },
    getCampaign: (id, signal) => {
      const d = deferred<CampaignView>();
      signal.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')));
      gets.push({ id, signal, d });
      return d.promise;
    },
    listCampaigns: () => {
      const d = deferred<CampaignListItem[]>();
      lists.push(d);
      return d.promise;
    },
    createCampaign: (name) => {
      const d = deferred<CampaignView>();
      creates.push({ name, d });
      return d.promise;
    },
    pauseCampaign: () => {
      const d = deferred<CampaignView>();
      pauses.push(d);
      return d.promise;
    },
    resumeCampaign: () => Promise.reject(new Error('not used')),
    stopCampaign: () => Promise.reject(new Error('not used')),
    refresh: () => {
      const d = deferred<void>();
      refreshes.push(d);
      return d.promise;
    },
    setSelectedTile: (t) => {
      tiles.push(t);
    },
    navigate: (v) => {
      navigations.push(v);
    },
    scheduler,
  };
  const exec: CampaignExecutor = createCampaignExecutor(ports, { activeId: 'ex-1' });
  const base: CampaignInputs = { scopeKey: 'kamiwaza:sub-a:room', activeId: 'ex-1', playbackTick: null, navigationRevision: 7, view: 'exercise' };
  let current = base;
  const input = (over: Partial<CampaignInputs>) => {
    current = { ...current, ...over };
    exec.setInputs(current);
  };
  /** Fires the next scheduled poll timer (the loop schedules one after each tick settles). */
  const nextPoll = () => {
    const fn = timers.shift();
    if (!fn) throw new Error('no poll scheduled');
    fn();
  };
  const resolveAllRefreshes = async () => {
    refreshes.forEach((r) => r.resolve());
    await flush();
  };
  return { ports, exec, input, selects, gets, lists, pauses, refreshes, creates, navigations, tiles, timers, nextPoll, resolveAllRefreshes, snap: () => exec.getSnapshot() };
}

/** Binds camp-1 on ex-1 and answers the first poll with the ex-1 view so the reducer is at revision 3. */
async function boundOnMissionOne() {
  const h = harness();
  h.input({});
  h.lists[0]!.resolve([listItem('running')]);
  h.exec.selectCampaign('camp-1');
  expect(h.gets).toHaveLength(1);
  h.gets[0]!.d.resolve(view('ex-1', 3));
  await flush();
  expect(h.snap().follow).toMatchObject({ campaignId: 'camp-1', activeExerciseId: 'ex-1', appliedRevision: 3 });
  expect(h.selects).toHaveLength(0);
  return h;
}

/** Second poll reports mission two open; the executor sends the automatic select and leaves it on the wire. */
async function automaticSelectInFlight() {
  const h = await boundOnMissionOne();
  h.nextPoll();
  h.gets[1]!.d.resolve(view('ex-2', 4));
  await flush();
  expect(h.selects).toHaveLength(1);
  expect(h.selects[0]!.req).toEqual({ exerciseId: 'ex-2', reason: 'automatic', expected: { activeId: 'ex-1', playbackTick: null, revision: 7 } });
  expect(h.tiles).toEqual([null]);
  expect(h.snap().lastTransition).toBeNull();
  return h;
}

/* ---------------- tests ---------------- */

describe('automatic transition, undisturbed', () => {
  it('a live follower on Exercise is moved, told once, and the overview is refreshed after the select', async () => {
    const h = await automaticSelectInFlight();
    h.selects[0]!.d.resolve({ selected: 'ex-2', navigationRevision:8 });
    await flush();
    expect(h.snap().lastTransition?.message).toMatch(/Mission 2: Crossing has started\. This is a new map with new forces/);
    expect(h.refreshes).toHaveLength(1);
    await h.resolveAllRefreshes();
    // The overview now reports the exercise the executor itself selected: not a user intent, nothing re-announced.
    h.input({ activeId: 'ex-2' });
    h.nextPoll();
    h.gets[2]!.d.resolve(view('ex-2', 4));
    await flush();
    expect(h.selects).toHaveLength(1);
    expect(h.navigations).toEqual([]);
    expect(h.snap().follow.heldTransition).toBeNull();
  });
});

describe('intent while the automatic select is on the wire', () => {
  it('Review opened meanwhile: the move is undone, the user stays on the mission they were reviewing, the transition is held', async () => {
    const h = await automaticSelectInFlight();
    h.input({ view: 'review' });
    h.selects[0]!.d.resolve({ selected: 'ex-2', navigationRevision: 8 }); // server already applied it
    await flush();
    expect(h.selects).toHaveLength(2);
    // The undo asserts the revision the server just committed, so it can only ever undo our own write.
    expect(h.selects[1]!.req).toEqual({ exerciseId: 'ex-1', reason: 'restore', expected: { activeId: 'ex-2', playbackTick: null, revision: 8 } });
    h.selects[1]!.d.resolve({ selected: 'ex-1' });
    await flush();
    const s = h.snap();
    expect(s.follow.activeExerciseId).toBe('ex-1');
    expect(s.follow.heldTransition?.toExerciseId).toBe('ex-2');
    expect(s.follow.announcedExerciseId).toBe('ex-1');
    expect(s.lastTransition).toBeNull();
    expect(s.actionError).toBeNull();
    expect(h.navigations).toEqual([]);
    expect(h.refreshes).toHaveLength(1);
    // The same campaign revision is not re-applied; "Go to current mission" is the only way forward.
    await h.resolveAllRefreshes();
    h.nextPoll();
    h.gets[2]!.d.resolve(view('ex-2', 4));
    await flush();
    expect(h.selects).toHaveLength(2);
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
  });

  it('scrubbed to a historical tick meanwhile: never left frozen on the wrong mission; restored and held', async () => {
    const h = await automaticSelectInFlight();
    h.input({ playbackTick: 40 });
    h.selects[0]!.d.resolve({ selected: 'ex-2', navigationRevision:8 });
    await flush();
    expect(h.selects[1]?.req.reason).toBe('restore');
    h.selects[1]!.d.resolve({});
    await flush();
    expect(h.snap().follow.activeExerciseId).toBe('ex-1');
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().lastTransition).toBeNull();
  });

  it('follow switched off meanwhile: the preference wins, the move is undone, the choice is kept', async () => {
    const h = await automaticSelectInFlight();
    h.exec.setFollowing(false);
    h.selects[0]!.d.resolve({navigationRevision:8});
    await flush();
    expect(h.selects[1]?.req).toMatchObject({ exerciseId: 'ex-1', reason: 'restore' });
    h.selects[1]!.d.resolve({});
    await flush();
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-1', following: false });
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
  });

  it('when the undo itself is refused, the user is told truthfully that they are on the new mission', async () => {
    const h = await automaticSelectInFlight();
    h.input({ view: 'review' });
    h.selects[0]!.d.resolve({navigationRevision:8});
    await flush();
    // The compensating request must identify the exact write it is undoing.
    expect(h.selects[1]!.req.expected?.revision).toBe(8);
    h.selects[1]!.d.reject(new ApiError(409, 'selection changed'));
    await flush();
    expect(h.snap().lastTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-2', heldTransition: null });
    expect(h.navigations).toEqual([]);
  });

  it('when the undo is refused because the user moved yet again, nothing is announced and the transition stays held', async () => {
    const h = await automaticSelectInFlight();
    h.input({ view: 'review' });
    h.selects[0]!.d.resolve({ navigationRevision: 8 });
    await flush();
    h.input({ activeId: 'ex-3' }); // picked another exercise while the undo was out
    h.selects[1]!.d.reject(new ApiError(409, 'navigation changed'));
    await flush();
    expect(h.snap().lastTransition).toBeNull();
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-3', announcedExerciseId: 'ex-1' });
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
  });

  it('a legacy session without a navigation revision still moves, just without a server precondition', async () => {
    const h = harness();
    h.input({ navigationRevision: null });
    h.lists[0]!.resolve([]);
    h.exec.selectCampaign('camp-1');
    h.gets[0]!.d.resolve(view('ex-2', 4));
    await flush();
    expect(h.selects[0]!.req).toEqual({ exerciseId: 'ex-2', reason: 'automatic' });
  });

  it('a manual selection of another exercise meanwhile is not undone; the transition is held, not delivered', async () => {
    const h = await automaticSelectInFlight();
    h.input({ activeId: 'ex-3' }); // user picked ex-3 from the header while our select was out
    expect(h.snap().follow.activeExerciseId).toBe('ex-3');
    h.selects[0]!.d.resolve({});
    await flush();
    expect(h.selects).toHaveLength(1); // no compensating write against a user's own choice
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-3', announcedExerciseId: 'ex-1' });
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().lastTransition).toBeNull();
    expect(h.navigations).toEqual([]);
    // If the server's last write was ours, the overview says so; the tab reconciles and the notice is cleared
    // only because the user is now actually on the new mission.
    await h.resolveAllRefreshes();
    h.input({ activeId: 'ex-2' });
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-2', heldTransition: null });
  });

  it('an intent that lands before the select is sent means nothing is sent at all', async () => {
    const h = await boundOnMissionOne();
    h.nextPoll();
    h.input({ view: 'review' }); // while GET /api/campaigns/:id is out
    h.gets[1]!.d.resolve(view('ex-2', 4));
    await flush();
    expect(h.selects).toHaveLength(0);
    expect(h.snap().view?.activeExerciseId).toBe('ex-2'); // the panel still shows the fresh view
    // The next poll re-decides from the current state: Review is open, so the transition is held.
    h.nextPoll();
    h.gets[2]!.d.resolve(view('ex-2', 4));
    await flush();
    expect(h.selects).toHaveLength(0);
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().follow.following).toBe(true);
  });

  it('switching to another campaign mid-flight drops the old transition entirely', async () => {
    const h = await automaticSelectInFlight();
    h.exec.selectCampaign('camp-9');
    h.selects[0]!.d.resolve({});
    await flush();
    expect(h.selects).toHaveLength(1);
    expect(h.snap().follow).toMatchObject({ campaignId: 'camp-9', activeExerciseId: 'ex-1', heldTransition: null });
    expect(h.snap().lastTransition).toBeNull();
    expect(h.refreshes).toHaveLength(0);
    expect(h.gets.at(-1)?.id).toBe('camp-9');
  });

  it('a scope change (sign-out, other workroom) mid-flight clears everything and delivers nothing', async () => {
    const h = await automaticSelectInFlight();
    h.input({ scopeKey: '' });
    h.selects[0]!.d.resolve({});
    await flush();
    expect(h.snap()).toMatchObject({ campaignId: null, view: null, lastTransition: null, list: [] });
    expect(h.selects).toHaveLength(1);
    expect(h.refreshes).toHaveLength(0);
  });
});

describe('frozen review and refused selection', () => {
  it('a frozen tick is never moved automatically, not even when a newer mission keeps being reported', async () => {
    const h = await boundOnMissionOne();
    h.input({ playbackTick: 120 });
    h.nextPoll();
    h.gets[1]!.d.resolve(view('ex-2', 4));
    await flush();
    h.nextPoll();
    h.gets[2]!.d.resolve(view('ex-3', 5));
    await flush();
    expect(h.selects).toHaveLength(0);
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-1', playbackTick: 120 });
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-3');
  });

  it('a refused select keeps the user in place with a retryable notice; accepting retries and only then navigates', async () => {
    const h = await automaticSelectInFlight();
    h.selects[0]!.d.reject(new ApiError(403, 'exercise not visible'));
    await flush();
    expect(h.snap().follow).toMatchObject({ activeExerciseId: 'ex-1', announcedExerciseId: 'ex-1' });
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().actionError).toMatch(/Could not move to the new mission: exercise not visible/);
    expect(h.snap().lastTransition).toBeNull();
    expect(h.refreshes).toHaveLength(0);
    // Retry through the explicit path, asserting the navigation the tab sees now (the user froze meanwhile).
    h.input({ playbackTick: 30, navigationRevision: 9 });
    const accepted = h.exec.acceptTransition();
    expect(h.selects).toHaveLength(2);
    expect(h.selects[1]!.req).toEqual({ exerciseId: 'ex-2', reason: 'accept', expected: { activeId: 'ex-1', playbackTick: 30, revision: 9 } });
    h.selects[1]!.d.resolve({});
    await flush();
    await h.resolveAllRefreshes();
    expect(await accepted).toBe('moved');
    expect(h.navigations).toEqual(['exercise']);
    expect(h.snap().lastTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().follow.heldTransition).toBeNull();
  });

  it('a server-side navigation conflict (409) is explained as a view change and kept retryable', async () => {
    const h = await automaticSelectInFlight();
    h.selects[0]!.d.reject(new ApiError(409, 'Your view changed; the waiting mission was not opened'));
    await flush();
    expect(h.snap().actionError).toBe('Could not move to the new mission: your view changed while it was being opened. Use "Go to current mission" to try again.');
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
    expect(h.snap().follow.activeExerciseId).toBe('ex-1');
  });

  it('accepting and then opening Review before the select returns does not navigate away from Review', async () => {
    const h = await automaticSelectInFlight();
    h.selects[0]!.d.reject(new ApiError(409, 'busy'));
    await flush();
    const accepted = h.exec.acceptTransition();
    h.input({ view: 'review' });
    h.selects[1]!.d.resolve({navigationRevision:8});
    await flush();
    h.selects[2]!.d.resolve({navigationRevision:9}); // restore
    await flush();
    await h.resolveAllRefreshes();
    expect(await accepted).toBe('superseded');
    expect(h.navigations).toEqual([]);
    expect(h.snap().follow.heldTransition?.toExerciseId).toBe('ex-2');
  });
});

describe('explicit campaign actions and late responses', () => {
  it('a poll that was out when the owner paused cannot overwrite the pause response, and its request is aborted', async () => {
    const h = await boundOnMissionOne();
    h.nextPoll();
    const stale = h.gets[1]!;
    const pausing = h.exec.pause();
    expect(stale.signal.aborted).toBe(true);
    expect(h.snap().busy).toBe(true);
    h.pauses[0]!.resolve(view('ex-1', 4, { enabled: false, paused: { reason: 'Paused by the campaign owner', at: 'x' } }));
    await pausing;
    expect(h.snap().view?.enabled).toBe(false);
    expect(h.snap().view?.pauseReason).toBe('participant-pause');
    expect(h.snap().busy).toBe(false);
    // Even if the transport had not honoured the abort, the pre-pause snapshot is dropped.
    stale.d.resolve(view('ex-1', 3));
    await flush();
    expect(h.snap().view?.enabled).toBe(false);
  });

  it('a pause that fails does not leave the panel busy or hide the failure', async () => {
    const h = await boundOnMissionOne();
    const pausing = h.exec.pause();
    h.pauses[0]!.reject(new ApiError(403, 'read-only seat'));
    await pausing;
    expect(h.snap()).toMatchObject({ busy: false, actionError: 'read-only seat' });
  });

  it('the newest list request wins even when an older one answers last', async () => {
    const h = harness();
    h.input({});
    h.exec.reloadList();
    expect(h.lists).toHaveLength(2);
    h.lists[1]!.resolve([listItem('stopped')]);
    await flush();
    h.lists[0]!.resolve([listItem('running')]);
    await flush();
    expect(h.snap().list.map((i) => i.status)).toEqual(['stopped']);
  });

  it('a list answer from a previous scope never repopulates the new one', async () => {
    const h = harness();
    h.input({});
    h.input({ scopeKey: 'kamiwaza:sub-b:room' });
    h.lists[0]!.resolve([listItem('running')]);
    await flush();
    expect(h.snap().list).toEqual([]);
    h.lists[1]!.resolve([]);
    await flush();
    expect(h.snap().listError).toBeNull();
  });

  it('a campaign that disappears from the session is dropped with a notice and polling stops', async () => {
    const h = await boundOnMissionOne();
    h.nextPoll();
    h.gets[1]!.d.reject(new ApiError(404, 'not found'));
    await flush();
    expect(h.snap()).toMatchObject({ campaignId: null, view: null, pollError: 'This campaign is no longer available to your session.' });
    expect(h.timers).toHaveLength(0);
    expect(h.lists).toHaveLength(2);
  });
});

describe('open mission for review', () => {
  it('navigates to Review only after the selection and refresh land and nothing newer happened', async () => {
    const h = await boundOnMissionOne();
    const opening = h.exec.openMission('ex-2');
    expect(h.selects[0]!.req).toEqual({ exerciseId: 'ex-2', reason: 'open-mission' });
    h.selects[0]!.d.resolve({});
    await flush();
    h.input({ activeId: 'ex-2' }); // the overview reflects this very request: not a newer intent
    h.refreshes[0]!.resolve();
    await opening;
    expect(h.navigations).toEqual(['review']);
  });

  it('does not navigate when the user picked a different exercise while it was on the wire', async () => {
    const h = await boundOnMissionOne();
    const opening = h.exec.openMission('ex-2');
    h.input({ activeId: 'ex-3' });
    h.selects[0]!.d.resolve({});
    await flush();
    h.refreshes[0]!.resolve();
    await opening;
    expect(h.navigations).toEqual([]);
  });

  it('a refused open reports the error unless the user has already moved on', async () => {
    const h = await boundOnMissionOne();
    const opening = h.exec.openMission('ex-2');
    h.selects[0]!.d.reject(new ApiError(404, 'gone'));
    await opening;
    expect(h.snap().actionError).toBe('gone');
    const again = h.exec.openMission('ex-3');
    h.exec.clearCampaign();
    h.selects[1]!.d.reject(new ApiError(404, 'gone again'));
    await again;
    expect(h.snap().actionError).toBeNull();
  });
});

describe('start', () => {
  it('binds the created campaign, announces mission one and navigates unless the user moved on meanwhile', async () => {
    const h = harness();
    h.input({});
    const starting = h.exec.start('Evening practice');
    h.input({ view: 'review' });
    h.creates[0]!.d.resolve(view('ex-2', 2));
    await flush();
    await h.resolveAllRefreshes();
    await starting;
    expect(h.snap().campaignId).toBe('camp-1');
    expect(h.snap().lastTransition).toMatchObject({ toExerciseId: 'ex-2', missionNumber: 2 });
    expect(h.snap().follow.activeExerciseId).toBe('ex-2');
    expect(h.navigations).toEqual([]);
    expect(h.selects).toHaveLength(0); // the server already selected mission one
    expect(h.gets.at(-1)?.id).toBe('camp-1');
  });
});

describe('mount lifecycle and guarded compensation',()=>{
 it('continues polling after a cleanup/setup replay and drops the first mount response',async()=>{
  const h=harness();h.input({});
  h.exec.selectCampaign('camp-1');
  const before=h.lists[0]!;
  h.exec.dispose();h.exec.activate();
  before.resolve([listItem('stopped')]);
  h.lists.at(-1)!.resolve([listItem('running')]);
  h.gets.at(-1)!.d.resolve(view('ex-1',2));
  await flush();
  expect(h.snap().list[0]?.status).toBe('running');
  expect(h.snap().view?.campaign.revision).toBe(2);
  h.nextPoll();expect(h.gets).toHaveLength(3);
  h.exec.dispose();
 });
 it('never issues an unconditional undo when a superseded selection has no committed revision',async()=>{
  const h=await automaticSelectInFlight();
  h.input({view:'review'});h.selects[0]!.d.resolve({});
  await flush();
  expect(h.selects).toHaveLength(1);
  expect(h.snap().lastTransition).toBeNull();
  h.exec.dispose();
 });
});

describe('integrated campaign joining',()=>{
 it('binds the joined mission through the executor without a second selection request',async()=>{
  const h=harness();h.input({});
  h.ports.joinCampaign=async()=>({campaignId:'camp-1',joined:true,activeExerciseId:'ex-2',navigationSelected:true,view:view('ex-2',4)});
  const joining=h.exec.join('code');await flush();
  expect(h.snap().campaignId).toBe('camp-1');expect(h.selects).toHaveLength(0);expect(h.navigations).toEqual(['exercise']);
  await h.resolveAllRefreshes();await joining;h.exec.dispose();
 });
 it('drops a late join answer after identity changes',async()=>{
  const h=harness();h.input({});const d=deferred<any>();h.ports.joinCampaign=()=>d.promise;
  const joining=h.exec.join('code');h.input({scopeKey:'kamiwaza:someone-else:room'});
  d.resolve({campaignId:'camp-1',joined:true,activeExerciseId:'ex-2',view:view('ex-2',4)});await joining;
  expect(h.snap().campaignId).toBeNull();expect(h.navigations).toEqual([]);expect(h.selects).toEqual([]);h.exec.dispose();
 });
 it('keeps newer navigation when the server joins without selecting the mission',async()=>{
  const h=harness();h.input({view:'review',playbackTick:10});
  h.ports.joinCampaign=async()=>({campaignId:'camp-1',joined:true,activeExerciseId:'ex-2',navigationSelected:false,view:view('ex-2',4)});
  const joining=h.exec.join('code');await flush();
  expect(h.navigations).toEqual([]);expect(h.snap().follow.following).toBe(false);expect(h.selects).toEqual([]);
  await h.resolveAllRefreshes();await joining;h.exec.dispose();
 });
 it('reports a refused invitation without changing the current campaign',async()=>{
  const h=harness();h.input({});h.ports.joinCampaign=async()=>{throw new ApiError(404,'Campaign code unavailable');};
  await h.exec.join('bad');expect(h.snap().actionError).toContain('unavailable');expect(h.snap().busy).toBe(false);expect(h.navigations).toEqual([]);h.exec.dispose();
 });
 it('does not let a late campaign creation replace a newer campaign choice',async()=>{
  const h=harness();h.input({});const pending=h.exec.start('First');
  h.exec.selectCampaign('chosen-later');h.creates[0].d.resolve(view('ex-2',4));await pending;
  expect(h.snap().campaignId).toBe('chosen-later');expect(h.navigations).toEqual([]);h.exec.dispose();
 });
});
