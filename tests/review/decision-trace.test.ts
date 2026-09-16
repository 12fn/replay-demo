import { describe, expect, it } from 'vitest';
import { DECISION_TRACE_LIMITS, decisionTrace, type DecisionTraceInput, type DecisionTraceReport } from '../../src/review/decision-trace';
import type { ExecutionEvent } from '../../src/review/execution';

const event = (id: string, kind: string, tick: number, details: Record<string, unknown>, extra: Partial<ExecutionEvent> = {}): ExecutionEvent =>
  ({ id, kind, tick, details: { sourceExerciseId: 'exercise', ...details }, summary: `${kind} public summary`, actor: 'same-actor', side: 'blue', ...extra });
const report = (id: string, tick: number, extra: Partial<DecisionTraceReport> = {}): DecisionTraceReport =>
  ({ id, tick, side: 'blue', title: id, sourceExerciseId: 'exercise', ...extra });
function fixture(): DecisionTraceInput {
  return { eventId: 'command-event', side: 'blue', cutoffTick: 10, events: [
    event('model-event', 'model_decision', 7, { receipt: { id: 'receipt', status: 'completed', modelRequested: 'gpt-5.6-luna', modelReturned: 'gpt-5.6-luna' }, observation: { id: 'observation', tick: 5, fingerprint: 'fingerprint', reports: [{ id: 'source' }] } }),
    event('tool-event', 'tool_result', 7, { tool: 'submit_order', receiptId: 'receipt', output: { id: 'command', status: 'queued' } }),
    event('command-event', 'command', 8, { commandId: 'command', origin: 'luna', intent: { type: 'boat', dst: 42, troops: 100 }, observedTick: 7, admittedTick: 7 }),
    event('feedback-event', 'execution_feedback', 9, { commandId: 'command', feedback: { tick: 8, status: 'transport-launched', observed: { kind: 'transport', troopsBefore: 200, troopsAfter: 100, troopsDelta: -100, launchTile: 3, ticksObserved: 1 } } }),
  ], reports: [report('source', 4), report('later', 6)] };
}
function inherit(e: ExecutionEvent, parent: string, newId = e.id): ExecutionEvent {
  const { sourceExerciseId: _namespace, ...originalDetails } = e.details;
  return { ...e, id: newId, kind: 'inherited_event', details: { parentId: parent, parentEventId: e.id, originalKind: e.kind, originalDetails } };
}

