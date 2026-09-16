/**
 * Offline, file-stepped two-seat game (docs/demo/dual-model-harness.md, plan docs/demo/dual-model-trial-plan.md). Two external
 * responders play Blue and Red of `crosscurrent-objectives/1` through the same seat-context/1 snapshots, prompts and
 * player-output/1 reply contract. There is NO scripted opponent: every non-spawn order in the engine record came from a
 * validated seat reply. This script never calls a model, CLI, network or API; the main integrator's provider driver
 * obtains both replies and passes them to `step`.
 *
 * Each round both snapshots are built from the same pre-order engine state. `step` needs both replies at once, parses and
 * engine-validates both before either is applied, and on any rejected reply writes a write-once rejection record, leaves
 * the engine where it was and refuses further steps for the round (no retry, no substitute). Accepted orders are queued
 * with a leading seat that alternates by round (Blue on round 0), revalidated at tick time and executed through the
 * engine's own turn path. Alternation removes an always-first seat at the harness layer; it is not a fairness proof.
 *
 * Timing is an ACCELERATED PAUSE: the engine waits for both replies, then advances the round's ticks with no further
 * orders. A short game (the default, no `mode` in its config) has at most 6 rounds. `--mode full-game` opts a NEW game into
 * `full-game/1`, recorded as `config.mode`: up to 45 rounds, stopping earlier at elimination or the objective limit. Neither
 * mode can be converted into the other. A round-limit stop in either mode is not an outcome and its scores stay provisional.
 *
 * `--scenario taiwan-strait/1` opts a NEW game (either mode) into the catalog Taiwan Strait entry, recorded as
 * `config.scenario`: its map, spawns and relay board come from `selectScenario`, both seats get the public regional context
 * (`dual-scenario-context/1`), and only Red gets the `strait-red-cell/1` brief. Without the flag nothing changes. No game is
 * converted between scenarios, and this accelerated offline game is not the native continuous Taiwan exercise.
 *
 * `--observation-profile feedback-v2` opts a NEW game (any mode or scenario) into `round-feedback/2`, recorded as
 * `config.observationProfile` (docs/demo/round-context-v2.md): each seat snapshot gains a `roundContext` with the public queue
 * order and advance rule for the decision, structured feedback on that seat's own earlier orders and a bounded table of its own
 * earlier public observations. It is added after the seat-context/1 snapshot is built and the id is recomputed; without the
 * flag nothing changes.
 *
 *   pnpm exec tsx scripts/dual-model-trial.ts init   --dir <new dir> [--mode short|full-game] [--rounds 6|45] [--ticks-per-round 270] [--seed DUAL0001] [--scenario taiwan-strait/1] [--observation-profile feedback-v2]
 *   pnpm exec tsx scripts/dual-model-trial.ts step   --dir <dir> --blue-response <file> --red-response <file>
 *   pnpm exec tsx scripts/dual-model-trial.ts status --dir <dir>
 *
 * Every artifact is written once (`wx`, read-only). Only `manifest.json` is replaced, atomically. The last stdout line of
 * every command is one compact JSON object.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CLIENTS, ReplayEngine, SIMULATION_PROFILE, TRANSPORT_ADMISSION, UPSTREAM_COMMIT, inputKeyString, type EngineRecord, type ExecutionFeedbackEvent, type Side } from '../src/engine/engine';
import { OBSERVED_STRUCTURES } from '../src/engine/execution-feedback';
import { NETWORK_RULES, advanceNetwork, createNetworkLayout, initialNetwork, networkOutcome, networkRulesForMap, type NetworkState, type Station } from '../src/campaign/network';
import { AOR_MAPS } from '../src/engine/maps';
import { selectScenario, type ExerciseScenario } from '../src/scenarios/catalog';
import { STRAIT_RED_CELL, STRAIT_RED_CELL_BRIEF_SCHEMA, STRAIT_RED_CELL_VERSION, straitRedCellInstructions, straitRedCellPublicBrief } from '../src/scenarios/strait-red-cell';
import { TICK_SIMULATED_MS, rawStep, spawnTarget } from './qualify-pacing';
import { SEATS, TrialRejection, buildSeatSnapshot, checkSeatSnapshot, choiceIntent, parseSeatChoice, playerOutputSchema, renderSeatPrompt, seatSnapshotId, validInterval, type SeatChoice, type SeatPreviousDecision, type SeatSnapshot } from './ai-player-trial';

export const DUAL_SCHEMA = 'replay.dual-model-trial/1';
/** The default scenario. A default game records no `config.scenario`. */
export const DUAL_SCENARIO_ID = 'crosscurrent-objectives/1';
/** Scenarios a new game may select explicitly with `--scenario`; strict allowlist. */
export const DUAL_SCENARIOS = ['taiwan-strait/1'] as const;
export type DualScenarioId = (typeof DUAL_SCENARIOS)[number];
/** What a selected scenario adds to each seat-context/1 snapshot, and its recorded identity in game.json. */
export const DUAL_SCENARIO_CONTEXT = 'dual-scenario-context/1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Files whose sha256 is recorded as provenance when a scenario is selected. Recorded only; other authors may edit them later. */
export const SCENARIO_SOURCE_FILES = ['src/scenarios/catalog.ts', 'src/campaign/network.ts', 'src/scenarios/strait-red-cell.ts', 'src/engine/maps.ts', 'scripts/ai-player-trial.ts', 'scripts/dual-model-trial.ts'];
/** Short-mode bound, unchanged. A short config has no `mode` key and can never exceed it. */
export const MAX_ROUNDS = 6;
export const DEFAULT_ROUNDS = 6;
/** Explicit opt-in full-game mode for new games only, recorded as `config.mode`. */
export const DUAL_FULL_GAME_MODE = 'full-game/1';
export const FULL_GAME_MAX_ROUNDS = 45;
export const FULL_GAME_DEFAULT_ROUNDS = 45;
export const DEFAULT_TICKS_PER_ROUND = 270;
export const DEFAULT_SEED = 'DUAL0001';
/** Explicit opt-in observation profile for new games only, recorded as `config.observationProfile`. */
export const ROUND_FEEDBACK_PROFILE = 'round-feedback/2';
export type ObservationProfile = typeof ROUND_FEEDBACK_PROFILE;
/** `--observation-profile` values (strict allowlist) and the canonical profile each records. */
export const OBSERVATION_PROFILE_FLAGS: Readonly<Record<string, ObservationProfile>> = { 'feedback-v2': ROUND_FEEDBACK_PROFILE };
/** round-feedback/2 bounds: own earlier orders listed, and own earlier observations compared with now. */
export const OWN_ORDER_WINDOW = 5;
export const BOARD_WINDOW = 3;
/** Round 0 is led by Blue, round 1 by Red, and so on. */
export const leadingSeat = (round: number): Side => (round % 2 === 0 ? 'blue' : 'red');
const otherSeat = (s: Side): Side => (s === 'blue' ? 'red' : 'blue');
const MAX_STORED_RESPONSE_BYTES = 64_000;

export const DUAL_CLAIMS = {
  players: 'Two external responders, one per seat, choosing from engine-validated candidates. No scripted opponent orders are issued by this harness.',
  timing: 'accelerated-pause: the engine waits until both replies are recorded, then advances the round with no further orders. Response latency costs no ticks; the native continuous clock is not exercised.',
  information: 'Both seat snapshots come from the same pre-order state. Neither seat sees the other\'s reply for the round, its queued order or any rationale; each sees only its own earlier choices and their observed execution feedback.',
  ordering: 'Orders from one round enter the same engine turn in an explicit queue whose leading seat alternates by round. This avoids an always-first seat at the harness layer; it is not a fairness proof.',
  horizon: `At most ${MAX_ROUNDS} rounds: a short capped exercise. A round-limit stop has no result, and its provisional scores are not a win, a strength measure or evidence of mastery.`,
  harnessModelCalls: 0, humanPlaytest: false,
  claim: 'Measured legal play by two external responders in a fictional abstract game. Not evidence of fun, difficulty, learning, AI-player quality or realistic doctrine.',
} as const;
export const TAIWAN_SCENARIO_CLAIM = 'taiwan-strait/1 in this offline runner: the catalog map taiwan-strait-400, its spawns and its strait-stations-and-reserves/1 relay board, played by two external responders under the accelerated pause above. The catalog objectives/1 controller is not used. Red alone receives the strait-red-cell/1 brief; Blue receives the public regional geography and objectives. Recognizable real geography in a fictional abstract game, not a model of any real force, doctrine or plan. This is not the native continuous Taiwan exercise and says nothing about its timing, opponent strength or learning.';
export const ROUND_FEEDBACK_CLAIM = `${ROUND_FEEDBACK_PROFILE}: each seat snapshot also carries the public queue order and advance rule for its decision (identical for both seats), structured feedback on that seat's own earlier orders (admitted, dropped at tick time or hold; observed construction and transport statuses only, with attacks, upgrades and other orders marked unobserved) and that seat's own public totals from up to ${BOARD_WINDOW} earlier observations beside the current ones. It never includes the other seat's reply, rationale or not-yet-selected order, reports no success an observed status does not show, and attributes no board change to any single order. An observation change only; it is not evidence of stronger play.`;
/** Default short games keep `DUAL_CLAIMS` exactly; a full-game run states its own recorded bound and mode; a selected scenario and an observation profile each add their own claim. */
export function claimsFor(config: DualConfig) {
  const base = !isFullGame(config) ? DUAL_CLAIMS : {
    ...DUAL_CLAIMS,
    horizon: `Full-game mode (${DUAL_FULL_GAME_MODE}): at most ${config.maxRounds} rounds of ${config.ticksPerRound} ticks, stopping earlier at elimination or the ${NETWORK_RULES.limitTicks}-tick objective limit. Only those two stops are an outcome. A round-limit stop before either has no result, and its provisional scores are not a win, a strength measure or evidence of mastery.`,
    mode: DUAL_FULL_GAME_MODE,
  };
  const scenario = !hasScenario(config) ? base : { ...base, scenarioId: config.scenario, scenario: TAIWAN_SCENARIO_CLAIM };
  if (!hasObservationProfile(config)) return scenario;
  return { ...scenario, observationProfile: config.observationProfile, observation: ROUND_FEEDBACK_CLAIM };
}

