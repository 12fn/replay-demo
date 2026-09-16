import { describe, expect, it } from 'vitest';
import { EVIDENCE_PACKET, type EvidencePacket, type EvidenceReport } from '../../src/scenarios/evidence-packet';
import {
  materializeEvidenceReport,
  projectEvidenceRecords,
  type PacketRecord,
} from '../../src/scenarios/evidence-records';

const packet: EvidencePacket = {
  ...EVIDENCE_PACKET, id: 'packet/1',
  sources: [{ ...EVIDENCE_PACKET.sources[0], id: 'source-a', name: 'Fictional survey desk' }],
};

const report: EvidenceReport = {
  ...EVIDENCE_PACKET.reports[0], id: 'r2',
  side: 'blue',
  sourceId: 'source-a',
  observedTick: 7,
  releaseTick: 10,
  title: 'Correction',
  body: 'A fictional correction.',
  sourceRelationship: 'independent',
  claim: { ...EVIDENCE_PACKET.reports[0].claim, entityId: 'entity-a' },
  links: [
    { kind: 'supersedes', reportId: 'r1' },
    { kind: 'disputes', reportId: 'r3' },
  ],
};

const metadata = (
  reportId: string,
  links: PacketRecord['packet']['links'] = [],
  lineageRootId = reportId,
): PacketRecord['packet'] => ({
  id: 'packet/1',
  reportId,
  sourceId: 'source-a',
  entityId: 'entity-a',
  observedTick: 0,
  releaseTick: 0,
  sourceRelationship: lineageRootId === reportId ? 'independent' : 'derivative',
  links,
  lineageRootId,
  claimStatus: 'fictional-scenario-claim',
  authoritativeState: false,
});

const record = (
  id: string,
  links: PacketRecord['packet']['links'] = [],
  lineageRootId = id,
  supersedes?: string,
) => ({ id, ...(supersedes ? { supersedes } : {}), packet: metadata(id, links, lineageRootId) });

const byId = <T extends { id: string }>(records: readonly T[], id: string) => records.find(value => value.id === id)!;

describe('materializeEvidenceReport', () => {
  it('maps every report link and the top-level supersession to runtime IDs', () => {
    const result = materializeEvidenceReport(packet, report, id => `runtime:${id}`);

    expect(result).toMatchObject({
      id: 'runtime:r2',
      tick: 10,
      side: 'blue',
      source: 'Fictional survey desk',
      confidence: 'Fictional scenario claim; unverified.',
      synthetic: true,
      supersedes: 'runtime:r1',
      packet: {
        id: 'packet/1',
        reportId: 'r2',
        entityId: 'entity-a',
        observedTick: 7,
        releaseTick: 10,
        lineageRootId: 'runtime:r2',
        links: [
          { kind: 'supersedes', reportId: 'runtime:r1' },
          { kind: 'disputes', reportId: 'runtime:r3' },
        ],
        claimStatus: 'fictional-scenario-claim',
        authoritativeState: false,
      },
    });
    expect(result).not.toHaveProperty('observedTroops');
    expect(result).not.toHaveProperty('observedTiles');
    expect(result.packet).not.toHaveProperty('packet');
    expect(result.packet).not.toHaveProperty('claim');
    expect(result.packet).not.toHaveProperty('sources');
  });

  it('uses the direct derived-from target as the runtime lineage root', () => {
    const derivative: EvidenceReport = {
      ...report,
      id: 'repeat',
      sourceRelationship: 'derivative',
      links: [{ kind: 'derived-from', reportId: 'origin' }],
    };

    const result = materializeEvidenceReport(packet, derivative, id => `branch-b:${id}`);

    expect(result.id).toBe('branch-b:repeat');
    expect(result.packet.lineageRootId).toBe('branch-b:origin');
    expect(result.packet.links).toEqual([{ kind: 'derived-from', reportId: 'branch-b:origin' }]);
  });
});

