import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { GameService, type Identity, type Session } from '../../src/server/service';
import { mountAgentRoutes } from '../../src/server/agent-routes';
import { DeterministicClient, InferenceError, type CompleteInput, type CompleteResult } from '../../src/inference/index';
import { MODEL_DEBOUNCE_TICKS } from '../../src/agents/index';

console.debug = () => {};
const alpha: Identity = { subject: 'user-alpha', name: 'Alpha', role: 'commander', organization: 'NPS training workspace', mode: 'local-demo' };
const bravo: Identity = { subject: 'user-bravo', name: 'Bravo', role: 'commander', organization: 'NPS training workspace', mode: 'local-demo' };
const instructor: Identity = { ...alpha, subject: 'user-instructor', role: 'instructor' };

const dirs: string[] = [];
const services: GameService[] = [];
const servers: { close: () => void }[] = [];
afterEach(() => { for (const srv of servers.splice(0)) srv.close(); for (const s of services.splice(0)) s.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function service(dir?: string) { const d = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'replay-agent-routes-')); if (!dir) dirs.push(d); const s = new GameService(d); services.push(s); return s; }
function close(s: GameService) { s.close(); services.splice(services.indexOf(s), 1); }
async function running(s: GameService, identity = alpha) { const row = await s.create('Agents', 'plains', identity); const w = s.world(row.id); for (let i = 0; i < 25; i++) s.tick(w); return { row, w }; }
function session(identity: Identity, activeId: string, extra: Partial<Session> = {}): Session { return { identity, activeId, playbackTick: null, selectedSide: 'blue', ...extra }; }

/** Test harness: session and native context come from headers here; production sets them server-side. */
async function serve(s: GameService) {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { const raw = req.headers['x-test-session']; if (typeof raw === 'string') res.locals.session = JSON.parse(raw); const native = req.headers['x-test-native']; if (typeof native === 'string') res.locals.native = JSON.parse(native); next(); });
  mountAgentRoutes(app, s);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((r) => server.once('listening', r)); servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, sess: Session | null, body?: unknown, native?: unknown) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(sess ? { 'x-test-session': JSON.stringify(sess) } : {}), ...(native ? { 'x-test-native': JSON.stringify(native) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, json, text };
  };
  return { call };
}
const decision = (calls: { tool: string; arguments: unknown }[], extra: Partial<{ summary: string; sourceIds: string[]; done: boolean }> = {}) =>
  ({ summary: extra.summary ?? 'external summary', sourceIds: extra.sourceIds ?? [], done: extra.done ?? false, calls: calls.map((c) => ({ tool: c.tool, arguments: JSON.stringify(c.arguments) })) });

describe('tool catalog route', () => {
  it('is scoped to the caller\'s side and seat, lists unavailable capabilities and never a paid model by default', async () => {
    const s = service(); const { row } = await running(s); const { call } = await serve(s);
    expect((await call('GET', '/api/agents/tools', null)).status).toBe(401);
    const mine = await call('GET', '/api/agents/tools', session(alpha, row.id));
    expect(mine.status).toBe(200);
    expect(mine.json).toMatchObject({ side: 'blue', scope: 'player', opponent: { enabled: false, model: 'deterministic baseline' }, pulseBudget: { maxSteps: 4, maxCompletions: 2 }, budget: { maxUsd: 5, maxRequests: 100, requestsUsed: 0 } });
    expect(mine.json.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['list_legal_actions', 'inspect_tile', 'submit_order']));
    expect(mine.json.unavailable).toEqual(expect.arrayContaining(['code execution', 'shell access', 'network access']));
    expect(mine.json.staffTools).not.toContain('submit_order');
    expect(['reserve-aware', 'expansion-focused', 'opportunistic']).toContain(mine.json.opponent.playstyle);
    // Intelligence seat gets read-only tools only.
    const intel = await call('GET', '/api/agents/tools', session({ ...alpha, role: 'intelligence' }, row.id));
    expect(intel.json.scope).toBe('staff');
    expect(intel.json.tools.every((t: any) => t.kind === 'query')).toBe(true);
    // Opposing side: denied to the commander, allowed to the instructor.
    expect((await call('GET', '/api/agents/tools?side=red', session(alpha, row.id))).status).toBe(403);
    expect((await call('GET', '/api/agents/tools?side=red', session(instructor, row.id))).json.side).toBe('red');
    expect((await call('GET', '/api/agents/tools?side=green', session(alpha, row.id))).status).toBe(400);
  });
});

