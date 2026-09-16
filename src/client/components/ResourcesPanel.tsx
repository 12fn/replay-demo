import {dollarAllowance} from '../budget-presentation';
import {opponentPresentation} from '../model-presentation';
import { useState } from 'react';
import { Bot, ShieldOff } from 'lucide-react';
import { api, errorMessage, type ExerciseSummary, type GameState, type Overview, type Side } from '../api';
import { fmtInt, fmtUsd, playerBySide, sideLabel } from '../lib';
import { InlineError, Meter, Panel, SideBadge, Stat } from './ui';

interface Props {
  ov: Overview;
  state: GameState;
  active: ExerciseSummary | undefined;
  /** Backend-assigned side; listed first and marked. */
  assignedSide: Side;
  refresh: () => Promise<void>;
  /** Whether this role may toggle the model opponent. */
  canControlAgent: boolean;
}

export function ResourcesPanel({ ov, state, active, assignedSide, refresh, canControlAgent }: Props) {
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState<string | null>(null);
  const [confirmEnable, setConfirmEnable] = useState(false);

  // Backend is authoritative for whether the paid opponent is on. Older snapshots may omit the flag.
  const agentOn = active?.agentEnabled === true;
  const agentKnown = active?.agentEnabled !== undefined;
  const strait=active?.options?.scenario?.redCellProfile==='strait-red-cell/1'&&active.humanSide==='blue';
  const running = active?.status === 'running';

  const setAgent = async (enabled: boolean) => {
    setAgentBusy(true);
    setAgentErr(null);
    setConfirmEnable(false);
    try {
      await api.agent(enabled);
      await refresh();
    } catch (e) {
      setAgentErr(errorMessage(e));
    } finally {
      setAgentBusy(false);
    }
  };

  const sides: Side[] = assignedSide === 'blue' ? ['blue', 'red'] : ['red', 'blue'];

  return (
    <div className="stack">
      <Panel title="Forces" tone="dark" className="resources">
        {sides.map((side) => {
          const p = playerBySide(state, side);
          if (!p) return null;
          return (
            <div key={side} className={`force force-${side}${side === assignedSide ? ' is-seat' : ''}`}>
              <div className="force-head">
                <SideBadge side={side} />
                <span className="force-name">{p.name}</span>
                {side === assignedSide && <span className="tag">you</span>}
                {!p.alive && <span className={`tag ${state.spawning ? 'tag-muted' : 'tag-danger'}`}>{state.spawning ? 'deploying' : 'eliminated'}</span>}
              </div>
              <div className="stat-grid">
                <Stat label="Troops" value={fmtInt(p.troops)} hint={`cap ${fmtInt(p.maxTroops)}`} />
                <Stat label="Gold" value={fmtInt(p.gold)} />
                <Stat label="Territory" value={fmtInt(p.tiles)} hint="tiles" />
                <Stat label="Structures" value={p.units.length} />
              </div>
              <Meter value={p.troops} max={p.maxTroops} label={`${sideLabel(side)} troops against cap`} />
              {p.attacks.length > 0 && (
                <div className="force-orders">
                  {p.attacks.length} active {p.attacks.length === 1 ? 'attack' : 'attacks'} ·{' '}
                  {fmtInt(p.attacks.reduce((s, a) => s + a.troops, 0))} committed
                </div>
              )}
            </div>
          );
        })}
        <div className="phase-line">
          {state.spawning ? 'Deployment phase' : 'Manoeuvre phase'} · shared map <span className="mono">{state.map}</span> {state.width}×{state.height}
        </div>
      </Panel>

      <Panel title="Opponent" tone="dark" className="opponent">
        <p className="muted small">
          Controller: <span className="mono">{opponentPresentation(active?.agentEnabled, ov.platform.model)}</span>
        </p>
        {canControlAgent ? (
          <div className="agent-toggle">
            {agentOn ? (
              <>
                <p className="small">
                  <Bot size={13} aria-hidden="true" /> Model opponent is enabled. Model requests so far: {ov.platform.requests} ·{' '}
                  {fmtUsd(ov.platform.spentUsd)} of {dollarAllowance(ov.platform.capUsd)}.
                </p>
                <button type="button" className="btn btn-sm" disabled={agentBusy} onClick={() => void setAgent(false)}>
                  {agentBusy ? 'Stopping…' : 'Stop model opponent'}
                </button>
              </>
            ) : confirmEnable ? (
              <>
                <p className="small">Turning this on makes model requests under the configured route and request cap until you stop it. See Platform for usage and API charges.</p>
                <div className="action-row">
                  <button type="button" className="btn btn-sm btn-primary" disabled={agentBusy} onClick={() => void setAgent(true)}>
                    {agentBusy ? 'Starting…' : 'Confirm: start model opponent'}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={agentBusy} onClick={() => setConfirmEnable(false)}>
                    Keep off
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted small">
                  {!running ? 'This exercise has ended. Its actual controller traces remain in Review.' : agentKnown ? `${sideLabel(assignedSide === 'red' ? 'blue' : 'red')} uses the reference controller shown above.` : 'Opponent state not reported by this snapshot.'} Off by default to avoid
                  accidental spend.
                </p>
                <button type="button" className="btn btn-sm" disabled={agentBusy || !running} title={running ? undefined : 'Only a running exercise can enable the opponent'} onClick={() => setConfirmEnable(true)}>
                  {strait?'Enable Strait Red Cell model…':ov.platform.inferenceRoute==='kamiwaza-local'?'Enable Kamiwaza deployed model…':'Enable connected model…'}
                </button>
              </>
            )}
            <InlineError message={agentErr} />
          </div>
        ) : (
          <p className="muted small">
            <ShieldOff size={13} aria-hidden="true" /> Opponent control is available to the commander and instructor.
          </p>
        )}
        <p className="muted small">
          Requests {ov.platform.requests} · traces {ov.platform.traceCount} · details on the Platform page
        </p>
      </Panel>
    </div>
  );
}
