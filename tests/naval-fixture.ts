/**
 * Shared naval fixture on the pinned 16x16 `ocean_and_land` OpenFront test map.
 *
 * Layout (x right, y down): land x 0-7 with a shore column at x=7, open water x 8-15, and a six-tile
 * island at x 14-15, y 6-8 whose interior tile is (15,7). Blue deploys at (5,3) and red at (5,12), so
 * each owns part of the mainland shore; the island is unclaimed land reachable only by transport.
 * Nothing here is geographic: it is an abstract exercise grid.
 */
import path from 'node:path';
import { CLIENTS, ReplayEngine, type EngineOptions, type Side } from '../src/engine/engine';
import { loadMap } from '../src/engine/maps';
import { Config } from '../vendor/openfront/src/core/configuration/Config';
import { Executor } from '../vendor/openfront/src/core/execution/ExecutionManager';
import { Difficulty, GameMapSize, GameMapType, GameMode, GameType, PlayerInfo, PlayerType, UnitType, type Game } from '../vendor/openfront/src/core/game/Game';
import { createGame } from '../vendor/openfront/src/core/game/GameImpl';
import { GameRunner } from '../vendor/openfront/src/core/GameRunner';
import { PseudoRandom } from '../vendor/openfront/src/core/PseudoRandom';
import { simpleHash } from '../vendor/openfront/src/core/Util';
import type { GameConfig, Turn } from '../vendor/openfront/src/core/Schemas';

export const W = 16;
export const T = (x: number, y: number) => y * W + x;
export const BLUE_SPAWN = T(5, 3);
export const RED_SPAWN = T(5, 12);
/** Island shore tile facing the mainland; the natural landing site. */
export const ISLAND_SHORE = T(14, 7);
/** Island interior; a transport ordered here lands on the nearest island shore instead. */
export const ISLAND_INTERIOR = T(15, 7);
export const SETTLE_TICKS = 5;

export async function navalEngine(options: EngineOptions = {}): Promise<ReplayEngine> {
  const e = await ReplayEngine.create({ simulationId: 'NAVAL001', map: 'ocean_and_land', ...options });
  e.step([{ side: 'blue', intent: { type: 'spawn', tile: BLUE_SPAWN } }, { side: 'red', intent: { type: 'spawn', tile: RED_SPAWN } }]);
  for (let i = 0; i < SETTLE_TICKS; i++) e.step();
  return e;
}

export const boat = (side: Side, dst: number, troops: number) => ({ side, intent: { type: 'boat', dst, troops } });

export interface TransportSnapshot { tick: number; fingerprint: string; boats: { id: number; x: number; y: number; troops: number; retreating: boolean }[]; tiles: number; troops: number; attacks: number }
export function snapshot(e: ReplayEngine, side: Side = 'blue'): TransportSnapshot {
  const p = e.player(side); const s = e.state();
  return { tick: s.tick, fingerprint: s.fingerprint, boats: p.units(UnitType.TransportShip).map((b) => ({ id: b.id(), x: e.game.x(b.tile()), y: e.game.y(b.tile()), troops: b.troops(), retreating: b.transportShipState().isRetreating })), tiles: p.numTilesOwned(), troops: p.troops(), attacks: p.outgoingAttacks().length };
}

/**
 * A game built directly with navmesh and water conversion enabled. This is NOT the REPLAY exercise
 * configuration; it exists only to exercise the upstream water-graph rebuild path that the stagger
 * counter governs, which REPLAY's pinned configuration (disableNavMesh, nukes disabled) never reaches.
 */
