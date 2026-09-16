import type {
  PracticeHistoryDetailItem, PracticeHistoryDetailsResult, PracticeHistoryItem, PracticeSourceStatus, PracticeStatement,
} from '../../learning/practice-history-types';
import { ApiError } from '../api';
import type { HistoryFilters } from './PracticeHistoryPanel';
import { Empty } from './ui';

/** The server defaults /2 to 5 records and bounds every serialized page to 6,000 characters. */
export const DETAILS_PAGE_SIZE = 5;
const MAX_DETAIL_ITEMS = 10;
const MAX_DETAIL_CHARS = 6000;

export function detailsUrl(filters: HistoryFilters, beforeSequence?: number): string {
  const params = new URLSearchParams({ scope: filters.scope, query: filters.query.trim(), limit: String(DETAILS_PAGE_SIZE) });
  if (filters.scenarioId) params.set('scenarioId', filters.scenarioId);
  if (beforeSequence !== undefined) params.set('beforeSequence', String(beforeSequence));
  return `/api/practice/history/details?${params}`;
}

const filtersKey = (filters: HistoryFilters) => JSON.stringify([filters.scope, filters.query.trim(), filters.scenarioId]);
const itemKey = (item: PracticeHistoryDetailItem) => JSON.stringify([item.exercise.id, item.eventId]);

export function mergeDetailItems(previous: PracticeHistoryDetailItem[], page: PracticeHistoryDetailItem[]): PracticeHistoryDetailItem[] {
  const seen = new Set<string>();
  return [...previous, ...page].filter(item => !seen.has(itemKey(item)) && !!seen.add(itemKey(item)));
}

/** Scan-limited pages carry a cursor too; it must still move strictly backwards. */
export function detailsCursor(page: PracticeHistoryDetailsResult, beforeSequence?: number): number | null {
  const cursor = page.nextBeforeSequence;
  return page.hasMore && cursor !== null && Number.isSafeInteger(cursor) && cursor > 0
    && (beforeSequence === undefined || cursor < beforeSequence) ? cursor : null;
}

const denied = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403);
export function detailsError(error: unknown): string {
  return denied(error)
    ? 'You are not authorized to view these practice records. Check your signed-in session and workroom access.'
    : 'Decision reasons and sources are unavailable. Please try again.';
}

export interface DetailsSnapshot {
  filters: HistoryFilters;
  items: PracticeHistoryDetailItem[];
  page: PracticeHistoryDetailsResult | null;
  cursor: number | null;
  loading: boolean;
  error: string | null;
}

/** Same race rules as the activity loader: one outstanding page, generation tokens, no retained rows after refusal. */
export function createDetailsLoader(request: typeof fetch = (...args) => fetch(...args)) {
  const ownRecords: HistoryFilters = { query: '', scenarioId: '', scope: 'mine' };
  let snapshot: DetailsSnapshot = { filters: ownRecords, items: [], page: null, cursor: null, loading: false, error: null };
  let generation = 0;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<DetailsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  const cancel = () => {
    generation++; controller?.abort(); controller = null;
    if (snapshot.loading) update({ loading: false });
  };
  const load = async (beforeSequence?: number) => {
    const token = generation;
    const filters = snapshot.filters;
    const key = filtersKey(filters);
    const ac = new AbortController();
    controller = ac;
    const current = () => !ac.signal.aborted && generation === token && filtersKey(snapshot.filters) === key;
    update({ loading: true, error: null });
    try {
      const response = await request(detailsUrl(filters, beforeSequence), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: ac.signal, headers: { Accept: 'application/json' },
      });
      // Refusal bodies may contain internal diagnostics; never render them.
      if (!response.ok) throw new ApiError(response.status, 'Details request refused');
      const body = await response.text();
      if (!current()) return;
      if (body.length > MAX_DETAIL_CHARS) throw new Error('Details page exceeds its response bound');
      const page = JSON.parse(body) as PracticeHistoryDetailsResult;
      if (page.schema !== 'replay.practice-history/2' || page.scope !== filters.scope || page.fiction !== true
        || !Array.isArray(page.items) || page.items.length > MAX_DETAIL_ITEMS || page.summary?.basis !== 'returned-page-only') {
        throw new Error('Unsupported details response');
      }
      update({ items: mergeDetailItems(beforeSequence === undefined ? [] : snapshot.items, page.items), page,
        cursor: detailsCursor(page, beforeSequence), loading: false });
    } catch (error) {
      if (!current()) return;
      update({ loading: false, error: detailsError(error), ...(denied(error) ? { items: [], page: null, cursor: null } : {}) });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    search: (filters: HistoryFilters) => {
      cancel();
      update({ filters: { ...filters, query: filters.query.trim() }, items: [], page: null, cursor: null, error: null });
      return load();
    },
    more: () => snapshot.loading || snapshot.cursor === null ? Promise.resolve() : load(snapshot.cursor),
    cancel,
  };
}

