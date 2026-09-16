import {isDeepStrictEqual} from 'node:util';
/**
 * Offline, file-stepped AI-player trial. An external actual model (Codex, Opus or any other responder the
 * main integrator runs) plays the Blue seat of `crosscurrent-objectives/1` one decision at a time; Red is the
 * scripted `objectives/1` controller exactly as the objective harness runs it. This script NEVER calls a
 * model, CLI, network or API: it writes a prompt, the integrator obtains a JSON choice from real inference,
 * and `step` applies that choice.
 *
 * Every step rebuilds the pinned engine from the canonical saved record (`ReplayEngine.restore`, fingerprint
 * verified) plus the saved objective board and the opponent's queued orders, re-derives the legal
 * candidates and refuses to continue if they differ from the snapshot the model saw. Orders are admitted
 * with `ReplayEngine.validate` at submission and again at tick time, executed through the engine's own turn
 * path (`rawStep`) and scored with the service's `advanceNetwork`, mirroring `runObjectiveMatchup`.
 *
 * Timing is an ACCELERATED PAUSE: the game waits while the model deliberates, then advances a declared
 * number of ticks with no further Blue orders. The native continuous clock (one tick per 100 ms wall-clock
 * that never waits) is not exercised. No human plays; nothing here is evidence of fun, engagement, learning
 * or realistic doctrine. Fictional abstract game only.
 *
 * Red's order cadence is `--opponent-ticks-per-check`: 45 (the controller's native interval, and the meaning of a
 * manifest without the field) checks at every 45-tick boundary; any other value checks on Blue's first decision
 * tick and every N ticks after it. Equal counts of order opportunities are not equal conditions (see `NOT_EQUALIZED`).
 *
 * `--player-context enriched` opts a NEW trial into `enriched/1` (docs/demo/player-context-v2.md): public landmass
 * access, station-directed landings, capped structure sites and a declared set of troop shares. A manifest without
 * the field is `legacy`: candidates, snapshot ids, prompts and accepted responses are exactly as before.
 *
 * `--mode full-game` opts a NEW trial into `full-game/1` (docs/demo/full-game-player-trials.md): enriched/1, Blue 270 / Red 270,
 * up to 45 decisions and a cap at the scenario's objective limit. Without it the short bounds below apply unchanged.
 * A new full-game trial also records `transportAdmission: launch-water-route/1` (docs/demo/versioned-transport-admission.md)
 * in its config and engine record. Saved trials without it keep the original admission, candidates and snapshot ids.
 *
 * `--player-output v1` opts a NEW enriched trial into the `player-output/1` response contract (docs/demo/player-output-contract.md):
 * `share` always present, null only where a share is irrelevant, and a write-once JSON Schema a provider can enforce.
 *
 *   pnpm exec tsx scripts/ai-player-trial.ts init   --dir <new dir> [--seed AIPT0001] [--mode short|full-game] [--ticks-per-decision 270] [--opponent-ticks-per-check 45] [--decisions 6] [--cap-ticks 1800] [--player-context legacy|enriched] [--player-output none|v1]
 *   pnpm exec tsx scripts/ai-player-trial.ts bounds
 *   pnpm exec tsx scripts/ai-player-trial.ts step   --dir <dir> --response <choice.json> --responder "<external label>"
 *   pnpm exec tsx scripts/ai-player-trial.ts status --dir <dir>
 *
 * Artifacts are written once (`wx`, read-only). Only `manifest.json` is replaced, atomically, as the cursor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENTS, ReplayEngine, TRANSPORT_ADMISSION, inputKeyString, type EngineRecord, type ExecutionFeedbackEvent, type Side } from '../src/engine/engine';
import { OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS, objectiveAssess } from '../src/agents/objective-controller';
import { landmasses } from '../src/agents/scripted-controller';
import { listLegalActions, listResources, type AgentContext, type LegalActions } from '../src/agents/tools';
import { NETWORK_DESCRIPTION, NETWORK_RULES, advanceNetwork, createNetworkLayout, initialNetwork, networkOutcome, networkView, type NetworkState, type NetworkView, type Station } from '../src/campaign/network';
import { UnitType } from '../vendor/openfront/src/core/game/Game';
import { selectScenario } from '../src/scenarios/catalog';
import { TICK_SIMULATED_MS, rawStep, spawnTarget } from './qualify-pacing';

export const TRIAL_SCHEMA = 'replay.ai-player-trial/1';
export const CHOICE_SCHEMA = 'replay.ai-player-choice/1';
export const TRIAL_SCENARIO_ID = 'crosscurrent-objectives/1';
export const MODEL_SIDE: Side = 'blue';
export const MAX_DECISIONS = 6;
export const MAX_CAP_TICKS = 1800;
export const MIN_CAP_TICKS = 600;
export const DEFAULT_TICKS_PER_DECISION = 270;
/** Also the value of a manifest written before the option existed. */
export const DEFAULT_OPPONENT_TICKS_PER_CHECK = OBJECTIVE_INTERVAL_TICKS;
/** Fixed at the short-trial value; the full-game horizon does not widen it. */
export const MAX_INTERVAL_TICKS = 900;
/** Shared bound for both sides' intervals: a multiple of 45 from 45 to 900. */
export const validInterval = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= OBJECTIVE_INTERVAL_TICKS && (n as number) <= MAX_INTERVAL_TICKS && (n as number) % OBJECTIVE_INTERVAL_TICKS === 0;
const INTERVAL_HINT = `an integer multiple of ${OBJECTIVE_INTERVAL_TICKS} from ${OBJECTIVE_INTERVAL_TICKS} to ${MAX_INTERVAL_TICKS}`;

/**
 * Explicit opt-in full-game trial: enriched/1 context, Blue 270 / Red 270, up to 45 decisions and a tick cap equal to the
 * scenario's own objective limit, so the run can reach the time-limit ending (or stops earlier on elimination). The 45
 * decisions are a separate subscription/provider authorization for the operator's runner; they are not app inference
 * and do not touch the application's request/USD ledger. A config without `trialMode` is a short trial.
 */
export const FULL_GAME_MODE = 'full-game/1';
export const FULL_GAME_BOUNDS = { playerContext: 'enriched/1', ticksPerDecision: 270, opponentTicksPerCheck: 270, maxDecisions: 45, capTicks: NETWORK_RULES.limitTicks } as const;
export const SHORT_BOUNDS = { maxDecisions: MAX_DECISIONS, capTicks: MAX_CAP_TICKS, minCapTicks: MIN_CAP_TICKS } as const;
export const FULL_GAME_CLAIMS = {
  players: 'Each trial is one external model playing Blue alone against the scripted objectives/1 Red controller. It is not AI-vs-AI and not native continuous play.',
  latency: 'Model latency is paused: the engine waits while the model deliberates, so response time costs no ticks.',
  benchmark: 'Not a validated difficulty or strength benchmark; one seed, one opponent, no human baseline.',
  budget: 'Up to 45 subscription/provider decisions authorized per fresh trial, run by the operator outside this harness. Separate from, and not counted against, the application inference ledger.',
} as const;
export const NOT_EQUALIZED = [
  'Map and spawns: Red starts on the landmass containing three of the five stations.',
  'Order content: Blue picks one of the sampled candidates with amounts fixed by this harness; the Red controller chooses its own orders and troop amounts.',
  'Response latency: the game pauses while the Blue responder deliberates; the Red controller answers instantly. On the native clock that deliberation would cost ticks.',
  'Shared-tick order: when both sides order at the same tick, Blue\'s intent precedes Red\'s in the next turn.',
  'Human experience: no human played. Nothing here measures fun, engagement or learning.',
] as const;
const MAX_RESPONSE_BYTES = 16_000, MAX_RATIONALE_CHARS = 2000;
export const TRIAL_CLAIMS = {
  timing: 'accelerated-pause: the engine waits while the responder deliberates, then advances the declared ticks with no further Blue orders. The native continuous clock (100 ms wall-clock per tick, never waits) is not exercised.',
  responder: 'The responder label is supplied by the operator and is not proof of inference; provider receipts are attached separately by the main integrator.',
  harnessModelCalls: 0, humanPlaytest: false,
  claim: 'Measured legal play by an external responder against the scripted objectives/1 opponent in a fictional abstract game. Not evidence of fun, engagement, learning, AI-player quality or realistic doctrine.',
} as const;

export class TrialRejection extends Error { constructor(readonly code: 'usage' | 'malformed' | 'stale-snapshot' | 'unknown-snapshot' | 'illegal-choice' | 'not-awaiting' | 'integrity', message: string) { super(`${code}: ${message}`); } }

/** Player-context profiles. `legacy` is the meaning of a manifest or snapshot without the field. */
export const PLAYER_CONTEXTS = ['legacy', 'enriched/1'] as const;
export type PlayerContext = (typeof PLAYER_CONTEXTS)[number];
/** enriched/1: the only troop shares a response may select for a troop-bearing candidate, and the one used when it names none. */
export const TROOP_SHARES = [0.1, 0.2, 0.35, 0.5] as const;
export const DEFAULT_TROOP_SHARE = 0.2;
/** enriched/1: structure sites kept per unit type, nearest a station first. */
export const MAX_SITES_PER_STRUCTURE = 3;

/**
 * Opt-in response contract for NEW enriched/1 trials (docs/demo/player-output-contract.md). `share` is always present: a
 * listed number for a candidate with `troopOptions` (no default), and null for "hold" or a candidate without them. A config
 * or snapshot without the field keeps the enriched/1 or legacy response rules, prompts and snapshot ids unchanged.
 */
export const PLAYER_OUTPUT = 'player-output/1';
export const PLAYER_OUTPUT_SCHEMA_FILE = 'initialization/player-output-schema.json';
/** The JSON Schema a provider may enforce on the reply. It narrows shape only; `parseChoice` still decides legality. */
export const playerOutputSchema = () => ({
  type: 'object', additionalProperties: false, required: ['snapshotId', 'choice', 'share', 'rationale'],
  properties: {
    snapshotId: { type: 'string' },
    choice: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string', enum: ['hold'] }] },
    share: { anyOf: [{ type: 'number', enum: [...TROOP_SHARES] }, { type: 'null' }] },
    rationale: { type: 'string', minLength: 1, maxLength: MAX_RATIONALE_CHARS },
  },
});
/** The recorded contract; absent means none. Anything else stops the step rather than guessing how to read a reply. */
export function playerOutputOf(holder: { playerOutput?: unknown }): typeof PLAYER_OUTPUT | undefined {
  if (holder.playerOutput !== undefined && holder.playerOutput !== PLAYER_OUTPUT) throw new TrialRejection('integrity', `playerOutput ${String(holder.playerOutput)} is not ${PLAYER_OUTPUT}`);
  return holder.playerOutput;
}

