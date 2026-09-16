import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORK_RULES } from '../../src/campaign/network';
import { agentOrganizationContext, AGENT_ORGANIZATION_CONTEXT_MAX_BYTES } from '../../src/context/agent-context';
import { exerciseContext, formatRolePracticeTemplate, newExerciseContext } from '../../src/context/exercise-context';
import {
  ORGANIZATION_PACK_CATALOG, resolveOrganizationPack, type OrganizationPackRole,
} from '../../src/context/organization-packs';
import { EVIDENCE_PACKET } from '../../src/scenarios/evidence-packet';
import { selectScenario } from '../../src/scenarios/catalog';
import { GameService } from '../../src/server/service';

const roles: readonly OrganizationPackRole[] = ['commander', 'intelligence', 'instructor'];
const packId = 'crosscurrent-changing-evidence';
const scenarioId = 'crosscurrent-evidence/1';
const options = { organizationPack: { packId, version: '1.0.0' }, scenario: { id: scenarioId } };
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const resolve = (role: OrganizationPackRole) => resolveOrganizationPack({ packId, version: '1.0.0', role });
const fieldIds = (role: OrganizationPackRole) => resolve(role).roleView.report.fields.map(field => field.id);
const reportPlaceNames = EVIDENCE_PACKET.entities.map(entity => entity.name.replace(' Station', ''));
const mapStationNames: readonly string[] = NETWORK_RULES.stations.map(station => station.name);

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-evidence-role-pack-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new GameService(dir);
  cleanup.push(() => s.close());
  s.baseline = () => {};
  return s;
}

describe('crosscurrent-changing-evidence@1.0.0 role views', () => {
  it('gives each current seat different, source-focused report work using the packet monitoring focus', () => {
    const [commander, intelligence, instructor] = roles.map(resolve);
    for (const view of [commander, intelligence, instructor]) {
      expect(view.roleView.purpose).toBe(EVIDENCE_PACKET.monitoringFocus[view.roleView.role]);
      expect(view.authority).toBe('presentation-only');
      expect(fieldIds(view.roleView.role).slice(0, 2)).toEqual(['observed-tick', 'evidence']);
      expect(view.tasks.every(task => task.roles.includes(view.roleView.role))).toBe(true);
      expect(view.tasks.some(task => task.id === 'lineage-review')).toBe(true);
    }
    expect(new Set([commander, intelligence, instructor].map(view => view.roleView.report.id)).size).toBe(3);

    expect(fieldIds('commander')).toEqual(['observed-tick', 'evidence', 'objective', 'resources', 'open-questions', 'commitment', 'continuity']);
    expect(fieldIds('intelligence')).toEqual(['observed-tick', 'evidence', 'claims', 'lineage', 'currency', 'report-versus-map', 'uncertainty', 'follow-up']);
    expect(fieldIds('instructor')).toEqual(['observed-tick', 'evidence', 'versions', 'release-timing', 'learning-evidence', 'timing-assistance', 'review-status']);

    // Role-appropriate separation: only the commander writes commitment rationale; only the analyst writes lineage.
    expect(commander.tasks.some(task => task.id === 'decision-note')).toBe(true);
    expect(intelligence.tasks.some(task => task.id === 'source-assessment')).toBe(true);
    expect(instructor.tasks.some(task => task.id === 'evidence-review')).toBe(true);
    expect(instructor.tasks.some(task => task.id === 'decision-note')).toBe(false);
    expect(commander.roleView.learningPrompts.map(p => p.id)).toEqual(['open-question', 'plan-response']);
    expect(intelligence.roleView.learningPrompts.map(p => p.id)).toEqual(['lineage-count', 'unknown-response']);
    expect(instructor.roleView.learningPrompts.map(p => p.id)).toEqual(['release-review', 'repeat-review']);
    expect(instructor.roleView.learningPrompts.every(p => p.prompt.endsWith('?'))).toBe(true);
  });

  it('reuses retained joint report fields and prompts byte-for-byte instead of paraphrasing them', () => {
    const joint = (role: OrganizationPackRole) => resolveOrganizationPack({ packId: 'crosscurrent-joint-coordination', version: '1.0.0', role }).roleView;
    for (const role of roles) {
      const view = resolve(role).roleView;
      const retained = joint(role);
      const reused = view.report.fields.filter(f => retained.report.fields.some(r => r.id === f.id));
      expect(reused.length).toBeGreaterThanOrEqual(4);
      for (const f of reused) expect(f).toEqual(retained.report.fields.find(r => r.id === f.id));
      for (const p of view.learningPrompts.filter(p => retained.learningPrompts.some(r => r.id === p.id))) {
        expect(p).toEqual(retained.learningPrompts.find(r => r.id === p.id));
      }
      expect(view.title).toBe(retained.title);
      expect(view.organizationId).toBe(retained.organizationId);
    }
    const pack = ORGANIZATION_PACK_CATALOG.find(p => p.packId === packId)!;
    expect(pack.curriculumReferences).toEqual(ORGANIZATION_PACK_CATALOG[0].curriculumReferences);
    for (const id of ['reserves', 'currency', 'evidence']) {
      expect(pack.glossary.find(t => t.id === id)).toEqual(ORGANIZATION_PACK_CATALOG[0].glossary.find(t => t.id === id));
    }
    expect(pack.glossary.find(t => t.id === 'station')).toEqual(ORGANIZATION_PACK_CATALOG[1].glossary.find(t => t.id === 'station'));
  });
});