export type HistoryMode = 'activity' | 'details';

/**
 * Only the visible mode fetches. On switching, reload when the target has nothing current for these
 * filters, or when the mode being left holds no page after an error (a refusal clears it; never reveal older rows).
 */
export function modeNeedsSearch(target: { filters: HistoryFilters; page: unknown; loading: boolean },
  filters: HistoryFilters, leaving: { page: unknown; error: string | null }): boolean {
  return target.loading || target.page === null || filtersKey(target.filters) !== filtersKey(filters)
    || (leaving.page === null && leaving.error !== null);
}

/**
 * Explicit adapter to the /1 item the existing opener expects. It opens the recorded event at its recorded tick;
 * statement timing is never used as a navigation tick.
 */
export function detailToHistoryItem(item: PracticeHistoryDetailItem): PracticeHistoryItem {
  return {
    eventId: item.eventId, sequence: item.sequence, tick: item.ticks.recorded, observedTick: item.ticks.observed,
    recordedAt: item.recordedAt, kind: item.kind, actor: item.actor, side: item.side, summary: item.summary,
    exercise: item.exercise, sourceIds: item.sources.items.map(source => source.id), commitmentRatio: item.commitmentRatio,
    rationaleRecorded: item.kind === 'command' && item.statement !== null,
  };
}

/** A decision note's order, only when the server resolved it in this scope. */
export function referencedOrderItem(item: PracticeHistoryDetailItem): PracticeHistoryItem | null {
  const { commandEventId, orderTick } = item.reference;
  if (item.kind !== 'decision_log' || commandEventId === null || orderTick === null) return null;
  return { ...detailToHistoryItem(item), eventId: commandEventId, kind: 'command', tick: orderTick,
    observedTick: item.sources.statusTickBasis === 'order-observed-tick' ? item.sources.statusTick : null, rationaleRecorded: false };
}

const KIND_LABELS: Record<string, string> = {
  command: 'Order', decision_log: 'Decision note', assessment_log: 'Assessment', task_created: 'Watch',
};
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

export function timingLabel(statement: PracticeStatement): string {
  const tick = statement.authoredTick === null ? 'authored tick not recorded' : `authored at tick ${statement.authoredTick}`;
  if (statement.timing === 'contemporaneous') return `Written at the time of the action · ${tick}`;
  if (statement.timing === 'post-hoc') return `Written afterwards (post-hoc) · ${tick}`;
  return `When this was written is not recorded · ${tick}`;
}

export function sourceStatusLabel(status: PracticeSourceStatus): string {
  switch (status.status) {
    case 'current': return 'Current';
    case 'superseded': return status.supersededBy ? `Superseded by ${status.supersededBy}` : 'Superseded';
    case 'disputed': return `Disputed${status.disputedWith?.length ? ` by ${status.disputedWith.join(', ')}` : ''}`
      + (status.disputesOmitted ? ` and ${status.disputesOmitted} more` : '');
    case 'unavailable': return 'Not among reports released to this side';
    case 'not-evaluated': return 'Not evaluated (required tick not recorded)';
  }
}

