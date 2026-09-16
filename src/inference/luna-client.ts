/**
 * Bounded Luna adapter over the OpenAI Responses API using built-in fetch.
 *
 * Guarantees:
 *  - No network call without a successful ledger reservation first.
 *  - Empty credentials are rejected before any reservation.
 *  - Input is capped in UTF-8 bytes; max_output_tokens is capped.
 *  - No automatic retries: an uncertain outcome (timeout, network error,
 *    missing usage) keeps its reservation as spent until reconciled.
 *  - Errors never carry the API key, raw provider bodies or caller input.
 *  - No built-in paid tools are requested; `store` is false.
 *  - Nothing happens at import time or on construction.
 */
import { InferenceError, sanitizeProviderCode, type InferenceErrorCode } from "./errors.ts";
import { classifyText, describeDiagnostics, summarizeOutput, type OutputDiagnostics } from "./diagnostics.ts";
import { selectOutputText } from "./response-text.ts";
import { BudgetCapError, type BudgetLedger, type Receipt } from "./ledger.ts";
import { assertLocalRoute, chatAsResponses, LOCAL_API_PRICING, localReceiptContext } from './local-route';
import {
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_CEILING,
  estimateReservationMicro,
  settlementMicro,
} from "./pricing.ts";

export const DEFAULT_LUNA_MODEL = "gpt-5.6-luna";
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface LunaClientOptions {
  apiKey: string;
  /** Provider-compatible base URL (OpenAI or a Kamiwaza-bound endpoint). */
  baseUrl?: string;
  model?: string;
  ledger: BudgetLedger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxInputBytes?: number;
  /** Extra headers (e.g. Kamiwaza deployment routing). Must not carry secrets from callers' context. */
  extraHeaders?: Record<string, string>;
  /** Explicit native local Chat Completions route; never falls back to the paid API. */
  local?: boolean;
}

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
  description?: string;
}

export interface CompleteInput {
  instructions: string;
  input: string;
  purpose: string;
  context?: Record<string, unknown>;
  maxOutputTokens?: number;
  jsonSchema?: JsonSchemaSpec;
}

export interface CompleteResult<T = unknown> {
  text: string;
  parsed?: T;
  receipt: Receipt;
  /** Text-free shape summary of the provider output (absent for synthetic clients). */
  diagnostics?: OutputDiagnostics;
}

interface ProviderUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class LunaClient {
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  private readonly apiKey: string;
  private readonly ledger: BudgetLedger;
  private readonly fetchImpl: FetchImpl;
  private readonly extraHeaders: Record<string, string>;
  private readonly local: boolean;

  constructor(opts: LunaClientOptions) {
    if (!opts || typeof opts !== "object") throw new TypeError("LunaClient options are required");
    if (!opts.ledger) throw new TypeError("LunaClient requires a BudgetLedger");
    this.apiKey = typeof opts.apiKey === "string" ? opts.apiKey : "";
    this.ledger = opts.ledger;
    this.model = opts.model ?? DEFAULT_LUNA_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxInputBytes = opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.extraHeaders = { ...(opts.extraHeaders ?? {}) };
    this.local = opts.local === true;
    if (this.local) assertLocalRoute(opts.baseUrl, opts.model);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError("timeoutMs must be > 0");
  }

  /** Never serialize the key. */
  toJSON(): Record<string, unknown> {
    return { model: this.model, baseUrl: this.baseUrl, timeoutMs: this.timeoutMs };
  }

  async complete<T = unknown>(req: CompleteInput): Promise<CompleteResult<T>> {
    // 1. Credentials and request validation happen before any reservation.
    if (!this.local && this.apiKey.trim().length === 0) {
      throw new InferenceError("missing_credentials", "no API key configured for the Luna route");
    }
    if (typeof req.purpose !== "string" || req.purpose.trim().length === 0) {
      throw new InferenceError("invalid_request", "purpose is required");
    }
    if (typeof req.instructions !== "string" || typeof req.input !== "string") {
      throw new InferenceError("invalid_request", "instructions and input must be strings");
    }
    const maxOutputTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS_CEILING) {
      throw new InferenceError(
        "invalid_request",
        `maxOutputTokens must be an integer in [1, ${MAX_OUTPUT_TOKENS_CEILING}]`,
      );
    }
    if (req.jsonSchema) {
      if (!SCHEMA_NAME.test(req.jsonSchema.name ?? "")) {
        throw new InferenceError("invalid_request", "jsonSchema.name must match [A-Za-z0-9_-]{1,64}");
      }
      if (!req.jsonSchema.schema || typeof req.jsonSchema.schema !== "object") {
        throw new InferenceError("invalid_request", "jsonSchema.schema must be an object");
      }
    }

