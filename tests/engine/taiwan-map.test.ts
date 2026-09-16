/**
 * `taiwan-strait-400` is the pinned upstream Taiwan Strait map (docs/demo/taiwan-map.md). These tests prove the playfield
 * is upstream's map16x.bin byte for byte, that altered assets are refused before parsing, that the geography players see is
 * recognisably island versus mainland at the manifest's own named places, and that a recording on it replays exactly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ReplayEngine, type EngineRecord, type Side } from '../../src/engine/engine';
import { AOR_MAPS, ENGINE_MAPS, LEGACY_MAPS, WORLD_RESOLUTIONS, isEngineMap, loadMap } from '../../src/engine/maps';
import { ROOT, spawnTarget, terrainHash } from '../../scripts/qualify-pacing';
import type { Game } from '../../vendor/openfront/src/core/game/Game';

console.debug = () => {}; console.warn = () => {};

const MAP = 'taiwan-strait-400' as const;
const FOLDER = path.join(ROOT, 'vendor/openfront/tests/testdata/maps/taiwanstrait');
const manifest = JSON.parse(fs.readFileSync(path.join(FOLDER, 'manifest.json'), 'utf8')) as { map: { width: number }; map16x: { width: number; height: number; num_land_tiles: number }; nations: { name: string; flag: string; coordinates: [number, number] }[] };
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Proposed scenario deployments, as manifest-normalized coordinates. */
const BLUE: [number, number] = [0.82, 0.28], RED: [number, number] = [0.28, 0.25];
const TAIWAN_CITIES = ['Taipei', 'Keelung', 'Taoyuan', 'Hsinchu', 'Miaoli', 'Taichung City', 'Chiayi', 'Tainan', 'Kaohsiung', 'Taitung', 'Hualien'];
/** Mainland places on Red's own land component; Fuzhou, Zhangzhou, Longyan and Dongshan sit across river channels (see doc). */
const RED_MAINLAND = ['Xiamen', 'Quanzhou', 'Putian', 'Anxi', 'Xianyou', 'Dehua', 'Sanming'];
const OFFSHORE = ['Kinmen Island', 'Penghu', 'Lanyu'];