const statusChanged = (a: PracticeSourceStatus, b: PracticeSourceStatus) => sourceStatusLabel(a) !== sourceStatusLabel(b)
  && a.status !== 'not-evaluated' && b.status !== 'not-evaluated';

export function pageNotice(page: PracticeHistoryDetailsResult): string | null {
  switch (page.page.truncatedBy) {
    case 'character-budget': return `This page ended early to stay within the ${page.limits.maxResponseChars.toLocaleString('en-US')}-character response limit. Load more continues after the last record shown.`;
    case 'page-limit': return `More matching records follow this page of ${page.page.requestedLimit}.`;
    case 'scan-limit': return `Search stopped after checking ${page.page.scannedEvents} retained events. Load more continues with older records; this is not the end of your history.`;
    default: return null;
  }
}

export function DetailsResults({ page, items, onOpen, opening = false }: {
  page: PracticeHistoryDetailsResult; items: PracticeHistoryDetailItem[]; onOpen: (item: PracticeHistoryItem) => void; opening?: boolean;
}) {
  const counts = page.summary;
  const notice = pageNotice(page);
  return <>
    <p className="small" role="status">{items.length} unique records loaded. Latest returned page: {page.page.returned} records · {counts.writtenStatements} with written statements
      {' '}· {counts.citationOnly} citing sources without a written reason · {counts.commands} orders · {counts.decisionStatements} decision notes · {counts.assessments} assessments
      {' '}· {counts.watches} watches · {counts.branchEvents} branch events. These are page counts, not full-history totals.</p>
    {notice && <p className="small" role="note">{notice}</p>}
    <details className="small muted"><summary>About these records</summary><p>{page.notice}</p></details>
    <p className="small muted">Search covers {page.limits.eligibleExercises} eligible completed exercises, including written statement text; up to {DETAILS_PAGE_SIZE} records per request.
      {page.limits.exerciseCatalogTruncated && ' The exercise catalog is truncated; older games may be omitted.'}</p>
    {items.length === 0 ? <Empty>{page.page.truncatedBy === 'scan-limit'
      ? 'No matches in the records checked so far. Load more to keep searching older records.'
      : 'No matching completed practice records in this search scope.'}</Empty> : <ul className="obs-list">
      {items.map(item => <DetailRecord key={itemKey(item)} item={item} scope={page.scope} onOpen={onOpen} opening={opening} />)}
    </ul>}
  </>;
}

