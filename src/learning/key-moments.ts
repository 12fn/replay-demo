/**
 * Evidence-grounded key-moment selection.
 *
 * Pure, deterministic selection of the few recorded moments most worth
 * reviewing in one exercise. Replaces "the last twelve human orders" with a
 * ranked, temporally spread set built only from records the server already
 * holds: human orders, admission rejections, engine execution observations,
 * objective-rule updates, report releases and staff watch updates.
 *
 * What it never does:
 *  - infer that one event caused another from timing alone. Every link between
 *    two records is an explicit recorded correlation (`commandId`, `supersedes`,
 *    `taskId`) or is labelled as mere adjacency in the reason text;
 *  - assign a quality score to a decision. Ranking weights measure how much
 *    observable, distinct evidence a moment carries, not how good the order was;
 *  - read opponent-controller records (`model_decision`, `tool_result`) or any
 *    event recorded on the non-viewing side, unless the caller says both sides
 *    are visible; even then the opponent's prompts/observations are not used;
 *  - use anything recorded after the review cutoff, including later execution
 *    feedback for an order placed before it;
 *  - merge materially different decisions. Consecutive orders are grouped only
 *    when they are the same act by the same participant (see `KEY_MOMENT_GROUPING`),
 *    and every grouped order keeps its own record ID and tick in `evidence`.
 *
 * No I/O, no inference, no mutation of inputs. Correlated records are indexed
 * once; ordering and comparison of earlier groups also contribute to runtime.
 * See docs/process/key-moment-selection-notes.md and
 * docs/process/key-moment-refinement-notes.md for integration seams.
 */
import { commitmentRatio, humanCommands, observedTick, rationaleFor, sourceStatusAt, type RationaleRecord, type RationaleStatement } from './evidence';
import type { ExerciseRecord, LearningEvent, LearningReport, Side } from './types';

export const KEY_MOMENTS_SCHEMA = 'replay.key-moments/1' as const;

/** Whose acts count as candidate decisions. Exercise-level records (objectives, releases) appear in both scopes. */
export type KeyMomentScope =
  | { kind: 'own'; subject: string }
  | { kind: 'shared' };

export interface KeyMomentCutoff {
  /** Records after this tick are unavailable to the review. */
  tick: number;
  /** When given, records at `tick` with a higher sequence are also unavailable. */
  sequence?: number;
}

export interface KeyMomentOptions {
  record: ExerciseRecord;
  scope: KeyMomentScope;
  cutoff: KeyMomentCutoff;
  /** Side the reviewer is viewing as. Defaults to the exercise's human side. */
  viewerSide?: Side;
  /** True when the reviewer may see both sides (instructor, or completed exercise). Opponent orders still never become moments. */
  bothSidesVisible?: boolean;
  /** How many moments to select. Default 6, minimum 1. */
  limit?: number;
}

export type KeyMomentKind =
  | 'order-ineffective'
  | 'order-rejected'
  | 'order-effective'
  | 'order-tradeoff'
  | 'follow-on-after-ineffective'
  | 'objective-control-changed'
  | 'objective-award'
  | 'source-superseded'
  | 'staff-update';

export type EvidenceBasis =
  | 'recorded-order'
  | 'admission-rejection'
  | 'engine-observation'
  | 'game-rules'
  | 'report-release'
  | 'staff-record';

export interface KeyMomentEvidence {
  id: string;
  kind: string;
  tick: number;
  /** How this record was produced; distinguishes a measured effect from a submitted intent. */
  basis: EvidenceBasis;
}

/**
 * How the orders behind one moment relate to each other.
 *  - `none`: a single order.
 *  - `identical`: every grouped order has the same canonical intent (same troops too).
 *  - `equivalent`: same participant, action type, target, recorded reason and cited
 *    sources; troop counts differ but the commitment share stays within
 *    `KEY_MOMENT_GROUPING.ratioTolerance` of the first order. Not identical inputs.
 */
export type RepeatKind = 'none' | 'identical' | 'equivalent';

export interface RepeatRange {
  /** Smallest and largest troop count across the grouped orders. */
  troops: [number, number];
  /** Smallest and largest commitment share across the grouped orders, when measurable. */
  ratio?: [number, number];
  /** First and last order tick in the group. */
  ticks: [number, number];
}

