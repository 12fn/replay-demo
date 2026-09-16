/** Actual 1.2 sign-ins and app API exercise; synthetic automated inputs, zero paid inference. */
import type {KamiwazaClient} from '../../src/platform';
import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {nativeAppClient} from './native-app-client';import {operatorClient,binding} from './operator-client';
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const commanderUser=users.find((u:any)=>u.role==='commander'),analystUser=users.find((u:any)=>u.role==='intelligence');
let commander=await nativeAppClient(commanderUser),analyst=await nativeAppClient(analystUser),instructor=await nativeAppClient(),op=await operatorClient();
const platform=op.resolved.platformClient as KamiwazaClient;
const json=async(c:typeof commander,p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const status=async(c:typeof commander,p:string,b?:unknown)=>{const r=await c.requestRaw(p,b);await r.arrayBuffer();return r.status;};
const created:string[]=[];let membershipChanged=false;
try{
 const identities=await Promise.all([json(commander,'/api/native/status'),json(analyst,'/api/native/status')]);
 assert.equal(identities[0].identity.role,'commander');assert.equal(identities[1].identity.role,'intelligence');assert.notEqual(identities[0].identity.subject,identities[1].identity.subject);
 const personal=await json(commander,'/api/exercises',{name:'Synthetic qualification · commander private history'});created.push(personal.id);await json(commander,`/api/exercises/${personal.id}/finish`,{});
 const shared=await json(commander,'/api/exercises',{name:'Synthetic qualification · shared command and intelligence'});created.push(shared.id);
 const before=await json(commander,'/api/agents/tools');assert.equal(before.opponent.enabled,false);
 let overview=await json(commander,'/api/overview');
 const deadline=Date.now()+10000;while(overview.state.tick<25&&Date.now()<deadline){await new Promise(r=>setTimeout(r,200));overview=await json(commander,'/api/overview');}assert(overview.state.tick>=25);
 const joinDeniedBefore=await status(analyst,'/api/select',{exerciseId:shared.id});assert.equal(joinDeniedBefore,403);
 const editorSharingDenied=await status(commander,'/api/team/code',{});assert.equal(editorSharingDenied,403);
 await json(instructor,'/api/select',{exerciseId:shared.id});const invitation=await json(instructor,'/api/team/code',{});
 await json(analyst,'/api/team/join',{code:invitation.code,role:'instructor',side:'red'});invitation.code='';
 const joined=await json(analyst,'/api/overview');assert.equal(joined.activeId,shared.id);assert.equal(joined.identity.role,'intelligence');assert.equal(joined.selectedSide,'blue');assert(!joined.exercises.some((e:any)=>e.id===personal.id));
 const roster=await json(instructor,'/api/team');assert.equal(roster.participants.filter((p:any)=>p.active).length,2);
 await json(commander,'/api/replay',{tick:21});await json(analyst,'/api/replay',{tick:21});
 const historical=await Promise.all([json(commander,'/api/overview'),json(analyst,'/api/overview')]);assert.equal(historical[0].state.fingerprint,historical[1].state.fingerprint);
 await json(commander,'/api/replay',{tick:null});await json(analyst,'/api/replay',{tick:null});
 const intelligenceCommandDenied=await status(analyst,'/api/commands',{side:'blue',idempotencyKey:randomUUID(),intent:{type:'attack',targetID:null,troops:10}});assert.equal(intelligenceCommandDenied,403);
 const report=joined.reports.find((r:any)=>r.side==='blue');assert(report);
 await json(analyst,'/api/learning/assessment',{text:'Synthetic qualification: this report is a time-stamped estimate; corroborate it before using it for a current decision.',sourceIds:[report.id]});
 overview=await json(commander,'/api/overview');const command=await json(commander,'/api/commands',{side:'blue',idempotencyKey:randomUUID(),intent:{type:'attack',targetID:null,troops:10},observationReceipt:overview.observationReceipt,rationale:'Synthetic qualification: bounded neutral expansion preserves the remaining reserve.',sourceIds:[report.id]});
 await new Promise(r=>setTimeout(r,300));
 const dossiers=await Promise.all([json(commander,'/api/learning/dossier'),json(analyst,'/api/learning/dossier')]);
 assert.equal(dossiers[0].dossier.current.counts.humanCommands,1);assert.equal(dossiers[0].dossier.current.counts.assessmentsLogged,0);assert.equal(dossiers[1].dossier.current.counts.assessmentsLogged,1);assert.equal(dossiers[1].dossier.current.counts.humanCommands,0);assert.equal(dossiers[1].dossier.current.counts.reportsReleased,0);assert(!JSON.stringify(dossiers[1]).includes(personal.id));
 const branch=await json(commander,'/api/branches',{tick:21,side:'blue'});created.push(branch.id);assert.equal(await status(analyst,'/api/select',{exerciseId:branch.id}),403);await json(commander,`/api/exercises/${branch.id}/finish`,{});await json(commander,'/api/select',{exerciseId:shared.id});
 const roleReceipt=await platform.request({method:'PATCH',path:`/workrooms/${binding.workroom.id}/members/${analystUser.subject}`,body:{role:'viewer'},workroomId:binding.workroom.id});membershipChanged=true;
 const nativeWriteRevocation=await status(analyst,'/api/learning/assessment',{text:'This must be refused after native edit permission is removed.',sourceIds:[]});assert.equal(nativeWriteRevocation,403);
 const restored=await platform.request({method:'PATCH',path:`/workrooms/${binding.workroom.id}/members/${analystUser.subject}`,body:{role:'editor'},workroomId:binding.workroom.id});membershipChanged=false;
 await analyst.close().catch(()=>{});analyst=await nativeAppClient(analystUser);await json(analyst,'/api/select',{exerciseId:shared.id});
 await json(instructor,'/api/team/remove',{subject:analystUser.subject});assert.equal(await status(analyst,'/api/select',{exerciseId:shared.id}),403);
 const rejoin=await json(instructor,'/api/team/code',{});await json(analyst,'/api/team/join',{code:rejoin.code});rejoin.code='';
 await json(commander,`/api/exercises/${shared.id}/finish`,{});
 const exported=await json(instructor,'/api/review/export.json');assert.equal(exported.payload.exercise.options.ownerSubject,commanderUser.subject);assert.equal(exported.payload.receipts.length,0);
 const after=await json(commander,'/api/agents/tools');assert.equal(after.budget.requestsUsed,before.budget.requestsUsed);assert.equal(after.opponent.enabled,false);
 await json(instructor,'/api/select',{exerciseId:'467bdded-c0f0-4dee-bdd0-14804f53350b'});const original=await json(instructor,'/api/review/export.json');assert.equal(original.payload.engine.fingerprint,'e72d20d9a67f09f799c1c62b6c5eaaedef98e60272b390d98084de6add56895d');
 const proof={at:new Date().toISOString(),automated:true,humanValidated:false,build:await json(commander,'/replay-build.json'),exerciseId:shared.id,privateHistory:personal.id,branchId:branch.id,identities:identities.map(x=>({identity:x.identity,context:x.context})),roster,sharedHistoricalFingerprint:historical[0].state.fingerprint,commandId:command.id,counts:dossiers.map(x=>({learner:x.dossier.learner,counts:x.dossier.current.counts})),denials:{beforeEnrollment:joinDeniedBefore,editorSharing:editorSharingDenied,intelligenceCommand:intelligenceCommandDenied,nativeWriteRevocation},roleChangeReceipts:[roleReceipt.receipt,restored.receipt],bundleSha256:exported.sha256,finalFingerprint:exported.payload.engine.fingerprint,budget:after.budget,newPaidRequests:0,originalDemoPreserved:true,browserVisualCheck:'Pending: Mac locked'};
 fs.writeFileSync('evidence/poc/native-shared-exercise.json',JSON.stringify(proof,null,2));fs.writeFileSync('data/platform/shared-exercise-export.json',JSON.stringify(exported));console.log(JSON.stringify(proof));
}finally{
 if(membershipChanged)await platform.request({method:'PATCH',path:`/workrooms/${binding.workroom.id}/members/${analystUser.subject}`,body:{role:'editor'},workroomId:binding.workroom.id});
 for(const id of created){try{await json(instructor,'/api/select',{exerciseId:id});const o=await json(instructor,'/api/overview');if(o.exercises.find((e:any)=>e.id===id)?.status==='running')await json(instructor,`/api/exercises/${id}/finish`,{});}catch{}}
 for(const c of [commander,analyst,instructor])await c.close().catch(()=>{});op.sessions.close();
}