    const schemaJson = req.jsonSchema ? JSON.stringify(req.jsonSchema.schema) : "";
    const inputBytes =
      Buffer.byteLength(req.instructions, "utf8") + Buffer.byteLength(req.input, "utf8") + Buffer.byteLength(schemaJson, "utf8");
    if (inputBytes > this.maxInputBytes) {
      throw new InferenceError(
        "input_too_large",
        `input is ${inputBytes} bytes; limit is ${this.maxInputBytes} bytes`,
      );
    }

    // Refuse to persist metadata that contains the credential.
    const contextJson = req.context === undefined ? "" : JSON.stringify(req.context);
    if (this.apiKey.length >= 8 && (contextJson.includes(this.apiKey) || req.purpose.includes(this.apiKey))) {
      throw new InferenceError("invalid_request", "purpose/context must not contain the API key");
    }

    // 2. Reserve an upper bound before touching the network.
    let receipt: Receipt;
    try {
      receipt = this.ledger.reserve({
        purpose: req.purpose,
        context: this.local ? localReceiptContext(req.context) : req.context ?? null,
        modelRequested: this.model,
        reservedMicro: estimateReservationMicro(inputBytes, maxOutputTokens, this.local ? LOCAL_API_PRICING : undefined),
      });
    } catch (err) {
      if (err instanceof BudgetCapError) {
        throw new InferenceError(err.kind === "requests" ? "request_cap_exceeded" : "budget_exceeded", err.message, {
          cause: err,
        });
      }
      throw new InferenceError("ledger_error", "could not record reservation", { cause: err });
    }

    // 3. Build the Responses API request.
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: req.instructions,
      input: req.input,
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: "low" },
      store: false,
    };
    if (req.jsonSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: req.jsonSchema.name,
          schema: req.jsonSchema.schema,
          strict: true,
          ...(req.jsonSchema.description ? { description: req.jsonSchema.description } : {}),
        },
      };
    }

    const wireBody = this.local ? {
      model:this.model,messages:[{role:'system',content:req.instructions},{role:'user',content:req.input}],
      max_tokens:maxOutputTokens,n:1,stream:false,
      ...(req.jsonSchema?{response_format:{type:'json_schema',json_schema:{name:req.jsonSchema.name,schema:req.jsonSchema.schema,strict:true}}}:{}),
    } : body;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));

    // 4. Single attempt. No retries.
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${this.local ? 'chat/completions' : 'responses'}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.apiKey ? {authorization: `Bearer ${this.apiKey}`} : {}),
          ...this.extraHeaders,
        },
        body: JSON.stringify(wireBody),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      const code = timedOut ? "timeout" : "network_error";
      this.ledger.markUncertain(receipt.id, { durationMs: elapsed(), errorCode: code });
      throw new InferenceError(
        code,
        timedOut
          ? `request exceeded ${this.timeoutMs} ms; reservation retained as uncertain spend`
          : "network error before a response was received; reservation retained as uncertain spend",
        { receiptId: receipt.id },
      );
    }

    const providerRequestId = response.headers.get("x-request-id");
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      clearTimeout(timer);
      const code = controller.signal.aborted ? "timeout" : "malformed_response";
      this.ledger.markUncertain(receipt.id, {
        durationMs: elapsed(),
        httpStatus: response.status,
        errorCode: code,
        providerRequestId,
      });
      throw new InferenceError(code, `provider returned an unreadable body (HTTP ${response.status})`, {
        httpStatus: response.status,
        receiptId: receipt.id,
      });
    }
    clearTimeout(timer);

    if (response.ok && this.local) json = chatAsResponses(json);

    if (!response.ok) {
      const providerCode = extractProviderCode(json);
      const durationMs = elapsed();
      if (response.status >= 400 && response.status < 500 && providerCode !== undefined) {
        // Definitive rejection from the provider: nothing was billed.
        this.ledger.release(receipt.id, { durationMs, httpStatus: response.status, errorCode: `http_${response.status}`, providerRequestId });
      } else {
        this.ledger.markUncertain(receipt.id, { durationMs, httpStatus: response.status, errorCode: `http_${response.status}`, providerRequestId });
      }
      throw new InferenceError("provider_error", `provider responded with HTTP ${response.status}`, {
        httpStatus: response.status,
        receiptId: receipt.id,
        providerCode,
      });
    }

    // 5. Extract text and usage, and classify the output shape before settling so the
    //    receipt (the only artifact that outlives the call) records why an answer was unusable.
    const selection = selectOutputText(json);
    const text = selection.text;
    const usage = extractUsage(json);
    const modelReturned = typeof (json as Record<string, unknown>)?.model === "string" ? String((json as Record<string, unknown>).model) : null;
    const providerResponseId = typeof (json as Record<string, unknown>)?.id === "string" ? String((json as Record<string, unknown>).id) : null;
    const durationMs = elapsed();
    const diagnostics = summarizeOutput(json, text, usage?.outputTokens ?? null, selection.diagnostics);
    const failure = classifyFailure(diagnostics, req.jsonSchema !== undefined);

    let finalReceipt: Receipt;
    if (usage === null) {
      finalReceipt = this.ledger.markUncertain(receipt.id, {
        durationMs,
        httpStatus: response.status,
        errorCode: "usage_missing",
        providerRequestId,
      });
    } else {
      finalReceipt = this.ledger.settle(receipt.id, {
        settledMicro: settlementMicro(usage, this.local ? LOCAL_API_PRICING : undefined),
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        modelReturned,
        providerResponseId,
        providerRequestId,
        durationMs,
        httpStatus: response.status,
        errorCode: failure?.receiptCode ?? null,
      });
    }

    if (failure) {
      throw new InferenceError(failure.code, `${failure.message} [${describeDiagnostics(diagnostics)}]`, {
        httpStatus: response.status,
        receiptId: receipt.id,
        providerCode: failure.providerCode,
        diagnostics,
      });
    }

    const result: CompleteResult<T> = { text: text as string, receipt: finalReceipt, diagnostics };
    if (req.jsonSchema) result.parsed = classifyText(text as string).parsed as T;
    return result;
  }
}

