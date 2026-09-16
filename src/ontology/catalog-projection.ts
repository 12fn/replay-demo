/**
 * Deterministic typed knowledge-graph projection of
 *
 *  1. the authored synthetic preset catalog (`src/catalog`), and
 *  2. completed actual offline two-model trials (`evidence/dual-model-trial/<name>`).
 *
 * Pure: no file, network, model, clock or native calls. The CLI
 * (`scripts/export-catalog-ontology.ts`) reads bytes and hands them in; every
 * hash is recomputed here from the text it was given, so a caller cannot vouch
 * for content it did not supply.
 *
 * Separation rules the projection enforces and `checkGraphIntegrity` re-checks:
 * - Authored examples stay `authored-synthetic`; they are never recast as play.
 *   The only edge between authored and actual data is ActualTrial
 *   PLAYED_IN_SETTING AOR.
 * - Synthetic personas carry authored preset labels only; no personality,
 *   trait or skill is inferred for personas or model seats.
 * - Actual decisions keep references to the exact prompt, snapshot, saved reply
 *   and provider record by path and SHA-256. Provider reasoning items are
 *   verified to exist in shape only and are never copied. The model-stated
 *   rationale is the seat's saved reply field, labelled as such.
 * - Behaviour observations are mechanical counts with numerators, denominators
 *   and denominators, never skill or personality scores.
 *
 * Curated Graphiti messages built here are an export, not native ingestion.
 */
import { createHash } from "node:crypto";
import type { CatalogBundle, CatalogRecord } from "../catalog/types.ts";
import type { AddKnowledgeRequest, EntityTypeSchema, MessageInput } from "../platform/types.ts";
import { MAX_EPISODE_BYTES } from "./source.ts";

export const PROJECTION_ID = "replay.catalog-ontology-projection";
export const PROJECTION_VERSION = "1.0.0";
export const GRAPH_SCHEMA = "replay.ontology-graph/1";
export const GRAPH_NOTICE =
  "Portable projection. authored-synthetic nodes are fictional reference examples, not recorded play or assessments of anyone. actual-recorded nodes come from hash-verified offline two-model trials in a fictional abstract game. derived-observation nodes are mechanical counts, not skill, strength or personality measures. This file is not the native Kamiwaza graph and has not been ingested.";

export const MAX_SUMMARY_CHARS = 480;
export const MAX_TEXT_PROPERTY_CHARS = 1200;
export const TRIAL_BOUNDS = Object.freeze({ maxFiles: 1000, maxFileBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxRounds: 45 });

// ---------------------------------------------------------------- vocabulary

export type EntityType =
  | "AOR" | "SyntheticPersona" | "AuthoredCase" | "SyntheticReport" | "AuthoredDecision" | "AuthoredReview" | "Lesson" | "GlossaryTerm"
  | "HistoricalReference" | "Source" | "Asset" | "Organization" | "RedProfile"
  | "ActualTrial" | "ModelSeat" | "ActualRound" | "RecordedModelDecision" | "ObservedOutcome" | "SourceArtifact" | "BehaviorObservation";

export type DataClass = "authored-synthetic" | "public-reference" | "actual-recorded" | "derived-observation";

export interface EntityTypeDefinition {
  dataClass: DataClass;
  description: string;
  /** Graphiti-compatible attribute descriptions. Reserved Graphiti node attributes are never used as keys. */
  fields: Record<string, string>;
}

const AUTHORED = "authored-synthetic" as const, PUBLIC = "public-reference" as const, ACTUAL = "actual-recorded" as const, DERIVED = "derived-observation" as const;

export const ENTITY_TYPES: Readonly<Record<EntityType, EntityTypeDefinition>> = Object.freeze({
  AOR: { dataClass: AUTHORED, description: "An authored exercise setting (area of responsibility) in the REPLAY preset catalog; fictional forces on named geography.", fields: { aor_key: "catalog AOR id", playable_scenario: "playable scenario id or none" } },
  SyntheticPersona: { dataClass: AUTHORED, description: "A fictional demo persona preset described by authored decision behaviours in authored cases; not a user, not a real person, no inferred skill or personality.", fields: { role: "commander, intelligence or instructor", profile_basis: "always authored-preset" } },
  AuthoredCase: { dataClass: AUTHORED, description: "An illustrative authored case timeline; not a recorded game, engine replay or assessment.", fields: { lesson_key: "lesson the case illustrates", variant: "late-correction or early-corroboration" } },
  SyntheticReport: { dataClass: AUTHORED, description: "Illustrative authored report text inside an authored case with an observed tick and a release tick on that case's authored clock.", fields: { observed_tick: "authored observation tick", released_tick: "authored release tick" } },
  AuthoredDecision: { dataClass: AUTHORED, description: "An in-exercise authored example step (assessment, decision, update or delegation) inside an authored case.", fields: { event_type: "assessment, decision, update or delegation", tick: "authored case tick" } },
  AuthoredReview: { dataClass: AUTHORED, description: "An authored post-hoc review of an authored case, separating outcome from reasoning.", fields: { review_focus: "outcome or reasoning", rating: "authored rating label" } },
  Lesson: { dataClass: AUTHORED, description: "An authored learning objective in one AOR.", fields: { lesson_key: "lesson key" } },
  GlossaryTerm: { dataClass: AUTHORED, description: "An authored glossary term for an AOR's game setting.", fields: { term: "term" } },
  HistoricalReference: { dataClass: PUBLIC, description: "A discussion card that links a public historical source and repeats only its original summary; not reenacted.", fields: { publisher: "source publisher" } },
  Source: { dataClass: PUBLIC, description: "A public reference link with its original short summary and retrieval date.", fields: { url: "public URL", retrieved_at: "retrieval date" } },
  Asset: { dataClass: AUTHORED, description: "A fictional game asset with authored capabilities and constraints.", fields: { category: "patrol, sensor, communications, logistics or weather" } },
  Organization: { dataClass: AUTHORED, description: "A fictional game organization; not a real unit or agency.", fields: { primary_role: "role" } },
  RedProfile: { dataClass: AUTHORED, description: "An authored fictional Red cell play-style profile for an AOR.", fields: { playable: "whether the AOR has a playable scenario" } },
  ActualTrial: { dataClass: ACTUAL, description: "One completed offline two-model game run with a fixed scenario, seed, engine commit and model per seat; setup only, no hindsight.", fields: { game_id: "recorded game id", scenario_id: "scenario id", seed: "simulation seed" } },
  ModelSeat: { dataClass: ACTUAL, description: "A seat (blue or red) in an actual trial played by one named external model; identity only, no inferred traits.", fields: { seat: "blue or red", model: "requested model id" } },
  ActualRound: { dataClass: ACTUAL, description: "One decision round of an actual trial: pre-order state fingerprint at a tick and the engine window that followed.", fields: { round_index: "round number", tick: "decision tick", end_tick: "window end tick" } },
  RecordedModelDecision: { dataClass: ACTUAL, description: "A model's saved choice among engine-validated candidates at one tick, with exact prompt, snapshot and reply artifact hashes.", fields: { seat: "blue or red", intent_type: "attack, boat, build_unit or hold", share: "chosen troop share" } },
  ObservedOutcome: { dataClass: ACTUAL, description: "Board state and execution feedback observed after a round, or the final game outcome; observation only, no causal attribution.", fields: { observed_tick: "tick of observation", winner: "winning seat when final" } },
  SourceArtifact: { dataClass: ACTUAL, description: "A write-once evidence file referenced by path and SHA-256.", fields: { path: "path relative to the trial directory", sha256: "hex digest" } },
  BehaviorObservation: { dataClass: DERIVED, description: "A mechanical per-run count or rate for one model seat with numerator, denominator and interval; not a skill, strength or personality score.", fields: { metric: "metric key", numerator: "count", denominator: "count" } },
});

export type RelationType =
  | "IN_AOR" | "BELONGS_TO" | "AUTHORED_BY" | "CITES" | "DERIVED_FROM" | "SUPERSEDES" | "DISPUTES" | "REVIEWS" | "PRECEDES" | "USES" | "CONTRASTS_WITH" | "REFERENCES_SOURCE"
  | "PLAYED_IN_SETTING" | "HAS_SEAT" | "HAS_ROUND" | "NEXT_ROUND" | "DECIDED" | "IN_ROUND" | "EVIDENCED_BY" | "RESULTED_IN" | "FOLLOWED_BY" | "ENDED_WITH" | "HAS_OBSERVATION" | "COMPUTED_FROM";

export interface RelationDefinition { from: readonly EntityType[]; to: readonly EntityType[]; statement: string }

const CATALOG_MEMBERS: EntityType[] = ["SyntheticPersona", "AuthoredCase", "SyntheticReport", "AuthoredDecision", "AuthoredReview", "Lesson", "GlossaryTerm", "HistoricalReference", "Asset", "Organization", "RedProfile"];
const AUTHORED_EVENTS: EntityType[] = ["AuthoredDecision", "AuthoredReview"];

