/** Main-dispatched only: VERSION ATTEMPT_LABEL. One bounded substantive-practice branch from the retained 0.21.1 integrated demo; --self-test is offline.
 * Contract: docs/process/substantive-practice-contract.md. Commander login only, no model call, no debrief, no instructor edit, no retry.
 * Chain: select completed original → verify recorded order/debrief/automated review (10% next practice) → ONE Blue branch at tick 970
 * → same listed landing tile, floor(10%) of observed uncommitted forces → native admission/execution feedback → end branch → original unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {nativeAppClient} from './native-app-client';
import {attemptArguments, withDeadline} from './tomo-qualification-contract';
import {assertPublicSafe, ids, storedId, verifyBranch, verifyOrderEvent, verifySourceUnchanged} from './run-integrated-learning-demo';

const APP = 'http://127.0.0.1:5183';
const REVIEW_FILE = 'evidence/platform/integrated-learning-demo-0211-main-review.json';
/** The one known original and its recorded chain (main review, 2026-09-15). Every value is re-checked against the retained proof and the live record. */
export const KNOWN = {
  originalId: '70d107e2-f0e3-414c-bdc8-33e2cc6a9852', orderEventId: '5d92726b-61ca-4704-ad73-12d1da7bbe6d', observedTick: 970, recordedTick: 973,
  debriefHash: '5a8c0a2daa1a524fcb8f41587700a15955db01c5fc93acbb5de8a0c72806f0c5', reviewId: '506a0668-d315-4890-896e-054e855d6e2e',
  priorBranchId: '29f6982e-364a-43d7-8ed2-7849aa322171',
} as const;
const REPORTS = ['blue-r05', 'blue-r06', 'blue-r07'];
/** Whole operation ≤150 s: 110 s active phase plus a 40 s cleanup budget. */
const ACTIVE_MS = 110000, CLEANUP_MS = 40000, CLEANUP_STEP_MS = 10000;
const READ_MS = 15000, OVERVIEW_MS = 20000, POST_MS = 30000, POLL_MS = 1000;
const ACTIVE_REQUESTS = 70, CLEANUP_REQUESTS = 8;
/** Practice size and qualification thresholds. */
const SHARE_DIVISOR = 10, EXECUTION_WINDOW_TICKS = 120, OBSERVATION_LAG_TICKS = 120, ADMISSION_WAIT_TICKS = 60;
const ORIGINAL_SHARE_MIN = 0.15, ORIGINAL_SHARE_MAX = 0.25, MAX_BRANCH_TO_ORIGINAL = 0.6;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AUTHORED = 'Authored substantive practice prompt (automated operator; not a model, player or human decision):';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
type Json = Record<string, any>;
class Failure extends Error {}
class GuardViolation extends Failure {}
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Failure(code); }
const errorCode = (e: unknown) => e instanceof Failure ? e.message : 'operation-or-contract-failed';
const budgetProjection = (v: Json) => ({requestsUsed: v?.requestsUsed, maxRequests: v?.maxRequests, committedUsd: v?.committedUsd, maxUsd: v?.maxUsd});
const branchCopies = (branchId: string) => ids(KNOWN.originalId, REPORTS).map(id => `${branchId}:${id}`);

// ---------------------------------------------------------------------------
// Request guard: Commander only, exact routes, one branch, one Blue boat order to the original destination.
// ---------------------------------------------------------------------------

export type Phase = 'setup' | 'original' | 'branch' | 'return';
export interface Guard {cleanup: boolean; phase: Phase; branchId: string; dst: number | null; requests: number; cleanupRequests: number; counts: Record<string, number>}
export const newGuard = (): Guard => ({cleanup: false, phase: 'setup', branchId: '', dst: null, requests: 0, cleanupRequests: 0, counts: {}});
const deny = (ok: unknown, code: string) => { if (!ok) throw new GuardViolation(code); };
const bump = (g: Guard, key: string, max: number) => deny((g.counts[key] = (g.counts[key] ?? 0) + 1) <= max, `${key}-retry-forbidden`);
const bodyJson = (body: unknown): Json => { try { return typeof body === 'string' ? JSON.parse(body) ?? {} : {}; } catch { return {}; } };

/** Throws before a disallowed request leaves the process. Returns the per-request timeout. */
export function permit(g: Guard, method: string, href: string, body?: unknown): number {
  const url = new URL(href), p = url.pathname, q = url.searchParams, active = !g.cleanup, keys = [...q.keys()].sort().join();
  deny(url.origin === APP, 'native-origin-only');
  if (g.cleanup) deny(++g.cleanupRequests <= CLEANUP_REQUESTS, 'cleanup-request-cap'); else deny(++g.requests <= ACTIVE_REQUESTS, 'request-cap');
  if (method === 'GET') {
    if (p === '/api/action-options') { deny(active && g.phase === 'branch' && keys === 'exerciseId' && !!g.branchId && q.get('exerciseId') === g.branchId, 'action-options-scope'); return READ_MS; }
    if (p === '/api/learning/reviews') {
      deny(active && keys === 'eventId,exerciseId,hash' && q.get('exerciseId') === KNOWN.originalId && q.get('eventId') === KNOWN.orderEventId && q.get('hash') === KNOWN.debriefHash, 'reviews-scope');
      return READ_MS;
    }
    deny(!url.search, 'query-not-permitted');
    if (p === '/api/overview') { if (g.cleanup) bump(g, 'cleanup-overview', 1); return OVERVIEW_MS; }
    if (p === '/api/agents/tools') { if (g.cleanup) bump(g, 'cleanup-budget', 1); return READ_MS; }
    const reads = ['/replay-build.json', '/api/native/status', `/api/record/${KNOWN.originalId}`, `/api/learning/debrief/${KNOWN.orderEventId}`];
    deny(active && reads.includes(p), 'request-route-not-permitted');
    return READ_MS;
  }
  deny(method === 'POST' && !url.search, 'request-method-not-permitted');
  const b = bodyJson(body), phase = (ok: boolean) => deny(active && ok, 'route-phase');
  switch (p) {
    case '/api/native/login': phase(g.phase === 'setup'); bump(g, 'login', 1); return POST_MS;
    case '/api/native/logout': deny(g.cleanup, 'logout-cleanup-only'); bump(g, 'logout', 1); return READ_MS;
    case '/api/select':
      deny(b.exerciseId === KNOWN.originalId || !!g.branchId && b.exerciseId === g.branchId, 'select-other-exercise');
      deny(b.exerciseId === KNOWN.originalId || g.cleanup, 'select-branch-cleanup-only');
      bump(g, g.cleanup ? 'cleanup-select' : 'select', 2); return READ_MS;
    case '/api/branches':
      phase(g.phase === 'original' && !g.branchId && b.side === 'blue' && b.tick === KNOWN.observedTick && Object.keys(b).length === 2);
      bump(g, 'branch', 1); return POST_MS;
    case '/api/commands':
      phase(g.phase === 'branch' && b.side === 'blue' && b.intent?.type === 'boat' && g.dst !== null && b.intent.dst === g.dst
        && Number.isSafeInteger(b.intent.troops) && b.intent.troops >= 1 && Object.keys(b.intent).length === 3);
      bump(g, 'branch-command', 1); return POST_MS;
  }
  const finish = p.match(/^\/api\/exercises\/([^/]+)\/finish$/)?.[1];
  if (finish && g.branchId && finish === g.branchId) { bump(g, g.cleanup ? 'cleanup-finish:branch' : 'finish:branch', 1); return READ_MS; }
  // Includes ending the original or prior branch, debrief generation, review writes, replay seeking, controller and report routes.
  throw new GuardViolation('request-route-not-permitted');
}

