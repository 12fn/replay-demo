/**
 * MAIN DISPATCH ONLY, after deployment:
 * python3 scripts/run_logged.py native-guarded-voyage -- ./node_modules/.bin/tsx scripts/platform/qualify-native-guarded-voyage.ts 0.22.1
 *
 * One fresh synthetic `crosscurrent-crossing/1` original under `launch-water-route/1`, through normal native logins only:
 * the native owner creates, selects and ends it; the enrolled Commander (blue, the exercise's human side) takes one
 * engine-listed landing from /api/action-options and submits it as an ordinary /api/commands order. Recorded
 * execution feedback is then compared with an independent local reconstruction of the released record.
 * No model, agent, staff, Tomo or MCP routes; no database, pod or file edits other than the new receipt.
 * Launch, landing and guard refusal are claimed only when observed. No legal candidate is reported as such, never passed.
 * Creation is never retried; the finally block ends only this run's exercise and always writes the receipt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { CLIENTS, ReplayEngine, SIMULATION_PROFILE, TRANSPORT_ADMISSION, type EngineRecord, type Side } from '../../src/engine/engine';
import { inputKeyString, type InputKey } from '../../src/engine/execution-feedback';

type Json = any;
export type Seat = 'owner' | 'commander';
export interface Client {
  requestRaw(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<Response>;
  close(): Promise<void>;
}
export interface Observation { tick: number; status: string }
export interface Reconstruction { fromTurn: number; turns: number; verifiedTicks: number; finalFingerprint: string; observations: Observation[] }
export interface Limits {
  deployMs: number; candidateMs: number; observeMs: number; liveMs: number; pollMs: number; httpMs: number;
  ownerRequests: number; commanderRequests: number; cleanupRequests: number; reconstructionTurns: number;
}
export interface Deps {
  login(seat: Seat): Promise<Client>;
  /** Called once with the finished exercise's released record; defaults to the pinned local engine. */
  reconstruct?(record: EngineRecord, key: InputKey | null, maxTurns: number): Promise<Reconstruction>;
  /** First call creates the receipt exclusively; later calls replace its contents. */
  writeReceipt(file: string, text: string, create: boolean): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  runId?: string;
  limits?: Partial<Limits>;
  signal?: AbortSignal;
  /** Explicit fresh-run setup: one ordinary35% expansion, no direct game-state changes. */
  prepareShore?: boolean;
}

export const SCENARIO = 'crosscurrent-crossing/1';
export const GUARD_REFUSAL = 'No water route from your launch shore to that landing';
export const DEFAULT_LIMITS: Limits = {
  deployMs: 45_000, candidateMs: 30_000, observeMs: 75_000, liveMs: 180_000, pollMs: 1500, httpMs: 15_000,
  ownerRequests: 40, commanderRequests: 140, cleanupRequests: 12, reconstructionTurns: 6000,
};
const TERMINAL = new Set(['transport-landed', 'transport-forces-returned', 'transport-not-launched', 'transport-ended-unconfirmed', 'observation-failed']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export class CheckFailure extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new CheckFailure(code); }

/** Row identity without the overview's live tick; completed rows must be byte-stable across the run. */
const rowHash = (row: Json) => { const { tick: _tick, ...rest } = row; return sha(rest); };

/**
 * Only these application routes, and only against this run's exercise where one is named. Everything
 * else (model, agent, staff, Tomo, MCP, replay seeking, other exercises) is refused before any request.
 */
export function allowedRequest(method: string, url: string, exerciseId: string | null): boolean {
  const fixed: Record<string, string[]> = {
    GET: ['/replay-build.json', '/api/native/status', '/api/team', '/api/agents/tools', '/api/overview'],
    POST: ['/api/exercises', '/api/team/code', '/api/team/join', '/api/select', '/api/commands'],
  };
  if (fixed[method]?.includes(url)) return true;
  if (!exerciseId) return false;
  const id = encodeURIComponent(exerciseId);
  if (method === 'GET') return url === `/api/action-options?exerciseId=${id}` || url === `/api/record/${id}`;
  return method === 'POST' && url === `/api/exercises/${id}/finish`;
}

