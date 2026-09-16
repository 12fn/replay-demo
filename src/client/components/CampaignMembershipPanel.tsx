import { useEffect, useId, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Loader2, LogOut, Users } from 'lucide-react';
import type { CampaignView } from '../campaign-api';
import {
  exclusionText,
  memberRows,
  missionMembershipRows,
  seatSummary,
  viewerCapabilities,
  type MembershipAction,
  type MembershipSnapshot,
} from '../campaign-membership-ui';
import { InlineError } from './ui';

/**
 * Compact roster and admission controls for a shared campaign. Presentational: every network call goes
 * through the callbacks (CampaignControl owns the membership controller). Capability flags only decide
 * what is offered; the server re-checks every request against the caller's fresh identity, so nothing
 * here is a permission. Owner-only controls are not rendered for participants at all rather than shown
 * disabled, so a peer never sees a control that looks like theirs to press.
 */
export interface CampaignMembershipPanelProps {
  /** Campaign view to render membership from (executor poll merged with the latest action response). */
  view: CampaignView | null;
  m: MembershipSnapshot;
  /** Workroom seat is read-only. Join, invite, limit and remove need write access; leaving does not. */
  readOnly: boolean;
  readOnlyReason?: string | null;
  /** Native sharing permission when the platform reports one; null/undefined when unknown (local mode). */
  canShare?: boolean | null;
  /** True while the campaign executor itself is busy, so admission controls do not overlap a progression call. */
  executorBusy: boolean;
  onJoin: (code: string) => Promise<void>;
  onIssueCode: () => Promise<void>;
  onDismissInvite: () => void;
  onWithdraw: () => Promise<void>;
  onSetLimit: (max: number) => Promise<void>;
  onRevoke: (subject: string) => Promise<void>;
  onReinstate: (subject: string) => Promise<void>;
  onClearMessages: () => void;
}

const LIMITS = Array.from({ length: 16 }, (_, i) => i);

const busyIs = (busy: MembershipAction | null, label: MembershipAction) => (busy === label ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null);

const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const };

