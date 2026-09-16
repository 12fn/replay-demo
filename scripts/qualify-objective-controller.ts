/**
 * Objective-controller characterization: `objectives/1` against and beside the `maneuver/1` reference
 * on the exact `crosscurrent-network/1` layout (world-500, blue at the Aster deployment, red at the
 * Delta deployment; the two are separated by sea), under the `stations-and-reserves/1` rules with the
 * 12,000-tick cap. Everything is accelerated deterministic simulation in simulated ticks (600 per
 * simulated minute); wall-clock figures describe this machine only. No human plays, no model is called,
 * elimination is never suspended. Nothing here is evidence of engagement, learning or optimal play.
 *
 * Geometry, initial forces, rules and visibility are identical for every matchup; only the controller
 * assignment and the declared seed (player IDs) change. Orders are admitted through `ReplayEngine.validate`
 * and executed through the engine's own turn path (`rawStep`); the board is advanced with the same
 * `advanceNetwork` the service uses; the engine's execution observer records what admitted boat and
 * construction orders later did.
 *
 * Tests import this module and never write evidence. Run directly
 * (`pnpm exec tsx scripts/qualify-objective-controller.ts [--quick] [--out path]`) it writes
 * evidence/campaign/objective-controller-characterization.json and refuses to overwrite an existing file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENTS, ReplayEngine, type EngineRecord, type ExecutionFeedbackEvent, type Side, inputKeyString } from '../src/engine/engine';
import { MANEUVER_CONTROLLER, MANEUVER_INTERVAL_TICKS, landmasses, maneuverAssess } from '../src/agents/scripted-controller';
import { OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS, OBJECTIVE_RULES, objectiveAssess, type DecisionSource, type ObjectiveAssessment, type ObjectiveCategory } from '../src/agents/objective-controller';
import { NETWORK_RULES, advanceNetwork, createNetworkLayout, initialNetwork, networkOutcome, type NetworkState, type NetworkView } from '../src/campaign/network';
import { SCENARIOS } from '../src/scenarios/catalog';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import { ROOT, TICKS_PER_SIMULATED_MINUTE, deploymentGeography, rawStep, spawnTarget } from './qualify-pacing';
import { percentiles, type Percentiles } from './qualify-maneuver';

export type ObjectiveController = typeof MANEUVER_CONTROLLER | typeof OBJECTIVE_CONTROLLER;
export type ObjectiveMatchup = 'objectives-vs-maneuver' | 'maneuver-vs-objectives' | 'objectives-vs-objectives';
export const OBJECTIVE_MATCHUPS: Record<ObjectiveMatchup, { blue: ObjectiveController; red: ObjectiveController; description: string }> = {
  'objectives-vs-maneuver': { blue: OBJECTIVE_CONTROLLER, red: MANEUVER_CONTROLLER, description: 'Blue runs objectives/1 from the Aster deployment, red the maneuver/1 reference from the Delta deployment.' },
  'maneuver-vs-objectives': { blue: MANEUVER_CONTROLLER, red: OBJECTIVE_CONTROLLER, description: 'Sides swapped: red runs objectives/1 from the Delta deployment, blue the maneuver/1 reference from the Aster deployment.' },
  'objectives-vs-objectives': { blue: OBJECTIVE_CONTROLLER, red: OBJECTIVE_CONTROLLER, description: 'Both sides run objectives/1 (mirror) from the two deployments.' },
};
export const OBJECTIVE_SEEDS = ['OBJC0001', 'OBJC0002'] as const;
/** The exact recorded scenario layout; the harness never redefines it. */
export const OBJECTIVE_SCENARIO = (() => { const s = SCENARIOS.find((x) => x.id === 'crosscurrent-network/1'); if (!s) throw new Error('crosscurrent-network/1 is not in the scenario catalog'); return s; })();
export const OBJECTIVE_EVIDENCE_FILE = path.join(ROOT, 'evidence/campaign/objective-controller-characterization.json');
/** Reconstruction checkpoints: the priority boundaries (multiples of both cadences) and the final tick. */
export const CHECKPOINT_EVERY: number = NETWORK_RULES.priorityEveryTicks;