describe('objective-driven watches', () => {
  it('creates a durable watch with objective and phase, makes no paid call by default, and reports only material events', async () => {
    const s = service(); const { row, w } = await running(s);
    const stub = new DeterministicClient({ respond: () => decision([]) }); s.luna = stub;
    const reply = await s.staff(session(alpha, row.id), 'Monitor report provenance', 'blue');
    expect(reply.taskId).toBeDefined();
    expect(reply.text).toMatch(/Free deterministic monitoring/);
    const task = s.store.tasks(row.id)[0];
    expect(task).toMatchObject({ objective: 'Monitor report provenance', side: 'blue', owner: alpha.subject, kind: 'provenance-watch', phase: 'baseline', modelEnabled: false, lastMethod: null, lastReceiptId: null });
    expect(task.watchConfig).toMatchObject({schema:'replay.watch-config/1',kind:'report-provenance',mode:'all-reports'});
    // A report watch stays quiet through ordinary public-map/resource changes.
    // This fixture's unattended Blue loses to the baseline by120ticks. Hold that
    // controller for this watch-specific check; terminal silence has a separate regression.
    const baseline=vi.spyOn(s,'baseline').mockImplementation(()=>{});
    try{for (let i = 0; i < 120; i++) s.tick(w);}finally{baseline.mockRestore();}
    expect(w.row.status).toBe('running');
    const early = s.store.events(row.id).filter((e) => e.kind === 'staff_update');
    expect(early).toHaveLength(0);
    s.injectReport(row.id);
    const updates = s.store.events(row.id).filter((e) => e.kind === 'staff_update');
    expect(updates).toHaveLength(early.length + 1);
    expect(updates.at(-1)!.details).toMatchObject({ taskId: task.id, method: 'deterministic provenance watcher', phase: 'monitoring' });
    expect(updates.at(-1)!.details.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/supersedes/)]));
    const after = s.store.tasks(row.id)[0];
    expect(after.sourceIds).toHaveLength(2);
    expect(after.lastResult).toMatch(/supersedes/);
    expect(after.lastResult).toMatch(/Sources describe their own observation ticks/);
    expect(after.lastObservedTick).toBe(w.engine.game.ticks());
    expect(after.phase).toBe('monitoring');
    // Every cited source is a real blue report; nothing from red.
    const blue = new Set(s.store.reports(row.id).filter((r) => r.side === 'blue').map((r) => r.id));
    for (const id of after.sourceIds) expect(blue.has(id)).toBe(true);
    expect(stub.history).toHaveLength(0);
    expect(s.ledger.summary().requestsUsed).toBe(0);
    expect(s.store.exercise(row.id)!.options.assistance).toBe('unassisted');
  });

  it('survives a restart with its cursor: no duplicate updates, paid analysis paused until re-enabled', async () => {
    let s = service(); const { row, w } = await running(s);
    s.luna = new DeterministicClient({ respond: () => decision([], { done: true, summary: 'Nothing new beyond the released estimate.' }) });
    const task = s.createTask(row.id, alpha, 'Watch supersession', 'blue');
    s.injectReport(row.id);
    s.setTaskModel(session(alpha, row.id), task.id, true);
    expect(s.store.tasks(row.id)[0].modelEnabled).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.store.tasks(row.id)[0].lastMethod).toBe('model staff agent');
    const updates = s.store.events(row.id).filter((e) => e.kind === 'staff_update').length;
    const dir = s.dataDir; close(s); s = service(dir); await s.init(false);
    const restored = s.store.tasks(row.id)[0];
    expect(restored).toMatchObject({ id: task.id, objective: 'Watch supersession', phase: 'monitoring', modelEnabled: false, kind: 'provenance-watch' });
    expect(restored.seenReportIds.length).toBeGreaterThan(0);
    s.processTasks(row.id);
    expect(s.store.events(row.id).filter((e) => e.kind === 'staff_update')).toHaveLength(updates);
    expect(s.store.events(row.id).find((e) => e.kind === 'task_model_changed' && e.actor === 'system')?.summary).toMatch(/paused by restart/);
    s.injectReport(row.id);
    expect(s.store.events(row.id).filter((e) => e.kind === 'staff_update')).toHaveLength(updates + 1);
    expect(s.world(row.id).engine.game.ticks()).toBe(w.engine.game.ticks());
  });

  it('runs bounded paid analysis only after explicit opt-in, cites only real context, and rejects hallucinated sources', async () => {
    const s = service(); const { row, w } = await running(s); const { call } = await serve(s);
    const task = s.createTask(row.id, alpha, 'Monitor report provenance', 'blue');
    let mode: 'good' | 'bad' = 'good';
    const stub = new DeterministicClient({ respond: (req: CompleteInput, i) => {
      const input = JSON.parse(req.input);
      if (i % 2 === 0) return decision([{ tool: 'search_reports', arguments: {} }]);
      const ids = input.priorResults[0].results[0].output.reports.map((r: any) => r.id);
      return mode === 'good' ? decision([], { summary: 'The opposing estimate is unchanged since release.', sourceIds: [ids[0]], done: true }) : decision([], { summary: 'Per a classified national dossier the enemy will attack.', sourceIds: ['report-that-does-not-exist'], done: true });
    } });
    s.luna = stub;
    expect((await call('POST', `/api/agents/tasks/${task.id}/model`, session(bravo, row.id), { enabled: true })).status).toBe(403);
    expect((await call('POST', `/api/agents/tasks/${task.id}/model`, session({ ...alpha, role: 'intelligence' }, row.id), { enabled: true })).status).toBe(200);
    // Enabling runs one bounded pulse now (2 completions, 1 tool step) and marks the attempt staff-assisted once delivered.
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.history).toHaveLength(2);
    expect(stub.history[0].purpose).toBe('staff watch analysis');
    expect(stub.history[0].instructions).toMatch(/Task objective: Monitor report provenance/);
    const t1 = s.store.tasks(row.id)[0];
    expect(t1).toMatchObject({ modelEnabled: true, kind: 'model-staff-agent', lastMethod: 'model staff agent', lastReceiptId: 'synthetic-1', lastResult: 'The opposing estimate is unchanged since release.' });
    expect(t1.sourceIds).toEqual([s.store.reports(row.id).find((r) => r.side === 'blue')!.id]);
    expect(s.store.exercise(row.id)!.options.assistance).toBe('staff-assisted');
    const trace = await call('GET', `/api/agents/tasks/${task.id}`, session(alpha, row.id));
    expect(trace.json.trace.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['task_created', 'task_model_changed', 'staff_model_decision', 'staff_tool_result', 'staff_update']));
    expect(trace.json.trace.find((e: any) => e.kind === 'staff_update').receiptId).toBe('synthetic-1');
    expect((await call('GET', `/api/agents/tasks/${task.id}`, session(bravo, row.id))).status).toBe(200);
    // Debounce: a material event soon after does not spend again; once the window has elapsed it does.
    s.injectReport(row.id); await new Promise((r) => setTimeout(r, 20));
    expect(stub.history).toHaveLength(2);
    expect(s.store.tasks(row.id)[0].lastMethod).toBe('deterministic provenance watcher');
    const aged = s.store.tasks(row.id)[0]; aged.lastModelTick -= MODEL_DEBOUNCE_TICKS; s.store.putTask(row.id, aged);
    for (let i = 0; i < 5; i++) s.tick(w);
    mode = 'bad'; s.injectReport(row.id); await new Promise((r) => setTimeout(r, 50));
    expect(stub.history).toHaveLength(4);
    const t2 = s.store.tasks(row.id)[0];
    expect(t2.lastMethod).toBe('deterministic provenance watcher');
    expect(t2.lastResult).not.toMatch(/classified/);
    const rejected = s.store.events(row.id).find((e) => e.kind === 'staff_rejected')!;
    expect(rejected.details.errors).toEqual(expect.arrayContaining([expect.stringMatching(/unknown citation "report-that-does-not-exist"/), expect.stringMatching(/real-world adversary/)]));
    expect(JSON.stringify(rejected.details)).not.toContain('classified national dossier');
    // Opt out keeps the free watch; cancel ends it and discards any late result.
    expect((await call('POST', `/api/agents/tasks/${task.id}/model`, session(alpha, row.id), { enabled: false })).json.task).toMatchObject({ modelEnabled: false, kind: 'provenance-watch', status: 'waiting' });
    expect((await call('POST', `/api/agents/tasks/${task.id}/model`, session(alpha, row.id), { enabled: 'yes' })).status).toBe(400);
    expect((await call('POST', '/api/agents/tasks/nope/model', session(alpha, row.id), { enabled: true })).status).toBe(404);
  });

  it('requires fresh native can_edit and can_run_agents to enable paid analysis under Kamiwaza identity', async () => {
    const s = service(); const { row } = await running(s); const { call } = await serve(s);
    const stub = new DeterministicClient({ respond: () => decision([], { done: true, summary: 'ok' }) }); s.luna = stub;
    const task = s.createTask(row.id, alpha, 'Watch source changes', 'blue');
    const native = session({ ...alpha, mode: 'kamiwaza' }, row.id);
    const url = `/api/agents/tasks/${task.id}/model`;
    expect((await call('POST', url, native, { enabled: true })).status).toBe(403);
    expect((await call('POST', url, native, { enabled: true }, { identity: { subject: alpha.subject }, context: { canEdit: false, canRunAgents: true, readOnlyReason: 'archived' } })).json.error).toMatch(/does not permit writes \(archived\)/);
    expect((await call('POST', url, native, { enabled: true }, { identity: { subject: alpha.subject }, context: { canEdit: true, canRunAgents: false } })).json.error).toMatch(/permit running agents/);
    expect((await call('POST', url, native, { enabled: true }, { identity: { subject: alpha.subject }, context: { canEdit: true, canRunAgents: true, fresh: false } })).json.error).toMatch(/stale/);
    expect((await call('POST', url, native, { enabled: true }, { identity: { subject: 'someone-else' }, context: { canEdit: true, canRunAgents: true } })).status).toBe(403);
    expect(stub.history).toHaveLength(0);
    expect((await call('POST', url, native, { enabled: true }, { identity: { subject: alpha.subject }, context: { canEdit: true, canRunAgents: true, fresh: true } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.history).toHaveLength(1);
    // Disabling is an ordinary write.
    expect((await call('POST', url, native, { enabled: false }, { identity: { subject: alpha.subject }, context: { canEdit: true, canRunAgents: false } })).status).toBe(200);
  });
});

describe('opposing player agent', () => {
  it('closes the legal-action feedback loop: queries, then a validated order, with durable memory and debrief-compatible traces', async () => {
    const s = service(); const { row, w } = await running(s);
    w.row.agentEnabled = true;
    const stub = new DeterministicClient({ respond: (req: CompleteInput, i) => {
      const input = JSON.parse(req.input);
      if (i === 0) { expect(input.observation.legal.actions.length).toBeGreaterThan(0); expect(input.memory).toEqual([]); return decision([{ tool: 'list_resources', arguments: {} }, { tool: 'inspect_tile', arguments: { tile: input.observation.borderSamples[0].tile } }]); }
      if (i === 1) { const troops = Math.floor(input.priorResults[0].results[0].output.troops * 0.2); return decision([{ tool: 'submit_order', arguments: { intent: { type: 'attack', targetID: null, troops } } }, { tool: 'submit_order', arguments: { intent: { type: 'attack', targetID: null, troops: 1e12 } } }], { summary: 'Expanded with a fifth of available forces' }); }
      expect(input.memory).toHaveLength(1); expect(input.memory[0].actions.some((a: any) => a.commandId)).toBe(true); return decision([], { done: true });
    } });
    s.luna = stub;
    await s.runOpponent(w);
    expect(stub.history).toHaveLength(2);
    expect(stub.history[0].purpose).toBe('opponent decision');
    expect(stub.history[0].context).toMatchObject({ side: 'red', playstyle: expect.stringMatching(/reserve-aware|expansion-focused|opportunistic/) });
    const decisions = s.store.events(row.id).filter((e) => e.kind === 'model_decision');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({ side: 'red', summary: 'Expanded with a fifth of available forces' });
    expect(decisions[0].details.receipt.id).toBe('synthetic-0');
    expect(decisions[0].details.observation.legal).toBeDefined();
    const results = s.store.events(row.id).filter((e) => e.kind === 'tool_result');
    expect(results.map((e) => [e.details.tool, e.details.receiptId])).toEqual([['list_resources', 'synthetic-0'], ['inspect_tile', 'synthetic-0'], ['submit_order', 'synthetic-1'], ['submit_order', 'synthetic-1']]);
    expect(results[2].details.output.status).toBe('queued');
    expect(results[3].details.output).toMatchObject({ rejected: true, reason: expect.stringMatching(/available forces/) });
    s.tick(w); s.tick(w);
    const cmd = s.store.events(row.id).find((e) => e.kind === 'command' && e.details.origin === 'luna');
    expect(cmd?.details.commandId).toBe(results[2].details.output.id);
    // Next pulse sees the receipt in durable memory.
    await s.runOpponent(w);
    expect(stub.history).toHaveLength(3);
    const memory = s.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`agent.memory:${row.id}:luna-${row.id}-red`) as any;
    expect(JSON.parse(memory.value)).toHaveLength(2);
    expect(JSON.parse(memory.value)[0].actions[2]).toMatchObject({ tool: 'submit_order', ok: true, commandId: cmd?.details.commandId });
    expect(JSON.stringify(JSON.parse(memory.value))).not.toMatch(/reasoning|chain of thought/i);
  });

  it('never stops the clock while inference is pending', async () => {
    const s = service(); const { row, w } = await running(s);
    w.row.agentEnabled = true;
    let release!: (r: CompleteResult) => void;
    const stub = new DeterministicClient({ respond: () => decision([], { done: true }) });
    let started!:()=>void;const entered=new Promise<void>(r=>started=r);
    s.luna = { complete: () => new Promise<CompleteResult>((resolve) => { release = resolve;started(); }) } as unknown as GameService['luna'];
    const before = w.engine.game.ticks();
    const pending = s.runOpponent(w);
    await entered;
    for (let i = 0; i < 30; i++) s.tick(w);
    expect(w.engine.game.ticks()).toBe(before + 30);
    expect(w.modelBusy).toBe(true);
    release(await stub.complete({ purpose: 'opponent decision', instructions: '', input: '{}', jsonSchema: { name: 'agent_pulse', schema: {} } }));
    await pending;
    expect(w.modelBusy).toBe(false);
    expect(s.store.events(row.id).filter((e) => e.kind === 'model_decision')).toHaveLength(1);
  });

  it('falls through to the deterministic baseline when the budget cap is hit, without retrying', async () => {
    const s = service(); const { row, w } = await running(s);
    w.row.agentEnabled = true;
    let calls = 0;
    s.luna = { complete: async () => { calls++; throw new InferenceError('budget_exceeded', 'project budget cap reached'); } } as unknown as GameService['luna'];
    await s.runOpponent(w);
    expect(calls).toBe(1);
    expect(w.row.agentEnabled).toBe(false);
    expect(s.store.exercise(row.id)!.agentEnabled).toBe(false);
    expect(s.store.events(row.id).find((e) => e.kind === 'model_error')?.summary).toMatch(/existing orders continue/);
    // The same cap disables a paid staff task too, leaving the free watch in place.
    const task = s.createTask(row.id, alpha, 'Watch source changes', 'blue');
    s.setTaskModel(session(alpha, row.id), task.id, true);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(2);
    expect(s.store.tasks(row.id)[0]).toMatchObject({ modelEnabled: false, kind: 'provenance-watch', status: 'waiting' });
    expect(s.store.events(row.id).find((e) => e.kind === 'staff_model_error')?.summary).toMatch(/deterministic watch continues/);
  });

  it('discards a result that returns after the controller was stopped', async () => {
    const s = service(); const { row, w } = await running(s);
    w.row.agentEnabled = true;
    s.luna = { complete: async (req: CompleteInput) => { w.row.agentEnabled = false; return new DeterministicClient({ respond: () => decision([{ tool: 'submit_order', arguments: { intent: { type: 'attack', targetID: null, troops: 5 } } }]) }).complete(req); } } as unknown as GameService['luna'];
    await s.runOpponent(w);
    expect(s.store.pending(row.id)).toHaveLength(0);
    expect(s.store.events(row.id).some((e) => e.kind === 'model_result_discarded')).toBe(true);
  });
});

