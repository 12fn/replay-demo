import type { PracticeHistoryItem, PracticeHistoryResult } from './practice-history-types';

/**
 * Evidence-led observations over ONE already-authorized practice-history page.
 *
 * Pure and deterministic: no I/O, no model calls, no mutation of the input.
 * Everything is a count or a citation of a returned record. Nothing here
 * describes personality, competence, causation, attention or mastery, and no
 * output is a complete learner history: the page is a bounded action search.
 */
export const PRACTICE_OBSERVATIONS_SCHEMA = 'replay.practice-observations/1' as const;

export const PRACTICE_OBSERVATIONS_NOTICE =
  'Descriptive observations of one returned practice-history page only; more records may exist outside this page, query or catalog bound. ' +
  'Groups differ by actor, seat, lineage, scenario, version, map, simulation, curriculum or assistance and are not compared or ranked. ' +
  'Not observed means absent from these records, not a weakness. No score, ranking, attention, learning or difficulty judgment is made.';

/** Kinds the upstream projection selects; anything else (for example `inherited_event`) is never a new act. */
export const OBSERVED_KINDS = ['command', 'assessment_log', 'task_created', 'decision_log'] as const;
export type ObservedKind = typeof OBSERVED_KINDS[number];

/** Metadata that must be declared and equal before records from different exercises share a group. */
export const COMPATIBILITY_FIELDS = ['scenarioId', 'scenarioVersion', 'map', 'simulationProfile', 'curriculumVersion', 'assistance'] as const;
export type CompatibilityField = typeof COMPATIBILITY_FIELDS[number] | 'seat';

export interface ObservationCitation {
  eventId: string;
  exerciseId: string;
  sequence: number;
  /** Tick the record was admitted at. */
  tick: number;
  /** Tick the participant was viewing; null when not recorded. */
  observedTick: number | null;
  recordedAt: string;
}
export interface SourceCitation extends ObservationCitation { sourceIds: string[] }

export type ObservationExclusionReason = 'not-completed' | 'unattributed' | 'not-observed-kind' | 'invalid-record' | 'conflicting-duplicate' | 'conflicting-exercise-metadata';
export interface ObservationExclusion { eventId: string; exerciseId: string; sequence: number; reason: ObservationExclusionReason }
export interface DuplicateRecord { eventId: string; exerciseId: string; copies: number; resolution: 'identical-counted-once' | 'conflicting-excluded' }

export interface ObservationProvenance {
  sourceSchema: PracticeHistoryResult['schema'];
  basis: 'returned-page-only';
  exhaustive: false;
  scope: PracticeHistoryResult['scope'];
  query: string;
  returnedItems: number;
  observedItems: number;
  /** Min/max global sequence of observed items; null when nothing was observed. */
  sequenceRange: { first: number; last: number } | null;
  hasMore: boolean;
  nextBeforeSequence: number | null;
  exerciseCatalogTruncated: boolean;
  eligibleExercises: number;
  maxPageSize: number;
  /** Known reasons records exist outside this page. Empty does NOT mean complete: see `unrecordedInputs`. */
  knownTruncation: Array<'has-more' | 'exercise-catalog-truncated' | 'text-query'>;
  /** Request inputs the history result does not echo, so an earlier cursor or scenario filter cannot be ruled out. */
  unrecordedInputs: ['beforeSequence', 'scenarioId', 'limit'];
}

export interface CommitmentDistribution {
  basis: 'finite-ratio-in-0-1';
  sampleSize: number;
  /** Commands whose recorded ratio was null, non-finite or outside [0,1]. */
  notObserved: number;
  range: { min: number; median: number; max: number } | null;
  values: Array<{ ratio: number; citation: ObservationCitation }>;
}

export interface ObservationGroup {
  key: string;
  basis: 'returned-page-only';
  exhaustive: false;
  actor: string;
  seat: string | null;
  lineage: 'original' | 'branch';
  exerciseKind: string;
  compatibility: Pick<PracticeHistoryItem['exercise'], typeof COMPATIBILITY_FIELDS[number]> & {
    status: 'declared' | 'isolated-to-exercise';
    missing: CompatibilityField[];
  };
  exercises: Array<Pick<PracticeHistoryItem['exercise'], 'id' | 'kind' | 'createdAt' | 'parentId' | 'forkTick'>>;
  sampleSize: { items: number; exercises: number; commands: number; assessments: number; watches: number; decisionLogs: number };
  commitment: CommitmentDistribution;
  commands: {
    recordedReason: { observed: ObservationCitation[]; notObserved: ObservationCitation[] };
    sourceCitations: { observed: SourceCitation[]; notObserved: ObservationCitation[] };
  };
  assessments: SourceCitation[];
  watches: ObservationCitation[];
  decisionLogs: ObservationCitation[];
  notObserved: string[];
}

export interface PracticeObservations {
  schema: typeof PRACTICE_OBSERVATIONS_SCHEMA;
  fiction: true;
  provenance: ObservationProvenance;
  groups: ObservationGroup[];
  excluded: ObservationExclusion[];
  duplicates: DuplicateRecord[];
  notice: string;
}