describe('decisionTrace', () => {
  it('joins exact model receipt, submission output, command, inline observation, source IDs and measured effects', () => {
    const out = decisionTrace(fixture());
    expect(out.controller).toBe('model');
    expect(out.command.value).toMatchObject({ eventId: 'command-event', commandId: 'command', admission: 'accepted', intent: { type: 'boat', dst: 42, troops: 100 } });
    expect(out.submission.value).toMatchObject({ eventId: 'tool-event', commandId: 'command', receiptId: 'receipt', status: 'queued' });
    expect(out.model.value).toMatchObject({ eventId: 'model-event', actor: 'same-actor', externalSummary: 'model_decision public summary', receipt: { id: 'receipt', status: 'completed', modelReturned: 'gpt-5.6-luna' } });
    expect(out.observation.value).toMatchObject({ id: 'observation', tick: 5, fingerprint: 'fingerprint', link: 'inline', sourceIdsRecorded: true });
    expect(out.sources).toMatchObject([
      { id: 'source', status: 'available-at-observation', references: ['observation'] },
      { id: 'later', status: 'released-later', references: [] },
    ]);
    expect(out.execution.value).toMatchObject([{ eventId: 'feedback-event', tick: 9, measuredTick: 8, status: 'transport-launched', observed: { troopsDelta: -100 } }]);
  });

  it.each(['receipt', 'command', 'tool-name'] as const)('does not join mismatched %s despite identical actor and nearby ticks', mismatch => {
    const input = fixture();
    if (mismatch === 'receipt') input.events[1].details.receiptId = 'other-receipt';
    if (mismatch === 'command') input.events[1].details.output.id = 'other-command';
    if (mismatch === 'tool-name') input.events[1].details.tool = 'observe';
    const out = decisionTrace(input);
    expect(out.model.value).toBeNull();
    expect(out.observation.status).toBe('missing');
    expect(out.execution.status).toBe('recorded');
    if (mismatch !== 'receipt') expect(out.submission.status).toBe('missing');
  });

  it('reports unknown observations without borrowing command admission ticks or receipt context', () => {
    const input = fixture();
    input.events[0].details.observation = { priorResultsOf: 0 };
    input.events[0].details.receipt.context = { observedTick: 5, fingerprint: 'unverified', observationId: 'guess' };
    const out = decisionTrace(input);
    expect(out.model.status).toBe('recorded');
    expect(out.observation).toMatchObject({ status: 'missing', value: null });
    expect(out.sources.every(s => s.status === 'observation-unknown' && s.references.length === 0)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('unverified');
  });

  it('keeps a legacy inline snapshot without inventing an observation ID', () => {
    const input = fixture(); delete input.events[0].details.observation.id;
    expect(decisionTrace(input).observation.value).toMatchObject({ tick: 5, id: null });
  });

  it('filters future, other-side and unscoped events before selection and ambiguity checks', () => {
    const input = fixture();
    input.events.push(...input.events.map(e => ({ ...e, tick: 11, summary: 'future-secret' })),
      ...input.events.map(e => ({ ...e, side: 'red', summary: 'red-secret' })),
      ...input.events.map(e => ({ ...e, side: null, summary: 'unscoped-secret' })));
    expect(decisionTrace(input)).toEqual(decisionTrace(fixture()));
    expect(decisionTrace({ ...input, cutoffTick: 7 }).command.status).toBe('unavailable');
    expect(decisionTrace({ ...fixture(), side: 'red' }).command.status).toBe('unavailable');
    expect(decisionTrace({ ...fixture(), eventId: 'model-event' }).command.status).toBe('unavailable');
  });

  it('withholds unavailable source content and does not reveal whether a recorded unresolved ID exists', () => {
    const input = fixture();
    input.events[0].details.observation.sourceIds = ['future-source', 'red-source', 'absent'];
    input.reports.push(report('future-source', 11, { title: 'future-secret', observedTick: 1 }), report('red-source', 2, { side: 'red', title: 'red-secret' }));
    const out = decisionTrace(input);
    for (const id of ['future-source', 'red-source', 'absent']) expect(out.sources.find(s => s.id === id)).toMatchObject({ status: 'missing', report: null, references: ['observation'] });
    expect(JSON.stringify(out)).not.toMatch(/future-secret|red-secret/);
    const withoutHidden = { ...input, reports: input.reports.slice(0, 2) };
    expect(out).toEqual(decisionTrace(withoutHidden));
    input.reports.push(report('uncited-future', 12));
    expect(JSON.stringify(decisionTrace(input))).not.toContain('uncited-future');
  });

  it('uses release time even when the source describes an older observation; equality is available', () => {
    const input = fixture();
    input.reports = [report('source', 6, { observedTick: 1 }), report('at-cutoff', 10), report('at-observation', 5)];
    expect(decisionTrace(input).sources).toMatchObject([
      { id: 'source', status: 'released-later' }, { id: 'at-cutoff', status: 'released-later' }, { id: 'at-observation', status: 'available-at-observation' },
    ]);
  });

  it.each([{ tick: 11 }, { tick: 5, side: 'red' }, { tick: Number.NaN }])('withholds an invalid observation %j and its embedded IDs', patch => {
    const input = fixture();
    input.events[0].details.observation = { ...input.events[0].details.observation, ...patch, sourceIds: ['hidden-observation-source'] };
    const out = decisionTrace(input);
    expect(out.observation.status).toBe('missing');
    expect(JSON.stringify(out)).not.toContain('hidden-observation-source');
  });

  it('handles a human command without exposing private contemporaneous or post-hoc notes', () => {
    const input = fixture(); input.events = [input.events[2]];
    Object.assign(input.events[0].details, { origin: 'human', rationale: 'private-rationale', privateNote: 'private-note', observation: { tick: 5, side: 'blue', receiptHash: 'hash', basis: 'app-snapshot-returned-with-order', player: { secret: 'private-player' } } });
    input.events.push(event('note', 'decision_log', 9, { commandId: 'command', text: 'private-posthoc' }));
    const out = decisionTrace(input);
    expect(out.controller).toBe('human');
    expect(out.model.status).toBe('not-applicable');
    expect(out.observation.value).toMatchObject({ tick: 5, receiptHash: 'hash' });
    expect(out.execution.status).toBe('missing');
    expect(JSON.stringify(out)).not.toContain('private-');
  });

  it('exposes a deterministic rule summary only through its exact command ID', () => {
    const input = fixture(); input.events = [input.events[2]]; input.events[0].details.origin = 'scripted-maneuver';
    input.events.push(event('script', 'scripted_decision', 7, { commandId: 'command', controller: 'maneuver', category: 'expand' }));
    const out = decisionTrace(input);
    expect(out.controller).toBe('scripted');
    expect(out.model.status).toBe('not-applicable');
    expect(out.scripted.value).toMatchObject({ eventId: 'script', category: 'expand', externalSummary: 'scripted_decision public summary' });
    expect(out.observation.status).toBe('missing');
    input.events[1].details.commandId = 'wrong';
    expect(decisionTrace(input).scripted.status).toBe('missing');
  });

  it('separates rejection from queued submission and measured feedback', () => {
    const input = fixture(); input.events = input.events.slice(0, 3); input.events[2].kind = 'command_rejected';
    input.events[2].details.reason = 'Order could not execute';
    const out = decisionTrace(input);
    expect(out.command.value).toMatchObject({ admission: 'rejected', rejectionReason: 'Order could not execute' });
    expect(out.submission.value?.status).toBe('queued');
    expect(out.execution.status).toBe('missing');
  });

  it('cannot attach a rejected submission without a recorded output command ID', () => {
    const input = fixture(); input.events[1].details.output = { rejected: true, reason: 'Invalid order' };
    expect(decisionTrace(input).submission.status).toBe('missing');
  });

  it.each(['selection', 'command', 'submission', 'model', 'feedback', 'source'] as const)('makes duplicate %s evidence explicitly ambiguous', kind => {
    const input = fixture();
    if (kind === 'selection') input.events.push({ ...input.events[2] });
    if (kind === 'command') input.events.push({ ...input.events[2], id: 'other-command-event' });
    if (kind === 'submission') input.events.push({ ...input.events[1], id: 'other-submission' });
    if (kind === 'model') input.events.push({ ...input.events[0], id: 'other-model' });
    if (kind === 'feedback') input.events.push({ ...input.events[3] });
    if (kind === 'source') input.reports.push({ ...input.reports[0], title: 'conflicting' });
    const out = decisionTrace(input);
    if (kind === 'selection') expect(out.command.status).toBe('ambiguous');
    if (kind === 'command') expect([out.submission.status, out.execution.status]).toEqual(['ambiguous', 'ambiguous']);
    if (kind === 'submission') expect(out.submission.status).toBe('ambiguous');
    if (kind === 'model') expect(out.model.status).toBe('ambiguous');
    if (kind === 'feedback') expect(out.execution.status).toBe('ambiguous');
    if (kind === 'source') expect(out.sources[0]).toMatchObject({ status: 'ambiguous', report: null });
  });

  it('keeps inherited, original and current-branch identities in exact namespaces', () => {
    const input = fixture();
    input.events = input.events.map(e => inherit(e, 'parent'));
    input.reports = input.reports.map(r => ({ ...r, sourceExerciseId: 'parent', id: `branch:${r.id}`, parentSourceId: r.id }));
    input.events.push(...fixture().events.map(e => ({ ...e, id: `branch-${e.id}`, details: { ...e.details, sourceExerciseId: 'branch' }, summary: 'branch-only' })),
      ...fixture().events.map(e => inherit(e, 'other-parent', `other-${e.id}`)));
    const out = decisionTrace(input);
    expect(out.model.value).toMatchObject({ inherited: true, sourceExerciseId: 'parent', eventId: 'model-event' });
    expect(out.execution.value?.[0]).toMatchObject({ inherited: true, sourceExerciseId: 'parent' });
    expect(out.sources[0]).toMatchObject({ id: 'source', report: { id: 'branch:source', parentSourceId: 'source', inherited: true } });
    expect(JSON.stringify(out)).not.toContain('branch-only');
    input.events = input.events.filter(e => e.id !== 'tool-event');
    expect(decisionTrace(input).submission.status).toBe('missing');
  });

  it('uses the deepest inherited namespace and never treats missing namespace as a wildcard', () => {
    const input = fixture();
    input.events = input.events.map(e => inherit(inherit(e, 'root'), 'parent'));
    expect(decisionTrace(input).model.value?.sourceExerciseId).toBe('root');
    const plain = fixture(); delete plain.events[0].details.sourceExerciseId;
    expect(decisionTrace(plain).model.status).toBe('missing');
    for (const e of plain.events) delete e.details.sourceExerciseId;
    expect(decisionTrace(plain).model.status).toBe('recorded');
  });

  it('uses explicit owning exercise for real legacy direct model, tool and report rows', () => {
    const input = fixture(); input.exerciseId = 'exercise';
    for (const e of input.events.filter(e => ['model_decision', 'tool_result'].includes(e.kind))) delete e.details.sourceExerciseId;
    for (const r of input.reports) delete r.sourceExerciseId;
    const out = decisionTrace(input);
    expect(out.model.value).toMatchObject({ sourceExerciseId: 'exercise', eventId: 'model-event' });
    expect(out.submission.status).toBe('recorded');
    expect(out.sources[0]).toMatchObject({ id: 'source', sourceExerciseId: 'exercise', status: 'available-at-observation' });
    expect(decisionTrace({ ...input, exerciseId: undefined }).submission.status).toBe('missing');
    expect(decisionTrace({ ...input, exerciseId: undefined }).model.status).toBe('unavailable');
  });

  it('does not assign the owning branch namespace to inherited rows or reports', () => {
    const input = fixture(); input.exerciseId = 'branch';
    input.events = input.events.map(e => inherit(e, 'parent'));
    const branchRows = fixture().events.map(e => { const row = structuredClone(e); row.id = `branch-${row.id}`; delete row.details.sourceExerciseId; return row; });
    input.events.push(...branchRows);
    input.reports = [report('source', 4, { sourceExerciseId: undefined }), report('source', 4, { sourceExerciseId: undefined, inherited: true, title: 'unresolved-inherited' })];
    const parent = decisionTrace(input);
    expect(parent.model.value?.sourceExerciseId).toBe('parent');
    expect(parent.sources[0]).toMatchObject({ id: 'source', status: 'missing', report: null });
    const branch = decisionTrace({ ...input, eventId: 'branch-command-event' });
    expect(branch.model.value?.sourceExerciseId).toBe('branch');
    expect(branch.sources[0]).toMatchObject({ status: 'available-at-observation', report: { title: 'source' } });
    delete input.events[2].details.parentId;
    const unknown = decisionTrace(input);
    expect(unknown.command.value?.sourceExerciseId).toBeNull();
    expect(unknown.submission.status).toBe('missing');
    expect(unknown.model.value).toBeNull();
  });

  it('resolves a later completion observation only through an exact unique pulse, side and namespace', () => {
    const input = fixture(); const anchor = structuredClone(input.events[0]);
    anchor.id = 'completion-zero'; anchor.details.receipt.id = 'receipt-zero'; anchor.details.completion = 0; anchor.details.pulseId = 'pulse';
    Object.assign(input.events[0].details, { completion: 1, pulseId: 'pulse', observation: { priorResultsOf: 0 }, sourceIds: ['source'] });
    input.events.push(anchor,
      { ...anchor, id: 'other-pulse', details: { ...anchor.details, pulseId: 'other' } },
      { ...anchor, id: 'other-side', side: 'red' },
      { ...anchor, id: 'other-namespace', details: { ...anchor.details, sourceExerciseId: 'other-exercise' } });
    const out = decisionTrace(input);
    expect(out.model.value?.eventId).toBe('model-event');
    expect(out.observation.value).toMatchObject({ tick: 5, id: 'observation', link: 'pulse-completion-zero', pulseId: 'pulse', recordedIn: { eventId: 'completion-zero' } });
    expect(out.sources[0].references).toEqual(['observation', 'external-summary']);
    input.events.push({ ...anchor, id: 'duplicate-anchor' });
    expect(decisionTrace(input).observation.status).toBe('ambiguous');
  });

  it.each(['missing-pulse', 'different-pulse', 'future-anchor'] as const)('leaves %s continuation observations missing', problem => {
    const input = fixture(); const anchor = structuredClone(input.events[0]);
    anchor.id = 'anchor'; anchor.details.receipt.id = 'anchor-receipt'; anchor.details.completion = 0; anchor.details.pulseId = 'pulse';
    Object.assign(input.events[0].details, { completion: 1, pulseId: 'pulse', observation: { priorResultsOf: 0 } });
    if (problem === 'missing-pulse') delete input.events[0].details.pulseId;
    if (problem === 'different-pulse') anchor.details.pulseId = 'other';
    if (problem === 'future-anchor') anchor.tick = 11;
    input.events.push(anchor);
    expect(decisionTrace(input).observation.status).toBe('missing');
  });

  it('withholds future measured ticks even when the enclosing event is in scope', () => {
    const input = fixture(); input.events[3].details.feedback.tick = 11;
    expect(decisionTrace(input).execution.status).toBe('missing');
  });

  it('allowlists public fields and never emits raw receipts, calls, model memory or personal notes', () => {
    const input = fixture();
    Object.assign(input.events[0].details, { calls: [{ arguments: 'private-call' }], diagnostics: 'private-diagnostics', reasoning: 'private-reasoning' });
    Object.assign(input.events[0].details.receipt, { context: { secret: 'private-context' }, providerResponse: 'private-provider' });
    input.events[0].details.observation.memory = ['private-memory'];
    input.events[1].details.output.raw = 'private-output';
    input.events[2].details.intent.privateNote = 'private-intent';
    input.events[3].details.feedback.observed.privateNote = 'private-facts';
    expect(JSON.stringify(decisionTrace(input))).not.toContain('private-');
  });

  it('projects known totals, recorded pack/tool metadata and domain IDs without recursively copying snapshots', () => {
    const input = fixture(), o = input.events[0].details.observation;
    Object.assign(o, {
      self: { side: 'blue', troops: 200, tiles: 10, gold: 99, maxTroops: 500, alive: true, attacks: [{ troops: 5, secret: 'private-attack' }], units: [{ secret: 'private-unit' }], notes: 'private-self' },
      opponent: { side: 'red', troops: 300, tiles: 20, alive: true, attacksInFlight: 2, structures: 3, gold: 999, privateNotes: 'private-opponent' },
      organizationContext: { packId: 'pack', version: '1.0.0', role: 'commander', purpose: 'private-purpose', learningPrompts: ['private-prompts'] },
      availableTools: ['observe', 'submit_order', 'observe'],
      domainKnowledge: { status: 'native', requestId: 'native-request', groupId: 'group', facts: [{ id: 'fact', content: 'private-fact-content', sourceIds: ['domain-source'] }], reason: 'private-domain-reason' },
      resources: { secret: 'private-resource' }, legal: ['private-legal'], objectives: { secret: 'private-objective' },
    });
    // Cycles in unprojected nested metadata must not be traversed or returned.
    o.self.recursive = o; o.resources.recursive = o;
    input.events[0].details.receipt.context = { recursive: o, secret: 'private-receipt' };
    const out = decisionTrace(input), obs = out.observation.value!;
    expect(obs.knownState).toEqual({
      self: { troops: 200, tiles: 10, gold: 99, maxTroops: 500, alive: true, attacksInFlight: 1, structures: 1 },
      opponent: { troops: 300, tiles: 20, alive: true, attacksInFlight: 2, structures: 3 },
    });
    expect(obs.organizationContext).toEqual({ packId: 'pack', version: '1.0.0', role: 'commander' });
    expect(obs.availableTools).toEqual({ status: 'recorded', names: ['observe', 'submit_order'], omitted: 0 });
    expect(obs.domainKnowledge).toEqual({ status: 'native', requestId: 'native-request', groupId: 'group', facts: [{ id: 'fact', sourceIds: ['domain-source'], omittedSourceIds: 0 }], omittedFacts: 0 });
    expect(obs.omittedFields).toEqual(['resources', 'legal', 'objectives']);
    expect(JSON.stringify(out)).not.toMatch(/private-|recursive|999/);
  });

  it('bounds tool and retrieval metadata and makes absent state explicit', () => {
    const input = fixture(), o = input.events[0].details.observation;
    const absent = decisionTrace(input).observation.value!;
    expect(absent.knownState).toEqual({ self: null, opponent: null });
    expect(absent.organizationContext).toBeNull(); expect(absent.domainKnowledge).toBeNull();
    expect(absent.availableTools.status).toBe('missing');
    o.availableTools = Array.from({ length: 40 }, (_, i) => `tool-${i}`);
    o.domainKnowledge = { status: 'native', facts: Array.from({ length: 10 }, (_, i) => ({ id: `fact-${i}`, sourceIds: Array.from({ length: 12 }, (_, j) => `source-${j}`) })) };
    const out = decisionTrace(input).observation.value!;
    expect(out.availableTools.names).toHaveLength(32); expect(out.availableTools.omitted).toBe(8);
    expect(out.domainKnowledge?.facts).toHaveLength(8); expect(out.domainKnowledge?.omittedFacts).toBe(2);
    expect(out.domainKnowledge?.facts[0].sourceIds).toHaveLength(8); expect(out.domainKnowledge?.facts[0].omittedSourceIds).toBe(4);
  });

  it('is deterministic, does not mutate frozen input and bounds output with explicit omission counts', () => {
    const input = fixture(); input.reports = Array.from({ length: 70 }, (_, i) => report(`source-${i}`, 4));
    input.events[0].details.observation.reports = input.reports;
    input.events[0].summary = 's'.repeat(3000);
    input.events = input.events.slice(0, 3).concat(Array.from({ length: 70 }, (_, i) => event(`feedback-${i}`, 'execution_feedback', 9, { commandId: 'command', feedback: { tick: 8, status: 'transport-launched', observed: { kind: 'transport', troopsDelta: -1 } } })));
    const before = structuredClone(input);
    function freeze(value: unknown) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } }
    freeze(input);
    const out = decisionTrace(input);
    expect(input).toEqual(before);
    expect(out).toEqual(decisionTrace({ ...before, events: [...before.events].reverse(), reports: [...before.reports].reverse() }));
    expect(out.sources).toHaveLength(DECISION_TRACE_LIMITS.sources);
    expect(out.execution.value).toHaveLength(DECISION_TRACE_LIMITS.feedback);
    expect(out.omitted).toEqual({ sources: 6, feedback: 6 });
    expect(out.model.value?.externalSummary).toHaveLength(DECISION_TRACE_LIMITS.text);
  });
});
