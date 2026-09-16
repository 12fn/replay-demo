import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '../../vendor/openfront/src/core/configuration/Config';
import { Executor } from '../../vendor/openfront/src/core/execution/ExecutionManager';
import { Difficulty, GameMapSize, GameMapType, GameMode, GameType, PlayerInfo, PlayerType, UnitType, type Player } from '../../vendor/openfront/src/core/game/Game';
import { createGame } from '../../vendor/openfront/src/core/game/GameImpl';
import { targetTransportTile } from '../../vendor/openfront/src/core/game/TransportShipUtils';
import { PathFinding } from '../../vendor/openfront/src/core/pathfinding/PathFinder';
import { isEngineMap, loadMap, type EngineMap } from './maps';
import { GameRunner } from '../../vendor/openfront/src/core/GameRunner';
import { PseudoRandom } from '../../vendor/openfront/src/core/PseudoRandom';
import { IntentSchema, type GameConfig, type Intent, type StampedIntent, type Turn } from '../../vendor/openfront/src/core/Schemas';
import { simpleHash } from '../../vendor/openfront/src/core/Util';
import { ExecutionFeedback, ObservedExecutor, type ExecutionFeedbackOptions } from './execution-feedback';
export { EXECUTION_FEEDBACK_SCHEMA, EXECUTION_FEEDBACK_VERSION, inputKeyString, type ExecutionFeedback, type ExecutionFeedbackEvent, type InputKey } from './execution-feedback';

export const UPSTREAM_COMMIT = '0f2ef7c43511cfb413a95e07d364139249d6905d';
/**
 * REPLAY-side simulation profile. Bump whenever a REPLAY patch to the pinned engine could change
 * simulation output for new exercises. `naval-isolation/1`: transport-ship rebuild stagger is kept
 * per game instead of per process (vendor/openfront/src/core/execution/TransportShipExecution.ts).
 * Records without a profile are legacy: they replay only if their recorded fingerprints still match.
 */
export const SIMULATION_PROFILE = 'naval-isolation/1';
const NAVAL_INTENTS = new Set(['boat', 'cancel_boat', 'move_warship']);
export type Side = 'blue' | 'red';
export const CLIENTS: Record<Side,string> = {blue:'human001',red:'redai001'};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Pinned fixture maps (see `maps.ts`). The two 16x16 ocean fixtures exist for naval tests and
 * qualification; classic live exercises use `world` (legacy 400x200) or `plains`. New experimental scenarios use `world-500`. `world-500`, `world-1000`
 * and `world-2000` are explicit, higher-resolution derivations of the same fixture for new exercises;
 * the option name is part of the recording and is never rewritten.
 */
export type { EngineMap };
/**
 * Opt-in, versioned transport admission (docs/demo/versioned-transport-admission.md). `launch-water-route/1` also refuses
 * a boat order when the pinned single-source water path finder finds no route from the launch shore the execution would
 * use to its landing shore. Admission only: execution, maps, rules and replay stepping are untouched, and restore never
 * validates. An engine option without the field keeps the original admission, so existing records mean what they meant.
 */
export const TRANSPORT_ADMISSION = 'launch-water-route/1';
export interface EngineOptions { simulationId?:string; map?:EngineMap; startingGold?:number; /** Absent means the original admission. */ transportAdmission?:typeof TRANSPORT_ADMISSION; }
/** Resolved options. `transportAdmission` stays absent unless set, so `record()` of an original-admission engine is unchanged. */
export type ResolvedEngineOptions = Required<Omit<EngineOptions,'transportAdmission'>> & Pick<EngineOptions,'transportAdmission'>;
export interface PlayerState { side:Side; id:string; name:string; smallId:number; tiles:number; troops:number; gold:number; maxTroops:number; spawn:number|null; alive:boolean; attacks:{id:string;target:string|null;troops:number}[]; units:{id:number;type:string;tile:number;level:number}[]; }
export interface GameState { tick:number; fingerprint:string; simulationId:string; map:string; width:number; height:number; spawning:boolean; players:PlayerState[]; owners?:number[]; land?:number[]; }
export interface EngineRecord { version:1; upstreamCommit:string; /** Absent on records made before the profile existed (legacy). */ simulationProfile?:string; options:EngineOptions; turns:Turn[]; fingerprints:Record<number,string>; }
/**
 * How an engine instance is built, as opposed to what it simulates. Never serialized: it is not part of
 * `EngineOptions`, the record or the simulation profile, and it cannot change simulation output.
 * `observeExecution:false` builds an unobserved control whose `feedback.drain()` is always empty.
 */
export interface EngineConstruction { observeExecution?:boolean; feedback?:ExecutionFeedbackOptions; }

