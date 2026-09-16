import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReplayEngine, TRANSPORT_ADMISSION, type EngineOptions, type EngineRecord, type ExecutionFeedbackEvent, type Side } from '../../src/engine/engine';
import { GameService } from '../../src/server/service';
import { selectScenario } from '../../src/scenarios/catalog';
import { spawnTarget } from '../../scripts/qualify-pacing';
import { UnitType } from '../../vendor/openfront/src/core/game/Game';
import { PathFinding } from '../../vendor/openfront/src/core/pathfinding/PathFinder';

console.debug = () => {}; console.warn = () => {};

/**
 * Fictional abstract-game fixtures. The reproduced failure (data/platform/transport-return-diagnosis-20260915.json, not read
 * here): on world-500 a Blue transport toward Beacon's centre (225,61) was admitted, launched from a shore at (121,79) whose
 * minimap cell has no water neighbour, and returned its forces on the next tick. Here Blue deploys at that shore on a fresh
 * pinned engine, which yields the same condition without depending on runtime data or operator evidence directories.
 */
const SCENARIO = selectScenario('crosscurrent-objectives/1');
const BEACON = 30725; // (225,61)
const ROUTED_LANDING = 625; // (125,1): unclaimed shore with a single-source route from the launch shore at this state
const REFUSAL = 'No water route from your launch shore to that landing';

/** Deploy `coastal` at (121,79) and the other side at its scenario spawn, then run past deployment with no orders. */
async function coastalState(options: Omit<EngineOptions, 'simulationId' | 'map'> = {}, coastal: Side = 'blue', feedback?: ExecutionFeedbackEvent[]) {
  const e = await ReplayEngine.create({ simulationId: 'AIPT0001', map: SCENARIO.map, ...options }, feedback ? { feedback: { listener: (ev) => feedback.push(ev) } } : {});
  const g = e.game, other: Side = coastal === 'blue' ? 'red' : 'blue';
  const spawn = (side: Side) => ({ side, intent: { type: 'spawn', tile: side === coastal ? g.ref(121, 79) : spawnTarget(g, ...SCENARIO.spawn[other]) } });
  e.step([spawn('blue'), spawn('red')]);
  while (g.inSpawnPhase() || g.ticks() < 60) e.step();
  return e;
}
const refusal = (e: ReplayEngine, side: Side, intent: Record<string, unknown>) => { try { e.validate(side, intent); return null; } catch (err) { return (err as Error).message; } };
const boat = (e: ReplayEngine, side: Side, dst: number) => ({ type: 'boat', dst, troops: Math.max(1, Math.floor(e.player(side).troops() * 0.1)) });
/** Exactly the pinned calls TransportShipExecution.init and its first move make. */
const launchRoute = (e: ReplayEngine, side: Side, dst: number) => {
  const p = e.player(side), landing = e.transportLanding(p, dst)!, launch = p.canBuild(UnitType.TransportShip, landing);
  return { landing, launch, route: launch === false ? null : PathFinding.Water(e.game).findPath(launch, landing) };
};
const roundTrip = (r: EngineRecord) => JSON.parse(JSON.stringify(r)) as EngineRecord;

