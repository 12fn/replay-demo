import {modelPresentation} from '../model-presentation';
import {useEffect,useState} from 'react';
import {api,errorMessage,type Side,type DecisionTraceResponse} from '../api';
import type {DecisionTrace} from '../../review/decision-trace';
import {Panel,Empty,InlineError} from './ui';

type DecisionTraceSelection={exerciseId:string;eventId:string|null;side:Side;cutoffTick:number;canShowLater?:boolean};
type ReviewTrace=DecisionTrace&{review?:DecisionTraceResponse['review']};

/** Remount selection-local consent and evidence together, including when hindsight eligibility changes. */
export function decisionTraceSelectionKey({exerciseId,eventId,side,cutoffTick,canShowLater=false}:DecisionTraceSelection){
 return JSON.stringify([exerciseId,eventId,side,cutoffTick,canShowLater]);
}
export function DecisionTracePanel(props:DecisionTraceSelection){
 return <SelectedDecisionTracePanel key={decisionTraceSelectionKey(props)} {...props}/>;
}
function SelectedDecisionTracePanel({exerciseId,eventId,side,cutoffTick,canShowLater=false}:DecisionTraceSelection){
 const [includeLater,setIncludeLater]=useState(false);
 const key=JSON.stringify([exerciseId,eventId,side,cutoffTick,includeLater]);
 const [result,setResult]=useState<{key:string;trace?:ReviewTrace;error?:string}|null>(null);
 useEffect(()=>{if(!eventId)return;const controller=new AbortController();let current=true;
  api.decisionTrace(exerciseId,eventId,side,cutoffTick,controller.signal,includeLater).then(trace=>{if(current)setResult({key,trace});},e=>{if(current&&!(e instanceof DOMException&&e.name==='AbortError'))setResult({key,error:errorMessage(e)});});
  return()=>{current=false;controller.abort();};
 },[key,exerciseId,eventId,side,cutoffTick,includeLater]);
 const ready=result?.key===key?result:null;
 return <Panel title="Decision perspective">
  {eventId&&canShowLater&&<div><label><input type="checkbox" checked={includeLater} onChange={e=>setIncludeLater(e.target.checked)}/> Include later outcomes</label><p className="muted small">Later outcomes add hindsight from the completed exercise. The map stays at tick {cutoffTick}; later evidence was not necessarily available when the order was chosen.</p></div>}
  {!eventId?<Empty>Select an order to follow its recorded observation, action and outcome.</Empty>:ready?.error?<InlineError message={ready.error}/>:ready?.trace?<DecisionTraceContent trace={ready.trace}/>:<p role="status">Loading this moment…</p>}
 </Panel>;
}
type TimingStep=readonly [label:string,tick:number|null];
const listLabels=(labels:string[])=>labels.length<2?labels.join(''):`${labels.slice(0,-1).join(', ')} and ${labels.at(-1)}`;
/** Groups recorded steps that share a tick; never derives a tick that was not recorded. */
function timingText(steps:TimingStep[]){
 const groups:{tick:number;labels:string[]}[]=[];
 for(const [label,tick] of steps){if(tick===null)continue;const group=groups.find(g=>g.tick===tick);if(group)group.labels.push(label);else groups.push({tick,labels:[label]});}
 return {distinct:groups.length,text:groups.map(g=>`${listLabels(g.labels)} at tick ${g.tick}`).join(' · ')};
}
function orderTiming(command:NonNullable<DecisionTrace['command']['value']>){
 const steps:TimingStep[]=[['snapshot',command.observedTick],...(command.admittedTick!==null?[[command.admission,command.admittedTick] as const]:[]),['recorded',command.tick]];
 const timing=timingText(steps);
 if(command.admittedTick===null)return {split:timing.distinct>1,text:`${command.admission} · ${timing.text}`};
 return {split:timing.distinct>1,text:timing.distinct>1?timing.text:`${command.admission} at tick ${command.tick}`};
}
function effectTiming(effect:{measuredTick:number|null;tick:number}){
 if(effect.measuredTick===null)return {split:false,text:`Recorded at tick ${effect.tick}`};
 if(effect.measuredTick===effect.tick)return {split:false,text:`Tick ${effect.tick}`};
 return {split:true,text:`Measured at tick ${effect.measuredTick} · recorded at tick ${effect.tick}`};
}
export function DecisionTraceContent({trace:t}:{trace:ReviewTrace}){
 const command=t.command.value,obs=t.observation.value,model=t.model.value,script=t.scripted.value;
 const later=t.review?.scope==='later-outcomes';
 if(!command)return <Empty>{t.command.reason??'No command is available at this selection.'}</Empty>;
 const order=orderTiming(command),effects=t.execution.value?.map(effect=>({effect,timing:effectTiming(effect)}));
 const observationSaved=obs&&obs.recordedIn.eventId!==command.eventId&&obs.recordedIn.tick!==obs.tick?obs.recordedIn.tick:null;
 const splitTimes=order.split||observationSaved!==null||!!effects?.some(e=>e.timing.split);
 return <div className="decision-perspective">
  <p><strong>{t.side==='red'?'Red':'Blue'} · {t.controller==='model'?'model player':t.controller==='scripted'?'scripted player':t.controller==='human'?'participant':'unidentified controller'}</strong> · review through tick {t.cutoffTick}</p>
  {later?<p><strong>Later outcomes · hindsight</strong>. The map remains at tick {t.review!.viewTick}; this evidence extends through tick {t.cutoffTick} of the completed exercise.</p>:t.review&&<p>Evidence as of map tick {t.review.viewTick}.</p>}
  {command.inherited&&<p className="muted small">Inherited from source exercise <code>{command.sourceExerciseId??'not recorded'}</code>.</p>}
  <h3>What was available</h3>
  {obs?<><p>Recorded observation at tick <strong>{obs.tick}</strong>{observationSaved!==null&&<> · saved at tick {observationSaved}</>}. {obs.link==='pulse-completion-zero'?'Linked to the first completion of this same agent pulse.':''}</p>
   {t.controller==='human'&&obs.basis==='app-snapshot-returned-with-order'&&<p className="muted small">Snapshot returned with the order; this does not establish human attention.</p>}
   {(obs.knownState.self||obs.knownState.opponent)&&<table><caption>Recorded game totals</caption><thead><tr><th>Perspective</th><th>Available forces</th><th>Tiles</th></tr></thead><tbody>{([['Own side',obs.knownState.self],['Visible opponent',obs.knownState.opponent]] as const).map(([label,state])=>state&&<tr key={label}><th>{label}</th><td>{state.troops?.toLocaleString()??'Not recorded'}</td><td>{state.tiles?.toLocaleString()??'Not recorded'}</td></tr>)}</tbody></table>}
   {!obs.knownState.self&&!obs.knownState.opponent&&<p className="muted small">Game totals were not recorded in this observation.</p>}
   {obs.organizationContext&&<p className="small">Fictional context: {obs.organizationContext.packId}@{obs.organizationContext.version} · {obs.organizationContext.role}.</p>}
   {obs.availableTools.status==='recorded'?<details><summary>Available agent tools ({obs.availableTools.names.length})</summary><p className="small">{obs.availableTools.names.join(', ')}</p>{obs.availableTools.omitted>0&&<p>{obs.availableTools.omitted} additional names omitted.</p>}</details>:<p className="muted small">The available tool catalog was not retained in this observation.</p>}
   {obs.domainKnowledge&&<details><summary>Knowledge retrieval · {obs.domainKnowledge.status}</summary><p className="small">Native request: <code>{obs.domainKnowledge.requestId??'not recorded'}</code></p>{obs.domainKnowledge.facts.map((fact,index)=><p className="small" key={index}>Fact <code>{fact.id??'unnamed'}</code> · sources {fact.sourceIds.join(', ')||'not recorded'}</p>)}</details>}
   {obs.omittedFields.length>0&&<p className="muted small">This compact view omits detailed {obs.omittedFields.join(', ')} snapshots.</p>}
   {obs.fingerprint&&<details><summary>Observation fingerprint</summary><code>{obs.fingerprint}</code></details>}
   {!obs.sourceIdsRecorded&&<p className="muted small">This observation did not enumerate its sources.</p>}</>:<p>{t.observation.reason}</p>}
  {t.sources.length>0&&<details><summary>Sources and release times ({t.sources.length})</summary><ul>{t.sources.map(source=><li key={source.id}><strong>{source.report?.title??source.id}</strong> · {source.status.replaceAll(/[-_]/g,' ')}{source.status==='released-later'?' · hindsight: released after the recorded observation':''}{source.report?` · released tick ${source.report.releaseTick}`:''}{source.references.length?` · ${source.references.join(', ')}`:' · not recorded as used'}</li>)}</ul></details>}
  <h3>Recorded choice</h3>
  {model?<><p>{model.externalSummary??'No external summary was recorded.'}</p><p className="muted small">{model.actor??'Controller identity not recorded'} · {modelPresentation(model.receipt)} · {model.receipt.status??'status unavailable'} · receipt <code>{model.receipt.id}</code></p></>:script?<p>{script.externalSummary??'No scripted choice summary was recorded.'}</p>:<p className="muted small">{t.controller==='human'?'Participant order; no model explanation applies.':t.model.reason}</p>}
  <p><strong>{command.intent.type??'Intent not recorded'}</strong>{command.intent.unit?` · ${command.intent.unit}`:''}{command.intent.troops!==null?` · ${command.intent.troops.toLocaleString()} forces`:''} · {order.text}</p>
  {command.rejectionReason&&<p>{command.rejectionReason}</p>}
  {t.submission.value&&<p className="small"><code>submit_order</code> returned {t.submission.value.status??'an unspecified status'}; command <code>{command.commandId}</code>.</p>}
  <h3>{later?'Later measured outcomes (hindsight)':'What happened by this point'}</h3>
  {effects?<ul>{effects.map(({effect,timing})=><li key={effect.eventId}>{timing.text}: <strong>{effect.status.replaceAll(/[-_]/g,' ')}</strong>{effect.observed&&<details><summary>Measured facts</summary><dl className="detail-list">{Object.entries(effect.observed).map(([key,value])=><div key={key}><dt>{key.replaceAll(/([a-z])([A-Z])/g,'$1 $2')}</dt><dd>{String(value)}</dd></div>)}</dl></details>}</li>)}</ul>:<p>{t.execution.reason}</p>}
  {splitTimes&&<p className="muted small">Steps above carry separately recorded ticks. The map shows game state at a tick; the event list places each record at its recorded tick. Move the map to the tick of the step under discussion.</p>}
  {(t.omitted.sources>0||t.omitted.feedback>0)&&<p className="muted small">Omitted from this bounded view: {t.omitted.sources} sources, {t.omitted.feedback} feedback records.</p>}
  <p className="muted small">This links recorded evidence. An accepted order or later outcome does not establish decision quality; compare an alternate branch and discuss the choice.</p>
 </div>;
}
