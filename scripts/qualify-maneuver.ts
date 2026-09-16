/**
 * Maneuver characterization: the legacy baseline and `maneuver/1` compared on identical map, seed,
 * spawn and victory rules. Everything is accelerated deterministic simulation in simulated ticks
 * (600 per simulated minute); wall-clock figures describe this machine only. No human plays, no
 * model is called, elimination is never suspended, and nothing here is evidence of pacing quality.
 *
 * Mechanics reused from scripts/qualify-pacing.ts: GameService spawn placement, the mirrored legacy
 * rule, `rawStep` admission through `ReplayEngine.validate` and the engine's own turn path, and the
 * independent restore check (fingerprints sampled during original execution, a fresh engine
 * re-executes the record and must reproduce them).
 *
 * Tests import this module and do not write evidence unless opted in. Run directly
 * (`pnpm exec tsx scripts/qualify-maneuver.ts`) it writes evidence/pacing/maneuver-characterization.json,
 * keeping any earlier content of that file under `previous`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayEngine, type EngineMap, type EngineRecord, type Side } from '../src/engine/engine';
import { MANEUVER_CONTROLLER, MANEUVER_INTERVAL_TICKS, MANEUVER_RULES, landmasses, maneuverAssess, type ManeuverCategory } from '../src/agents/scripted-controller';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import { BASELINE, EVIDENCE_DIR, ROOT, SPAWN_FRACTIONS, TICKS_PER_SIMULATED_MINUTE, baselineOrder, deploymentGeography, evidenceHeader, rawStep, spawnTarget } from './qualify-pacing';
import { loadMap } from '../src/engine/maps';

export const THIRTY_SIMULATED_MINUTES = 30 * TICKS_PER_SIMULATED_MINUTE;
export type Controller = 'legacy' | typeof MANEUVER_CONTROLLER;
export type Matchup = 'legacy-vs-legacy' | 'maneuver-vs-legacy' | 'legacy-vs-maneuver' | 'maneuver-vs-maneuver' | 'sea-separated-maneuver-vs-maneuver' | 'sea-separated-legacy-vs-legacy';
export interface MatchupSpec { blue: Controller; red: Controller; spawn: 'default' | 'sea-separated' | 'connected'; description: string }
export const MATCHUPS: Record<Matchup, MatchupSpec> = {
  'legacy-vs-legacy': { blue: 'legacy', red: 'legacy', spawn: 'default', description: 'Both sides run the mirrored GameService baseline from the GameService positions; the existing reference.' },
  'maneuver-vs-legacy': { blue: MANEUVER_CONTROLLER, red: 'legacy', spawn: 'default', description: 'Blue runs maneuver/1, red the legacy baseline, same positions.' },
  'legacy-vs-maneuver': { blue: 'legacy', red: MANEUVER_CONTROLLER, spawn: 'default', description: 'Sides swapped: red runs maneuver/1 from the red position, blue the legacy baseline.' },
  'maneuver-vs-maneuver': { blue: MANEUVER_CONTROLLER, red: MANEUVER_CONTROLLER, spawn: 'default', description: 'Both sides run maneuver/1 from the GameService positions.' },
  'sea-separated-maneuver-vs-maneuver': { blue: MANEUVER_CONTROLLER, red: MANEUVER_CONTROLLER, spawn: 'sea-separated', description: 'Both sides run maneuver/1 with blue deployed in the western landmass (the sea-separated pacing deployment), red at its usual position.' },
  'sea-separated-legacy-vs-legacy': { blue: 'legacy', red: 'legacy', spawn: 'sea-separated', description: 'Reference for the sea-separated deployment under the boat-less legacy rule on both sides.' },
};
/** `world-1000` is included because the legacy pair stalemates there (existing evidence) and the comparison is informative. */
export const MANEUVER_MAPS: EngineMap[] = ['world', 'world-500', 'world-1000'];
const spawnFractions = (spawn: MatchupSpec['spawn']) => SPAWN_FRACTIONS[spawn === 'default' ? 'scripted-blue' : spawn === 'connected' ? 'scripted-blue-connected' : 'sea-separated-passive-blue'];

export interface Percentiles { n: number; p50: number; p95: number; max: number; mean: number }
export function percentiles(values: number[]): Percentiles {
  if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b); const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, p50: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3), max: +s[s.length - 1]!.toFixed(3), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3) };
}

