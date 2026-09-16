import { describe, expect, it } from 'vitest';
import {
  citingSourceCell,
  provenanceOf,
  referenceSuffixLabel,
  splitReferenceId,
  type AttemptCounts,
  type ObservedBehavior,
  type RationaleStatement,
} from '../../src/client/learning-api';

/*
 * Pure projection tests for the learning panel's provenance display. They check the shape the
 * panel renders from, not the DOM. The rules under test come from
 * docs/process/learning-audit-fixes.md (D1, D2, D4): a bare citation is never a reason, the
 * submission-time statement is never displaced, and the viewed tick is separate from the recorded tick.
 */

const counts: AttemptCounts = {
  humanCommands: 3, commandsWithRationale: 1, contemporaneousRationale: 1, commandsCitingSources: 2, commandsCitingSupersededSource: 0,
  reportsReleased: 2, releasesFollowedByRecordedAction: 1, watchesCreated: 0, assessmentsLogged: 0, assessmentsCitingSources: 0, staffQuestions: 0,
};

function command(over: Partial<ObservedBehavior> = {}): ObservedBehavior {
  return { evidenceId: 'cmd-1', tick: 120, kind: 'command', summary: 'Attack 3,4 with 400', rationale: null, citedSources: [], availableReportIds: ['r1'], criteria: ['C5'], ...over };
}

const stmt = (over: Partial<RationaleStatement>): RationaleStatement => ({ evidenceId: 'cmd-1', text: '', form: 'statement', sourceIds: [], timing: 'contemporaneous', tick: 120, ...over });

describe('citation-only orders (D1)', () => {
  it('shows the cited sources with an explicit "no written reason" and never a reason tag', () => {
    const o = command({
      citation: stmt({ form: 'citation-only', sourceIds: ['r1'] }),
      citedSources: [{ id: 'r1', status: 'current' }],
    });
    const p = provenanceOf(o);
    expect(p.status).toBe('citation-only');
    expect(p.tag).toBe('citation only · no written reason');
    expect(p.tag).not.toMatch(/reason recorded/);
    expect(p.primary).toBeNull();
    expect(p.citationsWithoutReason).toBe(true);
    expect(p.citations).toEqual([{ id: 'r1', status: 'current' }]);
  });

  it('carries the currency judged at the viewed tick onto each citation', () => {
    const o = command({
      citation: stmt({ form: 'citation-only', sourceIds: ['r1', 'r9'] }),
      citedSources: [{ id: 'r1', status: 'superseded', supersededBy: 'r2' }],
    });
    const p = provenanceOf(o);
    expect(p.citations).toEqual([{ id: 'r1', status: 'superseded', supersededBy: 'r2' }, { id: 'r9', status: 'unknown' }]);
  });
});

describe('observed vs recorded tick (D2)', () => {
  it('labels a historical assessment with both ticks and flags it', () => {
    const o = command({ evidenceId: 'as-1', kind: 'assessment', tick: 400, observedTick: 3, citedSources: [{ id: 'r1', status: 'current' }] });
    const p = provenanceOf(o);
    expect(p.snapshotLag).toBe(true);
    expect(p.observedTick).toBe(3);
    expect(p.recordedTick).toBe(400);
    expect(p.tickLabel).toBe('viewed t3 · recorded t400');
    expect(p.status).toBe('not-applicable');
    expect(p.citations).toEqual([{ id: 'r1', status: 'current' }]);
  });

  it('uses a single tick when the record was live or the field is absent (old dossiers)', () => {
    expect(provenanceOf(command({ observedTick: 120 })).tickLabel).toBe('t120');
    const old = provenanceOf(command());
    expect(old.snapshotLag).toBe(false);
    expect(old.observedTick).toBe(120);
    expect(old.tickLabel).toBe('t120');
  });
});

it('does not label a live order post-hoc merely because its snapshot arrived two ticks earlier', () => {
  const p=provenanceOf(command({observedTick:118,rationale:{evidenceId:'cmd-1',text:'Live reason',sourceIds:[],timing:'contemporaneous',form:'statement',tick:120}}));
  expect(p.snapshotLag).toBe(true);
  expect(p.tickLabel).toBe('viewed t118 · recorded t120');
  expect(p.status).toBe('contemporaneous');
  expect(p.tag).toBe('reason recorded · contemporaneous');
});

