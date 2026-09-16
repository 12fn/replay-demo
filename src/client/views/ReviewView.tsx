import { PageHeading, WorkspaceTabs } from '../components/Workspace';
import {ReportPerspectivePanel} from '../components/ReportPerspectivePanel';
import {DecisionTracePanel} from '../components/DecisionTracePanel';
import {KeyMomentsPanel} from '../components/KeyMomentsPanel';
import {ModelTrace} from '../components/ModelTrace';
import {InstructorReviewPanel} from '../components/InstructorReviewPanel';
import {LearningPanel} from '../components/LearningPanel';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Eye, GitBranch, Lock, Play, SkipBack, SkipForward } from 'lucide-react';
import { api, errorMessage, type Side } from '../api';
import type { ViewContext } from '../App';
import type {ReviewNavigation, ReviewMode, RecordTab} from '../review-navigation';
import { MapCanvas } from '../components/MapCanvas';
import {ExecutionPanel} from '../components/ExecutionPanel';
import {NetworkPanel} from '../components/NetworkPanel';
import { Busy, Empty, InlineError, KindBadge, Panel, SideBadge } from '../components/ui';
import { clamp, commitmentRatio, currentReportsAt, detailEntries, kindLabel, lineage as buildLineage, resolveEvidence, sideLabel, statusLabel, tickClock } from '../lib';

/** An explicit user selection waiting for its historical state before it may scroll. Passive refreshes never create one. */
export type FocusRequest = {seq: number; id: string; tick: number | null; side?: Side; perspectiveAsked?: boolean};
export type FocusStep = {kind: 'idle' | 'wait' | 'drop' | 'perspective'} | {kind: 'scroll'; target: 'source-perspective' | 'evidence'};
export const SOURCE_PERSPECTIVE_ANCHOR = 'review-source-perspective';

/** Decides what one explicit selection needs next; `drop` means the requested state will not arrive, so nothing scrolls later. */
export function nextFocusStep(req: FocusRequest | null, view: {highlightId: string | null; displayedTick: number; perspective: Side; seeking: boolean; selectedReportId: string | null}): FocusStep {
  if (!req) return {kind: 'idle'};
  if (view.highlightId !== req.id) return {kind: 'drop'};
  if (req.side && req.side !== view.perspective) return req.perspectiveAsked ? {kind: 'drop'} : {kind: 'perspective'};
  if (req.tick !== null && view.displayedTick !== req.tick) return view.seeking ? {kind: 'wait'} : {kind: 'drop'};
  return {kind: 'scroll', target: view.selectedReportId === req.id ? 'source-perspective' : 'evidence'};
}