describe('projectEvidenceRecords', () => {
  it('changes an earlier report only after its correction is supplied', () => {
    const earlier = record('earlier');
    const correction = record('correction', [{ kind: 'supersedes', reportId: 'earlier' }], 'correction', 'earlier');

    expect(projectEvidenceRecords([earlier])).toEqual([{ ...earlier, evidenceStatus: 'current' }]);
    const after = projectEvidenceRecords([earlier, correction]);
    expect(byId(after, 'earlier')).toMatchObject({ evidenceStatus: 'superseded', supersededBy: 'correction' });
    expect(byId(after, 'correction')).toMatchObject({ evidenceStatus: 'current' });
  });

  it('shares lineage status with duplicate reports without treating them as corroboration', () => {
    const origin = record('origin');
    const repeat = record('repeat', [{ kind: 'derived-from', reportId: 'origin' }], 'origin');
    const contrary = record('contrary', [{ kind: 'disputes', reportId: 'origin' }]);
    const projected = projectEvidenceRecords([origin, repeat, contrary]);

    expect(byId(projected, 'origin')).toMatchObject({ evidenceStatus: 'disputed', disputedWith: ['contrary'] });
    expect(byId(projected, 'repeat')).toMatchObject({ evidenceStatus: 'disputed', disputedWith: ['contrary'] });
    expect(byId(projected, 'contrary')).toMatchObject({ evidenceStatus: 'disputed', disputedWith: ['origin'] });
  });

  it('creates the reverse dispute edge when only one endpoint declares it', () => {
    const left = record('left');
    const right = record('right', [{ kind: 'disputes', reportId: 'left' }]);
    const projected = projectEvidenceRecords([left, right]);

    expect(byId(projected, 'left').disputedWith).toEqual(['right']);
    expect(byId(projected, 'right').disputedWith).toEqual(['left']);
  });

  it('ends stale disputes after supersession unless the correction redeclares one', () => {
    const old = record('old');
    const repeat = record('repeat', [{ kind: 'derived-from', reportId: 'old' }], 'old');
    const contrary = record('contrary', [{ kind: 'disputes', reportId: 'old' }]);
    const correction = record('correction', [{ kind: 'supersedes', reportId: 'old' }], 'correction', 'old');
    const ended = projectEvidenceRecords([old, repeat, contrary, correction]);

    expect(byId(ended, 'old')).toMatchObject({ evidenceStatus: 'superseded', supersededBy: 'correction' });
    expect(byId(ended, 'repeat')).toMatchObject({ evidenceStatus: 'superseded', supersededBy: 'correction' });
    expect(byId(ended, 'contrary')).toEqual({ ...contrary, evidenceStatus: 'current' });
    expect(byId(ended, 'correction')).toEqual({ ...correction, evidenceStatus: 'current' });

    const redeclared = record('redeclared', [
      { kind: 'supersedes', reportId: 'old' },
      { kind: 'disputes', reportId: 'contrary' },
    ], 'redeclared', 'old');
    const continued = projectEvidenceRecords([old, contrary, redeclared]);
    expect(byId(continued, 'contrary')).toMatchObject({ evidenceStatus: 'disputed', disputedWith: ['redeclared'] });
    expect(byId(continued, 'redeclared')).toMatchObject({ evidenceStatus: 'disputed', disputedWith: ['contrary'] });
  });

  it('does not mutate its input and leaves generic reports unchanged except for copying', () => {
    const packetRecord = Object.freeze(record('packet-report'));
    const generic = Object.freeze({ id: 'generic', title: 'Ordinary report' });
    const input = Object.freeze([packetRecord, generic] as const);
    const projected = projectEvidenceRecords(input);

    expect(projected[0]).not.toBe(packetRecord);
    expect(projected[1]).not.toBe(generic);
    expect(projected[1]).toEqual(generic);
    expect(packetRecord).not.toHaveProperty('evidenceStatus');
    expect(generic).not.toHaveProperty('evidenceStatus');
  });

  it('ignores filtered-out link targets without exposing computed references to them', () => {
    const visible = record('visible', [
      { kind: 'supersedes', reportId: 'filtered-old' },
      { kind: 'disputes', reportId: 'filtered-contrary' },
      { kind: 'derived-from', reportId: 'filtered-origin' },
    ], 'filtered-origin', 'filtered-old');
    const projected = projectEvidenceRecords([visible]);

    expect(projected).toEqual([{ ...visible, evidenceStatus: 'current' }]);
    expect(projected[0]).not.toHaveProperty('supersededBy');
    expect(projected[0]).not.toHaveProperty('disputedWith');
  });

  it('rejects duplicate runtime record IDs', () => {
    expect(() => projectEvidenceRecords([record('same'), record('same')])).toThrow('Duplicate evidence record ID: same');
  });

  it('keeps branch-remapped IDs isolated', () => {
    const originReport = { ...report, id: 'origin', links: [] } as unknown as EvidenceReport;
    const correctionReport: EvidenceReport = {
      ...report,
      id: 'correction',
      links: [{ kind: 'supersedes', reportId: 'origin' }],
    };
    const origin = materializeEvidenceReport(packet, originReport, id => `branch-2:${id}`);
    const correction = materializeEvidenceReport(packet, correctionReport, id => `branch-2:${id}`);
    const projected = projectEvidenceRecords([origin, correction]);

    expect(byId(projected, 'branch-2:origin')).toMatchObject({
      evidenceStatus: 'superseded',
      supersededBy: 'branch-2:correction',
    });
    expect(correction.packet.links).toEqual([{ kind: 'supersedes', reportId: 'branch-2:origin' }]);
  });
});
