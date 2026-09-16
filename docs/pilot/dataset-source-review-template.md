# Dataset and source review template (content revision 2)

Use one copy of this template for every dataset, document, or reference before it is ingested, cited in a rubric, shown to learners, or given to a model as context. No source is used in the exercise until a human reviewer completes this form and a second person signs off.

As of this refresh, **no dataset has been reviewed or ingested**. The event catalog lists candidate resources by ID (for example competency frameworks, planning-doctrine extractions, an educational wargaming review, a synthetic discussion assignment). Those are portal metadata entries only; their contents remain deferred and have not been downloaded, read, or validated. They are not cited anywhere in this package as authority. The curriculum's source array holds only `SRC-000` (status `none`); the app's debrief validator therefore rejects any doctrine or mastery claim.

What the app can publish today is different from a learning source: `POST /api/ontology/publish` sends the curated game-domain description in `src/ontology/domain.ts` (seven concepts and fourteen rules about the abstract game) to the workroom's Graphiti instance. It contains no learner data and no external material. Whether that ingestion and subsequent search work is unknown until a receipt exists; this template is not satisfied by it.

---

## Source review record

**Source ID (internal):** SRC-____
**Title as listed:**
**Portal or origin reference:** (catalog ID, URL, or "provided by ____")
**Edition / version / date:**
**Format:** (PDF, CSV, JSON, Moodle backup, other)
**Content hash after download:** (sha256)
**Downloaded by / date:**
**Reviewer:**
**Second signer:**

### 1. Provenance

| Question | Answer |
| --- | --- |
| Who produced it? | |
| Is it an original, an extraction, or a synthetic fixture? | |
| If an extraction: what was the source document, and is paragraph lineage preserved? | |
| If synthetic: is the synthetic status marked in the file and in its catalog entry? | |
| Does the catalog edition match the edition referenced by any use case we target? (Record mismatches, do not reconcile them silently.) | |
| Distribution and handling markings present? | |

### 2. Fitness for this exercise

| Question | Answer |
| --- | --- |
| What would we use it for? (vocabulary, competency IDs, rubric anchors, learner-facing reading, model context, test fixture) | |
| Does it describe an abstract decision skill, or does it describe real-world tactics, targeting, or a specific adversary? | |
| If the latter: **exclude** from learner-facing material and model context. Note here. | |
| Does it contain named real organizations or persons whose inclusion would imply endorsement or a real-world model? | |
| Does it require a subject-matter expert to interpret? Who? | |

### 3. Content checks

| Check | Result |
| --- | --- |
| Opened and read by the reviewer (not just parsed) | yes / no |
| Schema documented (for structured data) | |
| Row or paragraph count | |
| Obvious extraction errors, truncation, encoding problems | |
| Contradictions with another reviewed source | (list SRC IDs) |
| Prompt-injection risk if given to a model (instructions embedded in content) | |

### 4. Decision

- [ ] Approved for: ______ (list uses from section 2)
- [ ] Approved with restrictions: ______
- [ ] Rejected. Reason: ______
- [ ] Deferred pending: ______

**Citation form to use in curriculum JSON:** `{"id":"SRC-____","title":"","edition":"","hash":"","status":"approved|restricted|rejected|pending","approved_uses":[]}`

### 5. Post-ingestion

| Item | Value |
| --- | --- |
| Ingestion date and tool | |
| Number of facts or entities extracted | |
| Spot-check: five extracted items compared to the source, all correct? | |
| Where extracted facts are stored and how they are scoped (side, exercise, learner) | |
| Retraction procedure if the source is later found wrong | |

---

## Rules that apply to every source

1. A catalog entry, a filename, or an "approved" flag in a portal is not content review.
2. Extraction lineage is required before any paragraph is cited to a learner. "The doctrine says" with no paragraph reference is not allowed.
3. Synthetic material is labeled synthetic everywhere it appears, including in a learner's dossier.
4. A source about real tactics or targeting is not used to generate exercise content, even if it is public.
5. Sources given to a model are data, not instructions. Test one injection case per source before enabling it as model context.
6. A rubric anchor that cites a source must quote or reference the specific passage, and a subject-matter expert must have agreed that the anchor is a fair reading.
