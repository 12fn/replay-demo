/**
 * `maneuver/1` scripted opponent: every order is admitted by the engine validator and executed by the
 * pinned engine here (structures complete, transports sail and land, forces move). Determinism is
 * checked across sides, repeated calls, reconstruction and branches. Nothing in this file writes
 * evidence; the abstract 16x16 ocean fixture and the flat `plains` fixture are not geography.
 */
import { describe, expect, test } from 'vitest';
import { ReplayEngine, type EngineOptions, type Side } from '../../src/engine/engine';
import { MANEUVER_CONTROLLER, MANEUVER_INTERVAL_TICKS, MANEUVER_RULES, landmasses, maneuverAssess, maneuverDecision, transportTargets, type ManeuverAssessment, type ManeuverDecision } from '../../src/agents/scripted-controller';
import { UnitType } from '../../vendor/openfront/src/core/game/Game';
import { BLUE_SPAWN, ISLAND_INTERIOR, ISLAND_SHORE, RED_SPAWN, T, navalEngine } from '../naval-fixture';
import { spawnTarget } from '../../scripts/qualify-pacing';

console.debug = () => {}; console.warn = () => {};
const other = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');
const structures = (e: ReplayEngine, side: Side, type: UnitType) => e.player(side).units(type).filter((u) => u.isActive() && !u.isUnderConstruction()).length;
const boats = (e: ReplayEngine, side: Side) => e.player(side).units(UnitType.TransportShip).filter((u) => u.isActive());

/** Advance `ticks`, letting each scripted side issue the controller's one order every 45 ticks through the normal validated step. */
function drive(e: ReplayEngine, sides: Side[], ticks: number, onDecision?: (d: ManeuverAssessment, side: Side) => void) {
  const log: { tick: number; side: Side; decision: ManeuverDecision | null }[] = [];
  for (let i = 0; i < ticks; i++) {
    const orders: { side: Side; intent: unknown }[] = [];
    if (e.game.ticks() % MANEUVER_INTERVAL_TICKS === 0) for (const side of sides) {
      const a = maneuverAssess(e, side); onDecision?.(a, side);
      const d = maneuverDecision(e, side); log.push({ tick: e.game.ticks(), side, decision: d });
      if (d) orders.push({ side, intent: d.intent });
    }
    e.step(orders);
  }
  return log;
}

async function plains(options: EngineOptions = {}) {
  const e = await ReplayEngine.create({ simulationId: 'MANV0001', map: 'plains', ...options });
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: 2525 } }, { side: 'red', intent: { type: 'spawn', tile: 2575 } }]);
  return e;
}

