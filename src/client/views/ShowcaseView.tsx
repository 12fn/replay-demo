import {modelPresentation} from '../model-presentation';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock3, Download, FileText, GitBranch, RotateCcw, ShieldCheck, Waypoints } from 'lucide-react';
import { RecordedAnalysisPanel, type RecordedAnalysis } from '../components/RecordedAnalysisPanel';
import { NoteIntakePanel } from '../components/NoteIntakePanel';
import { DecisionRetrievalPanel } from '../components/DecisionRetrievalPanel';
import { InlineError } from '../components/ui';
import { PageHeading } from '../components/Workspace';
import type { ViewContext } from '../App';
import { api, errorMessage } from '../api';
import type { DecisionRetrieval } from '../../learning/decision-retrieval';
import { learningApi } from '../learning-api';
import '../showcase.css';
type Prepared={exerciseId:string;selectedEventId:string;reviewTick:number;forkTick:number};
type Showcase={recordedAnalysis:RecordedAnalysis;manifest:{version:string;fixture:{turns:number;events:number;reports:number};archivedTrial:{id:string;label:string}};prepared:Prepared|null;recordedProof:{label:string;exerciseId:string;selectedDecision:{eventId:string;observedTick:number};reviewTick:number;forkTick:number;sourceSha256:string;debrief:{receiptId:string;modelReturned:string;hash:string};review:{editedText:string;nextPractice:string;explanation:string};tomo:{taskId:string;tool:{name:string;callId:string};status:string};limitations:string[]};claim:string};
async function request<T>(url:string,method='GET'){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});const x=await r.json();if(!r.ok)throw Error(x.error||'Showcase unavailable');return x as T;}

const STEPS = [
  { title: 'The decision', detail: 'Reconstruct the moment', minutes: '1 min' },
  { title: 'The evidence', detail: 'Follow the source', minutes: '2 min' },
  { title: 'AI assistance', detail: 'Inspect the reasoning', minutes: '2 min' },
  { title: 'Your review', detail: 'Add instructor judgment', minutes: '1 min' },
  { title: 'Next practice', detail: 'Try, compare, hand off', minutes: '4 min' },
];

