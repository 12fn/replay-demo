/**
 * Execution feedback: observes what the pinned engine actually did with an admitted order.
 *
 * An admitted intent is not a guarantee of effect. The Executor turns each intent into an Execution
 * object; that object, and only that object, later creates a structure, launches a boat, fails, or is
 * cut short. This module wraps the executions the pinned Executor creates, keyed by the canonical input
 * occurrence (turnNumber + intentIndex + clientID), and reports facts observed inside that execution's
 * own `init`/`tick` calls. Because GameImpl ticks executions one at a time, any resource or ownership
 * change measured across a single execution's call is attributable to that execution alone, so two
 * identical simultaneous orders are never conflated.
 *
 * Scope: `build_unit` for City, Defense Post and Port, and `boat` transports. Every other intent is
 * explicitly unobserved and passes through untouched.
 *
 * Coupling to the pinned engine (vendor/openfront, commit in engine.ts):
 *  - Executor.createExecs(turn) returns executions in intent order; that index is the correlation.
 *  - GameImpl.executeNextTick: existing executions tick first (sequentially), new ones init afterwards.
 *    So an order admitted at engine tick N is initialised at N and first ticks at N+1.
 *  - ConstructionExecution.tick creates the structure via Player.buildUnit on its first tick (gold is
 *    charged there), then completes or stops when the structure is gone. Structures on a conquered tile
 *    are captured (City/Port) or destroyed (Defense Post) by the owner's PlayerExecution.
 *  - TransportShipExecution.init builds the boat and debits troops; tick moves it, lands it (conquers the
 *    landing tile) or returns forces (addTroops then delete).
 *  - No pinned private field is read. Structures and boats are identified by diffing the ordering
 *    player's unit list of that type across the execution's own call. Public accessors only.
 * Nothing here writes to simulation state. Feedback never enters the fingerprint.
 */
import { Executor } from '../../vendor/openfront/src/core/execution/ExecutionManager';
import { ConstructionExecution } from '../../vendor/openfront/src/core/execution/ConstructionExecution';
import { TransportShipExecution } from '../../vendor/openfront/src/core/execution/TransportShipExecution';
import { UnitType, type Execution, type Game, type Player, type Unit } from '../../vendor/openfront/src/core/game/Game';
import type { StampedIntent, Turn } from '../../vendor/openfront/src/core/Schemas';

export const EXECUTION_FEEDBACK_SCHEMA = 'replay.execution-feedback';
export const EXECUTION_FEEDBACK_VERSION = 1;
/** Structures whose construction is observed. Anything else built through `build_unit` is unobserved. */
export const OBSERVED_STRUCTURES: readonly UnitType[] = [UnitType.City, UnitType.DefensePost, UnitType.Port];
/** Default ring-buffer size for undrained events. Oldest events are dropped and counted, never grown. */
export const DEFAULT_FEEDBACK_CAPACITY = 2048;

/** Canonical identity of one recorded input occurrence. */
export interface InputKey { turnNumber: number; intentIndex: number; clientID: string }
export const inputKeyString = (k: InputKey): string => `${k.turnNumber}:${k.intentIndex}:${k.clientID}`;

export type ConstructionStatus = 'construction-started' | 'construction-completed' | 'construction-interrupted' | 'construction-not-started' | 'construction-unconfirmed';
export type TransportStatus = 'transport-launched' | 'transport-landed' | 'transport-forces-returned' | 'transport-not-launched' | 'transport-ended-unconfirmed';
export type FeedbackStatus = ConstructionStatus | TransportStatus | 'observation-failed';

/** Facts measured across the construction execution's own call. Gold values are numbers of the engine's bigint gold. */
export interface ConstructionObservation {
  kind: 'construction';
  unit: UnitType; orderedTile: number;
  /** Ordering player's gold immediately before and after this execution's call, and the difference. */
  goldBefore: number; goldAfter: number; goldDelta: number;
  /** Engine cost quoted for this unit for this player at the moment of the attempt (only on the attempt tick). */
  costAtAttempt?: number; affordableAtAttempt?: boolean;
  /** Set once the structure created by this execution is identified. */
  unitId?: number; structureTile?: number;
  structureActive?: boolean; underConstruction?: boolean;
  /** Client owning the structure at observation; differs from the key's client when it was captured. */
  ownerClientID?: string | null;
  /** When the structure went inactive: whether the engine marked it destroyed by an enemy, and by whom. */
  destroyedByEnemy?: boolean; destroyerClientID?: string | null;
  /** Number of new units of this type that appeared during the attempt when it was not exactly one. */
  newUnitsSeen?: number;
  ticksObserved: number;
}

