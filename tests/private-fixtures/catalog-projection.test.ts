import {privateFixtureRoot} from './root';
import { beforeAll, describe, expect, it } from "vitest";
import { createPresetCatalog } from "../../src/catalog/seed.ts";
import {
  DETERMINISTIC_IMPORT_GAP,
  ENTITY_TYPES,
  GRAPHITI_RESERVED_FIELDS,
  ProjectionInputError,
  RELATION_TYPES,
  aorNodeId,
  buildOntologyGraph,
  canonicalJson,
  catalogNodeId,
  checkGraphIntegrity,
  checkTrialRelativePath,
  curatedKnowledgeExport,
  decisionNodeId,
  finalOutcomeNodeId,
  graphAtCutoff,
  roundOutcomeNodeId,
  seatNodeId,
  sha256Hex,
  trialNodeId,
  validateTrialInput,
  wilsonInterval,
  type OntologyGraph,
  type TrialInput,
} from "../../src/ontology/catalog-projection.ts";
import { MAX_EPISODE_BYTES } from "../../src/ontology/source.ts";
import { exportFiles, readTrialInput } from "../../scripts/export-catalog-ontology.ts";

const TRIAL = "taiwan-sol-blue-opus-red-full-20260915";
const GAME = "dual-ae785c60-ba1c-4e7d-9eb5-09c8487a3564";
const catalog = createPresetCatalog();

let input: TrialInput;
let graph: OntologyGraph;
const node = (id: string) => graph.nodes.find((n) => n.id === id)!;

function clone(i: TrialInput): TrialInput {
  return { name: i.name, files: i.files.map((f) => ({ ...f })), engineReceipt: i.engineReceipt ? { ...i.engineReceipt } : null };
}
function edit(i: TrialInput, path: string, fn: (json: any) => void): void {
  const f = i.files.find((x) => x.path === path)!;
  const j = JSON.parse(f.text);
  fn(j);
  f.text = JSON.stringify(j, null, 2) + "\n";
}
/** Re-declares every summary hash (and the proof's summary copy) so a tamper reaches the deeper checks. */
function redeclareHashes(i: TrialInput): void {
  const shaOf = (p: string) => sha256Hex(i.files.find((x) => x.path === p)!.text);
  edit(i, "final/summary.json", (s) => { for (const src of s.sources) src.sha256 = shaOf(src.path); });
  const summary = JSON.parse(i.files.find((x) => x.path === "final/summary.json")!.text);
  edit(i, "provider-proof.json", (p) => { p.summary = summary; });
}
function rejects(i: TrialInput, code: ProjectionInputError["code"], pattern?: RegExp): void {
  let err: unknown;
  try { validateTrialInput(i); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ProjectionInputError);
  expect((err as ProjectionInputError).code).toBe(code);
  if (pattern) expect((err as Error).message).toMatch(pattern);
}

beforeAll(() => {
  input = readTrialInput(privateFixtureRoot, TRIAL);
  graph = buildOntologyGraph({ catalog, trials: [input] });
});

