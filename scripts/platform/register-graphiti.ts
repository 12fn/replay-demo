import fs from 'node:fs';
import {installationAdmin} from './admin-client';
const op=await installationAdmin();
try{
 const client=op.client;
 const base='data/platform/extensions/kamiwaza-extensions-bundle-20260820-155300/repos/kamiwaza-extensions-graphiti/registry/garden/v3';
 const template=JSON.parse(fs.readFileSync(`${base}/apps.json`,'utf8'))[0];
 // Preserve the supplied template while registering it in the local installation catalog.
 const {type,docker_images,verified,kz_ext_version,...body}=template;body.visibility='public';
 const existing=await client.request<any[]>({method:'GET',path:'/apps/app_templates'});
 const found=existing.data.find(x=>x.name===template.name);
 const result=found?{data:found,receipt:existing.receipt}:await client.request({method:'POST',path:'/apps/app_templates',body});
 fs.writeFileSync('evidence/platform/graphiti-template.json',JSON.stringify({at:new Date().toISOString(),source:'supplied release-1.2.0 offline extensions bundle',template:result.data,receipt:result.receipt},null,2));
 console.log(JSON.stringify({registered:true,id:(result.data as any).id,name:template.name,receipt:result.receipt}));
}finally{op.close();}
