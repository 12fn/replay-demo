import {mountShowcaseRoutes} from './showcase-routes';
import {createTomoNativeModelRoute} from './tomo-native-model-route';
import {createTomoModelBridge} from './tomo-model-bridge';
import {createTomoEntry,TOMO_PREFIX} from './tomo-entry';
import {createTomoBindingRegistry,TOMO_BINDINGS_FILE} from './tomo-pilot-bindings';
import {CampaignService} from './campaign-service';
import {mountCampaignRoutes} from './campaign-routes';
import {mountNativeAgentBindings} from './native-agent-bindings';
import {mountMcpRoutes} from './mcp-routes';
import {McpBearerResolver} from './mcp-auth';
import {mountActionOptionsRoutes} from './action-options-routes';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {mountReviewRoutes} from './review-routes';
import {mountCatalogRoutes} from './catalog-routes';
import {mountCatalogGraphRoutes} from './catalog-graph';
import {mountPracticeHistoryRoutes} from './practice-history-routes';
import {mountLearningRoutes} from './learning-routes';
import {mountReviewFeedbackRoutes} from './review-feedback-routes';
import {mountOntologyRoutes} from './ontology-routes';
import {mountAgentRoutes} from './agent-routes';
import {mountRecordingRoutes} from './recording-routes';
import {mountGraphBridge} from './graph-bridge';
import {verifyGraphitiWorkload} from './workload-auth';
import { GameService } from './service';
import { NativeSessions } from './native-session';
import { NativeConfigError, createApp, readAppConfig } from './native-http';

console.debug=()=>{};
const root=process.cwd();

// Authentication mode is decided before any service starts. A partial native configuration is fatal,
// never a silent downgrade to local demo identities.
let config:ReturnType<typeof readAppConfig>;
try{config=readAppConfig(process.env);}
catch(e){if(e instanceof NativeConfigError){console.error(`REPLAY refused to start: ${e.message}`);process.exit(2);}throw e;}

const dataDir=process.env.REPLAY_DATA_DIR??path.join(root,'data');
const service=new GameService(dataDir);
await service.init();
const campaigns=new CampaignService(service);
const native=config.mode==='kamiwaza'
  ?new NativeSessions({dataDir:path.join(dataDir,'native'),apiBase:config.apiBase,validationApiBase:config.validationApiBase,workroomId:config.workroomId,forwardedHost:config.forwardedHost,forwardedProto:config.forwardedProto})
  :null;
const tomoModelId=process.env.REPLAY_TOMO_DEPLOYMENT_ID;
const tomoAgentId=process.env.REPLAY_TOMO_AGENT_ID;
const tomoAgentName=process.env.REPLAY_TOMO_AGENT_NAME??'REPLAY evidence observer';
const tomoSubjects=(process.env.REPLAY_TOMO_SUBJECTS??'').split(',').filter(Boolean);
const tomoMemberTools=['get_exercise_state','get_replay_provenance','search_practice_history','search_practice_details','search_catalog','get_catalog_record',...(process.env.REPLAY_MCP_WATCH_WRITE==='true'?['create_watch']:[])].map(n=>'kz_replay-tools_replay_'+n);
if(tomoModelId&&(!tomoAgentId||!tomoSubjects.length||!process.env.REPLAY_TOMO_MODEL_SECRET))throw new Error('Tomo conversation configuration incomplete');
// One resolver for conversation entry, native model route and status. File presence selects registry mode;
// a missing file keeps the env subjects/single helper above. See docs/operator-tomo-member-bindings.md.
const tomoBindings=createTomoBindingRegistry({file:path.join(dataDir,TOMO_BINDINGS_FILE),workroomId:config.mode==='kamiwaza'?config.workroomId:null,legacy:{subjects:tomoSubjects,agentId:tomoAgentId,agentName:tomoAgentName},
 onInvalid:code=>console.error(`REPLAY Tomo member binding registry refused (${code}); all Tomo conversation and native model routing is denied until it is corrected.`)});