describe("catalog projection", () => {
  it("projects every catalog record, source and AOR exactly once with exact record hashes", () => {
    const catalogOnly = buildOntologyGraph({ catalog });
    expect(catalogOnly.nodes).toHaveLength(catalog.records.length + catalog.sources.length + catalog.aors.length);
    for (const r of catalog.records) {
      const n = catalogOnly.nodes.find((x) => x.id === catalogNodeId(r.id))!;
      expect(n.provenance.sourceSha256).toBe(sha256Hex(canonicalJson(r)));
      expect(n.dataClass).not.toBe("actual-recorded");
      expect(n.properties.recordedGame).toBe(false);
      expect(n.properties.engineReplay).toBe(false);
    }
    expect(checkGraphIntegrity(catalogOnly)).toEqual([]);
    expect(buildOntologyGraph({ catalog: createPresetCatalog() }).graphSha256).toBe(catalogOnly.graphSha256);
    expect(catalogOnly.inputs[0]).toMatchObject({ kind: "preset-catalog", sha256: sha256Hex(JSON.stringify(catalog)), records: catalog.records.length });
  });

  it("keeps report lineage and review links typed", () => {
    const report5 = catalog.records.find((r) => r.kind === "report" && r.fields.sequence === 5)!;
    const superseded = String(report5.fields.supersedesReportId);
    expect(graph.edges.some((e) => e.type === "SUPERSEDES" && e.source === catalogNodeId(report5.id) && e.target === catalogNodeId(superseded))).toBe(true);
    const review = graph.nodes.find((n) => n.type === "AuthoredReview")!;
    expect(graph.edges.some((e) => e.type === "REVIEWS" && e.source === review.id && node(e.target).type === "AuthoredDecision")).toBe(true);
    for (const e of graph.edges) expect(RELATION_TYPES[e.type].from).toContain(node(e.source).type);
  });

  it("labels persona presets as authored and never infers personality or skill", () => {
    const personas = graph.nodes.filter((n) => n.type === "SyntheticPersona");
    expect(personas).toHaveLength(36);
    for (const p of personas) {
      expect(p.properties).toMatchObject({ personalityInference: "none", skillInference: "none", authenticatedUser: false, field_profileBasis: "authored-preset", field_inferredSkill: false });
      expect(Object.keys(p.properties).filter((k) => /strength|limitation|criterion/i.test(k)).every((k) => k.startsWith("authoredPreset_"))).toBe(true);
      expect(p.hindsight).toBe(true);
    }
    for (const n of graph.nodes.filter((x) => x.dataClass === "actual-recorded" || x.dataClass === "derived-observation")) {
      expect(Object.keys(n.properties).some((k) => /personality|trait|temperament|skillScore|strengths/i.test(k) && !/Inference$/.test(k))).toBe(false);
    }
  });
});

describe("actual trial projection", () => {
  it("validates the recorded game and links every decision to its exact prompt, snapshot, reply and provider record", () => {
    expect(checkGraphIntegrity(graph)).toEqual([]);
    const t = node(trialNodeId(GAME));
    expect(t.properties).toMatchObject({ seed: "DUAL0001", scenarioId: "taiwan-strait/1", map: "taiwan-strait-400", blueModel: "gpt-5.6-sol", redModel: "claude-opus-5", actualRecordedGame: true, authoredExample: false });
    expect(t.hindsight).toBe(false);
    expect(Object.values(t.properties).join(" ")).not.toMatch(/elimination|winner/);
    const summary = JSON.parse(input.files.find((f) => f.path === "final/summary.json")!.text);
    const declared = new Map<string, string>(summary.sources.map((s: any) => [s.path, s.sha256]));
    const decisions = graph.nodes.filter((n) => n.type === "RecordedModelDecision");
    expect(decisions).toHaveLength(34);
    for (const d of decisions) {
      const roles = graph.edges.filter((e) => e.type === "EVIDENCED_BY" && e.source === d.id).map((e) => String(e.properties.role)).sort();
      expect(roles).toEqual(["decision-record", "output-schema", "provider-raw-record", "saved-reply", "saved-reply-copy", "seat-prompt", "seat-snapshot"]);
      const prompt = node(String(d.properties.promptArtifactId));
      expect(prompt.properties.sha256).toBe(d.properties.promptSha256);
      expect(declared.get(String(prompt.properties.path))).toBe(d.properties.promptSha256);
      expect(node(String(d.properties.savedReplyArtifactId)).properties.sha256).toBe(d.properties.responseSha256);
      expect(d.properties.legalityVerified).toBe(true);
      expect(d.properties.executedTick).toBe(d.properties.observedTick);
      expect(graph.edges.some((e) => e.type === "DECIDED" && e.target === d.id && e.source === seatNodeId(GAME, String(d.properties.seat)))).toBe(true);
    }
    const final = node(finalOutcomeNodeId(GAME));
    expect(final.properties).toMatchObject({ winner: "blue", reason: "elimination", ticksSimulated: 4392, finalFingerprint: "45966dc3ea62d847e8e09ed12174e890ac90e37cbe00c55fdb09cd2922ca4556" });
    expect(graph.edges.some((e) => e.source === final.id && e.properties.role === "engine-reconstruction-receipt")).toBe(true);
    for (const a of graph.nodes.filter((n) => n.type === "SourceArtifact")) expect(graph.edges.some((e) => e.target === a.id)).toBe(true);
  });

  it("chains rounds by tick and fingerprint", () => {
    const rounds = graph.nodes.filter((n) => n.type === "ActualRound").sort((a, b) => Number(a.properties.round) - Number(b.properties.round));
    expect(rounds).toHaveLength(17);
    for (let i = 1; i < rounds.length; i++) {
      expect(graph.edges.some((e) => e.type === "NEXT_ROUND" && e.source === rounds[i - 1]!.id && e.target === rounds[i]!.id)).toBe(true);
      expect(node(roundOutcomeNodeId(GAME, i - 1)).properties.fingerprintAfter).toBe(rounds[i]!.properties.preOrderFingerprint);
    }
  });

  it("keeps authored and actual data separate except the setting link", () => {
    const cross = graph.edges.filter((e) => {
      const classes = [node(e.source).dataClass, node(e.target).dataClass];
      return classes.includes("authored-synthetic") && (classes.includes("actual-recorded") || classes.includes("derived-observation"));
    });
    expect(cross.map((e) => [e.type, e.source, e.target])).toEqual([["PLAYED_IN_SETTING", trialNodeId(GAME), aorNodeId("taiwan")]]);
    const tampered: OntologyGraph = { ...graph, edges: [...graph.edges, { ...graph.edges[0]!, id: "edge:bad", type: "USES", source: catalogNodeId("taiwan/case/rowan-vale-1"), target: decisionNodeId(GAME, 0, "blue") }] };
    expect(checkGraphIntegrity(tampered).join("\n")).toMatch(/links authored and actual data|not allowed/);
  });

  it("stores no provider reasoning, session, cost or credential fields", () => {
    const text = JSON.stringify(graph);
    expect(text).not.toMatch(/session_id|sessionId|costUSD|total_cost|thread_id|reasoning_output|Codex-only access token/);
    const rationale = JSON.parse(input.files.find((f) => f.path === "results/03/blue/decision.json")!.text).rationale;
    expect(node(decisionNodeId(GAME, 3, "blue")).properties.modelStatedRationale).toBe(rationale);
  });
});

