import {budgetCapReached,budgetUsageText} from '../budget-presentation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, GitBranch, RefreshCw, Share2, UploadCloud } from 'lucide-react';
import type { ViewContext } from '../App';
import { Busy, Empty, InlineError, Panel, Stat } from './ui';
import { fmtUsd } from '../lib';
import {
  ontologyApi,
  OntologyApiError,
  type Budget,
  type HealthState,
  type NativeErrorBlock,
  type NativeReceipt,
  type OntologyRead,
  type PublishRecord,
  type PublishResponse,
  type SubgraphSource,
} from '../ontology-api';
import '../ontology.css';

/**
 * Shared workroom domain graph. Reads are free and cached server-side; the only paid action is the
 * instructor's explicit publish. Everything shown as "native" comes from the platform's own answers;
 * the curated definition is rendered separately and labelled as a local definition.
 *
 * `mode="platform"` adds the technical notes (bridge, CPU embeddings, service identity). Use
 * `mode="compact"` anywhere a learner sees it.
 */
export function OntologyPanel({ ctx, mode = 'platform' }: { ctx: ViewContext; mode?: 'platform' | 'compact' }) {
  const { ov } = ctx;
  const [data, setData] = useState<OntologyRead | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    try {
      const r = await ontologyApi.read(ac.signal);
      if (!ac.signal.aborted) {
        setData(r);
        setLoadErr(null);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setLoadErr(friendly(e));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);

  const native = data?.native ?? null;
  const graph = useMemo<Graph | null>(() => {
    if (!native || native.subgraph.error) return null;
    return {
      variant: 'native',
      nodes: native.subgraph.nodes.map((n) => ({ id: n.uuid, name: n.name, type: n.type, summary: n.summary })),
      edges: native.subgraph.edges.map((e) => ({ id: e.fact_uuid, source: e.source_uuid, target: e.target_uuid, name: e.name, fact: e.fact, validAt: e.valid_at, invalidAt: e.invalid_at })),
    };
  }, [native]);
  const local = useMemo<Graph | null>(
    () => (data ? { variant: 'local', nodes: data.definition.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, summary: n.summary })), edges: data.definition.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, name: e.name, fact: e.fact, validAt: null, invalidAt: null })) } : null),
    [data],
  );
  const published = data?.publish.status === 'accepted';
  const nativeHasGraph = !!graph && graph.nodes.length > 0;

  return (
    <div className="onto">
      <Panel
        title={<><Share2 size={15} aria-hidden="true" /> Domain ontology · shared workroom graph</>}
        aside={
          <span className="onto-head-aside">
            {data && <ModeTag data={data} />}
            {native && <HealthTag state={native.health.state} cached={native.health.cached} />}
            {data && <PublishTag status={data.publish.status} />}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} disabled={loading} title="Re-read the graph (not a paid call)">
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </span>
        }
      >
        {loading && !data && <Busy label="Reading the workroom graph…" />}
        <InlineError message={loadErr} />
        {data && (
          <div className="onto-lead">
            <p className="lead">
              {data.source.title} · <span className="mono">{data.source.sourceId}@{data.source.version}</span>
            </p>
            <p className="onto-scope">
              <strong>Scope.</strong> The shared graph holds only the abstract training-game ontology: {data.source.conceptCount} concepts and {data.source.relationshipCount} rules about legal tools, source supersession, the clock, replay and branch isolation. No doctrine, no real adversary intelligence. Learner profiles, personal orders, released reports and user identifiers are never published; your per-subject learning record stays private to REPLAY.
            </p>
            <div className="onto-grid">
              <Stat label="Source hash" value={<span className="mono" title={data.source.hash}>{data.source.hash.replace(/^sha256:/, '').slice(0, 16)}</span>} hint="sha256 of src/ontology/domain.ts as rendered" />
              <Stat label="Workroom group" value={<span className="mono">{data.workroomId ? data.workroomId.slice(0, 8) : '—'}</span>} hint={data.workroomId ? 'native group id = configured workroom' : 'no native workroom'} />
              <Stat label="Ontology instance" value={<span className="mono">{data.ontologyId ? data.ontologyId.slice(0, 8) : 'not configured'}</span>} hint={data.configured ? 'REPLAY_ONTOLOGY_ID' : 'REPLAY_ONTOLOGY_ID unset'} />
              <Stat label="Native seat" value={native ? `${native.identity.nativeRole ?? '?'} · ${native.identity.canEdit ? (native.identity.canRunAgents ? 'write · agents' : 'write') : 'read-only'}` : 'none'} hint={native?.identity.validatedAt ? `validated ${new Date(native.identity.validatedAt).toLocaleTimeString()}` : ov.identity.mode === 'local-demo' ? 'local demo identity' : undefined} />
            </div>
          </div>
        )}
      </Panel>

      {data && (
        <Panel
          title={nativeHasGraph || (native && !native.subgraph.error) ? 'Native workroom graph' : 'Graph'}
          aside={native ? <span className="muted small">{native.subgraph.error ? 'not read' : `${native.subgraph.nodes.length} nodes · ${native.subgraph.edges.length} edges${native.subgraph.truncated ? ' · sampled' : ''}${native.subgraph.cached ? ' · cached ≤15 s' : ''}`}</span> : <span className="tag tag-warn">no native graph</span>}
        >
          {!native && (
            <Empty>
              {data.mode === 'local-demo' ? 'This instance runs local demo identities; there is no native workroom graph to read.' : data.publish.reason}
            </Empty>
          )}
          {native?.subgraph.error && (
            <div className="onto-outcome is-failed" role="status">
              <strong>The platform graph could not be read.</strong>
              <span>{explainNativeError(native.subgraph.error)}</span>
              {native.subgraph.error.requestId && <span className="mono small">native request {native.subgraph.error.requestId}</span>}
            </div>
          )}
          {native && !native.subgraph.error && graph && graph.nodes.length === 0 && (
            <Empty>The platform answered with an empty subgraph for this workroom{published ? '. The accepted batch may still be extracting, or extraction produced no entities yet.' : '; nothing has been published from this source.'}</Empty>
          )}
          {nativeHasGraph && graph && (
            <GraphExplorer graph={graph} selected={selected} onSelect={setSelected} sources={native!.subgraph.sources} provenance={published && data.publish.record ? data.publish.record : null} source={data.source} />
          )}
          {native?.subgraph.truncated && <p className="muted small"><AlertTriangle size={12} aria-hidden="true" /> Sampled subgraph: the platform or REPLAY's bound ({native.subgraph.bounds.maxNodes} nodes / {native.subgraph.bounds.maxEdges} edges) was hit.</p>}
          {native && native.subgraph.danglingEdges > 0 && <p className="muted small">{native.subgraph.danglingEdges} edges referenced nodes outside the sample and were not drawn.</p>}
        </Panel>
      )}

      {data && local && (!nativeHasGraph || !published) && (
        <Panel title={<><GitBranch size={15} aria-hidden="true" /> {data.definition.label}</>} aside={<span className="onto-state onto-state-local">local definition</span>}>
          <p className="muted small">This is the curated definition REPLAY would publish, drawn from its own source file. It is not read from the platform and proves nothing about the workroom graph.</p>
          <GraphExplorer graph={local} selected={selected} onSelect={setSelected} sources={[]} provenance={null} source={data.source} />
        </Panel>
      )}

      {data && (
        <PublishSection data={data} instructor={ov.identity.role === 'instructor'} onDone={load} />
      )}

      {data && (
        <Panel title="Native health and receipts" aside={<span className="muted small">reads are cached per workroom for about 15 s</span>}>
          {!native ? (
            <Empty>No native session; nothing was asked of the platform.</Empty>
          ) : (
            <>
              <div className="onto-grid">
                <Stat label="Ontology health" value={<HealthTag state={native.health.state} cached={native.health.cached} />} hint={native.health.error ? explainNativeError(native.health.error) : `checked ${new Date(native.health.checkedAt).toLocaleTimeString()}`} />
                <Stat label="Subgraph read" value={native.subgraph.error ? <span className="onto-state onto-state-error">failed</span> : <span className="onto-state onto-state-ready">answered</span>} hint={native.subgraph.receipt?.requestId ? `native request ${native.subgraph.receipt.requestId.slice(0, 8)}` : undefined} />
              </div>
              <div className="onto-receipts">
                <ReceiptRow label="GET ontology health" receipt={native.health.receipt} error={native.health.error} extra={native.health.raw} />
                <ReceiptRow label="GET workroom subgraph" receipt={native.subgraph.receipt} error={native.subgraph.error} extra={null} />
                {data.publish.record && <ReceiptRow label={`POST knowledge · attempt ${data.publish.record.attempt} · ${data.publish.record.status}`} receipt={data.publish.record.receipt} error={data.publish.record.error} extra={data.publish.record} />}
              </div>
            </>
          )}
        </Panel>
      )}

      {mode === 'platform' && data && (
        <Panel title="How this graph is produced" className="onto-tech">
          <ul className="doc-list">
            <li><strong>Native instance.</strong> The workroom's Graphiti + Neo4j instance was created through the platform's own ontology API in the same workroom as this app. REPLAY reads it with the signed ForwardAuth path of the signed-in seat; no proxy URL and no shared credential.</li>
            <li><strong>Extraction is metered.</strong> Graphiti's language-model calls are routed through REPLAY's internal bridge to the authorized connected model, so every extraction pass lands on the same project ledger and application allowance as the rest of the app. Bridge calls so far: {data.budget.bridgeRequests} (purpose <span className="mono">{data.budget.bridgePurpose}</span>).</li>
            <li><strong>Embeddings are local.</strong> Vector embeddings come from a CPU service in the workroom (384 dimensions; exact model identity retained in technical records). No paid embedding service.</li>
            <li><strong>Service identity.</strong> Graphiti calls the bridge with its own platform-issued workload identity, verified before any request is accepted. A REPLAY session never lends its token to the graph.</li>
            <li><strong>Truthful state.</strong> Health, node and edge counts and request ids are the platform's answers at read time. A platform outage is shown as one; nothing is fabricated.</li>
          </ul>
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

interface GNode { id: string; name: string; type: string; summary: string | null }
interface GEdge { id: string; source: string; target: string; name: string | null; fact: string; validAt: string | null; invalidAt: string | null }
interface Graph { variant: 'native' | 'local'; nodes: GNode[]; edges: GEdge[] }

const W = 640;
const H = 400;
const PALETTE = ['#1b8494', '#2c84b0', '#d66054', '#d9a441', '#4fa877', '#7a5fb8', '#b06a2c', '#5b6b7a'];

function GraphExplorer({ graph, selected, onSelect, sources, provenance, source }: { graph: Graph; selected: string | null; onSelect: (id: string | null) => void; sources: SubgraphSource[]; provenance: PublishRecord | null; source: OntologyRead['source'] }) {
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const typeColor = useMemo(() => {
    const types = Array.from(new Set(graph.nodes.map((n) => n.type))).sort();
    return new Map(types.map((t, i) => [t, PALETTE[i % PALETTE.length]]));
  }, [graph]);
  const sel = graph.nodes.find((n) => n.id === selected) ?? null;
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (!sel) return set;
    for (const e of graph.edges) {
      if (e.source === sel.id) set.add(e.target);
      if (e.target === sel.id) set.add(e.source);
    }
    return set;
  }, [graph, sel]);
  const showAllLabels = graph.nodes.length <= 24;
  const r = graph.nodes.length <= 20 ? 8 : graph.nodes.length <= 80 ? 5.5 : 4;
  const facts = sel ? graph.edges.filter((e) => e.source === sel.id || e.target === sel.id) : [];
  const nameOf = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);
  const sourcesOf = (factId: string) => sources.find((s) => s.fact_uuid === factId)?.sources ?? [];

  return (
    <div className="onto-graph-wrap">
      <div>
        <svg className={`onto-canvas${graph.variant === 'local' ? ' is-local' : ''}`} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`${graph.variant === 'local' ? 'Local definition' : 'Native workroom'} graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}>
          <defs>
            <marker id={`onto-arrow-${graph.variant}`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#9a927f" />
            </marker>
            <marker id={`onto-arrow-hot-${graph.variant}`} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#1b8494" />
            </marker>
          </defs>
          {graph.edges.map((e) => {
            const a = layout.get(e.source);
            const b = layout.get(e.target);
            if (!a || !b) return null;
            const hot = sel !== null && (e.source === sel.id || e.target === sel.id);
            const dim = sel !== null && !hot;
            const cls = `onto-edge${hot ? ' is-hot' : ''}${dim ? ' is-dim' : ''}`;
            const marker = `url(#onto-arrow-${hot ? 'hot-' : ''}${graph.variant})`;
            if (e.source === e.target) {
              const d = `M${a.x + r},${a.y} C${a.x + r + 26},${a.y - 30} ${a.x - r - 26},${a.y - 30} ${a.x - r},${a.y}`;
              return (
                <g key={e.id}>
                  <path className={cls} d={d} markerEnd={marker} />
                  {hot && <text className="onto-edge-label" x={a.x} y={a.y - 26} textAnchor="middle">{e.name ?? ''}</text>}
                </g>
              );
            }
            const { x1, y1, x2, y2 } = shorten(a, b, r + 1);
            return (
              <g key={e.id}>
                <line className={cls} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={marker} />
                {hot && e.name && <text className="onto-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 3} textAnchor="middle">{e.name}</text>}
              </g>
            );
          })}
          {graph.nodes.map((n) => {
            const p = layout.get(n.id)!;
            const isSel = sel?.id === n.id;
            const dim = sel !== null && !isSel && !neighbours.has(n.id);
            const label = showAllLabels || isSel || neighbours.has(n.id) || hover === n.id;
            return (
              <g
                key={n.id}
                className={`onto-node${isSel ? ' is-selected' : ''}${dim ? ' is-dim' : ''}`}
                transform={`translate(${p.x},${p.y})`}
                tabIndex={0}
                role="button"
                aria-label={`${n.name} (${n.type})`}
                aria-pressed={isSel}
                onClick={() => onSelect(isSel ? null : n.id)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(isSel ? null : n.id); } }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              >
                <circle r={isSel ? r + 2 : r} fill={typeColor.get(n.type)} />
                {label && <text x={0} y={r + 11} textAnchor="middle">{truncate(n.name, 22)}</text>}
                <title>{n.name} · {n.type}</title>
              </g>
            );
          })}
        </svg>
        <div className="onto-legend" aria-label="Node types">
          {Array.from(typeColor.entries()).map(([t, c]) => <span key={t}><i style={{ background: c }} /> {t}</span>)}
        </div>
      </div>
      <aside className="onto-details" aria-live="polite">
        {!sel ? (
          <>
            <h4>Select a node</h4>
            <p className="muted small">Click a node to highlight its neighbours and list the facts the {graph.variant === 'local' ? 'definition' : 'platform'} holds about it.</p>
          </>
        ) : (
          <>
            <h4>{sel.name} <span className="tag tag-muted">{sel.type}</span></h4>
            {sel.summary && <p className="small">{sel.summary}</p>}
            <div className="onto-prov">
              {graph.variant === 'local' ? (
                <>
                  <span>Defined in REPLAY source <span className="mono">{source.sourceId}@{source.version}</span></span>
                  <span className="mono">{source.hash}</span>
                </>
              ) : (
                <>
                  <span className="mono" title="Platform node uuid">{sel.id}</span>
                  {provenance ? (
                    <span>REPLAY published <span className="mono">{provenance.sourceId}@{provenance.sourceVersion}</span> ({provenance.sourceHash.replace(/^sha256:/, '').slice(0, 12)}…) on {new Date(provenance.startedAt).toLocaleString()}{provenance.receipt?.requestId ? <>, native request <span className="mono">{provenance.receipt.requestId.slice(0, 8)}</span></> : null}. Whether this node came from that batch is only known if the platform attributes the fact below.</span>
                  ) : (
                    <span>No accepted publish from this REPLAY version is on record; this node's origin is whatever the platform holds.</span>
                  )}
                </>
              )}
            </div>
            <strong className="small">{facts.length} {facts.length === 1 ? 'fact' : 'facts'}</strong>
            {facts.length === 0 ? <p className="muted small">No edges touch this node in the sample.</p> : (
              <ul className="onto-facts">
                {facts.map((e) => {
                  const out = e.source === sel.id;
                  const attributions = sourcesOf(e.id);
                  return (
                    <li key={e.id} className="onto-fact">
                      <span>{e.fact}</span>
                      <span className="onto-fact-meta">
                        <span className="tag tag-muted">{e.name ?? 'related'}</span>
                        <span>{out ? '→' : '←'} <button type="button" className="link" onClick={() => onSelect(out ? e.target : e.source)}>{nameOf(out ? e.target : e.source)}</button></span>
                        {e.validAt && <span title="valid_at">from {new Date(e.validAt).toLocaleDateString()}</span>}
                        {e.invalidAt && <span className="tag tag-warn" title="invalid_at">invalid since {new Date(e.invalidAt).toLocaleDateString()}</span>}
                        <span className="mono" title="fact id">{e.id.slice(0, 8)}</span>
                      </span>
                      {graph.variant === 'native' && (
                        attributions.length > 0 ? (
                          <span className="onto-fact-meta">sources: {attributions.map((s) => <span key={s.source_id} className="mono">{s.source_urn ?? s.source_id}</span>)}</span>
                        ) : (
                          <span className="onto-fact-meta">no source attribution returned by the platform for this fact</span>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/** Deterministic layout: types clustered around a ring, nodes sorted by name inside each cluster. Same input, same picture. */
function layoutGraph(graph: Graph): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const cx = W / 2;
  const cy = H / 2;
  const nodes = graph.nodes.slice().sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const types = Array.from(new Set(nodes.map((n) => n.type))).sort();
  if (nodes.length === 0) return out;
  if (types.length === 1 || nodes.length <= 12) {
    const R = Math.min(W, H) * 0.38;
    nodes.forEach((n, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / nodes.length;
      out.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    return out;
  }
  const R1 = Math.min(W, H) * 0.34;
  types.forEach((t, ti) => {
    const members = nodes.filter((n) => n.type === t);
    const a = -Math.PI / 2 + (2 * Math.PI * ti) / types.length;
    const ccx = cx + R1 * Math.cos(a);
    const ccy = cy + R1 * Math.sin(a);
    const r = Math.min(64, 10 + 7 * Math.sqrt(members.length));
    members.forEach((n, i) => {
      if (members.length === 1) {
        out.set(n.id, { x: ccx, y: ccy });
        return;
      }
      const b = (2 * Math.PI * i) / members.length;
      out.set(n.id, { x: ccx + r * Math.cos(b), y: ccy + r * Math.sin(b) });
    });
  });
  return out;
}

function shorten(a: { x: number; y: number }, b: { x: number; y: number }, by: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { x1: a.x + ux * by, y1: a.y + uy * by, x2: b.x - ux * by, y2: b.y - uy * by };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ------------------------------------------------------------------------------------------- */

function PublishSection({ data, instructor, onDone }: { data: OntologyRead; instructor: boolean; onDone: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PublishResponse | null>(null);
  const [budget, setBudget] = useState<Budget>(data.budget);
  useEffect(() => setBudget(data.budget), [data.budget]);

  if (!instructor) {
    return (
      <Panel title={<><UploadCloud size={15} aria-hidden="true" /> Publishing</>}>
        <p className="muted small">Only the instructor seat can publish the domain ontology to the workroom graph. Reading it is free for every seat.</p>
        <PublishState data={data} />
      </Panel>
    );
  }
  const unresolved = data.publish.status === 'uncertain' || data.publish.status === 'pending';
  const capReached = budgetCapReached(budget);
  const disabled = !data.publish.canPublish || busy || capReached || (unresolved && !ack);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setOutcome(null);
    try {
      const r = await ontologyApi.publish(unresolved ? { acknowledgeDuplicateRisk: true } : {});
      setOutcome(r);
      setBudget(r.budget);
      setConfirming(false);
      setAck(false);
      await onDone();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={<><UploadCloud size={15} aria-hidden="true" /> Publish the domain ontology</>}
      aside={<span className="mono small muted" title="Project inference budget shared with the whole app">{budgetUsageText(budget)} · bridge {budget.bridgeRequests}</span>}
    >
      <div className="onto-publish">
        <PublishState data={data} />
        <p className="muted small">{data.publish.reason}</p>
        {!confirming ? (
          <div className="action-row">
            <button type="button" className="btn btn-sm btn-primary" disabled={!data.publish.canPublish || busy || capReached} onClick={() => setConfirming(true)} title={capReached ? 'Project inference cap reached' : data.publish.canPublish ? 'Opens a confirmation; nothing is sent yet' : data.publish.reason}>
              {data.publish.status === 'uncertain' || data.publish.status === 'failed' ? 'Publish again (paid)' : 'Publish domain ontology (paid)'}
            </button>
            {capReached && <span className="tag tag-warn">project cap reached</span>}
          </div>
        ) : (
          <div className="onto-confirm" role="dialog" aria-label="Confirm paid publish">
            <strong>Publish to the workroom ontology</strong>
            <span>REPLAY sends one modelling batch ({data.source.episodeBytes.toLocaleString()} bytes, source {data.source.sourceId}@{data.source.version}) to the workroom Graphiti in group <span className="mono">{data.workroomId?.slice(0, 8)}</span>. Graphiti's extraction calls run through REPLAY's metered bridge and count against the same ledger ({budgetUsageText(budget)}). No new permission is granted or requested: your native seat must already allow writes and agent runs, and the platform decides.</span>
            <span>A pending record is written before the call. If the platform does not answer definitively, REPLAY will not retry on its own.</span>
            {unresolved && (
              <label>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand the previous attempt may already have been ingested and billed, and that sending again can bill a second batch.</span>
              </label>
            )}
            <div className="action-row">
              <button type="button" className="btn btn-sm btn-primary" disabled={disabled} onClick={() => void run()}>{busy ? 'Publishing…' : 'Confirm and publish'}</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setConfirming(false); setAck(false); }}>Cancel</button>
            </div>
          </div>
        )}
        {busy && <Busy label="Waiting for the platform's knowledge result…" />}
        <InlineError message={err} />
        {outcome && <Outcome r={outcome} />}
      </div>
    </Panel>
  );
}

function PublishState({ data }: { data: OntologyRead }) {
  const rec = data.publish.record;
  return (
    <div className="onto-grid">
      <Stat label="This version" value={<PublishTag status={data.publish.status} />} hint={rec ? `attempt ${rec.attempt} · ${new Date(rec.startedAt).toLocaleString()}` : 'no attempt recorded'} />
      <Stat label="Group" value={<span className="mono">{data.workroomId ? data.workroomId.slice(0, 8) : '—'}</span>} hint="always the configured workroom; the request cannot choose" />
      {rec?.receipt?.requestId && <Stat label="Native request" value={<span className="mono">{rec.receipt.requestId.slice(0, 8)}</span>} hint={`${rec.receipt.target.method} ${rec.receipt.target.path.split('/').slice(-1)[0]} · HTTP ${rec.receipt.status}`} />}
      {rec?.result && <Stat label="Messages processed" value={rec.result.addedCount} hint={`group ${rec.result.groupId.slice(0, 8)}`} />}
      {data.publish.history.length > 1 && (
        <div className="stat">
          <span className="stat-label">Earlier attempts</span>
          <ul className="onto-history">
            {data.publish.history.filter((h) => h.key !== rec?.key || h.attempt !== rec?.attempt).slice(0, 6).map((h) => (
              <li key={`${h.key}:${h.attempt}`}><PublishTag status={h.status} /> <span className="mono">{h.sourceId}@{h.sourceVersion}</span> · attempt {h.attempt} · {new Date(h.startedAt).toLocaleDateString()}</li>
            ))}
          </ul>
        </div>
      )}
      {rec && <p className="small" style={{ gridColumn: '1 / -1', margin: 0 }}>{rec.note}</p>}
    </div>
  );
}

function Outcome({ r }: { r: PublishResponse }) {
  const cls = r.status === 'accepted' ? 'is-accepted' : r.status === 'uncertain' ? 'is-uncertain' : 'is-failed';
  const headline = r.already ? 'Already published.' : r.status === 'accepted' ? 'Batch accepted by the platform.' : r.status === 'uncertain' ? 'No definite answer from the platform.' : 'The platform refused the batch.';
  return (
    <div className={`onto-outcome ${cls}`} role="status">
      <strong>{headline}</strong>
      <span>{r.record.note}</span>
      {r.record.error && <span className="small">{explainNativeError(r.record.error)}</span>}
      {r.record.receipt?.requestId && <span className="mono small">native request {r.record.receipt.requestId}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

function ModeTag({ data }: { data: OntologyRead }) {
  if (data.mode === 'local-demo') return <span className="onto-state onto-state-local" title="No native session">local</span>;
  return <span className="onto-state onto-state-ready" title="Signed native session">native session</span>;
}

function HealthTag({ state, cached }: { state: HealthState; cached: boolean }) {
  const label = state === 'ready' ? 'ready' : state === 'degraded' ? 'degraded' : state === 'unavailable' ? 'unavailable' : state === 'error' ? 'health check failed' : 'health unknown';
  return <span className={`onto-state onto-state-${state}`} title={cached ? 'Served from the ≤15 s read cache' : 'Read from the platform on this request'}>{label}</span>;
}

function PublishTag({ status }: { status: OntologyRead['publish']['status'] }) {
  const label = status === 'unpublished' ? 'not published' : status === 'accepted' ? 'published' : status === 'pending' ? 'publishing…' : status;
  return <span className={`onto-state onto-state-${status}`}>{label}</span>;
}

function ReceiptRow({ label, receipt, error, extra }: { label: string; receipt: NativeReceipt | null; error: NativeErrorBlock | null; extra: unknown }) {
  const json = JSON.stringify({ receipt, error, detail: extra ?? undefined }, null, 2);
  return (
    <details className="onto-receipt">
      <summary>
        <span>{label}</span>
        {receipt ? (
          <>
            <span className="tag tag-muted">HTTP {receipt.status}</span>
            <span className="mono">{receipt.requestId ? `req ${receipt.requestId.slice(0, 8)}` : 'no request id'}</span>
            <span className="muted">{receipt.durationMs} ms</span>
          </>
        ) : error ? (
          <span className="tag tag-danger">{error.code}{error.requestId ? ` · req ${error.requestId.slice(0, 8)}` : ''}</span>
        ) : (
          <span className="tag tag-muted">no receipt</span>
        )}
      </summary>
      <pre>{json}</pre>
    </details>
  );
}

function explainNativeError(e: NativeErrorBlock): string {
  switch (e.code) {
    case 'timeout':
      return 'The platform did not answer in time.';
    case 'network_error':
      return 'The platform could not be reached.';
    case 'auth_denied':
      return 'The platform denied this seat access to the ontology.';
    case 'unconfigured':
      return 'The server has no ontology instance configured.';
    case 'adapter_unsupported':
    case 'no_platform_client':
      return 'The server could not address the platform for this session.';
    case 'backend_rejected':
      return `The graph backend rejected the batch: ${e.message}`;
    default:
      return e.httpStatus ? `Platform error HTTP ${e.httpStatus} (${e.code}).` : `${e.message} (${e.code}).`;
  }
}

function friendly(e: unknown): string {
  if (e instanceof OntologyApiError) {
    if (e.status === 0) return 'The REPLAY backend is unreachable.';
    if (e.status === 401) return 'Sign in to read the workroom graph.';
    if (e.status === 403) return e.message;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