export function ShowcaseView({ ctx }: { ctx: ViewContext }) {
  const [data, setData] = useState<Showcase | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [trace, setTrace] = useState<DecisionRetrieval>();
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [step, setStep] = useState(0);
  const load = async () => setData(await request<Showcase>('/api/showcase'));
  useEffect(() => { void load().catch(e => setError(errorMessage(e))); }, [ctx.ov.identity.subject]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const recorded = data?.recordedProof;
  const real = !!recorded && ctx.ov.exercises.some(e => e.id === recorded.exerciseId);
  const selected: Prepared | null = real ? { exerciseId: recorded!.exerciseId, selectedEventId: recorded!.selectedDecision.eventId, reviewTick: recorded!.reviewTick, forkTick: recorded!.forkTick } : data?.prepared ?? null;
  const originalSelected = selected?.exerciseId === ctx.ov.activeId;
  const select = async () => {
    if (!selected) throw Error('Prepare the case before opening its evidence.');
    await api.select(selected.exerciseId);
    await api.replay(selected.reviewTick, selected.exerciseId);
    await ctx.refresh();
    return selected;
  };
  const review = async () => { const target = await select(); ctx.openEvidence(target.selectedEventId, target.reviewTick); };
  const retrieve = async () => {
    const target = await select(); const response = await learningApi.retrieveDecision(target.selectedEventId);
    if (response.exerciseId !== target.exerciseId) throw Error('The exercise changed. Reopen the original case and try again.');
    setTrace(response.retrieval); setMessage('Source path retrieved for this decision. No model request was made.');
  };
  const practice = async () => {
    const target = await select(); await api.branch(target.forkTick, 'blue'); await ctx.refresh(); ctx.navigate('exercise');
  };
  const go = (next: number) => { setStep(next); setMessage(null); };

  return <div className="showcase-page">
    <PageHeading eyebrow="Teach through decisions" title="Instructor case" description="One decision. Its evidence. A better next practice."
      actions={<span className="time-label"><Clock3 size={15} aria-hidden="true" />10-minute walkthrough</span>} />
    <section className="case-hero" aria-label="Prepared case briefing">
      <div className="case-intro">
        <div className="case-labels"><span className="case-series">EXERCISE CROSSCURRENT</span><span className="badge badge-recorded">{!data ? 'Loading case provenance…' : real ? 'Recorded native workflow' : 'Authored synthetic rehearsal'}</span></div>
        <h2>When the reports disagree.</h2>
        <p>A participant committed resources while reports repeated and contradicted one another. Reopen the moment, test the evidence, and decide what they should practice next.</p>
        <div className="case-meta"><span><FileText size={15} aria-hidden="true" />Fictional training case</span>{selected && <span>Decision at tick <strong>{selected.reviewTick}</strong></span>}<span>Original record preserved</span></div>
      </div>
      <div className="case-route" aria-label="Learning sequence">
        <div><span className="route-symbol"><FileText size={19} aria-hidden="true" /></span><span><strong>Reconstruct</strong><small>What was known at the time?</small></span></div>
        <div><span className="route-symbol"><Waypoints size={19} aria-hidden="true" /></span><span><strong>Make sense of the evidence</strong><small>Which sources support the choice?</small></span></div>
        <div><span className="route-symbol"><GitBranch size={19} aria-hidden="true" /></span><span><strong>Practice an alternative</strong><small>What would you try next?</small></span></div>
      </div>
    </section>
    <InlineError message={error} />
    {message && <p className="notice-success" role="status">{message}</p>}
    {!data && !error && <p className="empty" role="status">Loading the prepared case…</p>}
    {data && !selected && <div className="setup-notice"><div><h3>Prepare your demonstration</h3><p>Install the bundled fictional case once. Your subsequent notes and practice branches will be retained.</p></div><button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { await request('/api/showcase/prepare', 'POST'); await ctx.refresh(); await load(); setMessage('Prepared case is ready.'); })}>Prepare rehearsal (one-time setup)<ArrowRight size={16} aria-hidden="true" /></button></div>}
    <div className="case-workspace">
      <nav className="case-steps" aria-label="Case walkthrough steps">{STEPS.map((s, i) => <button key={s.title} aria-current={step === i ? 'step' : undefined} className={step === i ? 'is-current' : ''} onClick={() => go(i)}><span className="step-number">{i + 1}</span><span><strong>{s.title}</strong><small>{s.minutes}</small></span></button>)}</nav>
      <section className="case-stage" aria-label={STEPS[step].title}>
        <div className="stage-heading"><div><span className="eyebrow">Step {step + 1} / 5</span><h2>{STEPS[step].detail}</h2></div>{selected && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(async () => { await select(); setTrace(undefined); setMessage('Original decision opened. Your previous reviews and branches are retained.'); })}><RotateCcw size={14} aria-hidden="true" />Return to original case</button>}</div>
        {step === 0 && <div className="stage-columns"><div className="stage-copy"><h3>Start with the choice, before judging the outcome.</h3><p>Open the original order alongside the reports available to the participant. Later corrections stay separate from what they could have known then.</p><button className="btn btn-primary" disabled={!selected || busy} onClick={() => void run(review)}>Open decision and source timeline<ArrowRight size={16} aria-hidden="true" /></button></div><aside className="teaching-prompt"><span className="eyebrow">Ask the room</span><blockquote>“What evidence would you want before committing more resources?”</blockquote><p>The outcome can start a discussion. The decision record lets you investigate it.</p></aside></div>}
        {step === 1 && <div className="stage-stack"><p className="stage-lede">A repeated claim is not a second independent observation. Follow the decision to its sources, inspect contradictions, and see what would change the judgment.</p><div className="action-row"><button className="btn btn-primary" disabled={!selected || busy} onClick={() => void run(retrieve)}><Waypoints size={16} aria-hidden="true" />{busy ? 'Retrieving evidence…' : 'Retrieve this decision’s evidence'}</button><span className="small muted">Local graph traversal · no model call</span></div>{trace && selected && <DecisionRetrievalPanel eventId={selected.selectedEventId} exerciseId={selected.exerciseId} allowed={originalSelected} saved={trace} replayed={false} initialOpen onOpen={ctx.openEvidence} />}<div className="teaching-note"><strong>Look for:</strong> source identity, release time, repeated reports, missing evidence, and assumptions. Availability does not prove the participant read a report.</div></div>}
        {step === 2 && <div className="stage-stack"><p className="stage-lede">Inspect the saved model response and follow its citations. Keep the model’s interpretation open to challenge.</p>{!analysisOpen ? <button className="btn btn-primary align-start" disabled={!data} onClick={() => setAnalysisOpen(true)}>Read the saved model analysis and cited evidence<ArrowRight size={16} aria-hidden="true" /></button> : <><button className="btn btn-sm align-start" onClick={() => setAnalysisOpen(false)}>Close recorded analysis</button>{data?.recordedAnalysis && <RecordedAnalysisPanel analysis={data.recordedAnalysis} linkedToCase={real} />}</>}{recorded && <details className="native-proof"><summary>Recorded native receipts and correction</summary><p>{recorded.label}</p><p><strong>Saved correction:</strong> {recorded.review.editedText}</p><p><strong>Next practice:</strong> {recorded.review.nextPractice}</p><p>{recorded.review.explanation}</p><dl className="proof-facts"><div><dt>Model</dt><dd>{modelPresentation(recorded.debrief)}</dd></div><div><dt>Saved receipt</dt><dd><code>{recorded.debrief.receiptId}</code></dd></div><div><dt>Tomo tool</dt><dd><code>{recorded.tomo.tool.name}</code> · {recorded.tomo.status}</dd></div></dl><p className="small muted">Recorded, scripted demonstration actions; not human instructor acceptance.</p></details>}</div>}
        {step === 3 && <div className="stage-stack"><p className="stage-lede">Record your interpretation and assign a concrete next practice. Your note is dated and attributed, with the original decision left intact.</p>{selected && originalSelected ? <NoteIntakePanel exerciseId={selected.exerciseId} eventId={selected.selectedEventId} observedTick={selected.reviewTick} onChanged={() => void ctx.refresh()} prepared /> : <button className="btn btn-primary align-start" disabled={!selected || busy} onClick={() => void run(async () => { await select(); })}>Open the original case to add your review</button>}<div className="teaching-note"><strong>A useful next practice:</strong> “Retain 90 percent reserve, test a smaller legal commitment, and explain which report informed the choice.”</div></div>}
        {step === 4 && <div className="stage-columns"><div className="stage-copy"><h3>Make the alternative real.</h3><p>Create an independent branch at tick {selected?.forkTick ?? '—'}. Choose a legal order, add your reason, and end the branch for review. The original stays available for comparison.</p><button className="btn btn-primary" disabled={!selected || busy} onClick={() => void run(practice)}><GitBranch size={16} aria-hidden="true" />Start a new legal practice branch</button><ol className="practice-checklist"><li>Set commitment to <strong>10%</strong>.</li><li>Add a decision note and select a supporting report.</li><li>Check available options, inspect a destination, then issue a legal order.</li><li>End for review and open <strong>My practice</strong>.</li></ol></div><aside className="handoff-card"><Download size={24} aria-hidden="true" /><h3>Take the learning record with you.</h3><p>Export the original evidence and your review. Use Review → Debrief &amp; handoff for the new branch’s bundle.</p>{originalSelected ? <a className="btn" href="/api/review/export.json" download>Download complete evidence packet</a> : <button className="btn" disabled={!selected || busy} onClick={() => void run(async () => { await select(); })}>Select original for export</button>}<button className="link" onClick={() => ctx.navigate('practice')}>Open My practice<ArrowRight size={14} aria-hidden="true" /></button></aside></div>}
      </section>
      <footer className="case-stage-footer"><button className="btn btn-ghost" disabled={step === 0} onClick={() => go(step - 1)}><ArrowLeft size={15} aria-hidden="true" />Previous</button><span>{step + 1} of {STEPS.length}</span>{step < 4 ? <button className="btn" onClick={() => go(step + 1)}>Next: {STEPS[step + 1].title}<ArrowRight size={15} aria-hidden="true" /></button> : <button className="btn" onClick={() => ctx.navigate('platform')}>Inspect native evidence and integration<ArrowRight size={15} aria-hidden="true" /></button>}</footer>
    </div>
    <footer className="case-platform-note"><ShieldCheck size={18} aria-hidden="true" /><p><strong>Built around a shared workroom.</strong> Kamiwaza supplies native identity, managed archives, and recorded model/tool integrations. This walkthrough demonstrates the workflow; educational benefit still needs instructor and learner evaluation.</p><button className="link" onClick={() => ctx.navigate('platform')}>Explore platform<ArrowRight size={14} aria-hidden="true" /></button></footer>
  </div>;
}
