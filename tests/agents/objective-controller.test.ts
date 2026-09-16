/**
 * `objectives/1` scripted opponent: every order is admitted by the engine validator and executed by the
 * pinned engine on the recorded world-500 station layout. Tests check exact chosen inputs (destination
 * tiles, force counts) against the board and the observed quantities, the reserve tradeoff at a real
 * tally, real transport landings, defence of a threatened station, deterministic reconstruction, board
 * negative controls and observer/control independence. Nothing in this file writes evidence.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIENTS, ReplayEngine, type EngineRecord, type Side } from '../../src/engine/engine';
import { OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS, OBJECTIVE_RULES, checkObjectiveBoard, objectiveAssess, objectiveDecision, type ObjectiveAssessment } from '../../src/agents/objective-controller';
import { MANEUVER_RULES, landmasses } from '../../src/agents/scripted-controller';
import { NETWORK_RULES, advanceNetwork, createNetworkLayout, initialNetwork, networkView, type NetworkState, type NetworkView, type Station } from '../../src/campaign/network';
import { UnitType } from '../../vendor/openfront/src/core/game/Game';
import { rawStep, spawnTarget } from '../../scripts/qualify-pacing';
import { OBJECTIVE_EVIDENCE_FILE, OBJECTIVE_SCENARIO, objectiveEvidenceHeader, reconstruct, runObjectiveMatchup, writeObjectiveEvidence } from '../../scripts/qualify-objective-controller';

console.debug = () => {}; console.warn = () => {};

/** The exact crosscurrent-network/1 deployment on world-500, with a board advanced every tick like the service does. */
interface World { e: ReplayEngine; layout: Station[]; state: NetworkState; view: NetworkView }
async function world(simulationId = 'OBJT0001', startingGold?: number): Promise<World> {
  const e = await ReplayEngine.create({ simulationId, map: OBJECTIVE_SCENARIO.map, ...(startingGold !== undefined ? { startingGold } : {}) });
  const layout = createNetworkLayout(e);
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: spawnTarget(e.game, ...OBJECTIVE_SCENARIO.spawn.blue) } }, { side: 'red', intent: { type: 'spawn', tile: spawnTarget(e.game, ...OBJECTIVE_SCENARIO.spawn.red) } }]);
  const w: World = { e, layout, state: initialNetwork(1), view: null! };
  step(w); return w;
}
/** One engine tick through the validated turn path, then the board for that tick. */
function step(w: World, orders: { side: Side; intent: unknown }[] = []) { rawStep(w.e, orders); const a = advanceNetwork(w.e, w.layout, w.state); w.state = a.state; w.view = a.view; return a; }
/** Idle ticks (no orders) until the engine reports `tick`. */
function until(w: World, tick: number) { let a = null as ReturnType<typeof step> | null; while (w.e.game.ticks() < tick) a = step(w); return a; }
/** Advance `ticks`, letting the listed sides issue the controller's one order every 45 ticks. */
function drive(w: World, sides: Side[], ticks: number, onDecision?: (a: ObjectiveAssessment) => void) {
  const log: ObjectiveAssessment[] = [];
  for (let i = 0; i < ticks; i++) {
    const orders: { side: Side; intent: unknown }[] = [];
    if (w.e.game.ticks() % OBJECTIVE_INTERVAL_TICKS === 0) for (const side of sides) { const a = objectiveAssess(w.e, side, w.view); log.push(a); onDecision?.(a); if (a.intent) orders.push({ side, intent: a.intent }); }
    step(w, orders);
  }
  return log;
}
const station = (w: World, id: string) => w.layout.find((s) => s.id === id)!;
/** A what-if board for the same tick and ownership with the priority flag moved; used only to isolate the priority effect. */
const withPriority = (v: NetworkView, id: string): NetworkView => ({ ...v, priorityId: id, stations: v.stations.map((s) => ({ ...s, priority: s.id === id })) });
/** Blue driven by the controller alone (red idle) to the tick before a pulse, then a human-style boat toward unclaimed Ember drops the home reserve to `ratio` of cap without a land commitment. */
async function dippedBlue(pulseTick: number, ratio: number) {
  const w = await world(); drive(w, ['blue'], pulseTick - 1 - w.e.game.ticks());
  expect(w.e.game.ticks()).toBe(pulseTick - 1);
  const p = w.e.player('blue'); const cap = w.e.game.config().maxTroops(p); const ember = station(w, 'ember').tile;
  expect(w.e.game.hasOwner(ember)).toBe(false); expect(w.e.transportRefusal(p, ember)).toBeNull();
  step(w, [{ side: 'blue', intent: { type: 'boat', dst: ember, troops: Math.floor(p.troops() - cap * ratio) } }]);
  expect(w.e.game.ticks()).toBe(pulseTick);
  return w;
}
const bandShare = (ratio: number) => [...MANEUVER_RULES.commitShare].find(([f]) => ratio >= f)?.[1] ?? 0;

