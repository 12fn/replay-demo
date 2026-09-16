import type { ChatFailureDiagnostics } from './chat-failure-diagnostics';
import type { OutputDiagnostics } from "./diagnostics.ts";

export type InferenceErrorCode =
  | "missing_credentials"
  | "input_too_large"
  | "invalid_request"
  | "budget_exceeded"
  | "request_cap_exceeded"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "malformed_response"
  | "incomplete_response"
  | "ledger_error";

/**
 * Error surfaced by the inference layer. Messages are constructed from
 * short, known-safe fragments: they never include credentials, raw provider
 * bodies or caller input.
 */
export class InferenceError extends Error {
  readonly code: InferenceErrorCode;
  /** HTTP status from the provider, if a response was received. */
  readonly httpStatus?: number;
  /** Ledger receipt id if a reservation was made before the failure. */
  readonly receiptId?: string;
  /** Provider-supplied short error type/code (sanitized, truncated). */
  readonly providerCode?: string;
  /** Text-free summary of the provider output shape (counts and enumerated classes only). */
  readonly diagnostics?: OutputDiagnostics;
  readonly chatDiagnostics?: ChatFailureDiagnostics;

  constructor(
    code: InferenceErrorCode,
    message: string,
    opts: { httpStatus?: number; receiptId?: string; providerCode?: string; diagnostics?: OutputDiagnostics; chatDiagnostics?: ChatFailureDiagnostics; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "InferenceError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.receiptId = opts.receiptId;
    this.providerCode = opts.providerCode;
    this.diagnostics = opts.diagnostics;
    this.chatDiagnostics = opts.chatDiagnostics;
  }
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Keep only short identifier-like strings from provider error metadata. */
export function sanitizeProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SAFE_TOKEN.test(trimmed) ? trimmed : undefined;
}
