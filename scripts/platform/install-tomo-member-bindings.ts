/** Install the two independently owned pilot helpers after native registry support is deployed.
 * Usage: VERSION commander|both. No model calls. Native member ownership/catalog checked first.
 * Writes only /data/tomo/member-bindings.json under an exclusive operator lock, retaining old bytes.
 */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {tomoMemberClient} from './tomo-member-client';import {assertDetailsScope} from './enable-tomo-practice-details';
import {parseTomoBindings,TOMO_BINDINGS_SCHEMA} from '../../src/server/tomo-pilot-bindings';
const version=process.argv[2],mode=process.argv[3];assert.match(version??'',/^\d+\.\d+\.\d+$/);assert(['commander','both'].includes(mode));
const artifact=`evidence/platform/tomo-member-bindings-${version}-${mode}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const nativeBuild=await(await fetch('http://127.0.0.1:5183/replay-build.json')).json() as any;assert.equal(nativeBuild.version,version);
const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));
const helperByRole={commander:{agentId:'5ea14dab-621a-46d7-8240-17a182dd9aa0',agentName:'REPLAY staff watch helper'},intelligence:{agentId:'07cc5eba-971a-4895-8187-d2fdc9fd862e',agentName:'REPLAY intelligence staff helper'}};
const rows:any[]=[],checks:any[]=[];
for(const role of mode==='both'?['commander','intelligence'] as const:['commander'] as const){
 const helper=helperByRole[role],client=await tomoMemberClient(role);
 try{
  const result=await client.request('GET',`/api/agents/${helper.agentId}`),card=result.data;
  assert(card.id===helper.agentId&&card.name===helper.agentName&&card.owned&&card.visibility==='private');assert.equal(result.receipt.workroomId,binding.workroom.id);
  const catalog=(await client.request('GET',`/api/agents/capability-catalog?agent_id=${helper.agentId}`)).data;assertDetailsScope(catalog.tools);
  rows.push({subject:result.receipt.subject,...helper});checks.push({role,...result.receipt,privateOwnedHelper:true,toolScopeVerified:true});
 }finally{await client.close();}
}
const document={schema:TOMO_BINDINGS_SCHEMA,workroomId:binding.workroom.id,bindings:rows};parseTomoBindings(JSON.stringify(document),binding.workroom.id);
// CLI source is fixed; registry data is stdin, never executable interpolation.
const program=`import fs from 'node:fs';import crypto from 'node:crypto';import {parseTomoBindings,TOMO_BINDINGS_FILE} from '/app/src/server/tomo-pilot-bindings.ts';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const doc=JSON.parse(Buffer.concat(chunks).toString());parseTomoBindings(JSON.stringify(doc),process.env.REPLAY_WORKROOM_ID);
const dir='/data/tomo',target='/data/'+TOMO_BINDINGS_FILE,lock=dir+'/.member-bindings.lock';fs.mkdirSync(dir,{recursive:true,mode:0o700});const fd=fs.openSync(lock,'wx',0o600);let temp;
try{const prior=fs.existsSync(target)?fs.readFileSync(target,'utf8'):null;
 if(prior!==null){const old=parseTomoBindings(prior,process.env.REPLAY_WORKROOM_ID);for(const [subject,value] of old){const next=doc.bindings.find(x=>x.subject===subject);if(!next||JSON.stringify(next)!==JSON.stringify(value))throw Error('Existing subject must be preserved');}}
 const bytes=JSON.stringify(doc,null,2)+'\\n',hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 if(prior!==bytes){if(prior!==null)fs.writeFileSync(dir+'/member-bindings.before-'+hash(prior)+'.json',prior,{flag:'wx',mode:0o600});temp=target+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});fs.renameSync(temp,target);temp=null;}
 const actual=fs.readFileSync(target,'utf8');if(actual!==bytes)throw Error('Registry read-back mismatch');console.log(JSON.stringify({path:target,previousSha256:prior===null?null:hash(prior),sha256:hash(actual),subjects:doc.bindings.map(x=>x.subject),mode:fs.statSync(target).mode&511,changed:prior!==bytes}));
}finally{if(temp)fs.unlinkSync(temp);fs.closeSync(fd);fs.unlinkSync(lock);}`;
const shellQuote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
const command=['sudo','k0s','kubectl','exec','-i','deployment/replay-server','-n','kamiwaza-extensions','--','node','--import','tsx','--input-type=module','-e',program].map(shellQuote).join(' ');
const raw=execFileSync('podman',['machine','ssh','kamiwaza-harness-poc',command],{input:JSON.stringify(document),encoding:'utf8',timeout:30000,stdio:['pipe','pipe','pipe']});
const receipt=JSON.parse(raw.trim().split('\n').at(-1)!);assert.equal(receipt.mode,0o600);
const expected=createHash('sha256').update(JSON.stringify(document,null,2)+'\n').digest('hex');assert.equal(receipt.sha256,expected);
fs.writeFileSync(artifact,JSON.stringify({at:new Date().toISOString(),version,mode,status:'passed',checks,document,receipt,modelCalls:0,exerciseWrites:0},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({artifact,status:'passed',subjects:rows.length,changed:receipt.changed,modelCalls:0}));