export interface KeyMoment {
  /** Stable identifier derived from the primary evidence, e.g. `km:order-ineffective:<eventId>`. */
  id: string;
  kind: KeyMomentKind;
  /** Tick of the primary record. For orders this is the execution/admission tick. */
  tick: number;
  /** Tick the participant was viewing when the order was submitted; equals `tick` for non-order moments. */
  observedTick: number;
  /** `participant`: an act recorded under `actor`. `exercise`: a rules or release record with no personal attribution. */
  attribution: 'participant' | 'exercise';
  actor?: string;
  side?: string | null;
  title: string;
  /** Human-readable, evidence-only reasons for surfacing this moment. */
  reasons: string[];
  evidence: KeyMomentEvidence[];
  /** Weight used for ranking. Measures evidence distinctness, not decision quality. */
  weight: number;
  /** Consecutive orders grouped into this moment (1 = not repeated). Each keeps its own entry in `evidence`. */
  repeatCount: number;
  /** Whether grouped orders were identical inputs or only equivalent ones. `none` when `repeatCount` is 1. */
  repeatKind: RepeatKind;
  /** Present when `repeatCount > 1`: the measured spread across the grouped orders. */
  repeatRange?: RepeatRange;
  /** Set on every moment: what the selector does not claim. */
  interpretation: string;
}

export interface KeyMomentExclusion {
  id: string;
  kind: string;
  tick: number;
  reason:
    | 'after-cutoff'
    | 'other-side'
    | 'other-participant'
    | 'opponent-controller-record'
    | 'inherited-context'
    | 'unconfirmed-observation'
    | 'not-a-moment';
}

export interface KeyMomentSelection {
  schema: typeof KEY_MOMENTS_SCHEMA;
  exerciseId: string;
  scope: KeyMomentScope;
  cutoff: KeyMomentCutoff;
  viewerSide: Side | undefined;
  /** Ranked and temporally spread. Ascending tick order for display. */
  selected: KeyMoment[];
  /** Every candidate that survived exclusion, in ascending tick order, so a reviewer can see what was not chosen. */
  candidates: KeyMoment[];
  excluded: KeyMomentExclusion[];
  limitations: string[];
}

const NO_CAUSAL_CLAIM = 'Selected because the record carries distinct observable evidence. No causal link between this moment and later outcomes is asserted, and no judgment of decision quality is made.';

/**
 * Declared grouping policy for consecutive orders. Documented in
 * docs/process/key-moment-refinement-notes.md; change both together.
 */
export const KEY_MOMENT_GROUPING = {
  /** Orders more than this many ticks after the first order of a group start a new group. */
  windowTicks: 300,
  /** Maximum absolute difference in commitment share (0–1) between an order and the first order of its group. */
  ratioTolerance: 0.05,
} as const;

export const KEY_MOMENT_LIMITATIONS = [
  'Moments are chosen for evidence distinctness and temporal spread, not for decision quality; the weight is not a score.',
  'A follow-on order after an ineffective order is recorded adjacency, not a demonstrated recovery or response.',
  'Execution effects come only from engine observations explicitly correlated to the order by command ID; an unobserved effect is unknown, not absent.',
  'Objective changes are deterministic game-rule records; they do not identify which order produced them.',
  'Opponent-controller records are never used; opponent orders never become moments.',
  'Records after the review cutoff, including later effects of earlier orders, are excluded.',
  `Consecutive orders by one participant with the same action type, target, recorded reason and cited sources, a commitment share within ${Math.round(KEY_MOMENT_GROUPING.ratioTolerance * 100)} points of the first, and no intervening objective change, report release, team assessment, rejection or terminal engine observation, are grouped within ${KEY_MOMENT_GROUPING.windowTicks} ticks; each grouped order keeps its own record ID and tick.`,
  'No pedagogical validation exists for this selection; it is an ordering aid for human review.',
] as const;

const OPPONENT_RECORD_KINDS = new Set(['model_decision', 'tool_result', 'agent_authorized', 'domain_retrieved', 'domain_unavailable']);
const INEFFECTIVE = new Set(['construction-not-started', 'construction-interrupted', 'transport-not-launched', 'transport-forces-returned']);
const EFFECTIVE = new Set(['construction-completed', 'transport-landed']);
const UNCONFIRMED = new Set(['construction-unconfirmed', 'transport-ended-unconfirmed', 'observation-failed']);

