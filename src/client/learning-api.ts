import type {BudgetLimit, Allowance} from '../inference/allowance';
// Client contract for /api/learning/*. Mirrors src/server/learning-routes.ts and the
// learning module's public types; only fields the panel renders are declared here.
import { ApiError } from './api';
import type { ExerciseKind, Role } from './api';

export type AttemptLabel = 'current' | 'independent-prior' | 'informed-practice';
export type Assistance = 'unassisted' | 'staff-assisted' | 'unknown';

export interface AttemptCounts {
  humanCommands: number;
  commandsWithRationale: number;
  contemporaneousRationale: number;
  commandsCitingSources: number;
  commandsCitingSupersededSource: number;
  reportsReleased: number;
  releasesFollowedByRecordedAction: number;
  watchesCreated: number;
  assessmentsLogged: number;
  assessmentsCitingSources: number;
  staffQuestions: number;
  /** Orders whose only evidence is a citation without a written reason. Absent on dossiers built before 2026-09-13. */
  commandsCitingWithoutStatement?: number;
}

export interface AttemptSummary {
  exerciseId: string;
  name?: string;
  kind: ExerciseKind;
  label: AttemptLabel;
  assistance: Assistance;
  parentId?: string;
  forkTick?: number;
  counts: AttemptCounts;
}

export type RationaleTiming = 'contemporaneous' | 'post-hoc' | 'unknown';
export type RationaleForm = 'statement' | 'citation-only';

/** One recorded piece of rationale evidence. Mirrors `RationaleStatement` in src/learning/types.ts. */
export interface RationaleStatement {
  evidenceId: string;
  /** Empty when `form` is `citation-only`. */
  text: string;
  form: RationaleForm;
  sourceIds: string[];
  timing: RationaleTiming;
  tick: number;
  recordedAt?: string;
}

export interface RationaleEvidence {
  text: string;
  sourceIds: string[];
  timing: RationaleTiming;
  evidenceId: string;
  // Optional provenance (absent on dossiers built before 2026-09-13).
  form?: RationaleForm;
  tick?: number;
  recordedAt?: string;
  statements?: RationaleStatement[];
  selection?: 'contemporaneous' | 'latest-post-hoc';
}

export type CitedSource = { id: string; status: 'current' | 'superseded' | 'unknown'; supersededBy?: string };

export interface ObservedBehavior {
  evidenceId: string;
  /** Tick the record was made at. */
  tick: number;
  /** Tick the participant was viewing when the record was made. Absent on older dossiers and on watches. */
  observedTick?: number;
  kind: 'command' | 'assessment' | 'watch';
  summary: string;
  commitmentRatio?: number;
  observationBasis?: 'client-snapshot' | 'server-admission';
  /** Only ever a written statement; null when unobserved or citation-only. */
  rationale: RationaleEvidence | null;
  /** Citation recorded without text. Provenance, never a reason. */
  citation?: RationaleStatement;
  citedSources: CitedSource[];
  availableReportIds: string[];
  criteria: string[];
}

// ---------------------------------------------------------------------------
// Pure display projection. No React, no I/O; unit-tested in
// tests/client/learning-provenance-display.test.ts.
// ---------------------------------------------------------------------------

/** Status a record's reason evidence is shown under. `citation-only` never reads as a reason. */
export type ReasonStatus = 'contemporaneous' | 'post-hoc' | 'unknown-timing' | 'citation-only' | 'not-observed' | 'not-applicable';

export interface StatementView {
  evidenceId: string;
  text: string;
  timing: RationaleTiming;
  tick: number;
  recordedAt?: string;
  /** Short role label distinguishing the statement from the primary one. */
  label: string;
  /** Cited sources with currency at the order's observed tick when known. */
  sources: CitedSource[];
}

