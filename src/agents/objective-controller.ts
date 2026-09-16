/**
 * `objectives/1`: a versioned, deterministic, stateless scripted opponent that reads the station board
 * of `stations-and-reserves/1` (src/campaign/network.ts) and lets it change the one order it gives per
 * pulse. It is a fixed rule set, not a model, not a doctrine and not an optimal player; nothing here
 * claims realism, engagement or learning value.
 *
 * Contract (the service is expected to call it once per `OBJECTIVE_INTERVAL_TICKS`): `objectiveDecision`
 * returns at most ONE order already admitted by `ReplayEngine.validate`, or null. Every decision is a pure
 * function of the current public game state, the tick and the board `view` handed in for that same tick,
 * so the same decision is produced on either side, after a seek, after a restart and on a branch. The
 * board is never cached, never taken from another tick and never recomputed with different scores: a
 * missing, foreign or stale board throws instead of silently using other numbers (`checkObjectiveBoard`).
 *
 * What the board changes:
 *  - Station value = station point + priority bonus now + the bonus of the station about to become
 *    priority (public `priorityAt`), so a priority rotation reorders targets.
 *  - Sea moves go to the highest-value station on a landmass the side cannot walk to, using the
 *    transport order's exact destination (the engine lands at the reachable shore nearest that tile).
 *    One boat per target landmass, never toward an owned landmass, at most `transportSlots` at sea.
 *  - Land pushes are chosen by the board (expand while the wanted station has unclaimed tiles, attack
 *    the opponent when it holds the wanted station and the side is not clearly weaker) but the pinned
 *    attack order takes only a player or unclaimed land as target: a land attack CANNOT be routed to a
 *    station's tiles. The reason string says so; the order presses the whole frontier.
 *  - Threatened controlled stations get a defence post near the station centre when gold allows.
 *  - Reserve guard: while the side holds a station and a tally is at most `reserveGuardTicks` away, no
 *    order may take the reserve below 30% of cap (plus a margin); a reserve just under 30% is left to
 *    grow instead of being spent. Outside that window forces are spent normally, so the guard cannot
 *    become idle hoarding.
 *  - Everything the board does not decide (construction, upgrades, recall, plain expansion, forced sea
 *    moves) is delegated to the untouched `maneuver/1` reference, then clipped by the same reserve guard
 *    and re-validated. That version is imported, not modified.
 *
 * `objectives/frontier-first/1` (`frontierFirstAssess`) is a separate, opt-in offline experiment policy for
 * 270-tick checks only (docs/demo/frontier-policy-experiment.md). It runs the same rules in the same order and
 * changes one precedence: when `objectives/1` would spend the check on maneuver/1 construction or upgrade, or on
 * a boat to an uncontrolled station, and `landPush` yields an admitted expansion within `frontierRoom`, the
 * expansion is returned instead. Near-miss holds, station defence, recall, attacks, contested boats, the reserve
 * guard, shares and pulse gates are unchanged. `objectiveAssess` and every saved record stay `objectives/1`.
 */
import { UnitType } from '../../vendor/openfront/src/core/game/Game';
import type { ReplayEngine, Side } from '../engine/engine';
import { MANEUVER_CONTROLLER, MANEUVER_RULES, landmasses, maneuverAssess, transportTargets, type ManeuverCategory, type ManeuverDecision } from './scripted-controller';
import { networkRulesForMap, NETWORK_RULES, priorityAt, type NetworkView, type StationView } from '../campaign/network';

export const OBJECTIVE_CONTROLLER = 'objectives/1';
/** Decision cadence the service is expected to use; the pulse index is derived from the tick. */
export const OBJECTIVE_INTERVAL_TICKS = 45;
/** Opt-in experiment policy: `objectives/1` with frontier expansion ahead of elective construction and uncontrolled-station boats. */
export const FRONTIER_FIRST_CONTROLLER = 'objectives/frontier-first/1';
/** The only check interval the frontier-first policy is defined for (`full-game/1` Red cadence). */
export const FRONTIER_FIRST_TICKS_PER_CHECK = 270;
export type ObjectivePolicy = typeof OBJECTIVE_CONTROLLER | typeof FRONTIER_FIRST_CONTROLLER;
export type ObjectiveCategory = ManeuverCategory;
/** ManeuverDecision-compatible; `objectiveId` names the station the order was chosen for, when one was. */
export interface ObjectiveDecision extends ManeuverDecision { objectiveId?: string }
export type DecisionSource = 'objectives/1' | typeof MANEUVER_CONTROLLER | 'none';
/** Sources a frontier-first assessment can also report; kept apart so `objectives/1` consumers keep their exhaustive records. */
export type PolicySource = DecisionSource | typeof FRONTIER_FIRST_CONTROLLER;
/** Frontier-first only: the order `objectives/1` would have given at this state, which the expansion replaced. */
export interface DisplacedDecision { category: ObjectiveCategory; intent: Record<string, unknown>; source: PolicySource; objectiveId: string | null; reason: string }

