/**
 * Doctrine benchmark contract (challenge 133).
 *
 * A pure, deterministic checker for benchmark cases built from
 * instructor-approved doctrine sources supplied at the event. It never
 * retrieves content, never creates doctrine and never marks a source approved.
 *
 * Three separate questions stay separate:
 *   1. Mechanical citation validity — does the answer cite approved sources
 *      assigned to this case, with quotes that literally appear in the
 *      approved excerpt, and cover the expected evidence? Checked here.
 *   2. Semantic correctness — does the answer apply the source correctly?
 *      Only a qualified human decides; this module records their judgments.
 *   3. Expert approval — is the case and its source set sanctioned for use?
 *      Supplied as data by the instructor; never inferred.
 *
 * There is deliberately no score, grade, pass status or mastery label.
 */

export const DOCTRINE_BENCHMARK_SCHEMA = 'replay.doctrine-benchmark/1' as const;

export type SourceApprovalStatus = 'approved' | 'pending' | 'rejected';

export interface DoctrineSourceApproval {
  status: SourceApprovalStatus;
  /** Accountable reviewer identity; required for `approved`. */
  approvedBy?: string;
  approvedAt?: string;
}

/** One instructor-supplied source passage. Content is data, never generated. */
export interface DoctrineSource {
  id: string;
  version: string;
  title: string;
  /** Exact approved passage that citations are checked against. */
  excerpt: string;
  approval: DoctrineSourceApproval;
}

export interface SourceRef {
  id: string;
  version: string;
}

export interface ExpectedEvidence {
  sourceId: string;
  /** Optional passage fragment the answer is expected to quote. */
  quote?: string;
}

export interface RubricCriterion {
  id: string;
  description: string;
}

export interface DoctrineBenchmarkCase {
  schema: typeof DOCTRINE_BENCHMARK_SCHEMA;
  id: string;
  question: string;
  /** Pinned source versions the case is allowed to draw on. */
  sources: SourceRef[];
  expectedEvidence: ExpectedEvidence[];
  rubric: RubricCriterion[];
}

export interface AnswerCitation {
  sourceId: string;
  quote?: string;
}

export interface BenchmarkAnswer {
  caseId: string;
  /** Who or what produced the answer, e.g. a model route or `human`. */
  respondent: string;
  text: string;
  citations: AnswerCitation[];
}

export type InstructorVerdict = 'meets' | 'does-not-meet' | 'unclear';

/** Independent human judgment of one rubric criterion. Never computed here. */
export interface InstructorJudgment {
  criterionId: string;
  verdict: InstructorVerdict;
  reviewer: string;
  note?: string;
}

export type CaseIssueCode =
  | 'wrong-schema'
  | 'missing-question'
  | 'no-sources'
  | 'source-missing'
  | 'source-version-mismatch'
  | 'source-unapproved'
  | 'approval-without-reviewer'
  | 'empty-excerpt'
  | 'no-expected-evidence'
  | 'expected-source-not-in-case'
  | 'expected-quote-not-in-excerpt'
  | 'no-rubric'
  | 'duplicate-rubric-criterion';

export interface CaseIssue {
  code: CaseIssueCode;
  ref?: string;
}

export interface CaseValidation {
  ready: boolean;
  issues: CaseIssue[];
  approvedSourceIds: string[];
}

export type CitationResult = 'valid' | 'source-not-in-case' | 'source-not-approved' | 'quote-not-in-excerpt';

export interface CitationCheck extends AnswerCitation {
  result: CitationResult;
}

export interface EvidenceCoverage extends ExpectedEvidence {
  covered: boolean;
}

export type MechanicalStatus = 'not-evaluated' | 'invalid' | 'incomplete' | 'valid';

export interface MechanicalReport {
  status: MechanicalStatus;
  citations: CitationCheck[];
  coverage: EvidenceCoverage[];
  answerIssues: ('case-mismatch' | 'no-citations')[];
}

