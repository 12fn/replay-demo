/** Register the member-forwarding MCP proxy through the installed native Extension API. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {operatorClient,binding} from './operator-client';
import type {KamiwazaClient,CreateExtension} from '../../src/platform';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version));
const artifact=`evidence/platform/replay-tool-${version}.json`;assert(!fs.existsSync(artifact),'Preserve existing registration receipt');
const op=await operatorClient();
try{
 const client=op.resolved.platformClient as KamiwazaClient;
 const app=await client.request<any>({method:'GET',path:'/extensions/replay'});
 const upstream=new URL('/mcp',app.data.endpoints.internal).toString();
 assert(upstream==='http://replay-server.kamiwaza-extensions.svc.cluster.local:5181/mcp','Verify an unexpected upstream before registering it');
 const list=await client.listExtensions({workroomId:binding.workroom.id});
 const existing=list.data.find(e=>e.name==='replay-tools');assert(!existing,'Existing tool registration must be inspected and updated, not duplicated');
 const spec:CreateExtension={name:'replay-tools',type:'tool',version,workroom_id:binding.workroom.id,
  services:[{name:'mcp',image:`localhost/replay:${version}`,primary:true,command:['node','services/mcp-proxy/server.mjs'],ports:[{container_port:5181,protocol:'TCP'}],replicas:1,
   env:[{name:'PORT',value:'5181'},{name:'REPLAY_MCP_UPSTREAM',value:upstream}],
   resources:{requests:{cpu:'50m',memory:'64Mi'},limits:{cpu:'500m',memory:'256Mi'}},
   automountServiceAccountToken:false,containerSecurityContext:{runAsNonRoot:true,runAsUser:1000,allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}},
   healthCheck:{httpGet:{path:'/health',port:5181},initialDelaySeconds:3,periodSeconds:10}}],
  kamiwaza:{namespace:'kamiwaza',api_url:'http://core-api.kamiwaza.svc:7777',public_api_url:'https://kamiwaza-harness.localhost',use_auth:'true'},
  networking:{ingress_enabled:false},security:{risk_tier:1,source_type:'user_repo',verified:false},
  annotations:{'kamiwaza.ai/title':'REPLAY · member-scoped exercise read tools','kamiwaza.ai/deployment-stage':'MCP proxy foundation; live Tomo conversation qualification pending'}};
 const result=await client.createExtension(spec);
 const proof={at:new Date().toISOString(),request:spec,response:result.data,receipt:result.receipt,noPersistence:true,noWorkloadCredential:true,upstreamValidation:'Calling member bearer is validated by REPLAY; proxy grants no identity',limitations:['Creation is not readiness or Tomo discovery proof.']};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify(proof));
}finally{op.sessions.close();}