/** Ranking weights. Larger means more distinct observable evidence. Documented in the notes file; change there too. */
const WEIGHT: Record<KeyMomentKind, number> = {
  'order-ineffective': 5,
  'objective-control-changed': 5,
  'order-rejected': 4,
  'follow-on-after-ineffective': 4,
  'order-effective': 3,
  'order-tradeoff': 3,
  'objective-award': 2,
  'source-superseded': 2,
  'staff-update': 2,
};
/** Commitment fraction at or above which an order is surfaced as a tradeoff without needing a written reason. */
const TRADEOFF_RATIO = 0.5;
/** Ranking penalty applied per already-selected moment of the same kind or in the same time bucket. */
const DIVERSITY_PENALTY = 1.5;
/** Repeated order groups beyond the first are down-weighted by this amount. */
const REPEAT_GROUP_PENALTY = 2;

// ---------------------------------------------------------------------------
// Ordering and cutoff helpers
// ---------------------------------------------------------------------------

type Indexed = { e: LearningEvent; i: number };

function orderKey(a: Indexed, b: Indexed): number {
  if (a.e.tick !== b.e.tick) return a.e.tick - b.e.tick;
  if (a.e.sequence !== undefined && b.e.sequence !== undefined && a.e.sequence !== b.e.sequence) return a.e.sequence - b.e.sequence;
  return a.i - b.i;
}

function beforeCutoff(e: LearningEvent, cutoff: KeyMomentCutoff): boolean {
  if (e.tick < cutoff.tick) return true;
  if (e.tick > cutoff.tick) return false;
  return cutoff.sequence === undefined || e.sequence === undefined || e.sequence <= cutoff.sequence;
}

function canonical(v: any): any {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : Array.isArray(v) ? v.map(canonical) : v;
}

function stableIntent(intent: unknown): string {
  return JSON.stringify(canonical(intent ?? null));
}

/** The intent with its resource amount removed: action type, target, unit, tile and any other field. */
function intentShape(intent: unknown): string {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return stableIntent(intent);
  const { troops: _troops, ...rest } = intent as Record<string, unknown>;
  return JSON.stringify(canonical(rest));
}

function ev(e: LearningEvent, basis: EvidenceBasis): KeyMomentEvidence {
  return { id: e.id, kind: e.kind, tick: e.tick, basis };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/** Index of the first element whose `tick` is strictly greater than `tick`, in a tick-ascending list. */
function firstAfter(list: LearningEvent[], tick: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].tick > tick) hi = mid; else lo = mid + 1; }
  return lo;
}

// ---------------------------------------------------------------------------
// Candidate builders
// ---------------------------------------------------------------------------

interface Ctx {
  record: ExerciseRecord;
  events: LearningEvent[];        // visible, before cutoff, ascending
  reports: LearningReport[];      // visible, before cutoff
  reportById: Map<string, LearningReport>;
  scope: KeyMomentScope;
  side: Side | undefined;
  bothSides: boolean;
}

function ownsAct(ctx: Ctx, e: LearningEvent): boolean {
  return ctx.scope.kind === 'shared' || e.actor === ctx.scope.subject;
}

type Outcome = 'ineffective' | 'effective' | 'none';

/** Everything the grouping and reason text need about one order, computed once. */
interface OrderInfo {
  c: LearningEvent;
  intentKey: string;
  shapeKey: string;
  troops: number | undefined;
  ratio: number | undefined;
  rationale: RationaleRecord | null;
  /** Contemporaneous (or unknown-timing) written statement; post-hoc annotations never qualify. */
  statement: RationaleStatement | null;
  /** Sources cited at submission time. Post-hoc citations are excluded (main fix, preserved). */
  cited: string[];
  /** Statement text plus cited sources: a change in either separates decisions. */
  rationaleKey: string;
  feedback: LearningEvent[];
  outcome: Outcome;
  /** Context epoch at the order: advances on objective control/priority changes, report releases, rejections and engine observations. */
  epoch: number;
}

interface Group {
  members: OrderInfo[];
  kind: RepeatKind;
}

function comparableRatio(a: OrderInfo, b: OrderInfo): boolean {
  if (a.ratio === undefined || b.ratio === undefined) return a.ratio === undefined && b.ratio === undefined && a.intentKey === b.intentKey;
  if (Math.abs(a.ratio - b.ratio) > KEY_MOMENT_GROUPING.ratioTolerance) return false;
  return (a.ratio >= TRADEOFF_RATIO) === (b.ratio >= TRADEOFF_RATIO);
}

