/**
 * Fictional changing-evidence training packet. Pure data and pure functions: no engine, store,
 * graph, identity or inference dependencies. Claims are scenario text, never game engine state.
 */
import type { Side } from '../engine/engine';
import type { OrganizationPackRole } from '../context/organization-packs';

export const EVIDENCE_PACKET_SCHEMA = 'replay.evidence-packet/1';
/** Append a new ID for any content change; never revise a released packet in place. */
export const EVIDENCE_PACKET_ID = 'crosscurrent-changing-evidence/1';

export type EvidenceTopic = 'station-availability' | 'reserve-estimate' | 'holding-observation';

/** Structured claim values. Estimates are stated ranges, not probabilities or confidence scores. */
export type EvidenceClaimValue =
  | { readonly kind: 'station-availability'; readonly availability: 'available' | 'unavailable' | 'unknown' }
  | { readonly kind: 'reserve-estimate'; readonly low: number; readonly high: number; readonly unit: 'abstract-reserve-units' }
  | { readonly kind: 'holding-observation'; readonly holder: Side | 'unclear' };

export interface EvidenceClaim {
  readonly entityId: string;
  /** The name the source used. Different names can refer to one stable entity. */
  readonly nameAsReported: string;
  readonly value: EvidenceClaimValue;
}

export interface EvidenceEntity {
  readonly id: string;
  readonly kind: 'fictional-station';
  readonly name: string;
  readonly description: string;
}

export type EvidenceSourceOrigin = 'fictional-scripted-observation' | 'fictional-liaison-account' | 'fictional-relay-digest';

export interface EvidenceSource {
  readonly id: string;
  /** Sources belong to one side's staff records. */
  readonly side: Side;
  readonly name: string;
  readonly origin: EvidenceSourceOrigin;
  readonly description: string;
}

/**
 * Declared links are the only basis for currency and dispute status. Every target must be a
 * same-side report released no later than the linking report.
 */
export type EvidenceLink =
  | { readonly kind: 'supersedes'; readonly reportId: string }
  | { readonly kind: 'disputes'; readonly reportId: string }
  | { readonly kind: 'derived-from'; readonly reportId: string };

export interface EvidenceReport {
  readonly id: string;
  readonly side: Side;
  readonly sourceId: string;
  /** Tick the source says it observed. Ordinary simulation ticks; releases never pause play. */
  readonly observedTick: number;
  /** First tick at which the report is available to its side. */
  readonly releaseTick: number;
  readonly topic: EvidenceTopic;
  readonly title: string;
  readonly body: string;
  /** `derivative` repeats an earlier report and adds no independent observation. */
  readonly sourceRelationship: 'independent' | 'derivative';
  readonly claim: EvidenceClaim;
  readonly links: readonly EvidenceLink[];
  readonly claimStatus: 'fictional-scenario-claim';
  readonly authoritativeState: false;
}

export interface EvidencePacketProvenance {
  readonly kind: 'synthetic';
  readonly status: 'provisional-unreviewed';
  readonly author: 'REPLAY project';
  readonly scope: string;
  readonly limitations: readonly string[];
}

