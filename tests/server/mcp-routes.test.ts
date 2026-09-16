import {createPresetCatalog} from '../../src/catalog/seed';
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { GameService, type Identity } from "../../src/server/service";
import { McpBearerResolver, McpAuthError } from "../../src/server/mcp-auth";
import { mountMcpRoutes } from "../../src/server/mcp-routes";
import { McpService } from "../../src/server/mcp-service";
import type { KamiwazaConfig } from "../../src/server/native-http";
import type { FetchImpl } from "../../src/platform";

console.debug = () => {};
const ROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
// Synthetic fixtures only. No real platform calls or credentials.
const TOKEN = "mcp-owner-fixture-0123456789";
const PEER_TOKEN = "mcp-peer-fixture-0123456789";
const SIGNATURE = "mcp-signature-fixture";
const owner: Identity = { subject: "owner", name: "Owner", role: "commander", organization: "Test", mode: "kamiwaza" };
const peer: Identity = { ...owner, subject: "peer", name: "Peer" };
const config: KamiwazaConfig = { mode: "kamiwaza", apiBase: "https://platform.example/api", workroomId: ROOM, forwardedHost: "platform.example", forwardedProto: "https", allowedOrigins: [], cookieSecure: true, allowLegacyRecordings: false };
const initialize = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kaizen", version: "1.0" } };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

async function setup(enableWatchTool=false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-mcp-routes-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new GameService(dir);
  cleanups.push(() => service.close());
  await service.init(false);
  service.baseline = () => {};
  const create = async (name: string, identity = owner, workroomId = ROOM) => {
    const row = await service.create(name, "plains");
    row.options = { ...row.options, ownerSubject: identity.subject, workroomId };
    service.store.putExercise(row);
    service.teams.enroll(row, identity, 1);
    return row;
  };
  const state = { blocked: false, signedScope: ROOM, signedSubject: null as string | null, omitSignature: false, role: "editor", revoked: false, writable:false };
  const platform = vi.fn<FetchImpl>(async (url, init) => {
    const h = new Headers(init.headers);
    const token = h.get("authorization")?.slice(7);
    const subject = token === TOKEN ? owner.subject : token === PEER_TOKEN ? peer.subject : null;
    if (!subject || state.revoked) return new Response("{}", { status: 401 });
    const target = new URL(url).pathname;
    if (target === "/api/auth/forward/validate") return new Response(null, { headers: {
      "x-user-id": state.signedSubject ?? subject, "x-workroom-id": state.signedScope,
      "x-user-name": subject, ...(state.omitSignature ? {} : { "x-user-signature": SIGNATURE }),
    } });
    expect(h.get("x-user-signature")).toBe(SIGNATURE);
    if (target === `/api/workrooms/${ROOM}/runtime/context`) return Response.json({
      workroom_id: ROOM, user_id: subject, effective_workroom_role: state.role,
      workroom_lifecycle_state: "active", interaction_mode: state.blocked ? "blocked" : state.writable ? "read_write" : "read_only",
      access_state: "active", can_edit: state.writable, can_share: false, can_run_agents: false,
    });
    if (target === `/api/workrooms/${ROOM}`) return Response.json({ id: ROOM, tenant_id: "test", owner_user_id: "someone-else", name: "Test room", type: "standard", status: "active", created_at: "2026-09-13T00:00:00Z", attributes: {} });
    throw new Error("Unexpected platform operation");
  });
  const auth = new McpBearerResolver({ apiBase: config.apiBase, workroomId: ROOM, forwardedHost: config.forwardedHost, fetchImpl: platform });
  const tools = new McpService({ service, config });
  const app = express();
  mountMcpRoutes(app, { service, config, auth, tools, enableWatchTool, version: "test" });
  // MCP must finish before any browser-session middleware is reached.
  const sessionMiddleware = vi.fn((_req, res) => res.status(500).end("browser session reached"));
  app.use(sessionMiddleware);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const post = async (body: unknown, headers: Record<string, string> = {}, raw = false) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, "x-workroom-id": ROOM, ...headers }, body: raw ? String(body) : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
  };
  const rpc = (method: string, params?: unknown, headers?: Record<string, string>) => post({ jsonrpc: "2.0", id: 7, method, ...(params === undefined ? {} : { params }) }, headers);
  const call = (name: string, args: unknown = {}, headers?: Record<string, string>) => rpc("tools/call", { name, arguments: args }, headers);
  const payload = (result: Awaited<ReturnType<typeof post>>) => {
    expect(result.status).toBe(200);
    expect(result.body.result.isError).toBe(false);
    expect(JSON.parse(result.body.result.content[0].text)).toEqual(result.body.result.structuredContent);
    return result.body.result.structuredContent;
  };
  return { service, create, auth, tools, state, platform, sessionMiddleware, url, post, rpc, call, payload };
}

