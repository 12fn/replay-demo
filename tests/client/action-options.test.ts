/**
 * Availability, ownership, live-gate and invalid-target behaviour of the human parity controls.
 * These are the rules that decide whether a control is offered at all; the engine validator remains
 * the authority for anything the public state does not carry (gold, construction progress, reachability).
 */
import { describe, expect, it } from 'vitest';
import type { GameState, PlayerState, Unit } from '../../src/client/api';
import {
  liveGateReason,
  ownFleet,
  structureAt,
  toApiIntent,
  transportRecallOption,
  upgradeOption,
  warshipBuildOption,
  warshipMoveOption,
  type ActionContext,
} from '../../src/client/action-options';

/* ---------------- fixture: 4x3 map, top row water, rest land ----------------
 *  tiles 0..3  water
 *  tiles 4..7  land, blue owns 4,5 ; red owns 6,7
 *  tiles 8..11 land, unclaimed
 */
const W = 4, H = 3;
const WATER = [0, 1, 2, 3];
const land = Array.from({ length: W * H }, (_, i) => (WATER.includes(i) ? 0 : 1));
const owners = Array.from({ length: W * H }, (_, i) => (i === 4 || i === 5 ? 1 : i === 6 || i === 7 ? 2 : 0));

function player(side: 'blue' | 'red', units: Unit[] = [], over: Partial<PlayerState> = {}): PlayerState {
  return { side, id: side === 'blue' ? 'B' : 'R', name: side, smallId: side === 'blue' ? 1 : 2, tiles: 2, troops: 500, gold: 0, maxTroops: 1000, spawn: side === 'blue' ? 4 : 6, alive: true, attacks: [], units, ...over };
}

function state(blue: PlayerState, red: PlayerState, over: Partial<GameState> = {}): GameState {
  return { tick: 10, fingerprint: 'f', simulationId: 's', map: 'test', width: W, height: H, spawning: false, players: [blue, red], owners, land, ...over };
}

const ctx = (s: GameState, selectedTile: number | null, side: 'blue' | 'red' = 'blue'): ActionContext => ({ state: s, side, selectedTile });

const bluePort: Unit = { id: 10, type: 'Port', tile: 4, level: 1 };
const blueCity: Unit = { id: 11, type: 'City', tile: 5, level: 2 };
const blueDefense: Unit = { id: 12, type: 'Defense Post', tile: 5, level: 1 };
const blueWarship: Unit = { id: 20, type: 'Warship', tile: 1, level: 1 };
const blueTransport: Unit = { id: 21, type: 'Transport', tile: 2, level: 1 };
const redCity: Unit = { id: 30, type: 'City', tile: 6, level: 1 };
const redWarship: Unit = { id: 31, type: 'Warship', tile: 3, level: 1 };
const redTransport: Unit = { id: 32, type: 'Transport', tile: 0, level: 1 };

describe('live gate', () => {
  it('blocks every parity order during deployment, before this side is placed, or once eliminated', () => {
    const s = state(player('blue', [bluePort, blueWarship, blueTransport]), player('red'));
    const spawning = ctx({ ...s, spawning: true }, 0);
    const unplaced = ctx(state(player('blue', [bluePort], { spawn: null }), player('red')), 0);
    const dead = ctx(state(player('blue', [bluePort, blueWarship, blueTransport], { alive: false }), player('red')), 0);
    for (const c of [spawning, unplaced, dead]) {
      expect(liveGateReason(c)).not.toBeNull();
      expect(warshipBuildOption(c).available).toBe(false);
      expect(warshipMoveOption(c, blueWarship.id).available).toBe(false);
      expect(transportRecallOption(c, blueTransport.id).available).toBe(false);
      expect(upgradeOption({ ...c, selectedTile: 4 }).available).toBe(false);
    }
    expect(liveGateReason(ctx(s, 0))).toBeNull();
  });

  it('reports a missing player instead of throwing', () => {
    const s = state(player('blue'), player('red'));
    expect(liveGateReason({ state: { ...s, players: [] }, side: 'blue', selectedTile: 0 })).toMatch(/No player/);
  });
});

describe('warship build', () => {
  it('is offered on a water tile when this side owns a Port, with the upstream build_unit intent', () => {
    const o = warshipBuildOption(ctx(state(player('blue', [bluePort]), player('red')), 2));
    expect(o.available).toBe(true);
    expect(o.intent).toEqual({ type: 'build_unit', unit: 'Warship', tile: 2 });
    expect(o.label).toBe('Build Warship at 2,0');
  });

  it('is refused on land, on an invalid tile and with no selection', () => {
    const s = state(player('blue', [bluePort]), player('red'));
    expect(warshipBuildOption(ctx(s, 5))).toMatchObject({ available: false, reason: expect.stringMatching(/water/) });
    expect(warshipBuildOption(ctx(s, 99)).available).toBe(false);
    expect(warshipBuildOption(ctx(s, -1)).available).toBe(false);
    expect(warshipBuildOption(ctx(s, null)).available).toBe(false);
  });

  it('needs a Port of your own; an opponent Port or your own City does not count', () => {
    const redPort: Unit = { id: 40, type: 'Port', tile: 6, level: 1 };
    const noPort = warshipBuildOption(ctx(state(player('blue', [blueCity]), player('red', [redPort])), 2));
    expect(noPort.available).toBe(false);
    expect(noPort.reason).toMatch(/Port is required/);
  });

  it('does not pretend to know the cost: zero gold is still offered and the reason names the engine check', () => {
    const o = warshipBuildOption(ctx(state(player('blue', [bluePort], { gold: 0 }), player('red')), 2));
    expect(o.available).toBe(true);
    expect(o.reason).toMatch(/engine/);
  });
});

