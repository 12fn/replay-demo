/**
 * Offline counterfactual for `objectives/frontier-first/1` (docs/demo/frontier-policy-experiment.md). Red is either the
 * recorded `objectives/1` or the frontier-first policy; Blue is one of a few fixed scripted styles choosing from the same
 * enriched/1 candidates a model player sees. Everything else follows `full-game/1`: seed deployment, launch-water-route/1
 * admission, Blue 270 / Red 270 aligned to Blue's first decision tick, up to 45 decisions and the 12000-tick objective limit.
 *
 * The loop mirrors `scripts/ai-player-trial.ts` `advance` (tick-time re-validation, Blue before Red at a shared tick,
 * `rawStep`, `advanceNetwork`, `networkOutcome`) with the Red policy as the only parameter. Before any comparison the
 * script replays the recorded Sol Blue orders against `objectives/1` and requires the saved outcome, final tick, scores and
 * every Red check category, so a divergence from the trial harness stops the run instead of producing numbers.
 *
 * No model, provider, CLI, network or credential is used; nothing is enabled at runtime. The result is written once to a
 * path that must not exist. Measured scripted play in a fictional abstract game; not evidence of difficulty, fun or learning.
 *
 *   pnpm exec tsx scripts/qualify-frontier-experiment.ts --out <new file.json> [--smoke]
 *
 * `--deployment-variants` instead writes `replay.frontier-deployment-variants/1`: the same games from the predeclared fixed
 * spawn variants (docs/demo/frontier-deployment-variants.md). Without it the output is `replay.frontier-policy-experiment/1`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayEngine, TRANSPORT_ADMISSION, type Side } from '../src/engine/engine';
import { FRONTIER_FIRST_CONTROLLER, OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS, frontierFirstAssess, objectiveAssess, type ObjectivePolicy, type PolicyAssessment } from '../src/agents/objective-controller';
import { advanceNetwork, createNetworkLayout, initialNetwork, networkOutcome, networkView, NETWORK_RULES, type NetworkState, type Station } from '../src/campaign/network';
import { selectScenario, type ExerciseScenario } from '../src/scenarios/catalog';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import { FULL_GAME_BOUNDS, FULL_GAME_MODE, MODEL_SIDE, TRIAL_SCENARIO_ID, buildSnapshot, choiceIntent, opponentDue, type Snapshot, type TrialConfig } from './ai-player-trial';
import { ROOT, rawStep, reachableLand, spawnTarget } from './qualify-pacing';

export const EXPERIMENT_SCHEMA = 'replay.frontier-policy-experiment/1';
export const POLICIES: readonly ObjectivePolicy[] = [OBJECTIVE_CONTROLLER, FRONTIER_FIRST_CONTROLLER];
/** PAIR0001 is the recorded trial seed. The held-out seeds were fixed in this file before any experiment run. */
export const RECORDED_SEED = 'PAIR0001';
export const HELD_OUT_SEEDS = ['FFHO0001', 'FFHO0002', 'FFHO0003'] as const;
/** Ticks at which both sides' public totals are sampled (Blue decision ticks under full-game/1). */
export const SAMPLE_TICKS = [585, 855, 1125] as const;
/** Red checks at or before this tick count as the opening. */
export const OPENING_END_TICK = 1125;
export const SOL_TRIAL_DIR = path.join(ROOT, 'evidence/ai-player-trial/fullgame-sol-guarded-20260915');

// ---------------------------------------------------------------------------------------------
// Deployment variants (docs/demo/frontier-deployment-variants.md). Offline, opt-in only.
// ---------------------------------------------------------------------------------------------

export const DEPLOYMENT_VARIANTS_SCHEMA = 'replay.frontier-deployment-variants/1';
/**
 * Fixed Blue/Red spawn fractions on the same world-500 map, resolved with `spawnTarget` exactly like `scenario.spawn`.
 * The recorded pair sits on stations Aster (Blue) and Delta (Red); every variant keeps that convention and deploys each
 * side on a different `NETWORK_RULES.stations` fraction. Chosen from map geometry alone before any variant game was run.
 * Only spawn tiles change: budgets, cadence, policies, stations, scoring and starting resources are those of full-game/1.
 */
export const DEPLOYMENT_VARIANTS = {
  'blue-delta-red-aster/1': { spawn: { blue: [0.72, 0.34], red: [0.19, 0.27] }, geometry: 'recorded stations exchanged: Blue starts on the three-station landmass, Red overseas on the one-station landmass' },
  'blue-beacon-red-cedar/1': { spawn: { blue: [0.45, 0.24], red: [0.55, 0.64] }, geometry: 'both sides on the three-station landmass with a land route between them; neither recorded start is used' },
  'blue-cedar-red-ember/1': { spawn: { blue: [0.55, 0.64], red: [0.85, 0.76] }, geometry: 'Blue on the three-station landmass, Red overseas on the small Ember landmass; neither recorded start is used' },
} as const satisfies Record<string, { spawn: Record<Side, readonly [number, number]>; geometry: string }>;
export type DeploymentVariant = keyof typeof DEPLOYMENT_VARIANTS;
export const RECORDED_DEPLOYMENT = 'recorded' as const;
export type Deployment = DeploymentVariant | typeof RECORDED_DEPLOYMENT;