export interface SideMinute { tiles: number; troops: number; maxTroops: number; reserveRatio: number; reserveEligible: boolean; gold: number; attacks: number; alive: boolean; structures: Record<'City' | 'Defense Post' | 'Port', number>; transportsAtSea: number; landmasses: number; controlled: string[]; score: number }
export interface MinuteSample { tick: number; simulatedMinute: number; blue: SideMinute; red: SideMinute; priorityId: string; tilesChangedOwner: number; stationChangesThisMinute: number; fingerprint: string | null }
export interface BoardUpdate { tick: number; kind: 'award' | 'control' | 'priority'; scores: Record<Side, number>; controllers: Record<string, Side | null>; priorityId: string; award: Record<Side, { stations: number; priority: number; reserve: number; total: number }> | null }
export interface DecisionRecord {
  tick: number; side: Side; controller: ObjectiveController; category: ObjectiveCategory | 'none'; source: DecisionSource | null; objectiveId: string | null; intent: Record<string, unknown> | null; reason: string;
  /** Submission outcome and, once executed, the canonical input key and what the engine observer reported for it. */
  admitted: boolean | null; rejectedAtTick: boolean; key: string | null; observed: { tick: number; status: string }[];
}
export interface SideActivity {
  controller: ObjectiveController; decisions: Record<ObjectiveCategory | 'none', number>; sources: Record<DecisionSource, number>; byObjective: Record<string, number>;
  ordersSubmitted: number; rejectedAtSubmission: number; rejectedAtTick: number; decisionMs: Percentiles;
  transports: { ordered: number; launched: number; landed: number; returned: number; notLaunched: number; unconfirmed: number; landingsOnNewLandmass: number; landingsOnStationLandmass: number; firstLaunchTick: number | null; firstLandingTick: number | null };
  construction: { ordered: number; started: number; completed: number; interrupted: number; notStarted: number };
  guardedPulses: number; nearMissHolds: number; reserveBonusTallies: number; peakTiles: number; tilesGainedFromNeutral: number; tilesGainedFromOpponent: number;
}
export interface ReconstructionCheck { tick: number; sourceFingerprint: string; fingerprintMatched: boolean; boardMatched: boolean; decisionsMatched: Record<Side, boolean | null> }
export interface ObjectiveRunResult {
  matchup: ObjectiveMatchup; simulationId: string; description: string; controllers: Record<Side, ObjectiveController>; scenario: { id: string; map: string; spawn: Record<Side, [number, number]> };
  spawns: Record<Side, { tile: number; x: number; y: number }>; geography: ReturnType<typeof deploymentGeography>; stationLandmasses: Record<string, { landmass: number; size: number; blueSpawnLandmass: boolean; redSpawnLandmass: boolean }>;
  capTicks: number; ticksSimulated: number; simulatedMinutes: number; firstContactTick: number | null; eliminationTick: number | null; eliminated: Side | null;
  outcome: ReturnType<typeof networkOutcome>; finalControllers: Record<string, Side | null>; tallies: number; controlChanges: number; priorityChanges: number; stationOwnershipChanges: { tick: number; station: string; from: Side | null; to: Side | null }[];
  minutesWithOwnershipChange: number; noChangeTailMinutes: number; noStationChangeTailMinutes: number;
  activity: Record<Side, SideActivity>; samples: MinuteSample[]; boardUpdates: BoardUpdate[]; decisions: DecisionRecord[];
  reconstruction: { checks: ReconstructionCheck[]; officialRestore: { tick: number; matched: boolean; ms: number } | null; ms: number };
  wallClock: { runMs: number; rawTickMs: number; controllerMsTotal: number };
  record: EngineRecord;
}
export interface RunOptions { capTicks?: number; simulationId?: string; verifyReconstruction?: boolean; sampleEvery?: number; checkpointEvery?: number }

const emptyDecisions = (): SideActivity['decisions'] => ({ expansion: 0, attack: 0, reserve: 0, construction: 0, upgrade: 0, transport: 0, recall: 0, none: 0 });
const sides: Side[] = ['blue', 'red'];

