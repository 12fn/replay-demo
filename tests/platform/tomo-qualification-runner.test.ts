/** Runs the CLI with an in-memory filesystem and fully mocked native client; no native imports execute. */
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const mock = vi.hoisted(() => ({
  files: new Map<string, string>(),
  descriptors: new Map<number, string>(),
  request: vi.fn(), requestRaw: vi.fn(), close: vi.fn(), login: vi.fn(),
  read: vi.fn(), write: vi.fn(), open: vi.fn(), append: vi.fn(),
}));
vi.mock('node:fs', () => ({default: {
  existsSync: (path: string) => mock.files.has(path), readFileSync: mock.read,
  writeFileSync: mock.write, openSync: mock.open, writeSync: mock.append,
  closeSync: (fd: number) => { mock.descriptors.delete(fd); },
}}));
vi.mock('../../scripts/platform/native-app-client', () => ({nativeAppClient: mock.login}));

const version = '0.14.1', roomId = '54edeaaf04645a89a71bd1703715b9f9';
const inputId = '22222222-2222-4222-8222-222222222222';
const artifact = `evidence/platform/tomo-conversation-${version}.json`;
const acceptance = {input_id: inputId, accepted_position: 1, journal_head: 2, status: 'queued'};
let streamController: ReadableStreamDefaultController<Uint8Array>;
let inputResponse: () => Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const event = (name: string, position: number, data: unknown, overrides: object = {}) =>
  `id: ${position}\nevent: ${name}\ndata: ${JSON.stringify({schema_version: 1, stream_kind: 'durable', conversation_id: roomId, event: name, position, input_id: inputId, run_id: 'run-1', data, ...overrides})}\n\n`;
const emit = (wire: string) => streamController.enqueue(new TextEncoder().encode(wire));
const run = () => import('../../scripts/platform/qualify-tomo-conversation');
const proof = (path = artifact) => JSON.parse(mock.files.get(path)!);
const inputs = () => mock.requestRaw.mock.calls.filter(([path]) => path.endsWith('/inputs'));
let originalArgv: string[], originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  mock.files.clear(); mock.descriptors.clear();
  originalArgv = process.argv; originalExitCode = process.exitCode;
  process.argv = ['node', 'qualifier', version]; process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mock.read.mockImplementation((path: string) => {
    if (path === 'data/platform/tomo-conversation.json') return JSON.stringify({deploymentId: 'synthetic-model', agentId: 'synthetic-agent'});
    if (path === 'data/platform/team-qualification-users.json') return JSON.stringify([{role: 'commander', username: 'synthetic-user', password: 'synthetic-only'}]);
    throw new Error(`Unexpected file read ${path}`);
  });
  mock.write.mockImplementation((path: string, value: string, options?: {flag?: string}) => {
    if (options?.flag === 'wx' && mock.files.has(path)) throw new Error('EEXIST');
    mock.files.set(path, value);
  });
  mock.open.mockImplementation((path: string) => {
    if (mock.files.has(path)) throw new Error('EEXIST');
    mock.files.set(path, ''); mock.descriptors.set(1, path); return 1;
  });
  mock.append.mockImplementation((fd: number, value: string) => {
    const path = mock.descriptors.get(fd)!;
    mock.files.set(path, mock.files.get(path)! + value);
  });
  mock.close.mockResolvedValue(undefined);
  mock.login.mockResolvedValue({request: mock.request, requestRaw: mock.requestRaw, close: mock.close});
  mock.request.mockImplementation(async (path: string, _body: unknown, options?: {signal?: AbortSignal}) => {
    if (path === '/replay-build.json') return json({version, sourceArchive: {sha256: 'synthetic-source'}});
    if (path === '/api/overview') return json({});
    if (path === '/api/tomo/status') return json({mode: 'scoped-conversation'});
    if (path === '/api/agents/tools') return json({budget: {requestsUsed: 74}});
    if (path.endsWith('/events?after=0')) {
      const body = new ReadableStream<Uint8Array>({start(controller) { streamController = controller; }});
      options!.signal!.addEventListener('abort', () => { try { streamController.close(); } catch {} });
      return new Response(body, {headers: {'content-type': 'text/event-stream'}});
    }
    if (path.endsWith(roomId)) return json({id: roomId});
    throw new Error(`Unexpected request ${path}`);
  });
  inputResponse = async () => {
    emit(event('agent_run_failed', 3, {v: 1, status: 'failed', reason: 'model_route_unavailable'}));
    streamController.close();
    return json(acceptance, 202);
  };
  mock.requestRaw.mockImplementation(async (path: string) => path.endsWith('/inputs') ? inputResponse() : json({id: roomId}, 201));
});
afterEach(() => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.useRealTimers(); vi.restoreAllMocks();
});