/** Spawn fractions for a deployment; the recorded deployment is the scenario's own. Unknown names throw. */
export function deploymentSpawn(scenario: ExerciseScenario, deployment?: Deployment): Record<Side, readonly [number, number]> {
  if (deployment === undefined || deployment === RECORDED_DEPLOYMENT) return scenario.spawn;
  if (!Object.hasOwn(DEPLOYMENT_VARIANTS, deployment)) throw new Error(`Unknown deployment variant: ${String(deployment)}`);
  return DEPLOYMENT_VARIANTS[deployment].spawn;
}

/** Engine with both sides' spawn submitted, as every experiment game starts. */
async function deployedEngine(seed: string, scenario: ExerciseScenario, deployment?: Deployment) {
  const spawn = deploymentSpawn(scenario, deployment);
  const e = await ReplayEngine.create({ simulationId: seed, map: scenario.map, transportAdmission: TRANSPORT_ADMISSION });
  const tiles = { blue: spawnTarget(e.game, ...spawn.blue), red: spawnTarget(e.game, ...spawn.red) };
  if (tiles.blue === tiles.red) throw new Error(`deployment ${deployment} resolves both sides to tile ${tiles.blue}`);
  const first = e.step((['blue', 'red'] as Side[]).map((s) => ({ side: s, intent: { type: 'spawn', tile: tiles[s] } }))); e.fingerprints[first.tick] = first.fingerprint;
  return e;
}

/**
 * Starting conditions once the deployment phase ends, stated in map terms that do not depend on player IDs: spawn tile
 * and coordinates, the owned tile set (sha256 of sorted tile indices), troops, the land component and stations on it, and
 * stations already controlled. `playerIds` and `fingerprint` are included only to show they vary with the seed.
 */
export async function initialDeployment(seed: string, deployment?: Deployment) {
  const scenario = selectScenario(TRIAL_SCENARIO_ID); const e = await deployedEngine(seed, scenario, deployment); const g = e.game;
  while (g.inSpawnPhase()) rawStep(e);
  const layout = createNetworkLayout(e); const view = networkView(e, layout, initialNetwork(g.ticks()));
  const land = { blue: reachableLand(g, e.player('blue').tiles()), red: reachableLand(g, e.player('red').tiles()) };
  const side = (s: Side) => {
    const p = e.player(s); const tile = p.spawnTile(); if (!p.hasSpawned() || tile === undefined) throw new Error(`${s} did not deploy under ${deployment ?? RECORDED_DEPLOYMENT}`);
    const owned = [...p.tiles()].sort((a, b) => a - b);
    return {
      spawnTile: tile, x: g.x(tile), y: g.y(tile), ownedTiles: owned.length, ownedTilesSha256: sha(owned.join(',')), owned, troops: Math.round(p.troops()),
      landTiles: land[s].reduce((n, v) => n + v, 0), stationsOnLandmass: layout.filter((st) => land[s][st.tile] === 1).map((st) => st.id), stationsControlled: view.stations.filter((st) => st.controller === s).map((st) => st.id),
    };
  };
  const blue = side('blue'), red = side('red');
  return {
    seed, deployment: deployment ?? RECORDED_DEPLOYMENT, spawn: deploymentSpawn(scenario, deployment), tick: g.ticks(), blue, red,
    sharedLandmass: land.red[blue.spawnTile] === 1, spawnSeparationTiles: Math.round(Math.hypot(blue.x - red.x, blue.y - red.y)),
    playerIds: { blue: e.player('blue').id(), red: e.player('red').id() }, fingerprint: e.state().fingerprint, record: e.record(),
  };
}
export type InitialDeployment = Awaited<ReturnType<typeof initialDeployment>>;
/** How two starts differ per side: spawn tile, distance between spawns, and owned tiles in common. */
export function startDifference(a: InitialDeployment, b: InitialDeployment) {
  return Object.fromEntries((['blue', 'red'] as Side[]).map((s) => {
    const set = new Set(a[s].owned);
    return [s, { sameSpawnTile: a[s].spawnTile === b[s].spawnTile, spawnDistanceTiles: Math.round(Math.hypot(a[s].x - b[s].x, a[s].y - b[s].y)), sharedOwnedTiles: b[s].owned.filter((t) => set.has(t)).length, sameLandmassStations: JSON.stringify(a[s].stationsOnLandmass) === JSON.stringify(b[s].stationsOnLandmass) }];
  })) as Record<Side, { sameSpawnTile: boolean; spawnDistanceTiles: number; sharedOwnedTiles: number; sameLandmassStations: boolean }>;
}

// ---------------------------------------------------------------------------------------------
// Blue styles: fixed rules over the enriched/1 candidate list. Each returns a candidate index and share, or hold.
// ---------------------------------------------------------------------------------------------