describe("POST /mcp Tomo transport", () => {
  it("initializes, acknowledges notification, lists and calls every read tool with fresh native auth", async () => {
    const h = await setup();
    const row = await h.create("Visible");
    const before = h.service.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get();
    const init = await h.rpc("initialize", initialize);
    expect(init.body).toMatchObject({ jsonrpc: "2.0", id: 7, result: { protocolVersion: "2025-03-26", serverInfo: { name: "replay", version: "test" }, capabilities: { tools: { listChanged: false } } } });
    expect(init.body.result.instructions).toContain("scripted or model-driven");
    const notification = await h.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    expect(notification.text).toBe("");
    const list = await h.rpc("tools/list");
    expect(list.body.result.tools).toHaveLength(10);
    expect(h.platform).toHaveBeenCalledTimes(12); // validate + target twice for each request
    for (const tool of list.body.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const output = await h.call(tool.name, tool.name === "get_catalog_record" ? {recordId: createPresetCatalog().records.find(r=>r.kind==="persona")!.id} : tool.inputSchema.required.includes("exerciseId") ? { exerciseId: row.id } : {});
      const data = h.payload(output);
      if (tool.name === "list_exercises") expect(data.exercises.map((e: any) => e.id)).toEqual([row.id]);
      else if(tool.name === "search_catalog") expect(data).toMatchObject({schema:"replay.catalog-page/1",scope:"shared preset references; not the caller\'s actual history"});
      else if(tool.name === "get_catalog_record") expect(data.record.provenance).toBe("synthetic");
      else if(tool.name === "search_practice_details") expect(data).toMatchObject({schema:"replay.practice-history/2",items:[],scope:"mine"});
      else if(tool.name === "search_practice_history") expect(data).toMatchObject({schema:"replay.practice-history/1",items:[],scope:"mine"});
      else expect(data.provenance).toMatchObject({ fiction: true, exerciseId: row.id, position: "live" });
      expect(output.headers.get("cache-control")).toBe("no-store");
      expect(output.headers.get("set-cookie")).toBeNull();
      expect(output.headers.get("mcp-session-id")).toBeNull();
      expect(output.headers.get("content-type")).toContain("application/json");
      for (const secret of [TOKEN, SIGNATURE]) expect(output.text).not.toContain(secret);
    }
    expect(h.platform).toHaveBeenCalledTimes(60); // extra fresh auth for the two engine reads
    expect(h.sessionMiddleware).not.toHaveBeenCalled();
    expect(h.service.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before);
    expect(h.service.ledger.summary().requestsUsed).toBe(0);
    expect((await h.rpc("initialize", { ...initialize, protocolVersion: "unknown" })).body.result.protocolVersion).toBe("2025-06-18");
  });

  it.each(["initialize", "notifications/initialized", "tools/list", "tools/call"])("requires bearer and workroom even for %s", async (method) => {
    const h = await setup();
    const request = { jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: 1 }), method, params: method === "initialize" ? initialize : undefined };
    const missing = await h.post(request, { authorization: "", cookie: `access_token=${TOKEN}`, "x-auth-token": TOKEN, "x-user-id": owner.subject, "x-user-workroom-role": "owner" });
    expect(missing.status).toBe(401);
    expect(missing.body.error.data.code).toBe("missing_bearer");
    for (const room of ["", "different-room-0000"]) {
      const wrong = await h.post(request, { "x-workroom-id": room });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.data.code).toBe("workroom_mismatch");
    }
    expect(h.platform).not.toHaveBeenCalled();
  });

  it("denies invalid bearers, missing signatures, signed mismatches and blocked contexts", async () => {
    const h = await setup();
    expect((await h.rpc("tools/list", undefined, { authorization: "Bearer invalid-fixture-token" })).status).toBe(401);
    for (const [patch, status, code] of [
      [{ omitSignature: true }, 503, "platform_unavailable"],
      [{ signedScope: "wrong-signed-room" }, 403, "workroom_mismatch"],
      [{ signedSubject: "other-subject" }, 403, "subject_mismatch"],
      [{ blocked: true }, 403, "access_blocked"],
    ] as const) {
      const before = { ...h.state };
      Object.assign(h.state, patch);
      const result = await h.rpc("tools/list");
      expect(result.status).toBe(status);
      expect(result.body.error.data.code).toBe(code);
      Object.assign(h.state, before);
    }
  });

  it("scopes each caller independently and makes unknown, hidden and foreign-room exercises identical", async () => {
    const h = await setup();
    const own = await h.create("Owner-only");
    const theirs = await h.create("Peer-only", peer);
    const foreign = await h.create("Foreign", owner, "foreign-room-0000");
    const peerHeaders = { authorization: `Bearer ${PEER_TOKEN}`, "x-user-id": owner.subject, "x-user-workroom-role": "owner" };
    expect(h.payload(await h.call("list_exercises", {}, peerHeaders)).exercises.map((e: any) => e.id)).toEqual([theirs.id]);
    for (const tool of h.tools.tools().filter((t) => t.inputSchema.required.includes("exerciseId"))) {
      const hidden = await h.call(tool.name, { exerciseId: own.id }, peerHeaders);
      const absent = await h.call(tool.name, { exerciseId: UNKNOWN }, peerHeaders);
      const otherRoom = await h.call(tool.name, { exerciseId: foreign.id });
      expect(hidden.body).toEqual(absent.body);
      expect(otherRoom.body).toEqual(absent.body);
      expect(hidden.body.result).toMatchObject({ isError: true, content: [{ type: "text", text: "exercise_not_found: Exercise not found" }] });
      expect(hidden.text).not.toContain(own.id);
    }
    h.service.teams.enroll(own, peer, 1);
    expect(h.payload(await h.call("get_exercise_state", { exerciseId: own.id }, peerHeaders)).exercise.id).toBe(own.id);
  });

  it("rejects malformed JSON, oversized bodies, batches, unsupported HTTP and invalid RPC shapes", async () => {
    const h = await setup();
    expect((await h.post('{"opaque-secret":', {}, true)).body.error.code).toBe(-32700);
    const tooLarge = await h.post({ x: "x".repeat(20_000) });
    expect(tooLarge.status).toBe(413);
    for (const body of [[], {}, { jsonrpc: "1.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: {}, method: "tools/list" }, { jsonrpc: "2.0", id: 1, method: "tools/list", subject: owner.subject }]) {
      const result = await h.post(body);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe(-32600);
    }
    const get = await fetch(h.url);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(h.platform).not.toHaveBeenCalled();
  });

  it("rejects invalid initialize/list/call arguments and never treats notification names with IDs as notifications", async () => {
    const h = await setup();
    const row = await h.create("Args");
    for (const params of [undefined, [], { protocolVersion: 42 }, { ...initialize, subject: owner.subject }]) expect((await h.rpc("initialize", params)).body.error.code).toBe(-32602);
    expect((await h.rpc("tools/list", { workroomId: ROOM })).body.error.code).toBe(-32602);
    for (const params of [{}, { name: "get_exercise_state", arguments: [] }, { name: "list_exercises", subject: owner.subject }, { name: "submit_order" }]) expect((await h.rpc("tools/call", params)).body.error.code).toBe(-32602);
    for (const args of [{}, { exerciseId: "../hidden" }, { exerciseId: row.id, tick: -1 }, { exerciseId: row.id, tick: 1.5 }, { exerciseId: row.id, subject: owner.subject }, { exerciseId: row.id, workroomId: ROOM }, { exerciseId: row.id, side: "red" }]) expect((await h.call("get_exercise_state", args)).body.error.code).toBe(-32602);
    expect((await h.call("get_key_moments", { exerciseId: row.id, limit: 13 })).body.error.code).toBe(-32602);
    expect((await h.rpc("notifications/initialized")).body.error.code).toBe(-32601);
    expect((await h.call("get_exercise_state", { exerciseId: row.id, tick: 999 })).body.result.isError).toBe(true);
  });

  it("does not echo opaque adapter exceptions or arbitrary method/tool names", async () => {
    const h = await setup();
    const secret = "opaque-not-regex-detectable-value";
    const resolve = vi.spyOn(h.auth, "resolve");
    resolve.mockRejectedValueOnce(new Error(secret));
    resolve.mockRejectedValueOnce(new McpAuthError("platform_unavailable", 503, secret, { requestId: secret }));
    for (let i = 0; i < 2; i++) {
      const result = await h.rpc("tools/list");
      expect(result.status).toBe(503);
      expect(result.text).not.toContain(secret);
    }
    expect((await h.rpc(secret)).text).not.toContain(secret);
    expect((await h.call(secret)).text).not.toContain(secret);
    vi.spyOn(h.tools, "call").mockRejectedValueOnce(new Error(secret));
    const failed = await h.call("list_exercises");
    expect(failed.body.result.isError).toBe(true);
    expect(failed.text).not.toContain(secret);
  });


  it("returns historical state/provenance without future fingerprints or counts and enforces output bounds", async () => {
    const h = await setup();
    const row = await h.create("History");
    const before = h.payload(await h.call("get_replay_provenance", { exerciseId: row.id, tick: 1 }));
    for (let i = 0; i < 5; i++) h.service.tick(h.service.world(row.id));
    const past = h.payload(await h.call("get_exercise_state", { exerciseId: row.id, tick: 1 }));
    const after = h.payload(await h.call("get_replay_provenance", { exerciseId: row.id, tick: 1 }));
    expect(past.state.fingerprint).toBe(before.record.cutoffFingerprint);
    expect(after.record).toEqual(before.record);
    expect(after.record.latestTick).toBe(1);
    expect(JSON.stringify(after)).not.toContain(h.service.store.turns(row.id).at(-1)!.fingerprint);
    for (let i = 0; i < 100; i++) h.service.store.event(row.id, 1, "assessment_log", owner.subject, "summary", { text: "x".repeat(2000) }, "blue");
    const oversized = await h.call("get_team_assessments", { exerciseId: row.id });
    expect(oversized.body.result.isError).toBe(true);
    expect(oversized.text.length).toBeLessThan(1000);
    expect(oversized.text).not.toContain("x".repeat(100));
  });

  it.each(["membership", "native revocation", "instructor demotion", "subject change"])("refuses a deferred restore after %s", async (change) => {
    const h = await setup();
    const row = await h.create("Race");
    if (change === "membership") h.service.teams.enroll(row, peer, 1);
    if (change === "instructor demotion") h.state.role = "owner";
    const headers = { authorization: `Bearer ${PEER_TOKEN}` };
    // Other race cases use the owner so initial authorization succeeds.
    if (change !== "membership" && change !== "instructor demotion") headers.authorization = `Bearer ${TOKEN}`;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const historical = h.service.historical.bind(h.service);
    vi.spyOn(h.service, "historical").mockImplementationOnce(async (id, tick) => { entered(); await gate; return historical(id, tick); });
    const pending = h.call("get_exercise_state", { exerciseId: row.id, tick: 1 }, headers);
    await started;
    if (change === "membership") h.service.teams.remove(row, peer.subject, owner.subject);
    if (change === "native revocation") h.state.revoked = true;
    if (change === "instructor demotion") h.state.role = "viewer";
    if (change === "subject change") h.state.signedSubject = "different-subject";
    release();
    const result = await pending;
    if (change === "native revocation") expect(result.status).toBe(401);
    else if (change === "subject change") expect(result.status).toBe(403);
    else expect(result.body.result.isError).toBe(true);
    expect(result.text).not.toContain('"fingerprint"');
    expect(h.sessionMiddleware).not.toHaveBeenCalled();
  });
});

