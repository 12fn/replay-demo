/** Main-dispatched only: VERSION ATTEMPT_LABEL. One direct member-MCP create_watch after tick 300; --self-test is offline.
 * Contract: docs/process/late-watch-qualification-contract.md. Component evidence, NOT a Tomo conversation. No inference, no retries.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {nativeAppClient} from './native-app-client';
import {attemptArguments, withDeadline} from './tomo-qualification-contract';
import {receiptEventId, verifyPersisted, watchFingerprint, type WatchArgs} from './qualify-tomo-watch';
import {KamiwazaClient} from '../../src/platform';

const TITLE = 'Monitor report provenance', SCENARIO = 'crosscurrent-evidence/1', PACKET = 'crosscurrent-changing-evidence/1';
const APP = 'http://127.0.0.1:5183', METHOD = 'deterministic provenance watcher';
const TRANSPORT = 'Direct native member MCP create_watch (component check); not a Tomo conversation and no model inference';
const ACTIVE_MS = 170000, ACTIVE_REQUESTS = 90, CLEANUP_REQUESTS = 12, CLEANUP_STEP_MS = 15000;
/** Creation must see the tick-300 releases and leave margin before the tick-600 release. */
const CREATE_AFTER = 300, CREATE_GATE = 450, CORRECTION = 600, CONFLICT = 900, GIVE_UP = 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, any>;
class Failure extends Error {}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
const errorCode = (e: unknown) => e instanceof Failure ? e.message : 'operation-or-contract-failed';
const equal = (a: unknown, b: unknown, code: string) => { try { assert.deepEqual(a, b); } catch { throw new Failure(code); } };
const budgetProjection = (v: Json) => ({requestsUsed: v?.requestsUsed, maxRequests: v?.maxRequests, committedUsd: v?.committedUsd, maxUsd: v?.maxUsd});
const capsUnchanged = (b: Json) => b?.maxRequests === 100 && b?.maxUsd === 5 && Number.isInteger(b.requestsUsed)
  && b.requestsUsed >= 0 && b.requestsUsed <= 100 && Number.isFinite(b.committedUsd) && b.committedUsd >= 0 && b.committedUsd <= 5;

export const storedId = (exerciseId: string, report: string) => `${exerciseId}:${PACKET}:${report}`;
const ids = (exerciseId: string, reports: string[]) => reports.map(r => storedId(exerciseId, r)).sort();
const sorted = (v: unknown) => Array.isArray(v) ? [...v].sort() : v;
const updatesFor = (overview: Json, taskId: string): Json[] =>
  (overview.timeline ?? []).filter((e: Json) => e.kind === 'staff_update' && e.details?.taskId === taskId);

// ---------------------------------------------------------------------------
// Request guard: exact origins/routes, one-shot mutations, only this attempt's exercise.
// ---------------------------------------------------------------------------

export interface GuardState {
  cleanup: boolean; exerciseId: string; taskId: string; apiOrigin: string; apiPrefix: string; workroomId: string;
  requests: number; cleanupRequests: number; counts: Record<string, number>;
}
export const newGuard = (apiBase: string, workroomId: string): GuardState => {
  const url = new URL(apiBase);
  return {cleanup: false, exerciseId: '', taskId: '', apiOrigin: url.origin, apiPrefix: url.pathname.replace(/\/+$/, ''), workroomId,
    requests: 0, cleanupRequests: 0, counts: {}};
};
const once = (g: GuardState, key: string, max = 1) => check((g.counts[key] = (g.counts[key] ?? 0) + 1) <= max, `${key}-retry-forbidden`);
const bodyJson = (body: unknown): Json => { try { return typeof body === 'string' ? JSON.parse(body) : {}; } catch { return {}; } };

/** Throws before any disallowed request leaves the process. Mutates counters. */
export function permit(g: GuardState, method: string, href: string, body?: unknown, headers?: HeadersInit) {
  const url = new URL(href), p = url.pathname, active = !g.cleanup;
  check(url.origin === APP || url.origin === g.apiOrigin, 'origin-not-permitted');
  if (g.cleanup) check(++g.cleanupRequests <= CLEANUP_REQUESTS, 'cleanup-request-cap'); else check(++g.requests <= ACTIVE_REQUESTS, 'request-cap');
  check(!url.search, 'query-not-permitted');
  const phased = (ok: boolean, key: string, max = 1, code = 'route-phase') => { check(ok, code); once(g, key, max); };
  if (url.origin === g.apiOrigin) {
    const pre = g.apiPrefix;
    if (method === 'GET' && p === `${pre}/auth/forward/validate`) {
      const h = new Headers(headers), uri = h.get('x-forwarded-uri');
      check(h.get('x-forwarded-method') === 'POST', 'validation-method-not-permitted');
      if (uri === `${pre}/workrooms/${encodeURIComponent(g.workroomId)}/enter`) return phased(active, 'validate-enter');
      if (uri === `${pre}/workrooms/leave`) return phased(g.cleanup, 'validate-leave');
      throw new Failure('validation-target-not-permitted');
    }
    check(method === 'POST', 'request-route-not-permitted');
    if (p === `${pre}/auth/token`) return phased(active, 'member-token');
    if (p === `${pre}/workrooms/${encodeURIComponent(g.workroomId)}/enter`) return phased(active, 'workroom-enter');
    if (p === `${pre}/workrooms/leave`) return phased(g.cleanup, 'workroom-leave');
    throw new Failure('request-route-not-permitted');
  }
  if (method === 'GET') {
    const reads = ['/replay-build.json', '/api/native/status', '/api/agents/tools', '/api/overview', g.taskId && `/api/agents/tasks/${g.taskId}`];
    check(reads.includes(p), 'request-route-not-permitted');
    return;
  }
  check(method === 'POST', 'request-method-not-permitted');
  const b = bodyJson(body);
  switch (p) {
    case '/api/native/login': return phased(active, 'app-login', 2);
    case '/api/native/logout': return phased(g.cleanup, 'app-logout', 2);
    case '/api/exercises': return phased(active && !g.exerciseId, 'exercise-create');
    case '/api/team/code': return phased(active && !!g.exerciseId, 'team-code');
    case '/api/team/join': return phased(active && !!g.exerciseId, 'team-join');
    case '/api/select': return phased(g.cleanup && !!g.exerciseId && b.exerciseId === g.exerciseId, 'select', 1, 'select-other-exercise');
    case '/mcp':
      check(active && !!g.exerciseId, 'route-phase');
      if (b.method === 'tools/list') return once(g, 'mcp-list');
      check(b.method === 'tools/call' && b.params?.name === 'create_watch' && b.params.arguments?.exerciseId === g.exerciseId, 'mcp-call-not-permitted');
      return once(g, 'create-watch');
  }
  if (g.exerciseId && p === `/api/exercises/${g.exerciseId}/finish`) return phased(g.cleanup, 'finish', 1, 'finish-once-in-cleanup');
  throw new Failure('request-route-not-permitted');
}

