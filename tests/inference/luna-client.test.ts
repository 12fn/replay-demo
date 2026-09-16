import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetLedger,
  DeterministicClient,
  InferenceError,
  LunaClient,
  type FetchImpl,
  settlementMicro,
} from "../../src/inference/index.ts";

const API_KEY = "sk-test-SECRET-do-not-echo-1234567890";
let dir: string;
let ledger: BudgetLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-luna-"));
  ledger = new BudgetLedger({ path: join(dir, "ledger.sqlite"), maxUsd: 5, maxRequests: 100 });
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function okBody(text: string, usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30 }) {
  return {
    id: "resp_abc123",
    model: "gpt-5.6-luna-2026-08-01",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ],
    usage,
  };
}

function assertNoSecret(err: unknown) {
  const e = err as InferenceError;
  const dump = JSON.stringify({ message: e.message, code: e.code, providerCode: e.providerCode, stack: e.stack, cause: String(e.cause ?? "") });
  expect(dump).not.toContain(API_KEY);
  expect(dump).not.toContain("SECRET");
}

describe("LunaClient", () => {
  it("does not touch the network or the ledger when credentials are empty", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = new LunaClient({ apiKey: "   ", ledger, fetchImpl });
    await expect(client.complete({ instructions: "x", input: "y", purpose: "p" })).rejects.toMatchObject({ code: "missing_credentials" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("sends a Responses API request with defaults and settles actual usage", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody("hello"), { "x-request-id": "req_777" }));
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });

    const res = await client.complete({ instructions: "be brief", input: "say hello", purpose: "opponent.decide", context: { branch: "b1", tick: 42 } });

    expect(res.text).toBe("hello");
    expect(res.parsed).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      instructions: "be brief",
      input: "say hello",
      max_output_tokens: 1000,
      reasoning: { effort: "low" },
      store: false,
    });
    expect(body.tools).toBeUndefined();
    expect(body.text).toBeUndefined();

    const expectedMicro = settlementMicro({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 });
    expect(res.receipt).toMatchObject({
      status: "completed",
      purpose: "opponent.decide",
      context: { branch: "b1", tick: 42 },
      modelRequested: "gpt-5.6-luna",
      modelReturned: "gpt-5.6-luna-2026-08-01",
      providerResponseId: "resp_abc123",
      providerRequestId: "req_777",
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      settledMicro: expectedMicro,
      httpStatus: 200,
    });
    expect(res.receipt.reservedMicro).toBeGreaterThan(expectedMicro);
    expect(typeof res.receipt.durationMs).toBe("number");
    const s = ledger.summary();
    expect(s.requestsUsed).toBe(1);
    expect(s.committedMicro).toBe(expectedMicro);
    // ledger persisted no credential
    expect(JSON.stringify(ledger.listReceipts())).not.toContain(API_KEY);
  });

  it("maps jsonSchema to strict text.format and returns parsed output", async () => {
    const payload = { action: "attack", target: "hill-3", confidence: 0.8 };
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody(JSON.stringify(payload))));
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    const schema = {
      type: "object",
      properties: { action: { type: "string" }, target: { type: "string" }, confidence: { type: "number" } },
      required: ["action", "target", "confidence"],
      additionalProperties: false,
    };

    const res = await client.complete<typeof payload>({
      instructions: "decide",
      input: "situation",
      purpose: "staff.plan",
      jsonSchema: { name: "decision", schema },
      maxOutputTokens: 300,
    });

    expect(res.parsed).toEqual(payload);
    expect(res.text).toBe(JSON.stringify(payload));
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.text).toEqual({ format: { type: "json_schema", name: "decision", schema, strict: true } });
    expect(body.max_output_tokens).toBe(300);
  });

  it("settles usage but fails when structured output is not JSON", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody("not json")));
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    await expect(
      client.complete({ instructions: "d", input: "s", purpose: "p", jsonSchema: { name: "x", schema: { type: "object" } } }),
    ).rejects.toMatchObject({ code: "malformed_response" });
    expect(ledger.listReceipts()[0]!.status).toBe("completed");
  });

  it("settles a truncated answer but never returns its apparently valid JSON as a complete decision", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, {...okBody('{}'), status:'incomplete', incomplete_details:{reason:'max_output_tokens'}}));
    const client = new LunaClient({apiKey:API_KEY,ledger,fetchImpl});
    await expect(client.complete({instructions:'d',input:'s',purpose:'p'})).rejects.toMatchObject({code:'incomplete_response',providerCode:'max_output_tokens',receiptId:expect.any(String)});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.listReceipts()[0]!).toMatchObject({ status: 'completed', errorCode: 'incomplete_response:max_output_tokens', outputTokens: 30 });
  });
  it.each(['failed','cancelled','in_progress','queued'])('never consumes output from a provider response whose status is %s',async status=>{
    const fetchImpl=vi.fn<FetchImpl>(async()=>jsonResponse(200,{...okBody('{}'),status}));const client=new LunaClient({apiKey:API_KEY,ledger,fetchImpl});
    await expect(client.complete({instructions:'d',input:'s',purpose:'p'})).rejects.toMatchObject({code:'incomplete_response',providerCode:status});
    expect(ledger.listReceipts()[0]).toMatchObject({status:'completed',errorCode:`response_status:${status}`});expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe("malformed-output diagnostics (text-free)", () => {
    const structured = { instructions: "d", input: "s", purpose: "opponent decision", jsonSchema: { name: "agent_pulse", schema: { type: "object" } } };
    const MODEL_TEXT = `Sure ${API_KEY} here`;

    async function failWith(body: unknown) {
      const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, body, { "x-request-id": "req_diag" }));
      const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
      let caught: unknown;
      try { await client.complete(structured); } catch (e) { caught = e; }
      expect(fetchImpl).toHaveBeenCalledTimes(1); // never a blind retry
      const err = caught as InferenceError;
      expect(err).toBeInstanceOf(InferenceError);
      assertNoSecret(err);
      expect(JSON.stringify(err.diagnostics)).not.toContain("Sure");
      expect(err.message).not.toContain("Sure");
      const [receipt] = ledger.listReceipts();
      expect(receipt!.id).toBe(err.receiptId);
      return { err, receipt: receipt! };
    }

    it("classifies a fenced answer at 224 output tokens as fenced, not exhausted", async () => {
      const usage = { input_tokens: 900, input_tokens_details: { cached_tokens: 0 }, output_tokens: 224 };
      const { err, receipt } = await failWith(okBody('```json\n{"summary":"' + MODEL_TEXT + '","calls":[]}\n```', usage));
      expect(err.code).toBe("malformed_response");
      expect(err.message).toMatch(/^structured output was not valid JSON \[shape=fenced selection=legacy status=- items=reasoning:1,message:1 parts=output_text:1 chars=\d+ tokens=224\]$/);
      expect(err.diagnostics).toMatchObject({ textShape: "fenced", outputTokens: 224, messageItems: 1, refusal: false, incompleteReason: null });
      expect(receipt).toMatchObject({ status: "completed", errorCode: "malformed_output:fenced", outputTokens: 224, providerRequestId: "req_diag" });
      expect(receipt.settledMicro).toBe(settlementMicro({ inputTokens: 900, cachedInputTokens: 0, outputTokens: 224 }));
    });

    it("classifies prose-wrapped, cut-off and trailing-content answers distinctly", async () => {
      const prose = await failWith(okBody(`${MODEL_TEXT}: {"summary":"x","calls":[]}`));
      expect(prose.receipt.errorCode).toBe("malformed_output:leading_prose");
      ledger.close(); ledger = new BudgetLedger({ path: join(dir, "l2.sqlite"), maxUsd: 5, maxRequests: 100 });

      const cut = await failWith({ ...okBody(`{"summary":"${MODEL_TEXT}`), status: "completed" });
      expect(cut.err.diagnostics).toMatchObject({ textShape: "unbalanced_json", providerStatus: "completed" });
      expect(cut.receipt.errorCode).toBe("malformed_output:unbalanced_json");
      ledger.close(); ledger = new BudgetLedger({ path: join(dir, "l3.sqlite"), maxUsd: 5, maxRequests: 100 });

      // Two message items: each valid on its own, concatenated they are not.
      const body = okBody('{"summary":"a","calls":[]}');
      body.output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"summary":"b","calls":[]}' }] });
      const two = await failWith(body);
      expect(two.err.diagnostics).toMatchObject({ textShape: "trailing_content", messageItems: 2, partTypes: { output_text: 2 } });
      expect(two.receipt.errorCode).toBe("malformed_output:trailing_content");
    });

    it("reports a refusal-only message as a refusal, not as missing text", async () => {
      const body = okBody("");
      body.output[1] = { type: "message", role: "assistant", content: [{ type: "refusal", refusal: `no ${API_KEY}` }] } as any;
      const { err, receipt } = await failWith(body);
      expect(err).toMatchObject({ code: "malformed_response", providerCode: "refusal" });
      expect(err.message).toMatch(/^provider returned a refusal instead of output \[shape=none .*parts=refusal:1/);
      expect(err.diagnostics).toMatchObject({ refusal: true, textShape: "none", textChars: null });
      expect(receipt.errorCode).toBe("refusal");
    });

    it("reports an unexpected content shape as no output text with the part types seen", async () => {
      const body = okBody("");
      body.output[1] = { type: "message", role: "assistant", content: "a bare string" } as any;
      const { err, receipt } = await failWith(body);
      expect(err.message).toMatch(/^provider response contained no output text \[shape=none .*parts=no_content_array:1/);
      expect(receipt.errorCode).toBe("no_output_text");
    });

    it("attaches diagnostics to a successful structured call and leaves the receipt clean", async () => {
      const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody('{"summary":"Selected expansion","calls":[],"sourceIds":[],"done":true}')));
      const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
      const res = await client.complete<{ summary: string }>(structured);
      expect(res.parsed?.summary).toBe("Selected expansion");
      expect(res.diagnostics).toMatchObject({ textShape: "json_object", messageItems: 1, refusal: false, providerStatus: null, outputTokens: 30 });
      expect(JSON.stringify(res.diagnostics)).not.toContain("expansion");
      expect(res.receipt.errorCode).toBeNull();
    });

    it("keeps plain-text calls unaffected by JSON classification", async () => {
      const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody("just prose, no schema requested")));
      const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
      const res = await client.complete({ instructions: "d", input: "s", purpose: "p" });
      expect(res.text).toBe("just prose, no schema requested");
      expect(res.diagnostics?.textShape).toBe("leading_prose");
      expect(res.receipt.errorCode).toBeNull();
    });
  });

  it("honors the timeout, keeps the reservation as uncertain and never echoes the key", async () => {
    const fetchImpl: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new DOMException(`aborted ${API_KEY}`, "AbortError")));
      });
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl, timeoutMs: 20 });

    const started = Date.now();
    let caught: unknown;
    try {
      await client.complete({ instructions: "i", input: "x", purpose: "p" });
    } catch (e) {
      caught = e;
    }
    expect(Date.now() - started).toBeLessThan(2000);
    expect(caught).toBeInstanceOf(InferenceError);
    expect((caught as InferenceError).code).toBe("timeout");
    assertNoSecret(caught);

    const [r] = ledger.listReceipts();
    expect(r).toMatchObject({ status: "uncertain", errorCode: "timeout" });
    expect(r!.settledMicro).toBe(r!.reservedMicro);
    expect(ledger.summary().uncertainMicro).toBe(r!.reservedMicro);
    expect(ledger.summary().requestsUsed).toBe(1);
  });

  it("treats a network error as uncertain spend with no retry", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new TypeError(`fetch failed: ${API_KEY}`);
    });
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    let caught: unknown;
    try { await client.complete({ instructions: "i", input: "x", purpose: "p" }); } catch (e) { caught = e; }
    expect((caught as InferenceError).code).toBe("network_error");
    assertNoSecret(caught);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ledger.listReceipts()[0]!.status).toBe("uncertain");
  });

  it("releases the reservation on a definitive 4xx and does not echo the provider body", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () =>
      jsonResponse(401, { error: { message: `Incorrect API key provided: ${API_KEY}`, type: "invalid_request_error", code: "invalid_api_key" } }),
    );
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    let caught: unknown;
    try { await client.complete({ instructions: "i", input: "x", purpose: "p" }); } catch (e) { caught = e; }
    const err = caught as InferenceError;
    expect(err.code).toBe("provider_error");
    expect(err.httpStatus).toBe(401);
    expect(err.providerCode).toBe("invalid_api_key");
    expect(err.message).not.toContain("Incorrect API key");
    assertNoSecret(caught);
    const [r] = ledger.listReceipts();
    expect(r).toMatchObject({ status: "failed", settledMicro: 0, httpStatus: 401, errorCode: "http_401" });
    expect(ledger.summary().committedMicro).toBe(0);
    expect(ledger.summary().requestsUsed).toBe(1);
  });

  it("keeps a 5xx as uncertain spend", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(503, { error: { type: "server_error" } }));
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    await expect(client.complete({ instructions: "i", input: "x", purpose: "p" })).rejects.toMatchObject({ code: "provider_error", httpStatus: 503 });
    expect(ledger.listReceipts()[0]!.status).toBe("uncertain");
    expect(ledger.summary().uncertainMicro).toBeGreaterThan(0);
  });

  it("keeps the reservation when provider usage is missing", async () => {
    const body = okBody("ok");
    delete (body as { usage?: unknown }).usage;
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, body));
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    const res = await client.complete({ instructions: "i", input: "x", purpose: "p" });
    expect(res.text).toBe("ok");
    expect(res.receipt).toMatchObject({ status: "uncertain", errorCode: "usage_missing" });
    expect(res.receipt.settledMicro).toBe(res.receipt.reservedMicro);
  });

  it("enforces request and dollar caps before calling fetch", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody("x")));
    const small = new BudgetLedger({ path: join(dir, "small.sqlite"), maxUsd: 5, maxRequests: 1 });
    const client = new LunaClient({ apiKey: API_KEY, ledger: small, fetchImpl });
    await client.complete({ instructions: "i", input: "x", purpose: "p" });
    await expect(client.complete({ instructions: "i", input: "x", purpose: "p" })).rejects.toMatchObject({ code: "request_cap_exceeded" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const poor = new BudgetLedger({ path: join(dir, "poor.sqlite"), maxUsd: 0.0001, maxRequests: 10 });
    const client2 = new LunaClient({ apiKey: API_KEY, ledger: poor, fetchImpl });
    await expect(client2.complete({ instructions: "i", input: "x", purpose: "p" })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(poor.listReceipts()).toHaveLength(0);
    small.close();
    poor.close();
  });

  it("serializes concurrent calls through the ledger so the cap holds", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody("x")));
    const capped = new BudgetLedger({ path: join(dir, "cc.sqlite"), maxUsd: 5, maxRequests: 3 });
    const client = new LunaClient({ apiKey: API_KEY, ledger: capped, fetchImpl });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => client.complete({ instructions: "i", input: "x", purpose: "p" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(capped.summary().requestsUsed).toBe(3);
    capped.close();
  });

  it("rejects oversized input and out-of-range output limits without reserving", async () => {
    const fetchImpl = vi.fn<FetchImpl>();
    const client = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl });
    await expect(client.complete({ instructions: "", input: "é".repeat(13 * 1024), purpose: "p" })).rejects.toMatchObject({ code: "input_too_large" });
    await expect(client.complete({ instructions: "", input: "x", purpose: "p", maxOutputTokens: 1601 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.complete({ instructions: "", input: "x", purpose: "p", context: { leaked: API_KEY } })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("supports a provider-compatible base URL and extra headers", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(200, okBody("x")));
    const client = new LunaClient({
      apiKey: API_KEY,
      ledger,
      fetchImpl,
      baseUrl: "https://kamiwaza.example/api/openai/v1/",
      extraHeaders: { "x-kamiwaza-deployment": "dep-1" },
    });
    await client.complete({ instructions: "i", input: "x", purpose: "p" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://kamiwaza.example/api/openai/v1/responses");
    expect((init.headers as Record<string, string>)["x-kamiwaza-deployment"]).toBe("dep-1");
  });

  it("does not leak the key through JSON serialization", () => {
    const client = new LunaClient({ apiKey: API_KEY, ledger });
    expect(JSON.stringify(client)).not.toContain(API_KEY);
  });
});

describe("DeterministicClient", () => {
  it("returns labelled synthetic output without network or ledger spend", async () => {
    const client = new DeterministicClient({ respond: (req, i) => (req.jsonSchema ? { i, ok: true } : `hi ${i}`) });
    const a = await client.complete({ instructions: "", input: "", purpose: "p" });
    const b = await client.complete<{ i: number; ok: boolean }>({ instructions: "", input: "", purpose: "p", jsonSchema: { name: "s", schema: {} } });
    expect(a.text).toBe("hi 0");
    expect(a.receipt.modelReturned).toBe("deterministic-synthetic");
    expect(b.parsed).toEqual({ i: 1, ok: true });
    expect(ledger.listReceipts()).toHaveLength(0);
  });
});