type BlueChoice = { choice: number | 'hold'; share?: number; label: string };
interface StyleInput { snap: Snapshot; decision: number; layout: Station[]; controllers: Record<string, Side | null> }
const maxShare = (snap: Snapshot, i: number) => Math.max(...snap.candidates[i]!.troopOptions!.map((o) => o.share));
const hasShare = (snap: Snapshot, i: number, share: number) => snap.candidates[i]!.troopOptions?.some((o) => o.share === share) ?? false;
const find = (snap: Snapshot, f: (intent: Record<string, unknown>) => boolean) => snap.candidates.findIndex((c) => f(c.intent));
const isExpansion = (i: Record<string, unknown>) => i.type === 'attack' && i.targetID === null;
const isAttack = (i: Record<string, unknown>) => i.type === 'attack' && i.targetID !== null;
/** A transport whose destination is a station centre, for a station in one of `wanted` control states (board order). */
const stationBoat = (x: StyleInput, wanted: (Side | null)[]) => {
  for (const want of wanted) for (const st of x.layout) {
    if (x.controllers[st.id] !== want) continue;
    const i = find(x.snap, (intent) => intent.type === 'boat' && intent.dst === st.tile); if (i >= 0) return { i, id: st.id };
  }
  return null;
};

export const BLUE_STYLES = {
  /** Never orders. */
  'hold': (): BlueChoice => ({ choice: 'hold', label: 'hold' }),
  /** The rule noted in docs/demo/full-game-player-trials.md: first troop-bearing candidate at its default share on even decisions, hold on odd. */
  'first-troop-even': (x: StyleInput): BlueChoice => {
    if (x.decision % 2 === 1) return { choice: 'hold', label: 'odd decision' };
    const i = x.snap.candidates.findIndex((c) => c.troopOptions); return i < 0 ? { choice: 'hold', label: 'no troop-bearing candidate' } : { choice: i, label: 'first troop-bearing' };
  },
  /** Sol-like: largest share; expand for the first two decisions, then boat for stations Blue does not hold, then attack Red, else expand. */
  'aggressive': (x: StyleInput): BlueChoice => {
    const exp = find(x.snap, isExpansion);
    if (x.decision < 2 && exp >= 0) return { choice: exp, share: maxShare(x.snap, exp), label: 'opening expansion' };
    const boat = stationBoat(x, [null, 'red']); if (boat) return { choice: boat.i, share: maxShare(x.snap, boat.i), label: `station boat ${boat.id}` };
    const atk = find(x.snap, isAttack); if (atk >= 0) return { choice: atk, share: maxShare(x.snap, atk), label: 'attack red' };
    if (exp >= 0) return { choice: exp, share: maxShare(x.snap, exp), label: 'expansion' };
    return { choice: 'hold', label: 'nothing listed' };
  },
  /** Keeps most forces home: 0.2 expansion, else 0.2 boat to an uncontrolled station, else a Defense Post; never attacks Red or sails for a Red station. */
  'cautious': (x: StyleInput): BlueChoice => {
    const exp = find(x.snap, isExpansion); if (exp >= 0 && hasShare(x.snap, exp, 0.2)) return { choice: exp, share: 0.2, label: 'expansion' };
    const boat = stationBoat(x, [null]); if (boat && hasShare(x.snap, boat.i, 0.2)) return { choice: boat.i, share: 0.2, label: `station boat ${boat.id}` };
    const post = find(x.snap, (i) => i.type === 'build_unit' && i.unit === UnitType.DefensePost); if (post >= 0) return { choice: post, label: 'defense post' };
    return { choice: 'hold', label: 'nothing listed' };
  },
} as const;
export type BlueStyle = keyof typeof BLUE_STYLES;
/** Replays the Blue intents recorded in the Sol trial at their ticks, then holds. Used only for the harness parity check. */
type RecordedBlue = { kind: 'recorded'; intents: Map<number, Record<string, unknown>> };

// ---------------------------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------------------------

interface Pending { side: Side; intent: Record<string, unknown>; decisionTick: number }
export interface RedCheck {
  tick: number; category: string; intentType: string | null; targetsBlue: boolean; source: string; objectiveId: string | null;
  admittedAtSubmission: boolean; executedAtTick: boolean | null; neutralBorder: number; reserveRatio: number; spendableTroops: number;
  displaced: { category: string; intentType: string | null; source: string; objectiveId: string | null } | null;
  precedenceDeclined: string | null;
}
export interface BlueDecision { decision: number; tick: number; label: string; choice: number | 'hold'; share: number | null; intentType: string | null; category: string; executedAtTick: boolean | null }
const sideTotals = (e: ReplayEngine, s: Side) => { const p = e.player(s); return { tiles: p.numTilesOwned(), troops: Math.round(p.troops()), alive: p.isAlive() }; };
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const blueCategory = (i: Record<string, unknown> | null) => (!i ? 'hold' : isExpansion(i) ? 'expansion' : isAttack(i) ? 'attack' : i.type === 'boat' ? 'transport' : i.type === 'build_unit' ? 'construction' : String(i.type));

