/** Main-dispatched only: VERSION ATTEMPT_LABEL [PERMITTED_EXERCISE_ID]. --self-test is offline. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {nativeAppClient} from './native-app-client';
import {attemptArguments, inputAccepted, roomCreated, parseRoomFrame, RoomFrameDecoder, RoomObservation, withDeadline,
  type RoomFrame, type TerminalOutcome} from './tomo-qualification-contract';
import {validateHistoryPage, pageEvidence} from './qualify-practice-history';
import type {PracticeHistoryItem, PracticeHistoryQuery, PracticeHistoryResult} from '../../src/learning/practice-history-types';

const TOOL = 'kz_replay-tools_replay_search_practice_history';
const EXERCISES = ['3e54da3e-e8a1-40e8-94fb-363f76bcf2b9', 'd009bcc9-2f92-44ba-a790-50915e7c9b35'];
const PREFIX = '/runtime/apps/replay-tomo/api/conversations';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, any>;
class Failure extends Error {}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
const errorCode = (e: unknown) => e instanceof Failure ? e.message : 'operation-or-contract-failed';
const equal = (a: unknown, b: unknown, code: string) => {
  try { assert.deepEqual(a, b); } catch { throw new Failure(code); }
};
const budgetProjection = (value: Json) => ({requestsUsed: value?.requestsUsed, maxRequests: value?.maxRequests,
  committedUsd: value?.committedUsd, maxUsd: value?.maxUsd});
function parseEvidenceJson(text: string, code: string): any {
  try { return JSON.parse(text); } catch { throw new Failure(code); }
}

/** An exact answer projection avoids passing on a tick/ID mentioned out of context. */
export function answerRecord(item: PracticeHistoryItem) {
  return {exerciseId: item.exercise.id, eventId: item.eventId, kind: item.kind, summary: item.summary,
    scenarioId: item.exercise.scenarioId, scenarioVersion: item.exercise.scenarioVersion,
    exerciseKind: item.exercise.kind, parentId: item.exercise.parentId, forkTick: item.exercise.forkTick,
    recordedTick: item.tick, observedTick: item.observedTick, recordedAt: item.recordedAt,
    side: item.side, sourceIds: item.sourceIds, commitmentRatio: item.commitmentRatio};
}

