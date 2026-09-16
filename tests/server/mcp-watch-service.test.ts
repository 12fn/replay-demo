import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GameService, type Identity } from "../../src/server/service";
import type { KamiwazaConfig } from "../../src/server/native-http";
import type { McpPrincipal } from "../../src/server/mcp-auth";
import type { NativeContext } from "../../src/server/native-session";
import { createMcpWatch, McpWatchError, MCP_WATCH_EVENT_KIND } from "../../src/server/mcp-watch-service";

console.debug = () => {};

const WORKROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const OTHER_WORKROOM = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const NOW = Date.parse("2026-09-14T12:00:00Z");
const now = () => NOW;
const config: KamiwazaConfig = { mode: "kamiwaza", apiBase: "https://kamiwaza.example/api", workroomId: WORKROOM, forwardedHost: "kamiwaza-harness.localhost", forwardedProto: "https", allowedOrigins: [], cookieSecure: true, allowLegacyRecordings: false };
const TITLE = "Watch reserves below 30%";

const who = (subject: string, role: Identity["role"] = "commander") => ({ subject, name: `Native ${subject}`, role, organization: "Fictional workroom", mode: "kamiwaza" as const });
const principal = (subject: string, over: Partial<NativeContext> = {}, role: Identity["role"] = "commander"): McpPrincipal => ({
  identity: who(subject, role),
  context: { workroomId: WORKROOM, workroomName: "Fictional workroom", nativeRole: "member", mappedRole: role, profileApplied: false, accessState: "active", interactionMode: "interactive", lifecycleState: "active", canEdit: true, canRunAgents: false, canShare: false, readOnlyReason: null, statusBanner: null, fresh: true, validatedAt: "2026-09-14T11:59:30Z", ...over },
  nativeReceipts: [],
});

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) f(); });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-mcp-watch-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inference = vi.fn(async () => { throw new Error("Unexpected inference in free-watch test"); });
  const state: { service: GameService } = { service: null as unknown as GameService };
  const open = async () => {
    const s = new GameService(dir);
    s.luna = { complete: inference };
    vi.spyOn(s.lunaChat, "complete").mockImplementation(inference);
    await s.init(false);
    s.baseline = () => {};
    state.service = s;
    return s;
  };
  await open();
  cleanup.push(() => state.service.close());
  const create = async (owner: string, workroomId: string | null = WORKROOM) => {
    const s = state.service;
    const row = await s.create("Fictional watch fixture", "plains");
    row.options = { ...row.options, ownerSubject: owner, workroomId, assistance: "unknown" };
    s.store.putExercise(row);
    s.teams.enroll(row, who(owner), 1);
    for (let i = 0; i < 25; i++) s.tick(s.world(row.id));
    return row;
  };
  const restart = async () => { state.service.close(); await open(); };
  const counts = (exerciseId: string) => ({
    tasks: state.service.store.tasks(exerciseId).length,
    created: state.service.store.events(exerciseId).filter((e) => e.kind === "task_created").length,
    receipts: state.service.store.events(exerciseId).filter((e) => e.kind === MCP_WATCH_EVENT_KIND).length,
  });
  return { get service() { return state.service; }, create, restart, counts, inference };
}

function denial(fn: () => unknown): McpWatchError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(McpWatchError); return e as McpWatchError; }
  throw new Error("expected McpWatchError");
}

