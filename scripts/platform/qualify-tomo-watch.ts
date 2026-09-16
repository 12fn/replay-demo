/** Main-dispatched only: VERSION ATTEMPT_LABEL. One Tomo conversational create_watch; --self-test is offline.
 * Contract: docs/process/tomo-watch-conversation-contract.md. No direct MCP fallback and no retries.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {nativeAppClient} from './native-app-client';
import {attemptArguments, inputAccepted, roomCreated, RoomFrameDecoder, RoomObservation, withDeadline,
  type RoomFrame, type TerminalOutcome} from './tomo-qualification-contract';

const WATCH = 'kz_replay-tools_replay_create_watch';
const TITLE = 'Monitor report provenance', SCENARIO = 'crosscurrent-evidence/1', PACKET = 'crosscurrent-changing-evidence/1';
const PREFIX = '/runtime/apps/replay-tomo/api/conversations';
const HELPER_RECEIPT = 'evidence/platform/tomo-staff-watch-agent-1.json';
const OBSERVER_RECEIPT = 'evidence/platform/tomo-observer-agent-1.json';
const ACTIVE_MS = 180000, ACTIVE_REQUESTS = 60, CLEANUP_REQUESTS = 10, CLEANUP_STEP_MS = 15000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, any>;
export interface WatchArgs {exerciseId: string; requestId: string; title: string}
class Failure extends Error {}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
const errorCode = (e: unknown) => e instanceof Failure ? e.message : 'operation-or-contract-failed';
const equal = (a: unknown, b: unknown, code: string) => { try { assert.deepEqual(a, b); } catch { throw new Failure(code); } };
const parseJson = (text: string, code: string): any => { try { return JSON.parse(text); } catch { throw new Failure(code); } };
const budgetProjection = (v: Json) => ({requestsUsed: v?.requestsUsed, maxRequests: v?.maxRequests, committedUsd: v?.committedUsd, maxUsd: v?.maxUsd});
const capsUnchanged = (b: Json) => b?.maxRequests === 100 && b?.maxUsd === 5 && Number.isInteger(b.requestsUsed)
  && b.requestsUsed >= 0 && b.requestsUsed <= 100 && Number.isFinite(b.committedUsd) && b.committedUsd >= 0 && b.committedUsd <= 5;

/** Independent recomputation of mcp-watch-service.ts receipt identity and payload fingerprint. */
export function receiptEventId(exerciseId: string, subject: string, requestId: string) {
  const h = sha(JSON.stringify(['replay.mcp-watch-receipt/1', exerciseId, subject, requestId]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const watchFingerprint = (exerciseId: string, title: string) => sha(JSON.stringify(['replay.mcp-watch/1', exerciseId, title]));

export const answerFacts = (c: Json) => ({exerciseId: c.provenance.exerciseId, requestId: c.receipt.requestId, taskId: c.task.id,
  modelEnabled: c.task.modelEnabled, side: c.task.side, title: c.task.title, createdTick: c.task.createdTick,
  receiptEventId: c.receipt.eventId, replayed: c.receipt.replayed, paidInference: c.provenance.paidInference});

export const watchMessage = (args: WatchArgs) => `Call ${WATCH} exactly once with this JSON argument object: ${JSON.stringify(args)}. This is a fictional REPLAY exercise; use no other tools and do not retry. If the tool fails, say so and do not invent a result. Otherwise return only a JSON object (no prose, no other keys) copied exactly from the tool's structured result: exerciseId=provenance.exerciseId, requestId=receipt.requestId, taskId=task.id, modelEnabled=task.modelEnabled, side=task.side, title=task.title, createdTick=task.createdTick, receiptEventId=receipt.eventId, replayed=receipt.replayed, paidInference=provenance.paidInference. Keep booleans and numbers as JSON booleans and numbers.`;

/** Exactly one successful create_watch in the matched run, full (untruncated) result, then a fact-exact answer. */
export function verifyWatchEvidence(frames: RoomFrame[], result: TerminalOutcome, args: WatchArgs) {
  check(result.status === 'completed' && result.assistant, 'matching-completed-answer-required');
  const inputTools = frames.filter(f => f.envelope.event === 'tool' && f.envelope.data.input_id === result.inputId);
  check(inputTools.every(f => f.envelope.data.run_id === result.runId), 'tool-frame-other-run');
  // Identical live/replayed tool frames may repeat. Conflicting duplicates are never discarded.
  const unique = (status: string) => {
    const byId = new Map<string, RoomFrame>();
    for (const f of inputTools.filter(t => t.envelope.data.status === status)) {
      const id = f.envelope.data.call_id; check(typeof id === 'string' && id.length > 0, 'missing-tool-call-id');
      const previous = byId.get(id);
      if (previous) equal(previous.envelope.data, f.envelope.data, 'conflicting-tool-frame'); else byId.set(id, f);
    }
    return [...byId.values()];
  };
  const starts = unique('start'), ends = unique('end');
  check(starts.length === 1 && ends.length === 1, 'exactly-one-matched-tool-required');
  const start = starts[0].envelope.data, end = ends[0].envelope.data;
  check(start.name === WATCH && end.name === WATCH && start.call_id === end.call_id && end.outcome === 'ok', 'create-watch-tool-not-successful');
  check(typeof start.args_full === 'string' && typeof end.result_full === 'string', 'full-tool-evidence-required');
  equal(parseJson(start.args_full, 'tool-arguments-invalid-json'), args, 'tool-arguments-mismatch');
  // A truncated display is never repaired into evidence.
  check(!end.result_full.endsWith('… (truncated)'), 'tool-result-display-truncated');
  const payload = parseJson(end.result_full, 'tool-result-invalid-json').details?.payload;
  check(payload?.isError === false && payload.structuredContent, 'mcp-watch-payload-required');
  const c = payload.structuredContent;
  check(UUID.test(c.task?.id) && c.task.kind === 'provenance-watch' && c.task.modelEnabled === false && c.task.title === TITLE
    && typeof c.task.side === 'string' && Number.isSafeInteger(c.task.createdTick), 'returned-task-contract');
  check(c.receipt?.requestId === args.requestId && c.receipt.replayed === false && UUID.test(c.receipt.eventId)
    && c.receipt.fingerprint === watchFingerprint(args.exerciseId, args.title), 'returned-receipt-contract');
  check(c.provenance?.exerciseId === args.exerciseId && c.provenance.paidInference === 'off-at-creation'
    && typeof c.provenance.taskCreatedEventId === 'string', 'returned-provenance-contract');
  const at = (f: RoomFrame) => frames.indexOf(f);
  const answerFrame = frames.find(f => f.envelope.event === 'assistant_message' && f.envelope.position === result.assistant!.position
    && f.envelope.input_id === result.inputId && f.envelope.run_id === result.runId);
  check(answerFrame && at(starts[0]) < at(ends[0]) && at(ends[0]) < at(answerFrame), 'tool-answer-order');
  const text = result.assistant.text.trim();
  const answer = parseJson(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'), 'answer-invalid-json');
  equal(answer, answerFacts(c), 'answer-tool-facts');
  return {created: c, callId: start.call_id as string, answerSha256: sha(text), answerDurablePosition: result.assistant.position};
}

/** Persisted read from the Commander's own overview: one task, its UUID-linked receipt, and free-only analysis. */
export function verifyPersisted(overview: Json, created: Json, args: WatchArgs, subject: string) {
  check(overview.activeId === args.exerciseId, 'overview-exercise-mismatch');
  check(Array.isArray(overview.tasks) && overview.tasks.length === 1, 'unrelated-or-missing-task');
  const task = overview.tasks[0];
  check(task.id === created.task.id && task.owner === subject, 'persisted-task-identity');
  check(task.modelEnabled === false, 'paid-analysis-enabled');
  equal({title: task.title, side: task.side, createdTick: task.createdTick},
    {title: created.task.title, side: created.task.side, createdTick: created.task.createdTick}, 'persisted-task-facts');
  const timeline: Json[] = Array.isArray(overview.timeline) ? overview.timeline : [];
  const receipts = timeline.filter(e => e.kind === 'mcp_watch_request');
  check(receipts.length === 1, 'persisted-receipt-not-visible-or-duplicated');
  const r = receipts[0];
  check(r.id === receiptEventId(args.exerciseId, subject, args.requestId) && r.id === created.receipt.eventId, 'receipt-not-uuid-linked');
  equal({actor: r.actor, tick: r.tick, details: r.details}, {actor: subject, tick: created.task.createdTick,
    details: {requestId: args.requestId, fingerprint: created.receipt.fingerprint, taskId: task.id,
      taskCreatedEventId: created.provenance.taskCreatedEventId}}, 'persisted-receipt-facts');
  check(timeline.some(e => e.kind === 'task_created' && e.id === created.provenance.taskCreatedEventId && e.details?.taskId === task.id), 'persisted-task-created-event');
  return {task, receipt: r};
}

/** The tick-300 released-report alert for exactly this task, or undefined while it is not yet visible. */
export function tick300Alert(overview: Json, taskId: string, exerciseId: string, side: string) {
  const updates = (overview.timeline ?? []).filter((e: Json) => e.kind === 'staff_update' && e.details?.taskId === taskId);
  check(updates.every((e: Json) => e.details.method === 'deterministic provenance watcher'), 'paid-analysis-update-present');
  const alert = updates.find((e: Json) => e.tick === 300);
  if (!alert) return undefined;
  equal({side: alert.side, observedTick: alert.details.observedTick, sourceIds: [...(alert.details.sourceIds ?? [])].sort()},
    {side, observedTick: 300, sourceIds: [`${exerciseId}:${PACKET}:blue-r02`, `${exerciseId}:${PACKET}:blue-r03`]}, 'tick300-alert-sources');
  return alert;
}

async function qualify(argv: string[]) {
  const {version, attempt: label} = attemptArguments(argv);
  check(argv.length === 2, 'usage-version-attempt-label');
  const attempt = `${label}-${randomUUID()}`;
  const artifact = `evidence/platform/tomo-watch-${attempt}.json`;
  const eventsPath = `data/platform/tomo-watch-${attempt}-events.jsonl`;
  const detailPath = `data/platform/tomo-watch-${attempt}-detail.json`;
  const observedPath = `data/platform/tomo-watch-${attempt}-observed.json`;
  const files = [artifact, eventsPath, detailPath, observedPath];
  for (const file of files) { fs.mkdirSync(path.dirname(file), {recursive: true}); check(!fs.existsSync(file), 'attempt-file-exists'); }
  const fds = new Map<string, number>();
  try { for (const file of files) fds.set(file, fs.openSync(file, 'wx', 0o600)); }
  catch (e) { for (const fd of fds.values()) fs.closeSync(fd); throw e; }
  const write = (file: string, data: unknown) => { const fd = fds.get(file)!; fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n', 0, 'utf8'); };
  const args: WatchArgs = {exerciseId: '', requestId: randomUUID(), title: TITLE};
  const exerciseName = `Fictional automated Tomo watch qualification ${version} ${attempt.slice(-8)}`;
  const proof: Json = {startedAt: new Date().toISOString(), version, attempt, scenarioId: SCENARIO, exerciseName,
    fictional: true, automatedOperation: true, pairedPlayerTrial: false, humanValidated: false, status: 'starting',
    transport: 'REPLAY Tomo conversation entry with configured staff helper; no direct MCP fallback',
    requestId: args.requestId, title: TITLE, creationKey: randomUUID(), inputKey: randomUUID(),
    privateEvents: eventsPath, privateDetail: detailPath, privateObserved: observedPath,
    limits: {activeDeadlineMs: ACTIVE_MS, activeRequestCap: ACTIVE_REQUESTS, cleanupRequestCap: CLEANUP_REQUESTS, rooms: 1, inputPosts: 1,
      exerciseCreates: 1, minimumRequestsLeft: 3, applicationRequestCap: 100, applicationUsdCap: 5},
    limitations: ['One model input may use multiple provider requests; the application budget is authoritative.',
      'Exact tool/receipt/answer fact checks do not validate learning efficacy or free-text interpretation.',
      'Tasks are read from the Commander overview (own side); opposing-side tasks are outside this view.',
      'The tick-300 alert requires the watch to be created before tick 300 of the new exercise.']};
  const save = () => write(artifact, proof);
  const observed: Json = {};
  let phase = 'preflight', owner: Awaited<ReturnType<typeof nativeAppClient>> | undefined, commander: typeof owner;
  let cleanup = false, requests = 0, cleanupRequests = 0, roomPosts = 0, inputPosts = 0, exercisePosts = 0, finishPosts = 0;
  let observation: RoomObservation | undefined, streamTask: Promise<void> | undefined, taskId = '';
  const frames: RoomFrame[] = [], active = new AbortController(), streamStop = new AbortController();
  const activeEnd = Date.now() + ACTIVE_MS, activeTimer = setTimeout(() => active.abort(), ACTIVE_MS);
  const nativeFetch = globalThis.fetch;
  // Both ordinary clients share this guard: native origin only, exact routes, one-shot mutations, active/cleanup caps.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET', p = url.pathname;
    check(url.origin === 'http://127.0.0.1:5183', 'native-origin-only');
    if (cleanup) check(++cleanupRequests <= CLEANUP_REQUESTS, 'cleanup-request-cap'); else check(++requests <= ACTIVE_REQUESTS, 'request-cap');
    const room = proof.conversationId ? `${PREFIX}/${proof.conversationId}` : null, ex = args.exerciseId ? `/api/exercises/${args.exerciseId}` : null;
    const gets = ['/replay-build.json', '/api/native/status', '/api/agents/tools', '/api/tomo/status', '/api/overview', room, room && `${room}/events`, taskId && `/api/agents/tasks/${taskId}`];
    const posts = ['/api/native/login', '/api/native/logout', '/api/exercises', '/api/team/code', '/api/team/join', '/api/select', PREFIX, room && `${room}/inputs`, ex && `${ex}/finish`];
    check(method === 'GET' ? gets.includes(p) && (p !== room || cleanup) : method === 'POST' && posts.includes(p), 'request-route-not-permitted');
    if (method === 'POST') {
      if (p === PREFIX) check(++roomPosts === 1, 'room-retry-forbidden');
      if (p.endsWith('/inputs')) check(++inputPosts === 1, 'input-retry-forbidden');
      if (p === '/api/exercises') check(++exercisePosts === 1, 'exercise-retry-forbidden');
      if (p.endsWith('/finish')) check(cleanup && ++finishPosts === 1, 'finish-once-in-cleanup');
    }
    const isStream = p.endsWith('/events');
    const signals = [AbortSignal.timeout(isStream ? ACTIVE_MS : p.endsWith('/inputs') || p === PREFIX || p === '/api/exercises' ? 30000 : 15000)];
    if (!cleanup) signals.push(active.signal);
    if (init?.signal) signals.push(init.signal);
    return nativeFetch(input, {...init, redirect: 'error', signal: AbortSignal.any(signals)});
  };
  const read = async (who: typeof owner, target: string, body?: unknown) => withDeadline(async signal =>
    (await who!.request(target, body, {signal})).json() as Promise<Json>, 15000, 'read-deadline');
  try {
    save();
    const config = JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json', 'utf8'));
    const helperId = JSON.parse(fs.readFileSync(HELPER_RECEIPT, 'utf8')).agent?.id;
    const observerId = JSON.parse(fs.readFileSync(OBSERVER_RECEIPT, 'utf8')).agent?.id;
    check(UUID.test(helperId) && config.agentId === helperId && helperId !== observerId, 'staff-helper-config-required');
    check(typeof config.deploymentId === 'string' && config.deploymentId.length > 0, 'model-deployment-config');
    proof.agentId = config.agentId; proof.modelDeploymentId = config.deploymentId;
    const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
    const matches = Array.isArray(users) ? users.filter((u: Json) => u.role === 'commander') : [];
    const credential = matches.length === 1 && matches[0].username && matches[0].password ? {username: matches[0].username, password: matches[0].password} : null;
    if (Array.isArray(users)) for (const u of users) u.password = '';
    check(credential, 'commander-credentials');

    phase = 'owner-login'; owner = await nativeAppClient();
    const build = await read(owner, '/replay-build.json');
    equal(build.version, version, 'deployed-version'); proof.build = build;
    const ownerStatus = await read(owner, '/api/native/status');
    check(ownerStatus.mode === 'kamiwaza' && ownerStatus.signedIn && typeof ownerStatus.identity?.subject === 'string', 'native-owner-required');
    proof.budgetBefore = budgetProjection((await read(owner, '/api/agents/tools')).budget);
    check(capsUnchanged(proof.budgetBefore) && proof.budgetBefore.requestsUsed <= 97 && proof.budgetBefore.committedUsd < 5, 'insufficient-or-unexpected-budget');

    phase = 'commander-login';
    try { commander = await nativeAppClient(credential); } finally { credential.password = ''; }
    const status = await read(commander, '/api/native/status');
    check(status.mode === 'kamiwaza' && status.signedIn && status.identity?.role === 'commander' && typeof status.identity.subject === 'string'
      && status.identity.subject !== ownerStatus.identity.subject, 'native-commander-required');
    const subject: string = status.identity.subject; proof.subjectSha256 = sha(subject); proof.ownerSubjectSha256 = sha(ownerStatus.identity.subject);
    equal((await read(commander, '/api/tomo/status')).mode, 'scoped-conversation', 'conversation-route-unavailable');

    phase = 'room-create'; proof.status = 'room-create-pending'; save();
    const roomId = await withDeadline(async signal => {
      const response = await commander!.requestRaw(PREFIX, {}, {idempotencyKey: proof.creationKey, signal});
      proof.creationHttpStatus = response.status;
      return roomCreated(response.status, await response.json());
    }, 30000, 'room-creation-uncertain');
    proof.conversationId = roomId; proof.status = 'room-created'; save();

    phase = 'observe-stream';
    const response = await withDeadline(signal => commander!.request(`${PREFIX}/${roomId}/events?after=0`, undefined,
      {signal: AbortSignal.any([signal, streamStop.signal])}), 15000, 'event-headers-deadline');
    check(response.status === 200 && /^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') && response.body, 'event-stream-required');
    const body = response.body;
    observation = new RoomObservation(roomId); const roomObs = observation;
    let acceptanceBound = false, streamEnded = false, streamFailure: unknown;
    let resolveTerminal!: (r: TerminalOutcome) => void, rejectTerminal!: (e: unknown) => void;
    const terminal = new Promise<TerminalOutcome>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
    void terminal.catch(() => {});
    const observe = () => {
      if (!acceptanceBound) return;
      try {
        const outcome = roomObs.outcome();
        if (outcome) resolveTerminal(outcome);
        else if (streamFailure || streamEnded) rejectTerminal(new Failure('stream-ended-before-matched-terminal'));
      } catch (e) { rejectTerminal(e); }
    };
    streamTask = (async () => {
      const reader = body.getReader(), decoder = new RoomFrameDecoder(); let bytes = 0;
      try {
        while (!streamStop.signal.aborted) {
          const {done, value} = await reader.read(); if (done) break;
          bytes += value.byteLength; check(bytes <= 8_000_000, 'stream-byte-cap');
          for (const frame of decoder.push(value)) {
            fs.writeSync(fds.get(eventsPath)!, JSON.stringify({...frame.envelope, _sse: {event: frame.sseEvent, id: frame.sseId}}) + '\n');
            frames.push(frame); roomObs.add(frame); observe();
          }
        }
      } catch (e) { streamFailure = e; }
      finally { streamEnded = true; observe(); try { await reader.cancel(); } catch {} reader.releaseLock(); }
    })();

    // Created last so the watch can exist before tick 300 of the new exercise.
    phase = 'exercise-create'; proof.exerciseCreation = 'pending'; save();
    const exercise = await read(owner, '/api/exercises', {name: exerciseName, scenarioId: SCENARIO});
    check(UUID.test(exercise.id) && exercise.name === exerciseName && exercise.status === 'running', 'exercise-create-contract');
    args.exerciseId = exercise.id; proof.exerciseId = exercise.id; proof.exerciseCreation = 'created'; proof.humanSide = exercise.humanSide; save();
    phase = 'commander-join';
    const invitation = await read(owner, '/api/team/code', {});
    try { equal((await read(commander, '/api/team/join', {code: invitation.code})).exerciseId, args.exerciseId, 'join-exercise-mismatch'); }
    finally { invitation.code = ''; }
    check(!streamFailure && !streamEnded, 'stream-failed-before-input');

    phase = 'single-input'; proof.status = 'input-response-pending'; proof.acceptanceState = 'uncertain';
    const message = watchMessage(args); proof.messageSha256 = sha(message); proof.inputDispatchedAt = new Date().toISOString(); save();
    const accepted = await withDeadline(async signal => {
      const r = await commander!.requestRaw(`${PREFIX}/${roomId}/inputs`, {kind: 'message', message, model: config.deploymentId,
        agent: config.agentId, platform_tool_names: [WATCH], connector_ids: [], subagent_ids: [], resource_reference_ids: [], effort: 'low'},
      {idempotencyKey: proof.inputKey, signal});
      proof.inputHttpStatus = r.status; save();
      const data = await r.json();
      if (typeof data?.input_id === 'string') proof.inputId = data.input_id;
      signal.throwIfAborted(); return inputAccepted(r.status, data);
    }, 30000, 'input-acceptance-uncertain');
    proof.acceptance = accepted; proof.inputId = accepted.input_id; proof.acceptanceState = 'accepted';
    proof.status = 'input-accepted'; save(); roomObs.accept(accepted); acceptanceBound = true; observe();

    phase = 'matched-terminal';
    const result = await withDeadline(() => terminal, Math.max(1, activeEnd - Date.now()), 'terminal-observation-deadline');
    const {assistant, reason, ...terminalProof} = result;
    proof.terminal = terminalProof; proof.terminalReasonPresent = typeof reason === 'string'; save();

    phase = 'verify-tool-and-answer';
    const evidence = verifyWatchEvidence(frames, result, args);
    taskId = evidence.created.task.id; observed.created = evidence.created; write(observedPath, observed);
    proof.tool = {name: WATCH, callId: evidence.callId, outcome: 'ok', inputId: result.inputId, runId: result.runId};
    proof.created = {taskId, createdTick: evidence.created.task.createdTick, receiptEventId: evidence.created.receipt.eventId,
      taskCreatedEventId: evidence.created.provenance.taskCreatedEventId, modelEnabled: false, replayed: false};
    proof.answerSha256 = evidence.answerSha256; proof.answerDurablePosition = evidence.answerDurablePosition;
    proof.answerToolFactsMatched = true; proof.status = 'watch-created-verifying-persistence'; save();

    // Read immediately: the receipt kind is only in the overview's recent-event window.
    phase = 'persisted-task-and-receipt';
    let overview = await read(commander, '/api/overview');
    const persisted = verifyPersisted(overview, evidence.created, args, subject);
    observed.task = persisted.task; observed.receipt = persisted.receipt; write(observedPath, observed);
    proof.persisted = {taskId, receiptEventId: persisted.receipt.id, receiptUuidLinked: true, taskOwnerIsCommander: true,
      paidAnalysisOff: true, unrelatedTasks: 0, independentReceiptMatchesToolAndAnswer: true}; save();
    check(evidence.created.task.createdTick < 300, 'watch-created-at-or-after-tick300');

    phase = 'tick300-alert';
    let alert: Json | undefined, polls = 1;
    while (!(alert = tick300Alert(overview, taskId, args.exerciseId, evidence.created.task.side))) {
      check(Number(overview.state?.tick) < 400, 'tick300-alert-missing');
      check(activeEnd - Date.now() > 4000, 'tick300-alert-deadline');
      await delay(3000, undefined, {signal: active.signal});
      overview = await read(commander, '/api/overview'); polls++;
      check(overview.activeId === args.exerciseId && overview.tasks?.length === 1 && overview.tasks[0].id === taskId
        && overview.tasks[0].modelEnabled === false, 'unrelated-task-or-paid-analysis');
    }
    const trace = await read(commander, `/api/agents/tasks/${taskId}`);
    check(trace.task?.id === taskId && trace.task.modelEnabled === false && Array.isArray(trace.trace), 'task-trace-contract');
    check(trace.trace.every((e: Json) => e.kind === 'task_created' || e.kind === 'staff_update' && e.method === 'deterministic provenance watcher'), 'paid-analysis-trace-present');
    observed.alert = alert; observed.trace = trace; write(observedPath, observed);
    proof.alert = {id: alert.id, tick: alert.tick, observedTick: alert.details.observedTick, sourceIds: alert.details.sourceIds,
      method: alert.details.method, polls, traceKinds: [...new Set(trace.trace.map((e: Json) => e.kind))].sort()};
    proof.status = 'qualified-facts-main-review-pending';
  } catch (e) {
    proof.failure = {phase, code: errorCode(e)};
    proof.status = proof.acceptanceState === 'uncertain' ? 'input-acceptance-uncertain'
      : proof.status === 'room-create-pending' ? 'room-creation-uncertain'
      : proof.exerciseCreation === 'pending' ? 'exercise-creation-uncertain' : 'qualification-incomplete';
    if (proof.exerciseCreation === 'pending') proof.exerciseCreation = 'uncertain';
    process.exitCode = 1;
  } finally {
    cleanup = true; clearTimeout(activeTimer); streamStop.abort(); active.abort();
    const step = async (name: string, run: () => Promise<unknown>) => {
      try { await withDeadline(() => run(), CLEANUP_STEP_MS, `${name}-deadline`); return true; }
      catch (e) { (proof.cleanupFailures ??= []).push({step: name, code: errorCode(e)}); process.exitCode = 1; return false; }
    };
    proof.streamClosed = await step('stream-close', () => streamTask ?? Promise.resolve());
    if (commander && proof.conversationId) proof.detailRetained = await step('detail', async () => write(detailPath, await read(commander, `${PREFIX}/${proof.conversationId}`)));
    if (owner) {
      // End only this attempt's exercise; an uncertain creation is reconciled by its unique name, never recreated.
      if (!args.exerciseId && proof.exerciseCreation === 'uncertain') await step('reconcile-exercise', async () => {
        const rows = ((await read(owner, '/api/overview')).exercises ?? []).filter((e: Json) => e.name === exerciseName);
        proof.exerciseCreationReconciled = rows.length === 1 ? 'found' : rows.length === 0 ? 'not-visible' : 'ambiguous';
        if (rows.length === 1) { args.exerciseId = rows[0].id; proof.exerciseId = rows[0].id; equal((await read(owner, '/api/select', {exerciseId: args.exerciseId})).selected, args.exerciseId, 'reconcile-select'); }
      });
      if (args.exerciseId) proof.ended = await step('end-exercise', async () => equal((await read(owner, `/api/exercises/${args.exerciseId}/finish`, {})).status, 'completed', 'finish-contract'));
      if (proof.budgetBefore) await step('budget-after', async () => {
        proof.budgetAfter = budgetProjection((await read(owner, '/api/agents/tools')).budget);
        proof.newRequests = proof.budgetAfter.requestsUsed - proof.budgetBefore.requestsUsed;
        check(capsUnchanged(proof.budgetAfter) && proof.newRequests >= 0 && proof.budgetAfter.committedUsd >= proof.budgetBefore.committedUsd, 'budget-after-contract');
      });
    }
    proof.commanderClosed = commander ? await step('commander-logout', () => commander!.close()) : 'not-opened';
    proof.ownerClosed = owner ? await step('owner-logout', () => owner!.close()) : 'not-opened';
    globalThis.fetch = nativeFetch;
    Object.assign(proof, {requests, cleanupRequests, roomPosts, inputPosts, exercisePosts, finishPosts,
      eventTypes: observation?.eventTypes ?? [], lastDurablePosition: observation?.lastPosition ?? 0, finishedAt: new Date().toISOString()});
    proof.exitCode = process.exitCode === 1 ? 1 : 0;
    if (proof.exitCode === 1 && proof.status === 'qualified-facts-main-review-pending') proof.status = 'facts-matched-cleanup-or-evidence-incomplete';
    try { save(); } finally { for (const fd of fds.values()) fs.closeSync(fd); }
    // No answer, tool output, identity, credential or terminal reason in the public log.
    console.log(JSON.stringify({artifact, status: proof.status, failure: proof.failure, exerciseId: proof.exerciseId, ended: proof.ended,
      inputPosts, newRequests: proof.newRequests, cleanupFailures: proof.cleanupFailures, exitCode: proof.exitCode}));
  }
}

function selfTest() {
  const subject = 'commander-subject', exerciseId = '11111111-2222-4333-8444-555555555555';
  const args: WatchArgs = {exerciseId, requestId: '66666666-7777-4888-9999-000000000000', title: TITLE};
  const eventId = receiptEventId(exerciseId, subject, args.requestId);
  assert.match(eventId, UUID); assert.equal(eventId, receiptEventId(exerciseId, subject, args.requestId));
  assert.notEqual(eventId, receiptEventId(exerciseId, 'other', args.requestId));
  const created = {task: {id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'provenance-watch', phase: 'baseline', modelEnabled: false, side: 'blue', title: TITLE, interpretation: 'x', createdTick: 40},
    receipt: {requestId: args.requestId, eventId, fingerprint: watchFingerprint(exerciseId, TITLE), replayed: false},
    provenance: {exerciseId, exerciseKind: 'live', taskCreatedEventId: 'created-event', fiction: 'Fictional abstract exercise', paidInference: 'off-at-creation'}};
  const answer = JSON.stringify(answerFacts(created));
  const frame = (event: string, data: Json, position?: number): RoomFrame => ({sseEvent: event,
    envelope: {schema_version: 1, stream_kind: position ? 'durable' : 'transient', event, data,
      ...(position ? {position, input_id: 'input', run_id: 'run', conversation_id: 'room'} : {})}});
  const start = {status: 'start', name: WATCH, call_id: 'call', input_id: 'input', run_id: 'run', args_full: JSON.stringify(args)};
  const end = {...start, status: 'end', outcome: 'ok', result_full: JSON.stringify({details: {payload: {isError: false, structuredContent: created}}})};
  const frames = [frame('tool', start), frame('tool', end), frame('assistant_message', {v: 1, text: answer}, 8)];
  const result: TerminalOutcome = {event: 'agent_run_completed', inputId: 'input', runId: 'run', status: 'completed', position: 9,
    assistant: {position: 8, text: answer, data: {}}};
  assert.equal(verifyWatchEvidence(frames, result, args).created.task.id, created.task.id);
  const fails = (f: RoomFrame[], r: TerminalOutcome, code: RegExp) => assert.throws(() => verifyWatchEvidence(f, r, args), code);
  fails(frames.slice(2), result, /exactly-one-matched-tool/);
  fails(frames, {...result, status: 'failed', assistant: undefined}, /matching-completed-answer/);
  const mutate = (i: number, patch: Json) => { const c = structuredClone(frames); Object.assign(c[i].envelope.data, patch); return c; };
  fails(mutate(1, {run_id: 'other'}), result, /other-run/);
  fails(mutate(1, {outcome: 'failed'}), result, /not-successful/);
  fails(mutate(0, {args_full: JSON.stringify({...args, requestId: randomUUID()})}), result, /arguments-mismatch/);
  fails(mutate(1, {result_full: '{"details": … (truncated)'}), result, /display-truncated/);
  fails(mutate(1, {result_full: JSON.stringify({details: {payload: {isError: false, structuredContent: {...created, task: {...created.task, modelEnabled: true}}}}})}), result, /returned-task/);
  fails(mutate(1, {result_full: JSON.stringify({details: {payload: {isError: false, structuredContent: {...created, receipt: {...created.receipt, replayed: true}}}}})}), result, /returned-receipt/);
  const other = structuredClone(frames[0]); other.envelope.data.call_id = 'second';
  fails([other, ...frames], result, /exactly-one/);
  fails([frames[0], structuredClone(frames[0]), frames[1], frames[2]].map((f, i) => i === 1 ? {...f, envelope: {...f.envelope, data: {...f.envelope.data, args_full: '{}'}}} : f), result, /conflicting/);
  assert.equal(verifyWatchEvidence([frames[0], structuredClone(frames[0]), frames[1], frames[2]], result, args).callId, 'call');
  const fabricated = JSON.stringify({...answerFacts(created), createdTick: 41});
  fails(frames, {...result, assistant: {...result.assistant!, text: fabricated}}, /answer-tool-facts/);
  fails([frames[2], frames[0], frames[1]], result, /tool-answer-order/);

  const receipt = {id: eventId, kind: 'mcp_watch_request', actor: subject, tick: 40, side: 'blue',
    details: {requestId: args.requestId, fingerprint: created.receipt.fingerprint, taskId: created.task.id, taskCreatedEventId: 'created-event'}};
  const alert = {id: 'alert', kind: 'staff_update', tick: 300, side: 'blue', details: {taskId: created.task.id, observedTick: 300,
    method: 'deterministic provenance watcher', sourceIds: [`${exerciseId}:${PACKET}:blue-r03`, `${exerciseId}:${PACKET}:blue-r02`]}};
  const overview: Json = {activeId: exerciseId, state: {tick: 310}, tasks: [{id: created.task.id, owner: subject, modelEnabled: false, title: TITLE, side: 'blue', createdTick: 40}],
    timeline: [{id: 'created-event', kind: 'task_created', details: {taskId: created.task.id}}, receipt, alert]};
  assert.equal(verifyPersisted(overview, created, args, subject).receipt.id, eventId);
  const bad = (patch: (o: Json) => void, code: RegExp) => { const o = structuredClone(overview); patch(o); assert.throws(() => verifyPersisted(o, created, args, subject), code); };
  bad(o => o.tasks.push({...o.tasks[0], id: 'unrelated'}), /unrelated-or-missing/);
  bad(o => { o.tasks[0].modelEnabled = true; }, /paid-analysis-enabled/);
  bad(o => { o.tasks[0].owner = 'other'; }, /task-identity/);
  bad(o => { o.timeline = o.timeline.filter((e: Json) => e.kind !== 'mcp_watch_request'); }, /receipt-not-visible/);
  bad(o => { o.timeline[1].details.requestId = randomUUID(); }, /receipt-facts/);
  bad(o => { o.timeline[1].id = randomUUID(); }, /uuid-linked/);
  assert.equal(tick300Alert(overview, created.task.id, exerciseId, 'blue')?.id, 'alert');
  assert.equal(tick300Alert({timeline: []}, created.task.id, exerciseId, 'blue'), undefined);
  const paid = structuredClone(overview); paid.timeline[2].details.method = 'model staff agent';
  assert.throws(() => tick300Alert(paid, created.task.id, exerciseId, 'blue'), /paid-analysis-update/);
  const wrongSources = structuredClone(overview); wrongSources.timeline[2].details.sourceIds.pop();
  assert.throws(() => tick300Alert(wrongSources, created.task.id, exerciseId, 'blue'), /tick300-alert-sources/);
  assert.equal(watchMessage(args).includes(JSON.stringify(args)), true);
  console.log('Offline Tomo watch checks passed: single create_watch/run/args, truncation refusal, answer facts, UUID-linked receipt, one task, free tick-300 alert. No native calls.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
    else await qualify(process.argv.slice(2));
  } catch (e) { console.error(JSON.stringify({status: 'startup-failed', code: errorCode(e)})); process.exitCode = 1; }
}
