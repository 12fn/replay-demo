import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GameService, type Identity } from '../../src/server/service';
import { DeterministicClient, summarizeOutput, type CompleteInput } from '../../src/inference/index';
import { AgentMemory, MEMORY_LIMIT, noteFor, readDecision, runPulse, validateCitations, type Completion } from '../../src/agents/index';

console.debug = () => {};
const dirs: string[] = [];
const services: GameService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const luna: Identity = { subject: 'luna-loop-red', name: 'Luna opponent', role: 'commander', organization: 'Exercise', mode: 'local-demo' };

async function world() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-agent-loop-')); dirs.push(d);
  const s = new GameService(d); services.push(s);
  const row = await s.create('Loop', 'plains'); const w = s.world(row.id);
  for (let i = 0; i < 25; i++) s.tick(w);
  return { s, row, w };
}
const decision = (calls: { tool: string; arguments: unknown }[], extra: Partial<{ summary: string; sourceIds: string[]; done: boolean }> = {}) =>
  ({ summary: extra.summary ?? 'external summary', sourceIds: extra.sourceIds ?? [], done: extra.done ?? false, calls: calls.map((c) => ({ tool: c.tool, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) })) });

describe('bounded agent loop', () => {
  it('retains safe provider message shapes alongside decision diagnostics in the exercise event',async()=>{
    const {s,w}=await world(),client=new DeterministicClient({respond:()=>decision([],{done:true})});const complete=client.complete.bind(client);
    const diagnostics=summarizeOutput({status:'completed',output:[{type:'message',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'{"done":true}'}]}]},'{"done":true}',12);
    client.complete=async<T>(req:CompleteInput)=>({...await complete<T>(req),diagnostics});s.luna=client;w.row.agentEnabled=true;await s.runOpponent(w);
    const event=s.store.events(w.row.id).find(e=>e.kind==='model_decision');expect(event?.details.providerDiagnostics).toEqual(diagnostics);expect(event?.details.diagnostics.kind).toBe('decision');
  });
  it('feeds real tool results into the next completion and lets the model pick a legal action from them', async () => {
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'player', luna);
    let seenActions: any[] = [];
    const client = new DeterministicClient({ respond: (req: CompleteInput, i) => {
      const input = JSON.parse(req.input);
      if (i === 0) { expect(input.priorResults).toEqual([]); return decision([{ tool: 'list_legal_actions', arguments: {} }]); }
      seenActions = input.priorResults[0].results[0].output.actions;
      const expand = seenActions.find((a: any) => a.intent.type === 'attack' && a.intent.targetID === null);
      return decision([{ tool: 'submit_order', arguments: { intent: expand.intent } }], { summary: 'Selected expansion from the legal list' });
    } });
    const steps: Completion[] = [];
    const run = await runPulse({ client, scope: 'player', ctx, purpose: 'test', context: {}, instructions: 'play', observation: { tick: w.engine.game.ticks() }, onCompletion: (c) => steps.push(c) });
    expect(run.completions).toHaveLength(2);
    expect(run.stopped).toBe('action-selected');
    expect(run.stepsUsed).toBe(2);
    expect(seenActions.length).toBeGreaterThan(0);
    expect(steps[1].results[0]).toMatchObject({ tool: 'submit_order', ok: true, output: { status: 'queued' } });
    expect(client.history[1].jsonSchema?.name).toBe('agent_pulse');
    expect(client.history[1].instructions).toMatch(/untrusted data/);
    s.tick(w); s.tick(w);
    expect(s.store.events(w.row.id).some((e) => e.kind === 'command' && e.details.origin === 'luna' && e.side === 'red')).toBe(true);
  });

  it('caps a pulse at 2 completions and 4 tool steps, and records refused calls instead of running them', async () => {
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'player', luna);
    const client = new DeterministicClient({ respond: () => decision(Array.from({ length: 5 }, () => ({ tool: 'observe', arguments: {} }))) });
    const run = await runPulse({ client, scope: 'player', ctx, purpose: 'test', context: {}, instructions: 'x', observation: {} });
    expect(client.history).toHaveLength(1);
    expect(run.stepsUsed).toBe(4);
    expect(run.stopped).toBe('budget');
    expect(run.completions[0].results.map((r) => r.ok)).toEqual([true, true, true, true, false]);
    expect(run.completions[0].results[4].reason).toMatch(/budget/);
    const chatty = new DeterministicClient({ respond: () => decision([{ tool: 'observe', arguments: {} }]) });
    const two = await runPulse({ client: chatty, scope: 'player', ctx, purpose: 'test', context: {}, instructions: 'x', observation: {} });
    expect(chatty.history).toHaveLength(2);
    expect(two.stepsUsed).toBe(2);
    expect(two.completions.map((c) => c.index)).toEqual([0, 1]);
  });

  it('refuses unknown and out-of-scope tools and stops on done / no calls without spending more', async () => {
    const { s, w } = await world();
    const staff = s.agentContext(w, 'blue', 'staff');
    const client = new DeterministicClient({ respond: () => decision([{ tool: 'submit_order', arguments: { intent: {} } }, { tool: 'nonsense', arguments: {} }], { done: true }) });
    const run = await runPulse({ client, scope: 'staff', ctx: staff, purpose: 'test', context: {}, instructions: 'x', observation: {} });
    expect(run.completions[0].results.map((r) => [r.ok, r.reason])).toEqual([[false, expect.stringMatching(/not available in staff scope/)], [false, expect.stringMatching(/Unknown tool/)]]);
    expect(run.stopped).toBe('done');
    expect(client.history).toHaveLength(1);
    const quiet = new DeterministicClient({ respond: () => decision([]) });
    expect((await runPulse({ client: quiet, scope: 'staff', ctx: staff, purpose: 'test', context: {}, instructions: 'x', observation: {} })).stopped).toBe('no-calls');
    expect(quiet.history).toHaveLength(1);
  });

  it('tolerates malformed model output and stops the pulse when the caller says conditions changed', async () => {
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'player', luna);
    expect(readDecision(undefined, 'not json')).toMatchObject({ summary: 'not json', calls: [], sourceIds: [], done: false, diagnostics: { source: 'none', kind: 'not_object', missing: ['summary', 'sourceIds', 'calls', 'done'] } });
    expect(readDecision({ calls: [{ tool: 'observe', arguments: { a: 1 } }, 'junk'], sourceIds: ['x', 'x', 3] }, '')).toMatchObject({ calls: [{ tool: 'observe', arguments: '{"a":1}' }], sourceIds: ['x'], diagnostics: { source: 'parsed', kind: 'partial', missing: ['summary', 'done'], droppedCalls: 1, coercedArguments: 1, invalidArguments: 0, droppedSourceIds: 2 } });
    const client = new DeterministicClient({ respond: () => decision([{ tool: 'submit_order', arguments: { intent: { type: 'attack', targetID: null, troops: 10 } } }]) });
    const run = await runPulse({ client, scope: 'player', ctx, purpose: 'test', context: {}, instructions: 'x', observation: {}, shouldContinue: () => false });
    expect(run.completions).toEqual([]);
    expect(client.history).toHaveLength(0);
    expect(s.store.pending(w.row.id)).toHaveLength(0);
  });

  it('distinguishes a well-formed decision, a wrong-shaped object, text-only JSON and malformed argument strings', async () => {
    const full = { summary: 's', sourceIds: [], calls: [], done: true };
    expect(readDecision(full, '').diagnostics).toEqual({ source: 'parsed', kind: 'decision', missing: [], droppedCalls: 0, coercedArguments: 0, invalidArguments: 0, droppedSourceIds: 0 });
    // Valid JSON, but not a decision: an array, a scalar, a differently keyed object.
    expect(readDecision([full], JSON.stringify([full])).diagnostics).toMatchObject({ source: 'none', kind: 'not_object' });
    expect(readDecision('yes', '"yes"').diagnostics).toMatchObject({ source: 'none', kind: 'not_object' });
    expect(readDecision({ action: 'attack' }, '').diagnostics).toMatchObject({ source: 'parsed', kind: 'partial', missing: ['summary', 'sourceIds', 'calls', 'done'] });
    // No client-side parse but the text itself is a decision.
    expect(readDecision(undefined, JSON.stringify(full))).toMatchObject({ summary: 's', done: true, diagnostics: { source: 'text', kind: 'decision' } });
    // Selection is valid; the JSON-string arguments are not an object.
    const bad = readDecision({ ...full, calls: [{ tool: 'submit_order', arguments: '{"intent": {type: attack' }, { tool: 'observe', arguments: '[1]' }, { tool: 'observe', arguments: '' }, { tool: 'observe', arguments: 7 }] }, '');
    expect(bad.calls.map((c) => c.arguments)).toEqual(['{"intent": {type: attack', '[1]', '', '7']);
    expect(bad.diagnostics).toMatchObject({ kind: 'decision', droppedCalls: 0, coercedArguments: 1, invalidArguments: 3 });
    expect(JSON.stringify(bad.diagnostics)).not.toContain('attack');

    // Through the loop: the call still reaches the tool (which sees `{}`) and the completion carries the diagnosis.
    const { s, w } = await world();
    const ctx = s.agentContext(w, 'red', 'player', luna);
    const client = new DeterministicClient({ respond: () => ({ ...full, done: false, calls: [{ tool: 'submit_order', arguments: '{"intent": {type: attack' }] }) });
    const run = await runPulse({ client, scope: 'player', ctx, purpose: 'test', context: {}, instructions: 'x', observation: {}, budget: { maxCompletions: 1 } });
    expect(run.completions).toHaveLength(1);
    expect(run.completions[0].decision.diagnostics).toMatchObject({ source: 'parsed', kind: 'decision', invalidArguments: 1 });
    expect(run.completions[0].results[0]).toMatchObject({ tool: 'submit_order', ok: false });
    expect(s.store.pending(w.row.id)).toHaveLength(0);
  });
});

