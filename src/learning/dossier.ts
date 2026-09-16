import { belongsToLearner, classifyCandidate } from './eligibility';
import { citedSourceIds, commitmentRatio, humanCommands, observedTick, rationaleFor, releaseResponses, reportsAvailable, shortId, sourceStatusAt, type RationaleRecord, type RationaleStatement } from './evidence';
import type {
  AttemptCounts, AttemptLabel, AttemptSummary, CounterfactualSummary, Curriculum, Dossier, ExerciseRecord,
  GapKind, LearnerRole, LearningInput, ObservedBehavior, ObservedGap, PracticeItem,
} from './types';

const OBJECTIVE_BY_CRITERION: Record<string, string> = { C1: 'OBJ-1', C2: 'OBJ-2', C3: 'OBJ-3', C4: 'OBJ-4', C5: 'OBJ-5', C6: 'OBJ-6', C7: 'OBJ-7' };

/**
 * Observed behaviour with evidence provenance. `rationale` is only ever a
 * written statement (with every recorded statement attached); a citation
 * recorded without text is carried separately in `citation` so it is never
 * displayed as a reason. `observedTick` is the tick the participant was
 * viewing when the record was made; `tick` is when it was recorded.
 */
export interface ObservedBehaviorRecord extends ObservedBehavior {
  rationale: RationaleRecord | null;
  citation?: RationaleStatement;
  observedTick?: number;
}

/** Attempt counts plus the number of orders whose only evidence is a citation without a written reason. */
export interface AttemptCountsRecord extends AttemptCounts {
  commandsCitingWithoutStatement: number;
}

function criterionFor(curriculum: Curriculum, objective: string): string | null {
  return curriculum.objectives.find(o => o.id === objective)?.rubric_criterion ?? null;
}

function summarizeAttempt(record: ExerciseRecord, subject: string, label: AttemptLabel): AttemptSummary {
  const { exercise, events, reports } = record;
  const own = events.filter(e => e.actor === subject);
  const commands = humanCommands(events).filter(e => e.actor === subject);
  const side = exercise.humanSide;
  const counts: AttemptCountsRecord = {
    humanCommands: commands.length, commandsWithRationale: 0, contemporaneousRationale: 0, commandsCitingSources: 0, commandsCitingSupersededSource: 0, commandsCitingWithoutStatement: 0,
    reportsReleased: 0, releasesFollowedByRecordedAction: 0, watchesCreated: own.filter(e => e.kind === 'task_created').length,
    assessmentsLogged: own.filter(e => e.kind === 'assessment_log').length,
    assessmentsCitingSources: own.filter(e => e.kind === 'assessment_log' && Array.isArray(e.details?.sourceIds) && e.details.sourceIds.length).length,
    staffQuestions: own.filter(e => e.kind === 'staff_answer').length,
  };
  for (const c of commands) {
    const r = rationaleFor(c, events);
    if (!r) continue;
    // A written statement is a reason; a bare citation is provenance only and is counted apart.
    if (r.form === 'statement') {
      counts.commandsWithRationale++;
      if (r.timing === 'contemporaneous') counts.contemporaneousRationale++;
    } else counts.commandsCitingWithoutStatement++;
    const cited = citedSourceIds(r);
    if (cited.length) counts.commandsCitingSources++;
    if (cited.some(id => sourceStatusAt(reports, id, observedTick(c)).status === 'superseded')) counts.commandsCitingSupersededSource++;
  }
  const releases = releaseResponses(record, subject);
  counts.reportsReleased = releases.length;
  counts.releasesFollowedByRecordedAction = releases.filter(r => r.answered).length;
  const ticks = own.map(e => e.tick);
  return {
    exerciseId: exercise.id, name: exercise.name, kind: exercise.kind, label, assistance: exercise.assistance ?? 'unknown',
    parentId: exercise.parentId, forkTick: exercise.forkTick, counts,
    firstTick: ticks.length ? Math.min(...ticks) : undefined, lastTick: ticks.length ? Math.max(...ticks) : undefined,
  };
}