// ---------------------------------------------------------------------------
// Offline-checkable acceptance functions
// ---------------------------------------------------------------------------

/** The tick-300 releases are already visible to the Commander and no watch or receipt exists yet. */
export function readyToCreate(overview: Json, exerciseId: string) {
  check(overview.activeId === exerciseId && overview.playbackTick === null, 'overview-exercise-mismatch');
  check(Array.isArray(overview.tasks) && overview.tasks.length === 0, 'task-exists-before-creation');
  check(!(overview.timeline ?? []).some((e: Json) => e.kind === 'mcp_watch_request'), 'receipt-exists-before-creation');
  const tick = Number(overview.state?.tick);
  check(Number.isSafeInteger(tick) && tick < CREATE_GATE, 'creation-window-missed');
  const reports = new Set((overview.reports ?? []).map((r: Json) => r.id));
  return tick > CREATE_AFTER && ids(exerciseId, ['blue-r02', 'blue-r03']).every(id => reports.has(id));
}

/** JSON-RPC create_watch result: free, fresh (not replayed), exact request and a creation tick strictly between 300 and 600. */
export function verifyCreated(rpc: Json, args: WatchArgs) {
  check(rpc?.jsonrpc === '2.0' && !rpc.error && rpc.result?.isError === false && rpc.result.structuredContent, 'create-watch-not-successful');
  const c = rpc.result.structuredContent;
  check(UUID.test(c.task?.id) && c.task.kind === 'provenance-watch' && c.task.modelEnabled === false && c.task.title === TITLE
    && c.task.side === 'blue' && Number.isSafeInteger(c.task.createdTick), 'returned-task-contract');
  check(c.receipt?.requestId === args.requestId && c.receipt.replayed === false && UUID.test(c.receipt.eventId)
    && c.receipt.fingerprint === watchFingerprint(args.exerciseId, args.title), 'returned-receipt-contract');
  check(c.provenance?.exerciseId === args.exerciseId && c.provenance.paidInference === 'off-at-creation'
    && typeof c.provenance.taskCreatedEventId === 'string', 'returned-provenance-contract');
  check(c.task.createdTick > CREATE_AFTER, 'watch-not-created-after-tick300');
  check(c.task.createdTick < CORRECTION, 'watch-created-at-or-after-tick600');
  return c;
}

/** Creation is a baseline, not a retroactive alert: earlier releases are seen but never reported. */
export function verifyBaseline(overview: Json, created: Json, args: WatchArgs, subject: string) {
  const {task, receipt} = verifyPersisted(overview, created, args, subject);
  check(overview.playbackTick === null, 'overview-not-live');
  const createdTick = created.task.createdTick;
  const creation = (overview.timeline ?? []).find((e: Json) => e.id === created.provenance.taskCreatedEventId);
  check(creation?.tick === createdTick && receipt.tick === createdTick, 'creation-tick-mismatch');
  equal({kind: task.watchConfig?.kind, mode: task.watchConfig?.mode, every: task.watchConfig?.evaluationEveryTicks},
    {kind: 'report-provenance', mode: 'all-reports', every: 100}, 'watch-config-contract');
  const prior = (overview.reports ?? []).filter((r: Json) => ids(args.exerciseId, ['blue-r02', 'blue-r03']).includes(r.id));
  check(prior.length === 2 && prior.every((r: Json) => r.side === 'blue' && r.tick === 300 && r.tick < createdTick), 'prior-releases-not-visible');
  check(!(overview.reports ?? []).some((r: Json) => r.tick > createdTick), 'future-report-visible');
  equal(sorted(task.seenReportIds), ids(args.exerciseId, ['blue-r01', 'blue-r02', 'blue-r03']), 'baseline-not-prior-releases');
  check(updatesFor(overview, task.id).length === 0 && task.lastResult === null && task.sourceIds?.length === 0, 'pretended-earlier-observation');
  return {task, receipt};
}

const resolves = (overview: Json, id: string, side: string, tick: number) =>
  (overview.reports ?? []).find((r: Json) => r.id === id && r.side === side && r.tick <= tick);
const hasLink = (report: Json | undefined, kind: string, target: string) =>
  (report?.packet?.links ?? []).some((l: Json) => l.kind === kind && l.reportId === target);

