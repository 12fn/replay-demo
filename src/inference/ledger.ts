/**
 * Durable SQLite budget/usage ledger.
 *
 * Every paid request gets a receipt row. The lifecycle is:
 *
 *   reserve()  -> status "reserved"   (upper-bound cost held against the cap)
 *   settle()   -> status "completed"  (actual cost from provider usage)
 *   release()  -> status "failed"     (provider definitively rejected; no spend)
 *   markUncertain() -> "uncertain"    (timeout / missing usage; reservation kept)
 *   reconcile() -> "completed"        (manual settlement of an uncertain row)
 *
 * Cap enforcement counts reserved + uncertain + completed dollars, and every
 * row that reached the network as a request. Reservations run inside
 * BEGIN IMMEDIATE so concurrent processes cannot both slip under the cap.
 * The DB file is the source of truth; reopening after restart sees all rows.
 *
 * This ledger stores no credentials. Callers are responsible for not placing
 * secrets in purpose/context; LunaClient additionally refuses to persist any
 * context that contains its API key.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MICRO_PER_USD, microToUsd, usdToMicro } from "./pricing.ts";

export type ReceiptStatus = "reserved" | "completed" | "failed" | "uncertain";

export interface Receipt {
  id: string;
  status: ReceiptStatus;
  purpose: string;
  context: Record<string, unknown> | null;
  modelRequested: string;
  modelReturned: string | null;
  /** Provider response id (Responses API `id`), if returned. */
  providerResponseId: string | null;
  /** Provider request id (`x-request-id` header), if returned. */
  providerRequestId: string | null;
  reservedMicro: number;
  /** Actual (or conservatively assumed) cost in microdollars. */
  settledMicro: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerSummary {
  path: string;
  maxUsd: number;
  maxRequests: number;
  maxMicro: number;
  /** Rows counted against the request cap (everything that reached the network). */
  requestsUsed: number;
  remainingRequests: number;
  /** Settled cost of completed rows. */
  completedMicro: number;
  /** Held cost of rows still in flight. */
  reservedMicro: number;
  /** Held cost of rows whose outcome is unknown (kept until reconciliation). */
  uncertainMicro: number;
  /** completed + reserved + uncertain; this is what the cap is checked against. */
  committedMicro: number;
  remainingMicro: number;
  committedUsd: number;
  counts: Record<ReceiptStatus, number>;
}

export interface BudgetLedgerOptions {
  path: string;
  maxUsd?: number;
  maxRequests?: number;
}

export interface ReserveInput {
  purpose: string;
  context?: Record<string, unknown> | null;
  modelRequested: string;
  reservedMicro: number;
}

export interface SettleInput {
  settledMicro: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  modelReturned: string | null;
  providerResponseId: string | null;
  providerRequestId: string | null;
  durationMs: number;
  httpStatus: number;
  /**
   * Optional short outcome code for a billed call whose answer was unusable
   * (e.g. `malformed_output:fenced`, `incomplete_response:max_output_tokens`).
   * The receipt still settles as `completed` because the spend is real.
   */
  errorCode?: string | null;
}

export interface FailureInput {
  durationMs: number;
  httpStatus?: number | null;
  errorCode: string;
  providerRequestId?: string | null;
}

