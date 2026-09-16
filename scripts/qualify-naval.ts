/**
 * Naval qualification: real transports on the pinned `ocean_and_land` fixture, per-game stagger
 * isolation, interleaved/restored/branched fingerprint identity, admission parity and legacy-record
 * fingerprint checks. Writes evidence/naval/qualification.json. No network, no model calls.
 *
 *   python3 scripts/run_logged.py qualify-naval -- pnpm exec tsx scripts/qualify-naval.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ReplayEngine, SIMULATION_PROFILE, UPSTREAM_COMMIT, type EngineRecord, type Side } from '../src/engine/engine';
import { listNavalOptions } from '../src/agents/tools';
import { TransportShipExecution, transportStaggerCount } from '../vendor/openfront/src/core/execution/TransportShipExecution';
import { UnitType } from '../vendor/openfront/src/core/game/Game';

console.debug = () => {}; console.warn = () => {};
const started = performance.now();
const W = 16; const T = (x: number, y: number) => y * W + x;
const ISLAND_SHORE = T(14, 7);
const boat = (side: Side, dst: number, troops: number) => ({ side, intent: { type: 'boat', dst, troops } });
async function fixture(simulationId = 'NAVAL001') {
  const e = await ReplayEngine.create({ simulationId, map: 'ocean_and_land' });
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: T(5, 3) } }, { side: 'red', intent: { type: 'spawn', tile: T(5, 12) } }]);
  for (let i = 0; i < 5; i++) e.step();
  return e;
}
const boats = (e: ReplayEngine, side: Side = 'blue') => e.player(side).units(UnitType.TransportShip).map((b) => ({ id: b.id(), x: e.game.x(b.tile()), y: e.game.y(b.tile()), troops: b.troops(), retreating: b.transportShipState().isRetreating }));

// 1. Launch, move, land, attack.
const voyage = await fixture();
voyage.step([boat('blue', ISLAND_SHORE, 40)]);
const trace: { tick: number; x: number; y: number }[] = [];
let landedTick: number | null = null;
for (let i = 0; i < 30 && landedTick === null; i++) { const b = boats(voyage)[0]; if (!b) { landedTick = voyage.game.ticks(); break; } trace.push({ tick: voyage.game.ticks(), x: b.x, y: b.y }); voyage.step(); }
assert.equal(landedTick, 18);
assert.equal(voyage.game.ownerID(ISLAND_SHORE), voyage.player('blue').smallID());
assert.equal(voyage.player('blue').outgoingAttacks().length, 1);

// 2. Recall: retreat flag, deletion at own shore, 75% of forces returned.
const control = await fixture(), recalled = await fixture();
for (const e of [control, recalled]) { e.step([boat('blue', ISLAND_SHORE, 40)]); for (let i = 0; i < 3; i++) e.step(); }
recalled.step([{ side: 'blue', intent: { type: 'cancel_boat', unitID: boats(recalled)[0]!.id } }]); control.step();
let gain = 0, returnedTick: number | null = null;
for (let i = 0; i < 20 && returnedTick === null; i++) { const r0 = recalled.player('blue').troops(), c0 = control.player('blue').troops(); recalled.step(); control.step(); if (!boats(recalled).length) { returnedTick = recalled.game.ticks(); gain = (recalled.player('blue').troops() - r0) - (control.player('blue').troops() - c0); } }
assert.equal(Math.round(gain), 30);

// 3. Per-game stagger counter.
assert.equal('_staggerCounter' in TransportShipExecution, false);
const g1 = await fixture(); g1.step([boat('blue', ISLAND_SHORE, 10)]); g1.step([boat('red', ISLAND_SHORE, 10)]);
const g2 = await fixture();
assert.equal(transportStaggerCount(g1.game), 2); assert.equal(transportStaggerCount(g2.game), 0);

// 4. Interleaved games, reconstruction, branch.
const script = (e: ReplayEngine, t: number) => {
  if (t === 0) e.step([boat('blue', ISLAND_SHORE, 40), boat('red', ISLAND_SHORE, 25)]);
  else if (t === 4) e.step([boat('blue', T(15, 7), 15)]);
  else if (t === 9) e.step([{ side: 'red', intent: { type: 'cancel_boat', unitID: boats(e, 'red')[0]!.id } }]);
  else e.step();
};
const solo = await fixture(); for (let t = 0; t < 40; t++) script(solo, t); const reference = solo.record();
const noisy = await fixture('NOISE001'), a = await fixture(), b = await fixture(); let noiseLaunches = 0;
const noise = (side: Side) => { try { noisy.step([boat(side, ISLAND_SHORE, 5)]); noiseLaunches++; } catch { noisy.step(); } };
for (let i = 0; i < 3; i++) noise('blue');
for (let t = 0; t < 40; t++) { script(a, t); noise(t % 2 ? 'blue' : 'red'); script(b, t); }
assert.deepEqual(a.fingerprints, reference.fingerprints); assert.deepEqual(b.fingerprints, reference.fingerprints);
const restored = await ReplayEngine.restore(reference); assert.equal(restored.state().fingerprint, reference.fingerprints[restored.game.ticks()]);
const midTick = 14; const same = await ReplayEngine.restore(reference, midTick), other = await ReplayEngine.restore(reference, midTick);
for (const turn of reference.turns.slice(midTick)) same.step(turn.intents.map(({ clientID, ...intent }) => ({ side: clientID === 'human001' ? 'blue' as Side : 'red' as Side, intent })));
assert.deepEqual(same.fingerprints, reference.fingerprints);
other.step([{ side: 'blue', intent: { type: 'cancel_boat', unitID: boats(other)[0]!.id } }]); for (let i = 0; i < 10; i++) other.step();
assert.notEqual(other.state().fingerprint, reference.fingerprints[other.game.ticks()]);
for (const e of [solo, a, b, noisy, restored, same, other]) assert.equal(e.game.waterGraphVersion(), 0);

// 5. Admission parity and sampled options.
const adm = await fixture();
const refusals: Record<string, string> = {};
for (const [label, intent] of Object.entries({ ownTerritory: { type: 'boat', dst: T(5, 3), troops: 10 }, water: { type: 'boat', dst: T(9, 9), troops: 10 }, immuneOpponent: { type: 'boat', dst: T(5, 12), troops: 10 }, zeroForces: { type: 'boat', dst: ISLAND_SHORE, troops: 0 } })) { try { adm.validate('blue', intent); refusals[label] = 'ACCEPTED'; } catch (e) { refusals[label] = (e as Error).message; } }
assert.ok(Object.values(refusals).every((r) => r !== 'ACCEPTED'));
const ctx = { exerciseId: 'q', side: 'blue' as Side, engine: adm, reports: () => [], events: () => [] };
const options = listNavalOptions(ctx);
assert.equal(options.status, 'available'); for (const l of options.landings) adm.validate('blue', l.intent);
for (let i = 0; i < 3; i++) adm.step([boat('blue', ISLAND_SHORE, 5)]);
const limited = listNavalOptions(ctx); assert.equal(limited.status, 'unavailable');

// 6. Legacy records: profile handling and on-disk fingerprints (POC record; live sqlite when present).
const { simulationProfile: _p, ...legacy } = solo.record();
const legacyRestored = await ReplayEngine.restore(legacy as EngineRecord); assert.equal(legacyRestored.state().fingerprint, solo.state().fingerprint);
await assert.rejects(ReplayEngine.restore({ ...reference, simulationProfile: 'other/0' }), /Simulation profile/);
const legacyChecks: { source: string; turns: number; navalIntents: number; matched: boolean; ms: number }[] = [];
const check = async (source: string, rec: EngineRecord) => { const t0 = performance.now(); const r = await ReplayEngine.restore(rec, rec.turns.length, rec.turns.length <= 1000 ? 'every-tick' : 'checkpoints'); const matched = r.state().fingerprint === rec.fingerprints[rec.turns.length]; assert.ok(matched); legacyChecks.push({ source, turns: rec.turns.length, navalIntents: ReplayEngine.navalIntentCount(rec), matched, ms: Math.round(performance.now() - t0) }); };
if (fs.existsSync('evidence/poc/engine-record.json')) await check('evidence/poc/engine-record.json', JSON.parse(fs.readFileSync('evidence/poc/engine-record.json', 'utf8')));
if (fs.existsSync('data/replay.sqlite')) {
  const db = new DatabaseSync('data/replay.sqlite', { readOnly: true });
  for (const row of db.prepare('SELECT body FROM exercises').all() as { body: string }[]) {
    const ex = JSON.parse(row.body) as { id: string; options: EngineRecord['options'] };
    const turns = db.prepare('SELECT tick, body, fingerprint FROM turns WHERE exercise_id=? ORDER BY tick').all(ex.id) as { tick: number; body: string; fingerprint: string }[];
    if (!turns.length) continue;
    await check(`data/replay.sqlite:${ex.id}`, { version: 1, upstreamCommit: UPSTREAM_COMMIT, options: ex.options, turns: turns.map((t) => JSON.parse(t.body)), fingerprints: Object.fromEntries(turns.map((t) => [t.tick, t.fingerprint])) });
  }
  db.close();
}

fs.mkdirSync('evidence/naval', { recursive: true });
const report = {
  stage: 'naval_isolation', status: 'passed', at: new Date().toISOString(), upstreamCommit: UPSTREAM_COMMIT, simulationProfile: SIMULATION_PROFILE, map: 'ocean_and_land (pinned 16x16 OpenFront test fixture; abstract grid)',
  voyage: { launchedAt: trace[0], landedTick, tilesPerTick: 1, trace },
  recall: { returnedTick, forcesReturned: Math.round(gain), of: 40, penaltyPercent: 25 },
  staggerCounter: { processGlobalStaticPresent: '_staggerCounter' in TransportShipExecution, perGameCounts: { first: transportStaggerCount(g1.game), second: transportStaggerCount(g2.game) } },
  isolation: { referenceTurns: reference.turns.length, navalIntents: ReplayEngine.navalIntentCount(reference), interleavedGamesIdentical: 2, noiseLaunchesInSiblingGame: noiseLaunches, fullReplayMatched: true, branchContinuationMatched: true, alternateBranchDiverged: true, waterGraphVersionAlways: 0 },
  admission: { refusals, sampledLandings: options.landings.map((l) => ({ dst: l.intent.dst, landing: l.landing, target: l.target, distanceFromCoast: l.distanceFromCoast })), landingsConsidered: options.landingsConsidered, sampling: options.sampling, atLimit: limited.reason },
  legacyRecords: legacyChecks,
  durationMs: Math.round(performance.now() - started), modelRequests: 0,
};
fs.writeFileSync('evidence/naval/qualification.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