export const RELATION_TYPES: Readonly<Record<RelationType, RelationDefinition>> = Object.freeze({
  IN_AOR: { from: CATALOG_MEMBERS, to: ["AOR"], statement: "Authored catalog record belongs to an AOR setting." },
  BELONGS_TO: { from: ["Asset", "SyntheticPersona", "SyntheticReport", ...AUTHORED_EVENTS], to: ["Organization", "AuthoredCase"], statement: "Authored record belongs to an organization or authored case." },
  AUTHORED_BY: { from: ["AuthoredCase", "AuthoredDecision"], to: ["SyntheticPersona"], statement: "Authored example is attributed to a fictional persona preset." },
  CITES: { from: [...AUTHORED_EVENTS, "Lesson"], to: ["SyntheticReport", "HistoricalReference"], statement: "Authored step cites a report released by its tick, or a lesson cites a historical card." },
  DERIVED_FROM: { from: ["SyntheticReport"], to: ["SyntheticReport"], statement: "Authored report restates an earlier report; not independent." },
  SUPERSEDES: { from: ["SyntheticReport"], to: ["SyntheticReport"], statement: "Authored correction replaces an earlier report." },
  DISPUTES: { from: ["SyntheticReport"], to: ["SyntheticReport"], statement: "Authored report conflicts with an earlier report." },
  REVIEWS: { from: ["AuthoredReview"], to: ["AuthoredDecision"], statement: "Authored review examines an authored step." },
  PRECEDES: { from: AUTHORED_EVENTS, to: AUTHORED_EVENTS, statement: "Authored step comes before the next step on the case clock." },
  USES: { from: ["AuthoredCase", "SyntheticPersona", "Lesson"], to: ["Lesson", "Asset", "RedProfile", "GlossaryTerm"], statement: "Authored record uses a lesson, asset, Red profile or glossary term." },
  CONTRASTS_WITH: { from: ["AuthoredCase"], to: ["AuthoredCase"], statement: "Authored case is the contrast pair of another authored case." },
  REFERENCES_SOURCE: { from: ["AOR", "GlossaryTerm", "HistoricalReference", "Lesson"], to: ["Source"], statement: "Record links a public reference source." },
  PLAYED_IN_SETTING: { from: ["ActualTrial"], to: ["AOR"], statement: "Actual trial used the playable scenario of this AOR setting; authored examples of that AOR are not part of the trial." },
  HAS_SEAT: { from: ["ActualTrial"], to: ["ModelSeat"], statement: "Actual trial seat played by a named model." },
  HAS_ROUND: { from: ["ActualTrial"], to: ["ActualRound"], statement: "Actual trial contains the round." },
  NEXT_ROUND: { from: ["ActualRound"], to: ["ActualRound"], statement: "Round is followed by the next round; the post-window fingerprint equals the next pre-order fingerprint." },
  DECIDED: { from: ["ModelSeat"], to: ["RecordedModelDecision"], statement: "Seat's model returned this saved choice." },
  IN_ROUND: { from: ["RecordedModelDecision"], to: ["ActualRound"], statement: "Decision was made from the round's pre-order snapshot." },
  EVIDENCED_BY: { from: ["ActualTrial", "ModelSeat", "ActualRound", "RecordedModelDecision", "ObservedOutcome"], to: ["SourceArtifact"], statement: "Graph fact is backed by a hash-verified evidence file in the stated role." },
  RESULTED_IN: { from: ["ActualRound"], to: ["ObservedOutcome"], statement: "Round window ended with the observed board state." },
  FOLLOWED_BY: { from: ["RecordedModelDecision"], to: ["ObservedOutcome"], statement: "Outcome was observed after the decision executed; no causal attribution." },
  ENDED_WITH: { from: ["ActualTrial"], to: ["ObservedOutcome"], statement: "Actual trial stopped with this recorded outcome." },
  HAS_OBSERVATION: { from: ["ModelSeat"], to: ["BehaviorObservation"], statement: "Mechanical per-run observation for the seat." },
  COMPUTED_FROM: { from: ["BehaviorObservation"], to: ["RecordedModelDecision", "ObservedOutcome", "ActualRound"], statement: "Observation counted this node in its denominator." },
});

// ---------------------------------------------------------------- graph shapes

export type Scalar = string | number | boolean | null;
export type PropertyValue = Scalar | string[] | number[];

export interface GraphTime {
  /** `catalog-case:<caseId>` (authored per-case clock) or `trial:<gameId>` (engine ticks). Clocks are never compared with each other. */
  clock: string;
  observedTick: number | null;
  releasedTick: number;
}

export interface OntologyNode {
  id: string;
  type: EntityType;
  dataClass: DataClass;
  label: string;
  summary: string;
  properties: Record<string, PropertyValue>;
  provenance: { origin: "preset-catalog" | "dual-model-trial" | "projection"; sourceRef: string; sourceSha256: string | null };
  /** null: static reference data with no clock. */
  time: GraphTime | null;
  /** Content only knowable once its clock has ended (authored review ratings, final outcomes, whole-run observations). */
  hindsight: boolean;
  contentSha256: string;
}

export interface OntologyEdge {
  id: string;
  type: RelationType;
  source: string;
  target: string;
  dataClass: DataClass;
  fact: string;
  properties: Record<string, PropertyValue>;
  contentSha256: string;
}

export type InputRef =
  | { kind: "preset-catalog"; schema: string; version: string; seed: string; sha256: string; records: number }
  | { kind: "dual-model-trial"; name: string; gameId: string; files: number; totalBytes: number; manifestSha256: string; summarySha256: string; engineReceipt: { path: string; sha256: string } | null };

export interface OntologyGraph {
  schema: typeof GRAPH_SCHEMA;
  projection: { id: string; version: string };
  notice: string;
  inputs: InputRef[];
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  observations: BehaviorObservationValue[];
  graphSha256: string;
}

export class ProjectionInputError extends Error {
  constructor(readonly code: "bounds" | "path" | "missing" | "unexpected" | "hash" | "schema" | "consistency" | "legality", message: string) {
    super(`${code}: ${message}`);
    this.name = "ProjectionInputError";
  }
}

// ---------------------------------------------------------------- helpers

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON: object keys sorted, arrays in order. Used for every content hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const bound = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const fail = (code: ProjectionInputError["code"], message: string): never => { throw new ProjectionInputError(code, message); };
const need = (cond: unknown, code: ProjectionInputError["code"], message: string) => { if (!cond) fail(code, message); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const pad2 = (n: number) => String(n).padStart(2, "0");

function boundedProperties(input: Record<string, unknown>): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const key of Object.keys(input).sort()) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v === "string") out[key] = bound(v, MAX_TEXT_PROPERTY_CHARS);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[key] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[key] = (v as string[]).map((x) => bound(x, MAX_TEXT_PROPERTY_CHARS));
    else if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[key] = [...(v as number[])];
    else out[key] = bound(canonicalJson(v), MAX_TEXT_PROPERTY_CHARS);
  }
  return out;
}

function hashNode(n: Omit<OntologyNode, "contentSha256">): string {
  return sha256Hex(canonicalJson(n));
}
function hashEdge(e: Omit<OntologyEdge, "contentSha256">): string {
  return sha256Hex(canonicalJson(e));
}

class GraphBuilder {
  private readonly nodes = new Map<string, OntologyNode>();
  private readonly edges = new Map<string, OntologyEdge>();

