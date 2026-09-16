/** Automated integration activity only; no AI player, human judgment or learning claim. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {nativeAppClient} from './native-app-client';
import {ReplayEngine} from '../../src/engine/engine';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version),'Expected target version');
const artifact=`evidence/soak/native-shared-campaign-${version}.json`;
assert(!fs.existsSync(artifact),'Preserve existing qualification evidence');
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const owner=await nativeAppClient(); // The native instructor/owner may share; editors cannot issue invitations.
const commander=await nativeAppClient(users.find((u:any)=>u.role==='commander'));
const peer=await nativeAppClient(users.find((u:any)=>u.role==='intelligence'));
const j=async(c:typeof owner,p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const finish=async(id:string)=>{await j(owner,'/api/select',{exerciseId:id});return j(owner,`/api/exercises/${id}/finish`,{});};
let campaignId:string|null=null;const ids=new Set<string>();
try{
 const build=await j(owner,'/replay-build.json');assert.equal(build.version,version);
 await j(owner,'/api/overview'); // Initialize this new browser session's assigned exercise before scoped tool reads.
 const before=(await j(owner,'/api/agents/tools')).budget;
 const first=await j(owner,'/api/campaigns',{name:'Automated shared campaign qualification · no player judgment'});
 campaignId=first.campaign.id;const cid=campaignId!,firstId=first.activeExerciseId;assert(firstId);ids.add(firstId);
 const ownerIdentity=(await j(owner,'/api/overview')).identity;
 assert.equal((await peer.requestRaw(`/api/campaigns/${cid}`)).status,404);
 const invitation=await j(owner,`/api/campaigns/${cid}/code`,{});
 await j(commander,'/api/campaigns/join',{code:invitation.code});
 const commanderIdentity=(await j(commander,'/api/overview')).identity;assert.equal(commanderIdentity.role,'commander');
 const join=await j(peer,'/api/campaigns/join',{code:invitation.code});assert.equal(join.activeExerciseId,firstId);
 const analyst=await j(peer,'/api/overview');assert.equal(analyst.identity.role,'intelligence');assert.notEqual(analyst.identity.subject,ownerIdentity.subject);
 assert.equal(join.view.membership.viewer.canManage,false);
 assert([403,404].includes((await peer.requestRaw(`/api/campaigns/${cid}/pause`,{})).status),'Participants cannot pause owner progression');
 const source=analyst.reports.find((r:any)=>r.side==='blue');
 const assessment=await j(peer,'/api/learning/assessment',{exerciseId:firstId,text:'Automated integration assessment: compare the dated source before acting. No human learning judgment.',sourceIds:source?[source.id]:[]});
 const commanderView=await j(commander,'/api/overview');assert(commanderView.timeline.some((e:any)=>e.id===assessment.id));
 assert.equal(assessment.timing,'contemporaneous');
 await j(peer,'/api/replay',{tick:1,exerciseId:firstId});
 await finish(firstId);
 let second:any;for(let n=0;n<40;n++){second=await j(owner,`/api/campaigns/${cid}`);if(second.campaign.missions.length===2)break;await delay(250);}
 assert.equal(second.campaign.missions.length,2);const secondId=second.activeExerciseId;assert(secondId);ids.add(secondId);
 const carried=second.membership.missions[1];assert(carried.carried.includes(analyst.identity.subject));assert(carried.carried.includes(commanderIdentity.subject));assert.equal(carried.excluded.length,0);
 const peerCampaign=await j(peer,`/api/campaigns/${cid}`);assert.equal(peerCampaign.activeExerciseId,secondId);
 const frozen=await j(peer,'/api/overview');assert.equal(frozen.activeId,firstId);assert.equal(frozen.playbackTick,1);
 await j(peer,'/api/select',{exerciseId:secondId});
 const seat=(await j(peer,'/api/team')).participants.find((p:any)=>p.subject===analyst.identity.subject);assert.equal(seat.source,'campaign-carryover');
 assert.equal(seat.roleAtJoin,'intelligence');
 const firstRecord=await j(owner,`/api/record/${firstId}`),sourceJson=JSON.stringify(firstRecord);
 await j(owner,'/api/select',{exerciseId:firstId});
 const branch=await j(owner,'/api/branches',{tick:1,side:'red'});ids.add(branch.id);assert.equal(branch.options.campaignId,undefined);
 assert.equal((await peer.requestRaw('/api/select',{exerciseId:branch.id})).status,403);
 await finish(branch.id);
 assert.equal(JSON.stringify(await j(owner,`/api/record/${firstId}`)),sourceJson);
 await j(owner,`/api/campaigns/${cid}/pause`,{});
 await j(owner,`/api/campaigns/${cid}/revoke`,{subject:analyst.identity.subject});
 assert.equal((await peer.requestRaw(`/api/campaigns/${cid}`)).status,404);
 assert.equal((await peer.requestRaw('/api/select',{exerciseId:secondId})).status,403);
 const lifted=await j(owner,`/api/campaigns/${cid}/reinstate`,{subject:analyst.identity.subject});assert.equal(lifted.rejoinRequired,true);
 assert.equal((await peer.requestRaw('/api/select',{exerciseId:secondId})).status,403);
 const nextInvitation=await j(owner,`/api/campaigns/${cid}/code`,{});
 const rejoin=await j(peer,'/api/campaigns/join',{code:nextInvitation.code});assert.equal(rejoin.activeExerciseId,secondId);
 const stopped=await j(owner,`/api/campaigns/${cid}/stop`,{});assert.equal(stopped.membership.detached?.exerciseId,secondId);
 await j(peer,`/api/campaigns/${cid}/withdraw`,{});
 assert.equal((await peer.requestRaw(`/api/campaigns/${cid}`)).status,404);
 await finish(secondId);
 const final=await j(owner,`/api/campaigns/${cid}`);assert.equal(final.membership.detached,null);
 assert.equal(final.membership.missions[1].status,'completed');
 const restores=[];for(const id of [firstId,secondId]){const record=await j(owner,`/api/record/${id}`),tick=record.turns.length;const e=await ReplayEngine.restore(record,tick,'checkpoints');assert.equal(e.state().fingerprint,record.fingerprints[tick]);restores.push({exerciseId:id,tick,fingerprint:e.state().fingerprint});}
 const after=(await j(owner,'/api/agents/tools')).budget;assert.equal(after.requestsUsed,before.requestsUsed);
 const result={at:new Date().toISOString(),build,campaignId,exerciseIds:[...ids],automated:true,humanPlaytest:false,aiPlayerPlaytest:false,newPaidRequests:0,budget:after,subjects:{instructorOwner:ownerIdentity.subject,commander:commanderIdentity.subject,analyst:analyst.identity.subject},assessmentId:assessment.id,sharedLiveAssessment:true,participantCarryover:true,ownFreshRoleAtCarry:true,frozenPeerReviewPreserved:true,ownerBranchPrivate:true,sourceUnchanged:true,removalAndExplicitRejoin:true,stoppedDetachedState:true,restores,limitations:['Short API-driven integration exercise, not continuous human pacing or learning validation.','Tomo and DGX runtime are separate qualifications.']};
 fs.writeFileSync(artifact,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}finally{
 if(campaignId){try{await j(owner,`/api/campaigns/${campaignId}/pause`,{});const v=await j(owner,`/api/campaigns/${campaignId}`);for(const m of v.campaign.missions)ids.add(m.exerciseId);await j(owner,`/api/campaigns/${campaignId}/stop`,{});}catch{}}
 for(const id of ids)try{await finish(id);}catch{}
 await owner.close();await commander.close();await peer.close();
}