describe('every statement kept; submission text never displaced (D4)', () => {
  it('keeps the contemporaneous statement primary and lists a later post-hoc annotation separately', () => {
    const o = command({
      rationale: {
        evidenceId: 'cmd-1', text: 'Hold the crossing; R1 shows the ford is open.', sourceIds: ['r1'], timing: 'contemporaneous', form: 'statement', tick: 120, selection: 'contemporaneous',
        statements: [
          stmt({ text: 'Hold the crossing; R1 shows the ford is open.', sourceIds: ['r1'] }),
          stmt({ evidenceId: 'dl-1', text: 'In hindsight R2 had already superseded R1.', sourceIds: ['r2'], timing: 'post-hoc', tick: 900, recordedAt: '2026-09-13T10:00:00Z' }),
        ],
      },
      citedSources: [{ id: 'r1', status: 'current' }, { id: 'r2', status: 'unknown' }],
    });
    const p = provenanceOf(o);
    expect(p.status).toBe('contemporaneous');
    expect(p.tag).toBe('reason recorded · contemporaneous');
    expect(p.tagTone).toBe('plain');
    expect(p.primary).toMatchObject({ evidenceId: 'cmd-1', label: 'statement at submission', text: 'Hold the crossing; R1 shows the ford is open.', tick: 120 });
    expect(p.primary?.sources).toEqual([{ id: 'r1', status: 'current' }]);
    expect(p.others).toHaveLength(1);
    expect(p.others[0]).toMatchObject({ evidenceId: 'dl-1', label: 'later annotation (post-hoc)', timing: 'post-hoc', tick: 900, recordedAt: '2026-09-13T10:00:00Z' });
    expect(p.others[0].sources).toEqual([{ id: 'r2', status: 'unknown' }]);
    // The primary block only carries the submission-time citations, not the later ones.
    expect(p.citations.map((c) => c.id)).toEqual(['r1']);
  });

  it('with only post-hoc statements, the latest is current and the earlier one is labelled superseded', () => {
    const o = command({
      rationale: {
        evidenceId: 'dl-2', text: 'Corrected: I expected the reserve to hold.', sourceIds: [], timing: 'post-hoc', form: 'statement', tick: 950, selection: 'latest-post-hoc',
        statements: [
          stmt({ evidenceId: 'dl-1', text: 'First attempt at a reason.', timing: 'post-hoc', tick: 900 }),
          stmt({ evidenceId: 'dl-2', text: 'Corrected: I expected the reserve to hold.', timing: 'post-hoc', tick: 950 }),
        ],
      },
    });
    const p = provenanceOf(o);
    expect(p.status).toBe('post-hoc');
    expect(p.tagTone).toBe('warn');
    expect(p.primary).toMatchObject({ evidenceId: 'dl-2', label: 'post-hoc statement (current)' });
    expect(p.others.map((s) => [s.evidenceId, s.label])).toEqual([['dl-1', 'earlier post-hoc statement (superseded by the later one)']]);
  });

  it('a citation-only record beside a written statement is listed, not merged', () => {
    const o = command({
      rationale: {
        evidenceId: 'dl-1', text: 'Written later.', sourceIds: [], timing: 'post-hoc', form: 'statement', tick: 900, selection: 'latest-post-hoc',
        statements: [stmt({ form: 'citation-only', sourceIds: ['r1'] }), stmt({ evidenceId: 'dl-1', text: 'Written later.', timing: 'post-hoc', tick: 900 })],
      },
      citedSources: [{ id: 'r1', status: 'current' }],
    });
    const p = provenanceOf(o);
    expect(p.primary?.evidenceId).toBe('dl-1');
    expect(p.others[0]).toMatchObject({ evidenceId: 'cmd-1', label: 'citation at submission, no written reason', text: '' });
    expect(p.others[0].sources).toEqual([{ id: 'r1', status: 'current' }]);
  });
});

describe('old dossiers without optional fields', () => {
  it('falls back to a single primary statement from the flat rationale fields', () => {
    const o = command({ rationale: { evidenceId: 'cmd-1', text: 'Old style reason.', sourceIds: ['r1'], timing: 'post-hoc' }, citedSources: [{ id: 'r1', status: 'current' }] });
    const p = provenanceOf(o);
    expect(p.primary).toMatchObject({ evidenceId: 'cmd-1', text: 'Old style reason.', label: 'post-hoc statement', tick: 120 });
    expect(p.others).toEqual([]);
    expect(p.citations).toEqual([{ id: 'r1', status: 'current' }]);
    expect(p.tag).toBe('reason recorded · post-hoc');
  });

  it('an order with nothing recorded reads "reason not observed"; a watch gets no reason tag', () => {
    expect(provenanceOf(command())).toMatchObject({ status: 'not-observed', tag: 'reason not observed', primary: null, citations: [] });
    expect(provenanceOf(command({ kind: 'watch' })).tag).toBe('');
  });

  it('unknown timing is named rather than shown as contemporaneous', () => {
    const p = provenanceOf(command({ rationale: { evidenceId: 'cmd-1', text: 'x', sourceIds: [], timing: 'unknown' } }));
    expect(p.tag).toBe('reason recorded · timing unknown');
    expect(p.tagTone).toBe('warn');
    expect(p.primary?.label).toBe('statement (timing unknown)');
  });
});

describe('attempt table and debrief reference suffixes', () => {
  it('reports citation-only orders in the citing-source cell only when the dossier records them', () => {
    expect(citingSourceCell(counts)).toBe('2');
    expect(citingSourceCell({ ...counts, commandsCitingWithoutStatement: 0 })).toBe('2');
    expect(citingSourceCell({ ...counts, commandsCitingWithoutStatement: 1 })).toBe('2 (1 without reason)');
  });

  it('routes a <command>:citation debrief reference to the command with a non-reason label', () => {
    expect(splitReferenceId('abc:citation')).toEqual(['abc', 'citation']);
    expect(splitReferenceId('abc:rationale')).toEqual(['abc', 'rationale']);
    expect(splitReferenceId('abc:before')).toEqual(['abc', 'before']);
    expect(splitReferenceId('abc')).toEqual(['abc', null]);
    expect(referenceSuffixLabel('citation')).toBe('citation only, no written reason');
    expect(referenceSuffixLabel('rationale')).toBe('statement');
    expect(referenceSuffixLabel(null)).toBeNull();
  });
});
