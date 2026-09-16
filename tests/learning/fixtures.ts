import curriculumJson from '../../docs/pilot/exercise-curriculum.json';
import type { Curriculum, ExerciseMeta, ExerciseRecord, LearningEvent, LearningIdentity, LearningReport } from '../../src/learning/index';

export const curriculum = curriculumJson as unknown as Curriculum;

export const learner: LearningIdentity = { subject: 'user-alpha', role: 'commander', organization: 'NPS training workspace' };
export const other: LearningIdentity = { subject: 'user-bravo', role: 'commander', organization: 'NPS training workspace' };

let seq = 0;
export function ev(partial: Partial<LearningEvent> & { kind: string; tick: number }): LearningEvent {
  seq++;
  const e: LearningEvent = {
    id: partial.id ?? `evt-${partial.kind}-${seq}`, sequence: partial.sequence ?? seq, tick: partial.tick, kind: partial.kind,
    actor: partial.actor ?? learner.subject, side: partial.side === undefined ? 'blue' : partial.side, summary: partial.summary ?? partial.kind, details: partial.details ?? {},
  };
  if (partial.recordedAt) e.recordedAt = partial.recordedAt;
  return e;
}

export function report(id: string, tick: number, supersedes?: string, side = 'blue'): LearningReport {
  return { id, tick, side, title: supersedes ? `Updated resource estimate (${id})` : `Initial resource estimate (${id})`, body: `At tick ${tick} the opposing player controls 40 tiles and has 1,000 uncommitted forces.`, source: `Engine observation at tick ${tick} · fictional exercise`, supersedes, observedTroops: 1000, observedTiles: 40, synthetic: true };
}

export function order(opts: { id?: string; tick: number; observedTick?: number; troops?: number; before?: number; actor?: string; side?: string; rationale?: string; rationaleTiming?: 'contemporaneous' | 'post-hoc'; sourceIds?: string[]; after?: { troops: number; tiles: number }; origin?: string }): LearningEvent {
  const troops = opts.troops ?? 200, before = opts.before ?? 1000;
  return ev({
    id: opts.id, kind: 'command', tick: opts.tick, actor: opts.actor, side: opts.side, summary: `Expanded with ${troops} forces`,
    details: { commandId: `cmd-${opts.id ?? seq + 1}`, origin: opts.origin ?? 'human', intent: { type: 'attack', targetID: null, troops }, observedTick: opts.observedTick ?? opts.tick - 1, before: { troops: before, tiles: 30 }, after: opts.after ?? { troops: before - troops, tiles: 32 }, ...(opts.rationale ? { rationale: opts.rationale, rationaleTiming: opts.rationaleTiming, sourceIds: opts.sourceIds } : {}) },
  });
}

export function meta(partial: Partial<ExerciseMeta> & { id: string }): ExerciseMeta {
  return { name: partial.id, kind: 'live', ownerSubject: learner.subject, scenarioId: 'crosscurrent', curriculumVersion: '0.1.0', assistance: 'unassisted', humanSide: 'blue', createdAt: '2026-09-13T10:00:00Z', ...partial };
}

/** A typical live attempt: two releases, three orders, one with a contemporaneous cited reason. */
export function liveAttempt(id = 'ex-current', overrides: Partial<ExerciseMeta> = {}): ExerciseRecord {
  const reports = [report(`${id}-r1`, 0), report(`${id}-r2`, 300, `${id}-r1`)];
  const events: LearningEvent[] = [
    ev({ kind: 'exercise_started', tick: 0, actor: 'facilitator', side: null }),
    ev({ kind: 'report', tick: 0, actor: 'exercise-reporter', details: { reportId: reports[0].id } }),
    order({ id: `${id}-o1`, tick: 50, rationale: 'Expand while the estimate is fresh; keep 800 in reserve.', rationaleTiming: 'contemporaneous', sourceIds: [reports[0].id] }),
    order({ id: `${id}-o2`, tick: 200, troops: 700 }),
    ev({ kind: 'report', tick: 300, actor: 'exercise-reporter', details: { reportId: reports[1].id, supersedes: reports[0].id } }),
    order({ id: `${id}-o3`, tick: 400, troops: 100 }),
  ];
  return { exercise: meta({ id, ...overrides }), events, reports };
}
