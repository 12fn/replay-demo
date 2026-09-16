/**
 * `maneuver/1`: a versioned, deterministic, stateless scripted opponent for the abstract territorial
 * exercise. It is a fixed rule set, not a model and not a doctrine; nothing here claims optimality or
 * realism. Every decision is a pure function of the current public game state and the tick, so the
 * same decision is produced on either side, after a seek, after a restart and on a branch.
 *
 * Contract (used by GameService once per `MANEUVER_INTERVAL_TICKS`): `maneuverDecision` returns at
 * most ONE order, already admitted by `ReplayEngine.validate` (the same validator a human order uses),
 * or null when the rule holds (reserve) or nothing is legal. The reason string only quotes observed
 * quantities; it is not a narrative of hidden reasoning. `maneuverAssess` exposes the same evaluation
 * with the reserve case made explicit for tests and the qualification harness.
 *
 * The legacy `GameService.baseline` is untouched; this file adds a second option beside it.
 *
 * Fixed deficiencies of the legacy rule that the pacing measurements exposed (docs/process/pacing-*.md):
 * neutral expansion continues while in contact; commitments scale with the reserve ratio instead of
 * spending a flat share every pulse; idle gold goes into cities, defence posts, ports and upgrades;
 * transports are used only toward land the side cannot walk to, and never to its own landmass.
 */
import { UnitType, type Game, type Player, type Unit } from '../../vendor/openfront/src/core/game/Game';
import type { ReplayEngine, Side } from '../engine/engine';

export const MANEUVER_CONTROLLER = 'maneuver/1';
/** Decision cadence the service is expected to use; the rule itself derives its pulse index from the tick. */
export const MANEUVER_INTERVAL_TICKS = 45;
export type ManeuverCategory = 'expansion' | 'attack' | 'reserve' | 'construction' | 'upgrade' | 'transport' | 'recall';
export interface ManeuverDecision { intent: Record<string, unknown>; reason: string; category: ManeuverCategory }
/** Full evaluation: a decision, or an explicit reserve/none with the observed facts that produced it. */
export interface ManeuverAssessment { controller: typeof MANEUVER_CONTROLLER; tick: number; side: Side; category: ManeuverCategory | 'none'; intent: Record<string, unknown> | null; reason: string; observed: ManeuverObservation }
export interface ManeuverObservation {
  troops: number; maxTroops: number; reserveRatio: number; committedTroops: number; incomingTroops: number; gold: number; tiles: number;
  borderTiles: number; neutralBorder: number; opponentBorder: number; ownShores: number; inContact: boolean; opponentTroops: number; opponentTiles: number;
  transportsAtSea: number; structures: Record<'City' | 'Defense Post' | 'Port', number>; ownedLandmasses: number; pulse: number;
}

/** Rule tunables. Versioned with the controller name; change them only under a new name. */
export const MANEUVER_RULES = {
  minTroops: 100,
  /** Commit share of home forces by reserve ratio band (ratio of troops to the engine's cap). */
  commitShare: [[0.8, 0.35], [0.5, 0.25], [0.3, 0.18], [0.15, 0.1]] as [number, number][],
  /** Below this reserve ratio only cheap neutral expansion is allowed, and only with this many forces. */
  neutralFloorRatio: 0.08, neutralFloorTroops: 1000,
  /** No new land commitment while forces already in the field exceed those at home (unless the cap binds). */
  overcommitRatio: 1.0,
  /** In contact with a neutral frontier still open: every third pulse expands; the others attack when not clearly weaker. */
  attackStrengthRatio: 0.9, expansionPulseModulo: 3,
  /** Transports: at most this many at sea from this side; periodic launches when land options still exist. */
  transportSlots: 2, transportPeriodModulo: 4, transportMinRatio: 0.35, transportShareUnclaimed: 0.2, transportShareOpponent: 0.25,
  /** Landmass candidates and shore samples inspected per pulse (bounded CPU). */
  landmassCandidates: 8, shoreSamplesPerLandmass: 48, ownShoreSamples: 16, transportValidations: 4,
  /** Construction caps. */
  maxCities: 8, maxDefensePosts: 6, maxPorts: 2, defensePostsPerOpponentBorderTiles: 40, buildSiteSamples: 8, defensePostSetback: 8,
  /** Recall: cancel the largest neutral attack when the incoming force exceeds home forces and the reserve is thin. */
  recallReserveRatio: 0.3, recallMinShare: 0.1,
} as const;