// ---------------------------------------------------------------------------
// Offline-checkable acceptance functions
// ---------------------------------------------------------------------------

/** The retained public proof is byte-identical to what main reviewed and names the same original, order, debrief, review and prior branch. */
export function verifyPriorEvidence(review: Json, proofBytes: Buffer) {
  check(sha(proofBytes) === review.sourceSha256, 'prior-proof-hash-mismatch');
  const proof = JSON.parse(proofBytes.toString('utf8'));
  check(review.exerciseId === KNOWN.originalId && review.branchId === KNOWN.priorBranchId && typeof review.qualificationGap === 'string', 'prior-review-ids');
  const d1 = proof.decisions?.D1, sel = proof.selectedDecision, br = proof.branch;
  check(proof.exercise?.id === KNOWN.originalId && sel?.eventId === KNOWN.orderEventId && sel.observedTick === KNOWN.observedTick
    && d1?.eventId === KNOWN.orderEventId && d1.observedTick === KNOWN.observedTick && d1.recordedTick === KNOWN.recordedTick && d1.intent?.type === 'boat', 'prior-order-ids');
  check(proof.debrief?.hash === KNOWN.debriefHash && proof.debrief.eventId === KNOWN.orderEventId && proof.review?.reviewId === KNOWN.reviewId
    && proof.review.debriefHash === KNOWN.debriefHash && /\b10% share\b/.test(proof.review.nextPractice ?? ''), 'prior-debrief-review-ids');
  check(br?.branchId === KNOWN.priorBranchId && br.forkTick === KNOWN.observedTick && br.ended === true && br.order?.intent?.dst === d1.intent.dst, 'prior-branch-ids');
  check(/^[a-f0-9]{64}$/.test(proof.original?.recordSha256) && /^[a-f0-9]{64}$/.test(proof.original.finalFingerprint) && Number.isSafeInteger(proof.original.finalTick), 'prior-original-facts');
  return {commandId: d1.commandId as string, intent: d1.intent as {type: 'boat'; dst: number; troops: number}, admittedTick: d1.admittedTick as number,
    recordSha256: proof.original.recordSha256 as string, finalFingerprint: proof.original.finalFingerprint as string, finalTick: proof.original.finalTick as number,
    priorBranchTroops: br.order.intent.troops as number, priorForkFingerprint: br.forkFingerprint as string, nextPractice: proof.review.nextPractice as string};
}

/** The recorded original order in the completed record: same IDs, ticks and intent as the proof, with its own observed forces. */
export function verifyOriginalOrder(timeline: Json[], prior: ReturnType<typeof verifyPriorEvidence>, subject: string) {
  const rows = timeline.filter(e => e.id === KNOWN.orderEventId);
  check(rows.length === 1, 'original-order-missing-or-duplicated');
  const e = rows[0], d = e.details ?? {};
  check(e.kind === 'command' && e.side === 'blue' && e.actor === subject && d.origin === 'human' && d.commandId === prior.commandId, 'original-order-owner');
  check(e.tick === KNOWN.recordedTick && d.observedTick === KNOWN.observedTick && d.admittedTick === prior.admittedTick, 'original-order-ticks');
  try { assert.deepEqual(d.intent, prior.intent); } catch { throw new Failure('original-order-intent'); }
  const observedTroops = d.observation?.player?.troops;
  check(d.observationBasis === 'app-snapshot-returned-with-order' && d.observation?.tick === KNOWN.observedTick && Number.isFinite(observedTroops) && observedTroops > 0, 'original-order-observation');
  const share = d.intent.troops / observedTroops;
  check(share >= ORIGINAL_SHARE_MIN && share <= ORIGINAL_SHARE_MAX, 'original-order-not-about-20pct');
  return {eventId: e.id as string, commandId: d.commandId as string, intent: d.intent, observedTroops: observedTroops as number, shareOfObserved: Number(share.toFixed(4)),
    sourceIds: [...(d.sourceIds ?? [])].sort()};
}

/** Cached debrief and the single automated review, read-only; its next practice names the 10% share at tick 970. */
export function verifyDebriefReview(debrief: Json, history: Json) {
  check(debrief?.status === 'cached' && debrief.record?.hash === KNOWN.debriefHash && debrief.record.eventId === KNOWN.orderEventId
    && debrief.record.exerciseId === KNOWN.originalId, 'cached-debrief-contract');
  check(history?.exerciseId === KNOWN.originalId && history.eventId === KNOWN.orderEventId && history.hash === KNOWN.debriefHash
    && history.canReview === false && Array.isArray(history.reviews) && history.reviews.length === 1, 'review-history-contract');
  const r = history.reviews[0];
  check(r.id === KNOWN.reviewId && r.disposition === 'edited' && typeof r.nextPractice === 'string' && /\b10% share\b/.test(r.nextPractice)
    && r.nextPractice.includes(`tick ${KNOWN.observedTick}`), 'review-10pct-instruction');
  return {debriefRecordSha256: sha(JSON.stringify(debrief.record)), reviewsSha256: sha(JSON.stringify(history.reviews)), stale: debrief.stale === true,
    nextPractice: r.nextPractice as string, criterionId: r.criterionId ?? null};
}

/** Floor of 10% of the observed uncommitted forces; null when that is not at least one. */
export const tenPercent = (observedTroops: number) => Number.isFinite(observedTroops) && observedTroops >= SHARE_DIVISOR ? Math.floor(observedTroops / SHARE_DIVISOR) : null;

/** The recorded amount is exactly floor(10%) of the order's own receipt-backed observation and a meaningful cut from the recorded original. */
export function verifyPracticeSize(x: {branchTroops: number; branchObservedTroops: number; originalTroops: number; originalObservedTroops: number}) {
  check(Number.isSafeInteger(x.branchTroops) && x.branchTroops === tenPercent(x.branchObservedTroops), 'commanded-amount-not-floor-10pct');
  const share = x.branchTroops / x.branchObservedTroops, originalShare = x.originalTroops / x.originalObservedTroops;
  const reduction = x.originalTroops - x.branchTroops;
  // With the amount pinned to floor(10%), this ratio also implies a cut of at least 40% of the original amount.
  check(x.branchTroops <= x.originalTroops * MAX_BRANCH_TO_ORIGINAL, 'reduction-not-meaningful');
  return {commandedTroops: x.branchTroops, observedTroops: x.branchObservedTroops, commandedShare: Number(share.toFixed(4)), originalTroops: x.originalTroops,
    originalShare: Number(originalShare.toFixed(4)), troopReduction: reduction, branchToOriginalRatio: Number((x.branchTroops / x.originalTroops).toFixed(4))};
}

/** The listed validator-checked landing for the same destination tile; a missing listing ends the attempt (no unlisted guess). */
export function listedDestination(options: Json, branchId: string, dst: number, overviewTick: number) {
  check(options?.exerciseId === branchId && options.side === 'blue' && Number.isSafeInteger(options.tick) && options.tick >= overviewTick, 'action-options-contract');
  check(options.naval?.status === 'available' && Array.isArray(options.naval.landings), 'naval-options-unavailable');
  const rows = options.naval.landings.filter((l: Json) => l.intent?.type === 'boat' && l.intent.dst === dst);
  check(rows.length === 1, 'original-destination-not-listed');
  return {listedDefaultTroops: rows[0].intent.troops as number, target: rows[0].target as string, distanceFromCoast: rows[0].distanceFromCoast as number, optionsTick: options.tick as number};
}