/** Recorded observations must be the reconstructed ones, in order; a complete read must also have the same length. */
export function compareObservations(recorded: Observation[], reconstructed: Observation[], complete: boolean): boolean {
  if (recorded.length > reconstructed.length || complete && recorded.length !== reconstructed.length) return false;
  return recorded.every((o, i) => o.tick === reconstructed[i].tick && o.status === reconstructed[i].status);
}

/**
 * Restore the released record to just before the submitted order's turn, then replay every later recorded turn
 * with fresh execution observation. Every replayed tick must equal the stored fingerprint; observations for the
 * order's input key are returned with the application's event tick (engine ticks after the turn).
 */
export async function reconstructVoyage(record: EngineRecord, key: InputKey | null, maxTurns: number): Promise<Reconstruction> {
  check(record.turns.length <= maxTurns, 'reconstruction-turn-cap');
  const from = key ? record.turns.findIndex(t => t.turnNumber === key.turnNumber) : record.turns.length;
  check(from >= 0, 'recorded-turn-missing');
  const engine = await ReplayEngine.restore(record, from, from <= 2000 ? 'every-tick' : 'checkpoints');
  const sides = new Map(Object.entries(CLIENTS).map(([side, client]) => [client, side as Side]));
  const wanted = key ? inputKeyString(key) : null, observations: Observation[] = [];
  let verified = 0;
  for (const turn of record.turns.slice(from)) {
    const orders = turn.intents.map(({ clientID, ...intent }) => {
      const side = sides.get(String(clientID)); check(side, 'reconstruction-unknown-client');
      return { side, intent };
    });
    let state;
    try { state = engine.step(orders); } catch { throw new CheckFailure('reconstruction-turn-refused'); }
    check(state.fingerprint === record.fingerprints[state.tick], 'reconstruction-fingerprint-mismatch');
    verified++;
    for (const event of engine.feedback.drain()) if (event.keyString === wanted) observations.push({ tick: engine.game.ticks(), status: event.status });
    if (verified % 50 === 0) await setImmediate();
  }
  const finalFingerprint = engine.state().fingerprint;
  check(finalFingerprint === record.fingerprints[record.turns.length], 'reconstruction-final-fingerprint');
  return { fromTurn: from, turns: record.turns.length, verifiedTicks: verified, finalFingerprint, observations };
}

export type Outcome = 'not-reached' | 'no-legal-candidate' | 'launched' | 'guard-refused-at-submission' | 'guard-refused-at-tick'
  | 'refused-other' | 'not-launched' | 'not-settled' | 'submission-unresolved';

