import type { PracticeHistoryItem, PracticeHistoryResult } from '../../learning/practice-history-types';
import { observePracticeHistory, type ObservationCitation } from '../../learning/practice-observations';

/** Keeps the latest page distinct from the accumulated list of search results. */
export function PracticeObservationsPanel({ page, onOpen, opening = false }: {
  page: PracticeHistoryResult; onOpen: (item: PracticeHistoryItem) => void; opening?: boolean;
}) {
  const observations = observePracticeHistory(page);
  const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
  const evidence = (citations: ObservationCitation[]) => citations.map(citation => {
    const item = page.items.find(i => i.eventId === citation.eventId && i.exercise.id === citation.exerciseId);
    return item && <li key={`${citation.exerciseId}/${citation.eventId}`}>
      <button type="button" className="btn btn-sm" disabled={opening} onClick={() => onOpen(item)}
        aria-label={`Review evidence ${citation.eventId} in ${item.exercise.name}`}>
        {item.exercise.name} · recorded tick {citation.tick}
      </button>
      <span className="small muted"> Viewed tick: {citation.observedTick ?? 'not recorded'}</span>
    </li>;
  });
  return <details className="panel" style={{ marginBottom: 12 }}>
    <summary><strong>Practice observations · latest page</strong></summary>
    <p className="small">These {observations.provenance.observedItems} records are grouped by participant and recorded exercise settings.
      {' '}Historical staff roles are unavailable. This is a partial view of retained actions.</p>
    {observations.groups.length === 0 && <p className="small">No eligible observations on this page.</p>}
    {observations.groups.map(group => <section key={group.key} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
      <p><strong>{group.compatibility.scenarioId ?? 'Scenario not recorded'}</strong> · {group.seat ?? 'Side not recorded'}
        {' '}· {group.lineage === 'branch' ? 'Branch · informed practice' : 'Original'}
        {page.scope === 'workroom' && <span className="small"> · Participant: {group.actor}</span>}</p>
      <p className="small">{group.sampleSize.exercises} exercise(s) · {group.sampleSize.commands} commands · {group.sampleSize.assessments} assessments · {group.sampleSize.watches} watches.
        {' '}Assistance: {group.compatibility.assistance}. Scenario version: {group.compatibility.scenarioVersion ?? 'not recorded'}.</p>
      {group.compatibility.status === 'isolated-to-exercise' && <p className="small muted">Kept within one exercise because some settings were not recorded.</p>}
      <p className="small">Written reason on {group.commands.recordedReason.observed.length} of {group.sampleSize.commands} commands;
        {' '}source citations on {group.commands.sourceCitations.observed.length}.</p>
      {group.commitment.range ? <>
        <p className="small">Recorded force commitment: {percent(group.commitment.range.min)}–{percent(group.commitment.range.max)};
          {' '}median {percent(group.commitment.range.median)} across {group.commitment.sampleSize} orders.
          {' '}This describes committed forces, not decision quality.</p>
        <details><summary className="small">Review commitment evidence</summary><ul>{evidence(group.commitment.values.map(v => v.citation))}</ul></details>
      </> : <p className="small muted">Force commitment was not observed in these records.</p>}
      <details><summary className="small">Review reasons and source use</summary>
        <ul>{evidence([...group.commands.recordedReason.observed, ...group.commands.recordedReason.notObserved])}</ul>
        {group.assessments.length > 0 && <><p className="small">Recorded assessments</p><ul>{evidence(group.assessments)}</ul></>}
      </details>
    </section>)}
    {observations.excluded.length > 0 && <p className="small muted">{observations.excluded.length} records excluded because attribution, eligibility or duplicate metadata could not be resolved.</p>}
    <p className="small muted">Only the latest returned page is summarized, including after Load more. Filters and pagination can omit other attempts.
      {' '}These observations do not rate mastery or change an opponent.</p>
  </details>;
}