/** Exactly one new branch of the original; every earlier branch (including the prior practice branch) is still present. */
export function verifyOneNewBranch(before: Json[], after: Json[], branchId: string) {
  const children = (rows: Json[]) => rows.filter(r => r.parentId === KNOWN.originalId && r.kind === 'branch').map(r => r.id as string).sort();
  const a = children(before), b = children(after);
  check(a.includes(KNOWN.priorBranchId) && b.includes(KNOWN.priorBranchId), 'prior-branch-not-retained');
  check(b.length === a.length + 1 && a.every(id => b.includes(id)) && b.filter(id => !a.includes(id)).join() === branchId, 'not-exactly-one-new-branch');
  const prior = after.find(r => r.id === KNOWN.priorBranchId);
  check(prior?.status === 'completed' && prior.forkTick === KNOWN.observedTick, 'prior-branch-changed');
  return {branchesBefore: a.length, branchesAfter: b.length};
}

const TERMINAL = new Set(['transport-landed', 'transport-forces-returned', 'transport-not-launched', 'transport-ended-unconfirmed', 'observation-failed']);
const NEGATIVE = new Set(['transport-not-launched', 'observation-failed']);
/** Engine execution feedback for this command inside the window after it was recorded. Absence is reported, never inferred. */
export function executionWindow(timeline: Json[], commandId: string, recordedTick: number, tick: number) {
  const rows = timeline.filter(e => e.kind === 'execution_feedback' && e.details?.commandId === commandId && e.tick <= recordedTick + EXECUTION_WINDOW_TICKS)
    .sort((a, b) => a.tick - b.tick);
  const statuses = rows.map(e => ({eventId: e.id as string, tick: e.tick as number, status: e.details.feedback?.status as string, observed: e.details.feedback?.observed ?? null}));
  const terminal = statuses.find(s => TERMINAL.has(s.status));
  const done = !!terminal || tick > recordedTick + EXECUTION_WINDOW_TICKS;
  const outcome = terminal ? (NEGATIVE.has(terminal.status) ? 'execution-refused' : terminal.status) : statuses.length ? `${statuses.at(-1)!.status}-no-terminal-within-window` : 'no-feedback-within-window';
  return {done, outcome, refused: !!terminal && NEGATIVE.has(terminal.status), statuses};
}

export const REQUIRED_FACTS = [
  'prior-evidence-consistent', 'commander-native-login', 'original-completed-record-unchanged', 'original-order-debrief-review-verified',
  'one-new-blue-branch-at-970', 'original-destination-listed-in-branch', 'ten-percent-order-admitted', 'ten-percent-order-recorded-with-lineage',
  'no-refusal-within-execution-window', 'branch-ended', 'returned-original-unchanged', 'zero-inference-ledger-delta', 'cleanup-complete'] as const;
export type FactId = typeof REQUIRED_FACTS[number];

export function classify(facts: {id: string; met: boolean}[], fatal: string | null) {
  const met = new Set(facts.filter(f => f.met).map(f => f.id));
  const unmet = REQUIRED_FACTS.filter(id => !met.has(id) || facts.some(f => f.id === id && !f.met));
  if (fatal) return {status: 'incomplete-retained', unmet};
  return {status: unmet.length ? 'partial-retained' : 'substantive-practice-qualified-main-review-pending', unmet};
}

export const freshLabel = (files: string[], version: string, suffix: string) => !files.some(f => f.startsWith(`substantive-practice-${version}-${suffix}-`));

export function rationaleText(x: {commandId: string; troops: number; observedTroops: number; observedTick: number; dst: number; originalTroops: number; originalShare: number}) {
  return `${AUTHORED} Branch practice of recorded order ${KNOWN.orderEventId} (command ${x.commandId}) in exercise ${KNOWN.originalId}, following automated review ${KNOWN.reviewId} next practice. `
    + `Same listed landing tile ${x.dst}; commit 10% of observed uncommitted forces (floor: ${x.troops} of ${x.observedTroops} at tick ${x.observedTick}) instead of the recorded ${x.originalTroops} (${Math.round(x.originalShare * 100)}%). `
    + `This branch's copies of blue-r05, blue-r06 (disputes blue-r05) and blue-r07 (repeats blue-r05) remain unresolved, so a smaller commitment keeps more in reserve. `
    + 'This is a size adjustment for comparison, not a claim that it is better or that anyone learned from the review.';
}

const compactOverview = (o: Json) => o && ({activeId: o.activeId, playbackTick: o.playbackTick, tick: o.state?.tick, fingerprint: o.state?.fingerprint,
  blue: o.state?.players?.find((p: Json) => p.side === 'blue') ?? null, mapSha256: Array.isArray(o.state?.owners) ? sha(JSON.stringify(o.state.owners)) : null,
  timeline: o.timeline, reports: o.reports});

// ---------------------------------------------------------------------------
// Native run (never reached by --self-test)
// ---------------------------------------------------------------------------

