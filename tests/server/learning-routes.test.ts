import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { GameService, type Identity, type Session } from '../../src/server/service';
import { mountLearningRoutes } from '../../src/server/learning-routes';
import { DeterministicClient, LunaClient, type CompleteInput } from '../../src/inference/index';

console.debug = () => {};

const alpha: Identity = { subject: 'user-alpha', name: 'Alpha', role: 'commander', organization: 'NPS training workspace', mode: 'local-demo' };
const bravo: Identity = { subject: 'user-bravo', name: 'Bravo', role: 'commander', organization: 'NPS training workspace', mode: 'local-demo' };

const dirs: string[] = [];
const services: GameService[] = [];
const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const srv of servers.splice(0)) srv.close();
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function service() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-learning-'));
  dirs.push(d);
  const s = new GameService(d);
  services.push(s);
  return s;
}

/** Test harness: the session and native context come from headers only here; production sets them server-side. */
async function serve(s: GameService,resolver?:()=>Promise<any>) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const raw = req.headers['x-test-session'];
    if (typeof raw === 'string') res.locals.session = JSON.parse(raw);
    const native = req.headers['x-test-native'];
    if (typeof native === 'string') res.locals.native = JSON.parse(native);
    if(resolver)res.locals.resolveAgentAuthority=resolver;
    next();
  });
  mountLearningRoutes(app, s);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, session: Session, body?: unknown, native?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-session': JSON.stringify(session), ...(native ? { 'x-test-native': JSON.stringify(native) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* markdown or empty */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { call };
}

function session(identity: Identity, activeId: string, extra: Partial<Session> = {}): Session {
  return { identity, activeId, playbackTick: null, selectedSide: 'blue', ...extra };
}

/** Issue a human order on the human side and execute it. Returns the command event. */
function order(s: GameService, id: string, identity: Identity, troops: number, idem: string, metadata?: { rationale?: string; sourceIds?: string[] }) {
  const w = s.world(id);
  s.command(id, w.row.humanSide, { type: 'attack', targetID: null, troops }, idem, identity, 'human', metadata);
  s.tick(w);
  s.tick(w);
  const ev = s.store.events(id).find((e) => e.kind === 'command' && e.details.origin === 'human' && e.actor === identity.subject && e.details.intent?.troops === troops);
  if (!ev) throw new Error('order did not execute');
  return ev;
}

function finish(s: GameService, id: string) {
  const w = s.world(id);
  w.row.status = 'completed';
  w.row.kind = 'recorded';
  s.store.putExercise(w.row);
}

async function attributed(s: GameService, identity: Identity, name: string) {
  const row = await s.create(name, 'plains', identity);
  const w = s.world(row.id);
  for (let i = 0; i < 20; i++) s.tick(w);
  return row;
}

/** A debrief that cites only what the context supplied, in the shape validateDebrief accepts. */
function goodDebrief(req: CompleteInput) {
  const input = JSON.parse(req.input) as { commandEventId: string; availableThenIds: string[]; hindsightIds: string[] };
  const cmd = input.commandEventId;
  const before = input.availableThenIds.find((x) => x === `${cmd}:before`) ?? cmd;
  const after = input.hindsightIds.find((x) => x === `${cmd}:after`);
  return {
    headline: { text: 'An order was issued with the initial estimate current.', citations: [cmd] },
    observations: [{ text: 'You committed forces from the recorded pre-order state.', citations: [before], basis: 'available-then' }],
    opponentPerspective: [],
    tradeoffs: after ? [{ text: 'The post-execution state shows what remained.', citations: [after], basis: 'hindsight' }] : [],
    questions: [{ text: 'What did you expect this order to achieve?', citations: [cmd] }],
    nextPractice: [{ text: 'Write the reason before the order.', citations: ['C5'] }],
    limitations: [{ text: 'Criteria are provisional and unreviewed.', citations: [] }],
  };
}

