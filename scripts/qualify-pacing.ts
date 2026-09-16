/**
 * Pacing characterization harness for the pinned engine.
 *
 * Everything here is accelerated deterministic simulation. Ticks are simulated time (one tick is
 * 100 ms of game time, 600 ticks is one simulated minute); wall-clock numbers are reported only in
 * the `wallClock` sections and describe this machine, not the exercise. No run here is evidence of
 * human pacing or learning.
 *
 * The opponent rule is a line-for-line mirror of `GameService.baseline` and the spawn placement of
 * `GameService.create` (src/server/service.ts), so measured contact and elimination ticks describe
 * what the live server would do with the same option. Orders are admitted through
 * `ReplayEngine.validate` and executed through the engine's own `GameRunner` turn path; the only
 * difference from `ReplayEngine.step` is that the state fingerprint is sampled at declared checkpoints instead of every tick (its cost is measured separately, because on large maps it is the
 * dominant cost of a server tick).
 *
 * Tests import this module. Run directly (`tsx scripts/qualify-pacing.ts`) it writes the full
 * characterization to evidence/pacing/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CLIENTS, ReplayEngine, SIMULATION_PROFILE, UPSTREAM_COMMIT, type EngineMap, type EngineRecord, type Side } from '../src/engine/engine';
import { loadMap } from '../src/engine/maps';
import type { Game } from '../vendor/openfront/src/core/game/Game';
import type { StampedIntent, Turn } from '../vendor/openfront/src/core/Schemas';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVIDENCE_DIR = path.join(ROOT, 'evidence/pacing');
/** One engine tick represents 100 ms of game time; the live server advances one tick per 100 ms of wall clock. */
export const TICK_SIMULATED_MS = 100;
export const TICKS_PER_SIMULATED_MINUTE = 600;
export const SIXTY_SIMULATED_MINUTES = 60 * TICKS_PER_SIMULATED_MINUTE;
export const TIME_UNITS = { tick: `${TICK_SIMULATED_MS} ms simulated game time`, ticksPerSimulatedMinute: TICKS_PER_SIMULATED_MINUTE, serverWallClockPerTickMs: 100, note: 'Simulated ticks are not wall-clock. The live server schedules one tick per 100 ms and skips nothing, so a tick whose processing exceeds 100 ms wall-clock slows the exercise clock.' } as const;
/** Maps compared. `world` is the legacy 400x200 option every existing exercise uses. */
export const PACING_MAPS: EngineMap[] = ['world', 'world-500', 'world-1000', 'world-2000'];
/** GameService.baseline tunables, mirrored exactly. */
export const BASELINE = { intervalTicks: 45, troopFraction: 0.18, minTroops: 100 } as const;
export type Scenario = 'passive-blue' | 'scripted-blue' | 'scripted-blue-connected' | 'sea-separated-passive-blue';
export const SCENARIOS: Record<Scenario, string> = {
  'passive-blue': 'Blue deploys at the GameService position and never orders; red runs the deterministic baseline (a live exercise with an idle human).',
  'scripted-blue': 'Both sides run the deterministic baseline rule from the GameService positions (18% of forces every 45 ticks; the opponent once bordering, otherwise unclaimed land).',
  'scripted-blue-connected': 'Both sides run the baseline rule with blue deployed inland on the same landmass as red at every resolution (Anatolia), isolating map size from the strait artefact at the GameService position.',
  'sea-separated-passive-blue': 'Blue deploys in North America, red at its usual Asian position; shows what the boat-less baseline does when no land route exists.',
};
/** Spawn fractions. `passive-blue` and `scripted-blue` are exactly GameService.create: nearest passable land to (0.56w, 0.34h) and (0.72w, 0.34h). */
export const SPAWN_FRACTIONS: Record<Scenario, Record<Side, [number, number]>> = {
  'passive-blue': { blue: [0.56, 0.34], red: [0.72, 0.34] },
  'scripted-blue': { blue: [0.56, 0.34], red: [0.72, 0.34] },
  'scripted-blue-connected': { blue: [0.58, 0.28], red: [0.72, 0.34] },
  'sea-separated-passive-blue': { blue: [0.19, 0.27], red: [0.72, 0.34] },
};
/** How much of blue's actual deployment footprint shares a passable land component with red's. */
export type LandRoute = 'full' | 'partial' | 'none';