describe('exercise binding', () => {
  it('stores the exact reference on a new evidence exercise and resolves the current session seat only', async () => {
    expect(newExerciseContext(scenarioId)).toEqual({ packId, version: '1.0.0' });
    expect(Object.isFrozen(newExerciseContext(scenarioId))).toBe(true);
    // Existing mappings are unchanged.
    expect(newExerciseContext('crosscurrent-classic/1')?.packId).toBe('crosscurrent-joint-coordination');
    expect(newExerciseContext('crosscurrent-network/1')?.packId).toBe('crosscurrent-island-network');
    expect(newExerciseContext('crosscurrent-objectives/1')?.packId).toBe('crosscurrent-island-network');
    expect(newExerciseContext('crosscurrent-evidence/2')).toBeNull();

    const s = service();
    const row = await s.create('Evidence role pack', 'world', s.defaultSession().identity, scenarioId);
    expect(row.options.organizationPack).toEqual({ packId, version: '1.0.0' });
    const session = { ...s.defaultSession(), activeId: row.id };
    for (const role of roles) {
      const seat = { ...session, identity: { ...session.identity, role } };
      const ov = await s.overview(seat);
      expect(ov.organizationContext?.packId).toBe(packId);
      expect(ov.organizationContext?.roleView.role).toBe(role);
      // The pack repeats the source desk focus the session already receives for this seat.
      expect(ov.organizationContext?.roleView.purpose).toBe(ov.sourceDesk?.focus);
    }
    const template = formatRolePracticeTemplate(exerciseContext(row.options, 'intelligence')!);
    expect(template).toContain(`${packId}@1.0.0`);
    expect(template).toContain('Current seat: Evidence analyst. This describes your current view, not a claim about your historical role.');
    expect(s.ledger.summary().requestsUsed).toBe(0);
  });

  it('keeps a retained evidence exercise without organizationPack missing, without backfill', async () => {
    const retained = { scenario: selectScenario(scenarioId), evidencePacketId: EVIDENCE_PACKET.id };
    for (const role of roles) {
      expect(exerciseContext(retained, role)).toBeNull();
      expect(agentOrganizationContext(retained, role)).toBeNull();
    }
    const s = service();
    const row = await s.create('Retained evidence', 'world', s.defaultSession().identity, scenarioId);
    delete row.options.organizationPack;
    s.store.putExercise(row);
    const before = JSON.stringify(s.record(row.id));
    expect((await s.overview({ ...s.defaultSession(), activeId: row.id })).organizationContext).toBeNull();
    expect(JSON.stringify(s.record(row.id))).toBe(before);
  });

  it('refuses mismatched scenarios and inexact versions instead of substituting a pack', () => {
    for (const id of ['crosscurrent-classic/1', 'crosscurrent-network/1', 'crosscurrent-objectives/1']) {
      expect(() => exerciseContext({ ...options, scenario: { id } }, 'commander')).toThrow('does not match scenario');
    }
    for (const other of ['crosscurrent-joint-coordination', 'crosscurrent-island-network']) {
      expect(() => exerciseContext({ ...options, organizationPack: { packId: other, version: '1.0.0' } }, 'commander')).toThrow('does not match scenario');
    }
    for (const version of ['latest', '1.0.1', '2.0.0', '']) {
      expect(() => exerciseContext({ ...options, organizationPack: { packId, version } }, 'intelligence')).toThrow('version');
    }
    expect(() => exerciseContext(options, 'owner' as OrganizationPackRole)).toThrow('role');
  });
});

describe('retained catalog immutability', () => {
  it('leaves existing pack bytes and order unchanged and freezes the appended version', () => {
    // Hashes captured from the catalog before this pack was appended.
    expect(ORGANIZATION_PACK_CATALOG.map(p => `${p.packId}@${p.version}`)).toEqual([
      'crosscurrent-joint-coordination@1.0.0', 'crosscurrent-island-network@1.0.0', `${packId}@1.0.0`,
    ]);
    expect(sha256(ORGANIZATION_PACK_CATALOG[0])).toBe('acc27bfbfaf7c3ccecf1479c971234d798bf694bff68102f31b8e852e6c7d0db');
    expect(sha256(ORGANIZATION_PACK_CATALOG[1])).toBe('c213237ecf55abf881d294b9874ad8888dba776eb2d1ae36f52e6f349851a0ce');
    // Pins this version; any content change requires a new version.
    expect(sha256(ORGANIZATION_PACK_CATALOG[2])).toBe('1009cc4496fda290287c0ac025037cb21cb4daba2d536d5f3a75667ebd364edd');
    const check = (value: unknown) => {
      if (value !== null && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(check); }
    };
    check(ORGANIZATION_PACK_CATALOG[2]);
    expect(Reflect.set(ORGANIZATION_PACK_CATALOG[2].roleViews.intelligence.report.fields[3], 'description', 'x')).toBe(false);
  });
});