/** Simulate one matchup to elimination or the objective time limit, mirroring the service's admission, cadence, board and end condition. */
export async function runObjectiveMatchup(matchup: ObjectiveMatchup, options: RunOptions = {}): Promise<ObjectiveRunResult> {
  const spec = OBJECTIVE_MATCHUPS[matchup];
  const capTicks = options.capTicks ?? NETWORK_RULES.limitTicks, simulationId = options.simulationId ?? OBJECTIVE_SEEDS[0], sampleEvery = options.sampleEvery ?? TICKS_PER_SIMULATED_MINUTE, checkpointEvery = options.checkpointEvery ?? CHECKPOINT_EVERY;
  const feedbackByKey = new Map<string, { tick: number; status: string }[]>();
  const e = await ReplayEngine.create({ simulationId, map: OBJECTIVE_SCENARIO.map }, { feedback: { listener: (ev: ExecutionFeedbackEvent) => { const l = feedbackByKey.get(ev.keyString) ?? []; l.push({ tick: ev.tick, status: ev.status }); feedbackByKey.set(ev.keyString, l); } } });
  const g = e.game, n = g.width() * g.height(), lm = landmasses(g), layout = createNetworkLayout(e);
  const spawnTiles: Record<Side, number> = { blue: spawnTarget(g, ...OBJECTIVE_SCENARIO.spawn.blue), red: spawnTarget(g, ...OBJECTIVE_SCENARIO.spawn.red) };
  const spawns = { blue: { tile: spawnTiles.blue, x: g.x(spawnTiles.blue), y: g.y(spawnTiles.blue) }, red: { tile: spawnTiles.red, x: g.x(spawnTiles.red), y: g.y(spawnTiles.red) } };
  const stationLandmasses = Object.fromEntries(layout.map((s) => { const c = lm.label[s.tile]!; return [s.id, { landmass: c, size: lm.sizes[c]!, blueSpawnLandmass: c === lm.label[spawnTiles.blue], redSpawnLandmass: c === lm.label[spawnTiles.red] }]; }));
  const first = e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawnTiles.blue } }, { side: 'red', intent: { type: 'spawn', tile: spawnTiles.red } }]);
  e.fingerprints[first.tick] = first.fingerprint;
  let state: NetworkState = initialNetwork(g.ticks()); let view: NetworkView | null = null;
  const smallID: Record<Side, number> = { blue: e.player('blue').smallID(), red: e.player('red').smallID() };
  const controllers: Record<Side, ObjectiveController> = { blue: spec.blue, red: spec.red };
  const activity: Record<Side, SideActivity> = { blue: null!, red: null! }; const decisionMs: Record<Side, number[]> = { blue: [], red: [] };
  for (const s of sides) activity[s] = { controller: controllers[s], decisions: emptyDecisions(), sources: { 'objectives/1': 0, 'maneuver/1': 0, none: 0 }, byObjective: {}, ordersSubmitted: 0, rejectedAtSubmission: 0, rejectedAtTick: 0, decisionMs: percentiles([]), transports: { ordered: 0, launched: 0, landed: 0, returned: 0, notLaunched: 0, unconfirmed: 0, landingsOnNewLandmass: 0, landingsOnStationLandmass: 0, firstLaunchTick: null, firstLandingTick: null }, construction: { ordered: 0, started: 0, completed: 0, interrupted: 0, notStarted: 0 }, guardedPulses: 0, nearMissHolds: 0, reserveBonusTallies: 0, peakTiles: 0, tilesGainedFromNeutral: 0, tilesGainedFromOpponent: 0 };
  const decisions: DecisionRecord[] = []; const boardUpdates: BoardUpdate[] = []; const stationOwnershipChanges: ObjectiveRunResult['stationOwnershipChanges'] = [];
  let pending: { side: Side; intent: unknown; rec: DecisionRecord }[] = [];
  let geography: ReturnType<typeof deploymentGeography> | null = null; let firstContactTick: number | null = null, eliminationTick: number | null = null, eliminated: Side | null = null;
  const owners = new Int32Array(n); for (let i = 0; i < n; i++) owners[i] = g.ownerID(i);
  const samples: MinuteSample[] = []; let minutesWithOwnershipChange = 0, controllerMsTotal = 0, stationChangesThisMinute = 0;
  const reachedLandmasses: Record<Side, Set<number>> = { blue: new Set(), red: new Set() };
  const stationLandmassSet = new Set(layout.map((s) => lm.label[s.tile]!));
  const ownedLandmasses = (s: Side) => { const set = new Set<number>(); for (const t of e.player(s).borderTiles()) set.add(lm.label[t]!); return set; };
  const minuteGain: Record<Side, { neutral: number; opponent: number }> = { blue: { neutral: 0, opponent: 0 }, red: { neutral: 0, opponent: 0 } };
  const diffOwners = () => { let changed = 0; for (let i = 0; i < n; i++) { const o = g.ownerID(i); if (o === owners[i]) continue; changed++; for (const s of sides) if (o === smallID[s]) { if (owners[i] === 0) { minuteGain[s].neutral++; activity[s].tilesGainedFromNeutral++; } else { minuteGain[s].opponent++; activity[s].tilesGainedFromOpponent++; } } owners[i] = o; } return changed; };
  const sideMinute = (s: Side, v: NetworkView): SideMinute => { const p = e.player(s); const st = { City: 0, 'Defense Post': 0, Port: 0 } as SideMinute['structures']; for (const u of p.units(UnitType.City, UnitType.DefensePost, UnitType.Port)) if (u.isActive() && !u.isUnderConstruction()) st[u.type() as keyof typeof st]++; minuteGain[s] = { neutral: 0, opponent: 0 }; return { tiles: p.numTilesOwned(), troops: Math.round(p.troops()), maxTroops: Math.round(g.config().maxTroops(p)), reserveRatio: +v.reserve[s].fraction.toFixed(3), reserveEligible: v.reserve[s].eligible, gold: Number(p.gold()), attacks: p.outgoingAttacks().length, alive: p.isAlive(), structures: st, transportsAtSea: p.unitCount(UnitType.TransportShip), landmasses: p.isAlive() ? ownedLandmasses(s).size : 0, controlled: v.stations.filter((x) => x.controller === s).map((x) => x.id), score: v.scores[s] }; };
  const sample = (v: NetworkView, final = false) => {
    const changed = diffOwners(); if (changed > 0) minutesWithOwnershipChange++;
    if (final && e.fingerprints[g.ticks()] === undefined) e.fingerprints[g.ticks()] = e.state().fingerprint;
    samples.push({ tick: g.ticks(), simulatedMinute: +(g.ticks() / TICKS_PER_SIMULATED_MINUTE).toFixed(2), blue: sideMinute('blue', v), red: sideMinute('red', v), priorityId: v.priorityId, tilesChangedOwner: changed, stationChangesThisMinute, fingerprint: e.fingerprints[g.ticks()] ?? null }); stationChangesThisMinute = 0;
  };
  const decide = (s: Side, tick: number, v: NetworkView) => {
    const t0 = performance.now();
    const a: ObjectiveAssessment | ReturnType<typeof maneuverAssess> = controllers[s] === OBJECTIVE_CONTROLLER ? objectiveAssess(e, s, v) : maneuverAssess(e, s);
    const ms = performance.now() - t0; decisionMs[s].push(ms); controllerMsTotal += ms;
    const rec: DecisionRecord = { tick, side: s, controller: controllers[s], category: a.category, source: 'source' in a ? a.source : null, objectiveId: 'objectiveId' in a ? a.objectiveId : null, intent: a.intent, reason: a.reason, admitted: null, rejectedAtTick: false, key: null, observed: [] };
    decisions.push(rec); activity[s].decisions[a.category]++;
    if ('source' in a) { activity[s].sources[a.source]++; if (a.objectiveId) activity[s].byObjective[a.objectiveId] = (activity[s].byObjective[a.objectiveId] ?? 0) + 1; if (a.observed.guardActive) activity[s].guardedPulses++; if (a.category === 'reserve' && /just under/.test(a.reason)) activity[s].nearMissHolds++; }
    if (!a.intent) return;
    // GameService.command validates at submission; a rejection is swallowed by the scripted side and counted.
    try { e.validate(s, a.intent); rec.admitted = true; pending.push({ side: s, intent: a.intent, rec }); activity[s].ordersSubmitted++; } catch { rec.admitted = false; activity[s].rejectedAtSubmission++; }
  };
  const t0 = performance.now(); let ticks = 0; let outcome: ReturnType<typeof networkOutcome> = null;
  while (g.ticks() < capTicks) {
    // The server validates queued orders again at tick time and drops any that no longer apply.
    const admitted = pending.filter((o) => { try { e.validate(o.side, o.intent); return true; } catch { o.rec.rejectedAtTick = true; activity[o.side].rejectedAtTick++; return false; } }); pending = [];
    const turnNumber = e.turns.length;
    admitted.forEach((o, intentIndex) => { o.rec.key = inputKeyString({ turnNumber, intentIndex, clientID: CLIENTS[o.side] }); });
    rawStep(e, admitted.map((o) => ({ side: o.side, intent: o.intent }))); ticks++;
    const tick = g.ticks(); const bp = e.player('blue'), rp = e.player('red');
    const adv = advanceNetwork(e, layout, state);
    if (adv.changed) {
      for (const s of adv.view.stations) if (state.controllers[s.id] !== s.controller) { stationOwnershipChanges.push({ tick, station: s.id, from: state.controllers[s.id] ?? null, to: s.controller }); stationChangesThisMinute++; }
      const kind: BoardUpdate['kind'] = adv.award ? 'award' : adv.view.priorityId !== state.priorityId ? 'priority' : 'control';
      boardUpdates.push({ tick, kind, scores: { ...adv.state.scores }, controllers: { ...adv.state.controllers }, priorityId: adv.state.priorityId, award: adv.award });
      if (adv.award) for (const s of sides) if (adv.award[s].reserve > 0) activity[s].reserveBonusTallies++;
    }
    state = adv.state; view = adv.view;
    if (geography === null && bp.numTilesOwned() > 0 && rp.numTilesOwned() > 0) geography = deploymentGeography(e);
    for (const s of sides) activity[s].peakTiles = Math.max(activity[s].peakTiles, e.player(s).numTilesOwned());
    if (firstContactTick === null && bp.sharesBorderWith(rp)) firstContactTick = tick;
    // Source fingerprints at the declared checkpoints, captured during original execution (the reconstruction compares against these).
    if (tick % checkpointEvery === 0) e.fingerprints[tick] = e.state().fingerprint;
    if (tick % sampleEvery === 0) sample(view);
    // GameService.tick end condition: elimination or the objective time limit; elimination is never suspended.
    outcome = !g.inSpawnPhase() && tick > 50 ? networkOutcome(state, { blue: bp.isAlive(), red: rp.isAlive() }) : null;
    if (outcome) { if (outcome.reason === 'elimination') { eliminationTick = tick; eliminated = !bp.isAlive() ? 'blue' : 'red'; } if (tick % sampleEvery !== 0) sample(view, true); break; }
    if (tick % OBJECTIVE_INTERVAL_TICKS === 0) for (const s of sides) decide(s, tick, view);
  }
  if (e.fingerprints[g.ticks()] === undefined) e.fingerprints[g.ticks()] = e.state().fingerprint;
  const runMs = performance.now() - t0;
  if (view && g.ticks() % sampleEvery !== 0 && !outcome) sample(view, true);
  // Attach what the engine observer reported for each admitted order.
  for (const d of decisions) {
    if (!d.key) continue; d.observed = feedbackByKey.get(d.key) ?? [];
    const a = activity[d.side]; const st = new Set(d.observed.map((o) => o.status));
    if (d.intent?.type === 'boat') { a.transports.ordered++; if (st.has('transport-launched')) { a.transports.launched++; a.transports.firstLaunchTick ??= d.tick; } if (st.has('transport-landed')) { a.transports.landed++; a.transports.firstLandingTick ??= d.observed.find((o) => o.status === 'transport-landed')!.tick; const c = lm.label[Number(d.intent.dst)]!; if (!reachedLandmasses[d.side].has(c)) { reachedLandmasses[d.side].add(c); a.transports.landingsOnNewLandmass++; } if (stationLandmassSet.has(c)) a.transports.landingsOnStationLandmass++; } if (st.has('transport-forces-returned')) a.transports.returned++; if (st.has('transport-not-launched')) a.transports.notLaunched++; if (st.has('transport-ended-unconfirmed')) a.transports.unconfirmed++; }
    if (d.intent?.type === 'build_unit') { a.construction.ordered++; if (st.has('construction-started')) a.construction.started++; if (st.has('construction-completed')) a.construction.completed++; if (st.has('construction-interrupted')) a.construction.interrupted++; if (st.has('construction-not-started')) a.construction.notStarted++; }
  }
  for (const s of sides) activity[s].decisionMs = percentiles(decisionMs[s]);
  let noChangeTailMinutes = 0; for (let i = samples.length - 1; i >= 0 && samples[i]!.tilesChangedOwner === 0; i--) noChangeTailMinutes++;
  let noStationChangeTailMinutes = 0; for (let i = samples.length - 1; i >= 0 && samples[i]!.stationChangesThisMinute === 0; i--) noStationChangeTailMinutes++;
  const record = e.record();
  const reconstruction = options.verifyReconstruction === false ? { checks: [], officialRestore: null, ms: 0 } : await reconstruct(record, controllers, decisions, boardUpdates, checkpointEvery);
  if (geography === null) throw new Error('Deployment never executed');
  return { matchup, simulationId, description: spec.description, controllers, scenario: { id: OBJECTIVE_SCENARIO.id, map: OBJECTIVE_SCENARIO.map, spawn: OBJECTIVE_SCENARIO.spawn }, spawns, geography, stationLandmasses, capTicks, ticksSimulated: g.ticks(), simulatedMinutes: +(g.ticks() / TICKS_PER_SIMULATED_MINUTE).toFixed(2), firstContactTick, eliminationTick, eliminated, outcome: outcome ?? networkOutcome(state, { blue: e.player('blue').isAlive(), red: e.player('red').isAlive() }), finalControllers: { ...state.controllers }, tallies: boardUpdates.filter((u) => u.kind === 'award').length, controlChanges: stationOwnershipChanges.length, priorityChanges: boardUpdates.filter((u) => u.kind === 'priority').length, stationOwnershipChanges, minutesWithOwnershipChange, noChangeTailMinutes, noStationChangeTailMinutes, activity, samples, boardUpdates, decisions, reconstruction, wallClock: { runMs: Math.round(runMs), rawTickMs: +(runMs / Math.max(1, ticks)).toFixed(4), controllerMsTotal: Math.round(controllerMsTotal) }, record };
}