export type SemanticStatus = 'not-evaluated' | 'pending-instructor-judgment' | 'instructor-judged';

export interface CriterionJudgmentView extends RubricCriterion {
  judgments: InstructorJudgment[];
}

export interface SemanticReport {
  status: SemanticStatus;
  criteria: CriterionJudgmentView[];
  /** Judgments naming a criterion that is not in the rubric; kept, not dropped. */
  unmatchedJudgments: InstructorJudgment[];
}

export type BenchmarkOverall =
  | 'not-ready'
  | 'mechanical-issues'
  | 'awaiting-instructor-judgment'
  | 'instructor-judged';

export interface BenchmarkEvaluation {
  schema: typeof DOCTRINE_BENCHMARK_SCHEMA;
  caseId: string;
  overall: BenchmarkOverall;
  readiness: CaseValidation;
  mechanical: MechanicalReport;
  semantic: SemanticReport;
  /** Case/source approval is instructor-supplied data; this module never grants it. */
  expertApproval: 'supplied-by-instructor' | 'missing';
  limitations: string[];
}

export const BENCHMARK_LIMITATIONS: readonly string[] = [
  'Mechanical citation validity checks identifiers and literal quotes only; it does not show the answer is correct.',
  'Semantic correctness is recorded only from independent instructor judgment; no automated grounding score is produced.',
  'No mastery, grade or pass result is assigned by this check.',
];

