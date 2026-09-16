import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LunaChatClient, MAX_CHAT_RESPONSE_BYTES, type ChatCompleteInput, type ChatFunctionTool,
  type ChatMessage, type ChatToolCall,
} from '../../src/inference/luna-chat-client.ts';
import { BudgetLedger } from '../../src/inference/ledger.ts';
import { DEFAULT_LUNA_MODEL, LunaClient, type FetchImpl } from '../../src/inference/luna-client.ts';
import { InferenceError } from '../../src/inference/errors.ts';
import { estimateReservationMicro, settlementMicro } from '../../src/inference/pricing.ts';
import tomoPiWire from '../fixtures/tomo-pi-wire.json';

const KEY = 'test-only-chat-key-never-a-real-credential';
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const usage = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } };
const tool: ChatFunctionTool = {
  type: 'function', function: { name: 'read_exercise', description: 'Read the authorized exercise.', strict: true,
    parameters: { type: 'object', properties: { exercise_id: { type: 'string' } }, required: ['exercise_id'], additionalProperties: false } },
};
const call: ChatToolCall = { id: 'call_01', type: 'function', function: { name: 'read_exercise', arguments: '{ "exercise_id": "exercise-1" }' } };
const request = (): ChatCompleteInput => ({ messages: [{ role: 'user', content: 'Read this exercise.' }], tools: [tool], purpose: 'tomo.chat', context: { runId: 'run-1' } });
function provider(message: unknown = { role: 'assistant', content: 'Recorded exercise at tick 6.' }, finish_reason = 'stop') {
  return { id: 'chatcmpl_01', object: 'chat.completion', created: 1_800_000_000, model: 'gpt-5.6-luna-2026-08-01',
    choices: [{ index: 0, message, finish_reason }], usage };
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
let dir: string;
let ledger: BudgetLedger;
let ledgers: BudgetLedger[];
function newLedger(maxRequests = 100, maxUsd = 5) {
  const next = new BudgetLedger({ path: join(dir, `ledger-${ledgers.length}.sqlite`), maxRequests, maxUsd });
  ledgers.push(next);
  return next;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replay-luna-chat-'));
  ledgers = []; ledger = newLedger();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('real network is forbidden in this suite'); }));
});
afterEach(() => {
  ledgers.forEach(l => l.close());
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function client(fetchImpl: FetchImpl, options: Partial<ConstructorParameters<typeof LunaChatClient>[0]> = {}) {
  return new LunaChatClient({ apiKey: KEY, ledger, fetchImpl, ...options });
}
async function failure(promise: Promise<unknown>): Promise<InferenceError> {
  try { await promise; } catch (err) {
    expect(err).toBeInstanceOf(InferenceError);
    const e = err as InferenceError;
    expect(`${e.message}\n${e.stack}\n${JSON.stringify(e)}\n${String(e.cause)}`).not.toContain(KEY);
    return e;
  }
  throw new Error('expected failure');
}

describe('structured chat and shared accounting', () => {
  it('reserves before tool selection, sends direct Chat JSON and settles tool-only usage', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url, init) => {
      expect(url).toBe('https://provider.invalid/v1/chat/completions');
      expect(ledger.listReceipts()).toHaveLength(1);
      const [reservation] = ledger.listReceipts();
      expect(reservation).toMatchObject({ status: 'reserved', purpose: 'tomo.chat', context: { runId: 'run-1' } });
      expect(reservation!.reservedMicro).toBe(estimateReservationMicro(Buffer.byteLength(init.body as string), 1600));
      expect(JSON.parse(init.body as string)).toEqual({ model: 'gpt-5.6-luna', messages: request().messages, tools: [tool],
        tool_choice: { type: 'function', function: { name: 'read_exercise' } }, max_completion_tokens: 1600,
        n: 1, stream: false, store: false, reasoning_effort: 'none' });
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${KEY}`, 'x-routing': 'deployment-1' } });
      expect(init.body).not.toContain(KEY);
      return json(provider({ role: 'assistant', content: null, tool_calls: [call], annotations: ['discard'], reasoning: 'discard' }, 'tool_calls'), 200, { 'x-request-id': 'req_01' });
    });
    const result = await client(fetchImpl, { baseUrl: 'https://provider.invalid/v1/', extraHeaders: { 'x-routing': 'deployment-1' } }).complete({
      ...request(), toolChoice: { type: 'function', function: { name: 'read_exercise' } }, maxOutputTokens: 1600,
    });
    expect(result.completion.choices).toEqual([{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }]);
    expect(result.receipt).toMatchObject({ status: 'completed', inputTokens: 120, cachedInputTokens: 20, outputTokens: 30,
      providerResponseId: 'chatcmpl_01', providerRequestId: 'req_01', modelReturned: 'gpt-5.6-luna-2026-08-01',
      settledMicro: settlementMicro({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 }), errorCode: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('round-trips multiple tool IDs/argument strings and out-of-order results into a separate metered continuation', async () => {
    const other = { ...call, id: 'call_02', function: { ...call.function, arguments: '{"exercise_id":"exercise-2"}' } };
    const fetchImpl = vi.fn<FetchImpl>()
      .mockImplementationOnce(async () => json(provider({ role: 'assistant', content: 'I will read both.', tool_calls: [call, other] }, 'tool_calls')))
      .mockImplementationOnce(async () => json(provider()));
    const c = client(fetchImpl);
    const first = await c.complete(request());
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Only authorized evidence.', name: 'policy' },
      { role: 'developer', content: 'Keep source ticks.' }, ...request().messages,
      first.completion.choices[0].message,
      { role: 'tool', tool_call_id: other.id, content: '{"tick":6,"source":"r2"}' },
      { role: 'tool', tool_call_id: call.id, content: '{"tick":6,"source":"r1"}' },
    ];
    const second = await c.complete({ ...request(), messages, toolChoice: 'none' });
    const sent = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(sent.messages).toEqual(messages);
    expect(sent.messages[3].tool_calls[0].function.arguments).toBe(call.function.arguments);
    expect(second.completion.choices[0].message).toEqual({ role: 'assistant', content: 'Recorded exercise at tick 6.' });
    expect(second.receipt.id).not.toBe(first.receipt.id);
    expect(ledger.summary().requestsUsed).toBe(2);
    expect(ledger.summary().committedMicro).toBe(first.receipt.settledMicro! + second.receipt.settledMicro!);
  });

  it('supports text without tools, default bounds and strips provider extras', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json({ ...provider(), system_fingerprint: KEY, service_tier: 'discard',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello', extra: KEY }, finish_reason: 'stop', logprobs: { secret: KEY } }] }));
    const result = await client(fetchImpl).complete({ messages: [{ role: 'user', content: 'hello' }], purpose: 'p' });
    expect(result.completion).toEqual({ ...provider({ role: 'assistant', content: 'hello' }), usage: { ...usage, total_tokens: 150 } });
    expect(JSON.stringify(result)).not.toContain(KEY);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ max_completion_tokens: 1000, n: 1, stream: false, store: false, reasoning_effort: 'none' });
    expect(body.reasoning_effort).toBe('none'); expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('tool_choice');
  });

  it('accepts nested function schemas, local references and optional strict/description fields', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json(provider()));
    const parameters = { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } },
      note: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 100 }] } },
      $defs: { item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } } };
    await client(fetchImpl).complete({ ...request(), tools: [{ type: 'function', function: { name: 'read_exercise', parameters, strict: false } }], toolChoice: 'auto' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).tools[0].function.parameters).toEqual(parameters);
  });

  it('shares caps with the existing Responses client and denies concurrent reservations before fetch', async () => {
    const capped = newLedger(3);
    const textFetch = vi.fn<FetchImpl>(async () => json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1 } }));
    await new LunaClient({ apiKey: KEY, ledger: capped, fetchImpl: textFetch }).complete({ instructions: '', input: 'x', purpose: 'existing.text' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<FetchImpl>(async () => { await held; return json(provider()); });
    const c = client(fetchImpl, { ledger: capped });
    const attempts = Array.from({ length: 8 }, () => c.complete(request()));
    const pending = Promise.allSettled(attempts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(capped.summary()).toMatchObject({ requestsUsed: 3, counts: { reserved: 2, completed: 1 } });
    release();
    const results = await pending;
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'request_cap_exceeded' });
  });

  it('denies insufficient money without network or a new receipt', async () => {
    const poor = newLedger(100, 0.0001), fetchImpl = vi.fn<FetchImpl>();
    expect(await failure(client(fetchImpl, { ledger: poor }).complete(request()))).toMatchObject({ code: 'budget_exceeded' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(poor.listReceipts()).toEqual([]);
  });
});

describe('source-derived synthetic Pi compatibility (not a live capture)', () => {
  it.each(tomoPiWire.cases)('preserves $name through the normal metered API', async fixture => {
    const input: ChatCompleteInput = {
      messages: structuredClone(fixture.request.messages) as ChatMessage[],
      tools: structuredClone(fixture.request.tools) as ChatFunctionTool[],
      purpose: 'tomo.synthetic.contract', maxOutputTokens: 1600,
    };
    const original = structuredClone(input);
    const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
      const sent = JSON.parse(init.body as string);
      expect(sent).toMatchObject({ model: DEFAULT_LUNA_MODEL, messages: original.messages,
        max_completion_tokens: 1600, stream: false, n: 1, store: false, reasoning_effort: 'none' });
      expect(sent.messages).toEqual(original.messages); // Includes arrays, null content, IDs and argument strings.
      expect(sent).not.toHaveProperty('stream_options');
      expect(sent.reasoning_effort).toBe('none');
      expect(sent.tools).toHaveLength(original.tools!.length);
      for (const [i, before] of original.tools!.entries()) {
        const after = sent.tools[i];
        expect(after.function).not.toHaveProperty('parameters.$schema');
        // Restore just the expected omitted root marker to compare every other field exactly.
        const restored = structuredClone(after);
        if (before.function.parameters.$schema) restored.function.parameters.$schema = DIALECT;
        expect(restored).toEqual(before);
        expect(after.function.strict).toBe(false);
      }
      expect(ledger.listReceipts()).toHaveLength(1);
      expect(ledger.listReceipts()[0]).toMatchObject({ status: 'reserved',
        reservedMicro: estimateReservationMicro(Buffer.byteLength(init.body as string), 1600) });
      return json(provider());
    });
    const result = await client(fetchImpl).complete(input);
    expect(input).toEqual(original);
    expect(result.receipt).toMatchObject({ status: 'completed', purpose: input.purpose });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.summary().requestsUsed).toBe(1);
  });

  it('keeps text-part order, empty strings, whitespace and Unicode without flattening', async () => {
    const content: Extract<ChatMessage, { role: 'user' }>['content'] = [
      { type: 'text', text: '  First\n' }, { type: 'text', text: '' }, { type: 'text', text: 'é 🛰️ last  ' },
    ];
    const fetchImpl = vi.fn<FetchImpl>(async () => json(provider()));
    await client(fetchImpl).complete({ messages: [{ role: 'user', content }], purpose: 'p' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages).toEqual([{ role: 'user', content }]);
  });

  it('retains refs, constraints and ordinary $schema-named data while removing only the root marker', async () => {
    const parameters = {
      $schema: DIALECT, type: 'object',
      properties: {
        tick: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/tick' }], default: null },
        $schema: { type: 'string', enum: ['ordinary field'] },
        metadata: { type: 'object', default: { $schema: 'ordinary data' } },
      },
      $defs: { tick: { type: 'integer', minimum: 0, maximum: 1_000_000 } },
      required: ['$schema'], additionalProperties: false,
    };
    const fetchImpl = vi.fn<FetchImpl>(async () => json(provider()));
    await client(fetchImpl).complete({ ...request(), tools: [{ type: 'function', function: { name: 'read_exercise', parameters, strict: false } }] });
    const sent = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).tools[0].function;
    expect(sent.strict).toBe(false);
    expect(sent.parameters).not.toHaveProperty('$schema');
    expect({ ...sent.parameters, $schema: DIALECT }).toEqual(parameters);
    expect(parameters.$schema).toBe(DIALECT);
  });

  it.each([
    ['unknown root dialect', { $schema: 'https://json-schema.org/draft-07/schema' }],
    ['noncanonical root dialect', { $schema: `${DIALECT}#` }],
    ['null root dialect', { $schema: null }],
    ['numeric root dialect', { $schema: 202012 }],
    ['property override', { properties: { x: { $schema: DIALECT, type: 'string' } } }],
    ['definition override', { $defs: { x: { $schema: DIALECT, type: 'string' } } }],
    ['legacy definition override', { definitions: { x: { $schema: DIALECT, type: 'string' } } }],
    ['array item override', { properties: { x: { type: 'array', items: { $schema: DIALECT, type: 'string' } } } }],
    ['composition override', { allOf: [{ $schema: DIALECT, type: 'object' }] }],
    ['additional properties override', { additionalProperties: { $schema: DIALECT, type: 'string' } }],
    ['unsupported keyword with known dialect', { unevaluatedProperties: false }],
    ['invalid constraint with known dialect', { properties: { x: { type: 'string', maxLength: -1 } } }],
    ['external ref with known dialect', { $ref: 'https://external.invalid/schema' }],
  ])('rejects %s before reservation', async (_label, patch) => {
    const fetchImpl = vi.fn<FetchImpl>();
    const parameters = { type: 'object', $schema: DIALECT, ...patch };
    expect(await failure(client(fetchImpl).complete({ ...request(), tools: [
      { type: 'function', function: { ...tool.function, parameters } },
    ] }))).toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
  });
});

describe('validation before reservations or network', () => {
  it.each(['omitted-content','text-parts','named-result'])('preserves valid %s tool continuation without relaxing call pairing',async variant=>{
    const fetchImpl=vi.fn<FetchImpl>(async()=>json(provider()));
    const assistant:ChatMessage={role:'assistant',...(variant==='omitted-content'?{}:{content:variant==='text-parts'?[{type:'text' as const,text:'Observed.'}]:null}),tool_calls:[call]};
    const result:ChatMessage={role:'tool',tool_call_id:call.id,content:variant==='text-parts'?[{type:'text',text:'Exact result'}]:'Exact result',...(variant==='named-result'?{name:'read_exercise'}:{})};
    await client(fetchImpl).complete({...request(),messages:[...request().messages,assistant,result]});
    const sent=JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(sent.messages[1]).toEqual(assistant);expect(sent.messages[2].content).toEqual(result.content);
    expect(sent.messages[2].tool_call_id).toBe(call.id);expect(sent.messages[2]).not.toHaveProperty('name');
    expect(ledger.summary().requestsUsed).toBe(1);
  });
  it.each([
    ['mismatched result name',{...request(),messages:[{role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,name:'other_tool',content:'result'}]}],
    ['assistant missing content without call',{...request(),messages:[{role:'assistant'}]}],
    ['nontext tool parts',{...request(),messages:[{role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:[{type:'image_url',image_url:{url:'x'}}]}]}],
    ['unknown request option', { ...request(), stream: true }],
    ['wire option instead of adapter option', { ...request(), tool_choice: 'auto' }],
    ['images', { ...request(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }],
    ['mixed image and text', { ...request(), messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'x' } }] }] }],
    ['empty text array', { ...request(), messages: [{ role: 'user', content: [] }] }],
    ['unknown part key', { ...request(), messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: {} }] }] }],
    ['unknown part type', { ...request(), messages: [{ role: 'user', content: [{ type: 'input_text', text: 'x' }] }] }],
    ['missing part type', { ...request(), messages: [{ role: 'user', content: [{ text: 'x' }] }] }],
    ['missing part text', { ...request(), messages: [{ role: 'user', content: [{ type: 'text' }] }] }],
    ['nonstring part text', { ...request(), messages: [{ role: 'user', content: [{ type: 'text', text: 1 }] }] }],
    ['bare string part', { ...request(), messages: [{ role: 'user', content: ['x'] }] }],
    ['null part', { ...request(), messages: [{ role: 'user', content: [null] }] }],
    ['system text array', { ...request(), messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }] }],
    ['developer text array', { ...request(), messages: [{ role: 'developer', content: [{ type: 'text', text: 'x' }] }] }],
    ['audio', { ...request(), messages: [{ role: 'assistant', content: 'x', audio: {} }] }],
    ['unknown message field', { ...request(), messages: [{ role: 'user', content: 'x', extra: true }] }],
    ['unknown role', { ...request(), messages: [{ role: 'function', content: 'x' }] }],
    ['null user content', { ...request(), messages: [{ role: 'user', content: null }] }],
    ['empty history', { ...request(), messages: [] }],
    ['orphan result', { ...request(), messages: [{ role: 'tool', content: 'x', tool_call_id: 'call_01' }] }],
    ['pending result', { ...request(), messages: [{ role: 'assistant', content: null, tool_calls: [call] }] }],
    ['interrupted results', { ...request(), messages: [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'user', content: 'next' }] }],
    ['duplicate results', { ...request(), messages: [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', content: 'a', tool_call_id: call.id }, { role: 'tool', content: 'b', tool_call_id: call.id }] }],
    ['duplicate call IDs', { ...request(), messages: [{ role: 'assistant', content: null, tool_calls: [call, call] }] }],
    ['bad call arguments', { ...request(), messages: [{ role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'read_exercise', arguments: '{broken' } }] }] }],
    ['builtin tool', { ...request(), tools: [{ type: 'web_search' }] }],
    ['duplicate tools', { ...request(), tools: [tool, tool] }],
    ['unknown tool field', { ...request(), tools: [{ ...tool, cache_control: {} }] }],
    ['unknown function field', { ...request(), tools: [{ type: 'function', function: { ...tool.function, extra: true } }] }],
    ['bad strict', { ...request(), tools: [{ type: 'function', function: { ...tool.function, strict: 'true' } }] }],
    ['invalid parameters', { ...request(), tools: [{ type: 'function', function: { ...tool.function, parameters: [] } }] }],
    ['bad nested schema', { ...request(), tools: [{ type: 'function', function: { ...tool.function, parameters: { type: 'object', properties: { x: { type: 'nonsense' } } } } }] }],
    ['unknown schema keyword', { ...request(), tools: [{ type: 'function', function: { ...tool.function, parameters: { type: 'object', unknown: true } } }] }],
    ['invalid schema pattern', { ...request(), tools: [{ type: 'function', function: { ...tool.function, parameters: { type: 'object', properties: { id: { type: 'string', pattern: '[' } } } } }] }],
    ['external ref', { ...request(), tools: [{ type: 'function', function: { ...tool.function, parameters: { type: 'object', $ref: 'https://external.invalid/schema' } } }] }],
    ['required without tools', { ...request(), tools: [], toolChoice: 'required' }],
    ['unknown chosen tool', { ...request(), toolChoice: { type: 'function', function: { name: 'unknown' } } }],
    ['unknown choice field', { ...request(), toolChoice: { type: 'function', function: { name: 'read_exercise', extra: true } } }],
    ['bad choice', { ...request(), toolChoice: 'sometimes' }],
    ['too many messages', { ...request(), messages: Array.from({ length: 129 }, () => ({ role: 'user', content: 'x' })) }],
    ['too many tools', { ...request(), tools: Array.from({ length: 65 }, (_, i) => ({ ...tool, function: { ...tool.function, name: `f${i}` } })) }],
    ['missing purpose', { messages: request().messages }],
    ['empty purpose', { ...request(), purpose: ' ' }],
    ['context array', { ...request(), context: [] }],
    ['credential metadata', { ...request(), context: { leaked: KEY } }],
    ['credential purpose', { ...request(), purpose: KEY }],
    ['null request', null],
  ])('rejects %s before any I/O', async (_label, input) => {
    const fetchImpl = vi.fn<FetchImpl>();
    expect(await failure(client(fetchImpl).complete(input as ChatCompleteInput))).toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
  });

  it.each([0, -1, 1.5, 1601, Number.MAX_SAFE_INTEGER, NaN, Infinity, '100', null])('strictly rejects maxOutputTokens %s', async maxOutputTokens => {
    const fetchImpl = vi.fn<FetchImpl>();
    expect(await failure(client(fetchImpl).complete({ ...request(), maxOutputTokens } as ChatCompleteInput))).toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
  });

  it('bounds complete serialized UTF-8 messages, tool results and schemas without truncation', async () => {
    const fetchImpl = vi.fn<FetchImpl>(), c = client(fetchImpl);
    const big = 'é'.repeat(17 * 1024);
    for (const req of [
      { ...request(), messages: [{ role: 'user', content: big }] },
      { ...request(), messages: [{ role: 'user', content: [{ type: 'text', text: big }] }] },
      { ...request(), messages: [{ role: 'user', content: Array.from({ length: 32 }, () => ({ type: 'text', text: 'x'.repeat(1024) })) }] },
      { ...request(), messages: [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', content: big, tool_call_id: call.id }] },
      { ...request(), tools: [{ ...tool, function: { ...tool.function, description: big } }] },
    ]) expect(await failure(c.complete(req as ChatCompleteInput))).toMatchObject({ code: 'input_too_large' });
    // Individually small fields must still count together, including JSON framing.
    expect(await failure(client(fetchImpl, { maxInputBytes: 700 }).complete({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(500) }] }))).toMatchObject({ code: 'input_too_large' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
  });

  it('rejects cyclic/non-JSON/getter data safely without invoking serialization hooks', async () => {
    const fetchImpl = vi.fn<FetchImpl>(), c = client(fetchImpl), hook = vi.fn(() => KEY);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const context of [cycle, { bigint: 1n }, { fn: hook }, { toJSON: hook }, Object.defineProperty({}, 'x', { enumerable: true, get: hook })]) {
      expect(await failure(c.complete({ ...request(), context }))).toMatchObject({ code: 'invalid_request' });
    }
    expect(hook).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
  });

  it('has no constructor side effects, rejects absent credentials, and never serializes routing secrets', async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const c = client(fetchImpl, { baseUrl: `https://provider.invalid/${KEY}`, extraHeaders: { 'x-routing': KEY } });
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
    expect(await failure(client(fetchImpl, { apiKey: ' ' }).complete(request()))).toMatchObject({ code: 'missing_credentials' });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.listReceipts()).toEqual([]);
    expect(() => client(fetchImpl, { maxInputBytes: 32 * 1024 + 1 })).toThrow(RangeError);
  });
  it('admits a bounded native-sized tool continuation and refuses oversized history before a new reservation',async()=>{
    const fetchImpl=vi.fn<FetchImpl>(async()=>json(provider()));const c=client(fetchImpl);
    const continuation=(bytes:number):ChatCompleteInput=>({...request(),messages:[...request().messages,
      {role:'assistant',content:null,tool_calls:[call]},
      {role:'tool',tool_call_id:call.id,content:'x'.repeat(bytes)},
    ]});
    await c.complete(continuation(27000));
    expect(Buffer.byteLength(fetchImpl.mock.calls[0]![1].body as string)).toBeGreaterThan(24*1024);
    expect(ledger.summary().requestsUsed).toBe(1);
    expect(await failure(c.complete(continuation(33*1024)))).toMatchObject({code:'input_too_large'});
    expect(fetchImpl).toHaveBeenCalledOnce();expect(ledger.summary().requestsUsed).toBe(1);
  });
});

