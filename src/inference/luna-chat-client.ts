import {chatFailureDiagnostics} from './chat-failure-diagnostics';
/**
 * Offline-testable Chat Completions adapter. No routing, retries, SSE or tool execution.
 * Pi user text-part arrays retain their order and text verbatim. Function schemas may
 * declare draft 2020-12 at the root while using the existing supported subset; only
 * that recognized root $schema marker is deliberately omitted from provider JSON.
 * Unknown dialects and nested dialect overrides are rejected before reservation.
 */
import type { FetchImpl, LunaClientOptions } from './luna-client.ts';
import { DEFAULT_BASE_URL, DEFAULT_LUNA_MODEL, DEFAULT_TIMEOUT_MS } from './luna-client.ts';
import { BudgetCapError, type BudgetLedger, type Receipt } from './ledger.ts';
import { InferenceError, type InferenceErrorCode, sanitizeProviderCode } from './errors.ts';
import { assertLocalRoute, LOCAL_API_PRICING, localReceiptContext } from './local-route';
import {modelPricing, reasoningEffort, providerHeaders, privateValues, containsPrivate, safeProviderId, matchesRequestedModel, type ReasoningEffort} from './external-model';
import {
  DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CEILING,
  estimateReservationMicro, settlementMicro, type UsageTokens, type PriceTable,
} from './pricing.ts';

export const MAX_CHAT_MESSAGES = 128;
/** Fits native Tomo's tool-bearing continuation; separate from the Responses input limit. */
export const MAX_CHAT_INPUT_BYTES = 32 * 1024;
export const MAX_CHAT_TOOLS = 64;
export const MAX_CHAT_RESPONSE_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 32;
const FUNCTION_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,128}$/;
type RecordValue = Record<string, unknown>;

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type ChatMessage =
  | { role: 'system' | 'developer'; content: string; name?: string }
  | { role: 'user'; content: string | { type: 'text'; text: string }[]; name?: string }
  | { role: 'assistant'; content?: string | {type:'text';text:string}[] | null; name?: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; content: string | {type:'text';text:string}[]; tool_call_id: string; name?:string };
export interface ChatFunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters: RecordValue; strict?: boolean };
}
export type ChatToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
export interface ChatCompleteInput {
  messages: ChatMessage[];
  tools?: ChatFunctionTool[];
  toolChoice?: ChatToolChoice;
  purpose: string;
  context?: RecordValue;
  maxOutputTokens?: number;
}
export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: [{ index: 0; message: Extract<ChatMessage, { role: 'assistant' }>; finish_reason: 'stop' | 'tool_calls' }];
  /** Omitted when provider usage is missing or invalid; the receipt retains the reservation. */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details: { cached_tokens: number } };
}
export interface ChatCompleteResult { completion: ChatCompletion; receipt: Receipt }

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireShape(ok: unknown): asserts ok {
  if (!ok) throw new InferenceError('invalid_request', 'unsupported or malformed chat request');
}
function fields(value: unknown, allowed: string[]): asserts value is RecordValue {
  requireShape(record(value) && Object.keys(value).every(key => allowed.includes(key)));
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Snapshot JSON data without executing getters/toJSON or silently dropping unsupported values. */
function snapshot(value: unknown, byteLimit: number): unknown {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    requireShape(depth <= MAX_JSON_DEPTH && ++nodes <= 10_000);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      if (Buffer.byteLength(v, 'utf8') > byteLimit) throw new InferenceError('input_too_large', 'chat input exceeds byte limit');
      return v;
    }
    if (typeof v === 'number') { requireShape(Number.isFinite(v)); return v; }
    requireShape(record(v) || Array.isArray(v));
    requireShape(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
    const keys = Reflect.ownKeys(v);
    requireShape(keys.length <= 10_000 && keys.every(key => typeof key === 'string'));
    if (Array.isArray(v)) {
      requireShape(keys.length === v.length + 1);
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        requireShape(d && 'value' in d);
        return visit(d.value, depth + 1);
      });
    }
    return Object.fromEntries(keys.map(key => {
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      requireShape(typeof key === 'string' && d.enumerable && 'value' in d);
      visit(key, depth + 1);
      return [key, visit(d.value, depth + 1)];
    }));
  };
  const copied = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(copied), 'utf8') > byteLimit) {
    throw new InferenceError('input_too_large', 'chat input exceeds byte limit');
  }
  return copied;
}