export async function runGuardedVoyage(version: string, deps: Deps) {
  check(/^\d+\.\d+\.\d+$/.test(version) && version.length < 40, 'release-version');
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => delay(ms, undefined, deps.signal ? { signal: deps.signal } : undefined));
  const reconstruct = deps.reconstruct ?? reconstructVoyage;
  const runId = deps.runId ?? randomUUID().slice(0, 8);
  check(/^[a-z0-9-]{1,36}$/.test(runId), 'run-id');
  const artifact = `evidence/platform/native-guarded-voyage-${version}-${runId}.json`;
  const name = `Automated guarded voyage qualification ${version} ${runId}`;

  const receipts: Array<{ seat: Seat; phase: string; method: string; path: string; status: number | null; latencyMs: number; cleanup: boolean }> = [];
  const failures: Array<{ phase: string; code: string }> = [];
  const counts = { owner: 0, commander: 0, cleanup: 0 };
  const clients: Partial<Record<Seat, Client>> = {};
  let phase = 'initialize', exerciseId: string | null = null, liveDeadline: number | null = null, exercisePosts = 0;
  let creationAttempted = false, cleanupFinished = false, ownerSubject = '', outcome: Outcome = 'not-reached';
  let budgetBefore: Json = null, budgetAfter: Json = null;
  const proof: Json = {
    schema: 'replay.native-guarded-voyage/1', version, runId, scenarioId: SCENARIO, transportAdmission: TRANSPORT_ADMISSION,
    startedAt: new Date().toISOString(), status: 'running', automated: true, synthetic: true, name, exerciseId: null,
    limits, checks: {}, claims: { launchObserved: false, landingObserved: false, forcesReturnedObserved: false, guardRefusalObserved: false, arrivalPredicted: false },
    modelEndpointsCalled: false, controllerSettingsChanged: false, directStoreWrites: false,
    preparationProfile: deps.prepareShore ? 'expand-to-shore/1' : null,
    candidateSelection: deps.prepareShore ? 'sampled-farthest/1' : 'sampled-first/1',
    limitations: [
      'Automated HTTP qualification of one synthetic exercise; not a human naval play session, opponent-quality or learning result.',
      'The order uses a declared deterministic selection from engine-listed landings; this is a qualification, not an optimal plan.',
      'An admitted route is not a prediction of arrival; landing is claimed only when a transport-landed observation was recorded.',
      'Global budget equality also fails if paid work elsewhere runs during this window.',
    ],
  };
  let created = false;
  const save = () => {
    const status = proof.status;
    proof.at = new Date().toISOString(); proof.phase = phase; proof.exerciseId = exerciseId; proof.outcome = outcome;
    proof.failures = failures; proof.receipts = receipts; proof.requests = counts;
    proof.cleanup = { attempted: creationAttempted, finished: cleanupFinished };
    proof.budgetBefore = budgetBefore; proof.budgetAfter = budgetAfter;
    proof.newPaidRequests = budgetBefore && budgetAfter ? budgetAfter.requestsUsed - budgetBefore.requestsUsed : null;
    deps.writeReceipt(artifact, JSON.stringify({ ...proof, status }, null, 2) + '\n', !created); created = true;
  };
  const failure = (error: unknown) => failures.push({ phase, code: error instanceof CheckFailure ? error.message : 'operation-failed' });

  const send = async (seat: Seat, method: 'GET' | 'POST', url: string, body?: unknown, cleanup = false) => {
    check(allowedRequest(method, url, exerciseId), 'route-not-allowed');
    if (method === 'POST' && url === '/api/exercises') check(++exercisePosts === 1, 'exercise-creation-retry-forbidden');
    if (cleanup) check(++counts.cleanup <= limits.cleanupRequests, 'cleanup-request-cap');
    else check(++counts[seat] <= limits[seat === 'owner' ? 'ownerRequests' : 'commanderRequests'], `${seat}-request-cap`);
    const remaining = !cleanup && liveDeadline !== null ? liveDeadline - now() : Infinity;
    check(remaining > 0, 'live-deadline');
    const client = clients[seat]; check(client, `${seat}-not-signed-in`);
    const receipt = { seat, phase, method, path: url.replace(/[?].*$/, ''), status: null as number | null, latencyMs: 0, cleanup };
    const began = now();
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(limits.httpMs, remaining))));
      const response = await client.requestRaw(url, method === 'POST' ? body ?? {} : undefined, { signal });
      receipt.status = response.status;
      let data: Json = null; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data };
    } finally { receipt.latencyMs = Math.round(now() - began); receipts.push(receipt); }
  };
  const read = async (seat: Seat, method: 'GET' | 'POST', url: string, body?: unknown, cleanup = false) => {
    const r = await send(seat, method, url, body, cleanup);
    check(r.status >= 200 && r.status < 300, `http-${r.status}`);
    return r.data;
  };
  /** Select this run's exercise for the seat; scoped operations use a confirmed selection, rechecked before submission and finish. */
  const select = async (seat: Seat, cleanup = false) => {
    check(exerciseId, 'no-exercise-to-select');
    const r = await read(seat, 'POST', '/api/select', { exerciseId }, cleanup);
    check(r?.selected === exerciseId, 'selection-not-confirmed');
  };
  const budget = async (cleanup = false) => {
    const b = (await read('owner', 'GET', '/api/agents/tools', undefined, cleanup))?.budget;
    check(b && ['requestsUsed', 'maxRequests', 'committedUsd', 'maxUsd'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k])), 'budget-shape');
    return { requestsUsed: b.requestsUsed, maxRequests: b.maxRequests, committedUsd: b.committedUsd, maxUsd: b.maxUsd };
  };
  const commanderLive = async () => {
    const ov = await read('commander', 'GET', '/api/overview');
    check(ov?.activeId === exerciseId && ov.identity?.role === 'commander' && ov.selectedSide === 'blue' && ov.playbackTick === null, 'commander-scope-changed');
    const row = (ov.exercises ?? []).find((e: Json) => e.id === exerciseId);
    check(row && row.status === 'running', 'exercise-not-running');
    check(row.agentEnabled === false && (ov.tasks ?? []).every((t: Json) => t.modelEnabled !== true), 'paid-controller-enabled');
    return ov;
  };
  const orderRow = (ov: Json, commandId: string) => (ov.executionOrders ?? []).find((o: Json) => o.commandId === commandId);
  const observationsOf = (row: Json): Observation[] => (row?.observations ?? []).map((o: Json) => ({ tick: o.tick, status: o.status }));

  let intent: Json = null, commandId: string | null = null, liveRow: Json = null, oldRows = new Map<string, { hash: string; status: string }>();
  try {
    save();
    phase = 'owner-login';
    clients.owner = await deps.login('owner');
    const build = await read('owner', 'GET', '/replay-build.json');
    check(build?.version === version, 'deployed-version');
    proof.build = { version: build.version, sourceSha256: build.sourceArchive?.sha256 ?? null, simulationProfile: build.simulationProfile ?? null };
    const ownerStatus = await read('owner', 'GET', '/api/native/status');
    check(ownerStatus?.mode === 'kamiwaza' && ownerStatus.signedIn === true && ownerStatus.identity?.role === 'instructor'
      && ownerStatus.context?.nativeRole === 'owner' && typeof ownerStatus.identity.subject === 'string', 'native-owner');
    ownerSubject = ownerStatus.identity.subject;
    // requireActive on an existing visible record; the overview's first-exercise creation path is never reached.
    phase = 'existing-session-check'; await read('owner', 'GET', '/api/team');

    phase = 'commander-login';
    clients.commander = await deps.login('commander');
    const cmdStatus = await read('commander', 'GET', '/api/native/status');
    check(cmdStatus?.mode === 'kamiwaza' && cmdStatus.signedIn === true && cmdStatus.identity?.role === 'commander'
      && typeof cmdStatus.identity.subject === 'string' && cmdStatus.identity.subject !== ownerSubject
      && cmdStatus.workroomId === ownerStatus.workroomId, 'native-commander');
    proof.identities = { ownerSha256: sha(ownerSubject), commanderSha256: sha(cmdStatus.identity.subject), workroomSha256: sha(String(ownerStatus.workroomId)) };

    phase = 'baseline';
    budgetBefore = await budget();
    const before = await read('owner', 'GET', '/api/overview');
    check(Array.isArray(before?.exercises), 'baseline-exercises');
    check(before.exercises.every((e: Json) => e.agentEnabled === false), 'paid-controller-active-before-run');
    for (const e of before.exercises) oldRows.set(e.id, { hash: rowHash(e), status: e.status });
    proof.checks.baseline = { exercises: oldRows.size, running: before.exercises.filter((e: Json) => e.status === 'running').length, allPaidControllersOff: true };
    save();

    phase = 'create-one-exercise'; creationAttempted = true; liveDeadline = now() + limits.liveMs;
    const row = await read('owner', 'POST', '/api/exercises', { name, scenarioId: SCENARIO });
    check(typeof row?.id === 'string' && UUID.test(row.id) && !oldRows.has(row.id), 'created-exercise-id');
    exerciseId = row.id; save();
    check(row.name === name && row.status === 'running' && row.kind === 'live' && row.humanSide === 'blue' && row.agentEnabled === false, 'created-exercise-contract');
    check(row.options?.transportAdmission === TRANSPORT_ADMISSION && row.options.simulationProfile === SIMULATION_PROFILE, 'created-transport-admission');
    check(row.options.scenario?.id === SCENARIO && row.options.scenario.controller === 'maneuver/1' && row.options.ownerSubject === ownerSubject, 'created-scenario-or-owner');
    proof.checks.created = { transportAdmission: row.options.transportAdmission, simulationProfile: row.options.simulationProfile, controller: row.options.scenario.controller, map: row.options.map };

    phase = 'commander-enrollment';
    await select('owner');
    const invitation = await read('owner', 'POST', '/api/team/code', {});
    check(typeof invitation?.code === 'string' && /^[a-f0-9]{32}$/i.test(invitation.code), 'join-code-shape');
    try {
      const joined = await read('commander', 'POST', '/api/team/join', { code: invitation.code });
      check(joined?.exerciseId === exerciseId && joined.side === 'blue', 'commander-enrollment');
    } finally { invitation.code = ''; }
    await select('commander');

    phase = 'deployment';
    const deployBy = now() + limits.deployMs;
    let ov = await commanderLive();
    while (ov.state?.spawning !== false) {
      check(now() + limits.pollMs < deployBy, 'deployment-deadline');
      await sleep(limits.pollMs); ov = await commanderLive();
    }
    proof.checks.deployment = { tick: ov.state.tick };

    if (deps.prepareShore) {
      phase = 'prepare-owned-shore';
      await select('commander');
      ov = await commanderLive();
      const own = ov.state?.players?.find((p: Json) => p.side === 'blue');
      check(Number.isFinite(own?.troops) && own.troops > 0, 'preparation-own-forces');
      const expansion = { type: 'attack', targetID: null, troops: Math.max(1, Math.floor(own.troops * 0.35)) };
      const accepted = await send('commander', 'POST', '/api/commands', { side: 'blue', intent: expansion, idempotencyKey: `guarded-voyage-preparation-${runId}` });
      proof.checks.preparation = { tick: ov.state.tick, forcesAtHome: own.troops, intent: expansion, status: accepted.status, commandId: accepted.data?.id ?? null };
      check(accepted.status === 202 && accepted.data?.status === 'queued', 'preparation-order-not-queued');
      save();
    }

    phase = 'legal-candidate';
    const candidateBy = now() + limits.candidateMs, reasons: Array<{ tick: number; reason: string | null }> = [];
    let snapshot: Json = null;
    for (;;) {
      const options = await read('commander', 'GET', `/api/action-options?exerciseId=${encodeURIComponent(exerciseId!)}`);
      check(options?.exerciseId === exerciseId && options.side === 'blue' && Number.isSafeInteger(options.tick), 'action-options-scope');
      const landings: Json[] = options.naval?.status === 'available' ? options.naval.landings ?? [] : [];
      const landing = deps.prepareShore ? [...landings].sort((a,b) => b.distanceFromCoast-a.distanceFromCoast || a.intent.dst-b.intent.dst)[0] : landings[0];
      if (landing) { snapshot = { options, landing }; break; }
      reasons.push({ tick: options.tick, reason: typeof options.naval?.reason === 'string' ? options.naval.reason : null });
      if (now() + limits.pollMs >= candidateBy) break;
      await sleep(limits.pollMs); await commanderLive();
    }
    proof.checks.candidateSearch = { attempts: reasons.length + (snapshot ? 1 : 0), unavailable: reasons.slice(-5) };
    if (!snapshot) { outcome = 'no-legal-candidate'; save(); }
    else {
      const { options, landing } = snapshot;
      intent = landing.intent;
      check(intent?.type === 'boat' && Number.isSafeInteger(intent.dst) && Number.isSafeInteger(intent.troops) && intent.troops > 0, 'candidate-intent-shape');
      proof.checks.candidate = { tick: options.tick, fingerprint: options.fingerprint, intent, target: landing.target, landing: landing.landing, distanceFromCoast: landing.distanceFromCoast, limit: options.naval.limit, sampling: options.naval.sampling };

      phase = 'submit-legal-order';
      await select('commander');
      const idempotencyKey = `guarded-voyage-${runId}`;
      let submitted;
      try { submitted = await send('commander', 'POST', '/api/commands', { side: 'blue', intent, idempotencyKey }); }
      catch (error) { outcome = 'submission-unresolved'; throw error; }
      if (submitted.status === 202) {
        check(typeof submitted.data?.id === 'string' && submitted.data.status === 'queued', 'command-receipt-shape');
        commandId = submitted.data.id;
      } else {
        const message = typeof submitted.data?.error === 'string' ? submitted.data.error.slice(0, 300) : null;
        proof.checks.submissionRefusal = { httpStatus: submitted.status, message };
        outcome = submitted.status === 400 && message === GUARD_REFUSAL ? 'guard-refused-at-submission' : 'refused-other';
        check(outcome === 'guard-refused-at-submission', 'submission-refused-without-guard');
        proof.claims.guardRefusalObserved = true;
      }
      save();

      if (commandId) {
        phase = 'recorded-feedback';
        const observeBy = now() + limits.observeMs;
        outcome = 'not-settled';
        // The overview's order progress lists observed intents only; a tick-time refusal carries no intent and is read from the timeline.
        let rejection: Json = null;
        for (;;) {
          const live = await commanderLive();
          liveRow = orderRow(live, commandId) ?? liveRow;
          rejection = (live.timeline ?? []).find((e: Json) => e.kind === 'command_rejected' && e.details?.commandId === commandId) ?? rejection;
          const statuses = observationsOf(liveRow).map(o => o.status);
          if (rejection || statuses.some(s => TERMINAL.has(s))) break;
          if (now() + limits.pollMs >= observeBy) break;
          await sleep(limits.pollMs);
        }
        if (rejection) {
          const reason = typeof rejection.details?.reason === 'string' ? rejection.details.reason.slice(0, 300) : null;
          outcome = reason === GUARD_REFUSAL ? 'guard-refused-at-tick' : 'refused-other';
          proof.checks.tickRefusal = { tick: rejection.tick, reason };
          liveRow = null;
        } else if (liveRow) {
          const statuses = observationsOf(liveRow).map(o => o.status);
          check(liveRow.admission === 'accepted', 'order-admission-unknown');
          outcome = statuses.includes('transport-launched') ? 'launched' : statuses.some(s => TERMINAL.has(s)) ? 'not-launched' : 'not-settled';
        }
        proof.checks.liveFeedback = liveRow && { tick: liveRow.tick, admission: liveRow.admission, status: liveRow.status, inputKey: liveRow.inputKey, observations: observationsOf(liveRow) };
        save();
      }
    }

    phase = 'finish-created-exercise'; liveDeadline = null;
    await select('owner');
    const ended = await read('owner', 'POST', `/api/exercises/${encodeURIComponent(exerciseId!)}/finish`, {});
    check(ended?.id === exerciseId && ended.status === 'completed' && ended.agentEnabled === false, 'finish-not-confirmed');
    cleanupFinished = true; save();

    phase = 'final-recorded-feedback';
    let finalRow: Json = null;
    if (commandId) {
      await select('commander');
      const done = await read('commander', 'GET', '/api/overview');
      check(done?.activeId === exerciseId && (done.exercises ?? []).some((e: Json) => e.id === exerciseId && e.status === 'completed'), 'final-feedback-scope');
      finalRow = orderRow(done, commandId) ?? null;
    }

    phase = 'record-reconstruction';
    const record = await read('owner', 'GET', `/api/record/${encodeURIComponent(exerciseId!)}`) as EngineRecord;
    check(record?.options?.transportAdmission === TRANSPORT_ADMISSION && record.simulationProfile === SIMULATION_PROFILE && Array.isArray(record.turns), 'record-transport-admission');
    if (deps.prepareShore) {
      const prep = proof.checks.preparation?.intent;
      proof.checks.preparation.recorded = !!prep && record.turns.some(t => t.intents.some((i: Json) => i.clientID === CLIENTS.blue && i.type === 'attack' && i.targetID === null && i.troops === prep.troops));
      check(proof.checks.preparation.recorded, 'preparation-order-not-recorded');
    }
    const row2 = finalRow ?? liveRow;
    const accepted = row2?.admission === 'accepted';
    const key: InputKey | null = accepted ? row2.inputKey : null;
    if (accepted) {
      check(key && Number.isSafeInteger(key.turnNumber) && Number.isSafeInteger(key.intentIndex) && key.clientID === CLIENTS.blue, 'recorded-input-key');
      const turn = record.turns.find(t => t.turnNumber === key.turnNumber);
      const stamped: Json = turn?.intents[key.intentIndex];
      check(stamped && stamped.clientID === CLIENTS.blue && stamped.type === 'boat' && stamped.dst === intent.dst && stamped.troops === intent.troops, 'recorded-order-not-in-turn');
    } else if (outcome !== 'not-settled') {
      // A refused order never enters the canonical record.
      check(!record.turns.some(t => t.intents.some((i: Json) => i.clientID === CLIENTS.blue && i.type === 'boat' && intent && i.dst === intent.dst)), 'refused-order-in-record');
    }
    const rebuilt = await reconstruct(record, key, limits.reconstructionTurns);
    const recorded = observationsOf(row2);
    const matched = compareObservations(recorded, rebuilt.observations, !!finalRow);
    proof.checks.reconstruction = { ...rebuilt, recordedObservations: recorded, completeRecordedRead: !!finalRow, observationsMatched: matched };
    check(matched, 'recorded-feedback-differs-from-reconstruction');
    const rebuiltStatuses = rebuilt.observations.map(o => o.status);
    if (accepted) {
      proof.claims.launchObserved = rebuiltStatuses.includes('transport-launched') && recorded.some(o => o.status === 'transport-launched');
      proof.claims.landingObserved = recorded.some(o => o.status === 'transport-landed');
      proof.claims.forcesReturnedObserved = recorded.some(o => o.status === 'transport-forces-returned');
      if (outcome === 'launched') check(proof.claims.launchObserved, 'launch-not-reconstructed');
    }
    if (outcome === 'guard-refused-at-tick') proof.claims.guardRefusalObserved = true;
    check(['launched', 'guard-refused-at-submission', 'guard-refused-at-tick', 'no-legal-candidate'].includes(outcome), `outcome-${outcome}`);

    phase = 'older-exercises-preserved';
    const after = await read('owner', 'GET', '/api/overview');
    check(Array.isArray(after?.exercises), 'final-exercises');
    const afterIds = new Set(after.exercises.map((e: Json) => e.id));
    check([...oldRows.keys()].every(id => afterIds.has(id)), 'older-exercise-missing');
    check(after.exercises.every((e: Json) => e.id === exerciseId || oldRows.has(e.id)), 'unexpected-new-exercise');
    const changed = after.exercises.filter((e: Json) => { const old = oldRows.get(e.id); return old && old.status !== 'running' && old.hash !== rowHash(e); }).map((e: Json) => e.id);
    check(changed.length === 0, 'older-exercise-row-changed');
    check(after.exercises.every((e: Json) => e.agentEnabled === false), 'paid-controller-active-after-run');
    proof.checks.preserved = { olderExercises: oldRows.size, unchangedCompleted: [...oldRows.values()].filter(r => r.status !== 'running').length, allPaidControllersOff: true };
  } catch (error) { failure(error); }
  finally {
    liveDeadline = null;
    if (clients.owner && creationAttempted && !exerciseId) {
      phase = 'recover-created-id';
      // Never re-POST creation; adopt only the one row with this run's unique name and owner.
      try {
        const ov = await read('owner', 'GET', '/api/overview', undefined, true);
        const matches = (ov?.exercises ?? []).filter((e: Json) => e.name === name && e.options?.ownerSubject === ownerSubject);
        check(matches.length <= 1, 'ambiguous-created-run');
        if (matches.length === 1 && UUID.test(matches[0].id)) exerciseId = matches[0].id;
        else failures.push({ phase, code: 'creation-outcome-unresolved-no-retry' });
      } catch (error) { failure(error); }
    }
    if (clients.owner && exerciseId && !cleanupFinished) {
      phase = 'cleanup-finish-created-exercise';
      for (let attempt = 0; attempt < 2 && !cleanupFinished; attempt++) {
        try {
          await select('owner', true);
          const ended = await read('owner', 'POST', `/api/exercises/${encodeURIComponent(exerciseId)}/finish`, {}, true);
          check(ended?.id === exerciseId && ended.status === 'completed' && ended.agentEnabled === false, 'finish-not-confirmed');
          cleanupFinished = true;
        } catch (error) {
          failure(error);
          try { cleanupFinished = (await read('owner', 'GET', '/api/overview', undefined, true))?.exercises?.some((e: Json) => e.id === exerciseId && e.status === 'completed' && e.agentEnabled === false) === true; }
          catch (readError) { failure(readError); }
        }
      }
      if (!cleanupFinished) failures.push({ phase, code: 'created-exercise-not-confirmed-ended' });
    }
    if (clients.owner && budgetBefore) {
      phase = 'budget-after';
      try {
        budgetAfter = await budget(true);
        check(budgetAfter.requestsUsed === budgetBefore.requestsUsed && budgetAfter.committedUsd === budgetBefore.committedUsd, 'budget-delta-nonzero');
      } catch (error) { failure(error); }
    }
    phase = 'logout';
    for (const seat of ['commander', 'owner'] as const) { const c = clients[seat]; if (c) try { await c.close(); } catch (error) { failure(error); } }
    phase = 'complete';
    const clean = failures.length === 0 && (!creationAttempted || cleanupFinished) && budgetAfter !== null;
    proof.status = !clean ? 'failed' : outcome === 'no-legal-candidate' ? 'no-legal-candidate' : 'passed';
    proof.finishedAt = new Date().toISOString();
    try { save(); } catch { proof.receiptWriteFailed = true; }
  }
  return { artifact, proof };
}