export function CampaignMembershipPanel(props: CampaignMembershipPanelProps) {
  const { view, m, readOnly, readOnlyReason, canShare, executorBusy } = props;
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const codeId = useId();
  const limitId = useId();
  const rosterId = useId();
  const missionsId = useId();

  const caps = viewerCapabilities(view);
  const membership = view?.membership;
  const busy = m.busy !== null || executorBusy;

  // Nothing that was typed or confirmed survives a change of campaign or of invite.
  useEffect(() => {
    setConfirm(null);
    setCopied(false);
    setCopyError(null);
  }, [m.campaignId, m.invite]);

  const submitJoin = (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || busy || readOnly) return;
    void props.onJoin(c).then(() => setCode(''));
  };

  const copy = async () => {
    if (!m.invite) return;
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser; select the code and copy it by hand.');
      await navigator.clipboard.writeText(m.invite.code);
      setCopied(true);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : String(e));
    }
  };

  const confirmed = (key: string, action: () => Promise<void>) => {
    if (confirm !== key) {
      setConfirm(key);
      return;
    }
    setConfirm(null);
    void action();
  };

  const messages = (
    <>
      {m.notice && (
        <p className="campaign-fine" role="status" style={rowStyle}>
          <span>{m.notice}</span>
          <button type="button" className="link" onClick={props.onClearMessages}>Dismiss</button>
        </p>
      )}
      <InlineError message={m.error ?? copyError} />
    </>
  );

  /* ---- no campaign shown: join only ---- */
  if (!view) {
    return (
      <div className="campaign-membership" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <form className="campaign-start" onSubmit={submitJoin} aria-label="Join a shared campaign">
          <label className="sr-only" htmlFor={codeId}>Campaign invite code</label>
          <input
            id={codeId}
            className="input mono"
            placeholder="Campaign invite code"
            value={code}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={64}
            disabled={busy || readOnly}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={busy || readOnly || code.trim() === ''}>
            {busyIs(m.busy, 'join') ?? <KeyRound size={13} aria-hidden="true" />} Join campaign
          </button>
        </form>
        <p className="campaign-fine">
          {readOnly
            ? <>Your seat is read-only{readOnlyReason ? ` (${readOnlyReason})` : ''}, so you cannot join a shared campaign here.</>
            : <>Joining switches this session to the campaign's running mission and seats you on each later mission while you remain a member. Your seat is whatever the workroom gives you at the time; the code does not change it. The code is used once and not kept in this browser.</>}
        </p>
        {m.pendingBind && (
          <p className="campaign-fine" role="status">
            <Loader2 size={12} className="spin" aria-hidden="true" /> Joined. Waiting for this tab to show the campaign's mission before opening the campaign view…
          </p>
        )}
        {messages}
      </div>
    );
  }

  /* ---- campaign shown ---- */
  if (!caps.shared) {
    return (
      <div className="campaign-membership">
        <p className="campaign-fine">This server does not report campaign membership; only the owner is seated on missions.</p>
        {messages}
      </div>
    );
  }

  const rows = memberRows(membership, caps.canManage);
  const missions = missionMembershipRows(membership);
  const inviteBlocked = canShare === false;

  return (
    <div className="campaign-membership" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="campaign-status">
        <Users size={13} aria-hidden="true" />
        <span>{caps.role === 'owner' ? 'You own this campaign' : caps.viewerInactive ? 'You are no longer a member' : 'You are a participant'}</span>
        <span className="tag tag-muted">{seatSummary(membership)}</span>
      </div>

      {membership?.detached && (
        <p className="campaign-stalled" role="status">
          <span>{membership.detached.note}</span>
        </p>
      )}

      {/* Owner admission controls. Not rendered for participants. */}
      {caps.canAdmit && (
        <div className="campaign-controls">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || readOnly || inviteBlocked}
            title={inviteBlocked ? 'Your workroom access does not include sharing' : 'Creates a 24-hour invite code for this workroom; any earlier code stops working'}
            onClick={() => void props.onIssueCode()}
          >
            {busyIs(m.busy, 'code') ?? <KeyRound size={13} aria-hidden="true" />} {m.invite ? 'Rotate invite code' : 'Create invite code'}
          </button>
          <label className="campaign-follow" htmlFor={limitId}>
            Participant limit
            <select
              id={limitId}
              className="select select-sm"
              value={membership!.maxParticipants}
              disabled={busy || readOnly}
              onChange={(e) => void props.onSetLimit(Number(e.target.value))}
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {busyIs(m.busy, 'limit')}
          </label>
        </div>
      )}
      {caps.canAdmit && inviteBlocked && (
        <p className="campaign-fine" role="status">Inviting needs native sharing permission on your workroom seat, which this session does not have.</p>
      )}
      {caps.canManage && caps.terminal && (
        <p className="campaign-fine">The campaign has ended, so no new participants can be invited. Removing someone from a mission that still runs is still possible below.</p>
      )}

      {m.invite && (
        <div className="campaign-transition" role="status">
          <KeyRound size={14} aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <output className="mono" aria-label="Campaign invite code" style={{ display: 'block', wordBreak: 'break-all', userSelect: 'all' }}>{m.invite.code}</output>
            <span className="campaign-fine">
              Expires {new Date(m.invite.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}. Works only for members of this workroom; pass it on yourself, REPLAY sends no invitations. Shown once and not stored in this browser.
            </span>
            <div className="campaign-transition-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy()} aria-live="polite">
                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={props.onDismissInvite}>Hide code</button>
            </div>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <span id={rosterId} className="sr-only">Campaign members</span>
          <ul className="campaign-missions" aria-labelledby={rosterId}>
            {rows.map((r) => {
              const key = `revoke:${r.subject}`;
              const confirming = confirm === key;
              return (
                <li key={r.subject} style={{ alignItems: 'center' }}>
                  <span style={{ minWidth: 0 }}>
                    <strong>{r.name}</strong>{r.isViewer ? ' (you)' : ''}
                    {r.tag && <> <span className={`tag${r.standing === 'revoked' ? ' tag-danger' : r.standing === 'owner' ? '' : ' tag-muted'}`}>{r.tag}</span></>}
                    <br />
                    <span className="mono">{r.organization} · {r.term}</span>
                  </span>
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    {r.canRevoke && !confirming && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busy || readOnly} onClick={() => setConfirm(key)} title="Removes them from the campaign now and rotates the invite code; their records stay">
                        Remove
                      </button>
                    )}
                    {r.canRevoke && confirming && (
                      <span role="group" aria-label={`Confirm removing ${r.name}`} style={{ display: 'inline-flex', gap: 4 }}>
                        <button type="button" className="btn btn-sm btn-danger" disabled={busy || readOnly} onClick={() => confirmed(key, () => props.onRevoke(r.subject))}>
                          {busyIs(m.busy, `revoke:${r.subject}`)} Confirm remove
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>Keep</button>
                      </span>
                    )}
                    {r.canReinstate && (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={busy || readOnly} onClick={() => void props.onReinstate(r.subject)} title="Lifts the removal. They rejoin with a current invite code; nobody is seated on their behalf">
                        {busyIs(m.busy, `reinstate:${r.subject}`)} Lift removal
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {missions.length > 0 && (
        <details>
          <summary className="campaign-fine" style={{ cursor: 'pointer' }} id={missionsId}>Who was seated on each mission</summary>
          <ul className="campaign-missions" aria-labelledby={missionsId} style={{ marginTop: 4 }}>
            {missions.map((x) => (
              <li key={x.exerciseId} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                <span style={rowStyle}>
                  <span>Mission {x.number}</span>
                  <span className="mono">{x.summary}</span>
                </span>
                {x.carried.length > 0 && <span className="mono">carried: {x.carried.join(', ')}</span>}
                {x.excluded.map((e) => (
                  <span key={`${x.exerciseId}:${e.name}`} className="mono">
                    not seated: {e.name}, {exclusionText(e.outcome)}{e.detail ? ` (${e.detail})` : ''}. Membership unchanged; rejoining with a current code seats them again.
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}

      {caps.canLeave && (
        <div className="campaign-controls">
          <button
            type="button"
            className={`btn btn-sm ${confirm === 'withdraw' ? 'btn-danger' : 'btn-ghost'}`}
            disabled={busy}
            onBlur={() => confirm === 'withdraw' && setConfirm(null)}
            onClick={() => confirmed('withdraw', props.onWithdraw)}
            title="Ends your membership now. Later missions will not seat you; your records on earlier missions stay."
          >
            {busyIs(m.busy, 'withdraw') ?? <LogOut size={12} aria-hidden="true" />} {confirm === 'withdraw' ? 'Confirm: leave campaign' : 'Leave campaign'}
          </button>
        </div>
      )}
      {caps.viewerInactive && <p className="campaign-fine" role="status">Your membership has ended. This view will close on the next refresh; earlier mission records stay in Review.</p>}

      {membership && membership.limits.length > 0 && (
        <p className="campaign-fine">{membership.limits.join(' ')}</p>
      )}
      <p className="campaign-fine">
        The roster shows recorded membership. Who may act on a mission right now comes from each person's own current workroom access, never from this list.
      </p>
      {messages}
    </div>
  );
}
