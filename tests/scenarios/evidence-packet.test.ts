import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_PACKET, EvidencePacketValidationError, claimLineages, packetReportsAt, reportsAt, validateEvidencePacket,
  type EvidencePacket, type EvidenceReport, type EvidenceReportView,
} from '../../src/scenarios/evidence-packet';

type Draft = { -readonly [K in keyof EvidenceReport]: any };
/** Mutable copy of the packet for negative cases; the exported packet stays frozen. */
function variant(edit: (reports: Draft[], packet: any) => void): EvidencePacket {
  const packet = structuredClone(EVIDENCE_PACKET) as any;
  edit(packet.reports, packet);
  return packet;
}
const byId = (views: readonly EvidenceReportView[]) => new Map(views.map(view => [view.report.id, view]));
const codes = (packet: EvidencePacket) => validateEvidencePacket(packet).map(issue => issue.code);
const cloneReport = (packet: any, id: string, changes: Partial<Draft>): Draft =>
  ({ ...structuredClone(packet.reports.find((r: Draft) => r.id === id)), ...changes });

describe('evidence packet release cutoffs', () => {
  it('releases reports only at or after their release tick', () => {
    expect(packetReportsAt('blue', 299).map(v => v.report.id)).toEqual(['blue-r01']);
    expect(packetReportsAt('blue', 300).map(v => v.report.id)).toEqual(['blue-r01', 'blue-r02', 'blue-r03']);
    for (const tick of [0, 450, 899, 1200, 5000]) {
      for (const view of packetReportsAt('red', tick)) expect(view.report.releaseTick).toBeLessThanOrEqual(tick);
    }
  });

  it('keeps an earlier cutoff showing a report as current after a later correction supersedes it', () => {
    const before = byId(packetReportsAt('blue', 300));
    const after = byId(packetReportsAt('blue', 600));
    expect(before.get('blue-r02')).toMatchObject({ status: 'current', supersededBy: null });
    expect(before.has('blue-r04')).toBe(false);
    expect(after.get('blue-r02')).toMatchObject({ status: 'superseded', supersededBy: 'blue-r04', supersessionBasis: 'direct' });
    expect(after.get('blue-r04')!.status).toBe('current');
    // The superseded record itself is preserved unchanged and remains listed.
    expect(after.get('blue-r02')!.report).toEqual(before.get('blue-r02')!.report);
    // Querying the past again after asking about the future gives the same answer.
    expect(byId(packetReportsAt('blue', 300)).get('blue-r02')!.status).toBe('current');
  });

  it('marks a repeat as stale when the report it repeats is superseded', () => {
    expect(byId(packetReportsAt('red', 900)).get('red-r05')).toMatchObject({ status: 'current', lineageRootId: 'red-r03' });
    expect(byId(packetReportsAt('red', 1200)).get('red-r05'))
      .toMatchObject({ status: 'superseded', supersededBy: 'red-r06', supersessionBasis: 'origin' });
  });

  it('rejects invalid cutoffs rather than guessing', () => {
    expect(() => packetReportsAt('blue', -1)).toThrow();
    expect(() => packetReportsAt('blue', 1.5)).toThrow();
    expect(() => packetReportsAt('green' as any, 0)).toThrow();
  });
});

describe('evidence packet side separation', () => {
  it('never returns or links to the other side’s reports', () => {
    for (const side of ['blue', 'red'] as const) {
      const views = packetReportsAt(side, 10_000);
      const visible = new Set(views.map(v => v.report.id));
      expect(views.length).toBeGreaterThan(0);
      for (const view of views) {
        expect(view.report.side).toBe(side);
        for (const id of [view.supersededBy, view.lineageRootId, ...view.disputedWith]) if (id) expect(visible.has(id)).toBe(true);
      }
    }
  });

  it('keeps each side’s view of the same entity independent', () => {
    const blue = packetReportsAt('blue', 600).filter(v => v.report.claim.entityId === 'entity.marsh-station');
    const red = packetReportsAt('red', 600).filter(v => v.report.claim.entityId === 'entity.marsh-station');
    expect(blue.find(v => v.status === 'current')!.report.claim.value).toMatchObject({ low: 15, high: 25 });
    expect(red.map(v => v.report.id)).toEqual(['red-r03']);
  });

  it('refuses links and sources that cross sides', () => {
    expect(codes(variant(reports => { reports.find(r => r.id === 'red-r04')!.links = [{ kind: 'supersedes', reportId: 'blue-r01' }]; })))
      .toContain('cross-side-link');
    expect(codes(variant(reports => { reports.find(r => r.id === 'red-r03')!.sourceId = 'source.blue.survey'; })))
      .toContain('source-side-mismatch');
  });
});