describe(`${OBJECTIVE_CONTROLLER} board contract`, () => {
  test('silent before deployment, one validated order per pulse afterwards, no mutation, repeatable, objectiveId carried', async () => {
    const e = await ReplayEngine.create({ simulationId: 'OBJT0001', map: OBJECTIVE_SCENARIO.map }); const layout = createNetworkLayout(e);
    const v0 = networkView(e, layout, initialNetwork(0));
    expect(objectiveDecision(e, 'blue', v0)).toBeNull();
    expect(objectiveAssess(e, 'blue', v0)).toMatchObject({ controller: 'objectives/1', category: 'none', intent: null, source: 'none' });
    const w = await world(); until(w, 45);
    expect(w.e.game.ticks()).toBe(45);
    const before = w.e.state().fingerprint;
    const a = objectiveAssess(w.e, 'blue', w.view); const again = objectiveAssess(w.e, 'blue', w.view);
    expect(again).toEqual(a); expect(w.e.state().fingerprint).toBe(before);
    expect(a.intent).not.toBeNull(); expect(() => w.e.validate('blue', a.intent!)).not.toThrow();
    const d = objectiveDecision(w.e, 'blue', w.view)!;
    expect(d).toEqual({ intent: a.intent, reason: a.reason, category: a.category, ...(a.objectiveId ? { objectiveId: a.objectiveId } : {}) });
    expect(['expansion', 'attack', 'reserve', 'construction', 'upgrade', 'transport', 'recall']).toContain(d.category);
    // Observed quantities come from the board handed in, not a recomputation.
    expect(a.observed.scores).toEqual(w.view.scores); expect(a.observed.priorityId).toBe(w.view.priorityId);
    expect(a.observed.stations.map((s) => s.id)).toEqual(NETWORK_RULES.stations.map((s) => s.id));
  });

  test('negative controls: a missing, foreign, stale or mismatched board fails clearly instead of using other numbers', async () => {
    const w = await world(); until(w, 45);
    expect(() => objectiveAssess(w.e, 'blue', null as unknown as NetworkView)).toThrow('Objective board is missing');
    expect(() => objectiveAssess(w.e, 'blue', undefined as unknown as NetworkView)).toThrow('Objective board is missing');
    expect(() => objectiveAssess(w.e, 'blue', { ...w.view, rules: { ...w.view.rules, id: 'other-rules/9' } } as unknown as NetworkView)).toThrow(/rules other-rules\/9 are not stations-and-reserves\/1/);
    const stale = w.view; step(w);
    expect(w.view.tick).toBe(stale.tick + 1);
    expect(() => objectiveAssess(w.e, 'blue', stale)).toThrow(`Objective board is stale: board tick ${stale.tick}, engine tick ${stale.tick + 1}`);
    expect(() => objectiveDecision(w.e, 'blue', stale)).toThrow(/stale/);
    expect(() => objectiveAssess(w.e, 'blue', { ...w.view, stations: [] })).toThrow('Objective board has no stations');
    // Same tick, different world: a board advanced on a branch whose ownership differs is refused.
    const record = w.e.record(); const branch = await ReplayEngine.restore(record, 30, 'checkpoints'); const bl = createNetworkLayout(branch);
    let bs = initialNetwork(30); let bv: NetworkView | null = null;
    rawStep(branch, [{ side: 'blue', intent: { type: 'attack', targetID: null, troops: Math.floor(branch.player('blue').troops() * 0.6) } }]);
    for (;;) { const a = advanceNetwork(branch, bl, bs); bs = a.state; bv = a.view; if (branch.game.ticks() === w.e.game.ticks()) break; rawStep(branch); }
    expect(bv!.tick).toBe(w.view.tick);
    expect(bv!.stations.find((s) => s.id === 'aster')!.held.blue).not.toBe(w.view.stations.find((s) => s.id === 'aster')!.held.blue);
    expect(() => objectiveAssess(w.e, 'blue', bv!)).toThrow(/does not match engine ownership at station aster/);
    expect(checkObjectiveBoard(w.e, w.view)).toBe(w.view);
  });
});

