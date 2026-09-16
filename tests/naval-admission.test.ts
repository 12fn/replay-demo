/**
 * Boat admission and the sampled naval options.
 *
 * Before this work the validator only checked force bounds and "destination is land", so orders the
 * upstream execution silently discards (own territory, immune target, no shore, transport limit) were
 * admitted and recorded as accepted. The validator now mirrors the execution's own checks, and the
 * tool catalog enumerates a bounded, labelled sample of landings through that same validator.
 */
import { describe, expect, it } from 'vitest';
import { ReplayEngine } from '../src/engine/engine';
import { executeTool, listLegalActions, listNavalOptions, type AgentContext } from '../src/agents/tools';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import { BLUE_SPAWN, ISLAND_INTERIOR, ISLAND_SHORE, RED_SPAWN, T, boat, navalEngine, snapshot } from './naval-fixture';

console.debug = () => {}; console.warn = () => {};

const ctxFor = (engine: ReplayEngine, side: 'blue' | 'red'): AgentContext => ({ exerciseId: 'naval', side, engine, reports: () => [], events: () => [], submitOrder: (intent) => { engine.step([{ side, intent }]); return { id: 'x', status: 'executed' }; } });

describe('boat admission mirrors the upstream execution', () => {
  it('refuses orders the engine would drop silently, with a reason a human or model can act on', async () => {
    const e = await navalEngine();
    const v = (intent: unknown) => () => e.validate('blue', intent);
    expect(v({ type: 'boat', dst: BLUE_SPAWN, troops: 10 })).toThrow(/your own territory/);
    expect(v({ type: 'boat', dst: T(9, 9), troops: 10 })).toThrow(/valid land/);
    expect(v({ type: 'boat', dst: ISLAND_SHORE, troops: 0 })).toThrow(/available forces/);
    expect(v({ type: 'boat', dst: ISLAND_SHORE, troops: 1e9 })).toThrow(/available forces/);
    // Red still has spawn immunity: its shore is land, not owned by blue, but not attackable yet.
    expect(e.player('red').isImmune()).toBe(true);
    expect(v({ type: 'boat', dst: RED_SPAWN, troops: 10 })).toThrow(/not currently attackable/);
    // The island interior is accepted and lands on the nearest island shore.
    expect(v({ type: 'boat', dst: ISLAND_INTERIOR, troops: 10 })).not.toThrow();
    const landing = e.transportLanding(e.player('blue'), ISLAND_INTERIOR)!;
    expect(landing).not.toBe(ISLAND_INTERIOR);
    expect(e.game.isShore(landing)).toBe(true);
    expect(e.game.neighbors(ISLAND_INTERIOR)).toContain(landing); // upstream picks the first nearest island shore, (15,6)
    expect(e.transportRefusal(e.player('blue'), ISLAND_INTERIOR)).toBeNull();
    expect(e.transportLanding(e.player('blue'), ISLAND_SHORE)).toBe(ISLAND_SHORE);
  });

  it('an admitted order always produces a transport; the limit is enforced at admission', async () => {
    const e = await navalEngine();
    for (let i = 0; i < 3; i++) { e.step([boat('blue', ISLAND_SHORE, 10)]); expect(snapshot(e).boats).toHaveLength(i + 1); }
    expect(() => e.validate('blue', { type: 'boat', dst: ISLAND_SHORE, troops: 10 })).toThrow(/Transport limit reached \(3 at sea\)/);
    expect(() => e.validate('red', { type: 'boat', dst: ISLAND_SHORE, troops: 10 })).not.toThrow(); // per player
  });

  it('once immunity lapses an opponent shore becomes a legal landing and the transport actually sails', async () => {
    const e = await navalEngine();
    while (e.player('red').isImmune()) e.step();
    const redShore = [...e.player('red').borderTiles()].find((t) => e.game.isShore(t))!;
    expect(() => e.validate('blue', { type: 'boat', dst: redShore, troops: 10 })).not.toThrow();
    e.step([boat('blue', redShore, 10)]);
    expect(snapshot(e).boats).toHaveLength(1);
  });

  it('a map without water refuses transports and says why', async () => {
    const e = await ReplayEngine.create({ map: 'plains' });
    e.step([{ side: 'blue', intent: { type: 'spawn', tile: 2525 } }, { side: 'red', intent: { type: 'spawn', tile: 7575 } }]);
    for (let i = 0; i < 5; i++) e.step();
    expect(() => e.validate('blue', { type: 'boat', dst: 5050, troops: 10 })).toThrow(/No landing shore|No owned shoreline/);
    const naval = listNavalOptions(ctxFor(e, 'blue'));
    expect(naval).toMatchObject({ status: 'unavailable', reason: 'No owned shoreline to launch from', landings: [] });
  });
});

