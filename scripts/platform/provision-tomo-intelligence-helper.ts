/** Provision one private helper using the existing Intelligence member's own native login.
 * Does not enable app admission; main must separately verify/write the per-subject binding.
 * The intent file makes an uncertain create non-repeatable. No model or exercise calls.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {tomoMemberClient} from './tomo-member-client';
import {helperContent} from './enable-tomo-staff-watch';
import {withDetailsTool,assertDetailsScope} from './enable-tomo-practice-details';
const mode=process.argv[2]??'inspect';assert(['inspect','apply'].includes(mode));
const name='REPLAY intelligence staff helper';
const content=withDetailsTool(helperContent());content.name=name;
const digest=createHash('sha256').update(JSON.stringify(content)).digest('hex');
const intentPath='evidence/platform/tomo-intelligence-helper-intent.json';
const proofPath=`evidence/platform/tomo-intelligence-helper-${mode}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const proof:any={at:new Date().toISOString(),mode,status:'running',name,contentSha256:digest,modelCalls:0,appAdmissionChanged:false,exerciseWrites:0};
const client=await tomoMemberClient('intelligence');
try{
 const list=await client.request('GET','/api/agents');proof.identityReceipt=list.receipt;
 assert(Array.isArray(list.data.agents));
 const matches=list.data.agents.filter((a:any)=>a.name===name);assert(matches.length<=1,'Duplicate helper names require operator review');
 let id=matches[0]?.id;
 if(fs.existsSync(intentPath)){
  const intent=JSON.parse(fs.readFileSync(intentPath,'utf8'));
  assert.equal(intent.subject,list.receipt.subject);assert.equal(intent.workroomId,list.receipt.workroomId);assert.equal(intent.contentSha256,digest);
  assert(id,'Uncertain previous create: do not retry');proof.reconciledExistingIntent=true;
 }else if(mode==='apply'){
  assert(!id,'Existing name without intent requires review');
  fs.writeFileSync(intentPath,JSON.stringify({at:proof.at,subject:list.receipt.subject,workroomId:list.receipt.workroomId,name,contentSha256:digest,rule:'Never repeat POST after uncertain result; reconcile read-only.'},null,2)+'\n',{flag:'wx',mode:0o600});
  const created=await client.request('POST','/api/agents',{content});id=created.data.id;proof.createReceipt=created.receipt;
 }
 if(id){
  assert.match(id,/^[a-f0-9-]{36}$/i);
  const card=(await client.request('GET',`/api/agents/${id}`)).data;
  assert(card.id===id&&card.owned&&card.can_edit&&card.visibility==='private'&&!card.protected);
  const definition=(await client.request('GET',`/api/agents/${id}/definition`)).data;
  assert.deepEqual(definition.content,content);
  const catalog=(await client.request('GET',`/api/agents/capability-catalog?agent_id=${id}`)).data;
  assertDetailsScope(catalog.tools);
  proof.helper={id,version:definition.version,owner:list.receipt.subject,private:true,toolIds:catalog.tools.map((t:any)=>t.id).sort()};
 }
 proof.status=mode==='apply'?'passed':'inspected';
}catch{proof.status='failed';proof.failure='Private helper provisioning or scope verification failed; inspect retained intent before retry.';process.exitCode=1;}
finally{
 try{await client.close();proof.sessionClosed=true;}catch{proof.sessionClosed=false;proof.status='failed';process.exitCode=1;}
 fs.writeFileSync(proofPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({proofPath,status:proof.status,helper:proof.helper,modelCalls:0,appAdmissionChanged:false}));
}
