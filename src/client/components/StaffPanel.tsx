import {requestAllowance} from '../budget-presentation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bot, FileText, ListChecks, MessageSquare, Send, Siren, Wrench, X } from 'lucide-react';
import { api, errorMessage, type Overview, type Report, type Side, type StaffReply } from '../api';
import { agentApi, type ToolCatalog, type WatchTask } from '../agent-api';
import { sideLabel, tickClock, truncate } from '../lib';
import { Busy, Empty, InlineError, Panel } from './ui';
import '../agent.css';
import {isWatchRequest} from '../../agents/watch-request';
import {EvidenceRelations} from './EvidenceRelations';
import {StaffDecisionAid} from './StaffDecisionAid';

interface Props {
  ov: Overview;
  /** Side whose staff records are shown and addressed. */
  side: Side;
  refresh: () => Promise<void>;
  canInjectReport: boolean;
  /** Watches can only be created against a running exercise at the live tick. */
  canCreateTask: boolean;
  onFocusEvidence?: (id: string) => void;
}

interface Exchange {
  id: number;
  question: string;
  reply?: StaffReply;
  error?: string;
}

type Tab = 'reports' | 'watches' | 'chat';

export function StaffPanel({ ov, side, refresh, canInjectReport, canCreateTask, onFocusEvidence }: Props) {
  const [tab, setTab] = useState<Tab>('reports');
  const [message, setMessage] = useState('');
  const [asking, setAsking] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskBusy, setTaskBusy] = useState<string | null>(null);
  const [taskErr, setTaskErr] = useState<string | null>(null);
  const [injectBusy, setInjectBusy] = useState(false);
  const [injectErr, setInjectErr] = useState<string | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState<string | null>(null);

  // The tool catalog is auth-scoped by the backend; fetch it per side and never assume tools exist.
  useEffect(() => {
    const ac = new AbortController();
    setCatalog(null);
    setCatalogErr(null);
    agentApi.tools(side, ac.signal).then(setCatalog, (err) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setCatalogErr(errorMessage(err));
    });
    return () => ac.abort();
  }, [side, ov.activeId]);

  const reports = useMemo(() => ov.reports.filter((r) => r.side === side).slice().sort((a, b) => b.tick - a.tick), [ov.reports, side]);
  const supersededIds = useMemo(() => new Set([...reports.map((r) => r.supersedes),...reports.filter(r=>r.evidenceStatus==='superseded').map(r=>r.id)].filter((x): x is string => !!x)), [reports]);
  const currentReports = reports.filter((r) => !supersededIds.has(r.id));
  const visibleReports = showSuperseded ? reports : currentReports;
  const tasks = (ov.tasks as WatchTask[]).filter((t) => t.side === side);
  // Exercise state is already supplied by the parent. Never infer it from permissions or task ticks.
  const exercise = ov.exercises.find((e) => e.id === ov.activeId);
  const exerciseInactive = exercise?.kind === 'recorded' || exercise?.status === 'completed' || exercise?.status === 'fault';
  const historicalView = ov.playbackTick !== null;
  const openTasks = tasks.filter((t) => !['cancelled', 'completed', 'failed'].includes(t.status)
    && (!t.watchConfig || (!exerciseInactive && !historicalView && t.status !== 'historical')));
  /** Paid analysis is opt-in per watch; the backend still enforces ownership, side and native agent permission. */
  const canRunPaidStaff = canCreateTask;
  const willCreateWatch = isWatchRequest(message);
  const lastQuestion = exchanges.at(-1)?.question;

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = message.trim();
    if (!q || asking) return;
    const id = Date.now();
    setExchanges((x) => [...x, { id, question: q }]);
    setMessage('');
    setAsking(true);
    try {
      const reply = await api.staff(q, side);
      setExchanges((x) => x.map((ex) => (ex.id === id ? { ...ex, reply } : ex)));
      await refresh();
    } catch (err) {
      setExchanges((x) => x.map((ex) => (ex.id === id ? { ...ex, error: errorMessage(err) } : ex)));
    } finally {
      setAsking(false);
    }
  };

  const createTask = async (e: FormEvent) => {
    e.preventDefault();
    const title = taskTitle.trim();
    if (!title || taskBusy) return;
    setTaskBusy('create');
    setTaskErr(null);
    try {
      await api.createTask(title, side);
      setTaskTitle('');
      await refresh();
    } catch (err) {
      setTaskErr(errorMessage(err));
    } finally {
      setTaskBusy(null);
    }
  };

  const cancelTask = async (id: string) => {
    setTaskBusy(id);
    setTaskErr(null);
    try {
      await api.cancelTask(id);
      await refresh();
    } catch (err) {
      setTaskErr(errorMessage(err));
    } finally {
      setTaskBusy(null);
    }
  };

  const setModel = async (id: string, enabled: boolean) => {
    setModelBusy(id);
    setTaskErr(null);
    try {
      await agentApi.setTaskModel(id, enabled);
      await refresh();
    } catch (err) {
      setTaskErr(errorMessage(err));
    } finally {
      setModelBusy(null);
    }
  };

  const inject = async () => {
    setInjectBusy(true);
    setInjectErr(null);
    try {
      await api.injectReport();
      await refresh();
    } catch (err) {
      setInjectErr(errorMessage(err));
    } finally {
      setInjectBusy(false);
    }
  };

  const titleOf = (id: string | undefined) => (id ? reports.find((r) => r.id === id)?.title : undefined);

  const TABS: { id: Tab; label: string; icon: typeof FileText; count: number }[] = [
    { id: 'reports', label: 'Reports', icon: FileText, count: currentReports.length },
    { id: 'watches', label: 'Watches', icon: ListChecks, count: openTasks.length },
    { id: 'chat', label: 'Ask staff', icon: MessageSquare, count: exchanges.length },
  ];

  return (
    <Panel
      title={`Staff · ${sideLabel(side)}`}
      className="staff"
      aside={
        canInjectReport ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={injectBusy} onClick={() => void inject()} title="Facilitator action: release the next scheduled exercise report to both sides">
            <Siren size={13} aria-hidden="true" /> Release report
          </button>
        ) : null
      }
    >
      <InlineError message={injectErr} />
      {ov.sourceDesk&&<details><summary>{ov.sourceDesk.title}</summary><p>{ov.sourceDesk.focus}</p><p className="muted small">{ov.sourceDesk.notice}</p></details>}
      <StaffDecisionAid role={ov.identity.role} catalog={catalog} disabled={asking} onPrepareQuestion={question=>{setMessage(question);setTab('chat');}} />

      <div className="tabs" role="tablist" aria-label="Staff sections">
        {TABS.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`staff-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`staff-panel-${id}`}
            className={`tab${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={13} aria-hidden="true" /> {label}
            {count > 0 && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>

      {tab === 'reports' && (
        <div role="tabpanel" id="staff-panel-reports" aria-labelledby="staff-tab-reports" className="tab-body">
          {reports.length === 0 ? (
            <Empty>No reports released to {sideLabel(side)} yet.</Empty>
          ) : (
            <>
              {supersededIds.size > 0 && (
                <label className="switch small">
                  <input type="checkbox" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />
                  <span>Show superseded reports ({supersededIds.size})</span>
                </label>
              )}
              <ul className="report-list">
                {visibleReports.map((r) => (
                  <ReportCard key={r.id} report={r} references={reports} superseded={supersededIds.has(r.id)} supersedesTitle={titleOf(r.supersedes)} onFocus={onFocusEvidence} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {tab === 'watches' && (
        <div role="tabpanel" id="staff-panel-watches" aria-labelledby="staff-tab-watches" className="tab-body">
          <p className="muted small">
            Free watches track reserve thresholds, objective control, or report changes. Each shows exactly what it is watching.
            Model analysis is optional and off until you enable it for a specific watch.
          </p>
          {tasks.some((t) => t.watchConfig) && (
            <p className="muted small">
              Entries mark a baseline or a change. Quiet checks do not add entries.
              {exerciseInactive && ' This exercise is no longer running; its configured watches are inactive in this view.'}
              {historicalView && ` Historical view at tick ${ov.playbackTick}: only records available at that tick are shown.`}
            </p>
          )}
          <ToolDisclosure catalog={catalog} error={catalogErr} />
          {tasks.length === 0 ? (
            <Empty>No watches for {sideLabel(side)}.</Empty>
          ) : (
            <ul className="task-list">
              {tasks.map((t) => {
                const isModel = t.kind === 'model-staff-agent' || t.modelEnabled === true;
                const terminal = ['cancelled', 'completed', 'failed'].includes(t.status);
                const historical = historicalView || t.status === 'historical';
                const inactive = !!t.watchConfig && exerciseInactive && !terminal;
                const active = !terminal && t.status !== 'historical'
                  && (!t.watchConfig || (!inactive && !historical && canCreateTask));
                const statusLabel = inactive ? 'Inactive · exercise ended'
                  : t.watchConfig && historical ? 'historical'
                  : t.watchConfig && t.status === 'waiting' && exercise?.status === 'running' ? 'Watching for changes'
                  : t.status;
                // Paid results retain their observation provenance; they are not free-watch changes.
                const recordedTick = t.lastObservedTick ?? t.cursor;
                const tickLabel = t.lastMethod === 'model staff agent' ? 'last model observation tick'
                  : t.lastResult ? 'last recorded change tick' : 'recorded baseline tick';
                return (
                  <li key={t.id}>
                    <div className="task-main">
                      <span className="task-title">{t.objective ?? t.title}</span>
                      <span className={`tag tag-status-${inactive ? 'completed' : t.status}`}
                        title={t.watchConfig ? `Recorded task status: ${t.status}` : undefined}>{statusLabel}</span>
                    </div>
                    <div className="watch-facts">
                      <span className={`watch-kind ${isModel ? 'watch-kind-model' : 'watch-kind-provenance'}`}>
                        {isModel ? <Bot size={11} aria-hidden="true" /> : <ListChecks size={11} aria-hidden="true" />}
                        {t.status === 'historical' ? 'Historical staff watch' : isModel ? 'Model staff agent' : t.watchConfig ? 'Configured watch · free' : 'Legacy provenance watch · free'}
                      </span>
                      {t.phase && <span>{t.watchConfig ? 'recorded phase' : 'phase'} {t.phase}</span>}
                      <span>owner {t.owner}</span>
                      {t.watchConfig ? (
                        <span>{tickLabel} {recordedTick}</span>
                      ) : (
                        <>
                          {typeof t.lastObservedTick === 'number' && <span>last observed tick {t.lastObservedTick}</span>}
                          {t.lastObservedTick == null && t.cursor > 0 && <span>last checked tick {t.cursor}</span>}
                        </>
                      )}
                      {t.lastReceiptId && (
                        <span>
                          last receipt <span className="mono">{t.lastReceiptId.slice(0, 12)}</span>
                        </span>
                      )}
                    </div>
                    {t.interpretation && <p className="small">{t.interpretation}</p>}
                    {t.lastResult && (
                      <p className="task-result">
                        {t.lastResult}
                        {t.lastMethod && <span className="task-result-method">via {t.lastMethod}</span>}
                      </p>
                    )}
                    {t.sourceIds.length > 0 && (
                      <div className="msg-sources">
                        {t.sourceIds.map((id) => (
                          <button key={id} type="button" className="chip" onClick={() => onFocusEvidence?.(id)} title="Show source report">
                            {truncate(titleOf(id) ?? `record ${id.slice(0, 8)}`, 40)}
                          </button>
                        ))}
                      </div>
                    )}
                    {t.modelResult && t.lastMethod !== 'model staff agent' && (
                      <details className="retained-model-result">
                        <summary>Previous model analysis · tick {t.modelResult.tick}</summary>
                        <p className="muted small">Recorded analysis retained as the free watch updates. It has not been regenerated for later reports.</p>
                        <p className="task-result">{t.modelResult.text}</p>
                        <div className="msg-sources">
                          <button type="button" className="chip" onClick={() => onFocusEvidence?.(t.modelResult!.eventId)}>Show recorded update</button>
                          {t.modelResult.sourceIds.map(id => <button key={id} type="button" className="chip" onClick={() => onFocusEvidence?.(id)}>{truncate(titleOf(id) ?? `record ${id.slice(0,8)}`,40)}</button>)}
                        </div>
                        {t.modelResult.receiptId && <span className="task-result-method">receipt {t.modelResult.receiptId.slice(0,12)}</span>}
                      </details>
                    )}
                    {active && (
                      <div className="watch-actions">
                        {canRunPaidStaff && (
                          <button
                            type="button"
                            className={`btn btn-sm${t.modelEnabled ? ' btn-ghost' : ' btn-primary'}`}
                            disabled={modelBusy !== null || taskBusy !== null}
                            aria-pressed={t.modelEnabled === true}
                            onClick={() => void setModel(t.id, !t.modelEnabled)}
                            title={
                              t.modelEnabled
                                ? 'Stop model analysis; the deterministic watch continues'
                                : 'One bounded model pulse now (up to 2 requests, 4 read-only tool steps), then again only on material changes'
                            }
                          >
                            <Bot size={12} aria-hidden="true" /> {modelBusy === t.id ? 'Updating…' : t.modelEnabled ? 'Disable model analysis' : 'Enable model staff analysis'}
                          </button>
                        )}
                        <button type="button" className="btn btn-ghost btn-sm" disabled={taskBusy !== null || modelBusy !== null} onClick={() => void cancelTask(t.id)}>
                          <X size={12} aria-hidden="true" /> Cancel watch
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canCreateTask ? (
            <>
            <div className="watch-actions" aria-label="Watch examples">
              {[
                ['Reserve below 30%', 'Watch reserves below 30%'],
                ['Objective changes', 'Watch objective changes'],
                ['Report provenance', 'Monitor report provenance'],
              ].map(([label, request]) => (
                <button key={request} type="button" className="btn btn-ghost btn-sm" disabled={taskBusy !== null}
                  onClick={() => setTaskTitle(request)}>{label}</button>
              ))}
            </div>
            <form className="inline-form" onSubmit={(e) => void createTask(e)}>
              <label className="sr-only" htmlFor="task-title">New watch</label>
              <input
                id="task-title"
                className="input"
                placeholder="e.g. Watch reserves below 30%"
                value={taskTitle}
                disabled={taskBusy !== null}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
              <button type="submit" className="btn btn-sm" disabled={taskBusy !== null || !taskTitle.trim()}>
                {taskBusy === 'create' ? 'Adding…' : 'Add watch'}
              </button>
            </form>
            <p className="muted small">Percentages refer to your current force capacity. Choose an example, edit it, then add the watch.</p>
            </>
          ) : (
            <p className="muted small">Watches can be created in a running exercise at the live tick.</p>
          )}
          <InlineError message={taskErr} />
        </div>
      )}

      {tab === 'chat' && (
        <div role="tabpanel" id="staff-panel-chat" aria-labelledby="staff-tab-chat" className="tab-body">
          <div className="chat" aria-live="polite">
            {exchanges.length === 0 && (
              <Empty>
                Answers come from the exercise staff service and may cite only the reports shown to it; an answer citing anything else is rejected rather
                than shown. Each question is one model request.
              </Empty>
            )}
            {exchanges.map((ex) => (
              <div key={ex.id} className="exchange">
                <div className="msg msg-user">{ex.question}</div>
                {ex.reply && (
                  <div className="msg msg-staff">
                    <p>{ex.reply.text}</p>
                    {(ex.reply.sourceIds.length > 0 || ex.reply.taskId) && (
                      <div className="msg-sources">
                        {ex.reply.sourceIds.map((id) => (
                          <button key={id} type="button" className="chip" onClick={() => onFocusEvidence?.(id)} title="Show source report">
                            {truncate(titleOf(id) ?? `record ${id.slice(0, 8)}`, 40)}
                          </button>
                        ))}
                        {ex.reply.taskId && <span className="chip chip-muted">watch created</span>}
                      </div>
                    )}
                  </div>
                )}
                {ex.error && <div className="msg msg-error">Staff request failed: {ex.error}</div>}
                {!ex.reply && !ex.error && <div className="msg msg-staff"><Busy label="Waiting for staff…" /></div>}
              </div>
            ))}
          </div>
          <form className="inline-form" onSubmit={(e) => void ask(e)}>
            <label className="sr-only" htmlFor="staff-message">Message to staff</label>
            <input
              id="staff-message"
              className="input"
              placeholder={`Ask ${sideLabel(side)} staff…`}
              value={message}
              disabled={asking}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={asking || !message.trim()}
              title={willCreateWatch ? 'This request creates a standing watch (no model call)' : 'Sends one model request'}
            >
              <Send size={13} aria-hidden="true" /> {asking ? 'Sending…' : willCreateWatch ? 'Create watch' : 'Send'}
            </button>
          </form>
          {lastQuestion && message.trim() === lastQuestion && !asking && (
            <p className="muted small" role="status">Same question as your last one. Sending again makes another model request.</p>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Small disclosure of what the staff/agent tools can and cannot do, straight from the backend catalog. */
function ToolDisclosure({ catalog, error }: { catalog: ToolCatalog | null; error: string | null }) {
  return (
    <details className="tool-disclosure">
      <summary>
        <Wrench size={12} aria-hidden="true" /> Available staff tools{catalog ? ` (${catalog.staffTools.length})` : ''}
      </summary>
      <div className="tool-body">
        {error && <InlineError message={`Tool catalog unavailable: ${error}`} />}
        {!catalog && !error && <Busy label="Loading tool catalog…" />}
        {catalog && (
          <>
            <ul className="tool-list" aria-label="Read-only tools available to staff watches">
              {catalog.tools
                .filter((t) => catalog.staffTools.includes(t.name))
                .map((t) => (
                  <li key={t.name}>
                    <code>{t.name}</code>
                    <span>{t.description}</span>
                  </li>
                ))}
            </ul>
            <p className="tool-unavailable small">
              Not available: {catalog.unavailable.join(', ')}. Model pulses are capped at {catalog.pulseBudget.maxCompletions} requests and{' '}
              {catalog.pulseBudget.maxSteps} tool steps. Budget used: {catalog.budget.requestsUsed}/{requestAllowance(catalog.budget.maxRequests)} requests.
            </p>
          </>
        )}
      </div>
    </details>
  );
}

function ReportCard({
  report: r,
  references,
  superseded,
  supersedesTitle,
  onFocus,
}: {
  report: Report;
  references:Report[];
  superseded: boolean;
  supersedesTitle: string | undefined;
  onFocus?: (id: string) => void;
}) {
  return (
    <li id={`evidence-${r.id}`} className={`report${superseded ? ' is-superseded' : ''}`}>
      <div className="report-head">
        <button type="button" className="link" onClick={() => onFocus?.(r.id)} title="Show in the record">
          {r.title}
        </button>
        <span className="mono muted">t{r.tick} · {tickClock(r.tick)}</span>
      </div>
      <p>{r.body}</p>
      {r.packet&&<EvidenceRelations packet={r.packet} evidenceStatus={r.evidenceStatus} supersededBy={r.supersededBy} disputedWith={r.disputedWith} references={references} onFocus={onFocus}/>}
      <div className="report-meta">
        <span>Source: {r.source}</span>
        <span>Confidence: {r.confidence}</span>
        {r.synthetic && <span className="tag tag-muted">synthetic exercise report</span>}
        {superseded && <span className="tag tag-warn">superseded</span>}
        {r.supersedes && <span>Replaces: {supersedesTitle ?? 'earlier report'}</span>}
        {r.parentSourceId && <span>Copied from the source exercise at the fork</span>}
      </div>
    </li>
  );
}