export interface ObservationProvenance {
  status: ReasonStatus;
  /** Tag text shown beside the record. Never says "reason" for a citation-only record. */
  tag: string;
  tagTone: 'plain' | 'warn' | 'muted';
  /** Written statement shown as the participant's reason, with its own label. Null for citation-only / unobserved. */
  primary: StatementView | null;
  /** Statements other than the primary one, in record order, each labelled. Never merged into `primary`. */
  others: StatementView[];
  /** Sources cited without a written reason (citation-only records) or by the primary statement. */
  citations: CitedSource[];
  /** Whether `citations` came from a bare citation, so the UI must not describe them as supporting a reason. */
  citationsWithoutReason: boolean;
  /** Tick the record was made at. */
  recordedTick: number;
  /** Tick the participant was viewing. Equals `recordedTick` when unknown or live. */
  observedTick: number;
  /** The observed snapshot precedes server recording. This can be ordinary live transport delay; it does not establish post-hoc timing. */
  snapshotLag: boolean;
  /** Short tick label: `t12` or `viewed t3 · recorded t400`. */
  tickLabel: string;
}

function statementLabel(s: RationaleStatement, primary: RationaleStatement | undefined, selection: RationaleEvidence['selection']): string {
  if (primary && s.evidenceId === primary.evidenceId) {
    if (s.timing === 'post-hoc') return selection === 'latest-post-hoc' ? 'post-hoc statement (current)' : 'post-hoc statement';
    return s.timing === 'contemporaneous' ? 'statement at submission' : 'statement (timing unknown)';
  }
  if (s.form === 'citation-only') return s.timing === 'post-hoc' ? 'later citation, no written reason' : 'citation at submission, no written reason';
  if (s.timing === 'post-hoc') {
    if (selection === 'latest-post-hoc') return 'earlier post-hoc statement (superseded by the later one)';
    return 'later annotation (post-hoc)';
  }
  return s.timing === 'contemporaneous' ? 'statement at submission' : 'statement (timing unknown)';
}

function withStatus(ids: string[], cited: CitedSource[]): CitedSource[] {
  return ids.map((id) => cited.find((c) => c.id === id) ?? { id, status: 'unknown' as const });
}

/**
 * Project one observed record into what the panel shows. Rules:
 * - A written statement is the only thing labelled a reason. Citation-only evidence is shown as sources cited, with an explicit "no written reason".
 * - Every recorded statement is kept. The primary one is the submission-time text when it exists; later post-hoc text is listed separately and never displaces it.
 * - `observedTick` (what the participant was viewing) is separated from `tick` (when the record was written).
 * Older dossiers without the optional fields fall back to the pre-existing behaviour.
 */
export function provenanceOf(o: ObservedBehavior): ObservationProvenance {
  const recordedTick = o.tick;
  const observedTick = typeof o.observedTick === 'number' ? o.observedTick : o.tick;
  const snapshotLag = observedTick < recordedTick;
  const tickLabel = snapshotLag ? `viewed t${observedTick} · recorded t${recordedTick}` : `t${recordedTick}`;
  const base = { recordedTick, observedTick, snapshotLag, tickLabel };

  if (o.rationale) {
    const r = o.rationale;
    const statements = r.statements?.length ? r.statements : [{ evidenceId: r.evidenceId, text: r.text, form: 'statement' as const, sourceIds: r.sourceIds, timing: r.timing, tick: r.tick ?? recordedTick, ...(r.recordedAt ? { recordedAt: r.recordedAt } : {}) }];
    const primaryStmt = statements.find((s) => s.evidenceId === r.evidenceId) ?? statements[0];
    const view = (s: RationaleStatement): StatementView => ({ evidenceId: s.evidenceId, text: s.text, timing: s.timing, tick: s.tick, ...(s.recordedAt ? { recordedAt: s.recordedAt } : {}), label: statementLabel(s, primaryStmt, r.selection), sources: withStatus(s.sourceIds, o.citedSources) });
    const status: ReasonStatus = r.timing === 'contemporaneous' ? 'contemporaneous' : r.timing === 'post-hoc' ? 'post-hoc' : 'unknown-timing';
    return {
      ...base, status,
      tag: `reason recorded · ${r.timing === 'unknown' ? 'timing unknown' : r.timing}`,
      tagTone: r.timing === 'contemporaneous' ? 'plain' : 'warn',
      primary: view(primaryStmt),
      others: statements.filter((s) => s.evidenceId !== primaryStmt.evidenceId).map(view),
      citations: withStatus(primaryStmt.sourceIds, o.citedSources),
      citationsWithoutReason: false,
    };
  }
  if (o.citation) {
    const c = o.citation;
    return {
      ...base, status: 'citation-only',
      tag: 'citation only · no written reason',
      tagTone: 'muted',
      primary: null,
      others: [],
      citations: withStatus(c.sourceIds.length ? c.sourceIds : o.citedSources.map((s) => s.id), o.citedSources),
      citationsWithoutReason: true,
    };
  }
  if (o.kind === 'command') return { ...base, status: 'not-observed', tag: 'reason not observed', tagTone: 'muted', primary: null, others: [], citations: [], citationsWithoutReason: false };
  return { ...base, status: 'not-applicable', tag: '', tagTone: 'muted', primary: null, others: [], citations: o.citedSources, citationsWithoutReason: false };
}

