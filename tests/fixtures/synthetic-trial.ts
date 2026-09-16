/**
 * Independently authored schema fixture. No engine, person or provider produced this trial.
 * The production projection uses recorded-trial labels; exercising those labels here is a
 * serialization/validation test, never evidence of a real model call or engine reconstruction.
 * All provider envelopes, fingerprints and optional receipt values below are synthetic.
 */
import {sha256Hex, type TrialInput} from '../../src/ontology/catalog-projection';

export const SYNTHETIC_TRIAL = 'synthetic-public-schema-fixture';
export const SYNTHETIC_GAME = 'synthetic-public-game';
export const SYNTHETIC_ROUNDS = 8;
export const syntheticFingerprint = (round: number) => sha256Hex(`synthetic-state-${round}`);

export function syntheticTrial(swapped = false, gameId = SYNTHETIC_GAME): TrialInput {
  const name = swapped ? 'synthetic-swapped-schema-fixture' : SYNTHETIC_TRIAL;
  const files = new Map<string, string>();
  const put = (path: string, value: unknown) => files.set(path, JSON.stringify(value, null, 2) + '\n');
  const models = swapped ? {blue: 'claude-opus-5', red: 'gpt-5.6-sol'} : {blue: 'gpt-5.6-sol', red: 'claude-opus-5'};
  const config = {seed: 'SYNTH001', scenario: 'taiwan-strait/1', mode: 'synthetic-schema-fixture', maxRounds: SYNTHETIC_ROUNDS, ticksPerRound: 270};
  const history: any[] = [], proofRounds: any[] = [], turns: any[] = [];
  const controllers = {syntheticA: 'blue', syntheticB: 'red'};
  const board = (round: number) => ({scores: {blue: round, red: round}, controllers});
  for (let round = 0; round < SYNTHETIC_ROUNDS; round++) {
    const n = String(round).padStart(2, '0'), tick = 45 + round * 270, endTick = tick + 270;
    const fingerprint = syntheticFingerprint(round), fingerprintAfter = syntheticFingerprint(round + 1);
    const seats: any = {}, proofSeats: any = {}, snapshotIds: any = {}, orders: any[] = [], holds: string[] = [];
    const feedback: Record<'blue' | 'red', any[]> = {blue: [], red: []};
    for (const [position, seat] of (['blue', 'red'] as const).entries()) {
      const snapshotId = `synthetic-${n}-${seat}`;
      const hold = (seat === 'blue' && round === 5) || (seat === 'red' && round === 3);
      const build = (seat === 'blue' && round === 2) || (seat === 'red' && round < 2);
      const boat = (seat === 'blue' && round < 2) || (seat === 'red' && round === 2);
      const choice = hold ? 'hold' : 1, share = hold || build ? null : round === 4 ? 0.5 : 0.2;
      const candidateIntent = build ? {type: 'build_unit', unit: 'Synthetic Post', tile: 1}
        : boat ? {type: 'boat', dst: 1} : {type: 'attack', targetID: null};
      const intent = hold ? null : build ? candidateIntent : {...candidateIntent, troops: share === 0.5 ? 50 : 20};
      const meaning = 'Synthetic listed order';
      const response = {snapshotId, choice, share, rationale: `Synthetic fixture rationale ${n} ${seat}; no model was called.`};
      const responsePath = `responses/${n}-${seat}.json`;
      put(responsePath, response);
      put(`results/${n}/${seat}/response.raw.json`, response);
      const responseSha256 = sha256Hex(files.get(responsePath)!);
      const executedKey = `${tick}:${position}:synthetic${seat}`;
      const decision = {gameId, round, seat, tick, snapshotId, choice, share, intent, meaning, responseSha256, rationale: response.rationale};
      put(`results/${n}/${seat}/decision.json`, decision);
      seats[seat] = {...decision, executedKey, droppedAtTick: null};
      snapshotIds[seat] = snapshotId;
      put(`rounds/${n}/${seat}/snapshot.json`, {
        schema: 'replay.ai-player-trial/1#seat-snapshot', gameId, seat, tick, snapshotId, fingerprint,
        candidates: [
          {index: 0, intent: {type: 'attack', targetID: 'synthetic-opponent'}, meaning: 'Synthetic alternate', troopOptions: [{share, troops: 20}]},
          {index: 1, intent: candidateIntent, meaning, ...(build ? {} : {troopOptions: [{share: 0.2, troops: 20}, {share: 0.5, troops: 50}]})},
        ], observation: {objectiveBoard: {ownReserve: {fraction: 0.8, eligible: true}}, own: {troops: 100}},
        fixtureNotice: 'SYNTHETIC SCHEMA FIXTURE — NOT AN ENGINE CAPTURE',
      });
      files.set(`rounds/${n}/${seat}/prompt.md`, `Synthetic test prompt ${n} ${seat}. No participant or provider data.\n`);
      put(`rounds/${n}/${seat}/schema.json`, {type: 'object', fixture: true});
      const model = models[seat], provider = `providers/${n}-${seat}.${model === 'gpt-5.6-sol' ? 'jsonl' : 'json'}`;
      if (model === 'gpt-5.6-sol') {
        files.set(provider, [
          {type: 'item.completed', item: {type: 'reasoning', text: 'synthetic reasoning_output must never reach graph'}},
          {type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(response)}},
          {type: 'turn.completed', session_id: 'synthetic-session-not-a-real-session', total_cost: 0},
        ].map(x => JSON.stringify(x)).join('\n') + '\n');
      } else put(provider, {is_error: false, modelUsage: {[model]: {inputTokens: 0}}, structured_output: response, session_id: 'synthetic-session-not-a-real-session', costUSD: 0});
      proofSeats[seat] = {snapshotId, status: 'returned', model, response: responsePath,
        providerArtifact: `evidence/dual-model-trial/${name}/${provider}`, providerArtifactSha256: sha256Hex(files.get(provider)!),
        promptSha256: sha256Hex(files.get(`rounds/${n}/${seat}/prompt.md`)!), label: 'synthetic-provider-envelope-no-call',
        constrainedOutput: true, toolsDisabled: true, toolsObserved: false};
      if (hold) holds.push(seat);
      else orders.push({seat, position, intent, executedKey, admittedBeforeApply: true});
      if (boat) feedback[seat].push({key: executedKey, tick: endTick, status: 'transport-launched'});
      if (boat && round !== 1) feedback[seat].push({key: executedKey, tick: endTick, status: 'transport-landed'});
      if (build && round !== 1) feedback[seat].push({key: executedKey, tick: endTick, status: 'construction-completed'});
    }
    put(`rounds/${n}/round.json`, {gameId, round, tick, fingerprint, leadingSeat: 'blue', snapshotIds});
    put(`rounds/${n}/replay.json`, {schema: 'synthetic-checkpoint-shape-only', tick});
    put(`results/${n}/outcome.json`, {gameId, round, fromTick: tick, toTick: endTick, fingerprintAfter,
      queue: {order: ['blue', 'red'], leadingSeat: 'blue', orders, holds},
      reconstruction: {fingerprintMatched: true, snapshotsRebuiltIdentically: true},
      board: {before: board(round), after: board(round + 1)}, feedback, outcome: null});
    history.push({round, tick, endTick, leadingSeat: 'blue', queue: ['blue', 'red'], seats});
    proofRounds.push({round, tick, applied: true, applicationStatus: 'applied', seats: proofSeats});
    turns.push({intents: orders.map(o => o.intent)});
  }
  const ticks = 45 + SYNTHETIC_ROUNDS * 270;
  put('initialization/game.json', {schema: 'replay.dual-model-trial/1#game', gameId, config, scenarioId: config.scenario,
    map: 'synthetic-map', createdAt: '2000-01-01T00:00:00.000Z', firstRoundTick: 45,
    engine: {upstreamCommit: 'synthetic-no-engine-run', simulationProfile: 'synthetic-fixture'},
    claims: {claim: 'Synthetic validation fixture; no actual provider calls or engine reconstruction.', timing: 'Synthetic ticks', humanPlaytest: false},
    scenario: {stationLayout: [{id: 'syntheticA', name: 'Synthetic A', tile: 1}, {id: 'syntheticB', name: 'Synthetic B', tile: 2}]}});
  put('manifest.json', {schema: 'replay.dual-model-trial/1', status: 'complete', gameId, config, history});
  put('final/replay.json', {schema: 'replay.dual-model-trial/1#checkpoint', tick: ticks,
    record: {turns, options: {map: 'synthetic-map', simulationId: config.seed}, upstreamCommit: 'synthetic-no-engine-run'}});
  const orderCount = {rounds: SYNTHETIC_ROUNDS, holds: 1, submitted: SYNTHETIC_ROUNDS - 1, executedAtTick: SYNTHETIC_ROUNDS - 1, droppedAtTick: 0};
  const summary = {schema: 'replay.dual-model-trial/1#summary', gameId, config, rounds: SYNTHETIC_ROUNDS,
    ticksSimulated: ticks, stopReason: 'synthetic-cap', scoresStatus: 'synthetic', outcome: null, scores: board(8).scores, controllers,
    orders: {blue: orderCount, red: orderCount},
    reconstruction: {finalFingerprint: syntheticFingerprint(SYNTHETIC_ROUNDS), recordTurns: turns.length, listedSeatOrders: SYNTHETIC_ROUNDS * 2 - 2, unlistedOrders: 0},
    sources: [...files].map(([path, text]) => ({path, sha256: sha256Hex(text)}))};
  put('final/summary.json', summary);
  put('provider-proof.json', {status: 'completed', gameId, assignment: {models}, rounds: proofRounds, summary,
    modelCallsAttempted: SYNTHETIC_ROUNDS * 2, retries: 0, appInferenceCalls: 0,
    fixtureNotice: 'Synthetic accounting fields to exercise schema validation. Actual calls: zero.'});
  return {name, files: [...files].map(([path, text]) => ({path, text})), engineReceipt: null};
}