/** Whether `next` may join the group anchored at `anchor`, and how. `null` means it starts a new group. */
function joinKind(anchor: OrderInfo, next: OrderInfo): RepeatKind | null {
  if (anchor.c.actor !== next.c.actor) return null;
  if (next.epoch !== anchor.epoch) return null;
  if (next.c.tick - anchor.c.tick > KEY_MOMENT_GROUPING.windowTicks) return null;
  if (anchor.rationaleKey !== next.rationaleKey) return null;
  if (!!anchor.c.details?.observation !== !!next.c.details?.observation) return null;
  if (anchor.outcome !== next.outcome) return null;
  if (!comparableRatio(anchor, next)) return null;
  if (anchor.intentKey === next.intentKey) return 'identical';
  // Orders with a measured outcome are never merged approximately: the observation belongs to an exact input.
  if (anchor.outcome !== 'none') return null;
  if (anchor.shapeKey !== next.shapeKey) return null;
  return 'equivalent';
}

function pct(r: number): number { return Math.round(r * 100); }

function orderCandidates(ctx: Ctx, exclusions: KeyMomentExclusion[]): KeyMoment[] {
  const { events, reports, record, side } = ctx;
  const out: KeyMoment[] = [];

  // One pass over the visible record: index correlated records and track the context epoch each order was placed in.
  const feedbackByCommand = new Map<string, LearningEvent[]>();
  const logsByRef = new Map<string, LearningEvent[]>();
  const position = new Map<string, number>();
  const epochAt = new Map<string, number>();
  let epoch = 0;
  let controllers: string | null = null;
  events.forEach((e, i) => {
    position.set(e.id, i);
    switch (e.kind) {
      case 'execution_feedback': {
        const cid = e.details?.commandId;
        if (typeof cid !== 'string' || e.details?.sourceExerciseId !== record.exercise.id) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'not-a-moment' }); return; }
        push(feedbackByCommand, cid, e);
        const status = e.details?.feedback?.status;
        if (INEFFECTIVE.has(status) || EFFECTIVE.has(status)) epoch++;
        return;
      }
      case 'decision_log': {
        const cid = e.details?.commandId, ceid = e.details?.commandEventId;
        if (typeof cid === 'string') push(logsByRef, cid, e);
        if (typeof ceid === 'string' && ceid !== cid) push(logsByRef, ceid, e);
        return;
      }
      case 'command': epochAt.set(e.id, epoch); return;
      case 'command_rejected': epoch++; return;
      case 'assessment_log': if (!e.side || !side || e.side === side) epoch++; return;
      case 'report': if (!e.side || !side || e.side === side) epoch++; return;
      case 'objective_update': {
        const state = e.details?.state;
        if (!state?.controllers || typeof state.controllers !== 'object') return;
        const key = JSON.stringify([canonical(state.controllers), state.priorityId ?? null]);
        if (controllers !== null && key !== controllers) epoch++;
        controllers = key;
        return;
      }
      default: return;
    }
  });

  const logsFor = (c: LearningEvent): LearningEvent[] => {
    const cid = c.details?.commandId;
    const refs = [...(typeof cid === 'string' ? logsByRef.get(cid) ?? [] : []), ...(logsByRef.get(c.id) ?? [])];
    if (refs.length < 2) return refs;
    const seen = new Set<string>();
    return refs.filter(l => !seen.has(l.id) && seen.add(l.id)).sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  };

  const commands = humanCommands(events).filter(c => ownsAct(ctx, c));
  const infos: OrderInfo[] = commands.map(c => {
    const rationale = rationaleFor(c, logsFor(c));
    const statement = rationale && rationale.form === 'statement' && rationale.timing !== 'post-hoc' ? rationale : null;
    // Later annotations must not become sources attributed to a submission-time reason.
    const cited = [...new Set(statement?.sourceIds ?? (rationale?.form === 'citation-only' && rationale.timing !== 'post-hoc' ? rationale.sourceIds : []))];
    const feedback = feedbackByCommand.get(c.details?.commandId) ?? [];
    const outcome: Outcome = feedback.some(f => INEFFECTIVE.has(f.details?.feedback?.status)) ? 'ineffective' : feedback.some(f => EFFECTIVE.has(f.details?.feedback?.status)) ? 'effective' : 'none';
    const troops = typeof c.details?.intent?.troops === 'number' ? c.details.intent.troops : undefined;
    return {
      c, intentKey: stableIntent(c.details?.intent), shapeKey: intentShape(c.details?.intent), troops, ratio: commitmentRatio(c), rationale, statement, cited,
      rationaleKey: JSON.stringify([statement?.text ?? null, statement?.timing ?? null, [...cited].sort()]), feedback, outcome, epoch: epochAt.get(c.id) ?? 0,
    };
  });

  // Group consecutive orders that are the same act (see KEY_MOMENT_GROUPING); each order keeps its own evidence entry.
  const groups: Group[] = [];
  for (const info of infos) {
    const last = groups.at(-1);
    const how = last ? joinKind(last.members[0], info) : null;
    if (last && how) { last.members.push(info); if (how === 'equivalent') last.kind = 'equivalent'; }
    else groups.push({ members: [info], kind: 'none' });
  }
  for (const g of groups) if (g.members.length > 1 && g.kind === 'none') g.kind = 'identical';

  // Earlier runs of the same act, keyed by everything but the commitment share; anchors are compared for comparable share.
  const runsByKey = new Map<string, OrderInfo[]>();
  type Item = { tick: number; seq: number; build: () => void };
  const items: Item[] = [];

  for (const group of groups) {
    const anchor = group.members[0];
    const c = anchor.c;
    const runKey = `${c.actor}|${anchor.shapeKey}|${anchor.rationaleKey}|${anchor.outcome}`;
    const priorGroups = (runsByKey.get(runKey) ?? []).filter(prev => comparableRatio(prev, anchor)).length;
    push(runsByKey, runKey, anchor);
    items.push({ tick: c.tick, seq: c.sequence ?? 0, build: () => {
      const at = observedTick(c);
      const { ratio, rationale, statement, cited } = anchor;
      const superseded = cited.filter(id => sourceStatusAt(reports, id, at).status === 'superseded');
      const feedback = group.members.flatMap(m => m.feedback);
      const ineffective = feedback.filter(f => INEFFECTIVE.has(f.details?.feedback?.status));
      const effective = feedback.filter(f => EFFECTIVE.has(f.details?.feedback?.status));
      for (const f of feedback.filter(f => UNCONFIRMED.has(f.details?.feedback?.status))) exclusions.push({ id: f.id, kind: f.kind, tick: f.tick, reason: 'unconfirmed-observation' });

      const evidence: KeyMomentEvidence[] = group.members.map(m => ev(m.c, 'recorded-order'));
      const reasons: string[] = [];
      let kind: KeyMomentKind;
      if (ineffective.length) {
        kind = 'order-ineffective';
        for (const f of ineffective) { evidence.push(ev(f, 'engine-observation')); reasons.push(`Engine observed "${f.details.feedback.status}" for this exact input at tick ${f.tick} (correlated by command ID).`); }
      } else if (effective.length) {
        kind = 'order-effective';
        for (const f of effective) { evidence.push(ev(f, 'engine-observation')); reasons.push(`Engine observed "${f.details.feedback.status}" for this exact input at tick ${f.tick} (correlated by command ID).`); }
      } else if ((ratio !== undefined && ratio >= TRADEOFF_RATIO) || statement) {
        kind = 'order-tradeoff';
      } else {
        for (const m of group.members) exclusions.push({ id: m.c.id, kind: m.c.kind, tick: m.c.tick, reason: 'not-a-moment' });
        return;
      }

      const n = group.members.length;
      const ratios = group.members.map(m => m.ratio).filter((r): r is number => r !== undefined);
      const troopCounts = group.members.map(m => m.troops).filter((t): t is number => t !== undefined);
      const basis = c.details?.observation ? 'snapshot returned with the order' : 'server-admission state (displayed state not recorded)';
      if (ratios.length) {
        const lo = pct(Math.min(...ratios)), hi = pct(Math.max(...ratios));
        reasons.push(lo === hi ? `Committed ${lo}% of forces in the ${basis}.` : `Committed between ${lo}% and ${hi}% of forces across ${n} orders in the ${basis}.`);
      }
      if (statement) {
        reasons.push(`A ${statement.timing} written reason was recorded${cited.length ? ` citing ${cited.join(', ')}` : ''}.`);
        for (const m of group.members) if (m.statement && m.statement.evidenceId !== m.c.id) evidence.push({ id: m.statement.evidenceId, kind: 'decision_log', tick: m.statement.tick, basis: 'recorded-order' });
      } else if (rationale && rationale.form === 'citation-only' && cited.length) reasons.push(`Sources ${cited.join(', ')} were cited without a written reason; this is provenance, not a stated reason.`);
      if (superseded.length) reasons.push(`Cited ${superseded.join(', ')} had been superseded on this side by tick ${at}; the newer report was available then.`);

      let repeatRange: RepeatRange | undefined;
      if (n > 1) {
        const first = group.members[0].c.tick, last = group.members[n - 1].c.tick;
        repeatRange = { troops: troopCounts.length ? [Math.min(...troopCounts), Math.max(...troopCounts)] : [0, 0], ...(ratios.length ? { ratio: [Math.min(...ratios), Math.max(...ratios)] as [number, number] } : {}), ticks: [first, last] };
        if (group.kind === 'identical') reasons.push(`The identical order was recorded ${n} times consecutively (ticks ${first}–${last}); shown once. Each order's record is listed in the evidence.`);
        else reasons.push(`${n} equivalent orders (same type, target, recorded reason and sources; troop counts ${repeatRange.troops[0]}–${repeatRange.troops[1]}${repeatRange.ratio ? `, ${pct(repeatRange.ratio[0])}%–${pct(repeatRange.ratio[1])}% of forces` : ''}) were recorded within ${last - first} ticks (ticks ${first}–${last}) with no objective change, report release, team assessment, rejection or terminal engine observation between them; shown once. Not identical inputs: each order's record is listed in the evidence.`);
      }
      let weight = WEIGHT[kind] + (statement ? 1 : 0) + (superseded.length ? 1 : 0) - (priorGroups ? REPEAT_GROUP_PENALTY : 0);
      if (priorGroups) reasons.push(`The same act had already been recorded in ${priorGroups} earlier run${priorGroups === 1 ? '' : 's'}; down-weighted as a repeat.`);
      const title = kind === 'order-ineffective' ? 'Order admitted but not carried out' : kind === 'order-effective' ? 'Order carried out as observed by the engine' : 'Commitment with a recorded tradeoff';
      out.push({ id: `km:${kind}:${c.id}`, kind, tick: c.tick, observedTick: at, attribution: 'participant', actor: c.actor, side: c.side, title, reasons, evidence, weight, repeatCount: n, repeatKind: group.kind, ...(repeatRange ? { repeatRange } : {}), interpretation: NO_CAUSAL_CLAIM });
    } });
  }

  const rejected = events.filter(e => e.kind === 'command_rejected' && ownsAct(ctx, e));
  for (const r of rejected) {
    items.push({ tick: r.tick, seq: r.sequence ?? 0, build: () => {
      const reason = typeof r.details?.reason === 'string' ? r.details.reason : 'no reason recorded';
      out.push({ id: `km:order-rejected:${r.id}`, kind: 'order-rejected', tick: r.tick, observedTick: r.tick, attribution: 'participant', actor: r.actor, side: r.side, title: 'Order could not execute', reasons: [`Admission rejected the order: ${reason}.`], evidence: [ev(r, 'admission-rejection')], weight: WEIGHT['order-rejected'], repeatCount: 1, repeatKind: 'none', interpretation: NO_CAUSAL_CLAIM });
    } });
  }

  // Follow-on: the next human order by the same actor after an ineffective or rejected one. Adjacency only.
  items.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  for (const item of items) item.build();
  const commandsByActor = new Map<string, LearningEvent[]>();
  for (const c of commands) push(commandsByActor, c.actor, c);
  const claimed = new Set<string>();
  const failuresInOrder = out.filter(m => m.kind === 'order-ineffective' || m.kind === 'order-rejected').sort(byTickThenId);
  for (const failure of failuresInOrder) {
    // Only after the failure is observable: for an ineffective order that is the tick of the engine observation, not the order.
    const knownAt = Math.max(failure.tick, ...failure.evidence.filter(x => x.basis === 'engine-observation').map(x => x.tick));
    const own = commandsByActor.get(failure.actor!) ?? [];
    let i = firstAfter(own, knownAt);
    while (i < own.length && claimed.has(own[i].id)) i++;
    if (i >= own.length) continue;
    const next = own[i];
    claimed.add(next.id);
    const gap = next.tick - knownAt;
    out.push({ id: `km:follow-on-after-ineffective:${next.id}`, kind: 'follow-on-after-ineffective', tick: next.tick, observedTick: observedTick(next), attribution: 'participant', actor: next.actor, side: next.side, title: 'Next order after an ineffective or rejected one',
      reasons: [`First order by the same participant recorded ${gap} ticks after "${failure.title.toLowerCase()}" became observable at tick ${knownAt}. Adjacency in the record only; whether it was a response is not established.`],
      evidence: [ev(next, 'recorded-order'), ...failure.evidence], weight: WEIGHT['follow-on-after-ineffective'], repeatCount: 1, repeatKind: 'none', interpretation: NO_CAUSAL_CLAIM });
  }
  return out;
}

