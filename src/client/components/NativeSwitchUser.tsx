import {useEffect,useRef,useState} from 'react';
import {AlertTriangle,LogOut} from 'lucide-react';
import {errorMessage} from '../api';
import {checkedNativeLoginUrl,switchNativeAccount} from '../native-switch';
import {PartnerBranding} from './PartnerBranding';

/** Lives above the protected workspace so a logout denial cannot erase its result or expose old content. */
export function NativeSwitchUser({loginUrl,onCancel,onSignedOut,navigate=(url:string)=>window.location.assign(url)}:{loginUrl:string|undefined;onCancel:()=>void;onSignedOut:()=>void;navigate?:(url:string)=>void}) {
  const [started,setStarted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const inFlight=useRef(false),cancel=useRef<HTMLButtonElement>(null);
  let recoveryUrl:string|undefined;try{recoveryUrl=checkedNativeLoginUrl(loginUrl,loginUrl);}catch{/* No arbitrary redirect fallback. */}
  useEffect(()=>{cancel.current?.focus();},[]);
  async function confirm(){
    if(inFlight.current)return;
    inFlight.current=true;setStarted(true);setBusy(true);setError(null);
    try{await switchNativeAccount(loginUrl,onSignedOut,navigate);}
    catch(err){setError(errorMessage(err));}
    finally{inFlight.current=false;setBusy(false);}
  }
  return <div className="native-gate"><section className="native-card" role="dialog" aria-labelledby="switch-user-title" aria-describedby="switch-user-explanation">
    <div className="boot-title">REPLAY</div>
    <h1 id="switch-user-title" className="native-lead">Switch Kamiwaza user</h1>
    <p id="switch-user-explanation" className="native-hint">Sign out of REPLAY and Kamiwaza and choose another account? Your exercise records remain saved.</p>
    {error&&<p className="native-error" role="alert"><AlertTriangle size={14} aria-hidden="true"/>{error}</p>}
    {busy&&<p role="status">Signing out of REPLAY and Kamiwaza…</p>}
    <div className="native-actions">
      {!started&&<button ref={cancel} type="button" className="btn btn-ghost" onClick={onCancel}>Stay signed in</button>}
      {!error&&<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void confirm()}><LogOut size={14} aria-hidden="true"/>Switch user</button>}
      {error&&recoveryUrl&&<a className="btn btn-primary" href={recoveryUrl}>Open Kamiwaza sign-in</a>}
    </div>
    <PartnerBranding className="partner-signin"/>
  </section></div>;
}
