/**
 * After main releases: tsx scripts/platform/qualify-practice-history.ts <deployed-version>
 * Offline only: tsx scripts/platform/qualify-practice-history.ts --self-test
 * Uses existing normal commander and default owner logins. Apart from login/logout,
 * only allowlisted GETs are possible. In particular, never read /api/overview: that
 * route can create a first exercise for a newly assigned native participant.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { nativeAppClient } from './native-app-client';
import type { PracticeHistoryQuery, PracticeHistoryResult } from '../../src/learning/practice-history-types';

type Client = Awaited<ReturnType<typeof nativeAppClient>>;
const MAX_GETS = 24;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
class QualificationFailure extends Error {}
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new QualificationFailure(code);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const itemSchema = z.object({
  eventId: z.string().min(1), sequence: integer.positive(), tick: integer, observedTick: integer.nullable(),
  recordedAt: timestamp, kind: z.enum(['command', 'assessment_log', 'task_created', 'decision_log']),
  actor: z.string().min(1), side: z.enum(['blue', 'red']).nullable(), summary: z.string(),
  exercise: z.object({
    id: z.string().min(1), name: z.string(), kind: z.enum(['live', 'recorded', 'branch']), status: z.literal('completed'),
    createdAt: timestamp, scenarioId: z.string().nullable(), scenarioVersion: z.string().nullable(),
    map: z.string().nullable(), simulationProfile: z.string().nullable(), curriculumVersion: z.string().nullable(),
    assistance: z.string(), parentId: z.string().nullable(), forkTick: integer.nullable(),
  }).strict(),
  sourceIds: z.array(z.string()).max(20), commitmentRatio: z.number().nonnegative().nullable(), rationaleRecorded: z.boolean(),
}).strict();
const pageSchema = z.object({
  schema: z.literal('replay.practice-history/1'), scope: z.enum(['mine', 'workroom']), fiction: z.literal(true), query: z.string(),
  items: z.array(itemSchema).max(20), nextBeforeSequence: integer.positive().nullable(), hasMore: z.boolean(),
  scenarios: z.array(z.object({ id: z.string(), name: z.string() }).strict()).max(1000),
  summary: z.object({ basis: z.literal('returned-page-only'), commands: integer, assessments: integer, watches: integer,
    commandsCitingSources: integer, commandsWithRecordedReason: integer, branchEvents: integer }).strict(),
  limits: z.object({ maxPageSize: integer.positive().max(50), eligibleExercises: integer.max(1000), exerciseCatalogTruncated: z.boolean() }).strict(),
  notice: z.string(),
}).strict();

/** Throws only fixed diagnostic codes, never response values or validation issues. */
export function validateHistoryPage(input: unknown, query: PracticeHistoryQuery, subject: string): PracticeHistoryResult {
  const parsed = pageSchema.safeParse(input);
  check(parsed.success, 'history-contract');
  const page = parsed.data;
  check(page.scope === (query.scope ?? 'mine') && page.query === (query.query ?? '').trim(), 'history-query-context');
  check(page.items.length <= (query.limit ?? 20) && page.limits.maxPageSize >= (query.limit ?? 20), 'page-bound');
  check(new Set(page.scenarios.map(s => s.id)).size === page.scenarios.length, 'duplicate-scenarios');
  check(new Set(page.items.map(i => JSON.stringify([i.exercise.id, i.eventId]))).size === page.items.length, 'duplicate-events');
  for (const [index, item] of page.items.entries()) {
    check(index === 0 || item.sequence < page.items[index - 1].sequence, 'sequence-order');
    check(query.beforeSequence === undefined || item.sequence < query.beforeSequence, 'cursor-exclusive');
    check(page.scope !== 'mine' || item.actor === subject, 'own-actor-scope');
    check(!query.scenarioId || item.exercise.scenarioId === query.scenarioId, 'scenario-filter');
    if (page.query) {
      check([item.summary, item.kind, item.exercise.name, item.exercise.scenarioId ?? '']
        .some(text => text.toLowerCase().includes(page.query.toLowerCase())), 'literal-substring-filter');
    }
  }
  check(page.hasMore ? page.items.length === (query.limit ?? 20) && page.nextBeforeSequence === page.items.at(-1)?.sequence
    : page.nextBeforeSequence === null, 'cursor-contract');
  const counts = {
    commands: page.items.filter(i => i.kind === 'command').length,
    assessments: page.items.filter(i => i.kind === 'assessment_log').length,
    watches: page.items.filter(i => i.kind === 'task_created').length,
    commandsCitingSources: page.items.filter(i => i.kind === 'command' && i.sourceIds.length > 0).length,
    commandsWithRecordedReason: page.items.filter(i => i.kind === 'command' && i.rationaleRecorded).length,
    branchEvents: page.items.filter(i => i.exercise.kind === 'branch').length,
  };
  check(Object.entries(counts).every(([key, count]) => page.summary[key as keyof typeof counts] === count), 'returned-page-counts');
  return page;
}

