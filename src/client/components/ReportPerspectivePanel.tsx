import type {Report} from '../api';
import {Panel} from './ui';
import {EvidenceRelations} from './EvidenceRelations';

/** A source claim has a release history, not a command execution trace. */
export function ReportPerspectivePanel({report,references,cutoffTick,onFocus}:{report:Report;references:Report[];cutoffTick:number;onFocus:(id:string)=>void}) {
 return <Panel title="Source perspective">
  <h3>{report.title}</h3>
  <p className="small muted">Evidence available through tick {cutoffTick} · report released at tick {report.tick}</p>
  <p>{report.body}</p>
  <p className="small">Source: {report.source} · {report.confidence}</p>
  {report.packet&&<EvidenceRelations packet={report.packet} evidenceStatus={report.evidenceStatus} disputedWith={report.disputedWith} supersededBy={report.supersededBy} references={references} onFocus={onFocus}/>}
 </Panel>;
}
