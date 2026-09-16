/**
 * MAIN DISPATCH ONLY, after deployment:
 * python3 scripts/run_logged.py changing-evidence-native -- ./node_modules/.bin/tsx scripts/platform/qualify-changing-evidence.ts 0.18.0
 * One new exercise, normal sequential owner/commander logins, no model endpoints.
 * Live polling is bounded to 180 seconds from the single creation attempt. Always
 * attempt to finish only this run's exercise in finally, including creation recovery.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeAppClient } from './native-app-client';
import { EVIDENCE_PACKET, packetReportsAt } from '../../src/scenarios/evidence-packet';
import type { Overview, Report } from '../../src/client/api';

type Client = Awaited<ReturnType<typeof nativeAppClient>>;
type Seat = 'instructor' | 'commander';
type Budget = { requestsUsed: number; maxRequests: number; committedUsd: number; maxUsd: number };
type Row = { id: string; name: string; status: string; agentEnabled: boolean; options: {
  ownerSubject?: string; scenarioId?: string; scenario?: { id: string; controller: string; evidencePacketId?: string };
} };
type NativeStatus = { mode: string; signedIn: boolean; workroomId: string; identity: { subject: string; role: string };
  context: { nativeRole: string } };
type RequestReceipt = { seat: Seat; operation: string; method: string; status: number | null; latencyMs: number; ok: boolean };
const SCENARIO = 'crosscurrent-evidence/1';
const LIVE_MS = 180_000, POLL_MS = 2000, HTTP_MS = 10_000, CLEANUP_MS = 15_000;
const PER_SEAT_CAP = 120, CLEANUP_CAP = 12;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
class CheckFailure extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new CheckFailure(code); }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Expected authored content and status are compared to the independent stored-record projection. */
function verifyReports(ov: Overview, side: 'both' | 'blue', ids: Map<string, string>) {
  const tick = ov.state.tick;
  check(Number.isSafeInteger(tick) && tick >= 0, 'overview-tick');
  const expected = (side === 'both' ? ['blue', 'red'] as const : ['blue'] as const).flatMap(s => packetReportsAt(s, tick));
  check(ov.reports.length === expected.length, 'report-count');
  check(new Set(ov.reports.map(r => r.id)).size === ov.reports.length, 'duplicate-stored-report');
  const byPacket = new Map(ov.reports.map(r => [r.packet?.reportId, r]));
  check(byPacket.size === expected.length, 'duplicate-packet-report');
  for (const view of expected) {
    const report = view.report, stored = byPacket.get(report.id), p = stored?.packet;
    check(stored && p, 'missing-packet-report');
    const oldId = ids.get(report.id);
    check(!oldId || stored.id === oldId, 'unstable-report-id');
    ids.set(report.id, stored.id);
    check(stored.id === `${ov.activeId}:${EVIDENCE_PACKET.id}:${report.id}`, 'report-exercise-binding');
    check(stored.side === report.side && stored.tick === report.releaseTick && p.releaseTick <= tick, 'side-or-future-report');
    check(p.id === EVIDENCE_PACKET.id && p.observedTick === report.observedTick && p.releaseTick === report.releaseTick
      && p.sourceId === report.sourceId && p.entityId === report.claim.entityId, 'packet-metadata');
    check(p.claimStatus === 'fictional-scenario-claim' && p.authoritativeState === false && stored.synthetic === true
      && stored.confidence === 'Fictional scenario claim; unverified.', 'claim-authority-label');
    check(stored.observedTroops === undefined && stored.observedTiles === undefined, 'claim-as-measured-state');
    check(stored.title === report.title && stored.body === report.body && p.sourceRelationship === report.sourceRelationship, 'report-content-or-derivation');
    check(stored.evidenceStatus === view.status, 'as-of-evidence-status');
    const runtime = (id: string) => { const row = byPacket.get(id); check(row, 'unreleased-link-target'); return row.id; };
    check(p.lineageRootId === runtime(view.lineageRootId), 'lineage-root');
    check(equal(p.links, report.links.map(link => ({ ...link, reportId: runtime(link.reportId) }))), 'durable-link-remapping');
    const correction = report.links.find(link => link.kind === 'supersedes');
    check((stored.supersedes ?? null) === (correction ? runtime(correction.reportId) : null), 'correction-link');
    check((stored.supersededBy ?? null) === (view.supersededBy ? runtime(view.supersededBy) : null), 'supersession-target');
    check(equal([...(stored.disputedWith ?? [])].sort(), view.disputedWith.map(runtime).sort()), 'dispute-targets');
  }
  check(ov.sourceDesk?.packetId === EVIDENCE_PACKET.id && !!ov.sourceDesk.focus
    && ov.sourceDesk.notice.includes('separate from measured map state'), 'source-desk-context');
  return { tick, total: ov.reports.length, blue: ov.reports.filter(r => r.side === 'blue').length,
    red: ov.reports.filter(r => r.side === 'red').length };
}

