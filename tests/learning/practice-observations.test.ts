import { describe, expect, it } from 'vitest';
import type { PracticeHistoryItem, PracticeHistoryResult } from '../../src/learning/practice-history-types';
import { commitmentDistribution, groupKeyOf, missingCompatibility, observePracticeHistory, reconcileItems, type ObservationGroup } from '../../src/learning/practice-observations';

type Exercise = PracticeHistoryItem['exercise'];
const exercise = (id: string, over: Partial<Exercise> = {}): Exercise => ({
  id, name: `Name of ${id}`, kind: 'recorded', status: 'completed', createdAt: '2026-09-01T00:00:00Z', scenarioId: 'station-practice', scenarioVersion: 'crosscurrent-objectives/1',
  map: 'world-500', simulationProfile: 'naval-isolation/1', curriculumVersion: '0.1.0', assistance: 'unassisted', parentId: null, forkTick: null, ...over,
});
let seq = 0;
const item = (ex: Exercise, over: Partial<PracticeHistoryItem> = {}): PracticeHistoryItem => {
  seq += 1;
  return { eventId: `ev-${seq}`, sequence: seq * 10, tick: 20 + seq, observedTick: 18 + seq, recordedAt: `2026-09-01T00:00:${String(seq).padStart(2, '0')}Z`, kind: 'command', actor: 'alice', side: 'blue', summary: 'Choice', exercise: ex, sourceIds: ['report-a'], commitmentRatio: 0.4, rationaleRecorded: true, ...over };
};
const page = (items: PracticeHistoryItem[], over: Partial<PracticeHistoryResult> = {}): PracticeHistoryResult => ({
  schema: 'replay.practice-history/1', scope: 'workroom', fiction: true, query: '', items, nextBeforeSequence: null, hasMore: false, scenarios: [{ id: 'station-practice', name: 'station-practice' }],
  summary: { basis: 'returned-page-only', commands: 99, assessments: 99, watches: 99, commandsCitingSources: 99, commandsWithRecordedReason: 99, branchEvents: 99 },
  limits: { maxPageSize: 50, eligibleExercises: 3, exerciseCatalogTruncated: false }, notice: 'upstream notice text', ...over,
});
const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); } return out; };
const only = (groups: ObservationGroup[], pred: (g: ObservationGroup) => boolean) => { const found = groups.filter(pred); expect(found).toHaveLength(1); return found[0]; };

