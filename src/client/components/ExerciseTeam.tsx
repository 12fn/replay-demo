import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, RefreshCw, Users, X } from 'lucide-react';
import { errorMessage, type Overview, type Role } from '../api';
import { sideLabel, statusLabel, tickClock } from '../lib';
import { nativeOf } from '../native-api';
import { teamApi, type JoinCode, type TeamView } from '../team-api';
import { SideBadge } from './ui';
import '../team.css';

const ROLE_LABEL: Record<string, string> = { commander: 'Commander', intelligence: 'Intelligence', instructor: 'Instructor' };
const roleLabel = (r: Role | string) => ROLE_LABEL[r] ?? r;

interface Props {
  ov: Overview;
  /** Re-reads the overview after roster or code changes. */
  refresh: () => Promise<void>;
  /** Called after a successful join; the header refreshes and navigates to the Exercise view. */
  onJoined: () => Promise<void>;
  /** Mirrors the header's busy state so the trigger disables with the other controls. */
  disabled?: boolean;
}

/**
 * Trigger button plus a modal dialog for joining or managing a shared exercise. Uses the native
 * <dialog> element for the focus trap, Escape handling and top-layer stacking; nothing else on the
 * page changes size, and the live overview poll keeps running underneath.
 */
export function ExerciseTeam({ ov, refresh, onJoined, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Join a shared exercise or manage who is enrolled in this one"
        onClick={() => setOpen(true)}
      >
        <Users size={14} aria-hidden="true" /> Team
      </button>
      <dialog
        ref={dialogRef}
        className="team-dialog"
        aria-labelledby="team-dialog-title"
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        {open && <TeamPanel ov={ov} refresh={refresh} onJoined={onJoined} onClose={close} />}
      </dialog>
    </>
  );
}

interface PanelProps {
  ov: Overview;
  refresh: () => Promise<void>;
  onJoined: () => Promise<void>;
  onClose: () => void;
}