function observe(record: ExerciseRecord, subject: string, curriculum: Curriculum): ObservedBehaviorRecord[] {
  const { events, reports } = record;
  const out: ObservedBehaviorRecord[] = [];
  for (const c of humanCommands(events).filter(e => e.actor === subject)) {
    const at = observedTick(c), evidence = rationaleFor(c, events);
    // Only a written statement is a rationale. Citation-only evidence stays visible as `citation` and in citedSources.
    const rationale = evidence && evidence.form === 'statement' ? evidence : null;
    const citation = evidence && evidence.form === 'citation-only' ? evidence.statements.find(s => s.form === 'citation-only') : undefined;
    const cited = evidence ? citedSourceIds(evidence) : [];
    const criteria = ['C5'];
    if (c.details?.intent?.type === 'attack') criteria.push('C4');
    if (cited.length) criteria.push('C1', 'C2');
    out.push({
      evidenceId: c.id, tick: c.tick, observedTick: at, kind: 'command', summary: c.summary, commitmentRatio: commitmentRatio(c), observationBasis:c.details.observation?'client-snapshot':'server-admission', rationale,
      ...(citation ? { citation } : {}),
      citedSources: cited.map(id => ({ id, ...sourceStatusAt(reports, id, at) })),
      availableReportIds: reportsAvailable(reports, c.side, at).map(r => r.id), criteria: criteria.filter(k => curriculum.rubric.criteria.some(x => x.id === k)),
    });
  }
  for (const a of events.filter(e => e.kind === 'assessment_log' && e.actor === subject)) {
    const ids: string[] = Array.isArray(a.details?.sourceIds) ? a.details.sourceIds : [];
    // Currency and availability are judged at the tick the analyst was viewing, not the live tick the entry was written at.
    const at = observedTick(a);
    out.push({
      evidenceId: a.id, tick: a.tick, observedTick: at, kind: 'assessment', summary: a.summary, rationale: null,
      citedSources: ids.map(id => ({ id, ...sourceStatusAt(reports, id, at) })),
      availableReportIds: reportsAvailable(reports, a.side, at).map(r => r.id), criteria: ['C2', 'C1'],
    });
  }
  for (const t of events.filter(e => e.kind === 'task_created' && e.actor === subject)) {
    out.push({ evidenceId: t.id, tick: t.tick, kind: 'watch', summary: t.summary, rationale: null, citedSources: [], availableReportIds: reportsAvailable(reports, t.side, t.tick).map(r => r.id), criteria: ['C3'] });
  }
  return out.sort((a, b) => a.tick - b.tick);
}

function findGaps(record: ExerciseRecord, subject: string, observations: ObservedBehaviorRecord[], current: AttemptSummary): ObservedGap[] {
  const gaps: ObservedGap[] = [];
  const push = (kind: GapKind, criterion: string, evidenceIds: string[], note: string) => { if (evidenceIds.length) gaps.push({ kind, criterion, objective: OBJECTIVE_BY_CRITERION[criterion], evidenceIds, note }); };
  const commands = observations.filter(o => o.kind === 'command');
  push('rationale-unobserved', 'C5', commands.filter(o => !o.rationale).map(o => o.evidenceId), 'No decision statement was recorded for these orders. The reason is unobserved; it cannot be inferred from the order. A report cited without text is provenance for the order, not a reason.');
  push('rationale-post-hoc-only', 'C5', commands.filter(o => o.rationale && o.rationale.timing === 'post-hoc').map(o => o.evidenceId), 'A reason exists but was written after the order. Post hoc statements are recorded on a separate line from contemporaneous ones.');
  push('rationale-uncited', 'C2', commands.filter(o => o.rationale && !o.citedSources.length).map(o => o.evidenceId), 'The recorded reason does not name a report, tick or map observation.');
  push('superseded-source-cited', 'C1', commands.filter(o => o.citedSources.some(s => s.status === 'superseded')).map(o => o.evidenceId), 'The reason cites a report that a later report on the same side had already superseded at the observed tick. The older report remains valid history for its own tick.');
  push('assessment-uncited', 'C2', observations.filter(o => o.kind === 'assessment' && !o.citedSources.length).map(o => o.evidenceId), 'Assessment entries without a report ID. A staff answer is assistance, not a source.');
  if (current.counts.reportsReleased > current.counts.releasesFollowedByRecordedAction) {
    const unanswered = releaseResponses(record, subject).filter(r => !r.answered);
    push('release-without-recorded-response', 'C6', unanswered.map(r => r.release.id), 'A report release has no recorded order, contemporaneous decision statement, assessment or watch from the participant before the next release. Post-hoc annotations do not count. Keeping the plan is revision behaviour only when it is written down.');
  }
  if (!observations.some(o => o.kind === 'watch') && commands.length) {
    push('no-recorded-uncertainty-action', 'C3', [commands[0].evidenceId], 'No watch or written unknown was recorded in this attempt. This is unobserved, not failed.');
  }
  return gaps;
}

