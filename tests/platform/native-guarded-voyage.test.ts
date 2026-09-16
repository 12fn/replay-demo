/**
 * Offline contract for the guarded-voyage native qualifier. A fake application answers only the routes the
 * script may use, with the server's scoping rules (selection, playback, finish on the active exercise), a fake
 * clock and no network, credentials, provider or browser. The reconstruction helper runs on the pinned engine.
 */
import { describe, expect, it } from 'vitest';
import { CLIENTS, SIMULATION_PROFILE, TRANSPORT_ADMISSION } from '../../src/engine/engine';
import {
  GUARD_REFUSAL, SCENARIO, allowedRequest, compareObservations, reconstructVoyage, runGuardedVoyage,
  type Client, type Deps, type Observation, type Seat,
} from '../../scripts/platform/qualify-native-guarded-voyage';
import { ISLAND_SHORE, boat, navalEngine } from '../naval-fixture';

const VERSION = '0.22.1';
const OWNER = 'owner-subject', COMMANDER = 'commander-subject';
const NEW_ID = '11111111-2222-4333-8444-555555555555';
const OLD = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Older original', kind: 'recorded', status: 'completed', humanSide: 'blue', agentEnabled: false, options: { ownerSubject: OWNER, map: 'world-500' } },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Older branch', kind: 'branch', status: 'completed', humanSide: 'blue', agentEnabled: false, options: { ownerSubject: OWNER, map: 'world-500' } },
];
const LANDING = { intent: { type: 'boat', dst: 4242, troops: 60 }, meaning: 'synthetic', landing: { tile: 4242, x: 42, y: 8 }, target: 'unclaimed', distanceFromCoast: 9, costGold: 0 };

interface Options {
  naval?: 'available' | 'never';
  needsPreparation?: boolean;
  submit?: 'accept' | { status: number; error: string };
  tickRejection?: string;
  launchAfterTicks?: number | null;
  landAfterTicks?: number | null;
  finishFailures?: number;
  budgetDriftAfterCreate?: boolean;
  oldPaidController?: boolean;
  mutateOldRowOnSubmit?: boolean;
  overviewErrorOnPoll?: number;
  reconstructObservations?: (recorded: Observation[]) => Observation[];
}