/** Attempt-table cell for "citing source": the count plus how many of those had no written reason, when the dossier records it. */
export function citingSourceCell(c: AttemptCounts): string {
  const n = c.commandsCitingSources;
  const without = c.commandsCitingWithoutStatement;
  return typeof without === 'number' && without > 0 ? `${n} (${without} without reason)` : String(n);
}

/** Split a debrief reference ID into its event ID and any evidence suffix, e.g. `<id>:citation`. */
export function splitReferenceId(id: string): [string, 'before' | 'after' | 'rationale' | 'citation' | null] {
  const m = /^(.*):(before|after|rationale|citation)$/.exec(id);
  return m ? [m[1], m[2] as 'before' | 'after' | 'rationale' | 'citation'] : [id, null];
}

export function referenceSuffixLabel(suffix: string | null): string | null {
  switch (suffix) {
    case 'before': return 'state at submission';
    case 'after': return 'state after execution';
    case 'rationale': return 'statement';
    case 'citation': return 'citation only, no written reason';
    default: return suffix;
  }
}

export interface ObservedGap {
  kind: string;
  criterion: string;
  objective: string;
  evidenceIds: string[];
  note: string;
}

export interface PracticeItem {
  objective: string;
  criterion: string | null;
  title: string;
  instruction: string;
  basedOn: string;
  evidenceIds: string[];
}

export interface Dossier {
  schema: string;
  generatedAt?: string;
  learner: { subject: string; role: Role; organization: string };
  provenance: { curriculumId: string; curriculumVersion: string; curriculumStatus: string; rubricVersion?: string; reviewedSourceIds: string[]; criteriaMethod: string };
  current: AttemptSummary;
  independentPrior: AttemptSummary[];
  informedPractice: AttemptSummary[];
  excluded: { exerciseId: string; reason: string }[];
  observations: ObservedBehavior[];
  gaps: ObservedGap[];
  comparison: string[];
  probes: { evidenceId: string; question: string }[];
  practice: PracticeItem[];
  nextSession: { role: Role; variantId: string; focus: string[]; steps: string[] };
  counterfactual: { attempts: { exerciseId: string; name?: string; forkTick?: number; humanCommandsAfterFork: number; lastObserved?: { tick: number; troops?: number; tiles?: number } }[]; note: string };
  roleSummary: string;
  limitations: string[];
}

export interface Budget { allowance?: Allowance;
  requestsUsed: number;
  maxRequests: BudgetLimit;
  committedUsd: number;
  maxUsd: BudgetLimit;
}

export interface DossierResponse {
  attributed: boolean;
  reason: string;
  dossier: Dossier | null;
  exerciseId: string;
  budget: Budget;
}

