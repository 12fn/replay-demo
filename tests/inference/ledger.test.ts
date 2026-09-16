import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetCapError, BudgetLedger, estimateReservationMicro, settlementMicro, usdToMicro } from "../../src/inference/index.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-ledger-"));
  path = join(dir, "ledger.sqlite");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const reserve = (ledger: BudgetLedger, micro: number, purpose = "test") =>
  ledger.reserve({ purpose, context: { k: 1 }, modelRequested: "gpt-5.6-luna", reservedMicro: micro });

describe("BudgetLedger", () => {
  it("settles a billed but unusable answer as completed with its outcome code", () => {
    const ledger = new BudgetLedger({ path, maxUsd: 5, maxRequests: 3 });
    const a = reserve(ledger, 10);
    const b = reserve(ledger, 10);
    const settle = (id: string, errorCode?: string) => ledger.settle(id, {
      settledMicro: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1,
      modelReturned: "gpt-5.6-luna", providerResponseId: "resp_1", providerRequestId: null, durationMs: 5, httpStatus: 200, ...(errorCode ? { errorCode } : {}),
    });
    expect(settle(a.id, "malformed_output:fenced")).toMatchObject({ status: "completed", settledMicro: 3, errorCode: "malformed_output:fenced" });
    expect(settle(b.id)).toMatchObject({ status: "completed", errorCode: null });
    expect(ledger.get(a.id)?.errorCode).toBe("malformed_output:fenced");
    expect(ledger.summary().completedMicro).toBe(6);
    ledger.close();
  });

  it("enforces the request cap counting every request that reached the network", () => {
    const ledger = new BudgetLedger({ path, maxUsd: 5, maxRequests: 3 });
    const a = reserve(ledger, 10);
    const b = reserve(ledger, 10);
    ledger.release(a.id, { durationMs: 1, httpStatus: 400, errorCode: "http_400" }); // failed still counts
    ledger.settle(b.id, {
      settledMicro: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1,
      modelReturned: "gpt-5.6-luna", providerResponseId: "resp_1", providerRequestId: null, durationMs: 5, httpStatus: 200,
    });
    reserve(ledger, 10);
    expect(() => reserve(ledger, 10)).toThrow(BudgetCapError);
    try { reserve(ledger, 10); } catch (e) { expect((e as BudgetCapError).kind).toBe("requests"); }
    const s = ledger.summary();
    expect(s.requestsUsed).toBe(3);
    expect(s.remainingRequests).toBe(0);
    expect(ledger.listReceipts()).toHaveLength(3);
    ledger.close();
  });

  it("enforces the dollar cap against committed (completed + reserved + uncertain) spend", () => {
    const ledger = new BudgetLedger({ path, maxUsd: 0.001, maxRequests: 100 }); // 1000 micro
    const a = reserve(ledger, 400);
    const b = reserve(ledger, 400);
    expect(() => reserve(ledger, 201)).toThrow(/dollar cap/);
    // settling below the reservation frees room
    ledger.settle(a.id, {
      settledMicro: 100, inputTokens: 10, cachedInputTokens: 0, outputTokens: 10,
      modelReturned: "gpt-5.6-luna", providerResponseId: null, providerRequestId: null, durationMs: 1, httpStatus: 200,
    });
    const c = reserve(ledger, 500);
    // uncertain keeps the full reservation
    ledger.markUncertain(b.id, { durationMs: 1, errorCode: "timeout" });
    expect(ledger.summary().committedMicro).toBe(100 + 400 + 500);
    expect(() => reserve(ledger, 1)).toThrow(BudgetCapError);
    // releasing c frees it
    ledger.release(c.id, { durationMs: 1, httpStatus: 401, errorCode: "http_401" });
    expect(ledger.summary().committedMicro).toBe(500);
    reserve(ledger, 500);
    expect(ledger.summary().remainingMicro).toBe(0);
    ledger.close();
  });

  it("does not let simultaneous reservations bypass the cap", async () => {
    const ledger = new BudgetLedger({ path, maxUsd: 0.001, maxRequests: 100 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => reserve(ledger, 300, `p${i}`))),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(7);
    for (const f of failed) expect((f as PromiseRejectedResult).reason).toBeInstanceOf(BudgetCapError);
    expect(ledger.summary().committedMicro).toBe(900);
    ledger.close();
  });

  it("does not let a second connection (separate process analogue) bypass the cap", () => {
    const one = new BudgetLedger({ path, maxUsd: 0.001, maxRequests: 100 });
    const two = new BudgetLedger({ path, maxUsd: 0.001, maxRequests: 100 });
    reserve(one, 600);
    expect(() => reserve(two, 600)).toThrow(BudgetCapError);
    reserve(two, 400);
    expect(one.summary().committedMicro).toBe(1000);
    one.close();
    two.close();
  });

  it("persists across close/reopen and keeps reserved rows counted", () => {
    const first = new BudgetLedger({ path, maxUsd: 1, maxRequests: 2 });
    const r = reserve(first, 250_000, "durable");
    first.close();

    const second = new BudgetLedger({ path, maxUsd: 1, maxRequests: 2 });
    const receipts = second.listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: r.id, status: "reserved", purpose: "durable", context: { k: 1 }, reservedMicro: 250_000 });
    expect(second.summary().committedMicro).toBe(250_000);
    reserve(second, 250_000);
    expect(() => reserve(second, 1)).toThrow(BudgetCapError);
    second.close();
  });

  it("reconciles an uncertain receipt without raising the cap", () => {
    const ledger = new BudgetLedger({ path, maxUsd: 5, maxRequests: 5 });
    const r = reserve(ledger, 1000);
    ledger.markUncertain(r.id, { durationMs: 1, errorCode: "timeout" });
    expect(ledger.summary().uncertainMicro).toBe(1000);
    const done = ledger.reconcile(r.id, 40);
    expect(done.status).toBe("completed");
    expect(ledger.summary()).toMatchObject({ uncertainMicro: 0, completedMicro: 40, requestsUsed: 1 });
    expect(() => ledger.reconcile(r.id, 40)).toThrow();
    ledger.close();
  });

  it("rejects operations after close", () => {
    const ledger = new BudgetLedger({ path });
    ledger.close();
    expect(() => ledger.summary()).toThrow(/closed/);
  });
});

describe("pricing", () => {
  it("uses exact integer microdollars", () => {
    expect(usdToMicro(5)).toBe(5_000_000);
    // 1M uncached input tokens at 1.25x = 0.25 USD; 1M output = 1.20 USD
    expect(settlementMicro({ inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBe(1_450_000);
    // cached input at 0.02
    expect(settlementMicro({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBe(20_000);
    // small values round up, never to zero
    expect(settlementMicro({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBe(3);
  });

  it("reserves a conservative upper bound", () => {
    const micro = estimateReservationMicro(24 * 1024, 1600);
    // (24576 + 256 tokens) * 0.25 + 1600 * 1.2 micro = 6208 + 1920
    expect(micro).toBe(6208 + 1920);
    expect(micro).toBeGreaterThanOrEqual(settlementMicro({ inputTokens: 24 * 1024 + 256, cachedInputTokens: 0, outputTokens: 1600 }));
  });
});