export type DualCode = 'usage' | 'integrity' | 'not-awaiting' | 'halted' | TrialRejection['code'];
export class DualRejection extends Error {
  constructor(readonly code: DualCode, message: string, readonly rejection: string | null = null) { super(`${code}: ${message}`); }
}

/** A default short config is exactly these three keys, as saved by every game before full-game mode existed. `scenario` and `observationProfile` are present only when selected. */
export interface ShortDualConfig { maxRounds: number; ticksPerRound: number; seed: string; scenario?: DualScenarioId; observationProfile?: ObservationProfile }
export interface FullGameDualConfig extends ShortDualConfig { mode: typeof DUAL_FULL_GAME_MODE }
export type DualConfig = ShortDualConfig | FullGameDualConfig;
export const isFullGame = (config: DualConfig): config is FullGameDualConfig => 'mode' in config;
export const hasScenario = (config: DualConfig): config is DualConfig & { scenario: DualScenarioId } => 'scenario' in config;
export const hasObservationProfile = (config: DualConfig): config is DualConfig & { observationProfile: ObservationProfile } => 'observationProfile' in config;
export interface SeatFiles { prompt: string; snapshot: string; schema: string }
export interface DualCursor { round: number; tick: number; seats: Record<Side, SeatFiles> }
/** `executedKey` is the canonical input key when the order passed tick-time validation; `droppedAtTick` is the engine's reason when it did not. Both null for a hold. */
export interface SeatRoundResult { snapshotId: string; choice: number | 'hold'; share: number | null; meaning: string | null; intent: Record<string, unknown> | null; executedKey: string | null; droppedAtTick: string | null; responseSha256: string }
export interface DualHistoryEntry { round: number; tick: number; endTick: number; leadingSeat: Side; queue: Side[]; seats: Record<Side, SeatRoundResult>; result: string }
export interface DualManifest { schema: typeof DUAL_SCHEMA; gameId: string; config: DualConfig; status: 'awaiting-responses' | 'complete'; cursor: DualCursor | null; history: DualHistoryEntry[] }
export interface DualCheckpoint { schema: string; tick: number; record: EngineRecord; network: NetworkState }

// ---------------------------------------------------------------------------------------------
// Arguments and bounds (pure)
// ---------------------------------------------------------------------------------------------

export function checkDualConfig(config: unknown, code: 'usage' | 'integrity' = 'integrity'): asserts config is DualConfig {
  const c = config as Record<string, unknown>;
  if (!c || typeof c !== 'object') throw new DualRejection(code, 'config takes exactly maxRounds, ticksPerRound and seed');
  // The recorded mode alone selects the bound: a config without `mode` is short, whatever its round count.
  const full = 'mode' in c, chosen = 'scenario' in c, profiled = 'observationProfile' in c;
  const keys = [...(full ? ['mode'] : []), 'maxRounds', 'ticksPerRound', 'seed', ...(chosen ? ['scenario'] : []), ...(profiled ? ['observationProfile'] : [])];
  if (!isDeepStrictEqual(Object.keys(c).sort(), [...keys].sort())) throw new DualRejection(code, chosen || profiled ? `a config with ${chosen ? 'a scenario' : 'an observation profile'} takes exactly ${keys.join(', ')}` : full ? `a ${DUAL_FULL_GAME_MODE} config takes exactly mode, maxRounds, ticksPerRound and seed` : 'config takes exactly maxRounds, ticksPerRound and seed');
  if (full && c.mode !== DUAL_FULL_GAME_MODE) throw new DualRejection(code, `mode must be ${DUAL_FULL_GAME_MODE}; a short game records no mode`);
  if (chosen && !DUAL_SCENARIOS.includes(c.scenario as DualScenarioId)) throw new DualRejection(code, `scenario must be one of ${DUAL_SCENARIOS.join(', ')}; the default ${DUAL_SCENARIO_ID} records no scenario`);
  if (profiled && c.observationProfile !== ROUND_FEEDBACK_PROFILE) throw new DualRejection(code, `observationProfile must be ${ROUND_FEEDBACK_PROFILE}; a game without the profile records none`);
  const bound = full ? FULL_GAME_MAX_ROUNDS : MAX_ROUNDS;
  if (!Number.isInteger(c.maxRounds) || (c.maxRounds as number) < 1 || (c.maxRounds as number) > bound) throw new DualRejection(code, full ? `${DUAL_FULL_GAME_MODE} rounds must be an integer from 1 to ${bound}` : `rounds must be an integer from 1 to ${MAX_ROUNDS}${code === 'usage' ? '; a longer game needs --mode full-game' : ''}`);
  if (!validInterval(c.ticksPerRound)) throw new DualRejection(code, 'ticks per round must be an integer multiple of 45 from 45 to 900');
  if (typeof c.seed !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(c.seed)) throw new DualRejection(code, 'seed must be 1-32 letters, digits or hyphens');
}

export function parseDualArgs(argv: readonly string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, readonly string[]> = { init: ['--dir', '--mode', '--rounds', '--ticks-per-round', '--seed', '--scenario', '--observation-profile'], step: ['--dir', '--blue-response', '--red-response'], status: ['--dir'] };
  if (!command || !flags[command]) throw new DualRejection('usage', 'command must be init, step or status');
  const given = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, v = rest[i + 1];
    if (!flags[command]!.includes(flag)) throw new DualRejection('usage', `unknown option ${flag} for ${command}`);
    if (given.has(flag) || v === undefined) throw new DualRejection('usage', `${flag} must be given once with a value`);
    given.set(flag, v);
  }
  const dir = given.get('--dir'); if (!dir) throw new DualRejection('usage', '--dir is required');
  if (command === 'status') return { command, dir: path.resolve(dir) } as const;
  if (command === 'init') {
    const num = (flag: string, dflt: number) => (given.has(flag) ? (/^\d+$/.test(given.get(flag)!) ? Number(given.get(flag)) : NaN) : dflt);
    const mode = given.get('--mode') ?? 'short';
    if (mode !== 'short' && mode !== 'full-game') throw new DualRejection('usage', '--mode must be short or full-game');
    const full = mode === 'full-game';
    const base = { maxRounds: num('--rounds', full ? FULL_GAME_DEFAULT_ROUNDS : DEFAULT_ROUNDS), ticksPerRound: num('--ticks-per-round', DEFAULT_TICKS_PER_ROUND), seed: given.get('--seed') ?? DEFAULT_SEED };
    const scenario = given.get('--scenario');
    if (scenario !== undefined && !DUAL_SCENARIOS.includes(scenario as DualScenarioId)) throw new DualRejection('usage', `--scenario must be one of ${DUAL_SCENARIOS.join(', ')}; omit it for the default ${DUAL_SCENARIO_ID}`);
    const profileFlag = given.get('--observation-profile');
    if (profileFlag !== undefined && !Object.hasOwn(OBSERVATION_PROFILE_FLAGS, profileFlag)) throw new DualRejection('usage', `--observation-profile must be one of ${Object.keys(OBSERVATION_PROFILE_FLAGS).join(', ')}; omit it for the original observation`);
    const config: DualConfig = withOptionalKeys(full ? { mode: DUAL_FULL_GAME_MODE, ...base } : base, scenario as DualScenarioId | undefined, profileFlag === undefined ? undefined : OBSERVATION_PROFILE_FLAGS[profileFlag]);
    checkDualConfig(config, 'usage');
    return { command, dir: path.resolve(dir), config } as const;
  }
  const blue = given.get('--blue-response'), red = given.get('--red-response');
  if (!blue || !red) throw new DualRejection('usage', '--blue-response and --red-response are both required');
  if (path.resolve(blue) === path.resolve(red)) throw new DualRejection('usage', 'the two responses must be separate files');
  return { command: 'step', dir: path.resolve(dir), blueResponse: path.resolve(blue), redResponse: path.resolve(red) } as const;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

