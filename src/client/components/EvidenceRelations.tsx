import React from 'react';

export type EvidenceRelationsProps = {
  packet: {
    id: string;
    reportId: string;
    sourceId: string;
    entityId: string;
    observedTick: number;
    releaseTick: number;
    sourceRelationship: 'independent' | 'derivative';
    links: ReadonlyArray<{
      kind: 'supersedes' | 'disputes' | 'derived-from';
      reportId: string;
    }>;
    lineageRootId: string;
    claimStatus: 'fictional-scenario-claim';
    authoritativeState: false;
  };
  evidenceStatus?: 'current' | 'superseded' | 'disputed';
  disputedWith?: string[];
  supersededBy?: string;
  references: Array<{ id: string; title: string }>;
  onFocus?: (id: string) => void;
};

export function EvidenceRelations({
  packet,
  evidenceStatus,
  disputedWith = [],
  supersededBy,
  references,
  onFocus,
}: EvidenceRelationsProps) {
  const titles = new Map(references.map((reference) => [reference.id, reference.title]));
  const candidates = [
    ...packet.links,
    ...disputedWith.map((reportId) => ({ kind: 'disputes' as const, reportId })),
    ...(supersededBy ? [{ kind: 'superseded-by' as const, reportId: supersededBy }] : []),
  ];
  const seen = new Set<string>();
  const links = candidates.filter(({ kind, reportId }) => {
    const key = `${kind}:${reportId}`;
    if (!titles.has(reportId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <section aria-label="Evidence relations" className="small">
      <p><strong>Fictional scenario claim</strong>; not measured game state.</p>
      <dl>
        <dt>Observed tick</dt><dd>{packet.observedTick}</dd>
        <dt>Released tick</dt><dd>{packet.releaseTick}</dd>
        <dt>Source relationship</dt>
        <dd>
          {packet.sourceRelationship === 'derivative'
            ? 'Derivative — repeated claim, not independent corroboration.'
            : 'Non-derivative report; check source identity before treating it as independent corroboration.'}
        </dd>
        {evidenceStatus && <><dt>Packet status</dt><dd>{evidenceStatus}</dd></>}
      </dl>
      {evidenceStatus === 'disputed' && (
        <p className="muted">Unresolved conflict; not adjudicated.</p>
      )}
      {links.length > 0 && (
        <ul aria-label="Related reports">
          {links.map(({ kind, reportId }) => (
            <li key={`${kind}:${reportId}`}>
              <span className="muted">{kind}: </span>
              {onFocus ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Focus ${kind} report: ${titles.get(reportId)}`}
                  onClick={() => onFocus(reportId)}
                >
                  {titles.get(reportId)}
                </button>
              ) : <span>{titles.get(reportId)}</span>}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>Stable identifiers and lineage</summary>
        <dl className="muted">
          <dt>Source ID</dt><dd>{packet.sourceId}</dd>
          <dt>Entity ID</dt><dd>{packet.entityId}</dd>
          <dt>Lineage root ID</dt><dd>{packet.lineageRootId}</dd>
        </dl>
      </details>
    </section>
  );
}