/**
 * Independent reconstruction: a fresh engine re-executes the record turn by turn with its own board, and
 * at every checkpoint its fingerprint is compared with the SOURCE run's recorded fingerprint (captured
 * during original execution, not recomputed here), its board with the source's last board update, and
 * for each objectives/1 side its decision with the source's decision at that tick. The official
 * `ReplayEngine.restore` path is exercised once at the final tick.
 */
export async function reconstruct(record: EngineRecord, controllers: Record<Side, ObjectiveController>, decisions: DecisionRecord[], boardUpdates: BoardUpdate[], checkpointEvery = CHECKPOINT_EVERY) {
  const t0 = performance.now();
  const e = await ReplayEngine.create(record.options, { observeExecution: false }); const layout = createNetworkLayout(e);
  let state: NetworkState | null = null; const checks: ReconstructionCheck[] = []; const finalTick = record.turns.length;
  for (const turn of record.turns) {
    rawStep(e, turn.intents.map((intent) => ({ side: intent.clientID === CLIENTS.blue ? 'blue' : 'red', intent })));
    const tick = e.game.ticks(); if (tick === 1) { state = initialNetwork(1); continue; }
    const adv = advanceNetwork(e, layout, state!); state = adv.state;
    if (tick % checkpointEvery !== 0 && tick !== finalTick) continue;
    const source = record.fingerprints[tick]; if (!source) throw new Error(`No source fingerprint at checkpoint ${tick}`);
    const fingerprintMatched = e.state().fingerprint === source;
    const lastUpdate = [...boardUpdates].reverse().find((u) => u.tick <= tick);
    const boardMatched = !lastUpdate || (JSON.stringify(lastUpdate.scores) === JSON.stringify(state.scores) && JSON.stringify(lastUpdate.controllers) === JSON.stringify(state.controllers));
    const decisionsMatched: Record<Side, boolean | null> = { blue: null, red: null };
    for (const s of sides) {
      if (controllers[s] !== OBJECTIVE_CONTROLLER) continue;
      const src = decisions.find((d) => d.tick === tick && d.side === s); if (!src) continue;
      const again = objectiveAssess(e, s, adv.view);
      decisionsMatched[s] = again.category === src.category && again.reason === src.reason && again.objectiveId === src.objectiveId && JSON.stringify(again.intent) === JSON.stringify(src.intent);
    }
    checks.push({ tick, sourceFingerprint: source, fingerprintMatched, boardMatched, decisionsMatched });
  }
  const s0 = performance.now(); const restored = await ReplayEngine.restore(record, finalTick, 'checkpoints');
  const officialRestore = { tick: finalTick, matched: restored.state().fingerprint === record.fingerprints[finalTick], ms: Math.round(performance.now() - s0) };
  return { checks, officialRestore, ms: Math.round(performance.now() - t0) };
}

