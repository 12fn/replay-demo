/**
 * Curated REPLAY domain ontology: the canonical source archive.
 *
 * This file is the *only* source of the shared domain graph. Everything in it
 * describes the abstract training game (OpenFront engine under REPLAY's
 * exercise, replay and branch rules). It contains no real-world doctrine, no
 * adversary intelligence and no participant data. Personal learner profiles,
 * orders, reports and user identifiers are never part of this definition and
 * are never published to the shared workroom graph.
 *
 * Versioning rule: any change to a concept, relationship, scope line or the
 * source date must bump `version`. The content hash is derived from the
 * canonical rendering in `source.ts`; `tests/ontology` pins it so an unnoticed
 * edit cannot silently re-publish under an old version.
 *
 * Pure data. No I/O, no Node-only imports, safe to import from the browser.
 */

export type ConceptName = "Exercise" | "PlayerTool" | "Decision" | "SourceReport" | "StaffWatch" | "Branch" | "LearningObjective";

export interface OntologyConcept {
  name: ConceptName;
  /** One-sentence definition used verbatim in the published episode and as the extraction description. */
  description: string;
  /** Extra attributes the extractor may record, as {field: description}. */
  fields: Record<string, string>;
}

export interface OntologyRelationship {
  /** Stable identifier, unique within the source. */
  id: string;
  from: ConceptName;
  /** UPPER_SNAKE relation name. */
  name: string;
  to: ConceptName;
  /** One-sentence statement of the rule the relationship encodes. */
  statement: string;
  /** Rule family the relationship belongs to, for grouping in the UI. */
  theme: "legal tools" | "source supersession" | "clock" | "replay" | "branch isolation" | "learning";
}

export interface DomainOntology {
  /** Stable source id cited inside every published episode. */
  sourceId: string;
  /** Semantic version of this definition. Bump on any content change. */
  version: string;
  title: string;
  /** Fixed authoring date used as the episode timestamp so a version publishes identically every time. */
  sourceDate: string;
  scope: readonly string[];
  concepts: readonly OntologyConcept[];
  relationships: readonly OntologyRelationship[];
}

