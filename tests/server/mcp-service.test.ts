import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GameService, type Identity } from "../../src/server/service";
import type { KamiwazaConfig } from "../../src/server/native-http";
import { McpService, McpToolError, MAX_KEY_MOMENTS } from "../../src/server/mcp-service";

console.debug = () => {};

const WORKROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const OTHER_WORKROOM = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const config: KamiwazaConfig = { mode: "kamiwaza", apiBase: "https://kamiwaza.example/api", workroomId: WORKROOM, forwardedHost: "kamiwaza-harness.localhost", forwardedProto: "https", allowedOrigins: [], cookieSecure: true, allowLegacyRecordings: false };

const who = (subject: string, role: Identity["role"]): Identity => ({ subject, name: `Native ${subject}`, role, organization: "Decision Advantage Workroom", mode: "kamiwaza" });
const owner = who("sub-owner", "commander");
const member = who("sub-member", "commander");
const analyst = who("sub-analyst", "intelligence");
const stranger = who("sub-stranger", "commander");
const instructor = who("sub-instructor", "instructor");

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-mcp-service-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new GameService(dir);
  cleanup.push(() => service.close());
  await service.init(false);
  service.baseline = () => {};
  const mcp = new McpService({ service, config, now: () => new Date("2026-09-13T12:00:00Z") });
  /** Persist native ownership the way the HTTP app's `persistOwnership` does. */
  const attribute = (id: string, by: Identity, workroomId: string | null = WORKROOM) => {
    const row = service.world(id).row;
    row.options = { ...row.options, ownerSubject: by.subject, workroomId, assistance: "unknown" };
    service.store.putExercise(row);
    service.teams.enroll(row, by, row.forkTick ?? 1);
    return row;
  };
  const create = async (name: string, by: Identity, workroomId: string | null = WORKROOM, scenarioId?: string) => {
    const row = await service.create(name, scenarioId ? "world" : "plains", undefined, scenarioId);
    return attribute(row.id, by, workroomId);
  };
  const advance = (id: string, n: number) => { const w = service.world(id); for (let i = 0; i < n; i++) service.tick(w); return w.engine.game.ticks(); };
  const snapshot = () => ({
    exercises: JSON.stringify(service.store.exercises()),
    events: service.store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number },
    sessions: service.store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number },
    settings: service.store.db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number },
    turns: service.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number },
  });
  return { service, mcp, attribute, create, advance, snapshot };
}

async function failure(p: Promise<unknown>): Promise<McpToolError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(McpToolError); return e as McpToolError; }
  throw new Error("expected tool error");
}