export interface StationAssessment {
  id: string; controller: Side | null; priority: boolean; upcomingPriority: boolean;
  /** Points per tally this station is worth to the side now (station point, current and imminent priority bonus). */
  value: number;
  ownHeld: number; opponentHeld: number; unclaimed: number; total: number;
  landmass: number; landmassSize: number;
  /** The side already owns tiles on the station's landmass (a land order can reach it). */
  reachableByLand: boolean;
  /** Controlled by the side while the opponent holds footprint tiles or borders the footprint. */
  threatened: boolean; opponentAdjacent: number;
  /** A transport of this side is already sailing to the station's landmass. */
  enRoute: boolean;
  /** Manhattan distance from the station centre to the nearest sampled owned ocean shore, or null without a shore. */
  distanceFromOwnShore: number | null;
  /** Nearest own active defence post to the station centre (manhattan), or null. */
  nearestDefencePost: number | null;
}
export interface ObjectiveObservation {
  tick: number; pulse: number; troops: number; maxTroops: number; reserveRatio: number; committedTroops: number; /** Part of `committedTroops` in attacks on unclaimed land. */ committedNeutralTroops: number; incomingTroops: number; gold: number; tiles: number;
  neutralBorder: number; opponentBorder: number; ownShores: number; inContact: boolean; opponentTroops: number; transportsAtSea: number; ownedLandmasses: number;
  scores: Record<Side, number>; priorityId: string; nextPriorityId: string | null; ticksToAward: number | null; ticksToPriority: number | null;
  controlledStations: string[]; wantedStations: string[];
  /** Reserve guard state this pulse: floor in forces that no order may cross, the growth credited until the tally, and the forces above the floor. */
  guardActive: boolean; guardFloorTroops: number; guardGrowthCredit: number; spendableTroops: number;
  /** Engine's current per-tick troop growth for this side (public config). */
  troopGrowthPerTick: number;
  stations: StationAssessment[];
}
export interface ObjectiveAssessment {
  controller: typeof OBJECTIVE_CONTROLLER; tick: number; side: Side; category: ObjectiveCategory | 'none'; intent: Record<string, unknown> | null; reason: string;
  objectiveId: string | null; source: DecisionSource; observed: ObjectiveObservation;
}
/** Either version's assessment. `displaced` is present only on a frontier-first assessment whose precedence changed the order. */
export interface PolicyAssessment extends Omit<ObjectiveAssessment, 'controller' | 'source'> {
  controller: ObjectivePolicy; source: PolicySource; displaced?: DisplacedDecision;
  /** Frontier-first only: the elective order would have yielded, but `landPush` gave no expansion; this is why. */
  precedenceDeclined?: string;
}

/** Rule tunables. Versioned with the controller name; change them only under a new name. */
export const OBJECTIVE_RULES = {
  minTroops: 100,
  /** A tally this close (ticks) activates the reserve guard for a side holding a station. Two pulses. */
  reserveGuardTicks: 90,
  /** The guard keeps the reserve this far above the rule's 30% threshold, to absorb the order's own effect. */
  reserveGuardMargin: 0.02,
  /** Share of the engine's current per-tick growth credited to the guard until the tally (growth slows as the reserve fills and the cap rises with territory). */
  reserveGrowthCredit: 0.5,
  /** A reserve this far under 30% at a guarded pulse is left to grow rather than spent. */
  reserveNearMissBand: 0.05,
  /** The bonus of the next priority station counts once its rotation is this close (ticks). */
  priorityLookaheadTicks: 900,
  /** Sea moves: at most this many at sea; share of home forces sent; minimum reserve ratio for an elective launch. */
  transportSlots: 2, transportShare: 0.25, transportMinRatio: 0.35, transportValidations: 3,
  /** A station the opponent controls is sailed for only every fourth pulse and only when not clearly weaker; uncontrolled stations on any pulse. */
  contestedTransportPulseModulo: 4,
  /** Growth sea moves (no unclaimed land adjoins any owned landmass): every fourth pulse, toward unclaimed landmasses at least this large; smaller islets are not worth a boat. */
  growthTransportPulseModulo: 4, growthTransportShare: 0.2, growthLandmassMinTiles: 100,
  /** Opponent shore samples inspected when the opponent can only be reached by sea. */
  opponentShoreSamples: 48,
  /** Land pushes: reserve-band shares are the maneuver reference's; attack the opponent only when not clearly weaker. */
  attackStrengthRatio: 0.9,
  /** Forces committed against unclaimed land (this order plus attacks already in the field) are capped at this many per unclaimed border tile, so a closing frontier does not park a large force that the engine later returns all at once. */
  expansionTroopsPerBorderTile: 2000,
  /** A defence post within this manhattan distance of a station centre counts as covering it. */
  defenceRadius: 7, defenceSiteSamples: 12,
  /** Own ocean-shore samples used for distances. */
  ownShoreSamples: 16,
} as const;

const other = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (r: number) => `${Math.round(r * 100)}%`;
const admitted = (e: ReplayEngine, side: Side, intent: Record<string, unknown>): boolean => { try { e.validate(side, intent); return true; } catch { return false; } };

/**
 * The board must be the one for this engine tick and these rules, and its station possession must match
 * the engine's ownership. Anything else throws: the policy never substitutes another tick's scores.
 */