/** Late alerts for exactly this task; undefined entries while not yet visible. Any mis-shaped update fails immediately. */
export function lateAlerts(overview: Json, task: {id: string; side: string; createdTick: number}, exerciseId: string) {
  const updates = updatesFor(overview, task.id), sid = (r: string) => storedId(exerciseId, r);
  check(updates.every(e => e.details.method === METHOD), 'paid-analysis-update-present');
  check(updates.every(e => e.tick > task.createdTick && e.details.observedTick === e.tick && e.side === task.side), 'update-predates-watch');
  check(!updates.some(e => (e.details.sourceIds ?? []).some((s: string) => s === sid('blue-r01') || s === sid('blue-r03'))), 'earlier-observation-cited');
  check(updates.every(e => e.tick === CORRECTION || e.tick === CONFLICT), 'unexpected-watch-update');
  check(new Set(updates.map(e => e.tick)).size === updates.length, 'duplicate-watch-update');
  const at600 = updates.find(e => e.tick === CORRECTION), at900 = updates.find(e => e.tick === CONFLICT);
  check(!at900 || at600, 'conflict-alert-without-correction-alert');
  for (const alert of [at600, at900].filter(Boolean) as Json[])
    check((alert.details.sourceIds ?? []).every((s: string) => resolves(overview, s, task.side, alert.tick)), 'alert-source-unresolved');
  if (at600) {
    equal(sorted(at600.details.sourceIds), ids(exerciseId, ['blue-r02', 'blue-r04', 'blue-r05']), 'correction-alert-sources');
    check(at600.summary.includes('supersedes') && !at600.summary.includes('unresolved conflict'), 'correction-alert-summary');
    check(resolves(overview, sid('blue-r04'), task.side, CORRECTION)?.supersedes === sid('blue-r02'), 'correction-lineage-mismatch');
  }
  if (at900) {
    equal(sorted(at900.details.sourceIds), ids(exerciseId, ['blue-r06', 'blue-r07']), 'conflict-alert-sources');
    check(at900.summary.includes('unresolved conflict'), 'conflict-alert-summary');
    check(hasLink(resolves(overview, sid('blue-r06'), task.side, CONFLICT), 'disputes', sid('blue-r05'))
      && hasLink(resolves(overview, sid('blue-r07'), task.side, CONFLICT), 'derived-from', sid('blue-r05')), 'conflict-lineage-mismatch');
  }
  return {at600, at900};
}

/** Task trace: one creation at createdTick, then exactly the two free alerts. */
export function verifyTrace(trace: Json, taskId: string, createdTick: number, alertIds: string[]) {
  check(trace.task?.id === taskId && trace.task.modelEnabled === false && Array.isArray(trace.trace), 'task-trace-contract');
  equal(trace.trace.map((e: Json) => [e.kind, e.tick, e.kind === 'staff_update' ? e.method : null, e.kind === 'staff_update' ? e.id : null]),
    [['task_created', createdTick, null, null], ['staff_update', CORRECTION, METHOD, alertIds[0]], ['staff_update', CONFLICT, METHOD, alertIds[1]]], 'task-trace-sequence');
}

/** Public output may never contain a secret or raw identity. */
export function assertPublicSafe(text: string, secrets: string[]) {
  check(secrets.filter(s => s.length >= 4).every(s => !text.includes(s)), 'secret-in-public-output');
  check(!/"(password|access_token|token|authorization|cookie)"\s*:/i.test(text), 'secret-field-in-public-output');
}

// ---------------------------------------------------------------------------
// Native run (never reached by --self-test)
// ---------------------------------------------------------------------------

