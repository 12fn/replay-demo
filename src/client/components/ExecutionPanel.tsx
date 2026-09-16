import type {OrderProgress} from '../../review/execution';
import {feedbackLabel} from '../../review/execution';
import {Panel} from './ui';import {tickClock,sideLabel} from '../lib';
export function ExecutionPanel({orders,onEvidence}:{orders:OrderProgress[]|undefined;onEvidence:(id:string)=>void}){
 const observed=(orders??[]).filter(o=>o.intent?.type==='boat'||o.intent?.type==='build_unit').slice(-5).reverse();
 if(!observed.length)return null;
 return <Panel title="Order outcomes">
  <p className="small muted">Accepted means recorded as an input. These receipts show what the engine subsequently observed.</p>
  <div className="execution-orders">{observed.map(o=><details key={o.eventId}>
   <summary><span>{o.side==='blue'||o.side==='red'?`${sideLabel(o.side)} · `:''}{o.summary}</span><strong>{feedbackLabel(o.status)}</strong></summary>
   <p className="small muted">{tickClock(o.tick)} · admission: {o.admission}{o.inherited?' · inherited action from the source exercise':''}</p>
   <button className="btn btn-sm btn-ghost" onClick={()=>onEvidence(o.eventId)}>Inspect recorded order</button>
   {!o.observations.length&&<p className="small">{o.status==='awaiting-observation'?'No effect has been observed at this displayed tick.':'Effect tracking is unavailable for this order.'}</p>}
   {o.observations.map(f=><div className="execution-receipt" key={f.eventId}>
    <button className="btn btn-sm btn-ghost" onClick={()=>onEvidence(f.eventId)}>{tickClock(f.tick)} · {feedbackLabel(f.status)}</button>
    <p className="small">{facts(f.observed)}</p>
   </div>)}
  </details>)}</div>
 </Panel>;
}
function facts(o:Record<string,any>):string{
 if(o.kind==='construction')return `${o.unit}${o.unitId!==undefined?` #${o.unitId}`:''} · gold change ${o.goldDelta.toLocaleString()}${o.costAtAttempt!==undefined?` · quoted cost ${o.costAtAttempt.toLocaleString()}`:''}${o.affordableAtAttempt===false?' · insufficient gold at this execution’s attempt':''}.`;
 if(o.kind==='transport')return `Transport${o.unitId!==undefined?` #${o.unitId}`:''} · reserve change ${Math.round(o.troopsDelta).toLocaleString()} · ${o.movesObserved} observed moves${o.retreatObserved?' · retreat observed':''}.`;
 return 'The observer could not determine this effect.';
}
