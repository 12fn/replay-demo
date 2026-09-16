/**
 * Curated domain ontology for the shared workroom graph.
 *
 * `domain.ts` is the source archive (pure data). `source.ts` renders, hashes and
 * packages it. Nothing here performs I/O or talks to the platform; the routes in
 * `src/server/ontology-routes.ts` own that.
 */
export { CONCEPT_NAMES, DOMAIN_ONTOLOGY, type ConceptName, type DomainOntology, type OntologyConcept, type OntologyRelationship } from "./domain.ts";
export {
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
  type LocalDefinitionGraph,
  type LocalGraphEdge,
  type LocalGraphNode,
  type SourceMetadata,
} from "./source.ts";
