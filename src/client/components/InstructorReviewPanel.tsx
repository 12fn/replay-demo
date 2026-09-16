import {useCallback,useEffect,useRef,useState} from 'react';
import type {ViewContext} from '../App';import {Panel,InlineError} from './ui';
import '../review.css';
/** '' selects the exercise-wide stream; any other value is a participant subject offered by the server. */
type Target={kind:'exercise'|'participant';subject:string|null;name:string;active:boolean;label:string};
const targetKey=(subject:string|null)=>subject??'';
export function InstructorReviewPanel({ctx}:{ctx:ViewContext}){
 const [data,setData]=useState<any>(null),[error,setError]=useState<string|null>(null),[target,setTarget]=useState(''),[criterion,setCriterion]=useState('C1'),[score,setScore]=useState(''),[disposition,setDisposition]=useState('confirmed'),[rationale,setRationale]=useState(''),[ids,setIds]=useState<string[]>([]),[busy,setBusy]=useState(false);
 const requestSequence=useRef(0),saveSequence=useRef(0);
 const wanted=useRef({exerciseId:ctx.ov.activeId,target:'',request:0});
 const load=useCallback(async(exerciseId:string,subject:string)=>{const request=++requestSequence.current;wanted.current={exerciseId,target:subject,request};try{const r=await fetch('/api/review/assessment'+(subject?`?participant=${encodeURIComponent(subject)}`:''));const b=await r.json().catch(()=>null);if(!r.ok)throw new Error(b?.error??'Instructor review is unavailable');
  // A response for a target or exercise that is no longer selected is dropped so it can never supply a baseVersion for a save.
  if(wanted.current.request!==request||wanted.current.exerciseId!==exerciseId||wanted.current.target!==subject)return;if(b.exerciseId!==exerciseId||targetKey(b.target?.subject)!==subject)throw new Error('Review data did not match the selected target');setData(b);setError(null);}catch(e){if(wanted.current.request===request&&wanted.current.exerciseId===exerciseId&&wanted.current.target===subject)setError((e as Error).message);}},[]);
 useEffect(()=>{saveSequence.current++;setBusy(false);setDisposition('confirmed');setData(null);setIds([]);setRationale('');setScore('');setTarget('');void load(ctx.ov.activeId,'');},[ctx.ov.activeId,load]);
 const selectTarget=(subject:string)=>{saveSequence.current++;setBusy(false);setDisposition('confirmed');setTarget(subject);setData(null);setIds([]);setRationale('');setScore('');setError(null);void load(ctx.ov.activeId,subject);};
 const fresh=!!data&&data.exerciseId===ctx.ov.activeId&&targetKey(data.target?.subject)===target;
 const current=fresh?data.current?.find((x:any)=>x.criterion.id===criterion)?.judgment:null;
 const selected:Target|null=fresh?data.target:null;const personal=selected?.kind==='participant';
 const save=async()=>{
  if(!fresh)return;const ticket=wanted.current,operation=++saveSequence.current;const exerciseId=ctx.ov.activeId,subject=target;
  setBusy(true);try{
   const r=await fetch('/api/review/assessment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({exerciseId,criterionId:criterion,baseVersion:current?.version??0,score:score===''?null:Number(score),disposition,rationale,evidenceIds:ids,participantSubject:subject||null})});
   const b=await r.json();if(!r.ok)throw new Error(b.error);
   if(wanted.current!==ticket||saveSequence.current!==operation)return;
   setRationale('');setIds([]);setScore('');await load(exerciseId,subject);
  }catch(e){if(wanted.current===ticket&&saveSequence.current===operation)setError((e as Error).message);}
  finally{if(saveSequence.current===operation)setBusy(false);}
 };
 const evidence:any[]=fresh?data.evidence??[]:[];const authoredSelected=ids.some(id=>evidence.find(e=>e.id===id)?.participantAuthored);
 const targetName=(subject:string|null|undefined)=>{const t=(data?.targets as Target[]|undefined)?.find(t=>t.subject===(subject??null));return t?t.kind==='exercise'?'Exercise-wide':t.name:subject??'Exercise-wide';};
 return <Panel title="Instructor judgment & handoff" className="instructor-review">
  <p className="muted small">Human judgment against provisional criteria. An unobserved criterion remains unscored; simulation outcomes do not establish mastery. Exercise-wide findings describe the group and are never an individual score.</p><InlineError message={error}/>
  <div className="review-downloads"><a className="btn btn-sm" href="/api/review/export.json">Download evidence bundle</a><a className="btn btn-sm" href="/api/review/export.md">Readable review</a></div>
  {data?.targets?.length>1&&<label className="review-target">Review target<select value={target} onChange={e=>selectTarget(e.target.value)}>{(data.targets as Target[]).map(t=><option key={targetKey(t.subject)} value={targetKey(t.subject)}>{t.label}</option>)}</select></label>}
  {selected&&<p className="small muted review-target-note">{personal?`Showing ${selected.name}'s own findings${selected.active?'':' (removed participant; history retained)'}. Confirmed or contested findings cite a new act they authored; withheld findings may be unobserved.`:'Showing exercise-wide findings for the whole group.'}</p>}
  <ul className="judgment-list">{fresh&&data.current?.map((x:any)=><li key={x.criterion.id}><strong>{x.criterion.id} · {x.criterion.name}</strong><span>{x.judgment?`${x.judgment.disposition} · ${x.judgment.score??'unscored'} · v${x.judgment.version} · ${x.judgment.participantSubject?`participant: ${targetName(x.judgment.participantSubject)}`:'exercise-wide'}`:'Unobserved'}</span>{x.judgment&&<p>{x.judgment.rationale}</p>}{x.judgment?.evidenceOwnership&&<p className="muted">Participant-authored citations (mechanical check only): {x.judgment.evidenceOwnership.participantAuthoredIds.length} of {x.judgment.evidenceIds.length}.</p>}</li>)}{!fresh&&!error&&<li><span>Loading review…</span></li>}</ul>
  {ctx.ov.identity.role==='instructor'&&<details><summary>Record an instructor judgment</summary><div className="judgment-form">
   <p className="small muted">Target: <strong>{selected?selected.label:'loading…'}</strong>. Versions are tracked separately for each target and criterion.</p>
   <label>Criterion<select value={criterion} onChange={e=>{setCriterion(e.target.value);setScore('');}}>{data?.current?.map((x:any)=><option key={x.criterion.id} value={x.criterion.id}>{x.criterion.id} · {x.criterion.name}</option>)}</select></label>
   <label>Disposition<select value={disposition} onChange={e=>{setDisposition(e.target.value);setScore('');}}><option value="confirmed">Confirmed observation</option><option value="contested">Contested interpretation</option><option value="withheld">Withheld / unobserved</option></select></label>
   <label>Provisional rubric score<select value={score} disabled={disposition!=='confirmed'} onChange={e=>setScore(e.target.value)}><option value="">Unscored</option>{[0,1,2,3].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
   <label>Instructor rationale<textarea value={rationale} onChange={e=>setRationale(e.target.value)} maxLength={2000} placeholder="What does the recorded evidence support, and what remains uncertain?"/></label>
   <fieldset><legend>Evidence from this exercise{personal?` · items marked "own" were recorded by ${selected?.name}`:''}</legend><div className="judgment-citations">{evidence.map(e=><label key={e.id}><input type="checkbox" checked={ids.includes(e.id)} onChange={x=>setIds(v=>x.target.checked?[...v,e.id]:v.filter(i=>i!==e.id))}/><span>t{e.tick} · {e.kind}{e.participantAuthored?' · own':''} · {String(e.title).slice(0,105)}</span></label>)}</div></fieldset>
   {personal&&disposition!=='withheld'&&!authoredSelected&&<p className="small muted">A participant finding needs at least one citation this participant authored (order, assessment entry, decision statement, staff question or tasking). Reports alone do not show their performance.</p>}
   <p className="small muted">{current?`Creates version ${current.version+1} for this target; version ${current.version} stays in the evidence bundle.`:'Creates the first judgment for this criterion and target.'}</p>
   <button className="btn btn-primary" disabled={busy||!fresh||rationale.trim().length<12||(personal&&disposition!=='withheld'&&!authoredSelected)} onClick={()=>void save()}>{busy?'Saving…':personal?`Save judgment for ${selected?.name}`:'Save exercise-wide judgment'}</button>
  </div></details>}
 </Panel>;
}
