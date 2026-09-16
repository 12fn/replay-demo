import {modelPresentation} from '../model-presentation';
import type {TimelineEvent} from '../api';
/** The already-authorized external trace; never requests or fabricates hidden model reasoning. */
export function ModelTrace({event}:{event:TimelineEvent}) {
 if (!['model_decision','staff_model_decision','tool_result','staff_tool_result'].includes(event.kind)) return null;
 const d=event.details as Record<string,any>|undefined;
 if(!d)return null;
 const receipt=d.receipt;
 const calls=Array.isArray(d.calls)?d.calls.filter((c:any)=>c&&typeof c.tool==='string').slice(0,4):[];
 return <section className="model-trace" aria-label="Recorded agent tools">
  <strong>Recorded agent tools</strong>
  {receipt&&<p className="small">{modelPresentation(receipt)} · {receipt.status} · receipt <code>{String(receipt.id).slice(0,8)}</code>{typeof receipt.durationMs==='number'?` · ${(receipt.durationMs/1000).toFixed(1)} s`:''}</p>}
  {calls.map((c:any,i:number)=><div key={i}><code>{c.tool}</code><pre>{format(c.arguments)}</pre></div>)}
  {typeof d.tool==='string'&&<div><code>{d.tool}</code><pre>{format(d.output)}</pre></div>}
  <span className="muted small">Selection and tool result are separate from the accepted game order.</span>
 </section>;
}
function format(value:unknown){let parsed=value;if(typeof value==='string'){try{parsed=JSON.parse(value);}catch{parsed=value;}}return (typeof parsed==='string'?parsed:JSON.stringify(parsed??null,null,2)).slice(0,5000);}