function practiceFor(gaps: ObservedGap[], role: LearnerRole, curriculum: Curriculum): PracticeItem[] {
  const items: PracticeItem[] = [];
  const has = (k: GapKind) => gaps.find(g => g.kind === k);
  const add = (objective: string, title: string, instruction: string, basedOn: GapKind | 'default', evidenceIds: string[] = []) => items.push({ objective, criterion: criterionFor(curriculum, objective), title, instruction, basedOn, evidenceIds });
  let g: ObservedGap | undefined;
  if ((g = has('rationale-unobserved'))) add('OBJ-5', 'Write the reason at the time of the order', 'Before each order in the next session, write one sentence naming what you expect and what you are keeping in reserve.', g.kind, g.evidenceIds);
  if ((g = has('rationale-post-hoc-only'))) add('OBJ-5', 'Move the decision statement before the order', 'Your reasons were written afterwards. Next time, write them first; the app records the timing.', g.kind, g.evidenceIds);
  if ((g = has('rationale-uncited')) || (g = has('assessment-uncited'))) add('OBJ-2', 'Name the source', 'Each reason or assessment should name a report ID and its tick, or say "map observation at tick N". "Staff said" is not a source.', g.kind, g.evidenceIds);
  if ((g = has('superseded-source-cited'))) add('OBJ-1', 'Check currency before citing', 'Before citing a report, check whether a later report on your side supersedes it. The old one is still history; date it rather than discarding it.', g.kind, g.evidenceIds);
  if ((g = has('release-without-recorded-response'))) add('OBJ-6', 'Record a response to each release', 'After each report release, write either a change or "keep, because ...". Silence is not revision behaviour.', g.kind, g.evidenceIds);
  if ((g = has('no-recorded-uncertainty-action'))) add('OBJ-3', 'Record one unknown and act on it', 'State one thing you do not know about the opponent and create a watch or ask a staff question about it.', g.kind, g.evidenceIds);
  if (role === 'intelligence' && !items.some(i => i.objective === 'OBJ-2')) add('OBJ-2', 'Keep the assessment log sourced', 'Every assessment line names its report and tick and separates observation from inference.', 'default');
  if (!items.length) add('OBJ-7', 'Test an assumption in a branch', 'State an assumption, branch from a recorded tick, play a different legal order and compare honestly. This is informed practice, not a post measure.', 'default');
  return items;
}

function nextSession(role: LearnerRole, gaps: ObservedGap[], practice: PracticeItem[], curriculum: Curriculum) {
  const variants = curriculum.practice_variants ?? [];
  const implemented = (id: string) => variants.some(v => v.id === id && v.implemented !== false);
  let variantId = 'PV-1';
  if (gaps.some(g => g.kind === 'release-without-recorded-response') && implemented('PV-2')) variantId = 'PV-2';
  const steps = role === 'intelligence'
    ? ['Open the assessment log before the first report release.', 'For each release, log the report ID, its tick and what changed against the previous estimate.', 'Create one watch for a stated unknown.', ...practice.slice(0, 2).map(p => p.instruction)]
    : role === 'instructor'
      ? ['Release reports at the plan times and record the release ticks.', 'Ask the participant for a decision statement after any order without one.', 'Score only from written evidence; note assistance, do not deduct it.']
      : ['Before the first order, write the expected outcome and the reserve you keep.', 'At each release, record a change or an explicit keep.', ...practice.slice(0, 2).map(p => p.instruction)];
  return { role, variantId, focus: [...new Set(practice.map(p => p.objective))], steps };
}

