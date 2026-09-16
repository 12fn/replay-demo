/** Browser-only integration fixture. All fetches terminate here; no real server or model route. */
import {createRoot} from 'react-dom/client';
import {StrictMode} from 'react';
import {App} from '../../src/client/App';
import type {Overview} from '../../src/client/api';
import type {NativePlatformBlock, NativeStatus} from '../../src/client/native-api';
import '../../src/client/styles.css';

const context={workroomId:'synthetic-room-a',workroomName:'Synthetic QA workroom',nativeRole:'owner',mappedRole:'instructor' as const,
  profileApplied:false,accessState:'active',interactionMode:'write',lifecycleState:'active',canEdit:true,canRunAgents:false,
  canShare:false,readOnlyReason:null,statusBanner:null,fresh:true,validatedAt:'2026-09-16T00:00:00Z'};
const native:NativePlatformBlock={workroomId:context.workroomId,context,metadata:{signedIn:true,subject:'synthetic-a',username:'Synthetic participant',
  workroomId:context.workroomId,accessExpiresAt:null,refreshable:false,binding:'claim',createdAt:'2026-09-16T00:00:00Z'},receipts:[]};
const ov:Overview={identity:{subject:'synthetic-a',name:'Synthetic protected participant',organization:'QA only',mode:'kamiwaza',role:'instructor'},
  activeId:'synthetic-exercise-a',exercises:[{id:'synthetic-exercise-a',name:'Synthetic protected exercise',kind:'recorded',status:'completed',tick:2,humanSide:'blue'}],
  state:{tick:2,fingerprint:'synthetic-only',simulationId:'synthetic',map:'fixture',width:2,height:2,spawning:false,players:[],owners:[0,0,0,0],land:[1,1,1,1]},
  timeline:[],reports:[{id:'synthetic-source',tick:1,title:'Synthetic protected source sentinel',body:'Fictional evidence for DOM absence assertions.',source:'Authored QA fixture',confidence:'synthetic',side:'blue'}],
  tasks:[],findings:[],dossier:{summary:'Synthetic',strengths:[],practice:[],priorAttempts:[],limitations:['Synthetic QA only']},
  selectedSide:'blue',playbackTick:2,platform:{mode:'kamiwaza',nativeConnected:true,model:'disabled',requests:0,spentUsd:0,capUsd:0,traceCount:0,ontologyStatus:'unconfigured',details:[],native} as Overview['platform']};
let denied:number|null=null,signedIn=true,logoutCount=0,overviewCount=0;
const events:Array<{at:string;path:string;status:number}>=[];
const output=document.getElementById('qa-observation')!;
const show=()=>{output.textContent=JSON.stringify({denied,signedIn,logoutCount,overviewCount,last:events.slice(-5)});};
const reply=(path:string,body:unknown,status=200)=>{events.push({at:new Date().toISOString(),path,status});show();return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});};
window.fetch=async(input,init)=>{
  if(init?.signal?.aborted)throw new DOMException('Aborted','AbortError');
  const path=typeof input==='string'?input:input instanceof URL?input.pathname:input.url;
  if(path==='/api/overview'){overviewCount++;return denied?reply(path,{error:'Synthetic authority refusal'},denied):reply(path,ov);}
  if(path==='/api/native/status'){
    const status:NativeStatus={mode:'kamiwaza',platformSso:true,platformSessionAvailable:true,signedIn,workroomId:native.workroomId,
      identity:signedIn?{...ov.identity,mode:'kamiwaza'}:null,context:signedIn?native.context:null,metadata:native.metadata,
      denial:denied===403?{code:'access_blocked',httpStatus:403,message:'Synthetic authority refusal'}:null};
    return reply(path,status);
  }
  if(path==='/api/native/logout'){logoutCount++;signedIn=false;denied=401;return reply(path,{signedIn:false});}
  // An unexpected mutation can never reach an external endpoint in this harness.
  return reply(path,{error:'Not provided by synthetic navigation fixture'},404);
};
function button(label:string,act:()=>void){const el=document.createElement('button');el.textContent=label;el.onclick=()=>{act();show();};document.getElementById('qa-buttons')!.append(el);}
button('QA deny 401',()=>{denied=401;});
button('QA deny 403',()=>{denied=403;});
button('QA recover same scope',()=>{denied=null;signedIn=true;});
button('QA change subject',()=>{ov.identity.subject=ov.identity.subject==='synthetic-a'?'synthetic-b':'synthetic-a';});
button('QA change workroom',()=>{native.workroomId=native.workroomId==='synthetic-room-a'?'synthetic-room-b':'synthetic-room-a';native.context.workroomId=native.workroomId;});
button('QA change exercise',()=>{ov.activeId=ov.activeId==='synthetic-exercise-a'?'synthetic-exercise-b':'synthetic-exercise-a';ov.exercises[0]!.id=ov.activeId;});
button('QA change role',()=>{ov.identity.role=ov.identity.role==='instructor'?'commander':'instructor';native.context.nativeRole=ov.identity.role==='instructor'?'owner':'editor';});
show();
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