export interface SideMinute { tiles: number; troops: number; maxTroops: number; gold: number; attacks: number; alive: boolean; structures: Record<'City' | 'Defense Post' | 'Port', number>; transportsAtSea: number; landmasses: number; gainedFromNeutral: number; gainedFromOpponent: number }
export interface MinuteSample { tick: number; simulatedMinute: number; blue: SideMinute; red: SideMinute; tilesChangedOwner: number; fingerprint: string | null }
export interface TransportRecord { side: Side; id: number; launchTick: number; troops: number; from: number; target: number; targetLandmass: number; moves: number; endTick: number | null; ended: 'landed' | 'ended-without-confirmed-landing' | 'at-sea-at-end' | null; landingTile: number | null; newLandmass: boolean }
export interface SideActivity {
  controller: Controller; decisions: Record<ManeuverCategory | 'none', number>; ordersSubmitted: number; rejectedAtSubmission: number; rejectedAtTick: number;
  firstOpponentAttackTick: number | null; firstTransportLaunchTick: number | null; firstLandingTick: number | null; landmassesReached: number;
  constructionCompletions: { tick: number; type: string; level: number }[]; upgradesCompleted: number; transports: TransportRecord[];
  decisionMs: Percentiles; peakTiles: number; tilesGainedFromNeutral: number; tilesGainedFromOpponent: number;
}
export interface ManeuverRunResult {
  map: EngineMap; matchup: Matchup; deployment:MatchupSpec['spawn']; simulationId: string; description: string; controllers: Record<Side, Controller>;
  playfield: { width: number; height: number; landTiles: number }; spawns: Record<Side, { tile: number; x: number; y: number }>; geography: ReturnType<typeof deploymentGeography>;
  capTicks: number; ticksSimulated: number; simulatedMinutes: number; firstContactTick: number | null; eliminationTick: number | null; eliminated: Side | null;
  outcome: 'eliminated' | 'stalemate' | 'contested-at-cap'; minutesWithOwnershipChange: number; lastOwnershipChangeTick: number | null; noChangeTailMinutes: number;
  activity: Record<Side, SideActivity>; samples: MinuteSample[];
  restore: { tick: number; verification: 'checkpoints'; matched: boolean; ms: number }[];
  wallClock: { runMs: number; rawTickMs: number; controllerMsTotal: number };
  record: EngineRecord;
}
export interface RunOptions { deployment?:MatchupSpec['spawn']; capTicks?: number; simulationId?: string; sampleEvery?: number; fingerprintEvery?: number; verifyRestore?: boolean }

const emptyDecisions = (): SideActivity['decisions'] => ({ expansion: 0, attack: 0, reserve: 0, construction: 0, upgrade: 0, transport: 0, recall: 0, none: 0 });