const other = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (r: number) => `${Math.round(r * 100)}%`;

// ---------------------------------------------------------------------------------------------
// Static terrain memo: land components (landmasses) of the map. Terrain is immutable under the
// REPLAY configuration (water conversion is only produced by disabled nuke units), so this is a
// pure function of the map, memoised per Game so repeated pulses do not relabel the whole map.
// It carries no game state, no per-side data and no history; decisions are identical without it.
// ---------------------------------------------------------------------------------------------
export interface Landmasses { label: Int32Array; sizes: number[]; /** Deterministic stride sample of each component's ocean-facing shore tiles (lake shores are unreachable by transport). */ shores: number[][]; /** Component ids ordered by size, largest first. */ bySize: number[] }
const LANDMASS_MEMO = new WeakMap<Game, Landmasses>();
export function landmasses(g: Game): Landmasses {
  const memo = LANDMASS_MEMO.get(g); if (memo) return memo;
  const w = g.width(), n = w * g.height(); const label = new Int32Array(n).fill(-1); const sizes: number[] = []; const allShores: number[][] = [];
  const ok = (t: number) => g.isLand(t) && !g.isImpassable(t);
  const oceanShore = (t: number) => g.isShore(t) && g.neighbors(t).some((nb) => g.isWater(nb) && g.isOcean(nb));
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || !ok(s)) continue;
    const id = sizes.length; let size = 0; const shores: number[] = []; label[s] = id; stack.push(s);
    while (stack.length) {
      const t = stack.pop()!; size++; if (oceanShore(t)) shores.push(t); const x = t % w;
      for (const nb of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) if (nb >= 0 && nb < n && label[nb] === -1 && ok(nb)) { label[nb] = id; stack.push(nb); }
    }
    sizes.push(size); allShores.push(stride(shores, MANEUVER_RULES.shoreSamplesPerLandmass));
  }
  const bySize = sizes.map((_, i) => i).sort((a, b) => sizes[b]! - sizes[a]! || a - b);
  const result = { label, sizes, shores: allShores, bySize }; LANDMASS_MEMO.set(g, result); return result;
}
/** Deterministic evenly spaced sample of at most `k` items. */
function stride<T>(items: T[], k: number): T[] { if (items.length <= k) return items; const step = items.length / k; return Array.from({ length: k }, (_, i) => items[Math.floor(i * step)]!); }

// ---------------------------------------------------------------------------------------------
// Observation: one pass over the side's border (its perimeter, not every tile) plus O(units).
// ---------------------------------------------------------------------------------------------
interface Scan { obs: ManeuverObservation; ownComponents: Set<number>; ownShoreSample: number[]; opponentFacing: number[]; sites: number[] }
function scan(e: ReplayEngine, side: Side): Scan {
  const g = e.game, p = e.player(side), opp = e.player(other(side)); const lm = landmasses(g);
  const border = p.borderTiles(); let neutral = 0, facing = 0; const ownShores: number[] = [], opponentFacing: number[] = [], sites: number[] = [];
  const ownComponents = new Set<number>(); const oppID = opp.smallID();
  let i = 0; const siteStep = Math.max(1, Math.floor(border.size / MANEUVER_RULES.buildSiteSamples));
  for (const t of border) {
    ownComponents.add(lm.label[t]!); if (g.isShore(t)) ownShores.push(t);
    let seesNeutral = false, seesOpp = false;
    for (const nb of g.neighbors(t)) { if (!g.isLand(nb) || g.isImpassable(nb)) continue; if (!g.hasOwner(nb)) seesNeutral = true; else if (g.ownerID(nb) === oppID) seesOpp = true; }
    if (seesNeutral) neutral++; if (seesOpp) { facing++; if (opponentFacing.length < 32 && facing % 3 === 1) opponentFacing.push(t); }
    if (i % siteStep === 0 && sites.length < MANEUVER_RULES.buildSiteSamples) sites.push(t); i++;
  }
  let committed = 0; for (const a of p.outgoingAttacks()) committed += a.troops();
  let incoming = 0; for (const a of p.incomingAttacks()) incoming += a.troops();
  const structures = { City: 0, 'Defense Post': 0, Port: 0 } as ManeuverObservation['structures'];
  for (const u of p.units(UnitType.City, UnitType.DefensePost, UnitType.Port)) if (u.isActive()) structures[u.type() as keyof typeof structures]++;
  const troops = p.troops(), maxTroops = g.config().maxTroops(p);
  const obs: ManeuverObservation = {
    troops, maxTroops, reserveRatio: maxTroops > 0 ? troops / maxTroops : 0, committedTroops: committed, incomingTroops: incoming, gold: Number(p.gold()), tiles: p.numTilesOwned(),
    borderTiles: border.size, neutralBorder: neutral, opponentBorder: facing, ownShores: ownShores.length, inContact: facing > 0 && p.canAttackPlayer(opp), opponentTroops: opp.troops(), opponentTiles: opp.numTilesOwned(),
    transportsAtSea: p.unitCount(UnitType.TransportShip), structures, ownedLandmasses: ownComponents.size, pulse: Math.floor(g.ticks() / MANEUVER_INTERVAL_TICKS),
  };
  return { obs, ownComponents, ownShoreSample: stride(ownShores, MANEUVER_RULES.ownShoreSamples), opponentFacing, sites };
}

