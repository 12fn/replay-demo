import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CONCEPT_NAMES,
  DOMAIN_ONTOLOGY,
  LOCAL_DEFINITION_LABEL,
  MAX_EPISODE_BYTES,
  buildKnowledgeRequest,
  canonicalSourceText,
  entityTypes,
  episodeContent,
  ingestionKey,
  ingestionKeyPrefix,
  isUuid,
  localDefinitionGraph,
  sourceHash,
  sourceMetadata,
} from "../../src/ontology/index.ts";

const WORKROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5";
const ONTOLOGY = "f6e5e895-5673-40d2-a34b-0bf4343f362f";

/**
 * Pinned content hash of replay.domain-ontology@1.0.0. Any edit to src/ontology/domain.ts
 * changes this value; the edit must then bump `version` and this constant together so the
 * new definition publishes under a new ingestion key instead of being mistaken for the old one.
 */
const PINNED_HASH = "sha256:d928b9c349486350390b953a61c1bf558e893ba354b43047db5a0cc9c9853bf3";

describe("curated domain source", () => {
  it("has the seven agreed concepts and only relationships between them", () => {
    expect(CONCEPT_NAMES).toEqual(["Exercise", "PlayerTool", "Decision", "SourceReport", "StaffWatch", "Branch", "LearningObjective"]);
    const names = new Set<string>(CONCEPT_NAMES);
    const ids = new Set<string>();
    for (const r of DOMAIN_ONTOLOGY.relationships) {
      expect(names.has(r.from)).toBe(true);
      expect(names.has(r.to)).toBe(true);
      expect(/^[A-Z_]+$/.test(r.name)).toBe(true);
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
    }
    const themes = new Set(DOMAIN_ONTOLOGY.relationships.map((r) => r.theme));
    for (const t of ["legal tools", "source supersession", "clock", "replay", "branch isolation"]) expect(themes.has(t as never)).toBe(true);
  });

  it("stays abstract: scope disclaims doctrine, adversary intelligence and participant data", () => {
    const text = canonicalSourceText();
    expect(text).toMatch(/No real-world doctrine/);
    expect(text).toMatch(/No participant data/);
    // Nothing that looks like a person, an email or a UUID is in the source.
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("renders and hashes deterministically, and the hash is pinned to the version", () => {
    expect(canonicalSourceText()).toBe(canonicalSourceText());
    expect(sourceHash()).toBe(`sha256:${createHash("sha256").update(canonicalSourceText(), "utf8").digest("hex")}`);
    expect(sourceHash()).toBe(sourceHash());
    expect(DOMAIN_ONTOLOGY.version).toBe("1.0.0");
    expect(sourceHash()).toBe(PINNED_HASH);
    // A content change produces a different hash: this is what forces a version bump.
    const edited = { ...DOMAIN_ONTOLOGY, scope: [...DOMAIN_ONTOLOGY.scope, "an extra line"] };
    expect(sourceHash(edited)).not.toBe(PINNED_HASH);
  });

  it("publishes one bounded user message that cites the source id, version and hash", () => {
    const req = buildKnowledgeRequest(WORKROOM);
    expect(req.group_id).toBe(WORKROOM);
    expect(req.messages).toHaveLength(1);
    const m = req.messages[0]!;
    expect(m.role).toBe("user");
    expect(m.role_type).toBe("user");
    expect(m.timestamp).toBe(DOMAIN_ONTOLOGY.sourceDate);
    expect(m.content).toContain(`source_id: ${DOMAIN_ONTOLOGY.sourceId}`);
    expect(m.content).toContain(`version: ${DOMAIN_ONTOLOGY.version}`);
    expect(m.content).toContain(`source_hash: ${sourceHash()}`);
    expect(m.content).toContain("src/ontology/domain.ts");
    expect(m.source_description).toContain(`${DOMAIN_ONTOLOGY.sourceId}@${DOMAIN_ONTOLOGY.version}`);
    expect(m.source_description).toContain(sourceHash());
    expect(Buffer.byteLength(m.content, "utf8")).toBeLessThanOrEqual(MAX_EPISODE_BYTES);
    expect(m.content).toBe(episodeContent());
    // Typed extraction schema: exactly the seven concepts, catch-all excluded.
    expect(Object.keys(req.entity_types!)).toEqual([...CONCEPT_NAMES]);
    for (const c of DOMAIN_ONTOLOGY.concepts) expect(req.entity_types![c.name]!.description).toBe(c.description);
    expect(req.excluded_entity_types).toEqual(["Entity"]);
    expect(entityTypes()).toEqual(req.entity_types);
    // Identical every time: a version publishes the same batch.
    expect(JSON.stringify(buildKnowledgeRequest(WORKROOM))).toBe(JSON.stringify(req));
  });

  it("refuses any group that is not a workroom UUID", () => {
    expect(() => buildKnowledgeRequest("replay-domain")).toThrow(/workroom UUID/);
    expect(() => buildKnowledgeRequest(`${WORKROOM}:shared`)).toThrow(/workroom UUID/);
    expect(() => ingestionKey("nope", ONTOLOGY)).toThrow(/UUID/);
    expect(() => ingestionKey(WORKROOM, "nope")).toThrow(/UUID/);
    expect(isUuid(WORKROOM)).toBe(true);
    expect(isUuid(WORKROOM.toUpperCase())).toBe(true);
    expect(isUuid("280d6347c0f54123-8dd4-93a53c3045e5")).toBe(false);
  });

  it("derives a stable ingestion key per workroom, instance and version", () => {
    const key = ingestionKey(WORKROOM, ONTOLOGY);
    expect(key).toBe(ingestionKey(WORKROOM.toUpperCase(), ONTOLOGY));
    expect(key.startsWith(ingestionKeyPrefix(WORKROOM, ONTOLOGY))).toBe(true);
    expect(key).toContain(`${DOMAIN_ONTOLOGY.sourceId}@${DOMAIN_ONTOLOGY.version}`);
    expect(key).toContain(sourceHash().slice("sha256:".length, "sha256:".length + 16));
    expect(ingestionKey(WORKROOM, "99999999-aaaa-4bbb-8ccc-dddddddddddd")).not.toBe(key);
    const bumped = { ...DOMAIN_ONTOLOGY, version: "1.1.0" };
    expect(ingestionKey(WORKROOM, ONTOLOGY, bumped)).not.toBe(key);
  });

  it("exposes source metadata and a local projection labelled as such", () => {
    const meta = sourceMetadata();
    expect(meta).toMatchObject({ sourceId: DOMAIN_ONTOLOGY.sourceId, version: "1.0.0", hash: PINNED_HASH, conceptCount: 7, relationshipCount: DOMAIN_ONTOLOGY.relationships.length });
    expect(meta.episodeBytes).toBeLessThanOrEqual(MAX_EPISODE_BYTES);
    const g = localDefinitionGraph();
    expect(g.label).toBe(LOCAL_DEFINITION_LABEL);
    expect(g.label).toMatch(/not the native graph/);
    expect(g.nodes.map((n) => n.id)).toEqual([...CONCEPT_NAMES]);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});
