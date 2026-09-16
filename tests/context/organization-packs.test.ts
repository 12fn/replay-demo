import { describe, expect, it } from 'vitest';
import curriculum from '../../docs/pilot/exercise-curriculum.json';
import { SCENARIOS } from '../../src/scenarios/catalog';
import {
  ORGANIZATION_PACK_CATALOG,
  OrganizationPackResolutionError,
  resolveOrganizationPack,
  type OrganizationPackRole,
  type OrganizationPackSelection,
} from '../../src/context/organization-packs';

const selection: OrganizationPackSelection = {
  packId: 'crosscurrent-joint-coordination', version: '1.0.0', role: 'commander',
};
const roles: readonly OrganizationPackRole[] = ['commander', 'intelligence', 'instructor'];

function expectResolutionError(input: OrganizationPackSelection, code: OrganizationPackResolutionError['code']) {
  expect(() => resolveOrganizationPack(input)).toThrow(OrganizationPackResolutionError);
  try { resolveOrganizationPack(input); } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function assertDeeplyFrozen(value: unknown) {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) assertDeeplyFrozen(child);
  }
}

describe('explicit organization pack resolution', () => {
  it('refuses unknown identifiers, display names and omitted pack selection without inference', () => {
    for (const packId of ['missing', 'Crosscurrent joint coordination', 'Crosscurrent coordination desk', 'constructor', '__proto__', '']) {
      expectResolutionError({ ...selection, packId }, 'unknown-pack');
    }
    const onlyOrganization = { version: '1.0.0', role: 'commander', organization: 'Crosscurrent coordination desk' };
    expectResolutionError(onlyOrganization as unknown as OrganizationPackSelection, 'unknown-pack');
  });

  it('requires an exact retained version and never falls back to a default or latest', () => {
    for (const version of ['1.0.1', '2.0.0', 'latest', '^1.0.0', '1', ' 1.0.0', '']) {
      expectResolutionError({ ...selection, version }, 'unknown-version');
    }
    expectResolutionError({ packId: selection.packId, role: 'commander' } as OrganizationPackSelection, 'unknown-version');
    expect(resolveOrganizationPack(selection).version).toBe('1.0.0');
  });

  it('refuses policy roles and prototype property names as presentation roles', () => {
    for (const role of ['owner', 'admin', 'viewer', 'Commander', '__proto__', 'constructor', '', undefined]) {
      expectResolutionError({ ...selection, role } as OrganizationPackSelection, 'unknown-role');
    }
  });

  it('uses only explicit selection and does not mutate or propagate caller authority', () => {
    const input = Object.freeze({ ...selection, role: 'intelligence' as const,
      organization: 'Island network coordination desk', can_edit: true, can_run_agents: true,
      permissions: ['admin'], workroom: 'untrusted-room' });
    const result = resolveOrganizationPack(input);
    expect(result.packId).toBe(selection.packId);
    expect(result.roleView.role).toBe('intelligence');
    expect(result.authority).toBe('presentation-only');
    for (const key of ['permissions', 'can_edit', 'can_run_agents', 'workroom', 'organization', 'roleViews']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(input.permissions).toEqual(['admin']);
    expect(resolveOrganizationPack(selection).roleView.role).toBe('commander');
  });
});

describe('role-specific context without authority', () => {
  it('provides different report work and task selections for all three roles', () => {
    const [commander, intelligence, instructor] = roles.map(role => resolveOrganizationPack({ ...selection, role }));
    const fieldIds = (view: typeof commander) => view.roleView.report.fields.map(field => field.id);
    expect(fieldIds(commander)).toContain('commitment');
    expect(fieldIds(intelligence)).toContain('currency');
    expect(fieldIds(intelligence)).not.toContain('commitment');
    expect(fieldIds(instructor)).toContain('timing-assistance');
    expect(fieldIds(commander)).not.toContain('timing-assistance');
    expect(intelligence.tasks.some(task => task.id === 'decision-note')).toBe(false);
    expect(commander.tasks.some(task => task.id === 'decision-note')).toBe(true);
    expect(instructor.tasks.some(task => task.id === 'evidence-review')).toBe(true);
    expect(intelligence.tasks.some(task => task.id === 'evidence-review')).toBe(false);
    for (const view of [commander, intelligence, instructor]) {
      expect(view.authority).toBe('presentation-only');
      expect(view.tasks.every(task => task.roles.includes(view.roleView.role))).toBe(true);
      expect(fieldIds(view)).toEqual(expect.arrayContaining(['observed-tick', 'evidence']));
      expect(view.roleView.learningPrompts.length).toBeGreaterThan(0);
      // Nested narrative data must not acquire executable grants or native policy fields.
      const check = (value: unknown) => {
        if (value !== null && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            expect(['permissions', 'capabilities', 'can_edit', 'can_run_agents', 'may_order', 'toolAllowlist', 'delegation']).not.toContain(key);
            check(child);
          }
        }
      };
      check(view);
    }
  });

  it('offers substantive optional network context only when explicitly selected', () => {
    const generic = resolveOrganizationPack(selection);
    const network = resolveOrganizationPack({ ...selection, packId: 'crosscurrent-island-network' });
    expect(network.glossary.some(term => term.id === 'station')).toBe(true);
    expect(generic.glossary.some(term => term.id === 'station')).toBe(false);
    expect(network.tasks.some(task => task.id === 'station-review')).toBe(true);
    expect(generic.tasks.some(task => task.id === 'station-review')).toBe(false);
    expect(network.roleView.report.fields.some(field => field.id === 'station-continuity')).toBe(true);
    expect(network.scenarioIds.every(id => SCENARIOS.some(scenario => scenario.id === id && scenario.victory === 'network-score/1'))).toBe(true);
  });
});