function commitShare(ratio: number): number { for (const [floor, share] of MANEUVER_RULES.commitShare) if (ratio >= floor) return share; return 0; }
const admitted = (e: ReplayEngine, side: Side, intent: Record<string, unknown>): boolean => { try { e.validate(side, intent); return true; } catch { return false; } };

// ---------------------------------------------------------------------------------------------
// Rules. Each returns a validated decision or null; `maneuverAssess` runs them in a fixed order.
// ---------------------------------------------------------------------------------------------
function recall(e: ReplayEngine, side: Side, s: Scan): ManeuverDecision | null {
  const o = s.obs; if (!(o.incomingTroops > o.troops) || o.reserveRatio >= MANEUVER_RULES.recallReserveRatio) return null;
  const neutralAttacks = e.player(side).outgoingAttacks().filter((a) => !a.target().isPlayer() && a.troops() >= o.maxTroops * MANEUVER_RULES.recallMinShare).sort((a, b) => b.troops() - a.troops() || a.id().localeCompare(b.id()));
  const a = neutralAttacks[0]; if (!a) return null;
  const intent = { type: 'cancel_attack', attackID: a.id() };
  if (!admitted(e, side, intent)) return null;
  return { intent, category: 'recall', reason: `incoming ${fmt(o.incomingTroops)} forces exceed ${fmt(o.troops)} at home (reserve ${pct(o.reserveRatio)}); recalling the ${fmt(a.troops())}-force neutral attack` };
}