/** `opponentTicksPerCheck` is absent from manifests written before the option existed; absent means 45. `playerContext` absent means legacy. `trialMode` absent means short. `transportAdmission` absent means the original engine admission; only full-game trials record it. `playerOutput` absent means no response contract. */
export interface TrialConfig { scenarioId: string; seed: string; seat: Side; opponent: string; ticksPerDecision: number; opponentTicksPerCheck?: number; maxDecisions: number; capTicks: number; playerContext?: Exclude<PlayerContext, 'legacy'>; trialMode?: typeof FULL_GAME_MODE; transportAdmission?: typeof TRANSPORT_ADMISSION; playerOutput?: typeof PLAYER_OUTPUT }
export type TrialMode = 'short' | typeof FULL_GAME_MODE;
export interface TroopOption { share: number; troops: number }
/** `defaultShare`/`troopOptions` exist only on enriched/1 troop-bearing candidates; `intent.troops` is the default share's amount. */
export interface Candidate { index: number; intent: Record<string, unknown>; meaning: string; costGold?: number; defaultShare?: number; troopOptions?: TroopOption[] }
export interface Snapshot { schema: string; trialId: string; snapshotId: string; decision: number; tick: number; fingerprint: string; playerContext?: Exclude<PlayerContext, 'legacy'>; transportAdmission?: typeof TRANSPORT_ADMISSION; playerOutput?: typeof PLAYER_OUTPUT; observation: Record<string, unknown>; candidates: Candidate[] }
export interface PendingOrder { side: Side; intent: Record<string, unknown>; decisionTick: number; source: 'model' | typeof OBJECTIVE_CONTROLLER }
export interface Checkpoint { schema: string; tick: number; record: EngineRecord; network: NetworkState; pending: PendingOrder[] }
export interface ParsedChoice { snapshotId: string; choice: number | 'hold'; rationale: string; share?: number }
export interface Manifest {
  schema: string; trialId: string; createdAt: string; updatedAt: string; config: TrialConfig; status: 'awaiting-choice' | 'complete';
  cursor: { decision: number; tick: number; snapshotId: string; prompt: string } | null;
  history: { decision: number; tick: number; snapshotId: string; choice: number | 'hold'; meaning: string | null; intent: Record<string, unknown> | null; key: string | null; responder: string; outcome: string; share?: number }[];
  claims: typeof TRIAL_CLAIMS;
}

// ---------------------------------------------------------------------------------------------
// Arguments and response parsing (pure)
// ---------------------------------------------------------------------------------------------

export function parseTrialArgs(argv: readonly string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, readonly string[]> = { status: ['--dir'], bounds: [], init: ['--dir', '--seed', '--mode', '--ticks-per-decision', '--opponent-ticks-per-check', '--decisions', '--cap-ticks', '--player-context', '--player-output'], step: ['--dir', '--response', '--responder'] };
  if (!command || !flags[command]) throw new TrialRejection('usage', 'command must be init, step, status or bounds');
  // Strict flag/value pairs: a misspelt cadence flag must not silently fall back to the default.
  const given = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, v = rest[i + 1];
    if (!flags[command]!.includes(flag)) throw new TrialRejection('usage', `unknown option ${flag} for ${command}`);
    if (given.has(flag) || v === undefined) throw new TrialRejection('usage', `${flag} must be given once with a value`);
    given.set(flag, v);
  }
  const value = (flag: string) => given.get(flag);
  const int = (flag: string, dflt: number, lo: number, hi: number) => { const n = Number(value(flag) ?? dflt); if (!Number.isInteger(n) || n < lo || n > hi) throw new TrialRejection('usage', `${flag} must be an integer from ${lo} to ${hi}`); return n; };
  const interval = (flag: string, dflt: number) => { const n = Number(value(flag) ?? dflt); if (!validInterval(n)) throw new TrialRejection('usage', `${flag} must be ${INTERVAL_HINT}`); return n; };
  if (command === 'bounds') return { command } as const;
  const dir = value('--dir'); if (!dir) throw new TrialRejection('usage', '--dir is required');
  if (command === 'status') return { command, dir: path.resolve(dir) } as const;
  if (command === 'init') {
    const seed = value('--seed') ?? 'AIPT0001'; if (!/^[A-Za-z0-9-]{1,32}$/.test(seed)) throw new TrialRejection('usage', '--seed must be 1-32 letters, digits or hyphens');
    const mode = value('--mode') ?? 'short'; if (mode !== 'short' && mode !== 'full-game') throw new TrialRejection('usage', '--mode must be short or full-game');
    const full = mode === 'full-game', F = FULL_GAME_BOUNDS;
    const context = value('--player-context') ?? (full ? 'enriched' : 'legacy'); if (context !== 'legacy' && context !== 'enriched') throw new TrialRejection('usage', '--player-context must be legacy or enriched');
    const playerContext: PlayerContext = context === 'enriched' ? 'enriched/1' : 'legacy';
    const output = value('--player-output') ?? 'none'; if (output !== 'none' && output !== 'v1') throw new TrialRejection('usage', '--player-output must be none or v1');
    const playerOutput = output === 'v1' ? PLAYER_OUTPUT : undefined;
    const request = { command, dir: path.resolve(dir), seed, trialMode: full ? FULL_GAME_MODE : 'short' as TrialMode, playerOutput,
      ticksPerDecision: interval('--ticks-per-decision', full ? F.ticksPerDecision : DEFAULT_TICKS_PER_DECISION), opponentTicksPerCheck: interval('--opponent-ticks-per-check', full ? F.opponentTicksPerCheck : DEFAULT_OPPONENT_TICKS_PER_CHECK),
      maxDecisions: full ? int('--decisions', F.maxDecisions, 1, F.maxDecisions) : int('--decisions', MAX_DECISIONS, 1, MAX_DECISIONS), capTicks: full ? int('--cap-ticks', F.capTicks, MIN_CAP_TICKS, F.capTicks) : int('--cap-ticks', MAX_CAP_TICKS, MIN_CAP_TICKS, MAX_CAP_TICKS), playerContext } as const;
    // Full-game values may be restated but not changed.
    checkBounds({ ...request, playerContext: playerContext === 'legacy' ? undefined : playerContext, trialMode: full ? FULL_GAME_MODE : undefined, playerOutput }, 'usage');
    return request;
  }
  if (command === 'step') {
    const response = value('--response'), responder = value('--responder')?.trim();
    if (!response) throw new TrialRejection('usage', '--response is required');
    if (!responder || responder.length > 80 || !/^[\x20-\x7e]+$/.test(responder)) throw new TrialRejection('usage', '--responder must be a printable label of at most 80 characters');
    return { command, dir: path.resolve(dir), response: path.resolve(response), responder } as const;
  }
  throw new TrialRejection('usage', 'command must be init, step or status');
}

/** The configured Red interval; a manifest without the field is a 45-tick trial. Tampered values stop the step. */
export function opponentTicksOf(config: Pick<TrialConfig, 'opponentTicksPerCheck'>) {
  const n = config.opponentTicksPerCheck ?? DEFAULT_OPPONENT_TICKS_PER_CHECK;
  if (!validInterval(n)) throw new TrialRejection('integrity', `manifest opponentTicksPerCheck ${String(n)} is not ${INTERVAL_HINT}`);
  return n;
}

/** The recorded profile; absent means legacy. Anything else stops the step rather than guessing a prompt format. */
export function playerContextOf(holder: { playerContext?: unknown }): PlayerContext {
  const v = holder.playerContext ?? 'legacy';
  if (!PLAYER_CONTEXTS.includes(v as PlayerContext)) throw new TrialRejection('integrity', `playerContext ${String(v)} is not one of ${PLAYER_CONTEXTS.join(', ')}`);
  return v as PlayerContext;
}

/**
 * Bounds for the recorded mode, checked before any engine work: at init with `usage`, and on every step of a saved
 * manifest with `integrity`. Short trials (no `trialMode`) keep 1-6 decisions and a 600-1800 tick cap. A full-game trial
 * must match `FULL_GAME_BOUNDS` exactly, so a saved manifest cannot quietly widen or narrow its horizon.
 */
export function checkBounds(config: Pick<TrialConfig, 'ticksPerDecision' | 'opponentTicksPerCheck' | 'maxDecisions' | 'capTicks'> & { playerContext?: unknown; trialMode?: unknown; transportAdmission?: unknown; playerOutput?: unknown }, code: 'usage' | 'integrity' = 'integrity'): TrialMode {
  const fail = (message: string) => new TrialRejection(code, message);
  if (config.trialMode !== undefined && config.trialMode !== FULL_GAME_MODE) throw fail(`trialMode ${String(config.trialMode)} is not ${FULL_GAME_MODE}`);
  // Absent on short trials and on full-game trials initialized before the rule; otherwise exactly the one known version.
  if (config.transportAdmission !== undefined && (config.transportAdmission !== TRANSPORT_ADMISSION || config.trialMode !== FULL_GAME_MODE)) throw fail(`transportAdmission ${String(config.transportAdmission)} is allowed only as ${TRANSPORT_ADMISSION} on a ${FULL_GAME_MODE} trial`);
  const opponent = config.opponentTicksPerCheck ?? DEFAULT_OPPONENT_TICKS_PER_CHECK;
  if (!validInterval(config.ticksPerDecision) || !validInterval(opponent)) throw fail(`ticksPerDecision and opponentTicksPerCheck must be ${INTERVAL_HINT}`);
  const playerContext = playerContextOf(config);
  // The contract only defines `share` against enriched/1 troop options.
  if (config.playerOutput !== undefined && (config.playerOutput !== PLAYER_OUTPUT || playerContext !== 'enriched/1')) throw fail(`playerOutput ${String(config.playerOutput)} is allowed only as ${PLAYER_OUTPUT} on an enriched/1 trial`);
  if (config.trialMode === FULL_GAME_MODE) {
    const actual = { playerContext, ticksPerDecision: config.ticksPerDecision, opponentTicksPerCheck: opponent, maxDecisions: config.maxDecisions, capTicks: config.capTicks };
    if (!isDeepStrictEqual(actual, { ...FULL_GAME_BOUNDS })) throw fail(`${FULL_GAME_MODE} requires ${JSON.stringify(FULL_GAME_BOUNDS)}; got ${JSON.stringify(actual)}`);
    return FULL_GAME_MODE;
  }
  const int = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
  if (!int(config.maxDecisions, 1, MAX_DECISIONS) || !int(config.capTicks, MIN_CAP_TICKS, MAX_CAP_TICKS)) throw fail(`short trials take 1-${MAX_DECISIONS} decisions and a ${MIN_CAP_TICKS}-${MAX_CAP_TICKS} tick cap`);
  return 'short';
}

/**
 * Whether Red checks after `tick`. At 45 this is the original rule, every 45-tick boundary, including any
 * deployment boundary before Blue's first decision. Any other interval is counted from Blue's first decision tick,
 * so Red checks on that tick and then every N ticks.
 */
export const opponentDue = (opponentTicksPerCheck: number, firstDecisionTick: number) => (tick: number) =>
  tick % OBJECTIVE_INTERVAL_TICKS === 0 && (opponentTicksPerCheck === OBJECTIVE_INTERVAL_TICKS || (tick >= firstDecisionTick && (tick - firstDecisionTick) % opponentTicksPerCheck === 0));

/**
 * Strict: exactly the documented fields, an exact candidate index or "hold", and the current snapshot. Legacy snapshots
 * accept three fields; enriched/1 also accepts `share`, only on a candidate that lists it in `troopOptions`.
 * Under player-output/1 `share` is required: a listed number on a troop-bearing candidate, null on "hold" or any other
 * candidate. Null never stands in for a share and nothing is coerced; a parsed null is returned as no share.
 */
