import fs from 'node:fs';
import {operatorClient} from './operator-client';
import type {KamiwazaClient} from '../../src/platform';
const op=await operatorClient();
try{
 const client=op.resolved.platformClient as KamiwazaClient;
 const list=await client.request<any>({method:'GET',path:'/extensions'});
 const items=Array.isArray(list.data)?list.data:list.data.extensions;
 const ext=items.find((e:any)=>e.name.startsWith('service-graphiti-280d6347'));
 if(!ext)throw new Error('Native workroom Graphiti extension not found');
 const result=await client.request({method:'PATCH',path:`/extensions/${ext.name}`,body:{services:[{name:'graphiti',image:{registry:'localhost',repository:'replay-graphiti',tag:'0.1.0',digest:''}}],annotations:{'kamiwaza.ai/replay-compatibility':'Fix embedding_model configuration attribute in supplied release-1.2.0 service'}}});
 fs.writeFileSync('evidence/platform/graphiti-compat-upgrade.json',JSON.stringify({at:new Date().toISOString(),extension:ext.name,patch:'services/graphiti-compat/patch.py',result},null,2));
 console.log(JSON.stringify({extension:ext.name,result:result.data,receipt:result.receipt}));
}finally{op.sessions.close();}