/** Facts measured across the transport execution's own call. Troop values are the ordering player's reserve. */
export interface TransportObservation {
  kind: 'transport';
  orderedTile: number; orderedTroops: number;
  troopsBefore: number; troopsAfter: number; troopsDelta: number;
  /** Boats the player had at sea and the engine limit, measured before init (only on the launch attempt). */
  transportsAtSeaAtAttempt?: number; transportLimit?: number;
  unitId?: number; launchTile?: number; troopsEmbarked?: number;
  /** Boat's target tile as set by the engine (changes to a home shore on retreat). */
  targetTile?: number;
  /** Owner client of the target tile before and after this call (null: unowned). */
  targetOwnerBefore?: string | null; targetOwnerAfter?: string | null;
  boatActive?: boolean; boatTile?: number;
  /** Tile-to-tile moves seen so far, and whether the boat was ever observed retreating. */
  movesObserved: number; retreatObserved: boolean;
  destroyedByEnemy?: boolean; destroyerClientID?: string | null;
  newUnitsSeen?: number;
  ticksObserved: number;
}

export interface ObservationFailure { kind: 'observation-failure'; message: string }

export interface ExecutionFeedbackEvent {
  schema: typeof EXECUTION_FEEDBACK_SCHEMA;
  version: typeof EXECUTION_FEEDBACK_VERSION;
  key: InputKey;
  keyString: string;
  intent: 'build_unit' | 'boat';
  /** Engine tick (`Game.ticks()`) during which the observation was made; the engine state after that step reports tick+1. */
  tick: number;
  status: FeedbackStatus;
  observed: ConstructionObservation | TransportObservation | ObservationFailure;
}

export interface ExecutionFeedbackOptions {
  /** Maximum undrained events kept; older ones are dropped and counted. */
  capacity?: number;
  /** Optional synchronous listener called as each event is recorded. Its exceptions count as observer failures and never reach the engine. */
  listener?: (event: ExecutionFeedbackEvent) => void;
}

interface Tracker {
  readonly key: InputKey;
  readonly intent: 'build_unit' | 'boat';
  beforeInit(mg: Game, ticks: number): void;
  afterInit(exec: Execution, mg: Game, ticks: number): void;
  beforeTick(ticks: number): void;
  afterTick(exec: Execution, ticks: number): void;
  /** True once a terminal status was emitted; the tracker is then released. */
  done: boolean;
}

const clientOf = (p: { isPlayer(): boolean; clientID?: () => string | null } | undefined | null): string | null =>
  p && p.isPlayer() && typeof p.clientID === 'function' ? (p.clientID() ?? null) : null;
const ownerClient = (mg: Game, tile: number | undefined): string | null | undefined =>
  tile === undefined ? undefined : clientOf(mg.owner(tile) as unknown as { isPlayer(): boolean; clientID?: () => string | null });

/**
 * Drainable, bounded feedback for one engine. Holds only undrained events and the trackers of executions
 * still in flight. No process-global state: each engine owns its own instance.
 */
export class ExecutionFeedback {
  readonly observed: boolean;
  readonly capacity: number;
  private readonly listener: ((event: ExecutionFeedbackEvent) => void) | undefined;
  private buffer: ExecutionFeedbackEvent[] = [];
  private droppedCount = 0;
  private failures = 0;
  private lastFailure: string | undefined;
  private trackers = new Map<string, Tracker>();

