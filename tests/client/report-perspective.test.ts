import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {ReportPerspectivePanel} from '../../src/client/components/ReportPerspectivePanel';
import type {Report} from '../../src/client/api';
it('shows source timing and derivative status without treating the report as a command',()=>{
 const report:Report={id:'report',tick:300,title:'Relay estimate',body:'Repeated source claim.',source:'Bulletin',confidence:'Unverified',side:'blue',synthetic:true,evidenceStatus:'current',packet:{id:'packet',reportId:'report',sourceId:'bulletin',entityId:'station',observedTick:240,releaseTick:300,sourceRelationship:'derivative',links:[],lineageRootId:'origin',claimStatus:'fictional-scenario-claim',authoritativeState:false}};
 const html=renderToStaticMarkup(createElement(ReportPerspectivePanel,{report,references:[report],cutoffTick:300,onFocus:()=>{}}));
 expect(html).toContain('Source perspective');expect(html).toContain('through tick 300');expect(html).toContain('Observed tick</dt><dd>240');expect(html).toContain('not independent corroboration');expect(html).not.toContain('Selected command is unavailable');
});