function construction(e: ReplayEngine, side: Side, s: Scan): ManeuverDecision | null {
  const g = e.game, p = e.player(side), o = s.obs; const cfg = g.config();
  const cost = (t: UnitType) => Number(cfg.unitInfo(t).cost(g, p));
  const disabled = (t: UnitType) => cfg.isUnitDisabled(t);
  const spawn = p.spawnTile(); const sites = [...(spawn !== undefined && g.ownerID(spawn) === p.smallID() ? [spawn] : []), ...s.sites];
  const tryBuild = (type: UnitType, at: number[], category: ManeuverCategory, why: string): ManeuverDecision | null => {
    if (disabled(type) || o.gold < cost(type)) return null;
    for (const t of at) { const tile = p.canBuild(type, t); if (tile === false) continue; const intent = { type: 'build_unit', unit: type, tile }; if (admitted(e, side, intent)) return { intent, category, reason: `${why}; gold ${fmt(o.gold)} covers ${type} cost ${fmt(cost(type))}` }; }
    return null;
  };
  // 1. Defensive structure covering the contact border while the opponent is adjacent (bounded by border length).
  //    Sited a few tiles behind the line (toward the deployment tile) so it is not on the tile the opponent takes next;
  //    the post's range still covers the line, and `canBuild` resolves the nearest legal owned tile.
  if (o.inContact && o.structures['Defense Post'] < Math.min(MANEUVER_RULES.maxDefensePosts, 1 + Math.floor(o.opponentBorder / MANEUVER_RULES.defensePostsPerOpponentBorderTiles))) {
    const anchor = sites[0] ?? s.opponentFacing[0]; const back = anchor === undefined ? [] : s.opponentFacing.map((f) => behind(g, f, anchor, MANEUVER_RULES.defensePostSetback, p.smallID())).filter((t): t is number => t !== null);
    const d = tryBuild(UnitType.DefensePost, [...back, ...s.opponentFacing], 'construction', `opponent adjacent on ${o.opponentBorder} border tiles; ${o.structures['Defense Post']} defence posts held`); if (d) return d;
  }
  // 2. City: raises the force cap (the cap is what limits growth once the reserve ratio is high).
  if (o.structures.City < MANEUVER_RULES.maxCities) {
    const d = tryBuild(UnitType.City, sites, 'construction', `force cap ${fmt(o.maxTroops)} with ${o.structures.City} cities (reserve ${pct(o.reserveRatio)})`); if (d) return d;
    // No free site within the sampled territory: upgrade the existing city instead.
    if (o.structures.City > 0 && !disabled(UnitType.City) && o.gold >= cost(UnitType.City)) {
      const u = upgradeable(p, UnitType.City); if (u) { const intent = { type: 'upgrade_structure', unit: UnitType.City, unitId: u.id() }; if (admitted(e, side, intent)) return { intent, category: 'upgrade', reason: `no free city site in the sampled territory; gold ${fmt(o.gold)} covers an upgrade of city #${u.id()} (level ${u.level()}) at ${fmt(cost(UnitType.City))}` }; }
    }
  }
  // 3. Port on an owned coast, once the side is coastal (low priority: ports do not carry transports).
  if (o.ownShores > 0 && o.structures.Port < MANEUVER_RULES.maxPorts && o.structures.City > 0) {
    const d = tryBuild(UnitType.Port, s.ownShoreSample, 'construction', `${o.ownShores} owned shore tiles and ${o.structures.Port} ports`); if (d) return d;
  }
  return null;
}
/** The owned tile `d` steps from `from` toward `toward` (straight line, clipped to the map), or null if that tile is not owned. */
function behind(g: Game, from: number, toward: number, d: number, ownerID: number): number | null {
  const dx = g.x(toward) - g.x(from), dy = g.y(toward) - g.y(from); const len = Math.hypot(dx, dy); if (len < 1) return null;
  const x = Math.max(0, Math.min(g.width() - 1, Math.round(g.x(from) + (dx / len) * d))), y = Math.max(0, Math.min(g.height() - 1, Math.round(g.y(from) + (dy / len) * d)));
  const t = y * g.width() + x; return g.isLand(t) && g.ownerID(t) === ownerID ? t : null;
}
function upgradeable(p: Player, type: UnitType): Unit | null { const us = p.units(type).filter((u) => u.isActive() && p.canUpgradeUnit(u)).sort((a, b) => a.level() - b.level() || a.id() - b.id()); return us[0] ?? null; }

