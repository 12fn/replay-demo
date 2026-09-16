import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PracticeHistoryItem, PracticeHistoryResult } from '../../learning/practice-history-types';
import { PracticeObservationsPanel } from './PracticeObservationsPanel';
import { createDetailsLoader, DetailsResults, modeNeedsSearch, type HistoryMode } from './PracticeDetailsPanel';
import { api, ApiError } from '../api';
import type { ViewContext } from '../App';
import { nativeOf } from '../native-api';
import { Busy, Empty, InlineError, Panel } from './ui';

export interface HistoryFilters { query: string; scenarioId: string; scope: 'mine' | 'workroom' }
const ownRecords: HistoryFilters = { query: '', scenarioId: '', scope: 'mine' };

function historySessionKey(ov: ViewContext['ov']): string {
  return JSON.stringify([ov.identity.mode, ov.identity.subject, nativeOf(ov)?.workroomId ?? null]);
}

/** Session context is only a local invalidation key, never request authority. */
export function historyContextKey(ov: ViewContext['ov']): string {
  return JSON.stringify([historySessionKey(ov), ov.identity.role]);
}

export function historyRequestKey(filters: HistoryFilters): string {
  return JSON.stringify([filters.scope, filters.query.trim(), filters.scenarioId]);
}

export function historyUrl(filters: HistoryFilters, beforeSequence?: number): string {
  const params = new URLSearchParams({ scope: filters.scope, query: filters.query.trim(), limit: '20' });
  if (filters.scenarioId) params.set('scenarioId', filters.scenarioId);
  if (beforeSequence !== undefined) params.set('beforeSequence', String(beforeSequence));
  return `/api/practice/history?${params}`;
}

