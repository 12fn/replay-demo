import {modelPresentation,configuredModelPresentation} from '../model-presentation';
import {NoteIntakePanel} from './NoteIntakePanel';
import {DecisionRetrievalPanel} from './DecisionRetrievalPanel';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { BookOpen, Download, FileText, MessageSquare, RefreshCw, Sparkles } from 'lucide-react';
import type { Report, Side, TimelineEvent } from '../api';
import type { ViewContext } from '../App';
import { Busy, Empty, InlineError, KindBadge, Panel } from './ui';
import { citingSourceCell, learningApi, LearningApiError, provenanceOf, referenceSuffixLabel, splitReferenceId, type AttemptSummary, type Budget, type CitedSource, type DebriefClaim, type DebriefRecord, type DebriefReference, type DebriefResponse, type DossierResponse, type ObservedBehavior, type StatementView } from '../learning-api';
import { fmtUsd, resolveEvidence, sideLabel, tickClock } from '../lib';
import '../learning.css';
import {DebriefFeedbackPanel} from './DebriefFeedbackPanel';

/**
 * Learner workspace over the evidence-led dossier. `practice` renders the full dossier;
 * `review` renders the dense form (observations, post-hoc statements, debrief) beside the
 * timeline. Nothing here pauses or blocks the exercise; every write is optional.
 */
