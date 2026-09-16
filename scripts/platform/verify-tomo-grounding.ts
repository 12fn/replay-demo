/** Verify recorded native tool→answer evidence against an independently reconstructed native view. No inference. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(/^\d+\.\d+\.\d+$/.test(version??''));
const dest=`evidence/platform/tomo-grounding-${version}.json`;assert(!fs.existsSync(dest),'Preserve prior proof');
const proof=JSON.parse(fs.readFileSync(`evidence/platform/tomo-conversation-${version}.json`,'utf8'));
assert.equal(proof.terminal?.status,'completed');assert.equal(proof.status,'terminal-observed');
const events=fs.readFileSync(`data/platform/tomo-conversation-${version}-events.jsonl`,'utf8').trim().split('\n').map(line=>JSON.parse(line));
const calls=events.filter(e=>e.event==='tool'&&e.data.status==='start');assert.equal(calls.length,1);
const call=calls[0].data;assert.equal(call.name,'kz_replay-tools_replay_get_exercise_state');
assert.equal(call.input_id,proof.inputId);assert.equal(call.run_id,proof.terminal.runId);
assert.deepEqual(JSON.parse(call.args_full),{exerciseId:proof.exerciseId,tick:proof.tick});
const finish=events.find(e=>e.event==='tool'&&e.data.status==='end'&&e.data.call_id===call.call_id)?.data;
assert(finish);assert.equal(finish.outcome,'ok');assert.equal(finish.input_id,proof.inputId);assert.equal(finish.run_id,proof.terminal.runId);
const result=JSON.parse(finish.result_full).details.payload;
assert.equal(result.isError,false);const state=result.structuredContent;assert(state);
assert.equal(state.provenance.exerciseId,proof.exerciseId);assert.equal(state.provenance.cutoffTick,proof.tick);
const answer=events.find(e=>e.event==='assistant_message'&&e.position===proof.assistant.position)?.data.text;
assert(typeof answer==='string'&&answer.trim());
const plain=answer.replaceAll(',','');assert(plain.includes(String(proof.tick)));assert(answer.includes(state.provenance.fingerprint));
for(const player of state.state.players){assert(plain.includes(String(player.troops)));assert(plain.includes(String(player.tiles)));}
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const user=users.find((u:any)=>u.role==='commander');assert(user);
const c=await nativeAppClient(user);for(const u of users)u.password='';
try{
 const j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
 await j('/api/overview');const before=(await j('/api/agents/tools')).budget;
 await j('/api/select',{exerciseId:proof.exerciseId});await j('/api/replay',{exerciseId:proof.exerciseId,tick:proof.tick});
 const ov=await j('/api/overview');assert.equal(ov.identity.role,'commander');assert.equal(ov.state.fingerprint,state.provenance.fingerprint);
 for(const player of state.state.players){const p=ov.state.players.find((p:any)=>p.side===player.side);assert(p);assert.equal(p.troops,player.troops);assert.equal(p.tiles,player.tiles);}
 const after=(await j('/api/agents/tools')).budget;assert.deepEqual(after,before);
 const evidence={at:new Date().toISOString(),version,automated:true,conversationId:proof.conversationId,inputId:proof.inputId,runId:proof.terminal.runId,
  tool:{name:call.name,callId:call.call_id,outcome:finish.outcome,exerciseId:proof.exerciseId,tick:proof.tick,fingerprint:ov.state.fingerprint},
  facts:state.state.players.map((p:any)=>({side:p.side,troops:p.troops,tiles:p.tiles})),answer,
  answerDurablePosition:proof.assistant.position,terminalDurablePosition:proof.terminal.position,independentNativeReconstructionMatched:true,
  inferenceRequestsForConversation:proof.newRequests,verificationInferenceRequests:0,budget:after,
  limits:['Automated API qualification; no browser or human learning validation.','Tomo observer uses non-reasoning Luna Chat mode.','Provider-workload receipts are separate; this proves the matching Tomo input/run/tool/answer chain, not a complete distributed provider join.']};
 fs.writeFileSync(dest,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
}finally{await c.close();}