/** Simulate one matchup to elimination or the tick cap, mirroring the server's admission, cadence and end condition. */
export async function runMatchup(map: EngineMap, matchup: Matchup, options: RunOptions = {}): Promise<ManeuverRunResult> {
  const spec = MATCHUPS[matchup];
  const capTicks = options.capTicks ?? THIRTY_SIMULATED_MINUTES, simulationId = options.simulationId ?? 'MANV0001', sampleEvery = options.sampleEvery ?? TICKS_PER_SIMULATED_MINUTE, fingerprintEvery = options.fingerprintEvery ?? 5 * TICKS_PER_SIMULATED_MINUTE;
  const e = await ReplayEngine.create({ simulationId, map }); const g = e.game; const n = g.width() * g.height();
  const deployment=options.deployment??spec.spawn;
  const fr = spawnFractions(deployment);
  const spawnTiles: Record<Side, number> = { blue: spawnTarget(g, ...fr.blue), red: spawnTarget(g, ...fr.red) };
  const spawns = { blue: { tile: spawnTiles.blue, x: g.x(spawnTiles.blue), y: g.y(spawnTiles.blue) }, red: { tile: spawnTiles.red, x: g.x(spawnTiles.red), y: g.y(spawnTiles.red) } };
  const first = e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawnTiles.blue } }, { side: 'red', intent: { type: 'spawn', tile: spawnTiles.red } }]);
  e.fingerprints[first.tick] = first.fingerprint;
  const lm = landmasses(g); const sides: Side[] = ['blue', 'red']; const smallID: Record<Side, number> = { blue: e.player('blue').smallID(), red: e.player('red').smallID() };
  const controllers: Record<Side, Controller> = { blue: spec.blue, red: spec.red };
  const activity: Record<Side, SideActivity> = { blue: null!, red: null! }; const decisionMs: Record<Side, number[]> = { blue: [], red: [] };
  for (const s of sides) activity[s] = { controller: controllers[s], decisions: emptyDecisions(), ordersSubmitted: 0, rejectedAtSubmission: 0, rejectedAtTick: 0, firstOpponentAttackTick: null, firstTransportLaunchTick: null, firstLandingTick: null, landmassesReached: 0, constructionCompletions: [], upgradesCompleted: 0, transports: [], decisionMs: percentiles([]), peakTiles: 0, tilesGainedFromNeutral: 0, tilesGainedFromOpponent: 0 };
  let geography: ReturnType<typeof deploymentGeography> | null = null;
  let pending: { side: Side; intent: unknown }[] = []; const lastPulse: Record<Side, number> = { blue: 0, red: 0 };
  let firstContactTick: number | null = null, eliminationTick: number | null = null, eliminated: Side | null = null;
  const owners = new Int32Array(n); for (let i = 0; i < n; i++) owners[i] = g.ownerID(i);
  const samples: MinuteSample[] = []; let minutesWithOwnershipChange = 0, lastOwnershipChangeTick: number | null = null; let controllerMsTotal = 0;
  // Per-tick trackers (O(units)): structures by id to catch completions/upgrades, transports by id to trace voyages.
  const knownStructures = new Map<number, { level: number; underConstruction: boolean }>();
  const liveTransports = new Map<number, { rec: TransportRecord; lastTile: number; retreating: boolean }>();
  const ownedLandmasses = (s: Side) => { const set = new Set<number>(); for (const t of e.player(s).borderTiles()) set.add(lm.label[t]!); return set; };
  const reachedLandmasses: Record<Side, Set<number>> = { blue: new Set(), red: new Set() };
  const minuteGain: Record<Side, { neutral: number; opponent: number }> = { blue: { neutral: 0, opponent: 0 }, red: { neutral: 0, opponent: 0 } };
  const trackUnits = (tick: number) => {
    for (const s of sides) {
      const p = e.player(s);
      for (const u of p.units(UnitType.City, UnitType.DefensePost, UnitType.Port)) {
        if (!u.isActive()) continue; const k = knownStructures.get(u.id()); const uc = u.isUnderConstruction();
        if (!k) { knownStructures.set(u.id(), { level: u.level(), underConstruction: uc }); if (!uc) activity[s].constructionCompletions.push({ tick, type: u.type(), level: u.level() }); }
        else { if (k.underConstruction && !uc) activity[s].constructionCompletions.push({ tick, type: u.type(), level: u.level() }); if (!uc && u.level() > k.level) activity[s].upgradesCompleted++; k.level = u.level(); k.underConstruction = uc; }
      }
      const seen = new Set<number>();
      for (const u of p.units(UnitType.TransportShip)) {
        if (!u.isActive()) continue; seen.add(u.id()); const live = liveTransports.get(u.id());
        if (!live) {
          const target = u.targetTile() ?? u.tile(); const rec: TransportRecord = { side: s, id: u.id(), launchTick: tick, troops: Math.round(u.troops()), from: u.tile(), target, targetLandmass: lm.label[target] ?? -1, moves: 0, endTick: null, ended: null, landingTile: null, newLandmass: false };
          activity[s].transports.push(rec); liveTransports.set(u.id(), { rec, lastTile: u.tile(), retreating: u.transportShipState().isRetreating }); activity[s].firstTransportLaunchTick ??= tick;
        } else { if (u.tile() !== live.lastTile) { live.rec.moves++; live.lastTile = u.tile(); } live.retreating = u.transportShipState().isRetreating; }
      }
      for (const [id, live] of liveTransports) if (live.rec.side === s && !seen.has(id)) {
        liveTransports.delete(id); live.rec.endTick = tick;
        const landed = !live.retreating && g.ownerID(live.rec.target) === smallID[s];
        live.rec.ended = landed ? 'landed' : 'ended-without-confirmed-landing'; live.rec.landingTile = landed ? live.rec.target : null;
        if (landed) { activity[s].firstLandingTick ??= tick; const before = reachedLandmasses[s]; if (!before.has(live.rec.targetLandmass)) { live.rec.newLandmass = true; before.add(live.rec.targetLandmass); } }
      }
    }
  };
  for (const s of sides) for (const c of ownedLandmasses(s)) reachedLandmasses[s].add(c);
  const sideMinute = (s: Side): SideMinute => { const p = e.player(s); const st = { City: 0, 'Defense Post': 0, Port: 0 } as SideMinute['structures']; for (const u of p.units(UnitType.City, UnitType.DefensePost, UnitType.Port)) if (u.isActive() && !u.isUnderConstruction()) st[u.type() as keyof typeof st]++; const gain = minuteGain[s]; minuteGain[s] = { neutral: 0, opponent: 0 }; return { tiles: p.numTilesOwned(), troops: Math.round(p.troops()), maxTroops: Math.round(g.config().maxTroops(p)), gold: Number(p.gold()), attacks: p.outgoingAttacks().length, alive: p.isAlive(), structures: st, transportsAtSea: p.unitCount(UnitType.TransportShip), landmasses: p.isAlive() ? ownedLandmasses(s).size : 0, gainedFromNeutral: gain.neutral, gainedFromOpponent: gain.opponent }; };
  const diffOwners = () => {
    let changed = 0;
    for (let i = 0; i < n; i++) { const o = g.ownerID(i); if (o === owners[i]) continue; changed++; for (const s of sides) if (o === smallID[s]) { if (owners[i] === 0) { minuteGain[s].neutral++; activity[s].tilesGainedFromNeutral++; } else { minuteGain[s].opponent++; activity[s].tilesGainedFromOpponent++; } } owners[i] = o; }
    return changed;
  };
  const sample = (final = false) => {
    const changed = diffOwners(); if (changed > 0) { minutesWithOwnershipChange++; lastOwnershipChangeTick = g.ticks(); }
    let fingerprint: string | null = null;
    if (final || g.ticks() % fingerprintEvery === 0) { const st = e.state(); fingerprint = st.fingerprint; e.fingerprints[st.tick] = fingerprint; }
    samples.push({ tick: g.ticks(), simulatedMinute: +(g.ticks() / TICKS_PER_SIMULATED_MINUTE).toFixed(2), blue: sideMinute('blue'), red: sideMinute('red'), tilesChangedOwner: changed, fingerprint });
  };
  const decide = (s: Side, tick: number) => {
    const c = controllers[s];
    if (c === 'legacy') {
      const order = baselineOrder(e, s); if (!order) { activity[s].decisions.none++; return; }
      activity[s].decisions[order.targetID === null ? 'expansion' : 'attack']++;
      try { e.validate(s, order); pending.push({ side: s, intent: order }); activity[s].ordersSubmitted++; if (order.targetID !== null) activity[s].firstOpponentAttackTick ??= tick; } catch { activity[s].rejectedAtSubmission++; }
      return;
    }
    const t0 = performance.now(); const a = maneuverAssess(e, s); const ms = performance.now() - t0; decisionMs[s].push(ms); controllerMsTotal += ms;
    activity[s].decisions[a.category]++; if (!a.intent) return;
    // GameService.command validates at submission; a rejection is swallowed by the scripted side and counted here.
    try { e.validate(s, a.intent); pending.push({ side: s, intent: a.intent }); activity[s].ordersSubmitted++; if (a.category === 'attack') activity[s].firstOpponentAttackTick ??= tick; } catch { activity[s].rejectedAtSubmission++; }
  };
  const t0 = performance.now(); let ticks = 0;
  while (g.ticks() < capTicks) {
    // The server validates queued orders again at tick time and drops any that no longer apply.
    const admitted = pending.filter((o) => { try { e.validate(o.side, o.intent); return true; } catch { activity[o.side].rejectedAtTick++; return false; } }); pending = [];
    rawStep(e, admitted); ticks++;
    const tick = g.ticks(); const bp = e.player('blue'), rp = e.player('red');
    trackUnits(tick);
    if (geography === null && bp.numTilesOwned() > 0 && rp.numTilesOwned() > 0) geography = deploymentGeography(e);
    for (const s of sides) activity[s].peakTiles = Math.max(activity[s].peakTiles, e.player(s).numTilesOwned());
    if (firstContactTick === null && bp.sharesBorderWith(rp)) firstContactTick = tick;
    if (tick % sampleEvery === 0) sample();
    // GameService.tick end condition: elimination is never suspended.
    if (!g.inSpawnPhase() && tick > 50 && (!bp.isAlive() || !rp.isAlive())) { eliminationTick = tick; eliminated = !bp.isAlive() ? 'blue' : 'red'; if (tick % sampleEvery !== 0) sample(true); break; }
    for (const s of sides) if (tick - lastPulse[s] >= (controllers[s] === 'legacy' ? BASELINE.intervalTicks : MANEUVER_INTERVAL_TICKS)) { lastPulse[s] = tick; decide(s, tick); }
  }
  if (e.fingerprints[g.ticks()] === undefined) e.fingerprints[g.ticks()] = e.state().fingerprint;
  const runMs = performance.now() - t0;
  if (g.ticks() % sampleEvery !== 0 && eliminationTick === null) sample(true);
  for (const [, live] of liveTransports) { live.rec.ended = 'at-sea-at-end'; live.rec.endTick = g.ticks(); }
  for (const s of sides) { activity[s].decisionMs = percentiles(decisionMs[s]); activity[s].landmassesReached = activity[s].transports.filter((t) => t.newLandmass).length; }
  let noChangeTailMinutes = 0; for (let i = samples.length - 1; i >= 0 && samples[i]!.tilesChangedOwner === 0; i--) noChangeTailMinutes++;
  const quiet = 10;
  const outcome: ManeuverRunResult['outcome'] = eliminationTick !== null ? 'eliminated' : samples.length >= quiet && noChangeTailMinutes >= quiet ? 'stalemate' : 'contested-at-cap';
  const record = e.record();
  // Independent verification: a fresh engine re-executes the record and must reproduce the fingerprints captured above.
  const restore: ManeuverRunResult['restore'] = [];
  if (options.verifyRestore !== false) {
    const firstFp = samples.find((s) => s.fingerprint !== null)?.tick; const at = [...new Set([firstFp, g.ticks()].filter((t): t is number => t !== undefined))];
    for (const tick of at) { if (!record.fingerprints[tick]) throw new Error(`No source fingerprint at tick ${tick}`); const s0 = performance.now(); const r = await ReplayEngine.restore(record, tick, 'checkpoints'); restore.push({ tick, verification: 'checkpoints', matched: r.state().fingerprint === record.fingerprints[tick], ms: Math.round(performance.now() - s0) }); }
  }
  const { derivation } = await loadMap(ROOT, map);
  if (geography === null) throw new Error('Deployment never executed');
  return { map, matchup, deployment, simulationId, description: spec.description, controllers, playfield: { width: derivation.width, height: derivation.height, landTiles: derivation.landTiles }, spawns, geography, capTicks, ticksSimulated: g.ticks(), simulatedMinutes: +(g.ticks() / TICKS_PER_SIMULATED_MINUTE).toFixed(2), firstContactTick, eliminationTick, eliminated, outcome, minutesWithOwnershipChange, lastOwnershipChangeTick, noChangeTailMinutes, activity, samples, restore, wallClock: { runMs: Math.round(runMs), rawTickMs: +(runMs / Math.max(1, ticks)).toFixed(4), controllerMsTotal: Math.round(controllerMsTotal) }, record };
}