  constructor(observed: boolean, options: ExecutionFeedbackOptions = {}) {
    this.observed = observed;
    this.capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_FEEDBACK_CAPACITY));
    this.listener = options.listener;
  }

  /** Remove and return all undrained events in observation order. */
  drain(): ExecutionFeedbackEvent[] { const out = this.buffer; this.buffer = []; return out; }
  /** Undrained events currently held. */
  pending(): number { return this.buffer.length; }
  /** Events discarded because nobody drained within `capacity`. */
  dropped(): number { return this.droppedCount; }
  /** Observer exceptions swallowed so far (engine progression was unaffected), with the last message. */
  observerFailures(): { count: number; last?: string } { return { count: this.failures, ...(this.lastFailure !== undefined ? { last: this.lastFailure } : {}) }; }
  /** Keys of observed executions that have not reached a terminal status. */
  inFlight(): InputKey[] { return [...this.trackers.values()].map((t) => ({ ...t.key })); }
  /** Forget historical events (e.g. after reconstruction) while keeping in-flight correlation. */
  discardHistory(): void { this.buffer = []; this.droppedCount = 0; }

  /** Wrap the executions the pinned Executor created for `turn`, in intent order. Unobserved intents pass through. */
  attach(turn: Turn, execs: Execution[]): Execution[] {
    if (!this.observed) return execs;
    return execs.map((exec, intentIndex) => {
      const intent = turn.intents[intentIndex];
      if (!intent) return exec;
      const tracker = this.trackerFor({ turnNumber: turn.turnNumber, intentIndex, clientID: intent.clientID }, intent, exec);
      if (!tracker) return exec;
      this.trackers.set(inputKeyString(tracker.key), tracker);
      return this.observe(exec, tracker);
    });
  }

  private trackerFor(key: InputKey, intent: StampedIntent, exec: Execution): Tracker | null {
    if (intent.type === 'build_unit' && exec instanceof ConstructionExecution && OBSERVED_STRUCTURES.includes(intent.unit)) {
      return new ConstructionTracker(key, intent.clientID, intent.unit, intent.tile, (e) => this.emit(e));
    }
    if (intent.type === 'boat' && exec instanceof TransportShipExecution) {
      return new TransportTracker(key, intent.clientID, intent.dst, intent.troops, (e) => this.emit(e));
    }
    return null;
  }

  /**
   * A Proxy over the real execution. `init`/`tick` run the target's own method with `this` bound to the
   * target and observe around it; every other member is forwarded to the target. The prototype chain is
   * the target's, so `instanceof` still holds. Observer exceptions are counted and swallowed; an engine
   * exception is re-thrown unchanged after the observation attempt.
   */
  private observe<E extends Execution>(target: E, tracker: Tracker): E {
    const guard = (fn: () => void) => { try { fn(); } catch (err) { this.failures++; this.lastFailure = err instanceof Error ? err.message : String(err); this.emitFailure(tracker, err); } };
    const finish = () => { if (tracker.done) this.trackers.delete(inputKeyString(tracker.key)); };
    const init = (mg: Game, ticks: number): void => {
      guard(() => tracker.beforeInit(mg, ticks));
      try { target.init(mg, ticks); } finally { guard(() => tracker.afterInit(target, mg, ticks)); finish(); }
    };
    const tick = (ticks: number): void => {
      guard(() => tracker.beforeTick(ticks));
      try { target.tick(ticks); } finally { guard(() => tracker.afterTick(target, ticks)); finish(); }
    };
    return new Proxy(target, {
      get(t, prop, _receiver) {
        if (prop === 'init') return init;
        if (prop === 'tick') return tick;
        const value = Reflect.get(t, prop);
        return typeof value === 'function' ? value.bind(t) : value;
      },
    });
  }

  private emit(event: ExecutionFeedbackEvent): void {
    if (this.buffer.length >= this.capacity) { this.buffer.splice(0, this.buffer.length - this.capacity + 1); this.droppedCount++; }
    this.buffer.push(event);
    if (this.listener) { try { this.listener(event); } catch (err) { this.failures++; this.lastFailure = err instanceof Error ? err.message : String(err); } }
  }

  private emitFailure(tracker: Tracker, err: unknown): void {
    // Recorded through the buffer only (not the listener path again) so a throwing listener cannot recurse.
    const event: ExecutionFeedbackEvent = { schema: EXECUTION_FEEDBACK_SCHEMA, version: EXECUTION_FEEDBACK_VERSION, key: { ...tracker.key }, keyString: inputKeyString(tracker.key), intent: tracker.intent, tick: -1, status: 'observation-failed', observed: { kind: 'observation-failure', message: err instanceof Error ? err.message : String(err) } };
    if (this.buffer.length >= this.capacity) { this.buffer.splice(0, this.buffer.length - this.capacity + 1); this.droppedCount++; }
    this.buffer.push(event);
  }
}

/** Executor that hands every created execution to the engine's feedback before the GameRunner schedules it. */
export class ObservedExecutor extends Executor {
  constructor(game: Game, gameID: string, private readonly feedback: ExecutionFeedback) { super(game, gameID, undefined); }
  override createExecs(turn: Turn): Execution[] { return this.feedback.attach(turn, super.createExecs(turn)); }
}

const base = (key: InputKey, intent: 'build_unit' | 'boat', tick: number, status: FeedbackStatus, observed: ExecutionFeedbackEvent['observed']): ExecutionFeedbackEvent =>
  ({ schema: EXECUTION_FEEDBACK_SCHEMA, version: EXECUTION_FEEDBACK_VERSION, key: { ...key }, keyString: inputKeyString(key), intent, tick, status, observed });

