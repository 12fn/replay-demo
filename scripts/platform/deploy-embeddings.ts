import fs from 'node:fs';
import {operatorClient,binding} from './operator-client';
const op=await operatorClient();
try{
 const client=op.resolved.platformClient;
 const subject=JSON.parse(fs.readFileSync('evidence/platform/graphiti-service-identity.json','utf8')).signedIdentity['x-user-id'];
 const existing=await client.listExtensions({workroomId:binding.workroom.id});
 if(existing.data.some(x=>x.name==='replay-embeddings')){console.log('Embedding extension already registered');process.exitCode=0;}
 else {
 const response=await client.createExtension({name:'replay-embeddings',type:'service',version:'0.1.1',workroom_id:binding.workroom.id,services:[{name:'server',image:'localhost/replay-embeddings:0.1.1',primary:true,ports:[{container_port:8000,protocol:'TCP'}],replicas:1,resources:{requests:{cpu:'100m',memory:'256Mi'},limits:{cpu:'2',memory:'1Gi'}},env:[{name:'REPLAY_GRAPHITI_SUBJECT',value:subject},{name:'REPLAY_KAMIWAZA_API',value:'http://core-api.kamiwaza.svc:7777/api'}],containerSecurityContext:{runAsNonRoot:true,runAsUser:65532,allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},healthCheck:{httpGet:{path:'/health',port:8000},initialDelaySeconds:10,periodSeconds:15}}],kamiwaza:{namespace:'kamiwaza',api_url:'http://core-api.kamiwaza.svc:7777',use_auth:'true'},networking:{ingress_enabled:false},security:{risk_tier:1,source_type:'user_repo',verified:false},annotations:{'kamiwaza.ai/title':'REPLAY local CPU embeddings','kamiwaza.ai/model':'BAAI/bge-small-en-v1.5 · 384 dimensions'}} as any);
 fs.writeFileSync('evidence/platform/embedding-extension.json',JSON.stringify({at:new Date().toISOString(),...response},null,2));console.log(JSON.stringify({name:response.data.name,receipt:response.receipt}));
 }
}finally{op.sessions.close();}
