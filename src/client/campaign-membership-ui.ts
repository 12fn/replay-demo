/**
 * Shared campaign membership: pure projections for the panel plus a small framework-free controller for
 * the membership actions (invite, join, leave, remove, lift, limit). The campaign executor
 * (campaign-executor.ts) keeps owning selection, polling and follow; this module never calls `/api/select`
 * and never navigates. Nothing here decides authorization: every capability flag is a display hint taken
 * from the server's own answer (`membership.viewer.canManage`, native `canShare`), and the server re-checks
 * each request against the caller's fresh identity.
 *
 * Invite codes live only in controller memory and are dropped on every campaign change, removal or
 * dismissal. They are never written to storage, the URL or the document title.
 */
import { errorMessage } from './api';
import type {
  CampaignInviteCode,
  CampaignJoinResult,
  CampaignMemberView,
  CampaignMembershipView,
  CampaignMissionMembershipView,
  CampaignMissionPoint,
  CampaignView,
} from './campaign-api';

/* ---------------- pure projections ---------------- */

const TERMINAL = new Set<CampaignView['campaign']['status']>(['completed', 'stopped', 'fault']);

/** What this viewer may plausibly do, as the server described it. Display only; the server decides. */
export interface ViewerCapabilities {
  /** Membership block present in the view (servers that predate shared enrollment omit it). */
  shared: boolean;
  role: 'owner' | 'participant';
  /** Server's owner decision for this viewer. Progression and roster controls are shown only when true. */
  canManage: boolean;
  /** Progression controls (pause/resume/stop) may be offered. Legacy views without membership keep the owner-only behaviour. */
  canProgress: boolean;
  /** The viewer is a participant who may leave. Owners cannot withdraw. */
  canLeave: boolean;
  /** Invite/limit/remove make sense: owner and the campaign still accepts participants. */
  canAdmit: boolean;
  /** The viewer's own standing is no longer active (stale view after leaving or removal). */
  viewerInactive: boolean;
  terminal: boolean;
}

export function viewerCapabilities(view: CampaignView | null): ViewerCapabilities {
  const none: ViewerCapabilities = { shared: false, role: 'owner', canManage: false, canProgress: false, canLeave: false, canAdmit: false, viewerInactive: false, terminal: false };
  if (!view) return none;
  const terminal = TERMINAL.has(view.campaign.status);
  const m = view.membership;
  // No membership block: an owner-only server. Keep the previous behaviour (the list only ever held owned campaigns).
  if (!m) return { ...none, canManage: true, canProgress: !terminal, terminal };
  const canManage = m.viewer.canManage === true;
  const viewerInactive = m.viewer.status !== 'active';
  return {
    shared: true,
    role: m.viewer.role,
    canManage,
    canProgress: canManage && !terminal,
    canLeave: !canManage && m.viewer.role === 'participant' && !viewerInactive,
    canAdmit: canManage && !terminal,
    viewerInactive,
    terminal,
  };
}

/** "mission 2 · tick 340". Mission numbers are one-based for people; the server's index is zero-based. */
export function pointLabel(p: CampaignMissionPoint | null | undefined): string {
  if (!p) return '';
  return p.tick <= 1 ? `mission ${p.missionIndex + 1} start` : `mission ${p.missionIndex + 1} · tick ${p.tick}`;
}

export type MemberStanding = 'owner' | 'active' | 'rejoin-required' | 'withdrawn' | 'revoked';

export interface MemberRow {
  subject: string;
  name: string;
  organization: string;
  isViewer: boolean;
  standing: MemberStanding;
  /** Short tag text for the row, or null for an ordinary active participant. */
  tag: string | null;
  /** Plain-language term text: when the membership started and, if ended, when. */
  term: string;
  /** Owner may remove this member now. */
  canRevoke: boolean;
  /** Owner may lift this member's removal. */
  canReinstate: boolean;
}

const STANDING_ORDER: Record<MemberStanding, number> = { owner: 0, active: 1, 'rejoin-required': 2, withdrawn: 3, revoked: 4 };

function standingOf(m: CampaignMemberView): MemberStanding {
  if (m.role === 'owner') return 'owner';
  if (m.status === 'active') return 'active';
  if (m.status === 'revoked') return 'revoked';
  return m.rejoinRequired ? 'rejoin-required' : 'withdrawn';
}

const STANDING_TAG: Record<MemberStanding, string | null> = {
  owner: 'owner',
  active: null,
  'rejoin-required': 'removal lifted · must rejoin',
  withdrawn: 'left',
  revoked: 'removed',
};