function objectiveCandidates(ctx: Ctx, exclusions: KeyMomentExclusion[]): KeyMoment[] {
  const out: KeyMoment[] = [];
  let previous: Record<string, Side | null> | null = null;
  for (const e of ctx.events) {
    if (e.kind !== 'objective_update') continue;
    const state = e.details?.state;
    const controllers: Record<string, Side | null> | undefined = state?.controllers;
    if (!controllers || typeof controllers !== 'object') { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'not-a-moment' }); continue; }
    if (e.details?.inherited === true) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'inherited-context' }); previous = controllers; continue; }
    const flips = Object.keys(controllers).filter(id => (previous?.[id] ?? null) !== (controllers[id] ?? null)).map(id => `${id}: ${previous?.[id] ?? 'none'} → ${controllers[id] ?? 'none'}`);
    const award = e.details?.award;
    if (flips.length) {
      out.push({ id: `km:objective-control-changed:${e.id}`, kind: 'objective-control-changed', tick: e.tick, observedTick: e.tick, attribution: 'exercise', side: null, title: 'Station control changed', reasons: [`Recorded controller change: ${flips.join('; ')}.`, `Scores at this record: Blue ${state.scores?.blue ?? '?'} / Red ${state.scores?.red ?? '?'}.`, 'Deterministic game-rule record; it does not say which order produced the change.'], evidence: [ev(e, 'game-rules')], weight: WEIGHT['objective-control-changed'], repeatCount: 1, repeatKind: 'none', interpretation: NO_CAUSAL_CLAIM });
    } else if (award) {
      out.push({ id: `km:objective-award:${e.id}`, kind: 'objective-award', tick: e.tick, observedTick: e.tick, attribution: 'exercise', side: null, title: 'Points awarded', reasons: [`Award recorded: Blue +${award.blue?.total ?? 0}, Red +${award.red?.total ?? 0}; totals Blue ${state.scores?.blue ?? '?'} / Red ${state.scores?.red ?? '?'}.`], evidence: [ev(e, 'game-rules')], weight: WEIGHT['objective-award'], repeatCount: 1, repeatKind: 'none', interpretation: NO_CAUSAL_CLAIM });
    } else exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'not-a-moment' });
    previous = controllers;
  }
  return out;
}

