/**
 * Execution feedback: what the pinned engine actually did with an admitted order.
 *
 * Every assertion below is derived from observations made inside the specific execution the Executor
 * created for one recorded input occurrence (turnNumber + intentIndex + clientID). No test fabricates a
 * confirmation: when an event is expected and does not arrive within a bounded number of ticks, the
 * failure says the event was not observed, not that the order failed. The observed engine must produce
 * exactly the same simulation (fingerprints) as an unobserved control and as a reconstruction.
 */
import { describe, expect, it } from 'vitest';
import { CLIENTS, ReplayEngine, type EngineConstruction, type EngineOptions, type ExecutionFeedbackEvent } from '../src/engine/engine';
import { ExecutionFeedback, inputKeyString } from '../src/engine/execution-feedback';
import { ConstructionExecution } from '../vendor/openfront/src/core/execution/ConstructionExecution';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import type { Turn } from '../vendor/openfront/src/core/Schemas';
import { BLUE_SPAWN, ISLAND_SHORE, RED_SPAWN, SETTLE_TICKS, T, boat, navalEngine, snapshot } from './naval-fixture';

console.debug = () => {}; console.warn = () => {};

const BLUE = CLIENTS.blue, RED = CLIENTS.red;
/** Blue's mainland shore tile facing red's half; a Defense Post ordered here is placed exactly here. */
const BLUE_SHORE = T(7, 3);
const build = (side: 'blue' | 'red', unit: UnitType, tile: number) => ({ side, intent: { type: 'build_unit', unit, tile } });
const key = (turnNumber: number, intentIndex: number, clientID: string) => ({ turnNumber, intentIndex, clientID });
/** The shared naval fixture's deployment, with an explicit engine construction (the fixture only takes simulation options). */
async function navalEngineBuilt(construction: EngineConstruction, options: EngineOptions = {}): Promise<ReplayEngine> {
  const e = await ReplayEngine.create({ simulationId: 'NAVAL001', map: 'ocean_and_land', ...options }, construction);
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: BLUE_SPAWN } }, { side: 'red', intent: { type: 'spawn', tile: RED_SPAWN } }]);
  for (let i = 0; i < SETTLE_TICKS; i++) e.step();
  return e;
}

/** Step until an event with `status` for `keyString` is drained, or `maxTicks` elapse. Returns every event drained meanwhile. */
function stepUntil(e: ReplayEngine, keyString: string, status: string, maxTicks: number): { hit: ExecutionFeedbackEvent | undefined; seen: ExecutionFeedbackEvent[] } {
  const seen: ExecutionFeedbackEvent[] = [];
  for (let i = 0; i < maxTicks; i++) {
    e.step();
    const drained = e.feedback.drain(); seen.push(...drained);
    const hit = drained.find((ev) => ev.keyString === keyString && ev.status === status);
    if (hit) return { hit, seen };
  }
  return { hit: undefined, seen };
}
const observedOf = <K extends ExecutionFeedbackEvent['observed']['kind']>(ev: ExecutionFeedbackEvent | undefined, kind: K) => {
  expect(ev, 'expected event was not observed').toBeDefined();
  expect(ev!.observed.kind).toBe(kind);
  return ev!.observed as Extract<ExecutionFeedbackEvent['observed'], { kind: K }>;
};