describe('brainstorm staff answers', () => {
  it('accepts an answer citing supplied reports and rejects one citing anything else', async () => {
    const s = service(); const { row } = await running(s);
    const blue = s.store.reports(row.id).find((r) => r.side === 'blue')!;
    s.luna = new DeterministicClient({ respond: (req: CompleteInput, i) => { const ids = JSON.parse(req.input).reports.map((r: any) => r.id); return i === 0 ? { text: 'You hold your initial forces; the estimate is current.', sourceIds: [ids[0]] } : i === 1 ? { text: 'Trust me.', sourceIds: ['fabricated-report'] } : 'plain text answer with no citations'; } });
    const ok = await s.staff(session(alpha, row.id), 'What do I know about the opposing player?', 'blue');
    expect(ok).toEqual({ text: 'You hold your initial forces; the estimate is current.', sourceIds: [blue.id] });
    expect(s.store.events(row.id).find((e) => e.kind === 'staff_answer')?.details.sourceIds).toEqual([blue.id]);
    await expect(s.staff(session(alpha, row.id), 'And now?', 'blue')).rejects.toMatchObject({ status: 422, extra: { unknown: ['fabricated-report'], receiptId: 'synthetic-1' } });
    const rejected = s.store.events(row.id).find((e) => e.kind === 'staff_rejected')!;
    expect(rejected.details.unknown).toEqual(['fabricated-report']);
    expect(JSON.stringify(rejected.details)).not.toContain('Trust me');
    expect(s.store.events(row.id).filter((e) => e.kind === 'staff_answer')).toHaveLength(1);
    // A non-JSON answer is shown without citations rather than rejected: nothing fabricated, nothing to validate.
    expect(await s.staff(session(alpha, row.id), 'Plain?', 'blue')).toEqual({ text: 'plain text answer with no citations', sourceIds: [] });
  });
});