export function checkObjectiveBoard(e: ReplayEngine, view: NetworkView | null | undefined): NetworkView {
  if (!view || typeof view !== 'object') throw new Error('Objective board is missing');
  const expectedRules=networkRulesForMap(e.options.map);
  if (view.rules?.id !== expectedRules.id) throw new Error(`Objective board rules ${String(view.rules?.id)} are not ${expectedRules.id}`);
  const tick = e.game.ticks();
  if (view.tick !== tick) throw new Error(`Objective board is stale: board tick ${view.tick}, engine tick ${tick}`);
  if (!Array.isArray(view.stations) || view.stations.length === 0) throw new Error('Objective board has no stations');
  const ids = { blue: e.player('blue').smallID(), red: e.player('red').smallID() };
  for (const s of view.stations) {
    const held = { blue: 0, red: 0 };
    for (const t of s.tiles) { const o = e.game.ownerID(t); if (o === ids.blue) held.blue++; else if (o === ids.red) held.red++; }
    if (held.blue !== s.held.blue || held.red !== s.held.red) throw new Error(`Objective board does not match engine ownership at station ${s.id} (board ${s.held.blue}/${s.held.red}, engine ${held.blue}/${held.red})`);
  }
  return view;
}

function commitShare(ratio: number): number { for (const [floor, share] of MANEUVER_RULES.commitShare) if (ratio >= floor) return share; return 0; }
function stride<T>(items: T[], k: number): T[] { if (items.length <= k) return items; const step = items.length / k; return Array.from({ length: k }, (_, i) => items[Math.floor(i * step)]!); }

interface Scan { obs: ObjectiveObservation; ownComponents: Set<number>; ownShoreSample: number[]; /** The checked board this pulse is evaluated against; footprints are read from it, never stored. */ view: NetworkView }

/** One pass over the side's border plus O(units) plus the station footprints (at most a few hundred tiles). */
function scan(e: ReplayEngine, side: Side, view: NetworkView): Scan {
  const g = e.game, p = e.player(side), opp = e.player(other(side)), lm = landmasses(g), tick = g.ticks();
  const oppID = opp.smallID(), ownID = p.smallID();
  const border = p.borderTiles(); let neutral = 0, facing = 0; const ownShores: number[] = []; const ownComponents = new Set<number>();
  for (const t of border) {
    ownComponents.add(lm.label[t]!);
    if (g.isShore(t) && g.neighbors(t).some((nb) => g.isWater(nb) && g.isOcean(nb))) ownShores.push(t);
    let seesNeutral = false, seesOpp = false;
    for (const nb of g.neighbors(t)) { if (!g.isLand(nb) || g.isImpassable(nb)) continue; if (!g.hasOwner(nb)) seesNeutral = true; else if (g.ownerID(nb) === oppID) seesOpp = true; }
    if (seesNeutral) neutral++; if (seesOpp) facing++;
  }
  const ownShoreSample = stride(ownShores, OBJECTIVE_RULES.ownShoreSamples);
  let committed = 0, committedNeutral = 0; for (const a of p.outgoingAttacks()) { committed += a.troops(); if (!a.target().isPlayer()) committedNeutral += a.troops(); }
  let incoming = 0; for (const a of p.incomingAttacks()) incoming += a.troops();
  const enRoute = new Set<number>(); let atSea = 0;
  for (const u of p.units(UnitType.TransportShip)) { if (!u.isActive()) continue; atSea++; const t = u.targetTile(); if (t !== undefined && !u.transportShipState().isRetreating) enRoute.add(lm.label[t]!); }
  const posts = p.units(UnitType.DefensePost).filter((u) => u.isActive()).map((u) => u.tile());
  const troops = p.troops(), maxTroops = g.config().maxTroops(p), reserveRatio = maxTroops > 0 ? troops / maxTroops : 0;
  const ticksToAward = view.nextAwardTick === null ? null : view.nextAwardTick - tick;
  const ticksToPriority = view.nextPriorityTick === null ? null : view.nextPriorityTick - tick;
  const nextPriorityId = view.nextPriorityTick === null ? null : priorityAt(view.nextPriorityTick,view.rules);
  const stations: StationAssessment[] = view.stations.map((s: StationView) => {
    const landmass = lm.label[s.tile]!;
    let opponentAdjacent = 0;
    for (const t of s.tiles) for (const nb of g.neighbors(t)) if (g.isLand(nb) && g.hasOwner(nb) && g.ownerID(nb) === oppID) { opponentAdjacent++; break; }
    const upcomingPriority = nextPriorityId === s.id && ticksToPriority !== null && ticksToPriority <= OBJECTIVE_RULES.priorityLookaheadTicks && !s.priority;
    const value = NETWORK_RULES.stationPoints + (s.priority ? NETWORK_RULES.priorityBonus : 0) + (upcomingPriority ? NETWORK_RULES.priorityBonus : 0);
    let distance: number | null = null; for (const o of ownShoreSample) { const d = g.manhattanDist(o, s.tile); if (distance === null || d < distance) distance = d; }
    let nearestPost: number | null = null; for (const t of posts) { const d = g.manhattanDist(t, s.tile); if (nearestPost === null || d < nearestPost) nearestPost = d; }
    const ownHeld = s.held[side], opponentHeld = s.held[other(side)];
    return { id: s.id, controller: s.controller, priority: s.priority, upcomingPriority, value, ownHeld, opponentHeld, unclaimed: s.total - ownHeld - opponentHeld, total: s.total, landmass, landmassSize: lm.sizes[landmass]!, reachableByLand: ownComponents.has(landmass), threatened: s.controller === side && (opponentHeld > 0 || opponentAdjacent > 0), opponentAdjacent, enRoute: enRoute.has(landmass), distanceFromOwnShore: distance, nearestDefencePost: nearestPost };
  });
  const controlled = stations.filter((s) => s.controller === side).map((s) => s.id);
  const guardActive = controlled.length > 0 && ticksToAward !== null && ticksToAward <= OBJECTIVE_RULES.reserveGuardTicks && reserveRatio >= NETWORK_RULES.reserveFraction;
  const guardFloorTroops = guardActive ? Math.ceil(maxTroops * (NETWORK_RULES.reserveFraction + OBJECTIVE_RULES.reserveGuardMargin)) : 0;
  const troopGrowthPerTick = p.isAlive() ? g.config().troopIncreaseRate(p) : 0;
  // Forces that will be at home by the tally if nothing is spent: current forces plus a discounted share of the engine's growth.
  const guardGrowthCredit = guardActive ? Math.floor(troopGrowthPerTick * ticksToAward! * OBJECTIVE_RULES.reserveGrowthCredit) : 0;
  const obs: ObjectiveObservation = {
    tick, pulse: Math.floor(tick / OBJECTIVE_INTERVAL_TICKS), troops, maxTroops, reserveRatio, committedTroops: committed, committedNeutralTroops: committedNeutral, incomingTroops: incoming, gold: Number(p.gold()), tiles: p.numTilesOwned(),
    neutralBorder: neutral, opponentBorder: facing, ownShores: ownShores.length, inContact: facing > 0 && p.canAttackPlayer(opp), opponentTroops: opp.troops(), transportsAtSea: atSea, ownedLandmasses: ownComponents.size,
    scores: { ...view.scores }, priorityId: view.priorityId, nextPriorityId, ticksToAward, ticksToPriority, controlledStations: controlled,
    wantedStations: stations.filter((s) => s.controller !== side).sort(byValue).map((s) => s.id),
    guardActive, guardFloorTroops, guardGrowthCredit, spendableTroops: guardActive ? Math.max(0, Math.min(Math.floor(troops), Math.floor(troops + guardGrowthCredit - guardFloorTroops))) : Math.floor(troops), troopGrowthPerTick, stations,
  };
  return { obs, ownComponents, ownShoreSample, view };
  function byValue(a: StationAssessment, b: StationAssessment) { return b.value - a.value || (a.distanceFromOwnShore ?? 1e9) - (b.distanceFromOwnShore ?? 1e9) || a.id.localeCompare(b.id); }
}