/** Export a fixed projection; no raw names, text, subject, source IDs, headers or errors. */
export function pageEvidence(page: PracticeHistoryResult) {
  return {
    scope: page.scope, querySha256: hash(page.query), returnedRecords: page.items.length, summary: page.summary,
    hasMore: page.hasMore, nextBeforeSequence: page.nextBeforeSequence, limits: page.limits,
    metadataCoverage: {
      observedTick: page.items.filter(i => i.observedTick !== null).length,
      sourceIds: page.items.filter(i => i.sourceIds.length > 0).length,
      commitment: page.items.filter(i => i.commitmentRatio !== null).length,
      writtenReason: page.items.filter(i => i.rationaleRecorded).length,
    },
    samples: page.items.slice(0, 6).map(item => ({
      exerciseIdSha256: hash(item.exercise.id), eventIdSha256: hash(item.eventId), actorSha256: hash(item.actor),
      scenarioIdSha256: item.exercise.scenarioId === null ? null : hash(item.exercise.scenarioId),
      sequence: item.sequence, kind: item.kind, exerciseKind: item.exercise.kind, completed: true,
      branchInformedPractice: item.exercise.kind === 'branch', side: item.side,
      observedTick: item.observedTick, recordedTick: item.tick, recordedAt: new Date(item.recordedAt).toISOString(),
      sourceIdsSha256: item.sourceIds.map(hash), commitmentRatio: item.commitmentRatio, rationaleRecorded: item.rationaleRecorded,
      parentIdSha256: item.exercise.parentId === null ? null : hash(item.exercise.parentId), forkTick: item.exercise.forkTick,
    })),
  };
}

