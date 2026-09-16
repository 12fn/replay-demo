/**
 * Canonical rendering, content hash, knowledge batch and local projection of
 * the curated domain ontology.
 *
 * - `canonicalSourceText` renders the definition deterministically; the hash is
 *   SHA-256 over that text and nothing else.
 * - `buildKnowledgeRequest` produces the exact `AddKnowledgeRequest` sent to the
 *   installed platform: one bounded `user` message (one episode, one paid
 *   extraction pass in Graphiti) whose content cites the source id, version and
 *   hash, plus a typed `entity_types` schema for the seven concepts with the
 *   catch-all `Entity` type excluded so extraction is constrained, not biased.
 * - `ingestionKey` is the durable settings key for "this version, this
 *   workroom, this ontology instance".
 * - `localDefinitionGraph` is the app-side projection shown when nothing has
 *   been published; it is labelled as a local definition, never as the graph.
 *
 * Group id policy: the shared domain graph lives in the native group equal to
 * the configured workroom UUID, because the installed subgraph endpoint binds
 * to the workroom group. No arbitrary prefixes, no per-user groups.
 */
import { createHash } from "node:crypto";
import type { AddKnowledgeRequest, EntityTypeSchema, MessageInput } from "../platform/types.ts";
import { DOMAIN_ONTOLOGY, type ConceptName, type DomainOntology, type OntologyRelationship } from "./domain.ts";

/** Upper bound for the single episode message, well under the 32 KiB bridge message cap that Graphiti's own prompts must also fit in. */
export const MAX_EPISODE_BYTES = 8 * 1024;

export interface SourceMetadata {
  sourceId: string;
  version: string;
  title: string;
  sourceDate: string;
  /** `sha256:<hex>` of the canonical text. */
  hash: string;
  conceptCount: number;
  relationshipCount: number;
  /** UTF-8 size of the episode content that would be published. */
  episodeBytes: number;
}

export interface LocalGraphNode {
  id: string;
  name: string;
  type: ConceptName;
  summary: string;
}

export interface LocalGraphEdge {
  id: string;
  source: string;
  target: string;
  name: string;
  fact: string;
  theme: OntologyRelationship["theme"];
}