interface OutputFailure {
  code: InferenceErrorCode;
  message: string;
  /** Short token stored on the settled receipt's `errorCode`. */
  receiptCode: string;
  providerCode?: string;
}

/**
 * Decide, from the text-free diagnostics alone, whether the billed answer is usable.
 * Order matters: an incomplete or refused response explains any odd text after it.
 */
function classifyFailure(d: OutputDiagnostics, structured: boolean): OutputFailure | null {
  if(d.providerStatus&&['failed','cancelled','in_progress','queued'].includes(d.providerStatus))return {code:'incomplete_response',message:'provider did not return a completed answer',receiptCode:`response_status:${d.providerStatus}`,providerCode:d.providerStatus};
  if (d.providerStatus === "incomplete") {
    const reason = d.incompleteReason ?? undefined;
    return {
      code: "incomplete_response",
      message: `provider stopped before completing the answer${reason ? ` (${reason})` : ""}`,
      receiptCode: `incomplete_response:${reason ?? "unknown"}`,
      providerCode: reason,
    };
  }
  if (d.refusal) {
    return { code: "malformed_response", message: "provider returned a refusal instead of output", receiptCode: "refusal", providerCode: "refusal" };
  }
  if (d.selection?.failure) {
    return { code: "malformed_response", message: "provider answer selection failed", receiptCode: `answer_selection:${d.selection.failure}` };
  }
  if (d.textShape === "empty") {
    return { code: "malformed_response", message: "provider response contained empty output text", receiptCode: "empty_output_text" };
  }
  if (d.textShape === "none") {
    return { code: "malformed_response", message: "provider response contained no output text", receiptCode: "no_output_text" };
  }
  if (structured && d.textShape !== "json_object" && d.textShape !== "json_array" && d.textShape !== "json_scalar") {
    return { code: "malformed_response", message: "structured output was not valid JSON", receiptCode: `malformed_output:${d.textShape}` };
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractProviderCode(json: unknown): string | undefined {
  const err = asRecord(asRecord(json)?.error);
  if (!err) return undefined;
  return sanitizeProviderCode(err.code) ?? sanitizeProviderCode(err.type);
}

function extractUsage(json: unknown): ProviderUsage | null {
  const usage = asRecord(asRecord(json)?.usage);
  if (!usage) return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return null;
  const details = asRecord(usage.input_tokens_details);
  const cachedRaw = details?.cached_tokens;
  const cached = Number.isSafeInteger(cachedRaw) ? (cachedRaw as number) : 0;
  return { inputTokens: input as number, cachedInputTokens: cached, outputTokens: output as number };
}