function DetailRecord({ item, scope, onOpen, opening }: {
  item: PracticeHistoryDetailItem; scope: PracticeHistoryDetailsResult['scope']; onOpen: (item: PracticeHistoryItem) => void; opening: boolean;
}) {
  const order = referencedOrderItem(item);
  const { sources } = item;
  return <li className="obs" style={{ overflowWrap: 'anywhere' }}>
    <div className="obs-head"><strong>{item.exercise.name}</strong>
      <span className="tag tag-muted">{item.exercise.kind === 'branch' || item.exercise.parentId ? 'Branch · informed practice' : 'Original'}</span></div>
    <p className="small">{kindLabel(item.kind)}{scope === 'workroom' && ` · Actor: ${item.actor}`}{item.side && ` · Side: ${item.side}`}
      {' '}· Scenario: {item.exercise.scenarioId ?? 'not recorded'}{item.exercise.scenarioVersion && ` · version ${item.exercise.scenarioVersion}`} · Assistance: {item.exercise.assistance}</p>
    <p>{item.summary}</p>

    <section aria-label="Reason">
      {item.statement ? <>
        <p className="small"><strong>Written reason</strong> · {timingLabel(item.statement)}
          {item.statement.authoredAt && <> · <time dateTime={item.statement.authoredAt}>{item.statement.authoredAt}</time></>}</p>
        <blockquote className="obs-rationale" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{item.statement.text}{item.statement.truncated && '…'}</blockquote>
        {item.statement.truncated && <p className="small muted">Statement clipped for display; the full text remains in the exercise record.</p>}
      </> : item.reason === 'citation-only'
        ? <p className="small"><strong>No written reason</strong> · Sources were cited. A citation shows what was referenced, not why.</p>
        : <p className="small"><strong>No written reason or source citation recorded.</strong></p>}
    </section>

    {item.kind === 'command' && item.reference.commandId && <p className="small mono">Order ID: {item.reference.commandId}</p>}
    {item.kind === 'decision_log' && (order
      ? <p className="small">Note on order event <span className="mono">{order.eventId}</span> at tick {order.tick}.{' '}
        <button className="btn btn-sm" type="button" disabled={opening} onClick={() => onOpen(order)}
          aria-label={`Open referenced order ${order.eventId} in ${item.exercise.name}`}>Open referenced order</button></p>
      : <p className="small muted">The order this note refers to is not readable in this record scope.</p>)}

    <p className="small">Viewed: {item.ticks.observed === null ? 'not recorded' : `tick ${item.ticks.observed}`}
      {item.ticks.observationBasis && ` (${item.ticks.observationBasis})`} · Recorded: tick {item.ticks.recorded}
      {' '}· <time dateTime={item.recordedAt}>{item.recordedAt}</time></p>
    {item.commitmentRatio !== null && <p className="small">Recorded commitment: {Math.round(item.commitmentRatio * 100)}%</p>}

    {sources.cited > 0 && <section aria-label="Cited sources">
      <p className="small"><strong>Cited sources: {sources.cited}</strong> · Status then: {sources.statusTick === null ? 'no viewed tick recorded'
        : `tick ${sources.statusTick}${sources.statusTickBasis === 'order-observed-tick' ? ' (when the referenced order was viewed)' : ' (viewed tick)'}`}
        {' '}· Status at completion: {sources.completedCutoffTick === null ? 'cutoff tick not recorded' : `tick ${sources.completedCutoffTick}`}</p>
      {sources.items.length > 0 && <ul className="obs-cites">
        {sources.items.map(source => <li className="obs-cite small" key={source.id}>
          <span className="mono">{source.id}</span>
          {statusChanged(source.atViewedTick, source.atCompletedCutoff) && <span className="tag tag-warn"> Changed by completion</span>}
          {source.derivedFrom && <span className="muted"> · derived from <span className="mono">{source.derivedFrom}</span></span>}
          {source.inheritedFrom && <span className="muted"> · inherited from original <span className="mono">{source.inheritedFrom}</span></span>}
          <br />Then: {sourceStatusLabel(source.atViewedTick)} · At completion: {sourceStatusLabel(source.atCompletedCutoff)}
        </li>)}
      </ul>}
      {sources.truncated === 'source-limit' && <p className="small muted">Showing the first {sources.items.length} of the cited sources.</p>}
      {sources.truncated === 'character-budget' && <p className="small muted">Source details were withheld for this record to fit the response limit.</p>}
      {sources.omittedIds > 0 && <p className="small muted">{sources.omittedIds} cited source {sources.omittedIds === 1 ? 'ID is' : 'IDs are'} not shown because {sources.omittedIds === 1 ? 'it' : 'they'} could not be displayed exactly.</p>}
    </section>}

    <p className="small mono">Exercise ID: {item.exercise.id} · Event ID: {item.eventId}</p>
    {item.exercise.parentId && <p className="small mono">Original exercise ID: {item.exercise.parentId} · Fork tick: {item.exercise.forkTick ?? 'not recorded'}</p>}
    <button className="btn btn-sm" type="button" disabled={opening} onClick={() => onOpen(detailToHistoryItem(item))}
      aria-label={`Open ${item.exercise.name} event ${item.eventId} in Review`}>Open event in Review</button>
  </li>;
}