/** Exact copy of the spawn target search in GameService.create (nearest passable land to a fraction of the playfield). */
export function spawnTarget(g: Game, fx: number, fy: number): number {
  const x = Math.floor(g.width() * fx), y = Math.floor(g.height() * fy); let best = 0, dist = Infinity;
  for (let i = 0; i < g.width() * g.height(); i++) if (g.isLand(i) && !g.isImpassable(i)) {
    const d = (g.x(i) - x) ** 2 + (g.y(i) - y) ** 2; if (d < dist) { dist = d; best = i; }
  }
  return best;
}

/** Exact copy of the GameService.baseline decision for `side`; null when the baseline would stay silent. */
export function baselineOrder(e: ReplayEngine, side: Side): { type: 'attack'; targetID: string | null; troops: number } | null {
  const p = e.player(side); if (!p.isAlive() || p.troops() < BASELINE.minTroops) return null;
  const opponent = e.player(side === 'blue' ? 'red' : 'blue'); let targetID: string | null = null;
  if (p.canAttackPlayer(opponent) && p.sharesBorderWith(opponent)) targetID = opponent.id();
  return { type: 'attack', targetID, troops: Math.floor(p.troops() * BASELINE.troopFraction) };
}

/**
 * Every passable land tile reachable from `seeds` by 4-neighbour land moves: the land a boat-less
 * attacker can ever conquer. Returns a membership mask (1 = reachable).
 */
export function reachableLand(g: Game, seeds: Iterable<number>): Uint8Array {
  const w = g.width(), n = w * g.height(); const seen = new Uint8Array(n); const stack: number[] = [];
  const ok = (t: number) => g.isLand(t) && !g.isImpassable(t);
  for (const s of seeds) if (ok(s) && !seen[s]) { seen[s] = 1; stack.push(s); }
  while (stack.length) {
    const t = stack.pop()!; const x = t % w;
    for (const nb of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) if (nb >= 0 && nb < n && !seen[nb] && ok(nb)) { seen[nb] = 1; stack.push(nb); }
  }
  return seen;
}

/**
 * Deployment geography once both spawns have executed (tick 2). The engine's spawn footprint is
 * every land tile within Euclidean radius 4 of the chosen tile, water ignored, so a coastal
 * deployment can straddle a strait; only the part on red's landmass is ever reachable by the
 * boat-less baseline.
 */
export function deploymentGeography(e: ReplayEngine) {
  const g = e.game; const blue = [...e.player('blue').tiles()], red = [...e.player('red').tiles()];
  const fromRed = reachableLand(g, red); let reachable = 0; for (let i = 0; i < fromRed.length; i++) reachable += fromRed[i];
  const blueOnRedLandmass = blue.filter(t => fromRed[t] === 1).length;
  const landRoute: LandRoute = blueOnRedLandmass === 0 ? 'none' : blueOnRedLandmass === blue.length ? 'full' : 'partial';
  return { blueFootprintTiles: blue.length, redFootprintTiles: red.length, blueTilesOnRedLandmass: blueOnRedLandmass, landRoute, redReachableLandTiles: reachable };
}