const rel = (n: number) => String(n).padStart(2, '0');
export const roundDir = (round: number) => `rounds/${rel(round)}`;
export const resultDir = (round: number) => `results/${rel(round)}`;
export const rejectionDir = (round: number) => `rejections/${rel(round)}`;
export const GAME_FILE = 'initialization/game.json';
export const seatFiles = (round: number, seat: Side): SeatFiles => ({ prompt: `${roundDir(round)}/${seat}/prompt.md`, snapshot: `${roundDir(round)}/${seat}/snapshot.json`, schema: `${roundDir(round)}/${seat}/schema.json` });
const sha = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
const writeOnce = (file: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { flag: 'wx', mode: 0o444 }); };
function writeManifest(dir: string, m: DualManifest) { const tmp = path.join(dir, `.manifest.${crypto.randomUUID()}.tmp`); fs.writeFileSync(tmp, json(m), { flag: 'wx' }); fs.renameSync(tmp, path.join(dir, 'manifest.json')); }
/** Build new artifact directories in a private staging area, then move each into place only if nothing exists there. */
function commitStaged(dir: string, build: (stage: string) => string[]) {
  const stage = path.join(dir, `.staging-${crypto.randomUUID()}`); fs.mkdirSync(stage);
  try {
    const parts = build(stage);
    for (const p of parts) if (fs.existsSync(path.join(dir, p))) throw new DualRejection('integrity', `${p} already exists; artifacts are never replaced`);
    for (const p of parts) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.renameSync(path.join(stage, p), path.join(dir, p)); }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
/** Relative path and sha256 of every file under the given top-level directories, sorted. */
function sourceHashes(roots: { base: string; parts: string[] }[]) {
  const out = new Map<string, string>();
  const walk = (base: string, relPath: string) => {
    const abs = path.join(base, relPath);
    if (fs.statSync(abs).isDirectory()) { for (const n of fs.readdirSync(abs).sort()) walk(base, `${relPath}/${n}`); return; }
    out.set(relPath, sha(fs.readFileSync(abs)));
  };
  for (const { base, parts } of roots) for (const p of parts) if (fs.existsSync(path.join(base, p))) walk(base, p);
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([file, sha256]) => ({ path: file, sha256 }));
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

/** Adds `scenario` then `observationProfile` last, each only when selected, so a default config keeps its exact keys and order. */
function withOptionalKeys<T extends DualConfig>(config: T, scenario: DualScenarioId | undefined, profile: ObservationProfile | undefined): T {
  const { scenario: _drop, observationProfile: _dropProfile, ...rest } = config;
  return { ...rest, ...(scenario === undefined ? {} : { scenario }), ...(profile === undefined ? {} : { observationProfile: profile }) } as T;
}
const scenarioIdOf = (config: DualConfig) => (hasScenario(config) ? config.scenario : DUAL_SCENARIO_ID);

/** The actual catalog entry: map, spawns and objective rules are never copied here. Refused if the engine's board would differ from the entry. */
export function dualScenario(config: DualConfig): ExerciseScenario {
  const id = scenarioIdOf(config), s = selectScenario(id);
  if (s.victory !== 'network-score/1') throw new DualRejection('integrity', `${id} no longer uses network scoring`);
  if (JSON.stringify(s.objectiveRules) !== JSON.stringify(networkRulesForMap(s.map))) throw new DualRejection('integrity', `${id} objective rules differ from the board the engine uses for ${s.map}`);
  if (hasScenario(config) && (s.redCellProfile !== STRAIT_RED_CELL_VERSION || STRAIT_RED_CELL.scenarioId !== s.id || STRAIT_RED_CELL.mapId !== s.map || !(s.map in AOR_MAPS))) throw new DualRejection('integrity', `${id} no longer pairs map ${s.map} with ${STRAIT_RED_CELL_VERSION}`);
  return s;
}

/** Public to both seats: the regional terrain and the published relay markers. Nothing about either seat's choices or the Red Cell brief. */
function publicScenarioContext(s: ExerciseScenario) {
  const rules = networkRulesForMap(s.map);
  return {
    context: DUAL_SCENARIO_CONTEXT, id: s.id, title: s.title, map: s.map,
    geography: `Terrain is the pinned OpenFront ${s.map} map, showing the mainland coast, Taiwan, Penghu and the Taiwan Strait. Place names describe the terrain only; use objectiveBoard, access and candidates for location and ownership.`,
    objectives: { rules: rules.id, sites: rules.stations.map(({ id, name }) => ({ id, name })), note: 'Five fictional relay markers, not facilities or targets. Positions, controllers and the rotating priority are on objectiveBoard.' },
    notice: 'Recognizable real geography in a fictional abstract game; not a model of any real force, doctrine, plan or intelligence. This offline runner waits for both replies each round; it is not native continuous play.',
  };
}
const scenarioGame = (s: ExerciseScenario) => `Fictional abstract strategy game on recognizable real geography (${s.id}, map ${s.map}); not a model of any real force, doctrine or plan.`;

/** Red seat only: the actual strait-red-cell/1 instructions and public brief, with versioned provenance. */
function redCellContext() {
  const instructions = straitRedCellInstructions(), publicBrief = straitRedCellPublicBrief();
  return {
    profile: STRAIT_RED_CELL_VERSION, visibility: 'red seat only', instructions, publicBrief,
    provenance: { module: 'src/scenarios/strait-red-cell.ts', profileSchema: STRAIT_RED_CELL.schema, briefSchema: STRAIT_RED_CELL_BRIEF_SCHEMA, instructionsSha256: sha(instructions), publicBriefSha256: sha(JSON.stringify(publicBrief)) },
    harnessNote: 'In this offline runner there are no tools: choose from `candidates` under player-output/1. Tool names in the profile describe native play. Put the short external brief (selected action, observed basis, main uncertainty) in `rationale`; it is never shown to Blue.',
  };
}

/**
 * dual-scenario-context/1 over a seat-context/1 snapshot: for a selected scenario, replaces the shared `game` line, adds the
 * public `scenario` context for both seats and `redCell` for Red only, then recomputes the id over the result so the shared
 * snapshot checks still hold. Default games pass through unchanged.
 */
function withScenarioContext(snap: SeatSnapshot, s: ExerciseScenario | null): SeatSnapshot {
  if (!s) return snap;
  const observation = { ...snap.observation, game: scenarioGame(s), scenario: publicScenarioContext(s), ...(snap.seat === 'red' ? { redCell: redCellContext() } : {}) };
  const base = { ...snap, observation };
  return { ...base, snapshotId: seatSnapshotId(base) };
}

type SeatFeedback = { key: string; tick: number; status: string };
const SEAT_LABEL: Record<Side, string> = { blue: 'Blue', red: 'Red' };
const queueOf = (round: number): Side[] => [leadingSeat(round), otherSeat(leadingSeat(round))];

/** round-feedback/2, shared by both seats: the queue order for this decision and the next, and the exact advance rule. */
function publicRoundRules(round: number, tick: number, config: DualConfig) {
  const [lead, second] = queueOf(round).map((s) => SEAT_LABEL[s]);
  return {
    turnOrder: {
      decision: round + 1, queue: queueOf(round), next: { decision: round + 2, queue: queueOf(round + 1) },
      rule: `For decision ${round + 1}, orders both seats submit enter the same engine turn in this order: ${lead}'s admitted order first, then ${second}'s. The leading seat alternates every decision: Blue leads odd-numbered decisions and Red leads even-numbered ones. A hold takes no place in the queue. An order applied earlier in the turn changes the state a later order in that turn meets; for example, a construction whose tile changes hands in that turn may not start. Neither seat sees the other's order before both are recorded.`,
    },
    advance: {
      ticksPerDecision: config.ticksPerRound, fromTick: tick, toTick: Math.min(tick + config.ticksPerRound, NETWORK_RULES.limitTicks), objectiveLimitTick: NETWORK_RULES.limitTicks,
      rule: 'The game waits until both seats have replied. Immediately before the first engine turn of this decision, each queued order is validated again; an order refused then is dropped and never executes. Admitted orders enter that one turn in queue order, and the game then advances to toTick with no further orders from either seat, stopping earlier only at elimination or the objective limit. Attacks and transports already under way continue.',
    },
  };
}

/** What this harness can observe about an order's effect. Only City/Defense Post/Port construction and transports are tracked. */
const observedKind = (intent: Record<string, unknown> | null) => (intent === null ? null : intent.type === 'boat' ? 'transport' : intent.type === 'build_unit' && OBSERVED_STRUCTURES.includes(intent.unit as (typeof OBSERVED_STRUCTURES)[number]) ? 'construction' : 'not-observed');

/** This seat's own last OWN_ORDER_WINDOW orders with released feedback for its own order keys. No other seat's order, place or key. */
function ownOrderFeedback(seat: Side, history: readonly DualHistoryEntry[], feedback: readonly SeatFeedback[]) {
  return {
    window: OWN_ORDER_WINDOW,
    orders: history.slice(-OWN_ORDER_WINDOW).map((h) => {
      const r = h.seats[seat], kind = observedKind(r.intent);
      const admission = r.choice === 'hold' ? 'hold' : r.executedKey !== null ? 'admitted' : 'dropped';
      const statuses = r.executedKey === null ? [] : feedback.filter((f) => f.key === r.executedKey).map(({ status, tick }) => ({ status, tick }));
      return {
        decision: h.round + 1, tick: h.tick, endTick: h.endTick, queuePlace: admission === 'hold' ? null : h.queue.indexOf(seat) === 0 ? 'first' : 'second',
        choice: r.choice, share: r.share, meaning: r.meaning, admission, droppedReason: r.droppedAtTick,
        observed: kind, statuses: kind === 'not-observed' ? null : statuses, latestStatus: kind === 'not-observed' ? null : statuses.at(-1)?.status ?? null,
      };
    }),
    note: 'Your own orders only. admission: "admitted" means the order passed tick-time validation and entered the turn, which is not evidence it had any effect; "dropped" means the engine refused it then and it never executed; "hold" issued nothing. queuePlace is your place in the public queue order, not whether the other seat submitted. statuses lists observed construction or transport statuses released so far; an empty list means no status was observed yet. observed "not-observed" (attacks, upgrades and other orders): this harness records no effect for them, so statuses and latestStatus are null.',
  };
}

type BoardObs = { decision?: number; tick?: number; ownResources?: Record<string, unknown>; opponentPublic?: Record<string, unknown> | null; objectiveBoard?: { scores?: Record<string, number> } };
const pickKeys = (o: Record<string, unknown> | null | undefined, keys: string[]) => (o ? Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) : null);
const boardRow = (o: BoardObs) => ({ decision: o.decision ?? null, tick: o.tick ?? null, scores: { ...o.objectiveBoard?.scores }, own: pickKeys(o.ownResources, ['tiles', 'troops', 'gold', 'structures']), opponentPublic: pickKeys(o.opponentPublic, ['tiles', 'troops', 'structures', 'alive']) });

