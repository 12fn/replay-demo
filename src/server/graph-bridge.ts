/**
 * Internal OpenAI-compatible chat bridge for native Graphiti.
 *
 * Exposes a minimal subset of the Chat Completions surface under
 * `/internal/graph/v1` so an in-cluster Graphiti (OpenAIGenericClient) can use
 * REPLAY's authorized Luna route and the project's budget ledger instead of
 * its own key. The ledger stays authoritative; this module adds a smaller
 * bridge-specific request cap on top and never bypasses a ledger denial.
 *
 * Security properties:
 *  - Disabled unless mounted with a strong server-only bearer secret.
 *  - Route auth is independent of the browser session: a bearer is required on
 *    every request (including /models); cookies and session state are ignored.
 *  - Secret comparison is constant time over SHA-256 digests.
 *  - Auth runs before body parsing; unauthenticated bodies are never read.
 *  - Rejects streaming, tools, functions, n > 1, unexpected models, non-text
 *    content parts, unknown roles, messages over 32 KiB and completion token
 *    requests over the bridge cap (4096) or the adapter ceiling, whichever is
 *    lower. All rejections happen before any reservation or network call.
 *  - Single active request; cumulative bridge cap (default 20) counted from
 *    the supplied ledger when available, otherwise from a caller-supplied
 *    counter, otherwise in memory for this process.
 *  - Errors never carry the secret, provider bodies or caller content; only
 *    the adapter's known-safe messages and sanitized provider codes.
 *  - Nothing is logged. `onReceipt` receives a redacted receipt and purpose,
 *    never message content.
 *
 * Mapping notes:
 *  - Leading system/developer messages become Luna `instructions`. Everything
 *    after the first user/assistant message (including later system messages)
 *    is rendered in order into `input` as role-labelled blocks so ordering is
 *    faithful.
 *  - `response_format.json_schema` maps to Luna's strict json_schema shape.
 *    The adapter always requests `strict: true`; a client `strict: false` is
 *    honoured as strict, which is at least as constrained as requested.
 *  - `response_format.json_object` is NOT presented to the provider as a
 *    schema. The instructions ask for a single JSON object and the output is
 *    validated as JSON afterward; invalid output returns 502 with the receipt
 *    id so the paid call stays visible.
 *  - Sampling parameters (temperature, top_p, seed, etc.) are ignored; the
 *    adapter fixes provider settings.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { DEFAULT_LUNA_MODEL, InferenceError, MAX_OUTPUT_TOKENS_CEILING } from "../inference/index.ts";
import { strictGraphSchema } from './strict-schema';
import type { CompleteInput, CompleteResult, JsonSchemaSpec, Receipt } from "../inference/index.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structural view of LunaClient (DeterministicClient also satisfies it). */
export interface GraphLunaLike {
  readonly model?: string;
  complete<T = unknown>(req: CompleteInput): Promise<CompleteResult<T>>;
}

/** Structural view of the project BudgetLedger used only for counting/lookup. */
export interface GraphLedgerLike {
  listReceipts(): Receipt[];
  get(id: string): Receipt | undefined;
}

/** Receipt with no free-form context. Safe to hand to callbacks. */
export type RedactedReceipt = Omit<Receipt, "context">;

export interface GraphBridgeReceiptEvent {
  purpose: string;
  requestId: string;
  outcome: "completed" | "failed";
  httpStatus: number;
  code: string | null;
  receiptId: string | null;
  receipt: RedactedReceipt | null;
  responseFormat: "text" | "json_object" | "json_schema";
}