export function createReadOnlyReader(counter: { gets: number }) {
  return async (client: Pick<Client, 'requestRaw'>, target: string, expectedStatus = 200): Promise<unknown> => {
    check(target === '/replay-build.json' || target === '/api/native/status' || /^\/api\/practice\/history(?:\?|$)/.test(target), 'read-allowlist');
    check(++counter.gets <= MAX_GETS, 'request-cap');
    const response = await client.requestRaw(target, undefined, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    check(response.status === expectedStatus, 'http-status');
    if (target.startsWith('/api/practice/history')) check(response.headers.get('cache-control')?.includes('no-store'), 'private-no-store');
    if (expectedStatus !== 200) { await response.body?.cancel(); return null; }
    const raw = await response.text();
    check(Buffer.byteLength(raw) <= MAX_RESPONSE_BYTES, 'response-bound');
    try { return JSON.parse(raw); } catch { throw new QualificationFailure('response-json'); }
  };
}

const nativeStatusSchema = z.object({ mode: z.literal('kamiwaza'), signedIn: z.literal(true), workroomId: z.string().min(1),
  identity: z.object({ subject: z.string().min(1), role: z.enum(['commander', 'instructor']), mode: z.literal('kamiwaza') }),
  context: z.object({ nativeRole: z.string() }), denial: z.null(),
});
function statusOf(input: unknown, role: 'commander' | 'instructor') {
  const status = nativeStatusSchema.safeParse(input);
  check(status.success && status.data.identity.role === role, 'native-role');
  if (role === 'instructor') check(status.data.context.nativeRole === 'owner', 'native-owner');
  return status.data;
}

async function qualify(version: string) {
  check(/^\d+\.\d+\.\d+$/.test(version) && version.length <= 40, 'release-version');
  const artifact = `evidence/platform/practice-history-${version}.json`;
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  check(!fs.existsSync(artifact), 'artifact-already-exists');
  const fd = fs.openSync(artifact, 'wx', 0o600); // Reserve before credentials or requests; never replace another run.
  const startedAt = new Date().toISOString();
  fs.writeSync(fd, JSON.stringify({ version, startedAt, status: 'running' }) + '\n');
  const clients: Client[] = [];
  const counter = { gets: 0 };
  const read = createReadOnlyReader(counter);
  const checks: Record<string, unknown> = {};
  const failures: Array<{ phase: string; code: string }> = [];
  let phase = 'commander-login';
  try {
    // Read as data; never source, print, or pass an absent account to the default-owner helper.
    const users: unknown = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
    check(Array.isArray(users), 'commander-credentials');
    const matches = users.filter(u => u && typeof u === 'object' && u.role === 'commander');
    check(matches.length === 1 && typeof matches[0].username === 'string' && matches[0].username.length > 0
      && typeof matches[0].password === 'string' && matches[0].password.length > 0, 'commander-credentials');
    let commander: Client;
    try { commander = await nativeAppClient({ username: matches[0].username, password: matches[0].password }); clients.push(commander); }
    finally { for (const user of users) if (user && typeof user === 'object') user.password = ''; }
    phase = 'release-before';
    const build = await read(commander, '/replay-build.json') as { version?: unknown };
    check(build?.version === version, 'deployed-version');
    phase = 'owner-login';
    const owner = await nativeAppClient(); clients.push(owner);
    phase = 'native-identities';
    const cmd = statusOf(await read(commander, '/api/native/status'), 'commander');
    const instructor = statusOf(await read(owner, '/api/native/status'), 'instructor');
    check(cmd.workroomId === instructor.workroomId && cmd.identity.subject !== instructor.identity.subject, 'distinct-same-room-identities');
    checks.identities = { commanderRole: 'commander', instructorRole: 'instructor', instructorNativeRole: 'owner',
      commanderSubjectSha256: hash(cmd.identity.subject), instructorSubjectSha256: hash(instructor.identity.subject), workroomIdSha256: hash(cmd.workroomId) };

    for (const [client, subject, scope] of [[commander, cmd.identity.subject, 'mine'], [owner, instructor.identity.subject, 'workroom']] as const) {
      phase = `${scope}-history`;
      const history = async (query: PracticeHistoryQuery = {}, defaultScope = false) => {
        const request: PracticeHistoryQuery = { ...(defaultScope ? {} : { scope }), limit: 20, ...query };
        const params = new URLSearchParams(Object.entries(request).map(([key, value]) => [key, String(value)]));
        return validateHistoryPage(await read(client, `/api/practice/history?${params}`), request, subject);
      };
      const first = await history({}, scope === 'mine'); // Prove default own scope under the commander login.
      check(first.items.length >= 2, 'insufficient-retained-events');
      if (scope === 'workroom') check(first.items.some(item => item.actor !== subject), 'insufficient-workroom-peer-events');
      const cursorFirst = await history({ limit: 1 });
      check(cursorFirst.items[0]?.eventId === first.items[0].eventId && cursorFirst.hasMore, 'cursor-first-page');
      const cursorSecond = await history({ limit: 1, beforeSequence: cursorFirst.nextBeforeSequence! });
      check(cursorSecond.items[0]?.eventId === first.items[1].eventId
        && cursorSecond.items[0]?.exercise.id === first.items[1].exercise.id, 'cursor-second-page');
      const sample = first.items.find(item => item.exercise.scenarioId !== null);
      check(sample?.exercise.scenarioId, 'insufficient-retained-scenario');
      const scenario = await history({ scenarioId: sample.exercise.scenarioId });
      check(scenario.items.some(i => i.eventId === sample.eventId && i.exercise.id === sample.exercise.id), 'scenario-known-event');
      const literal = await history({ query: sample.kind, scenarioId: sample.exercise.scenarioId });
      const matching = literal.items.find(i => i.eventId === sample.eventId && i.exercise.id === sample.exercise.id);
      check(matching && JSON.stringify(matching) === JSON.stringify(sample), 'event-metadata-stable');
      const percent = await history({ query: '%' });
      const sqlText = await history({ query: "' OR 1=1 --" });
      checks[scope] = { first: pageEvidence(first), cursorFirst: pageEvidence(cursorFirst), cursorSecond: pageEvidence(cursorSecond),
        scenario: pageEvidence(scenario), literalKind: pageEvidence(literal), literalPercent: pageEvidence(percent), literalSqlText: pageEvidence(sqlText),
        stableEventMetadata: true, exclusiveCursor: true, pageCountsRecomputed: true,
        firstPageOtherActorEvents: first.items.filter(item => item.actor !== subject).length };
    }
    phase = 'commander-workroom-denial';
    await read(commander, '/api/practice/history?scope=workroom&limit=20', 403);
    checks.commanderWorkroomStatus = 403;
    phase = 'identities-after';
    const cmdAfter = statusOf(await read(commander, '/api/native/status'), 'commander');
    const ownerAfter = statusOf(await read(owner, '/api/native/status'), 'instructor');
    check(cmdAfter.identity.subject === cmd.identity.subject && ownerAfter.identity.subject === instructor.identity.subject
      && cmdAfter.workroomId === cmd.workroomId && ownerAfter.workroomId === cmd.workroomId, 'identity-changed');
    phase = 'release-after';
    check((await read(owner, '/replay-build.json') as { version?: unknown })?.version === version, 'deployed-version');
  } catch (error) {
    failures.push({ phase, code: error instanceof QualificationFailure ? error.message : 'operation-failed' });
  } finally {
    for (const client of clients.reverse()) {
      try { await client.close(); } catch { failures.push({ phase: 'logout', code: 'logout-failed' }); }
    }
  }
  const proof = { version, startedAt, finishedAt: new Date().toISOString(), status: failures.length ? 'failed' : 'passed',
    automated: true, nativeGetRequests: counter.gets, maxGetRequests: MAX_GETS, checks, failures,
    createsExercises: false, selectsOrReplaysExercises: false, callsModelEndpoints: false,
    limitations: [
      'HTTP checks on existing retained records only; no browser, Tomo/MCP invocation, human playtest or learning validation.',
      'Requires at least two visible events and one scenario-bearing event in the first 20 records of each scope, plus an event from another actor in the workroom page; absent fixtures fail explicitly.',
      'Metadata is checked against the public contract and repeated filtered reads, not raw database events or deterministic replay.',
      'At most two cursor pages per scope; search completeness, branch coverage and optional metadata presence are not guaranteed.',
      'No exercise or inference endpoints are invoked. Global record counts, fingerprints and inference budgets are not independently measured.',
      'Normal login/logout and native read authorization may update session/authentication state. No roles, enrollments or game state are changed by this script.',
      'Concurrent retention or role changes can fail the run. Artifact identifiers and query text are SHA-256 digests; raw response prose is omitted.',
      'GET timeout is 15 seconds; the shared login/logout helper has no configurable timeout.',
    ] };
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(proof, null, 2) + '\n', 0, 'utf8');
  } finally { fs.closeSync(fd); }
  console.log(JSON.stringify({ artifact, status: proof.status, nativeGetRequests: counter.gets, failures }));
  if (failures.length) process.exitCode = 1;
}

