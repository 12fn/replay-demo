import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { GameService, type Identity, type Session } from "../../src/server/service";
import { KamiwazaError, type AddKnowledgeRequest, type RequestReceipt, type RequestSpec } from "../../src/platform/index.ts";
import { DEFAULT_HEALTH_CACHE_MS, OntologyConfigError, mountOntologyRoutes, parseSubgraph, readOntologyConfig, type PublishRecord } from "../../src/server/ontology-routes.ts";
import { DOMAIN_ONTOLOGY, ingestionKey, sourceHash } from "../../src/ontology/index.ts";

console.debug = () => {};

const WORKROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const OTHER_WORKROOM = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const ONTOLOGY = "f6e5e895-5673-40d2-a34b-0bf4343f362f";
const TOKEN_MARKER = "access-token-SECRET-never-serialized";

const instructor: Identity = { subject: "sub-instructor", name: "Instructor", role: "instructor", organization: "Decision Advantage Workroom", mode: "kamiwaza" };
const commander: Identity = { subject: "sub-commander", name: "Commander", role: "commander", organization: "Decision Advantage Workroom", mode: "kamiwaza" };
const local: Identity = { subject: "user-alpha", name: "Alpha", role: "instructor", organization: "NPS training workspace", mode: "local-demo" };

// ---------------------------------------------------------------------------
// Fake platform client: scripted answers, call log, never a real network hop
// ---------------------------------------------------------------------------

function receipt(method: "GET" | "POST", p: string, status = 200): RequestReceipt {
  return { clientRequestId: `c-${Math.random().toString(36).slice(2, 8)}`, requestId: `req-${p.split("/").slice(-1)[0]}-${status}`, target: { method, path: p }, status, durationMs: 4, validatedAt: "2026-09-13T12:00:00.000Z", signatureTs: "1789280140" };
}

class FakeClient {
  readonly token = TOKEN_MARKER;
  readonly healthCalls: { id: string; workroomId: string | null | undefined }[] = [];
  readonly requestCalls: RequestSpec[] = [];
  readonly knowledgeCalls: { id: string; req: AddKnowledgeRequest; workroomId: string | null | undefined }[] = [];
  health: unknown = { state: "ready", name: "graphiti" };
  healthError: Error | null = null;
  subgraph: unknown = { nodes: [], edges: [], truncated: false, sources: [] };
  subgraphError: Error | null = null;
  knowledge: (req: AddKnowledgeRequest) => Promise<{ added_count: number; group_id: string; result?: Record<string, unknown> | null; error?: string | null }> = async (req) => ({ added_count: req.messages.length, group_id: req.group_id, result: { episodes: 1 } });
  /** Called synchronously inside addKnowledge, before it resolves. */
  onKnowledge: (() => void) | null = null;

  async ontologyHealth(id: string, opts: { workroomId?: string | null } = {}) {
    this.healthCalls.push({ id, workroomId: opts.workroomId });
    if (this.healthError) throw this.healthError;
    return { data: this.health, identity: ident(), receipt: receipt("GET", `/context/ontologies/${id}/health`) };
  }
  async request(spec: RequestSpec) {
    this.requestCalls.push(spec);
    if (this.subgraphError) throw this.subgraphError;
    return { data: this.subgraph, identity: ident(), receipt: receipt("GET", spec.path) };
  }
  async addKnowledge(id: string, req: AddKnowledgeRequest, opts: { workroomId?: string | null } = {}) {
    this.knowledgeCalls.push({ id, req, workroomId: opts.workroomId });
    this.onKnowledge?.();
    const data = await this.knowledge(req);
    return { data, identity: ident(), receipt: receipt("POST", `/context/ontologies/${id}/knowledge`) };
  }
}

function ident() {
  return { userId: "sub-instructor", userName: "Instructor", roles: ["user"], workroomId: WORKROOM, workroomRole: "owner" };
}