/** Dialog body. Mounted only while the dialog is open so the join code and pending confirmations never outlive it. */
function TeamPanel({ ov, refresh, onJoined, onClose }: PanelProps) {
  const [team, setTeam] = useState<TeamView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [issued, setIssued] = useState<JoinCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const joinInputRef = useRef<HTMLInputElement>(null);

  const ctx = nativeOf(ov)?.context ?? null;
  const isLocal = ov.identity.mode === 'local-demo';
  const seat = roleLabel(ov.identity.role);
  const canEdit = isLocal || ctx?.canEdit === true;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const t = await teamApi.get(signal);
      setTeam(t);
      setLoadError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on open and whenever the session's active exercise changes underneath the dialog.
  useEffect(() => {
    const ac = new AbortController();
    setIssued(null);
    setCopied(false);
    setPendingRemove(null);
    setTeam(null);
    void load(ac.signal);
    return () => ac.abort();
  }, [load, ov.activeId]);

  useEffect(() => {
    joinInputRef.current?.focus();
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const join = () =>
    run('join', async () => {
      const code = joinCode.trim();
      if (!code) throw new Error('Enter the join code you were given.');
      await teamApi.join(code);
      setJoinCode('');
      await onJoined();
      onClose();
    });

  const issue = () =>
    run('code', async () => {
      const c = await teamApi.code();
      setIssued(c);
      setCopied(false);
      await load();
    });

  const copy = () =>
    run('copy', async () => {
      if (!issued) return;
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser; select the code and copy it manually.');
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
    });

  const remove = (subject: string) =>
    run(`remove:${subject}`, async () => {
      await teamApi.remove(subject);
      setPendingRemove(null);
      setIssued(null);
      setCopied(false);
      setNotice('Participant removed. The previous join code is revoked; issue a new one if others still need to join.');
      await load();
      await refresh();
    });

  const ended = team !== null && team.status !== 'running';
  const actives = team?.participants.filter((p) => p.active) ?? [];
  const inactives = team?.participants.filter((p) => !p.active) ?? [];

  return (
    <div className="team-panel">
      <header className="team-head">
        <div className="team-title">
          <h2 id="team-dialog-title">
            <Users size={16} aria-hidden="true" /> Team
          </h2>
          {team && (
            <span className="team-subtitle">
              {team.name} <SideBadge side={team.side} />
              <span className="team-status">{statusLabel(team.status)}</span>
            </span>
          )}
        </div>
        <div className="team-head-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading || busy !== null} title="Re-read the roster" onClick={() => void load()}>
            <RefreshCw size={13} className={loading ? 'spin' : undefined} aria-hidden="true" /> Refresh
          </button>
          <button type="button" className="btn btn-ghost btn-sm team-close" aria-label="Close" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {(actionError || loadError) && (
        <p className="team-error" role="alert">{actionError ?? loadError}</p>
      )}
      {notice && <p className="team-notice" role="status">{notice}</p>}

      <section className="team-section" aria-labelledby="team-join-title">
        <h3 id="team-join-title"><KeyRound size={13} aria-hidden="true" /> Join a shared exercise</h3>
        <form
          className="team-join"
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
        >
          <label className="sr-only" htmlFor="team-join-code">Join code</label>
          <input
            id="team-join-code"
            ref={joinInputRef}
            className="input team-code-input"
            placeholder="Join code"
            value={joinCode}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy !== null || !canEdit}
            onChange={(e) => setJoinCode(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy !== null || !canEdit || joinCode.trim() === ''}>
            {busy === 'join' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : null} Join
          </button>
        </form>
        <p className="team-fine">
          {canEdit
            ? <>Joining switches this session to that exercise. Your seat stays <strong>{seat}</strong>, as assigned by the workroom; the code cannot change it.</>
            : <>Your workroom seat is read-only{ctx?.readOnlyReason ? ` (${ctx.readOnlyReason})` : ''}, so you cannot join a shared exercise.</>}
        </p>
      </section>

      <section className="team-section" aria-labelledby="team-roster-title">
        <h3 id="team-roster-title">Roster{team ? ` · ${actives.length} active` : ''}</h3>
        {loading && !team && <p className="team-fine"><Loader2 size={13} className="spin" aria-hidden="true" /> Loading roster…</p>}
        {team && team.participants.length === 0 && <p className="team-fine">No one is enrolled yet.</p>}
        {team && team.participants.length > 0 && (
          <ul className="team-roster">
            {[...actives, ...inactives].map((p) => {
              const isSelf = p.subject === ov.identity.subject;
              const removable = team.canManage && p.active && !p.owner;
              const confirming = pendingRemove === p.subject;
              return (
                <li key={p.subject} className={`team-row${p.active ? '' : ' is-inactive'}`}>
                  <span className="team-row-main">
                    <span className="team-name">{p.name}{isSelf ? ' (you)' : ''}</span>
                    <span className="team-meta">
                      {p.organization}
                      {' · '}{roleLabel(p.roleAtJoin)} at join
                      {' · '}{p.source==='campaign-carryover'?'carried into mission':p.source==='campaign-join'?'joined this mission':'joined'} {tickClock(p.joinedTick)}
                    </span>
                  </span>
                  <span className="team-row-tags">
                    {p.owner && <span className="tag">owner</span>}
                    {!p.active && <span className="tag tag-status-cancelled">removed</span>}
                  </span>
                  {removable && !confirming && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setPendingRemove(p.subject)}>
                      Remove
                    </button>
                  )}
                  {removable && confirming && (
                    <span className="team-confirm" role="group" aria-label={`Confirm removing ${p.name}`}>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void remove(p.subject)}>
                        {busy === `remove:${p.subject}` ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null} Confirm remove
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setPendingRemove(null)}>
                        Keep
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="team-fine">
          Seats shown are as recorded at enrollment. Who can command or assess right now comes from each person's current workroom access, not this list.
          {team?.canManage && ' Removing someone revokes the current join code; their records stay in the exercise.'}
        </p>
      </section>

      <section className="team-section" aria-labelledby="team-share-title">
        <h3 id="team-share-title">Share this exercise</h3>
        {team && !team.canManage && (
          <p className="team-fine">Join codes require a running exercise and native sharing permission, plus an owner or instructor seat. This session cannot issue a code here.</p>
        )}
        {team?.canManage && ended && (
          <p className="team-fine">This exercise has {statusLabel(team.status).toLowerCase()}, so no new join codes can be issued for it. Select or create a running exercise to share one.</p>
        )}
        {team?.canManage && !ended && (
          <>
            <div className="team-share-actions">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => void issue()}>
                {busy === 'code' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <KeyRound size={14} aria-hidden="true" />}
                {issued ? ' Rotate code' : ' Create join code'}
              </button>
              {issued && (
                <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => void copy()} aria-live="polite">
                  {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
            {issued && (
              <output className="team-code" aria-label="Join code">
                <code>{issued.code}</code>
                <span className="team-meta">expires {new Date(issued.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </output>
            )}
            <p className="team-fine">
              Pass the code to teammates yourself; REPLAY does not send invitations. It works for 24 hours, only for members of this workroom, and rotating it invalidates the previous code. It is shown here once and is not stored in this browser.
            </p>
          </>
        )}
        {!team && !loading && loadError && <p className="team-fine">Roster unavailable; sharing controls appear once it loads.</p>}
      </section>

      {team && (
        <footer className="team-foot team-meta">
          Assigned side {sideLabel(team.side)} · exercise <span className="mono">{team.exerciseId.slice(0, 8)}</span>
        </footer>
      )}
    </div>
  );
}
