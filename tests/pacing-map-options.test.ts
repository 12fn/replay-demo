/**
 * Explicit world resolutions are new option names, never a change to an old one. These tests prove
 * that the legacy `world` (and `plains`) terrain is byte-identical to what existing recordings were
 * made on, that a new option is part of a recording's identity for replay and branch, and that an
 * unknown option is refused by name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { ReplayEngine, type EngineMap, type EngineRecord } from '../src/engine/engine';
import { AOR_MAPS, ENGINE_MAPS, LEGACY_MAPS, WORLD_RESOLUTIONS, isEngineMap, loadMap } from '../src/engine/maps';
import { ROOT, evidenceHeader, rawStep, spawnTarget, terrainHash, writeEvidence } from '../scripts/qualify-pacing';
console.debug = () => {};

/** Terrain hashes as first computed on 2026-09-13 from the pinned fixture; a change here means the terrain an option denotes changed. */
const PINNED: Record<string, { width: number; height: number; landTiles: number; terrainHash: string }> = {
  world: { width: 400, height: 200, landTiles: 25955, terrainHash: '88afce5ec4cb6cc7790503246120c24c8511ea85af55d31680be782e11d53a1f' },
};
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/openfront/tests/testdata/maps/world/manifest.json'), 'utf8'));
const evidence: Record<string, unknown> = {};
afterAll(() => { if(process.env.REPLAY_WRITE_PACING_EVIDENCE==='1')writeEvidence('map-options', { ...evidenceHeader('Terrain identity and record identity checks for explicit world resolutions'), ...evidence }); });

async function game(map: EngineMap, simulationId = 'MAPOPT01') {
  const e = await ReplayEngine.create({ simulationId, map });
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawnTarget(e.game, 0.56, 0.34) } }, { side: 'red', intent: { type: 'spawn', tile: spawnTarget(e.game, 0.72, 0.34) } }]);
  return e;
}

describe('legacy terrain is unchanged', () => {
  test('world keeps its 400x200 factor-5 derivation and pinned terrain hash', async () => {
    const { map, mini, derivation } = await loadMap(ROOT, 'world');
    const e = await ReplayEngine.create({ simulationId: 'MAPOPT01', map: 'world' });
    const hash = terrainHash(e.game);
    process.stderr.write(`world terrain ${map.width()}x${map.height()} land=${derivation.landTiles} mini=${mini.width()}x${mini.height()} hash=${hash}\n`);
    evidence.legacyWorld = { ...derivation, terrainHash: hash };
    expect([map.width(), map.height(), mini.width(), mini.height()]).toEqual([400, 200, 200, 100]);
    expect({ width: derivation.width, height: derivation.height, landTiles: derivation.landTiles, terrainHash: hash }).toEqual(PINNED.world);
  });
  test('the committed plains POC record replays every tick', async () => {
    const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence/poc/engine-record.json'), 'utf8')) as EngineRecord;
    expect(record.options.map).toBe('plains');
    const restored = await ReplayEngine.restore(record, record.turns.length, 'every-tick');
    expect(restored.state().fingerprint).toBe(record.fingerprints[record.turns.length]);
    evidence.legacyPlainsRecordReplay = { file: 'evidence/poc/engine-record.json', turns: record.turns.length, verification: 'every-tick', matched: true };
  }, 30000);
  test('every legacy name still resolves and the option list is legacy names plus explicit world resolutions', () => {
    expect(ENGINE_MAPS).toEqual([...LEGACY_MAPS, ...Object.keys(WORLD_RESOLUTIONS),...Object.keys(AOR_MAPS)]);
    for (const m of LEGACY_MAPS) expect(isEngineMap(m)).toBe(true);
  });
});