/** Roster rows: owner first, then active members, then those who left or were removed. Stable within a group. */
export function memberRows(m: CampaignMembershipView | undefined, canManage: boolean): MemberRow[] {
  if (!m) return [];
  const rows = m.members.map((x): MemberRow => {
    const standing = standingOf(x);
    const since = x.since ? `since ${pointLabel(x.since)}` : 'term not recorded';
    const until = x.until ? ` · until ${pointLabel(x.until)}` : '';
    return {
      subject: x.subject,
      name: x.name,
      organization: x.organization,
      isViewer: x.subject === m.viewer.subject,
      standing,
      tag: STANDING_TAG[standing],
      term: standing === 'owner' ? 'campaign owner' : `${since}${until}`,
      canRevoke: canManage && standing === 'active',
      canReinstate: canManage && standing === 'revoked',
    };
  });
  return rows.map((r, i) => [r, i] as const).sort((a, b) => STANDING_ORDER[a[0].standing] - STANDING_ORDER[b[0].standing] || a[1] - b[1]).map(([r]) => r);
}

export interface MissionMembershipRow {
  exerciseId: string;
  /** One-based. */
  number: number;
  /** Names of carried participants (owner excluded), resolved through the roster; subjects when unknown. */
  carried: string[];
  excluded: { name: string; outcome: 'denied' | 'unavailable'; detail: string | null }[];
  /** No membership record: the mission predates shared enrollment; only the owner was seated. */
  legacy: boolean;
  detached: boolean;
  /** Short line for the row, e.g. "2 carried · 1 not seated". */
  summary: string;
}

/** Per-mission carry record, resolved to names. Nothing is invented for unrecorded missions. */
export function missionMembershipRows(m: CampaignMembershipView | undefined): MissionMembershipRow[] {
  if (!m) return [];
  const nameOf = (subject: string) => m.members.find((x) => x.subject === subject)?.name ?? subject;
  const owner = m.members.find((x) => x.role === 'owner')?.subject ?? null;
  return m.missions.map((x: CampaignMissionMembershipView): MissionMembershipRow => {
    const carried = (x.carried ?? []).filter((s) => s !== owner).map(nameOf);
    const excluded = (x.excluded ?? []).map((e) => ({ name: nameOf(e.subject), outcome: e.outcome, detail: e.detail }));
    const legacy = !x.recorded;
    const parts: string[] = [];
    if (legacy) parts.push('no membership record');
    else {
      parts.push(carried.length === 0 ? 'owner only' : `${carried.length} carried`);
      if (excluded.length) parts.push(`${excluded.length} not seated`);
    }
    if (x.detached) parts.push('continues after the campaign ended');
    return { exerciseId: x.exerciseId, number: x.missionIndex + 1, carried, excluded, legacy, detached: x.detached, summary: parts.join(' · ') };
  });
}

/** "2 of 15 participant seats" / "no participant seats (owner only)". */
export function seatSummary(m: CampaignMembershipView | undefined): string {
  if (!m) return '';
  if (m.maxParticipants === 0) return 'no participant seats (owner only)';
  return `${m.activeParticipants} of ${m.maxParticipants} participant seat${m.maxParticipants === 1 ? '' : 's'} in use`;
}

/** Why the excluded outcome happened, in plain language that does not overstate what the server knows. */
export function exclusionText(outcome: 'denied' | 'unavailable'): string {
  return outcome === 'denied'
    ? 'their fresh workroom check was refused when the mission opened'
    : 'their fresh workroom check could not be completed when the mission opened';
}

/**
 * Two views of the same campaign may reach the panel: the executor's polled view and the response of a
 * membership action. Prefer whichever carries the newer membership version; equal versions prefer the
 * polled view (it is the executor's truth for everything else). Different campaigns never mix.
 */
export function preferNewerMembership(polled: CampaignView | null, fromAction: CampaignView | null): CampaignView | null {
  if (!fromAction) return polled;
  if (!polled) return fromAction;
  if (polled.campaign.id !== fromAction.campaign.id) return polled;
  const a = polled.membership?.version ?? -1;
  const b = fromAction.membership?.version ?? -1;
  return b > a ? fromAction : polled;
}

/**
 * After a join the server has already selected the running mission into this session. Binding the executor
 * before the tab's overview reflects that would make its first poll issue a conditional `/api/select` with
 * a stale navigation revision (refused as 409 and shown as an error). So the bind waits until the overview
 * reports the joined mission, or happens at once when no mission is running.
 */
