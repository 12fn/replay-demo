import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {operatorClient,binding} from './operator-client';
import type {KamiwazaClient} from '../../src/platform';
const op=await operatorClient();
try{
 const client=op.resolved.platformClient as KamiwazaClient;
 const secretFile='data/platform/graph-secrets.json';
 const secrets=fs.existsSync(secretFile)?JSON.parse(fs.readFileSync(secretFile,'utf8')):{neo4j:randomBytes(32).toString('hex'),bridge:randomBytes(32).toString('hex')};
 fs.writeFileSync(secretFile,JSON.stringify(secrets),{mode:0o600});
 const existing=await client.listOntologies({workroomId:binding.workroom.id});
 let result:any;
 if(existing.data.length)result=existing.data[0];
 else {
 const response=await client.request<any>({method:'POST',path:'/context/ontologies',workroomId:binding.workroom.id,body:{name:'replay-learning-evidence',backend:'graphiti',workroom_id:binding.workroom.id,config:{AUTO_LINK_PLATFORM_MODELS:'false',NEO4J_PASSWORD:secrets.neo4j,OPENAI_API_KEY:secrets.bridge,OPENAI_BASE_URL:'http://replay-server.kamiwaza-extensions.svc:5181/internal/graph/v1',LLM_BASE_URL:'http://replay-server.kamiwaza-extensions.svc:5181/internal/graph/v1',KAMIWAZA_ENDPOINT:'http://replay-server.kamiwaza-extensions.svc:5181/internal/graph/v1',MODEL_NAME:'gpt-5.6-luna',EMBEDDING_BASE_URL:'http://replay-embeddings-server.kamiwaza-extensions.svc:8000/v1',EMBEDDING_MODEL_NAME:'BAAI/bge-small-en-v1.5',EMBEDDING_DIM:'384',MESSAGES_MAX_BATCH:'4',MESSAGES_TIMEOUT_SECS:'180'}}});result=response.data;
 }
 fs.writeFileSync('data/platform/ontology-instance.json',JSON.stringify(result,null,2),{mode:0o600});
 const {config,...publicResult}=result;
 fs.writeFileSync('evidence/platform/ontology-created.json',JSON.stringify({at:new Date().toISOString(),instance:publicResult,modelRouting:'Explicit local CPU embeddings and app-metered Luna bridge; ready checks pending'},null,2));
 console.log(JSON.stringify(publicResult));
}finally{op.sessions.close();}
