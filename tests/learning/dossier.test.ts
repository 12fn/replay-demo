import { describe, expect, it } from 'vitest';
import { buildDossier, classifyCandidate, curriculumMajor } from '../../src/learning/index';
import type { ObservedBehaviorRecord } from '../../src/learning/dossier';
import { curriculum, ev, learner, liveAttempt, meta, order, other, report } from './fixtures';

describe('prior attempt eligibility', () => {
  it('only compares attempts by the same authenticated subject; other participants and unattributed sessions are excluded', () => {
    const current = liveAttempt('cur');
    const mine = liveAttempt('mine-1', { createdAt: '2026-09-12T10:00:00Z' });
    const theirs = liveAttempt('theirs', { ownerSubject: other.subject, createdAt: '2026-09-12T10:00:00Z' });
    const local = liveAttempt('local-demo', { ownerSubject: undefined, createdAt: '2026-09-12T10:00:00Z' });
    const d = buildDossier({ identity: learner, current, candidates: [mine, theirs, local, current], curriculum });
    expect(d.independentPrior.map(a => a.exerciseId)).toEqual(['mine-1']);
    expect(d.excluded).toEqual(expect.arrayContaining([
      { exerciseId: 'theirs', reason: 'different-subject' },
      { exerciseId: 'local-demo', reason: 'unattributed' },
      { exerciseId: 'cur', reason: 'self' },
    ]));
    expect(JSON.stringify(d)).not.toContain(other.subject);
  });

  it('refuses to build for a subject that does not own the current exercise', () => {
    expect(() => buildDossier({ identity: other, current: liveAttempt('cur'), candidates: [], curriculum })).toThrow(/different subject/);
  });

  it('excludes non-comparable scenario and curriculum major versions', () => {
    const current = liveAttempt('cur', { curriculumVersion: '1.2.0' });
    const sameMajor = liveAttempt('p-same', { curriculumVersion: '1.0.3', createdAt: '2026-09-01T00:00:00Z' });
    const oldMajor = liveAttempt('p-old', { curriculumVersion: '0.1.0', createdAt: '2026-09-01T00:00:00Z' });
    const otherScenario = liveAttempt('p-scn', { scenarioId: 'other-map', curriculumVersion: '1.2.0', createdAt: '2026-09-01T00:00:00Z' });
    const later = liveAttempt('p-later', { curriculumVersion: '1.2.0', createdAt: '2026-09-14T00:00:00Z' });
    const d = buildDossier({ identity: learner, current, candidates: [sameMajor, oldMajor, otherScenario, later], curriculum });
    expect(d.independentPrior.map(a => a.exerciseId)).toEqual(['p-same']);
    expect(d.excluded).toEqual(expect.arrayContaining([
      { exerciseId: 'p-old', reason: 'curriculum-major-mismatch' },
      { exerciseId: 'p-scn', reason: 'different-scenario' },
      { exerciseId: 'p-later', reason: 'not-prior' },
    ]));
    expect(curriculumMajor('0.1.0')).toBe('0');
    expect(classifyCandidate(learner, meta({ id: 'a', curriculumVersion: undefined }), meta({ id: 'b' })).reason).toBe('curriculum-major-mismatch');
  });

  it('labels a post-review branch as informed practice and keeps it out of independent comparison', () => {
    const current = liveAttempt('cur');
    const branch = liveAttempt('cur-branch', { kind: 'branch', parentId: 'cur', forkTick: 200, createdAt: '2026-09-13T11:00:00Z' });
    branch.events.unshift(ev({ kind: 'inherited_event', tick: 50, actor: learner.subject, details: { originalKind: 'command', originalDetails: { origin: 'human' } } }));
    const d = buildDossier({ identity: learner, current, candidates: [branch], curriculum });
    expect(d.independentPrior).toHaveLength(0);
    expect(d.informedPractice.map(a => [a.exerciseId, a.label])).toEqual([['cur-branch', 'informed-practice']]);
    expect(d.comparison.join(' ')).toMatch(/No independent prior attempt/);
    expect(d.counterfactual.attempts[0]).toMatchObject({ exerciseId: 'cur-branch', forkTick: 200, humanCommandsAfterFork: 2 });
    expect(d.counterfactual.note).toMatch(/never a post measure/);
    // Branch as the current exercise: comparison is suppressed rather than drawn.
    const asCurrent = buildDossier({ identity: learner, current: branch, candidates: [current], curriculum });
    expect(asCurrent.comparison).toEqual(['This attempt is a branch: informed practice. It is not compared with independent attempts.']);
    expect(asCurrent.independentPrior.map(a => a.exerciseId)).toEqual(['cur']);
    expect(asCurrent.counterfactual.attempts.map(a => a.exerciseId)).toEqual(['cur-branch']);
  });
});