describe(`${OBJECTIVE_CONTROLLER} the board changes the order`, () => {
  test('sea move targets the exact station tile; moving the priority flag changes the destination; a real priority rotation is read from the board', async () => {
    const w = await world();
    let first: ObjectiveAssessment | null = null;
    drive(w, ['blue'], 400, (a) => { if (!first && a.category === 'transport') first = a; });
    expect(first).not.toBeNull();
    const a = first! as ObjectiveAssessment;
    // Blue starts inland: the first sea move comes only once an owned ocean shore exists, and it aims at a station's own tile.
    expect(a.observed.ownShores).toBeGreaterThan(0);
    expect(a.objectiveId).toBe('beacon'); expect(a.intent).toMatchObject({ type: 'boat', dst: station(w, 'beacon').tile });
    expect(Number(a.intent!.troops)).toBe(Math.min(Math.floor(a.observed.troops * OBJECTIVE_RULES.transportShare), a.observed.spendableTroops));
    expect(a.reason).toMatch(/station beacon \(uncontrolled, worth 1\/tally\) lies on a 19,743-tile landmass/);
    // Reconstruct that exact tick and hand in a what-if board with Ember as priority: same engine state, different destination.
    const record = w.e.record(); const r = await ReplayEngine.restore(record, a.tick, 'checkpoints');
    let rs = initialNetwork(1); let rv: NetworkView | null = null;
    const again = await ReplayEngine.create(record.options); const al = createNetworkLayout(again);
    for (const turn of record.turns.slice(0, a.tick)) { rawStep(again, turn.intents.map((intent) => ({ side: intent.clientID === CLIENTS.blue ? 'blue' : 'red', intent }))); if (again.game.ticks() > 1) { const adv = advanceNetwork(again, al, rs); rs = adv.state; rv = adv.view; } }
    expect(again.state().fingerprint).toBe(r.state().fingerprint);
    const real = objectiveAssess(r, 'blue', rv!);
    expect(real).toEqual(a);
    const ember = objectiveAssess(r, 'blue', withPriority(rv!, 'ember'));
    expect(ember.category).toBe('transport'); expect(ember.objectiveId).toBe('ember'); expect(ember.intent).toMatchObject({ dst: station(w, 'ember').tile });
    expect(ember.observed.stations.find((s) => s.id === 'ember')!.value).toBe(NETWORK_RULES.stationPoints + NETWORK_RULES.priorityBonus);
    expect(ember.reason).toMatch(/station ember \(uncontrolled, worth 3\/tally, priority\)/);
    expect(r.state().fingerprint).toBe(again.state().fingerprint);
    // The real board rotates priority at tick 1801; the assessment reads the upcoming station from the board's next-priority tick.
    expect(rv!.priorityId).toBe('aster'); expect(rv!.nextPriorityTick).toBe(1801);
    expect(real.observed.nextPriorityId).toBe('beacon'); expect(real.observed.ticksToPriority).toBe(1801 - a.tick);
    expect(real.observed.stations.find((s) => s.id === 'beacon')!.upcomingPriority).toBe(false); // 900-tick lookahead not yet reached
  });

  test('no redundant boats: while a transport sails for a station landmass no second one is ordered there; the boat lands on that landmass and the station is taken', async () => {
    const r = await runObjectiveMatchup('objectives-vs-maneuver', { capTicks: 900, verifyReconstruction: false });
    const lm = landmasses((await ReplayEngine.create({ map: OBJECTIVE_SCENARIO.map })).game);
    const boats = r.decisions.filter((d) => d.side === 'blue' && d.intent?.type === 'boat');
    expect(boats.length).toBeGreaterThan(0);
    const beacon = boats.find((d) => d.objectiveId === 'beacon')!;
    expect(beacon.admitted).toBe(true); expect(beacon.rejectedAtTick).toBe(false);
    expect(beacon.observed.map((o) => o.status)).toEqual(['transport-launched', 'transport-landed']);
    const landedAt = beacon.observed[1]!.tick;
    for (const d of boats) if (d.tick > beacon.tick && d.tick < landedAt) expect(lm.label[Number(d.intent!.dst)]).not.toBe(lm.label[Number(beacon.intent!.dst)]);
    expect(r.stationOwnershipChanges.find((c) => c.station === 'beacon')).toMatchObject({ from: null, to: 'blue' });
    expect(r.stationOwnershipChanges.find((c) => c.station === 'beacon')!.tick).toBeGreaterThan(landedAt);
    expect(r.activity.blue.transports.landingsOnStationLandmass).toBeGreaterThan(0);
    expect(r.activity.blue.rejectedAtSubmission + r.activity.blue.rejectedAtTick).toBe(0);
    // Once blue owns tiles on Beacon's landmass the board marks it reachable by land and no boat is sent for it.
    const later = r.decisions.filter((d) => d.side === 'blue' && d.tick > landedAt && d.objectiveId === 'beacon');
    expect(later.length).toBeGreaterThan(0); expect(later.every((d) => d.intent?.type !== 'boat')).toBe(true);
  });

  test('reserve tradeoff at a real tally: the guarded order is clipped to the exact spendable figure and keeps the 2-point bonus; a larger legal commitment at the same tick forfeits it', async () => {
    const w = await dippedBlue(570, 0.305);
    expect(w.view.nextAwardTick).toBe(600);
    const a = objectiveAssess(w.e, 'blue', w.view); const o = a.observed;
    expect(o.controlledStations).toContain('aster'); expect(o.guardActive).toBe(true); expect(o.ticksToAward).toBe(30);
    expect(o.reserveRatio).toBeGreaterThanOrEqual(0.3); expect(o.reserveRatio).toBeLessThan(0.32);
    expect(o.guardFloorTroops).toBe(Math.ceil(o.maxTroops * 0.32));
    expect(o.guardGrowthCredit).toBe(Math.floor(o.troopGrowthPerTick * 30 * OBJECTIVE_RULES.reserveGrowthCredit));
    expect(o.spendableTroops).toBe(Math.floor(o.troops + o.guardGrowthCredit - o.guardFloorTroops));
    expect(['expansion', 'attack', 'transport']).toContain(a.category);
    const share = a.category === 'transport' ? OBJECTIVE_RULES.transportShare : bandShare(o.reserveRatio);
    expect(Math.floor(o.troops * share)).toBeGreaterThan(o.spendableTroops);
    expect(Number(a.intent!.troops)).toBe(o.spendableTroops);
    expect(a.reason).toMatch(/tally in 30 ticks, keeping [\d,]+ \(32% of cap [\d,]+\) at home with [\d,]+ growth credited/);
    // Execute the clipped order through the engine to the tally: reserve bonus earned.
    const record = w.e.record();
    let last = step(w, [{ side: 'blue', intent: a.intent! }]);
    while (w.e.game.ticks() < 600) last = step(w);
    expect(last.award!.blue.reserve).toBe(NETWORK_RULES.reserveBonus); expect(last.view.reserve.blue.fraction).toBeGreaterThanOrEqual(0.3);
    // Counterfactual on the same record: the reference's top-band share (35%) at the same tick, a legal order, forfeits the bonus.
    const c = await ReplayEngine.restore(record, 570, 'checkpoints'); const cl = createNetworkLayout(c); let cs = initialNetwork(570);
    const bigger = { type: 'attack', targetID: null, troops: Math.floor(o.troops * MANEUVER_RULES.commitShare[0]![1]) };
    expect(() => c.validate('blue', bigger)).not.toThrow();
    rawStep(c, [{ side: 'blue', intent: bigger }]); let ca = advanceNetwork(c, cl, cs); cs = ca.state;
    while (c.game.ticks() < 600) { rawStep(c); ca = advanceNetwork(c, cl, cs); cs = ca.state; }
    expect(ca.award!.blue.reserve).toBe(0); expect(ca.view.reserve.blue.fraction).toBeLessThan(0.3);
    expect(ca.award!.blue.stations).toBe(last.award!.blue.stations);
  });

  test('a reserve just under 30% at a guarded pulse is held and recovers the bonus; the same dip outside the window is spent by the reserve band', async () => {
    const w = await dippedBlue(570, 0.28);
    const a = objectiveAssess(w.e, 'blue', w.view);
    expect(a.observed.reserveRatio).toBeLessThan(0.3); expect(a.observed.reserveRatio).toBeGreaterThanOrEqual(0.25);
    expect(a.category).toBe('reserve'); expect(a.intent).toBeNull(); expect(a.objectiveId).toBe('aster');
    expect(a.reason).toMatch(/is just under 30% with the tally 30 ticks away while holding aster(, \w+)*; holding this pulse for the 2-point reserve bonus/);
    let last = step(w); while (w.e.game.ticks() < 600) last = step(w);
    expect(last.view.reserve.blue.fraction).toBeGreaterThanOrEqual(0.3); expect(last.award!.blue.reserve).toBe(NETWORK_RULES.reserveBonus);
    // Unguarded pulse (tally 120 ticks away): the same dip is spent at the 10% band share, capped by the open frontier.
    const u = await dippedBlue(480, 0.28);
    const b = objectiveAssess(u.e, 'blue', u.view);
    expect(b.observed.ticksToAward).toBe(120); expect(b.observed.guardActive).toBe(false); expect(b.observed.spendableTroops).toBe(Math.floor(b.observed.troops));
    expect(b.category).toBe('expansion'); expect(bandShare(b.observed.reserveRatio)).toBe(0.1);
    expect(Number(b.intent!.troops)).toBe(Math.min(Math.floor(b.observed.troops * 0.1), b.observed.neutralBorder * OBJECTIVE_RULES.expansionTroopsPerBorderTile - b.observed.committedNeutralTroops));
  });

  test('a threatened controlled station gets a defence post near its centre, ordered through the validator and built by the engine (gold-gated: shown on a richer ledger of the same recorded public state)', async () => {
    // In the characterization runs the reference's contact-line posts and cities consume gold first, so the station
    // rule rarely holds the 50,000+ it needs. Replaying the recorded mirror turns in a world that differs only in
    // starting gold reproduces the same ownership with a richer ledger; there the rule fires and the engine builds.
    const r = await runObjectiveMatchup('objectives-vs-objectives', { capTicks: 3600, verifyReconstruction: false });
    const e = await ReplayEngine.create({ ...r.record.options, startingGold: 3_000_000 }); const w: World = { e, layout: createNetworkLayout(e), state: initialNetwork(1), view: null! };
    const attempts: { a: ObjectiveAssessment; key: string; statuses: string[]; built: { tile: number } | null; sourceCategory: string }[] = [];
    const events = new Map<string, string[]>(); const drain = () => { for (const x of e.feedback.drain()) events.set(x.keyString, [...(events.get(x.keyString) ?? []), x.status]); };
    for (const turn of r.record.turns) {
      if (attempts.some((t) => t.built)) break;
      const orders = turn.intents.map((intent) => ({ side: (intent.clientID === CLIENTS.blue ? 'blue' : 'red') as Side, intent: intent as unknown }));
      if (e.game.ticks() <= 1 || e.game.ticks() % OBJECTIVE_INTERVAL_TICKS !== 0) { rawStep(e, orders); if (e.game.ticks() > 1) { const adv = advanceNetwork(e, w.layout, w.state); w.state = adv.state; w.view = adv.view; } drain(); continue; }
      let watch: { a: ObjectiveAssessment; before: Set<number> } | null = null;
      for (const side of ['blue', 'red'] as Side[]) { const a = objectiveAssess(e, side, w.view); if (a.source === 'objectives/1' && a.category === 'construction') { watch = { a, before: new Set(e.player(side).units(UnitType.DefensePost).map((u) => u.id())) }; break; } }
      if (!watch) { step(w, orders); drain(); continue; }
      // Branch here: the station-defence order replaces the recorded orders of this turn; both sides then follow the rule.
      const key = `${e.turns.length}:0:${CLIENTS[watch.a.side]}`; const sourceCategory = r.decisions.find((d) => d.tick === watch!.a.tick && d.side === watch!.a.side)!.category;
      step(w, [{ side: watch.a.side, intent: watch.a.intent }]); drain();
      const attempt = { a: watch.a, key, statuses: [] as string[], built: null as { tile: number } | null, sourceCategory }; attempts.push(attempt);
      // The engine first places a Construction unit; the Defense Post itself exists once the 50-tick build completes.
      for (let k = 0; k < 60 && !attempt.built; k++) { drive(w, ['blue', 'red'], 1); drain(); const added = e.player(watch.a.side).units(UnitType.DefensePost).find((u) => !watch!.before.has(u.id()) && u.isActive() && !u.isUnderConstruction()); if (added) attempt.built = { tile: added.tile() }; }
      attempt.statuses = events.get(key) ?? [];
      break;
    }
    const success = attempts.find((t) => t.built)!;
    expect(success).toBeDefined(); expect(success.statuses).toEqual(['construction-started', 'construction-completed']);
    // The same public state with the recorded ledger produced a different order: the rule is gold-gated.
    expect(success.sourceCategory).not.toBe('construction');
    const a = success.a; const st = station(w, a.objectiveId!); const sa = a.observed.stations.find((s) => s.id === st.id)!;
    expect(sa.threatened).toBe(true); expect(sa.controller).toBe(a.side); expect(sa.nearestDefencePost === null || sa.nearestDefencePost > OBJECTIVE_RULES.defenceRadius).toBe(true);
    expect(w.e.game.manhattanDist(Number(a.intent!.tile), st.tile)).toBeLessThanOrEqual(OBJECTIVE_RULES.defenceRadius);
    expect(a.reason).toMatch(new RegExp(`controlled station ${st.id} \\(${sa.ownHeld}/${st.tiles.length} held\\) is threatened: opponent holds ${sa.opponentHeld} footprint tiles and borders ${sa.opponentAdjacent}; no defence post within 7 tiles; gold [\\d,]+ covers Defense Post cost [\\d,]+`));
    expect(w.e.game.manhattanDist(success.built!.tile, st.tile)).toBeLessThanOrEqual(OBJECTIVE_RULES.defenceRadius);
  });

  test('land pushes name the wanted station, choose expansion or attack from the board and say the attack cannot be routed', async () => {
    const w = await world();
    const redHeld = new Set<string>();
    const log = drive(w, ['blue', 'red'], 1800, (a) => { if (a.side === 'red') for (const id of a.observed.controlledStations) redHeld.add(id); });
    const red = log.filter((a) => a.side === 'red' && a.source === 'objectives/1');
    const expansion = red.find((a) => a.category === 'expansion');
    expect(expansion).toBeDefined(); expect(['beacon', 'cedar']).toContain(expansion!.objectiveId);
    expect(expansion!.reason).toMatch(/is on an owned landmass/); expect(expansion!.reason).toMatch(/a land attack order cannot be routed to the station tiles; it presses the whole frontier/);
    expect(expansion!.intent).toMatchObject({ type: 'attack', targetID: null });
    // Red walks to at least one of Beacon and Cedar on its own landmass without any boat for them (blue may reach the other first by sea).
    expect(redHeld.has('beacon') || redHeld.has('cedar')).toBe(true);
    expect(red.filter((a) => a.category === 'transport' && (a.objectiveId === 'beacon' || a.objectiveId === 'cedar'))).toHaveLength(0);
    const attack = log.find((a) => a.category === 'attack' && a.source === 'objectives/1');
    expect(attack).toBeDefined();
    expect(attack!.intent).toMatchObject({ type: 'attack', targetID: w.e.player(attack!.side === 'blue' ? 'red' : 'blue').id() }); expect(attack!.reason).toMatch(/opponent holds station tiles|holding the station/);
    expect(log.filter((a) => a.intent).length).toBeGreaterThan(20);
  });
});

