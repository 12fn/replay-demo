/**
 * Error type and redaction helpers for the native Kamiwaza adapter.
 *
 * Errors carry a stable machine code plus a short, redacted detail. They never
 * carry request or response headers, bearer tokens, passwords or raw bodies.
 */

export type KamiwazaErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "forged_header"
  | "missing_credentials"
  | "session_required"
  | "auth_denied"
  | "auth_error"
  | "missing_signature"
  | "timeout"
  | "network_error"
  | "malformed_response"
  | "http_error";

export interface KamiwazaErrorInit {
  httpStatus?: number;
  /** `METHOD /path` of the request that failed, when one was attempted. */
  target?: string;
  /** Platform `x-request-id`, when the response carried one. */
  requestId?: string | null;
  /** Redacted, truncated platform `detail`, when one was returned. */
  detail?: string;
  cause?: unknown;
}

export class KamiwazaError extends Error {
  readonly code: KamiwazaErrorCode;
  readonly httpStatus?: number;
  readonly target?: string;
  readonly requestId: string | null;
  readonly detail?: string;

  constructor(code: KamiwazaErrorCode, message: string, init: KamiwazaErrorInit = {}) {
    // The cause is intentionally not attached: it may carry a token in its message.
    super(message);
    this.name = "KamiwazaError";
    this.code = code;
    this.httpStatus = init.httpStatus;
    this.target = init.target;
    this.requestId = init.requestId ?? null;
    this.detail = init.detail;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      target: this.target,
      requestId: this.requestId,
      detail: this.detail,
    };
  }
}

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const MIN_SECRET_LENGTH = 6;
export const MAX_DETAIL_LENGTH = 240;

/**
 * Remove known secrets and anything that looks like a bearer token or JWT.
 * Known secrets are replaced first so that partial patterns cannot leak them.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(BEARER_PATTERN, "Bearer [redacted]");
  out = out.replace(JWT_PATTERN, "[redacted-jwt]");
  return out;
}

/**
 * Extract a short human-readable detail from a FastAPI error body
 * (`{"detail": "..."}` or `{"detail": [ValidationError...]}`), redacted and truncated.
 * Returns undefined when the body has no usable detail.
 */
export function extractErrorDetail(body: unknown, secrets: readonly (string | null | undefined)[]): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const detail = (body as Record<string, unknown>).detail;
  let text: string | undefined;
  if (typeof detail === "string") {
    text = detail;
  } else if (Array.isArray(detail)) {
    const parts: string[] = [];
    for (const item of detail) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).msg === "string") {
        const loc = Array.isArray((item as Record<string, unknown>).loc)
          ? ((item as Record<string, unknown>).loc as unknown[]).map(String).join(".")
          : "";
        parts.push(loc ? `${loc}: ${(item as Record<string, unknown>).msg}` : String((item as Record<string, unknown>).msg));
      }
    }
    if (parts.length) text = parts.join("; ");
  } else if (detail && typeof detail === "object") {
    const msg = (detail as Record<string, unknown>).message ?? (detail as Record<string, unknown>).msg;
    if (typeof msg === "string") text = msg;
  }
  if (text === undefined) return undefined;
  const redacted = redactSecrets(text, secrets);
  return redacted.length > MAX_DETAIL_LENGTH ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…` : redacted;
}
