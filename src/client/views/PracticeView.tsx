import { useState } from 'react';
import { PageHeading, WorkspaceTabs } from '../components/Workspace';
import { LearningPanel } from '../components/LearningPanel';
import { PracticeHistoryPanel } from '../components/PracticeHistoryPanel';
import type { ViewContext } from '../App';

export function PracticeView({ ctx }: { ctx: ViewContext }) {
  const [section, setSection] = useState<'history'|'reflection'>('history');
  return <>
    <PageHeading eyebrow="Learn through alternatives" title="My practice" description="Revisit your decisions, compare branches, and carry a clear next step into the next exercise." />
    <WorkspaceTabs label="Practice workspace" value={section} onChange={setSection} items={[{id:'history',label:'Practice history'},{id:'reflection',label:'Current exercise reflection'}]} />
    <div hidden={section !== 'history'}><PracticeHistoryPanel ctx={ctx} /></div>
    <div hidden={section !== 'reflection'}><LearningPanel key={ctx.ov.activeId} ctx={ctx} mode="practice" /></div>
  </>;
}