/** Code-point order, independent of the host locale. */
const cmp = (a: unknown, b: unknown) => { const x = String(a), y = String(b); return x < y ? -1 : x > y ? 1 : 0; };
const bySequence = (a: { sequence: number; eventId: string }, b: { sequence: number; eventId: string }) => a.sequence - b.sequence || cmp(a.eventId, b.eventId);

/** Key-order-independent serialization used only to compare two copies of a record. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function citationOf(item: PracticeHistoryItem): ObservationCitation {
  const observed = item.observedTick;
  return {
    eventId: item.eventId, exerciseId: item.exercise.id, sequence: item.sequence, tick: item.tick,
    observedTick: typeof observed === 'number' && Number.isFinite(observed) ? observed : null, recordedAt: item.recordedAt,
  };
}

const sourced = (item: PracticeHistoryItem): SourceCitation => ({ ...citationOf(item), sourceIds: [...item.sourceIds] });

/** Why a returned record is not observed, or null when it is an attributable, completed, projected act. */
export function exclusionReason(item: PracticeHistoryItem): ObservationExclusionReason | null {
  if (!Number.isSafeInteger(item.sequence) || !Number.isFinite(item.tick) || !item.eventId || !item.exercise?.id) return 'invalid-record';
  if (item.exercise.status !== 'completed') return 'not-completed';
  if (typeof item.actor !== 'string' || !item.actor.trim()) return 'unattributed';
  if (!(OBSERVED_KINDS as readonly string[]).includes(item.kind)) return 'not-observed-kind';
  return null;
}

/** Undeclared compatibility metadata. Any gap isolates the group to its own exercise. */
export function missingCompatibility(item: PracticeHistoryItem): CompatibilityField[] {
  const missing: CompatibilityField[] = COMPATIBILITY_FIELDS.filter(f => item.exercise[f] === null || item.exercise[f] === '' || item.exercise[f] === 'unknown');
  if (!item.side) missing.push('seat');
  return missing;
}

export function groupKeyOf(item: PracticeHistoryItem): string {
  const e = item.exercise, isolated = missingCompatibility(item).length ? e.id : null;
  return JSON.stringify([item.actor, item.side, lineageOf(e), e.kind, ...COMPATIBILITY_FIELDS.map(f => e[f]), isolated]);
}

const lineageOf = (e: PracticeHistoryItem['exercise']): 'original' | 'branch' =>
  e.kind === 'branch' || e.parentId !== null || e.forkTick !== null ? 'branch' : 'original';

/** Commitment ratios on commands, kept only when finite and within [0,1]. */
export function commitmentDistribution(commands: PracticeHistoryItem[]): CommitmentDistribution {
  const values = commands
    .filter(c => typeof c.commitmentRatio === 'number' && Number.isFinite(c.commitmentRatio) && c.commitmentRatio >= 0 && c.commitmentRatio <= 1)
    .map(c => ({ ratio: c.commitmentRatio as number, citation: citationOf(c) }))
    .sort((a, b) => a.ratio - b.ratio || bySequence(a.citation, b.citation));
  const r = values.map(v => v.ratio), mid = Math.floor(r.length / 2);
  const median = r.length % 2 ? r[mid] : (r[mid - 1] + r[mid]) / 2;
  return { basis: 'finite-ratio-in-0-1', sampleSize: values.length, notObserved: commands.length - values.length, range: r.length ? { min: r[0], median, max: r[r.length - 1] } : null, values };
}

/**
 * Deduplicate event IDs within an exercise. Identical copies count once;
 * copies that disagree are all excluded, because neither can be trusted.
 * Records in one exercise that disagree on exercise metadata are excluded too.
 */
export function reconcileItems(items: readonly PracticeHistoryItem[]): { kept: PracticeHistoryItem[]; excluded: ObservationExclusion[]; duplicates: DuplicateRecord[] } {
  const byEvent = new Map<string, PracticeHistoryItem[]>(), exerciseShape = new Map<string, Set<string>>();
  for (const item of items) {
    const key = JSON.stringify([item.exercise?.id, item.eventId]);
    byEvent.set(key, [...(byEvent.get(key) ?? []), item]);
    if (item.exercise?.id) exerciseShape.set(item.exercise.id, (exerciseShape.get(item.exercise.id) ?? new Set()).add(canonical(item.exercise)));
  }
  const kept: PracticeHistoryItem[] = [], excluded: ObservationExclusion[] = [], duplicates: DuplicateRecord[] = [];
  const exclude = (i: PracticeHistoryItem, reason: ObservationExclusionReason) => excluded.push({ eventId: i.eventId, exerciseId: i.exercise?.id, sequence: i.sequence, reason });
  for (const copies of byEvent.values()) {
    const first = copies[0], identical = copies.every(c => canonical(c) === canonical(first));
    if (copies.length > 1) duplicates.push({ eventId: first.eventId, exerciseId: first.exercise?.id, copies: copies.length, resolution: identical ? 'identical-counted-once' : 'conflicting-excluded' });
    if (!identical) copies.forEach(c => exclude(c, 'conflicting-duplicate'));
    else if ((exerciseShape.get(first.exercise?.id)?.size ?? 0) > 1) exclude(first, 'conflicting-exercise-metadata');
    else kept.push(first);
  }
  duplicates.sort((a, b) => cmp(a.exerciseId, b.exerciseId) || cmp(a.eventId, b.eventId));
  return { kept, excluded, duplicates };
}