/** Landmass targets the side cannot walk to: nearest sampled unclaimed or attackable-opponent shore on the largest foreign landmasses. */
export function transportTargets(e: ReplayEngine, side: Side, s?: Scan): { tile: number; component: number; componentSize: number; target: 'unclaimed' | 'opponent'; distance: number }[] {
  const g = e.game, p = e.player(side), opp = e.player(other(side)); const sc = s ?? scan(e, side); const lm = landmasses(g);
  if (!sc.ownShoreSample.length) return [];
  const oppOpen = p.canAttackPlayer(opp), oppID = opp.smallID(), ownID = p.smallID();
  // Landmasses already being sailed to are not sailed to again.
  const enRoute = new Set<number>(); for (const u of p.units(UnitType.TransportShip)) { const t = u.targetTile(); if (t !== undefined && !u.transportShipState().isRetreating) enRoute.add(lm.label[t]!); }
  const dist = (t: number) => { let d = Infinity; for (const o of sc.ownShoreSample) { const m = g.manhattanDist(o, t); if (m < d) d = m; } return d; };
  const out: ReturnType<typeof transportTargets> = [];
  let considered = 0;
  for (const c of lm.bySize) {
    if (considered >= MANEUVER_RULES.landmassCandidates) break;
    if (sc.ownComponents.has(c) || enRoute.has(c)) continue; considered++;
    let best: (typeof out)[number] | null = null;
    for (const t of lm.shores[c]!) {
      const owned = g.hasOwner(t); const owner = owned ? g.ownerID(t) : -1;
      if (owner === ownID) continue; const target: 'unclaimed' | 'opponent' | null = !owned ? 'unclaimed' : owner === oppID && oppOpen ? 'opponent' : null; if (!target) continue;
      const d = dist(t);
      // Prefer unclaimed landings (no immediate combat), then nearer ones.
      const better = !best || (target === 'unclaimed' && best.target !== 'unclaimed') || (target === best.target && d < best.distance);
      if (better) best = { tile: t, component: c, componentSize: lm.sizes[c]!, target, distance: d };
    }
    if (best) out.push(best);
  }
  // Largest landmass first, but the starting point rotates with the pulse so a destination the engine
  // keeps refusing (coarse water reachability) cannot block every later pulse; still a pure function of state and tick.
  if (out.length > 1) { const k = sc.obs.pulse % out.length; return [...out.slice(k), ...out.slice(0, k)]; }
  return out;
}

function transport(e: ReplayEngine, side: Side, s: Scan, force: boolean): ManeuverDecision | null {
  const o = s.obs; const g = e.game, p = e.player(side);
  if (o.transportsAtSea >= MANEUVER_RULES.transportSlots || o.ownShores === 0 || g.config().isUnitDisabled(UnitType.TransportShip)) return null;
  if (!force && (o.reserveRatio < MANEUVER_RULES.transportMinRatio || o.pulse % MANEUVER_RULES.transportPeriodModulo !== 0 || o.transportsAtSea > 0)) return null;
  if (o.troops < MANEUVER_RULES.minTroops) return null;
  let checks = 0;
  for (const c of transportTargets(e, side, s)) {
    if (checks++ >= MANEUVER_RULES.transportValidations) break;
    const share = c.target === 'unclaimed' ? MANEUVER_RULES.transportShareUnclaimed : MANEUVER_RULES.transportShareOpponent;
    const troops = Math.max(1, Math.floor(o.troops * share)); const intent = { type: 'boat', dst: c.tile, troops };
    if (!admitted(e, side, intent)) continue;
    const landing = e.transportLanding(p, c.tile) ?? c.tile;
    return { intent, category: 'transport', reason: `${force ? 'no neutral land or attackable land border adjoins the ' + o.ownedLandmasses + ' owned landmass(es)' : 'periodic sea move with ' + o.neutralBorder + ' neutral border tiles still open'}; ${c.target} shore ${g.x(landing)},${g.y(landing)} on a ${fmt(c.componentSize)}-tile landmass ${c.distance} tiles from own coast; ${o.transportsAtSea} transports at sea; sending ${fmt(troops)} of ${fmt(o.troops)}` };
  }
  return null;
}

