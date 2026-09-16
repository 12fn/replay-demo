import { unwrapEvent, type ExecutionEvent } from './execution';

/** Output limits do not limit the search for duplicate identities. */
export const DECISION_TRACE_LIMITS = { sources: 64, feedback: 64, text: 2000, id: 512, tools: 32, domainFacts: 8, factSources: 8 } as const;
export interface DecisionTraceReport {
  id: string;
  /** Release tick, not the date/tick described by the source. */
  tick: number;
  side: 'blue' | 'red';
  title?: string;
  observedTick?: number;
  sourceExerciseId?: string | null;
  parentSourceId?: string;
  inherited?: boolean;
}
export interface DecisionTraceInput {
  /** Owning exercise of these authorized rows; supplies the namespace for legacy direct rows only. */
  exerciseId?: string;
  events: ExecutionEvent[];
  reports: DecisionTraceReport[];
  eventId: string;
  side: 'blue' | 'red';
  cutoffTick: number;
}
export interface TraceEvidence<T> {
  status: 'recorded' | 'missing' | 'ambiguous' | 'unavailable' | 'not-applicable';
  value: T | null;
  reason: string | null;
}
export interface TraceProvenance {
  eventId: string;
  tick: number;
  inherited: boolean;
  sourceExerciseId: string | null;
}
export interface TraceCommand extends TraceProvenance {
  commandId: string | null;
  admission: 'accepted' | 'rejected';
  origin: string | null;
  observedTick: number | null;
  admittedTick: number | null;
  observationBasis: string | null;
  intent: { type: string | null; unit: string | null; troops: number | null; dst: number | null; tile: number | null };
  rejectionReason: string | null;
}
export interface TraceSubmission extends TraceProvenance {
  tool: 'submit_order';
  commandId: string;
  receiptId: string | null;
  status: string | null;
  rejected: boolean;
  rejectionReason: string | null;
}
export interface TraceModelDecision extends TraceProvenance {
  actor: string | null;
  /** Recorded external summary, never receipt context, diagnostics or reasoning. */
  externalSummary: string | null;
  receipt: { id: string; status: string | null; modelRequested: string | null; modelReturned: string | null };
}
export interface TraceScriptedDecision extends TraceProvenance {
  controller: string | null;
  category: string | null;
  externalSummary: string | null;
}
export interface TraceObservation {
  recordedIn: TraceProvenance;
  link: 'inline' | 'pulse-completion-zero';
  pulseId: string | null;
  id: string | null;
  receiptHash: string | null;
  tick: number;
  fingerprint: string | null;
  basis: string | null;
  /** False means the record did not enumerate its report/source IDs. */
  sourceIdsRecorded: boolean;
  knownState: { self: TraceOwnTotals | null; opponent: TracePublicTotals | null };
  organizationContext: { packId: string; version: string; role: 'commander' | 'intelligence' | 'instructor' } | null;
  availableTools: { status: 'recorded' | 'missing'; names: string[]; omitted: number };
  domainKnowledge: TraceDomainRetrieval | null;
  /** Complex snapshots are intentionally omitted, even when present. */
  omittedFields: ('resources' | 'legal' | 'objectives')[];
}
export interface TracePublicTotals {
  troops: number | null;
  tiles: number | null;
  alive: boolean | null;
  attacksInFlight: number | null;
  structures: number | null;
}
export interface TraceOwnTotals extends TracePublicTotals { gold: number | null; maxTroops: number | null }
export interface TraceDomainRetrieval {
  status: 'native' | 'unavailable' | 'unknown';
  requestId: string | null;
  groupId: string | null;
  facts: { id: string | null; sourceIds: string[]; omittedSourceIds: number }[];
  omittedFacts: number;
}
export interface TraceSource {
  id: string;
  sourceExerciseId: string | null;
  references: ('observation' | 'external-summary')[];
  status: 'available-at-observation' | 'released-later' | 'observation-unknown' | 'missing' | 'ambiguous';
  report: { id: string; title: string | null; releaseTick: number; observedTick: number | null; inherited: boolean; parentSourceId: string | null } | null;
}
const numberFields = ['orderedTile', 'orderedTroops', 'troopsBefore', 'troopsAfter', 'troopsDelta', 'transportsAtSeaAtAttempt', 'transportLimit', 'unitId', 'launchTile', 'troopsEmbarked', 'targetTile', 'boatTile', 'movesObserved', 'newUnitsSeen', 'ticksObserved', 'goldBefore', 'goldAfter', 'goldDelta', 'costAtAttempt', 'structureTile'] as const;
const booleanFields = ['boatActive', 'retreatObserved', 'destroyedByEnemy', 'affordableAtAttempt', 'structureActive', 'underConstruction'] as const;
const stringFields = ['unit', 'ownerClientID', 'destroyerClientID', 'targetOwnerBefore', 'targetOwnerAfter'] as const;
export type TraceMeasuredFacts = { kind: 'construction' | 'transport' | 'observation-failure' }
  & Partial<Record<typeof numberFields[number], number>>
  & Partial<Record<typeof booleanFields[number], boolean>>
  & Partial<Record<typeof stringFields[number], string | null>>;
