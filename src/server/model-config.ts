import fs from 'node:fs';
import path from 'node:path';
import {assertLocalRoute} from '../inference/local-route';

export function readModelRoute(dataDir:string,env:NodeJS.ProcessEnv=process.env){
  const local=env.REPLAY_MODEL_BILLING==='local';
  if(env.REPLAY_MODEL_BILLING && !['local','external'].includes(env.REPLAY_MODEL_BILLING))throw new TypeError('Unsupported REPLAY_MODEL_BILLING');
  if(local){
    if(env.REPLAY_MODEL_TRANSPORT!=='chat-completions')throw new TypeError('Local inference requires chat-completions transport');
    assertLocalRoute(env.REPLAY_MODEL_BASE_URL,env.REPLAY_MODEL_ID);
    return {local:true,baseUrl:env.REPLAY_MODEL_BASE_URL!,model:env.REPLAY_MODEL_ID!,apiKey:env.REPLAY_MODEL_API_KEY??'',ledgerFile:'local-inference.sqlite',maxUsd:0,timeoutMs:120000};
  }
  if(env.REPLAY_MODEL_TRANSPORT && env.REPLAY_MODEL_TRANSPORT!=='responses')throw new TypeError('External route requires responses transport');
  let key=env.OPENAI_API_KEY??'';
  const file=env.REPLAY_KEY_FILE??path.join(dataDir,'luna.env');
  if(!key&&fs.existsSync(file)){const m=fs.readFileSync(file,'utf8').match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)$/m);if(m)key=m[1].trim().replace(/^['"]|['"]$/g,'');}
  return {local:false,baseUrl:env.REPLAY_MODEL_BASE_URL,model:undefined,apiKey:key,ledgerFile:'inference.sqlite',maxUsd:5,timeoutMs:25000};
}