function fakeApp(o: Options = {}) {
  let ms = 0;
  const calls: Array<{ seat: Seat; method: string; path: string; body?: any }> = [];
  const violations: string[] = [];
  const rows = OLD.map(r => structuredClone(r)) as any[];
  const budget = { requestsUsed: 93, maxRequests: 100, committedUsd: 0.071293, maxUsd: 5 };
  const sessions: Record<Seat, { activeId: string; playbackTick: null }> = { owner: { activeId: OLD[0].id, playbackTick: null }, commander: { activeId: OLD[0].id, playbackTick: null } };
  let created: any = null, createdAt = 0, frozenTick: number | null = null, joined = false, code = '';
  let command: { id: string; submittedTick: number } | null = null, finishFailures = o.finishFailures ?? 0, overviewPolls = 0;
  const closed: Seat[] = [];
  if (o.oldPaidController) rows[0].agentEnabled = true;

  const tick = () => frozenTick ?? (created ? Math.floor((ms - createdAt) / 100) + 1 : 0);
  const settledTick = () => command && command.submittedTick + 1;
  const observations = (): Observation[] => {
    if (!command || o.tickRejection || tick() < settledTick()!) return [];
    const out: Observation[] = [], at = settledTick()!;
    const launch = o.launchAfterTicks === undefined ? 0 : o.launchAfterTicks;
    if (launch !== null && tick() >= at + launch) out.push({ tick: at + launch, status: 'transport-launched' });
    const land = o.landAfterTicks === undefined ? 40 : o.landAfterTicks;
    if (launch !== null && land !== null && tick() >= at + land) out.push({ tick: at + land, status: 'transport-landed' });
    return out;
  };
  const inputKey = () => ({ turnNumber: settledTick()! - 1, intentIndex: 0, clientID: CLIENTS.blue });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const visible = () => created ? [...rows, created] : rows;
  let preparation: any = null;
  const overview = (seat: Seat) => {
    const active = visible().find(r => r.id === sessions[seat].activeId)!;
    const executionOrders = active.id === created?.id && command && !o.tickRejection && tick() >= settledTick()!
      ? [{ eventId: 'command-event', tick: settledTick(), side: 'blue', commandId: command.id, intent: LANDING.intent, origin: 'human', reason: null, admission: 'accepted', status: observations().at(-1)?.status ?? 'awaiting-observation', inputKey: inputKey(), observations: observations().map((x, i) => ({ eventId: `f${i}`, ...x, observed: {}, inherited: false })) }]
      : [];
    const timeline = active.id === created?.id && command && o.tickRejection && tick() >= settledTick()!
      ? [{ id: 'rejected-event', tick: settledTick(), kind: 'command_rejected', side: 'blue', details: { commandId: command.id, reason: o.tickRejection } }] : [];
    return { activeId: active.id, identity: { subject: seat === 'owner' ? OWNER : COMMANDER, role: seat === 'owner' ? 'instructor' : 'commander' }, selectedSide: active.humanSide, playbackTick: null,
      exercises: visible().map(r => ({ ...r, tick: r.id === created?.id ? tick() : 500 })), state: { players: [{side:'blue',troops:1000}], tick: active.id === created?.id ? tick() : 500, spawning: active.id === created?.id && tick() < 30 },
      tasks: [], timeline, executionOrders };
  };

  const handle = (seat: Seat, path: string, body: any): Response => {
    const method = body === undefined ? 'GET' : 'POST';
    calls.push({ seat, method, path, body });
    const session = sessions[seat];
    if (path === '/replay-build.json') return json(200, { version: VERSION, sourceArchive: { sha256: 'synthetic' }, simulationProfile: SIMULATION_PROFILE });
    if (path === '/api/native/status') return json(200, { mode: 'kamiwaza', signedIn: true, workroomId: 'room', identity: { subject: seat === 'owner' ? OWNER : COMMANDER, role: seat === 'owner' ? 'instructor' : 'commander' }, context: { nativeRole: seat === 'owner' ? 'owner' : 'member' } });
    if (path === '/api/team') return json(200, { exerciseId: session.activeId });
    if (path === '/api/agents/tools') {
      if (o.budgetDriftAfterCreate && created) return json(200, { budget: { ...budget, requestsUsed: budget.requestsUsed + 1 } });
      return json(200, { budget });
    }
    if (path === '/api/overview') {
      if (seat === 'commander' && !joined) violations.push('commander-overview-before-enrollment');
      if (seat === 'commander' && created && ++overviewPolls === o.overviewErrorOnPoll) return json(500, { error: 'synthetic outage' });
      return json(200, overview(seat));
    }
    if (path === '/api/exercises') {
      if (created) violations.push('second-exercise-created');
      createdAt = ms;
      created = { id: NEW_ID, name: body.name, kind: 'live', status: 'running', humanSide: 'blue', agentEnabled: false,
        options: { map: 'world-500', simulationProfile: SIMULATION_PROFILE, transportAdmission: TRANSPORT_ADMISSION, scenario: { id: body.scenarioId, controller: 'maneuver/1' }, ownerSubject: OWNER } };
      session.activeId = NEW_ID;
      return json(201, created);
    }
    if (path === '/api/team/code') { code = 'ab'.repeat(16); return json(200, { code }); }
    if (path === '/api/team/join') { if (body.code !== code) return json(403, {}); joined = true; session.activeId = NEW_ID; return json(200, { exerciseId: NEW_ID, side: 'blue' }); }
    if (path === '/api/select') {
      if (!visible().some(r => r.id === body.exerciseId)) return json(404, {});
      session.activeId = body.exerciseId; return json(200, { selected: body.exerciseId });
    }
    if (path.startsWith('/api/action-options')) {
      if (session.activeId !== NEW_ID) { violations.push('action-options-without-selection'); return json(409, {}); }
      const available = o.naval !== 'never' && tick() >= 30 && (!o.needsPreparation || preparation !== null);
      return json(200, { exerciseId: NEW_ID, side: 'blue', tick: tick(), fingerprint: `fp-${tick()}`, units: [], buildCosts: {},
        naval: available ? { status: 'available', sampling: 'Sampled', landingsConsidered: 5, landings: [LANDING], transportsAtSea: [], limit: { atSea: 0, max: 3 } }
          : { status: 'unavailable', reason: 'No owned shoreline to launch from', sampling: 'Sampled', landingsConsidered: 0, landings: [], transportsAtSea: [], limit: { atSea: 0, max: 3 } } });
    }
    if (path === '/api/commands') {
      if (session.activeId !== NEW_ID) violations.push('command-without-selection');
      if (o.needsPreparation && body.side === 'blue' && body.intent.type === 'attack') { preparation = body.intent; return json(202, {id:'prep-command',status:'queued'}); }
      if (body.side !== 'blue' || JSON.stringify(body.intent) !== JSON.stringify(LANDING.intent)) violations.push('command-not-the-listed-landing');
      if (o.mutateOldRowOnSubmit) rows[1].name = 'Changed by someone';
      const submit = o.submit ?? 'accept';
      if (submit !== 'accept') return json(submit.status, { error: submit.error });
      command = { id: 'command-1', submittedTick: tick() };
      return json(202, { id: command.id, status: 'queued' });
    }
    if (path === `/api/exercises/${NEW_ID}/finish`) {
      if (session.activeId !== NEW_ID) { violations.push('finish-without-selection'); return json(409, {}); }
      if (finishFailures-- > 0) return json(503, { error: 'synthetic' });
      frozenTick = tick(); created.status = 'completed'; created.kind = 'recorded';
      return json(200, created);
    }
    if (path === `/api/record/${NEW_ID}`) {
      if (created.status !== 'completed') { violations.push('record-before-finish'); return json(403, {}); }
      const turns = command && !o.tickRejection ? [{ turnNumber: inputKey().turnNumber, intents: [{ ...LANDING.intent, clientID: CLIENTS.blue }] }] : [{ turnNumber: 0, intents: [] }];
      if (preparation) turns.unshift({turnNumber:0,intents:[{...preparation,clientID:CLIENTS.blue}]});
      return json(200, { version: 1, upstreamCommit: 'synthetic', simulationProfile: SIMULATION_PROFILE, options: created.options, turns, fingerprints: {} });
    }
    violations.push(`unexpected ${method} ${path}`);
    return json(404, {});
  };

  const receipts = new Map<string, string>(), writes: Array<{ file: string; create: boolean }> = [];
  const reconstructCalls: any[] = [];
  const deps: Deps = {
    runId: 'test-run',
    now: () => ms,
    sleep: async wait => { ms += wait; },
    login: async seat => {
      const client: Client = {
        requestRaw: async (path, body) => { ms += 20; return handle(seat, path, body); },
        close: async () => { closed.push(seat); },
      };
      return client;
    },
    reconstruct: async (record, key, maxTurns) => {
      reconstructCalls.push({ key, maxTurns, turns: record.turns.length, calledAt: calls.length });
      const recorded = key ? observations() : [];
      return { fromTurn: key ? 0 : record.turns.length, turns: record.turns.length, verifiedTicks: tick(), finalFingerprint: 'fp', observations: o.reconstructObservations ? o.reconstructObservations(recorded) : recorded };
    },
    writeReceipt: (file, text, create) => {
      if (create && receipts.has(file)) throw new Error('EEXIST');
      if (!create && !receipts.has(file)) throw new Error('receipt must be created first');
      receipts.set(file, text); writes.push({ file, create });
    },
  };
  return { deps, calls, violations, rows, closed, receipts, writes, reconstructCalls, tick };
}