/** Local deterministic checks; this branch never reads credentials or creates a native client. */
async function selfTest() {
  const event = { eventId: 'event', sequence: 9, tick: 12, observedTick: 10, recordedAt: '2026-09-14T00:00:00Z',
    kind: 'command', actor: 'commander', side: 'blue', summary: 'Retained 20% commitment',
    exercise: { id: 'exercise', name: 'Trial', kind: 'branch', status: 'completed', createdAt: '2026-09-14T00:00:00Z',
      scenarioId: 'scenario', scenarioVersion: null, map: null, simulationProfile: null, curriculumVersion: null,
      assistance: 'unknown', parentId: 'parent', forkTick: 5 }, sourceIds: ['sensitive-source'], commitmentRatio: 0.2, rationaleRecorded: false };
  const fixture = { schema: 'replay.practice-history/1', scope: 'mine', fiction: true, query: '', items: [event],
    hasMore: false, nextBeforeSequence: null, scenarios: [{ id: 'scenario', name: 'Trial' }],
    summary: { basis: 'returned-page-only', commands: 1, assessments: 0, watches: 0, commandsCitingSources: 1, commandsWithRecordedReason: 0, branchEvents: 1 },
    limits: { maxPageSize: 50, eligibleExercises: 1, exerciseCatalogTruncated: false }, notice: 'private prose' };
  const valid = validateHistoryPage(fixture, { limit: 20 }, 'commander');
  assert.throws(() => validateHistoryPage(fixture, {}, 'other'), /own-actor-scope/);
  assert.throws(() => validateHistoryPage(fixture, { beforeSequence: 9 }, 'commander'), /cursor-exclusive/);
  assert.throws(() => validateHistoryPage({ ...fixture, items: [event, event] }, {}, 'commander'), /duplicate-events/);
  assert.throws(() => validateHistoryPage({ ...fixture, summary: { ...fixture.summary, commands: 2 } }, {}, 'commander'), /returned-page-counts/);
  assert.throws(() => validateHistoryPage({ ...fixture, items: [{ ...event, details: 'private' }] }, {}, 'commander'), /history-contract/);
  assert.throws(() => validateHistoryPage(fixture, { scenarioId: 'other' }, 'commander'), /scenario-filter/);
  validateHistoryPage({ ...fixture, query: '%' }, { query: '%' }, 'commander');
  assert.throws(() => validateHistoryPage({ ...fixture, query: '%', items: [{ ...event, summary: 'No percentage' }] }, { query: '%' }, 'commander'), /literal-substring-filter/);
  const evidence = JSON.stringify(pageEvidence(valid));
  assert(!evidence.includes('sensitive-source') && !evidence.includes('private prose') && !evidence.includes('Retained 20%'));
  assert(evidence.includes(hash('event')) && evidence.includes('"observedTick":10'));
  const counter = { gets: 0 }; const read = createReadOnlyReader(counter);
  const calls: string[] = [];
  const fake = { requestRaw: async (target: string, body?: unknown) => {
    assert.equal(body, undefined); calls.push(target);
    return new Response(JSON.stringify(fixture), { headers: { 'Cache-Control': 'private, no-store' } });
  } };
  await assert.rejects(read(fake, '/api/overview'), /read-allowlist/);
  await assert.rejects(read(fake, '/api/select'), /read-allowlist/);
  await read(fake, '/api/practice/history?limit=20'); assert.equal(calls.length, 1);
  counter.gets = MAX_GETS;
  await assert.rejects(read(fake, '/api/native/status'), /request-cap/);
  assert.equal(calls.length, 1);
  console.log('Practice-history sidecar offline checks passed (contract, scope, cursor, literal matching, redaction, GET allowlist and request cap).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 3, 'usage-release-version-or-self-test');
    if (process.argv[2] === '--self-test') await selfTest();
    else await qualify(process.argv[2]);
  } catch (error) {
    // Native login failures can carry process stderr. Never print an arbitrary error or stack.
    console.error(JSON.stringify({ status: 'failed', code: error instanceof QualificationFailure ? error.message : 'qualification-start-or-write-failed' }));
    process.exitCode = 1;
  }
}
