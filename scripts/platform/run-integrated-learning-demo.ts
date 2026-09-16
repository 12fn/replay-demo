/** Main-dispatched only: VERSION ATTEMPT_LABEL. One AUTOMATED, fictional integrated learning demonstration; --self-test is offline.
 * Contract: docs/process/integrated-learning-demo-contract.md. Not human validation, not AI-versus-AI play, no retries.
 * Chain: Commander-owned exercise → Intelligence assessment → one Tomo watch input → scripted Blue orders (authored reasons)
 * → correction/conflict alerts → end → one Luna debrief → one automated instructor correction → one branch practice order.
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
import {verifyPersisted, verifyWatchEvidence, watchMessage, type WatchArgs} from './qualify-tomo-watch';

const APP = 'http://127.0.0.1:5183';
const WATCH = 'kz_replay-tools_replay_create_watch', METHOD = 'deterministic provenance watcher';
const TITLE = 'Monitor report provenance', SCENARIO = 'crosscurrent-evidence/1', PACKET = 'crosscurrent-changing-evidence/1';
const PREFIX = '/runtime/apps/replay-tomo/api/conversations';
const HELPER_RECEIPT = 'evidence/platform/tomo-staff-watch-agent-1.json';
const OBSERVER_RECEIPT = 'evidence/platform/tomo-observer-agent-1.json';
/** Absolute bounds. The game clock is never paused; these only bound how long this process waits. */
const TOTAL_MS = 900000, GAME_MS = 330000, TOMO_MS = 180000, DEBRIEF_MS = 150000, BRANCH_MS = 90000;
const READ_MS = 15000, OVERVIEW_MS = 20000, POST_MS = 30000, CLEANUP_STEP_MS = 15000, POLL_MS = 1500;
const ACTIVE_REQUESTS = 320, CLEANUP_REQUESTS = 16, STREAM_BYTES = 8_000_000;
const MIN_REQUESTS_LEFT = 4, REQUEST_CAP = 100, USD_CAP = 5;
/** Transparent scripted Blue baseline: 20% neutral expansion on a fixed ~120-tick cadence. */
const ORDER_EVERY = 120, MAX_ORDERS = 12, EXPANSION_SHARE = 0.2, BRANCH_SHARE = 0.1;
const CORRECTION = 600, CONFLICT = 900, D0_LAST_TICK = 560, D1_FIRST_TICK = 960, LATE_RELEASE = 1200;
const END_TICK = 1230, END_TICK_MAX = 1500;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AUTHORED = 'Authored demo prompt (automated scripted Blue baseline; not a model, player or human decision):';
const BRANCH_AUTHORED = 'Authored branch practice prompt (automated; not a model, player or human decision):';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, any>;
class Failure extends Error {}
class GuardViolation extends Failure {}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
const errorCode = (e: unknown) => e instanceof Failure ? e.message : 'operation-or-contract-failed';
const equal = (a: unknown, b: unknown, code: string) => { try { assert.deepEqual(a, b); } catch { throw new Failure(code); } };
const sorted = (v: unknown) => Array.isArray(v) ? [...v].sort() : v;
const budgetProjection = (v: Json) => ({requestsUsed: v?.requestsUsed, maxRequests: v?.maxRequests, committedUsd: v?.committedUsd, maxUsd: v?.maxUsd});

export const storedId = (exerciseId: string, report: string) => `${exerciseId}:${PACKET}:${report}`;
export const ids = (exerciseId: string, reports: string[]) => reports.map(r => storedId(exerciseId, r)).sort();

/** Caps must be exactly 100 requests / USD 5, never raised; `left` requests must remain against the global ledger. */
export function budgetAllows(b: Json, left: number) {
  return b?.maxRequests === REQUEST_CAP && b?.maxUsd === USD_CAP && Number.isInteger(b.requestsUsed) && b.requestsUsed >= 0
    && Number.isFinite(b.committedUsd) && b.committedUsd >= 0 && b.committedUsd < USD_CAP && REQUEST_CAP - b.requestsUsed >= left;
}

// ---------------------------------------------------------------------------
// Request guard: native origin, exact routes, phase-bound one-shot mutations, only this attempt's exercise/branch.
// ---------------------------------------------------------------------------

export type Phase = 'setup' | 'original' | 'review' | 'branch';
export interface Guard {
  cleanup: boolean; phase: Phase; exerciseId: string; branchId: string; roomId: string; taskId: string; debriefEventId: string;
  requests: number; cleanupRequests: number; counts: Record<string, number>;
}
export const newGuard = (): Guard => ({cleanup: false, phase: 'setup', exerciseId: '', branchId: '', roomId: '', taskId: '', debriefEventId: '',
  requests: 0, cleanupRequests: 0, counts: {}});
const deny = (ok: unknown, code: string) => { if (!ok) throw new GuardViolation(code); };
const bump = (g: Guard, key: string, max: number) => deny((g.counts[key] = (g.counts[key] ?? 0) + 1) <= max, `${key}-retry-forbidden`);
const bodyJson = (body: unknown): Json => { try { return typeof body === 'string' ? JSON.parse(body) ?? {} : {}; } catch { return {}; } };

/** Throws before a disallowed request leaves the process. Returns the per-request timeout. Mutates counters. */
export function permit(g: Guard, method: string, href: string, body?: unknown): number {
  const url = new URL(href), p = url.pathname, q = url.searchParams, active = !g.cleanup;
  deny(url.origin === APP, 'native-origin-only');
  if (g.cleanup) deny(++g.cleanupRequests <= CLEANUP_REQUESTS, 'cleanup-request-cap'); else deny(++g.requests <= ACTIVE_REQUESTS, 'request-cap');
  const room = g.roomId ? `${PREFIX}/${g.roomId}` : null, keys = [...q.keys()].sort().join();
  if (method === 'GET') {
    if (room && p === `${room}/events`) { deny(active && url.search === '?after=0', 'stream-route'); bump(g, 'stream', 1); return TOMO_MS + 30000; }
    if (room && p === room) { deny(g.cleanup && !url.search, 'room-detail-cleanup-only'); return READ_MS; }
    if (p === '/api/action-options') {
      deny(active && keys === 'exerciseId' && !!q.get('exerciseId') && [g.exerciseId, g.branchId].includes(q.get('exerciseId')!), 'action-options-scope');
      return READ_MS;
    }
    if (p === '/api/learning/reviews') {
      deny(active && !!g.debriefEventId && keys === 'eventId,exerciseId,hash' && q.get('exerciseId') === g.exerciseId && q.get('eventId') === g.debriefEventId, 'reviews-scope');
      return READ_MS;
    }
    deny(!url.search, 'query-not-permitted');
    const reads = ['/replay-build.json', '/api/native/status', '/api/agents/tools', '/api/tomo/status', '/api/overview', g.exerciseId && '/api/team',
      g.taskId && `/api/agents/tasks/${g.taskId}`, g.debriefEventId && `/api/learning/debrief/${g.debriefEventId}`, g.exerciseId && `/api/record/${g.exerciseId}`];
    deny(reads.includes(p), 'request-route-not-permitted');
    return p === '/api/overview' ? OVERVIEW_MS : READ_MS;
  }
  deny(method === 'POST' && !url.search, 'request-method-not-permitted');
  const b = bodyJson(body), phase = (ok: boolean) => deny(active && ok, 'route-phase');
  switch (p) {
    case '/api/native/login': phase(g.phase === 'setup'); bump(g, 'login', 3); return POST_MS;
    case '/api/native/logout': deny(g.cleanup, 'logout-cleanup-only'); bump(g, 'logout', 3); return READ_MS;
    case '/api/exercises': phase(g.phase === 'setup' && !g.exerciseId); bump(g, 'exercise-create', 1); return POST_MS;
    case '/api/team/code': phase(g.phase === 'setup' && !!g.exerciseId); bump(g, 'team-code', 1); return READ_MS;
    case '/api/team/join': phase(g.phase === 'setup' && !!g.exerciseId); bump(g, 'team-join', 1); return READ_MS;
    case '/api/select':
      deny(!!b.exerciseId && [g.exerciseId, g.branchId].includes(b.exerciseId), 'select-other-exercise');
      bump(g, g.cleanup ? 'cleanup-select' : 'select', 2); return READ_MS;
    case PREFIX: phase(g.phase === 'setup' && !g.roomId); bump(g, 'room', 1); return POST_MS;
    case '/api/learning/assessment': phase(g.phase === 'original' && b.exerciseId === g.exerciseId); bump(g, 'assessment', 1); return POST_MS;
    case '/api/commands':
      phase((g.phase === 'original' || g.phase === 'branch') && b.side === 'blue');
      bump(g, g.phase === 'branch' ? 'branch-command' : 'command', g.phase === 'branch' ? 1 : MAX_ORDERS); return POST_MS;
    case '/api/learning/debrief': phase(g.phase === 'review' && !!g.debriefEventId && b.eventId === g.debriefEventId); bump(g, 'debrief', 1); return DEBRIEF_MS;
    case '/api/learning/reviews': phase(g.phase === 'review' && b.exerciseId === g.exerciseId && b.eventId === g.debriefEventId); bump(g, 'review', 1); return POST_MS;
    case '/api/branches': phase(g.phase === 'review' && !g.branchId && b.side === 'blue'); bump(g, 'branch', 1); return POST_MS;
  }
  if (room && p === `${room}/inputs`) { phase(g.phase === 'original'); bump(g, 'input', 1); return POST_MS; }
  const finish = p.match(/^\/api\/exercises\/([^/]+)\/finish$/)?.[1];
  if (finish && (finish === g.exerciseId || finish === g.branchId)) {
    // One active end per run, plus at most one bounded cleanup end if the active one never confirmed.
    bump(g, `${g.cleanup ? 'cleanup-finish' : 'finish'}:${finish === g.exerciseId ? 'original' : 'branch'}`, 1); return READ_MS;
  }
  throw new GuardViolation('request-route-not-permitted');
}

// ---------------------------------------------------------------------------
// Offline-checkable acceptance functions
// ---------------------------------------------------------------------------

/** True when an owned tile borders passable-looking unclaimed land in the overview's full map. The engine validator still governs. */
export function neutralFrontier(state: Json, side: string): boolean {
  const player = state?.players?.find((p: Json) => p.side === side);
  const {width, height, owners, land} = state ?? {};
  if (!player?.alive || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Array.isArray(owners) || !Array.isArray(land)
    || owners.length !== width * height || land.length !== owners.length) return false;
  for (let i = 0; i < owners.length; i++) {
    if (owners[i] !== player.smallId) continue;
    const x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width])
      if (j >= 0 && j < owners.length && land[j] === 1 && owners[j] === 0) return true;
  }
  return false;
}

export const nextSlotAfter = (tick: number) => (Math.floor(tick / ORDER_EVERY) + 1) * ORDER_EVERY;

/** Which authored decision a due baseline slot carries. D0 must be observed before the tick-600 correction; D1 after the 900 conflict. */
export function decisionFor(tick: number, releasedIds: Set<string>, exerciseId: string, attempted: {D0: boolean; D1: boolean}): 'D0' | 'D1' | null {
  const has = (rs: string[]) => ids(exerciseId, rs).every(id => releasedIds.has(id));
  if (!attempted.D0 && tick >= 300 && tick <= D0_LAST_TICK && has(['blue-r02', 'blue-r03'])) return 'D0';
  if (!attempted.D1 && tick >= D1_FIRST_TICK && tick < LATE_RELEASE && has(['blue-r05', 'blue-r06', 'blue-r07'])) return 'D1';
  return null;
}