export class BudgetCapError extends Error {
  readonly kind: "dollars" | "requests";
  constructor(kind: "dollars" | "requests", message: string) {
    super(message);
    this.name = "BudgetCapError";
    this.kind = kind;
  }
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id                   TEXT PRIMARY KEY,
  status               TEXT NOT NULL CHECK (status IN ('reserved','completed','failed','uncertain')),
  purpose              TEXT NOT NULL,
  context_json         TEXT,
  model_requested      TEXT NOT NULL,
  model_returned       TEXT,
  provider_response_id TEXT,
  provider_request_id  TEXT,
  reserved_micro       INTEGER NOT NULL CHECK (reserved_micro >= 0),
  settled_micro        INTEGER CHECK (settled_micro IS NULL OR settled_micro >= 0),
  input_tokens         INTEGER,
  cached_input_tokens  INTEGER,
  output_tokens        INTEGER,
  duration_ms          INTEGER,
  http_status          INTEGER,
  error_code           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_status_idx ON receipts(status);
CREATE INDEX IF NOT EXISTS receipts_created_idx ON receipts(created_at);
`;

function now(): string {
  return new Date().toISOString();
}

function requireInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export class BudgetLedger {
  readonly path: string;
  readonly maxUsd: number;
  readonly maxRequests: number;
  readonly maxMicro: number;
  private db: DatabaseSync | null;

  constructor({ path, maxUsd = 5, maxRequests = 100 }: BudgetLedgerOptions) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("ledger path is required");
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) {
      throw new RangeError("maxRequests must be a non-negative integer");
    }
    this.path = path;
    this.maxUsd = maxUsd;
    this.maxRequests = maxRequests;
    this.maxMicro = usdToMicro(maxUsd);
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  private conn(): DatabaseSync {
    if (!this.db) throw new Error("BudgetLedger is closed");
    return this.db;
  }

  /**
   * Atomically check both caps and insert a reservation. Throws BudgetCapError
   * when the request would push committed spend or request count over a cap.
   */
  reserve(input: ReserveInput): Receipt {
    const db = this.conn();
    const reservedMicro = requireInt(input.reservedMicro, "reservedMicro");
    if (typeof input.purpose !== "string" || input.purpose.length === 0) {
      throw new TypeError("purpose is required");
    }
    const id = randomUUID();
    const ts = now();
    const contextJson = input.context == null ? null : JSON.stringify(input.context);

    db.exec("BEGIN IMMEDIATE;");
    try {
      const totals = this.totalsUnlocked();
      if (totals.requestsUsed + 1 > this.maxRequests) {
        throw new BudgetCapError(
          "requests",
          `request cap reached (${totals.requestsUsed}/${this.maxRequests})`,
        );
      }
      if (totals.committedMicro + reservedMicro > this.maxMicro) {
        throw new BudgetCapError(
          "dollars",
          `dollar cap would be exceeded (committed ${microToUsd(totals.committedMicro).toFixed(6)} + reserve ${microToUsd(reservedMicro).toFixed(6)} > ${this.maxUsd} USD)`,
        );
      }
      db.prepare(
        `INSERT INTO receipts (id, status, purpose, context_json, model_requested, reserved_micro, created_at, updated_at)
         VALUES (?, 'reserved', ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.purpose, contextJson, input.modelRequested, reservedMicro, ts, ts);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
    return this.get(id)!;
  }

  /** Record actual usage; replaces the reservation with the settled cost. */
  settle(id: string, input: SettleInput): Receipt {
    const db = this.conn();
    requireInt(input.settledMicro, "settledMicro");
    const res = db
      .prepare(
        `UPDATE receipts SET status='completed', settled_micro=?, input_tokens=?, cached_input_tokens=?, output_tokens=?,
           model_returned=?, provider_response_id=?, provider_request_id=?, duration_ms=?, http_status=?, error_code=?, updated_at=?
         WHERE id=? AND status IN ('reserved','uncertain')`,
      )
      .run(
        input.settledMicro,
        requireInt(input.inputTokens, "inputTokens"),
        requireInt(input.cachedInputTokens, "cachedInputTokens"),
        requireInt(input.outputTokens, "outputTokens"),
        input.modelReturned,
        input.providerResponseId,
        input.providerRequestId,
        requireInt(input.durationMs, "durationMs"),
        input.httpStatus,
        input.errorCode ?? null,
        now(),
        id,
      );
    if (Number(res.changes) !== 1) throw new Error(`settle: receipt ${id} not in a settleable state`);
    return this.get(id)!;
  }

  /** Provider definitively rejected the request: no spend, but it still counts as a request. */
  release(id: string, input: FailureInput): Receipt {
    const db = this.conn();
    const res = db
      .prepare(
        `UPDATE receipts SET status='failed', settled_micro=0, duration_ms=?, http_status=?, error_code=?, provider_request_id=COALESCE(?, provider_request_id), updated_at=?
         WHERE id=? AND status='reserved'`,
      )
      .run(requireInt(input.durationMs, "durationMs"), input.httpStatus ?? null, input.errorCode, input.providerRequestId ?? null, now(), id);
    if (Number(res.changes) !== 1) throw new Error(`release: receipt ${id} not reserved`);
    return this.get(id)!;
  }

  /** Outcome unknown (timeout, missing usage): keep the full reservation as spent. */
  markUncertain(id: string, input: FailureInput): Receipt {
    const db = this.conn();
    const res = db
      .prepare(
        `UPDATE receipts SET status='uncertain', settled_micro=reserved_micro, duration_ms=?, http_status=?, error_code=?, provider_request_id=COALESCE(?, provider_request_id), updated_at=?
         WHERE id=? AND status='reserved'`,
      )
      .run(requireInt(input.durationMs, "durationMs"), input.httpStatus ?? null, input.errorCode, input.providerRequestId ?? null, now(), id);
    if (Number(res.changes) !== 1) throw new Error(`markUncertain: receipt ${id} not reserved`);
    return this.get(id)!;
  }

  /**
   * Manually reconcile an uncertain receipt once the true cost is known
   * (e.g. from the provider dashboard). Never raises the cap.
   */
  reconcile(id: string, settledMicro: number): Receipt {
    const db = this.conn();
    const res = db
      .prepare(`UPDATE receipts SET status='completed', settled_micro=?, updated_at=? WHERE id=? AND status='uncertain'`)
      .run(requireInt(settledMicro, "settledMicro"), now(), id);
    if (Number(res.changes) !== 1) throw new Error(`reconcile: receipt ${id} not uncertain`);
    return this.get(id)!;
  }

  get(id: string): Receipt | undefined {
    const row = this.conn().prepare("SELECT * FROM receipts WHERE id=?").get(id) as Row | undefined;
    return row ? toReceipt(row) : undefined;
  }

  listReceipts(): Receipt[] {
    const rows = this.conn().prepare("SELECT * FROM receipts ORDER BY created_at ASC, rowid ASC").all() as Row[];
    return rows.map(toReceipt);
  }

  summary(): LedgerSummary {
    const t = this.totalsUnlocked();
    return {
      path: this.path,
      maxUsd: this.maxUsd,
      maxRequests: this.maxRequests,
      maxMicro: this.maxMicro,
      requestsUsed: t.requestsUsed,
      remainingRequests: Math.max(0, this.maxRequests - t.requestsUsed),
      completedMicro: t.completedMicro,
      reservedMicro: t.reservedMicro,
      uncertainMicro: t.uncertainMicro,
      committedMicro: t.committedMicro,
      remainingMicro: Math.max(0, this.maxMicro - t.committedMicro),
      committedUsd: t.committedMicro / MICRO_PER_USD,
      counts: t.counts,
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private totalsUnlocked() {
    const rows = this.conn()
      .prepare(
        `SELECT status, COUNT(*) AS n, COALESCE(SUM(reserved_micro),0) AS reserved, COALESCE(SUM(settled_micro),0) AS settled
         FROM receipts GROUP BY status`,
      )
      .all() as Array<{ status: ReceiptStatus; n: number | bigint; reserved: number | bigint; settled: number | bigint }>;
    const counts: Record<ReceiptStatus, number> = { reserved: 0, completed: 0, failed: 0, uncertain: 0 };
    let completedMicro = 0;
    let reservedMicro = 0;
    let uncertainMicro = 0;
    for (const r of rows) {
      counts[r.status] = Number(r.n);
      if (r.status === "completed") completedMicro = Number(r.settled);
      else if (r.status === "reserved") reservedMicro = Number(r.reserved);
      else if (r.status === "uncertain") uncertainMicro = Number(r.reserved);
    }
    const requestsUsed = counts.reserved + counts.completed + counts.failed + counts.uncertain;
    return {
      counts,
      requestsUsed,
      completedMicro,
      reservedMicro,
      uncertainMicro,
      committedMicro: completedMicro + reservedMicro + uncertainMicro,
    };
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

function toReceipt(row: Row): Receipt {
  return {
    id: String(row.id),
    status: row.status as ReceiptStatus,
    purpose: String(row.purpose),
    context: row.context_json ? (JSON.parse(String(row.context_json)) as Record<string, unknown>) : null,
    modelRequested: String(row.model_requested),
    modelReturned: row.model_returned == null ? null : String(row.model_returned),
    providerResponseId: row.provider_response_id == null ? null : String(row.provider_response_id),
    providerRequestId: row.provider_request_id == null ? null : String(row.provider_request_id),
    reservedMicro: Number(row.reserved_micro),
    settledMicro: num(row.settled_micro),
    inputTokens: num(row.input_tokens),
    cachedInputTokens: num(row.cached_input_tokens),
    outputTokens: num(row.output_tokens),
    durationMs: num(row.duration_ms),
    httpStatus: num(row.http_status),
    errorCode: row.error_code == null ? null : String(row.error_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
