import type {NetworkView} from '../../campaign/network';
import {Panel} from './ui';import {tickClock,sideLabel} from '../lib';
import '../network.css';
export function NetworkPanel({view,onSelect}:{view:NetworkView|null|undefined;onSelect:(tile:number)=>void}){
 if(!view)return null;const priority=view.stations.find(s=>s.priority);
 return <Panel title="Stations & reserves" tone="dark" className="network-panel">
  <div className="network-score"><span>Blue <strong>{view.scores.blue}</strong></span><span>Red <strong>{view.scores.red}</strong></span></div>
  <p className="small muted">Game points · as of {tickClock(view.tick)}{view.inherited?' · includes inherited branch context':''}</p>
  <p className="network-priority">Priority: <strong>{priority?.name}</strong> · +2 bonus</p>
  <div className="network-stations">{view.stations.map(s=><button type="button" className={`network-station${s.priority?' is-priority':''}`} key={s.id} onClick={()=>onSelect(s.tile)} title={`Inspect ${s.name}: Blue holds ${s.held.blue} and Red ${s.held.red} of ${s.total} marked land tiles`}>
   <span>{s.name}{s.priority?' ★':''}</span><small>{s.controller?sideLabel(s.controller):'Uncontrolled'}</small>
  </button>)}</div>
  <p className="small">Reserve bonus: Blue {view.reserve.blue.eligible?'ready':'not met'} / Red {view.reserve.red.eligible?'ready':'not met'}. Hold a station and retain 30% of force capacity.</p>
  <p className="small muted">Next tally {view.nextAwardTick===null?'—':tickClock(view.nextAwardTick)} · priority changes {view.nextPriorityTick===null?'—':tickClock(view.nextPriorityTick)}</p>
  <details><summary>Rules & ending</summary><p className="small">{view.description}</p><p className="small muted">This is an experimental objectives mode. The 20-minute limit does not guarantee that duration; elimination may occur earlier.</p></details>
 </Panel>;
}
