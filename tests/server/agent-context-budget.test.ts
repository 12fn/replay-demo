import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GameService, APP_MODEL_INPUT_MAX_BYTES, type Identity, type Session } from '../../src/server/service';
import type { NativeResolved } from '../../src/server/native-session';
import { DeterministicClient, LunaClient, DEFAULT_MAX_INPUT_BYTES, type CompleteInput } from '../../src/inference';
import { toolsForScope, observe } from '../../src/agents/tools';
import { citableIds } from '../../src/agents/staff';
import { agentOrganizationContext } from '../../src/context/agent-context';

const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).reverse().forEach(fn => fn());
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(scenario: string, identity?: Identity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-context-budget-'));
  // Construction must not read a developer credential or configure native retrieval.
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('REPLAY_KEY_FILE', path.join(dir, 'absent-key-file'));
  vi.stubEnv('REPLAY_ONTOLOGY_ID', '');
  const s = new GameService(dir);
  clean.push(() => fs.rmSync(dir, { recursive: true, force: true }), () => s.close());
  // Check the production service configuration before any deterministic substitution.
  expect(s.luna).toBeInstanceOf(LunaClient);
  expect(APP_MODEL_INPUT_MAX_BYTES).toBe(32768);
  expect((s.luna as LunaClient).maxInputBytes).toBe(APP_MODEL_INPUT_MAX_BYTES);
  expect(DEFAULT_MAX_INPUT_BYTES).toBe(24 * 1024);
  expect(s.ledger.summary()).toMatchObject({ maxRequests: 100, maxUsd: 5 });
  const row = await s.create('Context budget fixture', 'world', identity, scenario);
  const w = s.world(row.id);
  for (let i = 0; i < 25; i++) s.tick(w);
  return { s, w };
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function size(req: CompleteInput) {
  // This is LunaClient.complete's admission calculation, including the actual response schema.
  const instructions = Buffer.byteLength(req.instructions, 'utf8');
  const input = Buffer.byteLength(req.input, 'utf8');
  const schema = req.jsonSchema ? jsonBytes(req.jsonSchema.schema) : 0;
  const body = JSON.parse(req.input);
  return {
    total: instructions + input + schema, instructions, input, schema,
    catalog: jsonBytes(body.tools), observation: jsonBytes(body.observation),
    pack: jsonBytes(body.observation.organizationContext), priorResults: jsonBytes(body.priorResults),
  };
}

for (const scenario of ['crosscurrent-classic/1', 'crosscurrent-objectives/1', 'crosscurrent-crossing/1']) {
  it(`keeps actual ${scenario} opponent first and query-follow-up completions within the service's 32 KiB bound`, async () => {
    const { s, w } = await fixture(scenario);
    const client = new DeterministicClient({ respond: (_req, index) => ({
      summary: 'Synthetic context budget check.', sourceIds: [], done: index > 0,
      calls: index === 0 ? [{ tool: 'observe', arguments: '{}' }] : [],
    }) });
    s.luna = client;
    const ctx = s.agentContext(w, 'red', 'staff');
    const expectedState = observe(ctx);
    const expectedPack = agentOrganizationContext(w.row.options, 'commander');
    const expectedCatalog = toolsForScope('player').map(t => ({
      name: t.name, kind: t.kind, description: t.description, arguments: t.args,
    }));
    w.row.agentEnabled = true;
    await s.runOpponent(w);
    expect(client.history.length).toBe(2);
    const bodies = client.history.map(req => JSON.parse(req.input));
    for (const [index, req] of client.history.entries()) {
      const body = bodies[index], measured = size(req);
      // Log byte counts only, never prompt contents, report bodies or native session data.
      console.info(JSON.stringify({ scenario, completion: index, ...measured }));
      expect.soft(measured.total, `${scenario} completion ${index} total UTF-8 bytes`).toBeLessThanOrEqual(APP_MODEL_INPUT_MAX_BYTES);
      expect(measured.pack).toBeLessThanOrEqual(6000);
      expect(isDeepStrictEqual(body.tools, expectedCatalog)).toBe(true);
      expect(isDeepStrictEqual(body.observation.organizationContext, expectedPack)).toBe(true);
      for (const [key, value] of Object.entries(expectedState)) {
        expect(isDeepStrictEqual(body.observation[key], value), `actual state field ${key}`).toBe(true);
      }
      expect(req.context).toMatchObject({ exerciseId: w.row.id, side: 'red',
        observedTick: expectedState.tick, fingerprint: expectedState.fingerprint, completion: index });
    }
    expect(isDeepStrictEqual(bodies[1].observation, bodies[0].observation)).toBe(true);
    expect(bodies[0].priorResults.length).toBe(0);
    expect(bodies[1].priorResults[0].results[0].tool).toBe('observe');
    expect(bodies[1].priorResults[0].results[0].ok).toBe(true);
    expect(isDeepStrictEqual(bodies[1].priorResults[0].results[0].output, expectedState)).toBe(true);
    expect(s.store.events(w.row.id).filter(e => e.kind === 'model_error').length).toBe(0);
    expect(s.ledger.summary().requestsUsed).toBe(0);
  });
}

it('keeps fresh initiating native staff pulses within 32 KiB, preserves observation metadata, and rejects narrative citations', async () => {
  const identity: Identity = { subject: 'synthetic-owner', name: 'Fixture owner', role: 'instructor',
    organization: 'Fictional fixture', mode: 'kamiwaza' };
  const { s, w } = await fixture('crosscurrent-classic/1', identity);
  w.row.options.workroomId = 'synthetic-room';
  s.store.putExercise(w.row);
  const session: Session = { identity, activeId: w.row.id, playbackTick: null, selectedSide: 'blue' };
  let currentRole: Identity['role'] = 'commander';
  // Authority-only fixture: no native client/session metadata is needed with ontology disabled.
  const resolver = vi.fn(async () => ({
    identity: { ...identity, role: currentRole },
    context: { workroomId: 'synthetic-room', fresh: true, canEdit: true, canRunAgents: true,
      validatedAt: '2026-09-14T00:00:00.000Z' },
    nativeReceipts: [],
  } as unknown as NativeResolved));
  const task = s.createTask(w.row.id, identity, 'Monitor report provenance', 'blue');
  s.bindAgentAuthority(session, `task:${task.id}`, resolver);
  const client = new DeterministicClient({ respond: (req, index) => {
    const body = JSON.parse(req.input);
    if (index % 2 === 0) {
      // Let the real clock advance while inference is pending; the pulse's observation stays pinned.
      s.tick(w);
      return { summary: 'Synthetic source query.', sourceIds: [], done: false,
        calls: [{ tool: 'search_reports', arguments: '{}' }] };
    }
    const source = index === 1 ? body.priorResults[0].results[0].output.reports[0].id
      : body.observation.organizationContext.report.id;
    return { summary: 'Synthetic source assessment.', sourceIds: [source], done: true, calls: [] };
  } });
  s.luna = client;
  const analysis = vi.spyOn(s, 'runStaffAnalysis'); // Observe the real async opt-in call; do not replace it.
  s.setTaskModel(session, task.id, true);
  await analysis.mock.results[0].value;
  expect(client.history.length).toBe(2);
  const first = JSON.parse(client.history[0].input).observation;
  expect(first.organizationContext.role).toBe('commander');
  expect(isDeepStrictEqual(first.organizationContext, agentOrganizationContext(w.row.options, 'commander'))).toBe(true);
  expect(resolver.mock.calls.length).toBe(5); // Preparation, before/after each completion.
  const accepted = s.store.tasks(w.row.id).find(t => t.id === task.id)!;
  expect(accepted.lastObservedTick).toBe(first.tick);
  expect(accepted.lastModelTick).toBeGreaterThan(first.tick);
  expect(accepted.lastReceiptId).toBe('synthetic-1');
  expect(accepted.lastMethod).toBe('model staff agent');

  currentRole = 'intelligence'; // Same initiating owner, freshly changed seat, unchanged stale session label.
  await s.runStaffAnalysis(w.row.id, task.id, { newReports: [], superseded: [], delta: null, reasons: ['fixture role change'] });
  expect(client.history.length).toBe(4);
  expect(resolver.mock.calls.length).toBe(10);
  expect(JSON.parse(client.history[2].input).observation.organizationContext.role).toBe('intelligence');
  expect(identity.role).toBe('instructor');
  const events = s.store.events(w.row.id);
  const decisions = events.filter(e => e.kind === 'staff_model_decision');
  const results = events.filter(e => e.kind === 'staff_tool_result');
  expect(decisions.length).toBe(4);
  expect(results.length).toBe(2);
  for (let index = 0; index < 4; index++) {
    const req = client.history[index], body = JSON.parse(req.input), decision = decisions[index];
    const measured = size(req);
    console.info(JSON.stringify({ scope: 'staff', pulse: Math.floor(index / 2), completion: index % 2, ...measured }));
    expect(measured.total).toBeLessThanOrEqual(APP_MODEL_INPUT_MAX_BYTES);
    const start = index - index % 2, initial = JSON.parse(client.history[start].input).observation;
    expect(isDeepStrictEqual(body.observation, initial)).toBe(true);
    expect(req.context).toMatchObject({ exerciseId: w.row.id, taskId: task.id, side: 'blue',
      pulseId: client.history[start].context!.pulseId, observedTick: initial.tick, completion: index % 2 });
    expect(decision.actor).toBe(identity.subject);
    expect(decision.side).toBe('blue');
    expect(decision.tick).toBeGreaterThan(initial.tick);
    expect(decision.details.pulseId).toBe(req.context!.pulseId);
    expect(decision.details.taskId).toBe(task.id);
    expect(decision.details.receipt.id).toBe(`synthetic-${index}`);
    expect(isDeepStrictEqual(decision.details.receipt.context, req.context)).toBe(true);
    expect(isDeepStrictEqual(decision.details.observation, index % 2 === 0 ? initial : { priorResultsOf: 0 })).toBe(true);
    const ctx = s.agentContext(w, 'blue', 'staff');
    const toolOutputs = body.priorResults.flatMap((prior: any) => prior.results.map((result: any) => result.output));
    const allowed = citableIds(ctx, [body.observation, ...toolOutputs]);
    const pack = body.observation.organizationContext;
    const narrativeIds = [pack.packId, pack.report.id, ...pack.report.fields.map((f: any) => f.id),
      ...pack.glossary.map((f: any) => f.id), ...pack.learningPrompts.map((f: any) => f.id),
      ...pack.curriculumReferences.map((f: any) => f.id)];
    expect(narrativeIds.filter(id => allowed.has(id)).length).toBe(0);
    expect(body.observation.reports.every((report: any) => allowed.has(report.id))).toBe(true);
  }
  for (let pulse = 0; pulse < 2; pulse++) {
    expect(results[pulse].details.pulseId).toBe(client.history[pulse * 2].context!.pulseId);
    expect(results[pulse].details.receiptId).toBe(`synthetic-${pulse * 2}`);
  }
  expect(client.history[0].context!.pulseId).not.toBe(client.history[2].context!.pulseId);
  const update = events.find(e => e.kind === 'staff_update' && e.details.method === 'model staff agent')!;
  expect(update.details.observedTick).toBe(first.tick);
  expect(update.details.receiptId).toBe('synthetic-1');
  const rejected = events.find(e => e.kind === 'staff_rejected')!;
  expect(rejected.details.receiptId).toBe('synthetic-3');
  expect(rejected.details.errors).toContain(`unknown citation "${JSON.parse(client.history[2].input).observation.organizationContext.report.id}"`);
  expect(s.store.tasks(w.row.id).find(t => t.id === task.id)!.lastReceiptId).toBe('synthetic-1');
  expect(events.filter(e => e.kind === 'staff_model_error').length).toBe(0);
  expect(s.ledger.summary().requestsUsed).toBe(0);
});