  node(n: Omit<OntologyNode, "contentSha256" | "dataClass" | "properties" | "summary"> & { summary: string; properties: Record<string, unknown> }): string {
    if (this.nodes.has(n.id)) throw new Error(`duplicate node ${n.id}`);
    const base: Omit<OntologyNode, "contentSha256"> = {
      id: n.id, type: n.type, dataClass: ENTITY_TYPES[n.type].dataClass, label: bound(n.label, 200), summary: bound(n.summary, MAX_SUMMARY_CHARS),
      properties: boundedProperties(n.properties), provenance: n.provenance, time: n.time, hindsight: n.hindsight,
    };
    this.nodes.set(n.id, { ...base, contentSha256: hashNode(base) });
    return n.id;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  edge(type: RelationType, source: string, target: string, fact?: string, properties: Record<string, unknown> = {}): void {
    const id = edgeId(type, source, target, typeof properties.role === "string" ? properties.role : "");
    if (this.edges.has(id)) return;
    const s = this.nodes.get(source), t = this.nodes.get(target);
    if (!s || !t) throw new Error(`edge ${type} has unresolved endpoint ${!s ? source : target}`);
    const dataClass: DataClass = s.dataClass === DERIVED || t.dataClass === DERIVED ? DERIVED : s.dataClass === ACTUAL || t.dataClass === ACTUAL ? ACTUAL : s.dataClass === PUBLIC && t.dataClass === PUBLIC ? PUBLIC : AUTHORED;
    const base: Omit<OntologyEdge, "contentSha256"> = { id, type, source, target, dataClass, fact: bound(fact ?? RELATION_TYPES[type].statement, MAX_SUMMARY_CHARS), properties: boundedProperties(properties) };
    this.edges.set(id, { ...base, contentSha256: hashEdge(base) });
  }

  build(): { nodes: OntologyNode[]; edges: OntologyEdge[] } {
    return {
      nodes: [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      edges: [...this.edges.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  }
}

export function edgeId(type: RelationType, source: string, target: string, role = ""): string {
  return `edge:${type}:${sha256Hex(`${source}\n${type}\n${target}\n${role}`).slice(0, 32)}`;
}

// ---------------------------------------------------------------- catalog projection

export const catalogNodeId = (recordId: string) => `catalog:${recordId}`;
export const aorNodeId = (aorId: string) => `catalog:aor/${aorId}`;
export const sourceNodeId = (sourceId: string) => `catalog:source/${sourceId}`;

const CATALOG_LINK_TYPES: Record<CatalogRecord["links"][number]["relation"], RelationType> = {
  "belongs-to": "BELONGS_TO", "authored-by": "AUTHORED_BY", cites: "CITES", "derived-from": "DERIVED_FROM", supersedes: "SUPERSEDES",
  disputes: "DISPUTES", reviews: "REVIEWS", precedes: "PRECEDES", uses: "USES", "contrasts-with": "CONTRASTS_WITH",
};

/** Persona fields that are authored prose about decision behaviour; kept, but flagged so they are never read as personality or skill. */
const PERSONA_PRESET_FIELDS = new Set(["strengths", "limitations", "criterionStatus", "criterionRule", "supportedReasoningCases"]);

function catalogEntityType(r: CatalogRecord): EntityType {
  switch (r.kind) {
    case "persona": return "SyntheticPersona";
    case "case": return "AuthoredCase";
    case "report": return "SyntheticReport";
    case "event": return r.fields.phase === "post-hoc" ? "AuthoredReview" : "AuthoredDecision";
    case "lesson": return "Lesson";
    case "glossary": return "GlossaryTerm";
    case "historical": return "HistoricalReference";
    case "asset": return "Asset";
    case "organization": return "Organization";
    case "red-profile": return "RedProfile";
  }
}

function projectCatalogInto(g: GraphBuilder, bundle: CatalogBundle): InputRef {
  const bundleSha = sha256Hex(JSON.stringify(bundle));
  const ref = (id: string) => `${bundle.version}#${id}`;
  const origin = "preset-catalog" as const;

  for (const s of bundle.sources) {
    g.node({ id: sourceNodeId(s.id), type: "Source", label: s.title, summary: s.summary, time: null, hindsight: false,
      provenance: { origin, sourceRef: ref(`source/${s.id}`), sourceSha256: sha256Hex(canonicalJson(s)) },
      properties: { sourceId: s.id, url: s.url, publisher: s.publisher, retrievedAt: s.retrievedAt, usage: s.usage, scope: s.scope } });
  }
  for (const a of bundle.aors) {
    g.node({ id: aorNodeId(a.id), type: "AOR", label: a.name, summary: a.summary, time: null, hindsight: false,
      provenance: { origin, sourceRef: ref(`aor/${a.id}`), sourceSha256: sha256Hex(canonicalJson(a)) },
      properties: { aorId: a.id, theater: a.theater, playableScenarioId: a.playableScenarioId, focus: a.focus, authoredSetting: true } });
    for (const s of a.sourceIds) g.edge("REFERENCES_SOURCE", aorNodeId(a.id), sourceNodeId(s));
  }

  // Latest event tick per case: case summaries carry review ratings and are released only then.
  const lastEventTick = new Map<string, number>();
  for (const r of bundle.records) if (r.kind === "event" && r.caseId && typeof r.observedTick === "number") lastEventTick.set(r.caseId, Math.max(lastEventTick.get(r.caseId) ?? -Infinity, r.observedTick));

  for (const r of bundle.records) {
    const type = catalogEntityType(r);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r.fields)) fields[k] = v;
    let time: GraphTime | null = null, hindsight = false;
    if (r.kind === "report" || r.kind === "event") {
      time = { clock: `catalog-case:${r.caseId}`, observedTick: r.observedTick ?? null, releasedTick: r.availableAtTick ?? r.observedTick ?? 0 };
      hindsight = type === "AuthoredReview";
    } else if (r.kind === "case") {
      time = { clock: `catalog-case:${r.id}`, observedTick: null, releasedTick: lastEventTick.get(r.id) ?? 0 };
      hindsight = true;
    } else if (r.kind === "persona") {
      hindsight = true; // criterion status summarises authored review ratings across three case clocks
    }
    const properties: Record<string, unknown> = {
      recordId: r.id, aorId: r.aorId, kind: r.kind, roles: r.roles, tags: r.tags, provenanceClass: r.provenance,
      bodyExcerpt: r.body, authoredExample: r.provenance === "synthetic", recordedGame: false, engineReplay: false,
      ...(r.personaId ? { personaRecordId: r.personaId } : {}), ...(r.caseId ? { caseRecordId: r.caseId } : {}),
    };
    for (const [k, v] of Object.entries(fields)) properties[type === "SyntheticPersona" && PERSONA_PRESET_FIELDS.has(k) ? `authoredPreset_${k}` : `field_${k}`] = v;
    if (type === "SyntheticPersona") Object.assign(properties, { personalityInference: "none", skillInference: "none", authenticatedUser: false });
    g.node({ id: catalogNodeId(r.id), type, label: r.title, summary: r.summary, time, hindsight,
      provenance: { origin, sourceRef: ref(r.id), sourceSha256: sha256Hex(canonicalJson(r)) }, properties });
  }
  for (const r of bundle.records) {
    const from = catalogNodeId(r.id);
    g.edge("IN_AOR", from, aorNodeId(r.aorId));
    for (const l of r.links) g.edge(CATALOG_LINK_TYPES[l.relation], from, catalogNodeId(l.targetId), undefined, { catalogRelation: l.relation });
    for (const s of r.sourceIds) g.edge("REFERENCES_SOURCE", from, sourceNodeId(s));
  }
  return { kind: "preset-catalog", schema: bundle.schema, version: bundle.version, seed: bundle.seed, sha256: bundleSha, records: bundle.records.length };
}

// ---------------------------------------------------------------- trial input validation

export interface TrialFile {
  /** Path relative to `evidence/dual-model-trial/<name>/`, or for receipts relative to the repository root. */
  path: string;
  text: string;
}

export interface TrialInput {
  name: string;
  files: TrialFile[];
  /** Optional independent engine reconstruction receipt written by scripts/qualify-dual-model-result.ts. */
  engineReceipt?: TrialFile | null;
}

const TRIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,70}$/;
const FIXED_TRIAL_PATHS = ["manifest.json", "provider-proof.json", "initialization/game.json", "final/summary.json", "final/replay.json"] as const;
const TRIAL_PATH_PATTERNS: RegExp[] = [
  /^(manifest|provider-proof)\.json$/, /^initialization\/game\.json$/, /^final\/(summary|replay)\.json$/,
  /^rounds\/\d{2}\/(round|replay)\.json$/, /^rounds\/\d{2}\/(blue|red)\/(prompt\.md|schema\.json|snapshot\.json)$/,
  /^results\/\d{2}\/outcome\.json$/, /^results\/\d{2}\/(blue|red)\/(decision|response\.raw)\.json$/,
  /^responses\/\d{2}-(blue|red)\.json$/, /^providers\/\d{2}-(blue|red)\.jsonl?$/,
];

/** Rejects absolute paths, traversal, backslashes, empty or dot segments, and anything outside the known trial layout. */
export function checkTrialRelativePath(p: string): string {
  need(typeof p === "string" && p.length > 0 && p.length <= 120, "path", "path must be a short non-empty string");
  need(!p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !/^[A-Za-z]:/.test(p), "path", `path ${JSON.stringify(p)} is not relative`);
  need(p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."), "path", `path ${JSON.stringify(p)} contains traversal or empty segments`);
  need(TRIAL_PATH_PATTERNS.some((re) => re.test(p)), "path", `path ${JSON.stringify(p)} is not a recognised trial artifact`);
  return p;
}

export function checkTrialName(name: string): string {
  need(typeof name === "string" && TRIAL_NAME.test(name), "path", "trial name must match [A-Za-z0-9][A-Za-z0-9-]{0,70}");
  return name;
}

export function engineReceiptPath(name: string): string {
  return `evidence/platform/${checkTrialName(name)}-main-review.json`;
}

export function fixedTrialPaths(): readonly string[] {
  return FIXED_TRIAL_PATHS;
}

type Json = any; // parsed evidence JSON; every field used below is checked before use

function parseJson(path: string, text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return fail("schema", `${path} is not valid JSON`);
  }
}

/** Maps a proof path (`evidence/dual-model-trial/<name>/...`) to a trial-relative path; anything else is refused. */
function proofPath(name: string, p: unknown): string {
  const prefix = `evidence/dual-model-trial/${name}/`;
  need(typeof p === "string" && p.startsWith(prefix), "path", `provider artifact ${JSON.stringify(p)} is outside evidence/dual-model-trial/${name}`);
  return checkTrialRelativePath((p as string).slice(prefix.length));
}

/**
 * Every trial-relative path the validator needs, derived from the three fixed index files.
 * The CLI reads exactly this list, so no directory is scanned.
 */
export function referencedTrialPaths(name: string, fixed: { manifest: string; proof: string; summary: string }): string[] {
  checkTrialName(name);
  const manifest = parseJson("manifest.json", fixed.manifest), proof = parseJson("provider-proof.json", fixed.proof), summary = parseJson("final/summary.json", fixed.summary);
  need(Array.isArray(summary?.sources) && Array.isArray(proof?.rounds) && Array.isArray(manifest?.history), "schema", "index files lack sources, rounds or history");
  need(proof.rounds.length <= TRIAL_BOUNDS.maxRounds && manifest.history.length <= TRIAL_BOUNDS.maxRounds, "bounds", `more than ${TRIAL_BOUNDS.maxRounds} rounds`);
  const paths = new Set<string>(FIXED_TRIAL_PATHS);
  for (const s of summary.sources) paths.add(checkTrialRelativePath(s?.path));
  for (const round of proof.rounds) for (const seat of ["blue", "red"]) {
    const row = round?.seats?.[seat];
    need(row, "missing", `provider-proof round ${round?.round} has no ${seat} seat`);
    paths.add(proofPath(name, row.providerArtifact));
    paths.add(checkTrialRelativePath(row.response));
  }
  for (let i = 0; i < manifest.history.length; i++) {
    const n = pad2(i);
    for (const p of [`rounds/${n}/round.json`, `rounds/${n}/replay.json`, `results/${n}/outcome.json`]) paths.add(p);
    for (const seat of ["blue", "red"]) for (const f of ["prompt.md", "schema.json", "snapshot.json"]) paths.add(`rounds/${n}/${seat}/${f}`);
    for (const seat of ["blue", "red"]) for (const f of ["decision.json", "response.raw.json"]) paths.add(`results/${n}/${seat}/${f}`);
  }
  need(paths.size <= TRIAL_BOUNDS.maxFiles, "bounds", `trial references ${paths.size} files; bound is ${TRIAL_BOUNDS.maxFiles}`);
  return [...paths].sort();
}

interface VerifiedFile { path: string; sha256: string; bytes: number; text: string }

interface ValidatedDecision {
  round: number; seat: "blue" | "red"; tick: number; executedTick: number | null; queuePosition: number | null; executedKey: string | null;
  snapshotId: string; choice: number | "hold"; share: number | null; intent: Json; meaning: string | null; rationale: string;
  candidateCount: number; reserveFraction: number | null; reserveEligible: boolean | null; forcesAtHome: number | null;
  acceptedAt: string | null; model: string; responseSha256: string; promptSha256: string;
  paths: { prompt: string; snapshot: string; schema: string; decision: string; rawReply: string; response: string; provider: string };
}

interface ValidatedRound {
  round: number; tick: number; endTick: number; leadingSeat: string; queue: string[]; fingerprint: string; fingerprintAfter: string;
  scoresBefore: Json; scoresAfter: Json; controllersAfter: Json; boardBefore: Json; boardAfter: Json; feedback: { blue: Json[]; red: Json[] };
  outcome: Json | null; decisions: Record<"blue" | "red", ValidatedDecision>;
}

export interface ValidatedTrial {
  name: string; gameId: string; createdAt: string; config: Json; game: Json; summary: Json; proofSeats: Json;
  files: Map<string, VerifiedFile>; rounds: ValidatedRound[]; stations: { id: string; name: string; tile: number }[];
  engineReceipt: VerifiedFile | null; totalBytes: number;
}

const SEATS = ["blue", "red"] as const;

/**
 * Validates one completed trial from supplied file texts: bounds, path safety, exact file set, every
 * declared SHA-256, provider replies against saved responses, choice legality against the listed
 * candidates, fingerprint and tick chains, and final summary counts. Throws ProjectionInputError.
 * It does not re-run the engine; an optional qualification receipt links that independent check.
 */
export function validateTrialInput(input: TrialInput): ValidatedTrial {
  const name = checkTrialName(input.name);
  need(Array.isArray(input.files), "schema", "files must be an array");
  need(input.files.length <= TRIAL_BOUNDS.maxFiles, "bounds", `${input.files.length} files exceeds ${TRIAL_BOUNDS.maxFiles}`);
  const files = new Map<string, VerifiedFile>();
  let totalBytes = 0;
  for (const f of input.files) {
    const p = checkTrialRelativePath(f.path);
    need(typeof f.text === "string", "schema", `${p} has no text`);
    need(!files.has(p), "unexpected", `duplicate file ${p}`);
    const bytes = Buffer.byteLength(f.text, "utf8");
    need(bytes <= TRIAL_BOUNDS.maxFileBytes, "bounds", `${p} is ${bytes} bytes; bound is ${TRIAL_BOUNDS.maxFileBytes}`);
    totalBytes += bytes;
    need(totalBytes <= TRIAL_BOUNDS.maxTotalBytes, "bounds", `trial exceeds ${TRIAL_BOUNDS.maxTotalBytes} bytes`);
    files.set(p, { path: p, sha256: sha256Hex(f.text), bytes, text: f.text });
  }
  const text = (p: string) => files.get(p)?.text ?? fail("missing", `unresolved reference ${p}`);
  const json = (p: string) => parseJson(p, text(p));
  const sha = (p: string) => files.get(p)?.sha256 ?? fail("missing", `unresolved reference ${p}`);

  const required = referencedTrialPaths(name, { manifest: text("manifest.json"), proof: text("provider-proof.json"), summary: text("final/summary.json") });
  for (const p of required) need(files.has(p), "missing", `unresolved reference ${p}`);
  for (const p of files.keys()) need(required.includes(p), "unexpected", `unreferenced file ${p} supplied`);

  const manifest = json("manifest.json"), proof = json("provider-proof.json"), game = json("initialization/game.json"), summary = json("final/summary.json"), replay = json("final/replay.json");
  need(manifest.schema === "replay.dual-model-trial/1" && manifest.status === "complete", "schema", "manifest is not a complete replay.dual-model-trial/1 run");
  need(game.schema === "replay.dual-model-trial/1#game" && summary.schema === "replay.dual-model-trial/1#summary", "schema", "unexpected game or summary schema");
  need(proof.status === "completed", "schema", "provider proof is not completed");
  const gameId: string = manifest.gameId;
  need(typeof gameId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(gameId), "schema", "gameId missing or malformed");
  need([proof.gameId, game.gameId, summary.gameId].every((x) => x === gameId), "consistency", "gameId differs across index files");
  need(same(manifest.config, game.config) && same(manifest.config, summary.config), "consistency", "config differs across manifest, game and summary");
  need(typeof manifest.config?.seed === "string" && typeof game.scenarioId === "string" && game.scenarioId === manifest.config.scenario, "schema", "seed or scenario identity missing");

  for (const s of summary.sources) need(sha(s.path) === s.sha256, "hash", `${s.path} sha256 differs from final/summary.json`);
  need(same(proof.summary, summary), "consistency", "provider-proof summary differs from final/summary.json");
  const history: Json[] = manifest.history;
  need(proof.rounds.length === history.length && summary.rounds === history.length && history.length > 0, "consistency", "round counts differ");
  need(proof.modelCallsAttempted === history.length * 2 && proof.retries === 0 && proof.appInferenceCalls === 0, "consistency", "provider call accounting differs from rounds");

  const stations: { id: string; name: string; tile: number }[] = (game.scenario?.stationLayout ?? []).map((s: Json) => ({ id: String(s.id), name: String(s.name), tile: Number(s.tile) }));
  const proofSeats: Json = {};
  const rounds: ValidatedRound[] = [];
  const allFeedback: Record<"blue" | "red", Json[]> = { blue: [], red: [] };

  for (let i = 0; i < history.length; i++) {
    const h = history[i], pr = proof.rounds[i], n = pad2(i);
    need(h.round === i && pr.round === i && pr.tick === h.tick && pr.applied === true && pr.applicationStatus === "applied", "consistency", `round ${i} index, tick or application status differs`);
    const round = json(`rounds/${n}/round.json`), outcome = json(`results/${n}/outcome.json`);
    need(round.gameId === gameId && round.round === i && round.tick === h.tick, "consistency", `rounds/${n}/round.json identity differs`);
    need(outcome.gameId === gameId && outcome.round === i && outcome.fromTick === h.tick && outcome.toTick === h.endTick, "consistency", `results/${n}/outcome.json window differs`);
    need(same(outcome.queue?.order, h.queue) && outcome.queue?.leadingSeat === h.leadingSeat && round.leadingSeat === h.leadingSeat, "consistency", `round ${i} queue differs`);
    need(outcome.reconstruction?.fingerprintMatched === true && outcome.reconstruction?.snapshotsRebuiltIdentically === true, "consistency", `round ${i} reconstruction flags not true`);
    if (i > 0) {
      const prev = rounds[i - 1]!;
      need(prev.endTick === h.tick, "consistency", `round ${i} tick does not follow round ${i - 1}`);
      need(prev.fingerprintAfter === round.fingerprint, "consistency", `round ${i} pre-order fingerprint differs from round ${i - 1} fingerprintAfter`);
    }
    const decisions = {} as Record<"blue" | "red", ValidatedDecision>;
    for (const seat of SEATS) {
      const hs = h.seats?.[seat], row = pr.seats?.[seat];
      const paths = {
        prompt: `rounds/${n}/${seat}/prompt.md`, snapshot: `rounds/${n}/${seat}/snapshot.json`, schema: `rounds/${n}/${seat}/schema.json`,
        decision: `results/${n}/${seat}/decision.json`, rawReply: `results/${n}/${seat}/response.raw.json`,
        response: checkTrialRelativePath(row.response), provider: proofPath(name, row.providerArtifact),
      };
      need(paths.response === `responses/${n}-${seat}.json`, "consistency", `round ${i} ${seat} response path is ${paths.response}`);
      const snapshot = json(paths.snapshot), decision = json(paths.decision), response = json(paths.response), rawReply = json(paths.rawReply);
      need(snapshot.schema === "replay.ai-player-trial/1#seat-snapshot" && snapshot.gameId === gameId && snapshot.seat === seat && snapshot.tick === h.tick, "consistency", `${paths.snapshot} identity differs`);
      need(snapshot.fingerprint === round.fingerprint, "consistency", `${paths.snapshot} fingerprint differs from round state`);
      need(snapshot.snapshotId === hs.snapshotId && round.snapshotIds?.[seat] === hs.snapshotId && row.snapshotId === hs.snapshotId && decision.snapshotId === hs.snapshotId, "consistency", `round ${i} ${seat} snapshotId differs`);
      need(sha(paths.prompt) === row.promptSha256, "hash", `${paths.prompt} sha256 differs from provider proof`);
      need(sha(paths.provider) === row.providerArtifactSha256, "hash", `${paths.provider} sha256 differs from provider proof`);
      need(row.status === "returned" && typeof row.model === "string" && row.model.length > 0, "schema", `round ${i} ${seat} provider row not returned`);
      const expectedModel = proof.assignment?.models?.[seat] ?? (seat === 'blue' ? 'gpt-5.6-sol' : 'claude-opus-5');
      need(row.model === expectedModel, "consistency", `round ${i} ${seat} model differs from recorded assignment`);
      need(paths.provider.endsWith('.jsonl') === (row.model === 'gpt-5.6-sol'), "consistency", `round ${i} ${seat} provider format differs from model`);
      need(same(response, rawReply), "consistency", `${paths.response} differs from ${paths.rawReply}`);
      need(decision.responseSha256 === sha(paths.response) && hs.responseSha256 === sha(paths.response), "hash", `round ${i} ${seat} responseSha256 differs from saved reply`);
      need(response.snapshotId === hs.snapshotId && same(response.choice, decision.choice) && same(response.choice, hs.choice), "consistency", `round ${i} ${seat} choice differs across reply, decision and manifest`);
      need(same(response.share ?? null, decision.share ?? null) && same(decision.share ?? null, hs.share ?? null), "consistency", `round ${i} ${seat} share differs`);
      need(decision.round === i && decision.seat === seat && decision.tick === h.tick && decision.gameId === gameId, "consistency", `${paths.decision} identity differs`);

      // Provider record: the saved structured reply must be exactly what the provider returned. Reasoning items are checked for shape only and never copied.
      if (paths.provider.endsWith(".jsonl")) {
        const events = text(paths.provider).trim().split("\n").map((line, k) => { try { return JSON.parse(line); } catch { return fail("schema", `${paths.provider} line ${k + 1} is not JSON`); } });
        const items = events.filter((e: Json) => e?.item).map((e: Json) => e.item);
        need(items.every((it: Json) => it.type === "agent_message" || it.type === "reasoning"), "schema", `${paths.provider} contains items other than agent_message/reasoning`);
        need(events.some((e: Json) => e?.type === "turn.completed"), "schema", `${paths.provider} has no turn.completed`);
        const last = items.filter((it: Json) => it.type === "agent_message").at(-1);
        need(last && typeof last.text === "string" && same(parseJson(paths.provider, last.text), response), "consistency", `${paths.provider} final message differs from saved reply`);
      } else {
        const raw = json(paths.provider);
        need(raw.is_error === false && raw.modelUsage?.[row.model], "schema", `${paths.provider} is an error or lacks usage for ${row.model}`);
        need(same(raw.structured_output, response), "consistency", `${paths.provider} structured_output differs from saved reply`);
      }

      // Legality: the saved choice is a listed candidate (or hold) and the recorded intent is exactly that candidate at the chosen share.
      const candidates: Json[] = snapshot.candidates;
      need(Array.isArray(candidates), "schema", `${paths.snapshot} has no candidates`);
      let expectedIntent: Json = null, meaning: string | null = null;
      if (decision.choice === "hold") {
        need(decision.intent === null && (decision.share ?? null) === null, "legality", `round ${i} ${seat} hold carries an intent or share`);
      } else {
        need(Number.isInteger(decision.choice) && decision.choice >= 0 && decision.choice < candidates.length, "legality", `round ${i} ${seat} choice ${decision.choice} is not a listed candidate`);
        const cand = candidates[decision.choice];
        need(cand.index === decision.choice, "legality", `round ${i} ${seat} candidate index mismatch`);
        if (Array.isArray(cand.troopOptions)) {
          const opt = cand.troopOptions.find((o: Json) => o.share === decision.share);
          need(opt, "legality", `round ${i} ${seat} share ${decision.share} is not a listed troop option`);
          expectedIntent = { ...cand.intent, troops: opt.troops };
        } else {
          need((decision.share ?? null) === null, "legality", `round ${i} ${seat} share given for a candidate without troop options`);
          expectedIntent = cand.intent;
        }
        meaning = cand.meaning ?? null;
      }
      need(same(decision.intent, expectedIntent) && same(hs.intent, expectedIntent), "legality", `round ${i} ${seat} recorded intent differs from the listed candidate`);
      need(meaning === null || (decision.meaning === meaning && hs.meaning === meaning), "consistency", `round ${i} ${seat} meaning differs from the listed candidate`);

      let executedTick: number | null = null, queuePosition: number | null = null;
      if (decision.choice !== "hold") {
        const q = (outcome.queue.orders as Json[]).find((o) => o.seat === seat);
        need(q && same(q.intent, expectedIntent) && q.executedKey === hs.executedKey && q.admittedBeforeApply === true, "consistency", `round ${i} ${seat} queue order differs`);
        const m = typeof hs.executedKey === "string" ? /^(\d+):(\d+):[A-Za-z0-9]+$/.exec(hs.executedKey) : null;
        if (m) { executedTick = Number(m[1]); queuePosition = Number(m[2]); need(executedTick === h.tick && queuePosition === q.position, "consistency", `round ${i} ${seat} executedKey tick or position differs`); }
        need(m !== null || hs.droppedAtTick !== null, "consistency", `round ${i} ${seat} order neither executed nor dropped`);
      } else {
        need(((outcome.queue.holds ?? []) as Json[]).some((x) => x === seat || x?.seat === seat), "consistency", `round ${i} ${seat} hold not listed in queue`);
      }

      const obs = snapshot.observation ?? {};
      decisions[seat] = {
        round: i, seat, tick: h.tick, executedTick, queuePosition, executedKey: executedTick === null ? null : hs.executedKey, snapshotId: hs.snapshotId, choice: decision.choice, share: decision.share ?? null,
        intent: expectedIntent, meaning, rationale: typeof response.rationale === "string" ? response.rationale : "", candidateCount: candidates.length,
        reserveFraction: typeof obs.objectiveBoard?.ownReserve?.fraction === "number" ? obs.objectiveBoard.ownReserve.fraction : null,
        reserveEligible: typeof obs.objectiveBoard?.ownReserve?.eligible === "boolean" ? obs.objectiveBoard.ownReserve.eligible : null,
        forcesAtHome: typeof obs.troopShares?.forcesAtHome === "number" ? obs.troopShares.forcesAtHome : null,
        acceptedAt: typeof decision.acceptedAt === "string" ? decision.acceptedAt : null, model: row.model, responseSha256: sha(paths.response), promptSha256: row.promptSha256, paths,
      };
      proofSeats[seat] ??= { model: row.model, constrainedOutput: row.constrainedOutput ?? null, toolsDisabled: row.toolsDisabled ?? null, toolsObserved: row.toolsObserved ?? null, personalAuthUnchanged: row.personalAuthUnchanged ?? null, label: proof.seats?.[seat] ?? null };
      need(proofSeats[seat].model === row.model, "consistency", `${seat} model changed between rounds`);
      for (const f of (outcome.feedback?.[seat] ?? []) as Json[]) allFeedback[seat].push(f);
    }
    rounds.push({
      round: i, tick: h.tick, endTick: h.endTick, leadingSeat: h.leadingSeat, queue: h.queue, fingerprint: round.fingerprint, fingerprintAfter: outcome.fingerprintAfter,
      scoresBefore: outcome.board?.before?.scores, scoresAfter: outcome.board?.after?.scores, controllersAfter: outcome.board?.after?.controllers ?? null,
      boardBefore: outcome.board?.before, boardAfter: outcome.board?.after, feedback: { blue: outcome.feedback?.blue ?? [], red: outcome.feedback?.red ?? [] },
      outcome: outcome.outcome ?? null, decisions,
    });
  }

  const last = rounds.at(-1)!;
  need(summary.ticksSimulated === last.endTick && summary.reconstruction?.finalFingerprint === last.fingerprintAfter, "consistency", "final ticks or fingerprint differ from last round");
  if (summary.stopReason === "game-outcome") need(same(summary.outcome, last.outcome), "consistency", "final outcome differs from last round outcome");
  for (const seat of SEATS) {
    const ds = rounds.map((r) => r.decisions[seat]), orders = ds.filter((d) => d.choice !== "hold");
    const executed = orders.filter((d) => d.executedTick !== null).length;
    need(same(summary.orders?.[seat], { rounds: ds.length, holds: ds.length - orders.length, submitted: orders.length, executedAtTick: executed, droppedAtTick: orders.length - executed }), "consistency", `summary order counts for ${seat} differ from rounds`);
  }
  need(replay.schema === "replay.dual-model-trial/1#checkpoint" && replay.tick === summary.ticksSimulated, "consistency", "final replay checkpoint tick differs");
  need(Array.isArray(replay.record?.turns) && replay.record.turns.length === summary.reconstruction.recordTurns, "consistency", "final replay turn count differs");
  const nonSpawn = (replay.record.turns as Json[]).flatMap((t) => t.intents ?? []).filter((x: Json) => x.type !== "spawn").length;
  need(nonSpawn === summary.reconstruction.listedSeatOrders && summary.reconstruction.unlistedOrders === 0, "consistency", "final replay order count differs from listed seat orders");
  need(replay.record.options?.map === game.map && replay.record.options?.simulationId === manifest.config.seed && replay.record.upstreamCommit === game.engine?.upstreamCommit, "consistency", "final replay map, seed or engine commit differs");

  let engineReceipt: VerifiedFile | null = null;
  if (input.engineReceipt) {
    const expected = engineReceiptPath(name);
    need(input.engineReceipt.path === expected, "path", `engine receipt must be ${expected}`);
    const bytes = Buffer.byteLength(input.engineReceipt.text, "utf8");
    need(bytes <= TRIAL_BOUNDS.maxFileBytes, "bounds", "engine receipt too large");
    const r = parseJson(expected, input.engineReceipt.text);
    need(r.status === "passed" && r.trial === name && r.finalFingerprint === summary.reconstruction.finalFingerprint && r.ticks === summary.ticksSimulated, "consistency", "engine receipt does not match this trial's final state");
    need(r.actualProviderCalls === proof.modelCallsAttempted && r.sourceHashesVerified === summary.sources.length, "consistency", "engine receipt counts differ");
    engineReceipt = { path: expected, sha256: sha256Hex(input.engineReceipt.text), bytes, text: input.engineReceipt.text };
  }
  return { name, gameId, createdAt: String(game.createdAt), config: manifest.config, game, summary, proofSeats, files, rounds, stations, engineReceipt, totalBytes };
}

// ---------------------------------------------------------------- behaviour observations

export interface BehaviorObservationValue {
  id: string;
  gameId: string;
  seat: "blue" | "red";
  model: string;
  metric: string;
  label: string;
  numerator: number;
  denominator: number;
  proportion: number | null;
  /** No interval is estimated from dependent decisions within one game. Reserved for a separately justified sampling design. */
  interval95: [number, number] | null;
  numeratorNodeIds: string[];
  denominatorNodeIds: string[];
  caveat: string;
}

export const OBSERVATION_CAVEAT =
  "Mechanical count from one recorded game (one seed, one seat assignment, one opponent). No confidence interval is reported: rounds within one game are dependent observations, not independent samples. Not a skill, strength, doctrine or personality measure and not generalisable.";

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

export function wilsonInterval(k: number, n: number, z = 1.959964): [number, number] | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n, z2 = z * z, denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom, half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [round4(Math.max(0, centre - half)), round4(Math.min(1, centre + half))];
}

