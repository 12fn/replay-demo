import fs from 'node:fs';import {nativeAppClient} from './native-app-client';
const app=await nativeAppClient();try{
 const ov=await(await app.request('/api/overview')).json() as any;const ex=ov.exercises.at(-1);await app.request('/api/select',{exerciseId:ex.id});
 const bundle=await(await app.request('/api/review/export.json')).json() as any;const events=bundle.payload.events;
 const authority=events.filter((e:any)=>['agent_authorized','agent_authorization_denied','domain_retrieved','domain_unavailable'].includes(e.kind));
 const model=events.filter((e:any)=>['model_decision','tool_result','staff_model_decision','staff_tool_result','staff_update','model_error','staff_model_error'].includes(e.kind));
 const proof={at:new Date().toISOString(),exercise:bundle.payload.exercise,engine:{tick:bundle.payload.engine.tick,fingerprint:bundle.payload.engine.fingerprint},authority,model,receipts:bundle.payload.receipts,bundleHash:bundle.sha256,automatedBrowserQualification:true,humanPlaytest:false};
 fs.writeFileSync('evidence/poc/native-agent-context.json',JSON.stringify(proof,null,2));fs.writeFileSync('evidence/poc/native-learning-bundle.json',JSON.stringify(bundle));
 console.log(JSON.stringify({exerciseId:ex.id,tick:proof.engine.tick,authorizations:authority.filter((e:any)=>e.kind==='agent_authorized').length,nativeRetrievals:authority.filter((e:any)=>e.kind==='domain_retrieved').length,modelDecisions:events.filter((e:any)=>e.kind==='model_decision').length,friendlyModelUpdates:events.filter((e:any)=>e.kind==='staff_update'&&e.details.method==='model staff agent').length,receipts:proof.receipts.length,fingerprint:proof.engine.fingerprint}));
}finally{await app.close();}