it('projects the task endpoint at the selected replay tick and withholds tasks created later',async()=>{
 const s=service();const {row,w}=await running(s);const {call}=await serve(s);
 const task=s.createTask(row.id,alpha,'Watch the available reports','blue');const createdTick=task.createdTick;
 for(let i=0;i<5;i++)s.tick(w);
 const later=s.store.event(row.id,w.engine.game.ticks(),'staff_update',alpha.subject,'Later accepted analysis',{taskId:task.id,sourceIds:[],method:'model staff agent',receiptId:'synthetic-later'},'blue');
 const old=await call('GET',`/api/agents/tasks/${task.id}`,session(alpha,row.id,{playbackTick:createdTick}));
 expect(old.status).toBe(200);expect(old.json.task.status).toBe('historical');expect(old.json.task.modelResult).toBeNull();expect(old.text).not.toContain('Later accepted analysis');expect(old.json.trace.every((e:any)=>e.tick<=createdTick)).toBe(true);
 expect((await call('GET',`/api/agents/tasks/${task.id}`,session(alpha,row.id,{playbackTick:createdTick-1}))).status).toBe(404);
 const now=await call('GET',`/api/agents/tasks/${task.id}`,session(alpha,row.id));expect(now.json.task.modelResult).toMatchObject({eventId:later,text:'Later accepted analysis',receiptId:'synthetic-later'});
});