// ---------------------------------------------------------------- trial projection

export const trialNodeId = (gameId: string) => `trial:${gameId}`;
export const seatNodeId = (gameId: string, seat: string) => `trial:${gameId}/seat/${seat}`;
export const roundNodeId = (gameId: string, round: number) => `trial:${gameId}/round/${pad2(round)}`;
export const decisionNodeId = (gameId: string, round: number, seat: string) => `trial:${gameId}/round/${pad2(round)}/decision/${seat}`;
export const roundOutcomeNodeId = (gameId: string, round: number) => `trial:${gameId}/round/${pad2(round)}/outcome`;
export const finalOutcomeNodeId = (gameId: string) => `trial:${gameId}/outcome/final`;
export const artifactNodeId = (gameId: string, path: string) => `artifact:${gameId}/${path}`;

function intentKind(intent: Json): string {
  if (!intent) return "hold";
  if (intent.type === "attack") return intent.targetID === null || intent.targetID === undefined ? "expand-unclaimed" : "land-attack-opponent";
  if (intent.type === "boat") return "transport";
  if (intent.type === "build_unit") return "construction";
  return String(intent.type);
}

function projectTrialInto(g: GraphBuilder, t: ValidatedTrial, aorIdForScenario: (scenarioId: string) => string | null): { input: InputRef; observations: BehaviorObservationValue[] } {
  const { gameId, name } = t;
  const clock = `trial:${gameId}`;
  const finalTick: number = t.summary.ticksSimulated;
  const origin = "dual-model-trial" as const;
  const trialRef = (p: string) => `evidence/dual-model-trial/${name}/${p}`;
  const ARTIFACT_ROLES: [RegExp, string][] = [
    [/^manifest\.json$/, "trial-manifest"], [/^provider-proof\.json$/, "provider-proof"], [/^initialization\/game\.json$/, "initialization"],
    [/^final\/summary\.json$/, "final-summary"], [/^final\/replay\.json$/, "final-replay-checkpoint"], [/round\.json$/, "round-state"], [/^rounds\/\d{2}\/replay\.json$/, "round-replay-checkpoint"],
    [/prompt\.md$/, "seat-prompt"], [/snapshot\.json$/, "seat-snapshot"], [/schema\.json$/, "output-schema"], [/outcome\.json$/, "round-outcome"],
    [/decision\.json$/, "decision-record"], [/response\.raw\.json$/, "saved-reply"], [/^responses\//, "saved-reply-copy"], [/^providers\//, "provider-raw-record"],
  ];
  const roleOf = (p: string) => ARTIFACT_ROLES.find(([re]) => re.test(p))?.[1] ?? "evidence";
  const releaseOf = (p: string): { tick: number; hindsight: boolean } => {
    const m = /^(?:rounds|results|responses|providers)\/(\d{2})/.exec(p);
    if (m) {
      const r = t.rounds[Number(m[1])]!;
      return /outcome\.json$/.test(p) ? { tick: r.endTick, hindsight: false } : { tick: r.tick, hindsight: false };
    }
    if (p === "initialization/game.json") return { tick: 0, hindsight: false };
    return { tick: finalTick, hindsight: true };
  };

  for (const f of [...t.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const rel = releaseOf(f.path);
    g.node({ id: artifactNodeId(gameId, f.path), type: "SourceArtifact", label: f.path, summary: `Evidence file ${f.path} (${roleOf(f.path)}), ${f.bytes} bytes, sha256 ${f.sha256}.`,
      time: { clock, observedTick: null, releasedTick: rel.tick }, hindsight: rel.hindsight,
      provenance: { origin, sourceRef: trialRef(f.path), sourceSha256: f.sha256 },
      properties: { path: f.path, repoPath: trialRef(f.path), role: roleOf(f.path), sha256: f.sha256, bytes: f.bytes, hashVerifiedInProjection: true, contentEmbedded: false } });
  }
  if (t.engineReceipt) {
    g.node({ id: artifactNodeId(gameId, t.engineReceipt.path), type: "SourceArtifact", label: t.engineReceipt.path,
      summary: "Independent engine reconstruction receipt from scripts/qualify-dual-model-result.ts; final fingerprint, ticks and counts matched by this projection.",
      time: { clock, observedTick: null, releasedTick: finalTick }, hindsight: true, provenance: { origin, sourceRef: t.engineReceipt.path, sourceSha256: t.engineReceipt.sha256 },
      properties: { path: t.engineReceipt.path, repoPath: t.engineReceipt.path, role: "engine-reconstruction-receipt", sha256: t.engineReceipt.sha256, bytes: t.engineReceipt.bytes, hashVerifiedInProjection: true, contentEmbedded: false } });
  }
  const art = (p: string) => artifactNodeId(gameId, p);
  const evidence = (from: string, p: string) => g.edge("EVIDENCED_BY", from, art(p), undefined, { role: roleOf(p), path: p, sha256: t.files.get(p)!.sha256 });

  const game = t.game, s = t.summary;
  const trial = g.node({ id: trialNodeId(gameId), type: "ActualTrial", label: `Actual trial ${name}`,
    summary: `Offline two-model ${t.config.mode} run of ${game.scenarioId} on ${game.map}, seed ${t.config.seed}: blue ${t.proofSeats.blue.model}, red ${t.proofSeats.red.model}. Setup only; the result is a separate outcome node.`,
    time: { clock, observedTick: null, releasedTick: 0 }, hindsight: false, provenance: { origin, sourceRef: trialRef("initialization/game.json"), sourceSha256: t.files.get("initialization/game.json")!.sha256 },
    properties: {
      trialName: name, gameId, createdAt: t.createdAt, mode: t.config.mode, seed: t.config.seed, scenarioId: game.scenarioId, map: game.map, maxRounds: t.config.maxRounds, ticksPerRound: t.config.ticksPerRound,
      firstRoundTick: game.firstRoundTick, engineUpstreamCommit: game.engine?.upstreamCommit ?? null, simulationProfile: game.engine?.simulationProfile ?? null, transportAdmission: game.transportAdmission ?? null,
      objectiveRules: game.scenario?.objectiveRules ?? null, objectiveRulesSha256: game.scenario?.objectiveRulesSha256 ?? null, redCellProfile: game.scenario?.redCell?.profile ?? null,
      redCellInstructionsSha256: game.scenario?.redCell?.instructionsSha256 ?? null, mapAssetSha256: Object.entries(game.scenario?.pinnedMapAssets ?? {}).map(([k, v]: [string, Json]) => `${k}:${v.sha256}`).sort(),
      harnessSourceSha256: ((game.scenario?.sources ?? []) as Json[]).map((x) => `${x.path}:${x.sha256}`).sort(), blueModel: t.proofSeats.blue.model, redModel: t.proofSeats.red.model,
      claim: game.claims?.claim ?? null, timingClaim: game.claims?.timing ?? null, humanPlaytest: game.claims?.humanPlaytest ?? null, actualRecordedGame: true, authoredExample: false,
      engineReconstructionReceipt: t.engineReceipt?.path ?? null,
    } });
  evidence(trial, "initialization/game.json");
  const aorId = aorIdForScenario(game.scenarioId);
  if (aorId && g.has(aorNodeId(aorId))) g.edge("PLAYED_IN_SETTING", trial, aorNodeId(aorId), `Actual trial ${name} used ${game.scenarioId}, the playable scenario of this setting. Authored cases, personas and reports of the setting are not part of this game.`, { scenarioId: game.scenarioId });

  for (const seat of SEATS) {
    const ps = t.proofSeats[seat];
    const id = g.node({ id: seatNodeId(gameId, seat), type: "ModelSeat", label: `${seat} · ${ps.model}`,
      summary: `${seat} seat of ${name}, played by external model ${ps.model} choosing among engine-validated candidates. Identity only; no traits are inferred.`,
      time: { clock, observedTick: null, releasedTick: 0 }, hindsight: false, provenance: { origin, sourceRef: trialRef("provider-proof.json"), sourceSha256: t.files.get("provider-proof.json")!.sha256 },
      properties: { seat, model: ps.model, providerRoute: ps.label, constrainedOutput: ps.constrainedOutput, toolsDisabled: ps.toolsDisabled, toolsObserved: ps.toolsObserved,
        receivesRedCellBrief: seat === game.scenario?.redCell?.seat, personalityInference: "none", skillInference: "none" } });
    g.edge("HAS_SEAT", trial, id);
    evidence(id, "provider-proof.json");
  }

  let prevRound: string | null = null;
  for (const r of t.rounds) {
    const n = pad2(r.round);
    const rid = g.node({ id: roundNodeId(gameId, r.round), type: "ActualRound", label: `Round ${r.round} · tick ${r.tick}`,
      summary: `Round ${r.round}: both seats saw the same pre-order state at tick ${r.tick} (fingerprint ${r.fingerprint.slice(0, 16)}…); leading seat ${r.leadingSeat}; window to tick ${r.endTick}.`,
      time: { clock, observedTick: r.tick, releasedTick: r.tick }, hindsight: false, provenance: { origin, sourceRef: trialRef(`rounds/${n}/round.json`), sourceSha256: t.files.get(`rounds/${n}/round.json`)!.sha256 },
      properties: { round: r.round, tick: r.tick, endTick: r.endTick, leadingSeat: r.leadingSeat, queueOrder: r.queue, preOrderFingerprint: r.fingerprint } });
    g.edge("HAS_ROUND", trial, rid);
    if (prevRound) g.edge("NEXT_ROUND", prevRound, rid);
    prevRound = rid;
    evidence(rid, `rounds/${n}/round.json`);
    evidence(rid, `rounds/${n}/replay.json`);

    const oid = g.node({ id: roundOutcomeNodeId(gameId, r.round), type: "ObservedOutcome", label: `Round ${r.round} observed result · tick ${r.endTick}`,
      summary: `After round ${r.round} (tick ${r.endTick}): scores blue ${r.scoresAfter?.blue} red ${r.scoresAfter?.red} (before ${r.scoresBefore?.blue}/${r.scoresBefore?.red}). Observation only; not attributed to either decision.`,
      time: { clock, observedTick: r.endTick, releasedTick: r.endTick }, hindsight: false, provenance: { origin, sourceRef: trialRef(`results/${n}/outcome.json`), sourceSha256: t.files.get(`results/${n}/outcome.json`)!.sha256 },
      properties: { round: r.round, fromTick: r.tick, toTick: r.endTick, fingerprintAfter: r.fingerprintAfter, scoresBefore: canonicalJson(r.scoresBefore), scoresAfter: canonicalJson(r.scoresAfter),
        controllersAfter: canonicalJson(r.controllersAfter), boardBefore: canonicalJson(r.boardBefore), boardAfter: canonicalJson(r.boardAfter),
        blueFeedback: r.feedback.blue.map((f: Json) => `${f.tick}:${f.status}`), redFeedback: r.feedback.red.map((f: Json) => `${f.tick}:${f.status}`),
        feedbackCoverage: "Execution feedback exists only for construction and transports; attacks are unobserved. Admission is not success.", gameOutcome: r.outcome ? canonicalJson(r.outcome) : null } });
    g.edge("RESULTED_IN", rid, oid);
    evidence(oid, `results/${n}/outcome.json`);

    for (const seat of SEATS) {
      const d = r.decisions[seat];
      const station = d.intent?.type === "boat" ? t.stations.find((st) => st.tile === d.intent.dst)?.id ?? null : d.intent?.type === "build_unit" ? t.stations.find((st) => st.tile === d.intent.tile)?.id ?? null : null;
      const did = g.node({ id: decisionNodeId(gameId, r.round, seat), type: "RecordedModelDecision", label: `Round ${r.round} ${seat} · ${d.choice === "hold" ? "hold" : `candidate ${d.choice}`}`,
        summary: `${seat} (${d.model}) at tick ${r.tick} chose ${d.choice === "hold" ? "hold" : `candidate ${d.choice} of ${d.candidateCount} (${intentKind(d.intent)}${d.share !== null ? `, share ${d.share}` : ""})`}. Saved reply sha256 ${d.responseSha256.slice(0, 16)}…`,
        time: { clock, observedTick: r.tick, releasedTick: r.tick }, hindsight: false, provenance: { origin, sourceRef: trialRef(d.paths.decision), sourceSha256: t.files.get(d.paths.decision)!.sha256 },
        properties: {
          round: r.round, seat, model: d.model, observedTick: r.tick, executedTick: d.executedTick, queuePosition: d.queuePosition, snapshotId: d.snapshotId, preOrderFingerprint: r.fingerprint,
          choice: d.choice === "hold" ? "hold" : d.choice, candidateCount: d.candidateCount, share: d.share, intentKind: intentKind(d.intent), intent: d.intent ? canonicalJson(d.intent) : null,
          troopsCommitted: typeof d.intent?.troops === "number" ? d.intent.troops : null, forcesAtHome: d.forcesAtHome, reserveFractionAtDecision: d.reserveFraction, reserveEligibleAtDecision: d.reserveEligible,
          targetStation: station, candidateMeaning: d.meaning, acceptedAt: d.acceptedAt, legalityVerified: true,
          modelStatedRationale: d.rationale, rationaleNote: "Verbatim field of the saved model reply; seen only by its author seat during play. Not verified reasoning and not private model thoughts.",
          promptSha256: d.promptSha256, responseSha256: d.responseSha256, promptArtifactId: art(d.paths.prompt), snapshotArtifactId: art(d.paths.snapshot), savedReplyArtifactId: art(d.paths.rawReply), providerRecordArtifactId: art(d.paths.provider),
        } });
      g.edge("DECIDED", seatNodeId(gameId, seat), did);
      g.edge("IN_ROUND", did, rid);
      g.edge("FOLLOWED_BY", did, oid);
      for (const p of Object.values(d.paths)) evidence(did, p);
    }
  }

  const fid = g.node({ id: finalOutcomeNodeId(gameId), type: "ObservedOutcome", label: `Final result · ${name}`,
    summary: `Stopped at tick ${finalTick} (${s.stopReason}); ${s.outcome ? `${s.outcome.reason}, winner ${s.outcome.winner}, scores blue ${s.outcome.scores?.blue} red ${s.outcome.scores?.red}` : "no game outcome; provisional scores only"}. One game; not a strength or learning measure.`,
    time: { clock, observedTick: finalTick, releasedTick: finalTick }, hindsight: true, provenance: { origin, sourceRef: trialRef("final/summary.json"), sourceSha256: t.files.get("final/summary.json")!.sha256 },
    properties: { stopReason: s.stopReason, scoresStatus: s.scoresStatus, outcome: s.outcome ? canonicalJson(s.outcome) : null, winner: s.outcome?.winner ?? null, reason: s.outcome?.reason ?? null,
      scores: canonicalJson(s.scores), controllers: canonicalJson(s.controllers), ticksSimulated: finalTick, rounds: s.rounds, finalFingerprint: s.reconstruction.finalFingerprint,
      engineReconstructionReceipt: t.engineReceipt?.path ?? null, engineReconstructionInProjection: false } });
  g.edge("ENDED_WITH", trial, fid);
  for (const p of ["final/summary.json", "final/replay.json", "manifest.json", "provider-proof.json"]) evidence(fid, p);
  if (t.engineReceipt) g.edge("EVIDENCED_BY", fid, art(t.engineReceipt.path), undefined, { role: "engine-reconstruction-receipt", path: t.engineReceipt.path, sha256: t.engineReceipt.sha256 });

  // Observations
  const observations: BehaviorObservationValue[] = [];
  const feedbackByKey = new Map<string, string[]>();
  for (const r of t.rounds) for (const seat of SEATS) for (const f of r.feedback[seat]) feedbackByKey.set(`${seat}|${f.key}`, [...(feedbackByKey.get(`${seat}|${f.key}`) ?? []), String(f.status)]);
  for (const seat of SEATS) {
    const ds = t.rounds.map((r) => r.decisions[seat]);
    const dId = (d: ValidatedDecision) => decisionNodeId(gameId, d.round, seat);
    const model = t.proofSeats[seat].model as string;
    const add = (metric: string, label: string, num: ValidatedDecision[] | string[], den: ValidatedDecision[] | string[]) => {
      const ids = (xs: ValidatedDecision[] | string[]) => (xs as (ValidatedDecision | string)[]).map((x) => (typeof x === "string" ? x : dId(x)));
      const numerator = num.length, denominator = den.length;
      observations.push({ id: `trial:${gameId}/seat/${seat}/observation/${metric}`, gameId, seat, model, metric, label, numerator, denominator,
        proportion: denominator > 0 ? round4(numerator / denominator) : null, interval95: null, numeratorNodeIds: ids(num), denominatorNodeIds: ids(den), caveat: OBSERVATION_CAVEAT });
    };
    const orders = ds.filter((d) => d.choice !== "hold");
    add("order-submitted-rate", "Decision opportunities with a submitted order", orders, ds);
    add("wait-rate", "Decision opportunities answered with hold", ds.filter((d) => d.choice === "hold"), ds);
    add("listed-candidate-rate", "Replies that selected a listed engine-validated candidate or hold", ds, ds);
    add("executed-at-tick-rate", "Submitted orders executed at their decision tick", orders.filter((d) => d.executedTick !== null), orders);
    for (const kind of ["expand-unclaimed", "land-attack-opponent", "transport", "construction"]) add(`intent-${kind}-share`, `Submitted orders of kind ${kind}`, orders.filter((d) => intentKind(d.intent) === kind), orders);
    const withShare = orders.filter((d) => d.share !== null);
    for (const sh of [...new Set(withShare.map((d) => d.share as number))].sort((a, b) => a - b)) add(`troop-share-${sh}`, `Troop-bearing orders committing share ${sh} of forces at home`, withShare.filter((d) => d.share === sh), withShare);
    add("high-commitment-rate", "Troop-bearing orders committing at least half of forces at home", withShare.filter((d) => (d.share as number) >= 0.5), withShare);
    const transports = orders.filter((d) => d.intent?.type === "boat");
    for (const st of t.stations) add(`transport-target-${st.id}`, `Transports aimed at station ${st.id} (${st.name})`, transports.filter((d) => d.intent.dst === st.tile), transports);
    const withReserve = ds.filter((d) => d.reserveEligible !== null);
    add("reserve-eligible-at-decision", "Decision snapshots where the seat's reserve met the scoring threshold", withReserve.filter((d) => d.reserveEligible === true), withReserve);
    const statusesOf = (d: ValidatedDecision) => (d.executedKey ? feedbackByKey.get(`${seat}|${d.executedKey}`) ?? [] : []);
    const launched = transports.filter((d) => statusesOf(d).includes("transport-launched"));
    add("transport-landed-rate", "Launched transports with a landed feedback status", launched.filter((d) => statusesOf(d).includes("transport-landed")), launched);
    const builds = orders.filter((d) => d.intent?.type === "build_unit");
    add("construction-completed-rate", "Construction orders with a completed feedback status", builds.filter((d) => statusesOf(d).includes("construction-completed")), builds);
    const outcomeIds = t.rounds.map((r) => roundOutcomeNodeId(gameId, r.round));
    add("score-gain-rounds", "Round windows in which the seat's score increased", t.rounds.filter((r) => Number(r.scoresAfter?.[seat]) > Number(r.scoresBefore?.[seat])).map((r) => roundOutcomeNodeId(gameId, r.round)), outcomeIds);
    const stationIds = Object.keys(s.controllers ?? {}).sort();
    add("stations-controlled-at-end", "Stations controlled by the seat when the run stopped", stationIds.filter((k) => s.controllers[k] === seat).map(() => finalOutcomeNodeId(gameId)), stationIds.map(() => finalOutcomeNodeId(gameId)));
  }
  for (const o of observations) {
    g.node({ id: o.id, type: "BehaviorObservation", label: `${o.seat} · ${o.metric}`,
      summary: `${o.label}: ${o.numerator}/${o.denominator}${o.interval95 ? ` (Wilson 95% ${o.interval95[0]}–${o.interval95[1]})` : ""}. Mechanical count from one game; not a skill or personality score.`,
      time: { clock, observedTick: null, releasedTick: finalTick }, hindsight: true, provenance: { origin: "projection", sourceRef: `${PROJECTION_ID}@${PROJECTION_VERSION}#observation/${o.metric}`, sourceSha256: null },
      properties: { metric: o.metric, seat: o.seat, model: o.model, numerator: o.numerator, denominator: o.denominator, proportion: o.proportion, interval95: o.interval95 ?? [], intervalMethod: "none-dependent-within-game-observations",
        numeratorNodeIds: [...new Set(o.numeratorNodeIds)], denominatorNodeIds: [...new Set(o.denominatorNodeIds)], caveat: o.caveat } });
    g.edge("HAS_OBSERVATION", seatNodeId(gameId, o.seat), o.id);
    for (const target of new Set(o.denominatorNodeIds)) g.edge("COMPUTED_FROM", o.id, target);
  }

  return {
    input: { kind: "dual-model-trial", name, gameId, files: t.files.size, totalBytes: t.totalBytes, manifestSha256: t.files.get("manifest.json")!.sha256, summarySha256: t.files.get("final/summary.json")!.sha256,
      engineReceipt: t.engineReceipt ? { path: t.engineReceipt.path, sha256: t.engineReceipt.sha256 } : null },
    observations,
  };
}

// ---------------------------------------------------------------- public entry points

export function buildOntologyGraph(opts: { catalog: CatalogBundle; trials?: TrialInput[] }): OntologyGraph {
  const g = new GraphBuilder();
  const inputs: InputRef[] = [projectCatalogInto(g, opts.catalog)];
  const observations: BehaviorObservationValue[] = [];
  const scenarioAor = (scenarioId: string) => opts.catalog.aors.find((a) => a.playableScenarioId === scenarioId)?.id ?? null;
  const seen = new Set<string>();
  for (const trial of [...(opts.trials ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const v = validateTrialInput(trial);
    need(!seen.has(v.gameId), "consistency", `trial game ${v.gameId} supplied twice`);
    seen.add(v.gameId);
    const out = projectTrialInto(g, v, scenarioAor);
    inputs.push(out.input);
    observations.push(...out.observations);
  }
  const { nodes, edges } = g.build();
  const body: Omit<OntologyGraph, "graphSha256"> = { schema: GRAPH_SCHEMA, projection: { id: PROJECTION_ID, version: PROJECTION_VERSION }, notice: GRAPH_NOTICE, inputs, nodes, edges, observations };
  return { ...body, graphSha256: graphHash(body) };
}

function graphHash(g: Omit<OntologyGraph, "graphSha256">): string {
  return sha256Hex(canonicalJson({ schema: g.schema, projection: g.projection, inputs: g.inputs, nodes: g.nodes.map((n) => n.contentSha256), edges: g.edges.map((e) => e.contentSha256), observations: g.observations }));
}

/**
 * The subgraph knowable at `cutoffTick` on one clock: static nodes, plus nodes of that clock released at or
 * before the cutoff. Nodes of other clocks and hindsight nodes without a clock are dropped; edges survive only
 * when both ends do. This is an after-action/instructor view, not a seat-scoped projection.
 */
export function graphAtCutoff(graph: OntologyGraph, clock: string, cutoffTick: number): OntologyGraph {
  const keep = (n: OntologyNode) => (n.time === null ? !n.hindsight : n.time.clock === clock && n.time.releasedTick <= cutoffTick);
  const nodes = graph.nodes.filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const observations = graph.observations.filter((o) => ids.has(o.id));
  const body = { schema: graph.schema, projection: graph.projection, notice: `${graph.notice} Cutoff view: ${clock} at tick ${cutoffTick}.`, inputs: graph.inputs, nodes, edges, observations };
  return { ...body, graphSha256: graphHash(body) };
}

/** Re-checks a graph (for example one loaded from an export). Returns problems; empty means consistent. */
export function checkGraphIntegrity(graph: OntologyGraph): string[] {
  const problems: string[] = [];
  const byId = new Map<string, OntologyNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) problems.push(`duplicate node ${n.id}`);
    byId.set(n.id, n);
    const { contentSha256, ...rest } = n;
    if (hashNode(rest) !== contentSha256) problems.push(`node ${n.id} content hash mismatch`);
    if (!ENTITY_TYPES[n.type]) problems.push(`node ${n.id} has unknown type ${n.type}`);
    else if (ENTITY_TYPES[n.type].dataClass !== n.dataClass) problems.push(`node ${n.id} data class ${n.dataClass} does not match ${n.type}`);
    if (n.summary.length > MAX_SUMMARY_CHARS) problems.push(`node ${n.id} summary exceeds bound`);
  }
  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) problems.push(`duplicate edge ${e.id}`);
    edgeIds.add(e.id);
    const { contentSha256, ...rest } = e;
    if (hashEdge(rest) !== contentSha256) problems.push(`edge ${e.id} content hash mismatch`);
    const s = byId.get(e.source), t = byId.get(e.target), def = RELATION_TYPES[e.type];
    if (!s || !t) { problems.push(`edge ${e.id} (${e.type}) has an unresolved endpoint`); continue; }
    if (!def) { problems.push(`edge ${e.id} has unknown type ${e.type}`); continue; }
    if (!def.from.includes(s.type) || !def.to.includes(t.type)) problems.push(`edge ${e.type} ${s.type} -> ${t.type} is not allowed`);
    const authoredSide = [s, t].some((x) => x.dataClass === AUTHORED), actualSide = [s, t].some((x) => x.dataClass === ACTUAL || x.dataClass === DERIVED);
    if (authoredSide && actualSide && !(e.type === "PLAYED_IN_SETTING" && t.type === "AOR")) problems.push(`edge ${e.id} links authored and actual data via ${e.type}`);
  }
  const { graphSha256, ...body } = graph;
  if (graphHash(body) !== graphSha256) problems.push("graph hash mismatch");
  return problems;
}