/** `deployment` is opt-in; when absent the game, its result keys and its record are exactly the recorded full-game/1 deployment. */
export async function runGame(opts: { seed: string; policy: ObjectivePolicy; blue: BlueStyle | RecordedBlue; capTicks?: number; keepRecord?: boolean; deployment?: DeploymentVariant }) {
  const scenario = selectScenario(TRIAL_SCENARIO_ID);
  if (scenario.controller !== OBJECTIVE_CONTROLLER) throw new Error(`${TRIAL_SCENARIO_ID} no longer uses ${OBJECTIVE_CONTROLLER}`);
  const B = FULL_GAME_BOUNDS, capTicks = opts.capTicks ?? B.capTicks;
  const config: TrialConfig = { scenarioId: scenario.id, seed: opts.seed, seat: MODEL_SIDE, opponent: opts.policy, ticksPerDecision: B.ticksPerDecision, opponentTicksPerCheck: B.opponentTicksPerCheck, maxDecisions: B.maxDecisions, capTicks, playerContext: 'enriched/1', trialMode: FULL_GAME_MODE, transportAdmission: TRANSPORT_ADMISSION };
  const e = await deployedEngine(opts.seed, scenario, opts.deployment);
  const layout = createNetworkLayout(e); let network: NetworkState = initialNetwork(e.game.ticks());
  let pending: Pending[] = []; const executed = new Map<Pending, boolean>();
  const redChecks: (RedCheck & { order: Pending | null })[] = [];
  const assess = (view: Parameters<typeof objectiveAssess>[2]): PolicyAssessment => (opts.policy === FRONTIER_FIRST_CONTROLLER ? frontierFirstAssess(e, 'red', view, B.opponentTicksPerCheck) : objectiveAssess(e, 'red', view));

  /** Same loop as the trial harness `advance`, with the Red policy as the only difference. */
  const advance = (cap: number, stop: (t: number) => boolean, due: (t: number) => boolean) => {
    let outcome: ReturnType<typeof networkOutcome> = null;
    while (e.game.ticks() < cap) {
      const admitted: Pending[] = [];
      for (const o of pending) { try { e.validate(o.side, o.intent); admitted.push(o); executed.set(o, true); } catch { executed.set(o, false); } }
      pending = [];
      rawStep(e, admitted.map((o) => ({ side: o.side, intent: o.intent })));
      const tick = e.game.ticks(); const adv = advanceNetwork(e, layout, network); network = adv.state;
      if (tick % NETWORK_RULES.awardEveryTicks === 0) e.fingerprints[tick] = e.state().fingerprint;
      outcome = !e.game.inSpawnPhase() && tick > 50 ? networkOutcome(network, { blue: e.player('blue').isAlive(), red: e.player('red').isAlive() }) : null;
      if (outcome) break;
      if (due(tick)) {
        const a = assess(adv.view); let order: Pending | null = null;
        if (a.intent) { try { e.validate('red', a.intent); order = { side: 'red', intent: a.intent, decisionTick: tick }; pending.push(order); } catch { /* dropped, like the harness */ } }
        const d = a.displaced;
        redChecks.push({ tick, category: a.category, intentType: typeof a.intent?.type === 'string' ? a.intent.type : null, targetsBlue: !!a.intent && a.intent.type === 'attack' && a.intent.targetID !== null, source: a.source, objectiveId: a.objectiveId, admittedAtSubmission: order !== null, executedAtTick: null, neutralBorder: a.observed.neutralBorder, reserveRatio: Number(a.observed.reserveRatio.toFixed(4)), spendableTroops: a.observed.spendableTroops, displaced: d ? { category: d.category, intentType: typeof d.intent.type === 'string' ? d.intent.type : null, source: d.source, objectiveId: d.objectiveId } : null, precedenceDeclined: a.precedenceDeclined ?? null, order });
      }
      if (stop(tick)) break;
    }
    e.fingerprints[e.game.ticks()] = e.state().fingerprint;
    return outcome;
  };

  const firstReady = (t: number) => t % OBJECTIVE_INTERVAL_TICKS === 0 && !e.game.inSpawnPhase() && e.player(MODEL_SIDE).hasSpawned();
  let outcome = advance(capTicks, firstReady, firstReady);
  const firstDecisionTick = e.game.ticks(); const due = opponentDue(B.opponentTicksPerCheck, firstDecisionTick);
  const samples: Record<string, { blue: ReturnType<typeof sideTotals>; red: ReturnType<typeof sideTotals>; scores: Record<Side, number> }> = {};
  const blueDecisions: (BlueDecision & { order: Pending | null })[] = [];
  let k = 0;
  while (!outcome && k < B.maxDecisions && e.game.ticks() < capTicks) {
    const tick = e.game.ticks();
    if ((SAMPLE_TICKS as readonly number[]).includes(tick)) samples[tick] = { blue: sideTotals(e, 'blue'), red: sideTotals(e, 'red'), scores: { ...network.scores } };
    let pick: BlueChoice; let intent: Record<string, unknown> | null;
    if (typeof opts.blue === 'object') { const rec = opts.blue.intents.get(tick); pick = { choice: rec ? 0 : 'hold', label: rec ? 'recorded' : 'hold' }; intent = rec ? structuredClone(rec) : null; }
    else {
      const snap = buildSnapshot({ e, layout, network, pending: [], opponentPulses: [], executed: new Map() }, `experiment-${opts.seed}`, k, config, []);
      pick = BLUE_STYLES[opts.blue]({ snap, decision: k, layout, controllers: network.controllers });
      intent = choiceIntent(snap, pick.choice, pick.share);
    }
    let order: Pending | null = null;
    if (intent) { e.validate(MODEL_SIDE, intent); order = { side: MODEL_SIDE, intent, decisionTick: tick }; pending = [order, ...pending]; }
    blueDecisions.push({ decision: k, tick, label: pick.label, choice: pick.choice, share: pick.share ?? null, intentType: intent ? String(intent.type) : null, category: blueCategory(intent), executedAtTick: null, order });
    const end = Math.min(capTicks, tick + B.ticksPerDecision);
    outcome = advance(end, (t) => t >= end, due); k++;
  }
  const finalTick = e.game.ticks();
  const stopReason = outcome ? 'game-outcome' : k >= B.maxDecisions ? 'decision-limit' : 'tick-cap';
  for (const c of redChecks) c.executedAtTick = c.order ? executed.get(c.order) ?? null : null;
  for (const b of blueDecisions) b.executedAtTick = b.order ? executed.get(b.order) ?? null : null;
  const strip = <T extends { order: Pending | null }>(xs: T[]) => xs.map(({ order: _o, ...rest }) => rest);
  const red = strip(redChecks), blue = strip(blueDecisions);
  const effective = red.filter((c) => c.tick >= firstDecisionTick && c.tick < finalTick);
  const count = <T,>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {});
  const nonExpandingOpen = (xs: RedCheck[]) => xs.filter((c) => c.neutralBorder > 0 && c.category !== 'expansion').map((c) => ({ tick: c.tick, category: c.category, source: c.source, precedenceDeclined: c.precedenceDeclined }));
  const record = e.record();
  return {
    seed: opts.seed, policy: opts.policy, blue: typeof opts.blue === 'object' ? 'recorded-sol' : opts.blue, ...(opts.deployment ? { deployment: opts.deployment } : {}), capTicks,
    outcome, stopReason, scoresStatus: outcome ? 'final' : 'provisional', finalTick, firstDecisionTick, decisions: k,
    scores: { ...network.scores }, controllers: { ...network.controllers }, final: { blue: sideTotals(e, 'blue'), red: sideTotals(e, 'red') }, samples,
    redSummary: {
      checks: red.length, checksWithEffect: effective.length, categories: count(effective, (c) => c.category), sources: count(effective, (c) => c.source),
      ordersQueued: effective.filter((c) => c.admittedAtSubmission).length, refusedAtSubmission: effective.filter((c) => c.intentType !== null && !c.admittedAtSubmission).length,
      executedAtTick: effective.filter((c) => c.executedAtTick === true).length, droppedAtTick: effective.filter((c) => c.executedAtTick === false).length,
      firstExecutedAttackOnBlueTick: effective.find((c) => c.targetsBlue && c.executedAtTick)?.tick ?? null,
      precedenceApplied: effective.filter((c) => c.displaced).length, precedenceDeclined: effective.filter((c) => c.precedenceDeclined).length,displacedCategories: count(effective.filter((c) => c.displaced), (c) => c.displaced!.category),
      openingNonExpandingWithFrontierOpen: nonExpandingOpen(effective.filter((c) => c.tick <= OPENING_END_TICK)), nonExpandingWithFrontierOpen: nonExpandingOpen(effective).length,
    },
    blueSummary: { decisions: blue.length, categories: count(blue, (b) => b.category), executedAtTick: blue.filter((b) => b.executedAtTick === true).length, droppedAtTick: blue.filter((b) => b.executedAtTick === false).length },
    redChecks: red, blueDecisions: blue,
    finalFingerprint: e.state().fingerprint, recordSha256: sha(JSON.stringify(record)),
    ...(opts.keepRecord ? { record } : {}),
  };
}
export type GameResult = Awaited<ReturnType<typeof runGame>>;

