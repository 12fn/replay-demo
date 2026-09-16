/**
 * Evidence-led learning projection for REPLAY.
 *
 * Pure functions over explicitly supplied records. No I/O, no inference calls,
 * no mutation. See README.md in this directory for the integration example.
 */
export { buildDossier } from './dossier';
export { buildDebriefContext, validateDebrief, DEBRIEF_OUTPUT_SCHEMA, type DebriefContextOptions } from './debrief';
export { formatDossierMarkdown, formatDebriefMarkdown, DISCLAIMER, type MarkdownOptions } from './markdown';
export { classifyCandidate, curriculumMajor, type EligibilityDecision } from './eligibility';
export { rationaleFor, rationaleStatements, citedSourceIds, observedTick, sourceStatusAt, humanCommands, type RationaleRecord } from './evidence';
export type {
  LearnerRole, ExerciseKind, Side, LearningIdentity, Assistance, ExerciseMeta, LearningEvent, LearningReport, RationaleEvidence,
  RationaleForm, RationaleSelection, RationaleStatement,
  ExerciseRecord, Curriculum, LearningInput, ExclusionReason, AttemptLabel, AttemptCounts, AttemptSummary, ObservedBehavior,
  GapKind, ObservedGap, PracticeItem, CounterfactualSummary, Dossier, ReferenceKind, DebriefReference, DebriefContext,
  DebriefClaim, Debrief, DebriefValidation,
} from './types';
