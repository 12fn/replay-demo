import { ArrowLeft, BookOpen, ExternalLink, RotateCcw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ViewContext } from '../App';
import { ApiError } from '../api';
import {
  CATALOG_MAX_LIMIT, CATALOG_PAGE_LIMIT, KIND_LABELS, KIND_ORDER, ROLE_LABELS,
  catalogApi, catalogErrorMessage, formatFieldValue, humanize, isAbortError, kindLabel, relationLabel, safeExternalUrl, sortCaseEvents,
  type CatalogAor, type CatalogAorId, type CatalogKind, type CatalogPage, type CatalogQuery, type CatalogRecord, type CatalogRecordDetail,
  type CatalogRelated, type CatalogRole, type CatalogSource, type CatalogSummary,
} from '../catalog-api';
import { Busy, Empty, InlineError } from '../components/ui';
import '../catalog.css';

interface Filters { aorId: CatalogAorId | ''; kind: CatalogKind | ''; role: CatalogRole | ''; query: string; cutoff: string }

interface PageState { page: CatalogPage | null; loading: boolean; error: string | null }

const CATALOG_ROLES: CatalogRole[] = ['commander', 'intelligence', 'instructor'];

/** Experts start from personas: pick a region and role, then a persona, then one of its authored cases. */
function defaultFilters(role: string): Filters {
  const known = (CATALOG_ROLES as string[]).includes(role) ? (role as CatalogRole) : '';
  return { aorId: '', kind: 'persona', role: known, query: '', cutoff: '' };
}

function parseCutoff(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 1000000 ? n : undefined;
}

function tickText(n: unknown): string | null {
  return typeof n === 'number' && Number.isFinite(n) ? `T+${n}` : null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const RECORD_ID = /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9/_-]+$/;

/** Only the persona's authored cases, so all three render instead of the first page of mixed reports and events. */
export function personaCasesQuery(personaId: string, cutoffTick?: number): CatalogQuery {
  return { personaId, kind: 'case', cutoffTick, offset: 0, limit: CATALOG_PAGE_LIMIT };
}

export function caseRecordsQuery(caseId: string, cutoffTick?: number): CatalogQuery {
  return { caseId, cutoffTick, offset: 0, limit: CATALOG_MAX_LIMIT };
}

/** Splits a case page into its ordered decision/review events and its report chain; the case itself is dropped. */
export function partitionCaseRecords(items: CatalogRecord[], caseId?: string) {
  const own = items.filter((r) => r.id !== caseId);
  const seq = (r: CatalogRecord) => (typeof r.fields?.sequence === 'number' ? r.fields.sequence : Number.POSITIVE_INFINITY);
  // Stable sort: reports without a sequence keep their tick order.
  const reports = sortCaseEvents(own.filter((r) => r.kind === 'report')).sort((a, b) => seq(a) - seq(b));
  return { events: sortCaseEvents(own.filter((r) => r.kind === 'event')), reports };
}

/** Short "R1" handles for a case's reports, keyed by record id. */
export function reportHandles(reports: CatalogRecord[]): Map<string, string> {
  return new Map(reports.map((r, i) => [r.id, `R${typeof r.fields?.sequence === 'number' ? r.fields.sequence : i + 1}`]));
}

const REPORT_RELATIONS: [field: string, label: string][] = [
  ['derivedFromReportId', 'Derived from'], ['supersedesReportId', 'Supersedes'], ['disputesReportIds', 'Disputes'],
  ['corroboratesReportId', 'Corroborates'], ['supersededByReportId', 'Superseded by'],
];

/** Source-chain relationships a report states about other released reports in the same case. */
export function reportRelations(report: CatalogRecord, handles: Map<string, string>): { label: string; targetId: string; handle: string }[] {
  return REPORT_RELATIONS.flatMap(([field, label]) => {
    const value = report.fields?.[field];
    const targets = typeof value === 'string' ? [value] : strings(value);
    return targets.filter((t) => handles.has(t)).map((targetId) => ({ label, targetId, handle: handles.get(targetId) as string }));
  });
}

/** Loads one bounded catalog page; a new query or unmount aborts the in-flight request so stale pages never land. */
function useCatalogPage(query: CatalogQuery | null, delayMs = 0): PageState {
  const key = query ? JSON.stringify(query) : '';
  const latest = useRef(query);
  latest.current = query;
  const [state, setState] = useState<PageState>({ page: null, loading: Boolean(query), error: null });
  useEffect(() => {
    const q = latest.current;
    if (!q) { setState({ page: null, loading: false, error: null }); return; }
    const controller = new AbortController();
    setState((s) => ({ page: s.page, loading: true, error: null }));
    const timer = window.setTimeout(() => {
      catalogApi.search(q, controller.signal).then(
        (page) => { if (!controller.signal.aborted) setState({ page, loading: false, error: null }); },
        (err) => { if (!controller.signal.aborted && !isAbortError(err)) setState({ page: null, loading: false, error: catalogErrorMessage(err) }); },
      );
    }, delayMs);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, delayMs]);
  return state;
}