export function mergeHistoryItems(previous: PracticeHistoryItem[], page: PracticeHistoryItem[]): PracticeHistoryItem[] {
  const seen = new Set<string>();
  return [...previous, ...page].filter(item => {
    const key = JSON.stringify([item.exercise.id, item.eventId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function historyCursor(page: PracticeHistoryResult, beforeSequence?: number): number | null {
  const cursor = page.nextBeforeSequence;
  return page.hasMore && cursor !== null && Number.isSafeInteger(cursor) && cursor > 0
    && (beforeSequence === undefined || cursor < beforeSequence) ? cursor : null;
}

export function historyError(error: unknown): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'You are not authorized to view these practice records. Check your signed-in session and workroom access.';
  }
  return 'Practice history is unavailable. Please try again.';
}

interface HistorySnapshot {
  filters: HistoryFilters;
  items: PracticeHistoryItem[];
  page: PracticeHistoryResult | null;
  scenarios: PracticeHistoryResult['scenarios'];
  cursor: number | null;
  loading: boolean;
  error: string | null;
}

/** One outstanding page per search; generations also reject A → B → A races. */
export function createHistoryLoader(request: typeof fetch = (...args) => fetch(...args)) {
  let snapshot: HistorySnapshot = { filters: ownRecords, items: [], page: null, scenarios: [], cursor: null, loading: false, error: null };
  let generation = 0;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<HistorySnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  const cancel = () => { generation++; controller?.abort(); controller = null; };
  const load = async (beforeSequence?: number) => {
    const token = generation;
    const filters = snapshot.filters;
    const key = historyRequestKey(filters);
    const ac = new AbortController();
    controller = ac;
    const current = () => !ac.signal.aborted && generation === token && historyRequestKey(snapshot.filters) === key;
    update({ loading: true, error: null });
    try {
      const response = await request(historyUrl(filters, beforeSequence), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: ac.signal, headers: { Accept: 'application/json' },
      });
      // Refusal bodies may contain internal diagnostics; never render them.
      if (!response.ok) throw new ApiError(response.status, 'History request refused');
      const page = await response.json() as PracticeHistoryResult;
      if (!current()) return;
      if (page.schema !== 'replay.practice-history/1' || page.scope !== filters.scope || page.fiction !== true
        || !Array.isArray(page.items) || page.items.length > 20 || page.summary?.basis !== 'returned-page-only') {
        throw new Error('Unsupported history response');
      }
      update({ items: mergeHistoryItems(beforeSequence === undefined ? [] : snapshot.items, page.items), page,
        scenarios: page.scenarios, cursor: historyCursor(page, beforeSequence), loading: false });
    } catch (error) {
      if (!current()) return;
      const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
      update({ loading: false, error: historyError(error), ...(denied ? { items: [], page: null, scenarios: [], cursor: null } : {}) });
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

/** Seek in the explicitly selected exercise before Review resolves the event ID. */
export async function prepareHistoryEvidence(item: PracticeHistoryItem, ctx: ViewContext, current: () => boolean = () => true) {
  if (!current()) return;
  if (ctx.ov.activeId !== item.exercise.id) {
    const expected = ctx.ov.navigationRevision === undefined ? undefined : {
      activeId: ctx.ov.activeId, playbackTick: ctx.ov.playbackTick, revision: ctx.ov.navigationRevision,
    };
    await api.select(item.exercise.id, expected);
  }
  if (!current()) return;
  await api.replay(item.tick, item.exercise.id);
  if (current()) await ctx.refresh();
}

export function PracticeHistoryPanel({ ctx }: { ctx: ViewContext }) {
  const [opening, setOpening] = useState(false);
  const [pending, setPending] = useState<{ item: PracticeHistoryItem; session: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const latest = useRef(ctx);
  latest.current = ctx;
  const session = historySessionKey(ctx.ov);
  useEffect(() => () => { operation.current++; }, []);

  const open = async (item: PracticeHistoryItem) => {
    if (opening) return;
    const token = ++operation.current;
    const current = () => operation.current === token && historySessionKey(latest.current.ov) === session;
    setOpening(true);
    setError(null);
    try {
      await prepareHistoryEvidence(item, ctx, current);
      if (current()) setPending({ item, session });
      else if (operation.current === token) setOpening(false);
    } catch (e) {
      if (current()) {
        setOpening(false);
        setError(e instanceof ApiError && (e.status === 401 || e.status === 403)
          ? 'You are not authorized to open this exercise record.'
          : 'This exercise record could not be opened. Please try again.');
      } else if (operation.current === token) setOpening(false);
    }
  };

  useEffect(() => {
    if (!pending) return;
    if (pending.session !== session) { setPending(null); setOpening(false); return; }
    const { item } = pending;
    // App clears pending evidence on activeId changes. Deliver on the next task after those effects.
    const ready = ctx.ov.activeId === item.exercise.id && ctx.ov.playbackTick === item.tick;
    const timer = window.setTimeout(() => {
      const now = latest.current;
      if (pending.session !== historySessionKey(now.ov)) { setPending(null); setOpening(false); return; }
      if (now.ov.activeId === item.exercise.id && now.ov.playbackTick === item.tick) {
        if (item.side === 'blue' || item.side === 'red') now.setPerspective(item.side);
        now.openEvidence(item.eventId, item.tick);
      } else setError('The selected exercise record is not available yet. Please try opening it again.');
      setPending(null);
      setOpening(false);
    }, ready ? 0 : 5000);
    return () => window.clearTimeout(timer);
  }, [pending, ctx.ov.activeId, ctx.ov.playbackTick, session]);

  return <Panel title="Practice history" aside={<span className="tag tag-muted">Completed records · fictional exercises</span>}>
    <PracticeHistorySearch key={historyContextKey(ctx.ov)} ctx={ctx} onOpen={item => void open(item)} opening={opening} />
    <InlineError message={error} />
  </Panel>;
}

function PracticeHistorySearch({ ctx, onOpen, opening }: { ctx: ViewContext; onOpen: (item: PracticeHistoryItem) => void; opening: boolean }) {
  const loader = useMemo(() => createHistoryLoader(), []);
  const details = useMemo(() => createDetailsLoader(), []);
  const activity = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  const detail = useSyncExternalStore(details.subscribe, details.getSnapshot, details.getSnapshot);
  const [mode, setMode] = useState<HistoryMode>('activity');
  const [filters, setFilters] = useState<HistoryFilters>(ownRecords);
  const [draft, setDraft] = useState('');
  useEffect(() => { void loader.search(ownRecords); return loader.cancel; }, [loader]);
  useEffect(() => details.cancel, [details]);
  // Selectors are shared by both views; only the visible view fetches.
  const search = (next: HistoryFilters) => {
    const normalized = { ...next, query: next.query.trim() };
    setFilters(normalized);
    void (mode === 'activity' ? loader.search(normalized) : details.search(normalized));
  };
  const switchMode = (next: HistoryMode) => {
    if (next === mode) return;
    const leaving = next === 'details' ? loader : details, target = next === 'details' ? details : loader;
    const left = leaving.getSnapshot();
    if (left.loading) leaving.cancel();
    setMode(next);
    if (modeNeedsSearch(target.getSnapshot(), filters, left)) void target.search(filters);
  };
  const state = mode === 'activity' ? activity : detail;
  const current = mode === 'activity' ? loader : details;
  const scenarios = [...activity.scenarios, ...(detail.page?.scenarioIds ?? [])
    .filter(id => !activity.scenarios.some(s => s.id === id)).map(id => ({ id, name: id }))];
  const native = nativeOf(ctx.ov);
  return <>
    <p className="small">Search retained actions from completed games. Branches are informed practice after exposure to the original exercise.</p>
    <p className="small muted">Current role: {ctx.ov.identity.role} · {native?.context.workroomName ?? ctx.ov.identity.organization}.
      {' '}For Tomo review, reference the exercise and event IDs below with this role context. Historical seat roles are not supplied by these records.</p>
    <div className="action-row" role="group" aria-label="Practice history view">
      <button type="button" className={`btn btn-sm ${mode === 'activity' ? 'btn-primary' : ''}`} aria-pressed={mode === 'activity'} onClick={() => switchMode('activity')}>Activity</button>
      <button type="button" className={`btn btn-sm ${mode === 'details' ? 'btn-primary' : ''}`} aria-pressed={mode === 'details'} onClick={() => switchMode('details')}>Reasons &amp; sources</button>
    </div>
    {mode === 'details' && <p className="small muted">What was written for each decision, when it was written, and whether cited reports changed between the tick they were viewed and the end of the exercise.</p>}
    <form className="action-row" role="search" aria-label="Search practice history" onSubmit={e => { e.preventDefault(); search({ ...filters, query: draft }); }}>
      <label className="small" htmlFor="practice-history-query">Search records</label>
      <input id="practice-history-query" type="search" className="input" value={draft} maxLength={120}
        onChange={e => setDraft(e.target.value)} placeholder={mode === 'details' ? 'Exercise, scenario, action, or written reason' : 'Exercise, scenario, or action'} />
      <button className="btn btn-sm" type="submit">Search</button>
      <label className="small" htmlFor="practice-history-scenario">Scenario</label>
      <select id="practice-history-scenario" className="select" value={filters.scenarioId}
        onChange={e => search({ ...filters, scenarioId: e.target.value })}>
        <option value="">All scenarios</option>
        {filters.scenarioId && !scenarios.some(s => s.id === filters.scenarioId) && <option value={filters.scenarioId}>{filters.scenarioId}</option>}
        {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {ctx.ov.identity.role === 'instructor' ? <>
        <label className="small" htmlFor="practice-history-scope">Record scope</label>
        <select id="practice-history-scope" className="select" value={filters.scope}
          onChange={e => search({ ...filters, scope: e.target.value === 'workroom' ? 'workroom' : 'mine' })}>
          <option value="mine">My records</option><option value="workroom">Workroom records</option>
        </select>
      </> : <span className="tag tag-muted">My records</span>}
    </form>
    {state.loading && <Busy label={state.items.length ? 'Loading more records…' : mode === 'details' ? 'Searching reasons and sources…' : 'Searching completed records…'} />}
    <InlineError message={state.error} />
    {state.error && <button type="button" className="btn btn-sm" onClick={() => void (state.page ? current.more() : current.search(filters))}>Retry</button>}
    {mode === 'activity' && activity.page && <HistoryResults page={activity.page} items={activity.items} onOpen={onOpen} opening={opening} />}
    {mode === 'details' && detail.page && <DetailsResults page={detail.page} items={detail.items} onOpen={onOpen} opening={opening} />}
    {state.cursor !== null && <button className="btn btn-sm" type="button" disabled={state.loading} onClick={() => void current.more()}>Load more</button>}
    {opening && <Busy label="Opening exercise record…" />}
  </>;
}

export function HistoryResults({ page, items, onOpen, opening = false }: {
  page: PracticeHistoryResult; items: PracticeHistoryItem[]; onOpen: (item: PracticeHistoryItem) => void; opening?: boolean;
}) {
  const counts = page.summary;
  return <>
    <p className="small" role="status">{items.length} unique records loaded. Latest returned page: {page.items.length} records · {counts.commands} commands · {counts.assessments} assessments · {counts.watches} watches
      {' '}· {counts.commandsCitingSources} commands citing sources · {counts.commandsWithRecordedReason} commands with recorded reason · {counts.branchEvents} branch events. These are page counts, not full-history totals.</p>
    <p className="small muted">{page.notice}</p>
    <p className="small muted">Search covers {page.limits.eligibleExercises} eligible completed exercises in the retained catalog; up to 20 records per request.
      {page.limits.exerciseCatalogTruncated && ' The exercise catalog is truncated; older games may be omitted.'}</p>
    <PracticeObservationsPanel page={page} onOpen={onOpen} opening={opening} />
    {items.length === 0 ? <Empty>No matching completed practice records in this search scope.</Empty> : <ul className="obs-list">
      {items.map(item => <li className="obs" key={JSON.stringify([item.exercise.id, item.eventId])} style={{ overflowWrap: 'anywhere' }}>
        <div className="obs-head"><strong>{item.exercise.name}</strong><span className="tag tag-muted">{item.exercise.kind === 'branch' || item.exercise.parentId ? 'Branch · informed practice' : 'Original'}</span></div>
        <p className="small">Scenario: {page.scenarios.find(s => s.id === item.exercise.scenarioId)?.name ?? item.exercise.scenarioId ?? 'Not recorded'}
          {item.exercise.scenarioVersion && ` · version ${item.exercise.scenarioVersion}`} · {item.exercise.status} · Assistance: {item.exercise.assistance}</p>
        <p>{item.summary}</p>
        <p className="small">Type: {item.kind}{page.scope === 'workroom' && ` · Actor: ${item.actor}`}{item.side && ` · Side: ${item.side}`}</p>
        <p className="small">Observed: {item.observedTick === null ? 'not recorded' : `tick ${item.observedTick}`} · Recorded: tick {item.tick}
          {' '}· <time dateTime={item.recordedAt}>{item.recordedAt}</time></p>
        {item.commitmentRatio !== null && <p className="small">Recorded commitment: {Math.round(item.commitmentRatio * 100)}%</p>}
        {item.sourceIds.length > 0 && <p className="small">Source IDs: {item.sourceIds.join(', ')}</p>}
        <p className="small">{item.rationaleRecorded ? 'Written reason recorded' : 'No written reason recorded'}</p>
        <p className="small mono">Exercise ID: {item.exercise.id} · Event ID: {item.eventId}</p>
        {item.exercise.parentId && <p className="small mono">Original exercise ID: {item.exercise.parentId} · Fork tick: {item.exercise.forkTick ?? 'not recorded'}</p>}
        <button className="btn btn-sm" type="button" disabled={opening} onClick={() => onOpen(item)} aria-label={`Open ${item.exercise.name} event ${item.eventId} in Review`}>Open event in Review</button>
      </li>)}
    </ul>}
  </>;
}