describe('explicit world resolutions', () => {
  test('each option loads the pinned fixture at its declared size and no two options share terrain', async () => {
    const hashes: Record<string, string> = {}; const rows: Record<string, unknown> = {};
    for (const name of ['world', ...Object.keys(WORLD_RESOLUTIONS)] as EngineMap[]) {
      const { derivation, sourceHash } = await loadMap(ROOT, name); const e = await ReplayEngine.create({ simulationId: 'MAPOPT01', map: name });
      hashes[name] = terrainHash(e.game); rows[name] = { ...derivation, sourceHash, terrainHash: hashes[name] };
      expect([e.game.width(), e.game.height()]).toEqual([derivation.width, derivation.height]);
    }
    process.stderr.write(JSON.stringify(rows, null, 1) + '\n');
    evidence.options = rows;
    expect(rows['world-500']).toMatchObject({ width: 500, height: 250, miniWidth: 250, miniHeight: 125 });
    // Upstream's own binaries, unchanged: land counts come straight from the manifest.
    expect(rows['world-1000']).toMatchObject({ width: 1000, height: 500, landTiles: manifest.map4x.num_land_tiles, miniWidth: 500, miniHeight: 250 });
    expect(rows['world-2000']).toMatchObject({ width: 2000, height: 1000, landTiles: manifest.map.num_land_tiles, miniWidth: 1000, miniHeight: 500 });
    expect(new Set(Object.values(hashes)).size).toBe(Object.keys(hashes).length);
  }, 30000);

  test('the map name is part of a recording: same seed and orders on different options give different histories', async () => {
    const a = await game('world'), b = await game('world-500');
    expect(a.record().options.map).toBe('world'); expect(b.record().options.map).toBe('world-500');
    expect(a.state().fingerprint).not.toBe(b.state().fingerprint);
  });

  test('a world-1000 recording restores and branches on world-1000 terrain with identical fingerprints', async () => {
    const e = await game('world-1000');
    for (let t = 0; t < 150; t++) {
      const orders = t % 45 === 10 ? (['blue', 'red'] as const).map(side => ({ side, intent: { type: 'attack', targetID: null, troops: Math.floor(e.player(side).troops() * 0.18) } })) : [];
      if (t % 30 === 0) e.step(orders); else rawStep(e, orders);
    }
    const final = e.state(); e.fingerprints[final.tick] = final.fingerprint;
    const record = e.record();
    expect(record.options).toEqual({ simulationId: 'MAPOPT01', map: 'world-1000', startingGold: 60000 });
    expect(record.simulationProfile).toBeDefined();
    const restored = await ReplayEngine.restore(record, record.turns.length, 'every-tick');
    expect(restored.game.width()).toBe(1000); expect(restored.state().fingerprint).toBe(final.fingerprint);
    expect(restored.player('blue').numTilesOwned()).toBeGreaterThan(1);
    // Branch: two independent restores at a fork continue identically, and a divergent order changes only its own branch.
    const fork = 61; const left = await ReplayEngine.restore(record, fork, 'checkpoints'), right = await ReplayEngine.restore(record, fork, 'every-tick');
    expect(left.state().fingerprint).toBe(right.state().fingerprint);
    for (let i = 0; i < 20; i++) { left.step(); right.step(); }
    expect(left.state().fingerprint).toBe(right.state().fingerprint);
    const parentAtFork = record.fingerprints[fork];
    right.step([{ side: 'blue', intent: { type: 'attack', targetID: null, troops: 500 } }]); left.step();
    expect(left.state().fingerprint).not.toBe(right.state().fingerprint);
    expect(record.fingerprints[fork]).toBe(parentAtFork);
    expect(record.options.map).toBe('world-1000');
    evidence.newOptionRecordIdentity = { map: 'world-1000', turns: record.turns.length, restoredEveryTick: true, branchFork: fork, identicalContinuationTicks: 20, divergedAfterDifferentOrder: true };
  }, 30000);

  test('unknown or misspelled map options are refused by name, at creation and at restore', async () => {
    for (const bad of ['world-999', 'World', 'world-400', 'WORLD-1000', '', 'world-1000 ', 'plains/../world']) {
      await expect(ReplayEngine.create({ simulationId: 'MAPOPT01', map: bad as EngineMap })).rejects.toThrow(`Unknown map option: ${bad}`);
      expect(isEngineMap(bad)).toBe(false);
    }
    await expect(ReplayEngine.create({ map: 42 as unknown as EngineMap })).rejects.toThrow('Unknown map option: 42');
    await expect(loadMap(ROOT, 'world-3000')).rejects.toThrow('Unknown map option: world-3000');
    const e = await game('world-500'); const record = e.record();
    const tampered = { ...record, options: { ...record.options, map: 'world-501' as EngineMap } };
    await expect(ReplayEngine.restore(tampered)).rejects.toThrow('Unknown map option: world-501');
    // A record can only be replayed on the option it names: the same turns on another option do not reproduce its fingerprint.
    const other = { ...record, options: { ...record.options, map: 'world' as EngineMap } };
    await expect(ReplayEngine.restore(other)).rejects.toThrow('Replay fingerprint mismatch');
    evidence.invalidOptionRejection = { rejected: ['world-999', 'World', 'world-400', 'WORLD-1000', '', 'world-1000 ', 'plains/../world', 42, 'world-3000', 'world-501'], crossOptionReplayRefused: true };
  });
});
