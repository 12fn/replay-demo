import {describe,expect,it,vi} from 'vitest';
import {NATIVE_COOKIE_NAMES,nativeLogoutCookies,nativeCookieExpirations,requestNativeLogout} from '../../src/server/native-platform-logout';

const base={apiBase:'https://kamiwaza.local/api',forwardedHost:'kamiwaza.local',forwardedProto:'https',cookieHeader:'access_token=synthetic.jwt.value; access_token_refresh=synthetic-refresh; unrelated=omit; replay_session=omit',timeoutMs:100};
describe('native logout cookie boundaries',()=>{
  it('forwards only native cookie values, never app or unrelated cookies',()=>{
    expect(nativeLogoutCookies('replay_session=app; access_token=synthetic.jwt.value; unrelated=private; access_token_refresh=synthetic-refresh; access_token_refresh_ts=1; access_token_id=synthetic-id')).toBe('access_token=synthetic.jwt.value; access_token_refresh=synthetic-refresh; access_token_refresh_ts=1; access_token_id=synthetic-id');
  });
  it.each(['access_token=a; access_token=b','access_token=a\nb','access_token='+('a'.repeat(16385))])('rejects ambiguous, invalid or oversized cookies without echoing values',cookie=>{
    expect(()=>nativeLogoutCookies(cookie)).toThrow('Ambiguous native cookies');
  });
  it('expires all four known cookie names at the actual native domain and host-only scopes, including native-omitted id',()=>{
    const values=nativeCookieExpirations('kamiwaza.local');expect(values).toHaveLength(8);
    for(const name of NATIVE_COOKIE_NAMES){const matches=values.filter(value=>value.startsWith(name+'='));expect(matches).toHaveLength(2);expect(matches.filter(value=>value.includes('Domain=.kamiwaza.local'))).toHaveLength(1);for(const value of matches){expect(value).toContain('Max-Age=0');expect(value).toContain('Path=/; HttpOnly; Secure; SameSite=Strict');}}
  });
  it('uses the fixed private logout endpoint, current native cookies and native-origin login; follows only the qualified canonical native continuation and exposes no private URLs',async()=>{
    const fetchImpl=vi.fn(async(input:unknown)=>{const url=String(input);if(url.endsWith('/api/auth/logout'))return new Response(JSON.stringify({session_termination_requested:true,front_channel_logout_url:'/api/auth/logout/front-channel?private=must-not-leave'}));if(url.includes('/front-channel?'))return new Response(null,{status:302,headers:{location:'/realms/kamiwaza/protocol/openid-connect/logout?private=native-only'}});if(url.includes('/realms/'))return new Response(null,{status:302,headers:{location:'/login'}});return new Response('Native login HTML');});
    const result=await requestNativeLogout({...base,fetchImpl});expect(result).toEqual({sessionTerminationRequested:true});expect(fetchImpl).toHaveBeenCalledTimes(4);
    const [url,init]=fetchImpl.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://kamiwaza.local/api/auth/logout');expect(init.redirect).toBe('error');expect(init.headers).toMatchObject({Cookie:'access_token=synthetic.jwt.value; access_token_refresh=synthetic-refresh',Origin:'https://kamiwaza.local'});expect(JSON.parse(String(init.body))).toEqual({reason:'user_logout',revoke_token:true,post_logout_redirect_uri:'https://kamiwaza.local/login'});
  });
  it.each(['false','missing','malformed','error','redirect'])('does not claim native termination for %s response',async kind=>{
    const fetchImpl=async()=>new Response(kind==='malformed'?'not-json':JSON.stringify(kind==='false'?{session_termination_requested:false}:{}),{status:kind==='error'?503:kind==='redirect'?302:200});expect(await requestNativeLogout({...base,fetchImpl})).toEqual({sessionTerminationRequested:false});
  });
  it.each(['https://attacker.example/api/auth/logout/front-channel','/api/other','/api/auth/logout/front-channel?post_logout_redirect_uri=https://attacker.example'])('rejects an unexpected native continuation %s',async url=>{const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({session_termination_requested:true,front_channel_logout_url:url})));expect(await requestNativeLogout({...base,fetchImpl})).toEqual({sessionTerminationRequested:false});expect(fetchImpl).toHaveBeenCalledOnce();});
  it('bounds a hung provider, including a fetch implementation that ignores abort',async()=>{
    const result=await requestNativeLogout({...base,timeoutMs:5,fetchImpl:()=>new Promise(()=>{})});expect(result).toEqual({sessionTerminationRequested:false});
  });
  it('does not convert a cookie-less retry into successful termination of a prior session',async()=>{
    const fetchImpl=vi.fn();expect(await requestNativeLogout({...base,cookieHeader:'replay_session=opaque',fetchImpl})).toEqual({sessionTerminationRequested:false});expect(fetchImpl).not.toHaveBeenCalled();
  });
});