describe('durable memory and citations', () => {
  it('persists external action notes with command receipts, bounded to the last entries', async () => {
    const { s, w } = await world();
    const m = new AgentMemory(s.store.db, w.row.id, 'luna-x');
    expect(m.load()).toEqual([]);
    for (let i = 0; i < MEMORY_LIMIT + 3; i++) m.append({ tick: i, at: 'now', receiptIds: [`r${i}`], summary: `s${i}`, stopped: 'done', actions: [noteFor('submit_order', true, { id: `cmd${i}`, status: 'queued' })] });
    const entries = m.load();
    expect(entries).toHaveLength(MEMORY_LIMIT);
    expect(entries[0].tick).toBe(3);
    expect(entries.at(-1)!.actions[0]).toEqual({ tool: 'submit_order', ok: true, note: 'order queued (queued)', commandId: `cmd${MEMORY_LIMIT + 2}` });
    expect(noteFor('observe', false, null, 'nope')).toEqual({ tool: 'observe', ok: false, note: 'rejected: nope' });
    const again = new AgentMemory(s.store.db, w.row.id, 'luna-x');
    expect(again.load()).toEqual(entries);
    expect(new AgentMemory(s.store.db, w.row.id, 'someone-else').load()).toEqual([]);
  });

  it('validates citations strictly against the available set', () => {
    expect(validateCitations(['a', 'b', 'a'], ['a', 'b', 'c'])).toEqual({ ok: true, unknown: [], cited: ['a', 'b'] });
    expect(validateCitations(['a', 'ghost'], ['a'])).toEqual({ ok: false, unknown: ['ghost'], cited: ['a', 'ghost'] });
    expect(validateCitations('a', ['a'])).toEqual({ ok: true, unknown: [], cited: [] });
  });
});