async function run(argv: string[]) {
  const {version, suffix} = attemptArguments(argv);
  check(argv.length === 2 && suffix, 'usage-version-attempt-label');
  check(freshLabel([...fs.readdirSync('evidence/platform'), ...(fs.existsSync('data/platform') ? fs.readdirSync('data/platform') : [])], version, suffix), 'attempt-label-not-fresh');
  const attempt = `${version}-${suffix}-${randomUUID()}`;
  const artifact = `evidence/platform/substantive-practice-${attempt}.json`, observedPath = `data/platform/substantive-practice-${attempt}-observed.json`;
  const fds = new Map<string, number>();
  fs.mkdirSync('data/platform', {recursive: true});
  try { for (const file of [artifact, observedPath]) fds.set(file, fs.openSync(file, 'wx', 0o600)); }
  catch (e) { for (const fd of fds.values()) fs.closeSync(fd); throw e; }
  const write = (file: string, data: unknown) => { const fd = fds.get(file)!; fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n', 0, 'utf8'); };

  const guard = newGuard(), subjects: string[] = [], observed: Json = {};
  const facts: {id: FactId; met: boolean; exerciseId: string | null; detail: Json}[] = [];
  const proof: Json = {schema: 'replay.substantive-practice/1', startedAt: new Date().toISOString(), version, attempt, status: 'starting',
    fictional: true, automatedOperation: true, humanValidated: false, modelPlayer: false, newDebrief: false, instructorEdits: 0,
    claimBoundary: ['One automated, fictional branch practice of a recorded order; not human play, human learning or model judgment.',
      'The order is a listed legal landing adjusted in size by a fixed rule; the rationale is authored by the operator script.',
      'A smaller commitment is not claimed to be better; no outcome comparison or strategic superiority is claimed.',
      'The earlier branch 29f6982e-364a-43d7-8ed2-7849aa322171 (11-troop difference) and its qualifier are retained unchanged as history.'],
    original: {exerciseId: KNOWN.originalId, orderEventId: KNOWN.orderEventId, debriefHash: KNOWN.debriefHash, reviewId: KNOWN.reviewId, priorBranchId: KNOWN.priorBranchId},
    privateFiles: {observed: observedPath},
    limits: {activeMs: ACTIVE_MS, cleanupMs: CLEANUP_MS, activeRequestCap: ACTIVE_REQUESTS, cleanupRequestCap: CLEANUP_REQUESTS, branches: 1, branchOrders: 1,
      shareDivisor: SHARE_DIVISOR, executionWindowTicks: EXECUTION_WINDOW_TICKS, maxBranchToOriginal: MAX_BRANCH_TO_ORIGINAL,
      originalShareRange: [ORIGINAL_SHARE_MIN, ORIGINAL_SHARE_MAX]},
    partial: []};
  const save = () => {
    try { assertPublicSafe(JSON.stringify(proof), subjects); write(artifact, proof); }
    catch (e) {
      proof.redactionFailure = errorCode(e); observed.unredactedProof = proof; write(observedPath, observed);
      write(artifact, {schema: proof.schema, version, attempt, status: 'redaction-check-failed', code: proof.redactionFailure, privateFiles: proof.privateFiles, at: new Date().toISOString()});
    }
  };
  const keep = (key: string, value: unknown) => { observed[key] = value; write(observedPath, observed); };
  const fact = (id: FactId, met: boolean, detail: Json = {}, exerciseId: string | null = KNOWN.originalId) => { facts.push({id, met, exerciseId, detail}); proof.acceptance = facts; save(); };
  const partial = (phase: string, code: string) => { proof.partial.push({phase, code}); save(); };

  type Client = Awaited<ReturnType<typeof nativeAppClient>>;
  let commander: Client | undefined, phase = 'preflight', fatal: string | null = null, violation: string | null = null;
  let branchEnded = false, branchCreation: 'none' | 'pending' | 'created' | 'uncertain' = 'none', returned = false;
  const total = new AbortController(), totalTimer = setTimeout(() => total.abort(), ACTIVE_MS);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let timeout: number;
    try { timeout = permit(guard, init?.method ?? 'GET', href, init?.body); } catch (e) { violation ??= errorCode(e); throw e; }
    const signals = [AbortSignal.timeout(timeout)];
    if (!guard.cleanup) signals.push(total.signal);
    if (init?.signal) signals.push(init.signal);
    return nativeFetch(input, {...init, redirect: 'error', signal: AbortSignal.any(signals)});
  };
  const call = (target: string, body?: unknown, ms = POST_MS) => withDeadline(async signal => {
    const r = await commander!.requestRaw(target, body, {signal});
    const text = await r.text(); let data: any = null; try { data = JSON.parse(text); } catch {}
    return {status: r.status, ok: r.ok, data};
  }, ms, 'request-deadline');
  const read = async (target: string, body?: unknown, ms = READ_MS) => { const r = await call(target, body, ms); check(r.ok, `http-${r.status}`); return r.data as Json; };
  const overview = () => read('/api/overview', undefined, OVERVIEW_MS);
  const short = (v: unknown) => typeof v === 'string' ? v.replace(/[A-Za-z0-9_-]{32,}/g, '[id]').slice(0, 200) : null;

  let prior: ReturnType<typeof verifyPriorEvidence> | undefined, childrenBefore: string[] = [];
  try {
    save();
    // ---- preflight: retained evidence as data, one Commander credential ----
    const review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
    prior = verifyPriorEvidence(review, fs.readFileSync(review.source));
    proof.priorEvidence = {review: REVIEW_FILE, source: review.source, sourceSha256: review.sourceSha256, qualificationGap: review.qualificationGap};
    fact('prior-evidence-consistent', true, {commandId: prior.commandId, originalIntent: prior.intent, priorBranchTroops: prior.priorBranchTroops,
      priorBranchDifference: prior.priorBranchTroops - prior.intent.troops}, null);
    const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
    const rows = Array.isArray(users) ? users.filter((u: Json) => u.role === 'commander') : [];
    const credential = rows.length === 1 && rows[0].username && rows[0].password ? {username: String(rows[0].username), password: String(rows[0].password)} : null;
    if (Array.isArray(users)) for (const u of users) u.password = '';
    check(credential, 'commander-credential');

    phase = 'login';
    try { commander = await nativeAppClient(credential); } finally { credential.password = ''; }
    const status = await read('/api/native/status');
    check(status.mode === 'kamiwaza' && status.signedIn && status.identity?.role === 'commander' && typeof status.identity.subject === 'string', 'native-commander-required');
    const subject = status.identity.subject as string; subjects.push(subject);
    const build = await read('/replay-build.json');
    check(build.version === version, 'deployed-version');
    proof.build = {version: build.version, builtAt: build.builtAt, simulationProfile: build.simulationProfile, sourceArchiveSha256: build.sourceArchive?.sha256 ?? null};
    fact('commander-native-login', true, {commanderSha256: sha(subject), role: 'commander'}, null);

    // ---- the original: select first (active-scoped routes), then verify its completed record and chain ----
    phase = 'original';
    check((await read('/api/select', {exerciseId: KNOWN.originalId})).selected === KNOWN.originalId, 'select-original');
    guard.phase = 'original';
    const budgetBefore = budgetProjection((await read('/api/agents/tools')).budget);
    check(Number.isInteger(budgetBefore.requestsUsed) && Number.isFinite(budgetBefore.committedUsd), 'budget-read');
    proof.budgetBefore = budgetBefore;
    const originalOverview = await overview();
    childrenBefore = (originalOverview.exercises ?? []).filter((e: Json) => e.parentId === KNOWN.originalId).map((e: Json) => e.id as string);
    const row = (originalOverview.exercises ?? []).find((e: Json) => e.id === KNOWN.originalId);
    check(originalOverview.activeId === KNOWN.originalId && row?.status === 'completed' && row.agentEnabled === false, 'original-not-completed');
    const record = await read(`/api/record/${KNOWN.originalId}`);
    const recordSha = sha(JSON.stringify(record)), forkFingerprint = record.fingerprints?.[String(KNOWN.observedTick)];
    keep('original', {overview: compactOverview(originalOverview), recordFingerprintAtFork: forkFingerprint, recordSha256: recordSha});
    const startFacts = {recordSha256: recordSha, finalTick: originalOverview.state?.tick, finalFingerprint: originalOverview.state?.fingerprint, forkFingerprint};
    const recordMatches = recordSha === prior.recordSha256 && startFacts.finalTick === prior.finalTick && startFacts.finalFingerprint === prior.finalFingerprint
      && forkFingerprint === prior.priorForkFingerprint;
    proof.originalAtStart = startFacts;
    fact('original-completed-record-unchanged', recordMatches, {...startFacts, matchesRetainedProof: recordMatches});
    check(recordMatches, 'original-record-differs-from-retained-proof');
    const order = verifyOriginalOrder(originalOverview.timeline ?? [], prior, subject);
    const debrief = await read(`/api/learning/debrief/${KNOWN.orderEventId}`);
    const history = await read('/api/learning/reviews?' + new URLSearchParams({exerciseId: KNOWN.originalId, eventId: KNOWN.orderEventId, hash: KNOWN.debriefHash}));
    const chain = verifyDebriefReview(debrief, history);
    keep('debriefReview', {debrief, history});
    proof.originalOrder = order; proof.debriefReviewAtStart = chain;
    fact('original-order-debrief-review-verified', true, {order, ...chain});

    // ---- exactly one new Blue branch at the order's observation tick ----
    phase = 'branch-create'; branchCreation = 'pending'; save();
    const branchRow = await read('/api/branches', {tick: KNOWN.observedTick, side: 'blue'}, POST_MS);
    check(UUID.test(branchRow?.id), 'branch-create-contract');
    guard.branchId = branchRow.id; branchCreation = 'created'; guard.phase = 'branch';
    let bov = await overview();
    const branch = verifyBranch({row: branchRow, overview: bov, parentId: KNOWN.originalId, forkTick: KNOWN.observedTick, subject, parentRecord: record,
      parentFinalFingerprint: prior.finalFingerprint});
    const counted = verifyOneNewBranch(originalOverview.exercises ?? [], bov.exercises ?? [], branch.branchId);
    const sourceIds = branchCopies(branch.branchId);
    check(sourceIds.every(id => (bov.reports ?? []).some((r: Json) => r.id === id && r.side === 'blue' && r.parentSourceId === id.slice(branch.branchId.length + 1))), 'branch-report-copies-missing');
    proof.branch = {...branch, parentId: KNOWN.originalId, forkTick: KNOWN.observedTick, fromEventId: KNOWN.orderEventId, side: 'blue', ownerIsCommander: true,
      forkFingerprintEqualsPriorBranch: branch.forkFingerprint === prior.priorForkFingerprint, ...counted, sourceIds};
    keep('branchStart', {row: branchRow, overview: compactOverview(bov)});
    fact('one-new-blue-branch-at-970', true, proof.branch, branch.branchId);

    // ---- its own observation and listed options; same destination, floor(10%) of observed forces ----
    phase = 'branch-order';
    bov = await overview();
    check(bov.activeId === branch.branchId && bov.playbackTick === null && typeof bov.observationReceipt === 'string', 'branch-observation');
    const blue = (bov.state?.players ?? []).find((p: Json) => p.side === 'blue');
    const observedTick = bov.state.tick as number, observedTroops = blue?.troops as number;
    check(blue?.alive && Number.isFinite(observedTroops), 'blue-not-alive');
    guard.dst = prior.intent.dst;
    let listed: ReturnType<typeof listedDestination> | undefined;
    try { listed = listedDestination(await read(`/api/action-options?${new URLSearchParams({exerciseId: branch.branchId})}`), branch.branchId, prior.intent.dst, observedTick); }
    catch (e) { if (e instanceof GuardViolation) throw e; fact('original-destination-listed-in-branch', false, {failure: errorCode(e)}, branch.branchId); partial('branch-order', errorCode(e)); }
    const troops = tenPercent(observedTroops);
    if (listed) fact('original-destination-listed-in-branch', true, {dst: prior.intent.dst, ...listed}, branch.branchId);
    if (listed && troops === null) partial('branch-order', 'observed-forces-below-ten');
    if (listed && troops !== null) {
      const intent = {type: 'boat', dst: prior.intent.dst, troops};
      const text = rationaleText({commandId: order.commandId, troops, observedTroops, observedTick, dst: prior.intent.dst, originalTroops: order.intent.troops, originalShare: order.shareOfObserved});
      proof.branchOrder = {kind: 'listed-landing-size-adjusted', intent, observedTick, observedTroops, listedDefaultTroops: listed.listedDefaultTroops, rationale: text, sourceIds};
      const r = await call('/api/commands', {side: 'blue', idempotencyKey: randomUUID(), intent, observationReceipt: bov.observationReceipt, rationale: text, sourceIds});
      proof.branchOrder.httpStatus = r.status; save();
      if (r.status !== 202 || !UUID.test(r.data?.id)) {
        proof.branchOrder.refusal = short(r.data?.error) ?? `HTTP ${r.status}`;
        fact('ten-percent-order-admitted', false, {httpStatus: r.status, refusal: proof.branchOrder.refusal}, branch.branchId);
        partial('branch-order', 'admission-refused-no-retry');
      } else {
        const commandId = r.data.id as string; proof.branchOrder.commandId = commandId;
        fact('ten-percent-order-admitted', true, {httpStatus: 202, commandId}, branch.branchId);
        // Admission is not execution: wait for the recorded command or rejection, then the bounded feedback window.
        let event: Json | undefined, rejected: Json | undefined, feedback: ReturnType<typeof executionWindow> | undefined;
        while (!total.signal.aborted) {
          await delay(POLL_MS, undefined, {signal: total.signal});
          bov = await overview();
          check(bov.activeId === branch.branchId && bov.playbackTick === null, 'branch-overview-changed');
          const tl: Json[] = bov.timeline ?? [], tick = bov.state?.tick as number;
          event ??= tl.find(e => e.kind === 'command' && e.details?.commandId === commandId);
          rejected ??= tl.find(e => e.kind === 'command_rejected' && e.details?.commandId === commandId);
          if (rejected) break;
          if (!event) { check(tick <= observedTick + ADMISSION_WAIT_TICKS + OBSERVATION_LAG_TICKS, 'command-not-recorded-in-window'); continue; }
          feedback = executionWindow(tl, commandId, event.tick, tick);
          if (feedback.done) break;
        }
        keep('branchOrderOverview', compactOverview(bov));
        if (rejected) {
          proof.branchOrder.refusal = short(rejected.details?.reason); proof.branchOrder.rejectedEventId = rejected.id;
          fact('ten-percent-order-recorded-with-lineage', false, {rejectedEventId: rejected.id, refusal: proof.branchOrder.refusal}, branch.branchId);
          fact('no-refusal-within-execution-window', false, {rejectedEventId: rejected.id}, branch.branchId);
          partial('branch-order', 'execution-rejected-no-retry');
        } else {
          check(event, 'command-not-recorded');
          try {
            const v = verifyOrderEvent(bov.timeline, bov.reports ?? [], {exerciseId: branch.branchId, commandId, subject, sourceIds,
              observedMin: KNOWN.observedTick, observedMax: KNOWN.observedTick + OBSERVATION_LAG_TICKS,
              mention: [KNOWN.orderEventId, KNOWN.reviewId, KNOWN.originalId, order.commandId, ...REPORTS], label: AUTHORED});
            check(v.intent?.type === 'boat' && v.intent.dst === prior.intent.dst && v.observedTick === observedTick, 'recorded-intent-or-observation');
            const size = verifyPracticeSize({branchTroops: v.intent.troops, branchObservedTroops: event.details.observation?.player?.troops,
              originalTroops: order.intent.troops, originalObservedTroops: order.observedTroops});
            Object.assign(proof.branchOrder, {...v, size, differenceFromPriorBranch: prior.priorBranchTroops - v.intent.troops, exerciseId: branch.branchId,
              lineage: {branchId: branch.branchId, parentId: KNOWN.originalId, forkTick: KNOWN.observedTick, originalOrderEventId: KNOWN.orderEventId,
                originalCommandId: order.commandId, reviewId: KNOWN.reviewId, parentSourceIds: ids(KNOWN.originalId, REPORTS)}});
            fact('ten-percent-order-recorded-with-lineage', true, {eventId: v.eventId, observedTick: v.observedTick, admittedTick: v.admittedTick, recordedTick: v.recordedTick, size}, branch.branchId);
          } catch (e) { if (e instanceof GuardViolation) throw e; fact('ten-percent-order-recorded-with-lineage', false, {failure: errorCode(e)}, branch.branchId); partial('branch-order-verify', errorCode(e)); }
          feedback ??= executionWindow(bov.timeline ?? [], commandId, event.tick, bov.state?.tick ?? 0);
          proof.execution = {windowTicks: EXECUTION_WINDOW_TICKS, completeWindowObserved: feedback.done, outcome: feedback.outcome, feedback: feedback.statuses};
          fact('no-refusal-within-execution-window', feedback.done && !feedback.refused, {outcome: feedback.outcome, windowComplete: feedback.done}, branch.branchId);
          if (feedback.refused) partial('execution', 'execution-refused-no-retry');
          else if (!feedback.done) partial('execution', 'execution-window-not-completed');
        }
      }
    }

    // ---- end the branch, return to the same original ----
    phase = 'branch-end';
    const ended = await read(`/api/exercises/${branch.branchId}/finish`, {});
    branchEnded = ended.id === branch.branchId && ended.status === 'completed' && ended.kind === 'branch';
    fact('branch-ended', branchEnded, {branchId: branch.branchId}, branch.branchId);

    phase = 'return'; guard.phase = 'return';
    check((await read('/api/select', {exerciseId: KNOWN.originalId})).selected === KNOWN.originalId, 'return-to-original');
    returned = true;
    try {
      const after = await overview();
      const recordAfter = await read(`/api/record/${KNOWN.originalId}`);
      const unchanged = verifySourceUnchanged({recordSha256: recordSha, overview: originalOverview}, {recordSha256: sha(JSON.stringify(recordAfter)), overview: after}, KNOWN.originalId);
      const chainAfter = verifyDebriefReview(await read(`/api/learning/debrief/${KNOWN.orderEventId}`),
        await read('/api/learning/reviews?' + new URLSearchParams({exerciseId: KNOWN.originalId, eventId: KNOWN.orderEventId, hash: KNOWN.debriefHash})));
      check(chainAfter.debriefRecordSha256 === chain.debriefRecordSha256 && chainAfter.reviewsSha256 === chain.reviewsSha256, 'debrief-or-review-changed');
      const priorBranch = (after.exercises ?? []).find((e: Json) => e.id === KNOWN.priorBranchId);
      check(priorBranch?.status === 'completed', 'prior-branch-not-retained-after');
      proof.returnedOriginal = {...unchanged, recordSha256: recordSha, debriefRecordSha256: chain.debriefRecordSha256, reviewsSha256: chain.reviewsSha256, priorBranchRetained: true};
      fact('returned-original-unchanged', true, proof.returnedOriginal);
    } catch (e) { if (e instanceof GuardViolation) throw e; fact('returned-original-unchanged', false, {failure: errorCode(e)}); partial('return', errorCode(e)); }
    const budgetAfter = budgetProjection((await read('/api/agents/tools')).budget);
    proof.budgetAfter = budgetAfter;
    const delta = {requests: budgetAfter.requestsUsed - budgetBefore.requestsUsed, usd: Number((budgetAfter.committedUsd - budgetBefore.committedUsd).toFixed(6))};
    proof.inferenceLedgerDelta = delta;
    fact('zero-inference-ledger-delta', delta.requests === 0 && delta.usd === 0 && budgetAfter.maxRequests === budgetBefore.maxRequests && budgetAfter.maxUsd === budgetBefore.maxUsd,
      {budgetBefore, budgetAfter, delta});
  } catch (e) {
    fatal = violation ?? (total.signal.aborted ? 'active-wallclock-deadline' : errorCode(e));
    proof.failure = {phase, code: fatal};
    if (branchCreation === 'pending') branchCreation = 'uncertain';
    process.exitCode = 1;
  } finally {
    if (violation && !fatal) { fatal = violation; proof.failure = {phase, code: violation}; }
    guard.cleanup = true; clearTimeout(totalTimer); total.abort();
    const cleanupEnd = Date.now() + CLEANUP_MS;
    const step = async (name: string, action: () => Promise<unknown>) => {
      try { await withDeadline(() => action(), Math.max(1, Math.min(CLEANUP_STEP_MS, cleanupEnd - Date.now())), `${name}-deadline`); return true; }
      catch (e) { (proof.cleanupFailures ??= []).push({step: name, code: errorCode(e)}); return false; }
    };
    // An uncertain creation is reconciled by listing, never re-created; only a single unseen child of the original is adopted for ending.
    if (commander && branchCreation === 'uncertain' && !guard.branchId) await step('reconcile-branch', async () => {
      const ov = await read('/api/overview', undefined, OVERVIEW_MS);
      const known = new Set(childrenBefore);
      const fresh = (ov.exercises ?? []).filter((e: Json) => e.parentId === KNOWN.originalId && e.kind === 'branch' && e.status === 'running' && !known.has(e.id)
        && Date.parse(e.createdAt) >= Date.parse(proof.startedAt));
      proof.branchCreationReconciled = fresh.length === 1 ? 'found' : fresh.length === 0 ? 'not-visible' : 'ambiguous';
      if (fresh.length === 1) guard.branchId = fresh[0].id;
    });
    if (commander && guard.branchId && !branchEnded) proof.branchEndedInCleanup = await step('end-branch', async () => {
      check((await read('/api/select', {exerciseId: guard.branchId})).selected === guard.branchId, 'cleanup-select-branch');
      check((await read(`/api/exercises/${guard.branchId}/finish`, {})).status === 'completed', 'branch-finish-contract');
      branchEnded = true;
    });
    if (commander && !returned && proof.budgetBefore) await step('return-original', async () => {
      check((await read('/api/select', {exerciseId: KNOWN.originalId})).selected === KNOWN.originalId, 'cleanup-select-original');
      returned = true;
      if (!proof.budgetAfter) {
        proof.budgetAfter = budgetProjection((await read('/api/agents/tools')).budget);
        proof.inferenceLedgerDelta = {requests: proof.budgetAfter.requestsUsed - proof.budgetBefore.requestsUsed,
          usd: Number((proof.budgetAfter.committedUsd - proof.budgetBefore.committedUsd).toFixed(6)), readInCleanup: true};
      }
    });
    if (commander) proof.loggedOut = await step('commander-logout', () => commander!.close());
    globalThis.fetch = nativeFetch;
    const cleanupComplete = !proof.cleanupFailures?.length && (!guard.branchId || branchEnded) && branchCreation !== 'uncertain' && (!commander || proof.loggedOut === true);
    fact('cleanup-complete', cleanupComplete, {branchEnded: guard.branchId ? branchEnded : 'no-branch', returnedToOriginal: returned, loggedOut: proof.loggedOut ?? false},
      guard.branchId || KNOWN.originalId);
    const outcome = classify(facts, fatal);
    Object.assign(proof, {status: outcome.status, unmetFacts: outcome.unmet, branchCreation, requests: guard.requests, cleanupRequests: guard.cleanupRequests, mutationCounts: guard.counts,
      limitations: [
        'Automated operator script, not a human participant or model player; the rationale is authored text attached to a fixed sizing rule.',
        'Uncommitted forces are the Blue troops in the order\'s own observation receipt (troops not already at sea or in attacks); the engine may cap an order at forces available when it executes.',
        'Execution feedback is reported only as recorded within 120 ticks of the command event; absence is not treated as success or failure of the landing.',
        'Ledger delta is the global application ledger; other workroom activity during the run would show as a nonzero delta.',
        'No outcome comparison between the original and branch is made, and none would show learning or a better decision.'],
      finishedAt: new Date().toISOString()});
    if (proof.status !== 'substantive-practice-qualified-main-review-pending') process.exitCode = 1;
    proof.exitCode = process.exitCode === 1 ? 1 : 0;
    try { save(); if (proof.redactionFailure) { proof.status = 'redaction-check-failed'; process.exitCode = 1; } }
    finally { for (const fd of fds.values()) fs.closeSync(fd); }
    console.log(JSON.stringify({artifact, status: proof.status, unmetFacts: proof.unmetFacts, failure: proof.failure, branchId: guard.branchId || null, branchEnded,
      returnedToOriginal: returned, inferenceLedgerDelta: proof.inferenceLedgerDelta ?? null, cleanupFailures: proof.cleanupFailures, exitCode: proof.exitCode}));
  }
}