export interface GraphBridgeOptions {
  /** The application's Luna instance. All calls go through it; no other key or ledger is ever loaded. */
  luna: GraphLunaLike;
  /** Server-only bearer. Must be at least 32 characters when enabled. */
  secret: string | null | undefined;
  /** Optional native workload validator; only a verified, explicitly allowed service identity may pass. */
  authorizeWorkload?: (authorization: string) => Promise<boolean>;
  /** Operator-selected compatibility: cap a caller's requested output at the adapter ceiling. */
  clampRequestedTokens?: boolean;
  /** Defaults to `true` when a secret is supplied. */
  enabled?: boolean;
  /** Redacted receipt + purpose per attempted paid call. */
  onReceipt?: (event: GraphBridgeReceiptEvent) => void;
  /** Ledger purpose recorded on every bridge receipt. */
  purpose?: string;
  /** Cumulative bridge request cap (rows with this purpose). */
  maxGraphRequests?: number;
  /** Bounded FIFO for native Graphiti parallel extraction; default rejects concurrency. */
  maxQueuedRequests?:number;
  /** Persisted counter source. When supplied, counts receipts whose purpose matches. */
  ledger?: GraphLedgerLike;
  /** Alternative counter source; takes precedence over `ledger`. */
  requestCount?: () => number;
  /** Model id advertised on /models and accepted on requests. */
  exposedModel?: string;
  /** Clock override for tests. */
  now?: () => number;
}

export interface GraphBridgeState {
  enabled: boolean;
  active: number;
  maxActiveRequests: number;
  requestsUsed: number;
  maxGraphRequests: number;
  remainingRequests: number;
}

