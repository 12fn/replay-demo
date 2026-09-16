/** Free operator preflight for the existing separately authenticated qualification seats.
 * Reads native capabilities and each member's own Tomo catalog. It never creates helpers,
 * enrolls participants, changes roles, creates a conversation or calls inference.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {nativeAppClient} from './native-app-client';
import {tomoMemberClient} from './tomo-member-client';
const version=process.argv[2];assert.match(version??'',/^\d+\.\d+\.\d+$/);
const output=`evidence/platform/tomo-seat-readiness-${version}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const config=JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json','utf8'));
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const proof:any={at:new Date().toISOString(),version,status:'running',seats:[],modelCalls:0,exerciseWrites:0,configurationWrites:0,
 limitation:'Existing synthetic qualification identities only; a fresh expert account is not qualified by this preflight.'};
try{
 for(const role of ['commander','intelligence']){
  const u=users.find((x:any)=>x.role===role);assert(u?.username&&u?.password);
  const row:any={seat:role,subject:u.subject,blockingReasons:[]}; let expectedHelperName:string|null=null;proof.seats.push(row);
  const web=await nativeAppClient({username:u.username,password:u.password});
  try{
   const build=await(await web.request('/replay-build.json')).json() as any;assert.equal(build.version,version);
   const native=await(await web.request('/api/native/status')).json() as any;assert.equal(native.identity.subject,u.subject);
   const status=await(await web.request('/api/tomo/status')).json() as any;
   row.native={seat:native.identity.role,workroomId:native.context.workroomId,nativeRole:native.context.nativeRole,canEdit:native.context.canEdit,canRunAgents:native.context.canRunAgents,accessState:native.context.accessState};
   expectedHelperName=typeof status.agentName==='string'?status.agentName:null;
   row.entry={agentName:expectedHelperName,bindingSource:status.helperBinding?.source??null,bindingState:status.helperBinding?.state??null,previewEnabled:status.enabled,conversationEnabled:status.mode==='scoped-conversation',watchCreationEnabled:status.watchCreationEnabled};
   if(native.context.accessState!=='active')row.blockingReasons.push('workroom-not-active');
   if(!native.context.canEdit)row.blockingReasons.push('native-write-permission-required');
   if(!native.context.canRunAgents)row.blockingReasons.push('native-agent-permission-required');
   if(!status.enabled)row.blockingReasons.push('tomo-preview-disabled');
   if(status.mode!=='scoped-conversation')row.blockingReasons.push('subject-not-enabled-for-conversation');
  }finally{await web.close();}
  const tomo=await tomoMemberClient(role);
  try{
   const list=(await tomo.request('GET','/api/agents')).data;
   assert(Array.isArray(list.agents));
   const candidates=list.agents.filter((a:any)=>expectedHelperName?a.name===expectedHelperName:a.id===config.agentId);assert(candidates.length<=1);
   const helper=candidates[0];
   row.configuredHelper={id:helper?.id??null,visible:!!helper,owned:helper?.owned===true,private:helper?.visibility==='private'};
   if(!helper||helper.owned!==true)row.blockingReasons.push('configured-helper-not-owned-by-this-member');
   if(helper?.owned===true){
    const catalog=(await tomo.request('GET',`/api/agents/capability-catalog?agent_id=${helper.id}`)).data;
    row.detailsSearchVisible=catalog.tools.some((t:any)=>t.id==='kz_replay-tools_replay_search_practice_details'&&t.capability==='read');
    if(!row.detailsSearchVisible)row.blockingReasons.push('detailed-history-tool-not-visible');
   }
  }finally{await tomo.close();}
  row.preflightReady=row.blockingReasons.length===0;
 }
 proof.status='checked';
}catch{proof.status='failed';proof.error='native-seat-preflight-incomplete';process.exitCode=1;}
finally{
 for(const u of users)u.password='';
 fs.writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({output,status:proof.status,seats:proof.seats.map((r:any)=>({seat:r.seat,preflightReady:r.preflightReady,blockingReasons:r.blockingReasons})),modelCalls:0}));
}
