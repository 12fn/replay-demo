import fs from 'node:fs';
import {KamiwazaClient} from '../../src/platform/index';
const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));
const client=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>fs.readFileSync('data/kamiwaza-runtime.token','utf8').trim(),forwardedHost:'kamiwaza-harness.localhost',workroomId:binding.workroom.id});
const operations=[['identity',()=>client.me()],['runtimeContext',()=>client.workroomContext(binding.workroom.id)],['nativeOwnership',()=>client.check({subject:{namespace:'user',id:binding.workroom.owner_user_id},relation:'owner',object:{namespace:'workroom',id:binding.workroom.id}})],['extensions',()=>client.listExtensions({workroomId:binding.workroom.id})]] as const;
const report:any={at:new Date().toISOString(),mode:'actual installed 1.2 API',results:{}};
for(const [name,run] of operations){try{const result=await run();report.results[name]={status:'passed',...result};console.log(name,JSON.stringify(result).slice(0,1000));}catch(e){report.results[name]={status:'failed',error:(e as Error).message};console.log(name,'FAILED',(e as Error).message);}}
report.capabilities=client.capabilities();fs.writeFileSync('evidence/platform/native-client-qualification.json',JSON.stringify(report,null,2));
if(Object.values(report.results).some((x:any)=>x.status==='failed'))process.exitCode=1;