const stationsByValue = (s: Scan) => s.obs.wantedStations.map((id) => s.obs.stations.find((x) => x.id === id)!);
/** Forces an order may commit: the reserve-band share, clipped by the guard floor. */
function allowance(o: ObjectiveObservation, share: number): number { return Math.max(0, Math.min(Math.floor(o.troops * share), o.spendableTroops)); }
/** Forces an expansion order may still add against the open frontier (see `expansionTroopsPerBorderTile`). */
const frontierRoom = (o: ObjectiveObservation) => Math.max(0, Math.floor(o.neutralBorder * OBJECTIVE_RULES.expansionTroopsPerBorderTile - o.committedNeutralTroops));
const frontierNote = (o: ObjectiveObservation) => `${fmt(o.committedNeutralTroops)} already committed against ${o.neutralBorder} unclaimed border tiles (cap ${fmt(OBJECTIVE_RULES.expansionTroopsPerBorderTile)} per tile)`;
const guardNote = (o: ObjectiveObservation) => (o.guardActive ? `; tally in ${o.ticksToAward} ticks, keeping ${fmt(o.guardFloorTroops)} (${pct(NETWORK_RULES.reserveFraction + OBJECTIVE_RULES.reserveGuardMargin)} of cap ${fmt(o.maxTroops)}) at home with ${fmt(o.guardGrowthCredit)} growth credited` : '');

// ---------------------------------------------------------------------------------------------
// Rules. Each returns a validated decision or null; `objectiveAssess` runs them in a fixed order.
// ---------------------------------------------------------------------------------------------
/** A reserve just under 30% at a guarded pulse grows past the threshold by the tally if left alone. */
function nearMiss(o: ObjectiveObservation): string | null {
  if (!o.controlledStations.length || o.ticksToAward === null || o.ticksToAward > OBJECTIVE_RULES.reserveGuardTicks) return null;
  if (o.reserveRatio >= NETWORK_RULES.reserveFraction || o.reserveRatio < NETWORK_RULES.reserveFraction - OBJECTIVE_RULES.reserveNearMissBand) return null;
  return `reserve ${pct(o.reserveRatio)} of cap ${fmt(o.maxTroops)} is just under ${pct(NETWORK_RULES.reserveFraction)} with the tally ${o.ticksToAward} ticks away while holding ${o.controlledStations.join(', ')}; holding this pulse for the ${NETWORK_RULES.reserveBonus}-point reserve bonus`;
}