describe('observed behaviour and gaps', () => {
  it('treats missing rationale as unobserved, asks a probe question, and never emits a numerical mastery score', () => {
    const d = buildDossier({ identity: learner, current: liveAttempt('cur'), candidates: [], curriculum });
    const gap = d.gaps.find(g => g.kind === 'rationale-unobserved')!;
    expect(gap.evidenceIds).toEqual(['cur-o2', 'cur-o3']);
    expect(gap.note).toMatch(/unobserved/);
    expect(gap.note).not.toMatch(/fail/i);
    expect(d.probes.map(p => p.evidenceId)).toEqual(['cur-o2', 'cur-o3']);
    expect(d.probes[0].question).toMatch(/What did you expect/);
    expect(d.current.counts).toMatchObject({ humanCommands: 3, commandsWithRationale: 1, contemporaneousRationale: 1, commandsCitingSources: 1, reportsReleased: 2, releasesFollowedByRecordedAction: 2 });
    expect(JSON.stringify(d)).not.toMatch(/"score"|mastery score:|\/10\b/i);
    expect(d.observations.find(o => o.evidenceId === 'cur-o2')?.commitmentRatio).toBeCloseTo(0.7);
    expect(d.practice.some(p => p.objective === 'OBJ-5' && p.evidenceIds.includes('cur-o2'))).toBe(true);
  });

  it('flags a superseded source only when it was explicitly cited', () => {
    const rec = liveAttempt('cur');
    // Order after the second release citing the first (superseded) report.
    rec.events.push(order({ id: 'cur-o4', tick: 500, rationale: 'Estimate still says 1,000.', rationaleTiming: 'contemporaneous', sourceIds: ['cur-r1'] }));
    const d = buildDossier({ identity: learner, current: rec, candidates: [], curriculum });
    const ob = d.observations.find(o => o.evidenceId === 'cur-o4')!;
    expect(ob.citedSources).toEqual([{ id: 'cur-r1', status: 'superseded', supersededBy: 'cur-r2' }]);
    expect(d.gaps.find(g => g.kind === 'superseded-source-cited')?.evidenceIds).toEqual(['cur-o4']);
    // Silent orders after the release are not guessed to have used the old report.
    expect(d.gaps.find(g => g.kind === 'superseded-source-cited')?.evidenceIds).not.toContain('cur-o3');
    expect(d.practice.some(p => p.objective === 'OBJ-1')).toBe(true);
    // The earlier cited order used the report while current.
    expect(d.observations.find(o => o.evidenceId === 'cur-o1')?.citedSources[0].status).toBe('current');
  });

  it('reads rationale from a separate decision_log event and distinguishes post-hoc timing', () => {
    const rec = liveAttempt('cur');
    rec.events.push(ev({ kind: 'decision_log', tick: 450, details: { commandId: 'cmd-cur-o2', text: 'Wanted to press before the next estimate.', sourceIds: [] } }));
    const d = buildDossier({ identity: learner, current: rec, candidates: [], curriculum });
    const o2 = d.observations.find(o => o.evidenceId === 'cur-o2')!;
    expect(o2.rationale).toMatchObject({ timing: 'post-hoc', sourceIds: [] });
    expect(d.gaps.find(g => g.kind === 'rationale-post-hoc-only')?.evidenceIds).toEqual(['cur-o2']);
    expect(d.gaps.find(g => g.kind === 'rationale-uncited')?.evidenceIds).toEqual(['cur-o2']);
    expect(d.probes.map(p => p.evidenceId)).toEqual(['cur-o3']);
  });

  // D1: a contemporaneous citation recorded without text is provenance, not a reason, and must not vanish.
  it('keeps a source-only citation as provenance without presenting it as a recorded reason', () => {
    const rec = liveAttempt('cur');
    const cited = order({ id: 'cur-o4', tick: 500 });
    cited.details.sourceIds = ['cur-r1'];
    cited.details.rationaleTiming = 'contemporaneous';
    rec.events.push(cited);
    const d = buildDossier({ identity: learner, current: rec, candidates: [], curriculum });
    const ob = d.observations.find(o => o.evidenceId === 'cur-o4')! as ObservedBehaviorRecord;
    expect(ob.rationale).toBeNull();
    expect(ob.citation).toMatchObject({ evidenceId: 'cur-o4', form: 'citation-only', text: '', sourceIds: ['cur-r1'], timing: 'contemporaneous' });
    expect(ob.citedSources).toEqual([{ id: 'cur-r1', status: 'superseded', supersededBy: 'cur-r2' }]);
    expect(ob.criteria).toEqual(expect.arrayContaining(['C1', 'C2']));
    expect(d.current.counts).toMatchObject({ humanCommands: 4, commandsWithRationale: 1, contemporaneousRationale: 1, commandsCitingSources: 2, commandsCitingSupersededSource: 1, commandsCitingWithoutStatement: 1 });
    expect(d.gaps.find(g => g.kind === 'rationale-unobserved')?.evidenceIds).toContain('cur-o4');
    expect(d.gaps.find(g => g.kind === 'superseded-source-cited')?.evidenceIds).toEqual(['cur-o4']);
    expect(d.gaps.find(g => g.kind === 'rationale-uncited')).toBeUndefined();
    expect(d.probes.find(p => p.evidenceId === 'cur-o4')?.question).toMatch(/citing cur-r1 but wrote no reason/);
    expect(d.roleSummary).toMatch(/2 citing a source \(1 without a written reason\)/);
  });

  // D2: an assessment written at a live tick while viewing an earlier tick is judged at the viewed tick.
  it('evaluates assessment citations at the observed tick, not the tick the entry was written at', () => {
    const rec = liveAttempt('cur');
    rec.events = rec.events.filter(e => e.kind !== 'command');
    rec.events.push(ev({ id: 'as-playback', kind: 'assessment_log', tick: 400, summary: 'Initial estimate holds at tick 3', details: { sourceIds: ['cur-r1'], observedTick: 3, timing: 'post-hoc' } }));
    rec.events.push(ev({ id: 'as-live', kind: 'assessment_log', tick: 400, summary: 'Still citing the initial estimate', details: { sourceIds: ['cur-r1'], timing: 'contemporaneous' } }));
    const d = buildDossier({ identity: { ...learner, role: 'intelligence' }, current: rec, candidates: [], curriculum });
    const playback = d.observations.find(o => o.evidenceId === 'as-playback')! as ObservedBehaviorRecord;
    expect(playback).toMatchObject({ tick: 400, observedTick: 3 });
    expect(playback.citedSources).toEqual([{ id: 'cur-r1', status: 'current' }]);
    expect(playback.availableReportIds).toEqual(['cur-r1']);
    // Without an observed tick the record tick still applies, and the same citation is superseded there.
    const live = d.observations.find(o => o.evidenceId === 'as-live')! as ObservedBehaviorRecord;
    expect(live).toMatchObject({ tick: 400, observedTick: 400 });
    expect(live.citedSources).toEqual([{ id: 'cur-r1', status: 'superseded', supersededBy: 'cur-r2' }]);
    expect(live.availableReportIds).toEqual(['cur-r1', 'cur-r2']);
  });

  // D3: post-hoc annotations are not responses to releases, and one late order does not answer every earlier release.
  it('does not count post-hoc annotations as responses to report releases', () => {
    const rec = liveAttempt('cur');
    rec.events = rec.events.filter(e => e.id !== 'cur-o3');
    rec.events.push(ev({ id: 'dl-late', kind: 'decision_log', tick: 450, details: { commandId: 'cmd-cur-o2', text: 'Written after the exercise.', sourceIds: [], timing: 'post-hoc' } }));
    const releaseIds = rec.events.filter(e => e.kind === 'report').map(e => e.id);
    const d = buildDossier({ identity: learner, current: rec, candidates: [], curriculum });
    expect(d.current.counts).toMatchObject({ reportsReleased: 2, releasesFollowedByRecordedAction: 1 });
    expect(d.gaps.find(g => g.kind === 'release-without-recorded-response')?.evidenceIds).toEqual([releaseIds[1]]);
    expect(d.gaps.find(g => g.kind === 'release-without-recorded-response')?.note).toMatch(/Post-hoc annotations do not count/);
    // A contemporaneous assessment or watch in the release window does count.
    rec.events.push(ev({ id: 'watch-late', kind: 'task_created', tick: 460, summary: 'Watch estimates', details: { taskId: 't9' } }));
    expect(buildDossier({ identity: learner, current: rec, candidates: [], curriculum }).current.counts.releasesFollowedByRecordedAction).toBe(2);
  });

  it('matches responses to the release window so a single late order does not answer every release', () => {
    const rec = liveAttempt('cur');
    rec.events = rec.events.filter(e => e.id !== 'cur-o1' && e.id !== 'cur-o2');
    const releaseIds = rec.events.filter(e => e.kind === 'report').map(e => e.id);
    const d = buildDossier({ identity: learner, current: rec, candidates: [], curriculum });
    expect(d.current.counts).toMatchObject({ reportsReleased: 2, releasesFollowedByRecordedAction: 1 });
    expect(d.gaps.find(g => g.kind === 'release-without-recorded-response')?.evidenceIds).toEqual([releaseIds[0]]);
    expect(d.provenance.criteriaMethod).toMatch(/between it and the next release/);
  });

  // D4: every decision statement stays on record; the latest post-hoc statement is current, and
  // submission-time text is never overridden by a later annotation.
  it('uses the latest post-hoc statement as current while preserving every statement and contemporaneous primacy', () => {
    const rec = liveAttempt('cur');
    rec.events.push(ev({ id: 'dl-first', kind: 'decision_log', tick: 450, recordedAt: '2026-09-13T12:00:00Z', details: { commandId: 'cmd-cur-o2', text: 'First attempt at a reason.', sourceIds: [], timing: 'post-hoc' } }));
    rec.events.push(ev({ id: 'dl-second', kind: 'decision_log', tick: 460, recordedAt: '2026-09-13T12:05:00Z', details: { commandId: 'cmd-cur-o2', text: 'Corrected after re-reading the record.', sourceIds: ['cur-r1'], timing: 'post-hoc' } }));
    rec.events.push(ev({ id: 'dl-o1', kind: 'decision_log', tick: 470, details: { commandId: 'cmd-cur-o1', text: 'Later annotation of a contemporaneous order.', sourceIds: [], timing: 'post-hoc' } }));
    const d = buildDossier({ identity: learner, current: rec, candidates: [], curriculum });
    const o2 = (d.observations.find(o => o.evidenceId === 'cur-o2') as ObservedBehaviorRecord).rationale!;
    expect(o2).toMatchObject({ evidenceId: 'dl-second', text: 'Corrected after re-reading the record.', timing: 'post-hoc', selection: 'latest-post-hoc', recordedAt: '2026-09-13T12:05:00Z' });
    expect(o2.statements.map(s => [s.evidenceId, s.timing, s.tick])).toEqual([['dl-first', 'post-hoc', 450], ['dl-second', 'post-hoc', 460]]);
    expect(d.observations.find(o => o.evidenceId === 'cur-o2')?.citedSources).toEqual([{ id: 'cur-r1', status: 'current' }]);
    const o1 = (d.observations.find(o => o.evidenceId === 'cur-o1') as ObservedBehaviorRecord).rationale!;
    expect(o1).toMatchObject({ evidenceId: 'cur-o1', timing: 'contemporaneous', selection: 'contemporaneous' });
    expect(o1.statements.map(s => s.evidenceId)).toEqual(['cur-o1', 'dl-o1']);
    expect(d.gaps.find(g => g.kind === 'rationale-post-hoc-only')?.evidenceIds).toEqual(['cur-o2']);
    expect(d.current.counts).toMatchObject({ commandsWithRationale: 2, contemporaneousRationale: 1, commandsCitingSources: 2 });
  });

  it('describes prior comparison as counts, notes assistance and ignores other actors in the same exercise', () => {
    const prior = liveAttempt('prior', { assistance: 'staff-assisted', createdAt: '2026-09-10T00:00:00Z' });
    prior.events.push(order({ id: 'prior-x', tick: 600, actor: 'baseline-controller', side: 'red', origin: 'deterministic-baseline' }));
    prior.events.push(order({ id: 'prior-y', tick: 610, actor: other.subject }));
    const d = buildDossier({ identity: learner, current: liveAttempt('cur'), candidates: [prior], curriculum });
    expect(d.independentPrior[0].counts.humanCommands).toBe(3);
    expect(d.independentPrior[0].assistance).toBe('staff-assisted');
    expect(d.comparison[0]).toMatch(/1 of 3 now; 1 of 3 in prior \(staff-assisted\)/);
    expect(d.comparison.at(-1)).toMatch(/not a mastery score/);
  });

  it('gives the intelligence seat a role-specific summary and assessment-sourcing practice', () => {
    const rec = liveAttempt('cur');
    rec.events = rec.events.filter(e => e.kind !== 'command');
    rec.events.push(ev({ kind: 'assessment_log', tick: 320, summary: 'Opponent likely to commit soon', details: { sourceIds: ['cur-r2'] } }));
    rec.events.push(ev({ kind: 'assessment_log', tick: 330, summary: 'Staff said they are weak', details: { sourceIds: [] } }));
    rec.events.push(ev({ kind: 'task_created', tick: 340, summary: 'Staff assigned: watch estimates', details: { taskId: 't1' } }));
    const d = buildDossier({ identity: { ...learner, role: 'intelligence' }, current: rec, candidates: [], curriculum });
    expect(d.roleSummary).toMatch(/^Intelligence seat: 2 assessment entries \(1 with a report ID\), 1 watches/);
    expect(d.gaps.find(g => g.kind === 'assessment-uncited')?.evidenceIds).toHaveLength(1);
    expect(d.nextSession.role).toBe('intelligence');
    expect(d.nextSession.steps[0]).toMatch(/assessment log/);
    expect(d.probes).toHaveLength(0);
  });

  it('carries provenance and limitations from the curriculum file without approved sources', () => {
    const d = buildDossier({ identity: learner, current: liveAttempt('cur'), candidates: [], curriculum });
    expect(d.provenance).toMatchObject({ curriculumId: 'replay-crosscurrent-decision-reasoning', curriculumVersion: '0.1.0', curriculumStatus: 'provisional-unreviewed', reviewedSourceIds: [] });
    expect(d.limitations.join(' ')).toMatch(/provisional/);
    expect(d.limitations.join(' ')).toMatch(/nothing here is doctrine/);
    expect(d.limitations.join(' ')).toMatch(/real-world tactics/);
  });

  it('does not mutate supplied records', () => {
    const current = liveAttempt('cur');
    const snapshot = JSON.stringify(current);
    const rep = report('extra', 900);
    buildDossier({ identity: learner, current, candidates: [{ ...liveAttempt('p', { createdAt: '2026-09-01T00:00:00Z' }), reports: [rep] }], curriculum });
    expect(JSON.stringify(current)).toBe(snapshot);
  });
});