/** This seat's own saved observations from up to BOARD_WINDOW earlier decisions beside now: only values it was already shown. */
function recentBoard(recent: readonly SeatSnapshot[], now: Record<string, unknown>) {
  return {
    window: BOARD_WINDOW,
    rows: [...recent.slice(-BOARD_WINDOW).map((s) => boardRow(s.observation as BoardObs)), boardRow(now as BoardObs)],
    note: 'Public totals from your own earlier observations at the start of recent decisions, then now (last row). opponentPublic is what you were shown at the time. Changes between rows combine both seats\' orders, orders already under way and scoring over many ticks; they are not the effect of any single order and are not attributed to one.',
  };
}

/**
 * round-feedback/2 over a built seat snapshot: adds `roundContext` last and recomputes the id, as the scenario layer does.
 * `recent` is this seat's own earlier snapshots, oldest first. Games without the profile pass through unchanged.
 */
function withRoundContext(snap: SeatSnapshot, config: DualConfig, history: readonly DualHistoryEntry[], feedback: readonly SeatFeedback[], recent: readonly SeatSnapshot[]): SeatSnapshot {
  if (!hasObservationProfile(config)) return snap;
  const roundContext = { profile: config.observationProfile, ...publicRoundRules(snap.decision, snap.tick, config), ownOrders: ownOrderFeedback(snap.seat, history, feedback), recentBoard: recentBoard(recent, snap.observation) };
  const base = { ...snap, observation: { ...snap.observation, roundContext } };
  return { ...base, snapshotId: seatSnapshotId(base) };
}

/** `renderSeatPrompt` unchanged for default games; a selected scenario, then round-feedback/2, each append a section pointing at their context. */
export function renderDualPrompt(snap: SeatSnapshot, s: ExerciseScenario | null, profile: ObservationProfile | null = null): string {
  const prompt = renderSeatPrompt(snap);
  if (!s && !profile) return prompt;
  const [lead, second] = queueOf(snap.decision).map((x) => SEAT_LABEL[x]);
  return [
    prompt,
    ...(s ? [
      `## Scenario (${DUAL_SCENARIO_CONTEXT})`, '',
      `Scenario \`${s.id}\` on map \`${s.map}\`: see \`scenario\` in the observation. ${publicScenarioContext(s).notice}`, '',
      ...(snap.seat === 'red' ? [`## Strait Red Cell brief (${STRAIT_RED_CELL_VERSION}, Red seat only)`, '', 'Read `redCell.instructions` in the observation as your scenario brief, then `redCell.harnessNote` for how it applies in this runner. The reply contract above still governs your reply.', ''] : []),
    ] : []),
    ...(profile ? [
      `## Round context (${profile})`, '',
      `This decision's queue: ${lead}'s admitted order enters the engine turn first, then ${second}'s. See \`roundContext\` in the observation for the queue and advance rule, feedback on your own earlier orders and your recent board rows. Admission is not success, attacks and upgrades are not observed, and board changes are not attributed to any single order.`, '',
    ] : []),
  ].join('\n');
}

const landTiles = (e: ReplayEngine) => { let n = 0; e.game.forEachTile((t) => { if (e.game.isLand(t)) n++; }); return n; };
const spawnTilesOf = (record: EngineRecord) => Object.fromEntries(SEATS.map((seat) => [seat, (record.turns[0]?.intents.find((i) => i.type === 'spawn' && i.clientID === CLIENTS[seat]) as { tile?: number } | undefined)?.tile ?? null])) as Record<Side, number | null>;

/** Engine-derived facts of a selected scenario: terrain size, the engine's spawn tiles for the catalog fractions and the station layout. */
function scenarioEngineFacts(s: ExerciseScenario, e: ReplayEngine) {
  return {
    spawnTiles: Object.fromEntries(SEATS.map((seat) => [seat, spawnTarget(e.game, ...s.spawn[seat])])) as Record<Side, number>,
    terrain: { width: e.game.width(), height: e.game.height(), landTiles: landTiles(e) },
    stationLayout: createNetworkLayout(e).map(({ id, name, tile }) => ({ id, name, tile })),
  };
}
/** The version-bound identity of a selected scenario; compared on every load. */
function scenarioIdentity(s: ExerciseScenario) {
  const rules = networkRulesForMap(s.map), red = redCellContext();
  return {
    context: DUAL_SCENARIO_CONTEXT, id: s.id, map: s.map, spawn: s.spawn, pinnedMapAssets: AOR_MAPS[s.map as keyof typeof AOR_MAPS].assets,
    objectiveRules: rules.id, objectiveRulesSha256: sha(JSON.stringify(rules)),
    catalogController: s.controller, controllerUsed: null, redCell: { profile: red.profile, seat: 'red' as const, ...red.provenance },
  };
}
/** game.json `scenario`: identity, engine facts (re-derived from the restored engine at every step) and source sha256 (provenance only, not compared). */
function scenarioRecord(s: ExerciseScenario, e: ReplayEngine) {
  return { ...scenarioIdentity(s), ...scenarioEngineFacts(s, e), sources: sourceHashes([{ base: REPO_ROOT, parts: SCENARIO_SOURCE_FILES }]) };
}
type ScenarioRecord = ReturnType<typeof scenarioRecord>;
const checkpointOf = (e: ReplayEngine, network: NetworkState): DualCheckpoint => ({ schema: `${DUAL_SCHEMA}#checkpoint`, tick: e.game.ticks(), record: e.record(), network });
const publicSide = (e: ReplayEngine, s: Side) => { const p = e.player(s); return { tiles: p.numTilesOwned(), troops: Math.round(p.troops()), alive: p.isAlive() }; };
const cadenceFor = (config: DualConfig) => ({ ownTicksPerDecision: config.ticksPerRound, opponentTicksPerDecision: config.ticksPerRound });