describe('optional MCP free watch',()=>{
 it('advertises a write explicitly and respects read-only native access',async()=>{
  const h=await setup(true),row=await h.create('Watch fixture');
  const catalog=(await h.rpc('tools/list')).body.result.tools;expect(catalog).toHaveLength(11);expect(catalog.find((t:any)=>t.name==='create_watch').annotations.readOnlyHint).toBe(false);
  const denied=await h.call('create_watch',{exerciseId:row.id,requestId:'69e8b5ae-27f8-4b7c-97c4-5e283a967122',title:'Monitor report provenance'});
  expect(denied.body.result.isError).toBe(true);expect(h.service.store.tasks(row.id)).toHaveLength(0);
 });
 it('creates one durable free watch on an authenticated native caller and safely repeats the request',async()=>{
  const h=await setup(true),row=await h.create('Watch fixture');h.state.writable=true;
  const args={exerciseId:row.id,requestId:'69e8b5ae-27f8-4b7c-97c4-5e283a967122',title:'Monitor report provenance'};
  const first=h.payload(await h.call('create_watch',args)),second=h.payload(await h.call('create_watch',args));
  expect(first.task.modelEnabled).toBe(false);expect(first.task.id).toBe(second.task.id);expect(second.receipt.replayed).toBe(true);expect(h.service.store.tasks(row.id)).toHaveLength(1);
 });
});