function counterfactuals(records: ExerciseRecord[], subject: string): CounterfactualSummary[] {
  return records.map(({ exercise, events }) => {
    const cmds = humanCommands(events).filter(e => e.actor === subject && (exercise.forkTick === undefined || e.tick >= exercise.forkTick));
    const last = cmds.at(-1)?.details?.after;
    return { exerciseId: exercise.id, name: exercise.name, parentId: exercise.parentId, forkTick: exercise.forkTick, humanCommandsAfterFork: cmds.length, lastObserved: last ? { tick: cmds.at(-1)!.tick, troops: last.troops, tiles: last.tiles } : undefined, evidenceIds: cmds.map(c => c.id) };
  });
}

function compare(current: AttemptSummary, prior: AttemptSummary[]): string[] {
  if (!prior.length) return ['No independent prior attempt by this learner on this scenario and curriculum is available. Comparison lines are omitted rather than drawn from other participants or local sessions.'];
  const lines: string[] = [];
  const ratio = (c: AttemptCounts) => `${c.commandsWithRationale} of ${c.humanCommands}`;
  for (const p of prior) {
    lines.push(`Orders with a recorded reason: ${ratio(current.counts)} now; ${ratio(p.counts)} in ${p.name ?? shortId(p.exerciseId)} (${p.assistance}).`);
    lines.push(`Orders citing a source: ${current.counts.commandsCitingSources} now; ${p.counts.commandsCitingSources} then. Releases followed by a recorded response: ${current.counts.releasesFollowedByRecordedAction}/${current.counts.reportsReleased} now; ${p.counts.releasesFollowedByRecordedAction}/${p.counts.reportsReleased} then.`);
  }
  lines.push('These are counts of observed behaviour under a provisional rubric. They are not a mastery score and do not establish learning.');
  return lines;
}

function roleSummary(role: LearnerRole, current: AttemptSummary, obs: ObservedBehaviorRecord[]): string {
  const c = current.counts;
  const citationOnly = obs.filter(o => o.kind === 'command' && o.citation).length;
  const withoutText = citationOnly ? ` (${citationOnly} without a written reason)` : '';
  if (role === 'intelligence') return `Intelligence seat: ${c.assessmentsLogged} assessment entries (${c.assessmentsCitingSources} with a report ID), ${c.watchesCreated} watches, ${c.staffQuestions} staff questions, ${c.reportsReleased} releases on your side.`;
  if (role === 'instructor') return `Instructor view: ${c.humanCommands} participant orders, ${c.commandsWithRationale} with a recorded reason, ${c.commandsCitingSources} citing a source${withoutText}, ${c.reportsReleased} releases, ${c.watchesCreated} watches. Scores come from written evidence only.`;
  const ratios = obs.filter(o => o.commitmentRatio !== undefined).map(o => o.commitmentRatio!);
  const spread = ratios.length ? ` Commitment ratios ranged ${Math.round(Math.min(...ratios) * 100)}% to ${Math.round(Math.max(...ratios) * 100)}% of available forces.` : '';
  return `Commander seat: ${c.humanCommands} orders, ${c.commandsWithRationale} with a recorded reason (${c.contemporaneousRationale} contemporaneous), ${c.commandsCitingSources} citing a source${withoutText}.${spread}`;
}

/**
 * Build a personal, evidence-led dossier for the authenticated learner from
 * explicitly supplied records. Pure: no I/O, inputs are not mutated.
 */