function releaseCandidates(ctx: Ctx, exclusions: KeyMomentExclusion[]): KeyMoment[] {
  const out: KeyMoment[] = [];
  for (const e of ctx.events) {
    if (e.kind !== 'report') continue;
    const supersedes = e.details?.supersedes;
    if (typeof supersedes !== 'string') { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'not-a-moment' }); continue; }
    const reportId = typeof e.details?.reportId === 'string' ? e.details.reportId : e.id;
    const report = ctx.reportById.get(reportId);
    out.push({ id: `km:source-superseded:${e.id}`, kind: 'source-superseded', tick: e.tick, observedTick: e.tick, attribution: 'exercise', side: e.side, title: 'A report superseded an earlier one', reasons: [`${report?.title ?? e.summary} (${reportId}) supersedes ${supersedes} at tick ${e.tick}; orders citing ${supersedes} after this tick cite a superseded source.`], evidence: [ev(e, 'report-release')], weight: WEIGHT['source-superseded'], repeatCount: 1, repeatKind: 'none', interpretation: NO_CAUSAL_CLAIM });
  }
  return out;
}

function staffCandidates(ctx: Ctx): KeyMoment[] {
  const out: KeyMoment[] = [];
  const taskById = new Map<string, LearningEvent>();
  for (const e of ctx.events) if (e.kind === 'task_created' && typeof e.details?.taskId === 'string' && !taskById.has(e.details.taskId)) taskById.set(e.details.taskId, e);
  for (const e of ctx.events) {
    if (e.kind !== 'staff_update') continue;
    const sources: string[] = Array.isArray(e.details?.sourceIds) ? e.details.sourceIds.filter((s: unknown): s is string => typeof s === 'string') : [];
    const method = typeof e.details?.method === 'string' ? e.details.method : 'unrecorded method';
    const reasons = [`Staff update from the ${method}${sources.length ? ` citing ${sources.join(', ')}` : ' with no source cited'}.`];
    const task = typeof e.details?.taskId === 'string' ? taskById.get(e.details.taskId) : undefined;
    const evidence = [ev(e, 'staff-record')];
    if (task) { evidence.push(ev(task, 'staff-record')); reasons.push(`Answers the watch assigned at tick ${task.tick} (linked by task ID).`); }
    out.push({ id: `km:staff-update:${e.id}`, kind: 'staff-update', tick: e.tick, observedTick: typeof e.details?.observedTick === 'number' ? e.details.observedTick : e.tick, attribution: 'participant', actor: e.actor, side: e.side, title: 'Staff surfaced a change', reasons, evidence, weight: WEIGHT['staff-update'] + (sources.length ? 1 : 0), repeatCount: 1, repeatKind: 'none', interpretation: NO_CAUSAL_CLAIM });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function byTickThenId(a: KeyMoment, b: KeyMoment): number {
  return a.tick - b.tick || a.id.localeCompare(b.id);
}

/** Greedy pick with diversity penalties so one kind or one stretch of time cannot fill the list. Cost is bounded by `limit`, not by the record length squared. */
function pick(candidates: KeyMoment[], limit: number, cutoffTick: number): KeyMoment[] {
  if (!candidates.length) return [];
  const pool = [...candidates].sort(byTickThenId);
  const first = pool[0].tick;
  const span = Math.max(1, cutoffTick - first);
  const bucket = (m: KeyMoment) => Math.min(limit - 1, Math.floor(((m.tick - first) / span) * limit));
  const chosen: KeyMoment[] = [];
  const kindCount = new Map<KeyMomentKind, number>();
  const bucketCount = new Map<number, number>();
  while (chosen.length < limit && pool.length) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i];
      const score = m.weight - DIVERSITY_PENALTY * ((kindCount.get(m.kind) ?? 0) + (bucketCount.get(bucket(m)) ?? 0));
      if (score > bestScore) { best = i; bestScore = score; }
    }
    const m = pool[best];
    chosen.push(m);
    kindCount.set(m.kind, (kindCount.get(m.kind) ?? 0) + 1);
    bucketCount.set(bucket(m), (bucketCount.get(bucket(m)) ?? 0) + 1);
    pool.splice(best, 1);
  }
  return chosen.sort(byTickThenId);
}