describe("raw game validation rejects bad input", () => {
  it("rejects traversal and unknown paths", () => {
    for (const p of ["../manifest.json", "/etc/passwd", "rounds/00/../../x.json", "rounds\\00\\round.json", "providers/00-red.stderr", "providers/00-blue.proof.json", ""]) {
      expect(() => checkTrialRelativePath(p)).toThrow(ProjectionInputError);
    }
    const bad = clone(input);
    bad.files.push({ path: "../secrets.json", text: "{}" });
    rejects(bad, "path");
    rejects({ ...clone(input), name: "../other" }, "path");
    const outside = clone(input);
    edit(outside, "provider-proof.json", (p) => { p.rounds[0].seats.blue.providerArtifact = "evidence/codex/raw.jsonl"; });
    rejects(outside, "path");
  });

  it("rejects unresolved, unexpected and changed files", () => {
    const missing = clone(input);
    missing.files = missing.files.filter((f) => f.path !== "rounds/05/red/prompt.md");
    rejects(missing, "missing", /rounds\/05\/red\/prompt\.md/);
    const extra = clone(input);
    extra.files.push({ path: "rounds/44/round.json", text: "{}" });
    rejects(extra, "unexpected");
    const changed = clone(input);
    changed.files.find((f) => f.path === "rounds/07/blue/prompt.md")!.text += "\nextra instruction";
    rejects(changed, "hash", /rounds\/07\/blue\/prompt\.md/);
    const reply = clone(input);
    edit(reply, "results/02/red/response.raw.json", (r) => { r.rationale = "rewritten"; });
    rejects(reply, "hash");
  });

  it("rejects an intent that is not the listed candidate even when hashes are re-declared", () => {
    const bad = clone(input);
    edit(bad, "rounds/03/blue/snapshot.json", (s) => { s.candidates[1].troopOptions = s.candidates[1].troopOptions.filter((o: any) => o.share !== 0.2); });
    redeclareHashes(bad);
    rejects(bad, "legality", /share 0\.2 is not a listed troop option/);
  });

  it("rejects a broken fingerprint chain and a provider reply that differs from the saved reply", () => {
    const chain = clone(input);
    edit(chain, "results/04/outcome.json", (o) => { o.fingerprintAfter = "0".repeat(64); });
    redeclareHashes(chain);
    rejects(chain, "consistency", /fingerprint/);
    const provider = clone(input);
    edit(provider, "providers/06-red.json", (r) => { r.structured_output.choice = 0; });
    edit(provider, "provider-proof.json", (p) => { p.rounds[6].seats.red.providerArtifactSha256 = sha256Hex(provider.files.find((f) => f.path === "providers/06-red.json")!.text); });
    redeclareHashes(provider);
    rejects(provider, "consistency", /structured_output differs/);
  });

  it("enforces bounds and checks the engine receipt against the final state", () => {
    const big = clone(input);
    big.files.find((f) => f.path === "rounds/00/round.json")!.text = "x".repeat(1024 * 1024 + 1);
    rejects(big, "bounds");
    const receipt = clone(input);
    receipt.engineReceipt!.text = receipt.engineReceipt!.text.replace(/"finalFingerprint": "[0-9a-f]+"/, `"finalFingerprint": "${"1".repeat(64)}"`);
    rejects(receipt, "consistency", /engine receipt/);
    expect(validateTrialInput({ ...clone(input), engineReceipt: null }).engineReceipt).toBeNull();
  });
});