describe('construction feedback is correlated to the exact input occurrence', () => {
  it('a successful City build reports the unit it created and, later, its completion under the same key', async () => {
    const e = await navalEngine({ startingGold: 600_000 });
    const turn = e.turns.length;
    e.step([build('blue', UnitType.City, BLUE_SPAWN)]);
    // The execution is only initialised on its admission tick; the structure appears on its first tick.
    expect(e.feedback.drain()).toEqual([]);
    expect(e.feedback.inFlight()).toEqual([key(turn, 0, BLUE)]);
    e.step();
    const [started, ...rest] = e.feedback.drain();
    expect(rest).toEqual([]);
    expect(started).toMatchObject({ schema: 'replay.execution-feedback', version: 1, key: key(turn, 0, BLUE), keyString: `${turn}:0:${BLUE}`, intent: 'build_unit', tick: turn + 1, status: 'construction-started' });
    const facts = observedOf(started, 'construction');
    const city = e.player('blue').units(UnitType.City);
    expect(city).toHaveLength(1);
    expect(facts).toMatchObject({ unit: UnitType.City, orderedTile: BLUE_SPAWN, unitId: city[0]!.id(), structureTile: city[0]!.tile(), underConstruction: true, structureActive: true, ownerClientID: BLUE, goldDelta: -125_000, costAtAttempt: 125_000, affordableAtAttempt: true });
    expect(facts.goldBefore - facts.goldAfter).toBe(125_000);
    const { hit, seen } = stepUntil(e, started!.keyString, 'construction-completed', 30);
    expect(seen.filter((ev) => ev.keyString !== started!.keyString)).toEqual([]);
    const done = observedOf(hit, 'construction');
    expect(done).toMatchObject({ unitId: city[0]!.id(), underConstruction: false, structureActive: true, ownerClientID: BLUE, goldDelta: 0 });
    expect(city[0]!.isUnderConstruction()).toBe(false);
    expect(e.feedback.inFlight()).toEqual([]);
  });

  it('two individually legal simultaneous Defense Post orders: the second occurrence is the one that never started, with the gold it saw', async () => {
    const e = await navalEngine({ startingGold: 60_000 });
    const blue = e.player('blue');
    expect(blue.canBuild(UnitType.DefensePost, BLUE_SHORE)).toBe(BLUE_SHORE);
    const turn = e.turns.length;
    e.step([build('blue', UnitType.DefensePost, BLUE_SHORE), build('blue', UnitType.DefensePost, BLUE_SHORE)]); // both admitted by the validator
    e.step();
    const events = e.feedback.drain();
    expect(events.map((ev) => [ev.keyString, ev.status])).toEqual([[`${turn}:0:${BLUE}`, 'construction-started'], [`${turn}:1:${BLUE}`, 'construction-not-started']]);
    const posts = blue.units(UnitType.DefensePost);
    expect(posts).toHaveLength(1);
    const first = observedOf(events[0], 'construction'), second = observedOf(events[1], 'construction');
    expect(first).toMatchObject({ unitId: posts[0]!.id(), goldDelta: -50_000, costAtAttempt: 50_000, affordableAtAttempt: true });
    // The second attempt saw the post-purchase reserve and the raised second-post price; nothing was charged.
    expect(second).toMatchObject({ goldBefore: first.goldAfter, goldDelta: 0, costAtAttempt: 100_000, affordableAtAttempt: false, newUnitsSeen: 0 });
    expect(second.unitId).toBeUndefined();
  });

  it('a Defense Post whose tile is taken by a landing mid-build is reported interrupted, naming the destroyer', async () => {
    const e = await navalEngine({ startingGold: 60_000 });
    while (e.player('red').isImmune()) e.step();
    expect(e.transportLanding(e.player('red'), BLUE_SHORE)).toBe(BLUE_SHORE);
    const turn = e.turns.length;
    e.step([build('blue', UnitType.DefensePost, BLUE_SHORE), boat('red', BLUE_SHORE, 500)]);
    const launched = e.feedback.drain();
    expect(launched.map((ev) => [ev.keyString, ev.status])).toEqual([[`${turn}:1:${RED}`, 'transport-launched']]);
    e.step();
    const [started] = e.feedback.drain();
    expect(started).toMatchObject({ keyString: `${turn}:0:${BLUE}`, status: 'construction-started' });
    const post = e.player('blue').units(UnitType.DefensePost)[0]!;
    const landed = stepUntil(e, `${turn}:1:${RED}`, 'transport-landed', 30);
    expect(observedOf(landed.hit, 'transport')).toMatchObject({ targetTile: BLUE_SHORE, targetOwnerBefore: BLUE, targetOwnerAfter: RED, boatActive: false });
    const interrupted = stepUntil(e, `${turn}:0:${BLUE}`, 'construction-interrupted', 5);
    const facts = observedOf(interrupted.hit, 'construction');
    expect(facts).toMatchObject({ unitId: post.id(), structureActive: false, destroyedByEnemy: true, destroyerClientID: RED, goldDelta: 0 });
    expect(facts.ticksObserved).toBeLessThan(50); // the 50-tick build never reached completion
    expect(post.isActive()).toBe(false);
    expect(e.feedback.inFlight()).toEqual([]);
  });
});

