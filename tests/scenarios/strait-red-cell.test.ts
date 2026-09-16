import { describe, expect, it } from 'vitest';
import {
  STRAIT_RED_CELL, STRAIT_RED_CELL_MAX_BYTES, STRAIT_RED_CELL_VERSION,
  straitRedCellInstructions, straitRedCellPublicBrief,
} from '../../src/scenarios/strait-red-cell';
import { playerInstructions } from '../../src/agents/player';
import { toolsForScope } from '../../src/agents/tools';

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const isDeepFrozen = (value: unknown): boolean =>
  value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));

/** Content fingerprint: a failing assertion here means a new profile version is required. */
const PROFILE_JSON = JSON.stringify(STRAIT_RED_CELL);

describe('strait red cell profile identity', () => {
  it('names the versioned scenario, map, title and archetype', () => {
    expect(STRAIT_RED_CELL).toMatchObject({
      schema: 'replay.red-cell-profile/1', version: 'strait-red-cell/1', seat: 'red',
      scenarioId: 'taiwan-strait/1', mapId: 'taiwan-strait-400',
      title: 'Strait Red Cell', archetype: 'Adaptive maritime opponent',
    });
    expect(STRAIT_RED_CELL_VERSION).toBe('strait-red-cell/1');
    expect(straitRedCellPublicBrief()).toMatchObject({
      version: 'strait-red-cell/1', scenarioId: 'taiwan-strait/1', mapId: 'taiwan-strait-400',
      title: 'Strait Red Cell', archetype: 'Adaptive maritime opponent',
    });
  });

  it('is deeply frozen and cannot be edited in place', () => {
    expect(isDeepFrozen(STRAIT_RED_CELL)).toBe(true);
    expect(isDeepFrozen(straitRedCellPublicBrief())).toBe(true);
    expect(() => { (STRAIT_RED_CELL.objectives as any)[0].label = 'Changed'; }).toThrow();
    expect(() => { (STRAIT_RED_CELL.capabilities.tools as any).push('extra_tool'); }).toThrow();
    expect(JSON.stringify(STRAIT_RED_CELL)).toBe(PROFILE_JSON);
  });

  it('is plain JSON with deterministic output', () => {
    expect(JSON.parse(JSON.stringify(STRAIT_RED_CELL))).toEqual(STRAIT_RED_CELL);
    expect(JSON.parse(JSON.stringify(straitRedCellPublicBrief()))).toEqual(straitRedCellPublicBrief());
    expect(straitRedCellInstructions()).toBe(straitRedCellInstructions());
    expect(straitRedCellPublicBrief()).toBe(straitRedCellPublicBrief());
  });

  it('keeps instructions plus public brief under the byte bound', () => {
    const total = bytes(straitRedCellInstructions()) + bytes(JSON.stringify(straitRedCellPublicBrief()));
    expect(STRAIT_RED_CELL_MAX_BYTES).toBe(5000);
    expect(total).toBeLessThan(STRAIT_RED_CELL_MAX_BYTES);
  });
});

describe('strait red cell objectives', () => {
  it('lists five fictional exercise markers with Penghu relay as initial priority', () => {
    expect(STRAIT_RED_CELL.objectives.map(o => [o.id, o.label])).toEqual([
      ['aster', 'Northern relay'], ['beacon', 'Central relay'], ['cedar', 'Penghu relay'],
      ['delta', 'Western relay'], ['ember', 'Southern relay'],
    ]);
    expect(STRAIT_RED_CELL.objectives.every(o => o.kind === 'fictional-exercise-marker')).toBe(true);
    expect(STRAIT_RED_CELL.initialPriorityId).toBe('cedar');
    expect(STRAIT_RED_CELL.priorityOrder).toBe('published-board');
    const text = straitRedCellInstructions();
    expect(text).toContain('Penghu relay (cedar)');
    expect(text).toContain('not facilities or targets');
    expect(text).toContain('published board defines the rotating order');
  });

  it('carries no coordinates, ownership or schedule that would compete with the board', () => {
    for (const marker of STRAIT_RED_CELL.objectives) expect(Object.keys(marker).sort()).toEqual(['id', 'kind', 'label']);
    expect(PROFILE_JSON).not.toMatch(/"(x|y|tile|tiles|controller|ticks?|priorityEveryTicks)"/);
  });
});

