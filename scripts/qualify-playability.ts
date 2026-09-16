/**
 * Offline scripted-surrogate playability tournament. Runs a small, bounded set of seeded matches on the
 * recorded `crosscurrent-network/1` layout through the existing objective harness
 * (`runObjectiveMatchup`: engine validation at submission and tick time, the engine's own turn path, the
 * service's objective board) with BOTH sides driven by the scripted reference controllers (`objectives/1`
 * and `maneuver/1`). It then derives observed metrics with `src/learning/playability-metrics.ts`.
 *
 * Every player here is a scripted surrogate. No human plays, no model (Codex, Opus, Luna or any other) is
 * called, and nothing in the artifact is evidence of fun, engagement, learning, AI-player quality or
 * realistic doctrine. Bounded runs normally stop before the 12,000-tick objective limit, so the game
 * outcome is usually null and scores are provisional snapshots.
 *
 * Tests import only the metrics helper. Run directly (main integrator only):
 *   pnpm exec tsx scripts/qualify-playability.ts [--matches 1|2] [--cap-ticks N] [--verify]
 * Writes evidence/playability/scripted-surrogate-tournament-v1-m<M>-cap<N>.json and refuses to overwrite.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBJECTIVE_SCENARIO, runObjectiveMatchup, type ObjectiveMatchup, type ObjectiveRunResult } from './qualify-objective-controller';
import { ROOT, TICKS_PER_SIMULATED_MINUTE } from './qualify-pacing';
import { MANEUVER_CONTROLLER, MANEUVER_INTERVAL_TICKS } from '../src/agents/scripted-controller';
import { OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS } from '../src/agents/objective-controller';
import { NETWORK_RULES } from '../src/campaign/network';
import { SCENARIOS } from '../src/scenarios/catalog';
import { PLAYABILITY_METRICS_VERSION, objectiveProgress, sidePlayability, type PulseObservation } from '../src/learning/playability-metrics';

export const PLAYABILITY_SCHEMA = 'replay.playability-tournament/1';
export const MAX_MATCHES = 2;
export const DEFAULT_CAP_TICKS = 1800;
export const MAX_CAP_TICKS = 3600;
/** One award interval: an executed-order gap longer than this is a long idle gap. */
export const IDLE_THRESHOLD_TICKS = NETWORK_RULES.awardEveryTicks;

/**
 * Declared matches, in order. Each maps the harness assignment to the catalog scenario whose layout, rules
 * and red controller it reproduces; the blue side, played by a human in that scenario, is a scripted surrogate here.
 */
export const PLAYABILITY_MATCHES: readonly { matchup: ObjectiveMatchup; simulationId: string; scenarioId: string }[] = [
  { matchup: 'maneuver-vs-objectives', simulationId: 'PLAY0001', scenarioId: 'crosscurrent-objectives/1' },
  { matchup: 'objectives-vs-maneuver', simulationId: 'PLAY0002', scenarioId: 'crosscurrent-network/1' },
];

const sides = ['blue', 'red'] as const;

export function parseArgs(argv: readonly string[]) {
  const value = (flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1]; };
  const matches = Number(value('--matches') ?? MAX_MATCHES), capTicks = Number(value('--cap-ticks') ?? DEFAULT_CAP_TICKS);
  if (!Number.isInteger(matches) || matches < 1 || matches > MAX_MATCHES) throw new Error(`--matches must be an integer from 1 to ${MAX_MATCHES}`);
  if (!Number.isInteger(capTicks) || capTicks < 600 || capTicks > MAX_CAP_TICKS) throw new Error(`--cap-ticks must be an integer from 600 to ${MAX_CAP_TICKS}`);
  return { matches, capTicks, verify: argv.includes('--verify') };
}

/** Immutable name: fixed by schema revision and bounds, never by time; an existing file is never replaced. */
export const artifactFile = (matches: number, capTicks: number) => path.join(ROOT, `evidence/playability/scripted-surrogate-tournament-v1-m${matches}-cap${capTicks}.json`);