describe('honest source terminology', () => {
  const pack = ORGANIZATION_PACK_CATALOG.find(p => p.packId === packId)!;
  const { provenance, ...content } = pack;
  const text = JSON.stringify(content);

  it('distinguishes report place names from map stations without defining a mapping or effect', () => {
    expect(reportPlaceNames).toEqual(['Lantern', 'Marsh', 'Tidewell']);
    expect(mapStationNames).toEqual(['Aster', 'Beacon', 'Cedar', 'Delta', 'Ember']);
    expect(reportPlaceNames.some(name => mapStationNames.includes(name))).toBe(false);
    const caution = pack.glossary.find(t => t.id === 'report-place-names')!.definition;
    for (const name of [...reportPlaceNames, ...mapStationNames]) expect(caution).toContain(name);
    expect(caution).toContain('No mapping or effect between them is defined.');
    for (const role of ['commander', 'intelligence'] as const) {
      expect(pack.roleViews[role].report.fields.some(f => f.evidenceGuidance.endsWith(caution))).toBe(true);
    }
    // No sentence may pair a report place name with a map station outside the caution itself.
    const sentences = text.split(caution).join(' ').split(/[.?!]/);
    for (const sentence of sentences) {
      expect(reportPlaceNames.some(n => sentence.includes(n)) && mapStationNames.some(n => sentence.includes(n))).toBe(false);
    }
    expect(text).not.toMatch(/corresponds to|maps to|located at|same as (Aster|Beacon|Cedar|Delta|Ember)/i);
  });

  it('describes reports as authored, unscored and non-authoritative in packet terms', () => {
    const authored = pack.glossary.find(t => t.id === 'authored-report')!.definition;
    expect(authored).toContain('not measured map or engine state');
    expect(authored).toContain('changes no forces, holdings or permissions');
    const lineage = pack.glossary.find(t => t.id === 'source-lineage')!.definition;
    expect(lineage).toContain('not a separate observation');
    expect(lineage).toContain('unresolved, not false');
    expect(text).not.toMatch(/confidence score|probabilit|reliab|true report|doctrine|enemy|military|intelligence agency|classified/i);
    expect(provenance).toMatchObject({ kind: 'synthetic', status: 'provisional-unreviewed' });
    expect(provenance.scope).toContain('crosscurrent-changing-evidence/1');
    expect(provenance.limitations).toEqual(ORGANIZATION_PACK_CATALOG[0].provenance.limitations);
    expect(pack.authority).toBe('presentation-only');
    expect(text).not.toMatch(/"(permissions|capabilities|can_edit|can_run_agents|may_order|toolAllowlist|delegation)"/);
  });
});

describe('bounded agent projection', () => {
  it('keeps each seat projection useful, exact and within 6000 bytes', () => {
    const measured = roles.map(role => {
      const view = resolve(role).roleView;
      const context = agentOrganizationContext(options, role)!;
      expect(context).toMatchObject({ packId, version: '1.0.0', role, purpose: view.purpose, report: view.report, learningPrompts: view.learningPrompts });
      expect(context.glossary.map(t => t.id)).toEqual(['reserves', 'currency', 'evidence', 'station', 'authored-report', 'source-lineage', 'report-place-names']);
      for (const prompt of context.learningPrompts) for (const id of prompt.curriculumReferenceIds) {
        expect(context.curriculumReferences.some(ref => ref.id === id)).toBe(true);
      }
      // Caller-supplied role labels and authority never change the resolved seat.
      expect(agentOrganizationContext({ ...options, role: 'instructor', permissions: ['admin'] }, role)).toEqual(context);
      expect(bytes(context)).toBeLessThanOrEqual(AGENT_ORGANIZATION_CONTEXT_MAX_BYTES);
      return bytes(context);
    });
    expect(AGENT_ORGANIZATION_CONTEXT_MAX_BYTES).toBe(6000);
    expect(measured).toEqual([5680, 5711, 5527]);
    expect(agentOrganizationContext(options, 'commander')!.report.fields.map(f => f.id)).toContain('open-questions');
    expect(agentOrganizationContext(options, 'intelligence')!.report.fields.map(f => f.id)).toContain('lineage');
  });
});