/** Same nested tool wire as verify-tomo-grounding.ts; no invented success from a terminal alone. */
export function verifyHistoryEvidence(frames: RoomFrame[], result: TerminalOutcome, args: PracticeHistoryQuery,
  baseline: PracticeHistoryResult, subject: string) {
  check(result.status === 'completed' && result.assistant, 'matching-completed-answer-required');
  const tools = frames.filter(f => f.envelope.event === 'tool').map(f => f.envelope.data)
    .filter(d => d.input_id === result.inputId && d.run_id === result.runId);
  // Identical live/replayed tool frames may repeat. Conflicting duplicates are never discarded.
  const unique = (status: string) => {
    const byId = new Map<string, Json>();
    for (const d of tools.filter(t => t.status === status)) {
      check(typeof d.call_id === 'string' && d.call_id.length > 0, 'missing-tool-call-id');
      const previous = byId.get(d.call_id);
      if (previous) equal(previous, d, 'conflicting-tool-frame');
      else byId.set(d.call_id, d);
    }
    return [...byId.values()];
  };
  const starts = unique('start'), ends = unique('end');
  check(starts.length === 1 && ends.length === 1, 'exactly-one-matched-tool-required');
  const start = starts[0], end = ends[0];
  check(start.name === TOOL && end.name === TOOL && start.call_id === end.call_id && end.outcome === 'ok', 'history-tool-not-successful');
  check(typeof start.args_full === 'string' && typeof end.result_full === 'string', 'full-tool-evidence-required');
  equal(parseEvidenceJson(start.args_full, 'tool-arguments-invalid-json'), args, 'tool-arguments-mismatch');
  const payload = parseEvidenceJson(end.result_full, end.result_full.endsWith('… (truncated)')
    ? 'tool-result-display-truncated' : 'tool-result-invalid-json').details?.payload;
  check(payload?.isError === false && payload.structuredContent, 'mcp-history-payload-required');
  const page = validateHistoryPage(payload.structuredContent, args, subject);
  // Catalog metadata is not part of the returned-record comparison; the actual page is fully validated.
  for (const key of ['items', 'scope', 'query', 'summary', 'hasMore', 'nextBeforeSequence'] as const)
    equal(page[key], baseline[key], 'independent-history-mismatch');
  check(page.items.length > 0, 'nonempty-record-evidence-required');
  const answerIndex = frames.findIndex(f => f.envelope.event === 'assistant_message'
    && f.envelope.position === result.assistant!.position && f.envelope.input_id === result.inputId && f.envelope.run_id === result.runId);
  const startIndex = frames.findIndex(f => f.envelope.event === 'tool' && f.envelope.data === start);
  const endIndex = frames.findIndex(f => f.envelope.event === 'tool' && f.envelope.data === end);
  check(startIndex >= 0 && endIndex > startIndex && answerIndex > endIndex, 'tool-answer-order');
  const text = result.assistant.text.trim();
  // Markdown fences are presentation only; arbitrary surrounding prose is not silently stripped.
  const answer = parseEvidenceJson(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'), 'answer-invalid-json');
  equal(answer.scope, 'mine', 'answer-scope'); equal(answer.basis, 'returned-page-only', 'answer-page-basis');
  equal(answer.returnedRecords, page.items.length, 'answer-page-count'); equal(answer.hasMore, page.hasMore, 'answer-cursor');
  equal(answer.record, answerRecord(page.items[0]), 'answer-record-facts');
  equal(answer.recordScope, 'completed fictional records only', 'answer-completed-scope');
  equal(answer.branchInterpretation, 'informed practice', 'answer-branch-label');
  check(typeof answer.explanation === 'string' && answer.explanation.trim().length > 0 && answer.explanation.length <= 1500, 'answer-explanation');
  return {tool: {name: TOOL, callId: start.call_id, outcome: 'ok', inputId: result.inputId, runId: result.runId},
    page: pageEvidence(page), answerSha256: hash(text), answerDurablePosition: result.assistant.position,
    independentReturnedRecordsMatched: true, answerRecordFactsMatched: true,
    interpretationRequiresMainReview: true};
}

/** Forensics only: decode one intact JSON string token, never repair the truncated outer document.
 * This is deliberately NOT used by verifyHistoryEvidence or the native qualification path.
 */
function completeEmbeddedPayload(display: string): Json {
  const prefix = /^\s*\{\s*"content"\s*:\s*\[\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*/.exec(display);
  check(prefix && display[prefix[0].length] === '"', 'embedded-text-prefix');
  const begin = prefix[0].length;
  let escaped = false;
  for (let i = begin + 1; i < display.length; i++) {
    const ch = display[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      const text = parseEvidenceJson(display.slice(begin, i + 1), 'embedded-text-invalid-json');
      check(typeof text === 'string', 'embedded-text-string');
      return parseEvidenceJson(text, 'embedded-payload-invalid-json');
    }
  }
  throw new Failure('embedded-text-truncated');
}

/** Read existing evidence only; no native client, writes, submission, credentials, or network. */
function replayOffline(receiptPath: string) {
  const receiptBytes = fs.readFileSync(receiptPath), proof = JSON.parse(receiptBytes.toString('utf8'));
  check(typeof proof.attempt === 'string' && /^[a-zA-Z0-9_.-]+$/.test(proof.attempt), 'replay-attempt');
  const expectedBase = `data/platform/tomo-history-${proof.attempt}`;
  equal(proof.privateEvents, `${expectedBase}-events.jsonl`, 'replay-events-path');
  equal(proof.privateBaseline, `${expectedBase}-baseline.json`, 'replay-baseline-path');
  equal(proof.privateDetail, `${expectedBase}-detail.json`, 'replay-detail-path');
  const inputs = [receiptPath, proof.privateEvents, proof.privateBaseline, proof.privateDetail];
  const originals = inputs.map(file => fs.readFileSync(file));
  const fingerprints = originals.map(bytes => createHash('sha256').update(bytes).digest('hex'));
  check(originals[1].byteLength <= 8_000_000, 'replay-event-byte-cap');
  const frames = originals[1].toString('utf8').trim().split('\n').map(line => {
    const {_sse, ...envelope} = JSON.parse(line);
    check(_sse && typeof _sse.event === 'string', 'replay-sse-metadata');
    const frame = parseRoomFrame(`${_sse.id === undefined ? '' : `id: ${_sse.id}\n`}event: ${_sse.event}\ndata: ${JSON.stringify(envelope)}`);
    check(frame, 'replay-frame'); return frame;
  });
  const saved = JSON.parse(originals[2].toString('utf8'));
  const subject = saved.page?.items?.[0]?.actor;
  check(typeof subject === 'string' && hash(subject) === proof.subjectSha256, 'replay-subject-hash');
  const baseline = validateHistoryPage(saved.page, saved.args, subject);
  const observation = new RoomObservation(proof.conversationId);
  for (const frame of frames) observation.add(frame);
  observation.accept(inputAccepted(proof.inputHttpStatus, proof.acceptance));
  const result = observation.outcome(); check(result && result.assistant, 'replay-terminal-answer');
  const {assistant, reason, ...terminal} = result;
  equal(terminal, proof.terminal, 'replay-terminal-receipt-match');
  let strictFailure: string | null = null;
  try {verifyHistoryEvidence(frames, result, saved.args, baseline, subject);}
  catch (e) {strictFailure = errorCode(e);}
  const diagnostic: Json = {};
  try {
    const toolFrames = frames.filter(f => f.envelope.event === 'tool'
      && f.envelope.data.input_id === result.inputId && f.envelope.data.run_id === result.runId);
    const start = toolFrames.filter(f => f.envelope.data.status === 'start');
    const end = toolFrames.filter(f => f.envelope.data.status === 'end');
    check(start.length === 1 && end.length === 1, 'forensic-single-tool');
    const s = start[0].envelope.data, e = end[0].envelope.data;
    check(s.name === TOOL && e.name === TOOL && s.call_id === e.call_id && e.outcome === 'ok', 'forensic-tool-linkage');
    equal(parseEvidenceJson(String(s.args_full), 'forensic-args-json'), saved.args, 'forensic-args');
    const answerFrame = frames.find(f => f.envelope.event === 'assistant_message' && f.envelope.position === assistant!.position);
    check(answerFrame && frames.indexOf(start[0]) < frames.indexOf(end[0]) && frames.indexOf(end[0]) < frames.indexOf(answerFrame), 'forensic-tool-answer-order');
    const embedded = completeEmbeddedPayload(String(e.result_full));
    check(embedded.isError === false, 'forensic-mcp-error');
    const page = validateHistoryPage(embedded.structuredContent, saved.args, subject);
    equal(page, baseline, 'forensic-complete-page-baseline');
    check(Array.isArray(embedded.content) && embedded.content.length === 1 && embedded.content[0].type === 'text', 'forensic-mcp-content');
    equal(parseEvidenceJson(embedded.content[0].text, 'forensic-mcp-text-json'), baseline, 'forensic-mcp-text-baseline');
    const answer = parseEvidenceJson(assistant!.text, 'forensic-answer-json');
    equal(answer.record, answerRecord(page.items[0]), 'forensic-answer-record');
    equal(answer.scope, 'mine', 'forensic-answer-scope'); equal(answer.basis, 'returned-page-only', 'forensic-answer-basis');
    equal(answer.hasMore, page.hasMore, 'forensic-answer-cursor');
    equal(answer.recordScope, 'completed fictional records only', 'forensic-answer-record-scope');
    equal(answer.branchInterpretation, 'informed practice', 'forensic-answer-branch');
    Object.assign(diagnostic, {singleMatchedHistoryToolSucceeded: true, completeEmbeddedPayloadMatchesBaseline: true,
      embeddedTextAlsoMatchesBaseline: true, answerRecordFactsMatched: true,
      returnedRecordsIsRequiredNumber: typeof answer.returnedRecords === 'number' && answer.returnedRecords === page.items.length,
      returnedRecordsShape: typeof answer.returnedRecords, explanationRequiresMainReview: true,
      answerSha256: hash(assistant!.text), baselineSha256: fingerprints[2]});
  } catch (e) {diagnostic.failure = errorCode(e);}
  for (const [i, file] of inputs.entries()) equal(fs.readFileSync(file), originals[i], 'original-evidence-changed');
  console.log(JSON.stringify({mode: 'offline-replay', strictValidation: strictFailure ? 'failed' : 'passed', strictFailure,
    receiptSha256: fingerprints[0], originalEvidenceUnchanged: true, nativeCalls: 0, diagnostic}, null, 2));
  if (strictFailure || diagnostic.failure) process.exitCode = 1;
}

async function qualify(argv: string[]) {
  check(argv.length === 2 || argv.length === 3, 'usage-version-attempt-label-optional-exercise');
  const {version, attempt: label} = attemptArguments(argv.slice(0, 2));
  const exerciseId = argv[2] ?? EXERCISES[0]; check(EXERCISES.includes(exerciseId), 'exercise-not-permitted');
  const attempt = `${label}-${randomUUID()}`;
  const artifact = `evidence/platform/tomo-history-${attempt}.json`;
  const eventsPath = `data/platform/tomo-history-${attempt}-events.jsonl`;
  const detailPath = `data/platform/tomo-history-${attempt}-detail.json`;
  const baselinePath = `data/platform/tomo-history-${attempt}-baseline.json`;
  for (const file of [artifact, eventsPath, detailPath, baselinePath]) {
    fs.mkdirSync(path.dirname(file), {recursive: true}); check(!fs.existsSync(file), 'attempt-file-exists');
  }
  // All files are reserved before any login. Only these owned descriptors are subsequently written.
  const fds = new Map<string, number>();
  try { for (const file of [artifact, eventsPath, detailPath, baselinePath]) fds.set(file, fs.openSync(file, 'wx', 0o600)); }
  catch (e) { for (const fd of fds.values()) fs.closeSync(fd); throw e; }
  const write = (file: string, data: unknown) => {
    const fd = fds.get(file)!; fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n', 0, 'utf8');
  };
  const proof: Json = {startedAt: new Date().toISOString(), version, attempt, exerciseId,
    automatedOperation: true, pairedPlayerTrial: false, status: 'starting', creationKey: randomUUID(), inputKey: randomUUID(),
    privateEvents: eventsPath, privateDetail: detailPath, privateBaseline: baselinePath,
    limits: {activeDeadlineMs: 180000, requestCap: 28, inputPosts: 1, historyPages: 3, historyToolLimit: 1,
      applicationRequestCap: 100, applicationUsdCap: 5},
    limitations: ['One input may require multiple provider requests; application budget remains authoritative.',
      'Exact tool/result/answer fact checks do not validate free-text interpretation or learning efficacy.',
      'Discovery/configuration proof remains separate. No browser or complete provider-workload join claim.']};
  const save = () => write(artifact, proof);
  let phase = 'preflight', client: Awaited<ReturnType<typeof nativeAppClient>> | undefined;
  let selected = false, cleanup = false, loginAttempted = false, requestCount = 0, inputPosts = 0, roomPosts = 0;
  let observation: RoomObservation | undefined, streamTask: Promise<void> | undefined;
  const frames: RoomFrame[] = [], active = new AbortController(), streamStop = new AbortController();
  const activeTimer = setTimeout(() => active.abort(), 180000);
  const nativeFetch = globalThis.fetch;
  // nativeAppClient has no login/logout signal argument. This isolated CLI's fetch guard bounds
  // those ordinary calls too, permits only the native app origin, and is restored after cleanup.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET', p = url.pathname;
    check(url.origin === 'http://127.0.0.1:5183', 'native-origin-only');
    check(++requestCount <= 28, 'request-cap');
    const room = proof.conversationId ? `${PREFIX}/${proof.conversationId}` : null;
    const allowedGet = ['/replay-build.json', '/api/native/status', '/api/agents/tools', '/api/tomo/status', '/api/practice/history', room, room && `${room}/events`];
    const allowedPost = ['/api/native/login', '/api/native/logout', '/api/select', PREFIX, room && `${room}/inputs`];
    check(method === 'GET' ? allowedGet.includes(p) : method === 'POST' && allowedPost.includes(p), 'request-route-not-permitted');
    if (method === 'POST' && p === PREFIX) check(++roomPosts === 1, 'room-retry-forbidden');
    if (method === 'POST' && p.endsWith('/inputs')) check(++inputPosts === 1, 'input-retry-forbidden');
    const isStream = p.endsWith('/events');
    const signals = [AbortSignal.timeout(isStream ? 180000 : p.endsWith('/inputs') || p === PREFIX ? 30000 : 15000)];
    if (!cleanup) signals.push(active.signal);
    if (init?.signal) signals.push(init.signal);
    return nativeFetch(input, {...init, redirect: 'error', signal: AbortSignal.any(signals)});
  };
  const read = async (target: string, body?: unknown) => withDeadline(async signal => {
    const response = await client!.request(target, body, {signal});
    return response.json() as Promise<Json>;
  }, 15000, 'read-deadline');
  try {
    save();
    const config = JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json', 'utf8'));
    const observer = JSON.parse(fs.readFileSync('evidence/platform/tomo-observer-agent-1.json', 'utf8'));
    check(config.agentId === observer.agent.id && typeof config.deploymentId === 'string' && config.deploymentId.length > 0, 'existing-observer-config');
    const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
    check(Array.isArray(users), 'commander-credentials');
    const matches = users.filter((u: Json) => u.role === 'commander');
    check(matches.length === 1 && matches[0].username && matches[0].password, 'commander-credentials');
    phase = 'commander-login'; loginAttempted = true;
    try { client = await nativeAppClient(matches[0]); } finally { for (const u of users) u.password = ''; }
    phase = 'select-permitted-exercise';
    equal((await read('/api/select', {exerciseId})).selected, exerciseId, 'selection-failed'); selected = true;
    proof.selectedBeforeBudget = true;
    const build = await read('/replay-build.json'); equal(build.version, version, 'deployed-version');
    check(typeof build.sourceArchive?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(build.sourceArchive.sha256), 'build-source-hash');
    proof.sourceSha256 = build.sourceArchive?.sha256;
    const identity = await read('/api/native/status');
    check(identity.mode === 'kamiwaza' && identity.signedIn && identity.identity?.role === 'commander'
      && typeof identity.identity.subject === 'string', 'native-commander-required');
    const subject: string = identity.identity.subject;
    proof.subjectSha256 = hash(subject);
    proof.budgetBefore = budgetProjection((await read('/api/agents/tools')).budget);
    const budget = proof.budgetBefore;
    check(budget && Number.isInteger(budget.requestsUsed) && budget.requestsUsed >= 0 && budget.maxRequests === 100
      && budget.requestsUsed <= 98 && budget.maxUsd === 5 && Number.isFinite(budget.committedUsd)
      && budget.committedUsd >= 0 && budget.committedUsd < 5, 'insufficient-or-unexpected-budget');
    equal((await read('/api/tomo/status')).mode, 'scoped-conversation', 'conversation-route-unavailable');
    phase = 'independent-history-preflight';
    const history = async (query: PracticeHistoryQuery) => {
      const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
      return validateHistoryPage(await read(`/api/practice/history?${params}`), query, subject);
    };
    let candidate: PracticeHistoryItem | undefined, beforeSequence: number | undefined;
    for (let n = 0; n < 3; n++) {
      const page = await history({scope: 'mine', limit: 20, ...(beforeSequence ? {beforeSequence} : {})});
      candidate = page.items.find(item => item.exercise.id === exerciseId);
      if (candidate || !page.hasMore) break;
      beforeSequence = page.nextBeforeSequence!;
    }
    check(candidate && candidate.exercise.name.trim().length > 0 && candidate.exercise.name.trim().length <= 120, 'permitted-history-record-not-found');
    const args: PracticeHistoryQuery = {scope: 'mine', query: candidate.exercise.name.trim(), limit: 1,
      ...(candidate.exercise.scenarioId ? {scenarioId: candidate.exercise.scenarioId} : {})};
    const baseline = await history(args);
    check(baseline.items.length === 1 && baseline.items[0].exercise.id === exerciseId, 'literal-query-target-mismatch');
    write(baselinePath, {args, page: baseline}); proof.baseline = pageEvidence(baseline);
    const message = `Call ${TOOL} exactly once with this JSON argument object: ${JSON.stringify(args)}. Use its real result, no other tools. This is my completed fictional practice history, not live state. Return only a JSON object (no prose outside it) with scope, basis, returnedRecords (a JSON integer equal to the number of returned items, never total history; for one item write "returnedRecords":1, never an object such as {"items.length":1}), hasMore, recordScope="completed fictional records only", branchInterpretation="informed practice", and record for items[0]. Map record fields exactly: exerciseId=exercise.id, eventId, kind, summary, scenarioId=exercise.scenarioId, scenarioVersion=exercise.scenarioVersion, exerciseKind=exercise.kind, parentId=exercise.parentId, forkTick=exercise.forkTick, recordedTick=tick, observedTick, recordedAt, side, sourceIds, commitmentRatio. Preserve nulls and arrays. Add explanation: one brief sentence describing the recorded action and its evidence limits; observed time may differ from recorded time, missing evidence is not a weakness, and no personality, mastery or ranking claims. Do not invent results if the tool fails.`;
    proof.messageSha256 = hash(message); proof.agentId = config.agentId; proof.modelDeploymentId = config.deploymentId;
    phase = 'room-create'; proof.status = 'room-create-pending'; save();
    const roomId = await withDeadline(async signal => {
      const response = await client!.requestRaw(PREFIX, {}, {idempotencyKey: proof.creationKey, signal});
      proof.creationHttpStatus = response.status;
      return roomCreated(response.status, await response.json());
    }, 30000, 'room-creation-uncertain');
    proof.conversationId = roomId; proof.status = 'room-created'; save();
    phase = 'observe-stream';
    const response = await withDeadline(signal => client!.request(`${PREFIX}/${roomId}/events?after=0`, undefined,
      {signal: AbortSignal.any([signal, streamStop.signal])}), 15000, 'event-headers-deadline');
    check(response.status === 200 && /^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') && response.body, 'event-stream-required');
    const body = response.body;
    observation = new RoomObservation(roomId); const room = observation;
    let acceptanceBound = false, streamEnded = false, streamFailure: unknown;
    let resolveTerminal!: (r: TerminalOutcome) => void, rejectTerminal!: (e: unknown) => void;
    const terminal = new Promise<TerminalOutcome>((resolve, reject) => {resolveTerminal = resolve; rejectTerminal = reject;});
    void terminal.catch(() => {});
    const observe = () => {
      if (!acceptanceBound) return;
      try {
        const result = room.outcome();
        if (result) resolveTerminal(result);
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
            frames.push(frame); room.add(frame); observe();
          }
        }
      } catch (e) {streamFailure = e;}
      finally {streamEnded = true; observe(); try {await reader.cancel();} catch {} reader.releaseLock();}
    })();
    await Promise.resolve(); check(!streamFailure && !streamEnded, 'stream-failed-before-input');
    phase = 'single-input'; proof.status = 'input-response-pending'; proof.acceptanceState = 'uncertain';
    proof.inputDispatchedAt = new Date().toISOString(); save();
    const accepted = await withDeadline(async signal => {
      const r = await client!.requestRaw(`${PREFIX}/${roomId}/inputs`, {kind: 'message', message,
        model: config.deploymentId, agent: config.agentId, platform_tool_names: [TOOL],
        connector_ids: [], subagent_ids: [], resource_reference_ids: [], effort: 'low'}, {idempotencyKey: proof.inputKey, signal});
      proof.inputHttpStatus = r.status; save();
      const data = await r.json();
      if (typeof data?.input_id === 'string') proof.inputId = data.input_id;
      signal.throwIfAborted(); return inputAccepted(r.status, data);
    }, 30000, 'input-acceptance-uncertain');
    proof.acceptance = accepted; proof.inputId = accepted.input_id; proof.acceptanceState = 'accepted';
    proof.status = 'input-accepted'; save(); room.accept(accepted); acceptanceBound = true; observe();
    phase = 'matched-terminal';
    const result = await withDeadline(() => terminal, 120000, 'terminal-observation-deadline');
    const {assistant, reason, ...terminalProof} = result;
    proof.terminal = terminalProof; proof.terminalReasonPresent = typeof reason === 'string'; save();
    phase = 'verify-tool-and-answer';
    proof.verification = verifyHistoryEvidence(frames, result, args, baseline, subject);
    proof.status = 'qualified-facts-main-review-pending';
  } catch (e) {
    proof.failure = {phase, code: errorCode(e)};
    proof.status = proof.acceptanceState === 'uncertain' ? 'input-acceptance-uncertain'
      : proof.status === 'room-create-pending' ? 'room-creation-uncertain' : 'qualification-incomplete';
    process.exitCode = 1;
  } finally {
    cleanup = true; clearTimeout(activeTimer); streamStop.abort(); active.abort();
    try {await withDeadline(() => streamTask ?? Promise.resolve(), 5000, 'stream-cleanup-deadline'); proof.streamClosed = true;}
    catch {proof.streamClosed = false; process.exitCode = 1;}
    if (client) {
      if (proof.conversationId) {
        try {write(detailPath, await read(`${PREFIX}/${proof.conversationId}`)); proof.detailRetained = true;}
        catch {proof.detailRetained = false; process.exitCode = 1;}
      }
      if (selected) {
        try {
          proof.budgetAfter = budgetProjection((await read('/api/agents/tools')).budget);
          check(Number.isInteger(proof.budgetAfter.requestsUsed) && proof.budgetAfter.requestsUsed >= (proof.budgetBefore?.requestsUsed ?? 0)
            && proof.budgetAfter.requestsUsed <= 100 && proof.budgetAfter.maxRequests === 100
            && proof.budgetAfter.maxUsd === 5 && Number.isFinite(proof.budgetAfter.committedUsd)
            && proof.budgetAfter.committedUsd >= (proof.budgetBefore?.committedUsd ?? 0)
            && proof.budgetAfter.committedUsd <= 5, 'budget-after-contract');
          if (typeof proof.budgetBefore?.requestsUsed === 'number' && typeof proof.budgetAfter?.requestsUsed === 'number')
            proof.newRequests = proof.budgetAfter.requestsUsed - proof.budgetBefore.requestsUsed;
        } catch {proof.budgetReadFailed = true; process.exitCode = 1;}
      }
      try {await withDeadline(() => client!.close(), 15000, 'logout-deadline'); proof.clientClosed = true;}
      catch {proof.clientClosed = false; process.exitCode = 1;}
    } else proof.clientClosed = loginAttempted ? 'unconfirmed-login-failure' : 'not-opened';
    globalThis.fetch = nativeFetch;
    proof.requestCount = requestCount; proof.inputPosts = inputPosts; proof.roomPosts = roomPosts;
    proof.eventTypes = observation?.eventTypes ?? []; proof.lastDurablePosition = observation?.lastPosition ?? 0;
    proof.finishedAt = new Date().toISOString();
    proof.exitCode = process.exitCode === 1 ? 1 : 0;
    if (proof.exitCode === 1 && proof.status === 'qualified-facts-main-review-pending') proof.status = 'facts-matched-cleanup-or-evidence-incomplete';
    try {save();} finally {for (const fd of fds.values()) fs.closeSync(fd);}
    // No answer, tool output, identity, credential, arbitrary error or terminal reason in the public log.
    console.log(JSON.stringify({artifact, status: proof.status, failure: proof.failure, inputPosts, newRequests: proof.newRequests,
      clientClosed: proof.clientClosed, detailRetained: proof.detailRetained, exitCode: proof.exitCode}));
  }
}