/** Evidence form: the record is reduced to what identifies it; decisions keep their observed receipts. */
export function summarizeObjectiveRun(r: ObjectiveRunResult) {
  const { record, ...rest } = r;
  return { ...rest, record: { turns: record.turns.length, upstreamCommit: record.upstreamCommit, simulationProfile: record.simulationProfile, options: record.options, sampledFingerprints: Object.keys(record.fingerprints).length, navalOrders: ReplayEngine.navalIntentCount(record) } };
}

/** One line per run for logs and the notes. */
export function briefObjectiveRun(r: ObjectiveRunResult): string {
  const side = (s: Side) => { const a = r.activity[s]; return `${s}=${a.controller === OBJECTIVE_CONTROLLER ? 'objectives' : 'maneuver'}[score ${r.outcome?.scores[s] ?? '?'}, peak ${a.peakTiles}, neutral+${a.tilesGainedFromNeutral} opp+${a.tilesGainedFromOpponent}, boats ${a.transports.ordered}/launched ${a.transports.launched}/landed ${a.transports.landed}/station-lm ${a.transports.landingsOnStationLandmass}, built ${a.construction.completed}/${a.construction.ordered}, rej ${a.rejectedAtSubmission}+${a.rejectedAtTick}, guarded ${a.guardedPulses}, reserve-tallies ${a.reserveBonusTallies}, p95 ${a.decisionMs.p95}ms]`; };
  const rc = r.reconstruction.checks;
  return `${r.matchup} ${r.simulationId}: ${r.outcome?.reason ?? 'running'} winner=${r.outcome?.winner ?? '-'}${r.eliminated ? ` (${r.eliminated} eliminated at ${r.eliminationTick})` : ''} contact=${r.firstContactTick} simMin=${r.simulatedMinutes} tallies=${r.tallies} control-changes=${r.controlChanges} final=${Object.entries(r.finalControllers).map(([k, v]) => `${k}:${v ?? '-'}`).join(',')} tail=${r.noChangeTailMinutes}/${r.noStationChangeTailMinutes} recon=${rc.length ? rc.map((c) => (c.fingerprintMatched && c.boardMatched && Object.values(c.decisionsMatched).every((x) => x !== false) ? 'ok' : 'MISMATCH')).join('/') : 'skipped'} wall=${r.wallClock.runMs}ms ${side('blue')} ${side('red')}`;
}