describe(`${OBJECTIVE_CONTROLLER} determinism and independence`, () => {
  test('reconstruction: a fresh engine with its own board reproduces source fingerprints, board and decisions at independent checkpoints; a branch decides from its own state', async () => {
    const r = await runObjectiveMatchup('objectives-vs-objectives', { capTicks: 1800, checkpointEvery: 450 });
    expect(r.reconstruction.checks.map((c) => c.tick)).toEqual([450, 900, 1350, 1800]);
    for (const c of r.reconstruction.checks) { expect(c.fingerprintMatched).toBe(true); expect(c.boardMatched).toBe(true); expect(c.decisionsMatched).toEqual({ blue: true, red: true }); }
    expect(r.reconstruction.officialRestore).toMatchObject({ tick: 1800, matched: true });
    // Tampered source fingerprint at the target tick: the official restore refuses rather than accepting its own recomputation.
    const tampered: EngineRecord = { ...r.record, fingerprints: { ...r.record.fingerprints, 1800: 'f'.repeat(64) } };
    await expect(ReplayEngine.restore(tampered, 1800, 'checkpoints')).rejects.toThrow(/fingerprint mismatch at tick 1800/);
    // A branch deviating at 900 yields a decision from its own state, still through the same rule.
    const b = await ReplayEngine.restore(r.record, 900, 'checkpoints'); const bl = createNetworkLayout(b); let bs = initialNetwork(900);
    rawStep(b, [{ side: 'blue', intent: { type: 'attack', targetID: null, troops: Math.floor(b.player('blue').troops() * 0.9) } }]); let bv = advanceNetwork(b, bl, bs); bs = bv.state;
    while (b.game.ticks() < 945) { rawStep(b); bv = advanceNetwork(b, bl, bs); bs = bv.state; }
    const onBranch = objectiveAssess(b, 'blue', bv.view); const source = r.decisions.find((d) => d.tick === 945 && d.side === 'blue')!;
    expect(onBranch.controller).toBe('objectives/1'); expect(onBranch.observed.tick).toBe(945);
    expect(`${onBranch.category}:${JSON.stringify(onBranch.intent)}:${onBranch.reason}`).not.toBe(`${source.category}:${JSON.stringify(source.intent)}:${source.reason}`);
  });

  test('observer and control engines replay the same record to the same fingerprint and decision; only the observed one reports receipts', async () => {
    const r = await runObjectiveMatchup('objectives-vs-maneuver', { capTicks: 600, verifyReconstruction: false });
    const play = async (observeExecution: boolean) => {
      const e = await ReplayEngine.create(r.record.options, { observeExecution }); const l = createNetworkLayout(e); let s = initialNetwork(1); let v: NetworkView | null = null; const events: string[] = [];
      for (const turn of r.record.turns) { rawStep(e, turn.intents.map((intent) => ({ side: intent.clientID === CLIENTS.blue ? 'blue' : 'red', intent }))); if (e.game.ticks() > 1) { const a = advanceNetwork(e, l, s); s = a.state; v = a.view; } events.push(...e.feedback.drain().map((x) => x.status)); }
      return { fingerprint: e.state().fingerprint, decision: objectiveAssess(e, 'blue', v!), events, scores: s.scores };
    };
    const observed = await play(true), control = await play(false);
    expect(observed.fingerprint).toBe(control.fingerprint); expect(observed.fingerprint).toBe(r.record.fingerprints[600]);
    expect(observed.decision).toEqual(control.decision); expect(observed.scores).toEqual(control.scores);
    expect(observed.events).toContain('transport-launched'); expect(control.events).toEqual([]);
    expect(r.decisions.filter((d) => d.side === 'blue' && d.intent?.type === 'boat').every((d) => d.observed.length > 0)).toBe(true);
  });

  test('bounded work: decision time stays small on world-500 and the tunables are explicit', async () => {
    const w = await world(); drive(w, ['blue', 'red'], 450);
    const t0 = performance.now(); for (let i = 0; i < 20; i++) objectiveAssess(w.e, 'blue', w.view); const ms = (performance.now() - t0) / 20;
    expect(ms).toBeLessThan(25);
    expect(OBJECTIVE_RULES.transportSlots).toBeLessThan(w.e.game.config().boatMaxNumber() + 1);
    expect(OBJECTIVE_INTERVAL_TICKS).toBe(45); expect(OBJECTIVE_RULES.reserveGuardTicks).toBe(2 * OBJECTIVE_INTERVAL_TICKS);
  });
});