export interface EvidencePacket {
  readonly schema: typeof EVIDENCE_PACKET_SCHEMA;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly authoritativeState: false;
  readonly timing: { readonly unit: 'simulation-tick'; readonly pausesGame: false; readonly releaseTicks: readonly number[] };
  readonly provenance: EvidencePacketProvenance;
  /** Presentation guidance only; it grants no access, watch or order authority. */
  readonly monitoringFocus: Readonly<Record<OrganizationPackRole, string>>;
  readonly sides: Readonly<Record<Side, { readonly name: string }>>;
  readonly entities: readonly EvidenceEntity[];
  readonly sources: readonly EvidenceSource[];
  readonly reports: readonly EvidenceReport[];
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

type ReportDraft = Omit<EvidenceReport, 'claimStatus' | 'authoritativeState' | 'topic' | 'sourceRelationship' | 'links' | 'claim'> & {
  readonly entityId: string; readonly nameAsReported: string; readonly value: EvidenceClaimValue; readonly links?: readonly EvidenceLink[];
};

const report = ({ entityId, nameAsReported, value, links = [], ...rest }: ReportDraft): EvidenceReport => ({
  ...rest, topic: value.kind, claim: { entityId, nameAsReported, value }, links,
  sourceRelationship: links.some(link => link.kind === 'derived-from') ? 'derivative' : 'independent',
  claimStatus: 'fictional-scenario-claim', authoritativeState: false,
});

const available = { kind: 'station-availability', availability: 'available' } as const;
const unavailable = { kind: 'station-availability', availability: 'unavailable' } as const;
const reserve = (low: number, high: number) => ({ kind: 'reserve-estimate', low, high, unit: 'abstract-reserve-units' }) as const;

export const EVIDENCE_PACKET: EvidencePacket = freeze({
  schema: EVIDENCE_PACKET_SCHEMA, id: EVIDENCE_PACKET_ID,
  title: 'Crosscurrent · changing evidence',
  description: 'Two fictional staff desks receive reports about three abstract stations over several release ticks. Some reports are corrected, some contradict each other and some only repeat earlier reports.',
  authoritativeState: false,
  timing: { unit: 'simulation-tick', pausesGame: false, releaseTicks: [0, 300, 600, 900, 1200] },
  provenance: {
    kind: 'synthetic', status: 'provisional-unreviewed', author: 'REPLAY project',
    scope: 'Original fictional reports about abstract station availability, reserve estimates and holdings.',
    limitations: [
      'Every claim is fictional scenario text. No claim describes, or is checked against, the game engine state.',
      'Names are invented. No real place, organization, doctrine, operation or force posture is represented.',
      'Status comes only from declared links. A disputed claim is unresolved, not false, and the packet assigns no confidence.',
      'Integrated with versioned scenario releases and the saved report store; authored claims remain separate from measured game state.',
    ],
  },
  monitoringFocus: {
    commander: 'Note which current reports bear on the stated objective and which questions remain open before committing reserves.',
    intelligence: 'Trace each claim to its source and release tick; separate corrections, unresolved contradictions and repeats of an earlier report.',
    instructor: 'Review which reports were released at each decision tick. Later corrections were not available to earlier decisions.',
  },
  sides: { blue: { name: 'Blue staff desk' }, red: { name: 'Red staff desk' } },
  entities: [
    { id: 'entity.lantern-station', kind: 'fictional-station', name: 'Lantern Station', description: 'An abstract fictional station on the northern shore.' },
    { id: 'entity.marsh-station', kind: 'fictional-station', name: 'Marsh Station', description: 'An abstract fictional station on low ground inland.' },
    { id: 'entity.tidewell-station', kind: 'fictional-station', name: 'Tidewell Station', description: 'An abstract fictional station at the end of a causeway.' },
  ],
  sources: [
    { id: 'source.blue.survey', side: 'blue', name: 'Blue survey desk', origin: 'fictional-scripted-observation', description: 'Scripted scenario observations written for the exercise.' },
    { id: 'source.blue.liaison', side: 'blue', name: 'Blue liaison desk', origin: 'fictional-liaison-account', description: 'Second-hand accounts passed to the Blue desk.' },
    { id: 'source.blue.bulletin', side: 'blue', name: 'Blue relay bulletin', origin: 'fictional-relay-digest', description: 'Repeats earlier Blue reports; it makes no observations of its own.' },
    { id: 'source.red.survey', side: 'red', name: 'Red survey desk', origin: 'fictional-scripted-observation', description: 'Scripted scenario observations written for the exercise.' },
    { id: 'source.red.shorewatch', side: 'red', name: 'Red shore watch', origin: 'fictional-liaison-account', description: 'Accounts from a separate Red observer.' },
    { id: 'source.red.digest', side: 'red', name: 'Red daily digest', origin: 'fictional-relay-digest', description: 'Repeats earlier Red reports; it makes no observations of its own.' },
  ],
  reports: [
    report({ id: 'blue-r01', side: 'blue', sourceId: 'source.blue.survey', observedTick: 0, releaseTick: 0,
      entityId: 'entity.lantern-station', nameAsReported: 'Lantern Station', value: available,
      title: 'Lantern Station available', body: 'Survey notes Lantern Station as available at the start of the exercise.' }),
    report({ id: 'blue-r02', side: 'blue', sourceId: 'source.blue.survey', observedTick: 240, releaseTick: 300,
      entityId: 'entity.marsh-station', nameAsReported: 'Marsh Station', value: reserve(40, 60),
      title: 'Marsh reserve estimate', body: 'Survey estimates 40–60 reserve units held near Marsh Station.' }),
    report({ id: 'blue-r03', side: 'blue', sourceId: 'source.blue.bulletin', observedTick: 240, releaseTick: 300,
      entityId: 'entity.marsh-station', nameAsReported: 'the reed-flat stop', value: reserve(40, 60), links: [{ kind: 'derived-from', reportId: 'blue-r02' }],
      title: 'Bulletin: reed-flat reserves', body: 'Relay bulletin repeats the survey estimate of 40–60 reserve units at the reed-flat stop. No new observation.' }),
    report({ id: 'blue-r04', side: 'blue', sourceId: 'source.blue.survey', observedTick: 540, releaseTick: 600,
      entityId: 'entity.marsh-station', nameAsReported: 'Marsh Station', value: reserve(15, 25), links: [{ kind: 'supersedes', reportId: 'blue-r02' }],
      title: 'Correction: Marsh reserve estimate', body: 'Survey corrects its earlier estimate: one group was counted twice. Revised estimate is 15–25 reserve units.' }),
    report({ id: 'blue-r05', side: 'blue', sourceId: 'source.blue.liaison', observedTick: 560, releaseTick: 600,
      entityId: 'entity.tidewell-station', nameAsReported: 'the east causeway post', value: unavailable,
      title: 'Causeway post unavailable', body: 'Liaison account says the east causeway post is unavailable.' }),
    report({ id: 'blue-r06', side: 'blue', sourceId: 'source.blue.survey', observedTick: 820, releaseTick: 900,
      entityId: 'entity.tidewell-station', nameAsReported: 'Tidewell Station', value: available, links: [{ kind: 'disputes', reportId: 'blue-r05' }],
      title: 'Tidewell Station available', body: 'Survey notes Tidewell Station as available. This conflicts with the liaison account and neither report has been withdrawn.' }),
    report({ id: 'blue-r07', side: 'blue', sourceId: 'source.blue.bulletin', observedTick: 560, releaseTick: 900,
      entityId: 'entity.tidewell-station', nameAsReported: 'Causeway post', value: unavailable, links: [{ kind: 'derived-from', reportId: 'blue-r05' }],
      title: 'Bulletin: causeway post unavailable', body: 'Relay bulletin repeats the liaison account that the causeway post is unavailable. No new observation.' }),
    report({ id: 'blue-r08', side: 'blue', sourceId: 'source.blue.liaison', observedTick: 1150, releaseTick: 1200,
      entityId: 'entity.lantern-station', nameAsReported: 'the lamp-house', value: { kind: 'holding-observation', holder: 'unclear' },
      title: 'Lamp-house holder unclear', body: 'Liaison account could not tell which side holds the lamp-house.' }),

    report({ id: 'red-r01', side: 'red', sourceId: 'source.red.survey', observedTick: 0, releaseTick: 0,
      entityId: 'entity.tidewell-station', nameAsReported: 'Tidewell Station', value: available,
      title: 'Tidewell Station available', body: 'Survey notes Tidewell Station as available at the start of the exercise.' }),
    report({ id: 'red-r02', side: 'red', sourceId: 'source.red.shorewatch', observedTick: 260, releaseTick: 300,
      entityId: 'entity.lantern-station', nameAsReported: 'the north light', value: unavailable,
      title: 'North light unavailable', body: 'Shore watch reports the north light as unavailable.' }),
    report({ id: 'red-r03', side: 'red', sourceId: 'source.red.survey', observedTick: 590, releaseTick: 600,
      entityId: 'entity.marsh-station', nameAsReported: 'Marsh Station', value: reserve(30, 45),
      title: 'Marsh reserve estimate', body: 'Survey estimates 30–45 reserve units held near Marsh Station.' }),
    report({ id: 'red-r04', side: 'red', sourceId: 'source.red.shorewatch', observedTick: 870, releaseTick: 900,
      entityId: 'entity.lantern-station', nameAsReported: 'the north light', value: available, links: [{ kind: 'supersedes', reportId: 'red-r02' }],
      title: 'Correction: north light available', body: 'Shore watch withdraws its earlier note; the signal board was misread. The north light is available.' }),
    report({ id: 'red-r05', side: 'red', sourceId: 'source.red.digest', observedTick: 590, releaseTick: 900,
      entityId: 'entity.marsh-station', nameAsReported: 'the inland marsh', value: reserve(30, 45), links: [{ kind: 'derived-from', reportId: 'red-r03' }],
      title: 'Digest: inland marsh reserves', body: 'Daily digest repeats the survey estimate of 30–45 reserve units. No new observation.' }),
    report({ id: 'red-r06', side: 'red', sourceId: 'source.red.survey', observedTick: 1180, releaseTick: 1200,
      entityId: 'entity.marsh-station', nameAsReported: 'Marsh Station', value: reserve(10, 20), links: [{ kind: 'supersedes', reportId: 'red-r03' }],
      title: 'Correction: Marsh reserve estimate', body: 'Survey replaces its earlier estimate after a later count. Revised estimate is 10–20 reserve units.' }),
    report({ id: 'red-r07', side: 'red', sourceId: 'source.red.shorewatch', observedTick: 1190, releaseTick: 1200,
      entityId: 'entity.tidewell-station', nameAsReported: 'the causeway', value: unavailable, links: [{ kind: 'disputes', reportId: 'red-r01' }],
      title: 'Causeway unavailable', body: 'Shore watch reports the causeway as unavailable, contrary to the earlier survey. Neither report has been withdrawn.' }),
  ],
});

export type EvidencePacketIssueCode =
  | 'duplicate-id' | 'invalid-side' | 'invalid-tick' | 'future-observation' | 'authoritative-claim'
  | 'unknown-entity' | 'unknown-source' | 'source-side-mismatch' | 'topic-mismatch' | 'relationship-mismatch'
  | 'unknown-link-target' | 'self-link' | 'cross-side-link' | 'link-released-later'
  | 'invalid-supersession' | 'supersession-fork' | 'supersession-cycle'
  | 'invalid-derivative' | 'invalid-dispute';

export interface EvidencePacketIssue {
  readonly code: EvidencePacketIssueCode;
  readonly id: string;
  readonly message: string;
}

export class EvidencePacketValidationError extends Error {
  constructor(readonly issues: readonly EvidencePacketIssue[]) {
    super(`Invalid evidence packet: ${issues.map(issue => `${issue.code} (${issue.id})`).join(', ')}`);
    this.name = 'EvidencePacketValidationError';
  }
}

const isSide = (value: unknown): value is Side => value === 'blue' || value === 'red';
const isTick = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function sameValue(a: EvidenceClaimValue, b: EvidenceClaimValue): boolean {
  if (a.kind === 'station-availability' && b.kind === 'station-availability') return a.availability === b.availability;
  if (a.kind === 'reserve-estimate' && b.kind === 'reserve-estimate') return a.low === b.low && a.high === b.high && a.unit === b.unit;
  if (a.kind === 'holding-observation' && b.kind === 'holding-observation') return a.holder === b.holder;
  return false;
}

const sameSubject = (a: EvidenceReport, b: EvidenceReport) => a.claim.entityId === b.claim.entityId && a.topic === b.topic;
const originOf = (r: EvidenceReport) => r.links.find(link => link.kind === 'derived-from')?.reportId;

/** Returns every structural problem found; an empty list means the packet is usable. */
export function validateEvidencePacket(packet: EvidencePacket): EvidencePacketIssue[] {
  const issues: EvidencePacketIssue[] = [];
  const issue = (code: EvidencePacketIssueCode, id: string, message: string) => issues.push({ code, id, message });
  const seen = new Set<string>();
  for (const { id } of [...packet.entities, ...packet.sources, ...packet.reports]) {
    if (seen.has(id)) issue('duplicate-id', id, 'IDs must be unique across entities, sources and reports.');
    seen.add(id);
  }
  if (packet.authoritativeState !== false) issue('authoritative-claim', packet.id, 'The packet must not claim authoritative state.');
  const entities = new Set(packet.entities.map(entity => entity.id));
  const sources = new Map(packet.sources.map(source => [source.id, source]));
  const reports = new Map(packet.reports.map(r => [r.id, r]));
  for (const source of packet.sources) if (!isSide(source.side)) issue('invalid-side', source.id, 'Source side must be blue or red.');

  const supersededBy = new Map<string, string>();
  for (const r of packet.reports) {
    if (!isSide(r.side)) issue('invalid-side', r.id, 'Report side must be blue or red.');
    if (!isTick(r.observedTick) || !isTick(r.releaseTick)) { issue('invalid-tick', r.id, 'Ticks must be non-negative integers.'); continue; }
    if (r.observedTick > r.releaseTick) issue('future-observation', r.id, 'A report cannot be released before the tick it observed.');
    if (r.authoritativeState !== false || r.claimStatus !== 'fictional-scenario-claim') issue('authoritative-claim', r.id, 'Reports must be marked as non-authoritative fictional claims.');
    if (!entities.has(r.claim.entityId)) issue('unknown-entity', r.id, `Unknown entity ${r.claim.entityId}.`);
    const source = sources.get(r.sourceId);
    if (!source) issue('unknown-source', r.id, `Unknown source ${r.sourceId}.`);
    else if (source.side !== r.side) issue('source-side-mismatch', r.id, 'A report must come from a source on its own side.');
    if (r.topic !== r.claim.value.kind) issue('topic-mismatch', r.id, 'Topic must match the structured claim value.');
    const derivedLinks = r.links.filter(link => link.kind === 'derived-from');
    if ((r.sourceRelationship === 'derivative') !== (derivedLinks.length === 1) || derivedLinks.length > 1) {
      issue('relationship-mismatch', r.id, 'A derivative report needs exactly one derived-from link; an independent report has none.');
    }

    for (const link of r.links) {
      const target = reports.get(link.reportId);
      if (!target) { issue('unknown-link-target', r.id, `Unknown ${link.kind} target ${link.reportId}.`); continue; }
      if (target.id === r.id) { issue('self-link', r.id, 'A report cannot link to itself.'); continue; }
      if (target.side !== r.side) { issue('cross-side-link', r.id, `${link.kind} target ${target.id} belongs to the other side.`); continue; }
      if (isTick(target.releaseTick) && target.releaseTick > r.releaseTick) issue('link-released-later', r.id, `${link.kind} target ${target.id} is released after this report.`);
      if (link.kind === 'supersedes') {
        if (r.sourceRelationship === 'derivative' || originOf(target) || !sameSubject(r, target)) {
          issue('invalid-supersession', r.id, 'Only an independent report can supersede an independent report about the same entity and topic.');
        }
        const prior = supersededBy.get(target.id);
        if (prior) issue('supersession-fork', r.id, `${target.id} is already superseded by ${prior}.`);
        else supersededBy.set(target.id, r.id);
      } else if (link.kind === 'derived-from') {
        if (originOf(target) || target.sourceId === r.sourceId || !sameSubject(r, target) ||
            target.observedTick !== r.observedTick || !sameValue(target.claim.value, r.claim.value)) {
          issue('invalid-derivative', r.id, 'A derivative repeats one independent report from another source with the same observation tick and claim.');
        }
      } else if (r.sourceRelationship === 'derivative' || originOf(target) || target.sourceId === r.sourceId ||
                 !sameSubject(r, target) || sameValue(target.claim.value, r.claim.value)) {
        issue('invalid-dispute', r.id, 'A dispute links independent reports from different sources with conflicting claims about the same subject.');
      }
    }
  }
  for (const start of supersededBy.keys()) {
    const visited = new Set<string>([start]);
    for (let next = supersededBy.get(start); next; next = supersededBy.get(next)) {
      if (visited.has(next)) { issue('supersession-cycle', start, 'Supersession links form a cycle.'); break; }
      visited.add(next);
    }
  }
  return issues;
}

export function assertValidEvidencePacket(packet: EvidencePacket): void {
  const issues = validateEvidencePacket(packet);
  if (issues.length) throw new EvidencePacketValidationError(issues);
}

export type EvidenceReportStatus = 'current' | 'superseded' | 'disputed';

/** A released report plus its status at one cutoff. The record itself is never altered. */
export interface EvidenceReportView {
  readonly report: EvidenceReport;
  /** superseded outranks disputed; disputed claims are unresolved, not false. */
  readonly status: EvidenceReportStatus;
  /** Released successor. `origin` means the repeated report was superseded, so the repeat is stale too. */
  readonly supersededBy: string | null;
  readonly supersessionBasis: 'direct' | 'origin' | null;
  /** Released, unsuperseded reports declaring a dispute with this report or the report it repeats. */
  readonly disputedWith: readonly string[];
  /** The independent report this one repeats, or its own ID. Shared roots are one observation, not corroboration. */
  readonly lineageRootId: string;
}

/**
 * Reports released to `side` at or before `tick`, with status derived only from links released
 * by that cutoff. Earlier cutoffs keep showing later-superseded reports as they were then.
 */
export function reportsAt(packet: EvidencePacket, side: Side, tick: number): EvidenceReportView[] {
  if (!isSide(side)) throw new Error('Side must be blue or red');
  if (!isTick(tick)) throw new Error('Tick must be a non-negative integer');
  assertValidEvidencePacket(packet);
  const released = packet.reports.filter(r => r.side === side && r.releaseTick <= tick);
  const successor = new Map<string, string>();
  const disputes = new Map<string, Set<string>>();
  const markDispute = (a: string, b: string) => { if (!disputes.has(a)) disputes.set(a, new Set()); disputes.get(a)!.add(b); };
  for (const r of released) for (const link of r.links) if (link.kind === 'supersedes') successor.set(link.reportId, r.id);
  for (const r of released) {
    if (successor.has(r.id)) continue;
    for (const link of r.links) {
      if (link.kind === 'disputes' && !successor.has(link.reportId)) { markDispute(link.reportId, r.id); markDispute(r.id, link.reportId); }
    }
  }
  return released
    .map((r, order) => ({ r, order }))
    .sort((a, b) => a.r.releaseTick - b.r.releaseTick || a.order - b.order)
    .map(({ r }) => {
      const root = originOf(r) ?? r.id;
      const direct = successor.get(r.id), inherited = root !== r.id ? successor.get(root) : undefined;
      const supersededBy = direct ?? inherited ?? null;
      const disputedWith = [...(disputes.get(root) ?? [])];
      return {
        report: r, lineageRootId: root, supersededBy, disputedWith,
        supersessionBasis: direct ? 'direct' : inherited ? 'origin' : null,
        status: supersededBy ? 'superseded' : disputedWith.length ? 'disputed' : 'current',
      } satisfies EvidenceReportView;
    });
}

/** Released reports for one side of the built-in packet at a simulation tick. */
export function packetReportsAt(side: Side, tick: number): EvidenceReportView[] {
  return reportsAt(EVIDENCE_PACKET, side, tick);
}

export interface ClaimLineage {
  readonly entityId: string;
  readonly topic: EvidenceTopic;
  readonly lineageRootId: string;
  /** The independent report followed by any repeats of it. */
  readonly reportIds: readonly string[];
}

/**
 * Groups unsuperseded views by independent lineage. Counting lineages shows how many separate
 * observations exist; it is not a confidence measure and says nothing about which claim is true.
 */
export function claimLineages(views: readonly EvidenceReportView[], entityId: string): ClaimLineage[] {
  const lineages = new Map<string, { entityId: string; topic: EvidenceTopic; lineageRootId: string; reportIds: string[] }>();
  for (const view of views) {
    if (view.status === 'superseded' || view.report.claim.entityId !== entityId) continue;
    const lineage = lineages.get(view.lineageRootId) ??
      { entityId, topic: view.report.topic, lineageRootId: view.lineageRootId, reportIds: [] };
    lineage.reportIds.push(view.report.id);
    lineages.set(view.lineageRootId, lineage);
  }
  return [...lineages.values()];
}

assertValidEvidencePacket(EVIDENCE_PACKET);
