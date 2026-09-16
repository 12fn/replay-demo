import { STRAIT_RED_CELL, straitRedCellPublicBrief } from '../../scenarios/strait-red-cell';
import type { OrganizationPackRole } from '../../context/organization-packs';
import { Panel } from './ui';

export function StraitBriefPanel({role,modelEnabled,humanSide}:{role:OrganizationPackRole;modelEnabled:boolean;humanSide:string}) {
  const brief=straitRedCellPublicBrief(),focus=STRAIT_RED_CELL.roleFocus.find(f=>f.role===role)!;
  return <Panel title="Strait Red Cell" tone="dark" aside={<span className="badge">Taiwan AOR</span>}>
    <p className="small"><strong>{brief.archetype}</strong></p>
    <p className="small">{humanSide==='red'?'You control Red in this practice branch.':modelEnabled?'The connected model is enabled with the Strait Red Cell brief.':'Scripted reference is active. Enable the connected model below to use this Red cell brief.'}</p>
    <p className="small">Your focus: <strong>{focus.focus}</strong>. {focus.learningTargets[0].question}</p>
    <details className="small"><summary>Open Red cell dossier</summary>
      <p>{brief.objective}</p>
      <ul>{STRAIT_RED_CELL.principles.map(p=><li key={p.id}><strong>{p.title}.</strong> {p.text}</li>)}</ul>
      <p>Five fictional relay sites. Penghu is the first priority; the board shows the current rotation.</p>
      <p>{brief.notice}</p>
      <p className="muted">Profile {brief.version}. Model observations and selected actions are retained in the exercise log for replay.</p>
    </details>
  </Panel>;
}
