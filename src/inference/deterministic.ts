/**
 * DETERMINISTIC TESTING ADAPTER. Not a model.
 *
 * Produces canned, synthetic outputs with the same `complete()` shape as
 * LunaClient so engine/agent code can run in ordinary tests without any
 * network, credentials or budget spend. Receipts it returns are labelled
 * `modelReturned: "deterministic-synthetic"` and are never written to a
 * BudgetLedger. UI and evidence must present these outputs as synthetic.
 */
import type { CompleteInput, CompleteResult } from "./luna-client.ts";
import type { Receipt } from "./ledger.ts";

export const DETERMINISTIC_MODEL = "deterministic-synthetic";

export type DeterministicResponder = (req: CompleteInput, callIndex: number) => string | Record<string, unknown>;

export interface DeterministicClientOptions {
  /** Returns the synthetic output text (or an object to be JSON-encoded) for each call. */
  respond?: DeterministicResponder;
}

export class DeterministicClient {
  readonly model = DETERMINISTIC_MODEL;
  private readonly respond: DeterministicResponder;
  private calls = 0;
  readonly history: CompleteInput[] = [];

  constructor(opts: DeterministicClientOptions = {}) {
    this.respond = opts.respond ?? defaultResponder;
  }

  async complete<T = unknown>(req: CompleteInput): Promise<CompleteResult<T>> {
    const index = this.calls++;
    this.history.push(req);
    const raw = this.respond(req, index);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const ts = new Date(0).toISOString();
    const receipt: Receipt = {
      id: `synthetic-${index}`,
      status: "completed",
      purpose: req.purpose,
      context: req.context ?? null,
      modelRequested: DETERMINISTIC_MODEL,
      modelReturned: DETERMINISTIC_MODEL,
      providerResponseId: null,
      providerRequestId: null,
      reservedMicro: 0,
      settledMicro: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      httpStatus: null,
      errorCode: null,
      createdAt: ts,
      updatedAt: ts,
    };
    const result: CompleteResult<T> = { text, receipt };
    if (req.jsonSchema) result.parsed = JSON.parse(text) as T;
    return result;
  }
}

function defaultResponder(req: CompleteInput): string | Record<string, unknown> {
  if (req.jsonSchema) return { synthetic: true, purpose: req.purpose };
  return `[synthetic:${req.purpose}]`;
}