export function LearningPanel({ ctx, mode }: { ctx: ViewContext; mode: 'practice' | 'review' }) {
  const { ov, active, assignedSide, openEvidence, refresh } = ctx;
  const role = ov.identity.role;
  const [data, setData] = useState<DossierResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      const r = await learningApi.dossier(ac.signal);
      if (!ac.signal.aborted) {
        setData(r);
        setLoadErr(null);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setLoadErr(errText(e));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  // Reload when the exercise changes or its record grows; debounced so live ticks do not hammer the API.
  const recordKey = `${ov.activeId}:${ov.timeline.length}:${ov.reports.length}`;
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), data ? 1200 : 0);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordKey, load]);
  useEffect(() => () => abort.current?.abort(), []);

  const reload = async () => { await refresh(); await load(); };
  const d = data?.dossier ?? null;
  const ownOrders = useMemo(
    () => ov.timeline.filter((t) => t.kind === 'command' && originOf(t) === 'human' && (role === 'instructor' || t.actor === ov.identity.subject)).slice().sort((a, b) => a.tick - b.tick),
    [ov.timeline, ov.identity.subject, role],
  );

  const chip = (id: string) => <EvidenceChip key={id} id={id} ov={ov} onOpen={openEvidence} />;

  return (
    <div className={`learning learning-${mode}`}>
      <Panel
        title={<><BookOpen size={15} aria-hidden="true" /> Learning dossier · {ov.identity.name}</>}
        className="learning-main"
        aside={
          <span className="learning-head-aside">
            <span className="tag tag-muted" title={d ? `${d.provenance.curriculumId} ${d.provenance.curriculumVersion} · ${d.provenance.curriculumStatus}` : 'Curriculum criteria are provisional and unreviewed'}>provisional criteria</span>
            {data?.attributed ? <span className="tag">attributed to you</span> : <span className="tag tag-warn">not attributed</span>}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()} disabled={loading} title="Reload the dossier">
              <RefreshCw size={12} aria-hidden="true" />
            </button>
            {data?.attributed && (
              <a className="btn btn-sm" href={learningApi.dossierMarkdownUrl} download title="Download this dossier as Markdown">
                <Download size={12} aria-hidden="true" /> Markdown
              </a>
            )}
          </span>
        }
      >
        {loading && !data && <Busy label="Building dossier…" />}
        <InlineError message={loadErr} />
        {data && !data.attributed && (
          <>
            <p className="lead">{data.reason}</p>
            <p className="muted small">Orders you issue in an exercise started from your own session are attributed to you. Records here remain evidence for review, but no personal comparison is drawn from them.</p>
          </>
        )}
        {d && (
          <>
            <p className="lead">{d.roleSummary}</p>
            <AttemptTable current={d.current} prior={d.independentPrior} informed={d.informedPractice} />
            {mode === 'practice' && (
              <div className="learning-lines">
                {d.comparison.map((line, i) => <p key={i} className="small">{line}</p>)}
              </div>
            )}
          </>
        )}
      </Panel>

      {d && (
        <Panel title="Observed behaviour" className="learning-observations" aside={<span className="muted small">{d.observations.length} records</span>}>
          {d.observations.length === 0 ? (
            <Empty>No orders, assessments or watches recorded by you in this attempt yet.</Empty>
          ) : (
            <>
              <details className="small muted">
                <summary>How reasons, citations and ticks are labelled</summary>
                <ul className="doc-list">
                  <li>Only text you wrote is shown as a reason. A report cited without text is listed as a citation with no written reason; nothing is inferred from it.</li>
                  <li>Text written at submission stays the reason on record. Later post-hoc statements are listed separately and never replace it.</li>
                  <li>"Viewed" is the tick you were looking at; "recorded" is when the entry was written. Citation currency is judged at the viewed tick.</li>
                </ul>
              </details>
              <ul className="obs-list">
                {d.observations.map((o) => {
                  const probe = d.probes.find((p) => p.evidenceId === o.evidenceId);
                  const ev = ov.timeline.find((t) => t.id === o.evidenceId);
                  return (
                    <li key={o.evidenceId} className="obs">
                      <ObservationRow o={o} chip={chip} onOpen={openEvidence} />
                      {probe && ev && (
                        <DecisionLogForm event={ev} question={probe.question} reports={ov.reports} side={(ev.side ?? assignedSide) as Side} onSaved={reload} />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Panel>
      )}

      {(role === 'intelligence' || role === 'instructor') && data?.attributed && (
        <AssessmentForm exerciseId={ov.activeId} reports={ov.reports} side={assignedSide} live={ov.playbackTick === null && active?.status === 'running'} displayedTick={ov.playbackTick ?? ov.state.tick} onSaved={reload} />
      )}

      {d && mode === 'practice' && (
        <>
          <Panel title="Unobserved or uncertain" className="learning-gaps" aside={<span className="muted small">{d.gaps.length}</span>}>
            {d.gaps.length === 0 ? <Empty>Nothing flagged. Absence of a flag is not a judgment.</Empty> : (
              <ul className="gap-list">
                {d.gaps.map((g) => (
                  <li key={`${g.kind}-${g.criterion}`}>
                    <div className="gap-head"><span className="tag">{g.criterion}</span> <strong>{g.kind.replaceAll('-', ' ')}</strong></div>
                    <p className="small">{g.note}</p>
                    <div className="msg-sources">{g.evidenceIds.slice(0, 8).map(chip)}{g.evidenceIds.length > 8 && <span className="muted small">+{g.evidenceIds.length - 8} more</span>}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Targeted practice" className="learning-practice">
            <ul className="practice-list">
              {d.practice.map((p, i) => (
                <li key={i}>
                  <div className="gap-head"><span className="tag">{p.objective}{p.criterion ? ` · ${p.criterion}` : ''}</span> <strong>{p.title}</strong></div>
                  <p className="small">{p.instruction}</p>
                  {p.evidenceIds.length > 0 && <div className="msg-sources">{p.evidenceIds.slice(0, 6).map(chip)}</div>}
                </li>
              ))}
            </ul>
            <h3 className="sub">Next session · {d.nextSession.role} · variant {d.nextSession.variantId}</h3>
            <ol className="doc-list step-list">{d.nextSession.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </Panel>
          <Panel title="Counterfactual practice (separate)" className="learning-cf">
            <p className="small muted">{d.counterfactual.note}</p>
            {d.counterfactual.attempts.length === 0 ? <Empty>No branch attempts.</Empty> : (
              <ul className="plain-list">
                {d.counterfactual.attempts.map((c) => (
                  <li key={c.exerciseId} className="small">
                    <KindBadge kind="branch" /> {c.name ?? c.exerciseId.slice(0, 8)} · fork tick {c.forkTick ?? '?'} · {c.humanCommandsAfterFork} orders after fork
                    {c.lastObserved && ` · last observed t${c.lastObserved.tick}${c.lastObserved.tiles !== undefined ? `, ${c.lastObserved.tiles} tiles` : ''}`}
                  </li>
                ))}
              </ul>
            )}
            {d.excluded.length > 0 && (
              <>
                <h3 className="sub">Not compared</h3>
                <ul className="plain-list">
                  {d.excluded.map((e) => (
                    <li key={e.exerciseId} className="small"><span className="mono">{ov.exercises.find((x) => x.id === e.exerciseId)?.name ?? e.exerciseId.slice(0, 8)}</span> · {e.reason.replaceAll('-', ' ')}</li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
          <Panel title="Limitations" className="learning-limits">
            <ul className="doc-list muted small">{d.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </Panel>
        </>
      )}

      {data && (data.attributed || role === 'instructor') && (
        <DebriefSection key={ov.activeId} ov={ov} orders={ownOrders} completed={active?.status === 'completed'} instructor={role === 'instructor'} budget={data.budget} onOpen={openEvidence} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

/**
 * One observed record. Rendering is driven entirely by `provenanceOf`, so the tag can never say
 * "reason" for a citation-only order, the submission-time statement is never displaced by a later
 * annotation, and the viewed tick is separated from the recorded tick.
 */
function ObservationRow({ o, chip, onOpen }: { o: ObservedBehavior; chip: (id: string) => ReactElement; onOpen: ViewContext['openEvidence'] }) {
  const p = provenanceOf(o);
  const cites = (sources: CitedSource[]) => sources.length > 0 && (
    <span className="obs-cites">
      {sources.map((s) => (
        <span key={s.id} className="obs-cite">
          {chip(s.id)}
          <span className={`tag ${s.status === 'superseded' ? 'tag-warn' : 'tag-muted'}`} title={s.status === 'superseded' ? `Superseded by ${s.supersededBy?.slice(0, 8) ?? 'a later report'} at the viewed tick t${p.observedTick}` : `Currency at the viewed tick t${p.observedTick}`}>
            {s.status === 'superseded' ? 'superseded at viewed tick' : s.status}
          </span>
        </span>
      ))}
    </span>
  );
  const statement = (s: StatementView, primary: boolean) => (
    <blockquote key={s.evidenceId} className="obs-rationale" style={primary ? undefined : { borderLeftStyle: 'dashed', opacity: 0.9 }}>
      <span className="obs-labels">
        <span className={`tag ${s.timing === 'contemporaneous' ? '' : 'tag-warn'}`}>{s.label}</span>
        <button type="button" className="link mono small" onClick={() => onOpen(s.evidenceId, s.tick)} title="Open the statement record in Review">t{s.tick}{s.recordedAt ? ` · ${new Date(s.recordedAt).toLocaleString()}` : ''}</button>
      </span>
      {s.text}
      {cites(s.sources)}
    </blockquote>
  );
  return (
    <>
      <div className="obs-head">
        <button type="button" className="link" onClick={() => onOpen(o.evidenceId, p.observedTick)} title="Open in Review">{o.summary}</button>
        <span className="mono muted small" title={p.snapshotLag ? `Written at tick ${p.recordedTick} while viewing tick ${p.observedTick}` : `Recorded at tick ${p.recordedTick}`}>
          {p.tickLabel} · {tickClock(p.observedTick)}
        </span>
      </div>
      <div className="obs-labels">
        <span className="tag tag-muted">{o.kind}</span>
        {p.snapshotLag && <span className="tag tag-warn" title="The viewed snapshot precedes recording. A live order can have this delay; it does not mean the reason was written after the fact.">earlier snapshot</span>}
        {o.commitmentRatio !== undefined && <span className="tag tag-muted">{Math.round(o.commitmentRatio * 100)}% of {o.observationBasis === 'client-snapshot' ? 'snapshot forces' : 'forces at server admission'}</span>}
        {p.tag && <span className={`tag ${p.tagTone === 'plain' ? '' : p.tagTone === 'warn' ? 'tag-warn' : 'tag-muted'}`}>{p.tag}</span>}
        {o.criteria.map((c) => <span key={c} className="tag tag-muted">{c}</span>)}
      </div>
      {p.primary && statement(p.primary, true)}
      {p.citationsWithoutReason && p.citations.length > 0 && (
        <div className="small">
          <span className="muted">Cited at submission, no written reason: </span>
          {cites(p.citations)}
        </div>
      )}
      {!p.primary && !p.citationsWithoutReason && o.kind === 'assessment' && p.citations.length > 0 && (
        <div className="small"><span className="muted">Cites: </span>{cites(p.citations)}</div>
      )}
      {p.others.length > 0 && (
        <details className="small">
          <summary>{p.others.length} other recorded statement{p.others.length === 1 ? '' : 's'} (kept separately, not merged into the reason above)</summary>
          {p.others.map((s) => statement(s, false))}
        </details>
      )}
    </>
  );
}

function AttemptTable({ current, prior, informed }: { current: AttemptSummary; prior: AttemptSummary[]; informed: AttemptSummary[] }) {
  const row = (a: AttemptSummary) => (
    <tr key={a.exerciseId} className={`row-${a.label}`}>
      <td className="cell-name"><KindBadge kind={a.kind} /> <span>{a.name ?? a.exerciseId.slice(0, 8)}</span></td>
      <td><span className="tag tag-muted">{a.label.replaceAll('-', ' ')}</span></td>
      <td>{a.assistance}</td>
      <td className="num">{a.counts.humanCommands}</td>
      <td className="num">{a.counts.commandsWithRationale}</td>
      <td className="num" title="Orders citing at least one report. A citation without text is provenance for the order, not a reason.">{citingSourceCell(a.counts)}</td>
      <td className="num">{a.counts.releasesFollowedByRecordedAction}/{a.counts.reportsReleased}</td>
    </tr>
  );
  return (
    <div className="attempt-table-wrap">
      <table className="attempt-table">
        <thead>
          <tr><th>Attempt</th><th>Label</th><th>Assistance</th><th className="num">Orders</th><th className="num">With reason</th><th className="num">Citing source</th><th className="num">Responses / releases</th></tr>
        </thead>
        <tbody>{row(current)}{prior.map(row)}{informed.map(row)}</tbody>
      </table>
    </div>
  );
}

function EvidenceChip({ id, ov, onOpen, reference }: { id: string; ov: ViewContext['ov']; onOpen: ViewContext['openEvidence']; reference?: DebriefReference }) {
  const [base, suffix] = splitReferenceId(id);
  if (/^(C\d+|OBJ-\d+|SRC-\d+)$/.test(base)) return <span className="chip chip-muted" title="Curriculum reference">{base}</span>;
  const ref = resolveEvidence(ov, base);
  const tick = reference?.tick ?? ref.tick;
  const label = ref.tick === null && reference ? `${reference.kind.replaceAll('-', ' ')} ${base.slice(0, 8)}` : ref.label;
  const suffixLabel = referenceSuffixLabel(suffix);
  return (
    <button type="button" className="chip" onClick={() => onOpen(base, tick ?? undefined)} title={reference ? `${reference.availability}: ${reference.content}` : `${ref.kind} ${base}${suffix ? ` (${suffixLabel})` : ''}`}>
      {tick !== null && <span className="mono">t{tick}</span>} {label}{suffix && <span className="chip-suffix"> · {suffixLabel}</span>}
    </button>
  );
}

function ReportPicker({ reports, side, maxTick, value, onChange, label }: { reports: Report[]; side: Side; maxTick: number; value: string[]; onChange: (ids: string[]) => void; label: string }) {
  const available = reports.filter((r) => r.side === side && r.tick <= maxTick).slice().sort((a, b) => a.tick - b.tick);
  if (available.length === 0) return <p className="muted small">No {sideLabel(side)} reports had been released by tick {maxTick}; a map observation can be named in the text.</p>;
  return (
    <fieldset className="report-picker">
      <legend className="small muted">{label}</legend>
      {available.map((r) => (
        <label key={r.id} className="report-opt small">
          <input type="checkbox" checked={value.includes(r.id)} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          <span className="mono">t{r.tick}</span> {r.title}
        </label>
      ))}
    </fieldset>
  );
}

function DecisionLogForm({ event, question, reports, side, onSaved }: { event: TimelineEvent; question: string; reports: Report[]; side: Side; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const observedTick = observedTickOf(event);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await learningApi.decisionLog(event.id, text.trim(), ids);
      setText('');
      setIds([]);
      setOpen(false);
      await onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dlog">
      <p className="small dlog-q">{question}</p>
      {!open ? (
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}><MessageSquare size={12} aria-hidden="true" /> Add a post-hoc statement</button>
      ) : (
        <form className="dlog-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="sr-only" htmlFor={`dlog-${event.id}`}>Decision statement</label>
          <textarea id={`dlog-${event.id}`} className="input" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="What you expected, what supported it, what you kept in reserve." />
          <ReportPicker reports={reports} side={side} maxTick={observedTick} value={ids} onChange={setIds} label={`Reports available to ${sideLabel(side)} at tick ${observedTick} (cite what you used)`} />
          <div className="action-row">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Record as post-hoc'}</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            <span className="muted small">Recorded as written after the order, with today's tick and your subject. It does not become contemporaneous.</span>
          </div>
          <InlineError message={err} />
        </form>
      )}
    </div>
  );
}

export function AssessmentForm({ exerciseId, reports, side, live, displayedTick, onSaved }: { exerciseId:string; reports: Report[]; side: Side; live: boolean; displayedTick: number; onSaved: () => Promise<void> }) {
  const [text, setText] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await learningApi.assessment(text.trim(), ids, exerciseId);
      setText('');
      setIds([]);
      setSaved(`Recorded at tick ${r.tick} as ${r.timing}.`);
      await onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Assessment log" className="learning-assess" aside={<span className={`tag ${live ? '' : 'tag-warn'}`}>{live ? 'contemporaneous' : 'post-hoc (historical view or ended)'}</span>}>
      <form className="dlog-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="sr-only" htmlFor="assess-text">Assessment</label>
        <textarea id="assess-text" className="input" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Observation, then inference, each tied to a report ID and tick." />
        <ReportPicker reports={reports} side={side} maxTick={displayedTick} value={ids} onChange={setIds} label={`Reports available to ${sideLabel(side)} at tick ${displayedTick}`} />
        <div className="action-row">
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Record assessment'}</button>
          {saved && <span className="muted small">{saved}</span>}
        </div>
        <InlineError message={err} />
      </form>
    </Panel>
  );
}

function DebriefSection({ ov, orders, completed, instructor, budget, onOpen }: { ov: ViewContext['ov']; orders: TimelineEvent[]; completed: boolean; instructor: boolean; budget: Budget; onOpen: ViewContext['openEvidence'] }) {
  const [eventId, setEventId] = useState<string>('');
  const [result, setResult] = useState<DebriefResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ errors: string[]; receiptId: string | null } | null>(null);
  const [liveBudget, setLiveBudget] = useState<Budget>(budget);
  useEffect(() => setLiveBudget(budget), [budget]);
  useEffect(() => {
    if (!eventId && orders.length) setEventId(orders[orders.length - 1].id);
  }, [orders, eventId]);

  // Show the cached result for the selected order, if any.
  useEffect(() => {
    if (!eventId) return;
    const ac = new AbortController();
    setResult(null);
    setRejected(null);
    setErr(null);
    learningApi.cachedDebrief(eventId, ac.signal).then((r) => { if (!ac.signal.aborted) { setResult(r); setLiveBudget(r.budget); } }).catch((e) => {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (e instanceof LearningApiError && e.status === 404) return;
      setErr(errText(e));
    });
    return () => ac.abort();
  }, [eventId, ov.activeId]);

  const ownSelectedOrder = orders.some(o => o.id === eventId && o.actor === ov.identity.subject);
  const allowed = (completed || instructor) && ownSelectedOrder;
  const capReached = liveBudget.requestsUsed >= liveBudget.maxRequests || (liveBudget.maxUsd>0 && liveBudget.committedUsd >= liveBudget.maxUsd);
  const generate = async () => {
    setBusy(true);
    setErr(null);
    setRejected(null);
    try {
      const r = await learningApi.generateDebrief(eventId);
      setResult(r);
      setLiveBudget(r.budget);
    } catch (e) {
      if (e instanceof LearningApiError && e.status === 422) setRejected({ errors: e.errors, receiptId: e.receiptId });
      else setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={<><Sparkles size={15} aria-hidden="true" /> Model debrief of one order</>}
      className="learning-debrief"
      aside={<span className="mono small muted" title="Project inference budget: API charges and model requests">{fmtUsd(liveBudget.committedUsd)} / {fmtUsd(liveBudget.maxUsd)} · {liveBudget.requestsUsed}/{liveBudget.maxRequests} requests</span>}
    >
      {orders.length === 0 ? (
        <Empty>{instructor ? 'No participant orders are recorded in this exercise.' : 'No orders of yours are recorded in this exercise.'}</Empty>
      ) : (
        <>
          <div className="action-row debrief-pick">
            <label htmlFor="debrief-order" className="small">Order</label>
            <select id="debrief-order" className="select" value={eventId} onChange={(e) => setEventId(e.target.value)} disabled={busy}>
              {orders.map((o) => <option key={o.id} value={o.id}>t{o.tick} · {o.summary}{instructor ? ` · ${o.actor}` : ''}</option>)}
            </select>
            <button type="button" className="btn btn-sm btn-primary" disabled={!allowed || !eventId || busy || capReached || (result !== null && !result.stale)} onClick={() => void generate()} title={!allowed ? 'Available after the exercise ends, or to an instructor' : capReached ? 'Project inference cap reached' : result && !result.stale ? 'A validated debrief for this evidence is already cached' : 'Sends one model request under the configured route and request cap'}>
              {busy ? 'Generating…' : result?.stale ? 'Regenerate (evidence changed)' : 'Generate debrief'}
            </button>
          </div>
          <p className="muted small">
            {instructor && !ownSelectedOrder ? 'Review the participant’s existing AI debrief here. The participant generates it from their own seat; your corrections are saved separately from the original.' : allowed ? `One request to the ${configuredModelPresentation(ov.platform.inferenceRoute).replace(/^Connected/,'connected')}, cached by exercise, order and evidence hash. Citations and time labels are checked against the record. Unknown citations and mislabeled hindsight are rejected; the interpretation still requires instructor review.` : 'Debriefs are generated after the exercise ends, or by an instructor, so the analysis never steers live play.'}
          </p>
          {busy && <Busy label="Waiting for the model…" />}
          <InlineError message={err} />
          {rejected && (
            <div className="debrief-rejected" role="alert">
              <strong>Debrief discarded.</strong> The model output did not validate against the evidence{rejected.receiptId ? ` (receipt ${rejected.receiptId.slice(0, 8)})` : ''}. It was logged, not shown, and no retry was sent.
              {rejected.errors.length > 0 && <ul className="doc-list small">{rejected.errors.slice(0, 6).map((e, i) => <li key={i}>{e}</li>)}</ul>}
            </div>
          )}
          <NoteIntakePanel exerciseId={ov.activeId} eventId={eventId} observedTick={orders.find(o=>o.id===eventId)?.tick??ov.state.tick} onChanged={()=>{if(result)setResult({...result,stale:true})}}/>
          <DecisionRetrievalPanel eventId={eventId} exerciseId={ov.activeId} allowed={completed||instructor} saved={result?.record.retrieval} onOpen={onOpen}/>
          {result && <DebriefView record={result.record} status={result.status} stale={result.stale} ov={ov} onOpen={onOpen} />}
          {result && <DebriefFeedbackPanel key={`${ov.activeId}:${result.record.hash}`} record={result.record} stale={result.stale} playbackTick={ov.playbackTick} onOpenEvidence={(id) => onOpen(id)} />}
        </>
      )}
    </Panel>
  );
}

function DebriefView({ record, status, stale, ov, onOpen }: { record: DebriefRecord; status: 'generated' | 'cached'; stale: boolean; ov: ViewContext['ov']; onOpen: ViewContext['openEvidence'] }) {
  const hindsight = new Set(record.hindsightIds);
  const claim = (c: DebriefClaim, i: number) => {
    const usesHindsight = c.basis === 'hindsight' || c.citations.some((id) => hindsight.has(id));
    return (
      <li key={i} className="claim">
        <span>{c.text}</span>
        {usesHindsight && <span className="tag tag-warn" title="Cites evidence that was not available when the order was issued">hindsight</span>}
        {c.basis === 'available-then' && !usesHindsight && <span className="tag tag-muted">available then</span>}
        {c.citations.length > 0 && <span className="msg-sources">{c.citations.map((id) => <EvidenceChip key={id} id={id} ov={ov} onOpen={onOpen} reference={record.references.find(r => r.id === id)} />)}</span>}
      </li>
    );
  };
  const section = (title: string, claims: DebriefClaim[]) => claims.length > 0 && (
    <div className="debrief-section">
      <h3 className="sub">{title}</h3>
      <ul className="claim-list">{claims.map(claim)}</ul>
    </div>
  );
  const d = record.debrief;
  const download = () => {
    const blob = new Blob([record.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `replay-debrief-${record.eventId.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="debrief">
      <div className="debrief-meta small muted">
        <span className={`tag ${status === 'generated' ? '' : 'tag-muted'}`}>{status === 'generated' ? 'generated now' : 'cached'}</span>
        {stale && <span className="tag tag-warn" title="The exercise record has changed since this debrief was generated">evidence changed since</span>}
        <span>{new Date(record.generatedAt).toLocaleString()}</span>
        <span className="mono">{modelPresentation(record.receipt)}</span>
        <span className="mono" title="Ledger receipt">receipt {record.receipt.id.slice(0, 8)} · {record.receipt.status}{record.receipt.settledUsd !== null ? ` · ${fmtUsd(record.receipt.settledUsd)}` : ''}</span>
        {record.prompt.truncated && <span className="tag tag-warn">context truncated</span>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={download} title="Download this debrief as Markdown"><FileText size={12} aria-hidden="true" /> Markdown</button>
      </div>
      <p className="lead debrief-headline">{d.headline.text}{d.headline.citations.length > 0 && <span className="msg-sources">{d.headline.citations.map((id) => <EvidenceChip key={id} id={id} ov={ov} onOpen={onOpen} reference={record.references.find(r => r.id === id)} />)}</span>}</p>
      {section('Observations', d.observations)}
      {section('Opponent’s recorded actions', d.opponentPerspective)}
      {section('Tradeoffs', d.tradeoffs)}
      {section('Questions for you', d.questions)}
      {section('Next practice', d.nextPractice)}
      {section('Limitations', d.limitations)}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

function originOf(t: TimelineEvent): string | undefined {
  const d = t.details as { origin?: unknown } | undefined;
  return typeof d?.origin === 'string' ? d.origin : undefined;
}

function observedTickOf(t: TimelineEvent): number {
  const d = t.details as { observedTick?: unknown } | undefined;
  return typeof d?.observedTick === 'number' ? d.observedTick : t.tick;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
