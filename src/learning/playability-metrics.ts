/**
 * Playability metrics: pure counts over the decision pulses and objective board of one match. No engine,
 * model or clock access; the tournament script (scripts/qualify-playability.ts) supplies what the engine
 * actually recorded. These numbers describe observed scripted play (legality, variety, stalls, points);
 * they are not evidence of fun, engagement, learning or model/human performance.
 */

export const PLAYABILITY_METRICS_VERSION = 'replay.playability-metrics/1';

export type PlayabilitySide = 'blue' | 'red';

/** One controller pulse as recorded by the harness. `admitted` is null when the pulse produced no order. */
export interface PulseObservation {
  tick: number;
  side: PlayabilitySide;
  /** Controller category (`expansion`, `attack`, ...) or `none` when the pulse held. */
  category: string;
  /** Intent `type` submitted, or null when there was no intent. */
  intentType: string | null;
  /** true: passed validation at submission; false: rejected at submission; null: nothing submitted. */
  admitted: boolean | null;
  /** Admitted at submission but dropped by tick-time validation. */
  rejectedAtTick: boolean;
}

export interface MetricsWindow {
  /** First tick at which the side could act (inclusive). */
  startTick: number;
  /** Last simulated tick of the match (inclusive). */
  endTick: number;
  /** A gap between executed orders strictly longer than this counts as a long idle gap. */
  idleThresholdTicks: number;
}

export interface SidePlayability {
  pulses: number;
  /** Pulses that proposed an intent. */
  proposed: number;
  /** Pulses that chose to hold (no intent). */
  held: number;
  admittedAtSubmission: number;
  rejectedAtSubmission: number;
  rejectedAtTick: number;
  /** Admitted at submission and still valid at tick time. */
  executed: number;
  /** executed / proposed; null when nothing was proposed. */
  legalRate: number | null;
  categoryCounts: Record<string, number>;
  executedIntentTypes: Record<string, number>;
  distinctExecutedCategories: number;
  /** Shannon entropy (bits) of executed categories. */
  categoryEntropyBits: number;
  /** Entropy divided by log2(distinct categories); 0 when fewer than two categories executed. */
  normalizedCategoryEntropy: number;
  /** Largest share of executed orders taken by one category; null when nothing executed. */
  dominantCategoryShare: number | null;
  longestSameCategoryStreak: number;
  firstExecutedTick: number | null;
  lastExecutedTick: number | null;
  /** Tick spans with no executed order: leading, between consecutive executions, and trailing. */
  idleGapsTicks: number[];
  longestIdleTicks: number;
  longIdleGaps: number;
  /** Longest run of consecutive pulses without an executed order. */
  longestIdlePulseStreak: number;
}

export interface AwardObservation { tick: number; scores: Record<PlayabilitySide, number> }
export interface StationChangeObservation { tick: number; station: string; from: PlayabilitySide | null; to: PlayabilitySide | null }

export interface ObjectiveProgress {
  awards: number;
  /** Scores after the last award; zeros when no award happened. */
  scoresAtLastAward: Record<PlayabilitySide, number>;
  firstPointTick: Record<PlayabilitySide, number | null>;
  /** Times the strict points leader switched from one side to the other (ties do not reset the leader). */
  leadChanges: number;
  stationsGained: Record<PlayabilitySide, number>;
  stationsLost: Record<PlayabilitySide, number>;
  stationChanges: number;
}

const SIDES: PlayabilitySide[] = ['blue', 'red'];
const round = (x: number, digits = 4) => +x.toFixed(digits);