export async function navmeshGame(sim: string) {
  const { map, mini } = await loadMap(path.resolve('.'), 'ocean_and_land');
  const cfg = { gameMap: GameMapType.World, gameMapSize: GameMapSize.Normal, gameMode: GameMode.FFA, gameType: GameType.Singleplayer, difficulty: Difficulty.Medium, nations: 'disabled', donateGold: false, donateTroops: false, bots: 0, infiniteGold: false, infiniteTroops: false, instantBuild: false, randomSpawn: false, disableNavMesh: false, waterNukes: true, startingGold: 60000, disabledUnits: [], doomsdayClock: { enabled: false } } as unknown as GameConfig;
  const random = new PseudoRandom(simpleHash(sim));
  const players = (['blue', 'red'] as Side[]).map((s) => new PlayerInfo(s, PlayerType.Human, CLIENTS[s], random.nextID(), false));
  const game: Game = createGame(players, [], map, mini, new Config(cfg, null, false));
  let fatal: string | undefined; let motionPlanUpdates = 0;
  const runner = new GameRunner(game, new Executor(game, sim, undefined), (u) => { if ('errMsg' in u) fatal = String(u.errMsg); else if ((u as { packedMotionPlans?: unknown }).packedMotionPlans) motionPlanUpdates++; });
  runner.init();
  let n = 0;
  const step = (intents: Turn['intents'] = []) => { runner.addTurn({ turnNumber: n++, intents }); if (!runner.executeNextTick()) throw new Error(fatal ?? 'tick rejected'); };
  return { game, step, blue: () => game.playerByClientID(CLIENTS.blue)!, motionPlanUpdates: () => motionPlanUpdates };
}

/**
 * Scenario used to show the rebuild mechanism: spawn, queue a 2x2 block of unowned mainland tiles
 * for conversion to water, wait so the throttled graph rebuild lands mid-voyage, then launch one
 * transport to the island and trace it. Returns one string per tick: tick, water-graph version,
 * cumulative motion-plan updates seen by the client callback, boat position.
 */
export async function navmeshTrace(sim: string, sameGameNoopLaunchesFirst = 0) {
  const g = await navmeshGame(sim);
  g.step([{ type: 'spawn', tile: T(5, 2), clientID: CLIENTS.blue }, { type: 'spawn', tile: T(5, 13), clientID: CLIENTS.red }]);
  for (let i = 0; i < SETTLE_TICKS; i++) g.step();
  // Orders that initialise a TransportShipExecution but launch nothing (own territory) still advance the
  // counter. They are issued in one turn so the timeline of the traced voyage is unchanged.
  g.step(Array.from({ length: sameGameNoopLaunchesFirst }, () => ({ type: 'boat' as const, dst: T(5, 2), troops: 1, clientID: CLIENTS.blue })));
  for (const t of [T(6, 6), T(7, 6), T(6, 7), T(7, 7)]) { if (g.game.hasOwner(t)) throw new Error('fixture assumption broken: conversion tile owned'); g.game.queueWaterConversion(t); }
  for (let i = 0; i < 12; i++) g.step();
  g.step([{ type: 'boat', dst: ISLAND_SHORE, troops: 40, clientID: CLIENTS.blue }]);
  const trace: string[] = [];
  for (let i = 0; i < 60; i++) {
    const boats = g.blue().units(UnitType.TransportShip);
    trace.push(`${g.game.ticks()}:v${g.game.waterGraphVersion()}:p${g.motionPlanUpdates()}:${boats.map((b) => `${g.game.x(b.tile())},${g.game.y(b.tile())}`).join('|')}`);
    if (!boats.length && i > 3) break;
    g.step();
  }
  return { trace, game: g.game };
}

/** A separate navmesh game that initialises `n` transport executions in one turn (no voyage), to load any shared counter. */
export async function navmeshNoise(sim: string, n: number) {
  const g = await navmeshGame(sim);
  g.step([{ type: 'spawn', tile: T(5, 2), clientID: CLIENTS.blue }, { type: 'spawn', tile: T(5, 13), clientID: CLIENTS.red }]);
  for (let i = 0; i < SETTLE_TICKS; i++) g.step();
  g.step(Array.from({ length: n }, () => ({ type: 'boat' as const, dst: T(5, 2), troops: 1, clientID: CLIENTS.blue })));
  g.step();
  return g.game;
}
