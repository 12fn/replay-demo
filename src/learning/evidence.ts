import type { ExerciseRecord, LearningEvent, LearningReport, RationaleEvidence } from './types';

/** Human-origin command events. Inherited branch history is excluded. */
export function humanCommands(events: LearningEvent[]): LearningEvent[] {
  return events.filter(e => e.kind === 'command' && e.details?.origin === 'human');
}

/** Client-returned snapshot tick when recorded; older records use the server-admission cutoff. Neither proves attention. */
export function observedTick(command: LearningEvent): number {
  const t = command.details?.observedTick;
  return typeof t === 'number' ? t : command.tick;
}

function asStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
}

function timingOf(x: unknown): RationaleEvidence['timing'] {
  return x === 'contemporaneous' || x === 'post-hoc' ? x : 'unknown';
}

/**
 * One recorded piece of rationale evidence for an order. `form` separates a
 * written statement from a bare citation: a citation recorded at submission is
 * provenance for the order, never a statement of the participant's reasoning.
 */
export interface RationaleStatement {
  /** Event that carried it: the command itself or a `decision_log` event. */
  evidenceId: string;
  /** Empty when `form` is `citation-only`. */
  text: string;
  form: 'statement' | 'citation-only';
  sourceIds: string[];
  timing: RationaleEvidence['timing'];
  /** Tick the evidence was recorded at (the execution tick for submission evidence). */
  tick: number;
  recordedAt?: string;
}

/**
 * Rationale evidence for an order with full provenance. The top-level fields
 * describe the primary statement; `statements` keeps every recorded statement
 * in record order so nothing is discarded, and `selection` says how the
 * primary one was chosen.
 *
 * Selection rule: submission-time (contemporaneous) text is never overridden
 * by a later annotation. When only post-hoc statements exist the latest one is
 * current (the participant may correct an earlier statement), and the earlier
 * ones remain in `statements`. When no statement has text, the earliest
 * citation-only record is primary and `form` says so.
 */
export interface RationaleRecord extends RationaleEvidence {
  form: RationaleStatement['form'];
  tick: number;
  recordedAt?: string;
  statements: RationaleStatement[];
  selection: 'contemporaneous' | 'latest-post-hoc';
}

/** Every rationale statement recorded for a command, in record order: the command's own details first, then `decision_log` events referencing it. */
export function rationaleStatements(command: LearningEvent, events: LearningEvent[]): RationaleStatement[] {
  const d = command.details ?? {};
  const out: RationaleStatement[] = [];
  const ownText = typeof d.rationale === 'string' ? d.rationale.trim() : '';
  const ownSources = asStringArray(d.sourceIds);
  if (ownText || ownSources.length) out.push({ evidenceId: command.id, text: ownText, form: ownText ? 'statement' : 'citation-only', sourceIds: ownSources, timing: timingOf(d.rationaleTiming), tick: command.tick });
  const commandId = d.commandId;
  const refersToCommand = (e: LearningEvent) => e.kind === 'decision_log' && ((e.details?.commandId !== undefined && (e.details.commandId === commandId || e.details.commandId === command.id)) || e.details?.commandEventId === command.id);
  const logs = events.map((e, i) => ({ e, i })).filter(({ e }) => refersToCommand(e))
    .sort((a, b) => (a.e.sequence !== undefined && b.e.sequence !== undefined ? a.e.sequence - b.e.sequence : a.i - b.i));
  for (const { e: log } of logs) {
    const text = typeof log.details.text === 'string' ? log.details.text.trim() : '';
    const sourceIds = asStringArray(log.details.sourceIds);
    if (!text && !sourceIds.length) continue;
    const declared = timingOf(log.details.timing);
    const timing = declared === 'unknown' ? (log.tick <= command.tick ? 'contemporaneous' : 'post-hoc') : declared;
    const recordedAt = log.recordedAt ?? (typeof log.details.recordedAt === 'string' ? log.details.recordedAt : undefined);
    out.push({ evidenceId: log.id, text, form: text ? 'statement' : 'citation-only', sourceIds, timing, tick: log.tick, ...(recordedAt ? { recordedAt } : {}) });
  }
  return out;
}