// ---------------------------------------------------------------- Graphiti-compatible curated export

/** Graphiti node attributes that custom entity fields must not shadow. */
export const GRAPHITI_RESERVED_FIELDS = Object.freeze(["uuid", "name", "group_id", "labels", "created_at", "summary", "attributes", "name_embedding"]);

export interface CuratedBatch {
  batchId: string;
  purpose: string;
  /** `group_id` is intentionally absent: main chooses the group and owns every native call. */
  request: Omit<AddKnowledgeRequest, "group_id">;
  nodeIds: string[];
  messageBytes: number[];
}

export interface CuratedExport {
  schema: "replay.ontology-curated-messages/1";
  nativeIngestion: false;
  notice: string;
  graphSha256: string;
  batches: CuratedBatch[];
  /** Smallest reviewed subset worth considering for native ingestion, by batch id. */
  suggestedReviewSubset: string[];
  deterministicImportGap: string;
}

export const CURATED_EXPORT_NOTICE =
  "Curated message batches in the platform AddKnowledgeRequest shape, minus group_id. They are an export for review, NOT native ingestion: nothing was sent. Each message becomes one Graphiti episode whose entity extraction runs through the metered model bridge, so every message sent costs paid requests. Structured nodes and edges stay in graph.json.";

export const DETERMINISTIC_IMPORT_GAP =
  "Installed Kamiwaza1.2 Core supports POST /context/ontologies/{id}/entity for explicit nodes with local embeddings. Its Graphiti adapter preserves uuid/name/summary/group, but not arbitrary typed properties. No explicit Core fact/edge write endpoint was found. POST .../knowledge uses metered LLM extraction; search returns facts, so creating nodes alone does not establish retrievable graph relationships. The typed graph remains portable app data until a supported relationship ingestion path is verified. No direct database write or read-only Cypher bypass is used.";