describe('engine option', () => {
  it('stays absent unless set, persists by name through record and restore, and refuses an unknown version', async () => {
    const original = await ReplayEngine.create({ simulationId: 'OPT00001' });
    expect(original.options).not.toHaveProperty('transportAdmission');
    expect(original.record().options).toEqual({ simulationId: 'OPT00001', map: 'plains', startingGold: 60000 }); // byte-identical options to records made before the rule
    const versioned = await ReplayEngine.create({ simulationId: 'OPT00001', transportAdmission: TRANSPORT_ADMISSION });
    versioned.step(); original.step();
    expect(versioned.state().fingerprint).toBe(original.state().fingerprint); // admission is not simulation
    expect(roundTrip(versioned.record()).options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect((await ReplayEngine.restore(roundTrip(versioned.record()))).options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect((await ReplayEngine.restore(roundTrip(original.record()))).options).not.toHaveProperty('transportAdmission');
    await expect(ReplayEngine.create({ transportAdmission: 'launch-water-route/2' as never })).rejects.toThrow('Unknown transport admission option: launch-water-route/2');
  });

  it('restores a saved legacy trial checkpoint to its recorded fingerprints with or without the option', async () => {
    const cp = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/player-context-legacy/equal-sol-20260915/decisions/04/replay.json'), 'utf8')) as { record: EngineRecord };
    expect(cp.record.options).not.toHaveProperty('transportAdmission');
    const saved = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'every-tick');
    const opted = await ReplayEngine.restore({ ...cp.record, options: { ...cp.record.options, transportAdmission: TRANSPORT_ADMISSION } }, cp.record.turns.length, 'every-tick');
    expect(opted.state().fingerprint).toBe(saved.state().fingerprint);
    expect(saved.record().options).toEqual(cp.record.options);
  }, 60_000);
});

describe('launch-water-route/1 on the reproduced pathless transport', () => {
  it('without the option admits the order and the execution returns the forces on its first move', async () => {
    const feedback: ExecutionFeedbackEvent[] = [];
    const e = await coastalState({}, 'blue', feedback);
    const intent = boat(e, 'blue', BEACON);
    expect(launchRoute(e, 'blue', BEACON)).toMatchObject({ landing: BEACON, route: null });
    expect(launchRoute(e, 'blue', BEACON).launch).not.toBe(false);
    expect(refusal(e, 'blue', intent)).toBeNull();
    feedback.length = 0;
    e.step([{ side: 'blue', intent }]); e.step(); e.step();
    expect(feedback.map((ev) => ev.status)).toEqual(['transport-launched', 'transport-forces-returned']);
    expect(feedback[1]!.tick - feedback[0]!.tick).toBe(1);
  }, 60_000);

  it('refuses the same order, from either seat, before anything is committed', async () => {
    const e = await coastalState({ transportAdmission: TRANSPORT_ADMISSION });
    const intent = boat(e, 'blue', BEACON), before = { tick: e.game.ticks(), turns: e.turns.length, state: e.state(), record: JSON.stringify(e.record()) };
    expect(refusal(e, 'blue', intent)).toBe(REFUSAL);
    expect(() => e.step([{ side: 'blue', intent }])).toThrow(REFUSAL);
    expect({ tick: e.game.ticks(), turns: e.turns.length, state: e.state(), record: JSON.stringify(e.record()) }).toEqual(before);
    expect(e.player('blue').unitCount(UnitType.TransportShip)).toBe(0);
    // Red at the same shore meets the same validator (scripted controllers and model/human submissions all call validate).
    const red = await coastalState({ transportAdmission: TRANSPORT_ADMISSION }, 'red');
    expect(launchRoute(red, 'red', BEACON).route).toBeNull();
    expect(refusal(red, 'red', boat(red, 'red', BEACON))).toBe(REFUSAL);
  }, 60_000);

  it('admits a transport with a launch route, executes it without a return, and replays it exactly', async () => {
    const feedback: ExecutionFeedbackEvent[] = [];
    const e = await coastalState({ transportAdmission: TRANSPORT_ADMISSION }, 'blue', feedback);
    const route = launchRoute(e, 'blue', ROUTED_LANDING);
    expect(route.landing).toBe(ROUTED_LANDING); expect(route.route?.length).toBeGreaterThan(1);
    const intent = boat(e, 'blue', ROUTED_LANDING);
    expect(refusal(e, 'blue', intent)).toBeNull();
    feedback.length = 0; const forkTurns = e.turns.length;
    e.step([{ side: 'blue', intent }]);
    for (let i = 0; i < 20; i++) e.step();
    expect(feedback[0]?.status).toBe('transport-launched');
    expect(feedback.some((ev) => ev.status === 'transport-forces-returned')).toBe(false);
    const record = roundTrip(e.record());
    expect(record.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(record.turns.some((t) => t.intents.some((i) => i.type === 'boat' && i.dst === ROUTED_LANDING))).toBe(true);
    const restored = await ReplayEngine.restore(record, record.turns.length, 'every-tick');
    expect(restored.state().fingerprint).toBe(e.state().fingerprint);
    expect(restored.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    // A mid-record restore keeps the rule too: the refused order is refused again at the fork.
    const fork = await ReplayEngine.restore(record, forkTurns, 'checkpoints');
    expect(refusal(fork, 'blue', boat(fork, 'blue', BEACON))).toBe(REFUSAL);
  }, 60_000);
});

describe('added admission cost', () => {
  let original: ReplayEngine, versioned: ReplayEngine, dsts: number[] = [];
  beforeAll(async () => {
    [original, versioned] = await Promise.all([coastalState(), coastalState({ transportAdmission: TRANSPORT_ADMISSION })]);
    const g = original.game;
    for (let t = 0; t < g.width() * g.height() && dsts.length < 200; t += 3) if (g.isLand(t) && g.isShore(t) && !g.hasOwner(t) && refusal(original, 'blue', boat(original, 'blue', t)) === null) dsts.push(t);
  }, 60_000);

  it('adds at most one bounded single-source search per transport validation', () => {
    expect(dsts.length).toBe(200);
    const time = (e: ReplayEngine) => dsts.map((dst) => { const intent = boat(e, 'blue', dst); const t0 = performance.now(); const r = refusal(e, 'blue', intent); return { ms: performance.now() - t0, r }; });
    time(original); time(versioned); // warm both
    const rounds = [0, 1, 2].map(() => ({ original: time(original), versioned: time(versioned) }));
    const total = (xs: { ms: number }[]) => xs.reduce((n, x) => n + x.ms, 0);
    const meanAdded = rounds.reduce((n, r) => n + total(r.versioned) - total(r.original), 0) / (rounds.length * dsts.length);
    const maxVersioned = Math.max(...rounds.flatMap((r) => r.versioned.map((x) => x.ms)));
    const refused = rounds[0]!.versioned.filter((x) => x.r === REFUSAL).length;
    fs.writeFileSync(path.join(os.tmpdir(), 'replay-transport-admission-timing.json'), JSON.stringify({ orders: dsts.length, refusedByRule: refused, meanOriginalMs: total(rounds[0]!.original) / dsts.length, meanAddedMs: meanAdded, maxVersionedMs: maxVersioned }));
    expect(refused).toBeGreaterThan(0); // the timed set includes both outcomes of the added check
    expect(rounds[0]!.versioned.every((x) => x.r === null || x.r === REFUSAL)).toBe(true); // it only ever adds this refusal
    expect(meanAdded).toBeLessThan(5);
    expect(maxVersioned).toBeLessThan(250);
  });
});

describe('service creation, restart and branch', () => {
  const dirs: string[] = [], services: GameService[] = [];
  afterEach(() => { for (const s of services.splice(0)) s.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const service = (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-transport-admission-'))) => { if (!dirs.includes(dir)) dirs.push(dir); const s = new GameService(dir); services.push(s); return s; };

  it('opts new originals in, and branches and restarts inherit the recorded option exactly, including its absence', async () => {
    const s = service();
    const row = await s.create('Admission', 'plains');
    expect(row.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(s.world(row.id).engine.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    for (let i = 0; i < 3; i++) s.tick(s.world(row.id));
    expect(s.record(row.id).options.transportAdmission).toBe(TRANSPORT_ADMISSION);

    // A row saved before the rule: same shape, option absent.
    const legacy = await s.create('Before the rule', 'plains');
    for (let i = 0; i < 3; i++) s.tick(s.world(legacy.id));
    const legacyRow = s.world(legacy.id).row; delete legacyRow.options.transportAdmission; s.store.putExercise(legacyRow);

    const branch = await s.branch(row.id, 2, 'red');
    const legacyBranch = await s.branch(legacy.id, 2, 'red');
    expect(s.world(branch.id).row.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(s.world(branch.id).engine.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(s.world(legacyBranch.id).row.options).not.toHaveProperty('transportAdmission');
    expect(s.world(legacyBranch.id).engine.options).not.toHaveProperty('transportAdmission');
    expect((await s.historical(legacy.id, 2)).options).not.toHaveProperty('transportAdmission');
    const dir = dirs[0]!; s.close(); services.splice(0);

    const restarted = service(dir); await restarted.init(false);
    const optionOf = (id: string) => restarted.world(id).engine.options.transportAdmission;
    expect([optionOf(row.id), optionOf(branch.id), optionOf(legacy.id), optionOf(legacyBranch.id)]).toEqual([TRANSPORT_ADMISSION, TRANSPORT_ADMISSION, undefined, undefined]);
  }, 120_000);
});