describe(`${MANEUVER_CONTROLLER} contract`, () => {
  test('silent before deployment, one validated order per pulse afterwards, never mutating the state it reads', async () => {
    const e = await ReplayEngine.create({ simulationId: 'MANV0001', map: 'plains' });
    expect(maneuverDecision(e, 'blue')).toBeNull();
    expect(maneuverAssess(e, 'blue')).toMatchObject({ controller: 'maneuver/1', category: 'none', intent: null });
    e.step([{ side: 'blue', intent: { type: 'spawn', tile: 2525 } }, { side: 'red', intent: { type: 'spawn', tile: 2575 } }]);
    // The spawn turn itself is still the deployment phase; the rule stays silent until the engine closes it.
    expect(maneuverDecision(e, 'blue')).toBeNull();
    for (let i = 0; i < 5; i++) e.step();
    const before = e.state().fingerprint;
    const d = maneuverDecision(e, 'blue'); const again = maneuverDecision(e, 'blue');
    expect(d).not.toBeNull(); expect(again).toEqual(d);
    expect(e.state().fingerprint).toBe(before);
    expect(() => e.validate('blue', d!.intent)).not.toThrow();
    expect(d!.category).toBe('expansion'); expect(d!.reason).toMatch(/neutral/);
    // The reason quotes observed quantities, not a narrative.
    expect(d!.reason).toMatch(/home [\d,]+ of cap [\d,]+/);
  });

  test('expansion and later opponent attacks execute in the engine; neutral expansion continues after contact', async () => {
    const e = await plains();
    const seen = new Set<string>(); let expansionAfterContact = 0, contactTick: number | null = null;
    drive(e, ['blue', 'red'], 1800, (a, side) => {
      if (contactTick === null && a.observed.inContact) contactTick = a.tick;
      if (a.intent) { seen.add(a.category); expect(() => e.validate(side, a.intent!)).not.toThrow(); }
      if (contactTick !== null && a.category === 'expansion') expansionAfterContact++;
    });
    expect(contactTick).not.toBeNull();
    expect(seen.has('expansion')).toBe(true); expect(seen.has('attack')).toBe(true);
    expect(expansionAfterContact).toBeGreaterThan(0);
    expect(e.player('blue').numTilesOwned()).toBeGreaterThan(200); expect(e.player('red').numTilesOwned()).toBeGreaterThan(200);
  });

  test('reserve handling: thin reserves are rebuilt instead of spent, and field forces above home forces hold a pulse', async () => {
    const e = await plains();
    for (let i = 0; i < 20; i++) e.step();
    const p = e.player('blue');
    // Spend nearly everything through the engine, as a human could.
    e.step([{ side: 'blue', intent: { type: 'attack', targetID: null, troops: Math.floor(p.troops() * 0.97) } }]);
    const a = maneuverAssess(e, 'blue');
    expect(a.category).toBe('reserve'); expect(a.intent).toBeNull(); expect(maneuverDecision(e, 'blue')).toBeNull();
    expect(a.reason).toMatch(/in the field exceed|reserve below|below the/);
    // Once the reserve rebuilds the rule commits again, at a share bounded by the reserve band.
    let resumed: ManeuverAssessment | null = null;
    for (let i = 0; i < 40 && !resumed; i++) { for (let k = 0; k < MANEUVER_INTERVAL_TICKS; k++) e.step(); const b = maneuverAssess(e, 'blue'); if (b.intent && b.category === 'expansion') resumed = b; }
    expect(resumed).not.toBeNull();
    const share = Number(resumed!.intent!.troops) / resumed!.observed.troops;
    expect(share).toBeLessThanOrEqual(0.36); expect(share).toBeGreaterThan(0.05);
  });

  test('construction: idle gold becomes a city that actually completes and raises the force cap; upgrades follow when no site remains', async () => {
    const e = await navalEngine({ startingGold: 600_000 });
    const capBefore = e.game.config().maxTroops(e.player('blue'));
    const first = maneuverAssess(e, 'blue');
    expect(first.category).toBe('construction'); expect(first.intent).toMatchObject({ type: 'build_unit', unit: UnitType.City });
    expect(first.reason).toMatch(/gold [\d,]+ covers City cost/);
    e.step([{ side: 'blue', intent: first.intent! }]);
    for (let i = 0; i < 25; i++) e.step();
    expect(structures(e, 'blue', UnitType.City)).toBe(1);
    expect(e.game.config().maxTroops(e.player('blue'))).toBeGreaterThan(capBefore);
    // Blue's half of the 8-wide mainland has no second site 15 tiles from the first city: the next gold goes to an upgrade.
    const log = drive(e, ['blue'], 45 * 6);
    const upgrade = log.find((l) => l.decision?.category === 'upgrade');
    expect(upgrade).toBeDefined(); expect(upgrade!.decision!.intent).toMatchObject({ type: 'upgrade_structure', unit: UnitType.City });
    expect(e.player('blue').units(UnitType.City)[0]!.level()).toBeGreaterThanOrEqual(2);
  });

  test('construction: a defence post is ordered on the contact border and completes; a port follows on the coast', async () => {
    const e = await plains({ startingGold: 60_000 });
    let post: ManeuverAssessment | null = null;
    drive(e, ['blue', 'red'], 1350, (a) => { if (!post && a.category === 'construction' && (a.intent as { unit?: string }).unit === UnitType.DefensePost) post = a; });
    expect(post).not.toBeNull(); expect(post!.observed.inContact).toBe(true); expect(post!.reason).toMatch(/opponent adjacent on \d+ border tiles/);
    expect(structures(e, post!.side, UnitType.DefensePost) + structures(e, other(post!.side), UnitType.DefensePost)).toBeGreaterThan(0);
    // Coastal deployment on the legacy world option with ample gold: a port is built on an owned shore once a
    // shore site clear of the cities' 15-tile spacing exists (the 16x16 fixture has room for one structure per side).
    const sea = await ReplayEngine.create({ simulationId: 'MANV0001', map: 'world', startingGold: 1_500_000 });
    sea.step([{ side: 'blue', intent: { type: 'spawn', tile: spawnTarget(sea.game, 0.56, 0.34) } }, { side: 'red', intent: { type: 'spawn', tile: spawnTarget(sea.game, 0.19, 0.27) } }]);
    for (let i = 0; i < 5; i++) sea.step();
    const log = drive(sea, ['blue'], 45 * 40);
    const port = log.find((l) => l.decision?.category === 'construction' && (l.decision.intent as { unit?: string }).unit === UnitType.Port);
    expect(port).toBeDefined(); expect(port!.decision!.reason).toMatch(/\d+ owned shore tiles and 0 ports/);
    expect(structures(sea, 'blue', UnitType.Port)).toBeGreaterThanOrEqual(1);
    expect(sea.game.isShore(sea.player('blue').units(UnitType.Port)[0]!.tile())).toBe(true);
  });

  test('transport: once the home landmass is exhausted the rule sails to the island, the boat moves, lands and the island is taken; never to its own landmass', async () => {
    const e = await navalEngine();
    const lm = landmasses(e.game);
    expect(lm.label[ISLAND_SHORE]).not.toBe(lm.label[BLUE_SPAWN]); expect(lm.label[RED_SPAWN]).toBe(lm.label[BLUE_SPAWN]);
    const targets = transportTargets(e, 'blue');
    expect(targets.length).toBeGreaterThan(0); expect(targets[0]!.component).toBe(lm.label[ISLAND_SHORE]); expect(targets[0]!.target).toBe('unclaimed');
    let launch: ManeuverAssessment | null = null; const positions: number[] = []; let landedTick: number | null = null;
    for (let i = 0; i < 45 * 30; i++) {
      const orders: { side: Side; intent: unknown }[] = [];
      if (e.game.ticks() % MANEUVER_INTERVAL_TICKS === 0) {
        const a = maneuverAssess(e, 'blue');
        if (a.category === 'transport') { expect(lm.label[Number(a.intent!.dst)]).not.toBe(lm.label[BLUE_SPAWN]); launch ??= a; }
        if (a.intent) orders.push({ side: 'blue', intent: a.intent });
      }
      e.step(orders);
      const b = boats(e, 'blue')[0];
      if (b) positions.push(b.tile()); else if (positions.length && landedTick === null) landedTick = e.game.ticks();
    }
    expect(launch).not.toBeNull(); expect(launch!.reason).toMatch(/unclaimed shore 1[45],\d on a 6-tile landmass/);
    expect(new Set(positions).size).toBeGreaterThan(5); // the transport actually moved tick by tick
    expect(landedTick).not.toBeNull(); expect(landedTick! - launch!.tick).toBeLessThan(60);
    expect(boats(e, 'blue')).toHaveLength(0); // it landed (or returned); ownership shows which
    expect([ISLAND_SHORE, ISLAND_INTERIOR, T(14, 6), T(15, 6), T(14, 8), T(15, 8)].some((t) => e.game.ownerID(t) === e.player('blue').smallID())).toBe(true);
    // The island is now an owned landmass: no further transport is proposed toward it.
    expect(transportTargets(e, 'blue').some((t) => t.component === lm.label[ISLAND_SHORE])).toBe(false);
  });

  test('transport: no redundant launches toward a landmass already being sailed to, and the slot cap is respected', async () => {
    const e = await navalEngine();
    e.step([{ side: 'blue', intent: { type: 'boat', dst: ISLAND_SHORE, troops: 10 } }]);
    expect(boats(e, 'blue')).toHaveLength(1);
    expect(transportTargets(e, 'blue').some((t) => t.component === landmasses(e.game).label[ISLAND_SHORE])).toBe(false);
    e.step([{ side: 'blue', intent: { type: 'boat', dst: ISLAND_SHORE, troops: 10 } }]);
    // Two at sea: the rule never orders a third even when the mainland frontier is closed later.
    const log = drive(e, ['blue'], 45 * 2);
    expect(log.some((l) => l.decision?.category === 'transport')).toBe(false);
  });

  test('sea-separated: an island-only side with no neutral border crosses to the mainland and starts expanding there', async () => {
    const e = await ReplayEngine.create({ simulationId: 'MANV0002', map: 'ocean_and_land' });
    e.step([{ side: 'blue', intent: { type: 'spawn', tile: ISLAND_INTERIOR } }, { side: 'red', intent: { type: 'spawn', tile: RED_SPAWN } }]);
    for (let i = 0; i < 5; i++) e.step();
    const lm = landmasses(e.game); const blue = e.player('blue');
    expect([...blue.tiles()].every((t) => lm.label[t] === lm.label[ISLAND_SHORE])).toBe(true);
    const first = maneuverAssess(e, 'blue');
    expect(first.observed.neutralBorder).toBe(0); expect(first.category).toBe('transport'); expect(first.reason).toMatch(/no neutral land or attackable land border adjoins the 1 owned landmass/);
    // Red idles here so the crossing itself is what is measured (both sides scripted is the harness's job).
    const log = drive(e, ['blue'], 45 * 12);
    const mainlandOwned = [...blue.tiles()].filter((t) => lm.label[t] === lm.label[BLUE_SPAWN]).length;
    expect(mainlandOwned).toBeGreaterThan(0);
    expect(log.some((l) => l.side === 'blue' && l.decision?.category === 'expansion')).toBe(true);
    expect(maneuverAssess(e, 'blue').observed.ownedLandmasses).toBe(2);
  });

  test('sea-separated, both scripted: the opponent across the water is reached by transport and the contest is decided, not stalled', async () => {
    // A six-tile island against a 128-tile mainland is lopsided by construction; what matters is that the
    // mainland side crosses to the opponent instead of idling, and that elimination is never suppressed.
    const e = await ReplayEngine.create({ simulationId: 'MANV0002', map: 'ocean_and_land' });
    e.step([{ side: 'blue', intent: { type: 'spawn', tile: ISLAND_INTERIOR } }, { side: 'red', intent: { type: 'spawn', tile: RED_SPAWN } }]);
    for (let i = 0; i < 5; i++) e.step();
    const log = drive(e, ['blue', 'red'], 45 * 40);
    const redTransports = log.filter((l) => l.side === 'red' && l.decision?.category === 'transport');
    expect(redTransports.length).toBeGreaterThan(0);
    expect(redTransports.some((l) => /opponent shore/.test(l.decision!.reason))).toBe(true);
    expect(e.player('blue').isAlive() && e.player('red').isAlive()).toBe(false);
  });
});