/** Evidence form: the record is reduced to what identifies it; transports are kept because they are the landing evidence. */
export function summarizeRun(r: ManeuverRunResult) {
  const { record, ...rest } = r;
  return { ...rest, record: { turns: record.turns.length, upstreamCommit: record.upstreamCommit, simulationProfile: record.simulationProfile, options: record.options, sampledFingerprints: Object.keys(record.fingerprints).length, navalOrders: ReplayEngine.navalIntentCount(record) } };
}

/** One line per run for logs and the notes. */
export function brief(r: ManeuverRunResult): string {
  const side = (s: Side) => { const a = r.activity[s]; return `${s}=${a.controller === 'legacy' ? 'legacy' : 'maneuver'}[peak ${a.peakTiles}, neutral+${a.tilesGainedFromNeutral} opp+${a.tilesGainedFromOpponent}, built ${a.constructionCompletions.length}, upg ${a.upgradesCompleted}, boats ${a.transports.length}/landed ${a.transports.filter((t) => t.ended === 'landed').length}/new ${a.landmassesReached}, rej ${a.rejectedAtSubmission}+${a.rejectedAtTick}, dec p95 ${a.decisionMs.p95}ms]`; };
  return `${r.map} ${r.matchup} ${r.simulationId}: ${r.outcome}${r.eliminated ? ` (${r.eliminated} at tick ${r.eliminationTick})` : ''} contact=${r.firstContactTick} route=${r.geography.landRoute} simMin=${r.simulatedMinutes} changeMin=${r.minutesWithOwnershipChange} tail=${r.noChangeTailMinutes} restore=${r.restore.map((x) => (x.matched ? 'ok' : 'MISMATCH')).join('/')} wall=${r.wallClock.runMs}ms ${side('blue')} ${side('red')}`;
}