// ---------------------------------------------------------------------------
// Harness: session + native context from headers (production sets them server-side)
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const services: GameService[] = [];
const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const srv of servers.splice(0)) srv.close();
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function service() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "replay-ontology-"));
  dirs.push(d);
  const s = new GameService(d);
  services.push(s);
  const row = await s.create("Ontology exercise", "plains", instructor);
  return { s, exerciseId: row.id };
}

interface NativeHeader {
  identity: { subject: string };
  context: { workroomId: string; nativeRole?: string; canEdit: boolean; canRunAgents: boolean; readOnlyReason?: string | null; validatedAt?: string };
  client?: boolean;
}

async function serve(s: GameService, opts: { env?: NodeJS.ProcessEnv; client?: FakeClient; now?: () => number; guards?: Record<string, express.RequestHandler> } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const raw = req.headers["x-test-session"];
    if (typeof raw === "string") res.locals.session = JSON.parse(raw);
    const native = req.headers["x-test-native"];
    if (typeof native === "string") {
      const n = JSON.parse(native) as NativeHeader;
      const view: Record<string, unknown> = { identity: n.identity, context: n.context, nativeReceipts: [] };
      if (n.client !== false && opts.client) Object.defineProperty(view, "platformClient", { value: opts.client, enumerable: false });
      res.locals.native = view;
    } else {
      res.locals.native = null;
    }
    next();
  });
  if (opts.guards) app.locals.guards = opts.guards;
  const routes = mountOntologyRoutes(app, s, { env: opts.env ?? {}, now: opts.now });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, session: Session | null, body?: unknown, native?: NativeHeader) => {
    const res = await fetch(base + url, {
      method,
      headers: { "content-type": "application/json", ...(session ? { "x-test-session": JSON.stringify(session) } : {}), ...(native ? { "x-test-native": JSON.stringify(native) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* empty */
    }
    return { status: res.status, json, text };
  };
  return { call, routes };
}

function session(identity: Identity, activeId: string): Session {
  return { identity, activeId, playbackTick: null, selectedSide: "blue" };
}

const writable = (subject = instructor.subject): NativeHeader => ({ identity: { subject }, context: { workroomId: WORKROOM, nativeRole: "owner", canEdit: true, canRunAgents: true, validatedAt: "2026-09-13T12:00:00.000Z" } });
const noAgents = (subject = instructor.subject): NativeHeader => ({ identity: { subject }, context: { workroomId: WORKROOM, nativeRole: "owner", canEdit: true, canRunAgents: false } });
const readOnly = (subject = instructor.subject): NativeHeader => ({ identity: { subject }, context: { workroomId: WORKROOM, nativeRole: "viewer", canEdit: false, canRunAgents: false, readOnlyReason: "archival hold" } });
const ENV = { REPLAY_ONTOLOGY_ID: ONTOLOGY };

function storedRecord(s: GameService, key: string): PublishRecord | null {
  const row = s.store.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as unknown as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as PublishRecord) : null;
}

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("accepts an unset id, a UUID, and refuses anything else at mount time", () => {
    expect(readOntologyConfig({})).toEqual({ ontologyId: null });
    expect(readOntologyConfig({ REPLAY_ONTOLOGY_ID: ` ${ONTOLOGY.toUpperCase()} ` })).toEqual({ ontologyId: ONTOLOGY });
    expect(() => readOntologyConfig({ REPLAY_ONTOLOGY_ID: "graphiti-280d6347" })).toThrow(OntologyConfigError);
    expect(() => readOntologyConfig({ REPLAY_ONTOLOGY_ID: "https://kamiwaza.example/api/context/ontologies/x" })).toThrow(/UUID/);
    const app = express();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "replay-ontology-cfg-"));
    dirs.push(d);
    const s = new GameService(d);
    services.push(s);
    expect(() => mountOntologyRoutes(app, s, { env: { REPLAY_ONTOLOGY_ID: "not-a-uuid" } })).toThrow(OntologyConfigError);
    expect(mountOntologyRoutes(app, s, { env: {} }).ontologyId).toBeNull();
  });
});