export class ReplayEngine {
  readonly runner:GameRunner;
  readonly options:ResolvedEngineOptions;
  readonly turns:Turn[]=[];
  readonly fingerprints:Record<number,string>={};
  /** Observed effects of admitted City/Defense Post/Port builds and boat transports (see execution-feedback.ts). */
  readonly feedback:ExecutionFeedback;
  private fatal:string|undefined;
  private constructor(game:ReturnType<typeof createGame>,options:ResolvedEngineOptions,construction:EngineConstruction){
    this.options=options;
    this.feedback=new ExecutionFeedback(construction.observeExecution??true,construction.feedback);
    const executor=this.feedback.observed?new ObservedExecutor(game,options.simulationId,this.feedback):new Executor(game,options.simulationId,undefined);
    this.runner=new GameRunner(game,executor,(u)=>{if('errMsg' in u)this.fatal=u.errMsg;});
    this.runner.init();
  }

  static async create(options:EngineOptions={},construction:EngineConstruction={}):Promise<ReplayEngine>{
    const opts:ResolvedEngineOptions={simulationId:options.simulationId??'REPLAY01',map:options.map??'plains',startingGold:options.startingGold??60000,...(options.transportAdmission===undefined?{}:{transportAdmission:options.transportAdmission})};
    // A record naming an unknown map or admission rule must fail here, by name, rather than as a missing-file error deep in loading or a silently weaker check.
    if(!isEngineMap(opts.map))throw new Error(`Unknown map option: ${String(opts.map)}`);
    if(opts.transportAdmission!==undefined&&opts.transportAdmission!==TRANSPORT_ADMISSION)throw new Error(`Unknown transport admission option: ${String(opts.transportAdmission)}`);
    const {map,mini}=await loadMap(ROOT,opts.map);
    const cfg:GameConfig={gameMap:GameMapType.World,gameMapSize:GameMapSize.Normal,gameMode:GameMode.FFA,gameType:GameType.Singleplayer,difficulty:Difficulty.Medium,nations:'disabled',donateGold:false,donateTroops:false,bots:0,infiniteGold:false,infiniteTroops:false,instantBuild:false,randomSpawn:false,disableNavMesh:true,startingGold:opts.startingGold,disabledUnits:[UnitType.AtomBomb,UnitType.HydrogenBomb,UnitType.MIRV,UnitType.MissileSilo,UnitType.SAMLauncher,UnitType.Factory],doomsdayClock:{enabled:false}};
    const random=new PseudoRandom(simpleHash(opts.simulationId));
    const players=(['blue','red'] as Side[]).map((s)=>new PlayerInfo(s==='blue'?'Blue Expedition':'Red Expedition',PlayerType.Human,CLIENTS[s],random.nextID(),false));
    const game=createGame(players,[],map,mini,new Config(cfg,null,false));
    return new ReplayEngine(game,opts,construction);
  }

  get game(){return this.runner.game;}
  player(side:Side){const p=this.game.playerByClientID(CLIENTS[side]);if(!p)throw new Error('Unknown engine player');return p;}

