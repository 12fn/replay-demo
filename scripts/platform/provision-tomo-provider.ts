/** Dedicated Core provider credential and native external-model catalog registration. No inference. */
import fs from 'node:fs';import {randomBytes} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {installationAdmin} from './admin-client';
const local='data/platform/tomo-provider.json',artifact='evidence/platform/tomo-provider-registration-1.json';
if(fs.existsSync(artifact))throw new Error('Registration receipt already exists; inspect it instead of duplicating');
const saved=fs.existsSync(local)?JSON.parse(fs.readFileSync(local,'utf8')):{secret:randomBytes(48).toString('base64url')};
if(saved.phase==='submission-started')throw new Error('Prior registration outcome uncertain; reconcile native catalog before retry');
fs.writeFileSync(local,JSON.stringify(saved),{mode:0o600});
const spec={apiVersion:'v1',kind:'Secret',metadata:{name:'replay-tomo-provider',namespace:'kamiwaza-extensions'},type:'Opaque',stringData:{api_key:saved.secret}};
try{execFileSync('podman',['machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl apply -f -'],{input:JSON.stringify(spec),stdio:['pipe','pipe','pipe']});}catch{throw new Error('Dedicated provider secret provisioning failed');}
fs.writeFileSync('data/platform/tomo-provider.ready','dedicated Core provider secret provisioned\n',{mode:0o600});
const admin=await installationAdmin();
try{
 saved.phase='submission-started';fs.writeFileSync(local,JSON.stringify(saved),{mode:0o600});
 const result=await admin.client.request<any>({method:'POST',path:'/models/',body:{name:'REPLAY Tomo capped Luna',description:'Dedicated bounded provider for the REPLAY fictional learning exercise. Delegated serving identity; member/tool authority is enforced by Core and Tomo.',default_config:{default:true,config:{},system_config:{engine_name:'external_chat',external_endpoint:{protocol:'openai_compatible',base_url:'http://replay-server.kamiwaza-extensions.svc.cluster.local:5181/internal/tomo-provider/v1',model_id:'replay-tomo-luna',auth:{type:'openai_api_key',token:saved.secret},context_window:8192}}}}});
 const model=result.data;const id=model.id??model.m_id;if(typeof id!=='string')throw new Error('Registration returned no model ID');
 saved.modelId=id;saved.phase='model-created';fs.writeFileSync(local,JSON.stringify(saved),{mode:0o600});
 const config=model.default_config;let configId=config?.id??config?.m_config_id;
 if(!configId){const configs=await admin.client.request<any>({method:'GET',path:`/models/${id}/configs`});const rows=Array.isArray(configs.data)?configs.data:configs.data.items;const c=rows?.find((x:any)=>x.default===true);configId=c?.id??c?.m_config_id;}
 if(typeof configId!=='string')throw new Error('Default model config ID requires reconciliation');
 saved.configId=configId;saved.phase='registered';fs.writeFileSync(local,JSON.stringify(saved),{mode:0o600});
 const proof={at:new Date().toISOString(),modelId:id,configId,name:'REPLAY Tomo capped Luna',engine:'external_chat',protocol:'openai_compatible',modelAlias:'replay-tomo-luna',baseUrl:'http://replay-server.kamiwaza-extensions.svc.cluster.local:5181/internal/tomo-provider/v1',credential:{dedicated:true,kubernetesSecret:'replay-tomo-provider',catalogNormalized:true},receipt:result.receipt,inferenceRequests:0,deployed:false,attribution:'Core delegates to a dedicated serving identity; provider receipt must not be labeled as a member action.'};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}catch(error){console.error(JSON.stringify({failed:true,httpStatus:(error as any)?.httpStatus??null,phase:saved.phase,modelId:saved.modelId??null,message:'Native registration did not complete; inspect safe state and reconcile before retry.'}));process.exitCode=1;}finally{saved.secret='';admin.close();}
