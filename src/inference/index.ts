/**
 * REPLAY inference layer: budget ledger + bounded Luna adapter.
 * Importing this module performs no I/O and triggers no inference.
 */
export { BudgetLedger, BudgetCapError } from "./ledger.ts";
export type { Receipt, ReceiptStatus, LedgerSummary, BudgetLedgerOptions } from "./ledger.ts";
export { LunaClient, DEFAULT_LUNA_MODEL, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./luna-client.ts";
export type { LunaClientOptions, CompleteInput, CompleteResult, JsonSchemaSpec, FetchImpl } from "./luna-client.ts";
export { DeterministicClient, DETERMINISTIC_MODEL } from "./deterministic.ts";
export type { DeterministicClientOptions, DeterministicResponder } from "./deterministic.ts";
export { InferenceError } from "./errors.ts";
export type { InferenceErrorCode } from "./errors.ts";
export { classifyText, summarizeOutput, describeDiagnostics } from "./diagnostics.ts";
export type { OutputDiagnostics, TextShape } from "./diagnostics.ts";
export {
  LUNA_PRICING,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_CEILING,
  estimateReservationMicro,
  settlementMicro,
  usdToMicro,
  microToUsd,
} from "./pricing.ts";
