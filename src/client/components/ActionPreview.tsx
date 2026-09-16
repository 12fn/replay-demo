import {useEffect,useRef,useState} from 'react';
import {api,errorMessage,type ActionOptionsSnapshot} from '../api';
import {fmtInt} from '../lib';
import {InlineError} from './ui';

/** Explicit discovery keeps costly naval sampling out of the live overview polling loop. */
export function ActionPreview({exerciseId,tick,onSelect}:{exerciseId:string;tick:number;onSelect:(tile:number)=>void}){
 const [snapshot,setSnapshot]=useState<ActionOptionsSnapshot|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const pending=useRef<AbortController|null>(null);
 const disclosure=useRef<HTMLDetailsElement|null>(null);
 const select=(tile:number)=>{onSelect(tile);if(disclosure.current)disclosure.current.open=false;};
 useEffect(()=>()=>{pending.current?.abort();pending.current=null;},[exerciseId]);
 const inspect=async()=>{
  pending.current?.abort();const controller=new AbortController();pending.current=controller;
  setBusy(true);setError(null);
  try{
   const result=await api.actionOptions(exerciseId,controller.signal);
   if(pending.current!==controller||controller.signal.aborted)return;
   if(result.exerciseId!==exerciseId)throw new Error('The exercise changed. Refresh the available options.');
   setSnapshot(result);
  }catch(e){if(pending.current===controller&&!controller.signal.aborted)setError(errorMessage(e));}
  finally{if(pending.current===controller){pending.current=null;setBusy(false);}}
 };
 return <details className="decision-note" ref={disclosure}>
  <summary>Available costs & boat landings</summary>
  <button className="btn btn-sm" disabled={busy} onClick={()=>void inspect()}>{busy?'Checking…':snapshot?'Refresh options':'Check available options'}</button>
  <InlineError message={error}/>
  {snapshot&&<>
   <p className="small muted">Checked at t{snapshot.tick}{tick>snapshot.tick?` · ${tick-snapshot.tick} ticks ago`:''}. Play continues; orders are checked again when sent.</p>
   <p className="small">{Object.entries(snapshot.buildCosts).map(([unit,cost])=>`${unit}: ${cost===null?'unavailable':`${fmtInt(cost)} gold`}`).join(' · ')}</p>
   <p className="small">Transports: {snapshot.naval.limit.atSea} / {snapshot.naval.limit.max} at sea.</p>
   <p className="small muted">{snapshot.naval.landings.length?'Sampled reachable shores, not a recommended or exhaustive plan. Select one to inspect it on the map; use Boat to tile to send your chosen commitment.':snapshot.naval.reason}</p>
   <ul className="order-list">{snapshot.naval.landings.map(l=><li key={l.intent.dst}>
    <span className="small">{l.target} shore · landing {l.landing.x},{l.landing.y} · {fmtInt(l.costGold)} gold</span>
    <button className="btn btn-sm" onClick={()=>select(l.intent.dst)}>Inspect destination</button>
   </li>)}</ul>
   {snapshot.units.length>0&&<ul className="order-list">{snapshot.units.map(u=><li key={u.id}>
    <span className="small">{u.type} #{u.id} · {u.underConstruction?'building':u.retreating?'returning':u.canUpgrade?'upgrade available':'no upgrade available'}</span>
    <button className="btn btn-sm" onClick={()=>select(u.tile)}>Locate</button>
   </li>)}</ul>}
  </>}
 </details>;
}
