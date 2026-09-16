import type { EvidencePacket, EvidenceReport } from './evidence-packet';

export interface PacketRecord {
  readonly id: string;
  readonly tick: number;
  readonly side: EvidenceReport['side'];
  readonly title: string;
  readonly body: string;
  readonly source: string;
  readonly confidence: 'Fictional scenario claim; unverified.';
  readonly synthetic: true;
  readonly supersedes?: string;
  readonly packet: {
    readonly id: string;
    readonly reportId: string;
    readonly sourceId: string;
    readonly entityId: string;
    readonly observedTick: number;
    readonly releaseTick: number;
    readonly sourceRelationship: EvidenceReport['sourceRelationship'];
    readonly links: readonly { readonly kind: EvidenceReport['links'][number]['kind']; readonly reportId: string }[];
    readonly lineageRootId: string;
    readonly claimStatus: 'fictional-scenario-claim';
    readonly authoritativeState: false;
  };
}

export function materializeEvidenceReport(
  packet: EvidencePacket,
  report: EvidenceReport,
  resolveId: (packetReportId: string) => string,
): PacketRecord {
  const source = packet.sources.find(candidate => candidate.id === report.sourceId);
  if (!source) throw new Error(`Unknown evidence source ${report.sourceId}`);

  const resolved = new Map<string, string>();
  const resolve = (id: string) => {
    const existing = resolved.get(id);
    if (existing !== undefined) return existing;
    const runtimeId = resolveId(id);
    resolved.set(id, runtimeId);
    return runtimeId;
  };
  const links = report.links.map(link => ({ kind: link.kind, reportId: resolve(link.reportId) }));
  const derivedFrom = links.find(link => link.kind === 'derived-from');
  const supersedes = links.find(link => link.kind === 'supersedes')?.reportId;

  return {
    id: resolve(report.id),
    tick: report.releaseTick,
    side: report.side,
    title: report.title,
    body: report.body,
    source: source.name,
    confidence: 'Fictional scenario claim; unverified.',
    synthetic: true,
    ...(supersedes === undefined ? {} : { supersedes }),
    packet: {
      id: packet.id,
      reportId: report.id,
      sourceId: report.sourceId,
      entityId: report.claim.entityId,
      observedTick: report.observedTick,
      releaseTick: report.releaseTick,
      sourceRelationship: report.sourceRelationship,
      links,
      lineageRootId: derivedFrom?.reportId ?? resolve(report.id),
      claimStatus: 'fictional-scenario-claim',
      authoritativeState: false,
    },
  };
}

type Projectable = { id: string; supersedes?: string; packet?: PacketRecord['packet'] };
type Projected<T> = T & {
  evidenceStatus?: 'current' | 'superseded' | 'disputed';
  supersededBy?: string;
  disputedWith?: string[];
};

export function projectEvidenceRecords<T extends Projectable>(records: readonly T[]): Array<Projected<T>> {
  const byId = new Map<string, T>();
  for (const record of records) {
    if (byId.has(record.id)) throw new Error(`Duplicate evidence record ID: ${record.id}`);
    byId.set(record.id, record);
  }

  const packetRecords = records.filter((record): record is T & { packet: PacketRecord['packet'] } => Boolean(record.packet));
  const successor = new Map<string, string>();
  for (const record of packetRecords) {
    const targets = new Set<string>();
    if (record.supersedes) targets.add(record.supersedes);
    for (const link of record.packet.links) if (link.kind === 'supersedes') targets.add(link.reportId);
    for (const target of targets) if (byId.has(target)) successor.set(target, record.id);
  }

  const rootOf = (record: T & { packet: PacketRecord['packet'] }) =>
    byId.has(record.packet.lineageRootId) ? record.packet.lineageRootId : record.id;
  const supersededBy = (record: T & { packet: PacketRecord['packet'] }) =>
    successor.get(record.id) ?? (rootOf(record) === record.id ? undefined : successor.get(rootOf(record)));
  const active = new Set(packetRecords.filter(record => !supersededBy(record)).map(record => record.id));
  const lineageMembers = new Map<string, string[]>();
  for (const record of packetRecords) {
    if (!active.has(record.id)) continue;
    const root = rootOf(record);
    const members = lineageMembers.get(root) ?? [];
    members.push(record.id);
    lineageMembers.set(root, members);
  }

  const disputes = new Map<string, Set<string>>();
  const addDispute = (id: string, other: string) => {
    const values = disputes.get(id) ?? new Set<string>();
    values.add(other);
    disputes.set(id, values);
  };
  for (const record of packetRecords) {
    if (!active.has(record.id)) continue;
    for (const link of record.packet.links) {
      if (link.kind !== 'disputes' || !active.has(link.reportId)) continue;
      const target = byId.get(link.reportId);
      if (!target?.packet) continue;
      const leftRoot = rootOf(record);
      const rightRoot = rootOf(target as T & { packet: PacketRecord['packet'] });
      for (const id of lineageMembers.get(leftRoot) ?? []) addDispute(id, link.reportId);
      for (const id of lineageMembers.get(rightRoot) ?? []) addDispute(id, record.id);
    }
  }

  return records.map(record => {
    if (!record.packet) return { ...record };
    const { evidenceStatus: _status, supersededBy: _successor, disputedWith: _disputes, ...clean } = record as Projected<T>;
    const replacement = supersededBy(record as T & { packet: PacketRecord['packet'] });
    if (replacement) return { ...clean, evidenceStatus: 'superseded', supersededBy: replacement };
    const disputedWith = [...(disputes.get(record.id) ?? [])];
    return disputedWith.length
      ? { ...clean, evidenceStatus: 'disputed', disputedWith }
      : { ...clean, evidenceStatus: 'current' };
  }) as Array<Projected<T>>;
}