describe('transport feedback reports only what the execution itself did', () => {
  it('launch, movement and a landing that transferred the target tile', async () => {
    const e = await navalEngine();
    const turn = e.turns.length;
    e.step([boat('blue', ISLAND_SHORE, 40)]);
    const [launched] = e.feedback.drain();
    const boatUnit = snapshot(e).boats[0]!;
    expect(launched).toMatchObject({ key: key(turn, 0, BLUE), intent: 'boat', tick: turn, status: 'transport-launched' });
    const l = observedOf(launched, 'transport');
    expect(l).toMatchObject({ unitId: boatUnit.id, troopsEmbarked: 40, troopsDelta: -40, targetTile: ISLAND_SHORE, targetOwnerBefore: null, transportsAtSeaAtAttempt: 0, transportLimit: 3, launchTile: T(boatUnit.x, boatUnit.y) });
    let disappearedAt: number | null = null; let hit: ExecutionFeedbackEvent | undefined;
    for (let i = 0; i < 40 && !hit; i++) {
      e.step();
      if (disappearedAt === null && snapshot(e).boats.length === 0) disappearedAt = e.state().tick;
      hit = e.feedback.drain().find((ev) => ev.keyString === launched!.keyString && ev.status !== 'transport-launched');
    }
    expect(hit?.status).toBe('transport-landed');
    const facts = observedOf(hit, 'transport');
    expect(facts).toMatchObject({ unitId: boatUnit.id, boatActive: false, boatTile: ISLAND_SHORE, targetTile: ISLAND_SHORE, targetOwnerBefore: null, targetOwnerAfter: BLUE, troopsDelta: 0, retreatObserved: false });
    expect(facts.movesObserved).toBeGreaterThanOrEqual(7); // (7,y) to (14,7) is at least seven tile moves
    expect(hit!.tick + 1).toBe(disappearedAt); // the landing tick is the one on which the boat left the snapshot
    expect(e.game.ownerID(ISLAND_SHORE)).toBe(e.player('blue').smallID());
  });

  it('a recalled transport reports forces returned with the exact reserve delta, not the embarked amount', async () => {
    const e = await navalEngine();
    const turn = e.turns.length;
    e.step([boat('blue', ISLAND_SHORE, 40)]);
    e.step(); e.step();
    const id = snapshot(e).boats[0]!.id;
    e.step([{ side: 'blue', intent: { type: 'cancel_boat', unitID: id } }]);
    e.feedback.drain();
    const { hit } = stepUntil(e, `${turn}:0:${BLUE}`, 'transport-forces-returned', 30);
    const facts = observedOf(hit, 'transport');
    expect(facts).toMatchObject({ unitId: id, boatActive: false, retreatObserved: true, troopsEmbarked: 40, troopsDelta: 30 }); // 25% retreat malus, as the engine charged it
    expect(facts.targetOwnerBefore).toBe(BLUE); expect(facts.targetOwnerAfter).toBe(BLUE);
    expect(e.game.ownerID(facts.targetTile!)).toBe(e.player('blue').smallID());
  });

  it('a fourth simultaneous order is admitted but never launches; the observation says which one and why it saw the limit', async () => {
    const e = await navalEngine();
    const turn = e.turns.length;
    e.step([boat('blue', ISLAND_SHORE, 5), boat('blue', ISLAND_SHORE, 5), boat('blue', ISLAND_SHORE, 5), boat('blue', ISLAND_SHORE, 5)]);
    const events = e.feedback.drain();
    expect(events.map((ev) => [ev.key.intentIndex, ev.status])).toEqual([[0, 'transport-launched'], [1, 'transport-launched'], [2, 'transport-launched'], [3, 'transport-not-launched']]);
    expect(new Set(events.slice(0, 3).map((ev) => (ev.observed as { unitId?: number }).unitId)).size).toBe(3);
    expect(observedOf(events[3], 'transport')).toMatchObject({ transportsAtSeaAtAttempt: 3, transportLimit: 3, troopsDelta: 0 });
    expect(events[3]!.key).toEqual(key(turn, 3, BLUE));
    expect(snapshot(e).boats).toHaveLength(3);
  });

  it('a boat that vanishes for a reason the execution did not cause ends unconfirmed: no landing, no refund claimed', async () => {
    const e = await navalEngine();
    const turn = e.turns.length;
    e.step([boat('blue', ISLAND_SHORE, 40)]);
    e.step();
    e.feedback.drain();
    // Test-side removal, outside any execution: the observer must not attribute this to the transport.
    e.player('blue').units(UnitType.TransportShip)[0]!.delete(false);
    const { hit, seen } = stepUntil(e, `${turn}:0:${BLUE}`, 'transport-ended-unconfirmed', 3);
    expect(seen).toHaveLength(1);
    const facts = observedOf(hit, 'transport');
    expect(facts).toMatchObject({ boatActive: false, destroyedByEnemy: false, targetOwnerAfter: null, troopsDelta: 0 }); // nothing refunded by this execution, nothing landed
    expect(e.game.hasOwner(ISLAND_SHORE)).toBe(false);
    expect(e.feedback.inFlight()).toEqual([]);
  });
});