describe("McpService catalog", () => {
  it("lists only read tools, each with readOnlyHint and a closed 2020-12 input schema", async () => {
    const { mcp } = await setup();
    const tools = mcp.tools();
    expect(tools.map((t) => t.name)).toEqual(["search_catalog", "get_catalog_record", "list_exercises", "get_exercise_state", "get_station_objectives", "get_team_assessments", "get_key_moments", "get_replay_provenance", "search_practice_history", "search_practice_details"]);
    for (const t of tools) {
      expect(t.annotations).toEqual({ title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(t.inputSchema.properties)).not.toContain("subject");
      expect(Object.keys(t.inputSchema.properties)).not.toContain("workroomId");
      expect(Object.keys(t.inputSchema.properties)).not.toContain("side");
    }
    expect(JSON.stringify(tools.map((t) => t.name))).not.toMatch(/submit_order|delegate_watch|branch|command/);
  });

  it("refuses unknown tools, extra arguments, body-supplied identity and malformed ids as invalid_params", async () => {
    const { mcp, create } = await setup();
    const row = await create("Alpha", owner);
    expect((await failure(mcp.call("submit_order", {}, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("list_exercises", { subject: "someone" }, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("get_exercise_state", { exerciseId: row.id, workroomId: OTHER_WORKROOM }, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("get_exercise_state", { exerciseId: "../etc/passwd" }, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("get_exercise_state", { exerciseId: row.id, tick: -1 }, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("get_exercise_state", { exerciseId: row.id, tick: 1.5 }, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("get_key_moments", { exerciseId: row.id, limit: MAX_KEY_MOMENTS + 1 }, owner))).code).toBe("invalid_params");
    expect((await failure(mcp.call("get_exercise_state", "not-an-object", owner))).code).toBe("invalid_params");
  });

  it("refuses to run outside native mode", async () => {
    const { service } = await setup();
    expect(() => new McpService({ service, config: { mode: "local-demo", allowedOrigins: [], cookieSecure: false } as unknown as KamiwazaConfig })).toThrow(McpToolError);
  });
});

describe("list_exercises scope", () => {
  it("applies the native visibility rules: owner, enrolled member, instructor within the workroom, nothing else", async () => {
    const { service, mcp, create } = await setup();
    const mine = await create("Mine", owner);
    const theirs = await create("Theirs", stranger);
    const foreign = await create("Foreign room", owner, OTHER_WORKROOM);
    const legacy = await create("Legacy", owner, null);
    service.teams.enroll(mine, member, 1);
    const ids = async (as: Identity) => ((await mcp.call("list_exercises", {}, as)) as { exercises: { id: string; attribution: string }[] }).exercises;
    expect((await ids(owner)).map((e) => e.id)).toEqual([mine.id]);
    expect((await ids(member)).map((e) => [e.id, e.attribution])).toEqual([[mine.id, "shared"]]);
    expect((await ids(stranger)).map((e) => e.id)).toEqual([theirs.id]);
    expect((await ids(instructor)).map((e) => e.id).sort()).toEqual([mine.id, theirs.id].sort());
    const asInstructor = await ids(instructor);
    expect(asInstructor.map((e) => e.id)).not.toContain(foreign.id);
    expect(asInstructor.map((e) => e.id)).not.toContain(legacy.id);
    // The unattributed bootstrap exercise created by init() carries no workroom and is invisible to everyone.
    const bootstrap = service.store.exercises().find((r) => !r.options?.workroomId && r.id !== legacy.id);
    expect(bootstrap).toBeDefined();
    for (const as of [owner, member, stranger, instructor]) expect((await ids(as)).map((e) => e.id)).not.toContain(bootstrap!.id);
  });

  it("carries the fiction notice, kind, current tick and bounded fields only", async () => {
    const { mcp, create, advance } = await setup();
    const row = await create("Ticked", owner);
    const tick = advance(row.id, 3);
    const out = (await mcp.call("list_exercises", {}, owner)) as any;
    expect(out.fiction).toBe(true);
    expect(out.notice).toMatch(/Fictional/);
    expect(out.workroomId).toBe(WORKROOM);
    expect(out.exercises[0]).toMatchObject({ id: row.id, kind: "live", status: "running", humanSide: "blue", currentTick: tick, attribution: "owned", participantCount: 1, parentId: null, forkTick: null });
    expect(JSON.stringify(out)).not.toMatch(/owners|"land"|simulationId/);
  });
});

describe("get_exercise_state", () => {
  it("returns a bounded public summary live and at an explicit historical tick, and refuses future ticks", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("State", owner);
    const current = advance(row.id, 6);
    const live = (await mcp.call("get_exercise_state", { exerciseId: row.id }, owner)) as any;
    expect(live.provenance).toMatchObject({ fiction: true, exerciseId: row.id, exerciseKind: "live", position: "live", cutoffTick: current, viewerSide: "blue", bothSidesVisible: false, generatedAt: "2026-09-13T12:00:00.000Z" });
    expect(live.state.tick).toBe(current);
    expect(live.state.fingerprint).toBe(service.world(row.id).engine.state().fingerprint);
    expect(live.state.players.map((p: any) => p.side)).toEqual(["blue", "red"]);
    for (const p of live.state.players) {
      expect(Object.keys(p).sort()).toEqual(["alive", "committedTroops", "gold", "maxTroops", "name", "outgoingAttacks", "side", "tiles", "troops", "unitCounts"].sort());
    }
    expect(live.state).not.toHaveProperty("owners");
    expect(live.state).not.toHaveProperty("land");
    expect(live.omitted).toContain("tile ownership map");

    const past = (await mcp.call("get_exercise_state", { exerciseId: row.id, tick: 3 }, owner)) as any;
    expect(past.provenance).toMatchObject({ position: "historical", cutoffTick: 3 });
    expect(past.state.tick).toBe(3);
    expect(past.state.fingerprint).toBe(service.store.turns(row.id).find((t) => t.tick === 3)!.fingerprint);

    const future = await failure(mcp.call("get_exercise_state", { exerciseId: row.id, tick: current + 1 }, owner));
    expect(future.code).toBe("tick_unavailable");
    expect(future.message).toContain(`current tick ${current}`);
    const nullTick = (await mcp.call("get_exercise_state", { exerciseId: row.id, tick: null }, owner)) as any;
    expect(nullTick.provenance.position).toBe("live");
  });

  it("answers strangers and unknown ids identically, and never resolves through a session", async () => {
    const { service, mcp, create, snapshot } = await setup();
    const row = await create("Private", owner);
    const before = snapshot();
    expect((await failure(mcp.call("get_exercise_state", { exerciseId: row.id }, stranger))).code).toBe("exercise_not_found");
    expect((await failure(mcp.call("get_exercise_state", { exerciseId: "00000000-0000-4000-8000-000000000000" }, owner))).code).toBe("exercise_not_found");
    await mcp.call("get_exercise_state", { exerciseId: row.id, tick: 1 }, owner);
    await mcp.call("get_replay_provenance", { exerciseId: row.id }, owner);
    await mcp.call("get_key_moments", { exerciseId: row.id }, owner);
    await mcp.call("get_team_assessments", { exerciseId: row.id }, owner);
    await mcp.call("get_station_objectives", { exerciseId: row.id }, owner);
    await mcp.call("list_exercises", {}, instructor);
    expect(snapshot()).toEqual(before);
    expect(before.sessions.n).toBe(0);
    expect(service.ledger.summary().requestsUsed).toBe(0);
  });
});

describe("get_team_assessments", () => {
  it("shares analyst entries with the side, hides the opposing side until completion or instructor, and never emits debriefs", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("Assess", owner);
    service.teams.enroll(row, analyst, 1);
    advance(row.id, 2);
    const report = service.store.reports(row.id).find((r) => r.side === "blue")!;
    const logged = service.assessmentLog({ identity: analyst, activeId: row.id, playbackTick: null, selectedSide: "blue" }, { text: "The current source replaces the initial estimate; my interpretation.", sourceIds: [report.id] });
    const red = service.store.event(row.id, 1, "assessment_log", "opponent-analyst", "Other side analysis", { text: "RED SIDE SENTINEL", timing: "contemporaneous" }, "red");
    service.store.db.prepare("INSERT INTO settings VALUES(?,?)").run(`learning.debrief:${row.id}:x`, JSON.stringify({ text: "PRIVATE COACHING SENTINEL" }));
    service.store.event(row.id, 2, "decision_log", owner.subject, "Post-hoc statement", { text: "DECISION LOG SENTINEL", timing: "post-hoc" }, "blue");

    const mine = (await mcp.call("get_team_assessments", { exerciseId: row.id }, owner)) as any;
    expect(mine.entries).toHaveLength(1);
    expect(mine.entries[0]).toMatchObject({ id: logged.id, timing: "contemporaneous", author: { subject: analyst.subject, name: analyst.name, role: "intelligence" }, sourceIds: [report.id], side: "blue" });
    const text = JSON.stringify(mine);
    for (const s of [red, "RED SIDE SENTINEL", "PRIVATE COACHING SENTINEL", "DECISION LOG SENTINEL"]) expect(text).not.toContain(s);

    const asInstructor = (await mcp.call("get_team_assessments", { exerciseId: row.id }, instructor)) as any;
    expect(asInstructor.entries.map((e: any) => e.id).sort()).toEqual([logged.id, red].sort());
    expect(asInstructor.provenance.bothSidesVisible).toBe(true);

    service.world(row.id).row.status = "completed";
    service.store.putExercise(service.world(row.id).row);
    const completed = (await mcp.call("get_team_assessments", { exerciseId: row.id }, owner)) as any;
    expect(completed.entries.map((e: any) => e.id).sort()).toEqual([logged.id, red].sort());
  });

  it("hides entries recorded after the requested cutoff even when their observed tick was earlier", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("Cutoff", owner);
    service.teams.enroll(row, analyst, 1);
    advance(row.id, 4);
    const later = service.assessmentLog({ identity: analyst, activeId: row.id, playbackTick: 1, selectedSide: "blue" }, { text: "A later reflection.", sourceIds: [] });
    expect(later.timing).toBe("post-hoc");
    const frozen = (await mcp.call("get_team_assessments", { exerciseId: row.id, tick: 1 }, owner)) as any;
    expect(frozen.provenance).toMatchObject({ position: "historical", cutoffTick: 1 });
    expect(frozen.entries.some((e: any) => e.id === later.id)).toBe(false);
    const live = (await mcp.call("get_team_assessments", { exerciseId: row.id }, owner)) as any;
    expect(live.entries.find((e: any) => e.id === later.id)).toMatchObject({ timing: "post-hoc", observedTick: 1 });
  });
});

describe("get_key_moments", () => {
  it("selects own moments up to the cutoff without peer, opponent, future or controller records, and never exposes exclusions", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("Moments", owner);
    service.teams.enroll(row, member, 1);
    const id = row.id;
    const order = (actor: string, tick: number, amount: number, side = "blue") => service.store.event(id, tick, "command", actor, "Recorded order", { origin: "human", intent: { type: "attack", targetID: null, troops: amount }, before: { troops: 1000 } }, side);
    const early = order(owner.subject, 1, 750);
    for (let n = 0; n < 30; n++) order(owner.subject, 1, 10);
    const peer = order(member.subject, 1, 990);
    const opponent = order("opponent", 1, 999, "red");
    const secret = service.store.event(id, 1, "model_decision", "red-controller", "Private controller input", { observation: "SENTINEL OPPONENT INPUT" }, "red");
    advance(id, 3);
    const future = order(owner.subject, 3, 800);

    const out = (await mcp.call("get_key_moments", { exerciseId: id, tick: 2 }, owner)) as any;
    const text = JSON.stringify(out);
    expect(out.selected.some((m: any) => m.evidence.some((e: any) => e.id === early))).toBe(true);
    for (const excluded of [peer, opponent, future, secret, "SENTINEL OPPONENT INPUT"]) expect(text).not.toContain(excluded);
    expect(out).not.toHaveProperty("excluded");
    expect(out).not.toHaveProperty("candidates");
    expect(out.scope).toEqual({ kind: "own", subject: owner.subject });
    expect(out.cutoff).toEqual({ tick: 2 });
    expect(out.provenance).toMatchObject({ position: "historical", cutoffTick: 2, fingerprint: null });
    expect(typeof out.candidateCount).toBe("number");
    expect(out.limitations.length).toBeGreaterThan(0);

    const live = (await mcp.call("get_key_moments", { exerciseId: id, limit: 2 }, owner)) as any;
    expect(live.selected.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(live)).toContain(future);

    const shared = (await mcp.call("get_key_moments", { exerciseId: id }, instructor)) as any;
    expect(shared.scope).toEqual({ kind: "shared" });
    expect(JSON.stringify(shared)).toContain(peer);
    expect(JSON.stringify(shared)).not.toContain("SENTINEL OPPONENT INPUT");

    // A member sees only their own acts, not the owner's.
    const asMember = (await mcp.call("get_key_moments", { exerciseId: id }, member)) as any;
    expect(asMember.scope).toEqual({ kind: "own", subject: member.subject });
    expect(JSON.stringify(asMember)).not.toContain(early);
  });
});

describe("get_station_objectives", () => {
  it("reports available=false for last-side-standing scenarios", async () => {
    const { mcp, create } = await setup();
    const row = await create("Plain", owner);
    const out = (await mcp.call("get_station_objectives", { exerciseId: row.id }, owner)) as any;
    expect(out).toMatchObject({ available: false, provenance: { exerciseId: row.id, position: "live" } });
    expect(out.reason).toMatch(/no station objectives/);
  });

  it("returns the deterministic board live and historically for an objective scenario, without tile lists", async () => {
    const { mcp, create, advance } = await setup();
    const row = await create("Stations", owner, WORKROOM, "crosscurrent-network/1");
    const current = advance(row.id, 4);
    const live = (await mcp.call("get_station_objectives", { exerciseId: row.id }, owner)) as any;
    expect(live).toMatchObject({ available: true, rulesId: "stations-and-reserves/1", tick: current, scores: { blue: 0, red: 0 }, inheritedFromParent: false });
    expect(live.stations.map((s: any) => s.id)).toEqual(["aster", "beacon", "cedar", "delta", "ember"]);
    for (const s of live.stations) {
      expect(s).not.toHaveProperty("tiles");
      expect(s).not.toHaveProperty("tile");
      expect(Object.keys(s).sort()).toEqual(["controller", "held", "id", "name", "priority", "totalTiles"]);
    }
    expect(live.basis).toMatch(/never learning mastery/);
    const past = (await mcp.call("get_station_objectives", { exerciseId: row.id, tick: 2 }, owner)) as any;
    expect(past).toMatchObject({ available: true, tick: 2, provenance: { position: "historical", cutoffTick: 2 } });
  }, 30_000);
});

describe("get_replay_provenance", () => {
  it("labels lineage, engine pin, attribution and side-scoped synthetic reports with supersession", async () => {
    const { service, mcp, create, advance, attribute } = await setup();
    const parent = await create("Parent", owner);
    advance(parent.id, 4);
    service.injectReport(parent.id);
    const out = (await mcp.call("get_replay_provenance", { exerciseId: parent.id }, owner)) as any;
    expect(out.provenance).toMatchObject({ exerciseKind: "live", position: "live" });
    expect(out.lineage).toEqual({ parentId: null, forkTick: null, interpretation: "Independent exercise" });
    expect(out.attribution).toMatchObject({ label: "owned", assistance: "unknown" });
    expect(out.engine.upstreamCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(out.record).toMatchObject({ recordedTurns: service.store.turns(parent.id).length, latestTick: service.world(parent.id).engine.game.ticks() });
    expect(out.record.latestFingerprint).toBe(service.store.turns(parent.id).at(-1)!.fingerprint);
    expect(out.releasedReports.length).toBe(2);
    for (const r of out.releasedReports) {
      expect(r.side).toBe("blue");
      expect(r.synthetic).toBe(true);
      expect(r).not.toHaveProperty("body");
    }
    expect(out.releasedReports[1].supersedes).toBe(out.releasedReports[0].id);
    const redReports = service.store.reports(parent.id).filter((r) => r.side === "red").map((r) => r.id);
    for (const id of redReports) expect(JSON.stringify(out)).not.toContain(id);

    // Cutoff: only the first release exists at tick 1; the fingerprint matches the stored turn.
    const early = (await mcp.call("get_replay_provenance", { exerciseId: parent.id, tick: 1 }, owner)) as any;
    expect(early.releasedReports.length).toBe(1);
    expect(early.provenance.cutoffTick).toBe(1);
    expect(early.record.cutoffFingerprint).toBe(service.store.turns(parent.id).find((t) => t.tick === 1)!.fingerprint);

    // Instructor sees both sides.
    const both = (await mcp.call("get_replay_provenance", { exerciseId: parent.id }, instructor)) as any;
    expect(both.releasedReports.map((r: any) => r.side).sort()).toEqual(["blue", "blue", "red", "red"]);

    // A branch is labelled as such with its fork point; the branch opener owns it.
    const branch = await service.branch(parent.id, 2, "blue");
    attribute(branch.id, member);
    service.teams.enroll(parent, member, 1);
    const b = (await mcp.call("get_replay_provenance", { exerciseId: branch.id }, member)) as any;
    expect(b.provenance.exerciseKind).toBe("branch");
    expect(b.lineage).toMatchObject({ parentId: parent.id, forkTick: 2 });
    expect(b.lineage.interpretation).toMatch(/informed practice/);
    expect(b.releasedReports[0].inheritedFromParentReport).toBeTruthy();
    expect((await failure(mcp.call("get_replay_provenance", { exerciseId: branch.id }, stranger))).code).toBe("exercise_not_found");
  });
});

describe("MCP privacy regression boundaries", () => {
  it("historical provenance stays identical after future turns, releases and hidden records are added", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("Past", owner);
    const before = await mcp.call("get_replay_provenance", { exerciseId: row.id, tick: 1 }, owner);
    advance(row.id, 8);
    service.injectReport(row.id);
    service.store.event(row.id, 9, "model_decision", "opponent", "FUTURE PRIVATE TRACE", {}, "red");
    const after = await mcp.call("get_replay_provenance", { exerciseId: row.id, tick: 1 }, owner);
    expect(after).toEqual(before);
    expect((after.record as any).recordedTurns).toBe(1);
    expect(JSON.stringify(after)).not.toContain(service.store.turns(row.id).at(-1)!.fingerprint);
  });

  it("rechecks local membership and ownership after deferred reconstruction for both engine tools", async () => {
    for (const tool of ["get_exercise_state", "get_station_objectives"]) {
      const { service, mcp, create } = await setup();
      const row = await create("Membership", owner);
      service.teams.enroll(row, member, 1);
      const historical = service.historical.bind(service);
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((r) => { entered = r; });
      const gate = new Promise<void>((r) => { release = r; });
      service.historical = async (id, tick) => { entered(); await gate; return historical(id, tick); };
      const pending = mcp.call(tool, { exerciseId: row.id, tick: 1 }, member);
      await started;
      service.teams.remove(row, member.subject, owner.subject);
      release();
      expect(await failure(pending)).toMatchObject({ code: "exercise_not_found", message: "Exercise not found" });
    }
  });

  it("uses refreshed authority instead of the earlier instructor role", async () => {
    const { mcp, create } = await setup();
    const row = await create("Private", owner);
    const demoted = { ...instructor, role: "intelligence" as const };
    expect(await failure(mcp.call("get_exercise_state", { exerciseId: row.id, tick: 1 }, instructor, async () => demoted))).toMatchObject({ code: "exercise_not_found" });
  });

  it("hides the inaccessible parent and unshared sources while retaining precise inherited branch references", async () => {
    const { service, mcp, create, attribute, advance } = await setup();
    const parent = await create("Private parent", owner);
    advance(parent.id, 2);
    const branch = await service.branch(parent.id, 2, "blue");
    attribute(branch.id, member);
    const provenance = await mcp.call("get_replay_provenance", { exerciseId: branch.id }, member);
    const list = await mcp.call("list_exercises", {}, member);
    const text = JSON.stringify([provenance, list]);
    expect(text).not.toContain(parent.id);
    for (const r of service.store.reports(parent.id).filter((r) => r.side === "red")) expect(text).not.toContain(r.id);
    for (const r of provenance.releasedReports as any[]) {
      expect(r.id.startsWith(`${branch.id}:`)).toBe(true);
      expect(r.inheritedFromParentReport).toBeNull();
    }
    expect(provenance.lineage).toMatchObject({ parentId: null, forkTick: 2 });
  });


  it("does not change historical moment selections or candidate counts when future records arrive", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("Moment cutoff", owner);
    const add = (actor: string, tick: number) => service.store.event(row.id, tick, "command", actor, "Order", { origin: "human", intent: { type: "attack", targetID: null, troops: 750 }, before: { troops: 1000 } }, "blue");
    add(owner.subject, 1);
    const before = await mcp.call("get_key_moments", { exerciseId: row.id, tick: 1 }, owner);
    advance(row.id, 5);
    for (let i = 0; i < 20; i++) add(owner.subject, 5);
    add(member.subject, 1);
    expect(await mcp.call("get_key_moments", { exerciseId: row.id, tick: 1 }, owner)).toEqual(before);
  });

  it("redacts credential-shaped strings in otherwise visible records", async () => {
    const { service, mcp, create } = await setup();
    const row = await create("Redaction", owner);
    service.store.event(row.id, 1, "assessment_log", owner.subject, "Summary", { text: "Bearer fixture-secret-0123456789 and sk-fixture0123456789abcdef" }, "blue");
    const text = JSON.stringify(await mcp.call("get_team_assessments", { exerciseId: row.id }, owner));
    expect(text).not.toContain("fixture-secret");
    expect(text).not.toContain("sk-fixture");
    expect(text).toContain("redacted");
  });

  it("filters source references by cutoff and side, and bounds text and entry counts", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("References", owner);
    const blue = service.store.reports(row.id).find((r) => r.side === "blue")!;
    const red = service.store.reports(row.id).find((r) => r.side === "red")!;
    advance(row.id, 4);
    service.injectReport(row.id);
    const future = service.store.reports(row.id).filter((r) => r.side === "blue").at(-1)!;
    for (let i = 0; i < 110; i++) service.store.event(row.id, 1, "assessment_log", owner.subject, "Summary", { text: "x".repeat(5000), sourceIds: [blue.id, red.id, future.id, "not-a-report"] }, "blue");
    // 100 x 2000 text chars exceed the overall ceiling, so no oversized payload escapes.
    expect(await failure(mcp.call("get_team_assessments", { exerciseId: row.id, tick: 1 }, owner))).toMatchObject({ code: "unavailable" });
    const bounded = mcp.teamAssessments(owner, row.id, 1);
    expect(bounded.entries).toHaveLength(100);
    expect(bounded.truncated).toBe(true);
    for (const e of bounded.entries) {
      expect(e.text).toHaveLength(2000);
      expect(e.sourceIds).toEqual([blue.id]);
    }
  });
});

describe("MCP own staff moment scope", () => {
  it("excludes peer staff records and hidden/future source references before ranking", async () => {
    const { service, mcp, create, advance } = await setup();
    const row = await create("Staff", owner);
    const blue = service.store.reports(row.id).find((r) => r.side === "blue")!;
    const red = service.store.reports(row.id).find((r) => r.side === "red")!;
    advance(row.id, 4);
    service.injectReport(row.id);
    const future = service.store.reports(row.id).filter((r) => r.side === "blue").at(-1)!;
    const own = service.store.event(row.id, 1, "staff_update", owner.subject, "Own watch", { sourceIds: [blue.id, red.id, future.id], method: "deterministic watch" }, "blue");
    const peer = service.store.event(row.id, 1, "staff_update", member.subject, "Peer watch", { sourceIds: [blue.id], method: "private peer method" }, "blue");
    const malformedReport = service.store.event(row.id, 1, "report", "exercise-reporter", "Bad historical link", { reportId: blue.id, supersedes: future.id }, "blue");
    const result = await mcp.call("get_key_moments", { exerciseId: row.id, tick: 1 }, owner);
    const text = JSON.stringify(result);
    expect(text).toContain(own);
    expect(text).toContain(blue.id);
    for (const id of [peer, red.id, future.id, malformedReport, "private peer method"]) expect(text).not.toContain(id);
    expect(result.candidateCount).toBe(1);
  });
});