export interface LocalDefinitionGraph {
  label: string;
  nodes: LocalGraphNode[];
  edges: LocalGraphEdge[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Deterministic text rendering. Hash input; also the bulk of the published episode. */
export function canonicalSourceText(domain: DomainOntology = DOMAIN_ONTOLOGY): string {
  const lines: string[] = [];
  lines.push(`${domain.title}`);
  lines.push(`source_id: ${domain.sourceId}`);
  lines.push(`version: ${domain.version}`);
  lines.push(`source_date: ${domain.sourceDate}`);
  lines.push("");
  lines.push("SCOPE");
  for (const s of domain.scope) lines.push(`- ${s}`);
  lines.push("");
  lines.push("CONCEPTS");
  for (const c of domain.concepts) {
    lines.push(`- ${c.name}: ${c.description}`);
    for (const key of Object.keys(c.fields).sort()) lines.push(`  ${key}: ${c.fields[key]}`);
  }
  lines.push("");
  lines.push("RELATIONSHIPS");
  for (const r of domain.relationships) lines.push(`- ${r.id} ${r.from} ${r.name} ${r.to} [${r.theme}]: ${r.statement}`);
  return lines.join("\n");
}

export function sourceHash(domain: DomainOntology = DOMAIN_ONTOLOGY): string {
  return `sha256:${createHash("sha256").update(canonicalSourceText(domain), "utf8").digest("hex")}`;
}

/** Content of the single published episode: canonical text plus the provenance trailer that cites this file. */
export function episodeContent(domain: DomainOntology = DOMAIN_ONTOLOGY): string {
  const hash = sourceHash(domain);
  return [
    canonicalSourceText(domain),
    "",
    "PROVENANCE",
    `- Published by REPLAY from its curated source file src/ontology/domain.ts (${domain.sourceId}@${domain.version}).`,
    `- source_hash: ${hash}`,
    "- The statements above are the complete source; nothing outside this text is asserted.",
  ].join("\n");
}

export function sourceMetadata(domain: DomainOntology = DOMAIN_ONTOLOGY): SourceMetadata {
  return {
    sourceId: domain.sourceId,
    version: domain.version,
    title: domain.title,
    sourceDate: domain.sourceDate,
    hash: sourceHash(domain),
    conceptCount: domain.concepts.length,
    relationshipCount: domain.relationships.length,
    episodeBytes: Buffer.byteLength(episodeContent(domain), "utf8"),
  };
}

/** Typed extraction schema: one entry per concept, description verbatim from the source. */
export function entityTypes(domain: DomainOntology = DOMAIN_ONTOLOGY): Record<string, EntityTypeSchema> {
  const out: Record<string, EntityTypeSchema> = {};
  for (const c of domain.concepts) out[c.name] = { description: c.description, fields: { ...c.fields } };
  return out;
}

/**
 * The exact platform request for one modelling batch. `groupId` must be the
 * configured workroom UUID; anything else is refused here so a caller cannot
 * publish the shared domain into a private or arbitrary group.
 */
export function buildKnowledgeRequest(groupId: string, domain: DomainOntology = DOMAIN_ONTOLOGY): AddKnowledgeRequest {
  if (!isUuid(groupId)) throw new TypeError("groupId must be the configured workroom UUID");
  const content = episodeContent(domain);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EPISODE_BYTES) throw new RangeError(`episode content is ${bytes} bytes; the bound is ${MAX_EPISODE_BYTES}`);
  const hash = sourceHash(domain);
  const message: MessageInput = {
    content,
    role: "user",
    role_type: "user",
    name: "REPLAY domain source",
    timestamp: domain.sourceDate,
    source_description: `REPLAY curated domain ontology ${domain.sourceId}@${domain.version} ${hash}`,
  };
  return {
    group_id: groupId,
    messages: [message],
    entity_types: entityTypes(domain),
    excluded_entity_types: ["Entity"],
  };
}

/** Durable settings key for one version of the source in one workroom on one ontology instance. */
export function ingestionKey(workroomId: string, ontologyId: string, domain: DomainOntology = DOMAIN_ONTOLOGY): string {
  if (!isUuid(workroomId)) throw new TypeError("workroomId must be a UUID");
  if (!isUuid(ontologyId)) throw new TypeError("ontologyId must be a UUID");
  const hash = sourceHash(domain).replace(/^sha256:/, "").slice(0, 16);
  return `ontology.publish:${workroomId.toLowerCase()}:${ontologyId.toLowerCase()}:${domain.sourceId}@${domain.version}:${hash}`;
}

/** Prefix shared by every ingestion key of a workroom/ontology pair, for listing publish history. */
export function ingestionKeyPrefix(workroomId: string, ontologyId: string): string {
  if (!isUuid(workroomId)) throw new TypeError("workroomId must be a UUID");
  if (!isUuid(ontologyId)) throw new TypeError("ontologyId must be a UUID");
  return `ontology.publish:${workroomId.toLowerCase()}:${ontologyId.toLowerCase()}:`;
}

export const LOCAL_DEFINITION_LABEL = "Local definition · not the native graph";

/** App-side projection of the definition. Shown separately from, and never as, the platform graph. */
export function localDefinitionGraph(domain: DomainOntology = DOMAIN_ONTOLOGY): LocalDefinitionGraph {
  return {
    label: LOCAL_DEFINITION_LABEL,
    nodes: domain.concepts.map((c) => ({ id: c.name, name: c.name, type: c.name, summary: c.description })),
    edges: domain.relationships.map((r) => ({ id: r.id, source: r.from, target: r.to, name: r.name, fact: r.statement, theme: r.theme })),
  };
}