describe(`${MANEUVER_CONTROLLER} determinism`, () => {
  test('side symmetry: the same geometry produces the same decision sequence whichever player runs the rule', async () => {
    const run = async (scripted: Side) => {
      const e = await ReplayEngine.create({ simulationId: 'MANV0001', map: 'ocean_and_land' });
      const spawn = scripted === 'blue' ? { blue: BLUE_SPAWN, red: RED_SPAWN } : { blue: RED_SPAWN, red: BLUE_SPAWN };
      e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawn.blue } }, { side: 'red', intent: { type: 'spawn', tile: spawn.red } }]);
      const log = drive(e, [scripted], 45 * 20);
      return { seq: log.map((l) => `${l.tick}:${l.decision?.category ?? '-'}:${l.decision ? JSON.stringify({ ...l.decision.intent, targetID: undefined, unitId: undefined }) : ''}`), tiles: e.player(scripted).numTilesOwned(), troops: Math.round(e.player(scripted).troops()) };
    };
    const asBlue = await run('blue'), asRed = await run('red');
    expect(asRed.seq).toEqual(asBlue.seq); expect(asRed.tiles).toBe(asBlue.tiles); expect(asRed.troops).toBe(asBlue.troops);
  });

  test('branch independence: decisions after reconstruction and on a branch equal the decisions made during original play', async () => {
    const e = await plains();
    const decisions = new Map<number, ManeuverAssessment>();
    drive(e, ['blue', 'red'], 900, (a, side) => { if (side === 'blue') decisions.set(a.tick, a); });
    const record = e.record();
    for (const tick of [45, 450, 855]) {
      const restored = await ReplayEngine.restore(record, tick, 'checkpoints');
      const again = maneuverAssess(restored, 'blue');
      expect(again).toEqual(decisions.get(tick));
    }
    // A branch that deviates at tick 450 yields a decision from its own state, not a replay of the recorded one.
    const branch = await ReplayEngine.restore(record, 450, 'checkpoints');
    branch.step([{ side: 'blue', intent: { type: 'attack', targetID: null, troops: Math.floor(branch.player('blue').troops() * 0.9) } }]);
    for (let i = 0; i < 44; i++) branch.step();
    expect(branch.game.ticks()).toBe(495);
    const onBranch = maneuverAssess(branch, 'blue');
    expect(onBranch.observed.troops).not.toBe(decisions.get(495)!.observed.troops);
    expect(onBranch.controller).toBe('maneuver/1');
    // The rule keeps no memory: a fresh engine replayed to the same tick decides identically twice more.
    const twice = await ReplayEngine.restore(record, 855, 'checkpoints');
    expect(maneuverAssess(twice, 'blue')).toEqual(maneuverAssess(twice, 'blue'));
  });

  test('rejection handling: a decision that goes stale is refused by the validator and the next pulse is unaffected', async () => {
    const e = await navalEngine();
    const stale = maneuverDecision(e, 'blue')!;
    expect(stale.category).toBe('expansion');
    // Main submits late: forces were spent meanwhile, so the recorded troop figure exceeds what is available.
    e.step([{ side: 'blue', intent: { type: 'attack', targetID: null, troops: Math.floor(e.player('blue').troops() * 0.95) } }]);
    expect(() => e.validate('blue', { ...stale.intent })).toThrow(/exceeds available forces/);
    for (let i = 0; i < 44; i++) e.step();
    const next = maneuverAssess(e, 'blue');
    expect(next.controller).toBe('maneuver/1'); expect(['reserve', 'expansion', 'construction', 'transport']).toContain(next.category);
    if (next.intent) expect(() => e.validate('blue', next.intent!)).not.toThrow();
    // A dead side and a spawn-phase side both yield null rather than an order the pipeline would reject.
    expect(maneuverDecision(await ReplayEngine.create({ map: 'plains' }), 'red')).toBeNull();
  });

  test('bounded work: decision time on the 16x16 fixture stays small and cadence and transport limits are explicit', async () => {
    const e = await navalEngine();
    const t0 = performance.now(); for (let i = 0; i < 50; i++) maneuverAssess(e, 'blue'); const ms = (performance.now() - t0) / 50;
    expect(ms).toBeLessThan(20);
    expect(MANEUVER_RULES.transportSlots).toBeLessThan(e.game.config().boatMaxNumber() + 1);
    expect(MANEUVER_INTERVAL_TICKS).toBe(45);
  });
});