describe("createMcpWatch", () => {
  it("creates one free watch on the human side owned by the caller, with receipt and task_created provenance", async () => {
    const f = await setup();
    const row = await f.create("sub-owner");
    const input = { exerciseId: row.id, requestId: randomUUID(), title: TITLE };
    const out = createMcpWatch(f.service, config, principal("sub-owner"), input, now);

    expect(out.task).toMatchObject({ kind: "provenance-watch", modelEnabled: false, side: row.humanSide, title: TITLE });
    expect(out.receipt).toMatchObject({ requestId: input.requestId, replayed: false });
    const stored = f.service.store.tasks(row.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: out.task.id, owner: "sub-owner", side: row.humanSide, modelEnabled: false });
    const created = f.service.store.events(row.id).find((e) => e.kind === "task_created")!;
    expect(out.provenance).toMatchObject({ exerciseId: row.id, taskCreatedEventId: created.id, paidInference: "off-at-creation" });
    const receipt = f.service.store.events(row.id).find((e) => e.kind === MCP_WATCH_EVENT_KIND)!;
    expect(receipt).toMatchObject({ id: out.receipt.eventId, actor: "sub-owner", side: row.humanSide });
    expect(receipt.details).toEqual({ requestId: input.requestId, fingerprint: out.receipt.fingerprint, taskId: out.task.id, taskCreatedEventId: created.id });
    // Only the caller's own task summary is returned; no watch internals or other records.
    expect(Object.keys(out.task).sort()).toEqual(["createdTick", "id", "interpretation", "kind", "modelEnabled", "phase", "side", "title"]);
    expect(f.inference).not.toHaveBeenCalled();
    expect(f.service.ledger.summary().requestsUsed).toBe(0);
  });

  it("rejects side, tick, model, order or identity fields and malformed ids", async () => {
    const f = await setup();
    const row = await f.create("sub-owner");
    const base = { exerciseId: row.id, requestId: randomUUID(), title: TITLE };
    for (const extra of [{ side: "red" }, { tick: 1 }, { modelEnabled: true }, { intent: { type: "attack" } }, { subject: "sub-other" }]) {
      expect(denial(() => createMcpWatch(f.service, config, principal("sub-owner"), { ...base, ...extra }, now)).code).toBe("invalid_params");
    }
    expect(denial(() => createMcpWatch(f.service, config, principal("sub-owner"), { ...base, requestId: "not-a-uuid" }, now)).code).toBe("invalid_params");
    expect(denial(() => createMcpWatch(f.service, config, principal("sub-owner"), { ...base, title: "   " }, now)).code).toBe("invalid_params");
    expect(f.counts(row.id)).toEqual({ tasks: 0, created: 0, receipts: 0 });
  });

  it("replays an identical retry after restart and conflicts on a mismatched payload without duplicates", async () => {
    const f = await setup();
    const row = await f.create("sub-owner");
    const input = { exerciseId: row.id, requestId: randomUUID(), title: TITLE };
    const first = createMcpWatch(f.service, config, principal("sub-owner"), input, now);
    expect(createMcpWatch(f.service, config, principal("sub-owner"), input, now).task.id).toBe(first.task.id);

    await f.restart();
    const again = createMcpWatch(f.service, config, principal("sub-owner"), { ...input, title: `  ${TITLE} ` }, now);
    expect(again.task.id).toBe(first.task.id);
    expect(again.receipt).toEqual({ ...first.receipt, replayed: true });
    expect(again.provenance.taskCreatedEventId).toBe(first.provenance.taskCreatedEventId);

    const conflict = denial(() => createMcpWatch(f.service, config, principal("sub-owner"), { ...input, title: "Watch objective changes" }, now));
    expect(conflict).toMatchObject({ code: "idempotency_conflict", httpStatus: 409 });
    expect(f.counts(row.id)).toEqual({ tasks: 1, created: 1, receipts: 1 });

    // The same requestId from another identity is a separate key, never a replay of the first caller's task.
    f.service.teams.enroll(f.service.world(row.id).row, who("sub-member"), 1);
    const member = createMcpWatch(f.service, config, principal("sub-member"), input, now);
    expect(member.task.id).not.toBe(first.task.id);
    expect(f.service.store.tasks(row.id).find((t) => t.id === member.task.id)?.owner).toBe("sub-member");
    expect(f.inference).not.toHaveBeenCalled();
  });

  it("rolls back the task and task_created event when the receipt cannot commit", async () => {
    const f = await setup();
    const row = await f.create("sub-owner");
    const input = { exerciseId: row.id, requestId: randomUUID(), title: TITLE };
    const db = f.service.store.db;
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("kind='task_created'")) throw new Error("simulated receipt failure");
      return prepare(sql);
    });
    expect(() => createMcpWatch(f.service, config, principal("sub-owner"), input, now)).toThrow("simulated receipt failure");
    spy.mockRestore();
    expect(f.counts(row.id)).toEqual({ tasks: 0, created: 0, receipts: 0 });
    expect(Object.hasOwn(f.service.store, "transaction")).toBe(false);
    createMcpWatch(f.service, config, principal("sub-owner"), input, now);
    expect(f.counts(row.id)).toEqual({ tasks: 1, created: 1, receipts: 1 });
  });

  it("denies write-disabled, stale, cross-workroom and unassigned callers before any write", async () => {
    const f = await setup();
    const row = await f.create("sub-owner");
    const foreign = await f.create("sub-owner", OTHER_WORKROOM);
    const input = { exerciseId: row.id, requestId: randomUUID(), title: TITLE };
    const cases: [McpPrincipal, string, unknown?][] = [
      [principal("sub-owner", { canEdit: false }), "write_denied"],
      [principal("sub-owner", { accessState: "readonly" }), "write_denied"],
      [{ ...principal("sub-owner"), identity: { ...who("sub-owner"), mode: "local-demo" as never } }, "write_denied"],
      [principal("sub-owner", { fresh: false }), "stale_context"],
      [principal("sub-owner", { validatedAt: "2026-09-14T11:50:00Z" }), "stale_context"],
      [principal("sub-owner", { workroomId: OTHER_WORKROOM }), "workroom_mismatch"],
      [principal("sub-stranger"), "exercise_not_found"],
      [principal("sub-owner"), "exercise_not_found", { ...input, exerciseId: foreign.id }],
      [principal("sub-owner"), "exercise_not_found", { ...input, exerciseId: randomUUID() }],
    ];
    for (const [p, code, body] of cases) expect(denial(() => createMcpWatch(f.service, config, p, body ?? input, now)).code).toBe(code);
    // An instructor sees the workroom exercise; the watch still lands on the human side under the instructor's subject.
    const out = createMcpWatch(f.service, config, principal("sub-instructor", {}, "instructor"), input, now);
    expect(f.service.store.tasks(row.id).find((t) => t.id === out.task.id)).toMatchObject({ owner: "sub-instructor", side: row.humanSide });
    expect(f.counts(foreign.id)).toEqual({ tasks: 0, created: 0, receipts: 0 });
    expect(f.inference).not.toHaveBeenCalled();
  });

  it("refuses ended exercises and unsupported watch grammar without persisting a receipt", async () => {
    const f = await setup();
    const row = await f.create("sub-owner");
    const unsupported = denial(() => createMcpWatch(f.service, config, principal("sub-owner"), { exerciseId: row.id, requestId: randomUUID(), title: "Predict what the opponent is thinking" }, now));
    expect(unsupported).toMatchObject({ code: "unsupported_watch", httpStatus: 422 });
    expect(unsupported.extra.examples).toContain(TITLE);
    expect(f.counts(row.id)).toEqual({ tasks: 0, created: 0, receipts: 0 });

    const w = f.service.world(row.id);
    w.row.status = "completed";
    f.service.store.putExercise(w.row);
    expect(denial(() => createMcpWatch(f.service, config, principal("sub-owner"), { exerciseId: row.id, requestId: randomUUID(), title: TITLE }, now))).toMatchObject({ code: "exercise_not_running", httpStatus: 409 });
    expect(f.counts(row.id)).toEqual({ tasks: 0, created: 0, receipts: 0 });
    expect(f.inference).not.toHaveBeenCalled();
    expect(f.service.ledger.summary().requestsUsed).toBe(0);
  });
});