export interface GraphBridge {
  readonly enabled: boolean;
  readonly path: string;
  readonly exposedModel: string;
  readonly purpose: string;
  readonly maxGraphRequests: number;
  readonly maxActiveRequests: number;
  state(): GraphBridgeState;
  toJSON(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRAPH_BRIDGE_PATH = "/internal/graph/v1";
export const GRAPH_MAX_MESSAGE_BYTES = 32 * 1024;
export const GRAPH_MAX_COMPLETION_TOKENS = 4096;
export const GRAPH_DEFAULT_MAX_REQUESTS = 20;
export const GRAPH_DEFAULT_PURPOSE = "graph.bridge";
export const GRAPH_MAX_ACTIVE_REQUESTS = 1;
export const GRAPH_MIN_SECRET_LENGTH = 32;
export const RECEIPT_HEADER = "x-replay-receipt-id";

/** Effective per-request output cap: bridge cap or adapter ceiling, whichever is lower. */
export const GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS = Math.min(GRAPH_MAX_COMPLETION_TOKENS, MAX_OUTPUT_TOKENS_CEILING);

const BODY_LIMIT = "96kb";
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const TRANSCRIPT_ROLES = new Set(["system", "developer", "user", "assistant"]);
const REJECTED_KEYS = ["tools", "tool_choice", "functions", "function_call", "stream_options", "audio", "modalities", "prediction"] as const;
const JSON_OBJECT_DIRECTIVE = "Respond with exactly one valid JSON object and no other text, markdown or code fences.";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type ErrorType = "invalid_request_error" | "authentication_error" | "rate_limit_error" | "server_error" | "not_found_error";

class BridgeError extends Error {
  readonly httpStatus: number;
  readonly type: ErrorType;
  readonly code: string;
  readonly param: string | null;
  readonly retryAfterSeconds: number | null;
  readonly receiptId: string | null;
  readonly providerCode: string | null;
  constructor(
    httpStatus: number,
    type: ErrorType,
    code: string,
    message: string,
    extra: { param?: string | null; retryAfterSeconds?: number | null; receiptId?: string | null; providerCode?: string | null } = {},
  ) {
    super(message);
    this.name = "GraphBridgeError";
    this.httpStatus = httpStatus;
    this.type = type;
    this.code = code;
    this.param = extra.param ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.receiptId = extra.receiptId ?? null;
    this.providerCode = extra.providerCode ?? null;
  }
}

const invalid = (code: string, message: string, param?: string) => new BridgeError(400, "invalid_request_error", code, message, { param });

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountGraphBridge(app: Pick<Application, "use">, opts: GraphBridgeOptions): GraphBridge {
  if (!opts || typeof opts !== "object") throw new TypeError("mountGraphBridge options are required");
  if (!opts.luna || typeof opts.luna.complete !== "function") throw new TypeError("mountGraphBridge requires the application's Luna instance");
  const secret = typeof opts.secret === "string" ? opts.secret : "";
  const enabled = opts.enabled ?? (secret.length > 0 || !!opts.authorizeWorkload);
  if (enabled && secret.length < GRAPH_MIN_SECRET_LENGTH && !opts.authorizeWorkload) {
    throw new TypeError(`graph bridge secret must be at least ${GRAPH_MIN_SECRET_LENGTH} characters when enabled`);
  }
  const purpose = (opts.purpose ?? GRAPH_DEFAULT_PURPOSE).trim();
  if (purpose.length === 0 || purpose.length > 64 || /\s/.test(purpose)) throw new TypeError("graph bridge purpose must be a short token");
  const maxGraphRequests = opts.maxGraphRequests ?? GRAPH_DEFAULT_MAX_REQUESTS;
  if (!Number.isSafeInteger(maxGraphRequests) || maxGraphRequests < 0) throw new RangeError("maxGraphRequests must be a non-negative integer");
  const exposedModel = opts.exposedModel ?? DEFAULT_LUNA_MODEL;
  const now = opts.now ?? (() => Date.now());
  const secretDigest = enabled ? createHash("sha256").update(secret, "utf8").digest() : null;

  // Counting: every attempt that produced a receipt id counts, matching the ledger's own semantics.
  let memoryCount = 0;
  const requestsUsed = (): number => {
    if (opts.requestCount) return Math.max(0, Math.floor(opts.requestCount()));
    if (opts.ledger) return opts.ledger.listReceipts().filter((r) => r.purpose === purpose).length;
    return memoryCount;
  };
  let active = 0;
  const maxQueued=opts.maxQueuedRequests??0;
  if(!Number.isSafeInteger(maxQueued)||maxQueued<0||maxQueued>32)throw new RangeError('Queue bound must be 0..32');
  const queue:{grant:()=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
  const acquire=async()=>{
    if(active<GRAPH_MAX_ACTIVE_REQUESTS){active++;return;}
    if(queue.length>=maxQueued)throw new BridgeError(429,'rate_limit_error','concurrency_limited','Graph extraction queue is full',{retryAfterSeconds:1});
    await new Promise<void>((resolve,reject)=>{
      const entry={grant:()=>{active++;resolve();},reject,timer:setTimeout(()=>{const i=queue.indexOf(entry);if(i>=0)queue.splice(i,1);reject(new BridgeError(429,'rate_limit_error','queue_timeout','Graph extraction queue timed out'));},60000)};
      queue.push(entry);
    });
  };
  const release=()=>{active--;const entry=queue.shift();if(entry){clearTimeout(entry.timer);entry.grant();}};

  const bridge: GraphBridge = {
    enabled,
    path: GRAPH_BRIDGE_PATH,
    exposedModel,
    purpose,
    maxGraphRequests,
    maxActiveRequests: GRAPH_MAX_ACTIVE_REQUESTS,
    state: () => {
      const used = requestsUsed();
      return { enabled, active, maxActiveRequests: GRAPH_MAX_ACTIVE_REQUESTS, requestsUsed: used, maxGraphRequests, remainingRequests: Math.max(0, maxGraphRequests - used) };
    },
    toJSON: () => ({ enabled, path: GRAPH_BRIDGE_PATH, exposedModel, purpose, maxGraphRequests, maxActiveRequests: GRAPH_MAX_ACTIVE_REQUESTS }),
  };

  const router = express.Router();

  // Common headers; this surface is machine-only and never cacheable.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  if (!enabled) {
    router.use((_req, _res, next) => next(new BridgeError(404, "not_found_error", "bridge_disabled", "graph bridge is not configured")));
    router.use(errorHandler);
    app.use(GRAPH_BRIDGE_PATH, router);
    return bridge;
  }

  // 1. Bearer auth, independent of any session cookie, before any body is read.
  router.use(async (req, _res, next) => {
    const header = req.headers.authorization;
    const value = typeof header === "string" ? header : "";
    const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
    if (!match) return next(new BridgeError(401, "authentication_error", "missing_bearer", "bearer token required"));
    const presented = createHash("sha256").update(match[1]!, "utf8").digest();
    const staticAllowed = secret.length >= GRAPH_MIN_SECRET_LENGTH && timingSafeEqual(presented, secretDigest!);
    let nativeAllowed = false;
    if (!staticAllowed && opts.authorizeWorkload && value.length <= 16384) {
      try { nativeAllowed = (await opts.authorizeWorkload(value)) === true; } catch { nativeAllowed = false; }
    }
    if (!staticAllowed && !nativeAllowed) return next(new BridgeError(401, "authentication_error", "invalid_bearer", "bearer token rejected"));
    next();
  });

  // 2. Body parsing with a local limit (a no-op when an upstream parser already ran).
  router.use(express.json({ limit: BODY_LIMIT, strict: true }));

  router.get("/models", (_req, res) => {
    res.json({ object: "list", data: [{ id: exposedModel, object: "model", created: Math.floor(now() / 1000), owned_by: "replay" }] });
  });

  router.get("/models/:id", (req, res, next) => {
    if (req.params.id !== exposedModel) return next(new BridgeError(404, "not_found_error", "model_not_found", "model not exposed by this bridge"));
    res.json({ id: exposedModel, object: "model", created: Math.floor(now() / 1000), owned_by: "replay" });
  });

  router.post("/chat/completions", async (req, res, next) => {
    const requestId = randomUUID();
    let mapped: MappedRequest;
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : req.body;
      if (opts.clampRequestedTokens && body && !Array.isArray(body)) {
        for (const key of ['max_tokens', 'max_completion_tokens']) {
          if (Number.isSafeInteger(body[key]) && body[key] > GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS) body[key] = GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS;
        }
        res.setHeader('x-replay-output-token-cap', String(GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS));
      }
      mapped = mapChatRequest(body, exposedModel);
    } catch (err) {
      return next(err);
    }

    // 3. Caps, checked before any reservation.
    try{await acquire();}catch(e){return next(e);}
    if(res.destroyed){release();return;}
    const used = requestsUsed();
    if (used >= maxGraphRequests) {
      release();
      return next(new BridgeError(429, "rate_limit_error", "graph_request_cap", `graph bridge request cap reached (${used}/${maxGraphRequests})`));
    }

    const started = now();
    let result: CompleteResult | null = null;
    let failure: BridgeError | null = null;
    try {
      result = await opts.luna.complete({
        purpose,
        instructions: mapped.instructions,
        input: mapped.input,
        context: { bridge: "graph", requestId, messages: mapped.messageCount, responseFormat: mapped.responseFormat, schemaName: mapped.jsonSchema?.name ?? null },
        ...(mapped.maxOutputTokens !== undefined ? { maxOutputTokens: mapped.maxOutputTokens } : {}),
        ...(mapped.jsonSchema ? { jsonSchema: mapped.jsonSchema } : {}),
      });
    } catch (err) {
      failure = fromInferenceError(err);
    } finally {
      release();
    }

    const receiptId = result?.receipt.id ?? failure?.receiptId ?? null;
    if (receiptId !== null) memoryCount += 1;

    if (failure) {
      emit(opts.onReceipt, { purpose, requestId, outcome: "failed", httpStatus: failure.httpStatus, code: failure.code, receiptId, receipt: lookupReceipt(opts.ledger, receiptId), responseFormat: mapped.responseFormat });
      return next(failure);
    }

    const { text, receipt } = result!;
    if (mapped.responseFormat === "json_object" && !isValidJson(text)) {
      const err = new BridgeError(502, "server_error", "invalid_json_output", "model output was not valid JSON although a JSON object was requested", { receiptId: receipt.id });
      emit(opts.onReceipt, { purpose, requestId, outcome: "failed", httpStatus: 502, code: err.code, receiptId: receipt.id, receipt: redactReceipt(receipt), responseFormat: mapped.responseFormat });
      return next(err);
    }

    const body = completionBody({ receipt, text, exposedModel, createdMs: started });
    emit(opts.onReceipt, { purpose, requestId, outcome: "completed", httpStatus: 200, code: null, receiptId: receipt.id, receipt: redactReceipt(receipt), responseFormat: mapped.responseFormat });
    res.setHeader(RECEIPT_HEADER, receipt.id);
    res.status(200).json(body);
  });

  router.use((_req, _res, next) => next(new BridgeError(404, "not_found_error", "not_found", "no such graph bridge route")));
  router.use(errorHandler);
  app.use(GRAPH_BRIDGE_PATH, router);
  return bridge;
}

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

interface MappedRequest {
  instructions: string;
  input: string;
  messageCount: number;
  maxOutputTokens: number | undefined;
  responseFormat: "text" | "json_object" | "json_schema";
  jsonSchema: JsonSchemaSpec | undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Validate and translate a Chat Completions body. Throws BridgeError; performs no I/O. */
export function mapChatRequest(rawBody: unknown, exposedModel: string): MappedRequest {
  const body = asRecord(rawBody);
  if (!body) throw invalid("invalid_body", "request body must be a JSON object");

  if (body.model !== exposedModel) throw invalid("model_not_supported", `model must be ${JSON.stringify(exposedModel)}`, "model");
  if (body.stream === true) throw invalid("stream_not_supported", "streaming is not supported by the graph bridge", "stream");
  for (const key of REJECTED_KEYS) {
    if (body[key] !== undefined && body[key] !== null) throw invalid("unsupported_parameter", `${key} is not supported by the graph bridge`, key);
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw invalid("multiple_choices_not_supported", "n must be 1", "n");

  const maxOutputTokens = readMaxTokens(body);

  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid("messages_required", "messages must be a non-empty array", "messages");
  const messages = body.messages.map((m, i) => readMessage(m, i));

  const { responseFormat, jsonSchema } = readResponseFormat(body.response_format);

  const schemaBytes = jsonSchema ? Buffer.byteLength(JSON.stringify(jsonSchema.schema), "utf8") : 0;
  const messageBytes = messages.reduce((n, m) => n + Buffer.byteLength(m.content, "utf8"), 0);
  if (messageBytes + schemaBytes > GRAPH_MAX_MESSAGE_BYTES) {
    throw invalid("messages_too_large", `messages and schema total ${messageBytes + schemaBytes} bytes; limit is ${GRAPH_MAX_MESSAGE_BYTES} bytes`, "messages");
  }

  // Leading instruction-role messages become instructions; the rest is an ordered transcript.
  const instructionParts: string[] = [];
  let i = 0;
  while (i < messages.length && INSTRUCTION_ROLES.has(messages[i]!.role)) {
    instructionParts.push(messages[i]!.content);
    i += 1;
  }
  const transcript = messages.slice(i);
  if (responseFormat === "json_object") instructionParts.push(JSON_OBJECT_DIRECTIVE);
  const instructions = instructionParts.join("\n\n");
  const input = transcript.length === 0 ? "" : transcript.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");

  return { instructions, input, messageCount: messages.length, maxOutputTokens, responseFormat, jsonSchema };
}

function readMaxTokens(body: Record<string, unknown>): number | undefined {
  const source = body.max_completion_tokens !== undefined && body.max_completion_tokens !== null ? "max_completion_tokens" : body.max_tokens !== undefined && body.max_tokens !== null ? "max_tokens" : null;
  if (source === null) return undefined;
  const value = body[source];
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw invalid("invalid_max_tokens", `${source} must be a positive integer`, source);
  if ((value as number) > GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS) {
    throw invalid("max_tokens_exceeded", `${source} exceeds the graph bridge cap of ${GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS}`, source);
  }
  return value as number;
}

function readMessage(raw: unknown, index: number): { role: string; content: string } {
  const param = `messages[${index}]`;
  const m = asRecord(raw);
  if (!m) throw invalid("invalid_message", `${param} must be an object`, param);
  const role = m.role;
  if (typeof role !== "string" || !TRANSCRIPT_ROLES.has(role)) throw invalid("unsupported_role", `${param}.role must be system, developer, user or assistant`, `${param}.role`);
  for (const key of ["tool_calls", "function_call", "tool_call_id", "refusal", "audio"]) {
    if (m[key] !== undefined && m[key] !== null) throw invalid("unsupported_parameter", `${param}.${key} is not supported by the graph bridge`, `${param}.${key}`);
  }
  const content = m.content;
  if (typeof content === "string") return { role, content };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    content.forEach((part, j) => {
      const p = asRecord(part);
      if (!p || p.type !== "text" || typeof p.text !== "string") {
        throw invalid("unsupported_content", `${param}.content[${j}] must be a text part`, `${param}.content[${j}]`);
      }
      parts.push(p.text);
    });
    return { role, content: parts.join("\n") };
  }
  throw invalid("invalid_content", `${param}.content must be a string or an array of text parts`, `${param}.content`);
}

function readResponseFormat(raw: unknown): { responseFormat: MappedRequest["responseFormat"]; jsonSchema: JsonSchemaSpec | undefined } {
  if (raw === undefined || raw === null) return { responseFormat: "text", jsonSchema: undefined };
  const rf = asRecord(raw);
  if (!rf || typeof rf.type !== "string") throw invalid("invalid_response_format", "response_format must be an object with a type", "response_format");
  switch (rf.type) {
    case "text":
      return { responseFormat: "text", jsonSchema: undefined };
    case "json_object":
      return { responseFormat: "json_object", jsonSchema: undefined };
    case "json_schema": {
      const js = asRecord(rf.json_schema);
      if (!js) throw invalid("invalid_response_format", "response_format.json_schema is required", "response_format.json_schema");
      if (typeof js.name !== "string" || !SCHEMA_NAME.test(js.name)) {
        throw invalid("invalid_response_format", "response_format.json_schema.name must match [A-Za-z0-9_-]{1,64}", "response_format.json_schema.name");
      }
      const schema = asRecord(js.schema);
      if (!schema) throw invalid("invalid_response_format", "response_format.json_schema.schema must be an object", "response_format.json_schema.schema");
      let strict:Record<string,unknown>;
      try{strict=strictGraphSchema(schema);}catch{throw invalid('invalid_response_format','Graph schema cannot be mapped to the strict typed object contract','response_format.json_schema.schema');}
      const spec: JsonSchemaSpec = { name: js.name, schema:strict };
      if (typeof js.description === "string" && js.description.length > 0) spec.description = js.description.slice(0, 512);
      return { responseFormat: "json_schema", jsonSchema: spec };
    }
    default:
      throw invalid("invalid_response_format", "response_format.type must be text, json_object or json_schema", "response_format.type");
  }
}

// ---------------------------------------------------------------------------
// Responses and errors
// ---------------------------------------------------------------------------

function completionBody(args: { receipt: Receipt; text: string; exposedModel: string; createdMs: number }): Record<string, unknown> {
  const { receipt, text, exposedModel, createdMs } = args;
  const promptTokens = receipt.inputTokens ?? 0;
  const completionTokens = receipt.outputTokens ?? 0;
  return {
    id: `chatcmpl-${receipt.id}`,
    object: "chat.completion",
    created: Math.floor(createdMs / 1000),
    model: exposedModel,
    choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null }, logprobs: null, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: receipt.cachedInputTokens ?? 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    system_fingerprint: null,
    replay: {
      receipt_id: receipt.id,
      receipt_status: receipt.status,
      model_returned: receipt.modelReturned,
      usage_known: receipt.inputTokens !== null && receipt.outputTokens !== null,
    },
  };
}

function fromInferenceError(err: unknown): BridgeError {
  if (err instanceof InferenceError) {
    const extra = { receiptId: err.receiptId ?? null, providerCode: err.providerCode ?? null };
    switch (err.code) {
      case "invalid_request":
      case "input_too_large":
        return new BridgeError(400, "invalid_request_error", err.code, err.message, extra);
      case "missing_credentials":
        return new BridgeError(503, "server_error", err.code, "graph bridge has no inference credentials configured", extra);
      case "budget_exceeded":
      case "request_cap_exceeded":
        return new BridgeError(429, "rate_limit_error", err.code, err.message, extra);
      case "timeout":
        return new BridgeError(504, "server_error", err.code, err.message, extra);
      case "network_error":
      case "provider_error":
      case "malformed_response":
        return new BridgeError(502, "server_error", err.code, err.message, extra);
      case "ledger_error":
      default:
        return new BridgeError(500, "server_error", err.code, "inference ledger error", extra);
    }
  }
  // Unknown failure: give away nothing about it.
  return new BridgeError(500, "server_error", "internal_error", "graph bridge internal error");
}

function isBodyParserError(err: unknown): err is Error & { status?: number; statusCode?: number; type?: string } {
  const e = err as { type?: unknown; status?: unknown };
  return err instanceof Error && typeof e.type === "string" && typeof e.status === "number";
}

const errorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  let e: BridgeError;
  if (err instanceof BridgeError) e = err;
  else if (isBodyParserError(err)) {
    if (err.status === 413) e = new BridgeError(413, "invalid_request_error", "request_too_large", "request body exceeds the graph bridge limit");
    else if (err.status === 415) e = new BridgeError(415, "invalid_request_error", "unsupported_media_type", "request body must be UTF-8 JSON without content encoding");
    else e = new BridgeError(400, "invalid_request_error", "invalid_json_body", "request body must be valid JSON");
  } else e = new BridgeError(500, "server_error", "internal_error", "graph bridge internal error");