export const EXPECTED_ALERT_SOURCES: Record<number, string[]> = {
  300: ['blue-r02', 'blue-r03'], 600: ['blue-r02', 'blue-r04', 'blue-r05'], 900: ['blue-r06', 'blue-r07'], 1200: ['blue-r08']};

/** Free alerts for exactly this watch, keyed by release tick. Any paid, early, duplicated or mis-sourced update fails. */
export function verifyAlerts(timeline: Json[], reports: Json[], task: {id: string; side: string; createdTick: number}, exerciseId: string) {
  const updates = timeline.filter(e => e.kind === 'staff_update' && e.details?.taskId === task.id);
  check(updates.every(e => e.details.method === METHOD), 'paid-analysis-update-present');
  check(updates.every(e => e.side === task.side && e.details.observedTick === e.tick && e.tick > task.createdTick
    && Object.hasOwn(EXPECTED_ALERT_SOURCES, String(e.tick))), 'unexpected-watch-update');
  check(new Set(updates.map(e => e.tick)).size === updates.length, 'duplicate-watch-update');
  const byTick: Record<number, Json> = {};
  for (const e of updates) {
    equal(sorted(e.details.sourceIds), ids(exerciseId, EXPECTED_ALERT_SOURCES[e.tick]), `alert-${e.tick}-sources`);
    check(e.details.sourceIds.every((s: string) => reports.some(r => r.id === s && r.side === task.side && r.tick <= e.tick)), 'alert-source-unresolved');
    byTick[e.tick] = e;
  }
  if (byTick[CORRECTION]) check(String(byTick[CORRECTION].summary).includes('supersedes'), 'correction-alert-summary');
  if (byTick[CONFLICT]) check(String(byTick[CONFLICT].summary).includes('unresolved conflict'), 'conflict-alert-summary');
  return byTick;
}

/** Release ticks after watch creation that passed without an alert. */
export const missingAlerts = (byTick: Record<number, Json>, createdTick: number, finalTick: number) =>
  Object.keys(EXPECTED_ALERT_SOURCES).map(Number).filter(t => t > createdTick && t <= finalTick && !byTick[t]);

/** The distinct Intelligence seat's contemporaneous, source-linked assessment, before the tick-600 correction. */
export function verifyAssessment(timeline: Json[], x: {eventId: string; exerciseId: string; subject: string}) {
  const rows = timeline.filter(e => e.id === x.eventId);
  check(rows.length === 1 && rows[0].kind === 'assessment_log', 'assessment-event-missing');
  const e = rows[0], d = e.details ?? {};
  check(e.actor === x.subject && d.author === x.subject && d.authorRole === 'intelligence' && e.side === 'blue', 'assessment-author-side');
  equal(sorted(d.sourceIds), ids(x.exerciseId, ['blue-r02', 'blue-r03']), 'assessment-sources');
  check(d.timing === 'contemporaneous' && d.observedTick >= 300 && d.observedTick < CORRECTION && e.tick >= d.observedTick, 'assessment-time-chain');
  return {eventId: e.id, observedTick: d.observedTick as number, recordedTick: e.tick as number};
}

export interface OrderExpectation {
  exerciseId: string; commandId: string; subject: string; sourceIds: string[]; observedMin: number; observedMax: number; mention: string[]; label: string;
}
/** One recorded human-origin Blue order: owner, receipt-backed observation, released-before-observed citations, authored label. */
export function verifyOrderEvent(timeline: Json[], reports: Json[], x: OrderExpectation) {
  const rows = timeline.filter(e => e.kind === 'command' && e.details?.commandId === x.commandId);
  check(rows.length === 1, 'order-event-missing-or-duplicated');
  const e = rows[0], d = e.details;
  check(e.actor === x.subject && e.side === 'blue' && d.origin === 'human', 'order-owner-side');
  check(d.observationBasis === 'app-snapshot-returned-with-order' && d.observation?.tick === d.observedTick
    && d.observation.exerciseId === x.exerciseId && d.observation.subject === x.subject && d.observation.side === 'blue', 'order-observation-receipt');
  check(Number.isSafeInteger(d.observedTick) && d.observedTick >= x.observedMin && d.observedTick <= x.observedMax, 'order-observed-window');
  check(d.admittedTick >= d.observedTick && e.tick >= d.admittedTick, 'order-time-chain');
  equal(sorted(d.sourceIds ?? []), [...x.sourceIds].sort(), 'order-sources');
  const released: Record<string, number> = {};
  for (const id of x.sourceIds) {
    const r = reports.find(r => r.id === id && r.side === 'blue');
    check(r && r.tick <= d.observedTick, 'order-cites-unreleased-report');
    released[id] = r.tick;
  }
  check(d.rationaleTiming === 'contemporaneous' && typeof d.rationale === 'string' && d.rationale.startsWith(x.label)
    && x.mention.every(m => d.rationale.includes(m)), 'order-authored-rationale');
  return {eventId: e.id as string, commandId: x.commandId, observedTick: d.observedTick as number, admittedTick: d.admittedTick as number,
    recordedTick: e.tick as number, sourceIds: [...x.sourceIds].sort(), releasedTicks: released, intent: d.intent, fingerprint: d.fingerprint as string};
}

/** The post-900 order is tied to the recorded conflict alert by IDs, never by claimed interpretation. */
export function verifyAlertLink(d1: {observedTick: number; sourceIds: string[]}, rationale: string, alerts: Record<number, Json>, exerciseId: string) {
  const conflict = alerts[CONFLICT], correction = alerts[CORRECTION];
  check(conflict, 'conflict-alert-missing');
  check(d1.observedTick >= conflict.tick, 'order-observed-before-alert');
  check(rationale.includes(conflict.id), 'order-rationale-missing-alert-id');
  const cited = new Set(d1.sourceIds);
  check(conflict.details.sourceIds.every((s: string) => cited.has(s)), 'order-missing-alert-sources');
  const r05 = storedId(exerciseId, 'blue-r05');
  check(cited.has(r05) && (!correction || correction.details.sourceIds.includes(r05)), 'order-missing-disputed-source');
  return {alertEventId: conflict.id as string, alertTick: conflict.tick as number, sharedSourceIds: [...conflict.details.sourceIds].sort(),
    ...(correction ? {correctionAlertEventId: correction.id as string} : {})};
}

/** Debrief/review chain for one order in the original exercise; the model's original claim text and record stay intact. */
export function verifyReviewChain(x: {generated: Json; instructorRead: Json; commanderHistory: Json; commanderRead: Json; saved: Json;
  body: Json; exerciseId: string; eventId: string}) {
  const original = JSON.stringify(x.generated.record);
  check(x.generated.status === 'generated' && x.generated.record?.eventId === x.eventId && x.generated.record.exerciseId === x.exerciseId
    && /^[a-f0-9]{64}$/.test(x.generated.record.hash), 'debrief-record-contract');
  equal(JSON.stringify(x.instructorRead.record), original, 'instructor-debrief-differs');
  equal(JSON.stringify(x.commanderRead.record), original, 'original-debrief-changed');
  check(UUID.test(x.saved.id) && x.saved.disposition === 'edited' && x.saved.exerciseId === x.exerciseId && x.saved.eventId === x.eventId
    && x.saved.hash === x.generated.record.hash && !x.saved.previousId, 'saved-review-contract');
  const headline = x.generated.record.debrief?.headline;
  check(x.saved.originalText === headline?.text, 'review-original-text-changed');
  const h = x.commanderHistory;
  check(h.exerciseId === x.exerciseId && h.eventId === x.eventId && h.canReview === false && Array.isArray(h.reviews) && h.reviews.length === 1, 'commander-review-history');
  const r = h.reviews[0];
  equal({id: r.id, disposition: r.disposition, editedText: r.editedText, explanation: r.explanation, nextPractice: r.nextPractice, criterionId: r.criterionId, originalText: r.originalText},
    {id: x.saved.id, disposition: 'edited', editedText: x.body.editedText, explanation: x.body.explanation, nextPractice: x.body.nextPractice,
      criterionId: x.body.criterionId, originalText: headline.text}, 'commander-review-facts');
  return {reviewId: r.id as string, debriefHash: x.generated.record.hash as string, receiptId: x.generated.record.receipt?.id as string};
}

/** Branch row and its creation event are tied to the same original, fork tick, owner and recorded fingerprints. */
export function verifyBranch(x: {row: Json; overview: Json; parentId: string; forkTick: number; subject: string; parentRecord: Json; parentFinalFingerprint: string}) {
  const {row} = x;
  check(UUID.test(row.id) && row.id !== x.parentId && row.kind === 'branch' && row.parentId === x.parentId && row.forkTick === x.forkTick
    && row.humanSide === 'blue' && row.status === 'running' && row.agentEnabled === false && row.options?.ownerSubject === x.subject, 'branch-row-contract');
  check(x.overview.activeId === row.id && x.overview.playbackTick === null, 'branch-overview-not-active');
  const created = (x.overview.timeline ?? []).filter((e: Json) => e.kind === 'branch_created');
  check(created.length === 1 && created[0].tick === x.forkTick, 'branch-created-event');
  const d = created[0].details;
  check(d.parentId === x.parentId && d.forkTick === x.forkTick, 'branch-created-parent');
  check(d.fingerprint === x.parentRecord.fingerprints?.[String(x.forkTick)], 'branch-fork-fingerprint');
  check(d.originalFingerprint === x.parentFinalFingerprint, 'branch-original-fingerprint');
  check((x.overview.reports ?? []).every((r: Json) => String(r.id).startsWith(`${row.id}:`) && r.tick <= x.forkTick), 'branch-report-copies');
  return {branchId: row.id as string, branchCreatedEventId: created[0].id as string, forkFingerprint: d.fingerprint as string};
}

/** Same original afterwards: identical replay record, completed at the same tick/fingerprint, same human order events. */
export function verifySourceUnchanged(before: {recordSha256: string; overview: Json}, after: {recordSha256: string; overview: Json}, exerciseId: string) {
  check(before.recordSha256 === after.recordSha256, 'source-record-changed');
  const facts = (o: Json) => ({activeId: o.activeId, status: (o.exercises ?? []).find((e: Json) => e.id === exerciseId)?.status, tick: o.state?.tick,
    fingerprint: o.state?.fingerprint, orders: (o.timeline ?? []).filter((e: Json) => e.kind === 'command' && e.details?.origin === 'human').map((e: Json) => e.id).sort()});
  const a = facts(before.overview), b = facts(after.overview);
  check(a.activeId === exerciseId && a.status === 'completed', 'source-not-completed');
  equal(b, a, 'source-overview-changed');
  return {finalTick: a.tick as number, finalFingerprint: a.fingerprint as string, humanOrders: a.orders.length};
}

export const REQUIRED_FACTS = [
  'budget-gate', 'commander-owned-exercise-paid-opponent-off', 'instructor-selected-and-team-enrolled', 'intelligence-assessment-source-linked',
  'tomo-watch-created-and-verified', 'correction-alert-600', 'conflict-alert-900', 'decision-d0-pre600-r02-r03',
  'decision-d1-post900-linked-to-alert', 'continuous-clock-about-1200', 'original-ended-before-debrief', 'luna-debrief-generated',
  'automated-instructor-correction-retrievable', 'branch-created-from-recorded-decision', 'branch-alternative-order-recorded',
  'branch-ended', 'source-record-unchanged', 'cleanup-complete'] as const;
export type FactId = typeof REQUIRED_FACTS[number];

/** Demonstrated only when every required fact holds; a guard violation or unverified fact is never promoted. */
export function classify(facts: {id: string; met: boolean}[], fatal: string | null) {
  const met = new Set(facts.filter(f => f.met).map(f => f.id));
  const unmet = REQUIRED_FACTS.filter(id => !met.has(id) || facts.some(f => f.id === id && !f.met));
  if (fatal) return {status: 'incomplete-retained', unmet};
  return {status: unmet.length ? 'partial-retained' : 'demonstrated-main-review-pending', unmet};
}

