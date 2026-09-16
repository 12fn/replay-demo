import {createTomoConversationEntry,type TomoConversationOptions} from './tomo-conversation-entry';
/** Authenticated local browser preview of the installed Tomo interface.
 * GET only until its conversation route is connected to the project ledger.
 * Uses the native REPLAY HttpOnly session, fresh authority and exact-target Core ForwardAuth.
 * Browser identity headers, cookies and arbitrary targets never reach Tomo.
 */
import express from 'express';
import {KamiwazaError} from '../platform';
import {NativeSessionError} from './native-session';
import type {NativeSessionPort} from './native-http';
export const TOMO_PREFIX='/runtime/apps/replay-tomo';
export interface TomoEntryOptions { native:NativeSessionPort; frontendOrigin:string; apiOrigin:string; conversation?:Omit<TomoConversationOptions,'native'|'apiOrigin'>; }
export function createTomoEntry(opts:TomoEntryOptions):express.Router {
  for(const origin of [opts.frontendOrigin,opts.apiOrigin]){
    const url=new URL(origin);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==origin||url.username||url.password)throw new Error('Tomo requires a server-configured HTTP origin');
  }
  const router=express.Router();
  if(opts.conversation)router.use(createTomoConversationEntry({...opts.conversation,native:opts.native,apiOrigin:opts.apiOrigin}));
  router.use(async(req,res)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-REPLAY-Tomo-Mode':'read-only-preview'});
    if(req.method!=='GET'){res.status(403).json({error:{code:'tomo_preview_read_only',message:'Tomo conversation and editing are not enabled in this preview yet.'}});return;}
    const cookies=(req.headers.cookie??'').split(';').map(c=>c.trim()).filter(c=>c.startsWith('replay_session='));
    const id=cookies.length===1?cookies[0].slice('replay_session='.length):'';
    if(!/^[a-f0-9-]{36}$/.test(id)){
      res.status(401).type('html').send('<!doctype html><title>Sign in to REPLAY</title><h1>Sign in to REPLAY first</h1><p>Tomo uses your current Kamiwaza workroom identity.</p><a href="/">Open REPLAY sign-in</a>');return;
    }
    try{
      const member=await opts.native.resolve(id,{fresh:true});
      const read=member.platformClient.runtimeRead?.bind(member.platformClient);
      if(!read)throw new Error('Runtime transport unavailable');
      const api=req.path==='/api'||req.path.startsWith('/api/')||req.path.startsWith('/brand/');
      let result=await read({extension:'replay-tomo',origin:api?opts.apiOrigin:opts.frontendOrigin,path:req.url,subject:member.identity.subject});
      // The supplied static Nginx has no SPA fallback. Only extensionless client routes use its shell.
      if(!api&&result.status===404&&!req.path.split('/').at(-1)?.includes('.'))
        result=await read({extension:'replay-tomo',origin:opts.frontendOrigin,path:'/',subject:member.identity.subject});
      // Resolve again after async upstream reads so membership changes do not release stale private data.
      const fresh=await opts.native.resolve(id,{fresh:true});
      if(fresh.identity.subject!==member.identity.subject||fresh.context.workroomId!==member.context.workroomId)throw new Error('Identity changed');
      if(result.status>=300&&result.status<400){res.status(502).json({error:{code:'tomo_redirect_refused',message:'Unexpected Tomo redirect.'}});return;}
      res.status(result.status).set('Content-Type',result.contentType).send(Buffer.from(result.body));
    }catch(error){
      const status=error instanceof NativeSessionError?error.httpStatus:error instanceof KamiwazaError&&[401,403].includes(error.httpStatus??0)?error.httpStatus!:502;
      res.status(status).json({error:{code:status===401?'signed_out':status===403?'access_denied':'tomo_unavailable',message:status===401?'Sign in to REPLAY to open Tomo.':status===403?'Your current Kamiwaza session does not permit this view.':'Tomo could not be reached through native authentication.'}});
    }
  });
  return router;
}
