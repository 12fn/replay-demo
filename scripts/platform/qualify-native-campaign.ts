/** Native integration check; scripted activity, not Codex/Claude player testing or human validation. */
import fs from 'node:fs';import assert from 'node:assert/strict';
import {nativeAppClient} from './native-app-client';import {ReplayEngine} from '../../src/engine/engine';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version),'Expected version');
const artifact=`evidence/soak/native-campaign-${version}.json`;assert(!fs.existsSync(artifact),'Refuse to overwrite native evidence');
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const owner=await nativeAppClient(users.find((u:any)=>u.role==='commander'));
const peer=await nativeAppClient(users.find((u:any)=>u.role==='intelligence'));
const j=async(c:typeof owner,p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));let campaignId:string|null=null;const exerciseIds=new Set<string>();
try{
 const build=await j(owner,'/replay-build.json');assert.equal(build.version,version);await j(owner,'/api/overview');const before=(await j(owner,'/api/agents/tools')).budget;
 const first=await j(owner,'/api/campaigns',{name:'Automated campaign integration · not a player trial'});campaignId=first.campaign.id;assert(first.enabled);const firstId=first.activeExerciseId;exerciseIds.add(firstId);
 const observation=await j(owner,'/api/overview');assert.equal(observation.activeId,firstId);assert.equal(observation.exercises.find((e:any)=>e.id===firstId).options.scenario.controller,'objectives/1');
 const sourceReceipt=observation.observationReceipt;assert(sourceReceipt);const team=await j(owner,'/api/team');assert.equal(team.canManage,false);
 const otherList=await j(peer,'/api/campaigns');assert(!otherList.campaigns.some((c:any)=>c.id===campaignId));assert.equal((await peer.requestRaw(`/api/campaigns/${campaignId}`)).status,404);
 await delay(1500);await j(owner,'/api/replay',{tick:1});await j(owner,`/api/exercises/${firstId}/finish`,{});
 const firstRecord=await j(owner,`/api/record/${firstId}`),source=JSON.stringify(firstRecord);
 let next:any=null;for(let n=0;n<30;n++){next=await j(owner,`/api/campaigns/${campaignId}`);if(next.campaign.missions.length===2)break;await delay(250);}
 assert.equal(next.campaign.missions.length,2);const secondId=next.activeExerciseId;assert(secondId&&secondId!==firstId);exerciseIds.add(secondId);
 const frozen=await j(owner,'/api/overview');assert.equal(frozen.activeId,firstId);assert.equal(frozen.playbackTick,1);assert.equal(frozen.state.tick,1);
 assert.equal(next.campaign.missions[0].end.fingerprint,firstRecord.fingerprints[firstRecord.turns.length]);
 await j(owner,'/api/select',{exerciseId:secondId});const live=await j(owner,'/api/overview');assert.equal(live.playbackTick,null);
 const stale=await owner.requestRaw('/api/commands',{side:'blue',intent:{type:'attack',targetID:null,troops:1},idempotencyKey:`${campaignId}:old-receipt`,observationReceipt:sourceReceipt,rationale:'Synthetic stale-mission receipt refusal check'});assert([400,403,409,422].includes(stale.status),'Previous mission receipt was not refused');
 const start=performance.now(),samples:{tick:number;ms:number}[]=[];let natural=false;
 while(performance.now()-start<120000){
  const t=performance.now(),o=await j(owner,'/api/overview');samples.push({tick:o.state.tick,ms:performance.now()-t});
  if(o.exercises.find((e:any)=>e.id===secondId)?.status!=='running'){natural=true;break;}
  const p=o.state.players.find((p:any)=>p.side==='blue');if(p?.alive&&p.troops>500)await j(owner,'/api/commands',{side:'blue',intent:{type:'attack',targetID:null,troops:Math.floor(p.troops*.18)},idempotencyKey:`${campaignId}:load:${samples.length}`,observationReceipt:o.observationReceipt,rationale:'Automated campaign load check: fixed18percent neutral expansion, not a human or AI player decision.'});
  await delay(1000);
 }
 const elapsedMs=performance.now()-start;
 await j(owner,`/api/campaigns/${campaignId}/pause`,{});const paused=await j(owner,`/api/campaigns/${campaignId}`);assert.equal(paused.enabled,false);
 // Catch every attached mission if natural completion advanced during the load interval.
 for(const m of paused.campaign.missions)exerciseIds.add(m.exerciseId);
 await j(owner,`/api/exercises/${secondId}/finish`,{});const count=paused.campaign.missions.length;await delay(500);assert.equal((await j(owner,`/api/campaigns/${campaignId}`)).campaign.missions.length,count);
 const stopped=await j(owner,`/api/campaigns/${campaignId}/stop`,{});assert.equal(stopped.campaign.status,'stopped');
 await j(owner,'/api/select',{exerciseId:firstId});assert.equal(JSON.stringify(await j(owner,`/api/record/${firstId}`)),source);
 const branch=await j(owner,'/api/branches',{tick:1,side:'red'});exerciseIds.add(branch.id);assert.equal(branch.options.campaignId,undefined);assert.equal(branch.options.campaignReservation,undefined);
 await j(owner,`/api/exercises/${branch.id}/finish`,{});assert.equal(JSON.stringify(await j(owner,`/api/record/${firstId}`)),source);
 const restores=[];for(const id of [firstId,secondId]){const record=await j(owner,`/api/record/${id}`);const tick=record.turns.length,e=await ReplayEngine.restore(record,tick,'checkpoints');assert.equal(e.state().fingerprint,record.fingerprints[tick]);restores.push({exerciseId:id,tick,fingerprint:e.state().fingerprint});}
 const after=(await j(owner,'/api/agents/tools')).budget;assert.equal(after.requestsUsed,before.requestsUsed);
 const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b);const result={at:new Date().toISOString(),build,campaignId,firstId,secondId,branchId:branch.id,automated:true,humanPlaytest:false,aiPlayerPlaytest:false,activity:'Fixed18percent neutral-expansion load',newPaidRequests:0,budget:after,firstMissionEnd:next.campaign.missions[0].end,ownerOnly:true,frozenReviewPreserved:true,staleReceiptStatus:stale.status,pausedNoNewMissions:true,sourceUnchanged:true,branchIndependent:true,restores,load:{elapsedMs:Math.round(elapsedMs),reads:samples.length,naturalEnd:natural,fullDuration:elapsedMs>=120000,p95Ms:Math.round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0),samples},limitations:['Two short missions and a two-minute scripted load are integration evidence, not sustained human play or learning validation.','Campaign enrollment is owner-only; multi-role shared exercises remain standalone.']};
 fs.writeFileSync(artifact,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({...result,load:{...result.load,samples:undefined}}));
}finally{
 if(campaignId){try{await j(owner,`/api/campaigns/${campaignId}/pause`,{});const v=await j(owner,`/api/campaigns/${campaignId}`);for(const m of v.campaign.missions)exerciseIds.add(m.exerciseId);await j(owner,`/api/campaigns/${campaignId}/stop`,{});}catch{}}
 for(const id of exerciseIds)try{await j(owner,`/api/exercises/${id}/finish`,{});}catch{}
 await owner.close();await peer.close();
}