interface QueuedOrder { seat: Side; intent: Record<string, unknown>; executedKey: string | null; droppedAtTick: string | null }
/**
 * Advance to `endTick` or a game outcome. Queued orders are validated again immediately before the first turn, in queue
 * order, and admitted ones enter that turn in the same order; no other order is issued, so later turns are empty.
 */
function advance(e: ReplayEngine, layout: Station[], network: NetworkState, queue: QueuedOrder[], endTick: number, stop: (e: ReplayEngine) => boolean = () => false) {
  let outcome: ReturnType<typeof networkOutcome> = null, pending = queue;
  while (e.game.ticks() < endTick && !stop(e)) {
    const turnNumber = e.turns.length, admitted: QueuedOrder[] = [];
    for (const o of pending) { try { e.validate(o.seat, o.intent); admitted.push(o); } catch (err) { o.droppedAtTick = (err as Error).message || 'refused by the engine validator'; } }
    admitted.forEach((o, intentIndex) => { o.executedKey = inputKeyString({ turnNumber, intentIndex, clientID: CLIENTS[o.seat] }); });
    pending = [];
    rawStep(e, admitted.map((o) => ({ side: o.seat, intent: o.intent })));
    const tick = e.game.ticks(); network = advanceNetwork(e, layout, network).state;
    if (tick % NETWORK_RULES.awardEveryTicks === 0) e.fingerprints[tick] = e.state().fingerprint;
    outcome = !e.game.inSpawnPhase() && tick > 50 ? networkOutcome(network, { blue: e.player('blue').isAlive(), red: e.player('red').isAlive() }) : null;
    if (outcome) break;
  }
  e.fingerprints[e.game.ticks()] = e.state().fingerprint;
  return { network, outcome };
}

/** Each seat's own earlier decisions only, with the execution feedback observed for its own orders. No rationale. */
function previousDecisionsFor(seat: Side, history: readonly DualHistoryEntry[], feedback: readonly { key: string; tick: number; status: string }[]): SeatPreviousDecision[] {
  return history.map((h) => {
    const r = h.seats[seat];
    return { seat, decision: h.round, tick: h.tick, choice: r.choice, meaning: r.meaning, observed: r.executedKey === null ? [] : feedback.filter((f) => f.key === r.executedKey).map((f) => `${f.status}@${f.tick}`), ...(r.share === null ? {} : { share: r.share }) };
  });
}

/** The selected scenario for scenario-specific context, or null for a default game (whose files stay exactly as before). */
const selectedScenario = (config: DualConfig) => (hasScenario(config) ? dualScenario(config) : null);

/** `recent` (round-feedback/2 only): each seat's own earlier snapshots, oldest first, ending with `prior`. */
function buildRound(e: ReplayEngine, network: NetworkState, gameId: string, round: number, config: DualConfig, history: readonly DualHistoryEntry[], feedback: Record<Side, { key: string; tick: number; status: string }[]>, prior: Record<Side, SeatSnapshot> | null, recent: Record<Side, SeatSnapshot[]> = { blue: [], red: [] }) {
  const cadence = cadenceFor(config), scenario = selectedScenario(config);
  // Both seats read the same engine and board; buildSeatSnapshot mutates neither, so the second seat sees exactly the first seat's pre-order state.
  return Object.fromEntries(SEATS.map((seat) => [seat, withRoundContext(withScenarioContext(buildSeatSnapshot({ engine: e, network, gameId, seat, decision: round, cadence, previousDecisions: previousDecisionsFor(seat, history, feedback[seat]), ...(prior ? { priorSnapshot: prior[seat] } : {}) }), scenario), config, history, feedback[seat], recent[seat])])) as Record<Side, SeatSnapshot>;
}
const profileOf = (config: DualConfig) => (hasObservationProfile(config) ? config.observationProfile : null);
/** round-feedback/2: each seat's saved snapshots for rounds [from, to), oldest first. Nothing is read for games without the profile. */
const savedOwnSnapshots = (dir: string, config: DualConfig, from: number, to: number) => Object.fromEntries(SEATS.map((seat) => [seat, !hasObservationProfile(config) ? [] : Array.from({ length: Math.max(0, to - Math.max(0, from)) }, (_, i) => readJson<SeatSnapshot>(path.join(dir, seatFiles(Math.max(0, from) + i, seat).snapshot)))])) as Record<Side, SeatSnapshot[]>;

function stageRound(stage: string, gameId: string, round: number, snaps: Record<Side, SeatSnapshot>, cp: DualCheckpoint, scenario: ExerciseScenario | null, profile: ObservationProfile | null = null) {
  const d = roundDir(round);
  for (const seat of SEATS) {
    const f = seatFiles(round, seat);
    writeOnce(path.join(stage, f.snapshot), json(snaps[seat])); writeOnce(path.join(stage, f.prompt), renderDualPrompt(snaps[seat], scenario, profile)); writeOnce(path.join(stage, f.schema), json(playerOutputSchema()));
  }
  writeOnce(path.join(stage, d, 'round.json'), json({ schema: `${DUAL_SCHEMA}#round`, gameId, round, tick: cp.tick, fingerprint: snaps.blue.fingerprint, leadingSeat: leadingSeat(round), queueOrder: [leadingSeat(round), otherSeat(leadingSeat(round))], snapshotIds: { blue: snaps.blue.snapshotId, red: snaps.red.snapshotId }, note: 'Both seat snapshots were built from this one pre-order state. queueOrder applies only to orders both seats submit for this round.' }));
  writeOnce(path.join(stage, d, 'replay.json'), JSON.stringify(cp) + '\n');
  return d;
}
const cursorFor = (round: number, tick: number): DualCursor => ({ round, tick, seats: { blue: seatFiles(round, 'blue'), red: seatFiles(round, 'red') } });

// ---------------------------------------------------------------------------------------------
// init / step / status
// ---------------------------------------------------------------------------------------------

export async function initGame(opts: { dir: string; config: DualConfig }): Promise<DualManifest> {
  checkDualConfig(opts.config, 'usage');
  const base = { maxRounds: opts.config.maxRounds, ticksPerRound: opts.config.ticksPerRound, seed: opts.config.seed };
  const config: DualConfig = withOptionalKeys(isFullGame(opts.config) ? { mode: DUAL_FULL_GAME_MODE, ...base } : base, hasScenario(opts.config) ? opts.config.scenario : undefined, hasObservationProfile(opts.config) ? opts.config.observationProfile : undefined);
  if (fs.existsSync(opts.dir)) throw new DualRejection('usage', `${opts.dir} exists; choose a new game directory`);
  const scenario = dualScenario(config), selected = selectedScenario(config);
  // New games only: both seats' transports are admitted under the versioned water-route rule, carried in every checkpoint record.
  const e = await ReplayEngine.create({ simulationId: config.seed, map: scenario.map, transportAdmission: TRANSPORT_ADMISSION });
  const first = e.step(SEATS.map((s) => ({ side: s, intent: { type: 'spawn', tile: spawnTarget(e.game, ...scenario.spawn[s]) } }))); e.fingerprints[first.tick] = first.fingerprint;
  // The engine's own board for this map; identical to the original call for the default world-500 scenario.
  const layout = createNetworkLayout(e); let network = initialNetwork(e.game.ticks(), scenario.map);
  const scenarioFile = selected ? { scenario: scenarioRecord(selected, e) } : {};
  // Deployment: no orders from anyone until both seats have spawned and the spawn phase is over, at a 45-tick boundary.
  const deployed = (x: ReplayEngine) => x.game.ticks() % 45 === 0 && !x.game.inSpawnPhase() && SEATS.every((s) => x.player(s).hasSpawned());
  const deployment = advance(e, layout, network, [], NETWORK_RULES.limitTicks, deployed); network = deployment.network;
  if (deployment.outcome || !deployed(e)) throw new DualRejection('integrity', `deployment did not reach a playable round (tick ${e.game.ticks()})`);
  const gameId = `dual-${crypto.randomUUID()}`;
  const snaps = buildRound(e, network, gameId, 0, config, [], { blue: [], red: [] }, null);
  const game = { schema: `${DUAL_SCHEMA}#game`, gameId, createdAt: new Date().toISOString(), config, scenarioId: scenario.id, map: scenario.map, ...scenarioFile, transportAdmission: TRANSPORT_ADMISSION, engine: { upstreamCommit: UPSTREAM_COMMIT, simulationProfile: SIMULATION_PROFILE }, deploymentFromTick: first.tick, firstRoundTick: e.game.ticks(), seats: [...SEATS], opponentController: null, claims: claimsFor(config) };
  fs.mkdirSync(opts.dir, { recursive: true });
  commitStaged(opts.dir, (stage) => { writeOnce(path.join(stage, GAME_FILE), json(game)); return ['initialization', stageRound(stage, gameId, 0, snaps, checkpointOf(e, network), selected, profileOf(config))]; });
  const manifest: DualManifest = { schema: DUAL_SCHEMA, gameId, config, status: 'awaiting-responses', cursor: cursorFor(0, e.game.ticks()), history: [] };
  writeManifest(opts.dir, manifest); return manifest;
}