class ConstructionTracker implements Tracker {
  readonly intent = 'build_unit' as const;
  done = false;
  private mg!: Game;
  private player: Player | undefined;
  private structure: Unit | null = null;
  private ticksObserved = 0;
  private goldBefore = 0;
  private idsBefore: Set<number> | null = null;
  private costAtAttempt: number | undefined;

  constructor(readonly key: InputKey, private readonly clientID: string, private readonly unit: UnitType, private readonly tile: number, private readonly emit: (e: ExecutionFeedbackEvent) => void) {}

  private facts(goldAfter: number): ConstructionObservation {
    const s = this.structure;
    return {
      kind: 'construction', unit: this.unit, orderedTile: this.tile,
      goldBefore: this.goldBefore, goldAfter, goldDelta: goldAfter - this.goldBefore,
      ...(this.costAtAttempt !== undefined ? { costAtAttempt: this.costAtAttempt, affordableAtAttempt: this.goldBefore >= this.costAtAttempt } : {}),
      ...(s ? { unitId: s.id(), structureTile: s.tile(), structureActive: s.isActive(), underConstruction: s.isUnderConstruction(), ownerClientID: clientOf(s.owner()), destroyedByEnemy: s.wasDestroyedByEnemy(), destroyerClientID: clientOf(s.destroyer()) } : {}),
      ticksObserved: this.ticksObserved,
    };
  }
  private gold(): number { return this.player ? Number(this.player.gold()) : 0; }

  beforeInit(mg: Game): void { this.mg = mg; this.player = mg.playerByClientID(this.clientID) ?? undefined; this.goldBefore = this.gold(); }
  afterInit(exec: Execution, _mg: Game, ticks: number): void {
    if (!exec.isActive()) { this.done = true; this.emit(base(this.key, this.intent, ticks, 'construction-not-started', this.facts(this.gold()))); }
  }
  beforeTick(): void {
    if (this.done) return;
    this.goldBefore = this.gold();
    if (this.structure === null && this.player) {
      this.costAtAttempt = Number(this.mg.unitInfo(this.unit).cost(this.mg, this.player));
      this.idsBefore = new Set(this.player.units(this.unit).map((u) => u.id()));
    }
  }
  afterTick(exec: Execution, ticks: number): void {
    if (this.done) return;
    this.ticksObserved++;
    const goldAfter = this.gold();
    if (this.structure === null) {
      const fresh = this.player && this.idsBefore ? this.player.units(this.unit).filter((u) => !this.idsBefore!.has(u.id())) : [];
      this.idsBefore = null;
      if (fresh.length === 1) {
        this.structure = fresh[0]!;
        this.emit(base(this.key, this.intent, ticks, 'construction-started', this.facts(goldAfter)));
        if (!exec.isActive()) this.terminal(exec, ticks, goldAfter);
      } else if (!exec.isActive()) {
        this.done = true;
        const status: ConstructionStatus = fresh.length === 0 ? 'construction-not-started' : 'construction-unconfirmed';
        this.emit(base(this.key, this.intent, ticks, status, { ...this.facts(goldAfter), newUnitsSeen: fresh.length }));
      } else if (fresh.length > 1) {
        this.done = true;
        this.emit(base(this.key, this.intent, ticks, 'construction-unconfirmed', { ...this.facts(goldAfter), newUnitsSeen: fresh.length }));
      }
      this.costAtAttempt = undefined;
      return;
    }
    if (!exec.isActive()) this.terminal(exec, ticks, goldAfter);
  }
  private terminal(_exec: Execution, ticks: number, goldAfter: number): void {
    this.done = true;
    const s = this.structure!;
    const status: ConstructionStatus = !s.isActive() ? 'construction-interrupted' : !s.isUnderConstruction() ? 'construction-completed' : 'construction-unconfirmed';
    this.emit(base(this.key, this.intent, ticks, status, this.facts(goldAfter)));
  }
}

class TransportTracker implements Tracker {
  readonly intent = 'boat' as const;
  done = false;
  private mg!: Game;
  private player: Player | undefined;
  private boat: Unit | null = null;
  private ticksObserved = 0;
  private movesObserved = 0;
  private retreatObserved = false;
  private troopsBefore = 0;
  private idsBefore: Set<number> | null = null;
  private atSeaAtAttempt: number | undefined;
  private limit: number | undefined;
  private targetOwnerBefore: string | null | undefined;
  private tileBefore: number | undefined;