function buildGroup(key: string, items: PracticeHistoryItem[]): ObservationGroup {
  const [first] = items, e = first.exercise, missing = missingCompatibility(first);
  const ofKind = (k: ObservedKind) => items.filter(i => i.kind === k);
  const commands = ofKind('command'), assessments = ofKind('assessment_log'), watches = ofKind('task_created'), decisionLogs = ofKind('decision_log');
  const exercises = [...new Map(items.map(i => [i.exercise.id, i.exercise])).values()]
    .map(({ id, kind, createdAt, parentId, forkTick }) => ({ id, kind, createdAt, parentId, forkTick }))
    .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const commitment = commitmentDistribution(commands);
  const group: ObservationGroup = {
    key, basis: 'returned-page-only', exhaustive: false, actor: first.actor, seat: first.side, lineage: lineageOf(e), exerciseKind: e.kind,
    compatibility: { scenarioId: e.scenarioId, scenarioVersion: e.scenarioVersion, map: e.map, simulationProfile: e.simulationProfile, curriculumVersion: e.curriculumVersion, assistance: e.assistance, status: missing.length ? 'isolated-to-exercise' : 'declared', missing },
    exercises,
    sampleSize: { items: items.length, exercises: exercises.length, commands: commands.length, assessments: assessments.length, watches: watches.length, decisionLogs: decisionLogs.length },
    commitment,
    commands: {
      recordedReason: { observed: commands.filter(c => c.rationaleRecorded === true).map(citationOf), notObserved: commands.filter(c => c.rationaleRecorded !== true).map(citationOf) },
      sourceCitations: { observed: commands.filter(c => c.sourceIds.length > 0).map(sourced), notObserved: commands.filter(c => c.sourceIds.length === 0).map(citationOf) },
    },
    assessments: assessments.map(sourced), watches: watches.map(citationOf), decisionLogs: decisionLogs.map(citationOf), notObserved: [],
  };
  const gaps: Array<[string, number]> = [
    ['commands', commands.length], ['commitment ratio in [0,1]', commitment.sampleSize], ['recorded command reason', group.commands.recordedReason.observed.length],
    ['command source citation', group.commands.sourceCitations.observed.length], ['assessments', assessments.length], ['watches', watches.length],
    ['decision log entries', decisionLogs.length], ['observed tick', items.filter(i => citationOf(i).observedTick !== null).length],
  ];
  group.notObserved = gaps.filter(([, n]) => n === 0).map(([label]) => label);
  return group;
}

/** Project an already-authorized practice-history page into grouped, cited observations. The input is not modified. */
export function observePracticeHistory(result: PracticeHistoryResult): PracticeObservations {
  const reconciled = reconcileItems(result.items), excluded = [...reconciled.excluded], observed: PracticeHistoryItem[] = [];
  for (const item of reconciled.kept) {
    const reason = exclusionReason(item);
    if (reason) excluded.push({ eventId: item.eventId, exerciseId: item.exercise?.id, sequence: item.sequence, reason });
    else observed.push(item);
  }
  observed.sort(bySequence);
  excluded.sort((a, b) => bySequence(a, b) || cmp(a.exerciseId, b.exerciseId) || cmp(a.reason, b.reason));
  const grouped = new Map<string, PracticeHistoryItem[]>();
  for (const item of observed) { const key = groupKeyOf(item); grouped.set(key, [...(grouped.get(key) ?? []), item]); }
  const groups = [...grouped].sort(([a], [b]) => cmp(a, b)).map(([key, items]) => buildGroup(key, items));
  return {
    schema: PRACTICE_OBSERVATIONS_SCHEMA, fiction: true,
    provenance: {
      sourceSchema: result.schema, basis: 'returned-page-only', exhaustive: false, scope: result.scope, query: result.query,
      returnedItems: result.items.length, observedItems: observed.length,
      sequenceRange: observed.length ? { first: observed[0].sequence, last: observed[observed.length - 1].sequence } : null,
      hasMore: result.hasMore, nextBeforeSequence: result.nextBeforeSequence,
      exerciseCatalogTruncated: result.limits.exerciseCatalogTruncated, eligibleExercises: result.limits.eligibleExercises, maxPageSize: result.limits.maxPageSize,
      knownTruncation: [
        ...(result.hasMore ? ['has-more' as const] : []), ...(result.limits.exerciseCatalogTruncated ? ['exercise-catalog-truncated' as const] : []), ...(result.query ? ['text-query' as const] : []),
      ],
      unrecordedInputs: ['beforeSequence', 'scenarioId', 'limit'],
    },
    groups, excluded, duplicates: reconciled.duplicates, notice: PRACTICE_OBSERVATIONS_NOTICE,
  };
}