function selfTest() {
  const item = {eventId: 'event', sequence: 4, tick: 12, observedTick: 10, recordedAt: '2026-09-14T00:00:00Z',
    kind: 'command', actor: 'subject', side: 'blue', summary: 'Recorded fictional command',
    exercise: {id: 'exercise', name: 'Fixture', kind: 'live', status: 'completed', createdAt: '2026-09-14T00:00:00Z',
      scenarioId: 'fixture', scenarioVersion: 'fixture/1', map: null, simulationProfile: null, curriculumVersion: null,
      assistance: 'unassisted', parentId: null, forkTick: null}, sourceIds: ['source'], commitmentRatio: 0.2, rationaleRecorded: true} as PracticeHistoryItem;
  const args = {scope: 'mine', query: 'Fixture', scenarioId: 'fixture', limit: 1} as const;
  const page: PracticeHistoryResult = {schema: 'replay.practice-history/1', scope: 'mine', fiction: true, query: 'Fixture', items: [item],
    nextBeforeSequence: null, hasMore: false, scenarios: [{id: 'fixture', name: 'Fixture'}],
    summary: {basis: 'returned-page-only', commands: 1, assessments: 0, watches: 0, commandsCitingSources: 1, commandsWithRecordedReason: 1, branchEvents: 0},
    limits: {maxPageSize: 50, eligibleExercises: 1, exerciseCatalogTruncated: false}, notice: 'Fixture'};
  const answer = {scope: 'mine', basis: 'returned-page-only', returnedRecords: 1, hasMore: false,
    record: answerRecord(item), recordScope: 'completed fictional records only', branchInterpretation: 'informed practice', explanation: 'Recorded fictional act.'};
  const frame = (event: string, data: Json, position?: number): RoomFrame => ({sseEvent: event,
    envelope: {schema_version: 1, stream_kind: position ? 'durable' : 'transient', event, data,
      ...(position ? {position, input_id: 'input', run_id: 'run', conversation_id: 'room'} : {})}});
  const start = {status: 'start', name: TOOL, call_id: 'call', input_id: 'input', run_id: 'run', args_full: JSON.stringify(args)};
  const end = {...start, status: 'end', outcome: 'ok', result_full: JSON.stringify({details: {payload: {isError: false, structuredContent: page}}})};
  const frames = [frame('tool', start), frame('tool', end), frame('assistant_message', {v: 1, text: JSON.stringify(answer)}, 8)];
  const result: TerminalOutcome = {event: 'agent_run_completed', inputId: 'input', runId: 'run', status: 'completed', position: 9,
    assistant: {position: 8, text: JSON.stringify(answer), data: {}}};
  assert(verifyHistoryEvidence(frames, result, args, page, 'subject').answerRecordFactsMatched);
  assert.throws(() => verifyHistoryEvidence(frames.slice(2), result, args, page, 'subject')); // terminal alone
  const wrongRun = structuredClone(frames); wrongRun[1].envelope.data.run_id = 'other';
  assert.throws(() => verifyHistoryEvidence(wrongRun, result, args, page, 'subject'));
  const failedTool = structuredClone(frames); failedTool[1].envelope.data.outcome = 'failed';
  assert.throws(() => verifyHistoryEvidence(failedTool, result, args, page, 'subject'));
  const wrongArgs = structuredClone(frames); wrongArgs[0].envelope.data.args_full = JSON.stringify({...args, scope: 'workroom'});
  assert.throws(() => verifyHistoryEvidence(wrongArgs, result, args, page, 'subject'));
  const fabricated = {...result, assistant: {...result.assistant!, text: JSON.stringify({...answer, record: {...answer.record, observedTick: 12}})}};
  assert.throws(() => verifyHistoryEvidence(frames, fabricated, args, page, 'subject'));
  const duplicate = [frames[0], structuredClone(frames[0]), frames[1], frames[2]];
  assert(verifyHistoryEvidence(duplicate, result, args, page, 'subject').answerRecordFactsMatched);
  const conflicting = structuredClone(duplicate); conflicting[1].envelope.data.args_full = '{}';
  assert.throws(() => verifyHistoryEvidence(conflicting, result, args, page, 'subject'));
  const extraCall = structuredClone(frames[0]); extraCall.envelope.data.call_id = 'another-call';
  assert.throws(() => verifyHistoryEvidence([extraCall, ...frames], result, args, page, 'subject'));
  const truncated = structuredClone(frames); truncated[1].envelope.data.result_full = '{truncated';
  assert.throws(() => verifyHistoryEvidence(truncated, result, args, page, 'subject'), /tool-result-invalid-json/);
  truncated[1].envelope.data.result_full = '{\n… (truncated)';
  assert.throws(() => verifyHistoryEvidence(truncated, result, args, page, 'subject'), /tool-result-display-truncated/);
  const countObject = {...result, assistant: {...result.assistant!, text: JSON.stringify({...answer, returnedRecords: {'items.length': 1}})}};
  assert.throws(() => verifyHistoryEvidence(frames, countObject, args, page, 'subject'), /answer-page-count/);
  const embedded = {isError: false, structuredContent: page};
  const partialDisplay = `{"content":[{"type":"text","text":${JSON.stringify(JSON.stringify(embedded))}}],"details": … (truncated)`;
  assert.deepEqual(completeEmbeddedPayload(partialDisplay), embedded);
  assert.throws(() => completeEmbeddedPayload(partialDisplay.slice(0, 60)));
  const badPage = structuredClone(frames); const otherPage = structuredClone(page); otherPage.items[0].actor = 'other';
  badPage[1].envelope.data.result_full = JSON.stringify({details: {payload: {isError: false, structuredContent: otherPage}}});
  assert.throws(() => verifyHistoryEvidence(badPage, result, args, page, 'subject'));
  console.log('Offline history evidence checks passed: tool/run/arguments, scope, terminal-only refusal, duplicate frames and answer facts. No native calls.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
    else if (process.argv.length === 4 && process.argv[2] === '--replay') replayOffline(process.argv[3]);
    else await qualify(process.argv.slice(2));
  } catch (e) {console.error(JSON.stringify({status: 'startup-failed', code: errorCode(e)})); process.exitCode = 1;}
}