describe('learning attribution and same-subject history', () => {
  it('compares only the subject\'s own attributed attempts; legacy and other participants never leak', async () => {
    const s = service();
    const prior = await attributed(s, alpha, 'Alpha first');
    order(s, prior.id, alpha, 60, 'a-prior-1', { rationale: 'Expand while the estimate is fresh.', sourceIds: [s.store.reports(prior.id).find((r) => r.side === 'blue')!.id] });
    finish(s, prior.id);
    const theirs = await attributed(s, bravo, 'Bravo attempt');
    order(s, theirs.id, bravo, 50, 'b-1');
    const legacy = await s.create('Legacy local', 'plains');
    const current = await attributed(s, alpha, 'Alpha second');
    order(s, current.id, alpha, 40, 'a-cur-1');

    expect(s.store.exercise(current.id)!.options).toMatchObject({ ownerSubject: 'user-alpha', scenarioId: 'crosscurrent-plains', curriculumVersion: '0.1.0', assistance: 'unassisted' });
    expect(s.store.exercise(legacy.id)!.options.ownerSubject).toBeUndefined();

    const { call } = await serve(s);
    const mine = await call('GET', '/api/learning/dossier', session(alpha, current.id));
    expect(mine.status).toBe(200);
    expect(mine.json.attributed).toBe(true);
    expect(mine.json.dossier.independentPrior.map((a: any) => a.exerciseId)).toEqual([prior.id]);
    expect(mine.json.dossier.independentPrior[0].counts).toMatchObject({ humanCommands: 1, commandsWithRationale: 1, contemporaneousRationale: 1, commandsCitingSources: 1 });
    expect(mine.json.dossier.excluded).toEqual(expect.arrayContaining([{ exerciseId: legacy.id, reason: 'unattributed' }]));
    expect(mine.text).not.toContain(bravo.subject);
    expect(mine.text).not.toContain(theirs.id);

    // Overview-compatible summary carries the same scoping instead of the old workspace-wide list.
    const ov = await s.overview(session(alpha, current.id));
    expect(ov.dossier.attributed).toBe(true);
    expect(ov.dossier.priorAttempts.map((a: any) => a.id)).toEqual([prior.id]);
    expect(JSON.stringify(ov.dossier)).not.toContain(theirs.id);

    // Legacy session active: unattributed, no personal comparison, no dossier body.
    const asLegacy = await call('GET', '/api/learning/dossier', session(alpha, legacy.id));
    expect(asLegacy.json).toMatchObject({ attributed: false, dossier: null });
    expect(asLegacy.json.reason).toMatch(/without a learner attribution/);
    expect((await s.overview(session(alpha, legacy.id))).dossier.priorAttempts).toEqual([]);

    // Another participant's exercise: attributed to them, not to the viewer.
    const asBravoSeat = await call('GET', '/api/learning/dossier', session(alpha, theirs.id));
    expect(asBravoSeat.json.attributed).toBe(false);
    expect(asBravoSeat.json.reason).toMatch(/another participant/);
    expect(asBravoSeat.text).not.toContain('Bravo attempt');

    // Under native identity, other participants' exercises are not even candidates.
    const native = await call('GET', '/api/learning/dossier', session({ ...alpha, mode: 'kamiwaza' }, current.id));
    expect(native.json.dossier.excluded.map((e: any) => e.exerciseId)).not.toContain(legacy.id);
    expect(native.json.dossier.independentPrior.map((a: any) => a.exerciseId)).toEqual([prior.id]);

    const md = await call('GET', '/api/learning/dossier.md', session(alpha, current.id));
    expect(md.status).toBe(200);
    expect(md.headers.get('content-disposition')).toMatch(/attachment; filename="replay-dossier-/);
    expect(md.text).toMatch(/^# Learning dossier · commander · user-alpha/);
    expect(md.text).not.toContain(bravo.subject);
    expect((await call('GET', '/api/learning/dossier.md', session(alpha, legacy.id))).status).toBe(409);
  });

  it('branches are attributed to whoever opens them and start with unknown assistance; a model staff answer marks staff-assisted', async () => {
    const s = service();
    const src = await attributed(s, alpha, 'Source');
    order(s, src.id, alpha, 30, 'src-1');
    const forkTick = s.world(src.id).engine.game.ticks();
    const b = await s.branch(src.id, forkTick, 'red', bravo);
    expect(b.options).toMatchObject({ ownerSubject: 'user-bravo', assistance: 'unknown', scenarioId: 'crosscurrent-plains' });
    const anon = await s.branch(src.id, forkTick, 'blue');
    expect(anon.options.ownerSubject).toBeUndefined();
    s.luna = new DeterministicClient({ respond: () => 'synthetic staff answer' });
    await s.staff(session(alpha, src.id), 'How many forces do I have?', 'blue');
    expect(s.store.exercise(src.id)!.options.assistance).toBe('staff-assisted');
    // The branch opened by alpha after review is informed practice in alpha's dossier, even though it is newer.
    const mineBranch = await s.branch(src.id, forkTick, 'blue', alpha);
    const d = s.dossier(session(alpha, src.id));
    expect(d.dossier!.informedPractice.map((a) => a.exerciseId)).toEqual([mineBranch.id]);
    expect(d.dossier!.current.assistance).toBe('staff-assisted');
  });
});

describe('rationale capture and temporal source eligibility', () => {
  it('persists a contemporaneous rationale with the order and rejects citations not available to that side at submission', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'Rationale');
    const blue = s.store.reports(ex.id).find((r) => r.side === 'blue')!;
    const red = s.store.reports(ex.id).find((r) => r.side === 'red')!;
    expect(() => s.command(ex.id, 'blue', { type: 'attack', targetID: null, troops: 20 }, 'bad-cite', alpha, 'human', { rationale: 'x', sourceIds: [red.id] })).toThrow(/not a blue report available/);
    expect(() => s.command(ex.id, 'blue', { type: 'attack', targetID: null, troops: 20 }, 'bad-cite-2', alpha, 'human', { rationale: 'x', sourceIds: ['made-up'] })).toThrow(/not a blue report available/);
    expect(s.store.pending(ex.id)).toHaveLength(0);
    const ev = order(s, ex.id, alpha, 25, 'good-cite', { rationale: '  Expand now; keep most in reserve. ', sourceIds: [blue.id] });
    expect(ev.details).toMatchObject({ rationale: 'Expand now; keep most in reserve.', rationaleTiming: 'contemporaneous', sourceIds: [blue.id] });
    expect(ev.details.observedTick).toBeLessThan(ev.tick);
    const silent = order(s, ex.id, alpha, 26, 'silent');
    expect(silent.details.rationale).toBeUndefined();
    expect(silent.details.rationaleTiming).toBeUndefined();
    const d = s.dossier(session(alpha, ex.id)).dossier!;
    expect(d.observations.find((o) => o.evidenceId === ev.id)?.rationale).toMatchObject({ timing: 'contemporaneous', sourceIds: [blue.id] });
    expect(d.probes.map((p) => p.evidenceId)).toEqual([silent.id]);
  });

  it('records post-hoc decision statements separately, validates sources against the order\'s observed tick, and is own-subject only', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'Post hoc');
    const ev = order(s, ex.id, alpha, 30, 'ph-1');
    const before = s.store.reports(ex.id).find((r) => r.side === 'blue')!;
    for (let i = 0; i < 5; i++) s.tick(s.world(ex.id));
    s.injectReport(ex.id);
    const later = s.store.reports(ex.id).filter((r) => r.side === 'blue').at(-1)!;
    expect(later.tick).toBeGreaterThan(ev.details.observedTick);
    const { call } = await serve(s);

    const hindsight = await call('POST', '/api/learning/decision-log', session(alpha, ex.id), { eventId: ev.id, text: 'I used the later estimate.', sourceIds: [later.id] });
    expect(hindsight.status).toBe(422);
    expect(hindsight.json.error).toMatch(/not a blue report available at tick/);
    expect(s.store.events(ex.id).filter((e) => e.kind === 'decision_log')).toHaveLength(0);

    const other = await call('POST', '/api/learning/decision-log', session(bravo, ex.id), { eventId: ev.id, text: 'Not mine.', sourceIds: [] });
    expect(other.status).toBe(403);
    const missing = await call('POST', '/api/learning/decision-log', session(alpha, ex.id), { eventId: 'nope', text: 'x' });
    expect(missing.status).toBe(404);
    expect((await call('POST', '/api/learning/decision-log', session(alpha, ex.id), { eventId: ev.id, text: '' })).status).toBe(400);

    const ok = await call('POST', '/api/learning/decision-log', session(alpha, ex.id), { eventId: ev.id, text: 'Pressed early on the initial estimate.', sourceIds: [before.id] });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ timing: 'post-hoc', commandEventId: ev.id, sourceIds: [before.id] });
    const log = s.store.events(ex.id).find((e) => e.kind === 'decision_log')!;
    expect(log.details).toMatchObject({ commandId: ev.details.commandId, timing: 'post-hoc', author: alpha.subject, orderObservedTick: ev.details.observedTick });
    expect(log.tick).toBeGreaterThan(ev.tick);
    const d = s.dossier(session(alpha, ex.id)).dossier!;
    expect(d.observations.find((o) => o.evidenceId === ev.id)?.rationale).toMatchObject({ timing: 'post-hoc', evidenceId: log.id });
    expect(d.gaps.find((g) => g.kind === 'rationale-post-hoc-only')?.evidenceIds).toEqual([ev.id]);
    expect(d.gaps.find((g) => g.kind === 'rationale-unobserved')).toBeUndefined();
  });

  it('assessment entries belong to the intelligence seat and are post-hoc when not viewing live play', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'Assess');
    const blue = s.store.reports(ex.id).find((r) => r.side === 'blue')!;
    const red = s.store.reports(ex.id).find((r) => r.side === 'red')!;
    const { call } = await serve(s);
    const analyst: Identity = { ...alpha, role: 'intelligence' };
    expect((await call('POST', '/api/learning/assessment', session(alpha, ex.id), { text: 'Commander cannot log assessments', sourceIds: [] })).status).toBe(403);
    expect((await call('POST', '/api/learning/assessment', session(analyst, ex.id), { text: 'Cites the other side', sourceIds: [red.id] })).status).toBe(422);
    const live = await call('POST', '/api/learning/assessment', session(analyst, ex.id), { text: 'Opponent holds about 40 tiles per the initial estimate.', sourceIds: [blue.id] });
    expect(live.status).toBe(201);
    expect(live.json.timing).toBe('contemporaneous');
    const hist = await call('POST', '/api/learning/assessment', session(analyst, ex.id, { playbackTick: 3 }), { text: 'Written while viewing tick 3.', sourceIds: [] });
    expect(hist.json).toMatchObject({ timing: 'post-hoc', observedTick: 3 });
    const events = s.store.events(ex.id).filter((e) => e.kind === 'assessment_log');
    expect(events.map((e) => e.details.timing)).toEqual(['contemporaneous', 'post-hoc']);
    expect(events[0].details.sourceIds).toEqual([blue.id]);
  });
});

