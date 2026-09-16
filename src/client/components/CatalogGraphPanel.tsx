import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import { ArrowLeft, FileText, Link2, Network, Search, X } from 'lucide-react';
import { Busy, Empty, InlineError, Panel } from './ui';
import { catalogReviewHref, isCatalogReviewHash, parseCatalogReviewHash, sameReviewView, type CatalogReviewHash, type CatalogReviewLink } from '../catalog-review-link';
import '../catalog-graph.css';

type Props = Record<string, string | number | boolean | null | string[] | number[]>;
type View = { clock: string; cutoffTick: number } | null;
interface NodeRef { id: string; type: string; dataClass: string; label: string }
/** Which recorded trial, seat and round a record belongs to. Relative source paths repeat across trials, so this is what tells them apart. */
interface ReviewContext { trialName: string; trialId: string; seat: 'blue' | 'red' | null; roundIndex: number | null; releasedTick: number }
type Contextual = { reviewContext?: ReviewContext | null };
interface Summary {
  scope: string; notice: string; artifactSha256: string; view: View; types: string[]; dataClasses: string[];
  counts: { nodes: number; edges: number; byType: Record<string, number>; byDataClass: Record<string, number> };
  clocks: { clock: string; maxReleasedTick: number; nodes: number }[];
  inputs: { kind: string; label: string; sha256: string }[];
}
interface SearchPage { total: number; offset: number; limit: number; nextOffset: number | null; items: (NodeRef & Contextual & { summary: string })[] }
interface NodeDetail extends Contextual {
  node: NodeRef & { summary: string; properties: Props; hindsight: boolean; contentSha256: string; time: { clock: string; observedTick: number | null; releasedTick: number } | null; provenance: { origin: string; sourceRef: string; sourceSha256: string | null } };
  relations: { total: number; offset: number; limit: number; truncated: boolean; items: { direction: 'in' | 'out'; statement: string; endpoint: NodeRef & Contextual; edge: { id: string; type: string; fact: string; dataClass: string; properties: Props; contentSha256: string } }[] };
}
interface SourceText { nodeId: string; path: string; sha256: string; bytes: number; text: string; view: View; archive: { datasetUrn: string; objectId: string; sha256: string }; receipts: unknown[] }
type ViewParams = { clock?: string; cutoffTick?: number };
type Load<T> = { state: 'idle' } | { state: 'pending' } | { state: 'error'; message: string } | { state: 'ready'; data: T };
/** A review link from the URL that has not opened a record yet: waiting for the graph hash check, malformed, or for another graph. */
type Incoming = Exclude<CatalogReviewHash, { kind: 'none' }> | { kind: 'mismatch'; link: CatalogReviewLink; served: string } | null;

const QUICK: [string, string][] = [['ActualTrial', 'Trials'], ['ModelSeat', 'Model seats'], ['RecordedModelDecision', 'Model decisions'], ['BehaviorObservation', 'Behavior observations']];
const CLASS_LABEL: Record<string, string> = { 'actual-recorded': 'Recorded model game', 'derived-observation': 'Derived count', 'authored-synthetic': 'Fictional example', 'public-reference': 'Public reference' };
const MAX_PROPS = 60, MAX_TRAIL = 8;
/** SourceArtifact roles the server reads back from the native archive. Every other role stays a path-and-hash reference. */
const READABLE_ROLES = new Set(['seat-snapshot', 'seat-prompt', 'decision-record', 'saved-reply', 'round-state', 'round-outcome']);