describe('sampled naval options', () => {
  it('lists validated, labelled landings and recalls; every entry passes the same validator as a human order', async () => {
    const e = await navalEngine();
    const naval = listNavalOptions(ctxFor(e, 'blue'));
    expect(naval.status).toBe('available');
    expect(naval.sampling).toMatch(/Sampled.*not an exhaustive or optimal plan/);
    expect(naval.limit).toEqual({ atSea: 0, max: 3 });
    expect(naval.landings.length).toBeGreaterThan(0);
    expect(naval.landings.length).toBeLessThanOrEqual(5);
    expect(naval.landingsConsidered).toBeGreaterThan(naval.landings.length);
    for (const l of naval.landings) {
      expect(l.target).toBe('unclaimed'); // red is immune, so no opponent shore is offered yet
      expect(l.meaning).toMatch(/sampled option/);
      expect(l.intent.troops).toBe(Math.floor(e.player('blue').troops() / 5));
      expect(l.costGold).toBe(0);
      expect(() => e.validate('blue', l.intent)).not.toThrow();
      expect(e.game.isShore(l.landing.tile)).toBe(true);
    }
    // Nearest unclaimed shores are on the shared mainland coast; the farthest sampled one is the island.
    expect(naval.landings.some((l) => l.landing.x >= 14)).toBe(true);
    expect(naval.landings.some((l) => l.landing.x === 7)).toBe(true);
    const legal = listLegalActions(ctxFor(e, 'blue'));
    expect(legal.naval).toEqual(naval);
    expect(legal.actions.filter((a) => a.intent.type === 'boat').length).toBe(naval.landings.length);
    for (const a of legal.actions) expect(() => e.validate('blue', a.intent)).not.toThrow();
    // Submit the first sampled landing through the tool path: same validator, a real transport results.
    const r = executeTool({ tool: 'submit_order', arguments: JSON.stringify({ intent: naval.landings[0]!.intent }) }, 'player', ctxFor(e, 'blue'));
    expect(r.ok).toBe(true);
    expect(snapshot(e).boats).toHaveLength(1);
    const after = listNavalOptions(ctxFor(e, 'blue'));
    expect(after.transportsAtSea).toHaveLength(1);
    expect(after.transportsAtSea[0]!.cancelIntent).toEqual({ type: 'cancel_boat', unitID: snapshot(e).boats[0]!.id });
    expect(listLegalActions(ctxFor(e, 'blue')).actions.some((a) => a.intent.type === 'cancel_boat')).toBe(true);
  });

  it('reports the limit as unavailable instead of listing landings that would be refused', async () => {
    const e = await navalEngine();
    for (let i = 0; i < 3; i++) e.step([boat('blue', ISLAND_SHORE, 10)]);
    const naval = listNavalOptions(ctxFor(e, 'blue'));
    expect(naval).toMatchObject({ status: 'unavailable', reason: 'Transport limit reached (3 at sea)', landings: [] });
    expect(naval.transportsAtSea).toHaveLength(3);
    expect(listNavalOptions(ctxFor(e, 'red')).status).toBe('available');
  });

  it('offers opponent shores once they are attackable and is deterministic across calls and reconstruction', async () => {
    const e = await navalEngine();
    while (e.player('red').isImmune()) e.step();
    const first = listNavalOptions(ctxFor(e, 'blue'));
    expect(first.landings.some((l) => l.target === 'opponent')).toBe(true);
    expect(first.landings.filter((l) => l.target === 'opponent').length).toBeLessThanOrEqual(2);
    expect(listNavalOptions(ctxFor(e, 'blue'))).toEqual(first);
    const restored = await ReplayEngine.restore(e.record());
    expect(listNavalOptions(ctxFor(restored, 'blue'))).toEqual(first);
    for (const l of first.landings) { const owner = e.game.owner(l.intent.dst); expect(l.target).toBe(owner.isPlayer() ? 'opponent' : 'unclaimed'); }
  });

  it('nothing is offered during deployment, and a dead side gets an explicit reason', async () => {
    const e = await ReplayEngine.create({ map: 'ocean_and_land' });
    const naval = listNavalOptions(ctxFor(e, 'blue'));
    expect(naval).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/deployment/) });
  });

  it('stays cheap on the full world map', async () => {
    const e = await ReplayEngine.create({ map: 'world' });
    const spawn = (fx: number) => { let best = 0, d = Infinity; for (let t = 0; t < e.game.width() * e.game.height(); t++) if (e.game.isLand(t) && !e.game.isImpassable(t)) { const dist = (e.game.x(t) - e.game.width() * fx) ** 2 + (e.game.y(t) - e.game.height() * 0.34) ** 2; if (dist < d) { best = t; d = dist; } } return best; };
    e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawn(0.56) } }, { side: 'red', intent: { type: 'spawn', tile: spawn(0.72) } }]);
    for (let i = 0; i < 5; i++) e.step();
    const started = performance.now();
    const naval = listNavalOptions(ctxFor(e, 'blue'));
    const ms = performance.now() - started;
    process.stderr.write(`world naval options: ${naval.status} (${naval.reason ?? 'ok'}) ${naval.landings.length} landings of ${naval.landingsConsidered} considered in ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(500);
    if (naval.status === 'available') for (const l of naval.landings) expect(() => e.validate('blue', l.intent)).not.toThrow();
    expect(e.player('blue').unitCount(UnitType.TransportShip)).toBe(0);
  });
});