/** Supported JSON Schema subset: ordinary object/function schemas, local refs and compositions. */
function schema(value: unknown, root: RecordValue, depth = 0): void {
  requireShape(depth <= 16);
  if (typeof value === 'boolean') return;
  fields(value, ['type', 'properties', 'required', 'additionalProperties', '$defs', 'definitions', '$ref',
    'items', 'prefixItems', 'anyOf', 'oneOf', 'allOf', 'not', 'enum', 'const', 'title', 'description',
    'default', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
    ...(depth === 0 ? ['$schema'] : [])]);
  if (Object.hasOwn(value, '$schema')) requireShape(value.$schema === FUNCTION_SCHEMA_DIALECT);
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    requireShape(types.length > 0 && new Set(types).size === types.length
      && types.every(t => ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(t as string)));
  }
  for (const key of ['properties', '$defs', 'definitions']) if (value[key] !== undefined) {
    requireShape(record(value[key]));
    Object.values(value[key]).forEach(v => schema(v, root, depth + 1));
  }
  if (value.required !== undefined) requireShape(Array.isArray(value.required)
    && value.required.every(v => typeof v === 'string') && new Set(value.required).size === value.required.length);
  for (const key of ['additionalProperties', 'items', 'not']) if (value[key] !== undefined) schema(value[key], root, depth + 1);
  for (const key of ['prefixItems', 'anyOf', 'oneOf', 'allOf']) if (value[key] !== undefined) {
    requireShape(Array.isArray(value[key]) && value[key].length > 0);
    value[key].forEach(v => schema(v, root, depth + 1));
  }
  if (value.enum !== undefined) requireShape(Array.isArray(value.enum) && value.enum.length > 0);
  for (const key of ['title', 'description', 'format', 'pattern']) if (value[key] !== undefined) requireShape(typeof value[key] === 'string');
  if (typeof value.pattern === 'string') {
    try { new RegExp(value.pattern); } catch { requireShape(false); }
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (value[key] !== undefined) requireShape(typeof value[key] === 'number' && Number.isFinite(value[key]) && (key !== 'multipleOf' || value[key] > 0));
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) {
    if (value[key] !== undefined) requireShape(integer(value[key]));
  }
  if (value.uniqueItems !== undefined) requireShape(typeof value.uniqueItems === 'boolean');
  if (value.$ref !== undefined) {
    requireShape(typeof value.$ref === 'string' && (value.$ref === '#' || value.$ref.startsWith('#/')));
    let target: unknown = root;
    for (const part of value.$ref === '#' ? [] : value.$ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      requireShape(record(target) && Object.hasOwn(target, key));
      target = target[key];
    }
    requireShape(record(target) || typeof target === 'boolean');
  }
}

function calls(value: unknown): ChatToolCall[] {
  requireShape(Array.isArray(value) && value.length > 0 && value.length <= MAX_CHAT_TOOLS);
  const ids = new Set<string>();
  return value.map(call => {
    fields(call, ['id', 'type', 'function']);
    requireShape(typeof call.id === 'string' && IDENTIFIER.test(call.id) && !ids.has(call.id) && call.type === 'function');
    ids.add(call.id);
    fields(call.function, ['name', 'arguments']);
    requireShape(typeof call.function.name === 'string' && NAME.test(call.function.name) && typeof call.function.arguments === 'string');
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); } catch { requireShape(false); }
    requireShape(record(args));
    return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
  });
}