const app=createApp({service,config,native,root,operatorFileImport:process.env.REPLAY_OPERATOR_FILE_IMPORT==='true',
 mountAuthorized(app){mountNativeAgentBindings(app,service);},
 mountInternal(app){
  if(process.env.REPLAY_TOMO_PREVIEW==='true'){
   if(!native)throw new Error('Tomo browser entry requires native Kamiwaza authentication');
   app.use(TOMO_PREFIX,createTomoEntry({native,frontendOrigin:'http://replay-tomo-frontend.kamiwaza-extensions.svc.cluster.local:8080',apiOrigin:'http://replay-tomo-api-backend.kamiwaza-extensions.svc.cluster.local:8000',...(tomoModelId?{conversation:{modelId:tomoModelId,agentId:tomoAgentId,subjects:tomoSubjects,bindings:tomoBindings,toolNames:tomoMemberTools,onDispatch:event=>service.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`tomo-input-receipt:${event.receipt.clientRequestId}`,JSON.stringify(event))}}:{})}));
  }
  if(process.env.REPLAY_TOMO_SERVE_PATH){
   if(config.mode!=='kamiwaza'||!tomoModelId)throw new Error('Native Tomo routing requires Kamiwaza and a verified model deployment');
   app.use('/internal/tomo-native-route',createTomoNativeModelRoute({auth:new McpBearerResolver({assertTokenAllowed:token=>app.locals.assertNativeTokenAllowed(token),apiBase:config.apiBase,validationApiBase:config.validationApiBase,workroomId:config.workroomId,forwardedHost:config.forwardedHost,forwardedProto:config.forwardedProto}),apiBase:config.apiBase,forwardedHost:config.forwardedHost,forwardedProto:config.forwardedProto,deploymentId:tomoModelId,servePath:process.env.REPLAY_TOMO_SERVE_PATH,subjects:tomoSubjects,bindings:tomoBindings,onAudit:event=>service.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`tomo-native-route:${event.nativeReceipt.clientRequestId}`,JSON.stringify(event))}));
  }
  if(config.mode==='kamiwaza')mountMcpRoutes(app,{service,config,enableWatchTool:process.env.REPLAY_MCP_WATCH_WRITE==='true',auth:new McpBearerResolver({assertTokenAllowed:token=>app.locals.assertNativeTokenAllowed(token),apiBase:config.apiBase,validationApiBase:config.validationApiBase,workroomId:config.workroomId,forwardedHost:config.forwardedHost,forwardedProto:config.forwardedProto}),version:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version});
  if(process.env.REPLAY_TOMO_MODEL_SECRET){
   if(config.mode!=='kamiwaza')throw new Error('Tomo provider requires native deployment');
   const toolNames=[...tomoMemberTools,'tool_search','kamiwaza_mcp_catalog','search_about','list_available_agents','kamiwaza_connector_catalog','create_artifact','update_artifact','show_widget','visualize_read_me'];
   app.use('/internal/tomo-provider/v1',createTomoModelBridge({workload:{secret:process.env.REPLAY_TOMO_MODEL_SECRET,subject:'kamiwaza-core-serving:replay-tomo-luna',workroomId:config.workroomId},luna:service.lunaChat,ledger:service.ledger,exposedModel:'replay-tomo-luna',toolNames,maxRequests:26,onAudit:event=>service.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`tomo-model-receipt:${event.requestId}`,JSON.stringify({...event,at:new Date().toISOString()}))}));
  }
  const graphSubject=process.env.REPLAY_GRAPHITI_SUBJECT;
  mountGraphBridge(app,{luna:service.luna,ledger:service.ledger,secret:null,
   enabled:config.mode==='kamiwaza'&&!!graphSubject,
   clampRequestedTokens:true,
   maxQueuedRequests:24,maxGraphRequests:40,
   authorizeWorkload:config.mode==='kamiwaza'&&graphSubject?async authorization=>!!(await verifyGraphitiWorkload(authorization,{apiBase:config.apiBase,validationApiBase:config.validationApiBase,subject:graphSubject,forwardedHost:config.forwardedHost})):undefined,
   onReceipt:event=>service.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`graph-receipt:${event.requestId}`,JSON.stringify({...event,at:new Date().toISOString()})),
  });
 },
 mount(app){
  mountShowcaseRoutes(app,service);
  mountPracticeHistoryRoutes(app,service,config);
  mountCatalogRoutes(app,service);
  mountCatalogGraphRoutes(app);
  app.get('/api/tomo/status',(_req,res)=>{void tomoBindings.resolve({subject:res.locals.identity.subject,workroomId:res.locals.native?.context.workroomId}).then(bound=>{
   // Mapping readiness only: the file cannot prove helper ownership. Tomo enforces that per member; native authority is checked per operation.
   const conversation=!!tomoModelId&&bound.state==='bound';
   res.json({enabled:process.env.REPLAY_TOMO_PREVIEW==='true',mode:conversation?'scoped-conversation':'read-only-preview',path:TOMO_PREFIX+'/',modelName:conversation?(service.localInference?'Kamiwaza deployed model':'Connected model'):null,agentName:conversation?bound.binding.agentName:null,watchCreationEnabled:conversation&&process.env.REPLAY_TOMO_WATCH_HELPER==='true'&&process.env.REPLAY_MCP_WATCH_WRITE==='true',
    helperBinding:{source:bound.source,state:bound.state,helperOwnershipVerified:false}});
  },()=>res.status(503).json({error:{code:'tomo_status_unavailable',message:'Tomo status could not be read.'}}));});
  mountActionOptionsRoutes(app,service);
  mountCampaignRoutes(app,campaigns,native);
  const guards=app.locals.guards;
  app.use('/api/learning',guards.requireActive,(req,res,next)=>{
   if(req.method==='GET')return next();
   return (req.path==='/debrief'?guards.requireAgents:guards.requireWrite)(req,res,next);
  });
  mountLearningRoutes(app,service);
  mountReviewFeedbackRoutes(app,service);
  app.use('/api/agents',guards.requireActive,(req,res,next)=>{
   if(req.method==='GET')return next();
   return (req.body?.enabled===true?guards.requireAgents:guards.requireWrite)(req,res,next);
  });
  mountAgentRoutes(app,service);
  mountOntologyRoutes(app,service);
  mountRecordingRoutes(app,service);
  mountReviewRoutes(app,service);
 }
});
const port=Number(process.env.PORT??5181);
const server=app.listen(port,process.env.REPLAY_HOST??'127.0.0.1',()=>console.log(`REPLAY API ready on port ${port}. Auth mode: ${config.mode}${config.mode==='kamiwaza'?` (workroom ${config.workroomId})`:''}. Paid inference off by default.`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close();native?.close();service.close();process.exit(0);});