function defend(e: ReplayEngine, side: Side, s: Scan): ObjectiveDecision | null {
  const g = e.game, p = e.player(side), o = s.obs, cfg = g.config();
  if (cfg.isUnitDisabled(UnitType.DefensePost)) return null;
  const cost = Number(cfg.unitInfo(UnitType.DefensePost).cost(g, p)); if (o.gold < cost) return null;
  const threatened = o.stations.filter((x) => x.threatened && (x.nearestDefencePost === null || x.nearestDefencePost > OBJECTIVE_RULES.defenceRadius)).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const ownID = p.smallID();
  for (const st of threatened) {
    const footprint = stationTiles(s, st.id); if (!footprint) continue;
    const centre = footprint.tile;
    const owned = footprint.tiles.filter((t) => g.ownerID(t) === ownID).sort((a, b) => g.manhattanDist(a, centre) - g.manhattanDist(b, centre) || a - b);
    for (const t of stride(owned, OBJECTIVE_RULES.defenceSiteSamples)) {
      // `canBuild` resolves the nearest legal site; a post the spacing rules push away from the station does not cover it.
      const tile = p.canBuild(UnitType.DefensePost, t); if (tile === false || g.manhattanDist(tile, centre) > OBJECTIVE_RULES.defenceRadius) continue;
      const intent = { type: 'build_unit', unit: UnitType.DefensePost, tile };
      if (!admitted(e, side, intent)) continue;
      return { intent, category: 'construction', objectiveId: st.id, reason: `controlled station ${st.id} (${st.ownHeld}/${st.total} held) is threatened: opponent holds ${st.opponentHeld} footprint tiles and borders ${st.opponentAdjacent}; no defence post within ${OBJECTIVE_RULES.defenceRadius} tiles; gold ${fmt(o.gold)} covers Defense Post cost ${fmt(cost)}` };
    }
  }
  return null;
}
/** Station footprint as declared on this pulse's board. */
function stationTiles(s: Scan, id: string): { tile: number; tiles: readonly number[] } | null { const st = s.view.stations.find((x) => x.id === id); return st ? { tile: st.tile, tiles: st.tiles } : null; }

function seaMove(e: ReplayEngine, side: Side, s: Scan): ObjectiveDecision | null {
  const g = e.game, p = e.player(side), o = s.obs;
  if (o.transportsAtSea >= OBJECTIVE_RULES.transportSlots || o.ownShores === 0 || g.config().isUnitDisabled(UnitType.TransportShip)) return null;
  if (o.reserveRatio < OBJECTIVE_RULES.transportMinRatio) return null;
  const troops = allowance(o, OBJECTIVE_RULES.transportShare); if (troops < OBJECTIVE_RULES.minTroops) return null;
  let checks = 0;
  const strength = o.troops / Math.max(1, o.opponentTroops);
  const contestedPulse = o.pulse % OBJECTIVE_RULES.contestedTransportPulseModulo === 0 && strength >= OBJECTIVE_RULES.attackStrengthRatio;
  for (const st of stationsByValue(s)) {
    if (st.reachableByLand || st.enRoute) continue;
    if (st.controller !== null && !contestedPulse) continue;
    if (checks++ >= OBJECTIVE_RULES.transportValidations) break;
    const footprint = stationTiles(s, st.id); if (!footprint) continue;
    const intent = { type: 'boat', dst: footprint.tile, troops };
    if (!admitted(e, side, intent)) continue;
    const landing = e.transportLanding(p, footprint.tile) ?? footprint.tile;
    return { intent, category: 'transport', objectiveId: st.id, reason: `station ${st.id} (${st.controller ?? 'uncontrolled'}, worth ${st.value}/tally${st.priority ? ', priority' : st.upcomingPriority ? ', priority in ' + o.ticksToPriority + ' ticks' : ''}) lies on a ${fmt(st.landmassSize)}-tile landmass the side holds no tile of, ${st.distanceFromOwnShore} tiles from own coast; landing shore ${g.x(landing)},${g.y(landing)}; ${o.transportsAtSea} transports at sea; sending ${fmt(troops)} of ${fmt(o.troops)}${guardNote(o)}` };
  }
  return null;
}