function validate(req: unknown): asserts req is ChatCompleteInput {
  fields(req, ['messages', 'tools', 'toolChoice', 'purpose', 'context', 'maxOutputTokens']);
  requireShape(typeof req.purpose === 'string' && req.purpose.trim().length > 0 && Buffer.byteLength(req.purpose) <= 256);
  if (req.context !== undefined) requireShape(record(req.context) && Buffer.byteLength(JSON.stringify(req.context)) <= 4096);
  const max = req.maxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : req.maxOutputTokens;
  requireShape(integer(max) && max > 0 && max <= MAX_OUTPUT_TOKENS_CEILING);
  requireShape(Array.isArray(req.messages) && req.messages.length > 0 && req.messages.length <= MAX_CHAT_MESSAGES);
  const seen = new Set<string>(), pending = new Map<string,string>();
  const textContent=(content:unknown)=>{
    if(typeof content==='string')return;
    requireShape(Array.isArray(content)&&content.length>0);
    for(const part of content){fields(part,['type','text']);requireShape(part.type==='text'&&typeof part.text==='string');}
  };
  for (const message of req.messages) {
    requireShape(record(message));
    if (message.role === 'tool') {
      fields(message, ['role', 'content', 'tool_call_id','name']);
      textContent(message.content);
      requireShape(typeof message.tool_call_id === 'string'&&pending.has(message.tool_call_id));
      if(message.name!==undefined)requireShape(message.name===pending.get(message.tool_call_id));
      pending.delete(message.tool_call_id);
      continue;
    }
    requireShape(pending.size === 0);
    fields(message, message.role === 'assistant' ? ['role', 'content', 'name', 'tool_calls'] : ['role', 'content', 'name']);
    requireShape(['system', 'developer', 'user', 'assistant'].includes(message.role as string));
    if (message.name !== undefined) requireShape(typeof message.name === 'string' && NAME.test(message.name));
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if(message.content!==null&&message.content!==undefined)textContent(message.content);
      for (const call of calls(message.tool_calls)) {
        requireShape(!seen.has(call.id));
        seen.add(call.id); pending.set(call.id,call.function.name);
      }
    } else if (message.role === 'user'||message.role==='assistant') {
      textContent(message.content);
    } else requireShape(typeof message.content === 'string');
  }
  requireShape(pending.size === 0);
  const names = new Set<string>();
  if (req.tools !== undefined) {
    requireShape(Array.isArray(req.tools) && req.tools.length <= MAX_CHAT_TOOLS);
    for (const tool of req.tools) {
      fields(tool, ['type', 'function']);
      requireShape(tool.type === 'function');
      fields(tool.function, ['name', 'description', 'parameters', 'strict']);
      const fn = tool.function;
      requireShape(typeof fn.name === 'string' && NAME.test(fn.name) && !names.has(fn.name));
      names.add(fn.name);
      if (fn.description !== undefined) requireShape(typeof fn.description === 'string');
      if (fn.strict !== undefined) requireShape(typeof fn.strict === 'boolean');
      requireShape(record(fn.parameters) && fn.parameters.type === 'object');
      schema(fn.parameters, fn.parameters);
    }
  }
  const choice = req.toolChoice;
  if (choice !== undefined) {
    if (typeof choice === 'string') requireShape(['auto', 'none', 'required'].includes(choice) && (choice !== 'required' || names.size > 0));
    else {
      fields(choice, ['type', 'function']); fields(choice.function, ['name']);
      requireShape(choice.type === 'function' && typeof choice.function.name === 'string' && names.has(choice.function.name));
    }
  }
}

/** Normalize only validated root dialect markers, without mutating caller schemas. */
function providerTools(tools: ChatFunctionTool[]): ChatFunctionTool[] {
  return tools.map(tool => {
    const parameters = { ...tool.function.parameters };
    if (parameters.$schema === FUNCTION_SCHEMA_DIALECT) delete parameters.$schema;
    return { ...tool, function: { ...tool.function, parameters } };
  });
}