export interface TraceExecutionFeedback extends TraceProvenance {
  measuredTick: number | null;
  status: string;
  observed: TraceMeasuredFacts | null;
}
export interface DecisionTrace {
  schema: 'replay.decision-trace/1';
  eventId: string;
  side: 'blue' | 'red';
  cutoffTick: number;
  command: TraceEvidence<TraceCommand>;
  controller: 'human' | 'scripted' | 'model' | 'unknown';
  submission: TraceEvidence<TraceSubmission>;
  model: TraceEvidence<TraceModelDecision>;
  scripted: TraceEvidence<TraceScriptedDecision>;
  observation: TraceEvidence<TraceObservation>;
  execution: TraceEvidence<TraceExecutionFeedback[]>;
  sources: TraceSource[];
  omitted: { sources: number; feedback: number };
}

type Row = ReturnType<typeof unwrapEvent>;
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const id = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && v.length <= DECISION_TRACE_LIMITS.id ? v : null;
const text = (v: unknown): string | null => typeof v === 'string' ? v.slice(0, DECISION_TRACE_LIMITS.text) : null;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const tick = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const evidence = <T>(status: TraceEvidence<T>['status'], reason: string): TraceEvidence<T> => ({ status, value: null, reason });
const recorded = <T>(value: T): TraceEvidence<T> => ({ status: 'recorded', value, reason: null });
const namespace = (r: Row): string | null => id(r.sourceExerciseId);
const provenance = (r: Row): TraceProvenance => ({ eventId: r.id, tick: r.tick, inherited: r.inherited || r.details.inherited === true, sourceExerciseId: namespace(r) });
const compare = (a: { tick: number; id: string }, b: { tick: number; id: string }) => a.tick - b.tick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function one<T>(rows: Row[], project: (row: Row) => T, label: string): TraceEvidence<T> {
  if (!rows.length) return evidence('missing', `No exact recorded ${label} is available in this scope.`);
  if (rows.length !== 1) return evidence('ambiguous', `Multiple records have the same ${label} identity; none was selected.`);
  return recorded(project(rows[0]));
}
function measured(v: unknown): TraceMeasuredFacts | null {
  const o = object(v);
  if (!['construction', 'transport', 'observation-failure'].includes(String(o.kind))) return null;
  const out: TraceMeasuredFacts = { kind: o.kind as TraceMeasuredFacts['kind'] };
  for (const k of numberFields) if (number(o[k]) !== null) out[k] = o[k] as number;
  for (const k of booleanFields) if (typeof o[k] === 'boolean') out[k] = o[k];
  for (const k of stringFields) if (o[k] === null || typeof o[k] === 'string') out[k] = text(o[k]);
  return out;
}
function identifiers(v: unknown, limit: number): { values: string[]; omitted: number } {
  const values = Array.isArray(v) ? [...new Set(v.map(id).filter((v): v is string => v !== null))] : [];
  return { values: values.slice(0, limit), omitted: Math.max(0, values.length - limit) };
}
function totals(v: unknown, own: true): TraceOwnTotals | null;
function totals(v: unknown, own: false): TracePublicTotals | null;
function totals(v: unknown, own: boolean): TracePublicTotals | TraceOwnTotals | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const p = object(v);
  const publicTotals: TracePublicTotals = { troops: number(p.troops), tiles: number(p.tiles), alive: typeof p.alive === 'boolean' ? p.alive : null,
    attacksInFlight: own && Array.isArray(p.attacks) ? p.attacks.length : number(p.attacksInFlight),
    structures: own && Array.isArray(p.units) ? p.units.length : number(p.structures) };
  return own ? { ...publicTotals, gold: number(p.gold), maxTroops: number(p.maxTroops) } : publicTotals;
}
function organization(v: unknown): TraceObservation['organizationContext'] {
  const o = object(v), packId = id(o.packId), version = id(o.version);
  return packId && version && (o.role === 'commander' || o.role === 'intelligence' || o.role === 'instructor') ? { packId, version, role: o.role } : null;
}
function domain(v: unknown): TraceDomainRetrieval | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = object(v), facts = Array.isArray(d.facts) ? d.facts : [];
  return { status: d.status === 'native' || d.status === 'unavailable' ? d.status : 'unknown', requestId: id(d.requestId), groupId: id(d.groupId),
    facts: facts.slice(0, DECISION_TRACE_LIMITS.domainFacts).map(value => {
      const fact = object(value), sourceIds = identifiers(fact.sourceIds, DECISION_TRACE_LIMITS.factSources);
      return { id: id(fact.id), sourceIds: sourceIds.values, omittedSourceIds: sourceIds.omitted };
    }), omittedFacts: Math.max(0, facts.length - DECISION_TRACE_LIMITS.domainFacts) };
}

