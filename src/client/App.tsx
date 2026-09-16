import {ShowcaseView} from './views/ShowcaseView';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ExerciseSummary, Overview, Side } from './api';
import { Header, type View } from './components/Header';
import { NativeSignIn } from './components/NativeSignIn';
import { ExerciseView } from './views/ExerciseView';
import { PlatformView } from './views/PlatformView';
import {CatalogView} from './views/CatalogView';
import { PracticeView } from './views/PracticeView';
import { ReviewView } from './views/ReviewView';
import { commandAuthority, type CommandAuthority } from './lib';
import { nativeApi, nativeOf, type NativeStatus } from './native-api';
import { isCatalogReviewHash } from './catalog-review-link';
import { useOverview } from './useOverview';
import {useReviewNavigation} from './review-navigation';
import { campaignIdOfExercise, campaignScopeKey, useCampaign } from './useCampaign';
import { CampaignControl } from './components/CampaignControl';
import './native.css';

export interface ViewContext {
  ov: Overview;
  refresh: () => Promise<void>;
  /** Active exercise summary, if the backend knows it. */
  active: ExerciseSummary | undefined;
  /**
   * Side this session is assigned to in the active exercise. Comes from the backend
   * (overview.selectedSide / exercise.humanSide) and cannot be changed in the client.
   */
  assignedSide: Side;
  /** Whether and why this session may issue orders right now. */
  authority: CommandAuthority;
  /** Side whose information is displayed in Review. Viewing only; never affects command authority. */
  perspective: Side;
  setPerspective: (s: Side) => void;
  selectedTile: number | null;
  setSelectedTile: (t: number | null) => void;
  navigate: (v: View) => void;
  /** Open Review scrolled to an evidence record (event or report id). */
  openEvidence: (id: string, tick?: number) => void;
  /** Evidence id Review should focus once, then clear. */
  pendingEvidence: {id: string; tick?: number} | null;
  clearPendingEvidence: () => void;
}