describe("unconfigured and local-demo reads", () => {
  it("reports local mode with the labelled local definition and never a native graph", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    const { call } = await serve(s, { client });
    const r = await call("GET", "/api/ontology", session(local, exerciseId));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ mode: "local-demo", configured: false, ontologyId: null, workroomId: null, native: null });
    expect(r.json.definition.label).toMatch(/Local definition · not the native graph/);
    expect(r.json.definition.nodes).toHaveLength(7);
    expect(r.json.source).toMatchObject({ sourceId: DOMAIN_ONTOLOGY.sourceId, version: DOMAIN_ONTOLOGY.version, hash: sourceHash() });
    expect(r.json.publish).toMatchObject({ status: "unpublished", canPublish: false });
    expect(r.json.publish.reason).toMatch(/local demo/);
    expect(client.healthCalls).toHaveLength(0);
    expect(client.requestCalls).toHaveLength(0);
    // Publishing is refused outright and touches nothing.
    const p = await call("POST", "/api/ontology/publish", session(local, exerciseId), {});
    expect(p.status).toBe(409);
    expect(p.json.code).toBe("native_required");
    expect(client.knowledgeCalls).toHaveLength(0);
  });

  it("with a native session but no REPLAY_ONTOLOGY_ID it says so instead of guessing an instance", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    const { call } = await serve(s, { client });
    const r = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ mode: "kamiwaza", configured: false, workroomId: WORKROOM });
    expect(r.json.native.health).toMatchObject({ state: "unknown", error: { code: "unconfigured" } });
    expect(r.json.native.subgraph).toMatchObject({ nodes: [], edges: [], error: { code: "unconfigured" } });
    expect(r.json.publish.canPublish).toBe(false);
    expect(client.healthCalls).toHaveLength(0);
    const p = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(p.status).toBe(409);
    expect(p.json.code).toBe("unconfigured");
    expect(client.knowledgeCalls).toHaveLength(0);
  });

  it("answers 401 without a session and 403 when the native subject differs from the session", async () => {
    const { s, exerciseId } = await service();
    const { call } = await serve(s, { client: new FakeClient(), env: ENV });
    expect((await call("GET", "/api/ontology", null)).status).toBe(401);
    expect((await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable("someone-else"))).status).toBe(403);
    expect((await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable("someone-else"))).status).toBe(403);
  });

  it("uses the app's requireActive and requireAgents guards when mounted through createApp", async () => {
    const { s, exerciseId } = await service();
    const seen: string[] = [];
    const guards = {
      requireActive: ((_req: express.Request, _res: express.Response, next: express.NextFunction) => { seen.push("active"); next(); }) as express.RequestHandler,
      requireAgents: ((_req: express.Request, res: express.Response) => { seen.push("agents"); res.status(403).json({ error: "native workroom context does not permit running agents", code: "agents_blocked" }); }) as express.RequestHandler,
    };
    const client = new FakeClient();
    const { call } = await serve(s, { client, env: ENV, guards });
    expect((await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable())).status).toBe(200);
    const p = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(p.status).toBe(403);
    expect(p.json.code).toBe("agents_blocked");
    expect(seen).toEqual(["active", "active", "agents"]);
    expect(client.knowledgeCalls).toHaveLength(0);
  });
});