/** Ordinary victory rules still apply: an opponent reachable only by sea, with no land left to take, is pressed at its nearest shore. */
function opponentSeaMove(e: ReplayEngine, side: Side, s: Scan): ObjectiveDecision | null {
  const g = e.game, p = e.player(side), opp = e.player(other(side)), o = s.obs;
  if (o.inContact || o.neutralBorder > 0 || !opp.isAlive() || !p.canAttackPlayer(opp)) return null;
  if (o.transportsAtSea >= OBJECTIVE_RULES.transportSlots || o.ownShores === 0 || g.config().isUnitDisabled(UnitType.TransportShip)) return null;
  if (o.reserveRatio < OBJECTIVE_RULES.transportMinRatio) return null;
  const troops = allowance(o, OBJECTIVE_RULES.transportShare); if (troops < OBJECTIVE_RULES.minTroops) return null;
  const lm = landmasses(g); const enRoute = new Set<number>(); for (const u of p.units(UnitType.TransportShip)) { const t = u.targetTile(); if (t !== undefined && u.isActive() && !u.transportShipState().isRetreating) enRoute.add(lm.label[t]!); }
  const shores: number[] = []; for (const t of opp.borderTiles()) if (g.isShore(t) && !s.ownComponents.has(lm.label[t]!) && !enRoute.has(lm.label[t]!) && g.neighbors(t).some((nb) => g.isWater(nb) && g.isOcean(nb))) shores.push(t);
  const dist = (t: number) => { let d = Infinity; for (const o2 of s.ownShoreSample) { const m = g.manhattanDist(o2, t); if (m < d) d = m; } return d; };
  const ranked = stride(shores, OBJECTIVE_RULES.opponentShoreSamples).map((t) => ({ t, d: dist(t) })).sort((a, b) => a.d - b.d || a.t - b.t);
  let checks = 0;
  for (const { t, d } of ranked) {
    if (checks++ >= OBJECTIVE_RULES.transportValidations) break;
    const intent = { type: 'boat', dst: t, troops }; if (!admitted(e, side, intent)) continue;
    const held = o.stations.filter((x) => x.controller === other(side)).map((x) => x.id);
    return { intent, category: 'transport', reason: `no unclaimed land or land border with the opponent adjoins the ${o.ownedLandmasses} owned landmass(es) and every wanted station is already targeted; opponent holds ${held.length ? held.join(', ') : 'no station'} and ${fmt(o.opponentTroops)} forces; pressing its shore ${g.x(t)},${g.y(t)} ${d} tiles from own coast; sending ${fmt(troops)} of ${fmt(o.troops)}${guardNote(o)}` };
  }
  return null;
}

/** Unclaimed land the side cannot walk to is still worth taking (cap and reserves grow with territory), but not one islet at a time. */
function growthSeaMove(e: ReplayEngine, side: Side, s: Scan): ObjectiveDecision | null {
  const g = e.game, p = e.player(side), o = s.obs;
  if (o.neutralBorder > 0 || o.transportsAtSea > 0 || o.pulse % OBJECTIVE_RULES.growthTransportPulseModulo !== 0 || o.ownShores === 0) return null;
  if (o.reserveRatio < OBJECTIVE_RULES.transportMinRatio || g.config().isUnitDisabled(UnitType.TransportShip)) return null;
  const troops = allowance(o, OBJECTIVE_RULES.growthTransportShare); if (troops < OBJECTIVE_RULES.minTroops) return null;
  const candidates = transportTargets(e, side).filter((c) => c.target === 'unclaimed' && c.componentSize >= OBJECTIVE_RULES.growthLandmassMinTiles).sort((a, b) => b.componentSize - a.componentSize || a.distance - b.distance || a.tile - b.tile);
  let checks = 0;
  for (const c of candidates) {
    if (checks++ >= OBJECTIVE_RULES.transportValidations) break;
    const intent = { type: 'boat', dst: c.tile, troops }; if (!admitted(e, side, intent)) continue;
    const landing = e.transportLanding(p, c.tile) ?? c.tile;
    return { intent, category: 'transport', reason: `no unclaimed land adjoins the ${o.ownedLandmasses} owned landmass(es) and no station is left to sail for; unclaimed shore ${g.x(landing)},${g.y(landing)} on a ${fmt(c.componentSize)}-tile landmass ${c.distance} tiles from own coast; sending ${fmt(troops)} of ${fmt(o.troops)}${guardNote(o)}` };
  }
  return null;
}

function landPush(e: ReplayEngine, side: Side, s: Scan): ObjectiveDecision | { category: 'reserve'; reason: string; objectiveId: string } | null {
  const p = e.player(side), opp = e.player(other(side)), o = s.obs;
  const wanted = stationsByValue(s).filter((st) => st.reachableByLand); const st = wanted[0]; if (!st) return null;
  const canExpand = o.neutralBorder > 0, canAttack = o.inContact && p.sharesBorderWith(opp);
  const facts = `station ${st.id} (${st.ownHeld} own / ${st.opponentHeld} opponent / ${st.unclaimed} unclaimed of ${st.total}, worth ${st.value}/tally) is on an owned landmass; home ${fmt(o.troops)} of cap ${fmt(o.maxTroops)} (${pct(o.reserveRatio)}), ${fmt(o.committedTroops)} in the field`;
  if (o.committedTroops > o.troops && o.reserveRatio < 0.8) return { category: 'reserve', objectiveId: st.id, reason: `${facts}; forces in the field exceed those at home, holding this pulse` };
  const share = commitShare(o.reserveRatio); if (share === 0) return { category: 'reserve', objectiveId: st.id, reason: `${facts}; reserve below ${pct(MANEUVER_RULES.commitShare.at(-1)![0])} of cap, rebuilding` };
  const troops = allowance(o, share);
  if (troops < OBJECTIVE_RULES.minTroops) return { category: 'reserve', objectiveId: st.id, reason: `${facts}; nothing to spend above the reserve floor${guardNote(o)}` };
  const strength = o.troops / Math.max(1, o.opponentTroops);
  const attackFirst = st.opponentHeld > 0 && canAttack && strength >= OBJECTIVE_RULES.attackStrengthRatio;
  const routing = 'a land attack order cannot be routed to the station tiles; it presses the whole frontier';
  if (attackFirst) {
    const intent = { type: 'attack', targetID: opp.id(), troops };
    if (admitted(e, side, intent)) return { intent, category: 'attack', objectiveId: st.id, reason: `${facts}; opponent holds station tiles and ${fmt(o.opponentTroops)} forces (own/opp ${strength.toFixed(2)}); committing ${fmt(troops)} against the opponent (${routing})${guardNote(o)}` };
  }
  if (canExpand && (st.unclaimed > 0 || !canAttack || strength < OBJECTIVE_RULES.attackStrengthRatio)) {
    const why = st.unclaimed > 0 ? `${st.unclaimed} station tiles are unclaimed` : !canAttack ? 'the opponent is not attackable by land' : `the opponent is stronger (own/opp ${strength.toFixed(2)})`;
    const room = frontierRoom(o); const capped = Math.min(troops, room);
    if (capped < OBJECTIVE_RULES.minTroops) {
      if (!(canAttack && st.opponentHeld > 0)) return { category: 'reserve', objectiveId: st.id, reason: `${facts}; ${why}; ${frontierNote(o)}; holding this pulse` };
    } else {
      const intent = { type: 'attack', targetID: null, troops: capped };
      if (admitted(e, side, intent)) return { intent, category: 'expansion', objectiveId: st.id, reason: `${facts}; ${why}; committing ${fmt(capped)} to the ${o.neutralBorder} unclaimed border tiles${capped < troops ? ` (${frontierNote(o)})` : ''} (${routing})${guardNote(o)}` };
    }
  }
  if (canAttack && st.opponentHeld > 0) {
    const intent = { type: 'attack', targetID: opp.id(), troops };
    if (admitted(e, side, intent)) return { intent, category: 'attack', objectiveId: st.id, reason: `${facts}; no unclaimed frontier; committing ${fmt(troops)} against the opponent holding the station (${routing})${guardNote(o)}` };
  }
  return null;
}

