import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger, LunaClient, MAX_OUTPUT_TOKENS_CEILING, type FetchImpl } from "../../src/inference/index.ts";
import {
  GRAPH_BRIDGE_PATH,
  GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS,
  GRAPH_MAX_MESSAGE_BYTES,
  RECEIPT_HEADER,
  mountGraphBridge,
  type GraphBridgeOptions,
  type GraphBridgeReceiptEvent,
} from "../../src/server/graph-bridge.ts";

const API_KEY = "sk-provider-SECRET-key-1234567890abcdef";
const BRIDGE_SECRET = `bridge-SECRET-${randomBytes(24).toString("hex")}`;
const MODEL = "gpt-5.6-luna";
const SOURCE_TEXT = "SOURCE-CONTENT-must-not-leak-to-callbacks";

let dir: string;
let ledger: BudgetLedger;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-graph-bridge-"));
  ledger = new BudgetLedger({ path: join(dir, "ledger.sqlite"), maxUsd: 5, maxRequests: 100 });
});
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function okBody(text: string, usage: unknown = { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30 }) {
  return { id: "resp_abc123", model: "gpt-5.6-luna-2026-08-01", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage };
}

interface Harness {
  base: string;
  fetchImpl: ReturnType<typeof vi.fn<FetchImpl>>;
  events: GraphBridgeReceiptEvent[];
  luna: LunaClient;
  bridge: ReturnType<typeof mountGraphBridge>;
}

async function harness(overrides: Partial<GraphBridgeOptions> & { providerFetch?: FetchImpl; apiKey?: string; withAppParser?: boolean } = {}): Promise<Harness> {
  const fetchImpl = vi.fn<FetchImpl>(overrides.providerFetch ?? (async () => jsonResponse(200, okBody("hello from luna"), { "x-request-id": "req_777" })));
  const luna = new LunaClient({ apiKey: overrides.apiKey ?? API_KEY, ledger, fetchImpl });
  const events: GraphBridgeReceiptEvent[] = [];
  const app = express();
  app.disable("x-powered-by");
  if (overrides.withAppParser) app.use(express.json({ limit: "32kb" }));
  const { providerFetch: _p, apiKey: _k, withAppParser: _w, ...rest } = overrides;
  const bridge = mountGraphBridge(app, { luna, secret: BRIDGE_SECRET, ledger, onReceipt: (e) => events.push(e), ...rest });
  // A downstream "session" middleware that would grant access to anything reaching it; the bridge must never fall through to it.
  app.use((_req, res) => res.status(200).json({ fellThrough: true }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}${GRAPH_BRIDGE_PATH}`, fetchImpl, events, luna, bridge };
}

function chat(base: string, body: unknown, init: { token?: string | null; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers ?? {}) };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? BRIDGE_SECRET}`;
  return fetch(`${base}/chat/completions`, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
}

const validBody = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  messages: [
    { role: "system", content: "You extract entities." },
    { role: "user", content: SOURCE_TEXT },
  ],
  ...extra,
});

function providerBody(fetchImpl: Harness["fetchImpl"], call = 0): Record<string, unknown> {
  return JSON.parse(fetchImpl.mock.calls[call]![1].body as string);
}

function assertNoSecrets(value: unknown) {
  const dump = typeof value === "string" ? value : JSON.stringify(value);
  expect(dump).not.toContain(BRIDGE_SECRET);
  expect(dump).not.toContain(API_KEY);
  expect(dump).not.toContain("SECRET");
}

