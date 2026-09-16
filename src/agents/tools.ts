import type {AgentOrganizationContext} from '../context/agent-context';
/**
 * Typed tool catalog shared by the opposing-player agent and human-invoked staff agents.
 *
 * Every tool is either a read-only query answered from the engine and the caller's own side
 * records, or an action that goes through exactly the same validator as a human order.
 * Nothing here executes code, opens the network or reads another side's staff records.
 * Legal actions are enumerated from the engine, never invented.
 */
import { UnitType, type Player } from '../../vendor/openfront/src/core/game/Game';
import type { ReplayEngine, Side } from '../engine/engine';
import {orderProgress} from '../review/execution';

export type ToolScope = 'player' | 'staff';
export type ToolKind = 'query' | 'action';

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  scopes: ToolScope[];
  description: string;
  /** JSON-schema fragment for `arguments` (object properties). */
  args: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

export interface ToolCall { tool: string; arguments: string }
export interface ToolResult { tool: string; ok: boolean; output: unknown; reason?: string }

/** Minimal report/event shapes the tools read (side-filtered by the caller). */
export interface SideReport { id: string; tick: number; title: string; body?: string; supersedes?: string; observedTroops?: number; observedTiles?: number; packet?:import('../scenarios/evidence-records').PacketRecord['packet'];evidenceStatus?:'current'|'superseded'|'disputed';supersededBy?:string;disputedWith?:string[] }
export interface SideEvent { id: string; tick: number; kind: string; summary: string; details: Record<string, any> }

/** Everything a tool may touch. The caller filters records to `side` before handing them over. */
export interface AgentContext {
  /** Descriptive fictional pack; conveys no tool authority or live evidence. */
  organizationContext?:AgentOrganizationContext|null;
  objectives?:()=>import('../campaign/network').NetworkView|null;
  domainKnowledge?:import('../server/native-agent-bindings').DomainKnowledge;
  exerciseId: string;
  side: Side;
  engine: ReplayEngine;
  /** Reports already released to `side`. Never the other side's. */
  reports(): SideReport[];
  /** Events attributed to `side` or to no side. */
  events(): SideEvent[];
  /** Action capability; absent in staff scope. */
  submitOrder?(intent: unknown): { id: string; status: string };
  delegateWatch?(objective: string): { taskId: string };
}