/**
 * Explicit rationale for a command, if any was recorded, with every statement
 * preserved. Returns null when nothing was recorded: that is unobserved, not
 * failed. A `citation-only` result means sources were cited without any text;
 * callers must not present it as a reason.
 */
export function rationaleFor(command: LearningEvent, events: LearningEvent[]): RationaleRecord | null {
  const statements = rationaleStatements(command, events);
  if (!statements.length) return null;
  const withText = statements.filter(s => s.form === 'statement');
  const primary = withText.find(s => s.timing !== 'post-hoc') ?? withText.at(-1) ?? statements.find(s => s.timing !== 'post-hoc') ?? statements.at(-1)!;
  return { ...primary, statements, selection: primary.timing === 'post-hoc' ? 'latest-post-hoc' : 'contemporaneous' };
}

/** Distinct report IDs cited across every statement for the order, in first-cited order. */
export function citedSourceIds(evidence: RationaleRecord): string[] {
  return [...new Set(evidence.statements.flatMap(s => s.sourceIds))];
}

/** Reports on `side` released at or before `tick`. */
export function reportsAvailable(reports: LearningReport[], side: string | null | undefined, tick: number): LearningReport[] {
  return reports.filter(r => r.tick <= tick && (!side || r.side === side));
}

/**
 * Currency of a cited report at `tick`: `superseded` only when a later report
 * released at or before `tick` explicitly names it in `supersedes`.
 */
export function sourceStatusAt(reports: LearningReport[], sourceId: string, tick: number): { status: 'current' | 'superseded' | 'unknown'; supersededBy?: string } {
  const cited = reports.find(r => r.id === sourceId);
  if (!cited) return { status: 'unknown' };
  const newer = reports.find(r => r.supersedes === sourceId && r.tick <= tick);
  return newer ? { status: 'superseded', supersededBy: newer.id } : { status: 'current' };
}

/** Troops committed relative to the returned snapshot; older records use server admission. */
export function commitmentRatio(command: LearningEvent): number | undefined {
  const troops = command.details?.intent?.troops, before = command.details?.observation?.player?.troops ?? command.details?.before?.troops;
  if (typeof troops !== 'number' || typeof before !== 'number' || before <= 0) return undefined;
  return troops / before;
}

/**
 * Events recorded by the participant that constitute a response to a release.
 * Post-hoc annotations (a decision statement or assessment explicitly recorded
 * with `timing: 'post-hoc'`) describe an earlier moment and are never a
 * response to a release, whenever they were written.
 */
export function isRecordedResponse(e: LearningEvent, subject: string): boolean {
  if (e.actor !== subject) return false;
  if (e.kind === 'command' && e.details?.origin === 'human') return true;
  if (!['decision_log', 'assessment_log', 'task_created'].includes(e.kind)) return false;
  return e.details?.timing !== 'post-hoc';
}

/**
 * Report releases visible to `subject` on the human side (after joining and
 * after any fork), each with whether a recorded response by the subject falls
 * in its window. The window runs from the release to the next release at a
 * later tick on the same side, so one late order does not answer every earlier
 * release. Releases at the same tick share one window.
 */
export function releaseResponses(record: ExerciseRecord, subject: string): { release: LearningEvent; answered: boolean }[] {
  const { exercise, events } = record;
  const side = exercise.humanSide;
  const joined = exercise.participants?.find(p => p.subject === subject)?.joinedTick ?? 0;
  const releases = events.filter(e => e.kind === 'report' && e.tick >= joined && (!side || e.side === side) && (exercise.forkTick === undefined || e.tick >= exercise.forkTick));
  const after = (a: LearningEvent, b: LearningEvent) => (a.sequence !== undefined && b.sequence !== undefined ? a.sequence > b.sequence : events.indexOf(a) > events.indexOf(b));
  return releases.map(rel => {
    const next = releases.find(r => r.tick > rel.tick && after(r, rel));
    const answered = events.some(e => after(e, rel) && (!next || after(next, e)) && isRecordedResponse(e, subject));
    return { release: rel, answered };
  });
}

/** Shorten UUIDs to their first block for display; any other ID (including `uuid:before` suffixes) keeps its tail. */
export function shortId(id: string): string {
  return id.replace(/^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, '$1');
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}
