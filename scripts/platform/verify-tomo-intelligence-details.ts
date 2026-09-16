/** Read-only verification of retained Intelligence tool/answer evidence and fresh native history. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
import {attemptArguments} from './tomo-qualification-contract';
const {version,attempt}=attemptArguments(process.argv.slice(2));
const proofPath=`evidence/platform/tomo-intelligence-details-${attempt}.json`;
const dest=`evidence/platform/tomo-intelligence-details-grounding-${attempt}.json`;
assert(!fs.existsSync(dest),'Preserve previous verification');
const proof=JSON.parse(fs.readFileSync(proofPath,'utf8'));
assert.equal(proof.version,version);assert.equal(proof.role,'intelligence');
assert.equal(proof.status,'terminal-observed');assert.equal(proof.terminal.status,'completed');
const files=[proofPath,proof.privateEvents,proof.privateBaseline,proof.privateDetail];
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const hashes=files.map((p:string)=>sha(fs.readFileSync(p)));
const frames=fs.readFileSync(proof.privateEvents,'utf8').trim().split('\n').map(l=>JSON.parse(l));
const {args,baseline}=JSON.parse(fs.readFileSync(proof.privateBaseline,'utf8'));
const tools=frames.filter(f=>f.event==='tool'&&f.data.input_id===proof.inputId&&f.data.run_id===proof.terminal.runId);
const starts=tools.filter(f=>f.data.status==='start'),ends=tools.filter(f=>f.data.status==='end');
assert.equal(starts.length,1);assert.equal(ends.length,1);
const start=starts[0],end=ends[0];
assert.equal(start.data.name,'kz_replay-tools_replay_search_practice_details');
assert.equal(end.data.name,start.data.name);assert.equal(end.data.call_id,start.data.call_id);assert.equal(end.data.outcome,'ok');
assert.deepEqual(JSON.parse(start.data.args_full),args);
const display=String(end.data.result_full);
const displayTruncated=display.endsWith('\n\n… (truncated)');
let fullToolMatchesBaseline=false;
if(!displayTruncated){const payload=JSON.parse(display).details.payload;assert.equal(payload.isError,false);assert.deepEqual(payload.structuredContent,baseline);fullToolMatchesBaseline=true;}
else assert.equal(display.length,8015,'Unexpected truncation format');
// Never repair truncated JSON or treat the independent baseline as its missing bytes.
const assistant=frames.find(f=>f.event==='assistant_message'&&f.position===proof.assistant.position);
assert(assistant);assert.equal(assistant.input_id,proof.inputId);assert.equal(assistant.run_id,proof.terminal.runId);
assert(frames.indexOf(start)<frames.indexOf(end)&&frames.indexOf(end)<frames.indexOf(assistant));
const answer=JSON.parse(assistant.data.text.trim());const item=baseline.items[0];
assert.equal(item.actor,proof.subject);assert.equal(item.exercise.id,proof.exerciseId);assert.equal(baseline.scope,'mine');
const expected={eventId:item.eventId,exerciseId:item.exercise.id,recordedTick:item.ticks.recorded,observedTick:item.ticks.observed,
 statementTiming:item.statement.timing,statementText:item.statement.text,sources:item.sources.items.map((s:any)=>({id:s.id,derivedFrom:s.derivedFrom??null,atViewedTick:s.atViewedTick,atCompletedCutoff:s.atCompletedCutoff}))};
assert.deepEqual(answer.record,expected);assert.equal(typeof answer.explanation,'string');assert(answer.explanation.length>0);
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));let client:Awaited<ReturnType<typeof nativeAppClient>>|undefined;
try {
 try{client=await nativeAppClient(users.find((u:any)=>u.role==='intelligence'));}finally{for(const u of users)u.password='';}
 const read=async(p:string)=>await(await client!.request(p,undefined,{signal:AbortSignal.timeout(15000)})).json() as any;
 const identity=await read('/api/native/status');assert.equal(identity.identity.subject,proof.subject);assert.equal(identity.identity.role,'intelligence');
 await client.request('/api/select',{exerciseId:proof.exerciseId},{signal:AbortSignal.timeout(15000)});
 const before=(await read('/api/agents/tools')).budget;
 const fresh=await read('/api/practice/history/details?'+new URLSearchParams(Object.entries(args).map(([k,v])=>[k,String(v)])));
 assert.deepEqual(fresh,baseline);
 const after=(await read('/api/agents/tools')).budget;assert.deepEqual(after,before);
 files.forEach((p:string,i:number)=>assert.equal(sha(fs.readFileSync(p)),hashes[i]));
 const result={at:new Date().toISOString(),status:displayTruncated?'partial-tool-display-truncated':'passed',version,attempt,automatedOperation:true,role:'intelligence',agentId:proof.agentId,
 conversationId:proof.conversationId,inputId:proof.inputId,runId:proof.terminal.runId,
 tool:{name:start.data.name,callId:start.data.call_id,outcome:end.data.outcome},
 record:expected,explanation:answer.explanation,fullToolMatchesBaseline,displayTruncated,displayCharacters:display.length,freshNativeResultMatches:true,answerFactsMatch:true,
 originalEvidenceUnchanged:true,sourceArtifacts:files.map((path:string,i:number)=>({path,sha256:hashes[i]})),
 conversationInferenceRequests:proof.newRequests,verificationInferenceRequests:0,budget:after,
 limitations:['Automated authored example in a prior world-map exercise, not a new Taiwan or human assessment.','Explanation requires reviewer judgment; no mastery, personality or full provider-workload join claim.','Truncated tool display cannot establish equality of the full returned payload; successful tool event and independently matched answer are narrower evidence.']};
 fs.writeFileSync(dest,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({artifact:dest,status:result.status,role:result.role,fullToolMatchesBaseline,displayTruncated,displayCharacters:display.length,freshNativeResultMatches:true,answerFactsMatch:true,conversationInferenceRequests:proof.newRequests,verificationInferenceRequests:0,budget:after}));
}finally{await client?.close();}