/** Fresh artifact only: an existing file is never overwritten or merged. */
export function writeObjectiveEvidence(data: Record<string, unknown>, file = OBJECTIVE_EVIDENCE_FILE): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`Preserve the previous characterization at ${file}; choose a new artifact revision`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); return file;
}

export function objectiveEvidenceHeader() {
  return { at: new Date().toISOString(), schema: 'replay.objective-controller-characterization/1', method: 'Accelerated deterministic simulation of the pinned engine: objectives/1 versus and beside the maneuver/1 reference on the recorded crosscurrent-network/1 layout under stations-and-reserves/1; no human input, no wall-clock pacing, no model calls.', controller: OBJECTIVE_CONTROLLER, reference: MANEUVER_CONTROLLER, controllerIntervalTicks: OBJECTIVE_INTERVAL_TICKS, referenceIntervalTicks: MANEUVER_INTERVAL_TICKS, rules: OBJECTIVE_RULES, objectiveRules: NETWORK_RULES, scenario: OBJECTIVE_SCENARIO.id, seeds: OBJECTIVE_SEEDS, capTicks: NETWORK_RULES.limitTicks, humanPlaytest: false, paidInference: 0, observationBasis: 'Transport and construction outcomes are the engine execution observer receipts keyed by canonical input; admission is not success. Reconstruction compares a fresh engine with the source run fingerprints recorded during original execution.', claim: 'Measured scripted engine behaviour. Points, station changes and elapsed minutes are game outcomes; they are not evidence of engagement, learning, optimal play or realistic opponent doctrine.' };
}

