/** Fictional presentation context only. No identity, policy, engine or service dependencies. */
export type OrganizationPackRole = 'commander' | 'intelligence' | 'instructor';

export interface SyntheticPackProvenance {
  readonly kind: 'synthetic';
  readonly status: 'provisional-unreviewed';
  readonly author: 'REPLAY project';
  readonly origin: string;
  readonly engineCommit: string;
  readonly scope: string;
  readonly limitations: readonly string[];
}

export interface PackGlossaryTerm {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  /** Local implementation references explain game terms; they are not approved learning sources. */
  readonly implementationReferences: readonly string[];
}

export interface PackOrganization {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
}

/** Narrative relationships, never native policy relations or grants. */
export interface PackRelationship {
  readonly fromOrganizationId: string;
  readonly toOrganizationId: string;
  readonly relationship: 'contributes-to' | 'reviews-evidence-for';
  readonly description: string;
}

export interface ProvisionalCurriculumReference {
  readonly id: string;
  readonly path: 'docs/pilot/exercise-curriculum.json';
  readonly curriculumId: 'replay-crosscurrent-decision-reasoning';
  readonly version: '0.1.0';
  readonly contentRevision: 2;
  readonly status: 'provisional-unreviewed';
  readonly objectiveId: string;
  readonly criterionId: string | null;
}

export interface RoleReportFieldDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly valueKind: 'prose' | 'tick' | 'evidence-references';
  /** Guidance for a report author, not admission rules for orders or a scoring rubric. */
  readonly evidenceGuidance: string;
}

export interface RoleReportStructure {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly fields: readonly RoleReportFieldDescriptor[];
}

export interface PackExerciseConcept {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly curriculumReferenceIds: readonly string[];
}

export interface PackExerciseTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly roles: readonly OrganizationPackRole[];
  readonly conceptIds: readonly string[];
  readonly suggestedEvidence: readonly string[];
  readonly prerequisite: string;
}

export interface PackLearningPrompt {
  readonly id: string;
  readonly prompt: string;
  readonly curriculumReferenceIds: readonly string[];
}

export interface OrganizationPackRoleView {
  readonly role: OrganizationPackRole;
  readonly title: string;
  readonly organizationId: string;
  readonly purpose: string;
  readonly collaboration: string;
  readonly report: RoleReportStructure;
  readonly learningPrompts: readonly PackLearningPrompt[];
}

export interface OrganizationPack {
  readonly schema: 'replay.organization-pack/1';
  readonly packId: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly authority: 'presentation-only';
  readonly provenance: SyntheticPackProvenance;
  /** Compatibility guidance only. A pack does not select or enable a scenario. */
  readonly scenarioIds: readonly string[];
  readonly organizations: readonly PackOrganization[];
  readonly relationships: readonly PackRelationship[];
  readonly glossary: readonly PackGlossaryTerm[];
  readonly concepts: readonly PackExerciseConcept[];
  readonly tasks: readonly PackExerciseTask[];
  readonly curriculumReferences: readonly ProvisionalCurriculumReference[];
  readonly roleViews: Readonly<Record<OrganizationPackRole, OrganizationPackRoleView>>;
}

export interface OrganizationPackSelection {
  readonly packId: string;
  readonly version: string;
  readonly role: OrganizationPackRole;
}