  /** Human and model commands use exactly the same validator and upstream intents. */
  validate(side:Side,raw:unknown):Intent{
    const intent=IntentSchema.parse(raw);
    const p=this.player(side);
    const forbidden=['mark_disconnected','kick_player','toggle_pause','update_game_config','toggle_game_start_timer'];
    if(forbidden.includes(intent.type))throw new Error('This is a host capability, not a player order');
    if(intent.type==='spawn'){
      if(!this.game.inSpawnPhase())throw new Error('Deployment phase is complete');
      if(!this.game.isValidRef(intent.tile)||!this.game.isLand(intent.tile)||this.game.hasOwner(intent.tile))throw new Error('Choose unoccupied land');
    }else{
      if(!p.hasSpawned())throw new Error('Player has not deployed');
      if(!p.isAlive())throw new Error('Player has no remaining territory');
    }
    if(intent.type==='attack'){
      if(intent.troops!==null&&(!Number.isFinite(intent.troops)||intent.troops<=0||intent.troops>p.troops()))throw new Error('Order exceeds available forces');
      if(intent.targetID!==null){
        if(!this.game.hasPlayer(intent.targetID)||intent.targetID===p.id())throw new Error('Unknown opposing player');
        if(!(p.canAttackPlayer(this.game.player(intent.targetID)) && p.sharesBorderWith(this.game.player(intent.targetID))))throw new Error('Target is not currently attackable');
      }
    }
    if(intent.type==='build_unit'){
      if(this.game.config().isUnitDisabled(intent.unit))throw new Error('Unit is not in this scenario');
      if(!this.game.isValidRef(intent.tile)||this.game.ownerID(intent.tile)!==p.smallID())throw new Error('Construction requires owned territory');
      if(p.canBuild(intent.unit,intent.tile)===false)throw new Error('Construction unavailable at this location or resource level');
    }
    if(intent.type==='cancel_attack'&&!p.outgoingAttacks().some(a=>a.id()===intent.attackID))throw new Error('Order is not an active owned attack');
    if(intent.type==='boat'){
      if(!(intent.troops>0)||intent.troops>p.troops())throw new Error('Order exceeds available forces');
      const refusal=this.transportRefusal(p,intent.dst);if(refusal)throw new Error(refusal);
    }
    if(intent.type==='upgrade_structure'||intent.type==='delete_unit'||intent.type==='cancel_boat'){
      const id=intent.type==='cancel_boat'?intent.unitID:intent.unitId;
      const unit=this.game.unit(id);
      if(!unit||unit.owner()!==p||!unit.isActive())throw new Error('Unit is not active or owned by this player');
      if(intent.type==='upgrade_structure'&&(unit.type()!==intent.unit||!p.canUpgradeUnit(unit)))throw new Error('Structure cannot be upgraded with current resources');
      if(intent.type==='delete_unit'&&(!p.canDeleteUnit()||!this.game.isLand(unit.tile())||this.game.ownerID(unit.tile())!==p.smallID()))throw new Error('Unit cannot be deleted here or during cooldown');
      if(intent.type==='cancel_boat'&&unit.type()!==UnitType.TransportShip)throw new Error('Unit is not a transport');
    }
    if(intent.type==='move_warship'){
      if(!this.game.isValidRef(intent.tile)||this.game.isLand(intent.tile))throw new Error('Warship destination must be water');
      for(const id of intent.unitIds){const unit=this.game.unit(id);if(!unit||unit.owner()!==p||unit.type()!==UnitType.Warship||!unit.isActive())throw new Error('Warship is not active or owned by this player');}
    }
    if(intent.type==='donate_gold'||intent.type==='donate_troops')throw new Error('Donations are disabled in this scenario');
    return intent;
  }

  /**
   * Why a transport toward `dst` would be dropped by the upstream execution, or null when it would
   * launch. Mirrors the checks TransportShipExecution.init and canBuildTransportShip apply, in the same
   * order, so an admitted boat order is one the engine actually executes rather than silently discards.
   * Without `transportAdmission`, shore reachability is judged at the engine's own coarse water-component
   * level; a route blocked at sea is still possible and returns the forces on arrival failure.
   * `launch-water-route/1` additionally asks the question the transport's first tick asks: a route from the
   * one launch shore the execution picks to its landing. A found route is not a prediction of arrival.
   */
  transportRefusal(p:Player,dst:number):string|null{
    const g=this.game;
    if(!g.isValidRef(dst)||!g.isLand(dst))return 'Transport destination must be valid land';
    if(g.config().isUnitDisabled(UnitType.TransportShip))return 'Transports are not in this scenario';
    const max=g.config().boatMaxNumber();
    if(p.unitCount(UnitType.TransportShip)>=max)return `Transport limit reached (${max} at sea)`;
    const owner=g.owner(dst);
    if(owner===p)return 'Transport cannot target your own territory';
    if(owner.isPlayer()&&!p.canAttackPlayer(owner))return 'Target is not currently attackable';
    const landing=targetTransportTile(g,p,dst);
    if(landing===null)return 'No landing shore near that destination is reachable by water';
    if(p.canBuild(UnitType.TransportShip,dst)===false)return 'No owned shoreline can launch a transport toward that destination';
    if(this.options.transportAdmission===TRANSPORT_ADMISSION&&!this.launchRouteExists(p,landing))return 'No water route from your launch shore to that landing';
    return null;
  }
  /**
   * TransportShipExecution.init resolves the landing, then launches from `canBuild(TransportShip, landing)` and walks
   * the shared single-source water chain from that tile; a null path there is replaced by a one-tile path and the
   * forces come back on the first move. Same calls here, read-only: the chain reads terrain only.
   */
  private launchRouteExists(p:Player,landing:number):boolean{
    const launch=p.canBuild(UnitType.TransportShip,landing);
    if(launch===false)return false;
    try{return PathFinding.Water(this.game).findPath(launch,landing)!==null;}catch{return false;}// the stepper reports a throwing search as NOT_FOUND
  }
  /** Where a transport ordered to `dst` would actually land (the nearest reachable shore of the same owner), or null. */
  transportLanding(p:Player,dst:number):number|null{return this.game.isValidRef(dst)&&this.game.isLand(dst)?targetTransportTile(this.game,p,dst):null;}
  /** Count of recorded naval orders; used to disclose whether a legacy record exercised the patched code path. */
  static navalIntentCount(record:EngineRecord):number{let n=0;for(const t of record.turns)for(const i of t.intents)if(NAVAL_INTENTS.has(i.type))n++;return n;}