describe('provider outcomes, byte limits and safe errors', () => {
  it.each([
    undefined, null, {}, { prompt_tokens: -1, completion_tokens: 1 }, { prompt_tokens: 2.5, completion_tokens: 1 },
    { prompt_tokens: 10, completion_tokens: -1 }, { prompt_tokens: '10', completion_tokens: 1 },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: null } },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: [] },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: Number.MAX_SAFE_INTEGER },
  ])('retains reservation for missing, malformed or unpriceable usage %j', async reportedUsage => {
    const body = { ...provider({ role: 'assistant', content: null, tool_calls: [call] }, 'tool_calls'), usage: reportedUsage };
    const fetchImpl = vi.fn<FetchImpl>(async () => json(body));
    const result = await client(fetchImpl).complete(request());
    expect(result.completion.choices[0].message.tool_calls).toEqual([call]);
    expect(result.completion).not.toHaveProperty('usage');
    expect(result.receipt).toMatchObject({ status: 'uncertain', errorCode: 'usage_missing', settledMicro: result.receipt.reservedMicro });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([0, 20])('settles cached tokens %s and strips unneeded usage fields', async cached => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json({ ...provider(), usage: { ...usage,
      prompt_tokens_details: { cached_tokens: cached, ignored: KEY }, completion_tokens_details: { reasoning_tokens: 10 } } }));
    const result = await client(fetchImpl).complete(request());
    expect(result.receipt.cachedInputTokens).toBe(cached);
    expect(result.receipt.outputTokens).toBe(30);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('accepts zero usage and absent cache details, deriving total_tokens rather than trusting provider extras', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json({ ...provider(), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: KEY } }));
    const result = await client(fetchImpl).complete(request());
    expect(result.completion.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } });
    expect(result.receipt).toMatchObject({ status: 'completed', settledMicro: 0, cachedInputTokens: 0 });
  });

  it.each([
    ['length', provider({ role: 'assistant', content: 'partial' }, 'length'), 'incomplete_response'],
    ['filter', provider({ role: 'assistant', content: KEY }, 'content_filter'), 'malformed_response'],
    ['refusal', provider({ role: 'assistant', content: null, refusal: KEY }), 'malformed_response'],
    ['invalid arguments', provider({ role: 'assistant', content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: KEY } }] }, 'tool_calls'), 'malformed_response'],
    ['unknown tool', provider({ role: 'assistant', content: null, tool_calls: [{ ...call, function: { ...call.function, name: 'unknown' } }] }, 'tool_calls'), 'malformed_response'],
    ['array arguments', provider({ role: 'assistant', content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: '[]' } }] }, 'tool_calls'), 'malformed_response'],
    ['duplicate IDs', provider({ role: 'assistant', content: null, tool_calls: [call, call] }, 'tool_calls'), 'malformed_response'],
    ['wrong finish', provider({ role: 'assistant', content: null, tool_calls: [call] }), 'malformed_response'],
    ['missing calls', provider({ role: 'assistant', content: 'x' }, 'tool_calls'), 'malformed_response'],
    ['empty answer', provider({ role: 'assistant', content: '  ' }), 'malformed_response'],
    ['nontext', provider({ role: 'assistant', content: [{ type: 'text', text: KEY }] }), 'malformed_response'],
    ['audio', provider({ role: 'assistant', content: 'x', audio: {} }), 'malformed_response'],
    ['multiple choices', { ...provider(), choices: [provider().choices[0], provider().choices[0]] }, 'malformed_response'],
    ['unknown finish', provider({ role: 'assistant', content: 'x' }, 'function_call'), 'malformed_response'],
    ['missing envelope', { choices: provider().choices, usage }, 'malformed_response'],
  ])('accounts usage even for unusable %s', async (_label, body, code) => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json(body));
    expect(await failure(client(fetchImpl).complete(request()))).toMatchObject({ code, receiptId: expect.any(String) });
    expect(ledger.listReceipts()[0]).toMatchObject({ status: 'completed', outputTokens: 30, settledMicro: settlementMicro({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 }) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces selected/required/disabled tools and prevents reusing a historical call ID', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json(provider({ role: 'assistant', content: null, tool_calls: [call] }, 'tool_calls')));
    await failure(client(fetchImpl).complete({ ...request(), toolChoice: 'none' }));
    await failure(client(fetchImpl).complete({ ...request(), tools: [tool, { ...tool, function: { ...tool.function, name: 'other' } }], toolChoice: { type: 'function', function: { name: 'other' } } }));
    await failure(client(fetchImpl).complete({ ...request(), messages: [...request().messages, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', content: 'result', tool_call_id: call.id }] }));
    const text = vi.fn<FetchImpl>(async () => json(provider()));
    await failure(client(text).complete({ ...request(), toolChoice: 'required' }));
    expect(ledger.listReceipts().every(r => r.status === 'completed' && r.errorCode === 'invalid_chat_answer')).toBe(true);
  });

  it('times out even if injected fetch ignores abort, retains spend and never retries', async () => {
    const fetchImpl = vi.fn<FetchImpl>(() => new Promise(() => {}));
    expect(await failure(client(fetchImpl, { timeoutMs: 10 }).complete(request()))).toMatchObject({ code: 'timeout' });
    expect(fetchImpl.mock.calls[0]![1].signal!.aborted).toBe(true);
    expect(ledger.listReceipts()[0]).toMatchObject({ status: 'uncertain', errorCode: 'timeout' });
    expect(ledger.summary().uncertainMicro).toBe(ledger.listReceipts()[0]!.reservedMicro);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('includes body reading in the timeout and cancels a stalled provider stream', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel })));
    expect(await failure(client(fetchImpl, { timeoutMs: 10 }).complete(request()))).toMatchObject({ code: 'timeout' });
    expect(cancel).toHaveBeenCalled();
    expect(ledger.listReceipts()[0]).toMatchObject({ status: 'uncertain', errorCode: 'timeout' });
  });

  it('sanitizes network exceptions and ledger errors without preserving their causes', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => { throw new Error(KEY); });
    const networkError = await failure(client(fetchImpl).complete(request()));
    expect(networkError.code).toBe('network_error'); expect(networkError.cause).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.spyOn(ledger, 'reserve').mockImplementation(() => { throw new Error(KEY); });
    const ledgerError = await failure(client(fetchImpl).complete(request()));
    expect(ledgerError.code).toBe('ledger_error'); expect(ledgerError.cause).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves the reservation charged if settlement fails, with no raw ledger error or retry', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json(provider()));
    vi.spyOn(ledger, 'settle').mockImplementation(() => { throw new Error(KEY); });
    expect(await failure(client(fetchImpl).complete(request()))).toMatchObject({ code: 'ledger_error', receiptId: expect.any(String) });
    expect(ledger.listReceipts()[0]).toMatchObject({ status: 'reserved' });
    expect(ledger.summary().reservedMicro).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 503])('handles HTTP %s without raw provider diagnostics', async status => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json({ error: { code: 'invalid_request_error', message: KEY, extras: KEY } }, status, { 'x-request-id': KEY }));
    expect(await failure(client(fetchImpl).complete(request()))).toMatchObject({ code: 'provider_error', httpStatus: status });
    expect(ledger.listReceipts()[0]).toMatchObject({ status: status < 500 ? 'failed' : 'uncertain', providerRequestId: null });
    expect(JSON.stringify(ledger.listReceipts())).not.toContain(KEY); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('settles actual usage on an HTTP error, and retains uncertainty if its usage is malformed', async () => {
    const fetchImpl = vi.fn<FetchImpl>()
      .mockImplementationOnce(async () => json({ error: { code: 'bad_request' }, usage }, 400))
      .mockImplementationOnce(async () => json({ error: { code: 'bad_request' }, usage: {} }, 400));
    await failure(client(fetchImpl).complete(request())); await failure(client(fetchImpl).complete(request()));
    expect(ledger.listReceipts().map(r => r.status).sort()).toEqual(['completed', 'uncertain']);
  });

  it.each(['not-json', 'oversized', 'declared-oversized'])('bounds %s provider bodies and retains the reservation', async kind => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<FetchImpl>(async () => kind === 'not-json' ? new Response(KEY) : new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(MAX_CHAT_RESPONSE_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel,
    }), { headers: kind === 'declared-oversized' ? { 'content-length': String(MAX_CHAT_RESPONSE_BYTES + 1) } : {} }));
    expect(await failure(client(fetchImpl).complete(request()))).toMatchObject({ code: 'malformed_response' });
    expect(ledger.listReceipts()[0]).toMatchObject({ status: 'uncertain', errorCode: 'malformed_response' });
    if (kind !== 'not-json') expect(cancel).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retain credential-bearing provider model/response identifiers', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => json({ ...provider(), id: KEY, model: KEY }, 200, { 'x-request-id': KEY }));
    await failure(client(fetchImpl).complete(request()));
    expect(ledger.listReceipts()[0]).toMatchObject({ status: 'completed', modelReturned: null, providerResponseId: null, providerRequestId: null });
    expect(JSON.stringify(ledger.listReceipts())).not.toContain(KEY);
  });
});