export function ReviewView({ ctx, navigation, onModeChange: setReviewMode, onTabChange: setRecordTab }: {
  ctx: ViewContext; navigation: ReviewNavigation;
  onModeChange: (mode: ReviewMode) => void; onTabChange: (tab: RecordTab) => void;
}) {
  const { ov, refresh, active, assignedSide, perspective, setPerspective, selectedTile, setSelectedTile, navigate, pendingEvidence, clearPendingEvidence } = ctx;
  const role = ov.identity.role;
  const liveTick = active?.tick ?? ov.state.tick;
  const maxTick = Math.max(liveTick, ...ov.timeline.map((t) => t.tick), 0);
  const playback = ov.playbackTick;
  const displayedTick = playback ?? ov.state.tick;
  const lineage = useMemo(() => buildLineage(ov.exercises, ov.activeId), [ov.exercises, ov.activeId]);
  const isRecorded = active?.kind === 'recorded';

  const {tab: recordTab, mode: reviewMode} = navigation;
  const [scrub, setScrub] = useState<number | null>(null); // local slider position while dragging
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [branchSide, setBranchSide] = useState<Side>(assignedSide);
  const debounce = useRef<number | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusSeq = useRef(0);

  // Default the branch assignment to the side being viewed; the backend fixes it when the branch is created.
  useEffect(() => setBranchSide(perspective), [perspective]);

  const seek = async (tick: number | null) => {
    setBusy('seek');
    setErr(null);
    try {
      await api.replay(tick, ov.activeId);
      await refresh();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
      setScrub(null);
    }
  };

  const onScrub = (v: number) => {
    setScrub(v);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void seek(v), 250);
  };
  useEffect(() => () => { if (debounce.current) window.clearTimeout(debounce.current); }, []);

  const step = (delta: number) => {
    const next = clamp(displayedTick + delta, 0, maxTick);
    void seek(next);
  };

  const branch = async () => {
    const tick = displayedTick;
    if (tick < 1) return;
    setBusy('branch');
    setErr(null);
    try {
      await api.branch(tick, branchSide);
      // The backend selects the new branch and assigns branchSide; the overview refresh carries both.
      await refresh();
      navigate('exercise');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const timeline = useMemo(
    () => ov.timeline.filter((t) => !t.side || t.side === perspective).slice().sort((a, b) => a.sequence - b.sequence),
    [ov.timeline, perspective],
  );
  const findings = ov.findings.filter((f) => f.side === perspective);
  const reports = useMemo(() => ov.reports.filter((r) => r.side === perspective).slice().sort((a, b) => a.tick - b.tick), [ov.reports, perspective]);
  const selectedReport = reports.find(report=>report.id===highlight);
  const supersededIds = useMemo(() => new Set(reports.map((r) => r.supersedes).filter((x): x is string => !!x)), [reports]);

  // Opposing staff records are released after completion or to the instructor.
  const otherSideReleased = role === 'instructor' || active?.status === 'completed';
  const viewingOther = perspective !== assignedSide;

  const focus = (id: string, referenceTick?: number) => {
    setReviewMode('record');
    setRecordTab(ov.reports.some(r => r.id === id) ? 'reports' : 'timeline');
    setHighlight(id);
    const ref = resolveEvidence(ov, id);
    const target = referenceTick ?? ref.tick;
    const event = ov.timeline.find(e => e.id === id);
    if (event?.side) setPerspective(event.side);
    const seeking = target !== null && target !== displayedTick;
    // A fresh sequence number re-runs the scroll even when the same record is selected again.
    setFocusRequest({seq: ++focusSeq.current, id, tick: seeking ? target : null, side: event?.side});
    if (seeking) void seek(target);
  };

  // Scroll once per explicit selection, after its historical tick and side are displayed. Polling and manual seeks never scroll.
  useEffect(() => {
    const step = nextFocusStep(focusRequest, {highlightId: highlight, displayedTick, perspective, seeking: busy === 'seek', selectedReportId: selectedReport?.id ?? null});
    if (step.kind === 'idle' || step.kind === 'wait') return;
    if (step.kind === 'perspective') { setPerspective(focusRequest!.side!); setFocusRequest({...focusRequest!, perspectiveAsked: true}); return; }
    setFocusRequest(null);
    if (step.kind !== 'scroll') return; // drop
    const element = document.getElementById(step.target === 'source-perspective' ? SOURCE_PERSPECTIVE_ANCHOR : `evidence-${focusRequest!.id}`);
    if (!element) return; // Not released at this cutoff; never substitute a later record.
    const behavior: ScrollBehavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (step.target === 'source-perspective') {
      // Start-aligned so the panel heading clears the app header on the stacked narrow layout; focus follows the user's own selection.
      element.scrollIntoView({block: 'start', behavior});
      element.focus({preventScroll: true});
    } else {
      element.scrollIntoView({block: 'center', behavior});
    }
  }, [focusRequest, highlight, displayedTick, perspective, busy, selectedReport?.id, setPerspective]);

  // Evidence requested from another page.
  useEffect(() => {
    if (!pendingEvidence) return;
    const {id, tick} = pendingEvidence;
    clearPendingEvidence();
    focus(id, tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEvidence]);

  const sliderValue = scrub ?? displayedTick;
  const evidenceChip = (id: string) => {
    const ref = resolveEvidence(ov, id);
    return (
      <button key={id} type="button" className="chip" onClick={() => focus(id)} title={`${ref.kind} ${id}`}>
        {ref.tick !== null && <span className="mono">t{ref.tick}</span>} {ref.label}
      </button>
    );
  };

  return (<>
    <PageHeading title="Decision review" description="Select a recorded decision to inspect its reports, source timeline, and review notes." />
    <WorkspaceTabs label="Review workspace" value={reviewMode} onChange={setReviewMode} items={[{id:'record',label:'Decision record'},{id:'learning',label:'Debrief & handoff'}]} />
    <div className={`layout layout-review${reviewMode === 'learning' ? ' review-learning' : ''}`}>
      <section className="col col-map">
        {lineage && (
          <div className="lineage" role="group" aria-label="Record lineage">
            {lineage.source ? (
              <>
                <span className="lineage-node" title="Source exercise; its record does not change when you play a branch">
                  <KindBadge kind={lineage.source.kind} />
                  <span>{lineage.source.name}</span>
                  <Lock size={12} aria-hidden="true" />
                  <span className="muted small">{lineage.source.kind === 'live' ? `runs on · tick ${lineage.source.tick}` : `${statusLabel(lineage.source.status).toLowerCase()} · tick ${lineage.source.tick}`}</span>
                </span>
                <ArrowRight size={14} className="lineage-arrow" aria-hidden="true" />
                <span className="lineage-node is-active">
                  <KindBadge kind={lineage.active.kind} />
                  <span>{lineage.active.name}</span>
                  <span className="muted small">
                    forked at tick {lineage.forkTick} · you control {sideLabel(lineage.active.humanSide)} · {statusLabel(lineage.active.status).toLowerCase()}
                  </span>
                </span>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void api.select(lineage.source!.id).then(refresh)}>
                  Return to source exercise
                </button>
              </>
            ) : (
              <>
                <span className="lineage-node is-active">
                  <KindBadge kind={lineage.active.kind} />
                  <span>{lineage.active.name}</span>
                  <span className="muted small">
                    original · {statusLabel(lineage.active.status).toLowerCase()} · tick {lineage.active.tick} · you control {sideLabel(lineage.active.humanSide)}
                  </span>
                </span>
                {lineage.branches.length > 0 && (
                  <span className="muted small">
                    {lineage.branches.length} {lineage.branches.length === 1 ? 'branch' : 'branches'}:
                  </span>
                )}
                {lineage.branches.map((b) => (
                  <button key={b.id} type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} title={`Open ${b.name}`} onClick={() => void api.select(b.id).then(refresh)}>
                    <GitBranch size={12} aria-hidden="true" /> {sideLabel(b.humanSide)} @ {b.forkTick ?? '?'}
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        <div className="review-controls" role="group" aria-label="Playback">
          <div className="seg" role="radiogroup" aria-label="Viewing perspective (display only)">
            {(['blue', 'red'] as Side[]).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={perspective === s}
                className={`seg-btn seg-${s}${perspective === s ? ' is-on' : ''}`}
                onClick={() => setPerspective(s)}
                title="Changes which side's records are displayed. It does not change who you command."
              >
                <Eye size={12} aria-hidden="true" /> View as {sideLabel(s)}
              </button>
            ))}
          </div>
          <div className="playback">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null || displayedTick <= 0} onClick={() => step(-10)} title="Back 10 ticks">
              <SkipBack size={14} aria-hidden="true" />
            </button>
            <label className="sr-only" htmlFor="tick-range">Displayed tick</label>
            <input
              id="tick-range"
              type="range"
              min={0}
              max={Math.max(1, maxTick)}
              value={sliderValue}
              disabled={busy === 'branch'}
              onChange={(e) => onScrub(Number(e.target.value))}
              aria-valuetext={`tick ${sliderValue} (${tickClock(sliderValue)})`}
            />
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null || displayedTick >= maxTick} onClick={() => step(10)} title="Forward 10 ticks">
              <SkipForward size={14} aria-hidden="true" />
            </button>
            <span className="mono tick-readout">
              {sliderValue} / {maxTick} · {tickClock(sliderValue)}
            </span>
            {playback === null && active?.status === 'running' ? (
              <span className="badge badge-live">Live view</span>
            ) : active?.status === 'completed' ? (
              <span className="badge badge-recorded" title="Recorded exercises are read-only">Recorded</span>
            ) : (
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void seek(null)}>
                <Play size={13} aria-hidden="true" /> Return to live
              </button>
            )}
            {busy === 'seek' && <Busy label="Loading tick…" />}
          </div>
        </div>
        <InlineError message={err} />
        <MapCanvas
          stations={ov.campaign?.stations}
          state={ov.state}
          selectedTile={selectedTile}
          onSelectTile={setSelectedTile}
          perspective={perspective}
          caption={
            active
              ? `${kindLabel(active.kind)} · ${playback === null && active.status === 'running' ? `live tick ${ov.state.tick}` : `recorded state at tick ${displayedTick}`} · viewing as ${sideLabel(perspective)} · fingerprint ${ov.state.fingerprint.slice(0, 12)}`
              : undefined
          }
        />
        <details className="review-branch"><summary>Practice from this point</summary><Panel title="Continue from here" tone="dark" className="branch-panel">
          <p className="muted small">
            Creates a new branch of <strong>{active?.name ?? 'this exercise'}</strong> from the state at tick {displayedTick} ({tickClock(displayedTick)}).
            The source record stays exactly as it is. You will command the side you choose here; the exercise service fixes that assignment when the
            branch is created.
          </p>
          {!ov.state.spawning && ov.state.players.some(p => !p.alive) && <p className="small muted">Choose an earlier tick when both sides are still active. An eliminated side cannot continue legal practice.</p>}
          <div className="action-row">
            <div className="seg" role="radiogroup" aria-label="Side to command in the new branch">
              {(['blue', 'red'] as Side[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={branchSide === s}
                  className={`seg-btn seg-${s}${branchSide === s ? ' is-on' : ''}`}
                  onClick={() => setBranchSide(s)}
                >
                  Command {sideLabel(s)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || displayedTick < 1 || (!ov.state.spawning && ov.state.players.some(p => !p.alive))}
              title={displayedTick < 1 ? 'Move to at least tick 1 to branch' : !ov.state.spawning && ov.state.players.some(p => !p.alive) ? 'Choose an earlier tick when both sides are still active' : undefined}
              onClick={() => void branch()}
            >
              <GitBranch size={14} aria-hidden="true" /> {busy === 'branch' ? 'Creating branch…' : `Branch at tick ${displayedTick}`}
            </button>
          </div>
          <p className="muted small">Playing a branch after seeing the source's later record is informed practice; the dossier marks it that way.</p>
        </Panel></details>
      </section>

      <aside className="col col-right review-side">
        {reviewMode === 'record' && <>
        {selectedReport?<div id={SOURCE_PERSPECTIVE_ANCHOR} role="region" tabIndex={-1} aria-label={`Source perspective: ${selectedReport.title}`} style={{flex:'none', scrollMarginTop:8, outline:'none'}}><ReportPerspectivePanel report={selectedReport} references={reports} cutoffTick={displayedTick} onFocus={focus}/></div>:<DecisionTracePanel exerciseId={ov.activeId} eventId={highlight} side={perspective} cutoffTick={displayedTick} canShowLater={active?.status==='completed'&&displayedTick<maxTick}/>}
        <details className="panel execution-disclosure"><summary>Network &amp; order execution</summary><NetworkPanel view={ov.campaign} onSelect={setSelectedTile} /><ExecutionPanel orders={ov.executionOrders?.filter(o=>!o.side||o.side===perspective)} onEvidence={focus} /></details>
        {viewingOther && !otherSideReleased && (
          <div className="map-banner map-banner-quiet" role="status">
            <span>{sideLabel(perspective)} staff records are released when the exercise ends, or to an instructor.</span>
          </div>
        )}

        <WorkspaceTabs label="Evidence records" value={recordTab} onChange={setRecordTab} items={[{id:'decisions',label:'Decisions'},{id:'timeline',label:'Timeline'},{id:'reports',label:'Reports'}]} />
        <div className="stack" hidden={recordTab !== 'decisions'}><KeyMomentsPanel overview={ov} onEvidence={ctx.openEvidence}/>
        <Panel title={<>Recent orders <SideBadge side={perspective} /></>} className="findings" aside={<span className="muted small">{findings.length}</span>}>
          {findings.length === 0 ? (
            <Empty>No recorded decisions for {sideLabel(perspective)} up to this tick.</Empty>
          ) : (
            <ul className="finding-list">
              {findings
                .slice()
                .sort((a, b) => b.tick - a.tick)
                .map((f) => {
                  const ev = ov.timeline.find((t) => t.id === f.evidenceIds[0]);
                  const ratio = ev ? commitmentRatio(ev.details) : 0;
                  const detail=ev?.details as {observedTick?:number;observationBasis?:string}|undefined;
                  const observedTick=typeof detail?.observedTick==='number'?detail.observedTick:f.tick;
                  const available = currentReportsAt(reports,observedTick);
                  return (
                    <li key={f.id} className={`finding${f.tick > displayedTick ? ' is-future' : ''}`}>
                      <div className="finding-head">
                        <button type="button" className="link" onClick={() => f.evidenceIds[0] ? focus(f.evidenceIds[0],f.tick) : void seek(f.tick)} title="Review this order and its recorded perspective">
                          {f.title}
                        </button>
                        <span className="mono muted">t{f.tick} · {tickClock(f.tick)}</span>
                      </div>
                      <div className="finding-labels">
                        <span className="tag">{f.label}</span>
                        <span className="tag tag-muted">{f.criterion}</span>
                      </div>
                      <dl className="decision-facts">
                        {ev && (
                          <>
                            <dt>Action</dt>
                            <dd>{ev.summary}</dd>
                          </>
                        )}
                        {ratio > 0 && (
                          <>
                            <dt>Committed</dt>
                            <dd>{Math.round(ratio * 100)}% of {detail?.observationBasis==='app-snapshot-returned-with-order'?'snapshot forces':'forces at server admission'}</dd>
                          </>
                        )}
                        <dt>Available then</dt>
                        <dd>{available.length === 0 ? 'No staff reports had been released to this side.' : `${available.length} current ${available.length === 1 ? 'report' : 'reports'}: ${available.map((r) => r.title).join('; ')}`}</dd>
                        <dt>Confidence</dt>
                        <dd>{f.confidence}</dd>
                      </dl>
                      <p><span className="tag tag-muted">Recorded facts · fixed review prompt</span> {f.explanation}</p>
                      {f.alternative && (
                        <p className="alt">
                          <strong>Comparison to explore:</strong> {f.alternative}
                        </p>
                      )}
                      {f.evidenceIds.length > 0 && <div className="msg-sources">{f.evidenceIds.map(evidenceChip)}</div>}
                    </li>
                  );
                })}
            </ul>
          )}
        </Panel>

        </div><div hidden={recordTab !== 'timeline'}><Panel title="Timeline" className="timeline" aside={<span className="muted small">{timeline.length} events</span>}>
          {timeline.length === 0 ? (
            <Empty>No recorded events for this view.</Empty>
          ) : (
            <ol className="event-list">
              {timeline.map((t) => {
                const rows = highlight === t.id ? detailEntries(t.details) : [];
                return (
                  <li
                    key={t.id}
                    id={`evidence-${t.id}`}
                    className={`event${highlight === t.id ? ' is-hl' : ''}${t.tick > displayedTick ? ' is-future' : ''}`}
                  >
                    <button
                      type="button"
                      className="event-btn"
                      onClick={() => (highlight === t.id ? setHighlight(null) : focus(t.id))}
                      aria-expanded={highlight === t.id}
                      aria-label={`Tick ${t.tick}: ${t.summary}`}
                    >
                      <span className="mono ev-tick">{t.tick}</span>
                      <span className="ev-kind">{t.kind.replaceAll('_', ' ')}</span>
                      {t.side && <SideBadge side={t.side} />}
                      <span className="ev-summary">{t.summary}</span>
                      <span className="ev-actor muted">{t.actor}</span>
                    </button>
                    {highlight === t.id && <ModelTrace event={t} />}
                    {highlight === t.id && rows.length > 0 && (
                      <dl className="detail-list">
                        {rows.map((r) => (
                          <div key={r.key}>
                            <dt>{r.key}</dt>
                            <dd>{r.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        </div><div hidden={recordTab !== 'reports'}><Panel title={<>Reports released to {sideLabel(perspective)}</>} className="review-reports" aside={<span className="muted small">{reports.length}</span>}>
          {reports.length === 0 ? (
            <Empty>None up to this tick.</Empty>
          ) : (
            <ul className="report-list compact">
              {reports
                .slice()
                .reverse()
                .map((r) => (
                  <li key={r.id} id={`evidence-${r.id}`} className={`report${highlight === r.id ? ' is-hl' : ''}${supersededIds.has(r.id) ? ' is-superseded' : ''}`}>
                    <div className="report-head">
                      <button type="button" className="link" onClick={() => focus(r.id)}>{r.title}</button>
                      <span className="mono muted">t{r.tick}</span>
                    </div>
                    <p>{r.body}</p>
                    <div className="report-meta">
                      <span>Source: {r.source}</span>
                      <span>{r.confidence}</span>
                      {r.synthetic && <span className="tag tag-muted">synthetic</span>}
                      {supersededIds.has(r.id) && <span className="tag tag-warn">superseded</span>}
                      {r.supersedes && (
                        <button type="button" className="link small" onClick={() => focus(r.supersedes!)}>
                          replaces: {reports.find((x) => x.id === r.supersedes)?.title ?? 'earlier report'}
                        </button>
                      )}
                      {r.parentSourceId && <span>copied from the source exercise at the fork</span>}
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
        </div></>}
        {reviewMode === 'learning' && <><LearningPanel ctx={ctx} mode="review" /><InstructorReviewPanel ctx={ctx} /></>}
</aside>
    </div>
  </>);
}