describe('debrief: cache, single flight, validation and safe failure', () => {
  it('generates once per evidence hash, serves the cache afterwards, and never double-spends on concurrent identical requests', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'Debrief');
    const ev = order(s, ex.id, alpha, 35, 'db-1');
    const { call } = await serve(s);
    const stub = new DeterministicClient({ respond: (req) => goodDebrief(req) });
    // Slow enough that two HTTP requests overlap in flight.
    s.luna = { complete: async (req: CompleteInput) => { await new Promise((r) => setTimeout(r, 200)); return stub.complete(req); } } as unknown as GameService['luna'];

    // Live exercise: a commander cannot debrief yet.
    const early = await call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id });
    expect(early.status).toBe(409);
    expect(stub.history).toHaveLength(0);
    finish(s, ex.id);

    const [a, b] = await Promise.all([
      call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id }),
      call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id }),
    ]);
    expect(stub.history).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.json.record.receipt.id).toBe(b.json.record.receipt.id);
    expect(a.json.record.debrief.nextPractice[0].citations).toEqual(['C5']);
    expect(a.json.record.markdown).toMatch(/^# Debrief · order/);
    expect(a.json.record.hindsightIds).toContain(`${ev.id}:after`);
    expect(a.json.budget).toMatchObject({ maxUsd: 5, maxRequests: 100 });
    // The prompt sent carried the schema and only catalogue data.
    expect(stub.history[0].jsonSchema?.name).toBe('replay_debrief');
    expect(stub.history[0].purpose).toBe('participant debrief');

    const again = await call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('cached');
    expect(stub.history).toHaveLength(1);
    const cached = await call('GET', `/api/learning/debrief/${ev.id}`, session(alpha, ex.id));
    expect(cached.status).toBe(200);
    expect(cached.json).toMatchObject({ status: 'cached', stale: false });
    expect(cached.json.record.receipt.id).toBe(a.json.record.receipt.id);
    expect(s.store.events(ex.id).filter((e) => e.kind === 'debrief_generated')).toHaveLength(1);

    // An instructor may read the existing debrief but cannot generate as the learner.
    expect((await call('GET', `/api/learning/debrief/${ev.id}`, session(bravo, ex.id))).status).toBe(403);
    const instructorRead = await call('GET', `/api/learning/debrief/${ev.id}`, session({...bravo,role:'instructor'}, ex.id));
    expect(instructorRead.status).toBe(200);
    expect(instructorRead.json.record).toEqual(cached.json.record);
    expect((await call('POST', '/api/learning/debrief', session({ ...bravo, role: 'instructor' }, ex.id), { eventId: ev.id })).status).toBe(403);
    expect(stub.history).toHaveLength(1);

    // New evidence changes the hash: the cache is reported stale, and only an explicit request regenerates.
    s.store.event(ex.id, ev.tick + 1, 'decision_log', alpha.subject, 'late note', { commandId: ev.details.commandId, text: 'Wanted to press early.', timing: 'post-hoc', sourceIds: [] }, 'blue');
    const stale = await call('GET', `/api/learning/debrief/${ev.id}`, session(alpha, ex.id));
    expect(stale.json.stale).toBe(true);
    expect(stub.history).toHaveLength(1);
    const regen = await call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id });
    expect(regen.status).toBe(201);
    expect(stub.history).toHaveLength(2);
  });

  it('rejects a debrief with a hallucinated citation: 422, logged without the output, not cached, no paid retry', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'Bad debrief');
    const ev = order(s, ex.id, alpha, 35, 'bad-1');
    finish(s, ex.id);
    const stub = new DeterministicClient({ respond: (req) => { const d = goodDebrief(req); d.observations[0].citations = ['report-that-does-not-exist']; d.observations.push({ text: 'Later estimate was visible.', citations: [`${req.context!.commandEventId}:after`], basis: 'available-then' }); return d; } });
    s.luna = stub;
    const { call } = await serve(s);
    const r = await call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id });
    expect(r.status).toBe(422);
    expect(r.json.errors).toEqual(expect.arrayContaining([expect.stringMatching(/unknown citation "report-that-does-not-exist"/), expect.stringMatching(/cites hindsight but is labelled available-then/)]));
    expect(r.json.receiptId).toBe('synthetic-0');
    expect(r.json.record).toBeUndefined();
    expect(stub.history).toHaveLength(1);
    expect((await call('GET', `/api/learning/debrief/${ev.id}`, session(alpha, ex.id))).status).toBe(404);
    const logged = s.store.events(ex.id).find((e) => e.kind === 'debrief_rejected')!;
    expect(logged.details).toMatchObject({ commandEventId: ev.id, receiptId: 'synthetic-0' });
    expect(JSON.stringify(logged.details)).not.toContain('Later estimate was visible');
    expect(s.store.events(ex.id).some((e) => e.kind === 'debrief_generated')).toBe(false);
  });

  it('fails safely without a credential: no reservation, no receipt, a plain 503', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'No key');
    const ev = order(s, ex.id, alpha, 35, 'nokey-1');
    finish(s, ex.id);
    // Explicit empty credential: this test must never depend on the shell environment or reach the network.
    s.luna = new LunaClient({ apiKey: '', ledger: s.ledger, fetchImpl: () => { throw new Error('network must not be touched'); } });
    const { call } = await serve(s);
    const r = await call('POST', '/api/learning/debrief', session(alpha, ex.id), { eventId: ev.id });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ code: 'missing_credentials', receiptId: null });
    expect(r.json.error).toMatch(/no inference credential/);
    expect(r.text).not.toMatch(/sk-|Bearer/);
    expect(s.ledger.summary().requestsUsed).toBe(0);
    expect((await call('GET', `/api/learning/debrief/${ev.id}`, session(alpha, ex.id))).status).toBe(404);
    expect(s.store.events(ex.id).find((e) => e.kind === 'debrief_unavailable')?.details.code).toBe('missing_credentials');
  });
});