/** The maneuver reference decides; its land or sea commitment is clipped to the guard and re-validated. */
function fallback(e: ReplayEngine, side: Side, s: Scan): { d: ObjectiveDecision | null; reason: string; category: ObjectiveCategory | 'none' } {
  const o = s.obs, lm = landmasses(e.game);
  const m = maneuverAssess(e, side);
  if (!m.intent) return { d: null, reason: `${MANEUVER_CONTROLLER}: ${m.reason}`, category: m.category === 'reserve' ? 'reserve' : 'none' };
  const category = m.category as ObjectiveCategory;
  if (category === 'transport') {
    // A reference sea move is kept only when it heads for a landmass with a wanted station or one large
    // enough to matter for growth; boats to islets are not launched (the objective rules above already
    // cover stations, growth landmasses and an opponent reachable only by sea).
    const dst = Number(m.intent.dst); const c = lm.label[dst]!; const wantedLandmasses = new Set(stationsByValue(s).map((st) => st.landmass));
    if (!wantedLandmasses.has(c) && lm.sizes[c]! < OBJECTIVE_RULES.growthLandmassMinTiles) return { d: null, reason: `${MANEUVER_CONTROLLER} proposed a transport toward a ${fmt(lm.sizes[c]!)}-tile landmass without a wanted station; not launched (fewer than ${OBJECTIVE_RULES.growthLandmassMinTiles} tiles)`, category: 'none' };
  }
  let intent = m.intent;
  if (category === 'expansion' || category === 'attack' || category === 'transport') {
    const asked = Number(intent.troops); const clipped = Math.min(asked, o.spendableTroops, category === 'expansion' ? frontierRoom(o) : asked);
    if (clipped < OBJECTIVE_RULES.minTroops) return { d: null, reason: `${MANEUVER_CONTROLLER} would commit ${fmt(asked)}; only ${fmt(o.spendableTroops)} is above the reserve floor${category === 'expansion' ? ` and ${frontierNote(o)}` : ''}${guardNote(o)}`, category: 'reserve' };
    if (clipped !== asked) intent = { ...intent, troops: clipped };
  }
  if (!admitted(e, side, intent)) return { d: null, reason: `${MANEUVER_CONTROLLER} decision no longer admitted after clipping`, category: 'none' };
  const note = intent !== m.intent ? ` (clipped from ${fmt(Number(m.intent.troops))} to ${fmt(Number(intent.troops))}${guardNote(o)})` : '';
  return { d: { intent, category, reason: `${MANEUVER_CONTROLLER}: ${m.reason}${note}` }, reason: '', category };
}

/** Evaluate every rule in fixed order and report the outcome, including an explicit reserve. Throws on a missing or stale board. */
export function objectiveAssess(e: ReplayEngine, side: Side, view: NetworkView): ObjectiveAssessment {
  return assess(e, side, view, OBJECTIVE_CONTROLLER) as ObjectiveAssessment;
}

/**
 * `objectives/frontier-first/1`, for offline experiments that declare it. Defined only for a 270-tick check interval; any
 * other interval throws, so it cannot stand in for the native 45-tick opponent. Same board contract as `objectiveAssess`.
 */
export function frontierFirstAssess(e: ReplayEngine, side: Side, view: NetworkView, ticksPerCheck: number): PolicyAssessment {
  if (ticksPerCheck !== FRONTIER_FIRST_TICKS_PER_CHECK) throw new Error(`${FRONTIER_FIRST_CONTROLLER} is defined only for ${FRONTIER_FIRST_TICKS_PER_CHECK}-tick checks, not ${ticksPerCheck}`);
  return assess(e, side, view, FRONTIER_FIRST_CONTROLLER);
}

