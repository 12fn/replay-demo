import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Repeat } from 'lucide-react';
import { CampaignPanel } from './CampaignPanel';
import { CampaignMembershipPanel } from './CampaignMembershipPanel';
import { campaignApi } from '../campaign-api';
import { createMembershipController, joinSeamOf, preferNewerMembership, viewerCapabilities, type MembershipController, type MembershipPorts } from '../campaign-membership-ui';
import { campaignStatusLabel, campaignSummary, sortCampaignsForRecovery, type CampaignController } from '../useCampaign';

/**
 * Compact, collapsed-by-default wrapper around CampaignPanel. Sits above the exercise content so live
 * play is not crowded; expands on its own only when a fresh mission is waiting for the user's decision.
 * Scope: the list shows campaigns this session's subject owns or has joined in this workroom and nothing
 * else. Nothing here is selected or created automatically.
 *
 * Membership (invite/join/leave/remove/limit) is driven by a separate controller bound to the executor's
 * campaign id; selection, polling and follow stay with the executor. A join is handed to the executor's own
 * `join` when main provides one (see docs/process/shared-campaign-ui-notes.md); until then the controller
 * calls the route and binds the executor through `selectCampaign` once this tab shows the joined mission.
 */
export function CampaignControl({
  c,
  frozen,
  viewingExerciseId,
  viewingCampaignId,
  canShare,
  refresh,
}: {
  c: CampaignController;
  frozen: boolean;
  viewingExerciseId: string | null;
  viewingCampaignId: string | null;
  /** Native sharing permission from the overview, when main supplies it; unknown otherwise. */
  canShare?: boolean | null;
  /** Overview re-read after a join, when main supplies it; the overview poll catches up otherwise. */
  refresh?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const selectId = useId();
  const held = c.follow.heldTransition;
  useEffect(() => {
    if (held) setOpen(true);
  }, [held]);

  // The controller is created once; its ports read the latest executor controller and refresh callback.
  const latest = useRef({ c, refresh });
  latest.current = { c, refresh };
  const ctrl = useMemo<MembershipController>(() => {
    const ports: MembershipPorts = {
      issueCode: (id) => campaignApi.issueCode(id),
      withdraw: (id) => campaignApi.withdraw(id),
      setLimit: (id, n) => campaignApi.setLimit(id, n),
      revoke: (id, s) => campaignApi.revoke(id, s),
      reinstate: (id, s) => campaignApi.reinstate(id, s),
      join: (code) => campaignApi.join(code),
      bindCampaign: (id) => latest.current.c.selectCampaign(id),
      clearCampaign: () => latest.current.c.clearCampaign(),
      reloadList: () => latest.current.c.reloadList(),
      refresh: () => latest.current.refresh?.() ?? Promise.resolve(),
    };
    return createMembershipController(ports);
  }, []);
  useEffect(() => {
    ctrl.activate();
    return () => ctrl.dispose();
  }, [ctrl]);
  useEffect(() => {
    ctrl.bind(c.campaignId);
  }, [ctrl, c.campaignId]);
  useEffect(() => {
    ctrl.observeSelection(viewingExerciseId);
  }, [ctrl, viewingExerciseId]);
  const m = useSyncExternalStore(ctrl.subscribe, ctrl.getSnapshot, ctrl.getSnapshot);

  // The executor's polled view is the truth; an action response is used only while its membership is newer.
  const view = preferNewerMembership(c.view, m.actionView);
  const caps = viewerCapabilities(view);
  const joinSeam = joinSeamOf(c);
  const onJoin = (code: string) => (joinSeam ? joinSeam.join(code) : ctrl.join(code));

  const summary = campaignSummary(view, { following: c.follow.following, held: !!held });
  const recover = sortCampaignsForRecovery(c.list);
  const viewingItem = viewingCampaignId && viewingCampaignId !== c.campaignId ? c.list.find((i) => i.id === viewingCampaignId) ?? null : null;

  return (
    <details className="campaign-control" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="campaign-control-summary">
        <Repeat size={13} aria-hidden="true" />
        <span>{summary}</span>
        {caps.shared && caps.role === 'participant' && <span className="tag tag-muted">joined</span>}
        {held && <span className="tag tag-warn">new mission waiting</span>}
        {!c.campaignId && (c.error || m.error) && <span className="tag tag-warn">campaign notice</span>}
      </summary>
      <div className="campaign-control-body">
        {!c.campaignId && (recover.length > 0 || c.listError) && (
          <div className="campaign-recover">
            <label htmlFor={selectId}>Your campaigns in this workroom</label>
            {recover.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <select id={selectId} className="select" value={pick} onChange={(e) => setPick(e.target.value)} disabled={c.busy}>
                  <option value="">Choose a campaign…</option>
                  {recover.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · {campaignStatusLabel(i.status)} · {i.missionCount} mission{i.missionCount === 1 ? '' : 's'}{i.role === 'participant' ? ' · joined' : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-sm btn-primary" disabled={!pick || c.busy} onClick={() => c.selectCampaign(pick)}>
                  Open
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={c.reloadList} title="Re-read the list of your campaigns">
                  Refresh list
                </button>
              </div>
            )}
            {c.listError && <p className="inline-error" role="alert">Could not read your campaigns: {c.listError}</p>}
            {viewingItem && (
              <p style={{ margin: 0 }}>
                The exercise you are viewing belongs to <strong>{viewingItem.name}</strong>.{' '}
                <button type="button" className="link" onClick={() => c.selectCampaign(viewingItem.id)}>Open that campaign</button>
              </p>
            )}
          </div>
        )}
        <CampaignPanel
          view={view}
          busy={c.busy}
          error={c.error}
          readOnly={c.readOnly}
          readOnlyReason={c.readOnlyReason}
          following={c.follow.following}
          frozen={frozen}
          heldTransition={held}
          lastTransition={c.lastTransition}
          viewingExerciseId={viewingExerciseId}
          canManage={caps.canManage}
          onStart={c.start}
          onResume={c.resume}
          onPause={c.pause}
          onStop={c.stop}
          onFollowChange={c.setFollowing}
          onAcceptTransition={c.acceptTransition}
          onDismissTransition={c.dismissTransition}
          onOpenMission={c.openMission}
        />
        <CampaignMembershipPanel
          view={view}
          m={m}
          readOnly={c.readOnly}
          readOnlyReason={c.readOnlyReason}
          canShare={canShare}
          executorBusy={c.busy}
          onJoin={onJoin}
          onIssueCode={ctrl.issueCode}
          onDismissInvite={ctrl.dismissInvite}
          onWithdraw={ctrl.withdraw}
          onSetLimit={ctrl.setLimit}
          onRevoke={ctrl.revoke}
          onReinstate={ctrl.reinstate}
          onClearMessages={ctrl.clearMessages}
        />
        {c.campaignId && (
          <div>
            <button type="button" className="btn btn-sm btn-ghost" onClick={c.clearCampaign} title="Stop showing this campaign in this tab. The campaign itself is not changed.">
              Close campaign view
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
