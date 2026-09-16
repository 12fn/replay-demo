import type {Overview} from '../api';
import {Panel,Empty} from './ui';
import {tickClock} from '../lib';

export function KeyMomentsPanel({overview,onEvidence}:{overview:Overview;onEvidence:(id:string,tick:number)=>void}){
 const data=overview.keyMoments;
 if(!data)return null;
 return <Panel title="Key moments" aside={<span className="small muted">{data.selected.length} selected · {data.candidateCount} candidates</span>}>
  <p className="small muted">{data.scope.kind==='own'?'Your orders and shared exercise changes':'Team orders and exercise changes'}, selected for distinct evidence across the session. These are review prompts, not scores.</p>
  {!data.selected.length?<Empty>No distinct review moments are recorded at this position yet.</Empty>:<ul className="finding-list">
   {data.selected.map(m=><li key={m.id} className="finding">
    <div className="finding-head"><button className="link" onClick={()=>onEvidence(m.evidence[0].id,m.tick)}>{m.title}</button><span className="mono muted">t{m.tick} · {tickClock(m.tick)}</span></div>
    {m.repeatCount>1&&<span className="tag">{m.repeatCount} {m.repeatKind==='equivalent'?'similar':'identical'} orders grouped{m.repeatRange?` · t${m.repeatRange.ticks[0]}–${m.repeatRange.ticks[1]}`:''}</span>}
    <p className="small">{m.reasons[0]}</p>
    {m.reasons.length>1&&<details><summary className="small">Why this moment</summary>{m.reasons.slice(1).map((reason,i)=><p className="small" key={i}>{reason}</p>)}</details>}
    <div className="finding-labels">{m.evidence.slice(0,5).map(e=><button key={e.id} className="btn btn-sm" onClick={()=>onEvidence(e.id,e.tick)}>{e.basis} · t{e.tick}</button>)}</div>
    {m.evidence.length>5&&<details><summary className="small">Show {m.evidence.length-5} more records</summary><div className="finding-labels">{m.evidence.slice(5).map(e=><button key={e.id} className="btn btn-sm" onClick={()=>onEvidence(e.id,e.tick)}>{e.basis} · t{e.tick}</button>)}</div></details>}
   </li>)}
  </ul>}
  <details><summary className="small">How these moments are selected</summary>{data.limitations.map(l=><p className="small muted" key={l}>{l}</p>)}</details>
 </Panel>;
}
