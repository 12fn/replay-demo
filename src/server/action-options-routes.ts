import type express from 'express';
import {z} from 'zod';
import {UnitType} from '../../vendor/openfront/src/core/game/Game';
import {listNavalOptions, type NavalOptions} from '../agents/tools';
import type {Side} from '../engine/engine';
import type {AuthGuards} from './native-http';
import {ServiceError, type GameService, type Session} from './service';

const BUILDABLE = [UnitType.City, UnitType.DefensePost, UnitType.Port, UnitType.Warship] as const;
const query = z.object({exerciseId: z.string().min(1).max(200)}).strict();

export interface ActionOptionsSnapshot {
  exerciseId: string;
  side: Side;
  tick: number;
  fingerprint: string;
  units: {id: number; type: UnitType; tile: number; level: number; canUpgrade: boolean; underConstruction: boolean; retreating?: boolean}[];
  naval: NavalOptions;
  buildCosts: Record<typeof BUILDABLE[number], number | null>;
}

/** Mount through createApp's authenticated `mount` callback, before its static catch-all. */
export function mountActionOptionsRoutes(app: express.Express, service: GameService) {
  const guards = app.locals.guards as AuthGuards;
  app.get('/api/action-options', guards.requireActive, (req, res, next) => {
    try {
      const {exerciseId} = query.parse(req.query);
      const session = res.locals.session as Session;
      if (exerciseId !== session.activeId) throw new ServiceError(409, 'Exercise selection changed; refresh action options');
      if (session.playbackTick !== null) throw new ServiceError(409, 'Return to live before requesting action options');
      // requireActive has checked this exact session target against the resolved identity and scope.
      // Never select a different owned exercise or accept a browser-supplied side.
      const world = service.world(session.activeId);
      if (world.row.status !== 'running') throw new ServiceError(409, 'Open a live exercise or branch before requesting action options');
      const side = world.row.humanSide;
      const {engine} = world;
      const player = engine.player(side);
      const state = engine.state();
      const snapshot: ActionOptionsSnapshot = {
        exerciseId, side, tick: state.tick, fingerprint: state.fingerprint,
        units: player.units().filter(unit => unit.isActive()).map(unit => ({
          id: unit.id(), type: unit.type(), tile: unit.tile(), level: unit.level(),
          canUpgrade: player.canUpgradeUnit(unit), underConstruction: unit.isUnderConstruction(),
          ...(unit.type() === UnitType.TransportShip ? {retreating: unit.transportShipState().isRetreating} : {}),
        })),
        naval: listNavalOptions(service.agentContext(world, side, 'staff')),
        buildCosts: Object.fromEntries(BUILDABLE.map(type => {
          // Match the agent's cost query: unavailable engine costs are unknown, never guessed.
          try { return [type, Number(engine.game.config().unitInfo(type).cost(engine.game, player))]; }
          catch { return [type, null]; }
        })) as ActionOptionsSnapshot['buildCosts'],
      };
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(snapshot);
    } catch (error) { next(error); }
  });
}