interface DualGameFile { gameId: string; config: DualConfig; scenarioId: string; map: string; scenario?: ScenarioRecord; transportAdmission: string; claims: unknown }
/** Read-only integrity checks shared by step and status. */
function loadGame(dir: string) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new DualRejection('usage', `${file} does not exist`);
  const m = readJson<DualManifest>(file);
  if (m.schema !== DUAL_SCHEMA) throw new DualRejection('integrity', `manifest schema is not ${DUAL_SCHEMA}`);
  checkDualConfig(m.config);
  const game = readJson<DualGameFile>(path.join(dir, GAME_FILE));
  if (game.gameId !== m.gameId || !isDeepStrictEqual(game.config, m.config) || game.transportAdmission !== TRANSPORT_ADMISSION) throw new DualRejection('integrity', `manifest no longer matches ${GAME_FILE}`);
  // The claims written at init state the mode, bound and scenario, so editing both configs cannot turn a short game into a full one, or a default game into a Taiwan one, or back.
  if (!isDeepStrictEqual(game.claims, claimsFor(m.config))) throw new DualRejection('integrity', `${GAME_FILE} claims do not match the recorded ${isFullGame(m.config) ? DUAL_FULL_GAME_MODE : 'short'} mode${hasScenario(m.config) ? `, ${m.config.scenario} scenario` : ''} and bound`);
  const scenario = dualScenario(m.config);
  if (game.scenarioId !== scenario.id || game.map !== scenario.map) throw new DualRejection('integrity', `${GAME_FILE} scenario ${game.scenarioId} on ${game.map} is not the recorded ${scenario.id} on ${scenario.map}`);
  if (hasScenario(m.config) !== ('scenario' in game)) throw new DualRejection('integrity', `${GAME_FILE} ${hasScenario(m.config) ? 'lacks' : 'has'} a scenario record the config does not match`);
  if (game.scenario) {
    const { spawnTiles: _s, terrain: _t, stationLayout: _l, sources: _src, ...identity } = game.scenario;
    if (!isDeepStrictEqual(identity, scenarioIdentity(scenario))) throw new DualRejection('integrity', `${GAME_FILE} scenario record differs from ${scenario.id} (map, spawns, relay rules or ${STRAIT_RED_CELL_VERSION} brief)`);
  }
  return { m, game, scenario: hasScenario(m.config) ? scenario : null };
}
const loadManifest = (dir: string) => loadGame(dir).m;
export const haltedRound = (dir: string, m: Pick<DualManifest, 'cursor'>) => (m.cursor && fs.existsSync(path.join(dir, rejectionDir(m.cursor.round))) ? rejectionDir(m.cursor.round) : null);

function readResponse(file: string) {
  let stat: fs.Stats; try { stat = fs.statSync(file); } catch { throw new DualRejection('usage', `response file ${file} cannot be read`); }
  if (!stat.isFile()) throw new DualRejection('usage', `response ${file} is not a file`);
  return fs.readFileSync(file);
}

type Parsed = { ok: true; choice: SeatChoice } | { ok: false; code: TrialRejection['code']; message: string };
/**
 * Stops the round: one write-once record with both raw replies (up to 64 KB each) and why each was or was not accepted.
 * Nothing is applied, the engine is not advanced and the manifest is unchanged; a later step for the round is refused.
 */
function haltRound(dir: string, m: DualManifest, stage: 'parse' | 'engine-validation', raws: Record<Side, Buffer>, results: Record<Side, Parsed>, snaps: Record<Side, SeatSnapshot>) {
  const k = m.cursor!.round, d = rejectionDir(k);
  commitStaged(dir, (st) => {
    for (const seat of SEATS) if (raws[seat].length <= MAX_STORED_RESPONSE_BYTES) writeOnce(path.join(st, d, `${seat}.response.raw.json`), raws[seat]);
    writeOnce(path.join(st, d, 'rejection.json'), json({
      schema: `${DUAL_SCHEMA}#rejection`, gameId: m.gameId, round: k, tick: m.cursor!.tick, stage, rejectedAt: new Date().toISOString(),
      seats: Object.fromEntries(SEATS.map((seat) => { const r = results[seat]; return [seat, { snapshotId: snaps[seat].snapshotId, responseSha256: sha(raws[seat]), responseBytes: raws[seat].length, rawStored: raws[seat].length <= MAX_STORED_RESPONSE_BYTES, accepted: r.ok, ...(r.ok ? {} : { code: r.code, message: r.message }) }]; })),
      applied: { blue: false, red: false }, engineAdvanced: false,
      note: 'Either reply failing stops the round without applying either choice. The harness does not retry or substitute a reply; this round cannot be stepped again.',
    }));
    return [d];
  });
  const failed = SEATS.filter((s) => !results[s].ok).map((s) => { const r = results[s] as Extract<Parsed, { ok: false }>; return { seat: s, code: r.code, message: r.message }; });
  throw new DualRejection(failed[0]!.code, `round ${k} halted, nothing applied: ${failed.map((f) => `${f.seat} ${f.code}: ${f.message}`).join('; ')}`, d);
}