/** 4-connected passable-land components, the adjacency land attacks spread over. */
function landComponents(g: Game) {
  const W = g.width(), H = g.height(), id = new Int32Array(W * H).fill(-1), size: number[] = [], touchesEdge: boolean[] = [];
  const passable = (i: number) => g.isLand(i) && !g.isImpassable(i);
  for (let s = 0; s < W * H; s++) if (passable(s) && id[s] < 0) {
    const c = size.length, stack = [s]; let n = 0, edge = false; id[s] = c;
    while (stack.length) {
      const i = stack.pop()!, x = i % W, y = (i - x) / W; n++;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && id[j] < 0 && passable(j)) { id[j] = c; stack.push(j); }
    }
    size.push(n); touchesEdge.push(edge);
  }
  return { id, size, touchesEdge };
}
/** Manifest nation coordinates are on the 1600px map; scale to the playfield, then take the nearest passable land. */
function place(g: Game, name: string) {
  const n = manifest.nations.find((v) => v.name === name)!, scale = g.width() / manifest.map.width;
  const x = Math.floor(n.coordinates[0] * scale), y = Math.floor(n.coordinates[1] * scale), tile = spawnTarget(g, (x + 0.5) / g.width(), (y + 0.5) / g.height());
  return { name, x, y, tile, offset: Math.hypot(g.x(tile) - x, g.y(tile) - y) };
}
const roundTrip = (r: EngineRecord) => JSON.parse(JSON.stringify(r)) as EngineRecord;
const tmpRoots: string[] = [];
afterAll(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

describe('taiwan-strait-400 terrain identity', () => {
  it('plays upstream map16x.bin unchanged at 400x400 with a 200x200 minimap sampled from it', async () => {
    const { map, mini, sourceHash, derivation } = await loadMap(ROOT, MAP);
    const bin = fs.readFileSync(path.join(FOLDER, 'map16x.bin'));
    expect([map.width(), map.height(), mini.width(), mini.height()]).toEqual([400, 400, 200, 200]);
    expect(sourceHash).toBe(sha256(fs.readFileSync(path.join(FOLDER, 'map.bin'))));
    expect(sourceHash).toBe('b84cad3adf7136fa0e018a3a1a94a67423af262f9a95f0f8b67a1ec25d7b720a');
    expect(derivation).toMatchObject({ width: 400, height: 400, landTiles: 55147, miniWidth: 200, miniHeight: 200 });
    expect(derivation.assets!.map((a) => a.file)).toEqual(['taiwanstrait/manifest.json', 'taiwanstrait/map.bin', 'taiwanstrait/map16x.bin']);
    expect(derivation.source).toContain('map16x.bin (400x400) unchanged');

    // Byte identity: terrainHash re-packs every tile's land/shore/ocean/magnitude bits, which is exactly the native byte layout.
    const e = await ReplayEngine.create({ simulationId: 'TWMAP001', map: MAP });
    expect(terrainHash(e.game)).toBe(sha256(bin));
    expect(terrainHash(e.game)).toBe(AOR_MAPS[MAP].assets['map16x.bin'].sha256);
    let land = 0; for (let i = 0; i < 400 * 400; i++) if (e.game.isLand(i)) land++;
    expect([land, e.game.numLandTiles(), manifest.map16x.num_land_tiles]).toEqual([55147, 55147, 55147]);

    // Minimap: land/magnitude from every second playfield pixel, shoreline recomputed at 200x200.
    let miniLand = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
      const src = bin[y * 2 * 400 + x * 2], m = mini.ref(x, y), isLand = Boolean(src & 128);
      expect([mini.isLand(m), mini.magnitude(m)]).toEqual([isLand, src & 31]);
      const differs = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([nx, ny]) => nx >= 0 && ny >= 0 && nx < 200 && ny < 200 && Boolean(bin[ny * 2 * 400 + nx * 2] & 128) !== isLand);
      expect(mini.isShoreline(m)).toBe(differs);
      if (isLand) miniLand++;
    }
    expect(mini.numLandTiles()).toBe(miniLand);
  });

  it('refuses altered assets before loading, including the full-resolution source it does not play', async () => {
    const tamper = (file: string, edit: (b: Buffer) => Buffer) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twmap-')); tmpRoots.push(root);
      const dir = path.join(root, 'vendor/openfront/tests/testdata/maps/taiwanstrait'); fs.mkdirSync(dir, { recursive: true });
      for (const f of Object.keys(AOR_MAPS[MAP].assets)) fs.copyFileSync(path.join(FOLDER, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, file), edit(fs.readFileSync(path.join(dir, file))));
      return root;
    };
    const flip = (i: number) => (b: Buffer) => { b[i] ^= 128; return b; };
    await expect(loadMap(tamper('map16x.bin', flip(200 * 400 + 200)), MAP)).rejects.toThrow('Map taiwan-strait-400 refused: taiwanstrait/map16x.bin is 160000 bytes');
    await expect(loadMap(tamper('map.bin', flip(0)), MAP)).rejects.toThrow('refused: taiwanstrait/map.bin');
    await expect(loadMap(tamper('map16x.bin', (b) => b.subarray(0, 159600)), MAP)).rejects.toThrow('taiwanstrait/map16x.bin is 159600 bytes');
    await expect(loadMap(tamper('manifest.json', (b) => Buffer.from(b.toString('utf8').replace('"num_land_tiles": 55147', '"num_land_tiles": 55148'))), MAP)).rejects.toThrow('refused: taiwanstrait/manifest.json');
    // An untouched copy loads, so the refusals above are about the bytes, not the location.
    expect((await loadMap(tamper('manifest.json', (b) => b), MAP)).derivation.width).toBe(400);
  });

  it('leaves every existing option, list order and the legacy world terrain unchanged, and refuses unknown names', async () => {
    expect(ENGINE_MAPS).toEqual([...LEGACY_MAPS, ...Object.keys(WORLD_RESOLUTIONS), MAP]);
    expect(LEGACY_MAPS).toEqual(['plains', 'big_plains', 'world', 'half_land_half_ocean', 'ocean_and_land']);
    expect(Object.keys(WORLD_RESOLUTIONS)).toEqual(['world-500', 'world-1000', 'world-2000']);
    const world = await loadMap(ROOT, 'world'), e = await ReplayEngine.create({ simulationId: 'MAPOPT01', map: 'world' });
    expect([world.map.width(), world.map.height(), world.mini.width(), world.mini.height(), world.derivation.landTiles]).toEqual([400, 200, 200, 100, 25955]);
    expect(terrainHash(e.game)).toBe('88afce5ec4cb6cc7790503246120c24c8511ea85af55d31680be782e11d53a1f'); // pinned in tests/pacing-map-options.test.ts
    expect(world.derivation).not.toHaveProperty('assets');
    for (const bad of ['taiwanstrait', 'taiwan-strait', 'taiwan-strait-800', 'taiwan-strait-1600', 'Taiwan-Strait-400', 'taiwan-strait-400 ']) {
      expect(isEngineMap(bad)).toBe(false);
      await expect(loadMap(ROOT, bad)).rejects.toThrow(`Unknown map option: ${bad}`);
      await expect(ReplayEngine.create({ map: bad as never })).rejects.toThrow(`Unknown map option: ${bad}`);
    }
  });
});

