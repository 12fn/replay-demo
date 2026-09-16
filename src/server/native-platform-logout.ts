import type {FetchImpl} from '../platform/index';

export const NATIVE_COOKIE_NAMES=['access_token','access_token_refresh','access_token_refresh_ts','access_token_id'] as const;
const cookieNames=new Set<string>(NATIVE_COOKIE_NAMES);
export interface PlatformLogoutResult {sessionTerminationRequested:boolean}

/** Forward only the four native cookie fields, never app cookies, unrelated credentials or caller headers. */
export function nativeLogoutCookies(raw:string):string {
  const found=new Map<string,string>();
  for(const part of raw.split(';')){
    const cookie=part.trim(),equals=cookie.indexOf('=');if(equals<1)continue;
    const name=cookie.slice(0,equals);if(!cookieNames.has(name))continue;
    const value=cookie.slice(equals+1);
    if(found.has(name)||value.length>16384||!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value))throw new Error('Ambiguous native cookies');
    found.set(name,value);
  }
  return NATIVE_COOKIE_NAMES.filter(name=>found.has(name)).map(name=>`${name}=${found.get(name)}`).join('; ');
}

/** Native logout omits access_token_id; explicitly clear all four known names at both actual scopes. */
export function nativeCookieExpirations(hostname:string):string[] {
  if(!/^[a-z0-9.-]+$/i.test(hostname))throw new Error('Invalid native cookie domain');
  return NATIVE_COOKIE_NAMES.flatMap(name=>[true,false].map(domain=>`${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Strict${domain?`; Domain=.${hostname}`:''}`));
}

/** Requests native refresh/session termination. The installed Core may still accept an old access JWT. */
export async function requestNativeLogout(opts:{apiBase:string;forwardedHost:string;forwardedProto:string;cookieHeader:string;fetchImpl:FetchImpl;timeoutMs:number}):Promise<PlatformLogoutResult> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const base=new URL(opts.apiBase);
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!/^\/api\/?$/.test(base.pathname))return {sessionTerminationRequested:false};
    const cookie=nativeLogoutCookies(opts.cookieHeader);
    if(!cookie)return {sessionTerminationRequested:false};
    const nativeOrigin=new URL(`${opts.forwardedProto}://${opts.forwardedHost}`);
    const work=async()=>{
      const response=await opts.fetchImpl(new URL('/api/auth/logout',base).href,{method:'POST',redirect:'error',credentials:'omit',signal:controller.signal,
        headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:cookie,Origin:nativeOrigin.origin},
        body:JSON.stringify({reason:'user_logout',revoke_token:true,post_logout_redirect_uri:new URL('/login',nativeOrigin).href})});
      if(!response.ok)return {sessionTerminationRequested:false};
      const body=await response.json() as {session_termination_requested?:unknown;front_channel_logout_url?:unknown};
      if(controller.signal.aborted||body?.session_termination_requested!==true||typeof body.front_channel_logout_url!=='string')return {sessionTerminationRequested:false};
      // Installed native flow: front-channel -> native realm logout -> login. Never follow arbitrary redirects.
      let next=body.front_channel_logout_url;
      const paths=['/api/auth/logout/front-channel','/realms/kamiwaza/protocol/openid-connect/logout','/login'];
      for(const [index,path] of paths.entries()){
        if(controller.signal.aborted)return {sessionTerminationRequested:false};
        const url=new URL(next,nativeOrigin);
        if(url.origin!==nativeOrigin.origin||url.pathname!==path||url.username||url.password||url.hash)return {sessionTerminationRequested:false};
        for(const key of ['redirect_uri','post_logout_redirect_uri']){
          const redirect=url.searchParams.get(key);if(redirect&&new URL(redirect,nativeOrigin).href!==new URL('/login',nativeOrigin).href)return {sessionTerminationRequested:false};
        }
        const step=await opts.fetchImpl(url.href,{method:'GET',redirect:'manual',credentials:'omit',signal:controller.signal,headers:{Cookie:cookie,Origin:nativeOrigin.origin}});
        await step.body?.cancel();
        if(index===paths.length-1)return {sessionTerminationRequested:step.status===200};
        if(step.status!==302||!step.headers.get('location'))return {sessionTerminationRequested:false};
        next=step.headers.get('location')!;
      }
      return {sessionTerminationRequested:false};
    };
    return await Promise.race([work(),new Promise<PlatformLogoutResult>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({sessionTerminationRequested:false});},opts.timeoutMs);})]);
  }catch{return {sessionTerminationRequested:false};}
  finally{if(timer)clearTimeout(timer);controller.abort();}
}
