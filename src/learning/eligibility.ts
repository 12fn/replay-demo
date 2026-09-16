import type { AttemptLabel, ExclusionReason, ExerciseMeta, LearningIdentity } from './types';

/** Semver major, or the raw string when it is not semver-shaped. */
export function curriculumMajor(version: string | undefined): string | undefined {
  if (!version) return undefined;
  const m = /^(\d+)(?:\.|$)/.exec(version.trim());
  return m ? m[1] : version.trim();
}

export interface EligibilityDecision {
  exerciseId: string;
  label?: AttemptLabel;
  reason?: ExclusionReason;
}

export function belongsToLearner(exercise:ExerciseMeta,subject:string):boolean{
  return exercise.ownerSubject===subject||!!exercise.participants?.some(p=>p.subject===subject);
}

/**
 * Decide whether a candidate exercise is a comparable prior attempt for the
 * authenticated learner. Only the same subject, same scenario and same
 * curriculum major version count. Branches are comparable context but are
 * labelled informed practice and never independent improvement; they are
 * listed whenever they were created, because a branch opened after the
 * current attempt is still that learner's informed practice on this
 * scenario. The "prior" date restriction applies only to independent trials:
 * a later independent attempt cannot be a baseline for an earlier one.
 */
export function classifyCandidate(identity: LearningIdentity, current: ExerciseMeta, candidate: ExerciseMeta): EligibilityDecision {
  const id = candidate.id;
  if (candidate.id === current.id) return { exerciseId: id, reason: 'self' };
  if (!candidate.ownerSubject) return { exerciseId: id, reason: 'unattributed' };
  if (!belongsToLearner(candidate,identity.subject)) return { exerciseId: id, reason: 'different-subject' };
  if (!candidate.scenarioId || !current.scenarioId || candidate.scenarioId !== current.scenarioId) return { exerciseId: id, reason: 'different-scenario' };
  const a = curriculumMajor(candidate.curriculumVersion), b = curriculumMajor(current.curriculumVersion);
  if (a === undefined || b === undefined || a !== b) return { exerciseId: id, reason: 'curriculum-major-mismatch' };
  if (candidate.kind === 'branch') return { exerciseId: id, label: 'informed-practice' };
  if (candidate.createdAt && current.createdAt && candidate.createdAt > current.createdAt) return { exerciseId: id, reason: 'not-prior' };
  return { exerciseId: id, label: 'independent-prior' };
}