function checkWindow(w: MetricsWindow) {
  for (const [k, v] of Object.entries(w)) if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid metrics window ${k}: ${v}`);
  if (w.endTick < w.startTick) throw new Error(`Metrics window ends (${w.endTick}) before it starts (${w.startTick})`);
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** Metrics for one side. Pulses from the other side or outside the window are ignored; order is by tick (stable). */
export function sidePlayability(pulses: readonly PulseObservation[], side: PlayabilitySide, window: MetricsWindow): SidePlayability {
  checkWindow(window);
  const own = pulses.map((p, i) => ({ p, i })).filter(({ p }) => p.side === side && p.tick >= window.startTick && p.tick <= window.endTick)
    .sort((a, b) => a.p.tick - b.p.tick || a.i - b.i).map(({ p }) => p);
  const categoryCounts: Record<string, number> = {}, executedCategories: Record<string, number> = {}, executedIntentTypes: Record<string, number> = {};
  let proposed = 0, admittedAtSubmission = 0, rejectedAtSubmission = 0, rejectedAtTick = 0, executed = 0;
  let streak = 0, longestSameCategoryStreak = 0, lastCategory: string | null = null, idleStreak = 0, longestIdlePulseStreak = 0;
  const executedTicks: number[] = [];
  for (const p of own) {
    bump(categoryCounts, p.category);
    if (p.intentType !== null) proposed++;
    if (p.admitted === true) admittedAtSubmission++;
    if (p.admitted === false) rejectedAtSubmission++;
    if (p.admitted === true && p.rejectedAtTick) rejectedAtTick++;
    const ran = p.admitted === true && !p.rejectedAtTick && p.intentType !== null;
    if (!ran) { idleStreak++; longestIdlePulseStreak = Math.max(longestIdlePulseStreak, idleStreak); continue; }
    idleStreak = 0; executed++; executedTicks.push(p.tick);
    bump(executedCategories, p.category); bump(executedIntentTypes, p.intentType!);
    streak = p.category === lastCategory ? streak + 1 : 1; lastCategory = p.category;
    longestSameCategoryStreak = Math.max(longestSameCategoryStreak, streak);
  }
  const counts = Object.values(executedCategories), distinct = counts.length;
  const entropy = executed === 0 ? 0 : -counts.reduce((s, c) => s + (c / executed) * Math.log2(c / executed), 0);
  const idleGapsTicks: number[] = [];
  if (executedTicks.length === 0) idleGapsTicks.push(window.endTick - window.startTick);
  else {
    idleGapsTicks.push(executedTicks[0]! - window.startTick);
    for (let i = 1; i < executedTicks.length; i++) idleGapsTicks.push(executedTicks[i]! - executedTicks[i - 1]!);
    idleGapsTicks.push(window.endTick - executedTicks[executedTicks.length - 1]!);
  }
  return {
    pulses: own.length, proposed, held: own.length - proposed, admittedAtSubmission, rejectedAtSubmission, rejectedAtTick, executed,
    legalRate: proposed === 0 ? null : round(executed / proposed),
    categoryCounts, executedIntentTypes, distinctExecutedCategories: distinct,
    categoryEntropyBits: round(entropy), normalizedCategoryEntropy: distinct < 2 ? 0 : round(entropy / Math.log2(distinct)),
    dominantCategoryShare: executed === 0 ? null : round(Math.max(...counts) / executed),
    longestSameCategoryStreak,
    firstExecutedTick: executedTicks[0] ?? null, lastExecutedTick: executedTicks[executedTicks.length - 1] ?? null,
    idleGapsTicks, longestIdleTicks: Math.max(...idleGapsTicks), longIdleGaps: idleGapsTicks.filter((g) => g > window.idleThresholdTicks).length,
    longestIdlePulseStreak,
  };
}

/** Points and station control as the objective board recorded them. Awards are cumulative score snapshots. */
export function objectiveProgress(awards: readonly AwardObservation[], stationChanges: readonly StationChangeObservation[]): ObjectiveProgress {
  const ordered = [...awards].sort((a, b) => a.tick - b.tick);
  const firstPointTick: Record<PlayabilitySide, number | null> = { blue: null, red: null };
  let leader: PlayabilitySide | null = null, leadChanges = 0;
  for (const a of ordered) {
    for (const s of SIDES) if (firstPointTick[s] === null && a.scores[s] > 0) firstPointTick[s] = a.tick;
    const now: PlayabilitySide | null = a.scores.blue > a.scores.red ? 'blue' : a.scores.red > a.scores.blue ? 'red' : null;
    if (now === null) continue;
    if (leader !== null && now !== leader) leadChanges++;
    leader = now;
  }
  const stationsGained = { blue: 0, red: 0 }, stationsLost = { blue: 0, red: 0 };
  for (const c of stationChanges) { if (c.to) stationsGained[c.to]++; if (c.from) stationsLost[c.from]++; }
  const last = ordered[ordered.length - 1];
  return { awards: ordered.length, scoresAtLastAward: last ? { ...last.scores } : { blue: 0, red: 0 }, firstPointTick, leadChanges, stationsGained, stationsLost, stationChanges: stationChanges.length };
}
