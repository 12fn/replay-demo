/** Advertise enough protocol headroom without increasing adapter input/output/spend limits. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {installationAdmin} from './admin-client';
const saved=JSON.parse(fs.readFileSync('data/platform/tomo-provider.json','utf8'));const a=await installationAdmin();
try{
 const r=await a.client.request<any>({method:'GET',path:`/model_configs/${saved.configId}`});const prior=r.data;
 const system={...prior.system_config};const endpoint=typeof system.external_endpoint==='string'?JSON.parse(system.external_endpoint):{...system.external_endpoint};
 assert.equal(endpoint.model_id,'replay-tomo-luna');assert.equal(endpoint.protocol,'openai_compatible');assert(typeof endpoint.credential_secret_urn==='string');assert(!endpoint.auth&&!endpoint.api_key&&!endpoint.credential_secret);assert.equal(endpoint.context_window,8192);
 endpoint.context_window=32768;system.external_endpoint=endpoint;
 const result=await a.client.request({method:'PUT',path:`/model_configs/${saved.configId}`,body:{m_id:prior.m_id,default:prior.default,name:prior.name,description:prior.description,config:prior.config,system_config:system}});
 const inventory=await a.client.request<any>({method:'GET',path:'/serving/deployments'});const model=inventory.data.find((m:any)=>m.id===saved.deploymentId);assert.equal(model.context_window,32768);
 const proof={at:new Date().toISOString(),deploymentId:saved.deploymentId,configId:saved.configId,previousContextWindow:8192,contextWindow:32768,status:model.status,catalogCredentialReferenceVerified:true,reason:'Pi reserves4096tokens of context headroom. This metadata now covers the existing24KiB request and1600output ceilings without changing them or the project budget.',receipts:[r.receipt,result.receipt,inventory.receipt],inferenceRequests:0};
 fs.writeFileSync('evidence/platform/tomo-model-context-1.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{saved.secret='';a.close();}