describe('practice observations over one authorized history page', () => {
  it('keeps recorded branch ancestry separate even when the exercise kind is a legacy value', () => {
    const original = item(exercise('original'));
    const branch = item(exercise('branch-with-parent', { parentId: 'original', forkTick: 12 }));
    const hiddenParent = item(exercise('branch-hidden-parent', { forkTick: 12 }));
    const out = observePracticeHistory(page([original, branch, hiddenParent]));
    expect(out.groups).toHaveLength(2);
    expect(out.groups.find(g => g.lineage === 'original')?.sampleSize.exercises).toBe(1);
    expect(out.groups.find(g => g.lineage === 'branch')?.sampleSize.exercises).toBe(2);
  });
  it('separates actors, seats, assistance, lineage and versions; never shares one actor\'s text with another group', () => {
    const a = exercise('ex-a'), b = exercise('ex-b', { createdAt: '2026-09-02T00:00:00Z' }), assisted = exercise('ex-assisted', { assistance: 'staff-assisted' });
    const v2 = exercise('ex-v2', { scenarioVersion: 'crosscurrent-objectives/2' }), branch = exercise('ex-branch', { kind: 'branch', parentId: 'ex-a', forkTick: 12 });
    const items = [
      item(a), item(b, { commitmentRatio: 0.6, rationaleRecorded: false, sourceIds: [] }), item(a, { actor: 'bob', kind: 'assessment_log', summary: 'bob private narrative', sourceIds: ['report-b'] }),
      item(a, { side: 'red', actor: 'alice' }), item(assisted), item(v2), item(branch, { summary: 'alice branch note' }),
    ];
    const out = observePracticeHistory(page(items));
    expect(out.groups).toHaveLength(6);
    const alice = only(out.groups, g => g.actor === 'alice' && g.seat === 'blue' && g.lineage === 'original' && g.compatibility.assistance === 'unassisted' && g.compatibility.scenarioVersion === 'crosscurrent-objectives/1');
    expect(alice.exercises.map(e => e.id)).toEqual(['ex-a', 'ex-b']);
    expect(alice.compatibility).toMatchObject({ status: 'declared', missing: [] });
    expect(alice.sampleSize).toEqual({ items: 2, exercises: 2, commands: 2, assessments: 0, watches: 0, decisionLogs: 0 });
    const bob = only(out.groups, g => g.actor === 'bob');
    expect(bob.assessments).toEqual([expect.objectContaining({ exerciseId: 'ex-a', sourceIds: ['report-b'] })]);
    expect(only(out.groups, g => g.lineage === 'branch').exercises).toEqual([{ id: 'ex-branch', kind: 'branch', createdAt: '2026-09-01T00:00:00Z', parentId: 'ex-a', forkTick: 12 }]);
    const json = JSON.stringify(out);
    for (const text of ['bob private narrative', 'alice branch note', 'Choice', 'Name of ex-a', 'upstream notice text']) expect(json).not.toContain(text);
    expect(out.groups.every(g => g.basis === 'returned-page-only' && g.exhaustive === false)).toBe(true);
  });

  it('isolates records with missing or unknown compatibility metadata to their own exercise', () => {
    const noVersion1 = exercise('ex-1', { scenarioVersion: null }), noVersion2 = exercise('ex-2', { scenarioVersion: null }), unknownAssist = exercise('ex-3', { assistance: 'unknown' });
    const items = [item(noVersion1), item(noVersion1), item(noVersion2), item(unknownAssist), item(unknownAssist, { exercise: exercise('ex-4', { assistance: 'unknown' }) }), item(exercise('ex-5'), { side: null, kind: 'task_created' })];
    const out = observePracticeHistory(page(items));
    expect(out.groups.map(g => g.exercises.map(e => e.id))).toEqual(expect.arrayContaining([['ex-1'], ['ex-2'], ['ex-3'], ['ex-4'], ['ex-5']]));
    expect(out.groups).toHaveLength(5);
    expect(only(out.groups, g => g.exercises[0].id === 'ex-1')).toMatchObject({ sampleSize: { items: 2 }, compatibility: { status: 'isolated-to-exercise', missing: ['scenarioVersion'] } });
    expect(missingCompatibility(items[5])).toEqual(['seat']);
    expect(groupKeyOf(items[0])).toBe(groupKeyOf(items[1]));
    expect(groupKeyOf(items[0])).not.toBe(groupKeyOf(items[2]));
  });

  it('counts only attributable completed projected acts and never counts inherited branch history as new', () => {
    const branch = exercise('ex-branch', { kind: 'branch', parentId: 'ex-p', forkTick: 5 });
    const items = [item(branch), item(branch, { kind: 'inherited_event' }), item(branch, { actor: '' }), item(exercise('ex-live', { kind: 'live', status: 'running' })), item(branch, { kind: 'model_decision' }), item(branch, { sequence: Number.NaN })];
    const out = observePracticeHistory(page(items));
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].sampleSize.items).toBe(1);
    expect(out.excluded.map(e => e.reason).sort()).toEqual(['invalid-record', 'not-completed', 'not-observed-kind', 'not-observed-kind', 'unattributed']);
    expect(out.provenance).toMatchObject({ returnedItems: 6, observedItems: 1 });
  });

  it('deduplicates identical event IDs within an exercise and excludes every copy of a conflicting duplicate', () => {
    const a = exercise('ex-a'), b = exercise('ex-b');
    const base = item(a, { eventId: 'dup' }), conflict = item(a, { eventId: 'clash' });
    const items = [base, { ...base, exercise: { ...a } }, item(b, { eventId: 'dup' }), conflict, { ...conflict, commitmentRatio: 0.9 }, item(a, { eventId: 'meta', exercise: { ...a, map: 'other' } })];
    const reconciled = reconcileItems(items);
    expect(reconciled.kept.map(i => `${i.exercise.id}/${i.eventId}`)).toEqual(['ex-b/dup']);
    const out = observePracticeHistory(page(items));
    expect(out.duplicates).toEqual([
      { eventId: 'clash', exerciseId: 'ex-a', copies: 2, resolution: 'conflicting-excluded' },
      { eventId: 'dup', exerciseId: 'ex-a', copies: 2, resolution: 'identical-counted-once' },
    ]);
    // Exercise ex-a carries two metadata shapes on this page, so none of its records are grouped.
    expect(out.excluded.filter(e => e.reason === 'conflicting-duplicate')).toHaveLength(2);
    expect(out.excluded.filter(e => e.reason === 'conflicting-exercise-metadata').map(e => e.eventId).sort()).toEqual(['dup', 'meta']);
    expect(out.groups.flatMap(g => g.exercises.map(e => e.id))).toEqual(['ex-b']);
    const clean = observePracticeHistory(page([base, { ...base }, item(b, { eventId: 'dup' })]));
    expect(clean.groups[0].sampleSize).toMatchObject({ items: 2, exercises: 2 });
  });

  it('carries page provenance and truncation on every output, including an empty page', () => {
    const out = observePracticeHistory(page([item(exercise('ex-a'))], { hasMore: true, nextBeforeSequence: 10, query: 'reserve', limits: { maxPageSize: 50, eligibleExercises: 1000, exerciseCatalogTruncated: true } }));
    expect(out.provenance).toMatchObject({ basis: 'returned-page-only', exhaustive: false, scope: 'workroom', query: 'reserve', hasMore: true, nextBeforeSequence: 10, knownTruncation: ['has-more', 'exercise-catalog-truncated', 'text-query'], unrecordedInputs: ['beforeSequence', 'scenarioId', 'limit'] });
    const empty = observePracticeHistory(page([], { scope: 'mine' }));
    expect(empty).toMatchObject({ groups: [], excluded: [], duplicates: [], provenance: { exhaustive: false, knownTruncation: [], sequenceRange: null, observedItems: 0 } });
    expect(empty.notice).toMatch(/returned practice-history page only/);
  });

  it('keeps commitment distribution to finite ratios in [0,1] and reports the rest as not observed', () => {
    const ex = exercise('ex-a');
    const commands = [0.75, 0, 1, null, 1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 0.25].map(r => item(ex, { commitmentRatio: r }));
    const dist = commitmentDistribution(commands);
    expect(dist.values.map(v => v.ratio)).toEqual([0, 0.25, 0.75, 1]);
    expect(dist).toMatchObject({ sampleSize: 4, notObserved: 5, range: { min: 0, median: 0.5, max: 1 } });
    expect(commitmentDistribution([item(ex, { commitmentRatio: 0.3 })]).range).toEqual({ min: 0.3, median: 0.3, max: 0.3 });
    const assessmentOnly = observePracticeHistory(page([item(ex, { kind: 'assessment_log', commitmentRatio: 0.5 })])).groups[0];
    expect(assessmentOnly.commitment).toMatchObject({ sampleSize: 0, range: null, values: [] });
    expect(assessmentOnly.notObserved).toEqual(expect.arrayContaining(['commands', 'commitment ratio in [0,1]', 'recorded command reason', 'command source citation', 'watches', 'decision log entries']));
  });

  it('joins exact citations for reasons, sources, assessments, watches and decision logs in record order', () => {
    const ex = exercise('ex-a');
    const later = item(ex, { eventId: 'c-late', sequence: 500, rationaleRecorded: false, sourceIds: [], observedTick: null });
    const early = item(ex, { eventId: 'c-early', sequence: 100, tick: 40, observedTick: 36, sourceIds: ['r-1', 'r-2'] });
    const watch = item(ex, { eventId: 'w', sequence: 300, kind: 'task_created', sourceIds: [] });
    const log = item(ex, { eventId: 'd', sequence: 400, kind: 'decision_log' });
    const assess = item(ex, { eventId: 'as', sequence: 200, kind: 'assessment_log', sourceIds: ['r-3'] });
    const g = observePracticeHistory(page([later, log, watch, assess, early])).groups[0];
    expect(g.commands.recordedReason.observed).toEqual([{ eventId: 'c-early', exerciseId: 'ex-a', sequence: 100, tick: 40, observedTick: 36, recordedAt: early.recordedAt }]);
    expect(g.commands.recordedReason.notObserved.map(c => [c.eventId, c.observedTick])).toEqual([['c-late', null]]);
    expect(g.commands.sourceCitations.observed).toEqual([expect.objectContaining({ eventId: 'c-early', sourceIds: ['r-1', 'r-2'] })]);
    expect(g.commands.sourceCitations.notObserved.map(c => c.eventId)).toEqual(['c-late']);
    expect(g.assessments).toEqual([expect.objectContaining({ eventId: 'as', sourceIds: ['r-3'] })]);
    expect([g.watches.map(c => c.eventId), g.decisionLogs.map(c => c.eventId)]).toEqual([['w'], ['d']]);
    expect(g.commitment.values.map(v => v.citation.eventId)).toEqual(['c-early', 'c-late']);
    expect(g.notObserved).toEqual([]);
  });

  it('is deterministic under input order, does not mutate its input and makes no score, attention or learning claims', () => {
    const a = exercise('ex-a'), b = exercise('ex-b', { kind: 'branch', parentId: 'ex-a', forkTick: 3 });
    const items = [item(a), item(b, { actor: 'bob' }), item(a, { kind: 'task_created' }), item(b, { commitmentRatio: 2 }), item(a, { kind: 'decision_log', actor: 'carol', side: 'red' })];
    const input = deepFreeze(page(items)), snapshot = JSON.stringify(input);
    const out = observePracticeHistory(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(observePracticeHistory(page([...items].reverse()))).toEqual(out);
    expect(out.groups.map(g => g.key)).toEqual([...out.groups.map(g => g.key)].sort());
    const keys = [...keysOf(out)].join(' ');
    expect(keys).not.toMatch(/score|rank|mastery|competen|personality|attention|improv|trend|difficulty|learn|weakness|strength/i);
    expect(Object.keys(out)).not.toContain('summary');
  });
});