async function qualify(argv: string[]) {
  const {version, attempt: label} = attemptArguments(argv);
  check(argv.length === 2, 'usage-version-attempt-label');
  // Configuration is read as data before any file is reserved; the guard exists before any client does.
  const binding = JSON.parse(fs.readFileSync('data/kamiwaza-binding.json', 'utf8'));
  check(typeof binding.apiBase === 'string' && typeof binding.workroom?.id === 'string', 'binding-config');
  const guard = newGuard(binding.apiBase, binding.workroom.id);
  const attempt = `${label}-${randomUUID()}`;
  const artifact = `evidence/platform/late-watch-${attempt}.json`, observedPath = `data/platform/late-watch-${attempt}-observed.json`;
  const files = [artifact, observedPath];
  for (const file of files) { fs.mkdirSync(path.dirname(file), {recursive: true}); check(!fs.existsSync(file), 'attempt-file-exists'); }
  const fds = new Map<string, number>();
  try { for (const file of files) fds.set(file, fs.openSync(file, 'wx', 0o600)); }
  catch (e) { for (const fd of fds.values()) fs.closeSync(fd); throw e; }
  const write = (file: string, data: unknown) => { const fd = fds.get(file)!; fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n', 0, 'utf8'); };
  const args: WatchArgs = {exerciseId: '', requestId: randomUUID(), title: TITLE};
  const exerciseName = `Fictional automated late MCP watch qualification ${version} ${attempt.slice(-8)}`;
  const proof: Json = {startedAt: new Date().toISOString(), version, attempt, scenarioId: SCENARIO, packetId: PACKET, exerciseName,
    fictional: true, automatedOperation: true, pairedPlayerTrial: false, humanValidated: false, tomoConversation: false, modelInference: false,
    transport: TRANSPORT, status: 'starting', requestId: args.requestId, title: TITLE, privateObserved: observedPath,
    limits: {activeDeadlineMs: ACTIVE_MS, activeRequestCap: ACTIVE_REQUESTS, cleanupRequestCap: CLEANUP_REQUESTS, exerciseCreates: 1,
      createWatchCalls: 1, createAfterTick: CREATE_AFTER, createGateTick: CREATE_GATE, giveUpTick: GIVE_UP, applicationRequestCap: 100, applicationUsdCap: 5},
    limitations: ['Direct MCP creation is component evidence for Tomo-style late delegation; it is not a Tomo conversation and proves nothing about model tool choice.',
      'Alerts are read from the Commander own-side overview; opposing-side records are outside this view.',
      'Automated fictional operation; no playability, learning or doctrine claim.']};
  const save = () => write(artifact, proof);
  const observed: Json = {};
  const secrets: string[] = [];
  let phase = 'preflight', owner: Awaited<ReturnType<typeof nativeAppClient>> | undefined, commander: typeof owner;
  let core: KamiwazaClient | undefined, token = '', entered = false, rpcId = 0, subject = '';
  const active = new AbortController(), activeEnd = Date.now() + ACTIVE_MS, activeTimer = setTimeout(() => active.abort(), ACTIVE_MS);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    try { permit(guard, init?.method ?? 'GET', href, init?.body, init?.headers); }
    catch (e) { proof.deniedRequest = {method: init?.method ?? 'GET', path: new URL(href).pathname}; throw e; }
    const signals = [AbortSignal.timeout(15000)];
    if (!guard.cleanup) signals.push(active.signal);
    if (init?.signal) signals.push(init.signal);
    return nativeFetch(input, {...init, redirect: 'error', signal: AbortSignal.any(signals)});
  };
  const read = async (who: typeof owner, target: string, body?: unknown) => withDeadline(async signal =>
    (await who!.request(target, body, {signal})).json() as Promise<Json>, 15000, 'read-deadline');
  const rpc = (method: string, params: unknown) => withDeadline(async signal => {
    const r = await fetch(`${APP}/mcp`, {method: 'POST', signal, headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'x-workroom-id': binding.workroom.id}, body: JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method, params})});
    (proof.mcpRequests ??= []).push({method, status: r.status});
    check(r.status === 200 && !r.headers.has('set-cookie'), 'mcp-http-contract');
    return await r.json() as Json;
  }, 15000, `mcp-${method}-deadline`);
  try {
    save();
    const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
    const matches = Array.isArray(users) ? users.filter((u: Json) => u.role === 'commander') : [];
    const credential = matches.length === 1 && matches[0].username && matches[0].password ? {username: matches[0].username, password: matches[0].password} : null;
    if (Array.isArray(users)) for (const u of users) u.password = '';
    check(credential, 'commander-credentials');
    secrets.push(credential.password);

    try {
      phase = 'owner-login'; owner = await nativeAppClient();
      const build = await read(owner, '/replay-build.json');
      equal(build.version, version, 'deployed-version'); proof.build = build;
      const ownerStatus = await read(owner, '/api/native/status');
      check(ownerStatus.mode === 'kamiwaza' && ownerStatus.signedIn && typeof ownerStatus.identity?.subject === 'string', 'native-owner-required');
      proof.budgetBefore = budgetProjection((await read(owner, '/api/agents/tools')).budget);
      check(capsUnchanged(proof.budgetBefore), 'unexpected-budget-caps');

      phase = 'commander-login'; commander = await nativeAppClient(credential);
      const status = await read(commander, '/api/native/status');
      check(status.mode === 'kamiwaza' && status.signedIn && status.identity?.role === 'commander' && typeof status.identity.subject === 'string'
        && status.identity.subject !== ownerStatus.identity.subject, 'native-commander-required');
      subject = status.identity.subject; secrets.push(subject);
      proof.subjectSha256 = sha(subject); proof.ownerSubjectSha256 = sha(ownerStatus.identity.subject);

      // Same member identity through the platform: bearer for MCP, never persisted.
      phase = 'member-bearer';
      core = new KamiwazaClient({apiBase: binding.apiBase, getToken: () => token, workroomId: binding.workroom.id, forwardedHost: 'kamiwaza-harness.localhost'});
      token = (await withDeadline(() => core!.login(credential), 15000, 'member-login-deadline')).data.access_token;
      secrets.push(token);
      phase = 'member-enter';
      const entrance = await withDeadline(() => core!.enterWorkroom(binding.workroom.id), 15000, 'workroom-enter-deadline'); entered = true;
      if (entrance.data.access_token) { token = entrance.data.access_token; secrets.push(token); }
    } finally { credential.password = ''; }
    proof.memberBearerAcquired = true;

    phase = 'exercise-create'; proof.exerciseCreation = 'pending'; save();
    const exercise = await withDeadline(async signal => (await owner!.request('/api/exercises', {name: exerciseName, scenarioId: SCENARIO}, {signal})).json() as Promise<Json>, 30000, 'exercise-create-deadline');
    check(UUID.test(exercise.id) && exercise.name === exerciseName && exercise.status === 'running' && exercise.humanSide === 'blue', 'exercise-create-contract');
    args.exerciseId = exercise.id; guard.exerciseId = exercise.id;
    proof.exerciseId = exercise.id; proof.exerciseCreation = 'created'; proof.humanSide = exercise.humanSide; save();

    phase = 'commander-join';
    const invitation = await read(owner, '/api/team/code', {});
    if (typeof invitation.code === 'string') secrets.push(invitation.code);
    try { equal((await read(commander, '/api/team/join', {code: invitation.code})).exerciseId, args.exerciseId, 'join-exercise-mismatch'); }
    finally { invitation.code = ''; }

    phase = 'catalog';
    const catalog = await rpc('tools/list', {});
    const tool = (catalog.result?.tools ?? []).find((t: Json) => t.name === 'create_watch');
    check(tool?.annotations?.readOnlyHint === false && tool.annotations.idempotentHint === true, 'create-watch-not-exposed');

    phase = 'wait-for-tick300-releases';
    let overview = await read(commander, '/api/overview'), polls = 1;
    while (!readyToCreate(overview, args.exerciseId)) {
      check(activeEnd - Date.now() > 4000, 'creation-deadline');
      await delay(Number(overview.state?.tick) < 270 ? 2000 : 400, undefined, {signal: active.signal});
      overview = await read(commander, '/api/overview'); polls++;
    }
    proof.preCreation = {tick: overview.state.tick, polls, priorReleasesVisible: true, tasks: 0, receipts: 0};

    // Exactly one create_watch. Uncertainty is recorded, never retried.
    phase = 'create-watch'; proof.watchCreation = 'pending'; save();
    const response = await rpc('tools/call', {name: 'create_watch', arguments: args});
    proof.watchCreation = 'responded'; save();
    const created = verifyCreated(response, args);
    guard.taskId = created.task.id; observed.created = created; write(observedPath, observed);
    proof.created = {taskId: created.task.id, createdTick: created.task.createdTick, receiptEventId: created.receipt.eventId,
      receiptEventIdRecomputed: receiptEventId(args.exerciseId, subject, args.requestId) === created.receipt.eventId,
      taskCreatedEventId: created.provenance.taskCreatedEventId, modelEnabled: false, replayed: false, paidInference: 'off-at-creation'};
    proof.watchCreation = 'created'; save();

    // Read immediately: the receipt kind is only in the overview's recent-event window.
    phase = 'baseline';
    overview = await read(commander, '/api/overview');
    const baseline = verifyBaseline(overview, created, args, subject);
    observed.task = baseline.task; observed.receipt = baseline.receipt; write(observedPath, observed);
    proof.baseline = {taskOwnerIsCommander: true, receiptUuidLinked: true, paidAnalysisOff: true, unrelatedTasks: 0,
      priorReleasesSeenNotAlerted: ['blue-r01', 'blue-r02', 'blue-r03'], updatesAtCreation: 0, readTick: overview.state?.tick}; save();

    phase = 'late-alerts';
    const task = {id: created.task.id, side: created.task.side, createdTick: created.task.createdTick};
    let alerts = lateAlerts(overview, task, args.exerciseId); polls = 1;
    while (!alerts.at900) {
      check(Number(overview.state?.tick) < GIVE_UP, alerts.at600 ? 'conflict-alert-missing' : 'correction-alert-missing');
      check(activeEnd - Date.now() > 4000, 'late-alert-deadline');
      await delay(3000, undefined, {signal: active.signal});
      overview = await read(commander, '/api/overview'); polls++;
      check(overview.activeId === args.exerciseId && overview.playbackTick === null && overview.tasks?.length === 1
        && overview.tasks[0].id === task.id && overview.tasks[0].modelEnabled === false, 'unrelated-task-or-paid-analysis');
      alerts = lateAlerts(overview, task, args.exerciseId);
    }
    const {at600, at900} = alerts as {at600: Json; at900: Json};
    const trace = await read(commander, `/api/agents/tasks/${task.id}`);
    verifyTrace(trace, task.id, task.createdTick, [at600.id, at900.id]);
    observed.alerts = [at600, at900]; observed.trace = trace; write(observedPath, observed);
    const view = (a: Json) => ({id: a.id, tick: a.tick, observedTick: a.details.observedTick, method: a.details.method, sourceIds: a.details.sourceIds, summary: a.summary});
    proof.alerts = {correction: view(at600), conflict: view(at900), polls, traceKinds: trace.trace.map((e: Json) => `${e.kind}@${e.tick}`),
      sourcesResolvedInCommanderReports: true, correctionSupersedes: 'blue-r04 → blue-r02', conflictLinks: 'blue-r06 disputes blue-r05; blue-r07 derived-from blue-r05'};
    proof.status = 'qualified-facts-main-review-pending';
  } catch (e) {
    proof.failure = {phase, code: errorCode(e)};
    proof.status = proof.watchCreation === 'pending' ? 'watch-creation-uncertain'
      : proof.exerciseCreation === 'pending' ? 'exercise-creation-uncertain' : 'qualification-incomplete';
    if (proof.exerciseCreation === 'pending') proof.exerciseCreation = 'uncertain';
    if (proof.watchCreation === 'pending') proof.watchCreation = 'uncertain';
    process.exitCode = 1;
  } finally {
    guard.cleanup = true; clearTimeout(activeTimer); active.abort();
    const step = async (name: string, run: () => Promise<unknown>) => {
      try { await withDeadline(() => run(), CLEANUP_STEP_MS, `${name}-deadline`); return true; }
      catch (e) { (proof.cleanupFailures ??= []).push({step: name, code: errorCode(e)}); process.exitCode = 1; return false; }
    };
    if (owner) {
      // End only this attempt's exercise; an uncertain creation is reconciled by its unique name, never recreated.
      if (!args.exerciseId && proof.exerciseCreation === 'uncertain') await step('reconcile-exercise', async () => {
        const rows = ((await read(owner, '/api/overview')).exercises ?? []).filter((e: Json) => e.name === exerciseName);
        proof.exerciseCreationReconciled = rows.length === 1 ? 'found' : rows.length === 0 ? 'not-visible' : 'ambiguous';
        if (rows.length === 1) { args.exerciseId = guard.exerciseId = proof.exerciseId = rows[0].id; equal((await read(owner, '/api/select', {exerciseId: args.exerciseId})).selected, args.exerciseId, 'reconcile-select'); }
      });
      if (args.exerciseId) proof.ended = await step('end-exercise', async () => equal((await read(owner, `/api/exercises/${args.exerciseId}/finish`, {})).status, 'completed', 'finish-contract'));
      if (proof.budgetBefore) await step('budget-after', async () => {
        proof.budgetAfter = budgetProjection((await read(owner, '/api/agents/tools')).budget);
        proof.newRequests = proof.budgetAfter.requestsUsed - proof.budgetBefore.requestsUsed;
        check(capsUnchanged(proof.budgetAfter) && proof.newRequests === 0 && proof.budgetAfter.committedUsd === proof.budgetBefore.committedUsd, 'unexpected-paid-usage');
      });
    }
    proof.workroomLeft = core && entered ? await step('workroom-leave', () => core!.leaveWorkroom()) : 'not-entered';
    token = '';
    proof.commanderClosed = commander ? await step('commander-logout', () => commander!.close()) : 'not-opened';
    proof.ownerClosed = owner ? await step('owner-logout', () => owner!.close()) : 'not-opened';
    globalThis.fetch = nativeFetch;
    Object.assign(proof, {requests: guard.requests, cleanupRequests: guard.cleanupRequests, mutationCounts: guard.counts, finishedAt: new Date().toISOString()});
    proof.exitCode = process.exitCode === 1 ? 1 : 0;
    if (proof.exitCode === 1 && proof.status === 'qualified-facts-main-review-pending') proof.status = 'facts-matched-cleanup-incomplete';
    const summary = {artifact, status: proof.status, failure: proof.failure, exerciseId: proof.exerciseId, ended: proof.ended,
      newRequests: proof.newRequests, cleanupFailures: proof.cleanupFailures, exitCode: proof.exitCode};
    try {
      try { assertPublicSafe(JSON.stringify(proof), secrets); }
      catch { for (const k of Object.keys(proof)) if (!['status', 'failure', 'attempt', 'version', 'exerciseId', 'ended', 'exitCode'].includes(k)) delete proof[k];
        proof.status = 'public-proof-redacted-secret-detected'; proof.exitCode = 1; process.exitCode = 1; }
      save();
    } finally { for (const fd of fds.values()) fs.closeSync(fd); secrets.length = 0; subject = ''; }
    console.log(JSON.stringify({...summary, status: proof.status, exitCode: proof.exitCode}));
  }
}

