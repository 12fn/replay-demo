import { describe, expect, it } from 'vitest';
import {
  DOCTRINE_BENCHMARK_SCHEMA,
  evaluateBenchmarkAnswer,
  validateBenchmarkCase,
  type BenchmarkAnswer,
  type DoctrineBenchmarkCase,
  type DoctrineSource,
} from '../../src/learning/doctrine-benchmark';

// Placeholder test fixtures for an abstract board game. Not doctrine.
const sourceA: DoctrineSource = {
  id: 'fixture-rulebook-a',
  version: '1',
  title: 'Fixture rulebook A (test placeholder)',
  excerpt: 'Before committing reserve tokens, a player states which\nobservation would change the plan.',
  approval: { status: 'approved', approvedBy: 'instructor-fixture', approvedAt: '2026-09-14T00:00:00Z' },
};
const sourceB: DoctrineSource = {
  id: 'fixture-rulebook-b',
  version: '2',
  title: 'Fixture rulebook B (test placeholder)',
  excerpt: 'A report separates what was seen from what is assumed.',
  approval: { status: 'approved', approvedBy: 'instructor-fixture' },
};
const registry = [sourceA, sourceB];

const benchmark: DoctrineBenchmarkCase = {
  schema: DOCTRINE_BENCHMARK_SCHEMA,
  id: 'case-reserve-1',
  question: 'In the fixture game, what should a player do before committing reserve tokens?',
  sources: [{ id: sourceA.id, version: '1' }, { id: sourceB.id, version: '2' }],
  expectedEvidence: [{ sourceId: sourceA.id, quote: 'states which observation would change the plan' }, { sourceId: sourceB.id }],
  rubric: [
    { id: 'names-trigger', description: 'Names an observation that would change the plan.' },
    { id: 'separates-assumption', description: 'Separates observation from assumption.' },
  ],
};

const goodAnswer: BenchmarkAnswer = {
  caseId: benchmark.id,
  respondent: 'fixture-respondent',
  text: 'State the observation that would change the plan, and label assumptions.',
  citations: [
    { sourceId: sourceA.id, quote: 'a player STATES which observation   would change the plan' },
    { sourceId: sourceB.id },
  ],
};

describe('doctrine benchmark readiness', () => {
  it('reports not-ready, never a pass, when no approved source exists', () => {
    const empty = { ...benchmark, sources: [], expectedEvidence: [] };
    const r = evaluateBenchmarkAnswer(empty, [], goodAnswer);
    expect(r.overall).toBe('not-ready');
    expect(r.readiness.ready).toBe(false);
    expect(r.readiness.issues.map(i => i.code)).toEqual(expect.arrayContaining(['no-sources', 'no-expected-evidence']));
    expect(r.mechanical.status).toBe('not-evaluated');
    expect(r.semantic.status).toBe('not-evaluated');
    expect(r.expertApproval).toBe('missing');
    expect(JSON.stringify({ ...r, limitations: [] })).not.toMatch(/pass|score|mastery/i);
  });

  it('flags missing and unapproved sources as not-ready', () => {
    const pending: DoctrineSource = { ...sourceB, approval: { status: 'pending' } };
    const r = validateBenchmarkCase(benchmark, [pending]);
    expect(r.ready).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining([
      { code: 'source-missing', ref: sourceA.id },
      { code: 'source-unapproved', ref: sourceB.id },
    ]));
    expect(evaluateBenchmarkAnswer(benchmark, [pending], goodAnswer).overall).toBe('not-ready');
  });

  it('does not accept an approval without an accountable reviewer', () => {
    const unsigned: DoctrineSource = { ...sourceB, approval: { status: 'approved' } };
    expect(validateBenchmarkCase(benchmark, [sourceA, unsigned]).issues).toContainEqual({ code: 'approval-without-reviewer', ref: sourceB.id });
  });

  it('detects source version and expected-evidence mismatches', () => {
    const r = validateBenchmarkCase(
      { ...benchmark, sources: [{ id: sourceA.id, version: '9' }, { id: sourceB.id, version: '2' }], expectedEvidence: [{ sourceId: 'not-in-case' }, { sourceId: sourceB.id, quote: 'text absent from excerpt' }] },
      registry,
    );
    expect(r.ready).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining([
      { code: 'source-version-mismatch', ref: sourceA.id },
      { code: 'expected-source-not-in-case', ref: 'not-in-case' },
      { code: 'expected-quote-not-in-excerpt', ref: sourceB.id },
    ]));
  });
});