describe("configuration and auth", () => {
  it("is disabled unless configured: every route answers 404 and nothing reaches Luna or the ledger", async () => {
    const h = await harness({ secret: undefined });
    expect(h.bridge.enabled).toBe(false);
    const models = await fetch(`${h.base}/models`, { headers: { authorization: `Bearer ${BRIDGE_SECRET}` } });
    expect(models.status).toBe(404);
    expect((await models.json()).error.code).toBe("bridge_disabled");
    const res = await chat(h.base, validBody());
    expect(res.status).toBe(404);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);

    const off = await harness({ enabled: false });
    expect((await chat(off.base, validBody())).status).toBe(404);
    expect(off.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to mount enabled with a weak secret", async () => {
    const luna = new LunaClient({ apiKey: API_KEY, ledger, fetchImpl: vi.fn<FetchImpl>() });
    expect(() => mountGraphBridge(express(), { luna, secret: "short" })).toThrow(/32 characters/);
    expect(() => mountGraphBridge(express(), { luna, secret: undefined, enabled: true })).toThrow(/32 characters/);
    expect(JSON.stringify(mountGraphBridge(express(), { luna, secret: BRIDGE_SECRET }))).not.toContain(BRIDGE_SECRET);
  });

  it("requires the server bearer on every route, ignores browser session cookies and never falls through", async () => {
    const h = await harness();
    const cookie = { cookie: "replay_session=11111111-2222-4333-8444-555555555555" };

    const noAuth = await fetch(`${h.base}/models`, { headers: cookie });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Bearer");
    assertNoSecrets(await noAuth.text());

    const wrong = await chat(h.base, validBody(), { token: `${BRIDGE_SECRET.slice(0, -1)}x`, headers: cookie });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe("invalid_bearer");
    const cookieOnly = await chat(h.base, validBody(), { token: null, headers: cookie });
    expect(cookieOnly.status).toBe(401);
    const basic = await chat(h.base, validBody(), { token: null, headers: { authorization: `Basic ${Buffer.from(BRIDGE_SECRET).toString("base64")}` } });
    expect(basic.status).toBe(401);

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
    expect(h.events).toHaveLength(0);

    const ok = await fetch(`${h.base}/models`, { headers: { authorization: `Bearer ${BRIDGE_SECRET}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toMatchObject({ object: "list", data: [{ id: MODEL, object: "model" }] });
    expect((await fetch(`${h.base}/models/other`, { headers: { authorization: `Bearer ${BRIDGE_SECRET}` } })).status).toBe(404);
    expect((await fetch(`${h.base}/embeddings`, { method: "POST", headers: { authorization: `Bearer ${BRIDGE_SECRET}` } })).status).toBe(404);
  });
});

describe("native workload authorization", () => {
  const WORKLOAD_TOKEN = `workload-SECRET-${randomBytes(24).toString("hex")}`;
  const cookie = { cookie: "replay_session=11111111-2222-4333-8444-555555555555" };

  /** Stands in for verifyGraphitiWorkload: accepts exactly one header value, records what it saw. */
  function workloadStub(behaviour: (authorization: string) => Promise<boolean> = async (a) => a === `Bearer ${WORKLOAD_TOKEN}`) {
    return vi.fn<(authorization: string) => Promise<boolean>>(behaviour);
  }

  it("mounts enabled with no static secret when a workload validator is supplied, and only the validator can admit", async () => {
    const authorizeWorkload = workloadStub();
    const h = await harness({ secret: null, authorizeWorkload });
    expect(h.bridge.enabled).toBe(true);
    assertNoSecrets(h.bridge);

    const ok = await chat(h.base, validBody(), { token: WORKLOAD_TOKEN });
    expect(ok.status).toBe(200);
    expect(authorizeWorkload).toHaveBeenCalledTimes(1);
    expect(authorizeWorkload).toHaveBeenCalledWith(`Bearer ${WORKLOAD_TOKEN}`);
    expect(ledger.listReceipts()).toHaveLength(1);

    // The (unconfigured) static secret is not a credential on this mount.
    const stat = await chat(h.base, validBody(), { token: BRIDGE_SECRET });
    expect(stat.status).toBe(401);
    expect((await stat.json()).error.code).toBe("invalid_bearer");
    expect(authorizeWorkload).toHaveBeenLastCalledWith(`Bearer ${BRIDGE_SECRET}`);
    expect(ledger.listReceipts()).toHaveLength(1);
  });

  it("requires a bearer on every route: cookies alone never reach the validator and never fall through", async () => {
    const authorizeWorkload = workloadStub();
    const h = await harness({ secret: null, authorizeWorkload });

    const cookieOnly = await chat(h.base, validBody(), { token: null, headers: cookie });
    expect(cookieOnly.status).toBe(401);
    expect((await cookieOnly.json()).error.code).toBe("missing_bearer");
    const models = await fetch(`${h.base}/models`, { headers: cookie });
    expect(models.status).toBe(401);
    expect(models.headers.get("www-authenticate")).toContain("Bearer");
    const basic = await chat(h.base, validBody(), { token: null, headers: { authorization: `Basic ${Buffer.from(WORKLOAD_TOKEN).toString("base64")}`, ...cookie } });
    expect(basic.status).toBe(401);
    expect(authorizeWorkload).not.toHaveBeenCalled();

    // A cookie next to a rejected bearer does not help either.
    const wrong = await chat(h.base, validBody(), { token: `${WORKLOAD_TOKEN}x`, headers: cookie });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe("invalid_bearer");
    expect(authorizeWorkload).toHaveBeenCalledTimes(1);

    // Unknown routes under the bridge are the bridge's 404, not the downstream app.
    const unknown = await fetch(`${h.base}/embeddings`, { method: "POST", headers: { authorization: `Bearer ${WORKLOAD_TOKEN}`, ...cookie } });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("not_found");

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("treats a validator failure, rejection or throw as 401 and pays nothing", async () => {
    const authorizeWorkload = workloadStub(async () => { throw new Error(`platform down while checking ${WORKLOAD_TOKEN}`); });
    const h = await harness({ secret: null, authorizeWorkload });
    const res = await chat(h.base, validBody(), { token: WORKLOAD_TOKEN });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_bearer");
    expect(JSON.stringify(json)).not.toContain(WORKLOAD_TOKEN);
    assertNoSecrets(json);

    const denied = await harness({ secret: null, authorizeWorkload: workloadStub(async () => false) });
    expect((await chat(denied.base, validBody(), { token: WORKLOAD_TOKEN })).status).toBe(401);
    expect((await fetch(`${denied.base}/models`, { headers: { authorization: `Bearer ${WORKLOAD_TOKEN}` } })).status).toBe(401);

    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(denied.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("does not hand an oversized authorization header to the validator", async () => {
    const authorizeWorkload = workloadStub();
    const h = await harness({ secret: null, authorizeWorkload });
    // Node's default 16 KiB header budget answers 431 before Express runs; the bridge's own 16384 guard is the
    // backstop for a server mounted with a larger maxHeaderSize. Either way the validator must not be reached.
    const res = await chat(h.base, validBody(), { token: "a".repeat(16384) });
    expect([401, 431]).toContain(res.status);
    expect(authorizeWorkload).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("prefers the static secret when both are configured and consults the validator only for non-matching bearers", async () => {
    const authorizeWorkload = workloadStub();
    const h = await harness({ authorizeWorkload });
    expect((await chat(h.base, validBody())).status).toBe(200);
    expect(authorizeWorkload).not.toHaveBeenCalled();
    expect((await chat(h.base, validBody(), { token: WORKLOAD_TOKEN })).status).toBe(200);
    expect(authorizeWorkload).toHaveBeenCalledTimes(1);
    const wrong = await chat(h.base, validBody(), { token: `${BRIDGE_SECRET.slice(0, -1)}x` });
    expect(wrong.status).toBe(401);
    expect(authorizeWorkload).toHaveBeenCalledTimes(2);
    expect(ledger.listReceipts()).toHaveLength(2);
  });

  it("ignores a weak static secret when a validator is present rather than accepting it", async () => {
    const authorizeWorkload = workloadStub();
    const h = await harness({ secret: "short", enabled: true, authorizeWorkload });
    expect(h.bridge.enabled).toBe(true);
    const weak = await chat(h.base, validBody(), { token: "short" });
    expect(weak.status).toBe(401);
    expect(authorizeWorkload).toHaveBeenCalledWith("Bearer short");
    expect((await chat(h.base, validBody(), { token: WORKLOAD_TOKEN })).status).toBe(200);
  });

  it("stays disabled when explicitly disabled even with a validator, and the validator is never consulted", async () => {
    const authorizeWorkload = workloadStub();
    const h = await harness({ secret: null, enabled: false, authorizeWorkload });
    expect(h.bridge.enabled).toBe(false);
    expect((await chat(h.base, validBody(), { token: WORKLOAD_TOKEN })).status).toBe(404);
    expect(authorizeWorkload).not.toHaveBeenCalled();
  });

  it("keeps the workload under the same project ledger cap and bridge cap as any other caller", async () => {
    ledger.close();
    ledger = new BudgetLedger({ path: join(dir, "capped.sqlite"), maxUsd: 5, maxRequests: 0 });
    const h = await harness({ secret: null, authorizeWorkload: workloadStub() });
    const res = await chat(h.base, validBody(), { token: WORKLOAD_TOKEN });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("request_cap_exceeded");
    expect(h.fetchImpl).not.toHaveBeenCalled();

    const bridgeCapped = await harness({ secret: null, authorizeWorkload: workloadStub(), requestCount: () => 20 });
    const capped = await chat(bridgeCapped.base, validBody(), { token: WORKLOAD_TOKEN });
    expect(capped.status).toBe(429);
    expect((await capped.json()).error.code).toBe("graph_request_cap");
    expect(bridgeCapped.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("requested output token clamping", () => {
  const CAP = GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS;

  it("is off by default: an oversized request is still rejected before any reservation", async () => {
    const h = await harness();
    for (const body of [validBody({ max_tokens: CAP + 1 }), validBody({ max_completion_tokens: 100_000 })]) {
      const res = await chat(h.base, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("max_tokens_exceeded");
      expect(res.headers.get("x-replay-output-token-cap")).toBeNull();
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("when enabled, clamps oversized max_tokens and max_completion_tokens to the effective cap and advertises the cap", async () => {
    const h = await harness({ clampRequestedTokens: true });
    const a = await chat(h.base, validBody({ max_tokens: CAP + 1 }));
    expect(a.status).toBe(200);
    expect(a.headers.get("x-replay-output-token-cap")).toBe(String(CAP));
    expect(providerBody(h.fetchImpl, 0).max_output_tokens).toBe(CAP);

    const b = await chat(h.base, validBody({ max_completion_tokens: Number.MAX_SAFE_INTEGER, max_tokens: 1 }));
    expect(b.status).toBe(200);
    expect(providerBody(h.fetchImpl, 1).max_output_tokens).toBe(CAP);

    // Within the cap is passed through unchanged.
    const c = await chat(h.base, validBody({ max_tokens: 512 }));
    expect(c.status).toBe(200);
    expect(providerBody(h.fetchImpl, 2).max_output_tokens).toBe(512);
    expect(ledger.listReceipts()).toHaveLength(3);
  });

  it("clamps only integers above the cap; other invalid values are still rejected", async () => {
    const h = await harness({ clampRequestedTokens: true });
    const cases: Array<[Record<string, unknown>, string]> = [
      [validBody({ max_tokens: 10.5 }), "invalid_max_tokens"],
      [validBody({ max_tokens: 0 }), "invalid_max_tokens"],
      [validBody({ max_tokens: -5 }), "invalid_max_tokens"],
      [validBody({ max_tokens: String(CAP + 1) }), "invalid_max_tokens"],
      [validBody({ max_tokens: Number.MAX_SAFE_INTEGER + 2 }), "invalid_max_tokens"],
      [validBody({ max_tokens: CAP + 1, stream: true }), "stream_not_supported"],
      [validBody({ max_tokens: CAP + 1, messages: [{ role: "user", content: "x".repeat(GRAPH_MAX_MESSAGE_BYTES + 1) }] }), "messages_too_large"],
    ];
    for (const [body, code] of cases) {
      const res = await chat(h.base, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe(code);
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("never bypasses the project ledger or the bridge cap", async () => {
    ledger.close();
    ledger = new BudgetLedger({ path: join(dir, "capped.sqlite"), maxUsd: 5, maxRequests: 0 });
    const h = await harness({ clampRequestedTokens: true });
    const res = await chat(h.base, validBody({ max_tokens: CAP + 1 }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("request_cap_exceeded");
    expect(h.fetchImpl).not.toHaveBeenCalled();

    const bridgeCapped = await harness({ clampRequestedTokens: true, requestCount: () => 20 });
    const capped = await chat(bridgeCapped.base, validBody({ max_tokens: CAP + 1 }));
    expect(capped.status).toBe(429);
    expect((await capped.json()).error.code).toBe("graph_request_cap");
    expect(bridgeCapped.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not relax authentication: an unauthenticated clamped request is still 401 before the body is read", async () => {
    const h = await harness({ clampRequestedTokens: true });
    const res = await chat(h.base, validBody({ max_tokens: CAP + 1 }), { token: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-replay-output-token-cap")).toBeNull();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("request validation pays nothing", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["stream", validBody({ stream: true }), "stream_not_supported"],
    ["tools", validBody({ tools: [{ type: "function", function: { name: "f" } }] }), "unsupported_parameter"],
    ["functions", validBody({ functions: [{ name: "f" }] }), "unsupported_parameter"],
    ["n > 1", validBody({ n: 2 }), "multiple_choices_not_supported"],
    ["unexpected model", validBody({ model: "gpt-5.6-sol" }), "model_not_supported"],
    ["missing model", { messages: validBody().messages }, "model_not_supported"],
    ["max_tokens over cap", validBody({ max_tokens: GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS + 1 }), "max_tokens_exceeded"],
    ["max_completion_tokens over 4096", validBody({ max_completion_tokens: 4097 }), "max_tokens_exceeded"],
    ["non-integer max_tokens", validBody({ max_tokens: 10.5 }), "invalid_max_tokens"],
    ["empty messages", validBody({ messages: [] }), "messages_required"],
    ["tool role", validBody({ messages: [{ role: "tool", content: "x", tool_call_id: "c" }] }), "unsupported_role"],
    ["image part", validBody({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] }] }), "unsupported_content"],
    ["assistant tool_calls", validBody({ messages: [{ role: "assistant", content: null, tool_calls: [] }] }), "unsupported_parameter"],
    ["bad response_format", validBody({ response_format: { type: "xml" } }), "invalid_response_format"],
    ["schema without name", validBody({ response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } } }), "invalid_response_format"],
    ["oversize messages", validBody({ messages: [{ role: "user", content: "x".repeat(GRAPH_MAX_MESSAGE_BYTES + 1) }] }), "messages_too_large"],
    ["array body", [validBody()] as unknown as Record<string, unknown>, "invalid_body"],
  ];

  it.each(cases)("rejects %s with 400 before any reservation", async (_label, body, code) => {
    const h = await harness();
    const res = await chat(h.base, body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatchObject({ type: "invalid_request_error", code });
    assertNoSecrets(json);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("rejects malformed JSON and over-limit bodies without echoing them", async () => {
    const h = await harness();
    const bad = await chat(h.base, null, { raw: `{"model": "${MODEL}", "messages": [ SECRET-not-json` });
    expect(bad.status).toBe(400);
    const badJson = await bad.json();
    expect(badJson.error.code).toBe("invalid_json_body");
    assertNoSecrets(badJson);

    const huge = await chat(h.base, validBody({ messages: [{ role: "user", content: "y".repeat(100 * 1024) }] }));
    expect(huge.status).toBe(413);
    expect((await huge.json()).error.code).toBe("request_too_large");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("does not leak a paid slot for invalid requests and works behind an app-level JSON parser", async () => {
    const h = await harness({ withAppParser: true });
    expect((await chat(h.base, validBody({ stream: true }))).status).toBe(400);
    const ok = await chat(h.base, validBody());
    expect(ok.status).toBe(200);
    expect(h.bridge.state()).toMatchObject({ active: 0, requestsUsed: 1 });
  });
});

describe("completions", () => {
  it("maps ordered messages to instructions + transcript and returns a completion with usage from the receipt", async () => {
    const h = await harness();
    const res = await chat(h.base, {
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: "You extract entities." },
        { role: "developer", content: [{ type: "text", text: "Be terse." }, { type: "text", text: "Use JSON keys." }] },
        { role: "user", content: SOURCE_TEXT },
        { role: "assistant", content: "Earlier answer." },
        { role: "system", content: "Late reminder." },
        { role: "user", content: "Continue." },
      ],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const receipt = ledger.listReceipts()[0]!;
    expect(res.headers.get(RECEIPT_HEADER)).toBe(receipt.id);
    expect(json).toMatchObject({
      id: `chatcmpl-${receipt.id}`,
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello from luna" } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } },
      replay: { receipt_id: receipt.id, receipt_status: "completed", model_returned: "gpt-5.6-luna-2026-08-01", usage_known: true },
    });
    expect(typeof json.created).toBe("number");

    const sent = providerBody(h.fetchImpl);
    expect(sent.model).toBe(MODEL);
    expect(sent.instructions).toBe("You extract entities.\n\nBe terse.\nUse JSON keys.");
    expect(sent.input).toBe(`[user]\n${SOURCE_TEXT}\n\n[assistant]\nEarlier answer.\n\n[system]\nLate reminder.\n\n[user]\nContinue.`);
    expect(sent.text).toBeUndefined();
    expect(sent.max_output_tokens).toBe(1000);
    expect(sent).not.toHaveProperty("temperature");

    // Ledger row is the project's, with the bridge purpose and no source content.
    expect(receipt).toMatchObject({ status: "completed", purpose: "graph.bridge", inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, modelRequested: MODEL });
    expect(JSON.stringify(receipt)).not.toContain(SOURCE_TEXT);

    // Callback: redacted receipt + purpose, no content, no secrets.
    expect(h.events).toHaveLength(1);
    const ev = h.events[0]!;
    expect(ev).toMatchObject({ purpose: "graph.bridge", outcome: "completed", httpStatus: 200, receiptId: receipt.id, responseFormat: "text" });
    expect(ev.receipt).toMatchObject({ id: receipt.id, status: "completed", inputTokens: 120 });
    expect(ev.receipt).not.toHaveProperty("context");
    expect(JSON.stringify(ev)).not.toContain(SOURCE_TEXT);
    assertNoSecrets(ev);
  });

  it("passes max_completion_tokens through within the cap", async () => {
    const h = await harness();
    expect((await chat(h.base, validBody({ max_completion_tokens: 512, max_tokens: 9 }))).status).toBe(200);
    expect(providerBody(h.fetchImpl).max_output_tokens).toBe(512);
    expect(GRAPH_EFFECTIVE_MAX_COMPLETION_TOKENS).toBeLessThanOrEqual(Math.min(4096, MAX_OUTPUT_TOKENS_CEILING));
  });

  it("honours the json_schema contract as a strict Luna schema and returns the JSON text", async () => {
    const h = await harness({ providerFetch: async () => jsonResponse(200, okBody('{"entities":[{"name":"Kamiwaza"}]}')) });
    const schema = { type: "object", properties: { entities: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } } }, required: ["entities"], additionalProperties: false };
    const res = await chat(h.base, validBody({ response_format: { type: "json_schema", json_schema: { name: "ExtractedEntities", strict: false, description: "Entities", schema } } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.parse(json.choices[0].message.content)).toEqual({ entities: [{ name: "Kamiwaza" }] });
    expect(providerBody(h.fetchImpl).text).toEqual({ format: { type: "json_schema", name: "ExtractedEntities", schema, strict: true, description: "Entities" } });
    expect(h.events[0]).toMatchObject({ responseFormat: "json_schema", outcome: "completed" });
    expect(ledger.get(res.headers.get(RECEIPT_HEADER)!)?.context).toMatchObject({ bridge: "graph", schemaName: "ExtractedEntities", messages: 2 });
  });

  it("supports json_object by instruction only, validating JSON afterward and surfacing bad output with its receipt", async () => {
    let reply = '{"ok":true}';
    const h = await harness({ providerFetch: async () => jsonResponse(200, okBody(reply)) });
    const good = await chat(h.base, validBody({ response_format: { type: "json_object" } }));
    expect(good.status).toBe(200);
    expect((await good.json()).choices[0].message.content).toBe('{"ok":true}');
    const sent = providerBody(h.fetchImpl);
    expect(sent.text).toBeUndefined(); // no pretend strict schema
    expect(String(sent.instructions)).toContain("exactly one valid JSON object");
    expect(String(sent.instructions).startsWith("You extract entities.")).toBe(true);

    reply = "Sure! Here is JSON: {oops";
    const bad = await chat(h.base, validBody({ response_format: { type: "json_object" } }));
    expect(bad.status).toBe(502);
    const body = await bad.json();
    expect(body.error).toMatchObject({ code: "invalid_json_output", type: "server_error" });
    expect(body.error.message).not.toContain("oops");
    const receiptId = bad.headers.get(RECEIPT_HEADER)!;
    expect(body.error.receipt_id).toBe(receiptId);
    expect(ledger.get(receiptId)?.status).toBe("completed"); // the paid call remains on the books
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", code: "invalid_json_output", receiptId, responseFormat: "json_object" });
  });
});

describe("denials and failures", () => {
  it("does not bypass a ledger denial and pays nothing", async () => {
    ledger.close();
    ledger = new BudgetLedger({ path: join(dir, "capped.sqlite"), maxUsd: 5, maxRequests: 0 });
    const h = await harness();
    const res = await chat(h.base, validBody());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatchObject({ type: "rate_limit_error", code: "request_cap_exceeded" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
    expect(h.events).toEqual([expect.objectContaining({ outcome: "failed", code: "request_cap_exceeded", receiptId: null })]);
  });

  it("answers 503 without touching the ledger when no provider key is configured", async () => {
    const h = await harness({ apiKey: "" });
    const res = await chat(h.base, validBody());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("missing_credentials");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(0);
  });

  it("relays a provider denial safely: sanitized code only, receipt released, nothing from the provider body", async () => {
    const h = await harness({
      providerFetch: async () => jsonResponse(429, { error: { code: "rate_limit_exceeded", message: `Your key ${API_KEY} is SECRET-throttled` } }, { "x-request-id": "req_denied" }),
    });
    const res = await chat(h.base, validBody());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatchObject({ code: "provider_error", provider_code: "rate_limit_exceeded" });
    expect(json.error.message).not.toContain("throttled");
    assertNoSecrets(json);
    const receipt = ledger.listReceipts()[0]!;
    expect(receipt).toMatchObject({ status: "failed", settledMicro: 0, errorCode: "http_429", providerRequestId: "req_denied" });
    expect(res.headers.get(RECEIPT_HEADER)).toBe(receipt.id);
    expect(h.events[0]).toMatchObject({ outcome: "failed", code: "provider_error", receiptId: receipt.id, receipt: expect.objectContaining({ status: "failed" }) });
    assertNoSecrets(h.events);
  });

  it("maps a malformed provider result to 502 and keeps the receipt visible", async () => {
    const h = await harness({ providerFetch: async () => jsonResponse(200, { id: "resp_x", output: [], usage: { input_tokens: 5, output_tokens: 0 } }) });
    const res = await chat(h.base, validBody());
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("malformed_response");
    expect(ledger.listReceipts()[0]).toMatchObject({ status: "completed", id: res.headers.get(RECEIPT_HEADER) });

    const broken = await harness({ providerFetch: async () => new Response("<html>SECRET</html>", { status: 200, headers: { "content-type": "text/html" } }) });
    const res2 = await chat(broken.base, validBody());
    expect(res2.status).toBe(502);
    const json2 = await res2.json();
    expect(json2.error.code).toBe("malformed_response");
    assertNoSecrets(json2);
    expect(ledger.get(res2.headers.get(RECEIPT_HEADER)!)?.status).toBe("uncertain");
  });

  it("maps a network failure to 502 with the retained reservation", async () => {
    const h = await harness({
      providerFetch: async () => {
        throw new Error(`ECONNRESET talking to provider with ${API_KEY}`);
      },
    });
    const res = await chat(h.base, validBody());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("network_error");
    assertNoSecrets(json);
    expect(ledger.listReceipts()[0]?.status).toBe("uncertain");
  });
});

describe("caps", () => {
  it("allows one active request; a concurrent one is answered 429 without a reservation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await harness({
      providerFetch: async () => {
        await gate;
        return jsonResponse(200, okBody("done"));
      },
    });
    const first = chat(h.base, validBody());
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(1));
    expect(h.bridge.state().active).toBe(1);

    const second = await chat(h.base, validBody());
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect((await second.json()).error.code).toBe("concurrency_limited");
    expect(ledger.listReceipts()).toHaveLength(1);

    release();
    expect((await first).status).toBe(200);
    expect(h.bridge.state().active).toBe(0);
    expect((await chat(h.base, validBody())).status).toBe(200);
    expect(ledger.listReceipts()).toHaveLength(2);
  });

  it("enforces the cumulative bridge cap from the shared ledger, counting failures and surviving a remount", async () => {
    const h = await harness({ maxGraphRequests: 2, providerFetch: async () => jsonResponse(429, { error: { code: "rate_limit_exceeded" } }) });
    expect((await chat(h.base, validBody())).status).toBe(502);
    expect((await chat(h.base, validBody())).status).toBe(502);
    const third = await chat(h.base, validBody());
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe("graph_request_cap");
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(h.bridge.state()).toMatchObject({ requestsUsed: 2, remainingRequests: 0 });

    // A fresh mount over the same ledger inherits the count; a different purpose does not.
    const again = await harness({ maxGraphRequests: 2 });
    expect((await chat(again.base, validBody())).status).toBe(429);
    expect(again.fetchImpl).not.toHaveBeenCalled();
    const other = await harness({ maxGraphRequests: 2, purpose: "graph.other" });
    expect((await chat(other.base, validBody())).status).toBe(200);
    expect(ledger.listReceipts().map((r) => r.purpose)).toEqual(["graph.bridge", "graph.bridge", "graph.other"]);
  });

  it("prefers a caller-supplied counter and falls back to an in-memory count without a ledger", async () => {
    let count = 19;
    const counted = await harness({ requestCount: () => count });
    expect((await chat(counted.base, validBody())).status).toBe(200);
    count = 20;
    expect((await chat(counted.base, validBody())).status).toBe(429);

    const memory = await harness({ ledger: undefined, maxGraphRequests: 1 });
    expect((await chat(memory.base, validBody())).status).toBe(200);
    expect((await chat(memory.base, validBody())).status).toBe(429);
    expect(memory.bridge.state()).toMatchObject({ requestsUsed: 1, remainingRequests: 0 });
  });
});

 it('serializes native extraction without duplicate retries and rechecks cumulative caps after queueing',async()=>{
   let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let calls=0;
   const h=await harness({maxQueuedRequests:2,maxGraphRequests:1,providerFetch:async()=>{calls++;entered();await new Promise<void>(r=>release=r);return jsonResponse(200,okBody('actual result'));}});
   const first=chat(h.base,validBody());await started;const second=chat(h.base,validBody());await new Promise(r=>setTimeout(r,30));expect(calls).toBe(1);release();expect((await first).status).toBe(200);const denied=await second;expect(denied.status).toBe(429);expect((await denied.json()).error.code).toBe('graph_request_cap');expect(calls).toBe(1);expect(h.bridge.state().active).toBe(0);
 });