export function summarizeMatch(r: ObjectiveRunResult, scenarioId: string) {
  const pulses: PulseObservation[] = r.decisions.map((d) => ({ tick: d.tick, side: d.side, category: d.category, intentType: typeof d.intent?.type === 'string' ? d.intent.type : null, admitted: d.admitted, rejectedAtTick: d.rejectedAtTick }));
  const firstProposal = pulses.filter((p) => p.intentType !== null).reduce<number | null>((m, p) => (m === null ? p.tick : Math.min(m, p.tick)), null);
  const window = { startTick: firstProposal ?? r.ticksSimulated, endTick: r.ticksSimulated, idleThresholdTicks: IDLE_THRESHOLD_TICKS };
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario || scenario.map !== OBJECTIVE_SCENARIO.map || JSON.stringify(scenario.spawn) !== JSON.stringify(OBJECTIVE_SCENARIO.spawn)) throw new Error(`${scenarioId} does not share the harness layout`);
  const player = (s: (typeof sides)[number]) => ({
    kind: 'scripted-surrogate' as const, controller: r.controllers[s], intervalTicks: r.controllers[s] === OBJECTIVE_CONTROLLER ? OBJECTIVE_INTERVAL_TICKS : MANEUVER_INTERVAL_TICKS,
    human: false, model: null, standsInFor: scenario.controller === r.controllers[s] && s === 'red' ? 'catalog opponent controller' : 'human or AI player seat',
  });
  const a = r.activity;
  return {
    scenarioId, matchup: r.matchup, simulationId: r.simulationId, description: r.description,
    players: { blue: player('blue'), red: player('red') },
    capTicks: r.capTicks, ticksSimulated: r.ticksSimulated, simulatedMinutes: r.simulatedMinutes,
    metricsWindow: { ...window, basis: 'Starts at the first tick either side proposed an order (spawn-phase holds excluded) and ends at the last simulated tick.' },
    playability: { blue: sidePlayability(pulses, 'blue', window), red: sidePlayability(pulses, 'red', window) },
    objectiveProgress: objectiveProgress(r.boardUpdates.filter((u) => u.kind === 'award').map((u) => ({ tick: u.tick, scores: u.scores })), r.stationOwnershipChanges),
    outcome: r.outcome, outcomeNote: r.outcome ? 'Game outcome reached inside the bound.' : `No outcome: the bound (${r.capTicks} ticks) ended before elimination or the ${NETWORK_RULES.limitTicks}-tick objective limit. Scores are provisional.`,
    eliminated: r.eliminated, eliminationTick: r.eliminationTick, firstContactTick: r.firstContactTick, finalControllers: r.finalControllers,
    territory: Object.fromEntries(sides.map((s) => [s, { peakTiles: a[s].peakTiles, tilesGainedFromNeutral: a[s].tilesGainedFromNeutral, tilesGainedFromOpponent: a[s].tilesGainedFromOpponent }])),
    observedEffects: Object.fromEntries(sides.map((s) => [s, { transports: a[s].transports, construction: a[s].construction }])),
    minutesWithOwnershipChange: r.minutesWithOwnershipChange, noChangeTailMinutes: r.noChangeTailMinutes,
    reconstruction: r.reconstruction.checks.length ? { checks: r.reconstruction.checks.length, allMatched: r.reconstruction.checks.every((c) => c.fingerprintMatched && c.boardMatched && Object.values(c.decisionsMatched).every((x) => x !== false)), officialRestore: r.reconstruction.officialRestore?.matched ?? null } : 'not run (pass --verify)',
    engineRecord: { turns: r.record.turns.length, upstreamCommit: r.record.upstreamCommit, simulationProfile: r.record.simulationProfile },
  };
}

export async function runTournament(options: { matches: number; capTicks: number; verify: boolean; onMatch?: (line: string) => void }) {
  const matches = [];
  for (const m of PLAYABILITY_MATCHES.slice(0, options.matches)) {
    const r = await runObjectiveMatchup(m.matchup, { simulationId: m.simulationId, capTicks: options.capTicks, verifyReconstruction: options.verify });
    const s = summarizeMatch(r, m.scenarioId); matches.push(s);
    options.onMatch?.(`${m.scenarioId} ${m.matchup} ${m.simulationId}: ticks=${s.ticksSimulated} ` + sides.map((x) => `${x}[exec ${s.playability[x].executed}/${s.playability[x].proposed} rej ${s.playability[x].rejectedAtSubmission}+${s.playability[x].rejectedAtTick} cats ${s.playability[x].distinctExecutedCategories} idle-max ${s.playability[x].longestIdleTicks}]`).join(' ') + ` scores=${JSON.stringify(s.objectiveProgress.scoresAtLastAward)}`);
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(matches)).digest('hex');
  return {
    schema: PLAYABILITY_SCHEMA, metricsVersion: PLAYABILITY_METRICS_VERSION, at: new Date().toISOString(),
    participants: 'scripted surrogates only', humanPlaytest: false, modelCalls: 0, paidInference: 0,
    method: `Accelerated deterministic simulation of the pinned engine on the ${OBJECTIVE_SCENARIO.id} layout under ${NETWORK_RULES.id}; both seats driven by scripted reference controllers (${OBJECTIVE_CONTROLLER}, ${MANEUVER_CONTROLLER}); orders validated at submission and tick time.`,
    bounds: { matches: options.matches, maxMatches: MAX_MATCHES, capTicks: options.capTicks, maxCapTicks: MAX_CAP_TICKS, simulatedMinutesCap: +(options.capTicks / TICKS_PER_SIMULATED_MINUTE).toFixed(2), idleThresholdTicks: IDLE_THRESHOLD_TICKS },
    claim: 'Observed scripted-controller behaviour: legality, variety, idle gaps and provisional points. Not a real AI-player trial, not human play, and not evidence of fun, engagement, learning or realistic opponent doctrine. Fictional abstract game only.',
    determinism: { basis: 'sha256 of the matches array (excludes `at`); identical bounds on the same pinned engine should reproduce it.', matchesSha256: digest },
    matches,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {}; console.warn = () => {};
  const opts = parseArgs(process.argv.slice(2)); const file = artifactFile(opts.matches, opts.capTicks);
  if (fs.existsSync(file)) throw new Error(`Preserve the existing tournament artifact at ${file}; change the bounds or schema revision`);
  const result = await runTournament({ ...opts, onMatch: (l) => console.error(l) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ file, matchesSha256: result.determinism.matchesSha256, matches: result.matches.map((m) => ({ scenarioId: m.scenarioId, matchup: m.matchup, ticks: m.ticksSimulated, outcome: m.outcome, scores: m.objectiveProgress.scoresAtLastAward })) }, null, 2));
}
