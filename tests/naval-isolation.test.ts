/**
 * Naval execution and replay isolation.
 *
 * Root cause under test: upstream TransportShipExecution kept its pathfinder rebuild stagger in a
 * process-global static, so every game in one process advanced the same counter. REPLAY hosts live
 * exercises, historical replays and branches in one process. These tests (1) run a real transport
 * (launch, move, land, recall) on a pinned map, (2) show the counter is now per game, (3) prove that
 * interleaved games, reconstruction and branches yield identical fingerprints, (4) exercise the only
 * code path where the stagger value is observable, and (5) check legacy records against fingerprints
 * instead of assuming compatibility.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { ReplayEngine, SIMULATION_PROFILE, UPSTREAM_COMMIT, type EngineRecord } from '../src/engine/engine';
import { TransportShipExecution, transportStaggerCount } from '../vendor/openfront/src/core/execution/TransportShipExecution';
import { WaterPathFinder } from '../vendor/openfront/src/core/pathfinding/PathFinder';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import { ISLAND_INTERIOR, ISLAND_SHORE, T, boat, navalEngine, navmeshGame, navmeshNoise, navmeshTrace, snapshot } from './naval-fixture';

console.debug = () => {}; console.warn = () => {};

describe('a real transport on the pinned ocean_and_land map', () => {
  it('launches from an owned shore, moves one tile per tick, lands on the island and opens an attack', async () => {
    const e = await navalEngine();
    expect(e.game.waterGraphVersion()).toBe(0);
    const before = snapshot(e);
    expect(before.boats).toEqual([]);
    e.step([boat('blue', ISLAND_SHORE, 40)]);
    const launched = snapshot(e);
    expect(launched.boats).toHaveLength(1);
    expect(launched.boats[0]).toMatchObject({ x: 7, troops: 40, retreating: false });
    expect(launched.troops).toBeLessThan(before.troops + 400); // forces left the reserve (income is ~340/tick here)
    let previous = launched.boats[0]!;
    let landedAt: number | null = null;
    for (let i = 0; i < 30; i++) {
      e.step();
      const s = snapshot(e);
      if (!s.boats.length) { landedAt = s.tick; break; }
      const b = s.boats[0]!;
      expect(Math.abs(b.x - previous.x) + Math.abs(b.y - previous.y)).toBe(1);
      expect(e.game.isWater(T(b.x, b.y)) || e.game.isShore(T(b.x, b.y))).toBe(true);
      previous = b;
    }
    expect(landedAt).toBe(18);
    expect(previous).toMatchObject({ x: 14, y: 7 });
    expect(e.game.ownerID(ISLAND_SHORE)).toBe(e.player('blue').smallID());
    expect(e.player('blue').outgoingAttacks()).toHaveLength(1);
    for (let i = 0; i < 40; i++) e.step();
    expect(e.game.ownerID(ISLAND_INTERIOR)).toBe(e.player('blue').smallID());
  });

  it('a recalled transport turns back, is deleted at its own shore and returns 75% of its forces', async () => {
    const control = await navalEngine(); const recalled = await navalEngine();
    for (const e of [control, recalled]) { e.step([boat('blue', ISLAND_SHORE, 40)]); for (let i = 0; i < 3; i++) e.step(); }
    const id = snapshot(recalled).boats[0]!.id;
    expect(() => recalled.validate('red', { type: 'cancel_boat', unitID: id })).toThrow(/owned by this player/);
    recalled.step([{ side: 'blue', intent: { type: 'cancel_boat', unitID: id } }]);
    control.step();
    expect(snapshot(recalled).boats[0]).toMatchObject({ retreating: false }); // new executions initialise this tick and act next tick
    recalled.step(); control.step();
    expect(snapshot(recalled).boats[0]).toMatchObject({ retreating: true });
    let returnedTick: number | null = null; let gain = 0;
    for (let i = 0; i < 20 && returnedTick === null; i++) {
      const r0 = snapshot(recalled).troops, c0 = snapshot(control).troops;
      recalled.step(); control.step();
      const boats = snapshot(recalled).boats;
      if (boats.length) { expect(boats[0]!.retreating).toBe(true); expect(boats[0]!.troops).toBe(40); continue; }
      returnedTick = recalled.game.ticks();
      // Reserve change over the deletion tick, net of the same tick's income in the otherwise identical twin.
      gain = (snapshot(recalled).troops - r0) - (snapshot(control).troops - c0);
    }
    expect(returnedTick).not.toBeNull();
    expect(Math.round(gain)).toBe(30); // 40 embarked, 25% retreat penalty
    expect(snapshot(recalled).tiles).toBe(44);
    expect(snapshot(recalled).attacks).toBe(0);
    expect(snapshot(recalled).fingerprint).not.toBe(snapshot(control).fingerprint);
  });
});

describe('stagger counter isolation', () => {
  it('the process-global static is gone; each game counts its own transports from zero', async () => {
    expect('_staggerCounter' in TransportShipExecution).toBe(false);
    const first = await navalEngine();
    expect(transportStaggerCount(first.game)).toBe(0);
    first.step([boat('blue', ISLAND_SHORE, 20)]);
    first.step([boat('red', ISLAND_SHORE, 20)]);
    expect(transportStaggerCount(first.game)).toBe(2);
    const second = await navalEngine();
    expect(transportStaggerCount(second.game)).toBe(0); // unaffected by the first game
    second.step([boat('blue', ISLAND_SHORE, 20)]);
    expect(transportStaggerCount(second.game)).toBe(1);
    expect(transportStaggerCount(first.game)).toBe(2);
  });

  it('interleaved games, reconstruction and branches with transports in flight fingerprint identically', async () => {
    const script = (e: ReplayEngine, t: number) => {
      if (t === 0) e.step([boat('blue', ISLAND_SHORE, 40), boat('red', ISLAND_SHORE, 25)]);
      else if (t === 4) e.step([boat('blue', ISLAND_INTERIOR, 15)]);
      else if (t === 9) e.step([{ side: 'red', intent: { type: 'cancel_boat', unitID: snapshot(e, 'red').boats[0]!.id } }]);
      else e.step();
    };
    const solo = await navalEngine();
    for (let t = 0; t < 40; t++) script(solo, t);
    const reference = solo.record();
    expect(ReplayEngine.navalIntentCount(reference)).toBe(4);
    expect(Object.keys(reference.fingerprints).length).toBeGreaterThan(40);

    // Same inputs, three games advanced in lockstep, one of which fires extra transports first.
    const noisy = await navalEngine({ simulationId: 'NOISE001' }); const a = await navalEngine(); const b = await navalEngine();
    let noiseLaunches = 0;
    // Launch whenever the validator allows (limit, ownership and immunity change as boats land); otherwise idle.
    const noise = (side: 'blue' | 'red') => { try { noisy.step([boat(side, ISLAND_SHORE, 5)]); noiseLaunches++; } catch (e) { if (!/Transport|attackable|territory/.test((e as Error).message)) throw e; noisy.step(); } };
    for (let i = 0; i < 3; i++) noise('blue');
    for (let t = 0; t < 40; t++) { script(a, t); noise(t % 2 ? 'blue' : 'red'); script(b, t); }
    expect(noiseLaunches).toBeGreaterThanOrEqual(5); // a shared counter would have been pushed past the reference game's values
    expect(transportStaggerCount(noisy.game)).toBe(noiseLaunches);
    expect(a.fingerprints).toEqual(reference.fingerprints);
    expect(b.fingerprints).toEqual(reference.fingerprints);
    for (const e of [a, b, noisy]) expect(e.game.waterGraphVersion()).toBe(0);

    // Full reconstruction with every tick verified, and a mid-voyage seek.
    const restored = await ReplayEngine.restore(reference);
    expect(restored.state().fingerprint).toBe(reference.fingerprints[restored.game.ticks()]);
    const midTick = 6 + 8; // spawn/settle plus eight voyage ticks: transports are at sea
    const seek = await ReplayEngine.restore(reference, midTick);
    expect(snapshot(seek).boats.length).toBeGreaterThan(0);
    expect(snapshot(seek, 'red').boats.length).toBeGreaterThan(0);

    // Branch A replays the recorded continuation; branch B recalls instead and must diverge.
    const branchSame = await ReplayEngine.restore(reference, midTick); const branchOther = await ReplayEngine.restore(reference, midTick);
    for (const turn of reference.turns.slice(midTick)) { branchSame.step(turn.intents.map(({ clientID, ...intent }) => ({ side: clientID === 'human001' ? 'blue' as const : 'red' as const, intent }))); }
    expect(branchSame.fingerprints).toEqual(reference.fingerprints);
    branchOther.step([{ side: 'blue', intent: { type: 'cancel_boat', unitID: snapshot(branchOther).boats[0]!.id } }]);
    for (let i = 0; i < 10; i++) branchOther.step();
    expect(branchOther.state().fingerprint).not.toBe(reference.fingerprints[branchOther.game.ticks()]);
  });

  it('under REPLAY configuration the water graph never changes, so the stagger value is unobservable', async () => {
    const e = await navalEngine();
    expect(e.game.miniWaterGraph()).toBeNull(); // disableNavMesh: no graph, no rebuild, version pinned at 0
    e.step([boat('blue', ISLAND_SHORE, 40)]);
    for (let i = 0; i < 60; i++) e.step();
    expect(e.game.waterGraphVersion()).toBe(0);
    expect(e.game.config().isUnitDisabled(UnitType.AtomBomb)).toBe(true);
  });

  it('with navmesh and water conversion enabled (not the REPLAY config) the stagger value is observable, and games no longer influence each other', async () => {
    // A fresh game: after the throttled graph rebuild (version 1) the stagger-0 ship re-plans and the
    // client callback receives a second motion plan while the boat is still at sea.
    const fresh = await navmeshTrace('MECH');
    expect(fresh.trace.some((s) => s.includes(':v1:'))).toBe(true);
    expect(fresh.trace.at(-1)).toMatch(/:p2:$/);
    expect(fresh.game.waterGraphVersion()).toBe(1);
    expect(transportStaggerCount(fresh.game)).toBe(1);
    // Within one game the upstream stagger semantics are intact and deterministic: 49 earlier
    // transport initialisations give the traced ship stagger 49, so it never re-plans before landing.
    const staggered = await navmeshTrace('MECH', 49);
    expect(transportStaggerCount(staggered.game)).toBe(50);
    expect(staggered.trace.at(-1)).toMatch(/:p1:$/);
    expect(staggered.trace.map((s) => s.split(':')[3])).toEqual(fresh.trace.map((s) => s.split(':')[3])); // same route, different re-planning
    // Before the patch, those 49 initialisations in ANOTHER game had exactly this effect on the next game's
    // ship (process-global counter). Now a noisy sibling game leaves the traced game unchanged.
    const noise = await navmeshNoise('NOISE', 49);
    expect(transportStaggerCount(noise)).toBe(49);
    const afterNoise = await navmeshTrace('MECH');
    expect(afterNoise.trace).toEqual(fresh.trace);
    expect(transportStaggerCount(afterNoise.game)).toBe(1);
    const again = await navmeshTrace('MECH', 49);
    expect(again.trace).toEqual(staggered.trace);
  });

  it('a pathfinder with a non-zero stagger keeps the old graph after a rebuild while stagger zero adopts it', async () => {
    const g = await navmeshGame('PF');
    g.step([{ type: 'spawn', tile: T(5, 2), clientID: 'human001' }, { type: 'spawn', tile: T(5, 13), clientID: 'redai001' }]);
    const pf0 = new WaterPathFinder(g.game, 0), pf49 = new WaterPathFinder(g.game, 49);
    for (const t of [T(6, 6), T(7, 6), T(6, 7), T(7, 7)]) g.game.queueWaterConversion(t);
    let v = 0; for (let i = 0; i < 40 && v === 0; i++) { g.step(); v = g.game.waterGraphVersion(); }
    expect(v).toBe(1);
    expect(pf0.rebuilt).toBe(true);
    expect(pf49.rebuilt).toBe(false);
  });
});

describe('record profile and legacy records', () => {
  it('new records carry the simulation profile; a different profile is refused', async () => {
    const e = await navalEngine(); e.step([boat('blue', ISLAND_SHORE, 40)]); for (let i = 0; i < 5; i++) e.step();
    const rec = e.record();
    expect(rec.simulationProfile).toBe(SIMULATION_PROFILE);
    await expect(ReplayEngine.restore({ ...rec, simulationProfile: 'naval-isolation/0' })).rejects.toThrow(/Simulation profile naval-isolation\/0 does not match/);
  });

  it('a legacy record without a profile is replayed and accepted only when its fingerprints match; a mismatch is named, not repaired', async () => {
    const e = await navalEngine(); e.step([boat('blue', ISLAND_SHORE, 40)]); for (let i = 0; i < 5; i++) e.step();
    const { simulationProfile: _p, ...legacy } = e.record();
    const restored = await ReplayEngine.restore(legacy as EngineRecord);
    expect(restored.state().fingerprint).toBe(e.state().fingerprint);
    expect(restored.record().simulationProfile).toBe(SIMULATION_PROFILE); // re-recorded under the current profile, never rewritten in place
    const last = Number(Object.keys(legacy.fingerprints).at(-1));
    const tampered = { ...legacy, fingerprints: { ...legacy.fingerprints, [last]: '0'.repeat(64) } } as EngineRecord;
    await expect(ReplayEngine.restore(tampered)).rejects.toThrow(/legacy record without a simulation profile.*1 naval orders recorded/);
    await expect(ReplayEngine.restore(tampered, last, 'checkpoints')).rejects.toThrow(/fingerprint mismatch/); // the final tick is always verified
  });

  it('the POC engine record on disk (legacy, no naval orders) still reproduces every recorded fingerprint', async () => {
    const rec = JSON.parse(fs.readFileSync('evidence/poc/engine-record.json', 'utf8')) as EngineRecord;
    expect(rec.simulationProfile).toBeUndefined();
    expect(ReplayEngine.navalIntentCount(rec)).toBe(0);
    const restored = await ReplayEngine.restore(rec, rec.turns.length, 'every-tick');
    expect(restored.state().fingerprint).toBe(rec.fingerprints[rec.turns.length]);
  });


});
