import {deploymentOptions} from './deployment-options';
import fs from 'node:fs';
import {operatorClient,binding} from './operator-client';
import type {KamiwazaClient} from '../../src/platform';
const image=process.argv[2]??'localhost/replay:0.2.0-native';
if(!/^localhost\/replay:[a-zA-Z0-9._-]+$/.test(image))throw new Error('Expected a locally built REPLAY image tag');
const deployment=deploymentOptions(process.argv.slice(3));
const {operatorFileImport:operatorImport,legacyRecordings}=deployment;
const op=await operatorClient();
try{
 const client=op.resolved.platformClient as KamiwazaClient;
 const subject=JSON.parse(fs.readFileSync('evidence/platform/graphiti-service-identity.json','utf8')).signedIdentity['x-user-id'];
 const ontology=JSON.parse(fs.readFileSync('data/platform/ontology-instance.json','utf8')).id;
 const env={REPLAY_KAMIWAZA_VERSION:'1.2.0',REPLAY_MCP_WATCH_WRITE:'true',REPLAY_DATA_DIR:'/data',REPLAY_AUTH_MODE:'kamiwaza',REPLAY_KAMIWAZA_API:'http://core-api.kamiwaza.svc:7777/api',REPLAY_WORKROOM_ID:binding.workroom.id,REPLAY_FORWARDED_HOST:'kamiwaza-harness.localhost',REPLAY_FORWARDED_PROTO:'https',REPLAY_COOKIE_SECURE:String(deployment.cookieSecure),REPLAY_OPERATOR_FILE_IMPORT:String(operatorImport),REPLAY_ALLOW_LEGACY_RECORDINGS:String(legacyRecordings),REPLAY_GRAPHITI_SUBJECT:subject,REPLAY_ONTOLOGY_ID:ontology};
 const variables:any[]=Object.entries(env).map(([name,value])=>({name,value}));
 if(fs.existsSync('data/platform/native-inference-secret.ready'))variables.push({name:'OPENAI_API_KEY',valueFrom:{secretKeyRef:{name:'replay-inference',key:'OPENAI_API_KEY'}}});
 if(fs.existsSync('data/platform/tomo-provider.ready'))variables.push({name:'REPLAY_TOMO_MODEL_SECRET',valueFrom:{secretKeyRef:{name:'replay-tomo-provider',key:'api_key'}}});
 if(fs.existsSync('data/platform/tomo-conversation.json')){const conversation=JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json','utf8'));for(const [name,value]of Object.entries({REPLAY_TOMO_DEPLOYMENT_ID:conversation.deploymentId,REPLAY_TOMO_AGENT_ID:conversation.agentId,REPLAY_TOMO_AGENT_NAME:conversation.agentName??'REPLAY evidence observer',REPLAY_TOMO_WATCH_HELPER:String(conversation.watchCreationEnabled===true),REPLAY_TOMO_SUBJECTS:conversation.subjects.join(',')}))variables.push({name,value});}
 if(fs.existsSync('data/platform/tomo-native-route.json')){const route=JSON.parse(fs.readFileSync('data/platform/tomo-native-route.json','utf8'));if(route.deploymentId!==variables.find((e:any)=>e.name==='REPLAY_TOMO_DEPLOYMENT_ID')?.value)throw new Error('Native model route binding differs from selected deployment');variables.push({name:'REPLAY_TOMO_SERVE_PATH',value:route.servePath});}
 if(fs.existsSync('data/platform/tomo-preview.ready'))variables.push({name:'REPLAY_TOMO_PREVIEW',value:'true'});
 const body={services:[{name:'server',image:{tag:image.split(':').at(-1),digest:''},env:variables}],annotations:{'kamiwaza.ai/deployment-stage':'MVP native identity, learning evidence and bounded workload model bridge'}};
 const result=await client.request({method:'PATCH',path:'/extensions/replay',body});
 fs.writeFileSync('evidence/platform/replay-upgrade.json',JSON.stringify({at:new Date().toISOString(),image,body,result,network:deployment.network,operatorFileImport:operatorImport,legacyRecordings},null,2));
 console.log(JSON.stringify({result:result.data,receipt:result.receipt}));
}finally{op.sessions.close();}
