/**
 * Pure availability rules for the human order controls that mirror the agent's legal-action catalog
 * (src/agents/tools.ts): Warship construction, structure upgrade, warship movement and transport recall.
 *
 * Everything here is derived from the public game state the client already receives plus the selected
 * tile. It is a UI hint only: the server runs the same engine validator for humans and agents, and the
 * engine remains the authority for gold, construction progress and water reachability, none of which
 * the public state exposes (see docs/process/human-action-parity-notes.md for the seams).
 *
 * Nothing here can name an opponent's unit or a unit the state does not list: every intent is built
 * from the assigned side's own `units` array, so hidden, future or opposing units are never enabled.
 */
import type { GameState, Intent, PlayerState, Side, Unit } from './api';
import { isValidTile, playerBySide, tileToXY } from './lib';

/** Engine unit-type strings as they appear in public state (upstream `UnitType` enum values). */
export const UNIT_TYPE = { city: 'City', port: 'Port', defensePost: 'Defense Post', warship: 'Warship', transport: 'Transport' } as const;

/** Structure types the pinned engine config marks `upgradable`. Defense Post and Warship are not. */
export const UPGRADABLE_TYPES: readonly string[] = [UNIT_TYPE.city, UNIT_TYPE.port];

/** The same typed order contract as the other human controls. */
export type ParityIntent = Intent;

/** Preserve the exact validated intent without a separate wire conversion. */
export function toApiIntent(intent: ParityIntent): Intent {
  return intent;
}

export interface ActionContext {
  state: GameState;
  /** Backend-assigned side. Orders are only ever built for this side's own units. */
  side: Side;
  selectedTile: number | null;
}

export interface ActionOption {
  /** Whether the control should be enabled. */
  available: boolean;
  /** Plain-language reason when unavailable; a short description of the order when available. */
  reason: string;
  /** Receipt/label text for the order. */
  label: string;
  intent: ParityIntent | null;
}

const unavailable = (label: string, reason: string): ActionOption => ({ available: false, reason, label, intent: null });
const available = (label: string, reason: string, intent: ParityIntent): ActionOption => ({ available: true, reason, label, intent });

function me(ctx: ActionContext): PlayerState | undefined {
  return playerBySide(ctx.state, ctx.side);
}

/** Why no player order is legal right now, or null. Mirrors the engine's deployment/alive gate. */
export function liveGateReason(ctx: ActionContext): string | null {
  const p = me(ctx);
  if (!p) return 'No player for this side';
  if (ctx.state.spawning || p.spawn === null) return 'Orders open after deployment is complete';
  if (!p.alive) return 'This side has no remaining territory';
  return null;
}

function xy(ctx: ActionContext, tile: number): string {
  const { x, y } = tileToXY(tile, ctx.state.width);
  return `${x},${y}`;
}

function isWater(ctx: ActionContext, tile: number): boolean {
  return ctx.state.land[tile] === 0;
}

/** Own units only. Opponent units are never returned from here. */
export function ownUnits(ctx: ActionContext): Unit[] {
  return me(ctx)?.units ?? [];
}

/** Own ships that have a player order in the engine: warships (move) and transports at sea (recall). */
export function ownFleet(ctx: ActionContext): { warships: Unit[]; transports: Unit[] } {
  const units = ownUnits(ctx);
  return {
    warships: units.filter((u) => u.type === UNIT_TYPE.warship),
    transports: units.filter((u) => u.type === UNIT_TYPE.transport),
  };
}

/** The structure (if any) on the selected tile, with its owner. Any side's structure may be inspected. */
export function structureAt(ctx: ActionContext): { unit: Unit; side: Side } | null {
  if (!isValidTile(ctx.selectedTile, ctx.state)) return null;
  for (const p of ctx.state.players) {
    const unit = p.units.find((u) => u.tile === ctx.selectedTile);
    if (unit) return { unit, side: p.side };
  }
  return null;
}