describe('read-only and inaccessible attempts', () => {
  it('requires native can_edit for writes under Kamiwaza identity and ignores anything the browser claims', async () => {
    const s = service();
    const ex = await attributed(s, alpha, 'Native');
    ex.options.workroomId='native-test-room';s.store.putExercise(ex);
    const ev = order(s, ex.id, alpha, 30, 'nat-1');
    const { call } = await serve(s,async()=>({identity:{...alpha,mode:'kamiwaza'},context:{workroomId:'native-test-room',fresh:true,canEdit:true,canRunAgents:true},nativeReceipts:[]}));
    const nativeAlpha: Identity = { ...alpha, mode: 'kamiwaza' };
    const readOnly = { identity: { subject: alpha.subject }, context: { canEdit: false, readOnlyReason: 'workroom archived' } };
    const writable = { identity: { subject: alpha.subject }, context: { canEdit: true } };
    const body = { eventId: ev.id, text: 'Post-hoc note.', sourceIds: [] };

    expect((await call('GET', '/api/learning/dossier', session(nativeAlpha, ex.id), undefined, readOnly)).status).toBe(200);
    const denied = await call('POST', '/api/learning/decision-log', session(nativeAlpha, ex.id), body, readOnly);
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatch(/does not permit writes \(workroom archived\)/);
    // No native context at all under kamiwaza identity: denied, even if the body asserts a role.
    expect((await call('POST', '/api/learning/decision-log', session(nativeAlpha, ex.id), { ...body, role: 'instructor', canEdit: true })).status).toBe(403);
    // Native subject differs from the session subject: denied on reads and writes.
    expect((await call('GET', '/api/learning/dossier', session(nativeAlpha, ex.id), undefined, { ...writable, identity: { subject: 'someone-else' } })).status).toBe(403);
    expect(s.store.events(ex.id).filter((e) => e.kind === 'decision_log')).toHaveLength(0);

    const ok = await call('POST', '/api/learning/decision-log', session(nativeAlpha, ex.id), body, writable);
    expect(ok.status).toBe(201);
    expect(s.store.events(ex.id).filter((e) => e.kind === 'decision_log')).toHaveLength(1);
    // Paid debrief is a write too.
    finish(s, ex.id);
    s.luna = new DeterministicClient({ respond: (req) => goodDebrief(req) });
    expect((await call('POST', '/api/learning/debrief', session(nativeAlpha, ex.id), { eventId: ev.id }, readOnly)).status).toBe(403);
    expect((s.luna as DeterministicClient).history).toHaveLength(0);
    expect((await call('POST', '/api/learning/debrief', session(nativeAlpha, ex.id), { eventId: ev.id }, writable)).status).toBe(201);
  });

  it('answers 401 without a session and 404 for orders outside the active exercise', async () => {
    const s = service();
    const a = await attributed(s, alpha, 'A');
    const b = await attributed(s, alpha, 'B');
    const ev = order(s, a.id, alpha, 30, 'a-1');
    const { call } = await serve(s);
    const noSession = await fetch(`http://127.0.0.1:${(servers[0] as any).address().port}/api/learning/dossier`);
    expect(noSession.status).toBe(401);
    expect((await call('GET', `/api/learning/debrief/${ev.id}`, session(alpha, b.id))).status).toBe(404);
    expect((await call('POST', '/api/learning/decision-log', session(alpha, b.id), { eventId: ev.id, text: 'wrong exercise' })).status).toBe(404);
  });
});