const BUILDABLE: UnitType[] = [UnitType.City, UnitType.DefensePost, UnitType.Port, UnitType.Warship];
const obj = (properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec['args'] => ({ type: 'object', properties, required });

export const TOOL_CATALOG: ToolSpec[] = [
  {name:'lookup_domain_knowledge',kind:'query',scopes:['player','staff'],description:'Scoped native ontology retrieval prepared for this pulse: rules, source currency and replay practice, with native request and source IDs. Explicitly unavailable if not connected.',args:obj()},
  { name: 'observe', kind: 'query', scopes: ['player', 'staff'], description: 'Shared-map summary: tick, both players\' public tiles/forces/attacks, and a sample of your border tiles.', args: obj() },
  { name: 'list_legal_actions', kind: 'query', scopes: ['player', 'staff'], description: 'Enumerate orders the engine would accept right now (expansion, attack, build, upgrade, cancel, and a sampled set of naval landings/recalls under `naval`). Each entry is a ready-to-submit intent; naval landings are a bounded sample, not every option.', args: obj() },
  { name: 'list_owned_units', kind: 'query', scopes: ['player', 'staff'], description: 'Your active structures and ships with tile and whether each can be upgraded.', args: obj() },
  { name: 'list_resources', kind: 'query', scopes: ['player', 'staff'], description: 'Your forces, reserve ceiling, gold, tiles, committed attacks, and the opponent\'s public totals.', args: obj() },
  { name: 'list_border_tiles', kind: 'query', scopes: ['player', 'staff'], description: 'Border tiles with coordinates and what lies beyond each (unclaimed, opponent, water).', args: obj({ limit: { type: 'integer', minimum: 1, maximum: 40 } }) },
  { name: 'inspect_tile', kind: 'query', scopes: ['player', 'staff'], description: 'Terrain, ownership and units at one tile reference.', args: obj({ tile: { type: 'integer', minimum: 0 } }, ['tile']) },
  { name: 'search_reports', kind: 'query', scopes: ['player', 'staff'], description: 'Your side\'s released exercise reports, newest last, optionally filtered by a text query.', args: obj({ query: { type: 'string' } }) },
  { name: 'recent_orders', kind: 'query', scopes: ['player', 'staff'], description: 'Your side\'s recent orders with execution status and command IDs.', args: obj({ limit: { type: 'integer', minimum: 1, maximum: 20 } }) },
  { name: 'resource_delta', kind: 'query', scopes: ['player', 'staff'], description: 'Deterministic calculation of how the opponent estimate (from your reports) and your own totals changed over time.', args: obj({ sinceTick: { type: 'integer', minimum: 0 } }) },
  { name: 'submit_order', kind: 'action', scopes: ['player'], description: 'Queue one legal player intent. The engine admits it like a human order on the next tick; admission does not guarantee a completed effect. Check recent_orders for measured construction/transport results.', args: obj({ intent: { type: 'object' } }, ['intent']) },
  { name: 'delegate_watch', kind: 'action', scopes: ['player'], description: 'Create a free durable watch for your side. Supported requests include "Watch reserves below 30%" (own current force capacity), "Watch available forces below 1000", "Watch objective changes", and "Monitor report provenance". Unsupported or compound requests are rejected with examples. No paid analysis is enabled.', args: obj({ objective: { type: 'string' } }, ['objective']) },
];

/** Capabilities deliberately absent. Listed so UIs can say so instead of implying them. */
export const UNAVAILABLE_CAPABILITIES = ['code execution', 'shell access', 'network access', 'opposing-side staff records', 'host or admin game controls'];

export function toolsForScope(scope: ToolScope): ToolSpec[] { return TOOL_CATALOG.filter((t) => t.scopes.includes(scope)); }
export function toolSpec(name: string): ToolSpec | undefined { return TOOL_CATALOG.find((t) => t.name === name); }

/** Parse a call's JSON arguments; anything non-object becomes an empty object so queries stay usable. */
export function parseArgs(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** Execute one catalog tool within `scope`. Unknown or out-of-scope tools are refused, never guessed. */
export function executeTool(call: ToolCall, scope: ToolScope, ctx: AgentContext): ToolResult {
  const spec = toolSpec(call.tool);
  if (!spec) return { tool: call.tool, ok: false, output: null, reason: 'Unknown tool; only catalog tools are available' };
  if (!spec.scopes.includes(scope)) return { tool: call.tool, ok: false, output: null, reason: `Tool is not available in ${scope} scope` };
  const args = parseArgs(call.arguments);
  try {
    switch (spec.name) {
      case 'lookup_domain_knowledge': return ok(call,ctx.domainKnowledge??{status:'unavailable',reason:'Native domain retrieval not configured'});
      case 'observe': return ok(call, observe(ctx));
      case 'list_legal_actions': return ok(call, listLegalActions(ctx));
      case 'list_owned_units': return ok(call, listOwnedUnits(ctx));
      case 'list_resources': return ok(call, listResources(ctx));
      case 'list_border_tiles': return ok(call, listBorderTiles(ctx, clampInt(args.limit, 1, 40, 12)));
      case 'inspect_tile': return ok(call, inspectTile(ctx, args.tile));
      case 'search_reports': return ok(call, searchReports(ctx, typeof args.query === 'string' ? args.query : ''));
      case 'recent_orders': return ok(call, recentOrders(ctx, clampInt(args.limit, 1, 20, 8)));
      case 'resource_delta': return ok(call, resourceDelta(ctx, clampInt(args.sinceTick, 0, Number.MAX_SAFE_INTEGER, 0)));
      case 'submit_order': {
        if (!ctx.submitOrder) return { tool: call.tool, ok: false, output: null, reason: 'Orders cannot be issued from this context' };
        return ok(call, ctx.submitOrder(args.intent));
      }
      case 'delegate_watch': {
        if (!ctx.delegateWatch) return { tool: call.tool, ok: false, output: null, reason: 'Watches cannot be delegated from this context' };
        const objective = String(args.objective ?? '').trim();
        if (!objective) return { tool: call.tool, ok: false, output: null, reason: 'A watch needs an objective' };
        return ok(call, ctx.delegateWatch(objective.slice(0, 500)));
      }
      default: return { tool: call.tool, ok: false, output: null, reason: 'Tool has no executor' };
    }
  } catch (e) {
    return { tool: call.tool, ok: false, output: null, reason: (e as Error).message };
  }
}

const ok = (call: ToolCall, output: unknown): ToolResult => ({ tool: call.tool, ok: true, output });
function clampInt(v: unknown, lo: number, hi: number, dflt: number) { const n = typeof v === 'number' ? Math.floor(v) : Number.NaN; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
const other = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

function xy(ctx: AgentContext, tile: number) { return { tile, x: ctx.engine.game.x(tile), y: ctx.engine.game.y(tile) }; }

function sampleTiles(tiles: Iterable<number>, n: number): number[] {
  const all = [...tiles]; if (all.length <= n) return all;
  const step = all.length / n; return Array.from({ length: n }, (_, i) => all[Math.floor(i * step)]!);
}

export function observe(ctx: AgentContext) {
  const state = ctx.engine.state(); const p = ctx.engine.player(ctx.side);
  return {
    objectives:ctx.objectives?.()??null,
    tick: state.tick, fingerprint: state.fingerprint, spawning: state.spawning, map: { name: state.map, width: state.width, height: state.height },
    self: state.players.find((x) => x.side === ctx.side), opponent: publicView(state.players.find((x) => x.side === other(ctx.side))),
    borderSamples: sampleTiles(p.borderTiles(), 8).map((t) => xy(ctx, t)),
  };
}

/** What the shared map shows about the other player. Never that side's reports or staff records. */
function publicView(p: any) {
  if (!p) return null;
  return { side: p.side, id: p.id, tiles: p.tiles, troops: p.troops, alive: p.alive, attacksInFlight: p.attacks?.length ?? 0, structures: (p.units ?? []).length };
}

function unitCost(ctx: AgentContext, p: Player, type: UnitType): number | null {
  try { return Number(ctx.engine.game.config().unitInfo(type).cost(ctx.engine.game, p)); } catch { return null; }
}

export interface LegalAction { intent: Record<string, unknown>; meaning: string; costGold?: number }
export interface LegalActions { tick: number; availableTroops: number; actions: LegalAction[]; intentShapes: typeof INTENT_SHAPES; naval?: NavalOptions; note?: string }

export interface NavalLanding { intent: { type: 'boat'; dst: number; troops: number }; meaning: string; landing: { tile: number; x: number; y: number }; target: 'unclaimed' | 'opponent'; distanceFromCoast: number; costGold: number }
export interface NavalTransport { unitId: number; tile: number; x: number; y: number; troops: number; retreating: boolean; cancelIntent: { type: 'cancel_boat'; unitID: number } | null }
export interface NavalOptions {
  status: 'available' | 'unavailable';
  /** Present when status is unavailable. */
  reason?: string;
  /** Always a bounded sample chosen deterministically by distance from your coast, never every landing site. */
  sampling: string;
  landingsConsidered: number;
  landings: NavalLanding[];
  transportsAtSea: NavalTransport[];
  limit: { atSea: number; max: number };
}

/**
 * Deterministic, bounded set of usable naval orders for `side`. Candidate landing shores (unclaimed or
 * attackable-opponent) are ranked by Manhattan distance from a fixed sample of the side's own shore
 * tiles; the nearest few and the farthest unclaimed plus the nearest opponent shores are re-checked
 * with the same engine validator a human order goes through, keeping at most three unclaimed and two
 * opponent landings. Forces default to the engine's boat share and are adjustable.
 */
export function listNavalOptions(ctx: AgentContext): NavalOptions {
  const g = ctx.engine.game; const p = ctx.engine.player(ctx.side); const opp = ctx.engine.player(other(ctx.side));
  const max = g.config().boatMaxNumber(); const atSea = p.unitCount(UnitType.TransportShip);
  const transports: NavalTransport[] = p.units(UnitType.TransportShip).filter((u) => u.isActive()).map((u) => {
    const retreating = u.transportShipState().isRetreating;
    let cancelIntent: NavalTransport['cancelIntent'] = null;
    if (!retreating) { try { ctx.engine.validate(ctx.side, { type: 'cancel_boat', unitID: u.id() }); cancelIntent = { type: 'cancel_boat', unitID: u.id() }; } catch { /* not cancellable now */ } }
    return { unitId: u.id(), ...xy(ctx, u.tile()), troops: Math.round(u.troops()), retreating, cancelIntent };
  });
  const sampling = 'Sampled: up to three unclaimed shores (nearest and farthest by distance from your coast) and two nearest attackable opponent shores, each re-checked by the engine validator; not an exhaustive or optimal plan';
  const base = { sampling, transportsAtSea: transports, limit: { atSea, max } };
  const unavailable = (reason: string, considered = 0): NavalOptions => ({ status: 'unavailable', reason, landingsConsidered: considered, landings: [], ...base });
  if (g.config().isUnitDisabled(UnitType.TransportShip) || max === 0) return unavailable('Transports are not in this scenario');
  if (!p.hasSpawned() || !p.isAlive() || g.inSpawnPhase()) return unavailable('No naval orders until deployment is complete and the player is alive');
  if (atSea >= max) return unavailable(`Transport limit reached (${max} at sea)`);
  const ownShores: number[] = []; for (const t of p.borderTiles()) if (g.isShore(t)) ownShores.push(t);
  if (!ownShores.length) return unavailable('No owned shoreline to launch from');
  const coast = sampleTiles(ownShores.sort((a, b) => a - b), 48); // bounded, deterministic reference set
  const fromCoast = (t: number) => { let d = Infinity; for (const s of coast) { const m = g.manhattanDist(s, t); if (m < d) d = m; } return d; };
  const oppOpen = p.canAttackPlayer(opp);
  const unclaimed: [number, number][] = [], opponent: [number, number][] = [];
  g.forEachTile((t) => {
    if (!g.isLand(t) || !g.isShore(t) || g.isImpassable(t)) return;
    if (!g.hasOwner(t)) unclaimed.push([fromCoast(t), t]);
    else if (oppOpen && g.ownerID(t) === opp.smallID()) opponent.push([fromCoast(t), t]);
  });
  const byDist = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];
  unclaimed.sort(byDist); opponent.sort(byDist);
  // Candidate order: nearest unclaimed shores, then the farthest one, then nearest opponent shores. Each is
  // validated in turn (bounded work: at most 10 engine checks) and kept up to the per-group quota.
  type Group = 'near' | 'far' | 'opponent';
  const candidates: { tile: number; dist: number; target: NavalLanding['target']; group: Group }[] = [];
  const seen = new Set<number>();
  const consider = (row: [number, number] | undefined, target: NavalLanding['target'], group: Group) => { if (row && !seen.has(row[1])) { seen.add(row[1]); candidates.push({ tile: row[1], dist: row[0], target, group }); } };
  for (const row of unclaimed.slice(0, 4)) consider(row, 'unclaimed', 'near');
  for (const row of unclaimed.slice(-3).reverse()) consider(row, 'unclaimed', 'far');
  for (const row of opponent.slice(0, 3)) consider(row, 'opponent', 'opponent');
  const troops = Math.max(1, Math.floor(g.config().boatAttackAmount(p, opp)));
  const costGold = unitCost(ctx, p, UnitType.TransportShip) ?? 0;
  const landings: NavalLanding[] = []; const quota: Record<Group, number> = { near: 2, far: 1, opponent: 2 }; const kept: Record<Group, number> = { near: 0, far: 0, opponent: 0 };
  for (const c of candidates) {
    if (kept[c.group] >= quota[c.group]) continue;
    const intent = { type: 'boat' as const, dst: c.tile, troops };
    try { ctx.engine.validate(ctx.side, intent); } catch { continue; }
    kept[c.group]++;
    const at = ctx.engine.transportLanding(p, c.tile) ?? c.tile;
    landings.push({ intent, meaning: `Transport ${troops} forces (default share, adjustable) to ${c.target} shore ${JSON.stringify(xy(ctx, at))}, ${c.dist} tiles from your coast; sampled option`, landing: xy(ctx, at), target: c.target, distanceFromCoast: c.dist, costGold });
  }
  const considered = unclaimed.length + opponent.length;
  if (!landings.length) return unavailable(considered ? 'No sampled landing shore is reachable by water from your coast' : 'No unclaimed or attackable opponent shore exists on this map', considered);
  return { status: 'available', landingsConsidered: considered, landings, ...base };
}

/** Legal actions enumerated from the engine. Each proposed intent is re-checked with `engine.validate`. */
export function listLegalActions(ctx: AgentContext): LegalActions {
  const g = ctx.engine.game; const p = ctx.engine.player(ctx.side); const opp = ctx.engine.player(other(ctx.side));
  const actions: LegalAction[] = [];
  const candidate = (intent: Record<string, unknown>, meaning: string, costGold?: number) => {
    try { ctx.engine.validate(ctx.side, intent); actions.push({ intent, meaning, ...(costGold === undefined ? {} : { costGold }) }); } catch { /* not legal now */ }
  };
  if (g.inSpawnPhase() || !p.hasSpawned() || !p.isAlive()) return { tick: g.ticks(), availableTroops: p.troops(), actions, intentShapes: INTENT_SHAPES, note: 'No player orders are legal until deployment is complete and the player is alive.' };
  const troops = p.troops();
  if (troops > 0) {
    const neutralBorder=[...p.borderTiles()].some(t=>g.neighbors(t).some(n=>g.isLand(n)&&!g.isImpassable(n)&&!g.hasOwner(n)));
    if(neutralBorder)candidate({ type: 'attack', targetID: null, troops: Math.max(1, Math.floor(troops * 0.2)) }, 'Expand into unclaimed adjoining territory (troops adjustable up to available forces)');
    if (p.canAttackPlayer(opp) && p.sharesBorderWith(opp)) candidate({ type: 'attack', targetID: opp.id(), troops: Math.max(1, Math.floor(troops * 0.25)) }, 'Commit forces against the adjacent opposing player (troops adjustable)');
  }
  for (const a of p.outgoingAttacks()) candidate({ type: 'cancel_attack', attackID: a.id() }, `Retreat the attack of ${Math.round(a.troops())} forces`);
  const naval = listNavalOptions(ctx);
  for (const l of naval.landings) candidate(l.intent, l.meaning, l.costGold);
  for (const t of naval.transportsAtSea) if (t.cancelIntent) candidate(t.cancelIntent, `Recall transport #${t.unitId} (${t.troops} forces at ${t.x},${t.y}); returning forces pay the engine's retreat penalty`);
  const seen = new Set<string>();
  const tiles = [...(p.spawnTile() !== undefined ? [p.spawnTile()!] : []), ...sampleTiles(p.borderTiles(), 6), ...sampleTiles(p.tiles(), 6)];
  for (const type of BUILDABLE) {
    if (g.config().isUnitDisabled(type)) continue;
    for (const t of tiles) {
      const at = p.canBuild(type, t); if (at === false) continue;
      const key = `${type}:${at}`; if (seen.has(key)) continue; seen.add(key);
      candidate({ type: 'build_unit', unit: type, tile: at }, `Build ${type} at ${JSON.stringify(xy(ctx, at))}`, unitCost(ctx, p, type) ?? undefined);
      if (actions.length >= 24) break;
    }
  }
  for (const u of p.units()) if (u.isActive() && p.canUpgradeUnit(u)) candidate({ type: 'upgrade_structure', unit: u.type(), unitId: u.id() }, `Upgrade ${u.type()} #${u.id()} (level ${u.level()})`);
  return { tick: g.ticks(), availableTroops: troops, actions, intentShapes: INTENT_SHAPES, naval };
}

/** Upstream intent shapes the engine accepts, in words. Not a promise that a given instance is legal. */
export const INTENT_SHAPES = {
  attack: '{"type":"attack","targetID":null|<opposing player id>,"troops":<number ≤ available forces>}',
  cancel_attack: '{"type":"cancel_attack","attackID":"<own active attack id>"}',
  build_unit: '{"type":"build_unit","unit":"City"|"Defense Post"|"Port"|"Warship","tile":<owned tile ref>}',
  upgrade_structure: '{"type":"upgrade_structure","unit":"<type>","unitId":<own unit id>}',
  boat: '{"type":"boat","dst":<land tile ref>,"troops":<number ≤ available forces>} (needs an owned shore and a water-reachable landing shore of another owner; the `naval` field lists a sampled set, and any other dst is checked by the same validator)',
  cancel_boat: '{"type":"cancel_boat","unitID":<own transport id>} (recalls a transport at sea; listed under `naval.transportsAtSea`)',
  move_warship: '{"type":"move_warship","unitIds":[<own warship ids>],"tile":<water tile ref>}',
};

export function listOwnedUnits(ctx: AgentContext) {
  const p = ctx.engine.player(ctx.side);
  return { tick: ctx.engine.game.ticks(), units: p.units().filter((u) => u.isActive()).map((u) => ({ id: u.id(), type: u.type(), level: u.level(), ...xy(ctx, u.tile()), canUpgrade: p.canUpgradeUnit(u) })) };
}

export function listResources(ctx: AgentContext) {
  const state = ctx.engine.state(); const self = state.players.find((x) => x.side === ctx.side)!;
  const committed = self.attacks.reduce((s, a) => s + a.troops, 0);
  return { tick: state.tick, side: ctx.side, troops: self.troops, maxTroops: self.maxTroops, reserveRatio: self.maxTroops ? Number((self.troops / self.maxTroops).toFixed(3)) : null, gold: self.gold, tiles: self.tiles, attacksInFlight: self.attacks, troopsCommitted: committed, structures: self.units.length, opponent: publicView(state.players.find((x) => x.side !== ctx.side)) };
}

export function listBorderTiles(ctx: AgentContext, limit: number) {
  const g = ctx.engine.game; const p = ctx.engine.player(ctx.side); const opp = ctx.engine.player(other(ctx.side));
  const rows = sampleTiles(p.borderTiles(), limit).map((t) => {
    let unclaimed = 0, opponent = 0, water = 0;
    for (const n of g.neighbors(t)) { if (!g.isLand(n)) water++; else if (!g.hasOwner(n)) unclaimed++; else if (g.ownerID(n) === opp.smallID()) opponent++; }
    return { ...xy(ctx, t), beyond: { unclaimed, opponent, water } };
  });
  return { tick: g.ticks(), borderTileCount: p.numTilesOwned() ? [...p.borderTiles()].length : 0, tiles: rows };
}

export function inspectTile(ctx: AgentContext, raw: unknown) {
  const g = ctx.engine.game; const tile = typeof raw === 'number' ? Math.floor(raw) : Number.NaN;
  if (!Number.isFinite(tile) || !g.isValidRef(tile)) throw new Error('tile must be a valid tile reference on this map');
  const ownerId = g.hasOwner(tile) ? g.ownerID(tile) : null;
  const ownerSide = ownerId === null ? null : (['blue', 'red'] as Side[]).find((s) => ctx.engine.player(s).smallID() === ownerId) ?? null;
  const units = g.units().filter((u) => u.isActive() && u.tile() === tile).map((u) => ({ id: u.id(), type: u.type(), level: u.level(), ownerSide: (['blue', 'red'] as Side[]).find((s) => ctx.engine.player(s) === u.owner()) ?? null }));
  return { ...xy(ctx, tile), land: g.isLand(tile), water: g.isWater(tile), shore: g.isLand(tile) && g.isShore(tile), impassable: g.isLand(tile) && g.isImpassable(tile), ownerSide, ownedByYou: ownerSide === ctx.side, units };
}

export function searchReports(ctx: AgentContext, query: string) {
  const all = ctx.reports(); const superseded = new Set(all.map((r) => r.supersedes).filter(Boolean));
  const q = query.trim().toLowerCase();
  const hits = all.filter((r) => !q || `${r.title} ${r.body ?? ''}`.toLowerCase().includes(q)).slice(-8);
  return { side: ctx.side, count: hits.length, reports: hits.map((r) => ({ id: r.id, tick: r.tick, title: r.title, body: r.body, supersedes: r.supersedes ?? null, superseded: superseded.has(r.id)||r.evidenceStatus==='superseded', observedTroops: r.observedTroops, observedTiles: r.observedTiles,...(r.packet?{packet:r.packet,evidenceStatus:r.evidenceStatus,supersededBy:r.supersededBy,disputedWith:r.disputedWith}:{} ) })) };
}

export function recentOrders(ctx: AgentContext, limit: number) {
  return {side:ctx.side,orders:orderProgress(ctx.events(),limit),meaning:'Admission means the input was recorded. Effects are observed only for City, Defense Post, Port construction and transports on new records; other effects are unobserved.'};
}

/** Free, deterministic change calculation over records the side already holds. */
export function resourceDelta(ctx: AgentContext, sinceTick: number) {
  const est = ctx.reports().filter((r) => r.tick >= sinceTick && typeof r.observedTroops === 'number').map((r) => ({ reportId: r.id, tick: r.tick, troops: r.observedTroops!, tiles: r.observedTiles ?? null }));
  const first = est[0], last = est.at(-1);
  const orders = ctx.events().filter((e) => e.kind === 'command' && e.tick >= sinceTick && e.details.after);
  const lastOrder = orders.at(-1); const self = ctx.engine.state().players.find((x) => x.side === ctx.side)!;
  return {
    tick: ctx.engine.game.ticks(), sinceTick,
    opponentEstimate: { series: est, change: first && last && first !== last ? { troops: last.troops - first.troops, tiles: last.tiles !== null && first.tiles !== null ? last.tiles - first.tiles : null, fromTick: first.tick, toTick: last.tick } : null, basis: 'your side\'s released reports only' },
    ownSinceLastOrder: lastOrder ? { orderEventId: lastOrder.id, orderTick: lastOrder.tick, troops: self.troops - Number(lastOrder.details.after.troops ?? self.troops), tiles: self.tiles - Number(lastOrder.details.after.tiles ?? self.tiles) } : null,
  };
}
