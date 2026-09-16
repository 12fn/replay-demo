/**
 * Strait Red Cell: a versioned style profile for the AI Red player on the Taiwan Strait map.
 * Pure JSON data and pure functions: no engine, tool, provider, budget or identity dependencies.
 * The map shows recognizable real geography; everything else is a fictional abstract exercise and
 * is not a model of any real force, doctrine, plan or intelligence.
 */
import type { OrganizationPackRole } from '../context/organization-packs';

/** Append a new version for any content change; never revise a released profile in place. */
export const STRAIT_RED_CELL_VERSION = 'strait-red-cell/1';
export const STRAIT_RED_CELL_SCHEMA = 'replay.red-cell-profile/1';
export const STRAIT_RED_CELL_BRIEF_SCHEMA = 'replay.red-cell-brief/1';
/** Combined UTF-8 bound for the appended instructions plus the compact JSON public brief. */
export const STRAIT_RED_CELL_MAX_BYTES = 5000;

export type StraitObjectiveId = 'aster' | 'beacon' | 'cedar' | 'delta' | 'ember';

export interface StraitObjectiveMarker {
  readonly id: StraitObjectiveId;
  readonly label: string;
  readonly kind: 'fictional-exercise-marker';
}

export interface StraitPrinciple {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface StraitRoleFocus {
  readonly role: OrganizationPackRole;
  readonly focus: string;
  /** Questions answered by citing evidence IDs; never a mastery score. */
  readonly learningTargets: readonly { readonly id: string; readonly question: string; readonly answerWith: 'evidence-ids' }[];
}

export interface StraitRedCellProfile {
  readonly schema: typeof STRAIT_RED_CELL_SCHEMA;
  readonly version: typeof STRAIT_RED_CELL_VERSION;
  readonly scenarioId: 'taiwan-strait/1';
  readonly mapId: 'taiwan-strait-400';
  readonly seat: 'red';
  readonly title: 'Strait Red Cell';
  readonly archetype: 'Adaptive maritime opponent';
  readonly nature: {
    readonly kind: 'fictional-training-opponent';
    readonly notice: string;
  };
  readonly geography: {
    readonly basis: 'pinned-openfront-400x400';
    /** Plain place names visible on the map terrain; they carry no scenario facts. */
    readonly realPlaceNames: readonly string[];
    readonly note: string;
  };
  readonly capabilities: {
    readonly player: 'ai-player';
    /** The side's ordinary engine resources and the scenario's ordinary tool budget; nothing extra. */
    readonly resources: 'normal-side-resources';
    readonly toolBudget: 'normal-player-budget';
    readonly tools: readonly string[];
    readonly goal: string;
    readonly stylePrecedence: string;
  };
  readonly objectives: readonly StraitObjectiveMarker[];
  readonly initialPriorityId: 'cedar';
  readonly priorityOrder: 'published-board';
  readonly principles: readonly StraitPrinciple[];
  readonly knowledgeLimits: readonly string[];
  readonly externalBrief: {
    readonly fields: readonly ('selectedAction' | 'observedBasis' | 'uncertainty')[];
    readonly excludes: string;
  };
  readonly roleFocus: readonly StraitRoleFocus[];
}

/** Compact display projection for UI and receipts. */
export interface StraitRedCellPublicBrief {
  readonly schema: typeof STRAIT_RED_CELL_BRIEF_SCHEMA;
  readonly version: typeof STRAIT_RED_CELL_VERSION;
  readonly scenarioId: StraitRedCellProfile['scenarioId'];
  readonly mapId: StraitRedCellProfile['mapId'];
  readonly title: StraitRedCellProfile['title'];
  readonly archetype: StraitRedCellProfile['archetype'];
  readonly notice: string;
  readonly capabilities: readonly string[];
  readonly objective: string;
  readonly objectives: readonly { readonly id: StraitObjectiveId; readonly label: string }[];
  readonly principles: readonly { readonly id: string; readonly title: string }[];
  readonly knowledgeLimits: readonly string[];
  readonly roleFocus: readonly { readonly role: OrganizationPackRole; readonly focus: string }[];
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const STRAIT_RED_CELL: StraitRedCellProfile = freeze({
  schema: STRAIT_RED_CELL_SCHEMA,
  version: STRAIT_RED_CELL_VERSION,
  scenarioId: 'taiwan-strait/1',
  mapId: 'taiwan-strait-400',
  seat: 'red',
  title: 'Strait Red Cell',
  archetype: 'Adaptive maritime opponent',
  nature: {
    kind: 'fictional-training-opponent',
    notice: 'Abstract fictional training opponent on recognizable real geography. Not a model of any real military force, doctrine or plan, and holds no real adversary intelligence.',
  },
  geography: {
    basis: 'pinned-openfront-400x400',
    realPlaceNames: ['mainland coast', 'Taiwan', 'Penghu', 'Taiwan Strait'],
    note: 'Terrain comes from the pinned OpenFront 400x400 map. Place names describe the map only.',
  },
  capabilities: {
    player: 'ai-player',
    resources: 'normal-side-resources',
    toolBudget: 'normal-player-budget',
    tools: ['observe', 'list_legal_actions', 'list_resources', 'list_owned_units', 'list_border_tiles',
      'inspect_tile', 'search_reports', 'recent_orders', 'resource_delta', 'submit_order', 'delegate_watch'],
    goal: 'Try to win under the published objectives board. Never intentionally lose or stage a teaching moment.',
    stylePrecedence: 'Style is a tie-break preference only; it never forbids a stronger legal move.',
  },
  objectives: [
    { id: 'aster', label: 'Northern relay', kind: 'fictional-exercise-marker' },
    { id: 'beacon', label: 'Central relay', kind: 'fictional-exercise-marker' },
    { id: 'cedar', label: 'Penghu relay', kind: 'fictional-exercise-marker' },
    { id: 'delta', label: 'Western relay', kind: 'fictional-exercise-marker' },
    { id: 'ember', label: 'Southern relay', kind: 'fictional-exercise-marker' },
  ],
  initialPriorityId: 'cedar',
  priorityOrder: 'published-board',
  principles: [
    { id: 'separation', title: 'Separated landmasses',
      text: 'Mainland and island are divided by water; moving forces across needs a transport order.' },
    { id: 'transport-latency', title: 'Admission is not arrival',
      text: 'An admitted transport order has not landed. Count a landing only after recent_orders or the board shows it.' },
    { id: 'reserve-economy', title: 'Reserve and economy',
      text: 'Weigh each commitment against reserve, gold and growth; overextension risks the reserve bonus and holdings.' },
    { id: 'objective-control', title: 'Objective control',
      text: 'Control is measured board holdings. Compare priority, holdings and reserve before committing.' },
    { id: 'reactive-adjustment', title: 'Adjust to observations',
      text: 'There is no canned sequence or scripted prediction. Re-plan from current observations each pulse.' },
  ],
  knowledgeLimits: [
    'Read the objectives board and current legal actions each pulse.',
    'Do not assume ownership or location from marker labels.',
    'Private Blue orders and plans are not visible; public attacks and board changes may be observed. Do not treat guesses as fact.',
    'Reports are fictional exercise data, not real-world intelligence.',
  ],
  externalBrief: {
    fields: ['selectedAction', 'observedBasis', 'uncertainty'],
    excludes: 'hidden chain of thought',
  },
  roleFocus: [
    { role: 'commander', focus: 'Choice and commitment',
      learningTargets: [{ id: 'commit-basis', answerWith: 'evidence-ids',
        question: 'Which observations justified committing forces or holding reserve against Red at this moment?' }] },
    { role: 'intelligence', focus: 'Source corroboration',
      learningTargets: [{ id: 'corroborate-red', answerWith: 'evidence-ids',
        question: 'Which reports about Red were corroborated by measured board state, and which were not?' }] },
    { role: 'instructor', focus: 'Decision review',
      learningTargets: [{ id: 'review-adaptation', answerWith: 'evidence-ids',
        question: 'Where did Red adapt to an observed change, and how did Blue respond?' }] },
  ],
});

const objectiveList = STRAIT_RED_CELL.objectives.map(o => `${o.label} (${o.id})`).join(', ');
const initialPriority = STRAIT_RED_CELL.objectives.find(o => o.id === STRAIT_RED_CELL.initialPriorityId)!;

const INSTRUCTIONS = [
  `Scenario profile ${STRAIT_RED_CELL.version} (${STRAIT_RED_CELL.title}; scenario ${STRAIT_RED_CELL.scenarioId}; map ${STRAIT_RED_CELL.mapId}).`,
  `You play Red as an ${STRAIT_RED_CELL.archetype.toLowerCase()}, using your ordinary resources, tools and order budget. ${STRAIT_RED_CELL.capabilities.goal} ${STRAIT_RED_CELL.capabilities.stylePrecedence}`,
  `The map terrain shows recognizable real places (${STRAIT_RED_CELL.geography.realPlaceNames.join(', ')}). ${STRAIT_RED_CELL.nature.notice}`,
  `Playable constraints: ${STRAIT_RED_CELL.principles.map(p => p.text).join(' ')}`,
  `Objectives are five fictional exercise markers, not facilities or targets: ${objectiveList}. The initial priority is ${initialPriority.label} (${initialPriority.id}), uncontrolled at the start; the published board defines the rotating order and timing.`,
  `${STRAIT_RED_CELL.knowledgeLimits.join(' ')} Use board holdings, tiles and legal actions for location and ownership.`,
  'After choosing, give a short external brief: the selected action, the observations it rests on and your main uncertainty. Do not disclose hidden reasoning.',
].join('\n');

/** Scenario-specific text for the caller to append after the generic player instructions. */
export function straitRedCellInstructions(): string {
  return INSTRUCTIONS;
}

const PUBLIC_BRIEF: StraitRedCellPublicBrief = freeze({
  schema: STRAIT_RED_CELL_BRIEF_SCHEMA,
  version: STRAIT_RED_CELL.version,
  scenarioId: STRAIT_RED_CELL.scenarioId,
  mapId: STRAIT_RED_CELL.mapId,
  title: STRAIT_RED_CELL.title,
  archetype: STRAIT_RED_CELL.archetype,
  notice: STRAIT_RED_CELL.nature.notice,
  capabilities: [
    'AI player using ordinary side resources and legal orders within the model pulse budget.',
    'Submits only legal orders; admission does not guarantee an effect.',
    STRAIT_RED_CELL.capabilities.stylePrecedence,
  ],
  objective: STRAIT_RED_CELL.capabilities.goal,
  objectives: STRAIT_RED_CELL.objectives.map(({ id, label }) => ({ id, label })),
  principles: STRAIT_RED_CELL.principles.map(({ id, title }) => ({ id, title })),
  knowledgeLimits: [...STRAIT_RED_CELL.knowledgeLimits],
  roleFocus: STRAIT_RED_CELL.roleFocus.map(({ role, focus }) => ({ role, focus })),
});

/** Frozen display projection. Carries no tool, provider, budget or permission authority. */
export function straitRedCellPublicBrief(): StraitRedCellPublicBrief {
  return PUBLIC_BRIEF;
}