/**
 * Select key moments from an exercise record. Deterministic: identical inputs
 * (regardless of event array order when sequences are present) produce
 * identical output.
 */
export function selectKeyMoments(options: KeyMomentOptions): KeyMomentSelection {
  const { record, scope, cutoff } = options;
  const limit = Math.max(1, Math.floor(options.limit ?? 6));
  const side = options.viewerSide ?? record.exercise.humanSide;
  const bothSides = options.bothSidesVisible === true;
  const exclusions: KeyMomentExclusion[] = [];

  const ordered = record.events.map((e, i) => ({ e, i })).sort(orderKey).map(x => x.e);
  const visible: LearningEvent[] = [];
  for (const e of ordered) {
    if (!beforeCutoff(e, cutoff)) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'after-cutoff' }); continue; }
    if (OPPONENT_RECORD_KINDS.has(e.kind)) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'opponent-controller-record' }); continue; }
    if (e.kind === 'inherited_event') { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'inherited-context' }); continue; }
    if (e.side && side && e.side !== side && !bothSides) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'other-side' }); continue; }
    // Even with both sides visible, opponent-side orders and their effects are never moments for the human seat.
    if (e.side && side && e.side !== side && (e.kind === 'command' || e.kind === 'command_rejected' || e.kind === 'execution_feedback')) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'other-side' }); continue; }
    if (scope.kind === 'own' && (e.kind === 'command' || e.kind === 'command_rejected') && e.actor !== scope.subject) { exclusions.push({ id: e.id, kind: e.kind, tick: e.tick, reason: 'other-participant' }); continue; }
    visible.push(e);
  }
  const reports = record.reports.filter(r => r.tick <= cutoff.tick && (!side || !r.side || r.side === side || bothSides));
  const reportById = new Map<string, LearningReport>();
  for (const r of reports) if (!reportById.has(r.id)) reportById.set(r.id, r);
  const ctx: Ctx = { record, events: visible, reports, reportById, scope, side, bothSides };

  const candidates = [...orderCandidates(ctx, exclusions), ...objectiveCandidates(ctx, exclusions), ...releaseCandidates(ctx, exclusions), ...staffCandidates(ctx)].sort(byTickThenId);
  const selected = pick(candidates, limit, cutoff.tick);
  exclusions.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
  return { schema: KEY_MOMENTS_SCHEMA, exerciseId: record.exercise.id, scope, cutoff: { ...cutoff }, viewerSide: side, selected, candidates, excluded: exclusions, limitations: [...KEY_MOMENT_LIMITATIONS] };
}