  constructor(readonly key: InputKey, private readonly clientID: string, private readonly dst: number, private readonly orderedTroops: number, private readonly emit: (e: ExecutionFeedbackEvent) => void) {}

  private troops(): number { return this.player ? this.player.troops() : 0; }
  private facts(troopsAfter: number): TransportObservation {
    const b = this.boat;
    const target = b?.targetTile();
    return {
      kind: 'transport', orderedTile: this.dst, orderedTroops: this.orderedTroops,
      troopsBefore: this.troopsBefore, troopsAfter, troopsDelta: troopsAfter - this.troopsBefore,
      ...(this.atSeaAtAttempt !== undefined ? { transportsAtSeaAtAttempt: this.atSeaAtAttempt, transportLimit: this.limit } : {}),
      ...(b ? { unitId: b.id(), boatActive: b.isActive(), boatTile: b.tile(), troopsEmbarked: b.troops(), targetTile: target, targetOwnerBefore: this.targetOwnerBefore, targetOwnerAfter: ownerClient(this.mg, target), destroyedByEnemy: b.wasDestroyedByEnemy(), destroyerClientID: clientOf(b.destroyer()) } : {}),
      movesObserved: this.movesObserved, retreatObserved: this.retreatObserved,
      ticksObserved: this.ticksObserved,
    };
  }

  beforeInit(mg: Game): void {
    this.mg = mg; this.player = mg.playerByClientID(this.clientID) ?? undefined;
    this.troopsBefore = this.troops();
    if (this.player) { this.atSeaAtAttempt = this.player.unitCount(UnitType.TransportShip); this.limit = mg.config().boatMaxNumber(); this.idsBefore = new Set(this.player.units(UnitType.TransportShip).map((u) => u.id())); }
    this.targetOwnerBefore = ownerClient(mg, this.dst);
  }
  afterInit(exec: Execution, mg: Game, ticks: number): void {
    const troopsAfter = this.troops();
    const fresh = this.player && this.idsBefore ? this.player.units(UnitType.TransportShip).filter((u) => !this.idsBefore!.has(u.id())) : [];
    this.idsBefore = null;
    if (fresh.length === 1) {
      this.boat = fresh[0]!;
      this.targetOwnerBefore = ownerClient(mg, this.boat.targetTile());
      this.emit(base(this.key, this.intent, ticks, 'transport-launched', { ...this.facts(troopsAfter), launchTile: this.boat.tile() }));
      if (!exec.isActive()) this.terminal(ticks, troopsAfter, false);
    } else {
      this.done = true;
      this.emit(base(this.key, this.intent, ticks, fresh.length === 0 ? 'transport-not-launched' : 'transport-ended-unconfirmed', { ...this.facts(troopsAfter), newUnitsSeen: fresh.length }));
    }
    this.atSeaAtAttempt = undefined;
  }
  beforeTick(): void {
    if (this.done || !this.boat) return;
    this.troopsBefore = this.troops();
    this.tileBefore = this.boat.tile();
    this.targetOwnerBefore = ownerClient(this.mg, this.boat.targetTile());
  }
  afterTick(exec: Execution, ticks: number): void {
    if (this.done || !this.boat) return;
    this.ticksObserved++;
    if (this.boat.isActive()) {
      if (this.boat.tile() !== this.tileBefore) this.movesObserved++;
      if (this.boat.transportShipState().isRetreating) this.retreatObserved = true;
    }
    if (!exec.isActive()) this.terminal(ticks, this.troops(), true);
  }
  /**
   * Landed: the boat is gone and the target tile passed to the ordering player during this call.
   * Forces returned: the boat is gone, the target did not change hands, and the reserve rose during this
   * call (the exact amount is in troopsDelta; a retreat landing returns 75%, a blocked path 100%).
   * Anything else (destroyed, captured, or gone for an unobserved reason) is ended-unconfirmed.
   */
  private terminal(ticks: number, troopsAfter: number, ownershipMeasured: boolean): void {
    this.done = true;
    const facts = this.facts(troopsAfter);
    const gained = facts.troopsDelta > 0;
    const client = this.clientID;
    const conquered = ownershipMeasured && facts.targetOwnerBefore !== client && facts.targetOwnerAfter === client;
    const status: TransportStatus = facts.boatActive ? 'transport-ended-unconfirmed' : conquered ? 'transport-landed' : gained && !conquered ? 'transport-forces-returned' : 'transport-ended-unconfirmed';
    this.emit(base(this.key, this.intent, ticks, status, facts));
  }
}