export const DOMAIN_ONTOLOGY: DomainOntology = Object.freeze<DomainOntology>({
  sourceId: "replay.domain-ontology",
  version: "1.0.0",
  title: "REPLAY training-game domain ontology",
  sourceDate: "2026-09-13T00:00:00.000Z",
  scope: [
    "Abstract training-game concepts for the REPLAY decision-training demonstration on the pinned OpenFront engine.",
    "No real-world doctrine, no real adversary intelligence and no operational data are described.",
    "No participant data: learner profiles, personal orders, released report texts and user identifiers stay private to REPLAY and are never part of this source.",
  ],
  concepts: [
    {
      name: "Exercise",
      description: "A bounded REPLAY session on one game map whose clock advances in discrete engine ticks and whose full record is durable and deterministically replayable.",
      fields: { kind: "live, recorded or branch", clock: "tick counter; ten ticks per game second", status: "running or completed" },
    },
    {
      name: "PlayerTool",
      description: "An action a participant may legally issue in an Exercise: attack, build unit, boat or cancel attack; the engine validates legality at the tick it executes.",
      fields: { intent: "attack, build_unit, boat or cancel_attack", legality: "engine-validated per tick; illegal intents are rejected, not executed" },
    },
    {
      name: "Decision",
      description: "A human order recorded with the tick the participant observed at submission and the tick at which it executed; it may carry a contemporaneous rationale.",
      fields: { observedTick: "tick displayed when the order was submitted", executedTick: "tick at which the engine applied it", rationaleTiming: "contemporaneous or post-hoc" },
    },
    {
      name: "SourceReport",
      description: "A side-scoped report released into an Exercise at a tick with a stated confidence; a later report may supersede it, and only reports released to a side by a tick are citable then.",
      fields: { releasedTick: "tick at which the report became available to its side", confidence: "stated confidence label", supersedes: "id of the earlier report it replaces, if any" },
    },
    {
      name: "StaffWatch",
      description: "A side-scoped staff task that watches released SourceReports across ticks and returns cited results without changing the Exercise state.",
      fields: { status: "queued, running, waiting, completed or cancelled", cursor: "last tick the watch has examined" },
    },
    {
      name: "Branch",
      description: "A counterfactual Exercise forked from a parent at a fork tick: the parent record is replayed deterministically up to that tick and the Branch then diverges in isolation.",
      fields: { forkTick: "tick at which the fork was taken", parent: "the Exercise the Branch was forked from" },
    },
    {
      name: "LearningObjective",
      description: "A provisional curriculum objective whose criteria are evidenced by recorded Decisions and their source use; it never yields a numeric mastery score.",
      fields: { criteria: "observable, evidence-led criteria", status: "provisional until a reviewed curriculum source exists" },
    },
  ],
  relationships: [
    { id: "R01", from: "Exercise", name: "OFFERS", to: "PlayerTool", theme: "legal tools", statement: "An Exercise offers exactly the PlayerTools the engine accepts for the participant's side; the legal set is checked again at execution." },
    { id: "R02", from: "Decision", name: "USES", to: "PlayerTool", theme: "legal tools", statement: "Every Decision uses exactly one PlayerTool intent; a Decision using an illegal PlayerTool is recorded as rejected and changes nothing." },
    { id: "R03", from: "Decision", name: "RECORDED_IN", to: "Exercise", theme: "clock", statement: "A Decision is recorded in one Exercise with both its observed tick and its executed tick, so submission and execution are never conflated." },
    { id: "R04", from: "SourceReport", name: "RELEASED_IN", to: "Exercise", theme: "clock", statement: "A SourceReport is released in an Exercise at one tick to one side and is unavailable to that side before that tick." },
    { id: "R05", from: "Decision", name: "CITES", to: "SourceReport", theme: "source supersession", statement: "A Decision may cite only SourceReports released to its side at or before its observed tick; later reports are hindsight." },
    { id: "R06", from: "SourceReport", name: "SUPERSEDES", to: "SourceReport", theme: "source supersession", statement: "A later SourceReport may supersede an earlier one; a Decision citing a superseded SourceReport is flagged for review, not scored." },
    { id: "R07", from: "StaffWatch", name: "MONITORS", to: "SourceReport", theme: "source supersession", statement: "A StaffWatch monitors SourceReports released to its side and reports which are current and which are superseded." },
    { id: "R08", from: "StaffWatch", name: "OPENED_IN", to: "Exercise", theme: "clock", statement: "A StaffWatch is opened in one Exercise and advances with that Exercise's clock." },
    { id: "R09", from: "Exercise", name: "RECORDS", to: "Decision", theme: "replay", statement: "An Exercise records every Decision durably with tick provenance, and replaying the record reproduces the same state fingerprint at every tick." },
    { id: "R10", from: "Branch", name: "FORKS", to: "Exercise", theme: "branch isolation", statement: "A Branch forks a parent Exercise at a fork tick by replaying the parent record deterministically up to that tick." },
    { id: "R11", from: "Branch", name: "ISOLATES", to: "Decision", theme: "branch isolation", statement: "Decisions recorded after the fork tick exist only in the Branch; the parent Exercise record is never altered by a Branch." },
    { id: "R12", from: "Branch", name: "PRESERVES", to: "SourceReport", theme: "branch isolation", statement: "A Branch preserves the SourceReports released to its side before the fork tick with provenance to the parent report; later parent reports are not carried over." },
    { id: "R13", from: "LearningObjective", name: "OBSERVES", to: "Decision", theme: "learning", statement: "A LearningObjective is evidenced by recorded Decisions and their rationale timing; an unobserved rationale is a question, not a deduction." },
    { id: "R14", from: "LearningObjective", name: "REFERENCES", to: "SourceReport", theme: "learning", statement: "A LearningObjective about source use references SourceReport currency and supersession rather than outcomes." },
  ],
});

export const CONCEPT_NAMES: readonly ConceptName[] = DOMAIN_ONTOLOGY.concepts.map((c) => c.name);