// ---------------------------------------------------------------------------
// Offline self-test: zero native calls
// ---------------------------------------------------------------------------

export async function selfTest() {
  let nativeCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { nativeCalls++; throw new Error('self-test must not call the network'); };
  try {
    const subject = 'commander-subject', exerciseId = '11111111-2222-4333-8444-555555555555', sid = (r: string) => storedId(exerciseId, r);
    const args: WatchArgs = {exerciseId, requestId: '66666666-7777-4888-9999-000000000000', title: TITLE};
    const eventId = receiptEventId(exerciseId, subject, args.requestId), createdTick = 342, taskId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const created = {task: {id: taskId, kind: 'provenance-watch', phase: 'baseline', modelEnabled: false, side: 'blue', title: TITLE, interpretation: 'x', createdTick},
      receipt: {requestId: args.requestId, eventId, fingerprint: watchFingerprint(exerciseId, TITLE), replayed: false},
      provenance: {exerciseId, exerciseKind: 'live', taskCreatedEventId: 'created-event', fiction: 'Fictional abstract exercise', paidInference: 'off-at-creation'}};
    const rpcOk = {jsonrpc: '2.0', id: 2, result: {isError: false, structuredContent: created}};

    // 1. Creation contract and the strictly-after-300, before-600 window.
    assert.equal(verifyCreated(rpcOk, args).task.id, taskId);
    const withTask = (patch: Json) => ({...rpcOk, result: {...rpcOk.result, structuredContent: {...created, task: {...created.task, ...patch}}}});
    assert.throws(() => verifyCreated(withTask({createdTick: 300}), args), /watch-not-created-after-tick300/);
    assert.throws(() => verifyCreated(withTask({createdTick: 46}), args), /watch-not-created-after-tick300/);
    assert.throws(() => verifyCreated(withTask({createdTick: 600}), args), /watch-created-at-or-after-tick600/);
    assert.throws(() => verifyCreated(withTask({modelEnabled: true}), args), /returned-task-contract/);
    assert.throws(() => verifyCreated({...rpcOk, result: {...rpcOk.result, structuredContent: {...created, receipt: {...created.receipt, replayed: true}}}}, args), /returned-receipt-contract/);
    assert.throws(() => verifyCreated({jsonrpc: '2.0', id: 2, error: {code: -32602}}, args), /create-watch-not-successful/);
    assert.throws(() => verifyCreated({jsonrpc: '2.0', id: 2, result: {isError: true, content: []}}, args), /create-watch-not-successful/);

    // 2. Baseline: prior releases seen, never alerted.
    const report = (r: string, tick: number, extra: Json = {}) => ({id: sid(r), side: 'blue', tick, packet: {reportId: r, links: []}, ...extra});
    const reports300 = [report('blue-r01', 0), report('blue-r02', 300), report('blue-r03', 300, {packet: {reportId: 'blue-r03', links: [{kind: 'derived-from', reportId: sid('blue-r02')}]}})];
    const receipt = {id: eventId, kind: 'mcp_watch_request', actor: subject, tick: createdTick, side: 'blue',
      details: {requestId: args.requestId, fingerprint: created.receipt.fingerprint, taskId, taskCreatedEventId: 'created-event'}};
    const liveTask = {id: taskId, owner: subject, modelEnabled: false, title: TITLE, side: 'blue', createdTick, lastResult: null, sourceIds: [],
      seenReportIds: reports300.map(r => r.id), watchConfig: {schema: 'replay.watch-config/1', kind: 'report-provenance', mode: 'all-reports', evaluationEveryTicks: 100}};
    const base: Json = {activeId: exerciseId, playbackTick: null, state: {tick: 344}, reports: reports300, tasks: [liveTask],
      timeline: [{id: 'created-event', kind: 'task_created', tick: createdTick, details: {taskId}}, receipt]};
    assert.equal(verifyBaseline(base, created, args, subject).receipt.id, eventId);
    const baseFails = (patch: (o: Json) => void, code: RegExp) => { const o = structuredClone(base); patch(o); assert.throws(() => verifyBaseline(o, created, args, subject), code); };
    baseFails(o => o.timeline.push({id: 'u', kind: 'staff_update', tick: 300, side: 'blue', details: {taskId, sourceIds: [sid('blue-r02')], method: METHOD, observedTick: 300}}), /pretended-earlier-observation/);
    baseFails(o => { o.tasks[0].lastResult = 'Marsh released'; }, /pretended-earlier-observation/);
    baseFails(o => { o.tasks[0].seenReportIds.pop(); }, /baseline-not-prior-releases/);
    baseFails(o => { delete o.tasks[0].seenReportIds; }, /baseline-not-prior-releases/);
    baseFails(o => { o.reports = o.reports.slice(0, 1); }, /prior-releases-not-visible/);
    baseFails(o => { o.reports.push(report('blue-r04', 600)); }, /future-report-visible/);
    baseFails(o => { o.timeline[0].tick = 300; }, /creation-tick-mismatch/);
    baseFails(o => { o.tasks[0].watchConfig.mode = 'supersessions'; }, /watch-config-contract/);
    baseFails(o => { o.tasks.push({...o.tasks[0], id: 'other'}); }, /unrelated-or-missing-task/);
    baseFails(o => { o.tasks[0].owner = 'someone-else'; }, /persisted-task-identity/);
    baseFails(o => { o.timeline[1].id = randomUUID(); }, /receipt-not-uuid-linked/);
    baseFails(o => { o.timeline = o.timeline.filter((e: Json) => e.kind !== 'mcp_watch_request'); }, /receipt-not-visible/);

    // 3. Creation gate: waits for the 300 releases, refuses a missed window or pre-existing watch.
    const pre = {activeId: exerciseId, playbackTick: null, state: {tick: 305}, reports: reports300, tasks: [], timeline: []};
    assert.equal(readyToCreate(pre, exerciseId), true);
    assert.equal(readyToCreate({...pre, state: {tick: 299}, reports: reports300.slice(0, 1)}, exerciseId), false);
    assert.equal(readyToCreate({...pre, state: {tick: 300}}, exerciseId), false);
    assert.throws(() => readyToCreate({...pre, state: {tick: 450}}, exerciseId), /creation-window-missed/);
    assert.throws(() => readyToCreate({...pre, tasks: [liveTask]}, exerciseId), /task-exists-before-creation/);
    assert.throws(() => readyToCreate({...pre, timeline: [receipt]}, exerciseId), /receipt-exists-before-creation/);

    // 4. Late alerts: exact correction/conflict sources, independent lineage, nothing retroactive.
    const reportsAll = [...reports300,
      report('blue-r04', 600, {supersedes: sid('blue-r02'), packet: {reportId: 'blue-r04', links: [{kind: 'supersedes', reportId: sid('blue-r02')}]}}),
      report('blue-r05', 600), report('blue-r06', 900, {packet: {reportId: 'blue-r06', links: [{kind: 'disputes', reportId: sid('blue-r05')}]}}),
      report('blue-r07', 900, {packet: {reportId: 'blue-r07', links: [{kind: 'derived-from', reportId: sid('blue-r05')}]}})];
    const a600 = {id: 'alert-600', kind: 'staff_update', tick: 600, side: 'blue', summary: 'Marsh correction (tick 600) supersedes Marsh reserve estimate (tick 300); Liaison (tick 600) released.',
      details: {taskId, observedTick: 600, method: METHOD, sourceIds: [sid('blue-r04'), sid('blue-r05'), sid('blue-r02')]}};
    const a900 = {id: 'alert-900', kind: 'staff_update', tick: 900, side: 'blue', summary: 'Tidewell (tick 900) released · unresolved conflict; Causeway post (tick 900) released · unresolved conflict.',
      details: {taskId, observedTick: 900, method: METHOD, sourceIds: [sid('blue-r06'), sid('blue-r07')]}};
    const late: Json = {...base, state: {tick: 905}, reports: reportsAll, timeline: [...base.timeline, a600, a900]};
    const t = {id: taskId, side: 'blue', createdTick};
    const both = lateAlerts(late, t, exerciseId);
    assert.equal(both.at600?.id, 'alert-600'); assert.equal(both.at900?.id, 'alert-900');
    assert.deepEqual(lateAlerts({...base, reports: reports300}, t, exerciseId), {at600: undefined, at900: undefined});
    assert.equal(lateAlerts({...late, timeline: [...base.timeline, a600]}, t, exerciseId).at900, undefined);
    const lateFails = (patch: (o: Json) => void, code: RegExp) => { const o = structuredClone(late); patch(o); assert.throws(() => lateAlerts(o, t, exerciseId), code); };
    lateFails(o => o.timeline.splice(2, 0, {...a600, id: 'retro', tick: 300, details: {...a600.details, observedTick: 300, sourceIds: [sid('blue-r02'), sid('blue-r03')]}}), /update-predates-watch/);
    lateFails(o => { o.timeline[2].details.sourceIds.push(sid('blue-r03')); }, /earlier-observation-cited/);
    lateFails(o => { o.timeline[2].details.sourceIds = [sid('blue-r04'), sid('blue-r05')]; }, /correction-alert-sources/);
    lateFails(o => { o.timeline[3].details.sourceIds.pop(); }, /conflict-alert-sources/);
    lateFails(o => { o.timeline[3].details.method = 'model staff agent'; }, /paid-analysis-update-present/);
    lateFails(o => { o.timeline.push({...a600, id: 'x', tick: 700, details: {...a600.details, observedTick: 700}}); }, /unexpected-watch-update/);
    lateFails(o => { o.timeline.push({...a600, id: 'dup'}); }, /duplicate-watch-update/);
    lateFails(o => { o.timeline.splice(2, 1); }, /conflict-alert-without-correction-alert/);
    lateFails(o => { o.reports = o.reports.filter((r: Json) => r.id !== sid('blue-r05')); }, /alert-source-unresolved/);
    lateFails(o => { o.reports.find((r: Json) => r.id === sid('blue-r06')).side = 'red'; }, /alert-source-unresolved/);
    lateFails(o => { delete o.reports.find((r: Json) => r.id === sid('blue-r04')).supersedes; }, /correction-lineage-mismatch/);
    lateFails(o => { o.reports.find((r: Json) => r.id === sid('blue-r06')).packet.links = []; }, /conflict-lineage-mismatch/);
    lateFails(o => { o.timeline[3].summary = 'Tidewell released.'; }, /conflict-alert-summary/);
    lateFails(o => { o.timeline[2].summary += ' · unresolved conflict'; }, /correction-alert-summary/);

    // 5. Trace: creation then exactly the two free alerts.
    const trace = {task: {id: taskId, modelEnabled: false}, trace: [{id: 'created-event', kind: 'task_created', tick: createdTick, method: null},
      {id: 'alert-600', kind: 'staff_update', tick: 600, method: METHOD}, {id: 'alert-900', kind: 'staff_update', tick: 900, method: METHOD}]};
    verifyTrace(trace, taskId, createdTick, ['alert-600', 'alert-900']);
    assert.throws(() => verifyTrace({...trace, trace: [...trace.trace, {id: 'm', kind: 'staff_model_decision', tick: 901}]}, taskId, createdTick, ['alert-600', 'alert-900']), /task-trace-sequence/);
    assert.throws(() => verifyTrace({...trace, task: {id: taskId, modelEnabled: true}}, taskId, createdTick, ['alert-600', 'alert-900']), /task-trace-contract/);

    // 6. Request guard: origins, one-shot mutations, only this exercise, finish/select only in cleanup.
    const g = newGuard('https://platform.example.test/api', 'workroom-1');
    const mcp = (body: Json) => JSON.stringify({jsonrpc: '2.0', id: 1, ...body});
    assert.throws(() => permit(g, 'GET', 'https://elsewhere.test/api/overview'), /origin-not-permitted/);
    permit(g, 'POST', `${APP}/api/native/login`); permit(g, 'POST', `${APP}/api/native/login`);
    assert.throws(() => permit(g, 'POST', `${APP}/api/native/login`), /app-login-retry-forbidden/);
    permit(g, 'POST', 'https://platform.example.test/api/auth/token');
    assert.throws(() => permit(g, 'POST', 'https://platform.example.test/api/auth/token'), /member-token-retry-forbidden/);
    const authHeaders = {'x-forwarded-method':'POST','x-forwarded-uri':'/api/workrooms/workroom-1/enter'};
    permit(g, 'GET', 'https://platform.example.test/api/auth/forward/validate', undefined, authHeaders);
    assert.throws(() => permit(g, 'GET', 'https://platform.example.test/api/auth/forward/validate', undefined, {...authHeaders,'x-forwarded-uri':'/api/extensions/replay'}), /validation-target-not-permitted/);
    assert.throws(() => permit(g, 'GET', 'https://platform.example.test/api/auth/forward/validate', undefined, {...authHeaders,'x-forwarded-method':'DELETE'}), /validation-method-not-permitted/);
    permit(g, 'POST', 'https://platform.example.test/api/workrooms/workroom-1/enter');
    assert.throws(() => permit(g, 'POST', 'https://platform.example.test/api/workrooms/other/enter'), /route-not-permitted/);
    assert.throws(() => permit(g, 'POST', `${APP}/mcp`, mcp({method: 'tools/list'})), /route-phase/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/team/code`, '{}'), /route-phase/);
    permit(g, 'POST', `${APP}/api/exercises`, '{}'); g.exerciseId = exerciseId;
    assert.throws(() => permit(g, 'POST', `${APP}/api/exercises`, '{}'), /route-phase|retry-forbidden/);
    permit(g, 'POST', `${APP}/mcp`, mcp({method: 'tools/list'}));
    assert.throws(() => permit(g, 'POST', `${APP}/mcp`, mcp({method: 'tools/call', params: {name: 'create_watch', arguments: {...args, exerciseId: 'old-exercise'}}})), /mcp-call-not-permitted/);
    assert.throws(() => permit(g, 'POST', `${APP}/mcp`, mcp({method: 'tools/call', params: {name: 'get_exercise_state', arguments: {exerciseId}}})), /mcp-call-not-permitted/);
    permit(g, 'POST', `${APP}/mcp`, mcp({method: 'tools/call', params: {name: 'create_watch', arguments: args}}));
    assert.throws(() => permit(g, 'POST', `${APP}/mcp`, mcp({method: 'tools/call', params: {name: 'create_watch', arguments: args}})), /create-watch-retry-forbidden/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/exercises/${exerciseId}/finish`, '{}'), /finish-once-in-cleanup/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/exercises/old-exercise/finish`, '{}'), /route-not-permitted/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/commands`, '{}'), /route-not-permitted/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/agents/tasks/${taskId}/model`, '{"enabled":true}'), /route-not-permitted/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/reports/inject`, '{}'), /route-not-permitted/);
    assert.throws(() => permit(g, 'GET', `${APP}/api/agents/tasks/${taskId}`), /route-not-permitted/);
    g.taskId = taskId; permit(g, 'GET', `${APP}/api/agents/tasks/${taskId}`);
    assert.throws(() => permit(g, 'GET', `${APP}/api/overview?exerciseId=old`), /query-not-permitted/);
    g.cleanup = true;
    assert.throws(() => permit(g, 'POST', `${APP}/api/select`, JSON.stringify({exerciseId: 'old-exercise'})), /select-other-exercise/);
    permit(g, 'POST', `${APP}/api/exercises/${exerciseId}/finish`, '{}');
    assert.throws(() => permit(g, 'POST', `${APP}/api/exercises/${exerciseId}/finish`, '{}'), /finish-retry-forbidden/);
    assert.throws(() => permit(g, 'POST', `${APP}/api/exercises`, '{}'), /route-phase/);
    permit(g, 'GET', 'https://platform.example.test/api/auth/forward/validate', undefined, {'x-forwarded-method':'POST','x-forwarded-uri':'/api/workrooms/leave'});
    permit(g, 'POST', 'https://platform.example.test/api/workrooms/leave');
    const capped = newGuard('https://platform.example.test/api', 'w');
    for (let i = 0; i < ACTIVE_REQUESTS; i++) permit(capped, 'GET', `${APP}/api/overview`);
    assert.throws(() => permit(capped, 'GET', `${APP}/api/overview`), /request-cap/);

    // 7. Public output safety and labelling. Diagnostic error codes are not invitation secrets.
    assertPublicSafe(JSON.stringify({failure:{code:'request-route-not-permitted'}}), ['invite-1234']);
    assert.throws(() => assertPublicSafe(JSON.stringify({note:'invite-1234'}), ['invite-1234']), /secret-in-public-output/);
    assertPublicSafe(JSON.stringify({status: 'ok', subjectSha256: sha(subject)}), ['bearer-abc123', subject]);
    assert.throws(() => assertPublicSafe(JSON.stringify({note: 'bearer-abc123'}), ['bearer-abc123']), /secret-in-public-output/);
    assert.throws(() => assertPublicSafe(JSON.stringify({access_token: 'x'}), []), /secret-field-in-public-output/);
    assert.throws(() => assertPublicSafe(JSON.stringify({actor: subject}), [subject]), /secret-in-public-output/);
    assert.match(TRANSPORT, /not a Tomo conversation/); assert.match(TRANSPORT, /no model inference/);

    assert.equal(nativeCalls, 0);
    console.log('Offline late-watch checks passed: creation strictly after 300 and before 600, baseline without retroactive alerts, exact 600 correction and 900 conflict sources with independent lineage, free-only trace, one-shot guard scoped to the new exercise, secret-free output, non-Tomo label. Native calls: 0.');
  } finally { globalThis.fetch = realFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') await selfTest();
    else await qualify(process.argv.slice(2));
  } catch (e) { console.error(JSON.stringify({status: 'startup-failed', code: errorCode(e)})); process.exitCode = 1; }
}