class GraphError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
async function getJson<T>(route: string, params: Record<string, string | number | undefined>, signal: AbortSignal): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '').map(([k, v]) => [k, String(v)]));
  const r = await fetch(`${route}?${qs}`, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!r.ok) throw new GraphError(r.status);
  return r.json() as Promise<T>;
}
function sourceMessage(e: unknown): string {
  const s = e instanceof GraphError ? e.status : 0;
  if (s === 401 || s === 403) return 'Your sign-in no longer allows reading saved sources. Refresh to sign in again.';
  if (s === 404) return 'This saved source is not available in the current view, or its role cannot be opened.';
  if (s === 409) return 'The native archive is unavailable or no longer matches this graph, so the source was not shown.';
  if (s === 502) return 'The native archive could not be read or failed verification, so the source was not shown.';
  if (s === 429) return 'The source reader is busy. Close this source and try again shortly.';
  if (s === 400) return 'The server rejected this source request.';
  return 'Could not reach the saved source reader.';
}
function message(e: unknown): string {
  const s = e instanceof GraphError ? e.status : 0;
  if (s === 401 || s === 403) return 'Your sign-in no longer allows reading the catalog graph. Refresh to sign in again.';
  if (s === 404) return 'That record is not part of the current view.';
  if (s === 503) return 'The catalog graph artifact is unavailable or failed verification on this server.';
  if (s === 400) return 'The server rejected this query.';
  return 'Could not reach the catalog graph.';
}
/** Fetches while deps are stable; aborts the previous request when they change or the panel unmounts. */
function useGraphFetch<T>(route: string | null, params: Record<string, string | number | undefined>, describe: (e: unknown) => string = message): Load<T> {
  const key = route ? `${route}?${JSON.stringify(params)}` : '';
  const [saved, setSaved] = useState<{key:string;load:Load<T>}>({ key:'', load:{state:'idle'} });
  useEffect(() => {
    const setLoad = (load:Load<T>) => setSaved({key,load});
    if (!route) { setLoad({ state: 'idle' }); return; }
    const ac = new AbortController();
    setLoad({ state: 'pending' });
    getJson<T>(route, params, ac.signal).then(
      (data) => { if (!ac.signal.aborted) setLoad({ state: 'ready', data }); },
      (e) => { if (!ac.signal.aborted) setLoad({ state: 'error', message: describe(e) }); },
    );
    return () => ac.abort();
  }, [key]);
  // A changed selection must hide the previous result during render, before effect cleanup runs.
  return saved.key === key ? saved.load : {state:route ? 'pending' : 'idle'};
}

/**
 * Embeds in PlatformView. `scopeKey` should change with identity or workroom; the explorer remounts, dropping state and aborting requests.
 * A `#catalog-review?…` fragment (see catalog-review-link.ts) is read on mount and on every hash change, so reload, back/forward and a
 * remount after sign-in all reopen the linked record under the current session's own authorization.
 */
export function CatalogGraphPanel({ scopeKey }: { scopeKey: string }) {
  return <Explorer key={scopeKey} />;
}

const viewOf = (q: { clock?: string; cutoffTick?: number }) => (q.clock !== undefined && q.cutoffTick !== undefined ? { clock: q.clock, cutoffTick: q.cutoffTick } : null);
/** Removes only a review fragment the explorer no longer shows, without adding a history entry. */
function dropReviewHash() {
  if (isCatalogReviewHash(window.location.hash)) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
}