export async function stepGame(opts: { dir: string; blueResponse: string; redResponse: string }): Promise<DualManifest> {
  const dir = opts.dir, { m, game, scenario } = loadGame(dir);
  if (m.status !== 'awaiting-responses' || !m.cursor) throw new DualRejection('not-awaiting', `game is ${m.status}`);
  const k = m.cursor.round;
  if (k !== m.history.length || k >= m.config.maxRounds) throw new DualRejection('integrity', `cursor round ${k} is outside the recorded ${m.config.maxRounds}-round bound`);
  if (!isDeepStrictEqual(m.cursor, cursorFor(k, m.cursor.tick))) throw new DualRejection('integrity', 'cursor paths differ from the harness layout');
  const halted = haltedRound(dir, m); if (halted) throw new DualRejection('halted', `round ${k} was already rejected (${halted}); start a new game`, halted);
  if (fs.existsSync(path.join(dir, resultDir(k)))) throw new DualRejection('integrity', `${resultDir(k)} already exists`);
  const raws: Record<Side, Buffer> = { blue: readResponse(opts.blueResponse), red: readResponse(opts.redResponse) };

  // Saved round inputs must be exactly what the harness wrote for this seat, round and state.
  const round = readJson<{ gameId: string; round: number; tick: number; fingerprint: string; leadingSeat: Side; snapshotIds: Record<Side, string> }>(path.join(dir, roundDir(k), 'round.json'));
  if (round.gameId !== m.gameId || round.round !== k || round.tick !== m.cursor.tick || round.leadingSeat !== leadingSeat(k)) throw new DualRejection('integrity', `${roundDir(k)}/round.json does not match the manifest`);
  const snaps = {} as Record<Side, SeatSnapshot>;
  for (const seat of SEATS) {
    const f = m.cursor.seats[seat], s = readJson<SeatSnapshot>(path.join(dir, f.snapshot));
    try { checkSeatSnapshot(s); } catch (err) { throw new DualRejection('integrity', `${f.snapshot}: ${(err as Error).message}`); }
    if (s.seat !== seat || s.gameId !== m.gameId || s.decision !== k || s.tick !== round.tick || s.fingerprint !== round.fingerprint || s.snapshotId !== round.snapshotIds[seat] || s.transportAdmission !== TRANSPORT_ADMISSION) throw new DualRejection('integrity', `${f.snapshot} is not the ${seat} snapshot for round ${k}`);
    // Scenario context: exactly the public context for both seats and the Red Cell brief for Red only; none of it in a default game.
    const obs = s.observation;
    if (!scenario ? ('scenario' in obs || 'redCell' in obs) : !isDeepStrictEqual(obs.scenario, publicScenarioContext(scenario)) || obs.game !== scenarioGame(scenario) || ('redCell' in obs) !== (seat === 'red') || (seat === 'red' && !isDeepStrictEqual(obs.redCell, redCellContext()))) throw new DualRejection('integrity', `${f.snapshot} scenario context is not the ${scenario ? `${scenario.id} context for ${seat}` : 'default (none)'}`);
    // Observation profile: round-feedback/2 context exactly when the config records it; its contents are checked by the rebuild below.
    if (('roundContext' in obs) !== hasObservationProfile(m.config) || (hasObservationProfile(m.config) && (obs.roundContext as { profile?: unknown }).profile !== m.config.observationProfile)) throw new DualRejection('integrity', `${f.snapshot} round context does not match the recorded ${profileOf(m.config) ?? 'original'} observation`);
    if (fs.readFileSync(path.join(dir, f.prompt), 'utf8') !== renderDualPrompt(s, scenario, profileOf(m.config))) throw new DualRejection('integrity', `${f.prompt} differs from the prompt for its snapshot`);
    if (!isDeepStrictEqual(readJson(path.join(dir, f.schema)), playerOutputSchema())) throw new DualRejection('integrity', `${f.schema} differs from the player-output/1 schema`);
    snaps[seat] = s;
  }

  // Both replies are parsed strictly before anything else happens; either failure halts the round.
  const results = Object.fromEntries(SEATS.map((seat): [Side, Parsed] => {
    try { return [seat, { ok: true, choice: parseSeatChoice(raws[seat].toString('utf8'), snaps[seat], m.history.map((h) => h.seats[seat].snapshotId)) }]; } catch (err) {
      if (!(err instanceof TrialRejection)) throw err;
      return [seat, { ok: false, code: err.code, message: err.message }];
    }
  })) as Record<Side, Parsed>;
  if (SEATS.some((s) => !results[s].ok)) haltRound(dir, m, 'parse', raws, results, snaps);
  const choices = { blue: (results.blue as Extract<Parsed, { ok: true }>).choice, red: (results.red as Extract<Parsed, { ok: true }>).choice };

  // Deterministic reconstruction: restore the saved record, check the fingerprint and board, and rebuild both snapshots from the manifest history.
  const cp = readJson<DualCheckpoint>(path.join(dir, roundDir(k), 'replay.json'));
  const feedbackEvents: ExecutionFeedbackEvent[] = [];
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints', { feedback: { listener: (ev) => feedbackEvents.push(ev) } });
  feedbackEvents.length = 0; // re-executed history is not a receipt for this round
  if (e.options.transportAdmission !== TRANSPORT_ADMISSION) throw new DualRejection('integrity', `checkpoint engine admission is ${e.options.transportAdmission ?? 'original'}, not ${TRANSPORT_ADMISSION}`);
  if (e.options.map !== game.map) throw new DualRejection('integrity', `checkpoint engine map is ${e.options.map}, not the recorded ${game.map}`);
  if (scenario && game.scenario) {
    // Terrain, spawns and relay layout are re-derived from the restored engine and the catalog entry, not trusted from game.json.
    const facts = scenarioEngineFacts(scenario, e), { spawnTiles, terrain, stationLayout } = game.scenario;
    if (!isDeepStrictEqual({ spawnTiles, terrain, stationLayout }, facts) || !isDeepStrictEqual(spawnTilesOf(cp.record), facts.spawnTiles)) throw new DualRejection('integrity', `restored ${scenario.map} terrain, spawns or relay layout differ from ${GAME_FILE}`);
  }
  const fingerprintMatched = e.state().fingerprint === round.fingerprint && cp.tick === round.tick && cp.network.tick === round.tick && e.game.ticks() === round.tick;
  if (!fingerprintMatched) throw new DualRejection('integrity', `reconstruction diverged at tick ${round.tick}`);
  const earlierFeedback = readSeatFeedback(dir, m.history);
  const prior = k === 0 ? null : Object.fromEntries(SEATS.map((seat) => [seat, readJson<SeatSnapshot>(path.join(dir, seatFiles(k - 1, seat).snapshot))])) as Record<Side, SeatSnapshot>;
  const rebuilt = buildRound(e, cp.network, m.gameId, k, m.config, m.history, earlierFeedback, prior, savedOwnSnapshots(dir, m.config, k - BOARD_WINDOW, k));
  if (SEATS.some((seat) => !isDeepStrictEqual(rebuilt[seat], snaps[seat]))) throw new DualRejection('integrity', `rebuilt round ${k} snapshots differ from the saved ones`);

  // Both listed intents must pass the engine validator on the restored pre-order state before either is queued.
  const intents = Object.fromEntries(SEATS.map((seat) => [seat, choiceIntent(snaps[seat], choices[seat].choice, choices[seat].share)])) as Record<Side, Record<string, unknown> | null>;
  const engineChecks = Object.fromEntries(SEATS.map((seat): [Side, Parsed] => {
    const intent = intents[seat]; if (!intent) return [seat, { ok: true, choice: choices[seat] }];
    try { e.validate(seat, intent); return [seat, { ok: true, choice: choices[seat] }]; } catch (err) { return [seat, { ok: false, code: 'illegal-choice', message: `engine refused candidate ${choices[seat].choice}: ${(err as Error).message}` }]; }
  })) as Record<Side, Parsed>;
  if (SEATS.some((s) => !engineChecks[s].ok)) haltRound(dir, m, 'engine-validation', raws, engineChecks, snaps);

  const lead = leadingSeat(k), queueSeats: Side[] = [lead, otherSeat(lead)];
  const queue: QueuedOrder[] = queueSeats.filter((s) => intents[s]).map((seat) => ({ seat, intent: intents[seat]!, executedKey: null, droppedAtTick: null }));
  const before = { scores: { ...cp.network.scores }, blue: publicSide(e, 'blue'), red: publicSide(e, 'red') };
  const endTick = Math.min(round.tick + m.config.ticksPerRound, NETWORK_RULES.limitTicks);
  const { network, outcome } = advance(e, createNetworkLayout(e), cp.network, queue, endTick);
  const tick = e.game.ticks();

  const seatResult = (seat: Side): SeatRoundResult => {
    const c = choices[seat], q = queue.find((o) => o.seat === seat);
    return { snapshotId: snaps[seat].snapshotId, choice: c.choice, share: c.share ?? null, meaning: c.choice === 'hold' ? null : snaps[seat].candidates[c.choice]!.meaning, intent: intents[seat], executedKey: q?.executedKey ?? null, droppedAtTick: q?.droppedAtTick ?? null, responseSha256: sha(raws[seat]) };
  };
  const entry: DualHistoryEntry = { round: k, tick: round.tick, endTick: tick, leadingSeat: lead, queue: queueSeats, seats: { blue: seatResult('blue'), red: seatResult('red') }, result: resultDir(k) };
  const history = [...m.history, entry];
  // Execution feedback is recorded per seat for that seat's own order keys only.
  const ownKeys = (seat: Side) => new Set(history.map((h) => h.seats[seat].executedKey).filter((x): x is string => x !== null));
  const roundFeedback = Object.fromEntries(SEATS.map((seat) => { const keys = ownKeys(seat); return [seat, feedbackEvents.filter((ev) => keys.has(ev.keyString)).map((ev) => ({ key: ev.keyString, tick: ev.tick, status: ev.status }))]; })) as Record<Side, { key: string; tick: number; status: string }[]>;
  const outcomeRecord = {
    schema: `${DUAL_SCHEMA}#result`, gameId: m.gameId, round: k, fromTick: round.tick, toTick: tick,
    queue: { leadingSeat: lead, order: queueSeats, orders: queue.map((o, position) => ({ position, seat: o.seat, intent: o.intent, admittedBeforeApply: true, executedKey: o.executedKey, droppedAtTick: o.droppedAtTick })), holds: SEATS.filter((s) => intents[s] === null), note: 'Admitted orders enter one engine turn in this order; the leading seat alternates by round. Not a fairness proof.' },
    reconstruction: { restoredFromRecordTurns: cp.record.turns.length, fingerprintMatched, snapshotsRebuiltIdentically: true },
    feedback: roundFeedback, feedbackNote: 'Execution feedback exists only for City/Defense Post/Port construction and transports; attacks and upgrades are unobserved. Admission is not success.',
    board: { before, after: { scores: { ...network.scores }, controllers: { ...network.controllers }, blue: publicSide(e, 'blue'), red: publicSide(e, 'red') } },
    fingerprintAfter: e.state().fingerprint, outcome,
  };
  const decisionRecord = (seat: Side) => ({ schema: `${DUAL_SCHEMA}#decision`, gameId: m.gameId, round: k, seat, tick: round.tick, snapshotId: snaps[seat].snapshotId, choice: choices[seat].choice, share: choices[seat].share ?? null, intent: intents[seat], meaning: entry.seats[seat].meaning, rationale: choices[seat].rationale, responseSha256: entry.seats[seat].responseSha256, acceptedAt: new Date().toISOString(), rationaleVisibility: 'author seat only; never placed in either seat\'s later context' });

  const done = outcome !== null || k + 1 >= m.config.maxRounds;
  commitStaged(dir, (stage) => {
    const r = resultDir(k);
    for (const seat of SEATS) { writeOnce(path.join(stage, r, seat, 'response.raw.json'), raws[seat]); writeOnce(path.join(stage, r, seat, 'decision.json'), json(decisionRecord(seat))); }
    writeOnce(path.join(stage, r, 'outcome.json'), json(outcomeRecord));
    if (!done) {
      const feedback = Object.fromEntries(SEATS.map((s) => [s, [...earlierFeedback[s], ...roundFeedback[s]]])) as typeof roundFeedback;
      const earlier = savedOwnSnapshots(dir, m.config, k + 1 - BOARD_WINDOW, k), recent = Object.fromEntries(SEATS.map((s) => [s, hasObservationProfile(m.config) ? [...earlier[s], snaps[s]] : []])) as Record<Side, SeatSnapshot[]>;
      return [r, stageRound(stage, m.gameId, k + 1, buildRound(e, network, m.gameId, k + 1, m.config, history, feedback, snaps, recent), checkpointOf(e, network), scenario, profileOf(m.config))];
    }
    writeOnce(path.join(stage, 'final/replay.json'), JSON.stringify(checkpointOf(e, network)) + '\n');
    writeOnce(path.join(stage, 'final/summary.json'), json(summaryFor(m, history, e, network, outcome, sourceHashes([{ base: dir, parts: ['initialization', 'rounds', 'results'] }, { base: stage, parts: ['results'] }]), game.scenario)));
    return [r, 'final'];
  });
  const updated: DualManifest = { ...m, status: done ? 'complete' : 'awaiting-responses', cursor: done ? null : cursorFor(k + 1, tick), history };
  writeManifest(dir, updated);
  return updated;
}

