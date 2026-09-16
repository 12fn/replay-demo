import { PageHeading, WorkspaceTabs } from '../components/Workspace';
import { Square, Search } from 'lucide-react';
import {StraitBriefPanel} from '../components/StraitBriefPanel';
import { useCallback, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import type { ViewContext } from '../App';
import { ActionsInspector } from '../components/ActionsInspector';
import { MapCanvas } from '../components/MapCanvas';
import { NetworkPanel } from '../components/NetworkPanel';
import { ExecutionPanel } from '../components/ExecutionPanel';
import { ObjectivesPanel } from '../components/ObjectivesPanel';
import {RoleContextPanel} from '../components/RoleContextPanel';
import { ResourcesPanel } from '../components/ResourcesPanel';
import {TeamAssessmentPanel} from '../components/TeamAssessmentPanel';
import { StaffPanel } from '../components/StaffPanel';
import { InlineError } from '../components/ui';
import { kindLabel, lineage as buildLineage, sideLabel, tickClock } from '../lib';

export function ExerciseView({ ctx }: { ctx: ViewContext }) {
  const { ov, refresh, active, assignedSide, authority, selectedTile, setSelectedTile, navigate, openEvidence } = ctx;
  const role = ov.identity.role;
  const frozen = ov.playbackTick !== null;
  const [desk, setDesk] = useState<'orders' | 'staff' | 'mission' | 'forces' | 'team'>('orders');
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  const lineage = useMemo(() => buildLineage(ov.exercises, ov.activeId), [ov.exercises, ov.activeId]);
  const canControlAgent = role === 'commander' || role === 'instructor';
  const canInjectReport = role === 'instructor';

  const returnToLive = useCallback(async () => {
    setLiveErr(null);
    try {
      await api.replay(null, ov.activeId);
      await refresh();
    } catch (e) {
      setLiveErr(errorMessage(e));
    }
  }, [refresh, ov.activeId]);

  // Evidence links inside the exercise page: scroll to the report if it is on screen, otherwise open Review.
  const focusEvidence = useCallback(
    (id: string) => {
      const el = document.getElementById(`evidence-${id}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash');
        window.setTimeout(() => el.classList.remove('flash'), 1400);
      } else {
        openEvidence(id);
      }
    },
    [openEvidence],
  );

  const caption = active
    ? `${kindLabel(active.kind)}${
        frozen
          ? ` · showing tick ${ov.playbackTick} (${tickClock(ov.playbackTick ?? 0)}) · exercise at tick ${active.tick}`
          : ` · tick ${ov.state.tick}`
      } · you are ${sideLabel(assignedSide)}`
    : undefined;

  const finish = async () => {
    if (!active || ending) return;
    if (!confirmEnd) { setConfirmEnd(true); return; }
    setEnding(true); setLiveErr(null);
    try { await api.finish(active.id); await refresh(); } catch (e) { setLiveErr(errorMessage(e)); }
    finally { setEnding(false); setConfirmEnd(false); }
  };
  return <>
    <PageHeading eyebrow={active?.kind === 'branch' ? 'Independent practice branch' : 'Decision workspace'} title="Exercise"
      description={active?.status === 'running' ? 'Inspect the situation, record your reasoning, and make your next move.' : 'This exercise has ended. Review its decisions or branch from an earlier moment.'}
      actions={<><button className="btn" onClick={() => navigate('review')}><Search size={15} aria-hidden="true" />Review record</button>{active?.status === 'running' && canControlAgent && <button className={`btn ${confirmEnd ? 'btn-danger' : ''}`} disabled={ending} onClick={() => void finish()} onBlur={() => setConfirmEnd(false)}><Square size={13} aria-hidden="true" />{ending ? 'Ending…' : confirmEnd ? 'Confirm: end for review' : 'End for review'}</button>}</>} />
    <InlineError message={liveErr} />
    <div className="layout layout-exercise">
      <section className="col col-map" aria-label="Operational map">
        {ov.state.map==='taiwan-strait-400' && <div className="map-banner"><strong>Taiwan Strait</strong><span>Regional exercise · mainland coast, Taiwan and Penghu · fictional relay objectives</span></div>}
        {frozen && (
          <div className="map-banner" role="status">
            <span>
              Displayed view is frozen at tick {ov.playbackTick}.{' '}
              {active?.status === 'running' ? 'The exercise keeps running.' : 'This exercise has ended and cannot change.'}
            </span>
            {active?.kind !== 'recorded' && (
              <button type="button" className="btn btn-sm" onClick={() => void returnToLive()}>Return to live</button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('review')}>Open Review</button>
            <InlineError message={liveErr} />
          </div>
        )}
        {active?.kind === 'branch' && lineage && (
          <div className="map-banner map-banner-quiet" role="status">
            <span>
              Branch of <strong>{lineage.source?.name ?? active.parentId}</strong> from tick {lineage.forkTick ?? '?'}. You control{' '}
              <strong>{sideLabel(assignedSide)}</strong> here. The source exercise is unchanged.
            </span>
            {lineage.source && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void api.select(lineage.source!.id).then(refresh)}>
                Open source
              </button>
            )}
          </div>
        )}
        <MapCanvas stations={ov.campaign?.stations} state={ov.state} selectedTile={selectedTile} onSelectTile={setSelectedTile} perspective={assignedSide} caption={caption} />
        <details className="panel execution-disclosure"><summary>Order execution &amp; receipts</summary><ExecutionPanel orders={ov.executionOrders} onEvidence={focusEvidence} /></details>
      </section>

      <aside className="exercise-desk" aria-label="Exercise controls">
        <WorkspaceTabs label="Exercise desk" value={desk} onChange={setDesk} items={[{id:'orders',label:'Orders'},{id:'staff',label:'Staff'},{id:'mission',label:'Mission'},{id:'forces',label:'Forces'},{id:'team',label:'Team'}]} />
        <div className="desk-section" hidden={desk !== 'orders'}>
          <ActionsInspector key={`${ov.identity.subject}:${ov.identity.role}:${ov.activeId}:${frozen}`} exerciseId={ov.activeId} canPreview={!frozen && active?.status === 'running'} onSelectTile={setSelectedTile} observationReceipt={ov.observationReceipt} reports={ov.reports} state={ov.state} side={assignedSide} selectedTile={selectedTile} refresh={refresh} authority={authority} />
        </div>
        <div className="desk-section" hidden={desk !== 'staff'}>
          <StaffPanel ov={ov} side={assignedSide} refresh={refresh} canInjectReport={canInjectReport} canCreateTask={!frozen && active?.status === 'running'} onFocusEvidence={focusEvidence} />
        </div>
        <div className="desk-section" hidden={desk !== 'mission'}>
          {active?.options?.scenario?.id === 'taiwan-strait/1' && <StraitBriefPanel role={role} modelEnabled={active.agentEnabled === true} humanSide={active.humanSide} />}
          <ObjectivesPanel ov={ov} active={active} lineage={lineage} assignedSide={assignedSide} authority={authority} refresh={refresh} navigate={navigate} />
          <RoleContextPanel key={`${ov.activeId}:${ov.identity.role}`} pack={ov.organizationContext ?? null} />
          <NetworkPanel view={ov.campaign} onSelect={setSelectedTile} />
        </div>
        <div className="desk-section" hidden={desk !== 'forces'}><ResourcesPanel ov={ov} state={ov.state} active={active} assignedSide={assignedSide} refresh={refresh} canControlAgent={canControlAgent} /></div>
        <div className="desk-section" hidden={desk !== 'team'}><TeamAssessmentPanel ctx={ctx} /></div>
      </aside>
    </div>
  </>;
}