function Explorer() {
  const [initial] = useState(() => parseCatalogReviewHash(typeof window === 'undefined' ? '' : window.location.hash));
  const linked = initial.kind === 'link' ? initial.link.view : null;
  const [incoming, setIncoming] = useState<Incoming>(initial.kind === 'none' ? null : initial);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ q: '', clock: linked?.clock ?? '', tick: linked ? String(linked.cutoffTick) : '' });
  const [query, setQuery] = useState<{ q: string; type: string; dataClass: string; clock?: string; cutoffTick?: number }>({ q: '', type: 'ActualTrial', dataClass: '', clock: linked?.clock, cutoffTick: linked?.cutoffTick });
  const [offset, setOffset] = useState(0);
  const [edgeOffset, setEdgeOffset] = useState(0);
  const [trail, setTrail] = useState<string[]>([]);
  const view = { clock: query.clock, cutoffTick: query.cutoffTick };
  const summary = useGraphFetch<Summary>('/api/catalog/graph', view);
  const storage = useGraphFetch<{name:string;objects:number;contentRevision:number|null;graphFileSha256:string}>('/api/catalog/graph/storage', {});
  const page = useGraphFetch<SearchPage>('/api/catalog/graph/search', { ...view, q: query.q, type: query.type, dataClass: query.dataClass, offset, limit: 20 });
  const selected = trail[trail.length - 1];
  const detail = useGraphFetch<NodeDetail>(selected ? '/api/catalog/graph/node' : null, { ...view, id: selected, edgeOffset });
  const s = summary.state === 'ready' ? summary.data : null;

  // A later link replaces the selection and view in one render, so no record from before the hash change stays on screen.
  useEffect(() => {
    const onHash = () => {
      const h = parseCatalogReviewHash(window.location.hash);
      if (h.kind === 'none') { setTrail([]); setEdgeOffset(0); setIncoming(null); return; }
      setTrail([]); setEdgeOffset(0); setOffset(0); setQueryError(null); setIncoming(h);
      if (h.kind !== 'link') return;
      const v = h.link.view;
      setQuery((q) => ({ ...q, clock: v?.clock, cutoffTick: v?.cutoffTick }));
      setDraft((d) => ({ ...d, clock: v?.clock ?? '', tick: v ? String(v.cutoffTick) : '' }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Open the linked record only once this view's summary reports the exact graph the link pins. Never fall back to a similar ID elsewhere.
  useEffect(() => {
    if (incoming?.kind !== 'link' || !s || !sameReviewView(s.view, incoming.link.view)) return;
    if (s.artifactSha256 !== incoming.link.graph) { setIncoming({ kind: 'mismatch', link: incoming.link, served: s.artifactSha256 }); return; }
    setEdgeOffset(0); setTrail([incoming.link.id]); setIncoming(null);
  }, [incoming, s]);

  // Choosing another record or view supersedes any link: clear its pending state and stop the URL naming a record no longer shown.
  const leaveLink = () => { setIncoming(null); dropReviewHash(); };
  const apply = (next: Partial<typeof query>) => { leaveLink(); setQuery((q) => ({ ...q, ...next })); setOffset(0); };
  const open = (id: string) => { leaveLink(); setEdgeOffset(0); setTrail((t) => [...t.filter((x) => x !== id), id].slice(-MAX_TRAIL)); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const tick = /^\d{1,9}$/.test(draft.tick) ? Number(draft.tick) : undefined;
    if (draft.clock && tick === undefined) { setQueryError('Enter a valid tick for the selected review timeline.'); return; }
    setQueryError(null);
    const paired = draft.clock && tick !== undefined;
    leaveLink();
    apply({ q: draft.q.trim().slice(0, 120), clock: paired ? draft.clock : undefined, cutoffTick: paired ? tick : undefined });
    setTrail([]);
  };
  // The link names what is on screen: the summary's graph hash and the applied view, never the unsubmitted form.
  const activeView = viewOf(query);
  const reviewHref = incoming === null && s && sameReviewView(s.view, activeView) && detail.state === 'ready' && detail.data.node.id === selected
    ? catalogReviewHref({ graph: s.artifactSha256, id: selected, view: activeView }, window.location)
    : null;

  return (
    <Panel tone="dark" className="cgraph" title={<><Network size={15} aria-hidden="true" /> Catalog and model-game graph</>} aside={s && <span className="cgraph-count">{s.counts.nodes} nodes · {s.counts.edges} relations</span>}>
      <p className="cgraph-scope">App-maintained typed projection of the preset catalog and completed offline model-vs-model games. These are <strong>not native Kamiwaza graph facts</strong> and were not ingested; the native workroom graph is in the Domain ontology panel.</p>
      {summary.state === 'pending' && <Busy label="Loading graph summary…" />}
      {summary.state === 'error' && <InlineError message={summary.message} />}
      {storage.state === 'ready' && <p className="cgraph-hint">Native Kamiwaza archive: <strong>{storage.data.objects} files</strong> · revision {storage.data.contentRevision}. Its graph metadata matches this build. <code>{storage.data.name}</code></p>}
      {storage.state === 'error' && <p className="cgraph-hint">Native archive metadata could not be verified for this sign-in.</p>}
      {s && (
        <details className="cgraph-meta">
          <summary>Graph content hash <code title={s.artifactSha256}>{s.artifactSha256}</code></summary>
          <p>{s.notice}</p>
          <ul>{s.inputs.map((i) => <li key={i.sha256}>{i.kind}: {i.label} <code>{i.sha256}</code></li>)}</ul>
        </details>
      )}

      <form className="cgraph-search" role="search" aria-label="Search catalog graph" onSubmit={submit}>
        <label>Search <input type="search" maxLength={120} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="literal words, e.g. seat/blue" /></label>
        <label>Record class
          <select value={query.dataClass} onChange={(e) => apply({ dataClass: e.target.value })}>
            <option value="">All classes</option>
            {(s?.dataClasses ?? []).map((d) => <option key={d} value={d}>{CLASS_LABEL[d] ?? d}</option>)}
          </select>
        </label>
        <label>Type
          <select value={query.type} onChange={(e) => apply({ type: e.target.value })}>
            <option value="">All types</option>
            {(s?.types ?? []).map((t) => <option key={t} value={t}>{t}{s ? ` (${s.counts.byType[t] ?? 0})` : ''}</option>)}
          </select>
        </label>
        <label>Review timeline
          <input list="catalog-review-clocks" placeholder="Type a trial or case ID" value={draft.clock} onChange={(e) => setDraft({ ...draft, clock: e.target.value })}/><datalist id="catalog-review-clocks">
            <option value="">Full after-action view</option>
            {(s?.clocks ?? []).map((c) => <option key={c.clock} value={c.clock}>{c.clock} (ticks 0–{c.maxReleasedTick})</option>)}
          </datalist>
        </label>
        <label>Released by tick <input inputMode="numeric" pattern="\d{1,9}" size={6} required={!!draft.clock} disabled={!draft.clock} value={draft.tick} onChange={(e) => setDraft({ ...draft, tick: e.target.value })} /></label>
        <button className="btn btn-sm btn-primary" type="submit"><Search size={13} aria-hidden="true" /> Apply</button>
      </form>
      {queryError && <InlineError message={queryError} />}
      <div className="cgraph-quick" role="group" aria-label="Recorded model game path">
        {QUICK.filter(([t]) => !s || s.types.includes(t)).map(([t, label], i) => (
          <button key={t} type="button" className={`btn btn-sm ${query.type === t ? 'is-on' : 'btn-ghost'}`} aria-pressed={query.type === t} onClick={() => apply({ type: t })}>{i + 1}. {label}</button>
        ))}
      </div>
      {incoming?.kind === 'invalid' && <InlineError message={`${incoming.reason} No record was opened. Search or choose a record to continue.`} />}
      {incoming?.kind === 'mismatch' && <InlineError message={`This review link is for a different graph version (${incoming.link.graph.slice(0, 12)}…) than this server provides (${incoming.served.slice(0, 12)}…), so the linked record was not opened.`} />}
      {incoming?.kind === 'link' && summary.state === 'error' && <InlineError message="The linked record was not opened because this graph and review view could not be verified." />}
      {query.clock && <p className="cgraph-hint">After-action review of a completed game: records released on <code>{query.clock}</code> by tick {query.cutoffTick}. Other timelines and hindsight records are hidden. This is not a live feed of what a player could see.</p>}

      <div className="cgraph-body">
        <section aria-label="Search results" className="cgraph-results">
          {page.state === 'pending' && <Busy label="Searching…" />}
          {page.state === 'error' && <InlineError message={page.message} />}
          {page.state === 'ready' && (page.data.items.length === 0 ? <Empty>No matching records in this view.</Empty> : <>
            <p className="cgraph-hint" aria-live="polite">{page.data.offset + 1}–{page.data.offset + page.data.items.length} of {page.data.total}</p>
            <ul>{page.data.items.map((n) => (
              <li key={n.id}><button type="button" className={`cgraph-item${n.id === selected ? ' is-selected' : ''}`} aria-current={n.id === selected || undefined} onClick={() => open(n.id)}>
                <span className="cgraph-item-head"><ClassBadge dataClass={n.dataClass} /> <span className="cgraph-type">{n.type}</span></span>
                <span className="cgraph-label">{n.label}</span>
                {n.reviewContext && <ContextLine c={n.reviewContext} />}
                {/* A source file's filename plus its trial context identifies it; its hash summary stays on the detail view. */}
                {!(n.reviewContext && n.type === 'SourceArtifact') && <span className="cgraph-summary">{n.summary}</span>}
              </button></li>
            ))}</ul>
            <div className="cgraph-pager">
              <button type="button" className="btn btn-sm" disabled={page.data.offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button>
              <button type="button" className="btn btn-sm" disabled={page.data.nextOffset === null} onClick={() => page.data.nextOffset !== null && setOffset(page.data.nextOffset)}>Next</button>
            </div>
          </>)}
        </section>

        <section aria-label="Selected record and connected records" className="cgraph-detail">
          {!selected && (incoming?.kind === 'link' && summary.state !== 'error'
            ? <Busy label="Checking the graph content hash before opening the linked record…" />
            : <Empty>Select a record to see its connected records. Start with a trial, then its model seats, recorded decisions and behavior observations.</Empty>)}
          {trail.length > 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { leaveLink(); setEdgeOffset(0); setTrail((t) => t.slice(0, -1)); }}><ArrowLeft size={13} aria-hidden="true" /> Back</button>}
          {detail.state === 'pending' && <Busy label="Loading record…" />}
          {detail.state === 'error' && <InlineError message={detail.message} />}
          {detail.state === 'ready' && <NodeView d={detail.data} view={view} reviewHref={reviewHref} onOpen={open} onPage={setEdgeOffset} />}
        </section>
      </div>
    </Panel>
  );
}

function ClassBadge({ dataClass }: { dataClass: string }) {
  return <span className={`badge cgraph-class cgraph-class-${dataClass}`}>{CLASS_LABEL[dataClass] ?? dataClass}</span>;
}

/**
 * Plain in-app activation records the link in history without re-running navigation, so the trail and any open source stay as they are.
 * Modified clicks, middle clicks and "copy link" use the href unchanged.
 */
function followInPlace(e: MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (window.location.href !== e.currentTarget.href) window.history.pushState(null, '', e.currentTarget.href);
}

function NodeView({ d, view, reviewHref, onOpen, onPage }: { d: NodeDetail; view: ViewParams; reviewHref: string | null; onOpen: (id: string) => void; onPage: (offset: number) => void }) {
  const { node: n, relations: r } = d;
  const props = Object.entries(n.properties);
  const role = n.properties.role;
  const readable = n.type === 'SourceArtifact' && typeof role === 'string' && READABLE_ROLES.has(role);
  const ctx = d.reviewContext;
  return (
    <article className="cgraph-node" aria-labelledby="cgraph-node-title">
      <header>
        <h3 id="cgraph-node-title">{n.label}</h3>
        <p><ClassBadge dataClass={n.dataClass} /> <span className="cgraph-type">{n.type}</span>{n.hindsight && <span className="badge badge-warn">After-action only</span>}</p>
        {reviewHref && <p><a className="btn btn-sm btn-ghost" href={reviewHref} onClick={followInPlace}><Link2 size={13} aria-hidden="true" /> Link to this review</a> <span className="cgraph-hint">Read-only. Opens this record and review view after sign-in; carries no access.</span></p>}
        {ctx && (
          <div className="cgraph-node-context">
            <ContextLine c={ctx} detail />
            {ctx.trialId !== n.id && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onOpen(ctx.trialId)}>Open trial</button>}
          </div>
        )}
        {n.dataClass === 'authored-synthetic' && <p className="cgraph-fiction">Fictional authored example. Not recorded play and not an assessment of any real person.</p>}
      </header>
      <p>{n.summary}</p>
      {n.type === 'RecordedModelDecision' && <DecisionReview n={n} r={r} onOpen={onOpen} />}
      <details className="cgraph-meta">
        <summary>Source, clock and content hashes</summary>
        <dl className="cgraph-prov">
        <div><dt>Source hash</dt><dd><code>{n.provenance.sourceSha256 ?? 'none (computed by projection)'}</code></dd></div>
        <div><dt>Source</dt><dd><code>{n.provenance.origin} · {n.provenance.sourceRef}</code></dd></div>
        <div><dt>Content hash</dt><dd><code>{n.contentSha256}</code></dd></div>
        {n.time && <div><dt>Clock</dt><dd><code>{n.time.clock}</code> · released tick {n.time.releasedTick}{n.time.observedTick !== null && ` · observed ${n.time.observedTick}`}</dd></div>}
        </dl>
      </details>
      {n.type === 'SourceArtifact' && !readable && <p className="cgraph-hint">Evidence file reference by path and hash only. It does not open, replay or rewind the game.</p>}
      {readable && <SourceReader key={`${n.id}|${view.clock ?? ''}|${view.cutoffTick ?? ''}`} node={n} view={view} />}
      <details className="cgraph-meta">
        <summary>Properties ({props.length})</summary>
        <dl className="cgraph-props">{props.slice(0, MAX_PROPS).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>)}</dl>
        {props.length > MAX_PROPS && <p className="cgraph-hint">{props.length - MAX_PROPS} more not shown.</p>}
      </details>

      <h4>Connected records <span className="cgraph-hint">{r.total === 0 ? 'none' : `${r.offset + 1}–${r.offset + r.items.length} of ${r.total}`}</span></h4>
      {r.items.length > 0 && <Ego center={n} items={r.items} onOpen={onOpen} />}
      <ul className="cgraph-relations">
        {r.items.map((x) => (
          <li key={x.edge.id}>
            <button type="button" className="cgraph-item" onClick={() => onOpen(x.endpoint.id)} aria-label={`${x.direction === 'out' ? `${n.label} ${x.edge.type} ${x.endpoint.label}` : `${x.endpoint.label} ${x.edge.type} ${n.label}`}.${x.endpoint.reviewContext ? ` ${contextText(x.endpoint.reviewContext)}.` : ''} Open ${x.endpoint.type}.`}>
              <span className="cgraph-rel"><code>{x.direction === 'out' ? `${x.edge.type} →` : `← ${x.edge.type}`}</code> <span className="cgraph-type">{x.endpoint.type}</span> <ClassBadge dataClass={x.endpoint.dataClass} /></span>
              <span className="cgraph-label">{x.endpoint.label}</span>
              {x.endpoint.reviewContext && <ContextLine c={x.endpoint.reviewContext} />}
            </button>
            <details className="cgraph-meta">
              <summary>Relation details</summary>
              <p>{x.edge.fact}</p>
              {x.edge.fact !== x.statement && <p className="cgraph-hint">{x.statement}</p>}
              <p><code>{x.edge.id}</code> · content <code>{x.edge.contentSha256}</code></p>
              {Object.keys(x.edge.properties).length > 0 && <p className="cgraph-hint">{Object.entries(x.edge.properties).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</p>}
            </details>
          </li>
        ))}
      </ul>
      {(r.offset > 0 || r.truncated) && (
        <div className="cgraph-pager">
          <button type="button" className="btn btn-sm" disabled={r.offset === 0} onClick={() => onPage(Math.max(0, r.offset - r.limit))}>Previous relations</button>
          <button type="button" className="btn btn-sm" disabled={!r.truncated} onClick={() => onPage(r.offset + r.limit)}>More relations</button>
        </div>
      )}
    </article>
  );
}

function contextText(c: ReviewContext): string {
  return [`Trial ${c.trialName}`, c.seat && `${c.seat === 'blue' ? 'Blue' : 'Red'} seat`, c.roundIndex !== null && `Round index ${c.roundIndex}`, `released tick ${c.releasedTick}`].filter(Boolean).join(' · ');
}

/** Full trial name (wraps, never truncated: v1/v2 and seat-swap suffixes must stay visible), then seat, zero-based round index and tick. */
function ContextLine({ c, detail = false }: { c: ReviewContext; detail?: boolean }) {
  return (
    <span className="cgraph-context">
      <span className="cgraph-trial"><span className="cgraph-context-key">Trial</span> {c.trialName}</span>
      <span className="cgraph-context-facts">
        {c.seat && <span className={`cgraph-seat cgraph-seat-${c.seat}`}>{c.seat === 'blue' ? 'Blue' : 'Red'} seat</span>}
        {c.roundIndex !== null && <span>Round index {c.roundIndex}{detail && ' (archive numbering starts at 0)'}</span>}
        <span>Released tick {c.releasedTick}</span>
      </span>
    </span>
  );
}

type Relation = NodeDetail['relations']['items'][number];

/**
 * Review path for one recorded decision. Every shortcut opens an endpoint present in this relation page, never a raw id
 * property, so it cannot reach a record the current view hides. The rationale is a React string child, so it is escaped.
 */
function DecisionReview({ n, r, onOpen }: { n: NodeDetail['node']; r: NodeDetail['relations']; onOpen: (id: string) => void }) {
  const linked = (key: string): Relation | undefined => {
    const id = n.properties[key];
    return typeof id === 'string' ? r.items.find((x) => x.endpoint.id === id) : undefined;
  };
  const shortcuts: [string, Relation | undefined][] = [
    ['What the model saw', linked('snapshotArtifactId')],
    ['Saved reply', linked('savedReplyArtifactId')],
  ];
  const outcome = r.items.find((x) => x.direction === 'out' && x.edge.type === 'FOLLOWED_BY');
  const missing = shortcuts.filter(([, x]) => !x).map(([label]) => label);
  const rationale = n.properties.modelStatedRationale;
  const paged = r.offset > 0 || r.truncated;
  return (
    <section className="cgraph-review" aria-labelledby="cgraph-review-title">
      <h4 id="cgraph-review-title">Review this decision</h4>
      <p className="cgraph-context-key">Model’s stated reason</p>
      {typeof rationale === 'string' && rationale.trim()
        ? <blockquote className="cgraph-rationale">{rationale}</blockquote>
        : <p className="cgraph-hint">No stated reason was recorded for this decision.</p>}
      <div className="cgraph-review-nav" role="group" aria-label="Decision review shortcuts">
        {shortcuts.map(([label, x]) => <button key={label} type="button" className="btn btn-sm" disabled={!x} onClick={() => x && onOpen(x.endpoint.id)}>{label}</button>)}
        <button type="button" className="btn btn-sm" disabled={!outcome} onClick={() => outcome && onOpen(outcome.endpoint.id)}>Observed round outcome</button>
      </div>
      {missing.length > 0 && <p className="cgraph-hint">{missing.join(' and ')}: not in this relation page or review timeline.{paged && ' Use the relation pager below.'}</p>}
      {!outcome && <p className="cgraph-hint">Outcome is not available in this relation page or review timeline.</p>}
      <p className="cgraph-hint">Both players may act within a round. A later board change alone does not establish which player’s order caused it.</p>
    </section>
  );
}

/**
 * Opt-in reader for one archived SourceArtifact. The parent keys it by node id + view, so any node, view or scope change
 * remounts it: open state resets, the in-flight request aborts, and text for another node never renders.
 * Text is a React string child of <pre>, so it is escaped and never interpreted as HTML or Markdown.
 */
function SourceReader({ node, view }: { node: NodeDetail['node']; view: ViewParams }) {
  const [open, setOpen] = useState(false);
  const load = useGraphFetch<SourceText>(open ? '/api/catalog/graph/source' : null, { ...view, id: node.id }, sourceMessage);
  const got = load.state === 'ready' ? load.data : null;
  // Refuse a body that is not for this node, this view, or the hash the graph recorded.
  const sameView = !!got && (view.clock === undefined ? got.view === null : got.view?.clock === view.clock && got.view.cutoffTick === view.cutoffTick);
  const mismatch = !!got && (got.nodeId !== node.id || !sameView || got.sha256 !== node.provenance.sourceSha256);
  const data = mismatch ? null : got;
  const rehash = useTextRehash(data);

  if (!open) {
    return (
      <div className="cgraph-source">
        <p className="cgraph-hint">Saved evidence file from a completed game. Opening shows its archived text only; it does not replay the game.</p>
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}><FileText size={13} aria-hidden="true" /> Open saved source</button>
      </div>
    );
  }
  return (
    <section className="cgraph-source is-open" aria-label={`Saved source ${node.label}`}>
      <div className="cgraph-source-head">
        <strong>Saved source</strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}><X size={13} aria-hidden="true" /> Close source</button>
      </div>
      {load.state === 'pending' && <Busy label="Reading from native archive…" />}
      {load.state === 'error' && <InlineError message={load.message} />}
      {mismatch && <InlineError message="The server returned a source that does not match this record, view or recorded hash, so it was not shown." />}
      {data && <>
        <p className="cgraph-source-notice">Saved model evidence from the native Kamiwaza archive. Compare the model’s explanation with the recorded outcome.</p>
        <pre className="cgraph-source-text" tabIndex={0} aria-label={`Text of ${data.path}`}>{data.text}</pre>
        <details className="cgraph-meta"><summary>Verified source · {data.bytes.toLocaleString()} bytes</summary>
        <dl className="cgraph-prov">
          <div><dt>Path</dt><dd><code>{data.path}</code> · {data.bytes} bytes</dd></div>
          <div><dt>File sha256</dt><dd><code>{data.sha256}</code>{rehash && <span className="cgraph-hint"> · {rehash}</span>}</dd></div>
          <div><dt>Native archive</dt><dd><code>{data.archive.datasetUrn}</code> · object <code>{data.archive.objectId}</code></dd></div>
          <div><dt>Archive sha256</dt><dd><code>{data.archive.sha256}</code></dd></div>
          {data.view && <div><dt>Review view</dt><dd><code>{data.view.clock}</code> · released by tick {data.view.cutoffTick}</dd></div>}
          {data.receipts.length > 0 && <div><dt>Receipts</dt><dd>{data.receipts.length} verification receipt{data.receipts.length === 1 ? '' : 's'}</dd></div>}
        </dl>
        </details>
      </>}
    </section>
  );
}

/** Re-hashes the displayed text in the browser as a second check. Stays silent without WebCrypto (non-secure context). */
function useTextRehash(data: SourceText | null): string | null {
  const [result, setResult] = useState<{ for: SourceText; note: string } | null>(null);
  useEffect(() => {
    const subtle = globalThis.crypto?.subtle;
    if (!data || !subtle) return;
    let live = true;
    subtle.digest('SHA-256', new TextEncoder().encode(data.text)).then((buf) => {
      const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      if (live) setResult({ for: data, note: hex === data.sha256 ? 'displayed text re-hashed in browser: match' : 'displayed text differs from raw bytes after decoding' });
    }, () => {});
    return () => { live = false; };
  }, [data]);
  return result && result.for === data ? result.note : null;
}

/** Decorative radial view of the current relation page; the list below is the accessible equivalent. */
function Ego({ center, items, onOpen }: { center: NodeRef; items: NodeDetail['relations']['items']; onOpen: (id: string) => void }) {
  const W = 440, H = 230, RX = 140, RY = 86, cx = W / 2, cy = H / 2;
  const trim = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
  return (
    <svg className="cgraph-ego" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      {items.map((x, i) => {
        const a = (2 * Math.PI * i) / items.length - Math.PI / 2, px = cx + RX * Math.cos(a), py = cy + RY * Math.sin(a);
        return (
          <g key={x.edge.id} className="cgraph-ego-node" onClick={() => onOpen(x.endpoint.id)}>
            <line x1={cx} y1={cy} x2={px} y2={py} />
            <circle cx={px} cy={py} r={6} className={`cgraph-dot-${x.endpoint.dataClass}`} />
            <text x={px} y={py + (py < cy ? -10 : 17)} textAnchor="middle">{trim(x.endpoint.label)}</text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={10} className={`cgraph-dot-${center.dataClass} cgraph-ego-center`} />
    </svg>
  );
}