export function joinBindDecision(result: Pick<CampaignJoinResult, 'campaignId' | 'activeExerciseId'>, viewingExerciseId: string | null): 'bind-now' | 'wait-for-selection' {
  return result.activeExerciseId === null || result.activeExerciseId === viewingExerciseId ? 'bind-now' : 'wait-for-selection';
}

/** The executor seam main may implement (`CampaignController.join`). Detected structurally; nothing is assumed about its internals. */
export interface CampaignJoinSeam {
  join: (code: string) => Promise<void>;
}
export function joinSeamOf(c: unknown): CampaignJoinSeam | null {
  const j = (c as { join?: unknown } | null)?.join;
  return typeof j === 'function' ? { join: j as CampaignJoinSeam['join'] } : null;
}

/* ---------------- controller ---------------- */

export interface MembershipPorts {
  issueCode(campaignId: string): Promise<CampaignInviteCode>;
  withdraw(campaignId: string): Promise<unknown>;
  setLimit(campaignId: string, maxParticipants: number): Promise<CampaignView>;
  revoke(campaignId: string, subject: string): Promise<CampaignView>;
  reinstate(campaignId: string, subject: string): Promise<CampaignView>;
  join(code: string): Promise<CampaignJoinResult>;
  /** Bind the executor to a campaign the viewer just joined (existing `CampaignController.selectCampaign`). */
  bindCampaign(campaignId: string): void;
  /** Drop the executor's binding after the viewer left (existing `CampaignController.clearCampaign`). */
  clearCampaign(): void;
  /** Re-read the overview so the session's new selection shows. Optional: without it the overview poll catches up. */
  refresh?(): Promise<void>;
  /** Reload the campaign list (existing `CampaignController.reloadList`). */
  reloadList?(): void;
}

export type MembershipAction = 'code' | 'withdraw' | 'limit' | `revoke:${string}` | `reinstate:${string}` | 'join';

export interface MembershipSnapshot {
  /** Campaign the controller is bound to; mirrors the executor's `campaignId`. */
  campaignId: string | null;
  busy: MembershipAction | null;
  error: string | null;
  /** One-line confirmation of the last completed action. */
  notice: string | null;
  /** Invite shown once. Memory only. */
  invite: CampaignInviteCode | null;
  /** Newest view returned by an action, for the panel to merge with the executor's polled view. */
  actionView: CampaignView | null;
  /** A join completed; the executor is bound once the overview shows the joined mission. */
  pendingBind: { campaignId: string; exerciseId: string | null } | null;
}