// ---------------------------------------------------------------------------
// Offline self-test: synthetic records plus the retained local evidence files; no credentials or network.
// ---------------------------------------------------------------------------

export function selfTest() {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network-forbidden-in-self-test'); }) as typeof fetch;
  try {
    const branch = '99999999-8888-4777-8666-555555555555', subject = 'commander-subject', dst = 23122;
    const denied = (fn: () => unknown, code: RegExp) => assert.throws(fn, (e: unknown) => e instanceof GuardViolation && code.test((e as Error).message));

    // Guard: routes, phases, one branch, one sized boat order to the original destination, no model/review/end-original paths.
    const g = newGuard(), post = (p: string, b: Json = {}) => permit(g, 'POST', APP + p, JSON.stringify(b)), get = (p: string) => permit(g, 'GET', APP + p);
    denied(() => permit(g, 'GET', 'http://example.test/api/overview'), /native-origin-only/);
    denied(() => get('/api/overview?x=1'), /query-not-permitted/);
    post('/api/native/login');
    denied(() => post('/api/native/login'), /route-phase|retry-forbidden/);
    denied(() => post('/api/select', {exerciseId: KNOWN.priorBranchId}), /select-other-exercise/);
    post('/api/select', {exerciseId: KNOWN.originalId});
    denied(() => post('/api/branches', {tick: 970, side: 'blue'}), /route-phase/);
    g.phase = 'original';
    get(`/api/record/${KNOWN.originalId}`); get(`/api/learning/debrief/${KNOWN.orderEventId}`);
    get(`/api/learning/reviews?exerciseId=${KNOWN.originalId}&eventId=${KNOWN.orderEventId}&hash=${KNOWN.debriefHash}`);
    denied(() => get(`/api/learning/reviews?exerciseId=${KNOWN.originalId}&eventId=${KNOWN.orderEventId}&hash=${'b'.repeat(64)}`), /reviews-scope/);
    denied(() => get(`/api/record/${KNOWN.priorBranchId}`), /not-permitted/);
    for (const p of ['/api/learning/debrief', '/api/learning/reviews', '/api/agent', '/api/replay', '/api/reports/inject', '/api/staff', '/api/tasks', '/api/exercises',
      `/api/exercises/${KNOWN.originalId}/finish`, `/api/exercises/${KNOWN.priorBranchId}/finish`]) denied(() => post(p, {eventId: KNOWN.orderEventId}), /not-permitted/);
    denied(() => post('/api/branches', {tick: 971, side: 'blue'}), /route-phase/);
    denied(() => post('/api/branches', {tick: 970, side: 'red'}), /route-phase/);
    denied(() => get(`/api/action-options?exerciseId=${KNOWN.originalId}`), /action-options-scope/);
    post('/api/branches', {tick: 970, side: 'blue'}); g.branchId = branch; g.phase = 'branch';
    denied(() => post('/api/branches', {tick: 970, side: 'blue'}), /route-phase|retry-forbidden/);
    get(`/api/action-options?exerciseId=${branch}`);
    denied(() => post('/api/commands', {side: 'blue', intent: {type: 'boat', dst, troops: 10}}), /route-phase/); // destination not yet bound
    g.dst = dst;
    denied(() => post('/api/commands', {side: 'blue', intent: {type: 'boat', dst: 7075, troops: 10}}), /route-phase/);
    denied(() => post('/api/commands', {side: 'blue', intent: {type: 'attack', targetID: null, troops: 10}}), /route-phase/);
    denied(() => post('/api/commands', {side: 'red', intent: {type: 'boat', dst, troops: 10}}), /route-phase/);
    denied(() => post('/api/commands', {side: 'blue', intent: {type: 'boat', dst, troops: 1.5}}), /route-phase/);
    post('/api/commands', {side: 'blue', intent: {type: 'boat', dst, troops: 52339}});
    denied(() => post('/api/commands', {side: 'blue', intent: {type: 'boat', dst, troops: 52339}}), /branch-command-retry-forbidden/);
    denied(() => post('/api/select', {exerciseId: branch}), /select-branch-cleanup-only/);
    post(`/api/exercises/${branch}/finish`);
    denied(() => post(`/api/exercises/${branch}/finish`), /finish:branch-retry-forbidden/);
    denied(() => post('/api/native/logout'), /logout-cleanup-only/);
    post('/api/select', {exerciseId: KNOWN.originalId});
    denied(() => post('/api/select', {exerciseId: KNOWN.originalId}), /select-retry-forbidden/);
    g.cleanup = true;
    post('/api/select', {exerciseId: branch}); post(`/api/exercises/${branch}/finish`);
    denied(() => post(`/api/exercises/${branch}/finish`), /cleanup-finish:branch-retry-forbidden/);
    denied(() => get(`/api/record/${KNOWN.originalId}`), /not-permitted/);
    denied(() => post('/api/commands', {side: 'blue', intent: {type: 'boat', dst, troops: 1}}), /route-phase/);
    post('/api/native/logout');
    const cap = newGuard(); for (let i = 0; i < ACTIVE_REQUESTS; i++) permit(cap, 'GET', APP + '/api/overview');
    denied(() => permit(cap, 'GET', APP + '/api/overview'), /request-cap/);

    // Retained evidence: the real local review and proof agree with the known IDs; a changed byte or ID fails.
    const review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8')), bytes = fs.readFileSync(review.source);
    const prior = verifyPriorEvidence(review, bytes);
    assert.deepEqual([prior.intent, prior.priorBranchTroops - prior.intent.troops, prior.finalTick], [{type: 'boat', troops: 104678, dst: 23122}, 11, 1232]);
    assert.throws(() => verifyPriorEvidence(review, Buffer.concat([bytes, Buffer.from(' ')])), /prior-proof-hash-mismatch/);
    assert.throws(() => verifyPriorEvidence({...review, branchId: branch}, bytes), /prior-review-ids/);

    // Original order in the completed record.
    const ex = KNOWN.originalId;
    const orderEvent = {id: KNOWN.orderEventId, kind: 'command', side: 'blue', actor: subject, tick: 973,
      details: {commandId: prior.commandId, origin: 'human', observedTick: 970, admittedTick: prior.admittedTick, intent: {...prior.intent},
        observationBasis: 'app-snapshot-returned-with-order', observation: {tick: 970, player: {troops: 523390}}, sourceIds: ids(ex, REPORTS)}};
    const o = verifyOriginalOrder([orderEvent], prior, subject);
    assert.equal(o.shareOfObserved, 0.2);
    const badOrder = (patch: (e: Json) => void, code: RegExp) => { const e = structuredClone(orderEvent) as Json; patch(e); assert.throws(() => verifyOriginalOrder([e], prior, subject), code); };
    badOrder(e => { e.actor = 'other'; }, /original-order-owner/);
    badOrder(e => { e.tick = 974; }, /original-order-ticks/);
    badOrder(e => { e.details.intent.troops = 52339; }, /original-order-intent/);
    badOrder(e => { e.details.observation.player.troops = 1_000_000; }, /not-about-20pct/);
    badOrder(e => { delete e.details.observation; }, /original-order-observation/);
    assert.throws(() => verifyOriginalOrder([orderEvent, orderEvent], prior, subject), /missing-or-duplicated/);

    // Cached debrief and single automated review with the 10% instruction.
    const debrief = {status: 'cached', stale: false, record: {hash: KNOWN.debriefHash, eventId: KNOWN.orderEventId, exerciseId: ex, debrief: {headline: {text: 'x'}}}};
    const history = {exerciseId: ex, eventId: KNOWN.orderEventId, hash: KNOWN.debriefHash, canReview: false,
      reviews: [{id: KNOWN.reviewId, disposition: 'edited', criterionId: 'C1', nextPractice: prior.nextPractice}]};
    assert.equal(verifyDebriefReview(debrief, history).nextPractice, prior.nextPractice);
    assert.throws(() => verifyDebriefReview({...debrief, status: 'generated'}, history), /cached-debrief-contract/);
    assert.throws(() => verifyDebriefReview({...debrief, record: {...debrief.record, hash: 'c'.repeat(64)}}, history), /cached-debrief-contract/);
    assert.throws(() => verifyDebriefReview(debrief, {...history, reviews: [...history.reviews, history.reviews[0]]}), /review-history-contract/);
    assert.throws(() => verifyDebriefReview(debrief, {...history, canReview: true}), /review-history-contract/);
    assert.throws(() => verifyDebriefReview(debrief, {...history, reviews: [{...history.reviews[0], nextPractice: 'commit a smaller share'}]}), /10pct-instruction/);

    // Size: exact floor(10%) of the order's own observation, and a meaningful cut from the recorded 20% original.
    assert.equal(tenPercent(523399), 52339); assert.equal(tenPercent(9), null); assert.equal(tenPercent(Number.NaN), null);
    const size = verifyPracticeSize({branchTroops: 52339, branchObservedTroops: 523399, originalTroops: 104678, originalObservedTroops: 523390});
    assert.deepEqual([size.commandedShare, size.troopReduction, size.branchToOriginalRatio], [0.1, 52339, 0.5]);
    assert.throws(() => verifyPracticeSize({branchTroops: 104689, branchObservedTroops: 523445, originalTroops: 104678, originalObservedTroops: 523390}), /not-floor-10pct/);
    assert.throws(() => verifyPracticeSize({branchTroops: 52340, branchObservedTroops: 523399, originalTroops: 104678, originalObservedTroops: 523390}), /not-floor-10pct/);
    assert.throws(() => verifyPracticeSize({branchTroops: 104689, branchObservedTroops: 1046890, originalTroops: 104678, originalObservedTroops: 523390}), /reduction-not-meaningful/);
    assert.throws(() => verifyPracticeSize({branchTroops: 63000, branchObservedTroops: 630000, originalTroops: 104678, originalObservedTroops: 523390}), /reduction-not-meaningful/);
    assert.equal(verifyPracticeSize({branchTroops: 62000, branchObservedTroops: 620000, originalTroops: 104678, originalObservedTroops: 523390}).commandedShare, 0.1);

    // Listed destination in the branch's own options.
    const options = {exerciseId: branch, side: 'blue', tick: 976, naval: {status: 'available', landings: [
      {intent: {type: 'boat', dst: 7075, troops: 104000}, target: 'unclaimed', distanceFromCoast: 2},
      {intent: {type: 'boat', dst, troops: 104679}, target: 'unclaimed', distanceFromCoast: 2}]}};
    assert.equal(listedDestination(options, branch, dst, 975).listedDefaultTroops, 104679);
    assert.throws(() => listedDestination({...options, naval: {...options.naval, landings: [options.naval.landings[0]]}}, branch, dst, 975), /destination-not-listed/);
    assert.throws(() => listedDestination({...options, naval: {status: 'unavailable', landings: []}}, branch, dst, 975), /naval-options-unavailable/);
    assert.throws(() => listedDestination({...options, exerciseId: ex}, branch, dst, 975), /action-options-contract/);
    assert.throws(() => listedDestination(options, branch, dst, 977), /action-options-contract/);

    // Exactly one new branch; prior branch retained.
    const before = [{id: ex, kind: 'recorded'}, {id: KNOWN.priorBranchId, kind: 'branch', parentId: ex, status: 'completed', forkTick: 970}];
    const after = [...before, {id: branch, kind: 'branch', parentId: ex, status: 'running', forkTick: 970}];
    assert.deepEqual(verifyOneNewBranch(before, after, branch), {branchesBefore: 1, branchesAfter: 2});
    assert.throws(() => verifyOneNewBranch(before, [...after, {id: 'x', kind: 'branch', parentId: ex}], branch), /not-exactly-one-new-branch/);
    assert.throws(() => verifyOneNewBranch(before, before, branch), /not-exactly-one-new-branch/);
    assert.throws(() => verifyOneNewBranch(before, after.filter(r => r.id !== KNOWN.priorBranchId), branch), /prior-branch-not-retained/);
    assert.throws(() => verifyOneNewBranch(before, after.map(r => r.id === KNOWN.priorBranchId ? {...r, status: 'running'} : r), branch), /prior-branch-changed/);

    // Execution window: terminal outcome, negative feedback, absence, and events after the window are ignored.
    const fb = (tick: number, status: string, commandId = 'cmd') => ({id: `fb-${tick}`, kind: 'execution_feedback', tick, details: {commandId, feedback: {status, observed: {troops: 1}}}});
    assert.deepEqual(executionWindow([fb(980, 'transport-launched'), fb(1010, 'transport-landed')], 'cmd', 978, 1011).outcome, 'transport-landed');
    assert.equal(executionWindow([fb(980, 'transport-launched')], 'cmd', 978, 1000).done, false);
    assert.deepEqual(executionWindow([fb(980, 'transport-launched')], 'cmd', 978, 1099), {done: true, outcome: 'transport-launched-no-terminal-within-window', refused: false,
      statuses: [{eventId: 'fb-980', tick: 980, status: 'transport-launched', observed: {troops: 1}}]});
    assert.equal(executionWindow([fb(979, 'transport-not-launched')], 'cmd', 978, 979).refused, true);
    assert.equal(executionWindow([fb(1099, 'transport-landed'), fb(980, 'transport-launched', 'other')], 'cmd', 978, 1100).outcome, 'no-feedback-within-window');

    // Authored rationale mentions every lineage ID and stays within the API limit.
    const text = rationaleText({commandId: prior.commandId, troops: 52339, observedTroops: 523399, observedTick: 976, dst, originalTroops: 104678, originalShare: 0.2});
    assert.ok(text.startsWith(AUTHORED) && text.length <= 2000);
    for (const m of [KNOWN.orderEventId, KNOWN.reviewId, KNOWN.originalId, prior.commandId, ...REPORTS, 'floor: 52339 of 523399', 'not a claim that it is better']) assert.ok(text.includes(m), m);
    assert.deepEqual(branchCopies(branch), REPORTS.map(r => `${branch}:${storedId(ex, r)}`).sort());

    // Outcome, freshness, redaction, CLI.
    const everything = REQUIRED_FACTS.map(id => ({id, met: true}));
    assert.equal(classify(everything, null).status, 'substantive-practice-qualified-main-review-pending');
    assert.deepEqual(classify(everything.filter(f => f.id !== 'ten-percent-order-admitted'), null), {status: 'partial-retained', unmet: ['ten-percent-order-admitted']});
    assert.equal(classify([...everything, {id: 'no-refusal-within-execution-window', met: false}], null).status, 'partial-retained');
    assert.equal(classify(everything, 'request-route-not-permitted').status, 'incomplete-retained');
    assert.equal(freshLabel(['substantive-practice-0.21.1-a1-x.json'], '0.21.1', 'a1'), false);
    assert.equal(freshLabel(['substantive-practice-0.21.1-a10-x.json', 'integrated-learning-demo-0.21.1-a1-x.json'], '0.21.1', 'a1'), true);
    assertPublicSafe(JSON.stringify({commanderSha256: sha(subject)}), [subject]);
    assert.throws(() => assertPublicSafe(JSON.stringify({observationReceipt: 'x'}), []), /secret-field/);
    assert.throws(() => attemptArguments(['0.21', 'a']), /Version/);
    console.log('Offline substantive practice checks passed: guard routes/phases/one branch/one sized boat order/no debrief-review-end-original, retained proof hash and IDs, original order/debrief/review 10% instruction, floor-10% size and meaningful reduction (rejects the prior 11-troop branch), listed destination, exactly one new branch with prior branch retained, execution window, authored lineage rationale, outcome, freshness, redaction. No native calls.');
  } finally { globalThis.fetch = nativeFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
    else await run(process.argv.slice(2));
  } catch (e) { console.error(JSON.stringify({status: 'startup-failed', code: errorCode(e)})); process.exitCode = 1; }
}
