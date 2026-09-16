import type {ViewContext} from '../App';
import {AssessmentForm} from './LearningPanel';
import {nativeOf} from '../native-api';
import {Panel,Empty} from './ui';
import {tickClock} from '../lib';

/** Shared exercise assessments, separate from personal dossier/debrief records. */
export function TeamAssessmentPanel({ctx}:{ctx:ViewContext}){
 const {ov,assignedSide,active,refresh,openEvidence}=ctx;
 const cutoff=ov.playbackTick??ov.state.tick;
 const entries=ov.timeline.filter(e=>e.kind==='assessment_log'&&e.side===assignedSide&&e.tick<=cutoff).slice(-5).reverse();
 const native=nativeOf(ov),canWrite=!native||native.context.canEdit;
 const canAssess=canWrite&&(ov.identity.role==='intelligence'||ov.identity.role==='instructor');
 return <Panel title="Team assessments" aside={<span className="tag">{assignedSide}</span>}>
  <p className="small muted">Participant analysis shared with this exercise team. Source links show evidence; the analysis remains its author's interpretation.</p>
  {!entries.length?<Empty>No team assessments at this position yet.</Empty>:<ul className="doc-list">
   {entries.map(e=>{const d=e.details as {text?:string;sourceIds?:string[];timing?:string;observedTick?:number;authorName?:string};return <li key={e.id}>
    <button className="link small" onClick={()=>openEvidence(e.id,d.observedTick??e.tick)}>t{e.tick} · {tickClock(e.tick)} · {e.actor===ov.identity.subject?'You':d.authorName??`Participant ${e.actor.slice(0,8)}`}</button>
    <span className="tag tag-muted">{d.timing??'timing unspecified'}</span>
    <p className="small">{d.text??e.summary}</p>
    {(d.sourceIds??[]).map(id=><button className="btn btn-sm" key={id} onClick={()=>openEvidence(id,d.observedTick??e.tick)}>{ov.reports.find(r=>r.id===id)?.title??`Source ${id.slice(0,8)}`}</button>)}
   </li>;})}
  </ul>}
  {canAssess&&<details><summary>Write a team assessment</summary><AssessmentForm key={ov.activeId} exerciseId={ov.activeId} reports={ov.reports} side={assignedSide} live={ov.playbackTick===null&&active?.status==='running'} displayedTick={cutoff} onSaved={refresh}/></details>}
 </Panel>;
}
