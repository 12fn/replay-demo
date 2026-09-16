import {PartnerBranding} from './PartnerBranding';
import { useState, type FormEvent, type ChangeEvent } from 'react';
import { AlertTriangle, LogIn, LogOut, ShieldCheck } from 'lucide-react';
import { errorMessage } from '../api';
import { nativeApi, type NativeStatus } from '../native-api';

interface Props {
  status: NativeStatus;
  /** Called after a successful login or logout so the app refetches status and overview. */
  onChange: () => Promise<void>;
  /** Clear harmless navigation preferences after an explicit, successful sign-out. */
  onSignedOut?: () => void;
  onSwitchUser?:()=>void;
  /** Status and message from the last overview request when it was refused (e.g. 403 blocked, 503 unavailable). */
  denied: { status: number; message: string } | null;
}

/**
 * Native Kamiwaza sign-in gate. Credentials are posted once to the REPLAY
 * server, which validates them with the platform; the browser keeps only an
 * opaque session cookie. When a session exists but the platform refuses it,
 * the same card explains the denial and offers sign-out.
 */
export function NativeSignIn({ status, onChange, onSignedOut, denied, onSwitchUser }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const blocked = status.signedIn && (status.denial !== null || (denied !== null && denied.status !== 401));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    const u = username.trim();
    const p = password;
    setPassword('');
    try {
      await nativeApi.login(u, p);
      await onChange();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  const importOperatorFile=async(e:ChangeEvent<HTMLInputElement>)=>{
    const file=e.target.files?.[0];e.target.value='';if(!file||busy)return;
    if(file.size>8192){setErr('Choose the small JSON file produced by the local operator setup.');return;}
    setBusy(true);setErr(null);
    try {const credentials=JSON.parse(await file.text());
      if(typeof credentials.username!=='string'||typeof credentials.password!=='string')throw new Error('Invalid operator credentials file');
      await nativeApi.login(credentials.username,credentials.password);credentials.password='';setPassword('');await onChange();
    }catch(ex){setErr(errorMessage(ex));}finally{setBusy(false);}
  };
  const signOut = async () => {
    setBusy(true);
    setErr(null);
    try {
      await nativeApi.logout();
      onSignedOut?.();
      await onChange();
    } catch (ex) {
      setErr(errorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  const continuePlatform = async () => {
    if(busy)return;
    setBusy(true);setErr(null);
    try {await nativeApi.platformSession();await onChange();}
    catch(ex){setErr(errorMessage(ex));}
    finally{setBusy(false);}
  };

  if (blocked) {
    const message = status.denial?.message ?? denied?.message ?? 'The platform refused this session.';
    return (
      <div className="native-gate">
        <div className="native-card native-denied" role="alert">
          <div className="boot-title">REPLAY</div>
          <div className="native-kicker"><AlertTriangle size={13} aria-hidden="true" /> Kamiwaza access refused</div>
          <p className="native-lead">{message}</p>
          <p className="native-hint">
            Signed in as <strong>{status.metadata?.username ?? 'unknown'}</strong> for workroom <code>{status.workroomId ?? '—'}</code>.
            Access is decided by the platform on every request; ask the workroom operator if this is unexpected.
          </p>
          <div className="native-actions">
            {onSwitchUser&&<button type="button" className="btn" disabled={busy} onClick={onSwitchUser}>Switch user</button>}
            <button type="button" className="btn" disabled={busy} onClick={() => void signOut()}>
              <LogOut size={14} aria-hidden="true" /> Sign out
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onChange()}>Retry</button>
          </div>
          {err && <p className="native-error"><AlertTriangle size={14} aria-hidden="true" /> {err}</p>}
          <PartnerBranding className="partner-signin" />
        </div>
      </div>
    );
  }

  if(status.platformSso) return (
    <div className="native-gate"><div className="native-card">
      <div className="boot-title">REPLAY</div>
      <div className="native-kicker"><ShieldCheck size={13} aria-hidden="true" /> Kamiwaza workroom</div>
      <p className="native-lead">Continue with your Kamiwaza session.</p>
      <p className="native-hint">Kamiwaza supplies your identity and workroom permissions. Your exercise record stays in this workroom.</p>
      <div className="native-actions">
        {onSwitchUser&&<button type="button" className="btn" disabled={busy} onClick={onSwitchUser}>Switch user</button>}
        {status.platformSessionAvailable ? <button className="btn btn-primary" disabled={busy} onClick={()=>void continuePlatform()}><LogIn size={14} aria-hidden="true" />{busy?'Opening workroom…':'Continue with Kamiwaza'}</button>
          : status.platformLoginUrl && <a className="btn btn-primary" href={status.platformLoginUrl}><LogIn size={14} aria-hidden="true" />Sign in to Kamiwaza</a>}
      </div>
      {(err||status.denial?.httpStatus!==401&&status.denial?.message)&&<p className="native-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{err??status.denial?.message}</p>}
      <PartnerBranding className="partner-signin" />
    </div></div>
  );

  return (
    <div className="native-gate">
      <div className="native-card">
        <div className="boot-title">REPLAY</div>
        <div className="native-kicker"><ShieldCheck size={13} aria-hidden="true" /> Kamiwaza sign-in</div>
        <p className="native-lead">Sign in with your Kamiwaza account to join the exercise workroom.</p>
        <p className="native-hint">
          Your workroom supplies your role and organization.
        </p>
        <form className="native-form" onSubmit={(e) => void submit(e)}>
          <label className="native-field">
            Username
            <input name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required disabled={busy} autoFocus />
          </label>
          <label className="native-field">
            Password
            <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy} />
          </label>
          <div className="native-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || !username.trim() || !password}>
              <LogIn size={14} aria-hidden="true" /> {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
          {err && <p className="native-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {err}</p>}
        </form>
        {status.operatorFileImport&&<p className="native-fine" role="status">Operator credential-file import is explicitly enabled for this installation.</p>}
        {status.operatorFileImport&&<details className="native-fine"><summary>Local operator sign-in</summary><p>Choose the temporary credentials file prepared for this local preview. It uses the same Kamiwaza sign-in.</p><label>Operator credentials file<input type="file" accept="application/json,.json" disabled={busy} onChange={e=>void importOperatorFile(e)}/></label></details>}
        <p className="native-fine">Your exercise record stays in this workroom.</p>
        <PartnerBranding className="partner-signin" />
      </div>
    </div>
  );
}
