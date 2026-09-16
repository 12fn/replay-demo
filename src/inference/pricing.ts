/**
 * Pricing and cost arithmetic for the Luna route.
 *
 * All money is handled as exact integer microdollars (1 USD = 1_000_000 micro).
 * Rates below are expressed as microdollars per one million tokens so that
 * `tokens * rate / 1_000_000` is an exact integer division with ceiling.
 *
 * Verified 2026-09-12 from https://developers.openai.com/api/docs/models/gpt-5.6-luna
 *   input          USD 0.20 / 1M tokens
 *   cached input   USD 0.02 / 1M tokens
 *   output         USD 1.20 / 1M tokens
 *   cache writes   1.25x input
 */

export const MICRO_PER_USD = 1_000_000;

export interface PriceTable {
  /** microdollars per 1M uncached input tokens */
  inputMicroPerMillion: number;
  /** microdollars per 1M cached input tokens */
  cachedInputMicroPerMillion: number;
  /** microdollars per 1M output tokens (reasoning tokens bill as output) */
  outputMicroPerMillion: number;
  /** multiplier applied to input for cache writes, as a rational (num/den) */
  cacheWriteMultiplier: { num: number; den: number };
}

export const LUNA_PRICING: PriceTable = Object.freeze({
  inputMicroPerMillion: 200_000,
  cachedInputMicroPerMillion: 20_000,
  outputMicroPerMillion: 1_200_000,
  cacheWriteMultiplier: { num: 5, den: 4 },
});

/** Provider context window is 272k; we stay far below that. */
export const DEFAULT_MAX_INPUT_BYTES = 24 * 1024;
/** Hard ceiling on max_output_tokens accepted by the client. */
export const MAX_OUTPUT_TOKENS_CEILING = 1600;
/** Default max_output_tokens when the caller does not specify. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1000;
/** Fixed token overhead assumed for message framing, schema wrapping, etc. */
export const RESERVATION_OVERHEAD_TOKENS = 256;

export interface UsageTokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function ceilDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("ceilDiv requires safe integers and a positive denominator");
  }
  return Math.ceil(numerator / denominator);
}

function nonNegativeInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError("usd must be a finite non-negative number");
  return Math.round(usd * MICRO_PER_USD);
}

export function microToUsd(micro: number): number {
  return micro / MICRO_PER_USD;
}

/**
 * Conservative upper-bound reservation in microdollars.
 *
 * Input tokens are bounded by UTF-8 byte count (worst case: one token per byte)
 * plus a fixed overhead, priced at the cache-write rate (1.25x input) because a
 * fresh prompt may be written to the cache. Output is priced at the full
 * max_output_tokens since reasoning tokens bill as output and are not
 * predictable ahead of time.
 */
export function estimateReservationMicro(
  inputBytes: number,
  maxOutputTokens: number,
  pricing: PriceTable = LUNA_PRICING,
): number {
  const bytes = nonNegativeInt(inputBytes, "inputBytes");
  const out = nonNegativeInt(maxOutputTokens, "maxOutputTokens");
  const inputTokens = bytes + RESERVATION_OVERHEAD_TOKENS;
  const { num, den } = pricing.cacheWriteMultiplier;
  const inputMicro = ceilDiv(inputTokens * pricing.inputMicroPerMillion * num, 1_000_000 * den);
  const outputMicro = ceilDiv(out * pricing.outputMicroPerMillion, 1_000_000);
  return inputMicro + outputMicro;
}

/**
 * Conservative actual cost from provider-reported usage.
 *
 * The Responses API does not report cache writes separately, so uncached input
 * is billed at the cache-write multiplier (1.25x). This over-counts by at most
 * 25% on input, which is acceptable for a hard-capped budget.
 */
export function settlementMicro(usage: UsageTokens, pricing: PriceTable = LUNA_PRICING): number {
  const input = nonNegativeInt(usage.inputTokens, "inputTokens");
  const cached = Math.min(nonNegativeInt(usage.cachedInputTokens, "cachedInputTokens"), input);
  const output = nonNegativeInt(usage.outputTokens, "outputTokens");
  const uncached = input - cached;
  const { num, den } = pricing.cacheWriteMultiplier;
  const uncachedMicro = ceilDiv(uncached * pricing.inputMicroPerMillion * num, 1_000_000 * den);
  const cachedMicro = ceilDiv(cached * pricing.cachedInputMicroPerMillion, 1_000_000);
  const outputMicro = ceilDiv(output * pricing.outputMicroPerMillion, 1_000_000);
  return uncachedMicro + cachedMicro + outputMicro;
}