export function CatalogView({ ctx }: { ctx: ViewContext }) {
  const currentRole = ctx.ov.identity.role;
  const [summary, setSummary] = useState<CatalogSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(() => defaultFilters(currentRole));
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [trail, setTrail] = useState<string[]>([]);
  const selectedId = trail.length ? trail[trail.length - 1] : null;

  useEffect(() => {
    const controller = new AbortController();
    catalogApi.summary(controller.signal).then(
      (s) => { if (!controller.signal.aborted) setSummary(s); },
      (err) => { if (!controller.signal.aborted && !isAbortError(err)) setSummaryError(catalogErrorMessage(err)); },
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(filters.query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [filters.query]);

  const cutoffTick = parseCutoff(filters.cutoff);
  const searchQuery = useMemo<CatalogQuery>(() => ({
    query: debouncedQuery || undefined, aorId: filters.aorId || undefined, kind: filters.kind || undefined,
    role: filters.role || undefined, cutoffTick, offset, limit: CATALOG_PAGE_LIMIT,
  }), [debouncedQuery, filters.aorId, filters.kind, filters.role, cutoffTick, offset]);
  const results = useCatalogPage(searchQuery);

  const update = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setOffset(0); };
  const chooseAor = (aorId: CatalogAorId | '') => { update({ aorId }); setTrail([]); };
  const reset = () => { setFilters(defaultFilters(currentRole)); setDebouncedQuery(''); setOffset(0); setTrail([]); };
  const open = useCallback((id: string) => setTrail((t) => (t[t.length - 1] === id ? t : [...t.slice(-19), id])), []);
  const back = () => setTrail((t) => t.slice(0, -1));

  const aors = summary?.aors ?? [];
  const aor = aors.find((a) => a.id === filters.aorId) ?? null;
  const aorName = (id: string) => aors.find((a) => a.id === id)?.name ?? humanize(id);
  const defaults = defaultFilters(currentRole);
  const filtered = Boolean(filters.aorId || filters.kind !== defaults.kind || filters.query.trim() || filters.cutoff.trim() || filters.role !== defaults.role);
  const cutoffInvalid = filters.cutoff.trim() !== '' && cutoffTick === undefined;
  const roleLabel = ROLE_LABELS[currentRole as CatalogRole] ?? humanize(currentRole);

  return (
    <div className="catalog">
      <header className="catalog-head">
        <div className="catalog-title">
          <BookOpen size={18} aria-hidden="true" />
          <div>
            <h1>Scenario library</h1>
            <p className="catalog-lede">
              Read-only preparation material. You are signed in as <strong>{roleLabel}</strong>; browsing personas never changes that or grants permissions.
            </p>
          </div>
        </div>
        {summary && <span className="catalog-version mono" title={`Seed ${summary.seed}`}>{summary.version}</span>}
      </header>

      {summaryError && <InlineError message={summaryError} />}
      {summary?.notice && <p className="catalog-notice"><SyntheticBadge /> <span>{summary.notice}</span></p>}

      <div className="catalog-filters">
        <nav className="catalog-aors" aria-label="Area of responsibility">
          <button type="button" className={`catalog-aor ${filters.aorId === '' ? 'is-active' : ''}`} aria-pressed={filters.aorId === ''} onClick={() => chooseAor('')}>
            <span className="catalog-aor-name">All regions</span>
          </button>
          {aors.map((a) => (
            <button key={a.id} type="button" className={`catalog-aor ${filters.aorId === a.id ? 'is-active' : ''}`} aria-pressed={filters.aorId === a.id} onClick={() => chooseAor(a.id)}>
              <span className="catalog-aor-name">{a.name}</span>
              <CapabilityBadge aor={a} />
            </button>
          ))}
        </nav>

        <div className="catalog-toolbar">
          <label className="catalog-field">
            <span>Role</span>
            <select className="catalog-select" value={filters.role} onChange={(e) => update({ role: e.target.value as CatalogRole | '' })}>
              <option value="">All roles</option>
              {CATALOG_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}{r === currentRole ? ' (your role)' : ''}</option>)}
            </select>
          </label>
          <label className="catalog-field">
            <span>Kind</span>
            <select className="catalog-select" value={filters.kind} onChange={(e) => update({ kind: e.target.value as CatalogKind | '' })}>
              <option value="">All kinds</option>
              {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="catalog-field catalog-field-grow">
            <span>Search</span>
            <span className="catalog-search">
              <Search size={14} aria-hidden="true" />
              <input type="search" placeholder="Titles, summaries and tags" value={filters.query} onChange={(e) => update({ query: e.target.value })} aria-label="Search the scenario library" />
              {filters.query && <button type="button" className="catalog-icon-btn" onClick={() => update({ query: '' })} aria-label="Clear search"><X size={13} /></button>}
            </span>
          </label>
          <label className="catalog-field" title="Hide records released after this tick. Persona and case summaries release only after their final review.">
            <span>Released by tick</span>
            <input className={`catalog-input catalog-cutoff ${cutoffInvalid ? 'is-invalid' : ''}`} inputMode="numeric" placeholder="Any" value={filters.cutoff}
              onChange={(e) => update({ cutoff: e.target.value })} aria-invalid={cutoffInvalid} />
          </label>
          <button type="button" className="catalog-btn" onClick={reset} disabled={!filtered && trail.length === 0}><RotateCcw size={13} aria-hidden="true" /> Reset</button>
        </div>
        {cutoffInvalid && <p className="catalog-hint catalog-hint-bad">Enter a whole tick number, or clear the field to show every release.</p>}
        {cutoffTick !== undefined && (
          <p className="catalog-hint">Showing only what was released by T+{cutoffTick}. Persona and case summaries contain hindsight, so they appear only after their final review tick.</p>
        )}

        {summary && (
          <section className="catalog-counts" aria-label="Library totals across all regions">
            <span className="catalog-counts-label">Library totals · all regions</span>
            {KIND_ORDER.filter((k) => typeof summary.counts?.[k] === 'number').map((k) => (
              <button key={k} type="button" className={`catalog-count ${filters.kind === k ? 'is-active' : ''}`} aria-pressed={filters.kind === k}
                onClick={() => update({ kind: filters.kind === k ? '' : k })}>
                <span className="catalog-count-value">{summary.counts[k]}</span> {KIND_LABELS[k]}
              </button>
            ))}
            <span className="catalog-count catalog-count-total"><span className="catalog-count-value">{summary.total}</span> records</span>
          </section>
        )}
      </div>

      {aor && <AorBrief aor={aor} sources={summary?.sources ?? []} />}

      <div className="catalog-body">
        <section className="catalog-results" aria-label="Results" aria-busy={results.loading}>
          <ResultsHeader state={results} kind={filters.kind} />
          <InlineError message={results.error} />
          {results.page && results.page.items.length === 0 && !results.loading && (
            <Empty>No records match these filters.{filtered ? ' Try another role, kind or cutoff, or reset.' : ''}</Empty>
          )}
          <ul className="catalog-list">
            {(results.page?.items ?? []).map((r) => (
              <li key={r.id}>
                <RecordCard record={r} aorName={aorName(r.aorId)} active={r.id === selectedId} onOpen={open} />
              </li>
            ))}
          </ul>
          {results.page && (results.page.offset > 0 || results.page.hasMore) && (
            <div className="catalog-pager">
              <button type="button" className="catalog-btn" disabled={results.loading || results.page.offset === 0}
                onClick={() => setOffset(Math.max(0, (results.page?.offset ?? 0) - (results.page?.limit || CATALOG_PAGE_LIMIT)))}>Previous</button>
              <button type="button" className="catalog-btn" disabled={results.loading || !results.page.hasMore}
                onClick={() => setOffset((results.page?.offset ?? 0) + (results.page?.limit || CATALOG_PAGE_LIMIT))}>Next</button>
            </div>
          )}
        </section>

        <section className="catalog-detail" aria-label="Record details">
          {selectedId
            ? <RecordPanel key={`${selectedId}:${cutoffTick ?? 'all'}`} id={selectedId} cutoffTick={cutoffTick} canGoBack={trail.length > 1} onBack={back} onClose={() => setTrail([])} onOpen={open} aorName={aorName} aors={aors} globalNotice={summary?.notice} />
            : <DetailPlaceholder />}
        </section>
      </div>
    </div>
  );
}

function ResultsHeader({ state, kind }: { state: PageState; kind: CatalogKind | '' }) {
  const p = state.page;
  const noun = kind ? KIND_LABELS[kind].toLowerCase() : 'records';
  return (
    <div className="catalog-results-head">
      {p && p.total > 0
        ? <span>{p.offset + 1}–{p.offset + p.items.length} of {p.total} {noun}</span>
        : <span>{state.loading ? '' : p ? `0 ${noun}` : ''}</span>}
      {state.loading && <Busy label="Loading…" />}
    </div>
  );
}

function DetailPlaceholder() {
  return (
    <div className="catalog-placeholder">
      <h2>Choose a persona</h2>
      <ol className="catalog-steps">
        <li>Pick a region and role above.</li>
        <li>Open a persona to see its three authored cases, strengths, limitations and learning focus.</li>
        <li>Open a case for its ordered decision and review timeline and the report chain behind it.</li>
      </ol>
    </div>
  );
}

export function SyntheticBadge() {
  return <span className="catalog-prov catalog-prov-synthetic" title="Authored for training. Not a real person, user, event or assessment.">Synthetic</span>;
}

export function ProvenanceBadge({ provenance }: { provenance: string }) {
  if (provenance === 'synthetic') return <SyntheticBadge />;
  if (provenance === 'public-reference') return <span className="catalog-prov catalog-prov-public" title="Summarizes a public historical source; see the linked original.">Public reference</span>;
  return <span className="catalog-prov">{humanize(provenance)}</span>;
}

export function CapabilityBadge({ aor }: { aor: CatalogAor }) {
  return aor.playableScenarioId
    ? <span className="catalog-cap catalog-cap-playable" title="A playable exercise scenario exists for this AOR.">Playable</span>
    : <span className="catalog-cap catalog-cap-context" title="Reference context only. No playable exercise for this AOR.">Context only</span>;
}

function AorBrief({ aor, sources }: { aor: CatalogAor; sources: CatalogSource[] }) {
  const cited = strings(aor.sourceIds).map((id) => sources.find((s) => s.id === id)).filter((s): s is CatalogSource => Boolean(s));
  return (
    <section className="catalog-aor-brief">
      <div className="catalog-aor-brief-head">
        <h2>{aor.name}</h2>
        <span className="catalog-muted">{aor.theater}</span>
        <span className="catalog-muted">
          {aor.playableScenarioId ? '· Playable exercise region; library records are preparation, not exercise state.' : '· Context only; not playable as an exercise.'}
        </span>
      </div>
      <p>{aor.summary}</p>
      {(strings(aor.focus).length > 0 || cited.length > 0) && (
        <div className="catalog-aor-brief-foot">
          {strings(aor.focus).length > 0 && <TagList label="Focus" items={strings(aor.focus)} />}
          {cited.length > 0 && <ul className="catalog-inline-sources">{cited.map((s) => <li key={s.id}><SourceAnchor source={s} /></li>)}</ul>}
        </div>
      )}
    </section>
  );
}

export function RecordCard({ record, aorName, active, onOpen }: { record: CatalogRecord; aorName: string; active?: boolean; onOpen: (id: string) => void }) {
  const role = record.kind === 'persona' ? strings(record.roles)[0] : undefined;
  return (
    <button type="button" className={`catalog-card ${active ? 'is-active' : ''}`} onClick={() => onOpen(record.id)} aria-current={active || undefined}>
      <span className="catalog-card-meta">
        <span className={`catalog-kind catalog-kind-${record.kind}`}>{kindLabel(record.kind)}</span>
        {role && <span className="catalog-card-role">{ROLE_LABELS[role as CatalogRole] ?? humanize(role)}</span>}
        <span>{aorName}</span>
        <ProvenanceBadge provenance={record.provenance} />
      </span>
      <span className="catalog-card-title">{record.title}</span>
      {record.summary && <span className="catalog-card-summary">{record.summary}</span>}
      {(tickText(record.observedTick) || tickText(record.availableAtTick)) && (
        <span className="catalog-card-ticks">
          {tickText(record.observedTick) && <span>Observed {tickText(record.observedTick)}</span>}
          {tickText(record.availableAtTick) && <span>Released {tickText(record.availableAtTick)}</span>}
        </span>
      )}
    </button>
  );
}

function RecordPanel({ id, cutoffTick, canGoBack, onBack, onClose, onOpen, aorName, aors, globalNotice }: {
  id: string; cutoffTick?: number; canGoBack: boolean; onBack: () => void; onClose: () => void; onOpen: (id: string) => void;
  aorName: (id: string) => string; aors: CatalogAor[]; globalNotice?: string;
}) {
  const [detail, setDetail] = useState<CatalogRecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.closest('.catalog-detail')?.scrollTo?.({ top: 0 });
    // Stacked layout: the detail sits below the results, so bring it into view when a record opens.
    if (window.matchMedia?.('(max-width: 980px)').matches) root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [id]);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    catalogApi.record(id, controller.signal, cutoffTick).then(
      (d) => { if (!controller.signal.aborted) setDetail(d); },
      (err) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(err instanceof ApiError && err.status === 404 && cutoffTick !== undefined
          ? `Not released by T+${cutoffTick}. Persona and case summaries appear only after their final review tick; raise or clear the cutoff to read this record.`
          : catalogErrorMessage(err));
      },
    );
    return () => controller.abort();
  }, [id, cutoffTick]);

  const kind = detail?.record.kind;
  const caseRecords = useCatalogPage(kind === 'case' ? caseRecordsQuery(id, cutoffTick) : null);
  const personaCases = useCatalogPage(kind === 'persona' ? personaCasesQuery(id, cutoffTick) : null);

  return (
    <div className="catalog-detail-inner" ref={root}>
      <div className="catalog-detail-nav">
        <button type="button" className="catalog-btn" onClick={canGoBack ? onBack : onClose}><ArrowLeft size={13} aria-hidden="true" /> {canGoBack ? 'Back' : 'Close'}</button>
      </div>
      <InlineError message={error} />
      {!detail && !error && <Busy label="Loading record…" />}
      {detail && (
        <RecordDetail detail={detail} aor={aors.find((a) => a.id === detail.record.aorId) ?? null} aorName={aorName} onOpen={onOpen} globalNotice={globalNotice}>
          {kind === 'persona' && (
            <DetailSection title="Authored cases">
              <PersonaCases state={personaCases} persona={detail.record} onOpen={onOpen} />
            </DetailSection>
          )}
          {kind === 'case' && (
            <>
              <DetailSection title="Decision and review timeline" note="Authored sequence in scenario order. Not an engine replay and not an assessment of a real person.">
                <CaseTimeline state={caseRecords} caseId={id} onOpen={onOpen} />
              </DetailSection>
              <DetailSection title="Report chain" note="Illustrative authored reports and how they relate. Only independent lineages count as corroboration.">
                <SourceChain state={caseRecords} caseId={id} onOpen={onOpen} />
              </DetailSection>
            </>
          )}
        </RecordDetail>
      )}
    </div>
  );
}

function DetailSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="catalog-section">
      <h3>{title}</h3>
      {note && <p className="catalog-section-note">{note}</p>}
      {children}
    </section>
  );
}

const RATING_TONE: Record<string, string> = {
  supported: 'good', favorable: 'good', 'partly-supported': 'mixed', mixed: 'mixed', unsupported: 'bad', costly: 'bad',
};

function Rating({ label, value }: { label: string; value: unknown }) {
  const v = text(value);
  if (!v) return null;
  return <span className={`catalog-rating catalog-rating-${RATING_TONE[v] ?? 'neutral'}`}>{label} <strong>{humanize(v)}</strong></span>;
}

function PageNotes({ state, what }: { state: PageState; what: string }) {
  if (state.error) return <InlineError message={state.error} />;
  if (!state.page) return state.loading ? <Busy label={`Loading ${what}…`} /> : null;
  return null;
}

function PersonaCases({ state, persona, onOpen }: { state: PageState; persona: CatalogRecord; onOpen: (id: string) => void }) {
  if (!state.page) return <PageNotes state={state} what="cases" />;
  const order = strings(persona.fields?.caseIds);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  const cases = [...state.page.items].filter((r) => r.kind === 'case').sort((a, b) => rank(a.id) - rank(b.id));
  if (!cases.length) return <Empty>No authored cases are released for this persona.</Empty>;
  const prefix = `${persona.title} · `;
  return (
    <>
      <ul className="catalog-case-links">
        {cases.map((c) => (
          <li key={c.id}>
            <button type="button" className="catalog-case-link" onClick={() => onOpen(c.id)}>
              <span className="catalog-card-title">{c.title.startsWith(prefix) ? c.title.slice(prefix.length) : c.title}</span>
              {text(c.fields?.behaviorLabel) && <span className="catalog-case-behavior">{c.fields.behaviorLabel}</span>}
              <span className="catalog-case-facts">
                <Rating label="Outcome" value={c.fields?.outcomeRating} />
                <Rating label="Reasoning" value={c.fields?.reasoningRating} />
                {tickText(c.fields?.decisionDeadlineTick) && <span className="catalog-mono-note">Deadline {tickText(c.fields.decisionDeadlineTick)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {order.length > cases.length && <p className="catalog-hint">{cases.length} of {order.length} cases released at this cutoff.</p>}
    </>
  );
}

export function CaseTimeline({ state, caseId, onOpen }: { state: PageState; caseId?: string; onOpen: (id: string) => void }) {
  if (!state.page) return <PageNotes state={state} what="timeline" />;
  const { events, reports } = partitionCaseRecords(state.page.items, caseId);
  const handles = reportHandles(reports);
  if (!events.length) return <Empty>No authored events for this case.</Empty>;
  return (
    <>
      <ol className="catalog-timeline">
        {events.map((e) => {
          const f = e.fields ?? {};
          const review = f.phase === 'post-hoc';
          const decision = f.isDecisionDeadline === true || f.eventType === 'decision';
          const cited = strings(f.citedReportIds).filter((r) => handles.has(r));
          const stage = review ? 'Review' : decision ? 'Decision' : text(f.eventType) ? humanize(f.eventType as string) : null;
          return (
            <li key={e.id} className={`catalog-timeline-item ${review ? 'is-review' : ''} ${decision ? 'is-decision' : ''}`}>
              <span className="catalog-timeline-ticks">
                <span title="Tick at which the event is observed in the authored scenario">{tickText(e.observedTick) ?? '—'}</span>
                {tickText(e.availableAtTick) && e.availableAtTick !== e.observedTick && (
                  <span className="catalog-timeline-release" title="Tick at which the information is released to readers">released {tickText(e.availableAtTick)}</span>
                )}
              </span>
              <div className="catalog-timeline-body">
                <button type="button" className="catalog-timeline-open" onClick={() => onOpen(e.id)}>
                  <span className="catalog-timeline-head">
                    {stage && <span className="catalog-stage">{stage}</span>}
                    <span className="catalog-card-title">{text(f.label) ?? e.title}</span>
                  </span>
                  {e.summary && <span className="catalog-timeline-summary">{e.summary}</span>}
                </button>
                {(cited.length > 0 || text(f.statedConfidence) || text(f.rating)) && (
                  <span className="catalog-timeline-facts">
                    {cited.length > 0 && (
                      <span className="catalog-cites">Cites {cited.map((r) => (
                        <button key={r} type="button" className="catalog-handle" onClick={() => onOpen(r)} title={reports.find((x) => x.id === r)?.title}>{handles.get(r)}</button>
                      ))}</span>
                    )}
                    {text(f.statedConfidence) && <span className="catalog-mono-note">Confidence {f.statedConfidence}</span>}
                    {text(f.rating) && <Rating label={f.reviewFocus === 'outcome' ? 'Outcome' : 'Reasoning'} value={f.rating} />}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {state.page.total > state.page.items.length && <p className="catalog-hint">Showing the first {state.page.items.length} of {state.page.total} case records.</p>}
    </>
  );
}

export function SourceChain({ state, caseId, onOpen }: { state: PageState; caseId?: string; onOpen: (id: string) => void }) {
  if (!state.page) return <PageNotes state={state} what="reports" />;
  const { reports } = partitionCaseRecords(state.page.items, caseId);
  if (!reports.length) return <Empty>No reports are released for this case.</Empty>;
  const handles = reportHandles(reports);
  return (
    <ol className="catalog-chain">
      {reports.map((r) => {
        const f = r.fields ?? {};
        const relations = reportRelations(r, handles);
        return (
          <li key={r.id} className={`catalog-chain-item ${f.independent === false ? 'is-dependent' : ''}`}>
            <span className="catalog-handle-static">{handles.get(r.id)}</span>
            <div className="catalog-chain-body">
              <button type="button" className="catalog-chain-open" onClick={() => onOpen(r.id)}>
                <span className="catalog-card-title">{text(f.sourceLabel) ?? r.title}</span>
                {r.summary && <span className="catalog-timeline-summary">{r.summary}</span>}
              </button>
              <span className="catalog-timeline-facts">
                {text(f.lineage) && <span className={`catalog-lineage catalog-lineage-${f.lineage}`}>{humanize(f.lineage as string)}</span>}
                {f.independent === false && <span className="catalog-lineage catalog-lineage-dependent">Not independent</span>}
                {relations.map((rel) => (
                  <span key={`${rel.label}-${rel.targetId}`} className="catalog-cites">{rel.label} <button type="button" className="catalog-handle" onClick={() => onOpen(rel.targetId)}>{rel.handle}</button></span>
                ))}
                <span className="catalog-mono-note">
                  {[tickText(r.observedTick) && `obs ${tickText(r.observedTick)}`, tickText(r.availableAtTick) && `rel ${tickText(r.availableAtTick)}`, text(f.statedConfidence) && `${f.statedConfidence} confidence`].filter(Boolean).join(' · ')}
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PersonaProfile({ record, lessons, onOpen }: { record: CatalogRecord; lessons: CatalogRecord[]; onOpen: (id: string) => void }) {
  const f = record.fields ?? {};
  const strengths = strings(f.strengths);
  const limitations = strings(f.limitations);
  const focusId = text(f.focusLessonId);
  const ordered = [...lessons].sort((a, b) => Number(b.id === focusId) - Number(a.id === focusId));
  return (
    <section className="catalog-profile">
      {strengths.length > 0 && <ProfileList title="Strengths" tone="good" items={strengths} />}
      {limitations.length > 0 && <ProfileList title="Limitations" tone="bad" items={limitations} />}
      {ordered.length > 0 && (
        <div className="catalog-profile-block">
          <h3>Learning focus</h3>
          <ul className="catalog-lessons">
            {ordered.map((l) => (
              <li key={l.id}>
                <button type="button" className="catalog-lesson" onClick={() => onOpen(l.id)}>
                  <span className="catalog-card-title">{l.title}{l.id === focusId && <span className="catalog-focus-mark">Primary</span>}</span>
                  {l.summary && <span className="catalog-timeline-summary">{l.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {text(f.criterionStatus) && (
        <p className="catalog-criterion">
          <strong>{humanize(f.criterionStatus as string)}</strong>
          {text(f.criterionRule) && <span> · {f.criterionRule}</span>}
        </p>
      )}
    </section>
  );
}

function ProfileList({ title, tone, items }: { title: string; tone: 'good' | 'bad'; items: string[] }) {
  return (
    <div className={`catalog-profile-block catalog-profile-${tone}`}>
      <h3>{title}</h3>
      <ul>{items.map((s, i) => <li key={`${i}-${s}`}>{s}</li>)}</ul>
    </div>
  );
}

function CaseReview({ record, onOpen }: { record: CatalogRecord; onOpen: (id: string) => void }) {
  const f = record.fields ?? {};
  const contrast = text(f.contrastCaseId);
  if (!text(f.outcomeLesson) && !text(f.reasoningLesson) && !contrast) return null;
  return (
    <DetailSection title="Review takeaways" note="Outcome and reasoning are reviewed separately.">
      <dl className="catalog-review">
        {text(f.outcomeLesson) && <div><dt><Rating label="Outcome" value={f.outcomeRating} /></dt><dd>{f.outcomeLesson}</dd></div>}
        {text(f.reasoningLesson) && <div><dt><Rating label="Reasoning" value={f.reasoningRating} /></dt><dd>{f.reasoningLesson}</dd></div>}
      </dl>
      {contrast && (
        <p className="catalog-contrast">
          {text(f.contrastNote) && <span>{f.contrastNote} </span>}
          <button type="button" className="catalog-link" onClick={() => onOpen(contrast)}>Open contrast case</button>
        </p>
      )}
    </DetailSection>
  );
}

/** Kinds whose own fields read as useful facts; persona and case get dedicated layouts instead. */
const FACT_SKIP = /(^|[a-z])(Ids?|Id)$|^(sequence|tick|slot|label|lineageRoot|displayName|lessonKey|term|region|url|usage|retrievedAt|publisher|scope|phase|eventType|rating|reviewFocus|citedReportIds|statedConfidence|lineage|sourceLabel|independent)$/;

function keyFacts(record: CatalogRecord) {
  if (record.kind === 'persona' || record.kind === 'case' || record.kind === 'event' || record.kind === 'report') return [];
  return Object.entries(record.fields ?? {})
    .filter(([key, value]) => !FACT_SKIP.test(key) && typeof value !== 'boolean' && !/tick/i.test(key))
    .map(([key, value]) => ({ key, display: formatFieldValue(value) }))
    .filter((f): f is { key: string; display: NonNullable<ReturnType<typeof formatFieldValue>> } => {
      if (!f.display) return false;
      // Fields the authored body already restates are left to the body.
      const said = (s: string) => s === record.summary || s === record.title || (record.body ?? '').includes(s);
      if (f.display.kind === 'text') return !RECORD_ID.test(f.display.text) && !said(f.display.text);
      return f.display.items.every((i) => !RECORD_ID.test(i)) && !f.display.items.every(said);
    });
}

/** Links already shown elsewhere in the layout (self, crumbs, timeline, cases, lessons) are not repeated. */
function visibleRelations(detail: CatalogRecordDetail) {
  const r = detail.record;
  const shownElsewhere = new Set([r.id, r.personaId, r.caseId].filter(Boolean));
  const out = (Array.isArray(detail.links) ? detail.links : []).filter((l) => l?.record?.id && !shownElsewhere.has(l.record.id)
    && !(r.kind === 'persona' && l.record.kind === 'lesson'));
  const outIds = new Set(out.map((l) => l.record.id));
  const inn = (Array.isArray(detail.backlinks) ? detail.backlinks : []).filter((l) => l?.record?.id && l.record.id !== r.id && !outIds.has(l.record.id)
    && !(r.kind === 'case' && l.relation === 'belongs-to')
    && !(r.kind === 'persona' && (l.relation === 'authored-by' || l.record.personaId === r.id)));
  return { out, inn };
}

export function RecordDetail({ detail, aor, aorName, onOpen, globalNotice, children }: {
  detail: CatalogRecordDetail; aor: CatalogAor | null; aorName: (id: string) => string; onOpen: (id: string) => void; globalNotice?: string; children?: ReactNode;
}) {
  const r = detail.record;
  const f = r.fields && typeof r.fields === 'object' ? r.fields : {};
  const sources = Array.isArray(detail.sources) ? detail.sources : [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const allFields = Object.entries(f)
    .map(([key, value]) => ({ key, display: formatFieldValue(value) }))
    .filter((x): x is { key: string; display: NonNullable<ReturnType<typeof formatFieldValue>> } => x.display !== null);
  const reviewTick = Object.entries(f).find(([k, v]) => /review.?(end.?)?tick/i.test(k) && typeof v === 'number');
  const relayDelay = typeof f.relayDelayTicks === 'number' ? f.relayDelayTicks : null;
  const facts = keyFacts(r);
  const lessons = (Array.isArray(detail.links) ? detail.links : []).filter((l) => l?.record?.kind === 'lesson').map((l) => l.record);
  const structured = r.kind === 'persona' || r.kind === 'case';
  const { out, inn } = visibleRelations(detail);
  const showPersona = r.personaId && r.personaId !== r.id;
  const showCase = r.caseId && r.caseId !== r.id;
  const personaName = showPersona ? detail.links.find((l) => l.record?.id === r.personaId)?.record.title : undefined;
  const caseName = showCase ? detail.links.find((l) => l.record?.id === r.caseId)?.record.title : undefined;

  return (
    <article className="catalog-record">
      <header className="catalog-record-head">
        <div className="catalog-card-meta">
          <span className={`catalog-kind catalog-kind-${r.kind}`}>{kindLabel(r.kind)}</span>
          <span>{aor?.name ?? aorName(r.aorId)}</span>
          {aor && <CapabilityBadge aor={aor} />}
          <ProvenanceBadge provenance={r.provenance} />
        </div>
        <h2>{r.title}</h2>
        {r.summary && <p className="catalog-record-summary">{r.summary}</p>}
        {r.provenance === 'public-reference' && (
          <p className="catalog-public-note">Real public reference. The text below is the publisher's own summary; follow the source link for the original.</p>
        )}
        {r.kind === 'persona' && <p className="catalog-hint">Fictional preset for study only. It is not a sign-in identity and not measured skill.</p>}
      </header>

      {(showPersona || showCase) && (
        <p className="catalog-crumbs">
          {showCase && <button type="button" className="catalog-link" onClick={() => onOpen(r.caseId as string)}>{caseName ? `Case: ${caseName}` : 'Open parent case'}</button>}
          {showPersona && <button type="button" className="catalog-link" onClick={() => onOpen(r.personaId as string)}>{personaName ? `Persona: ${personaName}` : 'Author persona'}</button>}
        </p>
      )}

      {(tickText(r.observedTick) || tickText(r.availableAtTick) || reviewTick || tickText(f.decisionDeadlineTick) || relayDelay !== null) && (
        <dl className="catalog-ticks">
          {tickText(r.observedTick) && <div><dt>Observed</dt><dd>{tickText(r.observedTick)}</dd></div>}
          {tickText(f.decisionDeadlineTick) && <div><dt>Decision deadline</dt><dd>{tickText(f.decisionDeadlineTick)}</dd></div>}
          {reviewTick && <div><dt>{/end/i.test(reviewTick[0]) ? 'Review ends' : 'Review'}</dt><dd>{tickText(reviewTick[1])}</dd></div>}
          {tickText(r.availableAtTick) && <div><dt>Released</dt><dd>{tickText(r.availableAtTick)}</dd></div>}
          {relayDelay !== null && <div><dt>Relay delay</dt><dd>{relayDelay} ticks</dd></div>}
        </dl>
      )}

      {children}

      {r.kind === 'persona' && <PersonaProfile record={r} lessons={lessons} onOpen={onOpen} />}
      {r.kind === 'case' && <CaseReview record={r} onOpen={onOpen} />}

      {facts.length > 0 && (
        <dl className="catalog-facts">
          {facts.map(({ key, display }) => (
            <div key={key}>
              <dt>{humanize(key)}</dt>
              <dd>{display.kind === 'text' ? display.text : <ul className="catalog-bullets">{display.items.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}</ul>}</dd>
            </div>
          ))}
        </dl>
      )}

      {r.body && !structured && <div className="catalog-record-body">{r.body.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>}

      {(out.length > 0 || inn.length > 0) && (
        <DetailSection title="Related records">
          <RelationGroups items={out} direction="out" aorName={aorName} onOpen={onOpen} />
          <RelationGroups items={inn} direction="in" aorName={aorName} onOpen={onOpen} />
        </DetailSection>
      )}

      {sources.length > 0 && (
        <DetailSection title="Sources" note="Original publisher links with each publisher's summary.">
          <ul className="catalog-sources">
            {sources.map((s) => (
              <li key={s.id} className="catalog-source">
                <SourceAnchor source={s} />
                <span className="catalog-muted">{[s.publisher, s.retrievedAt && `retrieved ${s.retrievedAt}`].filter(Boolean).join(' · ')}</span>
                {s.summary && <p>{s.summary}</p>}
                {s.scope && <p className="catalog-muted">Scope: {s.scope}</p>}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      <details className="catalog-meta">
        <summary>Full text and record metadata</summary>
        <div className="catalog-meta-body">
          {r.body && structured && <div className="catalog-record-body">{r.body.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}</div>}
          <dl className="catalog-fields">
            <div className="catalog-field-row"><dt>Record ID</dt><dd className="mono">{r.id}</dd></div>
            <div className="catalog-field-row"><dt>Provenance</dt><dd>{humanize(r.provenance)}</dd></div>
            {allFields.map(({ key, display }) => (
              <div key={key} className="catalog-field-row">
                <dt>{humanize(key)}</dt>
                <dd>
                  {display.kind === 'text'
                    ? display.text
                    : <ul className="catalog-tags">{display.items.map((item, i) => {
                        const source = sourceById.get(item);
                        return <li key={`${item}-${i}`} className={source ? 'catalog-tag-source' : 'catalog-tag'}>{source ? <SourceAnchor source={source} /> : item}</li>;
                      })}</ul>}
                </dd>
              </div>
            ))}
          </dl>
          {strings(r.roles).length > 0 && <TagList label="Relevant roles" items={strings(r.roles).map((role) => ROLE_LABELS[role as CatalogRole] ?? humanize(role))} />}
          {strings(r.tags).length > 0 && <TagList label="Tags" items={strings(r.tags)} />}
          {detail.notice && detail.notice !== globalNotice && <p className="catalog-muted">{detail.notice}</p>}
        </div>
      </details>
    </article>
  );
}

const RELATION_PREVIEW = 8;

function RelationGroups({ items, direction, aorName, onOpen }: { items: CatalogRelated[]; direction: 'out' | 'in'; aorName: (id: string) => string; onOpen: (id: string) => void }) {
  const groups = new Map<string, CatalogRecord[]>();
  for (const item of items) {
    if (!item?.record?.id) continue;
    groups.set(item.relation, [...(groups.get(item.relation) ?? []), item.record]);
  }
  const row = (rec: CatalogRecord) => (
    <li key={rec.id}>
      <button type="button" className="catalog-related" onClick={() => onOpen(rec.id)}>
        <span className={`catalog-kind catalog-kind-${rec.kind}`}>{kindLabel(rec.kind)}</span>
        <span className="catalog-related-title">{rec.title}</span>
        <span className="catalog-muted">{aorName(rec.aorId)}</span>
        {rec.provenance === 'public-reference' && <ProvenanceBadge provenance={rec.provenance} />}
      </button>
    </li>
  );
  return (
    <>
      {[...groups].map(([relation, records]) => (
        <div key={`${direction}-${relation}`} className={`catalog-relation catalog-relation-${relation}`}>
          <h4>{relationLabel(relation, direction)} <span className="catalog-muted">{records.length}</span></h4>
          <ul>{records.slice(0, RELATION_PREVIEW).map(row)}</ul>
          {records.length > RELATION_PREVIEW && (
            <details className="catalog-more">
              <summary>{records.length - RELATION_PREVIEW} more</summary>
              <ul>{records.slice(RELATION_PREVIEW).map(row)}</ul>
            </details>
          )}
        </div>
      ))}
    </>
  );
}

function TagList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="catalog-taglist">
      <span className="catalog-taglist-label">{label}</span>
      <ul className="catalog-tags">{items.map((t, i) => <li key={`${t}-${i}`} className="catalog-tag">{t}</li>)}</ul>
    </div>
  );
}

export function SourceAnchor({ source }: { source: CatalogSource }) {
  const href = safeExternalUrl(source.url);
  if (!href) return <span className="catalog-source-title">{source.title}</span>;
  return (
    <a className="catalog-source-title" href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {source.title} <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}