/** sha256 over every tile's terrain classification; identical maps hash identically regardless of how they were loaded. */
export function terrainHash(g: Game): string {
  const n = g.width() * g.height(); const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (g.isLand(i) ? 128 : 0) | (g.isShoreline(i) ? 64 : 0) | (g.isOcean(i) ? 32 : 0) | (g.magnitude(i) & 31);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Admit `orders` exactly as `ReplayEngine.step` does and execute one engine tick without computing
 * the fingerprint. The turn is appended to the engine's own history so `record()`/`restore()` see it.
 */
export function rawStep(e: ReplayEngine, orders: { side: Side; intent: unknown }[] = []): void {
  const intents = orders.map(({ side, intent }) => ({ ...e.validate(side, intent), clientID: CLIENTS[side] }) as StampedIntent);
  const turn: Turn = { turnNumber: e.turns.length, intents };
  e.runner.addTurn(structuredClone(turn)); if (!e.runner.executeNextTick()) throw new Error('Engine rejected tick'); e.turns.push(turn);
}

export interface SideSample { tiles: number; troops: number; maxTroops: number; gold: number; attacks: number; alive: boolean }
export interface Sample { tick: number; simulatedMinute: number; blue: SideSample; red: SideSample; tilesChangedOwner: number; fingerprint: string | null }
export interface ScenarioResult {
  map: EngineMap; scenario: Scenario; simulationId: string; description: string;
  playfield: { width: number; height: number; landTiles: number };
  spawns: Record<Side, { tile: number; x: number; y: number }>; spawnSeparationTiles: number; spawnSeparationSourcePx: number;
  geography: ReturnType<typeof deploymentGeography>;
  capTicks: number; ticksSimulated: number; simulatedMinutes: number;
  firstContactTick: number | null; firstOpponentAttackTick: Record<Side, number | null>; eliminationTick: number | null; eliminated: Side | null;
  outcome: 'eliminated' | 'stalemate' | 'contested-at-cap';
  peakTiles: Record<Side, number>; minutesWithOwnershipChange: number; lastOwnershipChangeTick: number | null;
  samples: Sample[]; wallClock: { runMs: number; rawTickMs: number };
  record: EngineRecord;
}

export interface RunOptions { capTicks?: number; simulationId?: string; sampleEvery?: number; fingerprintEvery?: number }
/** Simulate one scenario to elimination or the tick cap, mirroring the server's order admission, baseline cadence and end condition. */
export async function runScenario(map: EngineMap, scenario: Scenario, options: RunOptions = {}): Promise<ScenarioResult> {
  const capTicks = options.capTicks ?? SIXTY_SIMULATED_MINUTES, simulationId = options.simulationId ?? 'PACE0001', sampleEvery = options.sampleEvery ?? TICKS_PER_SIMULATED_MINUTE, fingerprintEvery = options.fingerprintEvery ?? 5 * TICKS_PER_SIMULATED_MINUTE;
  const e = await ReplayEngine.create({ simulationId, map });
  const g = e.game; const n = g.width() * g.height();
  const fr = SPAWN_FRACTIONS[scenario];
  const spawnTiles: Record<Side, number> = { blue: spawnTarget(g, ...fr.blue), red: spawnTarget(g, ...fr.red) };
  const spawns = { blue: { tile: spawnTiles.blue, x: g.x(spawnTiles.blue), y: g.y(spawnTiles.blue) }, red: { tile: spawnTiles.red, x: g.x(spawnTiles.red), y: g.y(spawnTiles.red) } };
  let geography: ReturnType<typeof deploymentGeography> | null = null;
  // Tick 1 is the spawn turn, exactly as GameService.create issues it; the footprint exists from tick 2.
  const first = e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawnTiles.blue } }, { side: 'red', intent: { type: 'spawn', tile: spawnTiles.red } }]);
  const scripted: Side[] = scenario.startsWith('scripted-') ? ['blue', 'red'] : ['red'];
  let baselineAt: Record<Side, number> = { blue: 0, red: 0 };
  let pending: { side: Side; intent: unknown }[] = [];
  let firstContactTick: number | null = null, eliminationTick: number | null = null, eliminated: Side | null = null;
  const firstOpponentAttackTick: Record<Side, number | null> = { blue: null, red: null };
  const peakTiles: Record<Side, number> = { blue: 0, red: 0 };
  const owners = new Int32Array(n); for (let i = 0; i < n; i++) owners[i] = g.ownerID(i);
  e.fingerprints[first.tick] = first.fingerprint;
  const samples: Sample[] = []; let minutesWithOwnershipChange = 0, lastOwnershipChangeTick: number | null = null;
  const side = (s: Side): SideSample => { const p = e.player(s); return { tiles: p.numTilesOwned(), troops: Math.round(p.troops()), maxTroops: Math.round(g.config().maxTroops(p)), gold: Number(p.gold()), attacks: p.outgoingAttacks().length, alive: p.isAlive() }; };
  const sample = (final = false) => {
    let changed = 0; for (let i = 0; i < n; i++) { const o = g.ownerID(i); if (o !== owners[i]) { changed++; owners[i] = o; } }
    if (changed > 0) { minutesWithOwnershipChange++; lastOwnershipChangeTick = g.ticks(); }
    // The fingerprint is O(tiles) and is the expensive part; keep it sparse so large maps stay within budget.
    let fingerprint: string | null = null;
    if (final || g.ticks() % fingerprintEvery === 0) { const st = e.state(); fingerprint = st.fingerprint; e.fingerprints[st.tick] = fingerprint; }
    samples.push({ tick: g.ticks(), simulatedMinute: +(g.ticks() / TICKS_PER_SIMULATED_MINUTE).toFixed(2), blue: side('blue'), red: side('red'), tilesChangedOwner: changed, fingerprint });
  };
  const t0 = performance.now(); let ticks = 0;
  while (g.ticks() < capTicks) {
    // The server validates queued orders again at tick time and drops any that no longer apply.
    const admitted = pending.filter(o => { try { e.validate(o.side, o.intent); return true; } catch { return false; } }); pending = [];
    rawStep(e, admitted); ticks++;
    // Independent source references for the short benchmark seeks, captured during original execution.
    if(g.ticks()===50||g.ticks()===600)e.fingerprints[g.ticks()]=e.state().fingerprint;
    const tick = g.ticks(); const bp = e.player('blue'), rp = e.player('red');
    if (geography === null && bp.numTilesOwned() > 0 && rp.numTilesOwned() > 0) geography = deploymentGeography(e);
    for (const s of ['blue', 'red'] as Side[]) peakTiles[s] = Math.max(peakTiles[s], e.player(s).numTilesOwned());
    if (firstContactTick === null && bp.sharesBorderWith(rp)) firstContactTick = tick;
    if (tick % sampleEvery === 0) sample();
    // GameService.tick end condition.
    if (!g.inSpawnPhase() && tick > 50 && (!bp.isAlive() || !rp.isAlive())) { eliminationTick = tick; eliminated = !bp.isAlive() ? 'blue' : 'red'; if (tick % sampleEvery !== 0) sample(true); break; }
    for (const s of scripted) if (tick - baselineAt[s] >= BASELINE.intervalTicks) {
      baselineAt[s] = tick; const order = baselineOrder(e, s); if (!order) continue;
      // GameService.command validates at submission and the baseline swallows a rejection.
      try { e.validate(s, order); pending.push({ side: s, intent: order }); if (order.targetID !== null && firstOpponentAttackTick[s] === null) firstOpponentAttackTick[s] = tick; } catch { /* mirrored: silently not queued */ }
    }
  }
  if(e.fingerprints[g.ticks()]===undefined)e.fingerprints[g.ticks()]=e.state().fingerprint;
  const runMs = performance.now() - t0;
  if (g.ticks() % sampleEvery !== 0 && eliminationTick === null) sample(true);
  const quiet = 10; const tail = samples.slice(-quiet);
  const outcome: ScenarioResult['outcome'] = eliminationTick !== null ? 'eliminated' : (samples.length >= quiet && tail.every(s => s.tilesChangedOwner === 0)) ? 'stalemate' : 'contested-at-cap';
  const { map: _m, mini: _mini, derivation } = await loadMap(ROOT, map);
  if (geography === null) throw new Error('Deployment never executed');
  const separation = Math.hypot(spawns.blue.x - spawns.red.x, spawns.blue.y - spawns.red.y);
  return { map, scenario, simulationId, description: SCENARIOS[scenario], playfield: { width: derivation.width, height: derivation.height, landTiles: derivation.landTiles }, spawns, spawnSeparationTiles: Math.round(separation), spawnSeparationSourcePx: Math.round(separation * 2000 / derivation.width), geography, capTicks, ticksSimulated: g.ticks(), simulatedMinutes: +(g.ticks() / TICKS_PER_SIMULATED_MINUTE).toFixed(2), firstContactTick, firstOpponentAttackTick, eliminationTick, eliminated, outcome, peakTiles, minutesWithOwnershipChange, lastOwnershipChangeTick, samples, wallClock: { runMs: Math.round(runMs), rawTickMs: +(runMs / Math.max(1, ticks)).toFixed(4) }, record: e.record() };
}