// ---------------------------------------------------------------------------------------------
// Parity, determinism, comparison
// ---------------------------------------------------------------------------------------------

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

/** Recorded Sol Blue orders against `objectives/1` must reproduce the saved final summary and every saved Red check. */
export async function harnessParity(dir = SOL_TRIAL_DIR) {
  const manifest = readJson<{ config: TrialConfig; history: { tick: number; intent: Record<string, unknown> | null; outcome: string }[] }>(path.join(dir, 'manifest.json'));
  const summary = readJson<{ outcome: unknown; ticksSimulated: number; scores: Record<Side, number>; stopReason: string }>(path.join(dir, 'final/summary.json'));
  const pulses = [path.join(dir, 'initialization/receipts.json'), ...manifest.history.map((h) => path.join(dir, h.outcome, 'receipts.json'))].flatMap((f) => readJson<{ opponent: { pulses: { tick: number; category: string; intentType: string | null }[] } }>(f).opponent.pulses);
  const intents = new Map(manifest.history.filter((h) => h.intent).map((h) => [h.tick, h.intent!]));
  const r = await runGame({ seed: manifest.config.seed, policy: OBJECTIVE_CONTROLLER, blue: { kind: 'recorded', intents } });
  const redMatched = r.redChecks.length === pulses.length && r.redChecks.every((c, i) => c.tick === pulses[i]!.tick && c.category === pulses[i]!.category && c.intentType === pulses[i]!.intentType);
  const checks = { outcome: JSON.stringify(r.outcome) === JSON.stringify(summary.outcome), finalTick: r.finalTick === summary.ticksSimulated, scores: JSON.stringify(r.scores) === JSON.stringify(summary.scores), stopReason: r.stopReason === summary.stopReason, redChecks: redMatched };
  return { source: path.relative(ROOT, dir), matched: Object.values(checks).every(Boolean), checks, finalTick: r.finalTick, outcome: r.outcome, redChecksCompared: pulses.length };
}

