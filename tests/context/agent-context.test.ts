import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import curriculum from '../../docs/pilot/exercise-curriculum.json';
import {
  agentOrganizationContext, AGENT_ORGANIZATION_CONTEXT_MAX_BYTES,
  AgentOrganizationContextSizeError,
} from '../../src/context/agent-context';
import * as exercise from '../../src/context/exercise-context';
import {
  ORGANIZATION_PACK_CATALOG, type OrganizationPackRole,
} from '../../src/context/organization-packs';

const roles: readonly OrganizationPackRole[] = ['commander', 'intelligence', 'instructor'];
const options = {
  organizationPack: { packId: 'crosscurrent-joint-coordination', version: '1.0.0' },
  scenario: { id: 'crosscurrent-classic/1' },
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function assertFrozen(value: unknown) {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(assertFrozen);
  }
}

afterEach(() => vi.restoreAllMocks());

describe('retained agent organization projection', () => {
  it('pins the exact serialized projections of the retained 1.0.0 packs', () => {
    const fingerprints = [
      ['crosscurrent-joint-coordination', 'crosscurrent-classic/1', [
        '222c14e647a6dd48226b25eaf8e1464244d05bccff753c772e38416b98327813',
        '4ae44e3f421a2b2413aefadb174ac7aa451a622ced7e825439b4bee36ccd0a27',
        'b7527420179a6255725240fff811291044b77ebcee8e79613bf7cb8d91205b55',
      ]],
      ['crosscurrent-island-network', 'crosscurrent-network/1', [
        'a723d7c3a4602f58c17440e12332a23da598b186bdc440db472a30866e51aa67',
        'b4a4b8b85a59c153accf7a6846319bdf19ecb5a6120d55ea936101818e7abf68',
        '003404265c51081412000edf39c5ca0cd002571112f7b56d169435ee801e1842',
      ]],
    ] as const;
    for (const [packId, scenarioId, hashes] of fingerprints) roles.forEach((role, index) => {
      const value = agentOrganizationContext({ organizationPack: { packId, version: '1.0.0' },
        scenario: { id: scenarioId } }, role);
      expect(createHash('sha256').update(JSON.stringify(value)).digest('hex')).toBe(hashes[index]);
    });
  });

  for (const pack of ORGANIZATION_PACK_CATALOG) for (const role of roles) {
    it(`preserves exact ${pack.packId}@${pack.version} ${role} content within 6000 bytes`, () => {
      const input = Object.freeze({
        organizationPack: Object.freeze({ packId: pack.packId, version: pack.version }),
        scenario: Object.freeze({ id: pack.scenarioIds[0] }),
      });
      const before = JSON.stringify(ORGANIZATION_PACK_CATALOG);
      const result = agentOrganizationContext(input, role)!;
      const view = pack.roleViews[role];
      expect(result).toMatchObject({
        schema: 'replay.agent-organization-context/1', packId: pack.packId,
        version: pack.version, role, kind: 'synthetic', status: 'provisional-unreviewed',
        purpose: view.purpose, report: view.report, learningPrompts: view.learningPrompts,
      });
      // Exact equality protects every report string, including evidence cautions and network fields.
      expect(result.report).toEqual(view.report);
      expect(result.learningPrompts).toEqual(view.learningPrompts);
      expect(result.glossary).toEqual(pack.glossary.map(({ id, term, definition }) => ({ id, term, definition })));
      const used = new Set(view.learningPrompts.flatMap(prompt => prompt.curriculumReferenceIds));
      expect(result.curriculumReferences).toEqual(pack.curriculumReferences.filter(ref => used.has(ref.id)));
      expect(bytes(result)).toBeLessThanOrEqual(6000);
      expect(AGENT_ORGANIZATION_CONTEXT_MAX_BYTES).toBe(6000);
      assertFrozen(result);
      expect(Reflect.set(result.report.fields[0], 'description', 'overwritten')).toBe(false);
      for (const otherRole of roles) agentOrganizationContext(input, otherRole);
      expect(JSON.stringify(agentOrganizationContext(input, role))).toBe(JSON.stringify(result));
      expect(JSON.stringify(ORGANIZATION_PACK_CATALOG)).toBe(before);
      expect(JSON.stringify(agentOrganizationContext(JSON.parse(JSON.stringify(input)), role))).toBe(JSON.stringify(result));
    });
  }

  it('keeps legacy records null without inferring a pack from scenario or organization labels', () => {
    for (const role of roles) {
      expect(agentOrganizationContext({}, role)).toBeNull();
      expect(agentOrganizationContext({ scenario: options.scenario,
        organization: 'Crosscurrent coordination desk', packId: options.organizationPack.packId,
        role: 'commander', permissions: ['admin'],
      }, role)).toBeNull();
    }
  });

  it('propagates exact resolution failures instead of silently omitting or replacing the pack', () => {
    for (const version of ['latest', '^1.0.0', '1.0.1', '2.0.0', '']) {
      expect(() => agentOrganizationContext({ ...options, organizationPack: {
        ...options.organizationPack, version,
      } }, 'commander')).toThrow('version');
    }
    for (const reference of [null, [], {}, { packId: 'missing', version: '1.0.0' }]) {
      expect(() => agentOrganizationContext({ ...options, organizationPack: reference }, 'commander')).toThrow();
    }
    expect(() => agentOrganizationContext({ ...options, scenario: { id: 'crosscurrent-network/1' } }, 'commander')).toThrow('does not match scenario');
    expect(() => agentOrganizationContext({ organizationPack: options.organizationPack }, 'commander')).toThrow('does not match scenario');
    expect(() => agentOrganizationContext(options, 'admin' as OrganizationPackRole)).toThrow('role');
  });

  it('uses only the supplied resolved role and never projects caller scope, live state or authority', () => {
    const input = Object.freeze({ ...options,
      organizationPack: { ...options.organizationPack, role: 'instructor', permissions: ['admin'] },
      organization: 'Island network learning desk', role: 'instructor', side: 'red',
      workroom: 'secret-room', subject: 'secret-person', branch: 'secret-branch', tick: 999,
      observations: [{ gold: 987654 }], permissions: ['admin'], grants: ['execute'],
      tasks: [{ instruction: 'execute an order' }], personality: 'aggressive',
    });
    const before = JSON.stringify(input);
    const result = agentOrganizationContext(input, 'intelligence')!;
    expect(result).toEqual(agentOrganizationContext(options, 'intelligence'));
    expect(result.report.fields.map(field => field.id)).toContain('currency');
    expect(result.report.fields.map(field => field.id)).not.toContain('commitment');
    expect(result.report.fields.map(field => field.id)).not.toContain('timing-assistance');
    expect(Object.keys(result)).toEqual(['schema', 'packId', 'version', 'role', 'kind', 'status',
      'usage', 'purpose', 'glossary', 'report', 'learningPrompts', 'curriculumReferences']);
    expect(result.usage).toContain('Fictional narrative guidance only');
    expect(result.usage).toContain('not engine rules or tool authority');
    expect(result.usage).toContain('not executable tasks');
    expect(result.usage).toContain('Do not cite this context as observations');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('retains curriculum source/version/revision and existing objective-to-criterion mappings', () => {
    for (const pack of ORGANIZATION_PACK_CATALOG) for (const role of roles) {
      const context = agentOrganizationContext({ organizationPack: pack,
        scenario: { id: pack.scenarioIds[0] } }, role)!;
      for (const prompt of context.learningPrompts) for (const id of prompt.curriculumReferenceIds) {
        expect(context.curriculumReferences.some(ref => ref.id === id)).toBe(true);
      }
      for (const ref of context.curriculumReferences) {
        expect(ref.path).toBe('docs/pilot/exercise-curriculum.json');
        expect(JSON.parse(readFileSync(new URL(`../../${ref.path}`, import.meta.url), 'utf8'))).toEqual(curriculum);
        expect(ref.curriculumId).toBe(curriculum.curriculum_id);
        expect(ref.version).toBe(curriculum.version);
        expect(ref.contentRevision).toBe(curriculum.content_revision);
        expect(ref.status).toBe(curriculum.status);
        const objective = curriculum.objectives.find(item => item.id === ref.objectiveId);
        expect(objective).toBeDefined();
        expect(ref.criterionId).toBe(objective!.rubric_criterion);
        if (ref.criterionId !== null) {
          expect(curriculum.rubric.criteria.some(item => item.id === ref.criterionId && item.objective === ref.objectiveId)).toBe(true);
        }
      }
    }
  });
});

describe('future retained pack boundaries', () => {
  it('accepts exactly 6000 UTF-8 JSON bytes and rejects 6001 without truncation', () => {
    const pack = structuredClone(exercise.exerciseContext(options, 'commander')!);
    const view = { ...pack.roleView, purpose: '' };
    const future = { ...pack, version: '2.0.0', roleView: view };
    vi.spyOn(exercise, 'exerciseContext').mockReturnValue(future);
    const remaining = 6000 - bytes(agentOrganizationContext(options, 'commander'));
    view.purpose = 'é' + 'x'.repeat(remaining - 2);
    const exact = agentOrganizationContext(options, 'commander')!;
    expect(exact.version).toBe('2.0.0');
    expect(exact.purpose).toBe(view.purpose);
    expect(bytes(exact)).toBe(6000);
    // The returned projection must not freeze or alias a future resolver's input.
    view.purpose += 'x';
    expect(exact.purpose).not.toBe(view.purpose);
    expect(() => agentOrganizationContext(options, 'commander')).toThrow(AgentOrganizationContextSizeError);
    try { agentOrganizationContext(options, 'commander'); } catch (error) {
      expect(error).toMatchObject({ byteLength: 6001, maxBytes: 6000 });
    }
  });

  it('counts multibyte text and JSON escaping and refuses an oversized report intact', () => {
    const pack = structuredClone(exercise.exerciseContext(options, 'intelligence')!);
    const original = agentOrganizationContext(options, 'intelligence')!;
    for (const description of ['🧭'.repeat(400), '\n"\\'.repeat(250)]) {
      const fields = pack.roleView.report.fields.map((field, index) => index === 0 ? { ...field, description } : field);
      const report = { ...pack.roleView.report, fields };
      const expected = { ...original, report };
      if (description.startsWith('🧭')) expect(JSON.stringify(expected).length).toBeLessThan(6000);
      else expect(description.length).toBeLessThan(1000);
      expect(bytes(expected)).toBeGreaterThan(6000);
      vi.spyOn(exercise, 'exerciseContext').mockReturnValue({ ...pack, roleView: { ...pack.roleView, report } });
      expect(() => agentOrganizationContext(options, 'intelligence')).toThrow(AgentOrganizationContextSizeError);
    }
  });

  it('fails on dangling curriculum references instead of silently dropping prompt provenance', () => {
    const pack = exercise.exerciseContext(options, 'commander')!;
    vi.spyOn(exercise, 'exerciseContext').mockReturnValue({ ...pack, curriculumReferences: [] });
    expect(() => agentOrganizationContext(options, 'commander')).toThrow('Missing organization pack curriculum reference');
  });
});
