import { victoryDescription } from '../../scenarios/catalog';
import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Flag, GitBranch, Play, Square } from 'lucide-react';
import { api, errorMessage, type ExerciseSummary, type Overview, type Side } from '../api';
import type { View } from './Header';
import { sideLabel, statusLabel, tickClock, type CommandAuthority, type Lineage } from '../lib';
import { Busy, InlineError, KindBadge, Panel } from './ui';

const BRIEF_KEY = 'replay.briefCollapsed';

function readBriefCollapsed(): boolean {
  try {
    return localStorage.getItem(BRIEF_KEY) !== '0';
  } catch {
    return false;
  }
}

/**
 * Provisional learning objectives for Exercise Crosscurrent. They are educational framing for a
 * fictional abstract strategy game, not validated doctrine; the backend dossier states the same.
 */
const OBJECTIVES: { id: string; title: string; text: string }[] = [
  {
    id: 'resources',
    title: 'Manage resources',
    text: 'Hold and grow territory while keeping a reserve. Every commitment removes troops you could otherwise use.',
  },
  {
    id: 'provenance',
    title: 'Check provenance',
    text: 'Each staff report records its source and the simulation tick it observed. Treat it as time-bound, not permanent.',
  },
  {
    id: 'revision',
    title: 'Revise openly',
    text: 'When a newer report supersedes an older one, revise the plan and be able to say which assumption changed.',
  },
];

interface Props {
  ov: Overview;
  active: ExerciseSummary | undefined;
  lineage: Lineage | null;
  assignedSide: Side;
  authority: CommandAuthority;
  refresh: () => Promise<void>;
  navigate: (v: View) => void;
}

export function ObjectivesPanel({ ov, active, lineage, assignedSide, authority, refresh, navigate }: Props) {
  const [briefCollapsed, setBriefCollapsed] = useState<boolean>(readBriefCollapsed);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const role = ov.identity.role;
  const frozen = ov.playbackTick !== null;
  const canEnd = active?.status === 'running' && (role === 'commander' || role === 'instructor');

  const toggleBrief = () => {
    const next = !briefCollapsed;
    setBriefCollapsed(next);
    try {
      localStorage.setItem(BRIEF_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const endExercise = () => {
    if (!active) return;
    if (!confirmEnd) {
      setConfirmEnd(true);
      return;
    }
    setConfirmEnd(false);
    void run('end', () => api.finish(active.id));
  };

  return (
    <Panel
      title={<><Flag size={14} aria-hidden="true" /> Objectives</>}
      tone="dark"
      className={`objectives${briefCollapsed ? ' is-collapsed' : ''}`}
      aside={
        <button type="button" className="btn btn-ghost btn-sm" onClick={toggleBrief} aria-expanded={!briefCollapsed} aria-controls="mission-brief">
          {briefCollapsed ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
          {briefCollapsed ? 'Brief' : 'Hide brief'}
        </button>
      }
    >
      {!briefCollapsed && (
        <div id="mission-brief" className="brief">
          <p className="brief-lead">
            <BookOpen size={13} aria-hidden="true" /> <strong>Mission brief.</strong> You serve on {sideLabel(assignedSide)} in a fictional contest for
            territory and production. The opponent plays continuously. Nothing pauses for you, and no order is required at any set moment.
          </p>
          <p className="small"><strong>{active?.options?.scenario?.title??'Original exercise rules'}.</strong> {victoryDescription(active?.options?.scenario)}</p>
          <p className="small">{role==='intelligence'?'Your intelligence seat investigates reports and publishes assessments. The commander issues orders.':role==='instructor'?'Your instructor seat can manage the exercise and review evidence from both sides.':'Your commander seat issues orders and can delegate questions and standing watches to staff.'}</p>
          <ol className="brief-steps">
            <li>{role==='intelligence'?'Inspect the shared map and record what the evidence supports.':'Select a tile on the map, then issue orders from the right-hand panel.'}</li>
            <li>Read staff reports there too. Ask staff or set a standing watch when something matters.</li>
            <li>Open Review to scrub your record and branch a new line of play. Opponent staff records become available after the exercise ends.</li>
          </ol>
          <p className="muted small">Provisional educational objectives · fictional scenario · no real-world doctrine or adversary data.</p>
        </div>
      )}

      <ul className="objective-list">
        {OBJECTIVES.map((o) => (
          <li key={o.id}>
            <span className="objective-title">{o.title}</span>
            <span className="objective-text">{o.text}</span>
          </li>
        ))}
      </ul>

      {active && (
        <div className="context-line">
          <KindBadge kind={active.kind} /> <span>{active.name}</span>
          <span className="muted">· {statusLabel(active.status)}</span>
          {lineage?.source && lineage.forkTick !== null && (
            <span className="muted">
              · from <strong>{lineage.source.name}</strong> at tick {lineage.forkTick} ({tickClock(lineage.forkTick)})
            </span>
          )}
        </div>
      )}

      {!authority.allowed && authority.reason && (
        <p className="authority-note" role="status">{authority.reason}</p>
      )}

      <div className="ops">
        {frozen && (
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void run('live', () => api.replay(null, ov.activeId))}>
            <Play size={13} aria-hidden="true" /> Return to live
          </button>
        )}
        {lineage?.source && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy !== null}
            title="Open the source exercise. The branch keeps its own record."
            onClick={() => lineage.source && void run('source', () => api.select(lineage.source!.id))}
          >
            <GitBranch size={13} aria-hidden="true" /> Open source exercise
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('review')}>
          Review record
        </button>
        {canEnd && (
          <button
            type="button"
            className={`btn btn-sm ${confirmEnd ? 'btn-danger' : 'btn-ghost'}`}
            disabled={busy !== null}
            onClick={endExercise}
            onBlur={() => setConfirmEnd(false)}
            title="Ends play; the record stays available for review and branching"
          >
            <Square size={12} aria-hidden="true" /> {confirmEnd ? 'Confirm: end for review' : 'End for review'}
          </button>
        )}
        {busy && <Busy label={busy === 'end' ? 'Ending…' : busy === 'source' ? 'Opening…' : 'Working…'} />}
      </div>
      <InlineError message={err} />
    </Panel>
  );
}
