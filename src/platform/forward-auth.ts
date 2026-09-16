/**
 * Native ForwardAuth handling for the strict-auth Kamiwaza installation.
 *
 * Before each protected request the adapter calls `GET /auth/forward/validate`
 * exactly as the ingress gateway would. On 200 the platform answers with signed
 * identity headers. This module:
 *
 *  - builds the validate request headers,
 *  - copies only the documented allowlist of signed identity headers, unchanged,
 *  - derives the public (non-secret) identity fields from them,
 *  - refuses caller-supplied headers that would impersonate the gateway.
 *
 * Nothing here manufactures identity or signatures. If the platform does not
 * return a signature, the caller's target request must not be sent.
 */
import { KamiwazaError } from "./errors.ts";

/**
 * Signed identity headers returned by `GET /auth/forward/validate` that are
 * forwarded to the target request. Names are lower-case because `Headers`
 * normalizes them; values are copied byte-for-byte.
 *
 * Any other `x-*` header the platform returns is deliberately dropped.
 */
export const SIGNED_IDENTITY_HEADERS = [
  "x-user-id",
  "x-user-name",
  "x-user-email",
  "x-user-preferred-username",
  "x-user-groups",
  "x-user-attributes-hash",
  "x-user-system-high",
  "x-auth-azp",
  "x-user-workroom-id",
  "x-requested-workroom-scope",
  "x-verified-workroom-scope",
  "x-protected-action-type",
  "x-visibility-scope",
  "x-authz-outcome",
  "x-authz-reason-class",
  "x-user-roles",
  "x-workroom-id",
  "x-user-workroom-role",
  "x-user-signature",
  "x-user-signature-stable",
  "x-user-signature-ts",
  "x-auth-token",
] as const;

export type SignedIdentityHeader = (typeof SIGNED_IDENTITY_HEADERS)[number];

/** Headers whose values are secrets and must never surface in public identity or errors. */
export const SECRET_IDENTITY_HEADERS: readonly SignedIdentityHeader[] = [
  "x-user-signature",
  "x-user-signature-stable",
  "x-auth-token",
];

/** Headers that must be present for a validate response to count as signed identity. */
export const REQUIRED_IDENTITY_HEADERS: readonly SignedIdentityHeader[] = ["x-user-id", "x-user-signature"];

/** Header names the caller is never allowed to set on a request. */
const RESERVED_HEADER_PREFIXES = ["x-forwarded-", "x-user-", "x-auth-"] as const;
const RESERVED_HEADER_NAMES = new Set<string>(["authorization", "x-workroom-id", "host", "cookie", ...SIGNED_IDENTITY_HEADERS]);

/** Public, non-secret fields of the platform-verified identity. */
export interface VerifiedIdentity {
  userId: string;
  userName: string | null;
  roles: string[];
  /** Signed workroom scope as returned by the platform. Null when the platform returned none. */
  workroomId: string | null;
  workroomRole: string | null;
}

export interface ForwardAuthResult {
  identity: VerifiedIdentity;
  /** Signature timestamp as returned by the platform (not a secret). */
  signatureTs: string | null;
  /** Allowlisted headers, copied unchanged, ready to attach to the target request. */
  forwardHeaders: Readonly<Record<string, string>>;
}

export interface ForwardAuthRequest {
  token: string;
  /** Target HTTP method, upper-case. */
  method: string;
  /** Full forwarded URI: api prefix plus target path and query. */
  uri: string;
  host: string;
  proto: string;
  /** Optional caller context. The platform decides the signed scope; this is only a hint. */
  workroomId?: string | null;
}

/** Headers for `GET /auth/forward/validate`. */
export function buildForwardAuthHeaders(req: ForwardAuthRequest): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${req.token}`,
    "x-forwarded-method": req.method,
    "x-forwarded-uri": req.uri,
    "x-forwarded-host": req.host,
    "x-forwarded-proto": req.proto,
  };
  if (typeof req.workroomId === "string" && req.workroomId.length > 0) {
    headers["x-workroom-id"] = req.workroomId;
  }
  return headers;
}

/**
 * Copy the allowlisted signed identity headers from a 200 validate response and
 * derive the public identity. Throws `missing_signature` when the required
 * headers are absent or empty.
 */
export function extractSignedIdentity(responseHeaders: Headers): ForwardAuthResult {
  const forward: Record<string, string> = {};
  for (const name of SIGNED_IDENTITY_HEADERS) {
    const value = responseHeaders.get(name);
    if (value !== null && value.length > 0) forward[name] = value;
  }
  for (const name of REQUIRED_IDENTITY_HEADERS) {
    if (!(name in forward)) {
      throw new KamiwazaError(
        "missing_signature",
        `ForwardAuth returned 200 without a signed identity (${name} absent); target request not sent`,
      );
    }
  }
  const identity: VerifiedIdentity = {
    userId: forward["x-user-id"]!,
    userName: forward["x-user-name"] ?? null,
    roles: parseRoles(forward["x-user-roles"]),
    workroomId: forward["x-workroom-id"] ?? null,
    workroomRole: forward["x-user-workroom-role"] ?? null,
  };
  return { identity, signatureTs: forward["x-user-signature-ts"] ?? null, forwardHeaders: Object.freeze(forward) };
}

/** Split the platform's role header. Platform format is comma-separated. */
function parseRoles(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/**
 * Reject caller-supplied headers that would forge gateway, identity or
 * credential headers. Returns the remaining headers with lower-case names.
 */
export function assertCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(name) || RESERVED_HEADER_PREFIXES.some((p) => name.startsWith(p))) {
      throw new KamiwazaError("forged_header", `caller-supplied header "${name}" is reserved for the platform gateway`);
    }
    if (typeof value !== "string") {
      throw new KamiwazaError("invalid_request", `header "${name}" must be a string`);
    }
    out[name] = value;
  }
  return out;
}
