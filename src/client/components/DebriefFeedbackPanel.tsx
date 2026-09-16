import {useEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import type {DebriefRecord} from '../learning-api';
import {InlineError} from './ui';
import type {ReviewFeedbackDisposition as Disposition,ReviewFeedbackResponse as FeedbackResponse,ReviewFeedbackSection as Section} from '../../learning/review-feedback-types';

const sectionLabels:Record<Section,string> = {headline:'Headline',observations:'Observation',opponentPerspective:'Opponent perspective',tradeoffs:'Tradeoff',questions:'Question',nextPractice:'Next practice',limitations:'Limitation'};

async function request<T>(url:string, init?:RequestInit):Promise<T> {
  const response = await fetch(url,{...init,cache:'no-store',headers:{Accept:'application/json',...(init?.body?{'Content-Type':'application/json'}:{}),...init?.headers}});
  const body = await response.json();
  if(!response.ok)throw new Error(body.error ?? 'Could not save the instructor review');
  return body as T;
}

/** The original AI claim stays visible; instructor interpretations are separate revisions. */
export function DebriefFeedbackPanel({record,stale,playbackTick,onOpenEvidence}:{record:DebriefRecord;stale:boolean;playbackTick:number|null;onOpenEvidence:(id:string)=>void}) {
  const claims = useMemo(()=>(Object.keys(sectionLabels) as Section[]).flatMap(section=>(section==='headline'?[record.debrief.headline]:record.debrief[section]).map((claim,index)=>({section,index,key:`${section}:${index}`,claim}))),[record]);
  const [selected,setSelected] = useState('observations:0');
  const chosen = claims.find(c=>c.key===selected) ?? claims[0];
  const [data,setData] = useState<FeedbackResponse|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [disposition,setDisposition] = useState<Disposition>('accepted');
  const [criterionId,setCriterionId] = useState('');
  const [explanation,setExplanation] = useState('');
  const [editedText,setEditedText] = useState('');
  const [nextPractice,setNextPractice] = useState('');
  const [reload,setReload] = useState(0);
  const pending = useRef<{fingerprint:string;requestId:string}|null>(null);
  const mounted = useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const url = `/api/learning/reviews?${new URLSearchParams({exerciseId:record.exerciseId,eventId:record.eventId,hash:record.hash})}`;
  useEffect(()=>{
    const ac = new AbortController();setData(null);setError(null);
    request<FeedbackResponse>(url,{signal:ac.signal}).then(result=>{
      if(ac.signal.aborted)return;
      if(result.exerciseId!==record.exerciseId||result.eventId!==record.eventId||result.hash!==record.hash)throw new Error('Review selection changed; reopen this debrief');
      setData(result);
    }).catch(e=>{if(!ac.signal.aborted)setError(e instanceof Error?e.message:'Could not load instructor review');});
    return()=>ac.abort();
  },[url,reload,playbackTick,record.exerciseId,record.eventId,record.hash]);
  const history = data?.reviews.filter(r=>r.section===chosen?.section&&r.index===chosen?.index) ?? [];
  const latest = history.at(-1);
  const effectiveCriterion = criterionId || data?.criteria[0]?.id || '';
  const reset = (key:string)=>{setSelected(key);setMessage('');setExplanation('');setEditedText('');setNextPractice('');setDisposition('accepted');pending.current=null;};
  const save = async(event:FormEvent)=>{
    event.preventDefault();if(!chosen||!data?.canReview||stale||busy)return;
    const fields={exerciseId:record.exerciseId,eventId:record.eventId,hash:record.hash,section:chosen.section,index:chosen.index,disposition,criterionId:effectiveCriterion,explanation:explanation.trim(),...(disposition==='edited'?{editedText:editedText.trim()}:{}),nextPractice:nextPractice.trim(),expectedReviewId:latest?.id??null};
    const fingerprint=JSON.stringify(fields);
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,requestId:crypto.randomUUID()};
    setBusy(true);setError(null);setMessage('');
    try {
      await request('/api/learning/reviews',{method:'POST',body:JSON.stringify({...fields,requestId:pending.current.requestId})});
      if(!mounted.current)return;
      pending.current=null;setMessage('Instructor review saved. The original AI finding is preserved.');setReload(n=>n+1);
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Could not save review');}
    finally{if(mounted.current)setBusy(false);}
  };
  const download = ()=>{
    if(!data)return;
    const blob=new Blob([JSON.stringify({schema:'replay.debrief-review-export/1',exerciseId:record.exerciseId,eventId:record.eventId,hash:record.hash,original:record.debrief,references:record.references,review:data},null,2)],{type:'application/json'});
    const target=URL.createObjectURL(blob);const a=document.createElement('a');a.href=target;a.download=`replay-reviewed-debrief-${record.eventId.slice(0,8)}.json`;a.click();URL.revokeObjectURL(target);
  };
  if(!chosen)return null;
  return <details className="debrief-feedback" open={data?.canReview || undefined}>
    <summary>Instructor review · evidence and next practice</summary>
    <p className="small muted">Review the AI’s interpretation against the evidence. These are instructor observations, not automatic mastery scores.</p>
    <InlineError message={error}/>
    {message&&<p role="status" className="small">{message}</p>}
    <label className="small">Finding to review
      <select className="select" value={chosen.key} onChange={e=>reset(e.target.value)} disabled={busy}>
        {claims.map(c=><option key={c.key} value={c.key}>{sectionLabels[c.section]} {c.index+1} · {c.claim.text.slice(0,90)}</option>)}
      </select>
    </label>
    <blockquote className="obs-rationale"><span className="tag tag-muted">Original AI finding</span><p>{chosen.claim.text}</p></blockquote>
    <div className="msg-sources">{chosen.claim.citations.map(id=><button key={id} type="button" className="btn btn-sm btn-ghost" onClick={()=>onOpenEvidence(id)}>{record.references.find(r=>r.id===id)?.kind ?? 'Evidence'} · {id.slice(0,12)}</button>)}</div>
    {latest&&<div className="debrief-section"><h3 className="sub">Latest instructor interpretation · {latest.disposition}</h3><p className="small">{latest.explanation}</p>{latest.editedText&&<blockquote>{latest.editedText}</blockquote>}<p className="small"><strong>Next practice:</strong> {latest.nextPractice}</p><p className="small muted">{latest.criterionId} · {latest.author}</p></div>}
    {data&&!latest&&<p className="small muted">No instructor review of this finding at the displayed position.</p>}
    {data?.canReview&&<form onSubmit={save} className="learning-form">
      <fieldset disabled={busy||stale} className="review-feedback-fields">
        <label className="small">Instructor decision<select className="select" value={disposition} onChange={e=>setDisposition(e.target.value as Disposition)}><option value="accepted">Accept interpretation</option><option value="edited">Correct interpretation</option><option value="rejected">Reject interpretation</option></select></label>
        <label className="small">Competency<select className="select" value={effectiveCriterion} onChange={e=>setCriterionId(e.target.value)}>{data.criteria.map(c=><option key={c.id} value={c.id}>{c.id} · {c.name}</option>)}</select></label>
        <label className="small">What does the evidence support?<textarea className="input" required minLength={12} maxLength={2000} value={explanation} onChange={e=>setExplanation(e.target.value)} rows={3}/></label>
        {disposition==='edited'&&<label className="small">Corrected finding<textarea className="input" required maxLength={2000} value={editedText} onChange={e=>setEditedText(e.target.value)} rows={3}/></label>}
        <label className="small">Next practice or question<textarea className="input" required minLength={8} maxLength={2000} value={nextPractice} onChange={e=>setNextPractice(e.target.value)} rows={2}/></label>
        <button className="btn btn-sm btn-primary" type="submit" disabled={!effectiveCriterion}>{busy?'Saving…':'Save instructor review'}</button>
      </fieldset>
      {stale&&<p className="small muted">This debrief’s evidence has changed. Existing reviews remain available; refresh the debrief before adding a new review.</p>}
    </form>}
    {history.length>0&&<details><summary>{history.length} saved review revision{history.length===1?'':'s'}</summary><ol className="doc-list small">{history.map(r=><li key={r.id}><strong>{r.disposition}</strong> · {r.author}<p>{r.explanation}</p>{r.editedText&&<p>{r.editedText}</p>}<p>Next practice: {r.nextPractice}</p></li>)}</ol></details>}
    {data?.truncated&&<p className="small muted">Only the returned review history is shown.</p>}
    {data&&<div className="action-row"><button className="btn btn-sm" onClick={download} type="button">Export finding and review history</button><button className="btn btn-sm btn-ghost" onClick={()=>setReload(n=>n+1)} disabled={busy} type="button">Reload reviews</button></div>}
  </details>;
}
