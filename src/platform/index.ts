/**
 * Native Kamiwaza 1.2 platform adapter.
 *
 * Exports the client (the only adapter that talks to the installed platform),
 * the capability registry types, typed API contracts and the error type.
 * Importing this module performs no I/O.
 */
export {
  DEFAULT_TIMEOUT_MS,
  FORWARD_AUTH_PATH,
  KamiwazaClient,
  decodeJwtClaims,
  type EnterWorkroomOptions,
  type FetchImpl,
  type HttpMethod,
  type KamiwazaClientOptions,
  type LoginReceipt,
  type LoginResult,
  type NativePlatformAdapter,
  type RequestReceipt,
  type RequestSpec,
  type SignedResult,
  type TokenProvider,
} from "./client.ts";
export {
  CapabilityRegistry,
  PLATFORM_CAPABILITIES,
  type CapabilityLabel,
  type CapabilitySnapshot,
  type CapabilityStatus,
  type PlatformCapability,
} from "./capabilities.ts";
export {
  REQUIRED_IDENTITY_HEADERS,
  SECRET_IDENTITY_HEADERS,
  SIGNED_IDENTITY_HEADERS,
  type SignedIdentityHeader,
  type VerifiedIdentity,
} from "./forward-auth.ts";
export { KamiwazaError, redactSecrets, type KamiwazaErrorCode } from "./errors.ts";
export * from "./types.ts";
