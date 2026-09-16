import {opponentPresentation} from '../model-presentation';
import { PageHeading, WorkspaceTabs } from '../components/Workspace';
import {useEffect,useState} from 'react';
import { CheckCircle2, Cpu, Database, Receipt, XCircle } from 'lucide-react';
import type { ViewContext } from '../App';
import { OntologyPanel } from '../components/OntologyPanel';
import { CatalogGraphPanel } from '../components/CatalogGraphPanel';
import { nativeOf } from '../native-api';
import { Empty, KindBadge, Meter, Panel, Stat } from '../components/ui';
import { fmtUsd, shortHash, sideLabel, statusLabel } from '../lib';

export function PlatformView({ ctx }: { ctx: ViewContext }) {
  const { ov } = ctx;
  const [section, setSection] = useState<'archive'|'connections'|'usage'>('archive');
  const p = ov.platform;
  const native = p.nativeConnected;
  const [tomoPreview,setTomoPreview]=useState(false);
  const [tomoConversation,setTomoConversation]=useState(false);
  const [tomoAgentName,setTomoAgentName]=useState('REPLAY evidence observer');
  const [tomoWatches,setTomoWatches]=useState(false);
  useEffect(()=>{
    let alive=true;
    setTomoPreview(false);setTomoConversation(false);setTomoWatches(false);
    if(native) void fetch('/api/tomo/status',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(s=>{if(alive){setTomoPreview(s?.enabled===true);setTomoConversation(s?.mode==='scoped-conversation');setTomoAgentName(typeof s?.agentName==='string'?s.agentName:'REPLAY evidence observer');setTomoWatches(s?.watchCreationEnabled===true);}}).catch(()=>{});
    return ()=>{alive=false;};
  },[native,ov.identity.subject]);

  return (<>
    <PageHeading eyebrow="Powered by Kamiwaza" title="Platform & evidence" description="Inspect the original sources, connected tools, and usage behind this workspace." />
    <WorkspaceTabs label="Platform workspace" value={section} onChange={setSection} items={[{id:'archive',label:'Evidence archive'},{id:'connections',label:'Connections & tools'},{id:'usage',label:'Usage & records'}]} />
    <div className={`layout platform-layout platform-${section}`}>
      <div className="platform-catalog" hidden={section !== 'archive'}>
        <CatalogGraphPanel scopeKey={`${ov.identity.subject}|${nativeOf(ov)?.workroomId ?? 'local'}`} />
      </div>
      <div className="doc-col" hidden={section !== 'connections'}>
        <OntologyPanel ctx={ctx} />
        {tomoPreview && <Panel title={tomoConversation?"Tomo exercise assistant":"Tomo workspace preview"}>
          <p>Open the installed Tomo interface with your current Kamiwaza sign-in. Use it to inspect exercise evidence and previous practice.</p>
          <p className="muted small">{tomoConversation?`Choose ${tomoAgentName} and its REPLAY model in Tomo. Include the exercise context below in your question.`:"This preview supports viewing only. Conversations are not enabled for this sign-in yet."}</p>
          {tomoConversation && <p className="small">Exercise: {ov.exercises.find(e=>e.id===ov.activeId)?.name} · <code>{ov.activeId}</code></p>}
          {tomoWatches && <p className="small">Ask it to “monitor report provenance” during a running exercise. The watch keeps checking while you play; its alerts appear in Staff → Watches.</p>}
          <a className="btn btn-secondary" href="/runtime/apps/replay-tomo/" target="_blank" rel="noopener noreferrer">{tomoConversation?"Open Tomo assistant":"Open Tomo preview"}</a>
        </Panel>}
        <Panel title={<><Cpu size={15} aria-hidden="true" /> Integration status</>}>
          <div className="status-line">
            {native ? <CheckCircle2 size={16} className="ok" aria-hidden="true" /> : <XCircle size={16} className="bad" aria-hidden="true" />}
            <span>{native ? 'Connected to a native Kamiwaza platform' : 'Not connected to a native Kamiwaza platform'}</span>
          </div>
          <div className="stat-grid wide">
            <Stat label="Mode" value={p.mode} />
            <Stat label="Platform target" value={p.version ?? 'not reported'} />
            <Stat label="Identity source" value={ov.identity.mode === 'local-demo' ? 'Local demo persona' : 'Kamiwaza'} />
            <Stat label="Ontology" value={p.ontologyStatus || 'not reported'} />
          </div>
          <h3 className="sub">Evidence reported by the backend</h3>
          {p.details.length === 0 ? <Empty>The backend reported no integration details.</Empty> : (
            <ul className="doc-list">{p.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
          )}
        </Panel>

      </div><div className="doc-col" hidden={section !== 'usage'}>
        <Panel title={<><Receipt size={15} aria-hidden="true" /> Inference spend</>}>
          <div className="stat-grid wide">
            <Stat label="Model opponent" value={<span className="mono">{opponentPresentation(ov.exercises.find(e => e.id === ov.activeId)?.agentEnabled, p.model, p.inferenceRoute)}</span>} />
            <Stat label={p.inferenceRoute==='kamiwaza-local'?'Local model requests':'Paid requests'} value={p.requests} />
            <Stat label="API charges" value={fmtUsd(p.spentUsd)} hint={p.inferenceRoute==='kamiwaza-local'?'Local hardware cost not measured':`cap ${fmtUsd(p.capUsd)}`} />
            <Stat label="Traces recorded" value={p.traceCount} />
          </div>
          {p.capUsd>0&&<Meter value={p.spentUsd} max={p.capUsd} label="Spend against cap" />}
          <p className="muted small">
            Counts and spend are the backend's ledger figures. The model opponent is off by default and is only enabled explicitly from the Exercise page.
          </p>
          <p className="muted small">{p.inferenceRoute==='kamiwaza-local'?'Inference uses the configured Kamiwaza local model service. There is no external provider fallback. Local calls have a separate 100-request limit; the paid provider ledger is retained separately. Hardware and operating costs are not measured.':'Model names here are presentation labels. The default route calls an external provider API; native app sign-in does not establish local or platform-hosted inference.'} Exact model identities remain in the underlying receipts.</p>
        </Panel>
      </div>

      <aside className="doc-side" hidden={section !== 'usage'}>
        <Panel title="Source and licenses">
          <p className="muted small">REPLAY uses the OpenFront engine under AGPL-3.0. The archive includes this application’s corresponding source and asset notices.</p>
          <a className="btn btn-secondary" href="/replay-source.tar.gz" download>Download source archive</a>
        </Panel>
        <Panel title={<><Database size={15} aria-hidden="true" /> Engine snapshot</>}>
          <dl className="tile-summary">
            <div><dt>Exercise</dt><dd>{ov.exercises.find((e) => e.id === ov.activeId)?.name ?? ov.activeId}</dd></div>
            <div><dt>Simulation</dt><dd className="mono">{ov.state.simulationId}</dd></div>
            <div><dt>Map</dt><dd className="mono">{ov.state.map} {ov.state.width}×{ov.state.height}</dd></div>
            <div><dt>Tick</dt><dd className="mono">{ov.state.tick}</dd></div>
            <div><dt>Fingerprint</dt><dd className="mono" title={ov.state.fingerprint}>{shortHash(ov.state.fingerprint, 16)}</dd></div>
            <div><dt>Displayed</dt><dd>{ov.playbackTick !== null ? `historical tick ${ov.playbackTick}` : ctx.active?.status==='running' ? 'live' : 'recorded final state'}</dd></div>
          </dl>
        </Panel>
        <Panel title="Exercises known to this service">
          <details>
            <summary>Browse {ov.exercises.length} accessible exercise records</summary>
          <ul className="plain-list">
            {ov.exercises.map((e) => (
              <li key={e.id}>
                <KindBadge kind={e.kind} /> {e.name} · {statusLabel(e.status).toLowerCase()} · tick {e.tick} · human {sideLabel(e.humanSide)}
                {e.parentId && (
                  <span className="muted"> · from {ov.exercises.find((p) => p.id === e.parentId)?.name ?? e.parentId} @ {e.forkTick}</span>
                )}
              </li>
            ))}
            {ov.exercises.length === 0 && <li className="muted">None.</li>}
          </ul>
          </details>
        </Panel>
      </aside>
    </div>
  </>);
}
