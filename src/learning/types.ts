/**
 * Learning projection contracts.
 *
 * Everything here is data the caller already holds (store rows, events,
 * reports, the curriculum JSON). The learning module performs no I/O and never
 * mutates its inputs. Identity is compared as an opaque subject string: the
 * caller resolves a native (signed `x-user-id`) or local-demo identity to
 * `subject` before calling in.
 */

export type LearnerRole = 'commander' | 'intelligence' | 'instructor';
export type ExerciseKind = 'live' | 'recorded' | 'branch';
export type Side = 'blue' | 'red';

export interface LearningIdentity {
  /** Authenticated subject. Exact string match is the only identity test. */
  subject: string;
  role: LearnerRole;
  organization: string;
}

/** Assistance the participant had during the attempt. Noted, never deducted. */
export type Assistance = 'unassisted' | 'staff-assisted' | 'unknown';

export interface ExerciseMeta {
  id: string;
  name?: string;
  kind: ExerciseKind;
  /** Subject that played the human seat. Absent on unattributed local sessions. */
  ownerSubject?: string;
  /** Active authenticated exercise enrollment; original ownership is preserved. */
  participants?: {subject:string;joinedTick:number}[];
  /** Scenario family, e.g. `crosscurrent`. Attempts on other scenarios are not comparable. */
  scenarioId?: string;
  /** Curriculum version the attempt ran under, e.g. `0.1.0`. Major must match to compare. */
  curriculumVersion?: string;
  assistance?: Assistance;
  humanSide?: Side;
  parentId?: string;
  forkTick?: number;
  createdAt?: string;
  status?: string;
}

/** Shape of `Store.events()` rows; `details` is the free-form JSON body. */
export interface LearningEvent {
  id: string;
  sequence?: number;
  tick: number;
  kind: string;
  actor: string;
  side?: string | null;
  summary: string;
  details: Record<string, any>;
  recordedAt?: string;
}

/** Shape of `Store.reports()` rows. */
export interface LearningReport {
  packet?:import('../scenarios/evidence-records').PacketRecord['packet'];
  id: string;
  tick: number;
  side: Side | string;
  title: string;
  body?: string;
  source?: string;
  confidence?: string;
  supersedes?: string;
  parentSourceId?: string;
  synthetic?: boolean;
  observedTroops?: number;
  observedTiles?: number;
}

/**
 * Explicit rationale evidence. Read from a human command event's
 * `details.rationale` / `details.rationaleTiming` / `details.sourceIds`, or from a
 * separate `decision_log` event whose `details.commandId` points at the command.
 * Absence means "unobserved", never "failed".
 */
export interface RationaleEvidence {
  text: string;
  sourceIds: string[];
  timing: 'contemporaneous' | 'post-hoc' | 'unknown';
  /** Event that carried the rationale (the command itself or a decision_log event). */
  evidenceId: string;
  // Provenance fields (optional so dossiers built before 2026-09-13 still satisfy the contract).
  /** `citation-only` means sources were cited without any text: provenance for the order, never a reason. */
  form?: RationaleForm;
  /** Tick the primary evidence was recorded at (the execution tick for submission evidence). */
  tick?: number;
  recordedAt?: string;
  /** Every recorded statement in record order. Nothing is dropped when a later annotation is added. */
  statements?: RationaleStatement[];
  /** How the primary statement was chosen; see `RationaleStatement`. */
  selection?: RationaleSelection;
}

export type RationaleForm = 'statement' | 'citation-only';

/**
 * `contemporaneous`: submission-time text is primary and is never displaced by a
 * later annotation. `latest-post-hoc`: only post-hoc statements have text, so the
 * latest one is current and earlier ones remain in `statements`.
 */
export type RationaleSelection = 'contemporaneous' | 'latest-post-hoc';

/** One recorded piece of rationale evidence for an order. Runtime shape produced by `evidence.ts`. */
export interface RationaleStatement {
  /** Event that carried it: the command itself or a `decision_log` event. */
  evidenceId: string;
  /** Empty when `form` is `citation-only`. */
  text: string;
  form: RationaleForm;
  sourceIds: string[];
  timing: RationaleEvidence['timing'];
  /** Tick the evidence was recorded at. */
  tick: number;
  recordedAt?: string;
}

export interface ExerciseRecord {
  exercise: ExerciseMeta;
  events: LearningEvent[];
  reports: LearningReport[];
}

/** Minimal view of docs/pilot/exercise-curriculum.json. The real file satisfies it. */
export interface Curriculum {
  curriculum_id: string;
  version: string;
  status?: string;
  sources: { id: string; title: string; status: string; note?: string }[];
  objectives: { id: string; name: string; statement: string; rubric_criterion: string | null; evidence_kinds?: string[]; note?: string }[];
  rubric: { version?: string; criteria: { id: string; name: string; objective: string }[]; rules?: string[] };
  misconceptions?: { id: string; statement: string; correction: string; objective: string | null }[];
  practice_variants?: { id: string; name: string; purpose?: string; implemented?: boolean }[];
}