export interface ResolvedOrganizationPack extends Omit<OrganizationPack, 'roleViews'> {
  readonly roleView: OrganizationPackRoleView;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const provenance: SyntheticPackProvenance = {
  kind: 'synthetic', status: 'provisional-unreviewed', author: 'REPLAY project',
  origin: 'Original fictional context authored for the small Crosscurrent example.',
  engineCommit: '0f2ef7c43511cfb413a95e07d364139249d6905d',
  scope: 'Abstract OpenFront game resources, holdings and recorded decision evidence.',
  limitations: [
    'These packs are a foundation for an example. No human playtest or curriculum approval is claimed.',
    'Names and relationships are fictional. No real agency doctrine, military tactics or force posture is represented.',
    'Prompts invite reflection on recorded evidence. They do not predict personality, infer unrecorded motives or establish learning efficacy.',
    'Role context supplies no permission, delegation, evidence access or tool execution authority.',
  ],
};

const curriculumReferences: readonly ProvisionalCurriculumReference[] = [
  ['currency', 'OBJ-1', 'C1'], ['provenance', 'OBJ-2', 'C2'],
  ['uncertainty', 'OBJ-3', 'C3'], ['commitment', 'OBJ-4', 'C4'],
  ['explanation', 'OBJ-5', 'C5'], ['revision', 'OBJ-6', 'C6'],
  ['branch-practice', 'OBJ-7', 'C7'], ['ai-literacy', 'OBJ-8', null],
].map(([id, objectiveId, criterionId]) => ({
  id: id!, objectiveId: objectiveId!, criterionId,
  path: 'docs/pilot/exercise-curriculum.json',
  curriculumId: 'replay-crosscurrent-decision-reasoning', version: '0.1.0',
  contentRevision: 2, status: 'provisional-unreviewed',
}));

const glossary: readonly PackGlossaryTerm[] = [
  { id: 'resources', term: 'Abstract resources',
    definition: 'The game records gold and forces separately. Gold supports game construction; forces support legal player orders. Neither is a real inventory.',
    implementationReferences: ['src/engine/engine.ts'] },
  { id: 'reserves', term: 'Force reserves',
    definition: 'The player’s currently uncommitted forces, recorded as troops. Force capacity is maxTroops. Outgoing commitments are separate from the reserve.',
    implementationReferences: ['src/engine/engine.ts'] },
  { id: 'holdings', term: 'Holdings',
    definition: 'Owned map tiles and game structures at a stated tick. Ownership and tile totals are observations, not proof of reasoning quality.',
    implementationReferences: ['src/engine/engine.ts'] },
  { id: 'continuity', term: 'Objective continuity',
    definition: 'A written link from the stated objective to later decisions. After material change, record whether the objective or plan is kept or revised and why. This is a reporting concept, not an engine score.',
    implementationReferences: ['docs/pilot/exercise-curriculum.json'] },
  { id: 'currency', term: 'Source currency',
    definition: 'Whether a report was available and current at the decision tick. Superseded reports remain historical observations. A recent report can still leave unknowns.',
    implementationReferences: ['docs/pilot/exercise-curriculum.json'] },
  { id: 'evidence', term: 'Evidence',
    definition: 'A specific report, observation, event or recorded statement with its tick and origin. Separate what was observed from interpretation and preserve whether a statement was written during play or afterward.',
    implementationReferences: ['docs/pilot/exercise-curriculum.json'] },
];

const concepts: readonly PackExerciseConcept[] = [
  { id: 'source-review', title: 'Source review', description: 'Check when a report became available, what it observed and what remains unknown.', curriculumReferenceIds: ['currency', 'provenance', 'uncertainty'] },
  { id: 'resource-reasoning', title: 'Resources and holdings', description: 'Describe forces committed and retained, gold and holdings at the observation tick. Explain the chosen commitment using recorded evidence.', curriculumReferenceIds: ['commitment', 'explanation'] },
  { id: 'objective-continuity', title: 'Objective continuity', description: 'Connect the next decision to the stated objective and record a reason to keep or revise the plan after a material change.', curriculumReferenceIds: ['revision'] },
  { id: 'evidence-review', title: 'Review and informed practice', description: 'Keep outcome, recorded reasoning, assistance and later interpretation separate. A branch uses hindsight and is practice rather than an independent post measure.', curriculumReferenceIds: ['branch-practice', 'ai-literacy', 'explanation'] },
];

const tasks: readonly PackExerciseTask[] = [
  { id: 'decision-note', title: 'Explain a resource decision', roles: ['commander'], conceptIds: ['resource-reasoning', 'objective-continuity'],
    description: 'Write the objective, observed holdings and resources, proposed commitment, retained reserve and reason. Refer to the evidence available at the decision tick.',
    suggestedEvidence: ['Observation tick', 'Report references', 'Contemporaneous decision note', 'Command receipt if an order is separately authorized'],
    prerequisite: 'Use an authorized observation. Any order requires separate command admission.' },
  { id: 'source-assessment', title: 'Prepare a source assessment', roles: ['intelligence'], conceptIds: ['source-review'],
    description: 'Trace each claim to its source and tick. Describe supersession, uncertainty and any observation needed to resolve it.',
    suggestedEvidence: ['Available report references', 'Source release ticks', 'Recorded assessment'],
    prerequisite: 'Use only reports released to the participant’s scope at the selected tick.' },
  { id: 'change-review', title: 'Review a material change', roles: ['commander', 'intelligence'], conceptIds: ['source-review', 'objective-continuity'],
    description: 'Compare a new report or existing watch result with the earlier objective. Record a supported reason to revise or retain the plan.',
    suggestedEvidence: ['Prior objective statement', 'New report or watch event', 'Dated response'],
    prerequisite: 'A report or watch result must already be available. This task does not start a watch.' },
  { id: 'evidence-review', title: 'Review recorded evidence', roles: ['instructor'], conceptIds: ['evidence-review'],
    description: 'Check source timing, learner statements and assistance. Mark missing rationale as not observed and keep game outcome separate from provisional criterion observations.',
    suggestedEvidence: ['Released event references', 'Learner statements with timing', 'Assistance record', 'Provisional criterion reference'],
    prerequisite: 'Review only authorized records. Criteria remain provisional and findings require separate review.' },
  { id: 'branch-comparison', title: 'Compare informed practice', roles: ['commander', 'intelligence', 'instructor'], conceptIds: ['evidence-review'],
    description: 'State an assumption and compare an existing branch with its original record. Identify hindsight and avoid treating the comparison as a measure of improvement.',
    suggestedEvidence: ['Original and branch references', 'Fork tick', 'Written assumption', 'Written comparison'],
    prerequisite: 'An independently authorized branch and its permitted comparison records must exist.' },
];

const field = (id: string, label: string, description: string, evidenceGuidance: string,
  valueKind: RoleReportFieldDescriptor['valueKind'] = 'prose'): RoleReportFieldDescriptor =>
  ({ id, label, description, evidenceGuidance, valueKind });

const commonFields: readonly RoleReportFieldDescriptor[] = [
  field('observed-tick', 'Observation tick', 'State the game tick represented by this report.', 'Use the selected observation, not the wall clock or a later live state.', 'tick'),
  field('evidence', 'Evidence references', 'List the records supporting the report.', 'Keep report IDs, source ticks and availability distinct from later interpretations.', 'evidence-references'),
];

const roleViews: Readonly<Record<OrganizationPackRole, OrganizationPackRoleView>> = {
  commander: {
    role: 'commander', title: 'Coordination lead', organizationId: 'coordination',
    purpose: 'Explain the team objective and resource choices in the abstract exercise.',
    collaboration: 'Use the evidence desk’s assessments and leave a dated decision record for the learning desk.',
    report: { id: 'coordination-brief', title: 'Coordination brief', purpose: 'Connect a proposed decision to resources, evidence and the continuing objective.', fields: [
      ...commonFields,
      field('objective', 'Current objective', 'State the objective and what would justify changing it.', 'Reference the existing objective statement where available.'),
      field('resources', 'Resources and holdings', 'Describe gold, uncommitted forces, force capacity and owned tiles or structures.', 'Use game observations at the stated tick; do not substitute invented quantities.'),
      field('commitment', 'Commitment and retained reserve', 'Explain the proposed commitment and what remains available.', 'A written proposal is not an accepted order. Link a receipt only when one exists.'),
      field('continuity', 'Keep or revise the plan', 'Explain how the decision continues or changes the objective after new evidence.', 'Use the learner’s recorded reason and identify any later explanation.'),
    ] },
    learningPrompts: [
      { id: 'reserve-reason', prompt: 'What would remain available after this commitment, and which observation supports your choice?', curriculumReferenceIds: ['commitment', 'explanation'] },
      { id: 'plan-response', prompt: 'What changed in the available evidence, and why are you keeping or revising the plan?', curriculumReferenceIds: ['currency', 'revision'] },
    ],
  },
  intelligence: {
    role: 'intelligence', title: 'Evidence analyst', organizationId: 'evidence',
    purpose: 'Make claims, source currency and uncertainty clear to the coordination desk.',
    collaboration: 'Provide sourced assessments to the coordination desk and preserve their timing for review.',
    report: { id: 'source-assessment', title: 'Source assessment', purpose: 'Separate observations, interpretations and unresolved questions.', fields: [
      ...commonFields,
      field('claims', 'Supported observations', 'State what each source actually observed.', 'Trace each claim to an available report or map observation.'),
      field('currency', 'Currency and supersession', 'Identify the current report at this tick and any earlier reports used as history.', 'Retain release ticks and supersession links; later reports were unavailable earlier.'),
      field('uncertainty', 'Unknowns and interpretation', 'Separate interpretation from observation and state what remains unknown.', 'Do not infer opponent motives or learner personality from game actions.'),
      field('follow-up', 'Evidence needed next', 'Describe a question or observation that could resolve an uncertainty.', 'Reference an existing watch if relevant. This report grants no task or order authority.'),
    ] },
    learningPrompts: [
      { id: 'claim-source', prompt: 'Which claims can you trace to a report available at this tick, and which are interpretations?', curriculumReferenceIds: ['provenance', 'currency'] },
      { id: 'unknown-response', prompt: 'What is still unknown, and what recorded follow-up could address it?', curriculumReferenceIds: ['uncertainty'] },
    ],
  },
  instructor: {
    role: 'instructor', title: 'Learning facilitator', organizationId: 'learning',
    purpose: 'Organize a review of observable evidence using the provisional curriculum.',
    collaboration: 'Review the coordination and evidence desks’ records without supplying missing reasons on their behalf.',
    report: { id: 'learning-review', title: 'Learning evidence review', purpose: 'Record what can be supported and what must remain unresolved.', fields: [
      ...commonFields,
      field('versions', 'Exercise and reference versions', 'Identify the exercise, pack and provisional curriculum versions used.', 'Use the versions retained with the records, not an assumed latest edition.'),
      field('learning-evidence', 'Criterion observations', 'Link observable statements or actions to a provisional criterion where supported.', 'Missing rationale is not observed. Territory outcome alone supports no reasoning score.'),
      field('timing-assistance', 'Timing and assistance', 'Separate contemporaneous statements, later explanations and staff assistance.', 'Use recorded timing and assistance evidence; a model action summary is not private reasoning.'),
      field('review-status', 'Unresolved findings and next practice', 'State what remains unsupported and suggest a bounded practice question.', 'Withhold unsupported judgments. Branch comparisons are informed practice, not independent improvement evidence.'),
    ] },
    learningPrompts: [
      { id: 'recorded-reason', prompt: 'Which reasons were recorded during the decision, which came later, and which were not observed?', curriculumReferenceIds: ['explanation', 'ai-literacy'] },
      { id: 'practice-limits', prompt: 'What assumption does the branch comparison examine, and how does knowledge of the original future limit the comparison?', curriculumReferenceIds: ['branch-practice'] },
    ],
  },
};

const jointPack: OrganizationPack = {
  schema: 'replay.organization-pack/1', packId: 'crosscurrent-joint-coordination', version: '1.0.0',
  title: 'Crosscurrent joint coordination',
  description: 'A fictional coordination desk, evidence desk and learning desk work together on one abstract territory and resource exercise.',
  authority: 'presentation-only', provenance,
  scenarioIds: ['crosscurrent-classic/1', 'crosscurrent-maneuver/1', 'crosscurrent-crossing/1'],
  organizations: [
    { id: 'coordination', name: 'Crosscurrent coordination desk', purpose: 'Connect objectives, holdings and resource decisions.' },
    { id: 'evidence', name: 'Crosscurrent evidence desk', purpose: 'Provide assessments with source currency and uncertainty.' },
    { id: 'learning', name: 'Crosscurrent learning desk', purpose: 'Review recorded statements and provisional learning evidence.' },
  ],
  relationships: [
    { fromOrganizationId: 'evidence', toOrganizationId: 'coordination', relationship: 'contributes-to', description: 'The evidence desk supplies sourced assessments for coordination.' },
    { fromOrganizationId: 'learning', toOrganizationId: 'coordination', relationship: 'reviews-evidence-for', description: 'The learning desk reviews recorded resource decisions.' },
    { fromOrganizationId: 'learning', toOrganizationId: 'evidence', relationship: 'reviews-evidence-for', description: 'The learning desk reviews assessment provenance and timing.' },
  ],
  glossary, concepts, tasks, curriculumReferences, roleViews,
};

const networkField = field('station-continuity', 'Stations and objective continuity',
  'Describe observed station control, the current priority and reserve eligibility before explaining whether the plan should continue.',
  'Use the selected network view and recorded awards. A holdings snapshot alone does not prove continuous control or earlier points.');

const islandPack: OrganizationPack = {
  ...jointPack, packId: 'crosscurrent-island-network', version: '1.0.0',
  title: 'Crosscurrent island network',
  description: 'An optional fictional network context for the existing stations and reserves scenarios. The desks follow changing station priorities and evidence across an abstract map.',
  scenarioIds: ['crosscurrent-network/1', 'crosscurrent-objectives/1'],
  organizations: jointPack.organizations.map(org => ({ ...org, name: org.name.replace('Crosscurrent', 'Island network') })),
  glossary: [...glossary,
    { id: 'station', term: 'Station', definition: 'A marked footprint of land tiles in the network scenario. Control follows the configured ownership threshold. Stations are game objectives, not real facilities.', implementationReferences: ['src/campaign/network.ts'] },
    { id: 'priority', term: 'Priority station', definition: 'The station currently designated by the recorded network rules for extra game points. Priority changes on the scenario schedule; it is not assigned by this pack.', implementationReferences: ['src/campaign/network.ts'] },
    { id: 'reserve-eligibility', term: 'Reserve eligibility', definition: 'The network view records whether current reserves and station control qualify for the configured reserve bonus. Use the recorded award for points already earned.', implementationReferences: ['src/campaign/network.ts'] },
  ],
  concepts: [...concepts, { id: 'station-continuity', title: 'Stations and changing priorities', description: 'Compare station control, changing priority and reserve eligibility at recorded ticks. Connect changes to a stated objective without inventing continuity between snapshots.', curriculumReferenceIds: ['commitment', 'revision', 'provenance'] }],
  tasks: [...tasks, { id: 'station-review', title: 'Review a station priority change', roles: ['commander', 'intelligence', 'instructor'], conceptIds: ['station-continuity', 'objective-continuity'], description: 'Compare the available network views around a priority change and record a reason to retain or revise the objective. Keep game points separate from learning evidence.', suggestedEvidence: ['Network view ticks', 'Priority and controller records', 'Recorded awards', 'Dated objective response'], prerequisite: 'The exercise must use an existing network scenario and supply authorized network observations.' }],
  roleViews: {
    commander: { ...roleViews.commander, report: { ...roleViews.commander.report, id: 'network-coordination-brief', fields: [...roleViews.commander.report.fields, networkField] } },
    intelligence: { ...roleViews.intelligence, report: { ...roleViews.intelligence.report, id: 'network-source-assessment', fields: [...roleViews.intelligence.report.fields, field('station-evidence', 'Station evidence gaps', 'Identify the ticks supporting station control and priority claims and any gaps between observations.', 'Do not treat a single snapshot as an uninterrupted holding record.')] } },
    instructor: { ...roleViews.instructor, report: { ...roleViews.instructor.report, id: 'network-learning-review', fields: [...roleViews.instructor.report.fields, field('points-and-evidence', 'Game points and learning evidence', 'Record the network outcome separately from the evidence supporting provisional criteria.', 'Use recorded awards for game points and learner statements for reasons.')] } },
  },
};

const byId = <T extends { readonly id: string }>(entries: readonly T[], ...ids: string[]): T[] =>
  ids.map(id => entries.find(entry => entry.id === id)!);
const commanderField = (id: string) => byId(roleViews.commander.report.fields, id)[0];
const intelligenceField = (id: string) => byId(roleViews.intelligence.report.fields, id)[0];
const instructorField = (id: string) => byId(roleViews.instructor.report.fields, id)[0];

/** Map station names from src/campaign/network.ts. Report place names deliberately have no mapping to them. */
const placeNameCaution = 'Lantern, Marsh and Tidewell are report place names, not the map stations Aster, Beacon, Cedar, Delta or Ember. No mapping or effect between them is defined.';

// Purposes repeat the retained crosscurrent-changing-evidence/1 monitoringFocus text exactly.
const changingEvidencePack: OrganizationPack = {
  schema: 'replay.organization-pack/1', packId: 'crosscurrent-changing-evidence', version: '1.0.0',
  title: 'Crosscurrent changing evidence',
  description: 'An optional fictional context for the changing-intelligence scenario. The desks trace authored reports through corrections, disputes and repeats while station play continues on a separate abstract map.',
  authority: 'presentation-only',
  provenance: { ...provenance, scope: 'Abstract OpenFront station play and a separate fictional evidence packet (crosscurrent-changing-evidence/1). Packet claims are authored text, not engine state.' },
  scenarioIds: ['crosscurrent-evidence/1'],
  organizations: [
    { id: 'coordination', name: 'Changing evidence coordination desk', purpose: 'Connect objectives and reserve commitments to the reports available at the decision tick.' },
    { id: 'evidence', name: 'Changing evidence source desk', purpose: 'Trace authored claims through their sources, release ticks and declared links.' },
    { id: 'learning', name: 'Changing evidence learning desk', purpose: 'Review what was released before each recorded decision.' },
  ],
  relationships: jointPack.relationships.map(relation => ({ ...relation })),
  glossary: [...byId(glossary, 'reserves', 'currency', 'evidence'), byId(islandPack.glossary, 'station')[0],
    { id: 'authored-report', term: 'Authored report', definition: 'A fictional scripted claim released to one side at a stated tick. It is scenario text, not measured map or engine state. Its release changes no forces, holdings or permissions.', implementationReferences: ['src/scenarios/evidence-packet.ts'] },
    { id: 'source-lineage', term: 'Source lineage', definition: 'The declared links from a report back to its origin. A derived report repeats its origin and is not a separate observation. A disputed claim is unresolved, not false; no confidence is assigned.', implementationReferences: ['src/scenarios/evidence-packet.ts'] },
    { id: 'report-place-names', term: 'Report place names', definition: placeNameCaution, implementationReferences: ['src/scenarios/evidence-packet.ts', 'src/campaign/network.ts'] },
  ],
  concepts: [...concepts, { id: 'source-lineage', title: 'Changing source lineage', description: 'Follow a claim through corrections, disputes and repeats at release ticks. Count repeats with their origin and keep report claims separate from map observations.', curriculumReferenceIds: ['provenance', 'currency', 'uncertainty'] }],
  tasks: [...tasks, { id: 'lineage-review', title: 'Trace a changing claim', roles: ['commander', 'intelligence', 'instructor'], conceptIds: ['source-lineage', 'source-review'],
    description: 'Follow one report place name through its declared links. Record what was released by a decision tick and what arrived later.',
    suggestedEvidence: ['Released report references', 'Observed and release ticks', 'Declared links', 'Decision tick'],
    prerequisite: 'Use only reports released to your side by the selected tick. This task starts no watch and maps no report to a map station.' }],
  curriculumReferences,
  roleViews: {
    commander: {
      ...roleViews.commander,
      purpose: 'Note which current reports bear on the stated objective and which questions remain open before committing reserves.',
      collaboration: 'Use the source desk’s lineage assessments and leave a dated decision record for the learning desk.',
      report: { id: 'evidence-coordination-brief', title: 'Coordination brief', purpose: 'Connect a commitment to current reports, map observations and the open questions that remain.', fields: [
        ...commonFields, commanderField('objective'), commanderField('resources'),
        field('open-questions', 'Open questions before committing', 'List the current reports that bear on the objective, what is disputed or unmeasured, and why you commit now or wait.',
          `Cite reports released by the decision tick. ${placeNameCaution}`),
        commanderField('commitment'), commanderField('continuity'),
      ] },
      learningPrompts: [
        { id: 'open-question', prompt: 'Which open question would change this commitment, and is it answered by a report or by a map observation?', curriculumReferenceIds: ['uncertainty', 'commitment'] },
        byId(roleViews.commander.learningPrompts, 'plan-response')[0],
      ],
    },
    intelligence: {
      ...roleViews.intelligence,
      purpose: 'Trace each claim to its source and release tick; separate corrections, unresolved contradictions and repeats of an earlier report.',
      collaboration: 'Provide lineage assessments to the coordination desk and preserve their timing for review.',
      report: { id: 'source-lineage-assessment', title: 'Source lineage assessment', purpose: 'Show where each claim came from, how it changed and what remains unresolved.', fields: [
        ...commonFields, intelligenceField('claims'),
        field('lineage', 'Source lineage', 'For each claim, give the source, observed and release ticks, and any report it repeats, corrects or disputes.',
          'Count a derived report with its origin, not as another observation. A dispute stays unresolved until a declared link changes it.'),
        intelligenceField('currency'),
        field('report-versus-map', 'Report claims and map observations', 'Keep claims about report place names apart from observed station control and forces.', placeNameCaution),
        intelligenceField('uncertainty'), intelligenceField('follow-up'),
      ] },
      learningPrompts: [
        { id: 'lineage-count', prompt: 'After tracing repeats to their origin, how many separate lineages support this claim, and which are superseded or disputed?', curriculumReferenceIds: ['provenance', 'currency'] },
        byId(roleViews.intelligence.learningPrompts, 'unknown-response')[0],
      ],
    },
    instructor: {
      ...roleViews.instructor,
      purpose: 'Review which reports were released at each decision tick. Later corrections were not available to earlier decisions.',
      report: { id: 'evidence-learning-review', title: 'Learning evidence review', purpose: 'Record what each decision could draw on and what can be supported from the record.', fields: [
        ...commonFields, instructorField('versions'),
        field('release-timing', 'Reports available at each decision', 'For each decision, list the reports released by its tick and any later correction or dispute.',
          'Do not judge an earlier decision against later reports. Record the evidence packet version with the other versions.'),
        instructorField('learning-evidence'), instructorField('timing-assistance'), instructorField('review-status'),
      ] },
      learningPrompts: [
        { id: 'release-review', prompt: 'Which reports were released when each decision was recorded, and did the reason rely on one later corrected or disputed?', curriculumReferenceIds: ['currency', 'explanation'] },
        { id: 'repeat-review', prompt: 'Did the learner treat a repeated report as separate support, and was that reason recorded during the decision or afterward?', curriculumReferenceIds: ['provenance', 'explanation'] },
      ],
    },
  },
};

/** Append new versions; never revise an existing ID/version pair or add a latest alias. */
export const ORGANIZATION_PACK_CATALOG: readonly OrganizationPack[] = freeze([jointPack, islandPack, changingEvidencePack]);

export class OrganizationPackResolutionError extends Error {
  constructor(readonly code: 'unknown-pack' | 'unknown-version' | 'unknown-role') {
    super({ 'unknown-pack': 'Unknown organization pack.', 'unknown-version': 'Unknown organization pack version.', 'unknown-role': 'Unknown organization pack role.' }[code]);
    this.name = 'OrganizationPackResolutionError';
  }
}

/** Exact explicit lookup. The caller owns assignment, authorization and evidence scoping. */
export function resolveOrganizationPack(selection: OrganizationPackSelection): ResolvedOrganizationPack {
  const candidates = ORGANIZATION_PACK_CATALOG.filter(pack => pack.packId === selection.packId);
  if (!candidates.length) throw new OrganizationPackResolutionError('unknown-pack');
  const pack = candidates.find(candidate => candidate.version === selection.version);
  if (!pack) throw new OrganizationPackResolutionError('unknown-version');
  if (selection.role !== 'commander' && selection.role !== 'intelligence' && selection.role !== 'instructor') {
    throw new OrganizationPackResolutionError('unknown-role');
  }
  const { roleViews: views, tasks: availableTasks, ...context } = pack;
  return freeze({ ...context, roleView: views[selection.role], tasks: availableTasks.filter(task => task.roles.includes(selection.role)) });
}