describe('mechanical citation checks', () => {
  it('rejects citations outside the case, fabricated quotes and a mismatched case id', () => {
    const r = evaluateBenchmarkAnswer(benchmark, [...registry, { ...sourceA, id: 'other-approved' }], {
      ...goodAnswer,
      caseId: 'another-case',
      citations: [{ sourceId: 'other-approved' }, { sourceId: sourceA.id, quote: 'always commit every reserve token' }, { sourceId: sourceB.id }],
    });
    expect(r.overall).toBe('mechanical-issues');
    expect(r.mechanical.status).toBe('invalid');
    expect(r.mechanical.answerIssues).toEqual(['case-mismatch']);
    expect(r.mechanical.citations.map(c => c.result)).toEqual(['source-not-in-case', 'quote-not-in-excerpt', 'valid']);
    expect(r.mechanical.coverage.map(c => c.covered)).toEqual([false, true]);
  });

  it('marks valid but incomplete coverage separately from invalid citations', () => {
    const r = evaluateBenchmarkAnswer(benchmark, registry, { ...goodAnswer, citations: [{ sourceId: sourceB.id }] });
    expect(r.mechanical.status).toBe('incomplete');
    expect(r.overall).toBe('mechanical-issues');
  });

  it('treats valid mechanical coverage as awaiting instructor judgment, not correct', () => {
    const r = evaluateBenchmarkAnswer(benchmark, registry, goodAnswer);
    expect(r.readiness.ready).toBe(true);
    expect(r.mechanical.status).toBe('valid');
    expect(r.mechanical.coverage.every(c => c.covered)).toBe(true);
    expect(r.overall).toBe('awaiting-instructor-judgment');
    expect(r.semantic.status).toBe('pending-instructor-judgment');
    expect(r.semantic.criteria.every(c => c.judgments.length === 0)).toBe(true);
    expect(r.limitations.join(' ')).toMatch(/does not show the answer is correct/);
    expect(evaluateBenchmarkAnswer(benchmark, registry, goodAnswer)).toEqual(r);
  });
});

describe('instructor judgment', () => {
  it('stays pending until every criterion has a named human verdict', () => {
    const partial = evaluateBenchmarkAnswer(benchmark, registry, goodAnswer, [
      { criterionId: 'names-trigger', verdict: 'meets', reviewer: 'instructor-fixture' },
      { criterionId: 'separates-assumption', verdict: 'meets', reviewer: '' },
      { criterionId: 'invented-criterion', verdict: 'meets', reviewer: 'instructor-fixture' },
    ]);
    expect(partial.semantic.status).toBe('pending-instructor-judgment');
    expect(partial.overall).toBe('awaiting-instructor-judgment');
    expect(partial.semantic.unmatchedJudgments.map(j => j.criterionId)).toEqual(['separates-assumption', 'invented-criterion']);
  });

  it('records verdicts as given without aggregating them', () => {
    const r = evaluateBenchmarkAnswer(benchmark, registry, goodAnswer, [
      { criterionId: 'names-trigger', verdict: 'meets', reviewer: 'instructor-fixture' },
      { criterionId: 'separates-assumption', verdict: 'does-not-meet', reviewer: 'instructor-fixture', note: 'Assumption not labelled.' },
    ]);
    expect(r.overall).toBe('instructor-judged');
    expect(r.semantic.criteria.map(c => c.judgments[0].verdict)).toEqual(['meets', 'does-not-meet']);
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['score']));
  });
});