async function main() {
  check(process.argv.length === 3 || process.argv.length === 4 && process.argv[3] === '--prepare-shore', 'usage-requires-release-version-and-optional-prepare-shore');
  const { nativeAppClient } = await import('./native-app-client');
  const interrupted = new AbortController();
  const onInterrupt = () => interrupted.abort();
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  const realFetch = globalThis.fetch;
  // The normal login helper takes no signal; bound its login/logout as well. Redirects are never followed.
  globalThis.fetch = (input, init) => realFetch(input, { ...init, redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(DEFAULT_LIMITS.httpMs), ...(init?.signal ? [init.signal] : [])]) });
  try {
    const { artifact, proof } = await runGuardedVoyage(process.argv[2], {
      signal: interrupted.signal,
      prepareShore: process.argv[3] === '--prepare-shore',
      login: async seat => {
        if (seat === 'owner') return nativeAppClient();
        const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
        const matches = Array.isArray(users) ? users.filter((u: Json) => u?.role === 'commander') : [];
        const credential = matches.length === 1 && matches[0].username && matches[0].password ? { username: String(matches[0].username), password: String(matches[0].password) } : null;
        if (Array.isArray(users)) for (const u of users) if (u && typeof u === 'object') u.password = '';
        check(credential, 'commander-credentials');
        try { return await nativeAppClient(credential); } finally { credential.password = ''; }
      },
      writeReceipt: (file, text, create) => {
        if (create) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); }
        else fs.writeFileSync(file, text);
      },
    });
    console.log(JSON.stringify({ artifact, status: proof.status, outcome: proof.outcome, exerciseId: proof.exerciseId, claims: proof.claims,
      cleanup: proof.cleanup, newPaidRequests: proof.newPaidRequests, failures: proof.failures }));
    if (proof.status !== 'passed') process.exitCode = 1;
  } finally {
    globalThis.fetch = realFetch;
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error instanceof CheckFailure ? error.message : 'startup-failed' }));
    process.exitCode = 1;
  }
}