describe('objective characterization harness', () => {

  test('evidence writer is fresh-only and targets the declared campaign path; the header states what the numbers are not', () => {
    expect(OBJECTIVE_EVIDENCE_FILE.endsWith(path.join('evidence', 'campaign', 'objective-controller-characterization.json'))).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-objective-evidence-')); const file = path.join(dir, 'objective-controller-characterization.json');
    expect(writeObjectiveEvidence({ a: 1 }, file)).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(() => writeObjectiveEvidence({ a: 2 }, file)).toThrow(/Preserve the previous characterization/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
    const h = objectiveEvidenceHeader();
    expect(h.humanPlaytest).toBe(false); expect(h.paidInference).toBe(0); expect(h.claim).toMatch(/not evidence of engagement, learning, optimal play/);
    expect(h.scenario).toBe('crosscurrent-network/1'); expect(h.seeds).toEqual(['OBJC0001', 'OBJC0002']); expect(h.capTicks).toBe(12000);
  });

  test('a short run records tallies, station changes, receipts and matching reconstruction for both sides', async () => {
    const r = await runObjectiveMatchup('maneuver-vs-objectives', { capTicks: 900, checkpointEvery: 450 });
    expect(r.controllers).toEqual({ blue: 'maneuver/1', red: 'objectives/1' });
    expect(r.tallies).toBe(3); expect(r.boardUpdates.filter((u) => u.kind === 'award').map((u) => u.tick)).toEqual([300, 600, 900]);
    expect(r.stationOwnershipChanges.slice(0, 2)).toEqual([{ tick: 2, station: 'aster', from: null, to: 'blue' }, { tick: 2, station: 'delta', from: null, to: 'red' }]);
    expect(r.samples.map((s) => s.tick)).toEqual([600, 900]); expect(r.samples[1]!.red.score).toBe(r.boardUpdates.at(-1)!.scores.red);
    expect(r.activity.red.sources['objectives/1'] + r.activity.red.sources['maneuver/1'] + r.activity.red.sources.none).toBe(r.activity.red.decisionMs.n);
    expect(r.activity.blue.sources).toEqual({ 'objectives/1': 0, 'maneuver/1': 0, none: 0 });
    expect(r.reconstruction.checks.map((c) => [c.tick, c.fingerprintMatched, c.boardMatched, c.decisionsMatched.red])).toEqual([[450, true, true, true], [900, true, true, true]]);
    const again = await reconstruct(r.record, r.controllers, r.decisions, r.boardUpdates, 450);
    expect(again.checks).toEqual(r.reconstruction.checks);
    expect(r.outcome).toBeNull(); expect(r.stationLandmasses.aster.blueSpawnLandmass).toBe(true); expect(r.stationLandmasses.delta.redSpawnLandmass).toBe(true); expect(r.stationLandmasses.ember.landmass).not.toBe(r.stationLandmasses.delta.landmass);
  });
});