/** Whitespace-collapsed, case-insensitive text for literal quote matching. */
export function normalizeQuote(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function quoteInExcerpt(quote: string, excerpt: string): boolean {
  const q = normalizeQuote(quote);
  return q.length > 0 && normalizeQuote(excerpt).includes(q);
}

export function validateBenchmarkCase(benchmark: DoctrineBenchmarkCase, registry: readonly DoctrineSource[]): CaseValidation {
  const issues: CaseIssue[] = [];
  const approved = new Map<string, DoctrineSource>();
  if (benchmark.schema !== DOCTRINE_BENCHMARK_SCHEMA) issues.push({ code: 'wrong-schema' });
  if (!benchmark.question?.trim()) issues.push({ code: 'missing-question' });
  if (!benchmark.sources?.length) issues.push({ code: 'no-sources' });

  for (const ref of benchmark.sources ?? []) {
    const matches = registry.filter(s => s.id === ref.id);
    const source = matches.find(s => s.version === ref.version);
    if (!matches.length) { issues.push({ code: 'source-missing', ref: ref.id }); continue; }
    if (!source) { issues.push({ code: 'source-version-mismatch', ref: ref.id }); continue; }
    if (source.approval?.status !== 'approved') { issues.push({ code: 'source-unapproved', ref: ref.id }); continue; }
    if (!source.approval.approvedBy?.trim()) { issues.push({ code: 'approval-without-reviewer', ref: ref.id }); continue; }
    if (!source.excerpt?.trim()) { issues.push({ code: 'empty-excerpt', ref: ref.id }); continue; }
    approved.set(ref.id, source);
  }

  const inCase = new Set((benchmark.sources ?? []).map(s => s.id));
  if (!benchmark.expectedEvidence?.length) issues.push({ code: 'no-expected-evidence' });
  for (const e of benchmark.expectedEvidence ?? []) {
    if (!inCase.has(e.sourceId)) issues.push({ code: 'expected-source-not-in-case', ref: e.sourceId });
    else if (e.quote !== undefined && approved.has(e.sourceId) && !quoteInExcerpt(e.quote, approved.get(e.sourceId)!.excerpt)) {
      issues.push({ code: 'expected-quote-not-in-excerpt', ref: e.sourceId });
    }
  }

  if (!benchmark.rubric?.length) issues.push({ code: 'no-rubric' });
  const seen = new Set<string>();
  for (const c of benchmark.rubric ?? []) {
    if (seen.has(c.id)) issues.push({ code: 'duplicate-rubric-criterion', ref: c.id });
    seen.add(c.id);
  }

  return { ready: issues.length === 0 && approved.size > 0, issues, approvedSourceIds: [...approved.keys()].sort() };
}

function checkCitation(c: AnswerCitation, benchmark: DoctrineBenchmarkCase, registry: readonly DoctrineSource[]): CitationResult {
  const ref = benchmark.sources.find(s => s.id === c.sourceId);
  if (!ref) return 'source-not-in-case';
  const source = registry.find(s => s.id === ref.id && s.version === ref.version);
  if (!source || source.approval?.status !== 'approved' || !source.approval.approvedBy?.trim()) return 'source-not-approved';
  if (c.quote !== undefined && !quoteInExcerpt(c.quote, source.excerpt)) return 'quote-not-in-excerpt';
  return 'valid';
}

function isCovered(e: ExpectedEvidence, valid: readonly CitationCheck[]): boolean {
  return valid.some(c => c.sourceId === e.sourceId && (e.quote === undefined || (c.quote !== undefined && normalizeQuote(c.quote).includes(normalizeQuote(e.quote)))));
}

/**
 * Evaluate one answer against one case. Deterministic: same inputs, same
 * output. A case that is not ready is reported `not-ready` and its answer is
 * not mechanically evaluated. Even a fully valid answer only reaches
 * `awaiting-instructor-judgment`; `instructor-judged` requires a human verdict
 * on every rubric criterion and carries no aggregate result.
 */
export function evaluateBenchmarkAnswer(
  benchmark: DoctrineBenchmarkCase,
  registry: readonly DoctrineSource[],
  answer: BenchmarkAnswer,
  judgments: readonly InstructorJudgment[] = [],
): BenchmarkEvaluation {
  const readiness = validateBenchmarkCase(benchmark, registry);
  const rubric = benchmark.rubric ?? [];
  const criteria = rubric.map(c => ({ ...c, judgments: judgments.filter(j => j.criterionId === c.id && j.reviewer?.trim()) }));
  const unmatchedJudgments = judgments.filter(j => !rubric.some(c => c.id === j.criterionId) || !j.reviewer?.trim());
  const base = { schema: DOCTRINE_BENCHMARK_SCHEMA, caseId: benchmark.id, readiness, limitations: [...BENCHMARK_LIMITATIONS] };

  if (!readiness.ready) {
    return {
      ...base,
      overall: 'not-ready',
      mechanical: { status: 'not-evaluated', citations: [], coverage: [], answerIssues: [] },
      semantic: { status: 'not-evaluated', criteria, unmatchedJudgments },
      expertApproval: 'missing',
    };
  }

  const answerIssues: MechanicalReport['answerIssues'] = [];
  if (answer.caseId !== benchmark.id) answerIssues.push('case-mismatch');
  if (!answer.citations.length) answerIssues.push('no-citations');
  const citations = answer.citations.map(c => ({ ...c, result: checkCitation(c, benchmark, registry) }));
  const valid = citations.filter(c => c.result === 'valid');
  const coverage = benchmark.expectedEvidence.map(e => ({ ...e, covered: isCovered(e, valid) }));

  const status: MechanicalStatus = answerIssues.length || valid.length !== citations.length
    ? 'invalid'
    : coverage.every(e => e.covered) ? 'valid' : 'incomplete';
  const allJudged = criteria.length > 0 && criteria.every(c => c.judgments.length > 0);
  const semanticStatus: SemanticStatus = allJudged ? 'instructor-judged' : 'pending-instructor-judgment';

  return {
    ...base,
    overall: status !== 'valid' ? 'mechanical-issues' : allJudged ? 'instructor-judged' : 'awaiting-instructor-judgment',
    mechanical: { status, citations, coverage, answerIssues },
    semantic: { status: semanticStatus, criteria, unmatchedJudgments },
    expertApproval: 'supplied-by-instructor',
  };
}
