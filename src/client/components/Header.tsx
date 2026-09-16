import { useState } from 'react';
import { BookOpen, ChevronDown, Cpu, GitBranch, Library, LogOut, Map, Radio, RotateCcw, Search, ShieldCheck, WifiOff } from 'lucide-react';
import { api, errorMessage, type ExerciseSummary, type Overview, type Role, type Side } from '../api';
import { kindLabel, sideLabel, statusLabel, tickClock } from '../lib';
import { accessLabel, nativeApi, type NativePlatformBlock } from '../native-api';
import type { ConnectionStatus } from '../useOverview';
import { NewExercise } from './NewExercise';
import { ExerciseTeam } from './ExerciseTeam';
import { AppRecorder } from './AppRecorder';
import { KindBadge } from './ui';
import { PartnerBranding } from './PartnerBranding';

export type View = 'showcase' | 'exercise' | 'review' | 'practice' | 'catalog' | 'platform';
const NAV = [
  { id: 'showcase', label: 'Instructor case', icon: BookOpen, hint: 'A guided decision review' },
  { id: 'exercise', label: 'Exercise', icon: Map, hint: 'Play and make decisions' },
  { id: 'review', label: 'Review', icon: Search, hint: 'Reconstruct the record' },
  { id: 'practice', label: 'My practice', icon: GitBranch, hint: 'Learn from alternatives' },
  { id: 'catalog', label: 'Library', icon: Library, hint: 'Cases and source material' },
  { id: 'platform', label: 'Platform', icon: Cpu, hint: 'Kamiwaza connections' },
] as const;
const ROLES: { id: Role; label: string }[] = [
  { id: 'commander', label: 'Commander' }, { id: 'intelligence', label: 'Intelligence' }, { id: 'instructor', label: 'Instructor' },
];
interface Props {
  ov: Overview; view: View; onNavigate: (v: View) => void;
  connection: ConnectionStatus; connectionError: string | null; lastUpdated: Date | null;
  refresh: () => Promise<void>; activeExercise: ExerciseSummary | undefined; assignedSide: Side;
  native: NativePlatformBlock | null; onSignOut: () => Promise<void>;
  onSwitchUser?:()=>void;
}

/** Navigation, account controls, and exercise context have separate, stable homes. */
export function Header({ ov, view, onNavigate, connection, connectionError, lastUpdated, refresh, activeExercise, assignedSide, native, onSignOut, onSwitchUser }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await refresh(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  const isLocal = ov.identity.mode === 'local-demo';
  const context = native?.context;
  const role = ROLES.find(r => r.id === ov.identity.role)?.label ?? ov.identity.role;
  const destination = NAV.find(n => n.id === view)!;
  const inExercise = ['exercise', 'review', 'practice'].includes(view);
  const connectionLabel = connection === 'connected' ? 'Connected' : connection === 'loading' ? 'Connecting' : connection === 'degraded' ? 'Reconnecting' : 'Offline';
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="app-sidebar" aria-label="REPLAY workspace">
      <button className="brand" onClick={() => onNavigate('showcase')} aria-label="REPLAY home">
        <span className="brand-mark"><RotateCcw size={23} aria-hidden="true" /></span>
        <span><strong>REPLAY</strong></span>
      </button>
      <div className="sidebar-section-label">Learning workspace</div>
      <nav className="nav" aria-label="Destinations">
        {NAV.map(({ id, label, icon: Icon, hint }, index) => <button key={id} type="button"
          className={`nav-btn${view === id ? ' is-active' : ''}${index === 4 ? ' nav-divider' : ''}`}
          aria-current={view === id ? 'page' : undefined} aria-label={label} title={hint} onClick={() => onNavigate(id)}>
          <Icon size={18} aria-hidden="true" /><span>{label}</span>
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <PartnerBranding className="partner-sidebar" />
        <div className="workspace-origin"><ShieldCheck size={17} aria-hidden="true" /><div><strong>{isLocal ? 'Local demonstration' : 'Kamiwaza workroom'}</strong><span>{isLocal ? 'Synthetic exercise data' : context?.workroomName ?? ov.identity.organization}</span></div></div>
        <details className="account-menu">
          <summary><span className="avatar">{ov.identity.name.slice(0, 1).toUpperCase()}</span><span className="account-name"><strong>{ov.identity.name}</strong><span>{role}{isLocal ? ' · demo persona' : ''}</span></span><ChevronDown size={15} aria-hidden="true" /></summary>
          <div className="account-options">
            {isLocal ? <label>Demo persona<select className="select" value={ov.identity.role} disabled={busy} onChange={e => void run(() => api.session(e.target.value as Role))}>{ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
              : <><p className="small muted">{role} access is assigned by your workroom.{context && <> {accessLabel(context)}.</>}</p>{onSwitchUser&&<button className="btn btn-ghost" disabled={busy} onClick={onSwitchUser}>Switch user</button>}<button className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => { await nativeApi.logout(); await onSignOut(); })}><LogOut size={15} aria-hidden="true" />Sign out of REPLAY</button></>}
          </div>
        </details>
      </div>
    </aside>
    <header className="workspace-header">
      <PartnerBranding className="partner-mobile" />
      <div className="workspace-topbar">
        <div className="workspace-breadcrumb"><span>Workspace</span><span aria-hidden="true">/</span><strong>{destination.label}</strong></div>
        <div className="workspace-tools"><span className={`conn conn-${connection}`} role="status" title={connectionError ?? (lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : undefined)}>{connection === 'connected' ? <Radio size={13} aria-hidden="true" /> : <WifiOff size={13} aria-hidden="true" />}<span>{connectionLabel}</span></span><AppRecorder /></div>
      </div>
      {inExercise && <div className="exercise-context">
        <div className="exercise-switcher"><label htmlFor="exercise-select">Exercise record</label><select id="exercise-select" className="select" value={ov.activeId} disabled={busy} onChange={e => void run(() => api.select(e.target.value))}>
          {ov.exercises.map(ex => <option key={ex.id} value={ex.id}>{kindLabel(ex.kind)} · {ex.name} · {statusLabel(ex.status)}{ex.createdAt ? ` · ${new Date(ex.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</option>)}
          {!ov.exercises.length && <option value="">No exercises</option>}
        </select></div>
        <div className="exercise-context-state">{activeExercise && <KindBadge kind={activeExercise.kind} />}<span className="small muted">{ov.playbackTick !== null ? `Viewing tick ${ov.playbackTick}` : `Tick ${ov.state.tick}`} · {tickClock(ov.playbackTick ?? ov.state.tick)}</span><span className={`badge badge-${assignedSide}`}>{sideLabel(assignedSide)} seat</span></div>
        <div className="exercise-context-actions"><NewExercise disabled={busy || !(isLocal || context?.canEdit)} onCreated={async () => { await refresh(); onNavigate('exercise'); }} /><ExerciseTeam ov={ov} refresh={refresh} disabled={busy} onJoined={async () => { await refresh(); onNavigate('exercise'); }} /></div>
      </div>}
      {(err || (connection === 'degraded' && connectionError)) && <div className="hdr-banner" role="alert">{err ?? `Connection interrupted. Showing the last snapshot from ${lastUpdated?.toLocaleTimeString() ?? 'earlier'}.`}</div>}
    </header>
  </>;
}
