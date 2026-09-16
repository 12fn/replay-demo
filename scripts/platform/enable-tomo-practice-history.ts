/**
 * Add only search_practice_history to native Tomo policy and the existing private observer.
 * Run serially with other Commander logins:
 *   run_logged.py LABEL -- tsx scripts/platform/enable-tomo-practice-history.ts VERSION inspect|apply
 * Offline checks: tsx scripts/platform/enable-tomo-practice-history.ts --self-test
 * Uses the existing 5185 Tomo API tunnel and Core binding; never manages any tunnel.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { KamiwazaClient } from '../../src/platform';
import { buildForwardAuthHeaders, extractSignedIdentity } from '../../src/platform/forward-auth';

const SERVER = 'replay-tools_replay';
const HISTORY = `kz_${SERVER}_search_practice_history`;
const READS = ['list_exercises', 'get_exercise_state', 'get_station_objectives', 'get_team_assessments',
  'get_key_moments', 'get_replay_provenance', 'search_practice_history'].sort();
type Json = Record<string, any>;
class CheckFailure extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new CheckFailure(code); }
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
function unchanged(a: unknown, b: unknown, code: string) { check(stable(a) === stable(b), code); }

export function withHistoryTool(content: Json): Json {
  check(content && content.name === 'REPLAY evidence observer' && content.capability_ceiling === 'read', 'observer-definition');
  check(content.posture && Array.isArray(content.posture.platform_tool_allowlist)
    && content.posture.platform_tool_allowlist.every((v: unknown) => typeof v === 'string'), 'observer-allowlist');
  const next = structuredClone(content);
  if (!next.posture.platform_tool_allowlist.includes(HISTORY)) next.posture.platform_tool_allowlist.push(HISTORY);
  return next;
}

async function main(version: string, mode: string) {
  check(/^\d+\.\d+\.\d+$/.test(version) && ['inspect', 'apply'].includes(mode), 'usage-version-inspect-or-apply');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifact = `evidence/platform/tomo-practice-history-${version}-${mode}-${stamp}.json`;
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  const fd = fs.openSync(artifact, 'wx', 0o600);
  const b = JSON.parse(fs.readFileSync('data/kamiwaza-binding.json', 'utf8'));
  const reference = JSON.parse(fs.readFileSync('evidence/platform/tomo-observer-agent-1.json', 'utf8'));
  const agentId: string = reference.agent.id;
  check(/^[a-f0-9-]{36}$/i.test(agentId), 'observer-receipt-id');
  const receipts: Json[] = [], checks: Json = {}, failures: Json[] = [];
  let phase = 'initialize', active: Awaited<ReturnType<typeof login>> | null = null;
  let temp: { userId: string; memberId: string; ownerId: string } | null = null;
  let enrollmentIntent: { userId: string; ownerId: string } | null = null;
  let originalOtherMembers: unknown = null, calls = 0;
  const save = (status: string) => {
    const proof = { at: new Date().toISOString(), version, mode, status, phase, agentId, historyToolId: HISTORY,
      checks, receipts, failures, temporaryMembership: temp, enrollmentIntent,
      nativeIdentityLoginsSerial: true, tunnel: { api: '127.0.0.1:5185', managedByThisScript: false },
      modelEndpointsCalled: false, exerciseWrites: false, agentCreated: false,
      limitations: ['Discovery and configuration only; no conversation, actual model tool choice or learning claim.',
        'Optimistic conflicts stop without retrying writes or restoring stale settings.',
        'No runtime/MCP-service changes. Agent prose and all settings outside the added allowlist entry are preserved.'] };
    fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify(proof, null, 2) + '\n', 0, 'utf8');
  };
  function recordError(error: unknown) {
    failures.push({ phase, code: error instanceof CheckFailure ? error.message : 'native-operation-failed' });
  }
  const otherMembers = (items: Json[], adminId: string) => items.filter(m => m.user_id !== adminId)
    .map(m => ({ id: m.id, user_id: m.user_id, active: m.active, role: m.role })).sort((a, z) => a.id.localeCompare(z.id));
  async function login(who: 'commander' | 'admin' | 'owner', enter = true) {
    check(active === null, 'parallel-identity-login');
    let token = '', entered = false, username = '', password = '';
    const core = new KamiwazaClient({ apiBase: b.apiBase, getToken: () => token,
      forwardedHost: 'kamiwaza-harness.localhost', timeoutMs: 15000 });
    if (who === 'commander') {
      const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
      check(Array.isArray(users), 'member-credentials');
      const matches = users.filter(u => u.role === 'commander');
      check(matches.length === 1 && matches[0].username && matches[0].password, 'member-credentials');
      username = matches[0].username; password = matches[0].password;
      for (const u of users) u.password = '';
    } else {
      username = who === 'admin' ? 'admin' : 'poc-viewer';
      let raw = execFileSync('podman', ['machine', 'ssh', 'kamiwaza-harness-poc',
        `sudo k0s kubectl get secret kamiwaza-user-${username} -n kamiwaza -o jsonpath='{.data.password}'`],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
      password = Buffer.from(raw.trim(), 'base64').toString('utf8'); raw = '';
    }
    try {
      token = (await core.login({ username, password })).data.access_token;
      if (enter) { const result = await core.enterWorkroom(b.workroom.id); entered = true; if (result.data.access_token) token = result.data.access_token; }
      const me = await core.me();
      receipts.push({ operation: 'normal-login', identity: who, subject: me.identity.userId, enteredWorkroom: entered });
      return {
        core, subject: me.identity.userId, roles: me.identity.roles,
        async tomo(method: 'GET' | 'PUT', target: string, body?: unknown, expectedStatus = 200): Promise<Json> {
          check(++calls <= 60, 'tomo-request-cap');
          const paths = ['/api/auth/me', '/api/agents/capability-catalog', '/api/ops/kamiwaza-tools',
            `/api/agents/${agentId}`, `/api/agents/${agentId}/definition`, `/api/ops/kamiwaza-tools/${HISTORY}`];
          check(paths.includes(target) && (method === 'GET' || mode === 'apply'
            && [ `/api/agents/${agentId}`, `/api/ops/kamiwaza-tools/${HISTORY}` ].includes(target)), 'tomo-mutation-scope');
          const start = performance.now();
          const validation = await fetch(b.apiBase + '/auth/forward/validate', { headers: buildForwardAuthHeaders({ token, method,
            uri: '/runtime/apps/replay-tomo' + target, host: 'kamiwaza-harness.localhost', proto: 'https', workroomId: b.workroom.id }),
          redirect: 'error', signal: AbortSignal.timeout(15000) });
          check(validation.status === 200, `forward-auth-${validation.status}`);
          const signed = extractSignedIdentity(validation.headers);
          check(signed.identity.userId === me.identity.userId && signed.identity.workroomId === b.workroom.id, 'signed-identity-scope');
          if (target.startsWith('/api/ops/') && expectedStatus === 200) check(signed.identity.roles.includes('admin'), 'native-admin-required');
          const response = await fetch('http://127.0.0.1:5185' + target, { method, redirect: 'error', signal: AbortSignal.timeout(45000),
            headers: { Authorization: `Bearer ${token}`, ...signed.forwardHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body) });
          receipts.push({ operation: 'tomo-request', identity: who, method, path: target, status: response.status,
            latencyMs: Math.round(performance.now() - start), signatureTs: signed.signatureTs });
          check(response.status === expectedStatus, `tomo-http-${response.status}`);
          if (expectedStatus !== 200) { await response.body?.cancel(); return {}; }
          return await response.json() as Json;
        },
        async close() { try { if (entered) await core.leaveWorkroom(); } finally { token = ''; } },
      };
    } catch (error) {
      if (entered) try { await core.leaveWorkroom(); } catch { failures.push({ phase, code: 'login-cleanup-failed' }); }
      token = ''; throw error;
    } finally { password = ''; }
  }
  async function closeActive() {
    if (active) { const prior = active; active = null; await prior.close(); }
  }
  async function cleanEnrollment() {
    if (!temp && !enrollmentIntent) return;
    await closeActive(); phase = 'remove-temporary-admin-membership'; active = await login('owner');
    const adminId = temp?.userId ?? enrollmentIntent!.userId;
    const ownerId = temp?.ownerId ?? enrollmentIntent!.ownerId;
    check(active.subject === ownerId, 'cleanup-owner-changed');
    const endpoint = `/workrooms/${b.workroom.id}/members`;
    const before = (await active.core.request<Json>({ method: 'GET', path: endpoint, workroomId: b.workroom.id })).data;
    const member = before.items.find((m: Json) => m.user_id === adminId && m.active);
    if (member) {
      check((!temp || member.id === temp.memberId) && member.invited_by_user_id === ownerId, 'temporary-membership-ownership');
      await active.core.request({ method: 'DELETE', path: endpoint + '/' + adminId, workroomId: b.workroom.id });
    }
    const after = (await active.core.request<Json>({ method: 'GET', path: endpoint, workroomId: b.workroom.id })).data;
    check(!after.items.some((m: Json) => m.user_id === adminId && m.active), 'temporary-membership-remains');
    unchanged(otherMembers(before.items, adminId), otherMembers(after.items, adminId), 'cleanup-unrelated-members-changed');
    if (originalOtherMembers) unchanged(originalOtherMembers, otherMembers(after.items, adminId), 'unrelated-members-changed');
    checks.temporaryAdminCleanup = { removedUserId: adminId, removedMembershipId: member?.id ?? temp?.memberId ?? null,
      membershipAbsent: true, otherMembersPreserved: true };
    temp = null; enrollmentIntent = null; save('running'); await closeActive();
  }
  async function memberInspection() {
    const me = await active!.tomo('GET', '/api/auth/me'); check(me.role === 'member', 'ordinary-member-role');
    const card = await active!.tomo('GET', `/api/agents/${agentId}`);
    check(card.id === agentId && card.name === 'REPLAY evidence observer' && card.visibility === 'private'
      && card.owned && card.can_edit && !card.protected, 'existing-private-observer');
    const definition = await active!.tomo('GET', `/api/agents/${agentId}/definition`);
    check(Number.isInteger(definition.version) && definition.version > 0, 'agent-version');
    withHistoryTool(definition.content);
    const catalog = await active!.tomo('GET', '/api/agents/capability-catalog');
    check(Array.isArray(catalog.tools), 'member-catalog');
    const reads = catalog.tools.filter((t: Json) => t.server_id === SERVER);
    return { card, definition, reads };
  }
  try {
    save('running');
    phase = 'inspect-existing-member-observer'; active = await login('commander');
    const before = await memberInspection();
    checks.memberBefore = { agentId, version: before.definition.version, private: true, contentSha256: digest(before.definition.content),
      platformToolAllowlist: before.definition.content.posture.platform_tool_allowlist, discoveredReplayTools: before.reads.map((t: Json) => t.id) };
    await closeActive(); save('running');
    if (mode === 'apply') {
      phase = 'resolve-installation-admin'; active = await login('admin', false);
      check(active.roles.includes('admin'), 'installation-admin-role'); const adminId = active.subject; await closeActive();
      phase = 'check-admin-workroom-membership'; active = await login('owner');
      const endpoint = `/workrooms/${b.workroom.id}/members`;
      const members = (await active.core.request<Json>({ method: 'GET', path: endpoint, workroomId: b.workroom.id })).data;
      check(Array.isArray(members.items), 'membership-list');
      const existing = members.items.find((m: Json) => m.user_id === adminId && m.active);
      if (!existing) {
        originalOtherMembers = otherMembers(members.items, adminId);
        enrollmentIntent = { userId: adminId, ownerId: active.subject }; save('running');
        const added = (await active.core.request<Json>({ method: 'POST', path: endpoint, workroomId: b.workroom.id,
          body: { email: 'admin@localhost', role: 'editor', attested: true } })).data;
        check(added.user_id === adminId && added.active && added.role === 'editor' && added.invited_by_user_id === active.subject, 'temporary-enrollment');
        temp = { userId: adminId, memberId: added.id, ownerId: active.subject };
        checks.temporaryAdminEnrollment = { ...temp, purpose: 'additive Tomo tool selection', temporary: true }; save('running');
      } else checks.adminMembershipPreexisting = true;
      await closeActive();
      try {
        phase = 'admin-additive-tool-selection'; active = await login('admin');
        const selection = await active.tomo('GET', '/api/ops/kamiwaza-tools');
        check(Number.isInteger(selection.version) && Array.isArray(selection.items), 'selection-shape');
        const replay = selection.items.filter((t: Json) => t.server_id === SERVER);
        unchanged(replay.map((t: Json) => t.tool_name).sort(), READS, 'seven-replay-reads-discovered');
        check(replay.every((t: Json) => t.capability === 'read' && !t.requires_confirm), 'read-only-tools');
        const history = replay.find((t: Json) => t.id === HISTORY); check(history, 'history-tool-id');
        check(replay.filter((t: Json) => t.id !== HISTORY).every((t: Json) => t.enabled), 'original-six-not-enabled');
        if (!history.enabled) await active.tomo('PUT', `/api/ops/kamiwaza-tools/${HISTORY}`, { enabled: true, expected_version: selection.version });
        const after = await active.tomo('GET', '/api/ops/kamiwaza-tools');
        check(after.items.find((t: Json) => t.id === HISTORY)?.enabled === true, 'history-policy-not-enabled');
        const exceptHistory = (items: Json[]) => items.filter(t => t.id !== HISTORY).sort((a, z) => a.id.localeCompare(z.id));
        unchanged(exceptHistory(selection.items), exceptHistory(after.items), 'unrelated-tool-settings-changed');
        unchanged(selection.root, after.root, 'tool-root-settings-changed');
        check(after.version === selection.version + (history.enabled ? 0 : 1), 'tool-selection-version');
        checks.adminSelection = { beforeVersion: selection.version, afterVersion: after.version, changed: !history.enabled,
          enabledReplayReads: after.items.filter((t: Json) => t.server_id === SERVER && t.enabled).map((t: Json) => t.id),
          unrelatedSettingsSha256: digest(exceptHistory(after.items)), rootPreserved: true, unrelatedSettingsPreserved: true };
        save('running');
      } finally { await closeActive(); await cleanEnrollment(); }
      phase = 'member-additive-observer-allowlist'; active = await login('commander');
      const current = await memberInspection();
      unchanged(current.reads.map((t: Json) => t.id).sort(), READS.map(n => `kz_${SERVER}_${n}`).sort(), 'member-seven-reads');
      check(current.reads.every((t: Json) => t.capability === 'read'), 'member-read-only-catalog');
      const content = withHistoryTool(current.definition.content), changed = !equalContent(current.definition.content, content);
      if (changed) {
        const updated = await active.tomo('PUT', `/api/agents/${agentId}`, { content, expected_version: current.definition.version });
        check(updated.id === agentId && updated.version === current.definition.version + 1, 'observer-update-version');
      }
      const after = await memberInspection();
      unchanged(after.definition.content, content, 'observer-content-not-preserved');
      check(after.definition.version === current.definition.version + (changed ? 1 : 0), 'observer-version-after');
      unchanged(after.definition.published_version, current.definition.published_version, 'published-version-changed');
      await active.tomo('GET', '/api/ops/kamiwaza-tools', undefined, 403);
      checks.memberAfter = { agentId, private: true, owned: true, beforeVersion: current.definition.version, afterVersion: after.definition.version,
        changed, platformToolAllowlist: after.definition.content.posture.platform_tool_allowlist,
        priorContentSha256: digest(current.definition.content), expectedContentSha256: digest(content), actualContentSha256: digest(after.definition.content),
        unrelatedAgentContentPreserved: true, publishedVersionPreserved: true, ordinaryMemberAdminDenied: true,
        discoveredReplayTools: after.reads.map((t: Json) => t.id), readToolsDiscovered: after.reads.length };
    }
  } catch (error) { recordError(error); }
  finally {
    try { await closeActive(); } catch (error) { recordError(error); }
    try { await cleanEnrollment(); } catch (error) { recordError(error); }
    try { await closeActive(); } catch (error) { recordError(error); }
    phase = 'complete';
    try { save(failures.length ? 'failed' : mode === 'inspect' ? 'inspected' : 'passed'); } finally { fs.closeSync(fd); }
  }
  console.log(JSON.stringify({ artifact, status: failures.length ? 'failed' : mode === 'inspect' ? 'inspected' : 'passed',
    checks, failures, temporaryMembershipCleaned: !temp && !enrollmentIntent, modelCalls: 0 }));
  if (failures.length) process.exitCode = 1;
}
const equalContent = (a: unknown, b: unknown) => stable(a) === stable(b);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--self-test') {
      const original = { name: 'REPLAY evidence observer', persona: 'Preserve verbatim', capability_ceiling: 'read', extra: { untouched: true },
        posture: { platform_tool_allowlist: ['existing-tool'], tool_allowlist: ['local'], max_parallel_tools: 1 }, routing: { routable: false } };
      const result = withHistoryTool(original);
      assert.deepEqual(result.posture.platform_tool_allowlist, ['existing-tool', HISTORY]);
      assert.deepEqual(original.posture.platform_tool_allowlist, ['existing-tool']);
      assert.deepEqual(withHistoryTool(result), result);
      result.posture.platform_tool_allowlist.pop(); assert.deepEqual(result, original);
      assert.throws(() => withHistoryTool({ ...original, capability_ceiling: 'write' }));
      console.log('Additive observer helper checks passed; no native requests.');
    } else { check(process.argv.length === 4, 'usage-version-inspect-or-apply'); await main(process.argv[2], process.argv[3]); }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: error instanceof CheckFailure ? error.message : 'startup-or-artifact-write-failed' }));
    process.exitCode = 1;
  }
}