function entityTypeSchemas(types: EntityType[]): Record<string, EntityTypeSchema> {
  const out: Record<string, EntityTypeSchema> = {};
  for (const t of types) out[t] = { description: ENTITY_TYPES[t].description, fields: { ...ENTITY_TYPES[t].fields } };
  return out;
}

function message(content: string, name: string, timestamp: string, sourceDescription: string): MessageInput {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EPISODE_BYTES) throw new RangeError(`curated message ${name} is ${bytes} bytes; bound is ${MAX_EPISODE_BYTES}`);
  return { content, role: "user", role_type: "user", name, timestamp, source_description: bound(sourceDescription, 240) };
}

/**
 * Builds a small number of bounded, human-readable episodes: one per AOR (setting, lessons, Red profile,
 * organizations; no per-case/report/event records) and, per trial, one setup+result+observations summary
 * and one message per round. Model-stated rationales are excluded so extraction cannot turn them into facts.
 */
export function curatedKnowledgeExport(graph: OntologyGraph): CuratedExport {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const batches: CuratedBatch[] = [];
  const catalogInput = graph.inputs.find((i) => i.kind === "preset-catalog");
  const sourceDates = graph.nodes.filter((n) => n.type === "Source").map((n) => String(n.properties.retrievedAt)).sort();
  const catalogDate = `${sourceDates.at(-1) ?? "2026-01-01"}T00:00:00.000Z`;

  const aors = graph.nodes.filter((n) => n.type === "AOR");
  if (aors.length && catalogInput?.kind === "preset-catalog") {
    const messages: MessageInput[] = [], nodeIds: string[] = [];
    for (const aor of aors) {
      const members = graph.edges.filter((e) => e.type === "IN_AOR" && e.target === aor.id).map((e) => byId.get(e.source)!);
      const pick = (t: EntityType) => members.filter((m) => m.type === t);
      const lines = [
        `AUTHORED SYNTHETIC REFERENCE (${catalogInput.version}, catalog sha256 ${catalogInput.sha256}). Fictional examples, not recorded play, not real forces, not assessments of anyone.`,
        `Setting ${aor.label} [${aor.id}]: ${aor.summary}`,
        ...pick("Lesson").map((l) => `Lesson ${l.label} [${l.id}]: ${l.summary}`),
        ...pick("RedProfile").map((r) => `Fictional Red profile ${r.label} [${r.id}]: ${r.summary}`),
        ...pick("Organization").map((o) => `Fictional organization ${o.label} [${o.id}]: ${o.summary}`),
      ];
      messages.push(message(lines.join("\n"), `REPLAY catalog ${aor.properties.aorId}`, catalogDate, `REPLAY authored preset catalog ${catalogInput.version} ${aor.id}`));
      nodeIds.push(aor.id, ...pick("Lesson").map((x) => x.id), ...pick("RedProfile").map((x) => x.id), ...pick("Organization").map((x) => x.id));
    }
    batches.push({ batchId: "catalog-settings", purpose: "Authored setting, lesson, Red profile and organization reference per AOR", nodeIds,
      request: { messages, entity_types: entityTypeSchemas(["AOR", "Lesson", "RedProfile", "Organization"]), excluded_entity_types: ["Entity"] },
      messageBytes: messages.map((m) => Buffer.byteLength(m.content, "utf8")) });
  }

  for (const input of graph.inputs) {
    if (input.kind !== "dual-model-trial") continue;
    const trial = byId.get(trialNodeId(input.gameId));
    if (!trial) continue;
    const final = byId.get(finalOutcomeNodeId(input.gameId));
    const seats = SEATS.map((s) => byId.get(seatNodeId(input.gameId, s))).filter((x): x is OntologyNode => !!x);
    const obs = graph.observations.filter((o) => o.gameId === input.gameId);
    const header = `ACTUAL RECORDED OFFLINE TRIAL ${input.name} (game ${input.gameId}; manifest sha256 ${input.manifestSha256}). Fictional abstract game; two external models; not human play, not a strength, learning or doctrine measure.`;
    const keyMetrics = ["order-submitted-rate", "wait-rate", "executed-at-tick-rate", "intent-transport-share", "intent-land-attack-opponent-share", "high-commitment-rate", "transport-landed-rate", "score-gain-rounds", "stations-controlled-at-end"];
    const summaryLines = [
      header,
      `Setup [${trial.id}]: ${trial.summary}`,
      ...seats.map((s) => `Seat [${s.id}]: ${s.summary}`),
      final ? `Result [${final.id}]: ${final.summary}` : "Result: not present.",
      "Mechanical observations (numerator/denominator, Wilson 95%; rounds are serially dependent, intervals optimistic):",
      ...obs.filter((o) => keyMetrics.includes(o.metric)).map((o) => `- ${o.seat} ${o.metric}: ${o.numerator}/${o.denominator}${o.interval95 ? ` [${o.interval95[0]}, ${o.interval95[1]}]` : ""}`),
    ];
    const createdAt = String(trial.properties.createdAt);
    const summaryMessage = message(summaryLines.join("\n"), `REPLAY trial ${input.name} summary`, createdAt, `REPLAY actual trial ${input.name} summary ${input.summarySha256}`);
    batches.push({ batchId: `trial-${input.name}-summary`, purpose: "Trial setup, seat identities, result and key mechanical observations", nodeIds: [trial.id, ...seats.map((s) => s.id), ...(final ? [final.id] : []), ...obs.filter((o) => keyMetrics.includes(o.metric)).map((o) => o.id)],
      request: { messages: [summaryMessage], entity_types: entityTypeSchemas(["ActualTrial", "ModelSeat", "ObservedOutcome", "BehaviorObservation"]), excluded_entity_types: ["Entity"] },
      messageBytes: [Buffer.byteLength(summaryMessage.content, "utf8")] });

    const roundNodes = graph.nodes.filter((n) => n.type === "ActualRound" && n.id.startsWith(`${trial.id}/round/`));
    const messages: MessageInput[] = [], nodeIds: string[] = [];
    for (const r of roundNodes) {
      const ds = SEATS.map((s) => byId.get(`${r.id}/decision/${s}`)).filter((x): x is OntologyNode => !!x);
      const o = byId.get(`${r.id}/outcome`);
      const lines = [header, `Round [${r.id}]: ${r.summary}`,
        ...ds.map((d) => `Decision [${d.id}]: ${d.summary} Meaning: ${bound(String(d.properties.candidateMeaning ?? "hold"), 400)} Prompt sha256 ${d.properties.promptSha256}.`),
        ...(o ? [`Observed [${o.id}]: ${o.summary}`] : [])];
      const stamp = ds.map((d) => String(d.properties.acceptedAt ?? "")).filter(Boolean).sort().at(-1) ?? createdAt;
      messages.push(message(lines.join("\n"), `REPLAY trial ${input.name} round ${r.properties.round}`, stamp, `REPLAY actual trial ${input.name} round ${r.properties.round}`));
      nodeIds.push(r.id, ...ds.map((d) => d.id), ...(o ? [o.id] : []));
    }
    batches.push({ batchId: `trial-${input.name}-rounds`, purpose: "Per-round decisions and observed results (one episode per round)", nodeIds,
      request: { messages, entity_types: entityTypeSchemas(["ActualRound", "RecordedModelDecision", "ObservedOutcome"]), excluded_entity_types: ["Entity"] },
      messageBytes: messages.map((m) => Buffer.byteLength(m.content, "utf8")) });
  }

  return { schema: "replay.ontology-curated-messages/1", nativeIngestion: false, notice: CURATED_EXPORT_NOTICE, graphSha256: graph.graphSha256, batches,
    suggestedReviewSubset: batches.filter((b) => b.batchId.endsWith("-summary")).map((b) => b.batchId), deterministicImportGap: DETERMINISTIC_IMPORT_GAP };
}
