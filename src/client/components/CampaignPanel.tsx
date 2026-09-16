import { useId, useState, type FormEvent } from 'react';
import { ArrowRight, Loader2, Pause, Play, Repeat, ShieldAlert, Square } from 'lucide-react';
import type { CampaignSession } from '../../campaign/session';
import type { CampaignProgress, CampaignView } from '../campaign-api';
import { simulatedElapsedLabel, type FreshMissionTransition } from '../campaign-follow';
import { InlineError, Panel } from './ui';
import '../campaign.css';

/**
 * Props the parent (App) supplies. The panel is presentational plus a little local form state; all
 * network calls go through the callbacks so App owns polling, the follow reducer and error routing.
 */
export interface CampaignPanelProps {
  /** Current campaign view from GET /api/campaigns/:id, or null when this session has no campaign. */
  view: CampaignView | null;
  /** True while a request the panel started is in flight. */
  busy: boolean;
  /** Last error from create/resume/pause/stop or the poll; shown in plain language. */
  error: string | null;
  /** Workroom seat is read-only, or native authority is absent. Controls that write are disabled. */
  readOnly: boolean;
  /** Reason the seat is read-only, if the native context supplies one. */
  readOnlyReason?: string | null;
  /** Whether this browser follows the campaign into new missions. Owned by the follow reducer. */
  following: boolean;
  /** True when a historical tick is displayed. Follow moves are held while frozen. */
  frozen: boolean;
  /** A mission that opened while this session was frozen or paused, awaiting explicit acceptance. */
  heldTransition: FreshMissionTransition | null;
  /** The most recent transition this session did apply, for a dismissible notice. */
  lastTransition: FreshMissionTransition | null;
  /** Exercise this session is currently viewing, to mark the active mission in the list. */
  viewingExerciseId: string | null;
  /**
   * The server said this viewer owns the campaign (`membership.viewer.canManage`). When false the
   * progression controls are not rendered; the server refuses them anyway (403), this only keeps a
   * participant from seeing a control that looks like theirs. Defaults to true for views without a
   * membership block (owner-only servers).
   */
  canManage?: boolean;
  onStart: (name: string) => Promise<void>;
  onResume: () => Promise<void>;
  onPause: () => Promise<void>;
  onStop: () => Promise<void>;
  onFollowChange: (following: boolean) => void;
  /** User accepts a held transition: return to live and move to the current mission. */
  onAcceptTransition: () => void;
  onDismissTransition: () => void;
  /** Open a past mission's record in Review without leaving the campaign. */
  onOpenMission?: (exerciseId: string) => void;
}

const STATUS_LABEL: Record<CampaignSession['status'], string> = {
  'awaiting-mission': 'Opening next mission',
  running: 'Running',
  completed: 'Finished',
  stopped: 'Stopped',
  fault: 'Stopped (fault)',
};

const END_REASON: Record<NonNullable<CampaignSession['endReason']>, string> = {
  'tick-budget': 'the simulated-time budget was reached',
  'mission-limit': 'the mission cap was reached',
  'participant-stop': 'you stopped it',
  fault: 'a fault stopped it',
};

const MISSION_END: Record<NonNullable<CampaignSession['missions'][number]['end']>['reason'], string> = {
  elimination: 'ended by elimination',
  'time-limit': 'ended at its time limit',
  'facilitator-end': 'ended for review',
  'campaign-budget': 'ended at the campaign budget',
};

function pauseText(reason: string | null | undefined): string {
  switch (reason) {
    case 'restart':
      return 'The server restarted. New missions will not open until you resume with your current sign-in.';
    case 'authority-revoked':
      return 'Your workroom write access changed. New missions will not open until access is restored and you resume.';
    case 'authority-check-failed':
      return 'The last authority check failed, so the next mission was not opened. Resume to check again.';
    case 'fault':
      return 'A fault stopped progression. The current record is intact; nothing was skipped.';
    case 'participant-pause':
    case undefined:
    case null:
      return 'Automatic progression is paused. The current mission keeps running; no new mission will open until you resume.';
    default:
      return `Automatic progression is paused (${reason}). Resume to continue.`;
  }
}