/** Same inputs twice give byte-identical records; the final record restores to the same fingerprint. */
export async function determinism(seed: string, blue: BlueStyle, policy: ObjectivePolicy, capTicks?: number, deployment?: DeploymentVariant) {
  const a = await runGame({ seed, blue, policy, capTicks, keepRecord: true, deployment }), b = await runGame({ seed, blue, policy, capTicks, deployment });
  const restored = await ReplayEngine.restore(a.record!, a.record!.turns.length, 'checkpoints');
  return { seed, blue, policy, ...(deployment ? { deployment } : {}), sameRecord: a.recordSha256 === b.recordSha256, sameRedChecks: JSON.stringify(a.redChecks) === JSON.stringify(b.redChecks), restoredFingerprintMatched: restored.state().fingerprint === a.finalFingerprint, recordSha256: a.recordSha256 };
}

const tileGap = (r: GameResult, tick: number) => (r.samples[tick] ? r.samples[tick]!.blue.tiles - r.samples[tick]!.red.tiles : null);
export function compare(v1: GameResult, ff: GameResult) {
  return {
    seed: v1.seed, blue: v1.blue,
    outcome: { [OBJECTIVE_CONTROLLER]: v1.outcome, [FRONTIER_FIRST_CONTROLLER]: ff.outcome, changed: JSON.stringify(v1.outcome) !== JSON.stringify(ff.outcome) },
    finalTick: { [OBJECTIVE_CONTROLLER]: v1.finalTick, [FRONTIER_FIRST_CONTROLLER]: ff.finalTick, delta: ff.finalTick - v1.finalTick },
    blueMinusRedTiles: Object.fromEntries(SAMPLE_TICKS.map((t) => [t, { [OBJECTIVE_CONTROLLER]: tileGap(v1, t), [FRONTIER_FIRST_CONTROLLER]: tileGap(ff, t) }])),
    openingNonExpandingWithFrontierOpen: { [OBJECTIVE_CONTROLLER]: v1.redSummary.openingNonExpandingWithFrontierOpen.length, [FRONTIER_FIRST_CONTROLLER]: ff.redSummary.openingNonExpandingWithFrontierOpen.length },
    firstExecutedAttackOnBlueTick: { [OBJECTIVE_CONTROLLER]: v1.redSummary.firstExecutedAttackOnBlueTick, [FRONTIER_FIRST_CONTROLLER]: ff.redSummary.firstExecutedAttackOnBlueTick },
    precedenceApplied: ff.redSummary.precedenceApplied, precedenceDeclined: ff.redSummary.precedenceDeclined,
  };
}

export const EXPERIMENT_CLAIMS = {
  offline: 'Deterministic scripted play on the pinned engine. No model, provider, CLI, network, native platform or credential call.',
  enablement: `${FRONTIER_FIRST_CONTROLLER} is not enabled anywhere at runtime; the app and saved trials use ${OBJECTIVE_CONTROLLER}.`,
  variable: 'One variable: rule precedence. Pulse-modulo gates, commit shares, transport shares, reserve guard, information and cadence are unchanged.',
  human: 'No human played. Nothing here measures fun, engagement, learning, difficulty calibration or doctrine.',
  blue: 'Blue styles are fixed scripted surrogates, not models and not humans.',
} as const;