describe('disputes, derivatives and differently named claims', () => {
  it('keeps both sides of an unresolved contradiction without declaring either false', () => {
    const views = byId(packetReportsAt('blue', 900));
    expect(views.get('blue-r05')).toMatchObject({ status: 'disputed', supersededBy: null, disputedWith: ['blue-r06'] });
    expect(views.get('blue-r06')).toMatchObject({ status: 'disputed', supersededBy: null, disputedWith: ['blue-r05'] });
    // Before the independent report is released there is nothing to dispute.
    expect(byId(packetReportsAt('blue', 600)).get('blue-r05')!.status).toBe('current');
    expect(byId(packetReportsAt('red', 900)).get('red-r01')!.status).toBe('current');
    expect(byId(packetReportsAt('red', 1200)).get('red-r01')).toMatchObject({ status: 'disputed', disputedWith: ['red-r07'] });
  });

  it('does not count a repeated report as independent corroboration', () => {
    const views = packetReportsAt('blue', 900);
    const tidewell = views.filter(v => v.report.claim.entityId === 'entity.tidewell-station');
    const saysUnavailable = tidewell.filter(v => v.report.claim.value.kind === 'station-availability' && v.report.claim.value.availability === 'unavailable');
    expect(saysUnavailable).toHaveLength(2);
    expect(new Set(saysUnavailable.map(v => v.lineageRootId))).toEqual(new Set(['blue-r05']));
    expect(byId(views).get('blue-r07')).toMatchObject({ status: 'disputed', disputedWith: ['blue-r06'] });

    const lineages = claimLineages(views, 'entity.tidewell-station');
    expect(lineages.map(l => [l.lineageRootId, l.reportIds])).toEqual([['blue-r05', ['blue-r05', 'blue-r07']], ['blue-r06', ['blue-r06']]]);
  });

  it('resolves differently named claims to one stable entity', () => {
    const marsh = packetReportsAt('blue', 300).filter(v => v.report.claim.entityId === 'entity.marsh-station');
    expect(new Set(marsh.map(v => v.report.claim.nameAsReported))).toEqual(new Set(['Marsh Station', 'the reed-flat stop']));
    expect(claimLineages(marsh, 'entity.marsh-station')).toHaveLength(1);
  });

  it('lets a dispute lapse only through a declared supersession', () => {
    const packet = variant((reports, p) => reports.push(cloneReport(p, 'blue-r06', {
      id: 'blue-r09', observedTick: 1190, releaseTick: 1200, links: [{ kind: 'supersedes', reportId: 'blue-r06' }],
    })));
    expect(codes(packet)).toEqual([]);
    expect(byId(reportsAt(packet, 'blue', 900)).get('blue-r05')!.status).toBe('disputed');
    const later = byId(reportsAt(packet, 'blue', 1200));
    expect(later.get('blue-r06')).toMatchObject({ status: 'superseded', supersededBy: 'blue-r09' });
    expect(later.get('blue-r05')).toMatchObject({ status: 'current', disputedWith: [] });
  });
});

describe('evidence packet validation', () => {
  it('accepts the built-in packet and keeps it immutable', () => {
    expect(validateEvidencePacket(EVIDENCE_PACKET)).toEqual([]);
    const [view] = packetReportsAt('blue', 0);
    expect(() => { (view.report as any).body = 'edited'; }).toThrow(TypeError);
    expect(packetReportsAt('blue', 0)[0].report.body).not.toBe('edited');
  });

  it.each<[string, (reports: Draft[], packet: any) => void, string]>([
    ['duplicate report IDs', reports => { reports[1].id = reports[0].id; }, 'duplicate-id'],
    ['an ID shared by a source and an entity', (_, p) => { p.sources[0].id = p.entities[0].id; }, 'duplicate-id'],
    ['an observation after release', reports => { reports[0].observedTick = 10; }, 'future-observation'],
    ['an unknown source', reports => { reports[0].sourceId = 'source.nowhere'; }, 'unknown-source'],
    ['an unknown entity', reports => { reports[0].claim = { ...reports[0].claim, entityId: 'entity.nowhere' }; }, 'unknown-entity'],
    ['an unresolved link target', reports => { reports[3].links = [{ kind: 'supersedes', reportId: 'blue-r99' }]; }, 'unknown-link-target'],
    ['a link to a report released later', reports => { reports[0].links = [{ kind: 'supersedes', reportId: 'blue-r08' }]; }, 'link-released-later'],
    ['a correction about a different entity', reports => { reports.find(r => r.id === 'blue-r04')!.links = [{ kind: 'supersedes', reportId: 'blue-r01' }]; }, 'invalid-supersession'],
    ['two corrections of one report', (reports, p) => reports.push(cloneReport(p, 'blue-r04', { id: 'blue-r10' })), 'supersession-fork'],
    ['a supersession cycle', (reports, p) => reports.push(
      cloneReport(p, 'blue-r02', { id: 'blue-x1', releaseTick: 1500, observedTick: 1500, links: [{ kind: 'supersedes', reportId: 'blue-x2' }] }),
      cloneReport(p, 'blue-r02', { id: 'blue-x2', releaseTick: 1500, observedTick: 1500, links: [{ kind: 'supersedes', reportId: 'blue-x1' }] })), 'supersession-cycle'],
    ['a repeat that changes the claim', reports => { const r = reports.find(x => x.id === 'blue-r03')!; r.claim = { ...r.claim, value: { kind: 'reserve-estimate', low: 1, high: 2, unit: 'abstract-reserve-units' } }; }, 'invalid-derivative'],
    ['a repeat labelled independent', reports => { reports.find(r => r.id === 'blue-r03')!.sourceRelationship = 'independent'; }, 'relationship-mismatch'],
    ['a dispute between agreeing claims', reports => { const r = reports.find(x => x.id === 'blue-r06')!; r.claim = { ...r.claim, value: { kind: 'station-availability', availability: 'unavailable' } }; }, 'invalid-dispute'],
    ['a dispute aimed at a repeat instead of its origin', reports => { reports.find(r => r.id === 'blue-r06')!.links = [{ kind: 'disputes', reportId: 'blue-r07' }]; }, 'invalid-dispute'],
    ['a claim marked authoritative', reports => { reports[0].authoritativeState = true; }, 'authoritative-claim'],
  ])('reports %s', (_, edit, code) => {
    const packet = variant(edit);
    expect(codes(packet)).toContain(code);
    expect(() => reportsAt(packet, 'blue', 10_000)).toThrow(EvidencePacketValidationError);
  });
});