export interface MembershipController {
  getSnapshot(): MembershipSnapshot;
  subscribe(listener: () => void): () => void;
  /** Follow the executor's bound campaign. Any change clears invite, errors, notices and action views. */
  bind(campaignId: string | null): void;
  /** Feed the tab's current selection so a pending join bind can complete. */
  observeSelection(viewingExerciseId: string | null): void;
  issueCode(): Promise<void>;
  dismissInvite(): void;
  withdraw(): Promise<void>;
  setLimit(maxParticipants: number): Promise<void>;
  revoke(subject: string): Promise<void>;
  reinstate(subject: string): Promise<void>;
  join(code: string): Promise<void>;
  clearMessages(): void;
  /** Re-arms after `dispose` (React StrictMode replays mount effects). In-flight answers from before stay dropped. */
  activate(): void;
  dispose(): void;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

export function createMembershipController(ports: MembershipPorts): MembershipController {
  let snap: MembershipSnapshot = { campaignId: null, busy: null, error: null, notice: null, invite: null, actionView: null, pendingBind: null };
  const listeners = new Set<() => void>();
  const patch = (p: Partial<MembershipSnapshot>) => {
    snap = { ...snap, ...p };
    for (const l of listeners) l();
  };
  /** Bumped by every bind so a response for an earlier campaign (or an earlier binding of the same id) is dropped. */
  let bindGen = 0;
  let actionSeq = 0;
  let disposed = false;

  const bind = (campaignId: string | null) => {
    if (campaignId === snap.campaignId) return;
    bindGen += 1;
    actionSeq += 1;
    patch({ campaignId, busy: null, error: null, notice: null, invite: null, actionView: null, pendingBind: snap.pendingBind?.campaignId === campaignId ? null : snap.pendingBind });
  };

  /**
   * Runs one scoped action. The result is applied only when the controller is still bound to the same
   * campaign in the same binding generation and no later action has started; otherwise it is dropped.
   */
  const run = async <T>(label: MembershipAction, fn: (campaignId: string) => Promise<T>, apply: (r: T) => Partial<MembershipSnapshot>) => {
    const cid = snap.campaignId;
    if (!cid || disposed) return;
    const g = bindGen;
    const seq = ++actionSeq;
    const live = () => !disposed && g === bindGen && snap.campaignId === cid;
    patch({ busy: label, error: null, notice: null });
    try {
      const r = await fn(cid);
      if (!live() || seq !== actionSeq) return;
      patch(apply(r));
    } catch (e) {
      if (isAbort(e) || !live() || seq !== actionSeq) return;
      patch({ error: errorMessage(e) });
    } finally {
      if (live() && seq === actionSeq) patch({ busy: null });
    }
  };

  const issueCode = () => run('code', (id) => ports.issueCode(id), (invite) => ({ invite, notice: null }));

  const withdraw = () =>
    run(
      'withdraw',
      async (id) => {
        await ports.withdraw(id);
      },
      () => {
        // The campaign is 404 for this subject from now on; do not let the executor poll into that.
        ports.clearCampaign();
        ports.reloadList?.();
        return { invite: null, actionView: null, notice: 'You left the campaign. Your records on earlier missions stay in Review.' };
      },
    );

  const setLimit = (max: number) => run('limit', (id) => ports.setLimit(id, max), (view) => ({ actionView: view, notice: `Participant limit set to ${view.membership?.maxParticipants ?? max}.` }));

  const revoke = (subject: string) =>
    run(`revoke:${subject}`, (id) => ports.revoke(id, subject), (view) => ({
      actionView: view,
      invite: null,
      notice: 'Participant removed. The invite code was rotated; create a new one if others still need to join.',
    }));

  const reinstate = (subject: string) =>
    run(`reinstate:${subject}`, (id) => ports.reinstate(id, subject), (view) => ({
      actionView: view,
      notice: 'Removal lifted. They rejoin with a current invite code and their own sign-in; nobody is seated on their behalf.',
    }));

  /**
   * Join is not scoped to a bound campaign: it may run while no campaign is shown. It is scoped to the
   * binding generation so a late answer after the user opened another campaign (or the scope reset the
   * executor) is not acted on.
   */
  const join = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || disposed) return;
    const g = bindGen;
    const seq = ++actionSeq;
    const live = () => !disposed && g === bindGen && seq === actionSeq;
    patch({ busy: 'join', error: null, notice: null });
    try {
      const r = await ports.join(code);
      if (!live()) return;
      const name = r.view?.campaign?.name ?? 'the campaign';
      patch({
        notice: r.joined ? `Joined ${name}.${r.activeExerciseId ? ' Your session now shows its running mission.' : ' The next mission will seat you when it opens.'}` : `You were already a member of ${name}; your seat was restored.`,
        pendingBind: { campaignId: r.campaignId, exerciseId: r.activeExerciseId },
      });
      ports.reloadList?.();
      if (ports.refresh) await ports.refresh().catch(() => {});
      if (!live()) return;
      if (r.activeExerciseId === null) completeBind(r.campaignId);
    } catch (e) {
      if (isAbort(e) || !live()) return;
      patch({ error: errorMessage(e) });
    } finally {
      if (live()) patch({ busy: null });
    }
  };

  const completeBind = (campaignId: string) => {
    patch({ pendingBind: null });
    ports.bindCampaign(campaignId);
  };

  const observeSelection = (viewingExerciseId: string | null) => {
    const p = snap.pendingBind;
    if (!p || disposed) return;
    if (joinBindDecision({ campaignId: p.campaignId, activeExerciseId: p.exerciseId }, viewingExerciseId) === 'bind-now') completeBind(p.campaignId);
  };

  return {
    getSnapshot: () => snap,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    bind,
    observeSelection,
    issueCode,
    dismissInvite: () => patch({ invite: null }),
    withdraw,
    setLimit,
    revoke,
    reinstate,
    join,
    clearMessages: () => patch({ error: null, notice: null }),
    activate: () => {
      disposed = false;
    },
    dispose: () => {
      disposed = true;
      bindGen += 1;
      actionSeq += 1;
      listeners.clear();
      snap = { ...snap, invite: null, busy: null, pendingBind: null };
    },
  };
}