const receiptOf = (app: ReturnType<typeof fakeApp>) => JSON.parse(app.receipts.get(`evidence/platform/native-guarded-voyage-${VERSION}-test-run.json`)!);
const indexWhere = (app: ReturnType<typeof fakeApp>, f: (c: ReturnType<typeof fakeApp>['calls'][number]) => boolean) => app.calls.findIndex(f);
/** Every scoped call by `seat` is preceded, for that seat, by a confirmed selection of the new exercise. */
function selectedBefore(app: ReturnType<typeof fakeApp>, seat: Seat, predicate: (path: string) => boolean) {
  let selected = false;
  for (const c of app.calls.filter(x => x.seat === seat)) {
    if (c.path === '/api/select') selected = c.body.exerciseId === NEW_ID;
    else if (predicate(c.path) && !selected) return false;
  }
  return true;
}

describe('guarded voyage qualifier', () => {
  it('passes a launched and landed voyage only after selection, cleanup, reconstruction and zero budget delta', async () => {
    const app = fakeApp();
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(app.violations).toEqual([]);
    expect(proof.status).toBe('passed');
    expect(proof.outcome).toBe('launched');
    expect(proof.claims).toEqual({ launchObserved: true, landingObserved: true, forcesReturnedObserved: false, guardRefusalObserved: false, arrivalPredicted: false });
    expect(proof.checks.created).toMatchObject({ transportAdmission: TRANSPORT_ADMISSION, controller: 'maneuver/1' });
    expect(proof.checks.reconstruction.observationsMatched).toBe(true);
    expect(proof.newPaidRequests).toBe(0);
    expect(proof.cleanup).toEqual({ attempted: true, finished: true });

    // Exactly one exercise created, of the synthetic scenario; only this run's exercise finished, exactly once.
    expect(app.calls.filter(c => c.path === '/api/exercises')).toHaveLength(1);
    expect(app.calls.find(c => c.path === '/api/exercises')!.body).toEqual({ name: `Automated guarded voyage qualification ${VERSION} test-run`, scenarioId: SCENARIO });
    expect(app.calls.filter(c => c.path.endsWith('/finish')).map(c => c.path)).toEqual([`/api/exercises/${NEW_ID}/finish`]);
    // Only the owner finishes; the commander submits; selection precedes every scoped read and the finish.
    expect(app.calls.filter(c => c.path.endsWith('/finish')).every(c => c.seat === 'owner')).toBe(true);
    expect(app.calls.filter(c => c.path === '/api/commands').map(c => [c.seat, c.body.side])).toEqual([['commander', 'blue']]);
    expect(selectedBefore(app, 'commander', p => p === '/api/overview' || p.startsWith('/api/action-options') || p === '/api/commands')).toBe(true);
    expect(selectedBefore(app, 'owner', p => p.endsWith('/finish'))).toBe(true);
    // The record is read after finish and reconstruction uses the recorded input key.
    expect(indexWhere(app, c => c.path === `/api/record/${NEW_ID}`)).toBeGreaterThan(indexWhere(app, c => c.path.endsWith('/finish')));
    expect(app.reconstructCalls).toEqual([expect.objectContaining({ key: { turnNumber: expect.any(Number), intentIndex: 0, clientID: CLIENTS.blue } })]);
    // No model/agent/staff/Tomo/MCP routes and no writes to older exercises.
    expect(app.calls.every(c => allowedRequest(c.method, c.path, NEW_ID))).toBe(true);
    expect(app.calls.some(c => /\/api\/(agent|staff|tomo|mcp|agents\/tasks|replay|branches|tasks)\b/.test(c.path))).toBe(false);
    expect(app.calls.some(c => c.body?.exerciseId && c.body.exerciseId !== NEW_ID)).toBe(false);
    expect(app.rows).toEqual(OLD);
    expect(proof.checks.preserved).toEqual({ olderExercises: 2, unchangedCompleted: 2, allPaidControllersOff: true });
    expect(app.closed.sort()).toEqual(['commander', 'owner']);
    // The receipt is created exclusively first, then only replaced.
    expect(app.writes[0].create).toBe(true);
    expect(app.writes.slice(1).every(w => !w.create)).toBe(true);
    const receipt = receiptOf(app);
    expect(receipt.status).toBe('passed');
    expect(JSON.stringify(receipt)).not.toContain('ab'.repeat(16));
    expect(JSON.stringify(receipt)).not.toContain(COMMANDER);
  });

  it('never claims a landing it did not observe', async () => {
    const app = fakeApp({ landAfterTicks: null });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('passed');
    expect(proof.claims).toMatchObject({ launchObserved: true, landingObserved: false });
    expect(proof.checks.liveFeedback.observations.map((x: Observation) => x.status)).toEqual(['transport-launched']);
  });

  it('reports no legal candidate without submitting, passing or leaving the exercise running', async () => {
    const app = fakeApp({ naval: 'never' });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(app.violations).toEqual([]);
    expect(proof.status).toBe('no-legal-candidate');
    expect(proof.outcome).toBe('no-legal-candidate');
    expect(app.calls.some(c => c.path === '/api/commands')).toBe(false);
    expect(proof.cleanup.finished).toBe(true);
    expect(proof.claims.launchObserved).toBe(false);
    expect(proof.checks.candidateSearch.unavailable.at(-1).reason).toBe('No owned shoreline to launch from');
    // Candidate polling is bounded by the configured window.
    expect(app.calls.filter(c => c.path.startsWith('/api/action-options')).length).toBeLessThanOrEqual(Math.ceil(30_000 / 1500) + 1);
  });

  it('confirms the guard when submission is refused with the launch-water-route text', async () => {
    const app = fakeApp({ submit: { status: 400, error: GUARD_REFUSAL } });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('passed');
    expect(proof.outcome).toBe('guard-refused-at-submission');
    expect(proof.claims).toMatchObject({ guardRefusalObserved: true, launchObserved: false, landingObserved: false });
    expect(app.reconstructCalls[0].key).toBeNull();
    expect(proof.cleanup.finished).toBe(true);
  });

  it('confirms a tick-time guard refusal read from the recorded timeline', async () => {
    const app = fakeApp({ tickRejection: GUARD_REFUSAL });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('passed');
    expect(proof.outcome).toBe('guard-refused-at-tick');
    expect(proof.claims).toMatchObject({ guardRefusalObserved: true, launchObserved: false });
  });

  it('fails on a refusal that is not the guard', async () => {
    const app = fakeApp({ submit: { status: 400, error: 'Transport limit reached (3 at sea)' } });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures).toContainEqual({ phase: 'submit-legal-order', code: 'submission-refused-without-guard' });
    expect(proof.claims.guardRefusalObserved).toBe(false);
    expect(proof.cleanup.finished).toBe(true);
  });

  it('fails when an admitted transport never launches', async () => {
    const app = fakeApp({ launchAfterTicks: null, landAfterTicks: null });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures.map((f: any) => f.code)).toContain('outcome-not-settled');
    expect(proof.cleanup.finished).toBe(true);
  });

  it('fails when recorded feedback differs from reconstruction', async () => {
    const app = fakeApp({ reconstructObservations: recorded => recorded.map(x => x.status === 'transport-landed' ? { ...x, status: 'transport-forces-returned' } : x) });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures).toContainEqual({ phase: 'record-reconstruction', code: 'recorded-feedback-differs-from-reconstruction' });
  });

  it('ends only the new exercise in finally after a mid-run failure and retains the failure receipt', async () => {
    const app = fakeApp({ overviewErrorOnPoll: 4 });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures[0]).toMatchObject({ code: 'http-500' });
    const finishes = app.calls.filter(c => c.path.endsWith('/finish'));
    expect(finishes.map(c => c.path)).toEqual([`/api/exercises/${NEW_ID}/finish`]);
    expect(app.calls[app.calls.indexOf(finishes[0]) - 1]).toMatchObject({ seat: 'owner', path: '/api/select', body: { exerciseId: NEW_ID } });
    expect(proof.cleanup.finished).toBe(true);
    expect(proof.budgetAfter).toEqual(proof.budgetBefore);
    expect(app.closed.sort()).toEqual(['commander', 'owner']);
    expect(receiptOf(app)).toMatchObject({ status: 'failed', exerciseId: NEW_ID });
    expect(receiptOf(app).receipts.some((r: any) => r.status === 500)).toBe(true);
  });

  it('retries cleanup with a fresh selection and reports an unconfirmed end as failure', async () => {
    const retried = fakeApp({ overviewErrorOnPoll: 4, finishFailures: 1 });
    const first = await runGuardedVoyage(VERSION, retried.deps);
    expect(first.proof.cleanup.finished).toBe(true);
    expect(retried.calls.filter(c => c.path.endsWith('/finish'))).toHaveLength(2);

    const stuck = fakeApp({ overviewErrorOnPoll: 4, finishFailures: 99 });
    const second = await runGuardedVoyage(VERSION, stuck.deps);
    expect(second.proof.status).toBe('failed');
    expect(second.proof.failures).toContainEqual({ phase: 'cleanup-finish-created-exercise', code: 'created-exercise-not-confirmed-ended' });
    expect(stuck.calls.filter(c => c.path.endsWith('/finish'))).toHaveLength(2);
  });

  it('does not create an exercise while a paid controller is on', async () => {
    const app = fakeApp({ oldPaidController: true });
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures).toContainEqual({ phase: 'baseline', code: 'paid-controller-active-before-run' });
    expect(app.calls.some(c => c.path === '/api/exercises' || c.path.endsWith('/finish'))).toBe(false);
  });

  it('fails on any paid budget change or change to an older exercise', async () => {
    const drift = fakeApp({ budgetDriftAfterCreate: true });
    const a = await runGuardedVoyage(VERSION, drift.deps);
    expect(a.proof.status).toBe('failed');
    expect(a.proof.failures).toContainEqual({ phase: 'budget-after', code: 'budget-delta-nonzero' });
    expect(a.proof.newPaidRequests).toBe(1);

    const mutated = fakeApp({ mutateOldRowOnSubmit: true });
    const b = await runGuardedVoyage(VERSION, mutated.deps);
    expect(b.proof.status).toBe('failed');
    expect(b.proof.failures).toContainEqual({ phase: 'older-exercises-preserved', code: 'older-exercise-row-changed' });
  });

  it('enforces request caps and still cleans up', async () => {
    const app = fakeApp();
    app.deps.limits = { commanderRequests: 8 };
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures[0]).toEqual({ phase: expect.any(String), code: 'commander-request-cap' });
    expect(app.calls.filter(c => c.seat === 'commander').length).toBe(8);
    expect(proof.cleanup.finished).toBe(true);
  });

  it('enforces the live deadline across polling', async () => {
    const app = fakeApp({ landAfterTicks: null });
    app.deps.limits = { liveMs: 10_000, observeMs: 60_000 };
    const { proof } = await runGuardedVoyage(VERSION, app.deps);
    expect(proof.status).toBe('failed');
    expect(proof.failures.map((f: any) => f.code)).toContain('live-deadline');
    expect(proof.cleanup.finished).toBe(true);
  });

  it('refuses routes outside the allowlist and other exercises', () => {
    for (const [method, url] of [['POST', '/api/agent'], ['POST', '/api/staff'], ['POST', '/api/agents/tasks/x/model'], ['POST', '/api/replay'], ['POST', '/api/branches'],
      ['GET', '/api/record/other'], ['POST', '/api/exercises/other/finish'], ['GET', '/api/action-options?exerciseId=other'], ['POST', '/api/tomo/conversations']]) {
      expect(allowedRequest(method, url, NEW_ID), `${method} ${url}`).toBe(false);
    }
    expect(allowedRequest('POST', `/api/exercises/${NEW_ID}/finish`, null)).toBe(false);
    expect(allowedRequest('POST', `/api/exercises/${NEW_ID}/finish`, NEW_ID)).toBe(true);
  });

  it('compares recorded observations as an ordered prefix, or exactly when the read is complete', () => {
    const rebuilt = [{ tick: 5, status: 'transport-launched' }, { tick: 20, status: 'transport-landed' }];
    expect(compareObservations(rebuilt.slice(0, 1), rebuilt, false)).toBe(true);
    expect(compareObservations(rebuilt.slice(0, 1), rebuilt, true)).toBe(false);
    expect(compareObservations(rebuilt, rebuilt, true)).toBe(true);
    expect(compareObservations([{ tick: 6, status: 'transport-launched' }], rebuilt, false)).toBe(false);
  });
});