function assess(e: ReplayEngine, side: Side, view: NetworkView, policy: ObjectivePolicy): PolicyAssessment {
  const board = checkObjectiveBoard(e, view);
  const g = e.game, p = e.player(side), tick = g.ticks();
  const base = { controller: policy, tick, side } as const;
  const empty = (): ObjectiveObservation => ({ tick, pulse: Math.floor(tick / OBJECTIVE_INTERVAL_TICKS), troops: 0, maxTroops: 0, reserveRatio: 0, committedTroops: 0, committedNeutralTroops: 0, incomingTroops: 0, gold: 0, tiles: 0, neutralBorder: 0, opponentBorder: 0, ownShores: 0, inContact: false, opponentTroops: 0, transportsAtSea: 0, ownedLandmasses: 0, scores: { ...board.scores }, priorityId: board.priorityId, nextPriorityId: null, ticksToAward: null, ticksToPriority: null, controlledStations: [], wantedStations: [], guardActive: false, guardFloorTroops: 0, guardGrowthCredit: 0, spendableTroops: 0, troopGrowthPerTick: 0, stations: [] });
  if (g.inSpawnPhase() || !p.hasSpawned()) return { ...base, category: 'none', intent: null, reason: 'deployment phase; no player orders are legal', objectiveId: null, source: 'none', observed: empty() };
  if (!p.isAlive()) return { ...base, category: 'none', intent: null, reason: 'no remaining territory', objectiveId: null, source: 'none', observed: empty() };
  {
    const s = scan(e, side, board); const o = s.obs;
    const done = (d: ObjectiveDecision, source: PolicySource): PolicyAssessment => ({ ...base, category: d.category, intent: d.intent, reason: d.reason, objectiveId: d.objectiveId ?? null, source, observed: o });
    const hold = nearMiss(o); if (hold) return { ...base, category: 'reserve', intent: null, reason: hold, objectiveId: o.controlledStations[0] ?? null, source: policy, observed: o };
    const d1 = defend(e, side, s); if (d1) return done(d1, policy);
    // Resource investment and safety are the reference's rules (city, upgrade, port, defence post on the contact line, recall).
    const m = maneuverAssess(e, side);
    const reference: ObjectiveDecision | null = m.intent && (m.category === 'construction' || m.category === 'upgrade' || m.category === 'recall') ? { intent: m.intent, category: m.category, reason: `${MANEUVER_CONTROLLER}: ${m.reason}` } : null;
    const d2 = reference ? null : seaMove(e, side, s);
    if (policy === FRONTIER_FIRST_CONTROLLER) {
      // The one measured change: elective construction/upgrade or a boat to an uncontrolled station yields to an admitted expansion. Recall and contested boats keep their place.
      const yields = reference ? reference.category !== 'recall' : d2 !== null && o.stations.find((x) => x.id === d2.objectiveId)?.controller === null;
      const d3 = yields ? landPush(e, side, s) : null;
      if (d3 && 'intent' in d3 && d3.category === 'expansion') {
        const was = (reference ?? d2)!, wasSource = reference ? MANEUVER_CONTROLLER : OBJECTIVE_CONTROLLER;
        return { ...done({ ...d3, reason: `${d3.reason}; frontier-first precedence over ${was.category}${was.objectiveId ? ` for ${was.objectiveId}` : ''}` }, policy), displaced: { category: was.category, intent: was.intent, source: wasSource, objectiveId: was.objectiveId ?? null, reason: was.reason } };
      }
      if (yields) {
        const declined = !d3 ? 'no wanted station is reachable by land, or no land order is admitted' : 'intent' in d3 ? `land push chose ${d3.category}: ${d3.reason}` : `land push holds: ${d3.reason}`;
        if (reference) return { ...done(reference, MANEUVER_CONTROLLER), precedenceDeclined: declined };
        return { ...done(d2!, policy), precedenceDeclined: declined };
      }
    }
    if (reference) return done(reference, MANEUVER_CONTROLLER);
    if (d2) return done(d2, policy);
    const d3 = landPush(e, side, s);
    if (d3 && 'intent' in d3) return done(d3, policy);
    if (d3) return { ...base, category: 'reserve', intent: null, reason: d3.reason, objectiveId: d3.objectiveId, source: policy, observed: o };
    const d4 = growthSeaMove(e, side, s); if (d4) return done(d4, policy);
    const d5 = opponentSeaMove(e, side, s); if (d5) return done(d5, policy);
    const f = fallback(e, side, s);
    if (f.d) return done(f.d, MANEUVER_CONTROLLER);
    return { ...base, category: f.category, intent: null, reason: f.reason, objectiveId: null, source: f.category === 'none' ? 'none' : MANEUVER_CONTROLLER, observed: o };
  }
}

/** At most one validated order for `side` at the current tick given this tick's board, or null (reserve or nothing legal). */
export function objectiveDecision(e: ReplayEngine, side: Side, view: NetworkView): ObjectiveDecision | null {
  const a = objectiveAssess(e, side, view);
  if (a.intent === null) return null;
  return { intent: a.intent, reason: a.reason, category: a.category as ObjectiveCategory, ...(a.objectiveId !== null ? { objectiveId: a.objectiveId } : {}) };
}