export const MANEUVER_EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'maneuver-characterization.json');
/** Write the artifact without discarding what was there: earlier content is retained under `previous`. */
export function writeManeuverEvidence(data: Record<string, unknown>, file = MANEUVER_EVIDENCE_FILE): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let previous: unknown[] = [];
  if (fs.existsSync(file)) { try { const old = JSON.parse(fs.readFileSync(file, 'utf8')); const { previous: olderStill, ...rest } = old; previous = [rest, ...(Array.isArray(olderStill) ? olderStill : [])]; } catch { throw new Error('Existing maneuver evidence is unreadable; refusing to overwrite it'); } }
  fs.writeFileSync(file, JSON.stringify({ ...data, previous }, null, 2) + '\n'); return file;
}

export function maneuverEvidenceHeader() {
  return { ...evidenceHeader('Accelerated deterministic simulation of the pinned engine: legacy GameService baseline versus maneuver/1 on identical map, seed, spawn and elimination rules; no human input, no wall-clock pacing, no model calls.'), controller: MANEUVER_CONTROLLER, controllerIntervalTicks: MANEUVER_INTERVAL_TICKS, rules: MANEUVER_RULES, capTicks: THIRTY_SIMULATED_MINUTES, transportCompletionBasis:'A landed label means the transport disappeared without a retreat flag and its target tile was owned by the launching side at that tick. Other disappearances are unconfirmed; refunds or causes are not inferred.', claim: 'Measured scripted engine behaviour. Not evidence of human pacing, engagement, learning, optimal play or realistic opponent doctrine.' };
}