describe('record reconstruction on the pinned engine', () => {
  it('replays a recorded launch-water-route voyage to the same fingerprints and feedback the live engine saw', async () => {
    const e = await navalEngine({ transportAdmission: TRANSPORT_ADMISSION });
    const turnNumber = e.turns.length;
    e.step([boat('blue', ISLAND_SHORE, 40)]);
    const live: Observation[] = e.feedback.drain().map(ev => ({ tick: e.game.ticks(), status: ev.status }));
    for (let i = 0; i < 40; i++) { e.step(); for (const ev of e.feedback.drain()) live.push({ tick: e.game.ticks(), status: ev.status }); }
    expect(live.map(x => x.status)).toEqual(['transport-launched', 'transport-landed']);
    const record = e.record();
    expect(record.options.transportAdmission).toBe(TRANSPORT_ADMISSION);

    const rebuilt = await reconstructVoyage(record, { turnNumber, intentIndex: 0, clientID: CLIENTS.blue }, 1000);
    expect(rebuilt.observations).toEqual(live);
    expect(rebuilt.verifiedTicks).toBe(record.turns.length - turnNumber);
    expect(rebuilt.finalFingerprint).toBe(record.fingerprints[record.turns.length]);

    const tampered = structuredClone(record); tampered.fingerprints[record.turns.length] = 'not-the-recorded-state';
    await expect(reconstructVoyage(tampered, { turnNumber, intentIndex: 0, clientID: CLIENTS.blue }, 1000)).rejects.toThrow('reconstruction-fingerprint-mismatch');
    await expect(reconstructVoyage(record, null, 10)).rejects.toThrow('reconstruction-turn-cap');
    await expect(reconstructVoyage(record, { turnNumber: 9999, intentIndex: 0, clientID: CLIENTS.blue }, 1000)).rejects.toThrow('recorded-turn-missing');
  });
});


it('prepares owned shoreline only through one explicit normal expansion in a fresh opted-in run', async()=>{
 const f=fakeApp({needsPreparation:true});
 f.deps.prepareShore=true;
 const result=await runGuardedVoyage(VERSION,f.deps);
 expect(result.proof.status).toBe('passed');
 expect(result.proof.preparationProfile).toBe('expand-to-shore/1');
 expect(result.proof.checks.preparation.intent).toEqual({type:'attack',targetID:null,troops:350});
 expect(result.proof.checks.preparation.recorded).toBe(true);
 expect(result.proof.newPaidRequests).toBe(0);
 expect(result.proof.cleanup.finished).toBe(true);
});