describe('retained immutable content and verified references', () => {
  it('protects nested registry and resolved data and preserves exact lookup across other resolutions', () => {
    const before = JSON.stringify(ORGANIZATION_PACK_CATALOG);
    const result = resolveOrganizationPack(selection);
    assertDeeplyFrozen(ORGANIZATION_PACK_CATALOG);
    assertDeeplyFrozen(result);
    expect(Reflect.set(result.roleView.report.fields[0], 'label', 'Changed')).toBe(false);
    expect(Reflect.set(result.tasks[0].roles, '0', 'instructor')).toBe(false);
    expect(Reflect.set(ORGANIZATION_PACK_CATALOG[0], 'version', '2.0.0')).toBe(false);
    expect(Reflect.deleteProperty(result.curriculumReferences[0], 'objectiveId')).toBe(false);
    expect(Reflect.set(ORGANIZATION_PACK_CATALOG, '0', {})).toBe(false);
    const editableCopy = structuredClone(result);
    Reflect.set(editableCopy.glossary[0], 'definition', 'Local annotation');
    for (const pack of ORGANIZATION_PACK_CATALOG) {
      for (const role of roles) resolveOrganizationPack({ packId: pack.packId, version: pack.version, role });
    }
    expect(resolveOrganizationPack(selection)).toEqual(result);
    expect(JSON.stringify(ORGANIZATION_PACK_CATALOG)).toBe(before);
  });

  it('keeps relationships, roles, tasks and concepts internally usable without dangling references', () => {
    const keys = ORGANIZATION_PACK_CATALOG.map(pack => `${pack.packId}@${pack.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const pack of ORGANIZATION_PACK_CATALOG) {
      const organizationIds = pack.organizations.map(org => org.id);
      const conceptIds = pack.concepts.map(concept => concept.id);
      for (const entries of [pack.organizations, pack.glossary, pack.concepts, pack.tasks, pack.curriculumReferences]) {
        expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
      }
      for (const relation of pack.relationships) {
        expect(organizationIds).toContain(relation.fromOrganizationId);
        expect(organizationIds).toContain(relation.toOrganizationId);
      }
      for (const role of roles) {
        expect(pack.roleViews[role].role).toBe(role);
        expect(organizationIds).toContain(pack.roleViews[role].organizationId);
        const fields = pack.roleViews[role].report.fields;
        expect(new Set(fields.map(field => field.id)).size).toBe(fields.length);
      }
      for (const task of pack.tasks) {
        expect(task.roles.length).toBeGreaterThan(0);
        for (const id of task.conceptIds) expect(conceptIds).toContain(id);
      }
      for (const id of pack.scenarioIds) expect(SCENARIOS.some(scenario => scenario.id === id)).toBe(true);
    }
  });

  it('pins only existing provisional curriculum objectives and their actual criterion mappings', () => {
    for (const pack of ORGANIZATION_PACK_CATALOG) {
      expect(pack.provenance.kind).toBe('synthetic');
      expect(pack.provenance.status).toBe('provisional-unreviewed');
      expect(pack.provenance.engineCommit).toBe(curriculum.exercise.engine.upstream_commit);
      const referenceIds = pack.curriculumReferences.map(reference => reference.id);
      for (const item of [...pack.concepts, ...roles.flatMap(role => pack.roleViews[role].learningPrompts)]) {
        for (const id of item.curriculumReferenceIds) expect(referenceIds).toContain(id);
      }
      for (const reference of pack.curriculumReferences) {
        expect(reference.curriculumId).toBe(curriculum.curriculum_id);
        expect(reference.version).toBe(curriculum.version);
        expect(reference.contentRevision).toBe(curriculum.content_revision);
        expect(reference.status).toBe(curriculum.status);
        const objective = curriculum.objectives.find(item => item.id === reference.objectiveId);
        expect(objective).toBeDefined();
        expect(reference.criterionId).toBe(objective!.rubric_criterion);
        if (reference.criterionId !== null) {
          expect(curriculum.rubric.criteria.some(criterion => criterion.id === reference.criterionId && criterion.objective === reference.objectiveId)).toBe(true);
        }
      }
    }
  });
});