/** Full characterization: three matchups by every declared seed. `quick` reduces coverage to the first seed and says so. */
export async function characterizeObjectives(options: { seeds?: readonly string[]; capTicks?: number; onRun?: (r: ObjectiveRunResult) => void } = {}) {
  const seeds = options.seeds ?? OBJECTIVE_SEEDS; const runs = [];
  for (const simulationId of seeds) for (const matchup of Object.keys(OBJECTIVE_MATCHUPS) as ObjectiveMatchup[]) { const r = await runObjectiveMatchup(matchup, { simulationId, capTicks: options.capTicks }); options.onRun?.(r); runs.push(summarizeObjectiveRun(r)); }
  return { ...objectiveEvidenceHeader(), seeds, capTicks: options.capTicks ?? NETWORK_RULES.limitTicks, coverage: seeds.length < OBJECTIVE_SEEDS.length ? `reduced: ${seeds.length} of ${OBJECTIVE_SEEDS.length} declared seeds` : 'full', runs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {}; console.warn = () => {};
  const args = process.argv.slice(2); const quick = args.includes('--quick'); const outIx = args.indexOf('--out'); const out = outIx >= 0 ? path.resolve(args[outIx + 1] ?? '') : OBJECTIVE_EVIDENCE_FILE;
  if (fs.existsSync(out)) throw new Error(`Preserve the previous characterization at ${out}; choose a new artifact revision`);
  const result = await characterizeObjectives({ seeds: quick ? [OBJECTIVE_SEEDS[0]] : OBJECTIVE_SEEDS, onRun: (r) => console.error(briefObjectiveRun(r)) });
  const file = writeObjectiveEvidence(result, out);
  console.log(JSON.stringify({ file, coverage: result.coverage, runs: result.runs.map((r) => ({ matchup: r.matchup, simulationId: r.simulationId, outcome: r.outcome, eliminated: r.eliminated, eliminationTick: r.eliminationTick, firstContactTick: r.firstContactTick, simulatedMinutes: r.simulatedMinutes, finalControllers: r.finalControllers, reconstruction: r.reconstruction.checks.map((c) => ({ tick: c.tick, fingerprintMatched: c.fingerprintMatched, boardMatched: c.boardMatched, decisionsMatched: c.decisionsMatched })) })) }, null, 2));
}