  step(orders:{side:Side;intent:unknown}[]=[]):GameState{
    const intents=orders.map(({side,intent})=>({...this.validate(side,intent),clientID:CLIENTS[side]}) as StampedIntent);
    return this.applyTurn({turnNumber:this.turns.length,intents});
  }
  private executeTurn(turn:Turn):void{
    if(turn.turnNumber!==this.turns.length)throw new Error('Noncontiguous turn input');
    const copy=structuredClone(turn);this.runner.addTurn(copy);
    if(!this.runner.executeNextTick())throw new Error(this.fatal??'Engine rejected tick');
    this.turns.push(copy);
  }
  private applyTurn(turn:Turn):GameState{
    this.executeTurn(turn);const state=this.state();this.fingerprints[state.tick]=state.fingerprint;return state;
  }
  state(includeMap=false):GameState{
    const players=(['blue','red'] as Side[]).map(side=>{
      const p=this.player(side);
      return {side,id:p.id(),name:p.displayName(),smallId:p.smallID(),tiles:p.numTilesOwned(),troops:p.troops(),gold:Number(p.gold()),maxTroops:this.game.config().maxTroops(p),spawn:p.spawnTile()??null,alive:p.isAlive(),attacks:p.outgoingAttacks().map(a=>({id:a.id(),target:a.target().isPlayer()?a.target().id():null,troops:a.troops()})),units:p.units().map(u=>({id:u.id(),type:u.type(),tile:u.tile(),level:u.level()}))};
    });
    const owners=Array.from({length:this.game.width()*this.game.height()},(_,i)=>this.game.ownerID(i));
    const fingerprint=createHash('sha256').update(JSON.stringify({tick:this.game.ticks(),players,owners})).digest('hex');
    return {tick:this.game.ticks(),fingerprint,simulationId:this.options.simulationId,map:this.options.map,width:this.game.width(),height:this.game.height(),spawning:this.game.inSpawnPhase(),players,...(includeMap?{owners,land:owners.map((_,i)=>this.game.isLand(i)?1:0)}:{})};
  }
  record():EngineRecord{return {version:1,upstreamCommit:UPSTREAM_COMMIT,simulationProfile:SIMULATION_PROFILE,options:{...this.options},turns:structuredClone(this.turns),fingerprints:{...this.fingerprints}};}
  /**
   * Rebuild a recording. A record stamped with another simulation profile is refused outright. A legacy
   * record (no profile) is never rewritten or assumed compatible: it is re-executed under the current
   * profile and accepted only if its recorded fingerprints still match at every verified tick (the final
   * tick is always verified). A mismatch names both profiles so the cause is not mistaken for corruption.
   * Execution feedback produced while re-executing history is discarded at the end; executions still in
   * flight at `tick` stay correlated, so their later outcome is observed on the restored engine.
   */
  static async restore(record:EngineRecord,tick=record.turns.length,verification:'every-tick'|'checkpoints'='every-tick',construction:EngineConstruction={}):Promise<ReplayEngine>{
    if(record.upstreamCommit!==UPSTREAM_COMMIT)throw new Error('Engine version does not match recording');
    if(record.simulationProfile!==undefined&&record.simulationProfile!==SIMULATION_PROFILE)throw new Error(`Simulation profile ${record.simulationProfile} does not match ${SIMULATION_PROFILE}`);
    if(!Number.isInteger(tick)||tick<0||tick>record.turns.length)throw new Error('Invalid replay tick');
    const engine=await ReplayEngine.create(record.options,construction);
    for(const turn of record.turns.slice(0,tick)){
      engine.executeTurn(turn);const at=engine.game.ticks();
      const expected=record.fingerprints[at];
      if(verification==='every-tick'||at%1000===0||at===tick){
        const fingerprint=engine.state().fingerprint;
        if(expected&&fingerprint!==expected)throw new Error(`Replay fingerprint mismatch at tick ${at}${record.simulationProfile===undefined?` (legacy record without a simulation profile, replayed under ${SIMULATION_PROFILE}; ${ReplayEngine.navalIntentCount(record)} naval orders recorded)`:''}`);
        engine.fingerprints[at]=fingerprint;
      }else if(expected){engine.fingerprints[at]=expected;}
      if(at%50===0)await setImmediate();
    }
    engine.feedback.discardHistory();
    return engine;
  }
}