describe('structure upgrade', () => {
  it('upgrades your own City or Port on the selected tile with the upstream upgrade_structure intent', () => {
    const s = state(player('blue', [bluePort, blueCity]), player('red'));
    expect(upgradeOption(ctx(s, 4)).intent).toEqual({ type: 'upgrade_structure', unit: 'Port', unitId: 10 });
    const city = upgradeOption(ctx(s, 5));
    expect(city.intent).toEqual({ type: 'upgrade_structure', unit: 'City', unitId: 11 });
    expect(city.label).toBe('Upgrade City at 1,1 to L3');
  });

  it('never targets an opponent structure even when it is the selected tile', () => {
    const o = upgradeOption(ctx(state(player('blue', [blueCity]), player('red', [redCity])), 6));
    expect(o.available).toBe(false);
    expect(o.reason).toMatch(/your own/);
    expect(o.intent).toBeNull();
    expect(structureAt(ctx(state(player('blue'), player('red', [redCity])), 6))).toEqual({ unit: redCity, side: 'red' });
  });

  it('refuses non-upgradable types and empty tiles', () => {
    const s = state(player('blue', [blueDefense, blueWarship]), player('red'));
    expect(upgradeOption(ctx(s, 5)).reason).toMatch(/Defense Post cannot be upgraded/);
    expect(upgradeOption(ctx(s, 1)).reason).toMatch(/Warship cannot be upgraded/);
    expect(upgradeOption(ctx(s, 8)).available).toBe(false);
    expect(upgradeOption(ctx(s, null)).available).toBe(false);
  });
});

describe('fleet', () => {
  it('lists only this side\'s warships and transports, never opponent ships or other unit kinds', () => {
    const trade: Unit = { id: 50, type: 'Trade Ship', tile: 3, level: 1 };
    const s = state(player('blue', [bluePort, blueWarship, blueTransport, trade]), player('red', [redWarship, redTransport]));
    expect(ownFleet(ctx(s, null))).toEqual({ warships: [blueWarship], transports: [blueTransport] });
    expect(ownFleet(ctx(s, null, 'red'))).toEqual({ warships: [redWarship], transports: [redTransport] });
  });
});

describe('warship move', () => {
  const s = state(player('blue', [blueWarship]), player('red', [redWarship]));

  it('moves one own warship to the selected water tile', () => {
    const o = warshipMoveOption(ctx(s, 3), blueWarship.id);
    expect(o.available).toBe(true);
    expect(o.intent).toEqual({ type: 'move_warship', unitIds: [20], tile: 3 });
  });

  it('refuses land, invalid and missing destinations', () => {
    expect(warshipMoveOption(ctx(s, 5), blueWarship.id)).toMatchObject({ available: false, reason: expect.stringMatching(/water/) });
    expect(warshipMoveOption(ctx(s, 12), blueWarship.id).available).toBe(false);
    expect(warshipMoveOption(ctx(s, null), blueWarship.id).available).toBe(false);
  });

  it('refuses an opponent warship id, an unknown id and a non-warship own unit', () => {
    const withTransport = state(player('blue', [blueWarship, blueTransport]), player('red', [redWarship]));
    for (const id of [redWarship.id, 999, blueTransport.id]) {
      const o = warshipMoveOption(ctx(withTransport, 3), id);
      expect(o.available).toBe(false);
      expect(o.intent).toBeNull();
    }
  });
});

describe('transport recall', () => {
  it('recalls one own transport regardless of the selected tile', () => {
    const s = state(player('blue', [blueTransport]), player('red'));
    expect(transportRecallOption(ctx(s, null), blueTransport.id).intent).toEqual({ type: 'cancel_boat', unitID: 21 });
    expect(transportRecallOption(ctx(s, 5), blueTransport.id).available).toBe(true);
  });

  it('refuses opponent transports, unknown ids and own non-transport units', () => {
    const s = state(player('blue', [blueTransport, blueWarship]), player('red', [redTransport]));
    for (const id of [redTransport.id, 999, blueWarship.id]) {
      const o = transportRecallOption(ctx(s, null), id);
      expect(o.available).toBe(false);
      expect(o.intent).toBeNull();
    }
  });
});

describe('wire format', () => {
  it('passes parity intents through to the API unchanged', () => {
    const intent = { type: 'move_warship' as const, unitIds: [20], tile: 3 };
    expect(toApiIntent(intent)).toBe(intent);
  });
});