describe("native reads", () => {
  it("returns the platform's health and bounded subgraph, cached per workroom for 15 s", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    client.subgraph = {
      nodes: [
        { uuid: "n1", name: "Exercise", type: "Exercise", summary: "A bounded session" },
        { uuid: "n2", name: "PlayerTool", type: "PlayerTool", summary: null },
        { uuid: "n3", name: "Orphan", type: "Decision" },
        { uuid: "n1", name: "duplicate", type: "Exercise" },
        { name: "no uuid", type: "X" },
      ],
      edges: [
        { fact_uuid: "f1", source_uuid: "n1", target_uuid: "n2", fact: "An Exercise offers PlayerTools", name: "OFFERS", valid_at: "2026-09-13T00:00:00Z", invalid_at: null },
        { fact_uuid: "f2", source_uuid: "n1", target_uuid: "missing", fact: "dangles" },
        { fact_uuid: "f3", source_uuid: "n2", target_uuid: "n1" },
      ],
      truncated: false,
      sources: [{ fact_uuid: "f1", sources: [{ source_id: "ep-1", source_urn: "urn:replay:source", score: 0.9 }] }, { fact_uuid: "zzz", sources: [] }],
      secret_field_should_not_matter: "x",
    };
    let t = 1_000_000;
    const { call } = await serve(s, { client, env: ENV, now: () => t });
    const first = await call("GET", "/api/ontology", session(commander, exerciseId), undefined, writable(commander.subject));
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ mode: "kamiwaza", configured: true, ontologyId: ONTOLOGY, workroomId: WORKROOM });
    expect(first.json.native.health).toMatchObject({ state: "ready", cached: false, raw: { state: "ready", name: "graphiti" } });
    expect(first.json.native.health.receipt.requestId).toBe("req-health-200");
    const sg = first.json.native.subgraph;
    expect(sg.cached).toBe(false);
    expect(sg.nodes.map((n: any) => n.uuid)).toEqual(["n1", "n2", "n3"]);
    expect(sg.edges).toEqual([{ fact_uuid: "f1", source_uuid: "n1", target_uuid: "n2", fact: "An Exercise offers PlayerTools", name: "OFFERS", valid_at: "2026-09-13T00:00:00Z", invalid_at: null }]);
    expect(sg.danglingEdges).toBe(1);
    expect(sg.sources).toEqual([{ fact_uuid: "f1", sources: [{ source_id: "ep-1", chunk_id: null, source_urn: "urn:replay:source", score: 0.9 }] }]);
    expect(sg.receipt.requestId).toBe("req-subgraph-200");
    // Request shape: server-generated path, configured ids, bounded query, workroom hint. No caller input.
    expect(client.requestCalls).toHaveLength(1);
    expect(client.requestCalls[0]).toMatchObject({ method: "GET", path: `/context/ontologies/${ONTOLOGY}/workrooms/${WORKROOM}/subgraph`, query: { max_nodes: 200, max_edges: 600 }, workroomId: WORKROOM, capability: "knowledge" });
    expect(client.healthCalls).toEqual([{ id: ONTOLOGY, workroomId: WORKROOM }]);
    // Publish state for a non-instructor read.
    expect(first.json.publish).toMatchObject({ status: "unpublished", canPublish: false, ingestionKey: ingestionKey(WORKROOM, ONTOLOGY) });
    expect(first.json.publish.reason).toMatch(/instructor seat/);

    // Cached: same workroom, no new platform calls within the window.
    t += DEFAULT_HEALTH_CACHE_MS - 1;
    const second = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(second.json.native.health.cached).toBe(true);
    expect(second.json.native.subgraph.cached).toBe(true);
    expect(client.healthCalls).toHaveLength(1);
    expect(client.requestCalls).toHaveLength(1);
    // Expired: read again.
    t += 2;
    const third = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(third.json.native.health.cached).toBe(false);
    expect(client.healthCalls).toHaveLength(2);
    // Another workroom has its own cache entry.
    const other = { ...writable(), context: { ...writable().context, workroomId: OTHER_WORKROOM } };
    await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, other);
    expect(client.healthCalls).toHaveLength(3);
    expect(client.healthCalls[2]!.workroomId).toBe(OTHER_WORKROOM);
  });

  it("reports a platform outage truthfully with request ids and no fabricated graph", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    client.healthError = new KamiwazaError("timeout", "native request timed out (GET /context/ontologies/x/health)", { target: "GET /context/ontologies/x/health" });
    client.subgraphError = new KamiwazaError("http_error", `platform error Bearer ${TOKEN_MARKER}`, { httpStatus: 503, requestId: "req-outage", target: "GET subgraph" });
    const { call } = await serve(s, { client, env: ENV });
    const r = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(r.status).toBe(200);
    expect(r.json.native.health).toMatchObject({ state: "error", receipt: null, raw: null, error: { code: "timeout" } });
    expect(r.json.native.subgraph).toMatchObject({ nodes: [], edges: [], receipt: null, error: { code: "http_error", httpStatus: 503, requestId: "req-outage" } });
    expect(r.json.native.subgraph.error.message).toContain("Bearer [redacted]");
    expect(r.text).not.toContain(TOKEN_MARKER);
    expect(r.json.definition.nodes).toHaveLength(7); // local definition still shown, labelled
    // Health state never claims ready from an unknown body.
    expect(parseSubgraph(null, 10, 10)).toEqual({ nodes: [], edges: [], sources: [], truncated: false, danglingEdges: 0 });
  });

  it("applies its own bounds and marks the sample truncated", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({ uuid: `n${i}`, name: `N${i}`, type: "T" }));
    const edges = Array.from({ length: 5 }, (_, i) => ({ fact_uuid: `f${i}`, source_uuid: `n${i}`, target_uuid: `n${(i + 1) % 5}`, fact: "x" }));
    const p = parseSubgraph({ nodes, edges }, 3, 2);
    expect(p.nodes).toHaveLength(3);
    expect(p.edges).toHaveLength(2);
    expect(p.truncated).toBe(true);
    expect(parseSubgraph({ nodes, edges, truncated: true }, 10, 10).truncated).toBe(true);
  });
});