/** Pure, side/as-of bounded projection. Inherited namespaces are never inferred from the caller. */
export function decisionTrace(input: DecisionTraceInput): DecisionTrace {
  const { events, reports, eventId, side, cutoffTick } = input;
  const result: DecisionTrace = {
    schema: 'replay.decision-trace/1', eventId, side, cutoffTick,
    command: evidence('unavailable', 'Selected command is unavailable in this scope.'), controller: 'unknown',
    submission: evidence('unavailable', 'No unambiguous command link.'), model: evidence('unavailable', 'No unambiguous submission link.'),
    scripted: evidence('unavailable', 'No unambiguous command link.'), observation: evidence('missing', 'No exact observation was recorded.'),
    execution: evidence('unavailable', 'No unambiguous command link.'), sources: [], omitted: { sources: 0, feedback: 0 },
  };
  if (tick(cutoffTick) === null || !id(eventId) || !['blue', 'red'].includes(side) || input.exerciseId !== undefined && !id(input.exerciseId)) return result;
  // Filter before selecting or counting: unavailable records must not disclose their existence.
  const rows = events.filter(e => e.side === side && tick(e.tick) !== null && e.tick <= cutoffTick && id(e.id))
    .map(unwrapEvent).filter(e => e.kind !== 'inherited_event' && (e.sourceExerciseId == null || id(e.sourceExerciseId)))
    .map(e => ({ ...e, sourceExerciseId: e.sourceExerciseId ?? (!e.inherited && e.details.inherited !== true ? input.exerciseId : undefined) }));
  const selected = rows.filter(e => e.id === eventId);
  if (selected.length > 1) { result.command = evidence('ambiguous', 'Multiple visible records have the selected event ID.'); return result; }
  const command = selected[0];
  if (!command || !['command', 'command_rejected'].includes(command.kind)) return result;
  const d = object(command.details), intent = object(d.intent), commandId = id(d.commandId), ns = namespace(command);
  const origin = text(d.origin);
  result.command = recorded({ ...provenance(command), commandId, admission: command.kind === 'command' ? 'accepted' : 'rejected', origin,
    observedTick: tick(d.observedTick) !== null && (d.observedTick as number) <= command.tick ? tick(d.observedTick) : null,
    admittedTick: tick(d.admittedTick) !== null && (d.admittedTick as number) <= command.tick ? tick(d.admittedTick) : null,
    observationBasis: text(d.observationBasis),
    intent: { type: text(intent.type), unit: text(intent.unit), troops: number(intent.troops), dst: number(intent.dst), tile: number(intent.tile) },
    rejectionReason: command.kind === 'command_rejected' ? text(d.reason) : null,
  });
  result.controller = origin === 'human' ? 'human' : origin === 'luna' ? 'model' : origin?.startsWith('scripted') ? 'scripted' : 'unknown';
  const scope = rows.filter(e => namespace(e) === ns && (!(e.inherited || e.details.inherited === true) || namespace(e) !== null));
  if ((command.inherited || d.inherited === true) && ns === null) {
    const reason = 'Inherited command source namespace was not recorded; the owning exercise is not a substitute.';
    result.submission = evidence('missing', reason); result.scripted = evidence('missing', reason); result.execution = evidence('missing', reason);
    return result;
  }
  const duplicates = commandId ? scope.filter(e => ['command', 'command_rejected'].includes(e.kind) && id(e.details.commandId) === commandId) : [];
  if (!commandId || duplicates.length !== 1) {
    const status = commandId ? 'ambiguous' : 'missing';
    const reason = commandId ? 'Command ID identifies multiple command records in this namespace.' : 'Command ID was not recorded.';
    result.submission = evidence(status, reason); result.scripted = evidence(status, reason); result.execution = evidence(status, reason);
    return result;
  }
  const submissions = scope.filter(e => e.kind === 'tool_result' && e.details.tool === 'submit_order' && id(object(e.details.output).id) === commandId);
  result.submission = one(submissions, e => {
    const output = object(e.details.output);
    return { ...provenance(e), tool: 'submit_order' as const, commandId, receiptId: id(e.details.receiptId), status: text(output.status), rejected: output.rejected === true, rejectionReason: output.rejected === true ? text(output.reason) : null };
  }, 'submit_order output.id');
  const receiptId = result.submission.value?.receiptId;
  const models = receiptId ? scope.filter(e => e.kind === 'model_decision' && id(object(e.details.receipt).id) === receiptId) : [];
  if (result.submission.status === 'recorded') result.model = one(models, e => {
    const receipt = object(e.details.receipt);
    return { ...provenance(e), actor: id(e.actor), externalSummary: text(e.summary), receipt: { id: receiptId!, status: text(receipt.status), modelRequested: text(receipt.modelRequested), modelReturned: text(receipt.modelReturned) } };
  }, 'model receipt.id');
  const scripts = scope.filter(e => e.kind === 'scripted_decision' && id(e.details.commandId) === commandId);
  result.scripted = one(scripts, e => ({ ...provenance(e), controller: text(e.details.controller), category: text(e.details.category), externalSummary: text(e.summary) }), 'scripted commandId');
  if (result.controller === 'unknown') {
    if (result.model.value && !scripts.length) result.controller = 'model';
    else if (result.scripted.value && !submissions.length) result.controller = 'scripted';
  }
  if (result.controller === 'human' || result.controller === 'scripted') {
    if (!submissions.length) result.submission = evidence('not-applicable', 'No model submission is recorded for this controller.');
    if (!submissions.length) result.model = evidence('not-applicable', 'No model decision is recorded for this controller.');
  }
  if (result.controller !== 'scripted' && !scripts.length) result.scripted = evidence('not-applicable', 'No deterministic decision is recorded.');

  // priorResultsOf alone is not an identity link. Only new, explicitly pulse-stamped records can
  // resolve completion zero. Do not use actor, tick, completion index alone, or receipt context.
  let observationRow = result.model.value ? models[0] : result.controller === 'human' || result.controller === 'scripted' ? command : null;
  let observationLink: TraceObservation['link'] = 'inline';
  const model = result.model.value ? models[0] : null;
  const pulseId = id(model?.details.pulseId);
  if (model && tick(object(model.details.observation).tick) === null && pulseId && tick(model.details.completion) !== null
    && model.details.completion > 0 && object(model.details.observation).priorResultsOf === model.details.completion - 1) {
    const anchors = scope.filter(e => e.kind === 'model_decision' && id(e.details.pulseId) === pulseId && e.details.completion === 0);
    observationRow = anchors.length === 1 ? anchors[0] : null;
    observationLink = 'pulse-completion-zero';
    if (anchors.length > 1) result.observation = evidence('ambiguous', 'Multiple completion-zero observations have the same pulse identity.');
  }
  const o = object(observationRow?.details.observation);
  const observationTick = tick(o.tick);
  const observationSide = o.side ?? object(o.self).side ?? object(o.player).side;
  if (observationRow && observationTick !== null && observationTick <= observationRow.tick && observationTick <= (model?.tick ?? command.tick) && observationTick <= cutoffTick && (observationSide == null || observationSide === side)) {
    const availableTools = identifiers(o.availableTools, DECISION_TRACE_LIMITS.tools);
    const opponentSide = object(o.opponent).side;
    result.observation = recorded({ recordedIn: provenance(observationRow), link: observationLink, pulseId, id: id(o.id), receiptHash: id(o.receiptHash), tick: observationTick,
      fingerprint: id(o.fingerprint), basis: text(o.basis), sourceIdsRecorded: Array.isArray(o.reports) || Array.isArray(o.sourceIds),
      knownState: { self: totals(o.self ?? o.player, true), opponent: opponentSide == null || opponentSide === (side === 'blue' ? 'red' : 'blue') ? totals(o.opponent, false) : null },
      organizationContext: organization(o.organizationContext),
      availableTools: { status: Array.isArray(o.availableTools) ? 'recorded' : 'missing', names: availableTools.values, omitted: availableTools.omitted },
      domainKnowledge: domain(o.domainKnowledge),
      omittedFields: (['resources', 'legal', 'objectives'] as const).filter(k => o[k] !== undefined),
    });
  }
  const references = new Map<string, Set<'observation' | 'external-summary'>>();
  const add = (v: unknown, role: 'observation' | 'external-summary') => {
    const key = id(v); if (!key) return;
    const roles = references.get(key) ?? new Set(); roles.add(role); references.set(key, roles);
  };
  if (result.observation.value) {
    if (Array.isArray(o.reports)) for (const r of o.reports) add(object(r).id, 'observation');
    if (Array.isArray(o.sourceIds)) for (const sourceId of o.sourceIds) add(sourceId, 'observation');
  }
  if (result.model.value && Array.isArray(models[0].details.sourceIds)) for (const sourceId of models[0].details.sourceIds) add(sourceId, 'external-summary');
  const sourceRows = reports.filter(r => r.side === side && tick(r.tick) !== null && r.tick <= cutoffTick && id(r.id)
    && (r.sourceExerciseId == null || id(r.sourceExerciseId))
    && (!(r.inherited || r.parentSourceId) || id(r.sourceExerciseId) !== null)
    && (id(r.sourceExerciseId) ?? (!(r.inherited || r.parentSourceId) ? id(input.exerciseId) : null)) === ns);
  const grouped = new Map<string, DecisionTraceReport[]>();
  for (const r of sourceRows) {
    // A remapped copy can resolve its recorded parent ID only with the same explicit origin namespace.
    const key = ns !== null && id(r.parentSourceId) && references.has(r.parentSourceId!) ? r.parentSourceId! : r.id;
    const group = grouped.get(key) ?? []; group.push(r); grouped.set(key, group);
  }
  const keys = [...new Set([...references.keys(), ...grouped.keys()])].sort((a, b) => {
    const priority = Number(references.has(b)) - Number(references.has(a));
    return priority || (a < b ? -1 : a > b ? 1 : 0);
  });
  result.omitted.sources = Math.max(0, keys.length - DECISION_TRACE_LIMITS.sources);
  result.sources = keys.slice(0, DECISION_TRACE_LIMITS.sources).map(key => {
    const candidates = grouped.get(key) ?? [], r = candidates.length === 1 ? candidates[0] : null;
    const observedAt = result.observation.value?.tick;
    return { id: key, sourceExerciseId: ns, references: [...(references.get(key) ?? [])],
      status: candidates.length > 1 ? 'ambiguous' : !r ? 'missing' : observedAt === undefined ? 'observation-unknown' : r.tick <= observedAt ? 'available-at-observation' : 'released-later',
      report: r ? { id: r.id, title: text(r.title), releaseTick: r.tick, observedTick: tick(r.observedTick), inherited: r.inherited === true || !!r.parentSourceId, parentSourceId: id(r.parentSourceId) } : null };
  });
  const feedback = scope.filter(e => e.kind === 'execution_feedback' && id(e.details.commandId) === commandId)
    .filter(e => { const measuredTick = object(e.details.feedback).tick; return measuredTick === undefined || tick(measuredTick) !== null && (measuredTick as number) <= e.tick && (measuredTick as number) <= cutoffTick; }).sort(compare);
  if (new Set(feedback.map(e => e.id)).size !== feedback.length) result.execution = evidence('ambiguous', 'Multiple feedback records have the same event identity.');
  else if (!feedback.length) result.execution = evidence('missing', 'No measured execution feedback is recorded by this cutoff; admission does not establish an effect.');
  else {
    result.omitted.feedback = Math.max(0, feedback.length - DECISION_TRACE_LIMITS.feedback);
    result.execution = recorded(feedback.slice(-DECISION_TRACE_LIMITS.feedback).map(e => {
      const f = object(e.details.feedback);
      return { ...provenance(e), measuredTick: tick(f.tick), status: text(f.status) ?? 'unknown', observed: measured(f.observed) };
    }));
  }
  return result;
}