function usageOf(json: unknown, pricing: PriceTable): { tokens: UsageTokens; cost: number } | null {
  if (!record(json) || !record(json.usage)) return null;
  const u = json.usage;
  const details = u.prompt_tokens_details;
  if (details !== undefined && !record(details)) return null;
  const cached = details?.cached_tokens === undefined ? 0 : details.cached_tokens;
  if (!integer(u.prompt_tokens) || !integer(u.completion_tokens) || !integer(cached) || cached > u.prompt_tokens) return null;
  if (!Number.isSafeInteger(u.prompt_tokens + u.completion_tokens)) return null;
  const tokens = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cachedInputTokens: cached };
  // Even safe token integers can overflow the shared integer pricing arithmetic.
  try { return { tokens, cost: settlementMicro(tokens, pricing) }; } catch { return null; }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('body unavailable');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > MAX_CHAT_RESPONSE_BYTES) throw new Error('body limit');
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CHAT_RESPONSE_BYTES) throw new Error('body limit');
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('aborted');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function answer(json: unknown, req: ChatCompleteInput, safeId: (v: unknown) => string | null): ChatCompletion {
  requireShape(record(json) && safeId(json.id) && safeId(json.model) && json.object === 'chat.completion' && integer(json.created));
  requireShape(Array.isArray(json.choices) && json.choices.length === 1);
  const choice = json.choices[0];
  requireShape(record(choice) && choice.index === 0 && record(choice.message));
  const m = choice.message;
  requireShape(m.role === 'assistant' && !m.refusal && m.audio == null && m.function_call == null
    && (m.content === null || typeof m.content === 'string'));
  const toolCalls = m.tool_calls === undefined ? undefined : calls(m.tool_calls);
  const names = new Set(req.tools?.map(t => t.function.name));
  const historyIds = new Set(req.messages.flatMap(m => m.role === 'assistant' ? m.tool_calls?.map(c => c.id) ?? [] : []));
  if (toolCalls) {
    requireShape(choice.finish_reason === 'tool_calls' && req.toolChoice !== 'none');
    for (const call of toolCalls) requireShape(names.has(call.function.name) && !historyIds.has(call.id)
      && (typeof req.toolChoice !== 'object' || call.function.name === req.toolChoice.function.name));
  } else requireShape(choice.finish_reason === 'stop' && typeof m.content === 'string' && m.content.trim().length > 0
    && req.toolChoice !== 'required' && typeof req.toolChoice !== 'object');
  return {
    id: json.id as string, object: 'chat.completion', created: json.created, model: json.model as string,
    choices: [{ index: 0, message: { role: 'assistant', content: m.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
  };
}

export class LunaChatClient {
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  private readonly apiKey: string;
  private readonly ledger: BudgetLedger;
  private readonly fetchImpl: FetchImpl;
  private readonly extraHeaders: Record<string, string>;
  private readonly local: boolean;
  private readonly pricing: PriceTable;
  private readonly effort: ReasoningEffort | undefined;
  private readonly privateValues: string[];

  constructor(opts: LunaClientOptions) {
    if (!opts?.ledger) throw new TypeError('LunaChatClient requires a BudgetLedger');
    this.apiKey = typeof opts.apiKey === 'string' ? opts.apiKey : '';
    this.model = opts.model ?? DEFAULT_LUNA_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInputBytes = opts.maxInputBytes ?? MAX_CHAT_INPUT_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw new RangeError('invalid timeoutMs');
    if (!Number.isSafeInteger(this.maxInputBytes) || this.maxInputBytes <= 0 || this.maxInputBytes > MAX_CHAT_INPUT_BYTES) throw new RangeError('invalid maxInputBytes');
    if (!IDENTIFIER.test(this.model) || (this.apiKey && this.model.includes(this.apiKey))) throw new TypeError('invalid model');
    let url: URL;
    try { url = new URL(this.baseUrl); } catch { throw new TypeError('invalid baseUrl'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('invalid baseUrl');
    this.ledger = opts.ledger;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.local = opts.local === true;
    if (this.local) assertLocalRoute(opts.baseUrl,opts.model);
    this.pricing = this.local ? LOCAL_API_PRICING : modelPricing(this.model);
    this.effort = this.local ? undefined : reasoningEffort(opts.reasoningEffort,this.model,true);
    this.extraHeaders = providerHeaders(opts,this.baseUrl,this.local);
    this.privateValues = privateValues(this.apiKey,this.extraHeaders);
  }

  /** Neither endpoint configuration, headers nor the key enter serialized client diagnostics. */
  toJSON(): RecordValue { return { model: this.model, timeoutMs: this.timeoutMs, maxInputBytes: this.maxInputBytes, reasoningEffort:this.effort }; }

  async complete(input: ChatCompleteInput): Promise<ChatCompleteResult> {
    if (!this.local && !this.apiKey.trim()) throw new InferenceError('missing_credentials', 'no API key configured for the Luna route');
    let req: ChatCompleteInput;
    let body: string;
    try {
      const copy = snapshot(input, this.maxInputBytes);
      validate(copy); req = copy;
      requireShape(!containsPrivate(JSON.stringify({ purpose: req.purpose, context: req.context }),this.privateValues));
      // Preserve Luna's qualified non-reasoning tool default; Sol low remains provisional until live qualification.
      body = JSON.stringify({
        model: this.model, messages: req.messages.map(message=>message.role==='tool'?{role:message.role,content:message.content,tool_call_id:message.tool_call_id}:message), ...(req.tools !== undefined ? { tools: providerTools(req.tools) } : {}),
        ...(req.toolChoice !== undefined ? { tool_choice: req.toolChoice } : {}),
        ...(this.local ? {max_tokens:req.maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS} : {max_completion_tokens:req.maxOutputTokens??DEFAULT_MAX_OUTPUT_TOKENS,store:false,reasoning_effort:this.effort}),
        n: 1, stream: false,
      });
      if (Buffer.byteLength(body) > this.maxInputBytes) throw new InferenceError('input_too_large', 'chat input exceeds byte limit');
    } catch (err) {
      if (err instanceof InferenceError) throw err;
      throw new InferenceError('invalid_request', 'unsupported or malformed chat request');
    }
    let receipt: Receipt;
    try {
      receipt = this.ledger.reserve({ purpose: req.purpose, context: this.local ? localReceiptContext(req.context) : req.context ?? null, modelRequested: this.model,
        reservedMicro: estimateReservationMicro(Buffer.byteLength(body), req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, this.pricing) });
    } catch (err) {
      const code = err instanceof BudgetCapError ? err.kind === 'requests' ? 'request_cap_exceeded' : 'budget_exceeded' : 'ledger_error';
      throw new InferenceError(code, 'chat request could not reserve project budget');
    }
    const controller = new AbortController();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs);
    });
    const safeId = (v: unknown): string | null => safeProviderId(v,this.privateValues);
    let response: Response | undefined;
    let json: unknown;
    const metadata = () => ({ durationMs: Math.max(0, Math.round(performance.now() - started)),
      httpStatus: response?.status, providerRequestId: safeId(response?.headers.get('x-request-id')) });
    const ledgerWrite = (write: () => Receipt): Receipt => {
      try { return write(); } catch { throw new InferenceError('ledger_error', 'could not record chat outcome; reservation not released', { receiptId: receipt.id }); }
    };
    try {
      response = await Promise.race([this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST', headers: { ...this.extraHeaders, 'content-type': 'application/json', accept: 'application/json', ...(this.apiKey ? {authorization: `Bearer ${this.apiKey}`} : {}) },
        body, signal: controller.signal, redirect: 'error',
      }), deadline]);
      json = await Promise.race([readBounded(response, controller.signal), deadline]);
    } catch {
      const code = controller.signal.aborted ? 'timeout' : response ? 'malformed_response' : 'network_error';
      ledgerWrite(() => this.ledger.markUncertain(receipt.id, { ...metadata(), errorCode: code }));
      throw new InferenceError(code, 'chat attempt failed; reservation retained as uncertain spend', { receiptId: receipt.id, httpStatus: response?.status });
    } finally { clearTimeout(timer!); }

    if (!this.local && record(json) && !matchesRequestedModel(safeId(json.model),this.model)) {
      ledgerWrite(()=>this.ledger.markUncertain(receipt.id,{...metadata(),errorCode:'model_mismatch'}));
      throw new InferenceError('malformed_response','provider model differs from the priced model; reservation retained',{receiptId:receipt.id});
    }
    const usage = usageOf(json,this.pricing);
    let completion: ChatCompletion | undefined;
    let failure: InferenceErrorCode | undefined;
    let reason: string | null = null;
    if (!response.ok) { failure = 'provider_error'; reason = `http_${response.status}`; }
    else {
      const finish = record(json) && Array.isArray(json.choices) && json.choices.length === 1 && record(json.choices[0]) ? json.choices[0].finish_reason : undefined;
      if (finish === 'length') { failure = 'incomplete_response'; reason = 'length'; }
      else if (finish === 'content_filter') { failure = 'malformed_response'; reason = 'content_filter'; }
      else {
        try { completion = answer(json, req, safeId); }
        catch { failure = 'malformed_response'; reason = 'invalid_chat_answer'; }
      }
    }
    const providerError = record(json) && record(json.error) ? json.error : null;
    const providerCode = sanitizeProviderCode(providerError?.code ?? providerError?.type);
    const definitiveRejection = !response.ok && response.status >= 400 && response.status < 500
      && providerCode !== undefined && !containsPrivate(providerCode,this.privateValues);
    const finalReceipt = ledgerWrite(() => usage ? this.ledger.settle(receipt.id, {
      ...metadata(), httpStatus: response.status, settledMicro: usage.cost, ...usage.tokens,
      modelReturned: record(json) ? safeId(json.model) : null, providerResponseId: record(json) ? safeId(json.id) : null, errorCode: reason,
    }) : definitiveRejection && (!record(json) || !Object.hasOwn(json, 'usage'))
      ? this.ledger.release(receipt.id, { ...metadata(), errorCode: reason! })
      : this.ledger.markUncertain(receipt.id, { ...metadata(), errorCode: reason ?? 'usage_missing' }));
    if (failure || !completion) throw new InferenceError(failure ?? 'malformed_response', 'provider did not return a usable chat answer', { receiptId: receipt.id, httpStatus: response.status, chatDiagnostics: chatFailureDiagnostics(json), ...(providerCode && !containsPrivate(providerCode,this.privateValues) ? {providerCode} : {}) });
    if (usage) completion.usage = { prompt_tokens: usage.tokens.inputTokens, completion_tokens: usage.tokens.outputTokens,
      total_tokens: usage.tokens.inputTokens + usage.tokens.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.tokens.cachedInputTokens } };
    return { completion, receipt: finalReceipt };
  }
}