describe("publish: permission, durability, single flight, no automatic retry", () => {
  it("is instructor-only and needs fresh native can_edit and can_run_agents; the body cannot pick a group", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    const { call } = await serve(s, { client, env: ENV });
    const cmd = await call("POST", "/api/ontology/publish", session(commander, exerciseId), {}, writable(commander.subject));
    expect(cmd.status).toBe(403);
    expect(cmd.json.code).toBe("role_required");
    const ro = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, readOnly());
    expect(ro.status).toBe(403);
    expect(ro.json.error).toMatch(/archival hold/);
    expect((await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, noAgents())).status).toBe(403);
    // Instructor without any native context is denied, whatever the body asserts.
    expect((await call("POST", "/api/ontology/publish", session(instructor, exerciseId), { canEdit: true, role: "instructor" })).status).toBe(409);
    expect(client.knowledgeCalls).toHaveLength(0);

    const ok = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), { groupId: "attacker-group", group_ids: [OTHER_WORKROOM], ontologyId: OTHER_WORKROOM }, writable());
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ status: "accepted", already: false });
    expect(ok.json.record).toMatchObject({ status: "accepted", groupId: WORKROOM, ontologyId: ONTOLOGY, sourceId: DOMAIN_ONTOLOGY.sourceId, sourceVersion: DOMAIN_ONTOLOGY.version, sourceHash: sourceHash(), attempt: 1, requestedByRole: "instructor", result: { addedCount: 1, groupId: WORKROOM } });
    expect(ok.json.record.receipt.requestId).toBe("req-knowledge-200");
    expect(ok.json.budget).toMatchObject({ maxUsd: 5, maxRequests: 100, bridgePurpose: "graph.bridge", bridgeRequests: 0 });
    expect(client.knowledgeCalls).toHaveLength(1);
    const sent = client.knowledgeCalls[0]!;
    expect(sent.id).toBe(ONTOLOGY);
    expect(sent.workroomId).toBe(WORKROOM);
    expect(sent.req.group_id).toBe(WORKROOM);
    expect(sent.req.messages).toHaveLength(1);
    expect(sent.req.messages[0]!.role).toBe("user");
    expect(sent.req.messages[0]!.content).toContain(sourceHash());
    expect(Object.keys(sent.req.entity_types!)).toHaveLength(7);
    expect(sent.req.excluded_entity_types).toEqual(["Entity"]);
    // Nothing personal went into the batch.
    const batch = JSON.stringify(sent.req);
    expect(batch).not.toContain(instructor.subject);
    expect(batch).not.toContain(exerciseId);
    expect(batch).not.toContain("attacker-group");
    expect(batch).not.toContain(OTHER_WORKROOM);
    // Durable and visible on the next read; the read cache was invalidated.
    const key = ingestionKey(WORKROOM, ONTOLOGY);
    expect(storedRecord(s, key)?.status).toBe("accepted");
    const read = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(read.json.publish).toMatchObject({ status: "accepted", canPublish: false });
    expect(read.json.publish.record.key).toBe(key);
    expect(read.json.publish.history).toHaveLength(1);
    // Already published: no second batch, ever, for this version.
    const again = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "accepted", already: true });
    expect(client.knowledgeCalls).toHaveLength(1);
  });

  it("persists pending before the native call and collapses concurrent requests into one batch", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    const key = ingestionKey(WORKROOM, ONTOLOGY);
    let pendingSeen: PublishRecord | null = null;
    client.onKnowledge = () => {
      pendingSeen = storedRecord(s, key);
    };
    client.knowledge = async (req) => {
      await new Promise((r) => setTimeout(r, 200));
      return { added_count: 1, group_id: req.group_id };
    };
    const { call } = await serve(s, { client, env: ENV });
    const [a, b] = await Promise.all([
      call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable()),
      call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable()),
    ]);
    expect(client.knowledgeCalls).toHaveLength(1);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.json.record.startedAt).toBe(b.json.record.startedAt);
    expect(pendingSeen).not.toBeNull();
    expect(pendingSeen!).toMatchObject({ status: "pending", key, attempt: 1, receipt: null, result: null });
  });

  it("marks a timeout after send as uncertain, refuses to retry automatically, and requires an explicit acknowledgement", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    client.knowledge = async () => {
      throw new KamiwazaError("timeout", "native request timed out (POST /context/ontologies/x/knowledge)", { target: "POST knowledge" });
    };
    const { call } = await serve(s, { client, env: ENV });
    const first = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(first.status).toBe(502);
    expect(first.json.status).toBe("uncertain");
    expect(first.json.record).toMatchObject({ status: "uncertain", attempt: 1, error: { code: "timeout" } });
    expect(first.json.record.note).toMatch(/Nothing is retried automatically/i);
    expect(client.knowledgeCalls).toHaveLength(1);

    // Plain re-request: blocked, no new batch.
    const blocked = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("unresolved_previous");
    expect(blocked.json.record.status).toBe("uncertain");
    expect(client.knowledgeCalls).toHaveLength(1);
    const read = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(read.json.publish).toMatchObject({ status: "uncertain", canPublish: true });
    expect(read.json.publish.reason).toMatch(/duplicate-billing/);

    // Explicit acknowledgement: one more batch, attempt 2, and the platform now answers.
    client.knowledge = async (req) => ({ added_count: 1, group_id: req.group_id });
    const acked = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), { acknowledgeDuplicateRisk: true }, writable());
    expect(acked.status).toBe(201);
    expect(acked.json.record).toMatchObject({ status: "accepted", attempt: 2 });
    expect(client.knowledgeCalls).toHaveLength(2);
  });

  it("treats a stale pending row from a crashed process as unresolved", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    const key = ingestionKey(WORKROOM, ONTOLOGY);
    const stale: PublishRecord = { schema: "replay.ontology-publish/1", key, workroomId: WORKROOM, ontologyId: ONTOLOGY, groupId: WORKROOM, sourceId: DOMAIN_ONTOLOGY.sourceId, sourceVersion: DOMAIN_ONTOLOGY.version, sourceHash: sourceHash(), status: "pending", attempt: 1, requestedByRole: "instructor", startedAt: "2026-09-13T11:00:00.000Z", finishedAt: null, receipt: null, result: null, error: null, note: "" };
    s.store.db.prepare("INSERT INTO settings VALUES(?,?)").run(key, JSON.stringify(stale));
    const { call } = await serve(s, { client, env: ENV });
    const blocked = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(blocked.status).toBe(409);
    expect(client.knowledgeCalls).toHaveLength(0);
    const acked = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), { acknowledgeDuplicateRisk: true }, writable());
    expect(acked.status).toBe(201);
    expect(acked.json.record.attempt).toBe(2);
  });

  it("distinguishes a refusal before processing (failed, re-sendable) from a backend rejection", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    client.knowledge = async () => {
      throw new KamiwazaError("auth_denied", "native platform denied POST knowledge", { httpStatus: 403, requestId: "req-denied" });
    };
    const { call } = await serve(s, { client, env: ENV });
    const denied = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(denied.status).toBe(502);
    expect(denied.json.record).toMatchObject({ status: "failed", error: { code: "auth_denied", httpStatus: 403, requestId: "req-denied" } });
    expect(denied.json.record.note).toMatch(/Nothing was ingested/);
    // Failed is re-sendable without an acknowledgement, but only on an explicit request.
    client.knowledge = async (req) => ({ added_count: 0, group_id: req.group_id, error: "backend unavailable: neo4j" });
    const rejected = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(rejected.status).toBe(502);
    expect(rejected.json.record).toMatchObject({ status: "failed", attempt: 2, error: { code: "backend_rejected", message: "backend unavailable: neo4j", requestId: "req-knowledge-200" }, result: { addedCount: 0 } });
    expect(client.knowledgeCalls).toHaveLength(2);
    const read = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(read.json.publish).toMatchObject({ status: "failed", canPublish: true });
    // A 5xx after send is uncertain, not failed.
    client.knowledge = async () => {
      throw new KamiwazaError("http_error", "platform error HTTP 502", { httpStatus: 502 });
    };
    const gateway = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(gateway.json.record.status).toBe("uncertain");
  });
});

