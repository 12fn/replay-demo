import {useEffect,useRef,useState} from 'react';
import {Plus,X} from 'lucide-react';
import {SCENARIOS,DEFAULT_SCENARIO_ID,victoryDescription} from '../../scenarios/catalog';
import {api,errorMessage} from '../api';
import '../scenario.css';

/** Only creation is modal; play and review never wait on an instructional checkpoint. */
export function NewExercise({disabled,onCreated}:{disabled:boolean;onCreated:()=>Promise<void>}){
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const [open,setOpen]=useState(false),[selected,setSelected]=useState(DEFAULT_SCENARIO_ID);
  const created=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const scenario=SCENARIOS.find(s=>s.id===selected)!;
  useEffect(()=>{if(open)dialog.current?.showModal();},[open]);
  async function create(){
    if(busy||disabled)return;
    setBusy(true);setError(null);
    try{if(!created.current){await api.createExercise(scenario.title,scenario.id);created.current=true;}await onCreated();dialog.current?.close();}
    catch(e){setError((created.current?'Exercise created. Retry opening it: ':'')+errorMessage(e));}finally{setBusy(false);}
  }
  return <>
    <button ref={trigger} className="btn btn-ghost" type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={()=>{setError(null);created.current=false;setOpen(true);}}><Plus size={14}/> New</button>
    <dialog ref={dialog} className="scenario-dialog" aria-labelledby="scenario-title" onCancel={e=>{if(busy)e.preventDefault();}} onClose={()=>{setOpen(false);trigger.current?.focus();}}>
      <div className="scenario-panel">
        <div className="scenario-head"><h2 id="scenario-title">Choose an exercise</h2><button type="button" className="btn btn-ghost" aria-label="Close" disabled={busy} onClick={()=>dialog.current?.close()}><X size={18}/></button></div>
        <p>Choose your area of operations. Taiwan Strait uses a regional map and a dedicated Red cell brief. Play runs continuously after deployment.</p>
        <fieldset disabled={busy||created.current} className="scenario-choices"><legend>Starting situation</legend>{[...SCENARIOS].sort((a,b)=>Number(b.id===DEFAULT_SCENARIO_ID)-Number(a.id===DEFAULT_SCENARIO_ID)).map(s=><label className={`scenario-choice${selected===s.id?' selected':''}`} key={s.id}>
          <input type="radio" name="scenario" value={s.id} checked={selected===s.id} onChange={()=>setSelected(s.id)}/>
          <span><strong>{s.title}</strong><small>{s.description}</small>{s.status==='experimental'&&<span className="badge badge-warn">Experimental</span>}</span>
        </label>)}</fieldset>
        <div className="scenario-rule"><strong>When play ends</strong><p>{victoryDescription(scenario)}</p></div>
        <p className="small muted">{scenario.controller==='objectives/1'?'Scripted objective opponent':scenario.controller==='maneuver/1'?'Scripted maneuver opponent':'Original deterministic opponent'} · paid inference starts off. You can enable a connected model after deployment.</p>
        {error&&<p role="alert" className="team-error">{error}</p>}
        <button type="button" className="btn btn-primary" disabled={busy||disabled} onClick={()=>void create()}>{busy?'Opening…':created.current?'Open created exercise':'Start exercise'}</button>
      </div>
    </dialog>
  </>;
}
