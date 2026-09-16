/**
 * Native, automated presentation-context qualification; no model calls or controller changes.
 * Run from the repository root after deploying the target release:
 *   ./node_modules/.bin/tsx scripts/platform/qualify-organization-context.ts <deployed-version>
 * Uses existing team-qualification-users.json accounts and, only if sharing requires it,
 * nativeAppClient's normal poc-viewer enrollment owner. Never provisions or changes roles.
 * Starts fresh evidence before reading credentials/authenticating; retains failure and cleanup status.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
import {resolveOrganizationPack, type ResolvedOrganizationPack} from '../../src/context/organization-packs';

type Client = Awaited<ReturnType<typeof nativeAppClient>>;
type Role = 'commander' | 'intelligence';
type Credentials = {username: string; password: string};
type Identity = {subject: string; role: Role | 'instructor'; mode: string};
type PackReference = {packId: string; version: string};
type Row = {
  id: string; status: string; agentEnabled: boolean;
  options: {organizationPack?: PackReference; ownerSubject?: string; scenario: {id: string}};
};
type Overview = {
  identity: Identity; activeId: string; selectedSide: string; playbackTick: number | null;
  organizationContext: ResolvedOrganizationPack | null;
  state: {tick: number; fingerprint: string}; exercises: Row[];
  platform: {nativeConnected: boolean};
};
type NativeStatus = {
  mode: string; signedIn: boolean; workroomId: string; identity: Identity;
  context: {canShare: boolean; canEdit: boolean};
};
type Budget = {requestsUsed: number; committedUsd: number};
type ToolState = {opponent: {enabled: boolean}; budget: Budget};
type Roster = {participants: {subject: string; roleAtJoin: string; active: boolean}[]};
const scenarios = [
  ['crosscurrent-objectives/1', 'crosscurrent-island-network'],
  ['crosscurrent-classic/1', 'crosscurrent-joint-coordination'],
] as const;

const version = process.argv[2];
assert(version && /^\d+\.\d+\.\d+$/.test(version) && process.argv.length === 3,
  'Usage: tsx scripts/platform/qualify-organization-context.ts <deployed-version>');
const artifact = `evidence/soak/native-organization-context-${version}.json`;
assert(!fs.existsSync(artifact), 'Preserve existing qualification evidence; choose a new release or archive it separately');
let users: unknown;
function credentials(role: Role): Credentials {
  assert(Array.isArray(users), 'Existing team qualification accounts are required');
  const matches = users.filter(u => u && typeof u === 'object' && u.role === role);
  assert(matches.length === 1, `Exactly one existing ${role} qualification account is required`);
  const user = matches[0];
  // Never pass undefined: nativeAppClient would otherwise log in as its default owner.
  assert(typeof user.username === 'string' && user.username.length > 0 &&
    typeof user.password === 'string' && user.password.length > 0, `Missing ${role} credentials`);
  return {username: user.username, password: user.password};
}
const json = async <T>(client: Client, path: string, body?: unknown): Promise<T> =>
  (await client.request(path, body)).json() as Promise<T>;
const clients: Client[] = [];
const created: string[] = [];
const runs: unknown[] = [];
const ended: string[] = [];
let commander: Client | undefined;
let enrollmentOwner: Client | undefined;
let proof: Record<string, unknown> | undefined;
const failures: unknown[] = [];
const errors: {category: string; kind: 'assertion' | 'error'; exerciseId?: string}[] = [];
const startedAt = new Date().toISOString();
let phase = 'credentials';

// Only safe categories and known exercise IDs go into failure evidence, never exception
// messages, request bodies, credentials, cookies or invitation codes. Atomic replacements
// keep the previous checkpoint intact if a later write fails or the process is interrupted.
function saveEvidence(status: 'running' | 'failed' | 'passed', initial = false) {
  const result = {...proof, startedAt, updatedAt: new Date().toISOString(), version, status, phase,
    errorCategory: errors[0]?.category ?? null, errors, createdExerciseIds: created,
    endedExerciseIds: ended, pendingExerciseIds: created.filter(id => !ended.includes(id)), runs};
  const contents = JSON.stringify(result, null, 2);
  if (initial) fs.writeFileSync(artifact, contents, {flag: 'wx'});
  else {
    const temporary = `${artifact}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, contents, {flag: 'wx'});
      fs.renameSync(temporary, artifact);
    } finally { fs.rmSync(temporary, {force: true}); }
  }
  return result;
}
function checkpoint(nextPhase: string) { phase = nextPhase; saveEvidence('running'); }
function recordFailure(error: unknown, category = phase, exerciseId?: string) {
  failures.push(error);
  errors.push({category, kind: error instanceof assert.AssertionError ? 'assertion' : 'error',
    ...(exerciseId ? {exerciseId} : {})});
}
async function finishExercise(id: string) {
  if (ended.includes(id)) return;
  assert(commander);
  await json(commander, '/api/select', {exerciseId: id});
  const finished = await json<Row>(commander, `/api/exercises/${id}/finish`, {});
  assert.equal(finished.id, id); assert.equal(finished.status, 'completed');
  assert.equal(finished.agentEnabled, false);
  ended.push(id);
  saveEvidence(failures.length ? 'failed' : 'running');
}

function checkIdentity(actual: Identity, expected: Identity) {
  assert.equal(actual.mode, 'kamiwaza');
  assert.equal(actual.subject, expected.subject);
  assert.equal(actual.role, expected.role);
}
function checkOverview(view: Overview, row: Row, identity: Identity, reference: PackReference) {
  checkIdentity(view.identity, identity);
  assert.equal(view.platform.nativeConnected, true);
  assert.equal(view.activeId, row.id);
  assert.equal(view.selectedSide, 'blue');
  const retained = view.exercises.find(e => e.id === row.id);
  assert(retained, 'New exercise must be visible to its participant');
  assert.deepEqual(retained.options.organizationPack, reference);
  assert.equal(retained.options.scenario.id, row.options.scenario.id);
  assert.equal(retained.agentEnabled, false);
  const expected = resolveOrganizationPack({...reference, role: identity.role});
  assert.deepEqual(view.organizationContext, expected, 'Context must resolve the retained pack for this session role');
  return expected;
}

async function checkDossier(client: Client, identity: Identity, row: Row, context: ResolvedOrganizationPack) {
  const dossier = await json<{
    attributed: boolean; exerciseId: string;
    dossier: {learner: Identity; current: {exerciseId: string}};
  }>(client, '/api/learning/dossier');
  assert.equal(dossier.attributed, true);
  assert.equal(dossier.exerciseId, row.id);
  assert.equal(dossier.dossier.current.exerciseId, row.id);
  assert.equal(dossier.dossier.learner.subject, identity.subject);
  assert.equal(dossier.dossier.learner.role, identity.role);
  const markdown = await (await client.request('/api/learning/dossier.md')).text();
  const marker = '## Optional role practice template';
  assert.equal(markdown.split(marker).length, 2, 'Exactly one optional current-seat practice template is expected');
  const template = markdown.slice(markdown.indexOf(marker));
  assert(template.includes(`${context.packId}@${context.version}`));
  assert(template.includes(`Current seat: ${context.roleView.title}.`));
  assert(template.includes('not a claim about your historical role'));
  assert(template.includes('blank prompts are not learning evidence'));
  const reportHeading = `### ${context.roleView.report.title}\n`;
  assert(template.includes(reportHeading));
  const report = template.split(reportHeading)[1]!.split('### Next practice prompts')[0]!;
  assert.deepEqual(report.split('\n').filter(line => line.startsWith('- ')),
    context.roleView.report.fields.map(field =>
      `- **${field.label}:** ${field.description}${field.evidenceGuidance ? ` ${field.evidenceGuidance}` : ''}`),
    'Report fields must remain blank authoring guidance, with no generated answers');
  for (const prompt of context.roleView.learningPrompts) assert(template.includes(`- ${prompt.prompt}`));
  for (const otherRole of ['commander', 'intelligence', 'instructor'] as const) {
    if (otherRole === identity.role) continue;
    const other = resolveOrganizationPack({packId: context.packId, version: context.version, role: otherRole});
    assert(!template.includes(`Current seat: ${other.roleView.title}.`));
    assert(!template.includes(`### ${other.roleView.report.title}\n`));
  }
  // A query cannot substitute another current seat in the Markdown export either.
  const spoof = await (await client.request('/api/learning/dossier.md?role=instructor')).text();
  assert.equal(spoof.slice(spoof.indexOf(marker)), template);
  return {subject: identity.subject, role: identity.role, reportId: context.roleView.report.id,
    currentSeatTemplate: true, blankFields: true,
    templateSha256: createHash('sha256').update(template).digest('hex')};
}

// Failure to reserve fresh evidence must stop before any credential read or native call.
fs.mkdirSync('evidence/soak', {recursive: true});
saveEvidence('running', true);
try {
  users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
  const commanderCredentials = credentials('commander');
  const intelligenceCredentials = credentials('intelligence');
  assert(commanderCredentials.username !== intelligenceCredentials.username, 'Separate role accounts are required');
  checkpoint('authentication');
  commander = await nativeAppClient(commanderCredentials); clients.push(commander);
  const intelligence = await nativeAppClient(intelligenceCredentials); clients.push(intelligence);
  checkpoint('build');
  const build = await json<{version: string}>(commander, '/replay-build.json');
  assert.equal(build.version, version, 'Deploy the intended release before qualifying');
  checkpoint('identity');
  const cmd = await json<NativeStatus>(commander, '/api/native/status');
  const intel = await json<NativeStatus>(intelligence, '/api/native/status');
  for (const [status, role] of [[cmd, 'commander'], [intel, 'intelligence']] as const) {
    assert.equal(status.mode, 'kamiwaza'); assert.equal(status.signedIn, true);
    assert.equal(status.identity.role, role); assert.equal(status.identity.mode, 'kamiwaza');
    assert(status.identity.subject);
  }
  assert(cmd.workroomId); assert.equal(intel.workroomId, cmd.workroomId);
  assert.notEqual(cmd.identity.subject, intel.identity.subject);
  let budgetBefore: Budget | undefined;
  let budgetAfter: Budget | undefined;
  for (const [scenarioId, packId] of scenarios) {
    checkpoint('creation');
    // Do not read overview before explicit creation: an unassigned session may auto-create a world.
    const row: Row = await json<Row>(commander, '/api/exercises', {
      name: `Automated organization context · ${scenarioId}`, scenarioId,
    });
    assert(typeof row.id === 'string' && row.id.length > 0, 'Creation must return an exercise ID');
    created.push(row.id); // Track before further assertions so failure still ends this exercise.
    checkpoint('created-exercise');
    const reference = {packId, version: '1.0.0'};
    assert.deepEqual(row.options.organizationPack, reference);
    assert.equal(row.options.ownerSubject, cmd.identity.subject);
    assert.equal(row.options.scenario.id, scenarioId);
    assert.equal(row.agentEnabled, false);
    const tools: ToolState = await json<ToolState>(commander, '/api/agents/tools');
    assert.equal(tools.opponent.enabled, false);
    assert(Number.isFinite(tools.budget.requestsUsed) && Number.isFinite(tools.budget.committedUsd));
    budgetBefore ??= tools.budget;

    checkpoint('enrollment');
    const inaccessible = await intelligence.requestRaw('/api/select', {exerciseId: row.id});
    await inaccessible.arrayBuffer();
    assert.equal(inaccessible.status, 403, 'Intelligence must enroll before selecting this new exercise');
    const team = await json<{canManage: boolean}>(commander, '/api/team');
    let issuer: Client = commander;
    if (!team.canManage) {
      if (!enrollmentOwner) {
        checkpoint('enrollment-owner-authentication');
        enrollmentOwner = await nativeAppClient(); clients.push(enrollmentOwner);
        checkpoint('enrollment');
        const owner = await json<NativeStatus>(enrollmentOwner, '/api/native/status');
        assert.equal(owner.mode, 'kamiwaza'); assert.equal(owner.signedIn, true);
        assert.equal(owner.identity.role, 'instructor');
        assert.equal(owner.workroomId, cmd.workroomId);
        assert.equal(owner.context.canShare, true, 'Existing enrollment owner must have native sharing permission');
        assert.notEqual(owner.identity.subject, cmd.identity.subject);
        assert.notEqual(owner.identity.subject, intel.identity.subject);
      }
      issuer = enrollmentOwner;
      await json(issuer, '/api/select', {exerciseId: row.id});
      assert.equal((await json<{canManage: boolean}>(issuer, '/api/team')).canManage, true,
        'Existing owner cannot enroll participants; no provisioning or permission changes are attempted');
    }
    const invitation = await json<{code: string}>(issuer, '/api/team/code', {});
    try {
      const joined = await json<{exerciseId: string}>(intelligence, '/api/team/join', {code: invitation.code});
      assert.equal(joined.exerciseId, row.id);
    } finally { invitation.code = ''; }
    const roster: Roster = await json<Roster>(commander, '/api/team');
    for (const identity of [cmd.identity, intel.identity]) {
      const participant = roster.participants.find(p => p.subject === identity.subject && p.active);
      assert(participant, 'Both actual subjects must have active enrollment');
      assert.equal(participant.roleAtJoin, identity.role);
    }

    checkpoint('seat-checks');
    const seats: unknown[] = [];
    let rewindFingerprint: string | undefined;
    const readers: [Client, Identity][] = [[commander, cmd.identity], [intelligence, intel.identity]];
    for (const [client, identity] of readers) {
      const live: Overview = await json<Overview>(client, '/api/overview');
      const context = checkOverview(live, row, identity, reference);
      assert.equal(live.playbackTick, null);
      for (const requestedRole of ['commander', 'intelligence', 'instructor']) {
        checkOverview(await json<Overview>(client, `/api/overview?role=${requestedRole}`), row, identity, reference);
      }
      const dossier = await checkDossier(client, identity, row, context);
      await json(client, '/api/replay', {exerciseId: row.id, tick: 1});
      try {
        const historical = await json<Overview>(client, '/api/overview?role=instructor');
        checkOverview(historical, row, identity, reference);
        assert.equal(historical.playbackTick, 1); assert.equal(historical.state.tick, 1);
        assert(historical.state.fingerprint);
        rewindFingerprint ??= historical.state.fingerprint;
        assert.equal(historical.state.fingerprint, rewindFingerprint, 'Both participants must read the same historical world');
        assert.deepEqual(await checkDossier(client, identity, row, context), dossier);
      } finally { await json(client, '/api/replay', {exerciseId: row.id, tick: null}); }
      checkOverview(await json<Overview>(client, '/api/overview'), row, identity, reference);
      seats.push({...dossier, liveContext: true, roleQueryIgnored: true, rewindTick: 1, packPreserved: true});
    }
    runs.push({exerciseId: row.id, scenarioId, retainedPack: reference,
      enrollment: issuer === commander ? 'commander-issued participant code' : 'normal enrollment owner-issued participant code',
      beforeEnrollmentStatus: inaccessible.status, rewindFingerprint, seats});
    checkpoint('finish');
    await finishExercise(row.id); // Stop promptly after both seats, before opening the next world.
    checkpoint('budget');
    budgetAfter = (await json<ToolState>(commander, '/api/agents/tools')).budget;
    assert.deepEqual(budgetAfter, budgetBefore, 'Global budget must remain unchanged during qualification');
  }
  proof = {at: new Date().toISOString(), build, automated: true, humanPlaytest: false,
    subjects: {commander: cmd.identity.subject, intelligence: intel.identity.subject}, runs,
    budgetBefore, budgetAfter, modelOrInferenceEndpointsCalled: false, controllerEnablingAttempted: false,
    limitations: [
      'API qualification only; no browser, Tomo, model, human judgment or learning-efficacy validation.',
      'Requires pre-existing normal commander/intelligence accounts and an authorized invitation issuer; no provisioning or permission changes.',
      'Current fixed session roles and role-query spoofing are checked; live native role reassignment/revocation is not exercised.',
      'Objectives and classic cover both pack variants and tick-1 rewind. The other three scenario mappings are left to unit tests; no branching, restart, campaign carryover or sustained pacing qualification.',
      'No pre-existing exercise is selected, finished or amended. Legacy migration/replay compatibility is not qualified here.',
      'Optional means a blank authoring aid, not a generated assessment; a template is expected on these new pack-bearing exercises.',
      'Global budget comparison starts immediately after the first explicit exercise creation; concurrent inference elsewhere makes the comparison fail.',
    ]};
} catch (error) {
  recordFailure(error);
  // Retain the failure before attempting potentially fallible native cleanup.
  try { saveEvidence('failed'); }
  catch (writeError) { recordFailure(writeError, 'evidence-write'); }
}
finally {
  // Finish through the actual commander even when invitation, reads or assertions failed.
  // Do not hide cleanup failures or publish a success artifact before exercises have ended.
  phase = 'cleanup';
  for (const id of created.filter(id => !ended.includes(id))) {
    try {
      await finishExercise(id);
    } catch (error) { recordFailure(error, 'exercise-cleanup', id); }
  }
  phase = 'logout';
  for (const client of clients) {
    try { await client.close(); }
    catch (error) { recordFailure(error, 'logout'); }
  }
}
if (!failures.length && (!proof || ended.length !== created.length)) {
  recordFailure(new Error('Qualification or exercise cleanup was incomplete'), 'incomplete');
}
phase = 'complete';
console.log(JSON.stringify(saveEvidence(failures.length ? 'failed' : 'passed')));
if (failures.length) throw new AggregateError(failures, `Organization-context qualification failed; evidence retained at ${artifact}`);