export interface TimingResult {
  map: EngineMap; playfield: { width: number; height: number; landTiles: number; tiles: number }; derivation: string; terrainHash: string; sourceHash: string;
  wallClock: { createMs: number; spawnSearchMs: number; fingerprintedStepMs: number; rawTickMs: number; stateSnapshotMs: number; seeks: { tick: number; verification: 'checkpoints' | 'every-tick'; ms: number; matched: boolean }[] };
  serverTickBudgetShare: number;
}
/** Wall-clock costs of the server's actual per-tick path (`ReplayEngine.step` with fingerprint) and of seeking through a record. */
export async function measureTiming(map: EngineMap, record: EngineRecord, seekTicks: number[], everyTickSeek = 50): Promise<TimingResult> {
  const t0 = performance.now(); const e = await ReplayEngine.create({ simulationId: 'PACE0001', map }); const createMs = performance.now() - t0;
  const t1 = performance.now(); const b = spawnTarget(e.game, 0.56, 0.34), r = spawnTarget(e.game, 0.72, 0.34); const spawnSearchMs = performance.now() - t1;
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: b } }, { side: 'red', intent: { type: 'spawn', tile: r } }]);
  for (let i = 0; i < 100; i++) rawStep(e);
  const t2 = performance.now(); for (let i = 0; i < 20; i++) rawStep(e); const rawTickMs = (performance.now() - t2) / 20;
  const t3 = performance.now(); for (let i = 0; i < 20; i++) e.step(); const fingerprintedStepMs = (performance.now() - t3) / 20;
  const t4 = performance.now(); e.state(true); const stateSnapshotMs = performance.now() - t4;
  const seeks: TimingResult['wallClock']['seeks'] = [];
  for (const tick of [...new Set(seekTicks.filter(t => t <= record.turns.length))]) {
    if(!record.fingerprints[tick])throw new Error(`No source fingerprint at benchmark tick ${tick}`);
    const s = performance.now(); const restored = await ReplayEngine.restore(record, tick, 'checkpoints'); const ms = performance.now() - s;
    seeks.push({ tick, verification: 'checkpoints', ms: Math.round(ms), matched: restored.state().fingerprint === record.fingerprints[tick] });
  }
  const everyAt=Math.min(everyTickSeek,record.turns.length);
  if(!record.fingerprints[everyAt])throw new Error(`No source fingerprint at benchmark tick ${everyAt}`);
  const s = performance.now(); const every = await ReplayEngine.restore(record,everyAt,'every-tick');
  seeks.push({tick:everyAt,verification:'every-tick',ms:Math.round(performance.now()-s),matched:every.state().fingerprint===record.fingerprints[everyAt]});
  const { derivation, sourceHash } = await loadMap(ROOT, map);
  return { map, playfield: { width: derivation.width, height: derivation.height, landTiles: derivation.landTiles, tiles: derivation.width * derivation.height }, derivation: derivation.source, terrainHash: terrainHash(e.game), sourceHash, wallClock: { createMs: +createMs.toFixed(1), spawnSearchMs: +spawnSearchMs.toFixed(1), fingerprintedStepMs: +fingerprintedStepMs.toFixed(2), rawTickMs: +rawTickMs.toFixed(3), stateSnapshotMs: +stateSnapshotMs.toFixed(2), seeks }, serverTickBudgetShare: +(fingerprintedStepMs / TIME_UNITS.serverWallClockPerTickMs).toFixed(2) };
}

