import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {GameService, ServiceError, type Identity, type Session} from '../../src/server/service';
import {createApp} from '../../src/server/native-http';
import {mountAgentRoutes} from '../../src/server/agent-routes';
import {DeterministicClient, type CompleteInput} from '../../src/inference';
import {MODEL_DEBOUNCE_TICKS, type MaterialEvent, type WatchTask} from '../../src/agents/staff';

console.debug = () => {};
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of clean.splice(0).reverse()) await close();});
const identity: Identity = {subject: 'watch-learner', name: 'Learner', organization: 'Synthetic', mode: 'local-demo', role: 'commander'};
const manual: MaterialEvent = {newReports: [], superseded: [], delta: null, reasons: ['Local test request']};

async function fixture(objectives = false, settleTicks = 25) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-objective-watches-'));
  clean.push(() => fs.rmSync(dir, {recursive: true, force: true}));
  let s = new GameService(dir);
  clean.push(() => s.close());
  const row = await s.create('Watch fixture', 'plains', identity, objectives ? 'crosscurrent-objectives/1' : undefined);
  for (let i = 0; i < settleTicks; i++) s.tick(s.world(row.id));
  const session: Session = {identity, activeId: row.id, playbackTick: null, selectedSide: 'blue'};
  const inference = vi.fn(async () => {throw new Error('Unexpected inference in free-watch test');});
  s.luna = {complete: inference};
  const f = {
    get s() {return s;}, get w() {return s.world(row.id);}, row, session, inference,
    create: (title: string) => s.createTask(row.id, identity, title, 'blue'),
    updates: (taskId?: string) => s.store.events(row.id).filter(e => e.kind === 'staff_update' && (!taskId || e.details.taskId === taskId)),
    task: (id: string) => s.store.tasks(row.id).find(task => task.id === id) as WatchTask,
    async restart() {s.close(); s = new GameService(dir); s.luna = {complete: inference}; await s.init(false);},
  };
  return f;
}