function reportEvidence(reports: Report[]) {
  return reports.map(r => ({ id: r.id, side: r.side, packet: r.packet, evidenceStatus: r.evidenceStatus,
    supersededBy: r.supersededBy ?? null, disputedWith: r.disputedWith ?? [] }));
}

async function run(version: string) {
  check(/^\d+\.\d+\.\d+$/.test(version) && version.length < 40, 'release-version');
  const artifact = `evidence/platform/changing-evidence-${version}.json`;
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const fd = fs.openSync(artifact, 'wx', 0o600);
  const name = `Automated changing evidence qualification ${version} ${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const clients: Array<{ client: Client; seat: Seat }> = [];
  const receipts: RequestReceipt[] = [], failures: Array<{ phase: string; code: string }> = [];
  const checks: Record<string, unknown> = {};
  const counts = { instructor: 0, commander: 0 };
  let phase = 'initialize', exerciseId: string | null = null, owner: Client | undefined, commander: Client | undefined;
  let ownerSubject = '', creationAttempted = false, recoverySafe = false, cleanupFinished = false, cleanupRequests = 0;
  let budgetBefore: Budget | null = null, budgetAfter: Budget | null = null, liveDeadline: number | null = null;
  let creationAt = 0, finalLiveElapsedMs: number | null = null, clockEndedElapsedMs: number | null = null, targetReached = false;
  let cleaning = false;
  const interrupted = new AbortController();
  const onInterrupt = () => interrupted.abort();
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  const save = (status: string) => {
    const latencies = receipts.map(r => r.latencyMs).sort((a, b) => a - b);
    const proof = { version, packetId: EVIDENCE_PACKET.id, scenarioId: SCENARIO, startedAt, at: new Date().toISOString(),
      status, phase, automated: true, name, exerciseId, checks, failures, cleanup: { finished: cleanupFinished, requests: cleanupRequests },
      limits: { liveMs: LIVE_MS, pollMs: POLL_MS, httpMs: HTTP_MS, cleanupHttpMs: CLEANUP_MS, perSeatRequests: PER_SEAT_CAP, cleanupRequests: CLEANUP_CAP },
      targetReached, liveElapsedMs: finalLiveElapsedMs, clockEndedElapsedMs, requestsBySeat: counts, receipts,
      latencyMs: { samples: latencies.length, p95: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? null, max: latencies.at(-1) ?? null },
      budgetBefore, budgetAfter, newPaidRequests: budgetBefore && budgetAfter ? budgetAfter.requestsUsed - budgetBefore.requestsUsed : null,
      modelEndpointsCalled: false, controllerSettingsChanged: false,
      limitations: [
        'Automated HTTP qualification, not browser/Tomo, human learning, or opponent quality validation.',
        'One newly created run only; no baseline override, injected reports, player orders, branch or changes to prior games.',
        'Exact cutoff counts/statuses are read by rewind after the live target; live polls record the actual arrival tick and counts.',
        'Concurrent paid use elsewhere fails the global budget equality check; no model endpoint is called here.',
        'Creation is never retried. A lost creation response triggers bounded name/owner/scenario recovery, and unresolved cleanup is reported as failure.',
      ] };
    fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(proof, null, 2) + '\n', 0, 'utf8');
  };
  const failure = (error: unknown) => failures.push({ phase, code: error instanceof CheckFailure ? error.message : 'operation-failed' });
  const realFetch = globalThis.fetch;
  // The normal login helper has no signal parameter: bound its HTTP login/logout as well.
  globalThis.fetch = (input, init) => realFetch(input, { ...init,
    signal: AbortSignal.any([AbortSignal.timeout(CLEANUP_MS), ...(init?.signal ? [init.signal] : []), ...(!cleaning ? [interrupted.signal] : [])]) });
  const request = async <T>(client: Client, seat: Seat, operation: string, url: string, body?: unknown, cleanup = false): Promise<T> => {
    if (cleanup) check(++cleanupRequests <= CLEANUP_CAP, 'cleanup-request-cap');
    else check(++counts[seat] <= PER_SEAT_CAP, 'seat-request-cap');
    const remaining = !cleanup && liveDeadline !== null ? liveDeadline - performance.now() : Infinity;
    check(remaining > 0, 'live-180-second-deadline');
    const receipt: RequestReceipt = { seat, operation, method: body === undefined ? 'GET' : 'POST', status: null, latencyMs: 0, ok: false };
    const began = performance.now();
    try {
      const response = await client.requestRaw(url, body, { signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(cleanup ? CLEANUP_MS : HTTP_MS, remaining)))) });
      receipt.status = response.status;
      check(response.ok, `http-${response.status}`);
      const data = await response.json() as T; receipt.ok = true; return data;
    } finally { receipt.latencyMs = Math.round(performance.now() - began); receipts.push(receipt); }
  };
  const ownOverview = (cleanup = false) => request<Overview>(owner!, 'instructor', 'overview', '/api/overview', undefined, cleanup);
  const readBudget = async (cleanup = false) => {
    const data = await request<{ budget: Budget }>(owner!, 'instructor', 'budget', '/api/agents/tools', undefined, cleanup);
    check(data.budget && Object.values(data.budget).every(v => typeof v === 'number' && Number.isFinite(v)), 'budget-shape');
    return data.budget;
  };
  const checkRun = (ov: Overview, seat: Seat, live: boolean) => {
    check(ov.activeId === exerciseId && ov.identity.role === seat, 'exercise-or-role-changed');
    const row = ov.exercises.find(e => e.id === exerciseId);
    check(row && (!live || row.status === 'running') && row.agentEnabled === false, 'early-end-or-paid-controller');
    check(row.options?.scenario?.id === SCENARIO && row.options.scenario.controller === 'objectives/1', 'scripted-objective-controller');
    check(ov.tasks.every(t => (t as unknown as { modelEnabled?: boolean }).modelEnabled !== true), 'paid-watch-enabled');
  };
  try {
    save('running'); phase = 'instructor-login';
    // Same default owner account as nativeAppClient, but bound the credential lookup subprocess.
    let encoded = execFileSync('podman', ['machine', 'ssh', 'kamiwaza-harness-poc',
      "sudo k0s kubectl get secret kamiwaza-user-poc-viewer -n kamiwaza -o jsonpath='{.data.password}'"],
    { encoding: 'utf8', timeout: CLEANUP_MS, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    let password = Buffer.from(encoded.trim(), 'base64').toString('utf8'); encoded = '';
    try { owner = await nativeAppClient({ username: 'poc-viewer', password }); clients.push({ client: owner, seat: 'instructor' }); }
    finally { password = ''; }
    phase = 'release-and-identities';
    const build = await request<{ version: string }>(owner, 'instructor', 'build', '/replay-build.json');
    check(build.version === version, 'deployed-version');
    const ownerStatus = await request<NativeStatus>(owner, 'instructor', 'native-status', '/api/native/status');
    check(ownerStatus.mode === 'kamiwaza' && ownerStatus.signedIn && ownerStatus.identity.role === 'instructor'
      && ownerStatus.context.nativeRole === 'owner', 'native-instructor'); ownerSubject = ownerStatus.identity.subject;
    // Validate an existing visible active record without the overview's first-game creation path.
    await request(owner, 'instructor', 'existing-session-check', '/api/team'); recoverySafe = true;
    phase = 'commander-login';
    const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8')) as Array<{ role?: string; username?: string; password?: string }>;
    check(Array.isArray(users), 'commander-credentials');
    const matches = users.filter(u => u.role === 'commander');
    check(matches.length === 1 && matches[0].username && matches[0].password, 'commander-credentials');
    try { commander = await nativeAppClient({ username: matches[0].username, password: matches[0].password }); clients.push({ client: commander, seat: 'commander' }); }
    finally { for (const user of users) user.password = ''; }
    const cmdStatus = await request<NativeStatus>(commander, 'commander', 'native-status', '/api/native/status');
    check(cmdStatus.mode === 'kamiwaza' && cmdStatus.signedIn && cmdStatus.identity.role === 'commander'
      && cmdStatus.identity.subject !== ownerSubject && cmdStatus.workroomId === ownerStatus.workroomId, 'native-commander');
    checks.identities = { instructorSha256: hash(ownerSubject), commanderSha256: hash(cmdStatus.identity.subject), workroomSha256: hash(ownerStatus.workroomId) };
    budgetBefore = await readBudget();
    phase = 'create-one-exercise'; creationAttempted = true; creationAt = performance.now(); liveDeadline = creationAt + LIVE_MS;
    const created = await request<Row>(owner, 'instructor', 'create', '/api/exercises', { name, scenarioId: SCENARIO });
    check(uuid(created.id), 'created-exercise-id'); exerciseId = created.id; save('running');
    check(created.name === name && created.options?.scenario?.id === SCENARIO && created.options.scenario.controller === 'objectives/1'
      && created.options.scenario.evidencePacketId === EVIDENCE_PACKET.id && created.agentEnabled === false, 'created-scenario');
    phase = 'watch-and-enrollment';
    const watch = await request<{ id: string; kind: string; side: string; modelEnabled: boolean; createdTick: number }>(owner, 'instructor', 'create-watch', '/api/tasks', { title: 'Monitor report provenance', side: 'blue' });
    check(uuid(watch.id) && watch.kind === 'provenance-watch' && watch.side === 'blue' && watch.modelEnabled === false && watch.createdTick < 300, 'free-watch-before-first-update');
    const invitation = await request<{ code: string }>(owner, 'instructor', 'join-code', '/api/team/code', {});
    check(typeof invitation.code === 'string' && /^[a-f0-9]{32}$/i.test(invitation.code), 'join-code-shape');
    const joined = await request<{ exerciseId: string; side: string }>(commander, 'commander', 'join-created-exercise', '/api/team/join', { code: invitation.code });
    invitation.code = ''; check(joined.exerciseId === exerciseId && joined.side === 'blue', 'commander-enrollment');
    const ids = new Map<string, string>(), scriptedIds = new Set<string>();
    const samples: unknown[] = [], crossings: Record<string, unknown> = {};
    checks.livePolls = samples; checks.firstPollAtOrAfterCutoff = crossings;
    let lastTick = -1, liveOwner: Overview | undefined, liveCommander: Overview | undefined;
    phase = 'continuous-live-poll';
    for (let poll = 0; poll < 90; poll++) {
      const pollStart = performance.now();
      const ov = await ownOverview(); checkRun(ov, 'instructor', true);
      check(ov.playbackTick === null && ov.state.tick >= lastTick, 'live-clock-regressed-or-rewound');
      lastTick = ov.state.tick;
      const both = verifyReports(ov, 'both', ids);
      const cmd = await request<Overview>(commander, 'commander', 'live-overview', '/api/overview'); checkRun(cmd, 'commander', true);
      check(cmd.playbackTick === null && cmd.timeline.every(e => !e.side || e.side === 'blue'), 'commander-live-side-leak');
      const blue = verifyReports(cmd, 'blue', ids);
      for (const event of ov.timeline) {
        const detail = event.details as { controller?: string } | undefined;
        if (event.kind === 'scripted_decision' && event.actor === 'objective-controller' && detail?.controller === 'objectives/1') scriptedIds.add(event.id);
      }
      const sample = { elapsedMs: Math.round(performance.now() - creationAt), instructor: both, commander: blue };
      samples.push(sample);
      for (const cutoff of [300, 600, 900, 1200]) if (ov.state.tick >= cutoff && !crossings[cutoff]) crossings[cutoff] = sample;
      liveOwner = ov; liveCommander = cmd;
      if (ov.state.tick >= 1200 && cmd.state.tick >= 1200) { targetReached = true; break; }
      if (poll % 10 === 0) console.log(JSON.stringify({ phase, poll, instructorTick: ov.state.tick, commanderTick: cmd.state.tick }));
      const wait = Math.max(0, POLL_MS - (performance.now() - pollStart));
      check(performance.now() + wait < liveDeadline!, 'live-180-second-deadline'); if (wait) await delay(wait, undefined, { signal: interrupted.signal });
    }
    finalLiveElapsedMs = Math.round(performance.now() - creationAt);
    check(targetReached && finalLiveElapsedMs <= LIVE_MS && liveOwner && liveCommander, 'tick-1200-not-reached');
    check(scriptedIds.size > 0, 'scripted-opponent-action-not-observed');
    checks.scriptedOpponent = { controller: 'objectives/1', observedDecisionEvents: scriptedIds.size, paidEnabled: false, settingsChanged: false };
    checks.liveFinalReports = reportEvidence(liveOwner.reports);
    phase = 'durable-watch-alerts';
    const task = await request<{ task: { modelEnabled: boolean; modelResult: unknown; provenanceResult: { text: string; sourceIds: string[] } | null }; trace: Array<{ id: string; kind: string; tick: number; method: string | null; receiptId: string | null }> }>(owner, 'instructor', 'watch-trace', `/api/agents/tasks/${watch.id}`);
    check(task.task.modelEnabled === false && !task.task.modelResult && task.task.provenanceResult, 'watch-model-or-missing-result');
    const alerts = liveOwner.timeline.filter(e => e.kind === 'staff_update' && (e.details as { taskId?: string })?.taskId === watch.id);
    check(alerts.length > 0 && alerts.some(e => e.tick >= 600), 'watch-alerts-missing');
    const storedById = new Map(liveOwner.reports.map(r => [r.id, r]));
    checks.watch = { id: watch.id, createdTick: watch.createdTick, alerts: alerts.map(event => {
      const d = event.details as { sourceIds: string[]; method: string; receiptId?: string };
      check(d.method === 'deterministic provenance watcher' && !d.receiptId
        && event.summary.includes('authored scenario claims, not measured game state'), 'watch-claim-label');
      check(Array.isArray(d.sourceIds) && d.sourceIds.length > 0 && d.sourceIds.every(id => {
        const report = storedById.get(id); return report?.side === 'blue' && report.tick <= event.tick;
      }), 'watch-source-scope');
      check(task.trace.some(t => t.id === event.id && t.kind === 'staff_update' && t.method === d.method && t.receiptId === null), 'watch-durable-trace');
      return { eventId: event.id, tick: event.tick, sourceIds: d.sourceIds, method: d.method, claimsNotMeasuredState: true };
    }) };
    // Stop this run before potentially slow historical reconstruction. Finally retries
    // or confirms cleanup on every failure; there is no duplicate finish on the happy path.
    phase = 'finish-before-historical-review';
    const finished: Row = await request<Row>(owner, 'instructor', 'finish-own-run', `/api/exercises/${exerciseId}/finish`, {});
    check(finished.id === exerciseId && finished.status === 'completed' && finished.agentEnabled === false, 'finish-not-confirmed');
    cleanupFinished = true; clockEndedElapsedMs = Math.round(performance.now() - creationAt);
    check(clockEndedElapsedMs <= LIVE_MS, 'live-180-second-deadline'); liveDeadline = null;
    phase = 'historical-cutoffs';
    const historical: unknown[] = []; checks.cutoffs = historical;
    let at300: unknown;
    for (const cutoff of [300, 600, 900, 1200, 300]) {
      await request(owner, 'instructor', `rewind-${cutoff}`, '/api/replay', { exerciseId, tick: cutoff });
      const ov = await ownOverview(); checkRun(ov, 'instructor', false);
      check(ov.playbackTick === cutoff && ov.state.tick === cutoff && ov.timeline.every(e => e.tick <= cutoff), 'historical-future-data');
      const count = verifyReports(ov, 'both', ids);
      const expectedCounts: Record<number, number[]> = { 300: [3, 2], 600: [5, 3], 900: [7, 5], 1200: [8, 7] };
      check(count.blue === expectedCounts[cutoff][0] && count.red === expectedCounts[cutoff][1], 'cutoff-source-count');
      const evidence = reportEvidence(ov.reports);
      if (cutoff === 300) { if (at300) check(equal(at300, evidence), 'rewind-300-not-repeatable'); else at300 = evidence; }
      historical.push({ cutoff, counts: count, fingerprint: ov.state.fingerprint, reports: evidence });
    }
    phase = 'release-after';
    check((await request<{ version: string }>(owner, 'instructor', 'build-after', '/replay-build.json')).version === version, 'deployed-version-changed');
  } catch (error) { failure(error); }
  finally {
    cleaning = true;
    if (creationAttempted && finalLiveElapsedMs === null) finalLiveElapsedMs = Math.round(performance.now() - creationAt);
    liveDeadline = null;
    // Never retry POST /api/exercises. Recover only this unique labeled run after an ambiguous response.
    if (owner && creationAttempted && !exerciseId && recoverySafe) {
      phase = 'recover-created-id';
      for (let attempt = 0; attempt < 3 && !exerciseId; attempt++) {
        try {
          const ov = await ownOverview(true);
          const matches = (ov.exercises as unknown as Row[]).filter(r => r.name === name && r.options?.ownerSubject === ownerSubject
            && r.options.scenario?.id === SCENARIO);
          check(matches.length <= 1, 'ambiguous-created-run');
          if (matches.length === 1) { check(uuid(matches[0].id), 'recovered-exercise-id'); exerciseId = matches[0].id; }
        } catch (error) { failure(error); }
        if (!exerciseId && attempt < 2) await delay(1000);
      }
      if (!exerciseId) failures.push({ phase, code: 'creation-outcome-unresolved-no-retry' });
    }
    if (owner && exerciseId && !cleanupFinished) {
      phase = 'finish-created-exercise';
      for (let attempt = 0; attempt < 2 && !cleanupFinished; attempt++) {
        try {
          // Recovery can require session selection; the only allowed target is this run's ID.
          if (attempt > 0 || !targetReached) await request(owner, 'instructor', 'cleanup-select-own-run', '/api/select', { exerciseId }, true);
          const ended: Row = await request<Row>(owner, 'instructor', 'finish-own-run', `/api/exercises/${exerciseId}/finish`, {}, true);
          check(ended.id === exerciseId && ended.status === 'completed' && ended.agentEnabled === false, 'finish-not-confirmed'); cleanupFinished = true;
        } catch (error) {
          failure(error);
          // A lost finish response must not cause another end event if completion is already visible.
          try { cleanupFinished = (await ownOverview(true)).exercises.some(r => r.id === exerciseId && r.status === 'completed' && r.agentEnabled === false); }
          catch (readError) { failure(readError); }
        }
      }
      if (!cleanupFinished) failures.push({ phase, code: 'created-exercise-not-confirmed-ended' });
    }
    if (cleanupFinished && clockEndedElapsedMs === null) clockEndedElapsedMs = Math.round(performance.now() - creationAt);
    if (owner && budgetBefore) {
      phase = 'budget-after-cleanup';
      try { budgetAfter = await readBudget(true); check(equal(budgetBefore, budgetAfter), 'global-budget-changed'); }
      catch (error) { failure(error); }
    }
    phase = 'logout';
    for (const { client } of clients.reverse()) { try { await client.close(); } catch (error) { failure(error); } }
    globalThis.fetch = realFetch;
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
    phase = 'complete';
    try { save(failures.length || !cleanupFinished ? 'failed' : 'passed'); } finally { fs.closeSync(fd); }
  }
  console.log(JSON.stringify({ artifact, status: failures.length || !cleanupFinished ? 'failed' : 'passed', exerciseId,
    targetReached, liveElapsedMs: finalLiveElapsedMs, cleanupFinished, requestsBySeat: counts,
    newPaidRequests: budgetBefore && budgetAfter ? budgetAfter.requestsUsed - budgetBefore.requestsUsed : null, failures }));
  if (failures.length || !cleanupFinished) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { check(process.argv.length === 3, 'usage-requires-release-version'); await run(process.argv[2]); }
  catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error instanceof CheckFailure ? error.message : 'startup-or-artifact-write-failed' }));
    process.exitCode = 1;
  }
}