export interface DebriefClaim {
  text: string;
  citations: string[];
  basis?: 'available-then' | 'hindsight';
}

export interface Debrief {
  headline: DebriefClaim;
  observations: DebriefClaim[];
  opponentPerspective: DebriefClaim[];
  tradeoffs: DebriefClaim[];
  questions: DebriefClaim[];
  nextPractice: DebriefClaim[];
  limitations: DebriefClaim[];
}

export interface DebriefReference {
  id: string;
  kind: string;
  tick?: number;
  availability: 'available-then' | 'hindsight' | 'criterion';
  content: string;
  status?: string;
}

export interface DebriefRecord {
  exerciseId: string;
  eventId: string;
  hash: string;
  author: string;
  generatedAt: string;
  debrief: Debrief;
  markdown: string;
  references: DebriefReference[];
  availableThenIds: string[];
  hindsightIds: string[];
  receipt: { id: string; status: string; modelRequested: string; modelReturned: string | null; settledUsd: number | null; createdAt: string };
  prompt: { truncated: boolean; inputChars: number };
  sentReferenceIds?:string[];
  retrieval?:import('../learning/decision-retrieval').DecisionRetrieval;
}

export interface DebriefResponse {
  status: 'generated' | 'cached';
  stale: boolean;
  record: DebriefRecord;
  budget: Budget;
}

export interface DecisionLogResult {
  id: string;
  tick: number;
  timing: 'post-hoc';
  commandEventId: string;
  sourceIds: string[];
  recordedAt: string;
}

export interface AssessmentResult {
  id: string;
  tick: number;
  observedTick: number;
  timing: 'contemporaneous' | 'post-hoc';
  sourceIds: string[];
  recordedAt: string;
}

/** Server error with structured extras (validation errors, receipt id). */
export class LearningApiError extends ApiError {
  readonly errors: string[];
  readonly receiptId: string | null;
  constructor(status: number, message: string, extra: { errors?: unknown; receiptId?: unknown } = {}) {
    super(status, message);
    this.name = 'LearningApiError';
    this.errors = Array.isArray(extra.errors) ? extra.errors.filter((e): e is string => typeof e === 'string') : [];
    this.receiptId = typeof extra.receiptId === 'string' ? extra.receiptId : null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new LearningApiError(0, 'Backend unreachable');
  }
  if (!res.ok) {
    let body: { error?: unknown; errors?: unknown; receiptId?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON error body */
    }
    throw new LearningApiError(res.status, typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`.trim(), body);
  }
  return (await res.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

export const learningApi = {
  dossier: (signal?: AbortSignal) => request<DossierResponse>('/api/learning/dossier', { signal, cache: 'no-store' }),
  /** Browser download target for the Markdown export. */
  dossierMarkdownUrl: '/api/learning/dossier.md',
  decisionLog: (eventId: string, text: string, sourceIds: string[]) => post<DecisionLogResult>('/api/learning/decision-log', { eventId, text, sourceIds }),
  assessment: (text: string, sourceIds: string[], exerciseId?:string) => post<AssessmentResult>('/api/learning/assessment', { text, sourceIds, ...(exerciseId?{exerciseId}:{}) }),
  retrieveDecision: (eventId:string) => request<{exerciseId:string;eventId:string;retrieval:import('../learning/decision-retrieval').DecisionRetrieval}>(`/api/learning/retrieval/${encodeURIComponent(eventId)}`,{cache:'no-store'}),
  cachedDebrief: (eventId: string, signal?: AbortSignal) => request<DebriefResponse>(`/api/learning/debrief/${encodeURIComponent(eventId)}`, { signal, cache: 'no-store' }),
  /** Paid. One request; the server caches by exercise, order and evidence hash and never retries on its own. */
  generateDebrief: (eventId: string) => post<DebriefResponse>('/api/learning/debrief', { eventId }),
};