async function serve(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  f.s.store.putSession(id, f.session);
  const app = createApp({service: f.s, config: {mode: 'local-demo', allowedOrigins: [], cookieSecure: false}, mount: app => mountAgentRoutes(app, f.s)});
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  clean.push(() => new Promise<void>((resolve, reject) => {server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();}));
  const request = async (url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, {method: body === undefined ? 'GET' : 'POST', headers: {Cookie: `replay_session=${id}`, 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json()};
  };
  return {request};
}

describe('durable configured free watches', () => {
  it('records an actual 90% commitment crossing on the next tick and recovery before tick 100 without source scans', async () => {
    const f = await fixture(true, 6);
    const at = f.w.engine.game.ticks(), available = f.w.engine.player('blue').troops();
    expect(at).toBe(7);
    const threshold = Math.floor(available * .8);
    const task = f.create(`Watch available forces below ${threshold}`);
    f.create('Monitor report provenance'); // A source watch must not make the fast pass scan reports.
    f.create('Watch objective changes');
    const readReports = vi.spyOn(f.s.store, 'reports');
    f.s.command(f.row.id, 'blue', {type: 'attack', targetID: null, troops: Math.floor(available * .9)}, 'fast-reserve-crossing', identity);
    f.s.tick(f.w); // No explicit processTasks call: exercise the actual production tick seam.
    expect(f.w.engine.player('blue').troops()).toBeLessThan(threshold);
    expect(f.updates(task.id)).toHaveLength(1);
    expect(f.updates(task.id)[0]).toMatchObject({tick: at + 1, summary: expect.stringContaining(`below ${threshold} forces`), details: {observedTick: at + 1, method: 'deterministic objective watcher', watchConfig: {evaluationEveryTicks: 1}}});
    while (f.w.engine.game.ticks() < 99 && f.w.engine.player('blue').troops() < threshold) f.s.tick(f.w);
    expect(f.w.row.status).toBe('running');
    expect(f.w.engine.player('blue').troops()).toBeGreaterThanOrEqual(threshold);
    expect(f.updates(task.id)).toHaveLength(2);
    expect(f.updates(task.id)[1]).toMatchObject({tick: f.w.engine.game.ticks(), summary: expect.stringContaining(`at or above ${threshold} forces`)});
    expect(f.updates(task.id)[1].tick).toBeLessThan(100);
    expect(readReports).not.toHaveBeenCalled();
    f.s.processTasks(f.row.id, true);
    expect(f.updates(task.id)).toHaveLength(2); // Same-tick fast passes cannot repeat an accepted alert.
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('retains old missing/explicit slow cadence through fast passes, restart and historical creation config', async () => {
    const f = await fixture(false, 6);
    vi.spyOn(f.s, 'baseline').mockImplementation(() => {});
    const tick = f.w.engine.game.ticks(), threshold = Math.floor(f.w.engine.player('blue').troops() * .8);
    const prototype = f.create(`Watch available forces below ${threshold}`);
    const {evaluationEveryTicks: _cadence, ...oldConfig} = prototype.watchConfig!;
    const interpretation = 'Checked every 100 simulation ticks and on report release; changes between checks may be missed.';
    const old = {...prototype, id: 'pre-0121', watchConfig: oldConfig, interpretation};
    const slow = {...prototype, id: 'explicit-slow', watchConfig: {...oldConfig, evaluationEveryTicks: 100 as const}, interpretation};
    const {watchConfig: _config, watchState: _state, interpretation: _text, ...legacyBase} = old;
    const legacy = {...legacyBase, id: 'pre-config', seenReportIds: f.s.store.reports(f.row.id).filter(r => r.side === 'blue').map(r => r.id)};
    for (const row of [old, slow, legacy]) {
      f.s.store.putTask(f.row.id, row);
      f.s.store.event(f.row.id, tick, 'task_created', identity.subject, 'Preserved old fixture', {taskId: row.id, ...('watchConfig' in row ? {watchConfig: row.watchConfig, interpretation} : {})}, 'blue');
    }
    f.s.command(f.row.id, 'blue', {type: 'attack', targetID: null, troops: Math.floor(f.w.engine.player('blue').troops() * .9)}, 'old-cadence-order', identity);
    f.s.tick(f.w);
    expect(f.updates(prototype.id)).toHaveLength(1);
    for (const id of [old.id, slow.id, legacy.id]) expect(f.updates(id)).toHaveLength(0);
    await f.restart();
    vi.spyOn(f.s, 'baseline').mockImplementation(() => {});
    expect(f.task(old.id).watchConfig).toEqual(oldConfig);
    expect(f.task(old.id).interpretation).toBe(interpretation);
    expect(f.task(slow.id).watchConfig?.evaluationEveryTicks).toBe(100);
    expect(f.task(legacy.id)).not.toHaveProperty('watchConfig');
    const history = await f.s.overview({...f.session, playbackTick: tick});
    const oldView = history.tasks.find(t => t.id === old.id)!;
    expect(oldView.watchConfig).toEqual(oldConfig);
    expect(oldView.interpretation).toBe(interpretation);
    expect(oldView.watchState).toBeUndefined();
    f.s.store.putReport(f.row.id, {id: 'pending-legacy-source', tick: f.w.engine.game.ticks(), side: 'blue', title: 'New source awaiting the legacy cadence'});
    while (f.w.engine.game.ticks() < 99) f.s.tick(f.w);
    for (const id of [old.id, slow.id, legacy.id]) expect(f.updates(id)).toHaveLength(0);
    // Controlled before-tick setup leaves the reserve below threshold at the actual slow evaluation.
    f.w.engine.player('blue').removeTroops(f.w.engine.player('blue').troops());
    f.s.tick(f.w);
    expect(f.w.engine.game.ticks()).toBe(100);
    for (const id of [old.id, slow.id]) expect(f.updates(id)).toMatchObject([{tick: 100, details: {method: 'deterministic objective watcher'}}]);
    expect(f.updates(legacy.id)).toMatchObject([{tick: 100, details: {method: 'deterministic provenance watcher', sourceIds: ['pending-legacy-source']}}]);
    expect(f.task(old.id).watchConfig).toEqual(oldConfig);
    expect(f.task(slow.id).watchConfig?.evaluationEveryTicks).toBe(100);
    expect(f.task(legacy.id)).not.toHaveProperty('watchConfig');
    expect(f.inference).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports only while the world remains live after 120 ticks (hold opposing controller: %s)', async holdController => {
    const f = await fixture(); const task = f.create('Monitor report provenance');
    if (holdController) vi.spyOn(f.s, 'baseline').mockImplementation(() => {});
    for (let i = 0; i < 120; i++) f.s.tick(f.w);
    expect(f.w.row.status).toBe(holdController ? 'running' : 'completed');
    expect(f.w.engine.player('blue').isAlive()).toBe(holdController);
    expect(f.updates(task.id)).toHaveLength(0);
    f.s.injectReport(f.row.id);
    expect(f.updates(task.id)).toHaveLength(holdController ? 1 : 0);
  });

  it('returns actionable unsupported feedback through both real creation and staff HTTP routes without writes or inference', async () => {
    const f = await fixture(); const {request} = await serve(f);
    const before = f.s.store.db.prepare('SELECT total_changes() AS n').get();
    for (const [url, body] of [['/api/tasks', {title: 'Watch everything and recommend attacks', side: 'blue'}], ['/api/staff', {message: 'Notify me when the enemy is vulnerable', side: 'blue'}]] as const) {
      const response = await request(url, body);
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({code: 'unsupported_watch', examples: expect.arrayContaining(['Watch reserves below 30%', 'Monitor report provenance'])});
      expect(response.body.error).toContain('Free watches do not interpret arbitrary objectives');
    }
    expect(f.s.store.tasks(f.row.id)).toHaveLength(0);
    expect(f.s.store.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('persists the immutable interpretation in creation evidence and immediately returns it in staff chat', async () => {
    const f = await fixture(); const {request} = await serve(f);
    const response = await request('/api/tasks', {title: 'Watch reserves', side: 'blue'});
    expect(response.status).toBe(201);
    const task = response.body;
    expect(task).toMatchObject({modelEnabled: false, lastResult: null, interpretation: expect.stringContaining('Default threshold: 30%'), watchConfig: {schema: 'replay.watch-config/1', kind: 'reserve', defaultThreshold: true}});
    const created = f.s.store.events(f.row.id).find(e => e.kind === 'task_created' && e.details.taskId === task.id)!;
    expect(created.details).toMatchObject({watchConfig: task.watchConfig, interpretation: task.interpretation});
    expect(created.details.watchState).toBeUndefined();
    expect(f.updates()).toHaveLength(0);
    const reply = await request('/api/staff', {message: 'Alert me when our reserves fall below 25%', side: 'blue'});
    expect(reply.status).toBe(200);
    expect(reply.body.text).toContain('Threshold: 25% of current own force capacity');
    expect(reply.body.watchConfig.threshold.value).toBe(.25);
    expect(reply.body.text).toContain('paid analysis is off');
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('survives real order execution and restart without duplicate alerts or changing engine history', async () => {
    const f = await fixture();
    const threshold = Math.floor(f.w.engine.player('blue').troops() * .8);
    const task = f.create(`Watch available forces below ${threshold}`);
    f.s.command(f.row.id, 'blue', {type: 'attack', targetID: null, troops: Math.floor(f.w.engine.player('blue').troops() * .9)}, 'reserve-crossing', identity);
    for (let i = 0; i < 10 && f.w.engine.player('blue').troops() >= threshold; i++) f.s.tick(f.w);
    expect(f.w.engine.player('blue').troops()).toBeLessThan(threshold);
    const record = f.s.record(f.row.id), fingerprint = f.w.engine.state().fingerprint;
    f.s.processTasks(f.row.id);
    expect(f.updates(task.id)).toHaveLength(1);
    expect(f.updates(task.id)[0].details).toMatchObject({method: 'deterministic objective watcher', sourceIds: [], observedTick: f.w.engine.game.ticks()});
    const saved = structuredClone(f.task(task.id));
    expect(saved.watchState).toMatchObject({kind: 'reserve', below: true});
    await f.restart();
    f.s.processTasks(f.row.id);
    expect(f.task(task.id)).toEqual(saved);
    expect(f.updates(task.id)).toHaveLength(1);
    expect(f.w.engine.state().fingerprint).toBe(fingerprint);
    expect(f.s.record(f.row.id)).toEqual(record);
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('retains report provenance method, source isolation and source cutoff across restart', async () => {
    const f = await fixture(); const task = f.create('Watch supersession');
    const atCreation = f.w.engine.game.ticks();
    f.s.store.putReport(f.row.id, {id: 'future-private', side: 'red', tick: atCreation + 500, title: 'Opposing future'});
    f.s.tick(f.w); f.s.injectReport(f.row.id);
    const updated = f.task(task.id), event = f.updates(task.id)[0];
    expect(event.details.method).toBe('deterministic provenance watcher');
    const own = new Set(f.s.store.reports(f.row.id, event.tick).filter(r => r.side === 'blue').map(r => r.id));
    expect(updated.sourceIds.length).toBeGreaterThan(0);
    expect(updated.sourceIds.every(id => own.has(id))).toBe(true);
    const historical = await f.s.overview({...f.session, playbackTick: atCreation});
    const before = historical.tasks.find(t => t.id === task.id)!;
    expect(before.lastResult).toBeNull(); expect(before.sourceIds).toEqual([]);
    expect(before.watchState).toBeUndefined();
    await f.restart(); f.s.processTasks(f.row.id);
    expect(f.updates(task.id)).toHaveLength(1);
    expect(f.task(task.id).seenReportIds).toEqual(updated.seenReportIds);
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('evaluates station control on the actual objective board and does not react to report injections', async () => {
    const f = await fixture(true);
    const task = f.create('Watch objective changes');
    f.s.injectReport(f.row.id);
    expect(f.updates(task.id)).toHaveLength(0);
    const board = f.s.agentContext(f.w, 'blue', 'staff').objectives!()!;
    const target = board.stations.find(station => station.controller !== 'blue')!;
    const station = f.w.campaign!.layout.find(station => station.id === target.id)!;
    for (const tile of station.tiles) f.w.engine.player('blue').conquer(tile);
    f.s.processTasks(f.row.id);
    expect(f.updates(task.id)).toHaveLength(1);
    expect(f.updates(task.id)[0]).toMatchObject({summary: expect.stringContaining(`${target.id}: ${target.controller ?? 'uncontrolled'} → blue`), details: {method: 'deterministic objective watcher', sourceIds: []}});
    f.s.processTasks(f.row.id);
    expect(f.updates(task.id)).toHaveLength(1);
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('preserves legacy rows without interpreting their reserve-looking titles, including restart', async () => {
    const f = await fixture();
    const tick = f.w.engine.game.ticks(), state = f.w.engine.state(), opponent = state.players.find(p => p.side === 'red')!;
    const legacy = {id: 'legacy', title: 'Watch reserves below 999999', objective: 'Watch reserves below 999999', owner: identity.subject, side: 'blue', status: 'waiting', phase: 'monitoring', kind: 'provenance-watch', createdTick: tick, cursor: tick, modelEnabled: false,
      seenReportIds: f.s.store.reports(f.row.id).filter(r => r.side === 'blue').map(r => r.id), baseline: {tick, opponentTiles: opponent.tiles, opponentTroops: opponent.troops}};
    f.s.store.putTask(f.row.id, legacy);
    await f.restart();
    f.s.processTasks(f.row.id);
    expect(f.updates('legacy')).toHaveLength(0);
    expect(f.task('legacy')).not.toHaveProperty('watchConfig');
    f.s.injectReport(f.row.id);
    expect(f.updates('legacy')[0].details.method).toBe('deterministic provenance watcher');
    expect(f.updates('legacy')[0].summary).toContain('supersedes');
    expect(f.task('legacy')).not.toHaveProperty('watchConfig');
    expect(f.task('legacy')).not.toHaveProperty('watchState');
  });

  it('does not evaluate cancelled tasks, create in completed worlds, or enable paid work in frozen views', async () => {
    const f = await fixture(); const task = f.create('Monitor report provenance');
    const cancelled = {...task, status: 'cancelled'}; f.s.store.putTask(f.row.id, cancelled);
    f.s.injectReport(f.row.id); expect(f.updates(task.id)).toHaveLength(0);
    const active = f.create('Watch reserves');
    expect(() => f.s.setTaskModel({...f.session, playbackTick: 1}, active.id, true)).toThrow(/live exercise view/);
    await expect(f.s.staff({...f.session, playbackTick: 1}, 'Watch reserves', 'blue')).rejects.toThrow(/live exercise/);
    await expect(f.s.staff(f.session, 'Watch reserves', 'red')).rejects.toMatchObject({status: 403});
    f.w.row.status = 'completed'; f.s.store.putExercise(f.w.row);
    expect(() => f.create('Watch reserves')).toThrow(ServiceError);
    expect(f.inference).not.toHaveBeenCalled();
  });

  it('preserves explicit opt-in, native authority, debounce and restart pause for model work', async () => {
    const f = await fixture(); const task = f.create('Monitor report provenance');
    await f.s.runStaffAnalysis(f.row.id, task.id, manual);
    expect(f.inference).not.toHaveBeenCalled();
    f.w.row.options.workroomId = 'native-fixture'; f.s.store.putExercise(f.w.row);
    const enabled = {...task, modelEnabled: true}; f.s.store.putTask(f.row.id, enabled);
    await f.s.runStaffAnalysis(f.row.id, task.id, manual);
    expect(f.inference).not.toHaveBeenCalled();
    expect(f.task(task.id).modelEnabled).toBe(false);
    const pulse = vi.spyOn(f.s, 'runStaffAnalysis').mockResolvedValue(undefined);
    f.s.store.putTask(f.row.id, {...f.task(task.id), modelEnabled: true, lastModelTick: f.w.engine.game.ticks()});
    f.s.injectReport(f.row.id); expect(pulse).not.toHaveBeenCalled();
    f.s.store.putTask(f.row.id, {...f.task(task.id), lastModelTick: f.w.engine.game.ticks() - MODEL_DEBOUNCE_TICKS});
    f.s.injectReport(f.row.id); expect(pulse).toHaveBeenCalledOnce();
    await f.restart();
    expect(f.task(task.id).modelEnabled).toBe(false);
    expect(f.s.store.events(f.row.id).some(e => e.kind === 'task_model_changed' && e.actor === 'system')).toBe(true);
  });

  it('merges a deferred local model result into the current baseline without pausing engine progress', async () => {
    const f = await fixture();
    const threshold = Math.floor(f.w.engine.player('blue').troops() * .8), task = f.create(`Watch available forces below ${threshold}`);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;}), entered = new Promise<void>(resolve => {started = resolve;});
    const stub = new DeterministicClient({respond: () => ({summary: 'Local fixture response based on the earlier observation.', sourceIds: [], done: true, calls: []})});
    f.s.luna = {complete: async <T = unknown>(input: CompleteInput) => {started(); await gate; return stub.complete<T>(input);}};
    f.s.store.putTask(f.row.id, {...task, modelEnabled: true});
    const pending = f.s.runStaffAnalysis(f.row.id, task.id, manual);
    await entered;
    const observedTick = f.w.engine.game.ticks();
    f.s.command(f.row.id, 'blue', {type: 'attack', targetID: null, troops: Math.floor(f.w.engine.player('blue').troops() * .9)}, 'deferred-crossing', identity);
    for (let i = 0; i < 10 && f.w.engine.player('blue').troops() >= threshold; i++) f.s.tick(f.w);
    f.s.processTasks(f.row.id);
    expect(f.w.engine.game.ticks()).toBeGreaterThan(observedTick);
    const latest = structuredClone(f.task(task.id));
    expect(latest.watchState).toMatchObject({below: true});
    release(); await pending;
    expect(f.task(task.id).watchState).toEqual(latest.watchState);
    expect(f.task(task.id).cursor).toBe(latest.cursor);
    expect(f.task(task.id).lastObservedTick).toBe(observedTick);
    expect(f.task(task.id).lastMethod).toBe('model staff agent');
    const count = f.updates(task.id).length; f.s.processTasks(f.row.id);
    expect(f.updates(task.id)).toHaveLength(count);
    expect(stub.history).toHaveLength(1); expect(f.s.ledger.summary().requestsUsed).toBe(0);
  });
});