export function buildDossier(input: LearningInput, options: { now?: string } = {}): Dossier {
  const { identity, current, candidates, curriculum } = input;
  const subject = identity.subject;
  if (current.exercise.ownerSubject && !belongsToLearner(current.exercise,subject)) throw new Error('Current exercise belongs to a different subject');
  const currentSummary = summarizeAttempt(current, subject, 'current');
  const independentPrior: AttemptSummary[] = [], informed: AttemptSummary[] = [], excluded: Dossier['excluded'] = [], informedRecords: ExerciseRecord[] = [];
  for (const cand of candidates) {
    const d = classifyCandidate(identity, current.exercise, cand.exercise);
    if (d.reason) { excluded.push({ exerciseId: cand.exercise.id, reason: d.reason }); continue; }
    if (d.label === 'informed-practice') { informed.push(summarizeAttempt(cand, subject, 'informed-practice')); informedRecords.push(cand); }
    else independentPrior.push(summarizeAttempt(cand, subject, 'independent-prior'));
  }
  const observations = observe(current, subject, curriculum);
  const gaps = findGaps(current, subject, observations, currentSummary);
  const practice = practiceFor(gaps, identity.role, curriculum);
  const probes = observations.filter(o => o.kind === 'command' && !o.rationale).map(o => ({ evidenceId: o.evidenceId, question: o.citation
    ? `At tick ${o.tick} you issued "${o.summary}" citing ${o.citation.sourceIds.join(', ')} but wrote no reason. What did you expect from that report, and what did you keep in reserve?`
    : `At tick ${o.tick} you issued "${o.summary}". What did you expect, which report or observation supported it, and what did you keep in reserve?` }));
  const cfRecords = current.exercise.kind === 'branch' ? [current, ...informedRecords] : informedRecords;
  return {
    schema: 'replay.dossier/1', generatedAt: options.now, learner: { ...identity },
    provenance: {
      curriculumId: curriculum.curriculum_id, curriculumVersion: curriculum.version, curriculumStatus: curriculum.status ?? 'unknown', rubricVersion: curriculum.rubric.version,
      reviewedSourceIds: curriculum.sources.filter(s => s.status === 'approved').map(s => s.id),
      criteriaMethod: 'Descriptive counts of recorded events against provisional rubric criteria. Missing evidence is "not observed", not failure. No decision-value evaluator exists. A release counts as followed by a recorded response only when an order, contemporaneous statement, assessment or watch by the participant falls between it and the next release on the same side; post-hoc annotations never count. Citation currency is judged at the tick the participant was viewing. A citation without text is provenance, not a reason. Where several statements exist for one order, submission-time text stays primary and the latest post-hoc statement is current; all statements are kept.',
    },
    current: currentSummary, independentPrior, informedPractice: informed, excluded, observations, gaps,
    comparison: current.exercise.kind === 'branch' ? ['This attempt is a branch: informed practice. It is not compared with independent attempts.'] : compare(currentSummary, independentPrior),
    probes, practice, nextSession: nextSession(identity.role, gaps, practice, curriculum),
    counterfactual: { attempts: counterfactuals(cfRecords, subject), note: 'Branch play is informed by the original future. Outcomes here are practice records, never a post measure or evidence of improvement.' },
    roleSummary: roleSummary(identity.role, currentSummary, observations),
    limitations: [
      `Curriculum ${curriculum.curriculum_id} ${curriculum.version} is ${curriculum.status ?? 'of unknown status'}; criteria are provisional and unreviewed.`,
      curriculum.sources.some(s => s.status === 'approved') ? 'Only sources marked approved are cited.' : 'No reviewed doctrine or dataset source is loaded; nothing here is doctrine.',
      'Reasons come only from what the learner wrote. Nothing is inferred from orders alone, and a cited report without a written reason is not treated as one.',
      'Assistance is noted, not deducted. Branch attempts are informed practice.',
      'Fictional abstract game. Nothing transfers to real-world tactics or targeting.',
      'Game outcome, decision value and learning evidence are kept separate; only learning evidence is described.',
    ],
  };
}