/** Public proof may never contain a raw identity or credential field. */
export function assertPublicSafe(text: string, secrets: string[]) {
  check(secrets.filter(s => typeof s === 'string' && s.length >= 4).every(s => !text.includes(s)), 'identity-in-public-output');
  check(!/"(password|access_token|token|authorization|cookie|invitationCode|observationReceipt)"\s*:/i.test(text), 'secret-field-in-public-output');
}

/** Map arrays are large and not needed to audit the chain; their hash is kept instead. */
const compactOverview = (o: Json) => o && ({...o, state: o.state && {...o.state, owners: undefined, land: undefined,
  mapSha256: Array.isArray(o.state.owners) ? sha(JSON.stringify(o.state.owners)) : null}, observationReceipt: undefined});

// ---------------------------------------------------------------------------
// Native run (never reached by --self-test)
// ---------------------------------------------------------------------------

async function run(argv: string[]) {
  const {version, attempt: label} = attemptArguments(argv);
  check(argv.length === 2, 'usage-version-attempt-label');
  const stem = `integrated-learning-demo-${label}-`;
  check(!fs.readdirSync('evidence/platform').some(f => f.startsWith(stem)), 'attempt-label-not-fresh');
  const attempt = `${label}-${randomUUID()}`;
  const artifact = `evidence/platform/integrated-learning-demo-${attempt}.json`;
  const eventsPath = `data/platform/integrated-learning-demo-${attempt}-tomo-events.jsonl`;
  const detailPath = `data/platform/integrated-learning-demo-${attempt}-tomo-detail.json`;
  const observedPath = `data/platform/integrated-learning-demo-${attempt}-observed.json`;
  const files = [artifact, eventsPath, detailPath, observedPath];
  for (const file of files) { fs.mkdirSync(path.dirname(file), {recursive: true}); check(!fs.existsSync(file), 'attempt-file-exists'); }
  const fds = new Map<string, number>();
  try { for (const file of files) fds.set(file, fs.openSync(file, 'wx', 0o600)); }
  catch (e) { for (const fd of fds.values()) fs.closeSync(fd); throw e; }
  const write = (file: string, data: unknown) => { const fd = fds.get(file)!; fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n', 0, 'utf8'); };

  const guard = newGuard();
  const exerciseName = `Fictional automated integrated learning demo ${version} ${attempt.slice(-8)}`;
  const args: WatchArgs = {exerciseId: '', requestId: randomUUID(), title: TITLE};
  const facts: {id: FactId; met: boolean; exerciseId: string | null; detail: Json}[] = [];
  const proof: Json = {schema: 'replay.integrated-learning-demo/1', startedAt: new Date().toISOString(), version, attempt, scenarioId: SCENARIO, exerciseName,
    fictional: true, automatedOperation: true, humanValidated: false, aiVersusAi: false, modelPlayer: false, status: 'starting',
    claimBoundary: ['Integration demonstration of one automated fictional exercise; not human validation, player testing or AI-versus-AI play.',
      'Blue orders come from a transparent scripted baseline; their reasons are authored demo prompts, not model or human judgment.',
      'No model or player is claimed to have learned from, or acted because of, an authored reason, alert or correction.',
      'The instructor correction is an automated, unscored example of the review path, not an instructor assessment.',
      'Game outcomes and branch results are not evidence of learning, doctrine, opponent quality or realism.'],
    transport: 'REPLAY Tomo conversation entry with the configured staff helper; no direct MCP fallback',
    watchRequestId: args.requestId, creationKey: randomUUID(), inputKey: randomUUID(),
    privateFiles: {tomoEvents: eventsPath, tomoDetail: detailPath, observed: observedPath},
    limits: {totalMs: TOTAL_MS, gameMs: GAME_MS, tomoMs: TOMO_MS, debriefMs: DEBRIEF_MS, branchMs: BRANCH_MS, activeRequestCap: ACTIVE_REQUESTS,
      cleanupRequestCap: CLEANUP_REQUESTS, minimumRequestsLeft: MIN_REQUESTS_LEFT, applicationRequestCap: REQUEST_CAP, applicationUsdCap: USD_CAP,
      rooms: 1, tomoInputs: 1, debriefs: 1, reviews: 1, branches: 1, branchOrders: 1, maxOriginalOrders: MAX_ORDERS, orderEveryTicks: ORDER_EVERY,
      expansionShare: EXPANSION_SHARE, endTick: END_TICK, endTickMax: END_TICK_MAX},
    orders: [], partial: []};
  const observed: Json = {overviews: {}}, subjects: string[] = [];
  // Every public write is redaction-checked; a rejected proof is kept only in the private file.
  const save = () => {
    try { assertPublicSafe(JSON.stringify(proof), subjects); write(artifact, proof); }
    catch (e) {
      proof.redactionFailure = errorCode(e); observed.unredactedProof = proof; write(observedPath, observed);
      write(artifact, {schema: proof.schema, version, attempt, status: 'redaction-check-failed', code: proof.redactionFailure,
        exerciseId: args.exerciseId || null, privateFiles: proof.privateFiles, at: new Date().toISOString()});
    }
  };
  const keep = (key: string, value: unknown) => { observed[key] = value; write(observedPath, observed); };
  const fact = (id: FactId, met: boolean, detail: Json = {}, exerciseId: string | null = args.exerciseId || null) => {
    facts.push({id, met, exerciseId, detail}); proof.acceptance = facts; save();
  };
  const soft = (phase: string, e: unknown) => { if (e instanceof GuardViolation) throw e; proof.partial.push({phase, code: errorCode(e)}); save(); };

  type Client = Awaited<ReturnType<typeof nativeAppClient>>;
  let instructor: Client | undefined, commander: Client | undefined, intel: Client | undefined;
  let phase = 'preflight', fatal: string | null = null;
  // Mutated from the fetch guard and the concurrent Tomo task, so kept on an object rather than narrowed locals.
  const shared: {violation: string | null; task?: {id: string; side: string; createdTick: number}; tomoSettled: boolean} = {violation: null, tomoSettled: false};
  let observation: RoomObservation | undefined, streamTask: Promise<void> | undefined, tomoTask: Promise<void> | undefined;
  const frames: RoomFrame[] = [], total = new AbortController(), streamStop = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), TOTAL_MS);
  let originalEnded = false, branchEnded = false, exerciseCreation: 'none' | 'pending' | 'created' | 'uncertain' = 'none';
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let timeout: number;
    try { timeout = permit(guard, init?.method ?? 'GET', href, init?.body); }
    catch (e) { shared.violation ??= errorCode(e); throw e; }
    const signals = [AbortSignal.timeout(timeout)];
    if (!guard.cleanup) signals.push(total.signal);
    if (init?.signal) signals.push(init.signal);
    return nativeFetch(input, {...init, redirect: 'error', signal: AbortSignal.any(signals)});
  };
  const call = (who: Client, target: string, body?: unknown, ms = POST_MS) => withDeadline(async signal => {
    const r = await who.requestRaw(target, body, {signal});
    const text = await r.text();
    let data: any = null; try { data = JSON.parse(text); } catch {}
    return {status: r.status, ok: r.ok, data};
  }, ms, 'request-deadline');
  const read = async (who: Client, target: string, body?: unknown, ms = READ_MS) => {
    const r = await call(who, target, body, ms); check(r.ok, `http-${r.status}`); return r.data as Json;
  };
  const short = (v: unknown) => typeof v === 'string' ? v.replace(/[A-Za-z0-9_-]{32,}/g, '[id]').slice(0, 200) : null;

  try {
    save();
    // ---- preflight: configuration read as data, three distinct native identities, unchanged caps ----
    const config = JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json', 'utf8'));
    const helperId = JSON.parse(fs.readFileSync(HELPER_RECEIPT, 'utf8')).agent?.id;
    const observerId = JSON.parse(fs.readFileSync(OBSERVER_RECEIPT, 'utf8')).agent?.id;
    check(UUID.test(helperId) && config.agentId === helperId && helperId !== observerId, 'staff-helper-config-required');
    check(typeof config.deploymentId === 'string' && config.deploymentId.length > 0, 'model-deployment-config');
    proof.agentId = config.agentId; proof.modelDeploymentId = config.deploymentId;
    const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
    const one = (role: string) => {
      const rows = Array.isArray(users) ? users.filter((u: Json) => u.role === role) : [];
      return rows.length === 1 && rows[0].username && rows[0].password ? {username: String(rows[0].username), password: String(rows[0].password)} : null;
    };
    const commanderCredential = one('commander'), intelCredential = one('intelligence');
    if (Array.isArray(users)) for (const u of users) u.password = '';
    check(commanderCredential && intelCredential, 'team-credentials');

    phase = 'logins';
    instructor = await nativeAppClient();
    try { commander = await nativeAppClient(commanderCredential); } finally { commanderCredential.password = ''; }
    try { intel = await nativeAppClient(intelCredential); } finally { intelCredential.password = ''; }
    const identity = async (who: Client, role: string) => {
      const s = await read(who, '/api/native/status');
      check(s.mode === 'kamiwaza' && s.signedIn && s.identity?.role === role && typeof s.identity.subject === 'string', `native-${role}-required`);
      subjects.push(s.identity.subject); return s.identity.subject as string;
    };
    const instructorSubject = await identity(instructor, 'instructor');
    const subject = await identity(commander, 'commander');
    const intelSubject = await identity(intel, 'intelligence');
    check(new Set(subjects).size === 3, 'identities-not-distinct');
    proof.subjects = {instructorSha256: sha(instructorSubject), commanderSha256: sha(subject), intelligenceSha256: sha(intelSubject)};
    const build = await read(commander, '/replay-build.json');
    equal(build.version, version, 'deployed-version'); proof.build = build;
    equal((await read(commander, '/api/tomo/status')).mode, 'scoped-conversation', 'conversation-route-unavailable');
    proof.budgetBefore = budgetProjection((await read(instructor, '/api/agents/tools')).budget);
    check(budgetAllows(proof.budgetBefore, MIN_REQUESTS_LEFT), 'insufficient-or-unexpected-budget');
    fact('budget-gate', true, {budgetBefore: proof.budgetBefore, minimumRequestsLeft: MIN_REQUESTS_LEFT}, null);

    // ---- Tomo room and stream open before the exercise exists (same pattern as the qualified watch proof) ----
    phase = 'room-create'; proof.tomo = {status: 'room-create-pending'}; save();
    const roomId = await withDeadline(async signal => {
      const response = await commander!.requestRaw(PREFIX, {}, {idempotencyKey: proof.creationKey, signal});
      proof.tomo.creationHttpStatus = response.status;
      return roomCreated(response.status, await response.json());
    }, POST_MS, 'room-creation-uncertain');
    guard.roomId = roomId; proof.tomo = {...proof.tomo, status: 'room-created', conversationId: roomId}; save();
    phase = 'observe-stream';
    const response = await withDeadline(signal => commander!.request(`${PREFIX}/${roomId}/events?after=0`, undefined,
      {signal: AbortSignal.any([signal, streamStop.signal])}), READ_MS, 'event-headers-deadline');
    check(response.status === 200 && /^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') ?? '') && response.body, 'event-stream-required');
    const body = response.body!;
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
          bytes += value.byteLength; check(bytes <= STREAM_BYTES, 'stream-byte-cap');
          for (const frame of decoder.push(value)) {
            fs.writeSync(fds.get(eventsPath)!, JSON.stringify({...frame.envelope, _sse: {event: frame.sseEvent, id: frame.sseId}}) + '\n');
            frames.push(frame); roomObs.add(frame); observe();
          }
        }
      } catch (e) { streamFailure = e; }
      finally { streamEnded = true; observe(); try { await reader.cancel(); } catch {} reader.releaseLock(); }
    })();

    // ---- Commander-owned exercise, paid opponent off; instructor selects; distinct Intelligence user enrolls ----
    phase = 'exercise-create'; exerciseCreation = 'pending'; save();
    const exercise = await read(commander, '/api/exercises', {name: exerciseName, scenarioId: SCENARIO}, POST_MS);
    check(UUID.test(exercise.id) && exercise.name === exerciseName && exercise.status === 'running' && exercise.kind === 'live', 'exercise-create-contract');
    exerciseCreation = 'created'; args.exerciseId = exercise.id; guard.exerciseId = exercise.id;
    const gameEnd = Date.now() + GAME_MS;
    proof.exercise = {id: exercise.id, humanSide: exercise.humanSide, agentEnabled: exercise.agentEnabled, createdAt: exercise.createdAt}; save();
    fact('commander-owned-exercise-paid-opponent-off', exercise.agentEnabled === false && exercise.humanSide === 'blue'
      && exercise.options?.ownerSubject === subject && exercise.options?.scenario?.controller === 'objectives/1',
    {agentEnabled: exercise.agentEnabled, humanSide: exercise.humanSide, ownerIsCommander: exercise.options?.ownerSubject === subject, opponent: 'objectives/1 scripted controller'});

    phase = 'team';
    equal((await read(instructor, '/api/select', {exerciseId: exercise.id})).selected, exercise.id, 'instructor-select');
    const invitation = await read(instructor, '/api/team/code', {});
    const joined = await (async () => { try { return await read(intel!, '/api/team/join', {code: invitation.code}); } finally { invitation.code = ''; } })();
    equal({exerciseId: joined.exerciseId, side: joined.side}, {exerciseId: exercise.id, side: 'blue'}, 'join-exercise-mismatch');
    const team = await read(instructor, '/api/team');
    const enrolled = (team.participants ?? []).filter((p: Json) => p.active !== false).map((p: Json) => p.subject);
    fact('instructor-selected-and-team-enrolled', team.exerciseId === exercise.id && enrolled.includes(subject) && enrolled.includes(intelSubject),
      {instructorSelected: true, commanderEnrolled: enrolled.includes(subject), intelligenceEnrolled: enrolled.includes(intelSubject)});
    check(!streamFailure && !streamEnded, 'stream-failed-before-input');
    guard.phase = 'original';

    // ---- one Tomo input, concurrently with continuous play; failure is retained, never retried ----
    const tomo = proof.tomo;
    tomoTask = (async () => {
      try {
        tomo.status = 'input-response-pending'; tomo.acceptanceState = 'uncertain';
        const message = watchMessage(args); tomo.messageSha256 = sha(message); tomo.inputDispatchedAt = new Date().toISOString(); save();
        const accepted = await withDeadline(async signal => {
          const r = await commander!.requestRaw(`${PREFIX}/${roomId}/inputs`, {kind: 'message', message, model: config.deploymentId,
            agent: config.agentId, platform_tool_names: [WATCH], connector_ids: [], subagent_ids: [], resource_reference_ids: [], effort: 'low'},
          {idempotencyKey: proof.inputKey, signal});
          tomo.inputHttpStatus = r.status; save();
          const data = await r.json(); signal.throwIfAborted(); return inputAccepted(r.status, data);
        }, POST_MS, 'input-acceptance-uncertain');
        tomo.inputId = accepted.input_id; tomo.acceptanceState = 'accepted'; tomo.status = 'input-accepted'; save();
        roomObs.accept(accepted); acceptanceBound = true; observe();
        const result = await withDeadline(() => terminal, TOMO_MS, 'terminal-observation-deadline');
        const {assistant: _answer, reason, ...terminalProof} = result;
        tomo.terminal = terminalProof; tomo.terminalReasonPresent = typeof reason === 'string'; save();
        const evidence = verifyWatchEvidence(frames, result, args);
        const ov = await read(commander!, '/api/overview', undefined, OVERVIEW_MS);
        const persisted = verifyPersisted(ov, evidence.created, args, subject);
        guard.taskId = persisted.task.id;
        const task = {id: persisted.task.id as string, side: persisted.task.side as string, createdTick: persisted.task.createdTick as number};
        shared.task = task;
        keep('tomoCreated', {created: evidence.created, task: persisted.task, receipt: persisted.receipt});
        Object.assign(tomo, {status: 'watch-verified', tool: {name: WATCH, callId: evidence.callId, outcome: 'ok', inputId: result.inputId, runId: result.runId},
          durableCompletion: {status: result.status, position: result.position, answerPosition: evidence.answerDurablePosition},
          answerSha256: evidence.answerSha256, answerToolFactsMatched: true,
          taskId: task.id, createdTick: task.createdTick, side: task.side, receiptEventId: persisted.receipt.id,
          taskCreatedEventId: evidence.created.provenance.taskCreatedEventId, modelEnabled: false, ownerIsCommander: true});
        fact('tomo-watch-created-and-verified', task.side === 'blue' && task.createdTick < CONFLICT,
          {taskId: task.id, createdTick: task.createdTick, receiptEventId: persisted.receipt.id, inputId: result.inputId, runId: result.runId});
      } catch (e) {
        if (e instanceof GuardViolation) shared.violation ??= e.message;
        tomo.status = tomo.acceptanceState === 'uncertain' ? 'input-acceptance-uncertain' : 'tomo-watch-not-verified';
        tomo.failure = errorCode(e); proof.partial.push({phase: 'tomo', code: tomo.failure});
        if (!facts.some(f => f.id === 'tomo-watch-created-and-verified')) fact('tomo-watch-created-and-verified', false, {failure: tomo.failure});
      } finally {
        tomo.settledAt = new Date().toISOString(); streamStop.abort(); save();
      }
    })();

    // ---- continuous original run: poll only; never replay, pause or change the controller ----
    phase = 'original-run';
    const released = new Map<string, number>(), attempted = {D0: false, D1: false};
    const pending = new Map<string, Json>();
    let nextSlot = ORDER_EVERY, lastTick = -1, navalMode = false, alerts: Record<number, Json> = {}, alertFailure: string | null = null;
    let assessment: Json | undefined, polls = 0, endedBy = 'not-ended';
    void tomoTask.then(() => { shared.tomoSettled = true; });
    const decisions: Record<'D0' | 'D1', Json | undefined> = {D0: undefined, D1: undefined};
    const rationaleFor = (decision: 'D0' | 'D1' | null, share: string) => {
      if (decision === 'D0') return {text: `${AUTHORED} Marsh reserve estimate blue-r02 and its relay repeat blue-r03 share one origin, so they count as one account. Continue the ${share} neutral expansion and keep the rest in reserve until the survey desk reports again.${assessment ? ` Linked Intelligence assessment ${assessment.id}.` : ''}${alerts[300] ? ` Linked watch alert ${alerts[300].id}.` : ''}`,
        sourceIds: ids(args.exerciseId, ['blue-r02', 'blue-r03']), mention: assessment ? [assessment.id] : []};
      if (decision === 'D1') {
        const link = alerts[CONFLICT];
        return {text: `${AUTHORED} ${link ? `Watch alert ${link.id} recorded` : 'No watch alert was recorded, but the source desk released'} Tidewell reports blue-r06 (disputes blue-r05) and blue-r07 (repeats blue-r05); the conflict is unresolved and the repeat is not corroboration. Continue the same ${share} scripted order without relying on either account.`,
          sourceIds: ids(args.exerciseId, ['blue-r05', 'blue-r06', 'blue-r07']), mention: link ? [link.id] : []};
      }
      return {text: `${AUTHORED} fixed ${share} neutral expansion on the ~${ORDER_EVERY}-tick cadence while unclaimed land borders Blue territory.`, sourceIds: [] as string[], mention: [] as string[]};
    };
    const issue = async (ov: Json, slotTick: number) => {
      const tick = ov.state.tick, blue = ov.state.players.find((p: Json) => p.side === 'blue');
      const decision = decisionFor(tick, new Set(released.keys()), args.exerciseId, attempted);
      if (decision) attempted[decision] = true;
      const entry: Json = {slotTick, pollTick: tick, decision, kind: 'skipped'}; proof.orders.push(entry);
      if (ov.state.spawning || !blue?.alive) { entry.reason = ov.state.spawning ? 'spawn-phase' : 'blue-eliminated'; return; }
      let intent: Json | undefined;
      if (!navalMode && neutralFrontier(ov.state, 'blue') && Math.floor(blue.troops * EXPANSION_SHARE) >= 1) {
        intent = {type: 'attack', targetID: null, troops: Math.floor(blue.troops * EXPANSION_SHARE)}; entry.kind = 'expansion';
      } else {
        if (!navalMode) { navalMode = true; entry.switchedToNaval = 'no-reachable-unclaimed-land-in-map'; }
        const options = await read(commander!, `/api/action-options?${new URLSearchParams({exerciseId: args.exerciseId})}`);
        const landing = options.naval?.status === 'available' ? (options.naval.landings ?? []).find((l: Json) => l.intent?.type === 'boat') : undefined;
        if (!landing) { entry.reason = `no-listed-legal-naval-intent: ${short(options.naval?.reason) ?? 'unavailable'}`; return; }
        intent = landing.intent; entry.kind = 'listed-naval-fallback'; entry.listedMeaning = short(landing.meaning);
      }
      const reason = rationaleFor(decision, entry.kind === 'expansion' ? `${EXPANSION_SHARE * 100}%` : 'listed naval');
      const r = await call(commander!, '/api/commands', {side: 'blue', idempotencyKey: randomUUID(), intent, observationReceipt: ov.observationReceipt,
        rationale: reason.text, sourceIds: reason.sourceIds});
      Object.assign(entry, {intent, httpStatus: r.status, rationale: reason.text, sourceIds: reason.sourceIds});
      if (r.status !== 202 || !UUID.test(r.data?.id)) {
        entry.refusal = short(r.data?.error) ?? `HTTP ${r.status}`;
        if (entry.kind === 'expansion') navalMode = true;   // stop expansions after any refusal; never force or resend
        return;
      }
      entry.commandId = r.data.id; pending.set(r.data.id, {entry, reason});
      if (decision) decisions[decision] = {commandId: r.data.id, reason, entry};
    };
    const settle = (timeline: Json[]) => {
      for (const [commandId, {entry}] of pending) {
        const event = timeline.find(e => e.kind === 'command' && e.details?.commandId === commandId);
        const rejected = timeline.find(e => e.kind === 'command_rejected' && e.details?.commandId === commandId);
        if (event) Object.assign(entry, {eventId: event.id, recordedTick: event.tick, observedTick: event.details.observedTick, admittedTick: event.details.admittedTick});
        else if (rejected) Object.assign(entry, {rejectedEventId: rejected.id, rejectedTick: rejected.tick, refusal: short(rejected.details?.reason)});
        if (event || rejected) { pending.delete(commandId); if (rejected && entry.kind === 'expansion') navalMode = true; }
      }
    };
    while (true) {
      if (Date.now() >= gameEnd) { proof.partial.push({phase: 'original-run', code: 'game-deadline-before-end-tick'}); break; }
      const ov = await read(commander, '/api/overview', undefined, OVERVIEW_MS); polls++;
      check(ov.activeId === args.exerciseId && ov.playbackTick === null, 'overview-not-live-original');
      const tick = Number(ov.state?.tick); check(Number.isSafeInteger(tick) && tick >= lastTick, 'tick-regressed');
      lastTick = tick;
      const row = (ov.exercises ?? []).find((e: Json) => e.id === args.exerciseId);
      check(row && row.agentEnabled === false, 'paid-opponent-enabled');
      check((ov.reports ?? []).every((r: Json) => r.side === 'blue' && r.tick <= tick), 'report-leak-or-future-release');
      for (const r of ov.reports ?? []) if (!released.has(r.id)) released.set(r.id, r.tick);
      settle(ov.timeline ?? []);
      if (shared.task && !alertFailure) { try { alerts = verifyAlerts(ov.timeline ?? [], ov.reports ?? [], shared.task, args.exerciseId); } catch (e) { alertFailure = errorCode(e); soft('alerts', e); } }
      if (!observed.overviews.first) { observed.overviews.first = compactOverview(ov); keep('overviews', observed.overviews); }
      if (row.status !== 'running') { endedBy = `engine-${row.status}`; keep('overviews', {...observed.overviews, engineEnded: compactOverview(ov)}); break; }
      if (!assessment && tick >= 300 && tick <= D0_LAST_TICK && ids(args.exerciseId, ['blue-r02', 'blue-r03']).every(id => released.has(id)) && !proof.assessmentAttempted) {
        proof.assessmentAttempted = true;
        const text = 'Automated authored demo assessment (scripted Intelligence seat; not a human analysis): blue-r03 repeats blue-r02 and adds no independent observation. Treat the Marsh reserve estimate as one account until the survey desk corrects or confirms it.';
        try {
          const saved = await read(intel!, '/api/learning/assessment', {text, sourceIds: ids(args.exerciseId, ['blue-r02', 'blue-r03']), exerciseId: args.exerciseId}, POST_MS);
          check(typeof saved.id === 'string' && saved.timing === 'contemporaneous', 'assessment-response-contract');
          assessment = saved; proof.assessment = {eventId: saved.id, tick: saved.tick, observedTick: saved.observedTick, timing: saved.timing, text}; save();
        } catch (e) { soft('assessment', e); }
      }
      if (tick >= nextSlot && proof.orders.length < MAX_ORDERS) {
        const slot = nextSlot; nextSlot = nextSlotAfter(tick);
        try { await issue(ov, slot); } catch (e) { soft(`order-slot-${slot}`, e); }
        save();
        if (decisions.D0?.entry && !observed.overviews.d0 && decisions.D0.entry.slotTick === slot) { observed.overviews.d0 = compactOverview(ov); keep('overviews', observed.overviews); }
        if (decisions.D1?.entry && !observed.overviews.d1 && decisions.D1.entry.slotTick === slot) { observed.overviews.d1 = compactOverview(ov); keep('overviews', observed.overviews); }
      }
      if (tick >= END_TICK_MAX || tick >= END_TICK && pending.size === 0 && shared.tomoSettled) break;
      await delay(POLL_MS, undefined, {signal: total.signal});
    }
    proof.originalRun = {polls, lastPolledTick: lastTick, endedBy, navalMode, alertFailure}; save();

    // ---- end the original before any debrief ----
    phase = 'end-original';
    if (endedBy === 'not-ended') {
      const ended = await read(commander, `/api/exercises/${args.exerciseId}/finish`, {});
      check(ended.id === args.exerciseId && ended.status === 'completed' && ended.agentEnabled === false, 'finish-contract');
      endedBy = 'commander-end-for-review';
    }
    originalEnded = true; guard.phase = 'review';
    await withDeadline(() => tomoTask!, CLEANUP_STEP_MS, 'tomo-settle-deadline').catch(e => soft('tomo-settle', e));
    const finalOverview = await read(commander, '/api/overview', undefined, OVERVIEW_MS);
    const finalRow = (finalOverview.exercises ?? []).find((e: Json) => e.id === args.exerciseId);
    check(finalOverview.activeId === args.exerciseId && finalRow?.status === 'completed' && finalRow.agentEnabled === false, 'original-not-completed');
    const blueReports = (finalOverview.reports ?? []).filter((r: Json) => r.side === 'blue');
    const timeline: Json[] = (finalOverview.timeline ?? []).filter((e: Json) => !e.side || e.side === 'blue');
    settle(timeline);
    const finalTick = finalOverview.state.tick;
    const recordBefore = await read(commander, `/api/record/${args.exerciseId}`);
    const recordSha = sha(JSON.stringify(recordBefore));
    proof.original = {exerciseId: args.exerciseId, endedBy, finalTick, finalFingerprint: finalOverview.state.fingerprint, recordSha256: recordSha,
      controllerChanges: timeline.filter(e => e.kind === 'controller_changed').length, playbackUsed: false};
    keep('overviews', {...observed.overviews, final: compactOverview(finalOverview)});
    keep('originalRecordFingerprints', recordBefore.fingerprints);
    fact('continuous-clock-about-1200', finalTick >= LATE_RELEASE && endedBy === 'commander-end-for-review' && proof.original.controllerChanges === 0,
      {finalTick, polls, endedBy, livePollsOnly: true, controllerChanges: proof.original.controllerChanges});
    fact('original-ended-before-debrief', finalRow.status === 'completed', {endedBy, finalTick});

    // Alerts and task trace from the completed record (full human/staff timeline kinds are always retained there).
    const task = shared.task;
    if (task) {
      try {
        alerts = verifyAlerts(timeline, blueReports, task, args.exerciseId);
        const missing = missingAlerts(alerts, task.createdTick, finalTick);
        const trace = await read(commander, `/api/agents/tasks/${task.id}`);
        check(trace.task?.id === task.id && trace.task.modelEnabled === false && Array.isArray(trace.trace), 'task-trace-contract');
        check(trace.trace.every((e: Json) => e.kind === 'task_created' || e.kind === 'staff_update' && e.method === METHOD), 'paid-analysis-trace-present');
        keep('taskTrace', trace);
        proof.alerts = Object.fromEntries(Object.entries(alerts).map(([t, a]) => [t, {id: a.id, tick: a.tick, observedTick: a.details.observedTick,
          sourceIds: [...a.details.sourceIds].sort(), method: a.details.method}]));
        proof.missingAlertTicks = missing; save();
      } catch (e) { soft('final-alerts', e); alerts = {}; }
    }
    fact('correction-alert-600', !!alerts[CORRECTION], alerts[CORRECTION] ? {alertEventId: alerts[CORRECTION].id, tick: CORRECTION} : {reason: task ? 'no-verified-alert' : 'no-verified-watch'});
    fact('conflict-alert-900', !!alerts[CONFLICT], alerts[CONFLICT] ? {alertEventId: alerts[CONFLICT].id, tick: CONFLICT} : {reason: task ? 'no-verified-alert' : 'no-verified-watch'});

    if (assessment) {
      try { const a = verifyAssessment(timeline, {eventId: assessment.id, exerciseId: args.exerciseId, subject: intelSubject}); fact('intelligence-assessment-source-linked', true, a); }
      catch (e) { soft('assessment-verify', e); fact('intelligence-assessment-source-linked', false, {failure: errorCode(e)}); }
    } else fact('intelligence-assessment-source-linked', false, {reason: 'not-recorded'});

    const verified: Record<'D0' | 'D1', Json | undefined> = {D0: undefined, D1: undefined};
    for (const [key, range] of [['D0', [300, D0_LAST_TICK]], ['D1', [D1_FIRST_TICK, LATE_RELEASE - 1]]] as const) {
      const d = decisions[key];
      if (!d) { fact(key === 'D0' ? 'decision-d0-pre600-r02-r03' : 'decision-d1-post900-linked-to-alert', false, {reason: 'no-order-accepted-in-window'}); continue; }
      try {
        const v = verifyOrderEvent(timeline, blueReports, {exerciseId: args.exerciseId, commandId: d.commandId, subject, sourceIds: d.reason.sourceIds,
          observedMin: range[0], observedMax: range[1], mention: d.reason.mention, label: AUTHORED});
        verified[key] = v;
        const link = key === 'D1' ? verifyAlertLink(v, d.reason.text, alerts, args.exerciseId) : undefined;
        proof.decisions = {...proof.decisions, [key]: {...v, kind: d.entry.kind, rationale: d.reason.text, ...(link ? {alertLink: link} : {}),
          ...(key === 'D0' ? {correctionReleasedAfterObservation: v.observedTick < CORRECTION, assessmentEventId: assessment?.id ?? null} : {})}};
        fact(key === 'D0' ? 'decision-d0-pre600-r02-r03' : 'decision-d1-post900-linked-to-alert', true, proof.decisions[key]);
      } catch (e) {
        soft(`${key}-verify`, e);
        fact(key === 'D0' ? 'decision-d0-pre600-r02-r03' : 'decision-d1-post900-linked-to-alert', false, {failure: errorCode(e), commandId: d.commandId});
      }
    }

    // ---- one Luna debrief for the selected order (D1 when its chain verified, else D0) ----
    phase = 'debrief';
    const selectedKey = verified.D1 && facts.some(f => f.id === 'decision-d1-post900-linked-to-alert' && f.met) ? 'D1' : verified.D0 ? 'D0' : null;
    let review: Json | undefined, generated: Json | undefined;
    if (!selectedKey) proof.partial.push({phase: 'debrief', code: 'no-verified-decision-to-debrief'});
    else {
      const selected = verified[selectedKey]!;
      guard.debriefEventId = selected.eventId;
      proof.selectedDecision = {key: selectedKey, eventId: selected.eventId, commandId: selected.commandId, observedTick: selected.observedTick};
      const budget = budgetProjection((await read(instructor, '/api/agents/tools')).budget);
      proof.budgetBeforeDebrief = budget; save();
      if (!budgetAllows(budget, 1)) { proof.partial.push({phase: 'debrief', code: 'budget-insufficient-or-caps-changed'}); fact('luna-debrief-generated', false, {budget}); }
      else {
        proof.debrief = {status: 'pending', eventId: selected.eventId, attempts: 1}; save();
        try {
          const r = await withDeadline(() => call(commander!, '/api/learning/debrief', {eventId: selected.eventId}, DEBRIEF_MS), DEBRIEF_MS, 'debrief-deadline');
          proof.debrief.httpStatus = r.status;
          if (r.status !== 201 || r.data?.status !== 'generated') {
            proof.debrief = {...proof.debrief, status: 'not-generated', code: short(r.data?.code), receiptId: short(r.data?.receiptId), error: short(r.data?.error)};
            fact('luna-debrief-generated', false, {httpStatus: r.status});
          } else {
            generated = r.data; keep('debrief', generated);
            proof.debrief = {...proof.debrief, status: 'generated', receiptId: generated!.record.receipt?.id, hash: generated!.record.hash,
              modelReturned: generated!.record.receipt?.modelReturned ?? null, budgetAfter: budgetProjection(generated!.budget)};
            fact('luna-debrief-generated', true, {eventId: selected.eventId, receiptId: proof.debrief.receiptId, hash: proof.debrief.hash});
          }
        } catch (e) { soft('debrief', e); proof.debrief.status = 'uncertain'; fact('luna-debrief-generated', false, {failure: errorCode(e)}); }
        save();
      }

      // ---- one explicitly automated, unscored interpretation correction through the real review API ----
      if (generated) {
        phase = 'review';
        try {
          const record = generated.record, query = '/api/learning/reviews?' + new URLSearchParams({exerciseId: args.exerciseId, eventId: selected.eventId, hash: record.hash});
          const instructorRead = await read(instructor, `/api/learning/debrief/${selected.eventId}`);
          const initial = await read(instructor, query);
          check(initial.canReview === true && Array.isArray(initial.reviews) && initial.reviews.length === 0 && initial.criteria?.length, 'review-initial-state');
          const criterion = initial.criteria.find((c: Json) => /source|evidence|information/i.test(`${c.id} ${c.name}`)) ?? initial.criteria[0];
          const body = {exerciseId: args.exerciseId, eventId: selected.eventId, hash: record.hash, section: 'headline', index: 0, disposition: 'edited',
            criterionId: criterion.id,
            explanation: 'Automated demo review (scripted instructor action; unscored; not a human instructor judgment). It exercises the correction path for this recorded order.',
            editedText: 'Automated demo correction: this order rested on authored fictional reports, one repeating another and two in unresolved conflict. The record shows what was cited and when, not whether the choice was sound.',
            nextPractice: `Automated demo next practice: from tick ${selected.observedTick}, commit a smaller ${BRANCH_SHARE * 100}% share while the cited reports remain unresolved, then compare both records in review.`,
            requestId: randomUUID(), expectedReviewId: null};
          const saved = await read(instructor, '/api/learning/reviews', body, POST_MS);
          const commanderHistory = await read(commander, query);
          const commanderRead = await read(commander, `/api/learning/debrief/${selected.eventId}`);
          const chain = verifyReviewChain({generated, instructorRead, commanderHistory, commanderRead, saved, body, exerciseId: args.exerciseId, eventId: selected.eventId});
          review = {...chain, body};
          keep('reviews', {saved, commanderHistory});
          proof.review = {reviewId: chain.reviewId, disposition: 'edited', scored: false, automated: true, section: 'headline', index: 0, criterionId: criterion.id,
            explanation: body.explanation, editedText: body.editedText, nextPractice: body.nextPractice, commanderRetrieved: true, originalDebriefUnchanged: true, debriefHash: chain.debriefHash};
          fact('automated-instructor-correction-retrievable', true, {reviewId: chain.reviewId, eventId: selected.eventId, debriefHash: chain.debriefHash});
        } catch (e) { soft('review', e); fact('automated-instructor-correction-retrievable', false, {failure: errorCode(e)}); }
      } else fact('automated-instructor-correction-retrievable', false, {reason: 'no-generated-debrief'});

      // ---- one isolated branch from the recorded decision, one described alternative legal order ----
      phase = 'branch';
      const branchEnd = Date.now() + BRANCH_MS;
      try {
        const row = await read(commander, '/api/branches', {tick: selected.observedTick, side: 'blue'}, POST_MS);
        if (UUID.test(row?.id)) guard.branchId = row.id;
        guard.phase = 'branch';
        let bov = await read(commander, '/api/overview', undefined, OVERVIEW_MS);
        const b = verifyBranch({row, overview: bov, parentId: args.exerciseId, forkTick: selected.observedTick, subject, parentRecord: recordBefore,
          parentFinalFingerprint: finalOverview.state.fingerprint});
        proof.branch = {...b, parentId: args.exerciseId, forkTick: selected.observedTick, fromDecision: selectedKey, fromEventId: selected.eventId, ownerIsCommander: true, side: 'blue'};
        fact('branch-created-from-recorded-decision', true, proof.branch, b.branchId);
        keep('branch', {row, overview: compactOverview(bov)});
        const blue = bov.state.players.find((p: Json) => p.side === 'blue');
        const copies = (reportIds: string[]) => ids(args.exerciseId, reportIds).map(id => `${b.branchId}:${id}`);
        const branchSources = selectedKey === 'D1' ? copies(['blue-r05', 'blue-r06', 'blue-r07']) : copies(['blue-r02', 'blue-r03']);
        let intent: Json | undefined, kind = 'none';
        if (neutralFrontier(bov.state, 'blue') && Math.floor(blue.troops * BRANCH_SHARE) >= 1) { intent = {type: 'attack', targetID: null, troops: Math.floor(blue.troops * BRANCH_SHARE)}; kind = 'smaller-expansion'; }
        else {
          const options = await read(commander, `/api/action-options?${new URLSearchParams({exerciseId: b.branchId})}`);
          const landing = options.naval?.status === 'available' ? (options.naval.landings ?? []).find((l: Json) => l.intent?.type === 'boat' && JSON.stringify(l.intent) !== JSON.stringify(selected.intent)) : undefined;
          if (landing) { intent = landing.intent; kind = 'listed-naval-alternative'; }
        }
        if (intent && JSON.stringify(intent) === JSON.stringify(selected.intent)) { intent = undefined; kind = 'no-distinct-alternative'; }
        const text = `${BRANCH_AUTHORED} alternative to recorded order ${selected.eventId} in exercise ${args.exerciseId}${review ? `, following automated review ${review.reviewId} next practice` : ''}: ${kind === 'smaller-expansion' ? `a ${BRANCH_SHARE * 100}% neutral expansion` : 'a different listed legal naval order'}. Original intent: ${JSON.stringify(selected.intent)}. The cited reports are this branch's copies of the original sources.`;
        proof.branch.order = {kind, intent: intent ?? null, rationale: text, sourceIds: branchSources};
        if (!intent) { proof.partial.push({phase: 'branch-order', code: 'no-legal-alternative-listed'}); fact('branch-alternative-order-recorded', false, {reason: 'no-legal-alternative-listed'}, b.branchId); }
        else {
          const r = await call(commander, '/api/commands', {side: 'blue', idempotencyKey: randomUUID(), intent, observationReceipt: bov.observationReceipt, rationale: text, sourceIds: branchSources});
          proof.branch.order.httpStatus = r.status;
          if (r.status !== 202 || !UUID.test(r.data?.id)) { proof.branch.order.refusal = short(r.data?.error) ?? `HTTP ${r.status}`; fact('branch-alternative-order-recorded', false, {refusal: proof.branch.order.refusal}, b.branchId); }
          else {
            let event: Json | undefined, rejected: Json | undefined;
            while (!event && !rejected && Date.now() < branchEnd) {
              await delay(1000, undefined, {signal: total.signal});
              bov = await read(commander, '/api/overview', undefined, OVERVIEW_MS);
              check(bov.activeId === b.branchId, 'branch-overview-changed');
              event = (bov.timeline ?? []).find((e: Json) => e.kind === 'command' && e.details?.commandId === r.data.id);
              rejected = (bov.timeline ?? []).find((e: Json) => e.kind === 'command_rejected' && e.details?.commandId === r.data.id);
            }
            if (event) {
              const v = verifyOrderEvent(bov.timeline, bov.reports ?? [], {exerciseId: b.branchId, commandId: r.data.id, subject, sourceIds: branchSources,
                observedMin: selected.observedTick, observedMax: Number.MAX_SAFE_INTEGER, mention: [selected.eventId, ...(review ? [review.reviewId] : [])], label: BRANCH_AUTHORED});
              Object.assign(proof.branch.order, {...v, exerciseId: b.branchId});
              fact('branch-alternative-order-recorded', true, {eventId: v.eventId, observedTick: v.observedTick, recordedTick: v.recordedTick, branchId: b.branchId}, b.branchId);
            } else {
              proof.branch.order.refusal = rejected ? short(rejected.details?.reason) : 'not-observed-before-branch-deadline';
              fact('branch-alternative-order-recorded', false, {refusal: proof.branch.order.refusal}, b.branchId);
            }
            keep('branchOrderOverview', compactOverview(bov));
          }
        }
        const ended = await read(commander, `/api/exercises/${b.branchId}/finish`, {});
        branchEnded = ended.id === b.branchId && ended.status === 'completed' && ended.kind === 'branch';
        proof.branch.ended = branchEnded;
        fact('branch-ended', branchEnded, {branchId: b.branchId}, b.branchId);
      } catch (e) {
        soft('branch', e);
        if (!facts.some(f => f.id === 'branch-created-from-recorded-decision')) fact('branch-created-from-recorded-decision', false, {failure: errorCode(e)});
      }

      // ---- the same original afterwards: record, completed state, debrief and review unchanged ----
      phase = 'source-unchanged';
      try {
        equal((await read(commander, '/api/select', {exerciseId: args.exerciseId})).selected, args.exerciseId, 'return-to-original');
        const after = await read(commander, '/api/overview', undefined, OVERVIEW_MS);
        const recordAfter = await read(commander, `/api/record/${args.exerciseId}`);
        const unchanged = verifySourceUnchanged({recordSha256: recordSha, overview: finalOverview}, {recordSha256: sha(JSON.stringify(recordAfter)), overview: after}, args.exerciseId);
        if (generated) {
          equal(JSON.stringify((await read(commander, `/api/learning/debrief/${selected.eventId}`)).record), JSON.stringify(generated.record), 'original-debrief-changed-after-branch');
          if (review) {
            const history = await read(commander, '/api/learning/reviews?' + new URLSearchParams({exerciseId: args.exerciseId, eventId: selected.eventId, hash: generated.record.hash}));
            check(history.reviews?.length === 1 && history.reviews[0].id === review.reviewId, 'review-history-changed-after-branch');
          }
        }
        proof.sourceUnchanged = {...unchanged, recordSha256: recordSha, debriefUnchanged: !!generated, reviewUnchanged: !!review};
        fact('source-record-unchanged', true, proof.sourceUnchanged);
      } catch (e) { soft('source-unchanged', e); fact('source-record-unchanged', false, {failure: errorCode(e)}); }
    }
  } catch (e) {
    fatal = shared.violation ?? (total.signal.aborted ? 'total-wallclock-deadline' : errorCode(e));
    proof.failure = {phase, code: fatal};
    if (exerciseCreation === 'pending') exerciseCreation = 'uncertain';
    process.exitCode = 1;
  } finally {
    if (shared.violation && !fatal) { fatal = shared.violation; proof.failure = {phase, code: shared.violation}; process.exitCode = 1; }
    guard.cleanup = true; clearTimeout(totalTimer); streamStop.abort(); total.abort();
    const step = async (name: string, action: () => Promise<unknown>) => {
      try { await withDeadline(() => action(), CLEANUP_STEP_MS, `${name}-deadline`); return true; }
      catch (e) { (proof.cleanupFailures ??= []).push({step: name, code: errorCode(e)}); process.exitCode = 1; return false; }
    };
    proof.streamClosed = await step('stream-close', () => streamTask ?? Promise.resolve());
    proof.tomoSettled = await step('tomo-settle', () => tomoTask ?? Promise.resolve());
    if (commander && guard.roomId) proof.tomoDetailRetained = await step('tomo-detail', async () => write(detailPath, await read(commander!, `${PREFIX}/${guard.roomId}`)));
    // End only this attempt's runs. The branch is the Commander's active run until the Commander returns to the original.
    if (commander && guard.branchId && !branchEnded) proof.branchEndedInCleanup = await step('end-branch', async () => {
      equal((await read(commander!, '/api/select', {exerciseId: guard.branchId})).selected, guard.branchId, 'cleanup-select-branch');
      equal((await read(commander!, `/api/exercises/${guard.branchId}/finish`, {})).status, 'completed', 'branch-finish-contract');
      branchEnded = true;
    });
    if (commander && !args.exerciseId && exerciseCreation === 'uncertain') await step('reconcile-exercise', async () => {
      const rows = ((await read(commander!, '/api/overview', undefined, OVERVIEW_MS)).exercises ?? []).filter((e: Json) => e.name === exerciseName);
      proof.exerciseCreationReconciled = rows.length === 1 ? 'found' : rows.length === 0 ? 'not-visible' : 'ambiguous';
      if (rows.length === 1) { args.exerciseId = rows[0].id; guard.exerciseId = rows[0].id; }
    });
    if (args.exerciseId && !originalEnded) proof.originalEndedInCleanup = await step('end-original', async () => {
      const who = instructor ?? commander!;
      equal((await read(who, '/api/select', {exerciseId: args.exerciseId})).selected, args.exerciseId, 'cleanup-select-original');
      equal((await read(who, `/api/exercises/${args.exerciseId}/finish`, {})).status, 'completed', 'finish-contract');
      originalEnded = true;
    });
    if (instructor && proof.budgetBefore) await step('budget-after', async () => {
      proof.budgetAfter = budgetProjection((await read(instructor!, '/api/agents/tools')).budget);
      proof.newRequestsObserved = proof.budgetAfter.requestsUsed - proof.budgetBefore.requestsUsed;
      check(proof.budgetAfter.maxRequests === REQUEST_CAP && proof.budgetAfter.maxUsd === USD_CAP && proof.newRequestsObserved >= 0
        && proof.budgetAfter.committedUsd >= proof.budgetBefore.committedUsd, 'budget-after-contract');
    });
    for (const [name, who] of [['intelligence-logout', intel], ['commander-logout', commander], ['instructor-logout', instructor]] as const)
      if (who) await step(name, () => who.close());
    globalThis.fetch = nativeFetch;
    const cleanupComplete = !proof.cleanupFailures?.length && (!args.exerciseId || originalEnded) && (!guard.branchId || branchEnded);
    fact('cleanup-complete', cleanupComplete, {originalEnded, branchEnded: guard.branchId ? branchEnded : 'no-branch', streamClosed: proof.streamClosed});
    const outcome = classify(facts, fatal);
    Object.assign(proof, {status: outcome.status, unmetFacts: outcome.unmet, exerciseCreation, requests: guard.requests, cleanupRequests: guard.cleanupRequests,
      mutationCounts: guard.counts, eventTypes: observation?.eventTypes.length ?? 0, lastDurablePosition: observation?.lastPosition ?? 0,
      limitations: ['Blue orders are a fixed scripted baseline; the authored reason does not change the intent the script would otherwise issue.',
        'Neutral-frontier reachability is estimated from the overview map (land/owner only); impassable terrain is not in that projection.',
        'Tomo request usage is read from the global ledger, which other workroom activity can also move; it is observed, not bounded per input.',
        'Alerts are verified in the Commander (Blue) view; the opposing side is not inspected before the exercise ends.',
        'The branch continues from the order\'s observation tick; packet releases after the fork are not claimed.',
        'Recorded UI from this exercise is a separate later step; this proof contains API facts only.'],
      finishedAt: new Date().toISOString()});
    if (proof.status !== 'demonstrated-main-review-pending') process.exitCode = 1;
    proof.exitCode = process.exitCode === 1 ? 1 : 0;
    try { save(); if (proof.redactionFailure) { proof.status = 'redaction-check-failed'; process.exitCode = 1; } }
    finally { for (const fd of fds.values()) fs.closeSync(fd); }
    // No identities, tool output, debrief content or credentials in stdout.
    console.log(JSON.stringify({artifact, status: proof.status, unmetFacts: proof.unmetFacts, failure: proof.failure, exerciseId: args.exerciseId || null,
      branchId: guard.branchId || null, originalEnded, branchEnded, newRequestsObserved: proof.newRequestsObserved, cleanupFailures: proof.cleanupFailures, exitCode: proof.exitCode}));
  }
}

