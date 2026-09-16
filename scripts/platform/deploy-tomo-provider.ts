/** Native external_chat deployment; never invokes inference. */
import fs from 'node:fs';import {installationAdmin} from './admin-client';
const file='data/platform/tomo-provider.json',saved=JSON.parse(fs.readFileSync(file,'utf8'));
if(saved.phase!=='registered')throw new Error('Expected registered dedicated model; reconcile prior deployment before retry');
const admin=await installationAdmin();
try{
 saved.phase='deploy-submitted';fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600});
 const result=await admin.client.request<any>({method:'POST',path:'/serving/deploy_model',body:{m_id:saved.modelId,m_config_id:saved.configId,engine_name:'external_chat'}});
 let id=result.data?.id??result.data?.deployment_id;
 if(typeof id!=='string'){const inventory=await admin.client.request<any>({method:'GET',path:'/serving/deployments'});const matches=Array.isArray(inventory.data)?inventory.data.filter((x:any)=>x.m_id===saved.modelId):[];if(matches.length===1)id=matches[0].id;}
 if(typeof id!=='string')throw new Error('Deployment ID missing; reconcile native state without resubmission');
 saved.deploymentId=id;saved.phase='deployment-accepted';fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600});
 const proof={at:new Date().toISOString(),modelId:saved.modelId,configId:saved.configId,deploymentId:id,status:result.data.status??null,receipt:result.receipt,inferenceRequests:0};
 fs.writeFileSync('evidence/platform/tomo-provider-deployment-1.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}catch(e){console.error(JSON.stringify({failed:true,phase:saved.phase,httpStatus:(e as any)?.httpStatus??null,message:'Reconcile dedicated deployment before retry'}));process.exitCode=1;}finally{saved.secret='';admin.close();}