export interface LearningInput {
  identity: LearningIdentity;
  current: ExerciseRecord;
  /** Any exercises the caller considers candidates. Eligibility is decided here. */
  candidates: ExerciseRecord[];
  curriculum: Curriculum;
}

// ---------------------------------------------------------------------------
// Dossier output
// ---------------------------------------------------------------------------

export type ExclusionReason =
  | 'self'
  | 'different-subject'
  | 'unattributed'
  | 'different-scenario'
  | 'curriculum-major-mismatch'
  | 'not-prior';

export type AttemptLabel = 'current' | 'independent-prior' | 'informed-practice';

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
  firstTick?: number;
  lastTick?: number;
}

export interface ObservedBehavior {
  /** Human command (or assessment) event ID. */
  evidenceId: string;
  /** Tick the record was made at. */
  tick: number;
  /** Tick the participant was viewing when the record was made. Absent on older dossiers and on watches; equals `tick` when the record was live. */
  observedTick?: number;
  kind: 'command' | 'assessment' | 'watch';
  summary: string;
  /** Troops committed relative to a client-returned snapshot, or admission on older records. */
  commitmentRatio?: number;
  observationBasis?: 'client-snapshot' | 'server-admission';
  /** Only ever a written statement. Null means unobserved, or that only a bare citation exists (see `citation`). */
  rationale: RationaleEvidence | null;
  /** Citation recorded without any text. Provenance for the order, never a reason. */
  citation?: RationaleStatement;
  /** Report IDs cited; each tagged against the currency at the order's observed tick. */
  citedSources: { id: string; status: 'current' | 'superseded' | 'unknown'; supersededBy?: string }[];
  /** Report IDs released on the actor's side at or before the observed tick. */
  availableReportIds: string[];
  criteria: string[];
}

export type GapKind =
  | 'rationale-unobserved'
  | 'rationale-post-hoc-only'
  | 'rationale-uncited'
  | 'superseded-source-cited'
  | 'release-without-recorded-response'
  | 'assessment-uncited'
  | 'no-recorded-uncertainty-action';

export interface ObservedGap {
  kind: GapKind;
  criterion: string;
  objective: string;
  evidenceIds: string[];
  /** Descriptive; states what is unobserved, not what was wrong. */
  note: string;
}

export interface PracticeItem {
  objective: string;
  criterion: string | null;
  title: string;
  instruction: string;
  basedOn: GapKind | 'default';
  evidenceIds: string[];
}

export interface CounterfactualSummary {
  exerciseId: string;
  name?: string;
  parentId?: string;
  forkTick?: number;
  humanCommandsAfterFork: number;
  lastObserved?: { tick: number; troops?: number; tiles?: number };
  evidenceIds: string[];
}

export interface Dossier {
  schema: 'replay.dossier/1';
  generatedAt?: string;
  learner: LearningIdentity;
  provenance: {
    curriculumId: string;
    curriculumVersion: string;
    curriculumStatus: string;
    rubricVersion?: string;
    reviewedSourceIds: string[];
    criteriaMethod: string;
  };
  current: AttemptSummary;
  independentPrior: AttemptSummary[];
  informedPractice: AttemptSummary[];
  excluded: { exerciseId: string; reason: ExclusionReason }[];
  observations: ObservedBehavior[];
  gaps: ObservedGap[];
  /** Descriptive comparison lines against independent prior attempts. No score. */
  comparison: string[];
  /** Questions to put to the learner where the record is silent. */
  probes: { evidenceId: string; question: string }[];
  practice: PracticeItem[];
  nextSession: { role: LearnerRole; variantId: string; focus: string[]; steps: string[] };
  counterfactual: { attempts: CounterfactualSummary[]; note: string };
  roleSummary: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Debrief context / validation
// ---------------------------------------------------------------------------

export type ReferenceKind =
  | 'facilitator-note'
  | 'command'
  | 'rationale'
  | 'state'
  | 'report'
  | 'staff_update'
  | 'model_decision'
  | 'tool_result'
  | 'engine_observation'
  | 'criterion'
  | 'curriculum-source';

export interface DebriefReference {
  id: string;
  kind: ReferenceKind;
  tick?: number;
  /** `available-then`: at or before the order's observed tick and on the participant's side. */
  availability: 'available-then' | 'hindsight' | 'criterion';
  content: string;
  /** For curriculum sources: review status; only `approved` supports doctrine claims. */
  status?: string;
}

export interface DebriefContext {
  schema: 'replay.debrief-context/1';
  exerciseId: string;
  commandEventId: string;
  side: string;
  tick: number;
  observedTick: number;
  references: DebriefReference[];
  retrieval?: import('./decision-retrieval').DecisionRetrieval;
  sentReferenceIds?: string[];
  availableThenIds: string[];
  hindsightIds: string[];
  criterionIds: string[];
  prompt: { instructions: string; input: string; maxChars: number; truncated: boolean };
  outputSchema: Record<string, unknown>;
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

export interface DebriefValidation {
  ok: boolean;
  errors: string[];
  debrief?: Debrief;
}
