/** One Intelligence-owned Tomo practice-details conversation. VERSION [ATTEMPT_SUFFIX]. No retries. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
import {attemptArguments, inputAccepted, roomCreated, RoomFrameDecoder, RoomObservation, withDeadline, type TerminalOutcome} from './tomo-qualification-contract';

const {version, suffix, attempt} = attemptArguments(process.argv.slice(2));
const artifact = `evidence/platform/tomo-intelligence-details-${attempt}.json`;
const privateEvents = `data/platform/tomo-intelligence-details-${attempt}-events.jsonl`;
const privateBaseline = `data/platform/tomo-intelligence-details-${attempt}-baseline.json`;
const TOOL='kz_replay-tools_replay_search_practice_details';
const args={scope:'mine',query:'blue-r03 repeats blue-r02',limit:1};
const privateDetail = `data/platform/tomo-intelligence-details-${attempt}-detail.json`;
for (const path of [artifact, privateEvents, privateDetail, privateBaseline])
  assert(!fs.existsSync(path), `Prior attempt file exists: ${path}; inspect before any new paid submission`);
const proof: Record<string, any> = {
  startedAt: new Date().toISOString(), version, attempt, ...(suffix ? {attemptSuffix: suffix} : {}),
  automatedOperation: true, pairedPlayerTrial: false,
  exerciseId: '70d107e2-f0e3-414c-bdc8-33e2cc6a9852', role: 'intelligence', status: 'starting',
  creationKey: randomUUID(), inputKey: randomUUID(),
  note: 'Observation only; main must verify actual tool execution, grounded answer and receipts before claiming success.',
};
// Reserve the proof before authentication or mutation, also protecting simultaneous invocations.
fs.writeFileSync(artifact, JSON.stringify(proof, null, 2) + '\n', {flag: 'wx', mode: 0o600});
const save = () => fs.writeFileSync(artifact, JSON.stringify(proof, null, 2) + '\n');
const errorText = (_error: unknown) => 'qualification-operation-or-contract-failed';
const prefix = '/runtime/apps/replay-tomo/api/conversations';
const controller = new AbortController();
let c: Awaited<ReturnType<typeof nativeAppClient>> | undefined;
let streamTask: Promise<void> | undefined;
let observation: RoomObservation | undefined;

try {
  const config = JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json', 'utf8'));
  const users = JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json', 'utf8'));
  const user = users.find((u: any) => u.role === 'intelligence');
  assert(user);
  try { c = await nativeAppClient(user); }
  finally { for (const u of users) u.password = ''; }
  const client = c;
  const helper=JSON.parse(fs.readFileSync('evidence/platform/tomo-intelligence-helper-apply-2026-09-15T04-42-54-180Z.json','utf8'));
  // Explicitly qualified member-owned helper; do not reuse legacy Commander configuration.
  config.agentId='07cc5eba-971a-4895-8187-d2fdc9fd862e';
  proof.agentId=config.agentId;
  assert(JSON.stringify(helper).includes(config.agentId));
  const readJson = (path: string) => withDeadline(async signal => (await client.request(path, undefined, {signal})).json(), 15000, 'Read response not received within 15 seconds');
  const build = await readJson('/replay-build.json') as any;
  assert.equal(build.version, version);
  proof.sourceSha256 = build.sourceArchive.sha256;
  const identity=await readJson('/api/native/status') as any;
  assert.equal(identity.identity.role,'intelligence');
  assert.equal(identity.identity.subject,user.subject);
  proof.subject=user.subject;
  await withDeadline(signal=>client.request('/api/select',{exerciseId:proof.exerciseId},{signal}),15000,'selection-timeout');
  proof.budgetBefore = (await readJson('/api/agents/tools') as any).budget;
  const status = await readJson('/api/tomo/status') as any;
  assert.equal(status.mode, 'scoped-conversation');
  assert.equal(status.agentName,'REPLAY intelligence staff helper');
  assert.equal(status.helperBinding?.source,'registry');
  const budget=proof.budgetBefore;
  assert.equal(budget.maxRequests,100);assert.equal(budget.maxUsd,5);
  assert(Number.isInteger(budget.requestsUsed)&&budget.requestsUsed<=98&&budget.committedUsd<5);
  const baseline=await readJson('/api/practice/history/details?'+new URLSearchParams(Object.entries(args).map(([k,v])=>[k,String(v)]))) as any;
  assert.equal(baseline.schema,'replay.practice-history/2');assert.equal(baseline.scope,'mine');
  assert.equal(baseline.items.length,1);assert.equal(baseline.items[0].actor,user.subject);
  assert.equal(baseline.items[0].exercise.id,proof.exerciseId);
  fs.writeFileSync(privateBaseline,JSON.stringify({args,baseline},null,2)+'\n',{flag:'wx',mode:0o600});
  proof.privateBaseline=privateBaseline;


  proof.status = 'room-create-pending';
  save();
  const roomId = await withDeadline(async signal => {
    const response = await client.requestRaw(prefix, {}, {idempotencyKey: proof.creationKey, signal});
    signal.throwIfAborted();
    proof.creationHttpStatus = response.status;
    return roomCreated(response.status, await response.json());
  }, 30000, 'Room creation response uncertain after 30 seconds; preserve creation key');
  proof.conversationId = roomId;
  proof.status = 'room-created';
  save();

  const stream = await withDeadline(signal => client.request(`${prefix}/${roomId}/events?after=0`, undefined, {
    signal: AbortSignal.any([signal, controller.signal]),
  }), 15000, 'Event headers not received within 15 seconds');
  assert.equal(stream.status, 200, 'Room stream requires HTTP 200');
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream(?:;|$)/i);
  assert(stream.body, 'Event stream has no body');
  const streamBody = stream.body;
  observation = new RoomObservation(roomId);
  const room = observation;
  let streamFailure: unknown;
  let streamEnded = false;
  let resolveTerminal!: (outcome: TerminalOutcome) => void;
  let rejectTerminal!: (error: unknown) => void;
  const terminal = new Promise<TerminalOutcome>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  void terminal.catch(() => {});
  let acceptanceBound = false;
  const checkObservation = () => {
    if (!acceptanceBound) return; // The input response may lag behind every event, including completion.
    try {
      const outcome = room.outcome();
      if (outcome) resolveTerminal(outcome);
      else if (streamFailure) rejectTerminal(streamFailure);
      else if (streamEnded) rejectTerminal(new Error('Event stream ended before matched terminal observation'));
    } catch (error) { rejectTerminal(error); }
  };
  const sink = fs.openSync(privateEvents, 'wx', 0o600);
  proof.privateEvents = privateEvents;
  save();
  streamTask = (async () => {
    const reader = streamBody.getReader(), decoder = new RoomFrameDecoder();
    try {
      while (!controller.signal.aborted) {
        const {done, value} = await reader.read();
        if (done) break;
        for (const frame of decoder.push(value)) {
          // Preserve the original envelope at the top level for existing evidence readers.
          fs.writeSync(sink, JSON.stringify({...frame.envelope, _sse: {event: frame.sseEvent, id: frame.sseId}}) + '\n');
          room.add(frame);
          checkObservation();
        }
      }
    } catch (error) { streamFailure = error; }
    finally {
      streamEnded = true;
      checkObservation();
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
      fs.closeSync(sink);
    }
  })();

  // Observe already-settled read failures before admitting a paid input.
  await Promise.resolve();
  if (streamFailure) throw streamFailure;
  assert(!streamEnded, 'Event stream ended before input dispatch');
  const message = `Call ${TOOL} exactly once using ${JSON.stringify(args)} and no other tools. Use the returned item only. Return a JSON object with record (eventId,exerciseId=exercise.id,recordedTick=ticks.recorded,observedTick=ticks.observed,statementTiming=statement.timing,statementText=statement.text,sources=list of {id,derivedFrom or null,atViewedTick,atCompletedCutoff} copied exactly). Add explanation in under100words: explain the difference between independent corroboration and derivative reports, distinguish what was known at the observed tick from later supersession, and suggest one useful review question. State that this is an automated authored example, not evidence of this human's skill or personality. No actions and no invented tool results.`;
  proof.status = 'input-response-pending';
  proof.acceptanceState = 'uncertain';
  proof.inputDispatchedAt = new Date().toISOString();
  save(); // Persist room and the one stable key before the only input POST.
  const accepted = await withDeadline(async signal => {
    const response = await client.requestRaw(`${prefix}/${roomId}/inputs`, {
      kind: 'message', message, model: config.deploymentId, agent: config.agentId,
      platform_tool_names: [TOOL],
      connector_ids: [], subagent_ids: [], resource_reference_ids: [], effort: 'low',
    }, {idempotencyKey: proof.inputKey, signal});
    signal.throwIfAborted();
    proof.inputHttpStatus = response.status;
    save();
    const body: unknown = await response.json();
    signal.throwIfAborted();
    // Keep a returned ID for read-only reconciliation even if another acceptance field is malformed.
    if (body !== null && typeof body === 'object' && 'input_id' in body && typeof body.input_id === 'string') proof.inputId = body.input_id;
    return inputAccepted(response.status, body);
  }, 30000, 'Input acceptance uncertain after 30 seconds; preserve room/input key and reconcile, do not resubmit under a new key');
  proof.acceptance = accepted;
  proof.inputId = accepted.input_id;
  proof.acceptanceState = 'accepted';
  proof.status = 'input-accepted';
  save();
  room.accept(accepted);
  acceptanceBound = true;
  checkObservation(); // Recheck buffered early terminals, even if the stream has already ended.
  const result = await withDeadline(() => terminal, 120000, 'Matched terminal event not observed within 120 seconds; accepted input may still be running');
  const {assistant, ...terminalProof} = result;
  proof.terminal = terminalProof;
  proof.status = result.status === 'completed' ? 'terminal-observed' : 'qualification-failed';
  if (assistant) proof.assistant = {position: assistant.position, inputId: result.inputId, runId: result.runId, privateEvents};
  if (result.status !== 'completed') {
    proof.error = `Tomo run ${result.status}${result.reason ? `: ${result.reason}` : ''}`;
    process.exitCode = 1;
  }
  save();
  // Once a matched terminal is retained, an auxiliary detail failure must not overwrite its outcome.
  controller.abort();
  try {
    const detail = await readJson(`${prefix}/${roomId}`);
    fs.writeFileSync(privateDetail, JSON.stringify(detail, null, 2), {flag: 'wx', mode: 0o600});
    proof.privateDetail = privateDetail;
  } catch (error) { proof.detailError = errorText(error); process.exitCode = 1; }
} catch (error) {
  proof.status = proof.acceptanceState === 'uncertain' ? 'input-acceptance-uncertain'
    : proof.status === 'room-create-pending' ? 'room-creation-uncertain' : 'qualification-incomplete';
  proof.error = errorText(error);
  process.exitCode = 1;
} finally {
  controller.abort();
  try { await withDeadline(() => streamTask ?? Promise.resolve(), 5000, 'Stream cleanup exceeded 5 seconds'); }
  catch (error) { proof.cleanupError = errorText(error); process.exitCode = 1; }
  if (observation) {
    proof.eventTypes = observation.eventTypes;
    proof.lastDurablePosition = observation.lastPosition;
  }
  if (c) {
    try {
      proof.budgetAfter = (await withDeadline(async signal => (await c!.request('/api/agents/tools', undefined, {signal})).json(), 15000, 'Budget read timed out') as any).budget;
      if (typeof proof.budgetBefore?.requestsUsed === 'number' && typeof proof.budgetAfter?.requestsUsed === 'number')
        proof.newRequests = proof.budgetAfter.requestsUsed - proof.budgetBefore.requestsUsed;
    } catch (error) { proof.budgetReadError = errorText(error); }
    try { await withDeadline(() => c!.close(), 15000, 'Logout timed out'); }
    catch (error) { proof.logoutError = errorText(error); }
  }
  proof.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify(proof));
}