  if (e.httpStatus === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="replay-graph-bridge"');
  if (e.retryAfterSeconds !== null) res.setHeader("Retry-After", String(e.retryAfterSeconds));
  if (e.receiptId) res.setHeader(RECEIPT_HEADER, e.receiptId);
  res.status(e.httpStatus).json({
    error: {
      message: e.message,
      type: e.type,
      code: e.code,
      param: e.param,
      ...(e.providerCode ? { provider_code: e.providerCode } : {}),
      ...(e.receiptId ? { receipt_id: e.receiptId } : {}),
    },
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function redactReceipt(r: Receipt): RedactedReceipt {
  return {
    id: r.id,
    status: r.status,
    purpose: r.purpose,
    modelRequested: r.modelRequested,
    modelReturned: r.modelReturned,
    providerResponseId: r.providerResponseId,
    providerRequestId: r.providerRequestId,
    reservedMicro: r.reservedMicro,
    settledMicro: r.settledMicro,
    inputTokens: r.inputTokens,
    cachedInputTokens: r.cachedInputTokens,
    outputTokens: r.outputTokens,
    durationMs: r.durationMs,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function lookupReceipt(ledger: GraphLedgerLike | undefined, id: string | null): RedactedReceipt | null {
  if (!ledger || !id) return null;
  try {
    const r = ledger.get(id);
    return r ? redactReceipt(r) : null;
  } catch {
    return null;
  }
}

function emit(cb: GraphBridgeOptions["onReceipt"], event: GraphBridgeReceiptEvent): void {
  if (!cb) return;
  try {
    cb(event);
  } catch {
    /* callbacks must not affect the response */
  }
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