// ---------------------------------------------------------------------------
// Offline self-test: synthetic records only; no files, credentials or network.
// ---------------------------------------------------------------------------

function selfTest() {
  const ex = '11111111-2222-4333-8444-555555555555', branch = '99999999-8888-4777-8666-555555555555', subject = 'commander-subject', intel = 'intel-subject';
  const sid = (r: string) => storedId(ex, r);
  const releases: Record<string, number> = {'blue-r01': 0, 'blue-r02': 300, 'blue-r03': 300, 'blue-r04': 600, 'blue-r05': 600, 'blue-r06': 900, 'blue-r07': 900, 'blue-r08': 1200};
  const reports = Object.entries(releases).map(([r, tick]) => ({id: sid(r), side: 'blue', tick}));

  // Guard: exact routes, phases and one-shot mutations.
  const g = newGuard(), post = (p: string, b: Json = {}) => permit(g, 'POST', APP + p, JSON.stringify(b)), get = (p: string) => permit(g, 'GET', APP + p);
  const denied = (fn: () => unknown, code: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GuardViolation && code.test((e as Error).message));
  denied(() => get('/api/overview?x=1'), /query-not-permitted/);
  denied(() => permit(g, 'GET', 'http://example.test/api/overview'), /native-origin-only/);
  post('/api/native/login'); post('/api/exercises');
  denied(() => post('/api/exercises'), /route-phase|retry-forbidden/);
  g.exerciseId = ex; g.roomId = 'a'.repeat(32);
  denied(() => post(`${PREFIX}/${g.roomId}/inputs`), /route-phase/);
  g.phase = 'original';
  post(`${PREFIX}/${g.roomId}/inputs`);
  denied(() => post(`${PREFIX}/${g.roomId}/inputs`), /input-retry-forbidden/);
  for (const p of ['/api/agent', '/api/replay', '/api/tasks', '/api/staff', '/mcp', '/api/reports/inject']) denied(() => post(p, {enabled: true}), /not-permitted/);
  denied(() => post('/api/commands', {side: 'red'}), /route-phase/);
  for (let i = 0; i < MAX_ORDERS; i++) post('/api/commands', {side: 'blue'});
  denied(() => post('/api/commands', {side: 'blue'}), /command-retry-forbidden/);
  denied(() => post('/api/learning/debrief', {eventId: 'e'}), /route-phase/);
  denied(() => post('/api/exercises/other/finish'), /not-permitted/);
  post(`/api/exercises/${ex}/finish`);
  denied(() => post(`/api/exercises/${ex}/finish`), /finish:original-retry-forbidden/);
  g.phase = 'review'; g.debriefEventId = 'event-1';
  denied(() => post('/api/learning/debrief', {eventId: 'other'}), /route-phase/);
  assert.equal(post('/api/learning/debrief', {eventId: 'event-1'}), DEBRIEF_MS);
  denied(() => post('/api/learning/debrief', {eventId: 'event-1'}), /debrief-retry-forbidden/);
  denied(() => get(`/api/learning/reviews?exerciseId=${branch}&eventId=event-1&hash=h`), /reviews-scope/);
  get(`/api/learning/reviews?exerciseId=${ex}&eventId=event-1&hash=h`);
  denied(() => post('/api/select', {exerciseId: branch}), /select-other-exercise/);
  post('/api/branches', {tick: 960, side: 'blue'}); g.branchId = branch; g.phase = 'branch';
  denied(() => post('/api/branches', {tick: 960, side: 'blue'}), /route-phase|retry-forbidden/);
  post('/api/commands', {side: 'blue'});
  denied(() => post('/api/commands', {side: 'blue'}), /branch-command-retry-forbidden/);
  get(`/api/action-options?exerciseId=${branch}`);
  g.cleanup = true; post(`/api/exercises/${ex}/finish`);
  denied(() => post(`/api/exercises/${ex}/finish`), /cleanup-finish:original-retry-forbidden/);
  denied(() => post(`${PREFIX}/${g.roomId}/inputs`), /route-phase/);

  // Budget: at least four requests left and unchanged caps.
  assert.equal(budgetAllows({requestsUsed: 96, maxRequests: 100, committedUsd: 0.1, maxUsd: 5}, MIN_REQUESTS_LEFT), true);
  assert.equal(budgetAllows({requestsUsed: 97, maxRequests: 100, committedUsd: 0.1, maxUsd: 5}, MIN_REQUESTS_LEFT), false);
  assert.equal(budgetAllows({requestsUsed: 10, maxRequests: 120, committedUsd: 0.1, maxUsd: 5}, MIN_REQUESTS_LEFT), false);
  assert.equal(budgetAllows({requestsUsed: 10, maxRequests: 100, committedUsd: 0.1, maxUsd: 6}, MIN_REQUESTS_LEFT), false);

  // Neutral frontier on a 3x3 map: Blue (smallId 1) at centre.
  const state = (owners: number[], land = owners.map(() => 1)) => ({width: 3, height: 3, owners, land, players: [{side: 'blue', smallId: 1, alive: true}]});
  assert.equal(neutralFrontier(state([2, 0, 2, 2, 1, 2, 2, 2, 2]), 'blue'), true);
  assert.equal(neutralFrontier(state([0, 2, 0, 2, 1, 2, 0, 2, 0]), 'blue'), false);
  assert.equal(neutralFrontier(state([2, 0, 2, 2, 1, 2, 2, 2, 2], [1, 0, 1, 1, 1, 1, 1, 1, 1]), 'blue'), false);
  assert.equal(neutralFrontier(state([2, 2, 0, 1, 2, 2, 2, 2, 2]), 'blue'), false, 'row wrap is not adjacency');
  assert.equal(neutralFrontier({...state([2, 0, 2, 2, 1, 2, 2, 2, 2]), players: [{side: 'blue', smallId: 1, alive: false}]}, 'blue'), false);

  // Schedule: D0 only before the correction, D1 only after the conflict.
  const all = new Set(reports.map(r => r.id)), early = new Set(reports.filter(r => r.tick <= 300).map(r => r.id));
  assert.equal(nextSlotAfter(360), 480); assert.equal(nextSlotAfter(479), 480);
  assert.equal(decisionFor(362, early, ex, {D0: false, D1: false}), 'D0');
  assert.equal(decisionFor(600, all, ex, {D0: false, D1: false}), null);
  assert.equal(decisionFor(965, early, ex, {D0: true, D1: false}), null);
  assert.equal(decisionFor(965, all, ex, {D0: true, D1: false}), 'D1');
  assert.equal(decisionFor(965, all, ex, {D0: true, D1: true}), null);

  // Alerts for a watch created at tick 120.
  const task = {id: 'task-1', side: 'blue', createdTick: 120};
  const alert = (tick: number, extra: Json = {}) => ({id: `alert-${tick}`, kind: 'staff_update', tick, side: 'blue',
    summary: tick === 600 ? 'Correction supersedes Marsh reserve estimate' : tick === 900 ? 'Tidewell Station available · unresolved conflict' : 'released',
    details: {taskId: task.id, method: METHOD, observedTick: tick, sourceIds: ids(ex, EXPECTED_ALERT_SOURCES[tick]).reverse(), ...extra}});
  const timeline = [alert(300), alert(600), alert(900), alert(1200)];
  const byTick = verifyAlerts(timeline, reports, task, ex);
  assert.deepEqual(Object.keys(byTick).map(Number), [300, 600, 900, 1200]);
  assert.deepEqual(missingAlerts(byTick, 120, 1230), []);
  assert.deepEqual(missingAlerts({300: byTick[300]}, 120, 1000), [600, 900]);
  assert.deepEqual(missingAlerts({}, 450, 1000), [600, 900]);
  const badAlert = (tl: Json[], code: RegExp, t = task) => assert.throws(() => verifyAlerts(tl, reports, t, ex), code);
  badAlert([alert(600, {method: 'model staff agent'})], /paid-analysis/);
  badAlert([alert(300)], /unexpected-watch-update/, {...task, createdTick: 450});
  badAlert([alert(900, {sourceIds: [sid('blue-r06')]})], /alert-900-sources/);
  badAlert([alert(600), alert(600)], /duplicate/);
  badAlert([{...alert(900), summary: 'no conflict'}], /conflict-alert-summary/);
  assert.throws(() => verifyAlerts([alert(600)], reports.filter(r => r.id !== sid('blue-r04')), task, ex), /alert-source-unresolved/);

  // Intelligence assessment.
  const assessmentEvent = {id: 'assess-1', kind: 'assessment_log', actor: intel, side: 'blue', tick: 331,
    details: {author: intel, authorRole: 'intelligence', sourceIds: [sid('blue-r03'), sid('blue-r02')], timing: 'contemporaneous', observedTick: 331}};
  assert.equal(verifyAssessment([assessmentEvent], {eventId: 'assess-1', exerciseId: ex, subject: intel}).observedTick, 331);
  assert.throws(() => verifyAssessment([{...assessmentEvent, actor: subject}], {eventId: 'assess-1', exerciseId: ex, subject: intel}), /author-side/);
  assert.throws(() => verifyAssessment([{...assessmentEvent, details: {...assessmentEvent.details, observedTick: 600}}], {eventId: 'assess-1', exerciseId: ex, subject: intel}), /time-chain/);

  // Orders: D0 before the correction citing r02/r03; D1 after the conflict, linked to the alert by ID.
  const order = (commandId: string, observedTick: number, sourceIds: string[], rationale: string, extra: Json = {}) => ({id: `event-${commandId}`, kind: 'command', actor: subject, side: 'blue', tick: observedTick + 3,
    details: {commandId, origin: 'human', observedTick, admittedTick: observedTick + 1, observationBasis: 'app-snapshot-returned-with-order',
      observation: {tick: observedTick, exerciseId: ex, subject, side: 'blue'}, sourceIds, rationale, rationaleTiming: 'contemporaneous',
      intent: {type: 'attack', targetID: null, troops: 20}, fingerprint: 'f'.repeat(64), ...extra}});
  const d0Sources = ids(ex, ['blue-r02', 'blue-r03']), d1Sources = ids(ex, ['blue-r05', 'blue-r06', 'blue-r07']);
  const d0Text = `${AUTHORED} one account. Linked Intelligence assessment assess-1.`, d1Text = `${AUTHORED} Watch alert alert-900 recorded conflict.`;
  const x0: OrderExpectation = {exerciseId: ex, commandId: 'c0', subject, sourceIds: d0Sources, observedMin: 300, observedMax: D0_LAST_TICK, mention: ['assess-1'], label: AUTHORED};
  const d0 = verifyOrderEvent([order('c0', 362, d0Sources, d0Text)], reports, x0);
  assert.deepEqual([d0.observedTick, d0.admittedTick, d0.recordedTick, d0.releasedTicks[sid('blue-r02')]], [362, 363, 365, 300]);
  const badOrder = (event: Json, code: RegExp, x = x0) => assert.throws(() => verifyOrderEvent([event], reports, x), code);
  badOrder(order('c0', 600, d0Sources, d0Text), /observed-window/);
  badOrder({...order('c0', 362, d0Sources, d0Text), actor: 'other'}, /owner-side/);
  badOrder(order('c0', 362, d0Sources, 'Model decided to expand'), /authored-rationale/);
  badOrder(order('c0', 362, d0Sources, `${AUTHORED} no link`), /authored-rationale/);
  badOrder(order('c0', 362, d0Sources, d0Text, {observation: {tick: 360, exerciseId: ex, subject, side: 'blue'}}), /observation-receipt/);
  badOrder(order('c0', 362, d0Sources, d0Text, {admittedTick: 361}), /time-chain/);
  badOrder(order('c0', 362, [sid('blue-r02')], d0Text), /order-sources/);
  badOrder(order('c0', 362, [...d0Sources, sid('blue-r04')], d0Text), /order-sources/);
  assert.throws(() => verifyOrderEvent([order('c0', 290, d0Sources, d0Text)], reports, {...x0, observedMin: 0}), /unreleased/);
  badOrder({...order('c0', 362, d0Sources, d0Text)}, /missing-or-duplicated/, {...x0, commandId: 'other'});
  const x1: OrderExpectation = {...x0, commandId: 'c1', sourceIds: d1Sources, observedMin: D1_FIRST_TICK, observedMax: LATE_RELEASE - 1, mention: ['alert-900']};
  const d1 = verifyOrderEvent([order('c1', 962, d1Sources, d1Text)], reports, x1);
  const link = verifyAlertLink(d1, d1Text, byTick, ex);
  assert.deepEqual([link.alertEventId, link.alertTick, link.correctionAlertEventId], ['alert-900', 900, 'alert-600']);
  assert.throws(() => verifyAlertLink(d1, `${AUTHORED} no alert id`, byTick, ex), /missing-alert-id/);
  assert.throws(() => verifyAlertLink({...d1, observedTick: 899}, d1Text, byTick, ex), /observed-before-alert/);
  assert.throws(() => verifyAlertLink({...d1, sourceIds: ids(ex, ['blue-r05', 'blue-r06'])}, d1Text, byTick, ex), /missing-alert-sources/);
  assert.throws(() => verifyAlertLink({...d1, sourceIds: ids(ex, ['blue-r06', 'blue-r07'])}, d1Text, byTick, ex), /disputed-source/);
  assert.throws(() => verifyAlertLink(d1, d1Text, {600: byTick[600]}, ex), /conflict-alert-missing/);

  // Debrief and automated review chain.
  const generated = {status: 'generated', record: {schema: 'replay.debrief-record/1', exerciseId: ex, eventId: d1.eventId, hash: 'a'.repeat(64),
    receipt: {id: 'receipt-1', modelReturned: 'luna'}, debrief: {headline: {text: 'Original model claim', citations: [d1.eventId]}}}};
  const body = {criterionId: 'evidence', explanation: 'Automated demo review', editedText: 'Automated demo correction', nextPractice: 'Automated demo next practice'};
  const saved = {id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', disposition: 'edited', exerciseId: ex, eventId: d1.eventId, hash: generated.record.hash, originalText: 'Original model claim'};
  const history = {exerciseId: ex, eventId: d1.eventId, canReview: false, reviews: [{...saved, ...body}]};
  const chain = {generated, instructorRead: {record: structuredClone(generated.record)}, commanderRead: {record: structuredClone(generated.record)},
    commanderHistory: history, saved, body, exerciseId: ex, eventId: d1.eventId};
  assert.equal(verifyReviewChain(chain).reviewId, saved.id);
  const badChain = (patch: (c: Json) => void, code: RegExp) => { const c = structuredClone(chain) as Json; patch(c); assert.throws(() => verifyReviewChain(c as any), code); };
  badChain(c => { c.commanderRead.record.debrief.headline.text = 'rewritten'; }, /original-debrief-changed/);
  badChain(c => { c.commanderHistory.canReview = true; }, /commander-review-history/);
  badChain(c => { c.commanderHistory.reviews.push(c.commanderHistory.reviews[0]); }, /commander-review-history/);
  badChain(c => { c.saved.disposition = 'accepted'; }, /saved-review-contract/);
  badChain(c => { c.saved.originalText = 'other'; }, /review-original-text/);
  badChain(c => { c.commanderHistory.reviews[0].nextPractice = 'other'; }, /commander-review-facts/);
  badChain(c => { c.generated.record.exerciseId = branch; }, /debrief-record-contract/);

  // Branch from the recorded decision and unchanged source.
  const parentRecord = {fingerprints: {'962': 'c'.repeat(64), '1234': 'd'.repeat(64)}};
  const row = {id: branch, kind: 'branch', parentId: ex, forkTick: 962, humanSide: 'blue', status: 'running', agentEnabled: false, options: {ownerSubject: subject}};
  const bov = {activeId: branch, playbackTick: null, reports: [{id: `${branch}:${sid('blue-r06')}`, tick: 900}],
    timeline: [{id: 'bc', kind: 'branch_created', tick: 962, details: {parentId: ex, forkTick: 962, fingerprint: 'c'.repeat(64), originalFingerprint: 'd'.repeat(64)}}]};
  const bx = {row, overview: bov, parentId: ex, forkTick: 962, subject, parentRecord, parentFinalFingerprint: 'd'.repeat(64)};
  assert.equal(verifyBranch(bx).branchCreatedEventId, 'bc');
  const badBranch = (patch: (b: Json) => void, code: RegExp) => { const b = structuredClone(bx) as Json; patch(b); assert.throws(() => verifyBranch(b as any), code); };
  badBranch(b => { b.row.parentId = branch; }, /branch-row-contract/);
  badBranch(b => { b.row.options.ownerSubject = intel; }, /branch-row-contract/);
  badBranch(b => { b.row.agentEnabled = true; }, /branch-row-contract/);
  badBranch(b => { b.overview.timeline[0].details.fingerprint = 'e'.repeat(64); }, /fork-fingerprint/);
  badBranch(b => { b.overview.timeline[0].details.originalFingerprint = 'e'.repeat(64); }, /original-fingerprint/);
  badBranch(b => { b.forkTick = 963; b.row.forkTick = 963; }, /branch-created-event/);
  badBranch(b => { b.overview.reports.push({id: sid('blue-r08'), tick: 1200}); }, /report-copies/);
  const source = {activeId: ex, exercises: [{id: ex, status: 'completed'}], state: {tick: 1234, fingerprint: 'd'.repeat(64)}, timeline: [order('c0', 362, d0Sources, d0Text), order('c1', 962, d1Sources, d1Text)]};
  assert.equal(verifySourceUnchanged({recordSha256: 'r', overview: source}, {recordSha256: 'r', overview: structuredClone(source)}, ex).humanOrders, 2);
  assert.throws(() => verifySourceUnchanged({recordSha256: 'r', overview: source}, {recordSha256: 's', overview: source}, ex), /source-record-changed/);
  assert.throws(() => verifySourceUnchanged({recordSha256: 'r', overview: source}, {recordSha256: 'r', overview: {...source, state: {tick: 1300, fingerprint: 'x'}}}, ex), /source-overview-changed/);
  assert.throws(() => verifySourceUnchanged({recordSha256: 'r', overview: source}, {recordSha256: 'r', overview: {...source, timeline: [...source.timeline, order('c2', 970, [], AUTHORED)]}}, ex), /source-overview-changed/);
  assert.throws(() => verifySourceUnchanged({recordSha256: 'r', overview: {...source, exercises: [{id: ex, status: 'running'}]}}, {recordSha256: 'r', overview: source}, ex), /source-not-completed/);

  // Outcome classification and public redaction.
  const everything = REQUIRED_FACTS.map(id => ({id, met: true}));
  assert.equal(classify(everything, null).status, 'demonstrated-main-review-pending');
  assert.deepEqual(classify(everything.filter(f => f.id !== 'conflict-alert-900'), null), {status: 'partial-retained', unmet: ['conflict-alert-900']});
  assert.equal(classify([...everything, {id: 'luna-debrief-generated', met: false}], null).status, 'partial-retained');
  assert.equal(classify(everything, 'request-route-not-permitted').status, 'incomplete-retained');
  assertPublicSafe(JSON.stringify({subjects: {commanderSha256: sha(subject)}}), [subject]);
  assert.throws(() => assertPublicSafe(JSON.stringify({actor: subject}), [subject]), /identity-in-public-output/);
  assert.throws(() => assertPublicSafe(JSON.stringify({observationReceipt: 'x'}), []), /secret-field/);
  assert.equal(compactOverview({state: {owners: [1], land: [1], tick: 3}, observationReceipt: 'r'}).state.owners, undefined);
  assert.throws(() => attemptArguments(['0.21', 'a']), /Version/);
  console.log('Offline integrated demo checks passed: guard routes/phases/one-shot mutations, budget gate, neutral frontier, D0/D1 schedule, free alert sources/ticks, assessment, order owner/receipt/release/authored-reason chain, alert ID link, debrief/review retention, branch fork fingerprints, unchanged source, outcome classification, redaction. No native calls.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
    else await run(process.argv.slice(2));
  } catch (e) { console.error(JSON.stringify({status: 'startup-failed', code: errorCode(e)})); process.exitCode = 1; }
}