describe("payload hygiene", () => {
  it("never serializes the platform client, tokens or configuration, and strips credential-shaped keys from open objects", async () => {
    const { s, exerciseId } = await service();
    const client = new FakeClient();
    client.health = { status: "healthy", access_token: TOKEN_MARKER, neo4j_password: "hunter2", details: { ok: true } };
    client.knowledge = async (req) => ({ added_count: 1, group_id: req.group_id, result: { api_key: TOKEN_MARKER, episodes: 1, big: "x".repeat(10_000) } });
    const { call } = await serve(s, { client, env: { ...ENV, REPLAY_KAMIWAZA_API: "https://kamiwaza.example/api", OPENAI_API_KEY: "sk-SECRET-1234567890abcdefghij" } });
    const r = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    expect(r.json.native.health.state).toBe("ready");
    expect(r.json.native.health.raw).toEqual({ status: "healthy", details: { ok: true } });
    const p = await call("POST", "/api/ontology/publish", session(instructor, exerciseId), {}, writable());
    expect(p.status).toBe(201);
    expect(p.json.record.result.backend.episodes).toBe(1);
    expect(p.json.record.result.backend.api_key).toBeUndefined();
    const read = await call("GET", "/api/ontology", session(instructor, exerciseId), undefined, writable());
    for (const text of [r.text, p.text, read.text]) {
      expect(text).not.toContain(TOKEN_MARKER);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("sk-SECRET");
      expect(text).not.toContain("platformClient");
      expect(text).not.toContain("kamiwaza.example");
    }
    expect(read.text.length).toBeLessThan(40_000);
  });
});