it.each(['failed', 'cancelled', 'salvaged'])('fails qualification for a matched %s turn before acceptance, retaining reason/evidence', async status => {
  inputResponse = async () => {
    emit(event(`agent_run_${status}`, 3, {v: 1, status, reason: 'runtime_failed'}));
    streamController.close();
    return json(acceptance, 202);
  };
  await run();
  expect(process.exitCode).toBe(1);
  expect(proof()).toMatchObject({status: 'qualification-failed', acceptanceState: 'accepted', inputHttpStatus: 202, acceptance,
    terminal: {inputId, status, reason: 'runtime_failed'}, newRequests: 0});
  expect(mock.files.get(proof().privateEvents)).toContain('runtime_failed');
  expect(inputs()).toHaveLength(1);
});

it('matches early completion after an unrelated terminal and retains private nested answer', async () => {
  inputResponse = async () => {
    emit(event('agent_run_failed', 2, {v: 1, status: 'failed'}, {input_id: 'other'}));
    emit(event('assistant_message', 3, {v: 1, text: 'Actual fixture answer'}));
    emit(event('agent_run_completed', 4, {v: 1, status: 'completed'}));
    streamController.close();
    return json(acceptance, 202);
  };
  await run();
  expect(process.exitCode).toBeUndefined();
  expect(proof()).toMatchObject({status: 'terminal-observed', terminal: {inputId, position: 4, status: 'completed'}, assistant: {position: 3}});
  expect(mock.files.get(proof().privateEvents)).toContain('Actual fixture answer');
  expect(inputs()).toHaveLength(1);
});

it.each([200, 202])('preserves uncertain acceptance on invalid HTTP/body (%s) without a retry', async status => {
  inputResponse = async () => json(status === 200 ? acceptance : {input_id: inputId, accepted: true}, status);
  await run();
  expect(proof()).toMatchObject({status: 'input-acceptance-uncertain', acceptanceState: 'uncertain', inputHttpStatus: status, conversationId: roomId, inputId});
  expect(proof().inputKey).toBe(inputs()[0][2].idempotencyKey);
  expect(inputs()).toHaveLength(1);
  expect(process.exitCode).toBe(1);
});

it('bounds a hung input body, aborts it and retains the pre-dispatch proof/key', async () => {
  vi.useFakeTimers();
  inputResponse = async () => ({status: 202, json: () => new Promise(() => {})}) as Response;
  const pending = run();
  await vi.waitFor(() => expect(inputs()).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(30000);
  await pending;
  expect(proof()).toMatchObject({status: 'input-acceptance-uncertain', inputHttpStatus: 202, conversationId: roomId});
  expect(proof().privateEvents).toBeDefined();
  expect(inputs()[0][2].signal.aborted).toBe(true);
  expect(proof().inputKey).toBe(inputs()[0][2].idempotencyKey);
  expect(inputs()).toHaveLength(1);
  expect(process.exitCode).toBe(1);
});

it('preserves original same-version proof files when a suffix is supplied', async () => {
  mock.files.set(artifact, 'original-proof');
  process.argv.push('route-fix2');
  await run();
  expect(mock.files.get(artifact)).toBe('original-proof');
  expect(proof('evidence/platform/tomo-conversation-0.14.1-route-fix2.json')).toMatchObject({version, attempt: '0.14.1-route-fix2'});
});

it('refuses prior proof before reading configuration or logging in', async () => {
  mock.files.set(artifact, 'original-proof');
  await expect(run()).rejects.toThrow('Prior attempt file exists');
  expect(mock.login).not.toHaveBeenCalled();
  expect(mock.read).not.toHaveBeenCalled();
  expect(mock.files.get(artifact)).toBe('original-proof');
});