function land(e: ReplayEngine, side: Side, s: Scan): ManeuverDecision | { category: 'reserve'; reason: string } | null {
  const o = s.obs; const p = e.player(side), opp = e.player(other(side));
  if (o.troops < MANEUVER_RULES.minTroops) return { category: 'reserve', reason: `${fmt(o.troops)} forces at home is below the ${MANEUVER_RULES.minTroops} minimum` };
  const share = commitShare(o.reserveRatio);
  const canExpand = o.neutralBorder > 0, canAttack = o.inContact && p.sharesBorderWith(opp);
  if (!canExpand && !canAttack) return null;
  const facts = `home ${fmt(o.troops)} of cap ${fmt(o.maxTroops)} (${pct(o.reserveRatio)}), ${fmt(o.committedTroops)} in the field, ${o.neutralBorder} neutral / ${o.opponentBorder} opponent border tiles`;
  if (o.committedTroops > o.troops * MANEUVER_RULES.overcommitRatio && o.reserveRatio < 0.8) return { category: 'reserve', reason: `${facts}; forces in the field exceed those at home, holding this pulse` };
  const strength = o.troops / Math.max(1, o.opponentTroops);
  const expandNow = canExpand && (!canAttack || o.pulse % MANEUVER_RULES.expansionPulseModulo === 0 || strength < MANEUVER_RULES.attackStrengthRatio);
  if (expandNow) {
    const cheap = share === 0 && o.reserveRatio >= MANEUVER_RULES.neutralFloorRatio && o.troops >= MANEUVER_RULES.neutralFloorTroops;
    const f = share > 0 ? share : cheap ? MANEUVER_RULES.neutralFloorRatio : 0;
    if (f === 0) return { category: 'reserve', reason: `${facts}; reserve below ${pct(MANEUVER_RULES.neutralFloorRatio)} of cap, rebuilding` };
    const intent = { type: 'attack', targetID: null, troops: Math.max(1, Math.floor(o.troops * f)) };
    if (admitted(e, side, intent)) return { intent, category: 'expansion', reason: `${facts}; ${canAttack ? 'in contact but keeping the neutral frontier open, ' : ''}committing ${pct(f)} to unclaimed land` };
  }
  if (canAttack) {
    if (share === 0) return { category: 'reserve', reason: `${facts}; reserve below ${pct(MANEUVER_RULES.commitShare.at(-1)![0])} of cap, not attacking the opponent` };
    const intent = { type: 'attack', targetID: opp.id(), troops: Math.max(1, Math.floor(o.troops * share)) };
    if (admitted(e, side, intent)) return { intent, category: 'attack', reason: `${facts}; opponent holds ${fmt(o.opponentTroops)} forces (own/opp ${strength.toFixed(2)}); committing ${pct(share)} against the opponent` };
  }
  return null;
}

/** Evaluate every rule in fixed order and report the outcome, including an explicit reserve. */
export function maneuverAssess(e: ReplayEngine, side: Side): ManeuverAssessment {
  const g = e.game, p = e.player(side); const tick = g.ticks();
  const base = { controller: MANEUVER_CONTROLLER, tick, side } as const;
  const empty: ManeuverObservation = { troops: 0, maxTroops: 0, reserveRatio: 0, committedTroops: 0, incomingTroops: 0, gold: 0, tiles: 0, borderTiles: 0, neutralBorder: 0, opponentBorder: 0, ownShores: 0, inContact: false, opponentTroops: 0, opponentTiles: 0, transportsAtSea: 0, structures: { City: 0, 'Defense Post': 0, Port: 0 }, ownedLandmasses: 0, pulse: Math.floor(tick / MANEUVER_INTERVAL_TICKS) };
  if (g.inSpawnPhase() || !p.hasSpawned()) return { ...base, category: 'none', intent: null, reason: 'deployment phase; no player orders are legal', observed: empty };
  if (!p.isAlive()) return { ...base, category: 'none', intent: null, reason: 'no remaining territory', observed: empty };
  const s = scan(e, side);
  const done = (d: ManeuverDecision): ManeuverAssessment => ({ ...base, ...d, observed: s.obs });
  const r = recall(e, side, s); if (r) return done(r);
  const c = construction(e, side, s); if (c) return done(c);
  // Periodic sea move while land options remain (bounded by slots, reserve ratio and pulse cadence).
  const periodic = transport(e, side, s, false); if (periodic) return done(periodic);
  const l = land(e, side, s);
  if (l && 'intent' in l) return done(l);
  if (l) return { ...base, category: 'reserve', intent: null, reason: l.reason, observed: s.obs };
  // Neither neutral land nor an attackable land border adjoins any owned landmass: the sea is the only way to more territory.
  const t = transport(e, side, s, true); if (t) return done(t);
  return { ...base, category: 'none', intent: null, reason: `no legal expansion, attack, transport or construction this pulse (${s.obs.neutralBorder} neutral border tiles, ${s.obs.transportsAtSea} transports at sea, gold ${fmt(s.obs.gold)})`, observed: s.obs };
}

/** At most one validated order for `side` at the current tick, or null (reserve or nothing legal). */
export function maneuverDecision(e: ReplayEngine, side: Side): ManeuverDecision | null {
  const a = maneuverAssess(e, side);
  return a.intent === null ? null : { intent: a.intent, reason: a.reason, category: a.category as ManeuverCategory };
}