describe('prepared review HTTP workflows',()=>{
 it('retrieves a selected source path, imports an original and explicit revision, and exports durable source bytes without model calls',async()=>{
  const s=service(),a=await s.prepareShowcase(alpha,null),who=session(alpha,a.exerciseId),client=new DeterministicClient();s.luna=client;
  const {call}=await serve(s);const before=await call('GET','/api/learning/retrieval/'+encodeURIComponent(a.selectedEventId),who);expect(before.status).toBe(200);expect(before.json.modelInvoked).toBe(false);
  const note=(id:string,text:string,revisionOf?:string)=>JSON.stringify({schema:'replay.facilitator-notes/1',records:[{id,commandEventId:a.selectedEventId,observedTick:a.reviewTick,text,revisionOf}]});
  const original=note('http-note-1','Review source independence before treating a repeat as corroboration.');
  const first=await call('POST','/api/learning/intake',who,{exerciseId:a.exerciseId,filename:'review.json',text:original});expect(first.status).toBe(201);expect(first.json.accepted).toHaveLength(1);
  expect((await call('GET','/api/learning/intake/'+first.json.sha256,who)).json.rawText).toBe(original);
  const revision=note('http-note-2','Correction: retain uncertainty and discuss a smaller legal commitment.','http-note-1');
  expect((await call('POST','/api/learning/intake',who,{exerciseId:a.exerciseId,filename:'revision.json',text:revision})).status).toBe(201);
  const after=await call('GET','/api/learning/retrieval/'+encodeURIComponent(a.selectedEventId),who);expect(after.json.retrieval.graphSha256).not.toBe(before.json.retrieval.graphSha256);expect(after.json.retrieval.nodes.filter((n:any)=>n.type==='facilitator-note').every((n:any)=>n.availability==='hindsight')).toBe(true);
  const {exportAssessment}=await import('../../src/review/assessment');const exported=exportAssessment(s,who);expect(exported.payload.importedSources).toHaveLength(2);expect(exported.payload.importedSources.some((r:any)=>r.rawText===original)).toBe(true);expect(client.history).toHaveLength(0);
  const another=await s.prepareShowcase(bravo,null);expect((await call('GET','/api/learning/intake/'+first.json.sha256,session(bravo,another.exerciseId))).status).toBe(404);
  expect((await call('POST','/api/learning/intake',session({...alpha,mode:'kamiwaza'},a.exerciseId),{exerciseId:a.exerciseId,filename:'review.json',text:original},{context:{canEdit:false}})).status).toBe(403);
 });
 it('retains exactly the graph-selected snippets that the deterministic model double actually receives',async()=>{
  const s=service(),row=await attributed(s,alpha,'Trace contract'),event=order(s,row.id,alpha,30,'trace-contract',{rationale:'Preserve reserve while checking evidence.'});finish(s,row.id);
  const client=new DeterministicClient({respond:goodDebrief});s.luna=client;const {call}=await serve(s),r=await call('POST','/api/learning/debrief',session(alpha,row.id),{eventId:event.id});expect(r.status).toBe(201);expect(client.history).toHaveLength(1);
  const sent=JSON.parse(client.history[0].input);expect(r.json.record.retrieval.graphSha256).toBe(sent.graphSha256);expect(r.json.record.sentReferenceIds).toEqual(sent.references.map((x:any)=>x.id));expect(r.json.record.retrieval.excerpts.map((x:any)=>({id:x.id,text:x.text}))).toEqual(sent.references.map((x:any)=>({id:x.id,text:x.content})));
 });
});