function readSeatFeedback(dir: string, history: readonly DualHistoryEntry[]) {
  const out: Record<Side, { key: string; tick: number; status: string }[]> = { blue: [], red: [] };
  for (const h of history) {
    const r = readJson<{ round: number; feedback: typeof out }>(path.join(dir, h.result, 'outcome.json'));
    if (r.round !== h.round) throw new DualRejection('integrity', `${h.result}/outcome.json is not round ${h.round}`);
    for (const seat of SEATS) out[seat].push(...r.feedback[seat]);
  }
  return out;
}

/** Counts, stop reason and proof that the record holds only spawns and the listed seat orders. */
export function summaryFor(m: DualManifest, history: readonly DualHistoryEntry[], e: ReplayEngine, network: NetworkState, outcome: ReturnType<typeof networkOutcome>, sources: { path: string; sha256: string }[], scenario?: ScenarioRecord) {
  const tick = e.game.ticks(), record = e.record();
  const orders = (seat: Side) => { const rs = history.map((h) => h.seats[seat]), submitted = rs.filter((r) => r.choice !== 'hold'); return { rounds: rs.length, holds: rs.length - submitted.length, submitted: submitted.length, executedAtTick: submitted.filter((r) => r.executedKey !== null).length, droppedAtTick: submitted.filter((r) => r.droppedAtTick !== null).length }; };
  const listed = new Set(history.flatMap((h) => SEATS.map((s) => h.seats[s].executedKey)).filter((x): x is string => x !== null));
  const recorded = record.turns.flatMap((t) => t.intents.map((intent, intentIndex) => ({ type: intent.type, key: inputKeyString({ turnNumber: t.turnNumber, intentIndex, clientID: intent.clientID }) }))).filter((i) => i.type !== 'spawn');
  const unlistedOrders = recorded.filter((i) => !listed.has(i.key)).length;
  return {
    schema: `${DUAL_SCHEMA}#summary`, gameId: m.gameId, config: m.config, rounds: history.length, firstRoundTick: history[0]?.tick ?? null, ticksSimulated: tick, simulatedSeconds: tick * TICK_SIMULATED_MS / 1000,
    outcome, stopReason: outcome !== null ? 'game-outcome' as const : 'round-limit' as const, scoresStatus: outcome ? 'final' : 'provisional',
    outcomeNote: outcome ? `Game outcome reached inside the bound (${outcome.reason}).` : isFullGame(m.config) ? `No outcome: the ${m.config.maxRounds}-round ${DUAL_FULL_GAME_MODE} bound stopped the game at tick ${tick}, before elimination or the ${NETWORK_RULES.limitTicks}-tick objective limit. Scores are provisional; this capped run is not a win or evidence of mastery.` : `No outcome: the ${m.config.maxRounds}-round limit stopped the game at tick ${tick}, before elimination or the ${NETWORK_RULES.limitTicks}-tick objective limit. Scores are provisional; this short capped run is not a win or evidence of mastery.`,
    scores: { ...network.scores }, controllers: { ...network.controllers },
    orders: { blue: orders('blue'), red: orders('red') }, leadingSeatByRound: history.map((h) => h.leadingSeat),
    reconstruction: { finalFingerprint: e.state().fingerprint, recordTurns: record.turns.length, recordedOrders: recorded.length, listedSeatOrders: listed.size, unlistedOrders, note: 'unlistedOrders counts non-spawn intents in the final record that are not a listed seat order executed at tick time; 0 means no other order (scripted or otherwise) entered the game. `status` does not replay; restore final/replay.json to check finalFingerprint.' },
    engine: { upstreamCommit: record.upstreamCommit, simulationProfile: record.simulationProfile, transportAdmission: record.options.transportAdmission },
    sources, sourcesNote: 'sha256 of every write-once input and result file at completion (manifest.json and final/ excluded).',
    claims: claimsFor(m.config),
    // A selected scenario's recorded identity, engine facts and source provenance; absent from default summaries.
    ...(scenario ? { scenario } : {}),
  };
}

/** Rebuild a saved round's seat snapshot and prompt text from the saved checkpoint, history and feedback, as `step` does. Reads only; writes nothing. */
export async function rebuildSavedRound(dir: string, k: number) {
  const { m, scenario } = loadGame(dir);
  if (!Number.isInteger(k) || k < 0 || k > m.history.length) throw new DualRejection('usage', `round ${k} is not a saved round`);
  const history = m.history.slice(0, k), cp = readJson<DualCheckpoint>(path.join(dir, roundDir(k), 'replay.json'));
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints');
  const prior = k === 0 ? null : Object.fromEntries(SEATS.map((seat) => [seat, readJson<SeatSnapshot>(path.join(dir, seatFiles(k - 1, seat).snapshot))])) as Record<Side, SeatSnapshot>;
  const snaps = buildRound(e, cp.network, m.gameId, k, m.config, history, readSeatFeedback(dir, history), prior, savedOwnSnapshots(dir, m.config, k - BOARD_WINDOW, k));
  return Object.fromEntries(SEATS.map((seat) => [seat, { snapshot: json(snaps[seat]), prompt: renderDualPrompt(snaps[seat], scenario, profileOf(m.config)) }])) as Record<Side, { snapshot: string; prompt: string }>;
}

export function gameStatus(dir: string) {
  const m = loadManifest(dir);
  return { manifest: m, halted: haltedRound(dir, m) };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const cliLine = (dir: string, m: DualManifest, halted: string | null) => ({ ok: true, dir, gameId: m.gameId, status: m.status, halted, roundsCompleted: m.history.length, cursor: m.cursor, summary: m.status === 'complete' ? 'final/summary.json' : null });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.debug = () => {}; console.warn = () => {}; console.info = () => {};
  try {
    const a = parseDualArgs(process.argv.slice(2));
    if (a.command === 'init') console.log(JSON.stringify(cliLine(a.dir, await initGame(a), null)));
    else if (a.command === 'step') console.log(JSON.stringify(cliLine(a.dir, await stepGame(a), null)));
    else { const s = gameStatus(a.dir); console.log(JSON.stringify(cliLine(a.dir, s.manifest, s.halted))); }
  } catch (err) {
    const known = err instanceof DualRejection || err instanceof TrialRejection;
    const line = JSON.stringify({ ok: false, rejected: known ? err.code : 'error', message: (err as Error).message, rejection: err instanceof DualRejection ? err.rejection : null });
    // stdout keeps the last-line contract; stderr carries the same line for drivers that report stderr on failure.
    console.error(line); console.log(line);
    process.exitCode = 1;
  }
}