export function App() {
  const feed = useOverview();
  // A catalog review link (valid or not) opens Platform, which reports what it could open. Nothing else is selected from the URL.
  const [view, setView] = useState<View>(() => (isCatalogReviewHash(window.location.hash) ? 'platform' : 'showcase'));
  useEffect(() => {
    const onHash = () => { if (isCatalogReviewHash(window.location.hash)) setView('platform'); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useLayoutEffect(() => { document.getElementById('main')?.scrollTo({ top: 0, behavior: 'instant' }); }, [view]);
  // Leaving Platform drops only our review fragment, so a reload does not jump back to it. Other hashes and the path are untouched.
  useEffect(() => {
    if (view !== 'platform' && isCatalogReviewHash(window.location.hash)) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, [view]);
  const [perspective, setPerspectiveState] = useState<Side | null>(null);
  const [selectedTile, setSelectedTile] = useState<number | null>(null);
  const [pendingEvidence, setPendingEvidence] = useState<{id: string; tick?: number} | null>(null);
  const [nativeStatus, setNativeStatus] = useState<NativeStatus | null>(null);

  // Native session status is read from the backend; the client never decides identity or mode.
  const loadNative = useCallback(async () => {
    try {
      setNativeStatus(await nativeApi.status());
    } catch {
      /* backend unreachable: the overview feed reports it */
    }
  }, []);
  useEffect(() => {
    void loadNative();
  }, [loadNative]);
  // Re-read the native status whenever the overview refusal changes, so the gate shows the current denial.
  const deniedKey = feed.denied ? `${feed.denied.status}:${feed.denied.message}` : '';
  useEffect(() => {
    if (deniedKey) void loadNative();
  }, [deniedKey, loadNative]);

  const onAuthChange = useCallback(async () => {
    await loadNative();
    await feed.refresh();
  }, [loadNative, feed.refresh]);

  const ov = feed.data;
  const activeId = ov?.activeId ?? '';
  const active = ov?.exercises.find((e) => e.id === activeId);
  // These panel names survive a temporary native gate; all protected views still unmount.
  const reviewNavigation = useReviewNavigation(feed.denied ? undefined : ov);
  const onSignOut = useCallback(async () => {
    reviewNavigation.reset();
    await onAuthChange();
  }, [reviewNavigation.reset, onAuthChange]);
  useEffect(() => { document.title = active?.name && !feed.denied ? `REPLAY — ${active.name}` : 'REPLAY'; }, [active?.name, deniedKey]);

  // The backend decides which side this session controls. exercise.humanSide is the same value
  // when the exercise summary is present; selectedSide is what the session reports.
  const assignedSide: Side = active?.humanSide ?? ov?.selectedSide ?? 'blue';

  // Review perspective is a local, viewing-only choice. It resets to the assigned side whenever
  // the active exercise changes (branch created, exercise selected, reload).
  useEffect(() => {
    setPerspectiveState(null);
    setPendingEvidence(null);
  }, [activeId]);
  const effectivePerspective: Side = perspective ?? assignedSide;
  const setPerspective = useCallback((s: Side) => setPerspectiveState(s), []);

  // Clear tile selection when the exercise changes or the map dimensions change.
  const mapKey = ov ? `${activeId}:${ov.state?.width}x${ov.state?.height}` : '';
  useEffect(() => {
    setSelectedTile(null);
  }, [mapKey]);

  const authority = useMemo<CommandAuthority>(
    () => {
      const native=nativeOf(ov??undefined);
      if(native&&!native.context.canEdit)return {allowed:false,reason:native.context.readOnlyReason??'This workroom currently provides read-only access.'};
      return commandAuthority({ role: ov?.identity.role ?? 'intelligence', playbackTick: ov?.playbackTick ?? null, exercise: active });
    },
    [ov?.identity.role, ov?.playbackTick, ov?.platform, active],
  );

  const openEvidence = useCallback((id: string, tick?: number) => {
    setPendingEvidence({id, tick});
    setView('review');
  }, []);
  const clearPendingEvidence = useCallback(() => setPendingEvidence(null), []);

  // Optional practice campaign. Only active while the backend serves this session a normal overview;
  // identity/workroom/refusal changes clear it. Nothing is created or selected without a user action.
  const campaignEnabled = !!ov && !feed.denied;
  const campaign = useCampaign({ ov, enabled: campaignEnabled, view, refresh: feed.refresh, setSelectedTile, navigate: setView });

  const ctx = useMemo<ViewContext | null>(
    () =>
      ov
        ? {
            ov,
            refresh: feed.refresh,
            active,
            assignedSide,
            authority,
            perspective: effectivePerspective,
            setPerspective,
            selectedTile,
            setSelectedTile,
            navigate: setView,
            openEvidence,
            pendingEvidence,
            clearPendingEvidence,
          }
        : null,
    [ov, feed.refresh, active, assignedSide, authority, effectivePerspective, setPerspective, selectedTile, openEvidence, pendingEvidence, clearPendingEvidence],
  );

  // Native mode gate: the backend refused the overview for this session (not signed in, blocked, read-only with
  // nothing to show, or platform unavailable). Shown even when an older snapshot exists, e.g. after session expiry.
  if (nativeStatus?.mode === 'kamiwaza' && feed.denied) {
    return <NativeSignIn status={nativeStatus} onChange={onAuthChange} onSignedOut={reviewNavigation.reset} denied={feed.denied} />;
  }

  if (!ov || !ctx) {
    return (
      <div className="app-boot" role="status" aria-live="polite">
        <div className="boot-card">
          <div className="boot-title">REPLAY</div>
          {feed.status === 'offline' ? (
            <>
              <p className="boot-msg">
                <AlertTriangle size={16} aria-hidden="true" /> {feed.denied ? 'Exercise service refused this session.' : 'Backend unavailable.'}
              </p>
              <p className="boot-detail">{feed.denied?.message ?? feed.error}</p>
              <p className="boot-detail">Retrying at <code>/api/overview</code>.</p>
              <button type="button" className="btn" onClick={() => void feed.refresh()}>
                <RefreshCw size={14} aria-hidden="true" /> Retry now
              </button>
            </>
          ) : (
            <p className="boot-msg">Connecting to the exercise service…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`app view-${view}`}>
      <Header
        ov={ov}
        view={view}
        onNavigate={setView}
        connection={feed.status}
        connectionError={feed.error}
        lastUpdated={feed.lastUpdated}
        refresh={feed.refresh}
        activeExercise={active}
        assignedSide={assignedSide}
        native={nativeOf(ov)}
        onSignOut={onSignOut}
      />
      <main className="app-main" id="main" tabIndex={-1}>
        {view === 'showcase' && <ShowcaseView ctx={ctx}/>}
        {view === 'exercise' && <ExerciseView key={activeId} ctx={ctx} />}
        {view === 'review' && <ReviewView key={activeId} ctx={ctx} navigation={reviewNavigation.selection} onModeChange={reviewNavigation.setMode} onTabChange={reviewNavigation.setTab} />}
        {view === 'practice' && <PracticeView key={JSON.stringify([ov.identity.mode, ov.identity.subject, nativeOf(ov)?.workroomId ?? null, ov.identity.role])} ctx={ctx} />}
        {view === 'catalog' && <CatalogView key={JSON.stringify([ov.identity.subject,ov.identity.role])} ctx={ctx} />}
        {view === 'platform' && <PlatformView ctx={ctx} />}
        {campaignEnabled && view !== 'platform' && view !== 'catalog' && view !== 'showcase' && (
          <details className="campaign-disclosure"><summary>Practice campaign</summary><CampaignControl key={campaignScopeKey(ov)} canShare={nativeOf(ov)?.context.canShare ?? null} refresh={feed.refresh} c={campaign} frozen={ov.playbackTick !== null} viewingExerciseId={activeId || null} viewingCampaignId={campaignIdOfExercise(active)} /></details>
        )}
      </main>
    </div>
  );
}