describe('taiwan-strait-400 geography', () => {
  it('puts the proposed Blue deployment on Taiwan and Red on the mainland, matching the manifest place names', async () => {
    const e = await ReplayEngine.create({ simulationId: 'TWMAP001', map: MAP }), g = e.game, { id, size, touchesEdge } = landComponents(g);
    const blue = spawnTarget(g, ...BLUE), red = spawnTarget(g, ...RED);
    expect([g.x(blue), g.y(blue), g.x(red), g.y(red)]).toEqual([328, 112, 112, 100]); // both exact points are already land
    const island = id[blue], mainland = id[red];
    expect(island).not.toBe(mainland);
    expect(touchesEdge[island]).toBe(false); // wholly surrounded by water inside the AOR
    expect(touchesEdge[mainland]).toBe(true); // continues off the map edge
    expect([size[island], size[mainland]]).toEqual([27454, 20752]);

    for (const name of [...TAIWAN_CITIES, ...RED_MAINLAND, ...OFFSHORE]) {
      const p = place(g, name);
      expect(g.isLand(p.tile), name).toBe(true);
      expect(p.offset, `${name} manifest point is land on the playfield`).toBe(0);
      if (TAIWAN_CITIES.includes(name)) expect(id[p.tile], name).toBe(island);
      else if (RED_MAINLAND.includes(name)) expect(id[p.tile], name).toBe(mainland);
      else { expect([island, mainland], name).not.toContain(id[p.tile]); expect(size[id[p.tile]], name).toBeLessThan(200); }
    }
    for (const n of manifest.nations.filter((v) => v.flag === 'cn')) expect(id[place(g, n.name).tile], n.name).not.toBe(island);
  });

  it('records 300 ticks of legal orders, replays them identically and keeps each side on its own landmass', async () => {
    const orders = (e: ReplayEngine, tick: number): { side: Side; intent: unknown }[] => {
      const g = e.game;
      if (tick === 0) return [{ side: 'blue', intent: { type: 'spawn', tile: spawnTarget(g, ...BLUE) } }, { side: 'red', intent: { type: 'spawn', tile: spawnTarget(g, ...RED) } }];
      if (tick === 120 || tick === 220) return (['blue', 'red'] as Side[]).map((side) => ({ side, intent: { type: 'attack', targetID: null, troops: Math.floor(e.player(side).troops() / 3) } }));
      return [];
    };
    const e = await ReplayEngine.create({ simulationId: 'TWMAP001', map: MAP });
    // Orders go through the same validator players use: water and cross-strait targets are refused.
    const water = e.game.ref(200, 100);
    expect(e.game.isLand(water)).toBe(false);
    expect(() => e.validate('red', { type: 'spawn', tile: water })).toThrow('Choose unoccupied land');
    while (e.turns.length < 300) {
      e.step(orders(e, e.turns.length));
      if (e.turns.length === 150) expect(() => e.validate('blue', { type: 'attack', targetID: e.player('red').id(), troops: 1 })).toThrow('Target is not currently attackable');
    }
    const record = roundTrip(e.record()), final = e.state();
    expect(record.options).toEqual({ simulationId: 'TWMAP001', map: MAP, startingGold: 60000 });
    expect(record.turns.reduce((n, t) => n + t.intents.length, 0)).toBe(6);

    const restored = await ReplayEngine.restore(record, 300, 'every-tick');
    expect(restored.state()).toEqual(final);
    const again = await ReplayEngine.create({ simulationId: 'TWMAP001', map: MAP });
    while (again.turns.length < 300) again.step(orders(again, again.turns.length));
    expect(again.fingerprints).toEqual(e.fingerprints);

    const g = restored.game, { id } = landComponents(g), island = id[spawnTarget(g, ...BLUE)], mainland = id[spawnTarget(g, ...RED)];
    const owned = (side: Side) => { const s = restored.player(side).smallID(), comps = new Set<number>(); let n = 0; for (let i = 0; i < g.width() * g.height(); i++) if (g.ownerID(i) === s) { comps.add(id[i]); n++; } return { n, comps: [...comps] }; };
    const b = owned('blue'), r = owned('red');
    expect(b.n).toBeGreaterThan(final.players[0].tiles / 2); expect(b.n).toBe(final.players[0].tiles);
    expect(b.comps).toEqual([island]); expect(r.comps).toEqual([mainland]);
    expect(r.n).toBeGreaterThan(0);
  }, 20000);
});