describe('isolation, reconstruction and controls', () => {
  const orders = (e: ReplayEngine) => { e.step([build('blue', UnitType.Port, BLUE_SHORE), boat('blue', ISLAND_SHORE, 20)]); };
  const run = (e: ReplayEngine, ticks: number) => { const events: ExecutionFeedbackEvent[] = []; const prints: string[] = []; for (let i = 0; i < ticks; i++) { e.step(); events.push(...e.feedback.drain()); prints.push(e.state().fingerprint); } return { events, prints }; };

  it('two interleaved exercises each see only their own executions, and match a solo run', async () => {
    const solo = await navalEngine({ startingGold: 600_000 });
    orders(solo); const soloRun = run(solo, 60);
    const a = await navalEngine({ startingGold: 600_000 });
    const b = await navalEngine({ startingGold: 600_000, simulationId: 'NAVAL002' });
    orders(a); orders(b);
    const ea: ExecutionFeedbackEvent[] = [], eb: ExecutionFeedbackEvent[] = [], pa: string[] = [];
    for (let i = 0; i < 60; i++) { a.step(); b.step(); ea.push(...a.feedback.drain()); eb.push(...b.feedback.drain()); pa.push(a.state().fingerprint); }
    expect(ea).toEqual(soloRun.events);
    expect(pa).toEqual(soloRun.prints);
    expect(ea.map((ev) => ev.status)).toEqual(['transport-launched', 'construction-started', 'transport-landed', 'construction-completed']);
    expect(eb.map((ev) => ev.status)).toEqual(ea.map((ev) => ev.status));
    // Each engine's construction events name a port that exists in that engine and is complete there.
    for (const [events, engine] of [[ea, a], [eb, b]] as const) {
      const unitId = (events.find((ev) => ev.status === 'construction-completed')!.observed as { unitId: number }).unitId;
      const port = engine.player('blue').units(UnitType.Port).find((u) => u.id() === unitId);
      expect(port?.isUnderConstruction()).toBe(false);
    }
    expect(b.state().fingerprint).not.toBe(a.state().fingerprint); // different simulation IDs, different games
  });

  it('reconstruction while a build and a transport are in flight discards history but observes their later outcome', async () => {
    const live = await navalEngine({ startingGold: 600_000 });
    orders(live);
    const inflight = run(live, 3);
    expect(inflight.events.map((ev) => ev.status)).toEqual(['transport-launched', 'construction-started']);
    const record = live.record();
    const restored = await ReplayEngine.restore(record);
    expect(restored.feedback.drain()).toEqual([]);
    expect(restored.feedback.dropped()).toBe(0);
    expect(restored.feedback.inFlight()).toEqual(live.feedback.inFlight());
    expect(restored.feedback.inFlight().map(inputKeyString).sort()).toEqual([`${record.turns.length - 4}:0:${BLUE}`, `${record.turns.length - 4}:1:${BLUE}`]);
    const l = run(live, 60), r = run(restored, 60);
    expect(r.prints).toEqual(l.prints);
    expect(r.events).toEqual(l.events);
    expect(r.events.map((ev) => ev.status)).toEqual(['transport-landed', 'construction-completed']);
    // Seeking to before the orders leaves nothing in flight, and the recorded fingerprints are unchanged by observation.
    const earlier = await ReplayEngine.restore(record, record.turns.length - 4);
    expect(earlier.feedback.inFlight()).toEqual([]);
    expect(earlier.feedback.drain()).toEqual([]);
  });

  it('an unobserved control produces identical fingerprints and continued behaviour; records restore across both modes', async () => {
    const opts: EngineOptions = { startingGold: 600_000 };
    const observed = await navalEngine(opts);
    const control = await navalEngineBuilt({ observeExecution: false }, opts);
    expect(control.feedback.observed).toBe(false);
    expect(control.state().fingerprint).toBe(observed.state().fingerprint);
    orders(observed); orders(control);
    const o = run(observed, 60), c = run(control, 60);
    expect(c.prints).toEqual(o.prints);
    expect(c.events).toEqual([]);
    expect(control.feedback.inFlight()).toEqual([]);
    expect(o.events.map((ev) => ev.status)).toEqual(['transport-launched', 'construction-started', 'transport-landed', 'construction-completed']);
    expect(observed.record()).toEqual(control.record());
    expect(JSON.stringify(observed.options)).toBe(JSON.stringify(control.options));
    const viaControl = await ReplayEngine.restore(observed.record(), undefined, 'every-tick', { observeExecution: false });
    const viaObserved = await ReplayEngine.restore(control.record());
    expect(viaControl.state().fingerprint).toBe(observed.state().fingerprint);
    expect(viaObserved.state().fingerprint).toBe(observed.state().fingerprint);
    // Continued behaviour after reconstruction is the same in both modes.
    expect(run(viaControl, 20).prints).toEqual(run(viaObserved, 20).prints);
  });

  it('undrained feedback is bounded: the oldest events are dropped and counted', async () => {
    const e = await navalEngineBuilt({ feedback: { capacity: 2 } });
    e.step([boat('blue', ISLAND_SHORE, 1), boat('blue', ISLAND_SHORE, 1), boat('blue', ISLAND_SHORE, 1), boat('blue', ISLAND_SHORE, 1)]); // four events on one tick
    expect(e.feedback.pending()).toBe(2);
    expect(e.feedback.dropped()).toBe(2);
    expect(e.feedback.drain().map((ev) => [ev.key.intentIndex, ev.status])).toEqual([[2, 'transport-launched'], [3, 'transport-not-launched']]); // the newest survive
    for (let i = 0; i < 30; i++) e.step(); // three landings arrive undrained
    expect(e.feedback.pending()).toBe(2);
    expect(e.feedback.dropped()).toBe(3);
    expect(e.feedback.inFlight()).toEqual([]);
    expect(e.feedback.drain()).toHaveLength(2);
    expect(e.feedback.pending()).toBe(0);
  });

  it('an observer failure is counted and never alters engine progression', async () => {
    let calls = 0;
    const faulty = await navalEngineBuilt({ feedback: { listener: () => { calls++; throw new Error('listener exploded'); } } }, { startingGold: 600_000 });
    const control = await navalEngine({ startingGold: 600_000 });
    orders(faulty); orders(control);
    const f = run(faulty, 60), c = run(control, 60);
    expect(f.prints).toEqual(c.prints);
    expect(f.events).toEqual(c.events);
    expect(calls).toBe(4);
    expect(faulty.feedback.observerFailures()).toEqual({ count: 4, last: 'listener exploded' });
    expect(control.feedback.observerFailures()).toEqual({ count: 0 });
  });

  it('the wrapper keeps instanceof and this, and re-throws the engine\'s own exception unchanged', async () => {
    const e = await navalEngine();
    const feedback = new ExecutionFeedback(true);
    const real = new ConstructionExecution(e.player('blue'), UnitType.City, BLUE_SPAWN);
    const turn: Turn = { turnNumber: 99, intents: [{ type: 'build_unit', unit: UnitType.City, tile: BLUE_SPAWN, clientID: BLUE } as Turn['intents'][number]] };
    const [wrapped] = feedback.attach(turn, [real]);
    expect(wrapped).not.toBe(real);
    expect(wrapped instanceof ConstructionExecution).toBe(true);
    expect(wrapped!.isActive()).toBe(true);
    expect(feedback.inFlight()).toEqual([key(99, 0, BLUE)]);
    // The observed execution never affects the real game: it is not added to it here.
    wrapped!.init(e.game, e.game.ticks());
    const boom = new Error('engine tick failed');
    (real as unknown as { tick: () => void }).tick = () => { throw boom; };
    expect(() => wrapped!.tick(e.game.ticks())).toThrow(boom);
    expect(feedback.observerFailures().count).toBe(0);
    const events = feedback.drain();
    expect(events.map((ev) => ev.status)).toEqual([]); // no effect was observed, so nothing was claimed
    expect(feedback.inFlight()).toEqual([key(99, 0, BLUE)]);
  });
});