export async function runExperiment(opts: { smoke?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const seeds = opts.smoke ? [RECORDED_SEED] : [RECORDED_SEED, ...HELD_OUT_SEEDS];
  const styles: BlueStyle[] = opts.smoke ? ['aggressive'] : (Object.keys(BLUE_STYLES) as BlueStyle[]);
  const capTicks = opts.smoke ? 1395 : undefined;
  log('harness parity against the recorded Sol trial');
  const parity = await harnessParity();
  if (!parity.matched) throw new Error(`experiment loop diverged from the recorded trial: ${JSON.stringify(parity.checks)}`);
  const games: GameResult[] = []; const comparisons = [];
  for (const seed of seeds) for (const blue of styles) {
    const pair = [] as GameResult[];
    for (const policy of POLICIES) { const t0 = Date.now(); const r = await runGame({ seed, blue, policy, capTicks }); pair.push(r); games.push(r); log(`${seed} ${blue} ${policy}: ${r.stopReason} ${JSON.stringify(r.outcome)} tick ${r.finalTick} (${Date.now() - t0} ms)`); }
    comparisons.push(compare(pair[0]!, pair[1]!));
  }
  log('determinism re-run');
  const det = await Promise.all(POLICIES.map((p) => determinism(RECORDED_SEED, 'aggressive', p, capTicks)));
  const ffGames = games.filter((g) => g.policy === FRONTIER_FIRST_CONTROLLER);
  const aggressive = comparisons.filter((c) => c.blue === 'aggressive');
  return {
    schema: EXPERIMENT_SCHEMA, kind: opts.smoke ? 'smoke-not-experiment' : 'experiment', generatedAt: new Date().toISOString(),
    method: { scenario: TRIAL_SCENARIO_ID, mode: FULL_GAME_MODE, bounds: { ...FULL_GAME_BOUNDS, ...(capTicks ? { capTicks } : {}) }, transportAdmission: TRANSPORT_ADMISSION, policies: POLICIES, recordedSeed: RECORDED_SEED, heldOutSeeds: opts.smoke ? [] : HELD_OUT_SEEDS, blueStyles: styles, sampleTicks: SAMPLE_TICKS, openingEndTick: OPENING_END_TICK },
    claims: EXPERIMENT_CLAIMS,
    harnessParity: parity, determinism: det,
    /** Measured against the review's §8 criteria; reported, not judged. Main decides. */
    criteria: {
      frontierFirstOpeningNonExpandingWithFrontierOpen: ffGames.map((g) => ({ seed: g.seed, blue: g.blue, count: g.redSummary.openingNonExpandingWithFrontierOpen.length })),
      aggressiveTileGapAt1125: aggressive.map((c) => ({ seed: c.seed, ...c.blueMinusRedTiles[1125] })),
      aggressiveOutcomeAndDuration: aggressive.map((c) => ({ seed: c.seed, outcome: c.outcome, finalTick: c.finalTick })),
      aggressiveBlueWinsUnderFrontierFirst: ffGames.filter((g) => g.blue === 'aggressive' && g.outcome?.winner === 'blue').map((g) => g.seed),
    },
    comparisons, games,
  };
}

export const DEPLOYMENT_CLAIMS = {
  ...EXPERIMENT_CLAIMS,
  variable: 'Two variables, reported separately: deployment geometry (fixed spawn fractions) and rule precedence. Seed, map, stations, scoring, starting resources, pulse-modulo gates, commit shares, transport shares, reserve guard, information and cadence are unchanged.',
  geometry: 'Variants were predeclared from map geometry before any variant game. Distinct starts are shown by spawn tiles, owned tile sets and landmasses, not by player IDs or fingerprints. Three fixed layouts on one fictional map are not held-out scenario validation.',
} as const;

/**
 * `replay.frontier-deployment-variants/1`: the recorded deployment plus every predeclared variant, on the recorded seed,
 * each Blue style under both policies. Before any game it requires harness parity and that every variant's start differs
 * from the recorded start and from each other for both sides, and is the same under all four seed identifiers.
 */
export async function runDeploymentVariants(opts: { smoke?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const variants = (Object.keys(DEPLOYMENT_VARIANTS) as DeploymentVariant[]).slice(0, opts.smoke ? 1 : undefined);
  const deployments: Deployment[] = [RECORDED_DEPLOYMENT, ...variants];
  const styles: BlueStyle[] = opts.smoke ? ['aggressive'] : (Object.keys(BLUE_STYLES) as BlueStyle[]);
  const capTicks = opts.smoke ? 1395 : undefined;
  log('harness parity against the recorded Sol trial');
  const parity = await harnessParity();
  if (!parity.matched) throw new Error(`experiment loop diverged from the recorded trial: ${JSON.stringify(parity.checks)}`);

  log('starting conditions');
  const starts = new Map<Deployment, InitialDeployment>(); const seedInvariance = [];
  for (const d of deployments) {
    const bySeed = await Promise.all([RECORDED_SEED, ...HELD_OUT_SEEDS].map((s) => initialDeployment(s, d)));
    const key = (x: InitialDeployment) => JSON.stringify({ blue: { ...x.blue }, red: { ...x.red }, tick: x.tick });
    seedInvariance.push({ deployment: d, seeds: bySeed.map((x) => x.seed), sameStartAcrossSeeds: bySeed.every((x) => key(x) === key(bySeed[0]!)), distinctPlayerIds: new Set(bySeed.map((x) => x.playerIds.blue)).size, distinctFingerprints: new Set(bySeed.map((x) => x.fingerprint)).size });
    starts.set(d, bySeed[0]!);
  }
  const differences = deployments.flatMap((a, i) => deployments.slice(i + 1).map((b) => ({ a, b, ...startDifference(starts.get(a)!, starts.get(b)!) })));
  const indistinct = differences.filter((x) => (['blue', 'red'] as Side[]).some((s) => x[s].sameSpawnTile || x[s].sharedOwnedTiles > 0));
  if (indistinct.length) throw new Error(`deployments do not have distinct starts: ${JSON.stringify(indistinct)}`);
  if (seedInvariance.some((x) => !x.sameStartAcrossSeeds)) throw new Error(`a deployment start depends on the seed: ${JSON.stringify(seedInvariance)}`);

  const games: GameResult[] = []; const comparisons = [];
  for (const d of deployments) for (const blue of styles) {
    const deployment = d === RECORDED_DEPLOYMENT ? undefined : d; const pair = [] as GameResult[];
    for (const policy of POLICIES) { const t0 = Date.now(); const r = await runGame({ seed: RECORDED_SEED, blue, policy, capTicks, deployment }); pair.push(r); games.push(r); log(`${d} ${blue} ${policy}: ${r.stopReason} ${JSON.stringify(r.outcome)} tick ${r.finalTick} (${Date.now() - t0} ms)`); }
    comparisons.push({ deployment: d, ...compare(pair[0]!, pair[1]!) });
  }
  log('determinism re-run');
  const det = await Promise.all(variants.flatMap((d) => POLICIES.map((p) => determinism(RECORDED_SEED, 'aggressive', p, capTicks, d))));
  const deploymentOf = (g: GameResult) => ('deployment' in g && g.deployment) || RECORDED_DEPLOYMENT;
  const publicStart = ({ record: _r, fingerprint: _f, blue: { owned: _b, ...blue }, red: { owned: _o, ...red }, ...rest }: InitialDeployment) => ({ ...rest, blue, red });
  return {
    schema: DEPLOYMENT_VARIANTS_SCHEMA, kind: opts.smoke ? 'smoke-not-experiment' : 'experiment', generatedAt: new Date().toISOString(),
    method: {
      scenario: TRIAL_SCENARIO_ID, mode: FULL_GAME_MODE, bounds: { ...FULL_GAME_BOUNDS, ...(capTicks ? { capTicks } : {}) }, transportAdmission: TRANSPORT_ADMISSION, policies: POLICIES, seed: RECORDED_SEED, blueStyles: styles, sampleTicks: SAMPLE_TICKS, openingEndTick: OPENING_END_TICK,
      deployments: Object.fromEntries(deployments.map((d) => [d, d === RECORDED_DEPLOYMENT ? { spawn: selectScenario(TRIAL_SCENARIO_ID).spawn, geometry: 'full-game/1 as recorded' } : DEPLOYMENT_VARIANTS[d]])),
      priorReceipt: 'evidence/campaign/frontier-policy-main-20260915.json (replay.frontier-policy-experiment/1, unchanged)',
    },
    claims: DEPLOYMENT_CLAIMS,
    harnessParity: parity,
    startingConditions: { deployments: deployments.map((d) => publicStart(starts.get(d)!)), seedInvariance, differences },
    determinism: det,
    /** Measured, not judged. Main decides. */
    criteria: {
      frontierFirstOpeningNonExpandingWithFrontierOpen: games.filter((g) => g.policy === FRONTIER_FIRST_CONTROLLER).map((g) => ({ deployment: deploymentOf(g), blue: g.blue, count: g.redSummary.openingNonExpandingWithFrontierOpen.length })),
      outcomes: comparisons.map((c) => ({ deployment: c.deployment, blue: c.blue, outcome: c.outcome, finalTick: c.finalTick })),
    },
    comparisons, games,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {}; console.warn = () => {};
  try {
    const args = process.argv.slice(2); let out: string | undefined; let smoke = false; let variants = false;
    for (let i = 0; i < args.length; i++) { if (args[i] === '--out' && args[i + 1] && out === undefined) out = args[++i]; else if (args[i] === '--smoke' && !smoke) smoke = true; else if (args[i] === '--deployment-variants' && !variants) variants = true; else throw new Error(`unknown or repeated option ${args[i]}`); }
    if (!out) throw new Error('--out <new file.json> is required');
    const file = path.resolve(out);
    if (fs.existsSync(file)) throw new Error(`${file} exists; results are written once to a new path`);
    const log = (s: string) => console.error(s);
    const result = variants ? await runDeploymentVariants({ smoke, log }) : await runExperiment({ smoke, log });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
    console.log(JSON.stringify({ out: file, kind: result.kind, games: result.games.length, harnessParity: result.harnessParity.matched, determinism: result.determinism.every((d) => d.sameRecord && d.sameRedChecks && d.restoredFingerprintMatched) }));
  } catch (err) {
    console.error(JSON.stringify({ error: (err as Error).message }));
    process.exitCode = 1;
  }
}
