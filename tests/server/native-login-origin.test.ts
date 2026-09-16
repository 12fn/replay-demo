import {describe,expect,it} from 'vitest';
import {readAppConfig,nativeLoginUrl,type KamiwazaConfig} from '../../src/server/native-http';

const env={REPLAY_AUTH_MODE:'kamiwaza',REPLAY_KAMIWAZA_API:'http://core-api.kamiwaza.svc:7777/api',REPLAY_WORKROOM_ID:'synthetic-room',REPLAY_FORWARDED_HOST:'kamiwaza.local',REPLAY_PLATFORM_SSO:'true',REPLAY_ALLOWED_ORIGINS:'https://native.example,https://public.example'};
describe('native login origin is separate from signed ForwardAuth',()=>{
  it.each(['https://native.example','https://public.example/'])('uses the exact approved browser origin %s and fixed native return route',origin=>{
    const config=readAppConfig({...env,REPLAY_LOGIN_ORIGIN:origin}) as KamiwazaConfig;
    expect(config.forwardedHost).toBe('kamiwaza.local');expect(config.apiBase).toBe(env.REPLAY_KAMIWAZA_API);
    const url=new URL(nativeLoginUrl(config));expect(url.origin).toBe(new URL(origin).origin);expect(url.pathname).toBe('/login');expect([...url.searchParams]).toEqual([['redirect','/runtime/apps/replay']]);
  });
  it('retains canonical native login when no browser override is configured',()=>{
    expect(new URL(nativeLoginUrl(readAppConfig(env) as KamiwazaConfig)).origin).toBe('https://kamiwaza.local');
  });
  it.each(['http://public.example','https://user:pass@public.example','https://public.example/path','https://public.example?redirect=https://bad.example','https://public.example/#bad','https://unlisted.example','//public.example'])('fails closed on malformed or unapproved origin %s',origin=>{
    expect(()=>readAppConfig({...env,REPLAY_LOGIN_ORIGIN:origin})).toThrow();
  });
  it('does not introduce native login into local demo mode',()=>{
    expect(()=>readAppConfig({REPLAY_LOGIN_ORIGIN:'https://public.example',REPLAY_ALLOWED_ORIGINS:'https://public.example'})).toThrow('requires native');
  });
  it('rejects credential-bearing allowed origins instead of silently stripping credentials',()=>{
    expect(()=>readAppConfig({...env,REPLAY_ALLOWED_ORIGINS:'https://user:pass@public.example'})).toThrow('without credentials');
  });
});