describe("time cutoff", () => {
  it("shows only what was released on the trial clock by the cutoff", () => {
    const view = graphAtCutoff(graph, `trial:${GAME}`, 855);
    const ids = new Set(view.nodes.map((n) => n.id));
    for (let r = 0; r <= 3; r++) expect(ids.has(decisionNodeId(GAME, r, "red"))).toBe(true);
    expect(ids.has(decisionNodeId(GAME, 4, "blue"))).toBe(false);
    expect(ids.has(roundOutcomeNodeId(GAME, 2))).toBe(true);
    expect(ids.has(roundOutcomeNodeId(GAME, 3))).toBe(false);
    expect(ids.has(finalOutcomeNodeId(GAME))).toBe(false);
    expect(view.observations).toEqual([]);
    expect(view.nodes.some((n) => n.properties.path === "results/03/outcome.json" || n.properties.path === "final/summary.json" || n.properties.path === "manifest.json")).toBe(false);
    expect(view.nodes.some((n) => n.type === "AuthoredCase" || n.type === "SyntheticReport" || n.type === "SyntheticPersona")).toBe(false);
    expect(ids.has(aorNodeId("taiwan"))).toBe(true);
    expect(view.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it("hides late authored reports, reviews and case summaries before their release tick", () => {
    const c = catalog.records.find((r) => r.kind === "case" && r.fields.variant === "late-correction")!;
    const deadline = Number(c.fields.decisionDeadlineTick);
    const view = graphAtCutoff(graph, `catalog-case:${c.id}`, deadline);
    const ids = new Set(view.nodes.map((n) => n.id));
    const reports = catalog.records.filter((r) => r.kind === "report" && r.caseId === c.id);
    for (const r of reports) expect(ids.has(catalogNodeId(r.id))).toBe(r.availableAtTick! <= deadline);
    expect(reports.some((r) => r.availableAtTick! > deadline)).toBe(true);
    expect(ids.has(catalogNodeId(c.id))).toBe(false);
    expect(view.nodes.some((n) => n.type === "AuthoredReview")).toBe(false);
    expect(view.nodes.some((n) => n.dataClass === "actual-recorded")).toBe(false);
    expect(graphAtCutoff(graph, `catalog-case:${c.id}`, Number(c.fields.reviewTick) + 1).nodes.some((n) => n.id === catalogNodeId(c.id))).toBe(true);
  });
});

describe("behaviour observations", () => {
  const obs = (seat: string, metric: string) => graph.observations.find((o) => o.seat === seat && o.metric === metric)!;

  it("are mechanical counts with resolvable numerators and denominators", () => {
    expect(obs("blue", "wait-rate")).toMatchObject({ numerator: 0, denominator: 17, proportion: 0 });
    expect(graph.observations.every(o => o.interval95 === null)).toBe(true);
    expect(obs("red", "order-submitted-rate")).toMatchObject({ numerator: 17, denominator: 17 });
    expect(obs("blue", "troop-share-0.5")).toMatchObject({ numerator: 13, denominator: 17 });
    expect(obs("red", "intent-construction-share")).toMatchObject({ numerator: 2, denominator: 17 });
    expect(obs("red", "construction-completed-rate")).toMatchObject({ numerator: 1, denominator: 2 });
    expect(obs("blue", "stations-controlled-at-end")).toMatchObject({ numerator: 5, denominator: 5, interval95: null });
    expect(obs("blue", "transport-landed-rate")).toMatchObject({ numerator: 8, denominator: 8 });
    expect(obs("blue", "intent-transport-share")).toMatchObject({ numerator: 8, denominator: 17 });
    for (const seat of ["blue", "red"]) {
      const kinds = graph.observations.filter((o) => o.seat === seat && /^intent-/.test(o.metric));
      expect(kinds.reduce((a, o) => a + o.numerator, 0)).toBe(obs(seat, "order-submitted-rate").numerator);
    }
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const o of graph.observations) {
      expect(o.numerator).toBeLessThanOrEqual(o.denominator);
      expect(o.numeratorNodeIds.every((id) => o.denominatorNodeIds.includes(id) && ids.has(id))).toBe(true);
      expect(o.caveat).toMatch(/Not a skill, strength, doctrine or personality measure/);
      expect(node(o.id).hindsight).toBe(true);
    }
    expect(wilsonInterval(5, 10)).toEqual([0.2366, 0.7634]);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("exports", () => {
  it("builds bounded Graphiti-shaped batches that are clearly not native ingestion", () => {
    const curated = curatedKnowledgeExport(graph);
    expect(curated.nativeIngestion).toBe(false);
    expect(curated.notice).toMatch(/NOT native ingestion/);
    expect(curated.deterministicImportGap).toBe(DETERMINISTIC_IMPORT_GAP);
    const messages = curated.batches.flatMap((b) => b.request.messages);
    expect(messages).toHaveLength(3 + 1 + 17);
    expect(curated.suggestedReviewSubset).toEqual([`trial-${TRIAL}-summary`]);
    for (const b of curated.batches) {
      expect("group_id" in b.request).toBe(false);
      expect(b.request.excluded_entity_types).toEqual(["Entity"]);
      for (const t of Object.values(b.request.entity_types!)) for (const f of Object.keys(t.fields ?? {})) expect(GRAPHITI_RESERVED_FIELDS).not.toContain(f);
      for (const id of b.nodeIds) expect(graph.nodes.some((n) => n.id === id)).toBe(true);
    }
    for (const m of messages) expect(Buffer.byteLength(m.content, "utf8")).toBeLessThanOrEqual(MAX_EPISODE_BYTES);
    const allText = messages.map((m) => m.content).join("\n");
    for (const d of graph.nodes.filter((n) => n.type === "RecordedModelDecision")) expect(allText).not.toContain(String(d.properties.modelStatedRationale));
    expect(JSON.stringify(curatedKnowledgeExport(graph))).toBe(JSON.stringify(curated));
    for (const t of Object.keys(ENTITY_TYPES)) for (const f of Object.keys(ENTITY_TYPES[t as keyof typeof ENTITY_TYPES].fields)) expect(GRAPHITI_RESERVED_FIELDS).not.toContain(f);
  });

  it("writes deterministic portable files that re-verify after a JSON round trip", () => {
    const files = exportFiles(graph);
    expect(exportFiles(buildOntologyGraph({ catalog: createPresetCatalog(), trials: [readTrialInput(privateFixtureRoot, TRIAL)] }))).toEqual(files);
    const reloaded = JSON.parse(files["graph.json"]!) as OntologyGraph;
    expect(checkGraphIntegrity(reloaded)).toEqual([]);
    reloaded.nodes[0]!.summary = "edited";
    expect(checkGraphIntegrity(reloaded).join("\n")).toMatch(/content hash mismatch/);
    expect(files["README.md"]).toMatch(/not the native Kamiwaza graph/);
    expect(Math.max(...graph.nodes.map((n) => Buffer.byteLength(JSON.stringify(n))))).toBeLessThan(16 * 1024);
  });
});

it('imports a completed side-swapped game with each provider format following its model',()=>{
 const swapped=readTrialInput(privateFixtureRoot,'taiwan-paired-20260915-pair0001-opus-blue-sol-red');
 const v=validateTrialInput(swapped);
 expect(v.proofSeats.blue.model).toBe('claude-opus-5');expect(v.proofSeats.red.model).toBe('gpt-5.6-sol');
 const wrong=clone(swapped);edit(wrong,'provider-proof.json',p=>{p.assignment.models.blue='gpt-5.6-sol';});
 expect(()=>validateTrialInput(wrong)).toThrow(/model differs from recorded assignment/);
});