export function parseChoice(raw: string, snapshot: Pick<Snapshot, 'snapshotId' | 'candidates' | 'playerContext' | 'playerOutput'>, previousSnapshotIds: readonly string[] = []): ParsedChoice {
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new TrialRejection('malformed', `response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  let v: unknown; try { v = JSON.parse(raw); } catch { throw new TrialRejection('malformed', 'response is not JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TrialRejection('malformed', 'response must be a JSON object');
  const fields = playerContextOf(snapshot) === 'enriched/1' ? ['snapshotId', 'choice', 'rationale', 'share'] : ['snapshotId', 'choice', 'rationale'];
  const o = v as Record<string, unknown>; const extra = Object.keys(o).filter((k) => !fields.includes(k));
  if (extra.length) throw new TrialRejection('malformed', `unexpected fields: ${extra.join(', ')}`);
  if (typeof o.snapshotId !== 'string') throw new TrialRejection('malformed', 'snapshotId must be a string');
  if (typeof o.rationale !== 'string' || !o.rationale.trim() || o.rationale.length > MAX_RATIONALE_CHARS) throw new TrialRejection('malformed', `rationale must be a non-empty string of at most ${MAX_RATIONALE_CHARS} characters`);
  if (o.snapshotId !== snapshot.snapshotId) throw previousSnapshotIds.includes(o.snapshotId) ? new TrialRejection('stale-snapshot', `${o.snapshotId} was already decided; the current snapshot is ${snapshot.snapshotId}`) : new TrialRejection('unknown-snapshot', `${o.snapshotId} is not the current snapshot ${snapshot.snapshotId}`);
  const contract = playerOutputOf(snapshot) === PLAYER_OUTPUT;
  if (contract && !('share' in o)) throw new TrialRejection('malformed', `share is required under ${PLAYER_OUTPUT}: a listed number for a candidate with troopOptions, null otherwise`);
  if (contract ? o.share !== null && typeof o.share !== 'number' : o.share !== undefined && typeof o.share !== 'number') throw new TrialRejection('malformed', contract ? 'share must be a JSON number or null' : 'share must be a number when given');
  // From here `share` null can only come from the contract.
  if (o.choice === 'hold') {
    if (o.share !== undefined && o.share !== null) throw new TrialRejection('illegal-choice', `"hold" takes no share${contract ? ' (use null)' : ''}`);
    return { snapshotId: o.snapshotId, choice: 'hold', rationale: o.rationale.trim() };
  }
  if (typeof o.choice !== 'number' || !Number.isInteger(o.choice)) throw new TrialRejection('malformed', 'choice must be a candidate index or "hold"');
  if (o.choice < 0 || o.choice >= snapshot.candidates.length) throw new TrialRejection('illegal-choice', `candidate ${o.choice} does not exist (0-${snapshot.candidates.length - 1} or "hold")`);
  const options = snapshot.candidates[o.choice]!.troopOptions;
  if (options && o.share === null) throw new TrialRejection('illegal-choice', `candidate ${o.choice} carries troops: share must be one of ${options.map((t) => t.share).join(', ')}; null is only for "hold" and candidates without troopOptions`);
  if (o.share === undefined || o.share === null) return { snapshotId: o.snapshotId, choice: o.choice, rationale: o.rationale.trim() };
  if (!options?.some((t) => t.share === o.share)) throw new TrialRejection('illegal-choice', options ? `share ${o.share} is not offered for candidate ${o.choice} (${options.map((t) => t.share).join(', ')})` : `candidate ${o.choice} carries no troops and takes no share`);
  return { snapshotId: o.snapshotId, choice: o.choice, rationale: o.rationale.trim(), share: o.share as number };
}

/** The exact intent the snapshot listed for the choice. A declared share only swaps in that option's listed troop amount. */
export const choiceIntent = (snapshot: Pick<Snapshot, 'candidates'>, choice: ParsedChoice['choice'], share?: number) => {
  if (choice === 'hold') return null;
  const c = snapshot.candidates[choice]!; const intent = structuredClone(c.intent);
  if (share === undefined) return intent;
  const option = c.troopOptions?.find((t) => t.share === share);
  if (!option) throw new TrialRejection('illegal-choice', `share ${share} is not offered for candidate ${choice}`);
  return { ...intent, troops: option.troops };
};

// ---------------------------------------------------------------------------------------------
// Engine run (reuses the objective harness loop semantics)
// ---------------------------------------------------------------------------------------------

/** `executed` maps every order processed at tick time to its canonical input key, or null when tick-time validation dropped it. */
interface Run { e: ReplayEngine; layout: Station[]; network: NetworkState; pending: PendingOrder[]; opponentPulses: { tick: number; category: string; intentType: string | null; admittedAtSubmission: boolean; reason: string }[]; executed: Map<PendingOrder, string | null> }
const sides: Side[] = ['blue', 'red'];

function trialScenario() {
  const s = selectScenario(TRIAL_SCENARIO_ID);
  if (s.controller !== OBJECTIVE_CONTROLLER || s.victory !== 'network-score/1') throw new Error(`${TRIAL_SCENARIO_ID} no longer uses ${OBJECTIVE_CONTROLLER} with network scoring`);
  return s;
}

const newRun = (e: ReplayEngine, network: NetworkState, pending: PendingOrder[]): Run => ({ e, layout: createNetworkLayout(e), network, pending, opponentPulses: [], executed: new Map() });

/** Advance tick by tick until `stop` or the cap; the opponent decides after each tick for which `due` holds, before `stop` is checked. */
function advance(run: Run, capTicks: number, stop: (tick: number) => boolean, due: (tick: number) => boolean) {
  const { e } = run; let outcome: ReturnType<typeof networkOutcome> = null;
  while (e.game.ticks() < capTicks) {
    const turnNumber = e.turns.length; const admitted: PendingOrder[] = [];
    // The server validates queued orders again at tick time and drops any that no longer apply.
    for (const o of run.pending) { try { e.validate(o.side, o.intent); admitted.push(o); } catch { run.executed.set(o, null); } }
    admitted.forEach((o, intentIndex) => run.executed.set(o, inputKeyString({ turnNumber, intentIndex, clientID: CLIENTS[o.side] })));
    run.pending = [];
    rawStep(e, admitted.map((o) => ({ side: o.side, intent: o.intent })));
    const tick = e.game.ticks(); const adv = advanceNetwork(e, run.layout, run.network); run.network = adv.state;
    if (tick % NETWORK_RULES.awardEveryTicks === 0) e.fingerprints[tick] = e.state().fingerprint;
    outcome = !e.game.inSpawnPhase() && tick > 50 ? networkOutcome(run.network, { blue: e.player('blue').isAlive(), red: e.player('red').isAlive() }) : null;
    if (outcome) break;
    if (due(tick)) {
      const a =objectiveAssess(e, 'red', adv.view); let ok = false;
      if (a.intent) { try { e.validate('red', a.intent); ok = true; run.pending.push({ side: 'red', intent: a.intent, decisionTick: tick, source: OBJECTIVE_CONTROLLER }); } catch { /* swallowed by the scripted side, like the service */ } }
      // `reason` is the controller's own explanation, kept for the post-hoc receipt only; it never reaches a snapshot or prompt.
      run.opponentPulses.push({ tick, category: a.category, intentType: typeof a.intent?.type === 'string' ? a.intent.type : null, admittedAtSubmission: ok, reason: a.reason });
    }
    if (stop(tick)) break;
  }
  e.fingerprints[e.game.ticks()] = e.state().fingerprint;
  return outcome;
}

const checkpoint = (run: Run): Checkpoint => ({ schema: `${TRIAL_SCHEMA}#checkpoint`, tick: run.e.game.ticks(), record: run.e.record(), network: run.network, pending: run.pending });
const sha = (v: unknown) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const publicSide = (e: ReplayEngine, s: Side) => { const p = e.player(s); return { tiles: p.numTilesOwned(), troops: Math.round(p.troops()), alive: p.isAlive() }; };

/** Public cadence statement. Wording at a 45-tick Red interval is unchanged from trials recorded before the option. */
export const cadence = (ticksPerDecision: number, opponentTicksPerCheck: number = DEFAULT_OPPONENT_TICKS_PER_CHECK) => {
  const b = ticksPerDecision, r = opponentTicksPerCheck, legacy = r === OBJECTIVE_INTERVAL_TICKS;
  const aligned = legacy ? '' : ' Red\'s checks are counted from Blue\'s first decision tick; orders chosen at the same tick execute together on the next tick.';
  const note = b === r ? `Equal cadence: Blue and Red each get one order opportunity per ${b} ticks.${aligned}`
    : r < b ? `Asymmetric cadence: Red may order every ${r} ticks; Blue orders once per ${b} ticks (${b / r} Red opportunities per Blue decision).${aligned}`
      : `Asymmetric cadence: Blue orders once per ${b} ticks; Red may order only every ${r} ticks (${r / b} Blue decisions per Red opportunity).${aligned}`;
  return { blueTicksPerDecision: b, redTicksPerCheck: r, redChecksPerBlueDecision: b / r, note };
};

type PulseCount = Pick<Run['opponentPulses'][number], 'tick' | 'intentType' | 'admittedAtSubmission'>;
/**
 * Actual order opportunities and executions for the final summary. A Red check counts toward the comparison only
 * if its order could still execute: checks before Blue's first decision and at the final tick are reported
 * separately. `initializationPulses` is null for trials initialized before deployment checks were recorded; the
 * Red opportunity counts are then unknown rather than guessed. Counts only; Red reasons stay in the receipts.
 */
export function opportunityCounts(input: { config: TrialConfig; firstDecisionTick: number; finalTick: number; history: Pick<Manifest['history'][number], 'choice' | 'key'>[]; initializationPulses: PulseCount[] | null; stepPulses: PulseCount[]; opponentOrdersAtTick: { executedKey: string | null }[]; opponentPendingAtEnd: number }) {
  const { firstDecisionTick: first, finalTick: last } = input;
  const orders = input.history.filter((h) => h.choice !== 'hold'), executed = orders.filter((h) => h.key !== null).length;
  const blue = { decisionOpportunities: input.history.length, holds: input.history.length - orders.length, ordersSubmitted: orders.length, executedAtTick: executed, droppedAtTick: orders.length - executed };
  const known = input.initializationPulses !== null, pulses = [...(input.initializationPulses ?? []), ...input.stepPulses];
  const count = (f: (p: PulseCount) => boolean) => (known ? pulses.filter(f).length : null);
  const redExecuted = input.opponentOrdersAtTick.filter((o) => o.executedKey !== null).length;
  const red = {
    checksBeforeFirstDecision: count((p) => p.tick < first), checksWithEffect: count((p) => p.tick >= first && p.tick < last), checksAtFinalTick: count((p) => p.tick === last),
    noOrder: count((p) => p.intentType === null), refusedAtSubmission: count((p) => p.intentType !== null && !p.admittedAtSubmission), ordersQueued: count((p) => p.admittedAtSubmission),
    executedAtTick: redExecuted, droppedAtTick: input.opponentOrdersAtTick.length - redExecuted, pendingAtEnd: input.opponentPendingAtEnd,
  };
  const equalOpportunityCount = known ? red.checksBeforeFirstDecision === 0 && red.checksWithEffect === blue.decisionOpportunities : null;
  const ticksPerDecision = input.config.ticksPerDecision, opponentTicksPerCheck = opponentTicksOf(input.config);
  return {
    window: { firstDecisionTick: first, finalTick: last }, ticksPerDecision, opponentTicksPerCheck, equalCadence: ticksPerDecision === opponentTicksPerCheck, equalOpportunityCount, blue, red,
    note: equalOpportunityCount === null ? 'Red checks during initialization were not recorded for this trial, so opportunity parity cannot be stated.'
      : equalOpportunityCount ? `Equal order opportunity counts: each side had ${blue.decisionOpportunities} chances to order that could take effect before tick ${last}, and Red had no checks before Blue's first decision. That is the only thing equalized.`
        : `Unequal order opportunity counts: Blue ${blue.decisionOpportunities}, Red ${red.checksWithEffect} from tick ${first} to ${last}, plus ${red.checksBeforeFirstDecision} Red checks before Blue's first decision.`,
    executedNote: 'Executed means the order passed tick-time validation and entered an engine turn; it is not success. A Red check at the final tick queues an order that cannot execute inside the run.',
    notEqualized: input.config.playerContext === 'enriched/1' ? NOT_EQUALIZED.map((text, index) => index === 1
      ? 'Order content: Blue picks sampled candidates and may choose one of their listed troop shares; the Red controller chooses its own orders and troop amounts.' : text) : NOT_EQUALIZED,
  };
}

/** Harness wording for a candidate: the engine's generic labels offer adjustable troops, but this harness accepts only an index, so amounts are fixed. */
export const harnessMeaning = (meaning: string) => meaning.replace(/\((?:default share, adjustable|troops adjustable(?: up to available forces)?)\)/g, '(amount fixed by this harness)');

type Obs = { tick?: number; ownResources?: Record<string, unknown>; opponentPublic?: Record<string, unknown> | null; objectiveBoard?: { scores?: Record<string, number>; stations?: { id: string; controller: Side | null; heldTiles: Record<Side, number> }[] } };
/**
 * Public change between two recorded Blue observations: own totals, the opponent's public totals, points and
 * station holdings. Derived only from what Blue already saw, so it never reveals opponent orders or intentions.
 */
export function observationDelta(previous: Obs, current: Obs) {
  const num = (o: Record<string, unknown> | null | undefined, k: string) => (typeof o?.[k] === 'number' ? o[k] as number : null);
  const diff = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined, keys: string[]) => Object.fromEntries(keys.map((k) => [k, num(a, k) === null || num(b, k) === null ? null : Math.round(num(b, k)! - num(a, k)!)]));
  const before = new Map((previous.objectiveBoard?.stations ?? []).map((s) => [s.id, s]));
  return {
    fromTick: previous.tick ?? null, toTick: current.tick ?? null,
    own: diff(previous.ownResources, current.ownResources, ['tiles', 'troops', 'gold', 'structures']),
    opponentPublic: { ...diff(previous.opponentPublic, current.opponentPublic, ['tiles', 'troops', 'structures']), alive: current.opponentPublic?.alive ?? null },
    points: diff(previous.objectiveBoard?.scores, current.objectiveBoard?.scores, ['blue', 'red']),
    stations: (current.objectiveBoard?.stations ?? []).map((s) => { const p = before.get(s.id); return { id: s.id, controller: { before: p?.controller ?? null, now: s.controller }, heldTilesChange: { blue: p ? s.heldTiles.blue - p.heldTiles.blue : null, red: p ? s.heldTiles.red - p.heldTiles.red : null } }; }),
    note: 'Public totals only, computed from your previous and current observations. It does not show where tiles changed hands or what the opponent ordered.',
  };
}

const at = (e: ReplayEngine, t: number) => ({ x: e.game.x(t), y: e.game.y(t) });
const otherSide = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');
const controlWord = (c: Side | null, side: Side = MODEL_SIDE) => (c === side ? 'you control' : c ? 'opponent controls' : 'uncontrolled');

/**
 * enriched/1 public access: which landmass each station is on relative to the seat's land (Blue unless given), and how much
 * unclaimed land is left. Terrain labels come from the controller's shared `landmasses` memo and ownership from the shared
 * map, the same public inputs either side's scan reads; nothing from queued orders, pulses or reasons.
 */
export function publicAccess(e: ReplayEngine, view: NetworkView, side: Side = MODEL_SIDE) {
  const g = e.game, p = e.player(side), lm = landmasses(g), oppID = e.player(otherSide(side)).smallID();
  const own = new Set<number>(); let facingUnclaimed = 0, facingOpponent = 0;
  for (const t of p.borderTiles()) {
    const c = lm.label[t]!; if (c >= 0) own.add(c);
    let u = false, o = false;
    for (const nb of g.neighbors(t)) { if (!g.isLand(nb) || g.isImpassable(nb)) continue; if (!g.hasOwner(nb)) u = true; else if (g.ownerID(nb) === oppID) o = true; }
    if (u) facingUnclaimed++; if (o) facingOpponent++;
  }
  const unclaimed = new Map<number, number>(), opponent = new Map<number, number>();
  g.forEachTile((t) => {
    if (!g.isLand(t) || g.isImpassable(t)) return; const c = lm.label[t]!;
    if (!g.hasOwner(t)) unclaimed.set(c, (unclaimed.get(c) ?? 0) + 1); else if (g.ownerID(t) === oppID) opponent.set(c, (opponent.get(c) ?? 0) + 1);
  });
  return {
    ownLandmasses: own.size, borderTilesFacingUnclaimed: facingUnclaimed, borderTilesFacingOpponent: facingOpponent,
    unclaimedTilesOnOwnLandmasses: [...own].reduce((n, c) => n + (unclaimed.get(c) ?? 0), 0),
    stations: view.stations.map((s) => { const c = lm.label[s.tile]!; return { id: s.id, access: own.has(c) ? 'own-landmass' as const : 'transport-only' as const, landmassTiles: lm.sizes[c]!, unclaimedTilesOnLandmass: unclaimed.get(c) ?? 0, opponentTilesOnLandmass: opponent.get(c) ?? 0 }; }),
    note: '`own-landmass`: you hold land on the station\'s landmass, so land orders can reach it unless opponent territory lies between; `transport-only`: you hold no land there, so only a transport can reach it. Land expansion and land attacks press your whole frontier and cannot be aimed at a station. `borderTilesFacingUnclaimed` 0 means no expansion order is possible. Counts are the shared map at this tick; no path or travel time is computed.',
  };
}

/**
 * enriched/1 candidates, derived from the same `listLegalActions` pass as legacy plus the engine's own transport
 * landing and construction-site resolution. Every intent, and every troop option, passed `ReplayEngine.validate` now for
 * `side` (Blue unless given); `legal` must have been listed for the same side.
 */
function enrichedCandidates(e: ReplayEngine, view: NetworkView, legal: LegalActions, side: Side = MODEL_SIDE) {
  // Under launch-water-route/1 a transport names the engine's target shore and what admission checked; without the rule the wording is unchanged.
  const routeChecked = e.options.transportAdmission === TRANSPORT_ADMISSION;
  const routeNote = routeChecked ? '; admitted because a water route existed at this tick from the launch shore the engine would use; arrival not predicted' : '';
  const g = e.game, p = e.player(side), ownID = p.smallID(), oppID = e.player(otherSide(side)).smallID();
  const admitted = (intent: Record<string, unknown>) => { try { e.validate(side, intent); return true; } catch { return false; } };
  const cost = (type: UnitType) => { try { return Number(g.config().unitInfo(type).cost(g, p)); } catch { return undefined; } };
  const basis = Math.floor(p.troops());
  const out: Omit<Candidate, 'index'>[] = [];
  const withTroops = (intent: Record<string, unknown>, meaning: string, costGold?: number) => {
    const troopOptions = TROOP_SHARES.map((share) => ({ share, troops: Math.max(1, Math.floor(share * basis)) })).filter((o) => admitted({ ...intent, troops: o.troops }));
    const dflt = troopOptions.find((o) => o.share === DEFAULT_TROOP_SHARE); if (!dflt) return;
    out.push({ intent: { ...intent, troops: dflt.troops }, meaning, ...(costGold === undefined ? {} : { costGold }), defaultShare: dflt.share, troopOptions });
  };
  const nearestStation = (t: number) => view.stations.map((s) => ({ s, d: g.manhattanDist(t, s.tile) })).sort((a, b) => a.d - b.d || a.s.id.localeCompare(b.s.id))[0]!;
  const troopsText = 'forces set by the chosen share of forces at home (see troopOptions)';

  const kept: LegalActions['actions'] = [];
  for (const a of legal.actions) {
    if (a.intent.type === 'attack') withTroops(a.intent, a.intent.targetID === null ? `Expand into unclaimed land adjoining your territory with ${troopsText}. Presses your whole frontier with unclaimed land; cannot be aimed at a station` : `Attack the opposing player across your shared land border with ${troopsText}. Presses the whole shared border; cannot be aimed at a station`);
    else if (a.intent.type !== 'boat' && a.intent.type !== 'build_unit') kept.push(a);
  }
  // Transport toward each station centre not already yours: the destination Red's controller uses; the engine lands at the nearest reachable shore.
  const landed = new Set<number>(); const boatCost = cost(UnitType.TransportShip);
  const probe = Math.max(1, Math.floor(DEFAULT_TROOP_SHARE * basis));
  for (const s of view.stations) {
    if (g.ownerID(s.tile) === ownID || !admitted({ type: 'boat', dst: s.tile, troops: probe })) continue;
    const landing = e.transportLanding(p, s.tile); if (landing === null || landed.has(landing)) continue; landed.add(landing);
    const owner = !g.hasOwner(landing) ? 'unclaimed' : g.ownerID(landing) === oppID ? 'opponent-held' : 'other-owner';
    withTroops({ type: 'boat', dst: s.tile }, `Transport ${troopsText} toward station ${s.name} (${controlWord(s.controller, side)}); ${routeChecked ? 'engine target shore' : 'lands at'} ${owner} shore ${JSON.stringify(at(e, landing))}, ${g.manhattanDist(landing, s.tile)} tiles from the station centre${s.tiles.includes(landing) ? ', inside its marked land' : ''}${routeNote}`, boatCost);
  }
  for (const l of legal.naval?.landings ?? []) {
    if (!legal.actions.some((a) => a.intent === l.intent) || landed.has(l.landing.tile)) continue; landed.add(l.landing.tile);
    const n = nearestStation(l.landing.tile);
    withTroops({ type: 'boat', dst: l.intent.dst }, `Transport ${troopsText} to ${routeChecked ? 'engine target ' : ''}${l.target === 'opponent' ? 'opponent-held' : 'unclaimed'} shore ${JSON.stringify({ x: l.landing.x, y: l.landing.y })}, ${l.distanceFromCoast} tiles from your coast; nearest station ${n.s.name} (${controlWord(n.s.controller, side)}) ${n.d} tiles away; sampled shore${routeNote}`, l.costGold);
  }
  // Structure sites: the legacy sample plus the engine-resolved site nearest each station centre where you hold land; capped per type.
  const anchors = view.stations.filter((s) => s.held[side] > 0);
  const ref = anchors.length ? anchors : view.stations;
  const sites = new Map<string, { type: UnitType; tile: number; costGold?: number }>();
  for (const a of legal.actions) if (a.intent.type === 'build_unit') sites.set(`${a.intent.unit}:${a.intent.tile}`, { type: a.intent.unit as UnitType, tile: a.intent.tile as number, costGold: a.costGold });
  for (const type of [UnitType.City, UnitType.DefensePost, UnitType.Port, UnitType.Warship]) {
    if (g.config().isUnitDisabled(type)) continue;
    for (const s of anchors) {
      const owned = s.tiles.filter((t) => g.ownerID(t) === ownID).sort((a, b) => g.manhattanDist(a, s.tile) - g.manhattanDist(b, s.tile) || a - b)[0]; if (owned === undefined) continue;
      const tile = p.canBuild(type, owned); if (tile === false || sites.has(`${type}:${tile}`) || !admitted({ type: 'build_unit', unit: type, tile })) continue;
      sites.set(`${type}:${tile}`, { type, tile, costGold: cost(type) });
    }
  }
  const nearestRef = (t: number) => ref.map((s) => ({ s, d: g.manhattanDist(t, s.tile) })).sort((a, b) => a.d - b.d || a.s.id.localeCompare(b.s.id))[0]!;
  const byType = new Map<UnitType, { type: UnitType; tile: number; costGold?: number; near: ReturnType<typeof nearestRef> }[]>();
  for (const site of sites.values()) byType.set(site.type, [...(byType.get(site.type) ?? []), { ...site, near: nearestRef(site.tile) }]);
  const structures: Omit<Candidate, 'index'>[] = [];
  for (const [type, list] of byType) {
    for (const site of list.sort((a, b) => a.near.d - b.near.d || a.tile - b.tile).slice(0, MAX_SITES_PER_STRUCTURE)) {
      structures.push({ intent: { type: 'build_unit', unit: type, tile: site.tile }, meaning: `Build ${type} at ${JSON.stringify(at(e, site.tile))}, ${site.near.d} tiles from station ${site.near.s.name} centre (${controlWord(site.near.s.controller, side)})`, ...(site.costGold === undefined ? {} : { costGold: site.costGold }) });
    }
  }
  return [...out, ...kept.filter((a) => a.intent.type !== 'upgrade_structure').map((a) => ({ intent: a.intent, meaning: a.meaning })), ...structures, ...kept.filter((a) => a.intent.type === 'upgrade_structure').map((a) => ({ intent: a.intent, meaning: a.meaning }))];
}

const OBSERVATION_GAME = 'Fictional abstract strategy game (not a model of any real force or place).';
const ENRICHED_GOAL = `The game is decided by points at tick ${NETWORK_RULES.limitTicks} (${NETWORK_RULES.limitTicks * TICK_SIMULATED_MS / 60000} simulated minutes), or earlier by elimination. A recording of the game may stop before then; a recording that stops early has no result and its points are provisional.`;
/** The listed side's own view of the shared legal/resource tools, run for that side only. */
const seatTools = (e: ReplayEngine, exerciseId: string, side: Side, view: NetworkView) => {
  const ctx: AgentContext = { exerciseId, side, engine: e, reports: () => [], events: () => [], objectives: () => view };
  const legal = listLegalActions(ctx); const { opponent, ...own } = listResources(ctx);
  return { legal, own, opponent };
};
const objectiveBoardFor = (e: ReplayEngine, view: NetworkView, side: Side) => ({ rules: NETWORK_DESCRIPTION, scores: view.scores, priorityId: view.priorityId, nextAwardTick: view.nextAwardTick, nextPriorityTick: view.nextPriorityTick, ownReserve: view.reserve[side], stations: view.stations.map((s) => ({ id: s.id, name: s.name, x: e.game.x(s.tile), y: e.game.y(s.tile), controller: s.controller, heldTiles: s.held, totalTiles: s.total, priority: s.priority })) });
const troopSharesFor = (e: ReplayEngine, side: Side) => ({ forcesAtHome: Math.floor(e.player(side).troops()), shares: [...TROOP_SHARES], defaultShare: DEFAULT_TROOP_SHARE, rule: 'Troops for a share are floor(share x forcesAtHome), at least 1; each listed option passed the engine validator at this tick and is validated again when submitted and when it executes.' });
const enrichedLegalNote = (legal: LegalActions, transportAdmission: string | undefined) => [legal.note, legal.naval?.status === 'unavailable' ? `Naval: ${legal.naval.reason}` : null, `Every candidate passed the engine validator at this tick. Station transports use the station centre as destination and the engine's own landing shore. Other transports are a sample, not every shore. Structure sites: at most ${MAX_SITES_PER_STRUCTURE} per type, nearest a station where you hold land (any station if none).`, transportAdmission ? `Transport admission ${transportAdmission}: a transport is listed only if the engine's water path finder found a route at this tick from the launch shore the engine would use to its target shore, and the same check runs again when the order executes. It does not predict arrival: a boat can still return its forces, be sunk, or reach a shore whose owner has changed.` : null].filter(Boolean).join(' ');

type PreviousDecision = { decision: number; tick: number; choice: number | 'hold'; meaning: string | null; observed: string[]; share?: number };
/** Blue's permitted observation: own resources, the opponent's public totals, the objective board and legal candidates. Never Red's queued orders or controller reasoning. */
export function buildSnapshot(run: Run, trialId: string, decision: number, config: TrialConfig, previous: PreviousDecision[], priorObservation?: Record<string, unknown>): Snapshot {
  const { e } = run; const view = networkView(e, run.layout, run.network); const tick = e.game.ticks();
  const { legal, own, opponent } = seatTools(e, trialId, MODEL_SIDE, view);
  const enriched = playerContextOf(config) === 'enriched/1';
  const fingerprint = e.state().fingerprint;
  const objectiveBoard = objectiveBoardFor(e, view, MODEL_SIDE);
  const legacyNote = [legal.note, legal.naval?.status === 'unavailable' ? `Naval: ${legal.naval.reason}` : legal.naval?.sampling].filter(Boolean).join(' ');
  if (enriched) {
    const candidates: Candidate[] = enrichedCandidates(e, view, legal).map((c, index) => ({ index, ...c }));
    const access = publicAccess(e, view);
    // The admission version joins the id only when recorded, so ids saved before the rule are reproduced exactly.
    const admission = e.options.transportAdmission === undefined ? {} : { transportAdmission: e.options.transportAdmission };
    // Likewise the response contract: a contract trial's ids differ, ids saved without it are unchanged.
    const output = playerOutputOf(config) === undefined ? {} : { playerOutput: PLAYER_OUTPUT } as const;
    const snapshotId = `snap-${sha({ trialId, decision, tick, fingerprint, playerContext: 'enriched/1', ...admission, ...output, access, candidates }).slice(0, 20)}`;
    const observation = {
      game: OBSERVATION_GAME, seat: MODEL_SIDE, decision: decision + 1, tick, simulatedSeconds: tick * TICK_SIMULATED_MS / 1000,
      goal: ENRICHED_GOAL,
      timing: `Accelerated pause: the game waits for your reply, then advances ${config.ticksPerDecision} ticks (${config.ticksPerDecision * TICK_SIMULATED_MS / 1000} simulated seconds) with no further Blue orders. Attacks already under way continue.`,
      cadence: cadence(config.ticksPerDecision, opponentTicksOf(config)),
      ownResources: own, opponentPublic: opponent, objectiveBoard, access,
      troopShares: troopSharesFor(e, MODEL_SIDE),
      legalNote: enrichedLegalNote(legal, admission.transportAdmission),
      previousDecisions: previous,
    };
    if (priorObservation) Object.assign(observation, { sincePreviousObservation: observationDelta(priorObservation as Obs, observation as Obs) });
    return { schema: `${TRIAL_SCHEMA}#snapshot`, trialId, snapshotId, decision, tick, fingerprint, playerContext: 'enriched/1', ...admission, ...output, observation, candidates };
  }
  const candidates: Candidate[] = legal.actions.map((a, index) => ({ index, intent: a.intent, meaning: a.meaning, ...(a.costGold === undefined ? {} : { costGold: a.costGold }) }));
  const snapshotId = `snap-${sha({ trialId, decision, tick, fingerprint, candidates }).slice(0, 20)}`;
  const observation = {
    game: OBSERVATION_GAME, seat: MODEL_SIDE, decision: decision + 1, maxDecisions: config.maxDecisions, tick, simulatedSeconds: tick * TICK_SIMULATED_MS / 1000,
    timing: `Accelerated pause: the game waits for your reply, then advances ${config.ticksPerDecision} ticks (${config.ticksPerDecision * TICK_SIMULATED_MS / 1000} simulated seconds) with no further Blue orders. Attacks already under way continue. The run stops at tick ${config.capTicks}.`,
    cadence: cadence(config.ticksPerDecision, opponentTicksOf(config)),
    ownResources: own, opponentPublic: opponent, objectiveBoard,
    legalNote: legacyNote,
    previousDecisions: previous,
  };
  if (priorObservation) Object.assign(observation, { sincePreviousObservation: observationDelta(priorObservation as Obs, observation as Obs) });
  return { schema: `${TRIAL_SCHEMA}#snapshot`, trialId, snapshotId, decision, tick, fingerprint, observation, candidates };
}

/** Restore a saved checkpoint and derive the snapshot for it. Uses only the record and board at the checkpoint tick. */
export async function snapshotAtCheckpoint(cp: Checkpoint, trialId: string, decision: number, config: TrialConfig) {
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints');
  return buildSnapshot(newRun(e, cp.network, cp.pending), trialId, decision, config, []);
}

export function renderPrompt(s: Snapshot): string {
  if (playerContextOf(s) === 'enriched/1') return renderEnrichedPrompt(s);
  return [
    `# REPLAY AI-player trial: decision ${s.decision + 1}`, '',
    'You are the Blue player in a fictional abstract strategy game scored by stations and reserves. Pursue the strongest legal continuation for Blue. Choose exactly one candidate from `candidates` by its index, or "hold" to issue no order this decision.', '',
    'This harness accepts only a candidate index or "hold". Troop amounts, targets and tiles are fixed exactly as listed; you cannot adjust them.', '',
    ...(typeof (s.observation.cadence as { note?: unknown } | undefined)?.note === 'string' ? [`Cadence: ${(s.observation.cadence as { note: string }).note}`, ''] : []),
    'Station `x`/`y` are station centre coordinates on the same grid as candidate tiles. `sincePreviousObservation`, when present, lists public changes since your last decision.', '',
    'Reply with only this JSON object and nothing else:', '',
    '```json', JSON.stringify({ snapshotId: s.snapshotId, choice: '<candidate index as a number, or "hold">', rationale: '<one to three sentences>' }), '```', '',
    '## Observation', '', '```json', JSON.stringify({ snapshotId: s.snapshotId, ...s.observation, ...(Array.isArray(s.observation.previousDecisions) ? { previousDecisions: (s.observation.previousDecisions as { meaning: string | null }[]).map((p) => ({ ...p, meaning: p.meaning && harnessMeaning(p.meaning) })) } : {}), candidates: s.candidates.map((c) => ({ ...c, meaning: harnessMeaning(c.meaning) })) }, null, 2), '```', '',
  ].join('\n');
}

const SEAT_NAME: Record<Side, string> = { blue: 'Blue', red: 'Red' };
/** enriched/1 prompt. Candidate meanings are printed verbatim, so `decision.json` can store the same text. No run bound is shown. Blue trial wording unless a seat and title are given. */
function renderEnrichedPrompt(s: Pick<Snapshot, 'decision' | 'snapshotId' | 'playerOutput' | 'observation' | 'candidates'>, seat: Side = MODEL_SIDE, title = 'AI-player trial'): string {
  const note = (s.observation.cadence as { note?: unknown } | undefined)?.note;
  const contract = playerOutputOf(s) === PLAYER_OUTPUT;
  return [
    `# REPLAY ${title}: decision ${s.decision + 1}`, '',
    `You are the ${SEAT_NAME[seat]} player in a fictional abstract strategy game. Points come from controlling stations and keeping a reserve (see \`objectiveBoard.rules\`); the game is decided by points at 20 simulated minutes, or earlier by elimination. Pursue the strongest legal continuation for ${SEAT_NAME[seat]}. Choose exactly one candidate from \`candidates\` by its index, or "hold" to issue no order this decision.`, '',
    contract ? `Targets and tiles are fixed exactly as listed. Response contract ${PLAYER_OUTPUT}: \`share\` is always required. For a candidate with \`troopOptions\`, \`share\` MUST be one of its listed values; there is no default. For "hold" and for a candidate without \`troopOptions\`, \`share\` MUST be null.`
      : `Targets and tiles are fixed exactly as listed. A candidate with \`troopOptions\` also accepts an optional \`share\`, one of the listed values; without \`share\` it uses its \`defaultShare\` (the amount already in its intent). Other candidates and "hold" take no \`share\`.`, '',
    ...(typeof note === 'string' ? [`Cadence: ${note}`, ''] : []),
    'Station `x`/`y` are station centre coordinates on the same grid as candidate tiles. `access` says which stations your land orders can reach and how much unclaimed land adjoins you. `sincePreviousObservation`, when present, lists public changes since your last decision.', '',
    contract ? 'Reply with one JSON object and nothing else, with exactly the fields `snapshotId`, `choice`, `share` and `rationale`. `choice` is a numeric candidate index or the string "hold". `share` is a JSON number such as 0.2 or JSON null, never a quoted string or percentage. This is a shape example; select your own legal candidate and share from the observation:'
      : 'Reply with one JSON object and nothing else. `choice` is a numeric candidate index or the string "hold". If present, `share` MUST be a JSON number such as 0.2, never a quoted string or percentage. Omit `share` unless selecting a listed troop option. This is a shape example; select your own legal candidate and share from the observation:', '',
    '```json', JSON.stringify({ snapshotId: s.snapshotId, choice: 0, share: 0.2, rationale: '<one to three sentences>' }), '```', '',
    '## Observation', '', '```json', JSON.stringify({ snapshotId: s.snapshotId, ...s.observation, candidates: s.candidates }, null, 2), '```', '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// seat-context/1: read-only snapshot and prompt for either seat (docs/demo/red-seat-context.md)
// ---------------------------------------------------------------------------------------------

/**
 * Separately versioned from the Blue trial above, which it never changes: the same enriched/1 candidates, access, troop
 * shares and player-output/1 reply contract, derived for whichever seat is named. The seat and this version are part of
 * the snapshot id, so a reply to the other seat's snapshot, or to any trial snapshot, cannot match. Nothing here runs a
 * game loop, queues an order, or calls a model; it is the per-seat input a future two-model runner would need.
 */
export const SEAT_CONTEXT = 'seat-context/1';
export const SEAT_SNAPSHOT_SCHEMA = `${TRIAL_SCHEMA}#seat-snapshot` as const;
export const SEATS = ['blue', 'red'] as const satisfies readonly Side[];
/** One of this seat's own earlier decisions, exactly these fields. There is deliberately no rationale field: free-text reasoning is never carried forward. */
export interface SeatPreviousDecision { seat: Side; decision: number; tick: number; choice: number | 'hold'; meaning: string | null; observed: string[]; share?: number }
export interface SeatCadence { ownTicksPerDecision: number; opponentTicksPerDecision: number }
export interface SeatSnapshotInput {
  /** Read, never stepped. Queued orders are not an input: neither seat's pending orders reach a snapshot. */
  engine: ReplayEngine; network: NetworkState; gameId: string; seat: Side; decision: number; cadence: SeatCadence;
  previousDecisions?: readonly SeatPreviousDecision[];
  /** This seat's own earlier snapshot, for the public `sincePreviousObservation` totals. */
  priorSnapshot?: SeatSnapshot;
}
export interface SeatSnapshot {
  schema: typeof SEAT_SNAPSHOT_SCHEMA; seatContext: typeof SEAT_CONTEXT; gameId: string; seat: Side; snapshotId: string; decision: number; tick: number; fingerprint: string;
  playerContext: 'enriched/1'; transportAdmission?: typeof TRANSPORT_ADMISSION; playerOutput: typeof PLAYER_OUTPUT; observation: Record<string, unknown>; candidates: Candidate[];
}
export type SeatChoice = ParsedChoice & { seat: Side };

const PREVIOUS_FIELDS = ['seat', 'decision', 'tick', 'choice', 'meaning', 'observed', 'share'];
const isSeat = (v: unknown): v is Side => SEATS.includes(v as Side);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The id formula for a seat snapshot, over everything the seat is shown. Recomputed on every read, so an edited copy is refused. */
export const seatSnapshotId = (s: Pick<SeatSnapshot, 'seatContext' | 'gameId' | 'seat' | 'decision' | 'tick' | 'fingerprint' | 'playerContext' | 'transportAdmission' | 'playerOutput' | 'observation' | 'candidates'>) =>
  `seat-${s.seat}-${sha({ seatContext: s.seatContext, gameId: s.gameId, seat: s.seat, decision: s.decision, tick: s.tick, fingerprint: s.fingerprint, playerContext: s.playerContext, ...(s.transportAdmission === undefined ? {} : { transportAdmission: s.transportAdmission }), playerOutput: s.playerOutput, observation: s.observation, candidates: s.candidates }).slice(0, 20)}`;

/** Refuses anything that is not an unaltered seat-context/1 snapshot, including every Blue trial snapshot. */
export function checkSeatSnapshot(s: unknown): asserts s is SeatSnapshot {
  if (!isRecord(s) || s.schema !== SEAT_SNAPSHOT_SCHEMA || s.seatContext !== SEAT_CONTEXT) throw new TrialRejection('integrity', `not a ${SEAT_CONTEXT} snapshot`);
  if (!isSeat(s.seat) || s.playerContext !== 'enriched/1' || s.playerOutput !== PLAYER_OUTPUT || !isRecord(s.observation) || !Array.isArray(s.candidates)) throw new TrialRejection('integrity', `${SEAT_CONTEXT} snapshot fields are malformed`);
  if (s.observation.seat !== s.seat || s.snapshotId !== seatSnapshotId(s as unknown as SeatSnapshot)) throw new TrialRejection('integrity', `${SEAT_CONTEXT} snapshot ${String(s.snapshotId)} does not match its contents`);
}

/** Exactly the declared shape, only this seat's own earlier decisions, in order and before this one. */
function checkPreviousDecisions(list: readonly SeatPreviousDecision[], seat: Side, decision: number, tick: number) {
  let last: SeatPreviousDecision | undefined;
  for (const d of list as readonly unknown[]) {
    if (!isRecord(d)) throw new TrialRejection('usage', 'each previous decision must be an object');
    const extra = Object.keys(d).filter((k) => !PREVIOUS_FIELDS.includes(k));
    if (extra.length) throw new TrialRejection('usage', `previous decisions take only ${PREVIOUS_FIELDS.join(', ')}; unexpected: ${extra.join(', ')}`);
    if (d.seat !== seat) throw new TrialRejection('integrity', `previous decision for ${String(d.seat)} cannot enter the ${seat} seat's context`);
    if (!Number.isInteger(d.decision) || (d.decision as number) < 0 || (d.decision as number) >= decision || (last && (d.decision as number) <= last.decision)) throw new TrialRejection('usage', `previous decision numbers must increase and precede decision ${decision}`);
    if (!Number.isInteger(d.tick) || (d.tick as number) > tick || (last && (d.tick as number) < last.tick)) throw new TrialRejection('usage', `previous decision ticks must not decrease or exceed tick ${tick}`);
    if (d.choice !== 'hold' && !(Number.isInteger(d.choice) && (d.choice as number) >= 0)) throw new TrialRejection('usage', 'previous choice must be a candidate index or "hold"');
    if (d.meaning !== null && typeof d.meaning !== 'string') throw new TrialRejection('usage', 'previous meaning must be a string or null');
    if (!Array.isArray(d.observed) || !d.observed.every((o) => typeof o === 'string')) throw new TrialRejection('usage', 'previous observed must be a list of strings');
    if (d.share !== undefined && !TROOP_SHARES.includes(d.share as (typeof TROOP_SHARES)[number])) throw new TrialRejection('usage', `previous share must be one of ${TROOP_SHARES.join(', ')}`);
    last = d as unknown as SeatPreviousDecision;
  }
}

const seatCadenceNote = ({ ownTicksPerDecision: own, opponentTicksPerDecision: opp }: SeatCadence) => (own === opp
  ? `Equal cadence: you and the opponent each get one order opportunity per ${own} ticks.`
  : `Asymmetric cadence: you may order once per ${own} ticks; the opponent may order once per ${opp} ticks.`);

/**
 * The named seat's permitted observation at the engine's current tick: its own resources, reserve, troop shares, access and
 * legal candidates, the opponent's public totals, and the shared objective board. Station controllers stay literal side
 * names; candidate wording is relative to the seat. Never either side's queued orders, controller pulses or reasons, or any
 * earlier free-text rationale. Reads the engine and a copy of the network; mutates neither.
 */
export function buildSeatSnapshot(input: SeatSnapshotInput): SeatSnapshot {
  const { engine: e, seat, gameId, decision, cadence: c } = input;
  if (!isSeat(seat)) throw new TrialRejection('usage', `seat must be one of ${SEATS.join(', ')}`);
  if (typeof gameId !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(gameId)) throw new TrialRejection('usage', 'gameId must be 1-80 letters, digits, dots, colons, underscores or hyphens');
  if (!Number.isInteger(decision) || decision < 0) throw new TrialRejection('usage', 'decision must be a non-negative integer');
  if (!isRecord(c) || !validInterval(c.ownTicksPerDecision) || !validInterval(c.opponentTicksPerDecision)) throw new TrialRejection('usage', `cadence ticks must be ${INTERVAL_HINT}`);
  const tick = e.game.ticks();
  if (input.network.tick !== tick) throw new TrialRejection('integrity', `network board is at tick ${input.network.tick}, engine at ${tick}`);
  const previous = input.previousDecisions ?? [];
  checkPreviousDecisions(previous, seat, decision, tick);
  const prior = input.priorSnapshot;
  if (prior !== undefined) {
    checkSeatSnapshot(prior);
    if (prior.seat !== seat || prior.gameId !== gameId || prior.decision >= decision || prior.tick > tick) throw new TrialRejection('integrity', `prior snapshot ${prior.snapshotId} is not an earlier ${seat} snapshot of ${gameId}`);
  }

  const view = networkView(e, createNetworkLayout(e), structuredClone(input.network));
  const { legal, own, opponent } = seatTools(e, gameId, seat, view);
  const candidates: Candidate[] = enrichedCandidates(e, view, legal, seat).map((cand, index) => ({ index, ...cand }));
  const access = publicAccess(e, view, seat);
  const admission = e.options.transportAdmission === undefined ? {} : { transportAdmission: e.options.transportAdmission };
  const observation: Record<string, unknown> = {
    game: OBSERVATION_GAME, seatContext: SEAT_CONTEXT, seat, opponent: otherSide(seat), decision: decision + 1, tick, simulatedSeconds: tick * TICK_SIMULATED_MS / 1000,
    goal: ENRICHED_GOAL,
    timing: `Your next decision comes ${c.ownTicksPerDecision} ticks (${c.ownTicksPerDecision * TICK_SIMULATED_MS / 1000} simulated seconds) after this one. Attacks already under way continue. Whether the game waits while you deliberate is set by the game runner, not by this snapshot.`,
    cadence: { ...c, note: seatCadenceNote(c) },
    ownResources: own, opponentPublic: opponent, objectiveBoard: objectiveBoardFor(e, view, seat), access,
    troopShares: troopSharesFor(e, seat),
    legalNote: enrichedLegalNote(legal, admission.transportAdmission),
    previousDecisions: previous.map((d) => ({ decision: d.decision + 1, tick: d.tick, choice: d.choice, meaning: d.meaning, observed: [...d.observed], ...(d.share === undefined ? {} : { share: d.share }) })),
  };
  if (prior) observation.sincePreviousObservation = observationDelta(prior.observation as Obs, observation as Obs);
  const base: Omit<SeatSnapshot, 'snapshotId'> = { schema: SEAT_SNAPSHOT_SCHEMA, seatContext: SEAT_CONTEXT, gameId, seat, decision, tick, fingerprint: e.state().fingerprint, playerContext: 'enriched/1', ...admission, playerOutput: PLAYER_OUTPUT, observation, candidates };
  return { ...base, snapshotId: seatSnapshotId(base) };
}

/** Restore a saved checkpoint and derive a seat snapshot from its record and board. The checkpoint's queued orders are never read. */
export async function seatSnapshotAtCheckpoint(cp: Checkpoint, input: Omit<SeatSnapshotInput, 'engine' | 'network'>) {
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints');
  return buildSeatSnapshot({ ...input, engine: e, network: cp.network });
}

/** The player-output/1 prompt for the snapshot's seat. Only a verified seat-context/1 snapshot is rendered. */
export function renderSeatPrompt(s: SeatSnapshot): string {
  checkSeatSnapshot(s);
  return renderEnrichedPrompt(s, s.seat, `${SEAT_NAME[s.seat]} seat (${SEAT_CONTEXT})`);
}

/**
 * Strict player-output/1 parsing against a verified seat snapshot, reusing `parseChoice`. A reply carrying the other seat's
 * snapshot id, or a Blue trial id, is `unknown-snapshot`; `previousSnapshotIds` should list only this seat's earlier ids.
 * `choiceIntent` maps the result to the listed intent unchanged.
 */
export function parseSeatChoice(raw: string, snapshot: SeatSnapshot, previousSnapshotIds: readonly string[] = []): SeatChoice {
  checkSeatSnapshot(snapshot);
  const foreign = previousSnapshotIds.filter((id) => !id.startsWith(`seat-${snapshot.seat}-`));
  if (foreign.length) throw new TrialRejection('usage', `previous snapshot ids must be ${snapshot.seat} seat ids; got ${foreign.join(', ')}`);
  try { return { ...parseChoice(raw, snapshot, previousSnapshotIds), seat: snapshot.seat }; } catch (err) {
    if (!(err instanceof TrialRejection) || err.code !== 'unknown-snapshot') throw err;
    const id = (JSON.parse(raw) as { snapshotId: string }).snapshotId;
    const other = otherSide(snapshot.seat);
    if (id.startsWith(`seat-${other}-`)) throw new TrialRejection('unknown-snapshot', `${id} is a ${other} seat snapshot; this reply is for the ${snapshot.seat} seat snapshot ${snapshot.snapshotId}`);
    if (id.startsWith('snap-')) throw new TrialRejection('unknown-snapshot', `${id} is an AI-player trial snapshot, not ${SEAT_CONTEXT}; the current ${snapshot.seat} seat snapshot is ${snapshot.snapshotId}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Files: write-once artifacts, atomically replaced manifest
// ---------------------------------------------------------------------------------------------

const rel = (n: number) => String(n).padStart(2, '0');
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const writeOnce = (file: string, data: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { flag: 'wx', mode: 0o444 }); };
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
function writeManifest(dir: string, m: Manifest) { const tmp = path.join(dir, `.manifest.${crypto.randomUUID()}.tmp`); fs.writeFileSync(tmp, json(m), { flag: 'wx' }); fs.renameSync(tmp, path.join(dir, 'manifest.json')); }
/** Build artifact directories in a private staging area, then move each into place only if its target does not exist. */
function commitStaged(dir: string, build: (stage: string) => string[]) {
  const stage = path.join(dir, `.staging-${crypto.randomUUID()}`); fs.mkdirSync(stage);
  try {
    const parts = build(stage);
    for (const p of parts) if (fs.existsSync(path.join(dir, p))) throw new TrialRejection('integrity', `${p} already exists; artifacts are never replaced`);
    for (const p of parts) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.renameSync(path.join(stage, p), path.join(dir, p)); }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
const stageDecision = (stage: string, snap: Snapshot, cp: Checkpoint) => { const d = `decisions/${rel(snap.decision)}`; writeOnce(path.join(stage, d, 'snapshot.json'), json(snap)); writeOnce(path.join(stage, d, 'prompt.md'), renderPrompt(snap)); writeOnce(path.join(stage, d, 'replay.json'), JSON.stringify(cp) + '\n'); return d; };
const cursorFor = (s: Snapshot): Manifest['cursor'] => ({ decision: s.decision, tick: s.tick, snapshotId: s.snapshotId, prompt: `decisions/${rel(s.decision)}/prompt.md` });

/** Write-once record of a full-game trial's mode and bounds. Every step requires the replaceable manifest to still match it. */
export const RUN_MANIFEST = 'initialization/run-manifest.json';
const runManifest = (trialId: string, createdAt: string, config: TrialConfig) => ({
  schema: `${TRIAL_SCHEMA}#run-manifest`, trialId, createdAt, trialMode: FULL_GAME_MODE, config,
  objective: { rules: NETWORK_RULES.id, limitTicks: NETWORK_RULES.limitTicks, simulatedMinutes: NETWORK_RULES.limitTicks * TICK_SIMULATED_MS / 60000 },
  maxIntervalTicks: MAX_INTERVAL_TICKS,
  stopRules: [
    'game-outcome: stop at the first tick the scenario reports elimination or its objective time limit.',
    `decision-limit / tick-cap: stop after ${config.maxDecisions} decisions or at tick ${config.capTicks} without a result; scores stay provisional and no winner is recorded.`,
    'A rejected or failed response stops the run where it is; the harness never retries or substitutes a choice.',
  ],
  claims: { ...TRIAL_CLAIMS, fullGame: FULL_GAME_CLAIMS },
});

/** Full-game trials must carry an unchanged run manifest; short trials must not have one. Read-only. */
function checkRunManifest(dir: string, m: Manifest, mode: TrialMode) {
  const file = path.join(dir, RUN_MANIFEST), exists = fs.existsSync(file);
  if (mode !== FULL_GAME_MODE) { if (exists) throw new TrialRejection('integrity', `${RUN_MANIFEST} exists but the manifest has no trialMode`); return; }
  if (!exists) throw new TrialRejection('integrity', `${FULL_GAME_MODE} trial is missing ${RUN_MANIFEST}`);
  const r = readJson<{ trialId?: unknown; trialMode?: unknown; config?: unknown }>(file);
  if (r.trialId !== m.trialId || r.trialMode !== FULL_GAME_MODE || !isDeepStrictEqual(r.config, m.config)) throw new TrialRejection('integrity', `manifest config no longer matches ${RUN_MANIFEST}`);
}

/** A contract trial must carry the exact schema this harness defines; a trial without the contract must not have one. Read-only. */
function checkPlayerOutputSchema(dir: string, config: TrialConfig) {
  const file = path.join(dir, PLAYER_OUTPUT_SCHEMA_FILE), exists = fs.existsSync(file);
  if (playerOutputOf(config) === undefined) { if (exists) throw new TrialRejection('integrity', `${PLAYER_OUTPUT_SCHEMA_FILE} exists but the manifest has no playerOutput`); return; }
  if (!exists || !isDeepStrictEqual(readJson(file), playerOutputSchema())) throw new TrialRejection('integrity', `${PLAYER_OUTPUT} trial is missing ${PLAYER_OUTPUT_SCHEMA_FILE} or it differs from the harness schema`);
}

export async function initTrial(opts: { dir: string; seed: string; ticksPerDecision: number; opponentTicksPerCheck?: number; maxDecisions: number; capTicks: number; playerContext?: PlayerContext; trialMode?: TrialMode; playerOutput?: typeof PLAYER_OUTPUT }) {
  if (fs.existsSync(opts.dir)) throw new TrialRejection('usage', `${opts.dir} exists; choose a new trial directory`);
  const opponentTicksPerCheck = opts.opponentTicksPerCheck ?? DEFAULT_OPPONENT_TICKS_PER_CHECK;
  const playerContext = playerContextOf({ playerContext: opts.playerContext });
  const trialMode = opts.trialMode === undefined || opts.trialMode === 'short' ? undefined : opts.trialMode;
  // Same hard bounds as the CLI, for callers that skip parseTrialArgs; nothing is simulated or written before this.
  const full = checkBounds({ ticksPerDecision: opts.ticksPerDecision, opponentTicksPerCheck, maxDecisions: opts.maxDecisions, capTicks: opts.capTicks, playerContext: playerContext === 'legacy' ? undefined : playerContext, trialMode, playerOutput: opts.playerOutput }, 'usage') === FULL_GAME_MODE;
  const scenario = trialScenario();
  // A new full-game trial admits both seats' transports under the versioned rule; the engine record carries it into every checkpoint.
  const config: TrialConfig = { scenarioId: scenario.id, seed: opts.seed, seat: MODEL_SIDE, opponent: OBJECTIVE_CONTROLLER, ticksPerDecision: opts.ticksPerDecision, opponentTicksPerCheck, maxDecisions: opts.maxDecisions, capTicks: opts.capTicks, ...(playerContext === 'legacy' ? {} : { playerContext }), ...(full ? { trialMode: FULL_GAME_MODE, transportAdmission: TRANSPORT_ADMISSION } : {}), ...(opts.playerOutput === undefined ? {} : { playerOutput: opts.playerOutput }) };
  const e = await ReplayEngine.create({ simulationId: opts.seed, map: scenario.map, ...(config.transportAdmission === undefined ? {} : { transportAdmission: config.transportAdmission }) });
  const spawn = (s: Side) => spawnTarget(e.game, ...scenario.spawn[s]);
  const first = e.step(sides.map((s) => ({ side: s, intent: { type: 'spawn', tile: spawn(s) } }))); e.fingerprints[first.tick] = first.fingerprint;
  const run = newRun(e, initialNetwork(e.game.ticks()), []);
  const firstDecisionReady = (t: number) => t % OBJECTIVE_INTERVAL_TICKS === 0 && !e.game.inSpawnPhase() && e.player(MODEL_SIDE).hasSpawned();
  // At 45 Red keeps the original rule and may check at deployment boundaries Blue cannot use. Any other interval
  // starts at Blue's first decision tick, which is the tick where this advance stops.
  advance(run, opts.capTicks, firstDecisionReady, opponentTicksPerCheck === OBJECTIVE_INTERVAL_TICKS ? opponentDue(opponentTicksPerCheck, 0) : firstDecisionReady);
  if (e.game.ticks() + opts.ticksPerDecision > opts.capTicks) throw new TrialRejection('usage', `deployment ends at tick ${e.game.ticks()}; the cap leaves no full decision interval`);
  const trialId = `trial-${crypto.randomUUID()}`; const snap = buildSnapshot(run, trialId, 0, config, []);
  const initialization = { schema: `${TRIAL_SCHEMA}#initialization`, fromTick: first.tick, firstDecisionTick: snap.tick, opponent: { pulses: run.opponentPulses, note: 'Red checks from deployment up to and including Blue\'s first decision tick, with each reason from the scripted controller. Post-hoc audit only; never included in a model prompt.' } };
  const now = new Date().toISOString();
  fs.mkdirSync(opts.dir, { recursive: true });
  commitStaged(opts.dir, (stage) => {
    writeOnce(path.join(stage, 'initialization/receipts.json'), json(initialization));
    if (full) writeOnce(path.join(stage, RUN_MANIFEST), json(runManifest(trialId, now, config)));
    if (config.playerOutput) writeOnce(path.join(stage, PLAYER_OUTPUT_SCHEMA_FILE), json(playerOutputSchema()));
    return ['initialization', stageDecision(stage, snap, checkpoint(run))];
  });
  const manifest: Manifest = { schema: TRIAL_SCHEMA, trialId, createdAt: now, updatedAt: now, config, status: 'awaiting-choice', cursor: cursorFor(snap), history: [], claims: TRIAL_CLAIMS };
  writeManifest(opts.dir, manifest); return manifest;
}

export async function stepTrial(opts: { dir: string; response: string; responder: string }) {
  const m = readJson<Manifest>(path.join(opts.dir, 'manifest.json'));
  if (m.status !== 'awaiting-choice' || !m.cursor) throw new TrialRejection('not-awaiting', `trial is ${m.status}`);
  const opponentTicksPerCheck = opponentTicksOf(m.config); const playerContext = playerContextOf(m.config);
  const trialMode = checkBounds(m.config); checkRunManifest(opts.dir, m, trialMode); checkPlayerOutputSchema(opts.dir, m.config);
  if (m.cursor.decision !== m.history.length || m.cursor.decision >= m.config.maxDecisions) throw new TrialRejection('integrity', `cursor decision ${m.cursor.decision} is outside the recorded ${m.config.maxDecisions}-decision bound`);
  const k = m.cursor.decision; const ddir = path.join(opts.dir, `decisions/${rel(k)}`);
  const firstDecisionTick = k === 0 ? m.cursor.tick : m.history[0]!.tick;
  const snap = readJson<Snapshot>(path.join(ddir, 'snapshot.json'));
  if (snap.snapshotId !== m.cursor.snapshotId || snap.trialId !== m.trialId) throw new TrialRejection('integrity', 'manifest cursor does not match the saved snapshot');
  if (playerContextOf(snap) !== playerContext) throw new TrialRejection('integrity', `snapshot player context ${playerContextOf(snap)} does not match the manifest's ${playerContext}`);
  if (playerOutputOf(snap) !== m.config.playerOutput) throw new TrialRejection('integrity', `snapshot player output ${playerOutputOf(snap) ?? 'none'} does not match the manifest's ${m.config.playerOutput ?? 'none'}`);
  const raw = fs.readFileSync(opts.response, 'utf8');
  // Everything above is read-only; a rejected response leaves the trial untouched.
  const parsed = parseChoice(raw, snap, m.history.map((h) => h.snapshotId));
  const outcomeDir = `outcomes/${rel(k)}`; if (fs.existsSync(path.join(opts.dir, outcomeDir))) throw new TrialRejection('integrity', `${outcomeDir} already exists`);

  const cp = readJson<Checkpoint>(path.join(ddir, 'replay.json')); const feedback: ExecutionFeedbackEvent[] = [];
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints', { feedback: { listener: (ev) => feedback.push(ev) } });
  feedback.length = 0; // re-executed history is not a receipt for this step
  // The checkpoint's engine option is the rule that actually runs; the manifest and snapshot must name the same one (absent = original).
  const admissionOf = (v: unknown) => (v === undefined ? 'original' : String(v));
  if (e.options.transportAdmission !== m.config.transportAdmission || snap.transportAdmission !== m.config.transportAdmission) throw new TrialRejection('integrity', `transport admission differs: checkpoint ${admissionOf(e.options.transportAdmission)}, snapshot ${admissionOf(snap.transportAdmission)}, manifest ${admissionOf(m.config.transportAdmission)}`);
  const run = newRun(e, cp.network, cp.pending);
  const fingerprintMatched = e.state().fingerprint === snap.fingerprint && cp.tick === snap.tick && run.network.tick === snap.tick;
  const rebuiltSnapshot = buildSnapshot(run, m.trialId, k, m.config, []);
  const candidatesMatched = rebuiltSnapshot.snapshotId === snap.snapshotId && isDeepStrictEqual(rebuiltSnapshot.candidates,snap.candidates)
    && (playerContext !== 'enriched/1' || isDeepStrictEqual(rebuiltSnapshot.observation.access,snap.observation.access));
  if (!fingerprintMatched || !candidatesMatched) throw new TrialRejection('integrity', `reconstruction diverged at tick ${snap.tick} (fingerprint ${fingerprintMatched}, candidates ${candidatesMatched})`);

  const intent = choiceIntent(snap, parsed.choice, parsed.share);
  if (intent) { try { e.validate(MODEL_SIDE, intent); } catch (err) { throw new TrialRejection('illegal-choice', `engine refused candidate ${parsed.choice}${parsed.share === undefined ? '' : ` at share ${parsed.share}`}: ${(err as Error).message}`); } }
  const chosen = parsed.choice === 'hold' ? null : snap.candidates[parsed.choice]!;
  // The share actually applied: the declared one, or the candidate's default. Absent for legacy trials and troopless choices.
  const share = parsed.share ?? chosen?.defaultShare;
  const order: PendingOrder | null = intent ? { side: MODEL_SIDE, intent, decisionTick: snap.tick, source: 'model' } : null;
  if (order) run.pending = [order, ...run.pending]; // the harness decides Blue before Red at a shared tick
  const before = { scores: { ...run.network.scores }, blue: publicSide(e, 'blue'), red: publicSide(e, 'red') };
  const endTick = Math.min(m.config.capTicks, snap.tick + m.config.ticksPerDecision);
  const outcome = advance(run, endTick, (t) => t >= endTick, opponentDue(opponentTicksPerCheck, firstDecisionTick));
  const tick = e.game.ticks(); const key = order ? run.executed.get(order) ?? null : null;
  const meaning = chosen ? chosen.meaning : null;
  const history: Manifest['history'] = [...m.history, { decision: k, tick: snap.tick, snapshotId: snap.snapshotId, choice: parsed.choice, meaning, intent, key, responder: opts.responder, outcome: outcomeDir, ...(share === undefined ? {} : { share }) }];
  const blueKeys = new Set(history.map((h) => h.key).filter((x): x is string => !!x));
  const receipts = {
    schema: `${TRIAL_SCHEMA}#receipts`, decision: k, snapshotId: snap.snapshotId, fromTick: snap.tick, toTick: tick,
    reconstruction: { restoredFromRecordTurns: cp.record.turns.length, fingerprintMatched, candidatesMatched },
    modelOrder: order ? { intent, admittedAtSubmission: true, executedKey: key, droppedAtTick: key === null } : null,
    modelFeedback: feedback.filter((ev) => blueKeys.has(ev.keyString)).map((ev) => ({ key: ev.keyString, tick: ev.tick, status: ev.status })),
    feedbackNote: 'Execution feedback exists only for City/Defense Post/Port construction and transports; attacks and upgrades are unobserved. Admission is not success. Late feedback for an earlier decision appears in the step during which it occurred.',
    board: { before, after: { scores: { ...run.network.scores }, controllers: { ...run.network.controllers }, blue: publicSide(e, 'blue'), red: publicSide(e, 'red') } },
    opponent: { pulses: run.opponentPulses, ordersAtTick: [...run.executed].filter(([o]) => o.source !== 'model').map(([o, k2]) => ({ decisionTick: o.decisionTick, type: o.intent.type, executedKey: k2 })), note: 'Post-hoc audit only, including each pulse reason from the scripted controller; never included in a model prompt.' },
    outcome,
  };
  // `promptMeaning` is the exact candidate text the responder saw (legacy prompts reword the engine's troop labels; enriched/1 prints `meaning` verbatim).
  const decision = { schema: `${TRIAL_SCHEMA}#decision`, decision: k, snapshotId: snap.snapshotId, tick: snap.tick, choice: parsed.choice, intent, meaning, promptMeaning: meaning === null ? null : playerContext === 'legacy' ? harnessMeaning(meaning) : meaning, ...(share === undefined ? {} : { share, troops: intent!.troops }), rationale: parsed.rationale, responder: { label: opts.responder, basis: TRIAL_CLAIMS.responder }, responseSha256: sha(raw), acceptedAt: new Date().toISOString() };
  const atDecisionLimit = k + 1 >= m.config.maxDecisions, atTickCap = tick >= m.config.capTicks;
  const done = outcome !== null || atDecisionLimit || atTickCap;
  const stopReason = outcome !== null ? 'game-outcome' : atDecisionLimit && atTickCap ? 'decision-limit-and-tick-cap' : atDecisionLimit ? 'decision-limit' : 'tick-cap';
  let next: Snapshot | null = null;
  commitStaged(opts.dir, (stage) => {
    writeOnce(path.join(stage, outcomeDir, 'response.raw.json'), raw); writeOnce(path.join(stage, outcomeDir, 'decision.json'), json(decision)); writeOnce(path.join(stage, outcomeDir, 'receipts.json'), json(receipts));
    if (done) {
      const earlier = m.history.map((h) => readJson<typeof receipts>(path.join(opts.dir, h.outcome, 'receipts.json')));
      const initFile = path.join(opts.dir, 'initialization/receipts.json');
      const opportunities = opportunityCounts({
        config: m.config, firstDecisionTick, finalTick: tick, history,
        initializationPulses: fs.existsSync(initFile) ? readJson<{ opponent: { pulses: PulseCount[] } }>(initFile).opponent.pulses : null,
        stepPulses: [...earlier, receipts].flatMap((r) => r.opponent.pulses), opponentOrdersAtTick: [...earlier, receipts].flatMap((r) => r.opponent.ordersAtTick),
        opponentPendingAtEnd: run.pending.filter((o) => o.side !== MODEL_SIDE).length,
      });
      const summary = { schema: `${TRIAL_SCHEMA}#summary`, trialId: m.trialId, config: m.config, decisions: history.length, ticksSimulated: tick, simulatedSeconds: tick * TICK_SIMULATED_MS / 1000, outcome, stopReason, scoresStatus: outcome ? 'final' : 'provisional',
        outcomeNote: outcome ? `Game outcome reached inside the bound (${outcome.reason}).` : `No outcome: the recording stopped at tick ${tick} because ${stopReason === 'decision-limit' ? `the ${m.config.maxDecisions}-decision limit was reached before the ${m.config.capTicks}-tick cap` : stopReason === 'tick-cap' ? `the ${m.config.capTicks}-tick cap was reached with ${history.length} of ${m.config.maxDecisions} decisions taken` : `the ${m.config.maxDecisions}-decision limit and the ${m.config.capTicks}-tick cap were both reached`}, before elimination or the ${NETWORK_RULES.limitTicks}-tick objective limit. Scores are provisional and are not a win for either side.`,
        scores: run.network.scores, controllers: run.network.controllers, cadence: cadence(m.config.ticksPerDecision, opponentTicksPerCheck), opportunities, responders: [...new Set(history.map((h) => h.responder))], claims: TRIAL_CLAIMS,
        ...(trialMode === FULL_GAME_MODE ? { runManifest: RUN_MANIFEST, fullGameClaims: FULL_GAME_CLAIMS } : {}) };
      writeOnce(path.join(stage, 'final/replay.json'), JSON.stringify(checkpoint(run)) + '\n'); writeOnce(path.join(stage, 'final/summary.json'), json(summary));
      return [outcomeDir, 'final'];
    }
    const feedbackSoFar = [...m.history.flatMap((h) => readJson<typeof receipts>(path.join(opts.dir, h.outcome, 'receipts.json')).modelFeedback), ...receipts.modelFeedback];
    next = buildSnapshot(run, m.trialId, k + 1, m.config, history.map((h) => ({ decision: h.decision + 1, tick: h.tick, choice: h.choice, meaning: h.meaning, observed: feedbackSoFar.filter((f) => f.key === h.key).map((f) => `${f.status}@${f.tick}`), ...(h.share === undefined ? {} : { share: h.share }) })), snap.observation);
    return [outcomeDir, stageDecision(stage, next, checkpoint(run))];
  });
  const updated: Manifest = { ...m, updatedAt: new Date().toISOString(), status: done ? 'complete' : 'awaiting-choice', cursor: next ? cursorFor(next) : null, history };
  writeManifest(opts.dir, updated); return updated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {}; console.warn = () => {};
  try {
    const a = parseTrialArgs(process.argv.slice(2));
    if (a.command === 'bounds') console.log(JSON.stringify({ short: SHORT_BOUNDS, fullGame: { trialMode: FULL_GAME_MODE, ...FULL_GAME_BOUNDS }, objectiveLimitTicks: NETWORK_RULES.limitTicks, maxIntervalTicks: MAX_INTERVAL_TICKS }));
    else {
      const m = a.command === 'init' ? await initTrial(a) : a.command === 'step' ? await stepTrial(a) : readJson<Manifest>(path.join(a.dir, 'manifest.json'));
      console.log(JSON.stringify({ dir: a.dir, trialId: m.trialId, status: m.status, cursor: m.cursor, decisions: m.history.length, next: m.cursor ? path.join(a.dir, m.cursor.prompt) : path.join(a.dir, 'final/summary.json') }, null, 2));
    }
  } catch (err) {
    console.error(JSON.stringify({ rejected: err instanceof TrialRejection ? err.code : 'error', message: (err as Error).message }));
    process.exitCode = 1;
  }
}