/**
 * Warship construction at the selected tile. The engine spawns the ship at the nearest own Port that
 * shares the destination's water body; the public state shows Ports but not their construction state,
 * water component or the gold cost, so those are left to the validator.
 */
export function warshipBuildOption(ctx: ActionContext): ActionOption {
  const label = 'Build Warship';
  const gate = liveGateReason(ctx);
  if (gate) return unavailable(label, gate);
  if (!isValidTile(ctx.selectedTile, ctx.state)) return unavailable(label, 'Select a water tile for the warship');
  if (!isWater(ctx, ctx.selectedTile)) return unavailable(label, 'Warships are built on water, launched from your nearest Port');
  const ports = ownUnits(ctx).filter((u) => u.type === UNIT_TYPE.port);
  if (ports.length === 0) return unavailable(label, 'A Port is required to build warships');
  const at = xy(ctx, ctx.selectedTile);
  return available(`Build Warship at ${at}`, `Launch a warship toward ${at} from your nearest completed Port on this water; cost is checked by the engine`, { type: 'build_unit', unit: 'Warship', tile: ctx.selectedTile });
}

/**
 * Upgrade of the structure on the selected tile. Only the assigned side's own City or Port qualifies;
 * the engine still refuses an upgrade while the structure is under construction or gold is short.
 */
export function upgradeOption(ctx: ActionContext): ActionOption {
  const label = 'Upgrade';
  const gate = liveGateReason(ctx);
  if (gate) return unavailable(label, gate);
  const found = structureAt(ctx);
  if (!found) return unavailable(label, 'Select one of your City or Port structures');
  if (found.side !== ctx.side) return unavailable(label, 'Only your own structures can be upgraded');
  if (!UPGRADABLE_TYPES.includes(found.unit.type)) return unavailable(label, `${found.unit.type} cannot be upgraded`);
  const { unit } = found;
  return available(`Upgrade ${unit.type} at ${xy(ctx, unit.tile)} to L${unit.level + 1}`, `Raise this ${unit.type} from level ${unit.level} to ${unit.level + 1}; cost and construction state are checked by the engine`, { type: 'upgrade_structure', unit: unit.type, unitId: unit.id });
}

/** Move one own warship to the selected water tile. */
export function warshipMoveOption(ctx: ActionContext, unitId: number): ActionOption {
  const label = 'Move warship';
  const gate = liveGateReason(ctx);
  if (gate) return unavailable(label, gate);
  const ship = ownFleet(ctx).warships.find((u) => u.id === unitId);
  if (!ship) return unavailable(label, 'Not one of your active warships');
  if (!isValidTile(ctx.selectedTile, ctx.state)) return unavailable(label, 'Select a water tile as the destination');
  if (!isWater(ctx, ctx.selectedTile)) return unavailable(label, 'Warship destination must be water');
  const at = xy(ctx, ctx.selectedTile);
  return available(`Move warship #${ship.id} to ${at}`, `Order warship #${ship.id} from ${xy(ctx, ship.tile)} to ${at}`, { type: 'move_warship', unitIds: [ship.id], tile: ctx.selectedTile });
}

/**
 * Recall one own transport at sea. The public state does not say whether a transport is already
 * returning, so the button stays enabled and the engine treats a second recall as a no-op.
 */
export function transportRecallOption(ctx: ActionContext, unitId: number): ActionOption {
  const label = 'Recall transport';
  const gate = liveGateReason(ctx);
  if (gate) return unavailable(label, gate);
  const ship = ownFleet(ctx).transports.find((u) => u.id === unitId);
  if (!ship) return unavailable(label, 'Not one of your transports at sea');
  return available(`Recall transport #${ship.id}`, `Turn transport #${ship.id} at ${xy(ctx, ship.tile)} back to your coast; the engine applies its retreat penalty`, { type: 'cancel_boat', unitID: ship.id });
}

/** Whether the selected tile is water, i.e. a candidate warship build site or destination. */
export function selectedWater(ctx: ActionContext): boolean {
  return isValidTile(ctx.selectedTile, ctx.state) && isWater(ctx, ctx.selectedTile);
}