function ProgressBlock({ progress, targetTicks, maxMissions }: { progress: CampaignProgress; targetTicks: number; maxMissions: number }) {
  const pct = targetTicks > 0 ? Math.min(100, (progress.elapsedTicks / targetTicks) * 100) : 0;
  return (
    <div className="campaign-progress">
      <div className="campaign-progress-row">
        <span>Simulated time played</span>
        <strong>{simulatedElapsedLabel(progress.elapsedTicks)}</strong>
      </div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={targetTicks} aria-valuenow={progress.elapsedTicks} aria-label="Simulated time played against the campaign budget">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="campaign-progress-row">
        <span>Budget</span>
        <strong>{simulatedElapsedLabel(targetTicks)} · up to {maxMissions} missions</strong>
      </div>
      <div className="campaign-progress-row">
        <span>Missions so far</span>
        <strong>{progress.missionCount}</strong>
      </div>
    </div>
  );
}

export function CampaignPanel(props: CampaignPanelProps) {
  const { view, busy, error, readOnly, readOnlyReason, following, frozen, heldTransition, lastTransition, viewingExerciseId } = props;
  const canManage = props.canManage ?? (view?.membership ? view.membership.viewer.canManage === true : true);
  const participant = view?.membership?.viewer.role === 'participant';
  const [name, setName] = useState('');
  const nameId = useId();
  const followId = useId();
  const [confirmStop, setConfirmStop] = useState(false);

  const campaign = view?.campaign ?? null;
  const active = campaign?.missions.find((m) => m.exerciseId === view?.activeExerciseId && !m.end) ?? null;
  const activeIndex = active ? campaign!.missions.indexOf(active) : -1;
  const finished = campaign ? campaign.status === 'completed' || campaign.status === 'stopped' || campaign.status === 'fault' : false;
  const stalled = !!campaign && !finished && !view!.enabled;

  const submitStart = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy || readOnly) return;
    void props.onStart(n).then(() => setName(''));
  };

  const stop = () => {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    void props.onStop();
  };

  return (
    <Panel
      title={<><Repeat size={14} aria-hidden="true" /> Practice campaign</>}
      tone="dark"
      className="campaign-panel"
      aside={campaign ? <span className={`tag${finished ? ' tag-muted' : stalled ? ' tag-warn' : ''}`}>{STATUS_LABEL[campaign.status]}</span> : <span className="tag tag-muted">optional</span>}
    >
      {!campaign && (
        <>
          <p className="campaign-fine">
            Play a run of complete missions back to back with your campaign team. An instructor with sharing permission can invite commanders and analysts. When one ends under its own rules, the next opens on a <strong>new map with new forces</strong>.
            There is no quiz or approval screen between missions; Review stays a step you take when you want it.
          </p>
          <form className="campaign-start" onSubmit={submitStart}>
            <label className="sr-only" htmlFor={nameId}>Campaign name</label>
            <input
              id={nameId}
              className="input"
              placeholder="Campaign name"
              value={name}
              maxLength={80}
              autoComplete="off"
              disabled={busy || readOnly}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || readOnly || name.trim() === ''}>
              {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />} Start campaign
            </button>
          </form>
          {readOnly && (
            <p className="campaign-fine" role="status">
              Your seat is read-only{readOnlyReason ? ` (${readOnlyReason})` : ''}, so you cannot start a campaign here.
            </p>
          )}
          <p className="campaign-fine">
            The budget counts simulated time only, at 10 ticks per simulated second. It is not a promise of how long you will play or a measure of learning.
            Paid model opponents are never started automatically; enable one per mission if you want it.
          </p>
        </>
      )}

      {campaign && view && (
        <>
          <div className="campaign-status">
            <span className="campaign-name">{campaign.name}</span>
            {participant && <span className="tag tag-muted">joined</span>}
            {!view.enabled && !finished && <span className="tag tag-warn">progression paused</span>}
            {following && !finished && <span className="tag">following</span>}
          </div>

          {active ? (
            <div className="campaign-mission">
              <span className="campaign-mission-title">Mission {activeIndex + 1} of up to {campaign.rules.maxMissions}</span>
              <span className="campaign-mission-sub">
                {active.reservation.scenarioId} · exercise <span className="mono">{active.exerciseId.slice(0, 8)}</span>
                {viewingExerciseId && viewingExerciseId !== active.exerciseId && ' · you are viewing a different exercise'}
              </span>
            </div>
          ) : campaign.status === 'awaiting-mission' && view.enabled ? (
            <div className="campaign-mission">
              <span className="campaign-mission-title"><Loader2 size={13} className="spin" aria-hidden="true" /> Opening the next mission</span>
              <span className="campaign-mission-sub">A fresh map and forces are being prepared.</span>
            </div>
          ) : null}

          <ProgressBlock progress={view.progress} targetTicks={campaign.rules.targetTicks} maxMissions={campaign.rules.maxMissions} />

          {heldTransition && (
            <div className="campaign-transition" role="status">
              <ArrowRight size={14} aria-hidden="true" />
              <div>
                {heldTransition.message}
                {frozen
                  ? ' You are inspecting a historical tick, so your view was not moved.'
                  : !following
                    ? ' Following is off, so your view was not moved.'
                    : ''}
                <div className="campaign-transition-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={props.onAcceptTransition}>
                    Go to current mission
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={props.onDismissTransition}>
                    Stay here
                  </button>
                </div>
              </div>
            </div>
          )}

          {!heldTransition && lastTransition && (
            <div className="campaign-transition" role="status">
              <ArrowRight size={14} aria-hidden="true" />
              <div>
                {lastTransition.message}
                <div className="campaign-transition-actions">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={props.onDismissTransition}>Dismiss</button>
                </div>
              </div>
            </div>
          )}

          {stalled && (
            <p className="campaign-stalled" role="status">
              <ShieldAlert size={14} aria-hidden="true" />
              <span>{pauseText(view.pauseReason)}</span>
            </p>
          )}

          {finished && (
            <p className="campaign-ended" role="status">
              This campaign finished because {campaign.endReason ? END_REASON[campaign.endReason] : 'it ended'}. Every mission record stays available in Review.
              {campaign.endReason === 'mission-limit' && ' The mission cap can end a campaign before its time budget.'}
            </p>
          )}

          {!finished && (
            <div className="campaign-controls">
              {canManage && (view.enabled ? (
                <button type="button" className="btn btn-sm" disabled={busy || readOnly} title="Stop opening new missions. The current mission keeps running." onClick={() => void props.onPause()}>
                  <Pause size={13} aria-hidden="true" /> Pause next missions
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-primary" disabled={busy || readOnly} title="Re-check your access and continue opening missions" onClick={() => void props.onResume()}>
                  <Play size={13} aria-hidden="true" /> Resume
                </button>
              ))}
              {canManage && (
                <button
                  type="button"
                  className={`btn btn-sm ${confirmStop ? 'btn-danger' : 'btn-ghost'}`}
                  disabled={busy || readOnly}
                  onClick={stop}
                  onBlur={() => setConfirmStop(false)}
                  title="Ends the campaign. The current exercise is not ended or changed."
                >
                  <Square size={12} aria-hidden="true" /> {confirmStop ? 'Confirm: stop campaign' : 'Stop campaign'}
                </button>
              )}
              <label className="campaign-follow" htmlFor={followId}>
                <input id={followId} type="checkbox" checked={following} onChange={(e) => props.onFollowChange(e.target.checked)} />
                Follow into new missions
              </label>
              {busy && <Loader2 size={13} className="spin" aria-hidden="true" role="status" aria-label="Working" />}
            </div>
          )}

          {!canManage && !finished && (
            <p className="campaign-fine" role="status">Only the campaign owner can pause, resume or stop it. You can follow into new missions and open earlier ones in Review.</p>
          )}

          {readOnly && !finished && canManage && (
            <p className="campaign-fine" role="status">Your seat is read-only{readOnlyReason ? ` (${readOnlyReason})` : ''}; you can watch and follow, but not change the campaign.</p>
          )}

          {campaign.missions.length > 0 && (
            <ul className="campaign-missions" aria-label="Missions in this campaign">
              {campaign.missions.map((m, i) => {
                const isActive = m.exerciseId === view.activeExerciseId && !m.end;
                const label = `Mission ${i + 1}`;
                return (
                  <li key={m.reservation.key} className={isActive ? 'is-active' : undefined}>
                    <span>
                      {props.onOpenMission && !isActive ? (
                        <button type="button" className="link" onClick={() => props.onOpenMission?.(m.exerciseId)} title="Open this mission's record">{label}</button>
                      ) : label}
                      {' '}<span className="mono">{m.reservation.scenarioId}</span>
                    </span>
                    <span className="mono">{m.end ? `${MISSION_END[m.end.reason]} · ${simulatedElapsedLabel(m.end.elapsedTicks)}` : isActive ? 'in progress' : 'pending'}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="campaign-fine">
            Simulated time is the actual ticks the engine ran, at 10 per simulated second. Mission outcomes are game results under differing rules, not learning scores.
          </p>
        </>
      )}

      <InlineError message={error} />
    </Panel>
  );
}