/** Strip the full record (which can be megabytes) for the evidence file, keeping what identifies it. */
export function summarize(r: ScenarioResult) {
  const { record, ...rest } = r;
  return { ...rest, record: { turns: record.turns.length, upstreamCommit: record.upstreamCommit, simulationProfile: record.simulationProfile, options: record.options, sampledFingerprints: Object.keys(record.fingerprints).length } };
}

export function writeEvidence(name: string, data: unknown): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true }); const file = path.join(EVIDENCE_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); return file;
}

export function evidenceHeader(method: string) {
  return { at: new Date().toISOString(), method, upstreamCommit: UPSTREAM_COMMIT, simulationProfile: SIMULATION_PROFILE, timeUnits: TIME_UNITS, baseline: BASELINE, humanPlaytest: false, paidInference: 0, claim: 'Measured engine behaviour under deterministic scripted activity. Not evidence of human pacing, engagement or learning.' };
}

/** Full characterization: every map, every scenario, two seeds for the two main scenarios, plus timing. */
export async function characterize(maps: EngineMap[] = PACING_MAPS, capTicks = SIXTY_SIMULATED_MINUTES) {
  const runs = [], timings = [];
  for (const map of maps) {
    let scriptedRecord: EngineRecord | null = null;
    for (const scenario of Object.keys(SCENARIOS) as Scenario[]) for (const simulationId of scenario === 'sea-separated-passive-blue' ? ['PACE0001'] : ['PACE0001', 'PACE0002']) {
      const r = await runScenario(map, scenario, { capTicks, simulationId }); runs.push(summarize(r));
      if (scenario === 'scripted-blue' && simulationId === 'PACE0001') scriptedRecord = r.record;
    }
    timings.push(await measureTiming(map, scriptedRecord!, [TICKS_PER_SIMULATED_MINUTE, 10 * TICKS_PER_SIMULATED_MINUTE, scriptedRecord!.turns.length]));
  }
  return { ...evidenceHeader('Accelerated deterministic simulation of the pinned engine with the GameService spawn and baseline rules mirrored; no human input, no wall-clock pacing.'), maps: timings, runs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {};
  const result = await characterize();
  const file = writeEvidence('characterization', result);
  console.log(JSON.stringify({ file, maps: result.maps.map(m => ({ map: m.map, fingerprintedStepMs: m.wallClock.fingerprintedStepMs })), runs: result.runs.map(r => ({ map: r.map, scenario: r.scenario, simulationId: r.simulationId, outcome: r.outcome, firstContactTick: r.firstContactTick, eliminationTick: r.eliminationTick, simulatedMinutes: r.simulatedMinutes })) }, null, 2));
}
