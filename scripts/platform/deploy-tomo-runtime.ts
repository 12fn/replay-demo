/** Create the supplied Tomo runtime through Core; never print environment or secret values. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {operatorClient,binding} from './operator-client';
import type {CreateExtension,KamiwazaClient} from '../../src/platform';

const filename=process.argv[2];assert(filename,'Pass the reviewed generated CreateExtension JSON');
const spec=JSON.parse(fs.readFileSync(filename,'utf8')) as CreateExtension;
const artifact='evidence/platform/tomo-runtime-create-1.2.0.json';
assert(!fs.existsSync(artifact),'Preserve the existing creation receipt');
assert.equal(spec.name,'replay-tomo');assert.equal(spec.type,'app');
assert.equal(spec.workroom_id,binding.workroom.id);assert.equal(spec.kamiwaza?.use_auth,'true');
assert.equal(spec.networking?.ingress_enabled,false,'Raw Tomo identity parsing requires an authenticated ingress, not an exposed endpoint');
assert.equal(spec.services.length,7);
for(const service of spec.services){
 assert(service.image.endsWith(':release-1.2.0'));
 for(const entry of service.env??[]){
  if(/(?:_PASSWORD|_SECRET(?:_KEY)?|_TOKEN|_ACCESS_KEY|_FIELD_KEY|_ENCRYPTION_KEY)$|^DATABASE_URL$/.test(String(entry.name)))
   assert(!entry.value,'Secrets must use private Kubernetes secret references');
 }
}
const op=await operatorClient();
try{
 const client=op.resolved.platformClient as KamiwazaClient;
 const list=await client.listExtensions({workroomId:binding.workroom.id});
 assert(!list.data.some(e=>e.name==='replay-tomo'),'Inspect and PATCH the existing runtime instead of creating a duplicate');
 const created=await client.createExtension(spec);
 const result={at:new Date().toISOString(),name:created.data.name,type:created.data.type,
  phase:created.data.phase,version:spec.version,workroom:binding.workroom.id,
  services:spec.services.map(s=>({name:s.name,image:s.image})),receipt:created.receipt,
  qualification:'Core accepted runtime creation; pod readiness, authenticated member access and conversation remain separate checks',
  paidInferenceRequested:false};
 fs.writeFileSync(artifact,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(result));
}finally{op.sessions.close();}