describe('strait red cell capabilities', () => {
  it('uses only normal player tools and does not invent resources or budgets', () => {
    const playerTools = new Set(toolsForScope('player').map(t => t.name));
    for (const tool of STRAIT_RED_CELL.capabilities.tools) expect(playerTools.has(tool)).toBe(true);
    expect(STRAIT_RED_CELL.capabilities).toMatchObject({
      player: 'ai-player', resources: 'normal-side-resources', toolBudget: 'normal-player-budget',
    });
    const all = straitRedCellInstructions() + JSON.stringify(straitRedCellPublicBrief()) + PROFILE_JSON;
    // No numeric force, gold, request or spend figures and no global caps.
    expect(all).not.toMatch(/\b\d+\s*(troops|forces|gold|requests|pulses|tokens|%)/i);
    expect(all).not.toMatch(/USD|\$\d|budget cap|paid request|bonus troops|extra (forces|gold|tools)|unlimited/i);
  });

  it('appends to rather than overrides the generic player instructions', () => {
    const text = straitRedCellInstructions();
    expect(text).not.toMatch(/ignore|disregard|override|instead of the|replace/i);
    expect(text).toContain('never forbids a stronger legal move');
    expect(text).toMatch(/Never intentionally lose/);
    for (const style of ['reserve-aware', 'expansion-focused', 'opportunistic'] as const) {
      const combined = `${playerInstructions(style)}\n${text}`;
      expect(combined.startsWith(playerInstructions(style))).toBe(true);
    }
  });

  it('asks for an external brief without hidden reasoning', () => {
    expect(STRAIT_RED_CELL.externalBrief.fields).toEqual(['selectedAction', 'observedBasis', 'uncertainty']);
    expect(straitRedCellInstructions()).toContain('Do not disclose hidden reasoning');
  });
});

describe('strait red cell real geography versus fictional dossier', () => {
  it('names real places only as map geography and marks everything else fictional', () => {
    expect(STRAIT_RED_CELL.geography.basis).toBe('pinned-openfront-400x400');
    expect(STRAIT_RED_CELL.geography.realPlaceNames).toEqual(['mainland coast', 'Taiwan', 'Penghu', 'Taiwan Strait']);
    expect(STRAIT_RED_CELL.nature.kind).toBe('fictional-training-opponent');
    for (const text of [straitRedCellInstructions(), straitRedCellPublicBrief().notice]) {
      expect(text).toMatch(/Not a model of any real military force, doctrine or plan/);
      expect(text).toMatch(/no real adversary intelligence/);
    }
  });

  it('contains no real force, equipment, operation or target-list vocabulary', () => {
    const all = straitRedCellInstructions() + JSON.stringify(straitRedCellPublicBrief()) + PROFILE_JSON;
    expect(all).not.toMatch(/\bPLAN?\b|\bROC\b|\bPRC\b/);
    expect(all).not.toMatch(/People'?s Liberation|Eastern Theater|brigade|battalion|division|fleet|carrier|destroyer|frigate|missile|rocket|\bDF-\d|\bJ-\d|aircraft|fighter|submarine|drone|invasion|blockade|strike|bombard|casualt|target list|high-value|port of|airbase|air base|naval base|Kaohsiung|Taipei|Keelung|Kinmen|Matsu|Fujian|Xiamen/i);
  });

  it('does not claim a scripted plan or prediction', () => {
    const text = straitRedCellInstructions();
    expect(text).toContain('no canned sequence or scripted prediction');
    expect(text).toContain('Do not assume ownership or location from marker labels');
    expect(text).toContain('Private Blue orders and plans are not visible');
  });
});

describe('strait red cell role focus', () => {
  it('maps each role to its focus with evidence-cited questions and no mastery score', () => {
    expect(STRAIT_RED_CELL.roleFocus.map(r => [r.role, r.focus])).toEqual([
      ['commander', 'Choice and commitment'], ['intelligence', 'Source corroboration'], ['instructor', 'Decision review'],
    ]);
    for (const role of STRAIT_RED_CELL.roleFocus) {
      expect(role.learningTargets.length).toBeGreaterThan(0);
      for (const target of role.learningTargets) {
        expect(target.answerWith).toBe('evidence-ids');
        expect(target.question.endsWith('?')).toBe(true);
      }
    }
    expect(PROFILE_JSON).not.toMatch(/mastery|score"|rating|grade/i);
  });

  it('public brief exposes capabilities, objective, principles and limits without authority fields', () => {
    const brief = straitRedCellPublicBrief();
    expect(brief.capabilities.length).toBeGreaterThan(0);
    expect(brief.objective).toBe(STRAIT_RED_CELL.capabilities.goal);
    expect(brief.principles.map(p => p.id)).toEqual(STRAIT_RED_CELL.principles.map(p => p.id));
    expect(brief.knowledgeLimits).toEqual(STRAIT_RED_CELL.knowledgeLimits);
    expect(JSON.stringify(brief)).not.toMatch(/"(tools|scopes|grants?|permissions?|provider|model|apiKey|credential)"/i);
  });
});