/** Full characterization: every matchup on every map, one seed, plus a second seed for the mixed matchup. */
export async function characterizeManeuver(maps: EngineMap[] = MANEUVER_MAPS, capTicks = THIRTY_SIMULATED_MINUTES, onRun?: (r: ManeuverRunResult) => void) {
  const runs = [];
  for (const map of maps) for (const matchup of Object.keys(MATCHUPS) as Matchup[]) for (const simulationId of matchup === 'maneuver-vs-legacy' ? ['MANV0001', 'MANV0002'] : ['MANV0001']) {
    const r = await runMatchup(map, matchup, { capTicks, simulationId }); onRun?.(r); runs.push(summarizeRun(r));
  }
  return { ...maneuverEvidenceHeader(), maps, runs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {}; console.warn = () => {};
  const args=process.argv.slice(2);for(const a of args)if(!['world','world-500','world-1000','world-2000','plains','ocean_and_land'].includes(a))throw new Error('Unknown characterization map');
  const maps=args as EngineMap[];
  const result = await characterizeManeuver(maps.length ? maps : MANEUVER_MAPS, THIRTY_SIMULATED_MINUTES, (r) => console.error(brief(r)));
  const file = writeManeuverEvidence(result);
  console.log(JSON.stringify({ file, runs: result.runs.map((r) => ({ map: r.map, matchup: r.matchup, simulationId: r.simulationId, outcome: r.outcome, eliminated: r.eliminated, eliminationTick: r.eliminationTick, firstContactTick: r.firstContactTick, simulatedMinutes: r.simulatedMinutes, restore: r.restore })) }, null, 2));
}
