import {createElement} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {NativeSignIn} from '../../src/client/components/NativeSignIn';
import {NativeSwitchUser} from '../../src/client/components/NativeSwitchUser';
import {checkedNativeLoginUrl,switchNativeAccount} from '../../src/client/native-switch';
import type {NativeStatus} from '../../src/client/native-api';

const loginUrl='https://native.example/login?redirect=%2Fruntime%2Fapps%2Freplay';
afterEach(()=>vi.unstubAllGlobals());
describe('confirmed native account switch',()=>{
  it('makes no request until confirmation, and explains preservation of saved records',()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const html=renderToStaticMarkup(createElement(NativeSwitchUser,{loginUrl,onCancel:()=>{},onSignedOut:()=>{}}));
    expect(fetch).not.toHaveBeenCalled();expect(html).toContain('Stay signed in');expect(html).toContain('Your exercise records remain saved');expect(html).toContain('role="dialog"');
  });
  it('clears local navigation only after confirmed app sign-out and navigates only after confirmed platform sign-out',async()=>{
    const order:string[]=[];
    const fetch=vi.fn(async()=>new Response(JSON.stringify({signedIn:false,nativeSessionTerminationRequested:true,platformCookiesCleared:true,replayTokenBlocked:true,loginUrl}),{status:200}));vi.stubGlobal('fetch',fetch);
    await switchNativeAccount(loginUrl,()=>order.push('reset'),url=>order.push(url));
    expect(order).toEqual(['reset',loginUrl]);
    expect(fetch).toHaveBeenCalledWith('/api/native/switch-user',expect.objectContaining({method:'POST',body:'{}',cache:'no-store'}));
  });
  it('keeps an upstream revoke failure visible, resets the signed-out app, and never redirects',async()=>{
    vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({signedIn:false,nativeSessionTerminationRequested:false,platformCookiesCleared:true,replayTokenBlocked:true,error:'native internals must not become UI'}),{status:502}));
    const reset=vi.fn(),navigate=vi.fn();
    await expect(switchNativeAccount(loginUrl,reset,navigate)).rejects.toThrow('REPLAY is signed out and browser cookies are cleared. Kamiwaza session termination was not confirmed');
    expect(reset).toHaveBeenCalledOnce();expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['network','malformed','refused'])('does not claim local sign-out or navigate after %s uncertainty',async kind=>{
    vi.stubGlobal('fetch',async()=>{if(kind==='network')throw new Error('private network detail');return new Response(kind==='malformed'?'not json':JSON.stringify({error:'denied'}),{status:503});});
    const reset=vi.fn(),navigate=vi.fn();await expect(switchNativeAccount(loginUrl,reset,navigate)).rejects.toThrow('Could not confirm sign-out');expect(reset).not.toHaveBeenCalled();expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.example/login?redirect=%2Fruntime%2Fapps%2Freplay','http://native.example/login?redirect=%2Fruntime%2Fapps%2Freplay','https://user:pass@native.example/login?redirect=%2Fruntime%2Fapps%2Freplay','https://native.example/login?redirect=https://attacker.example','https://native.example/login?redirect=%2Fruntime%2Fapps%2Freplay&extra=1','https://native.example/login?redirect=%2Fruntime%2Fapps%2Freplay#fragment'])('rejects an unapproved login destination %s',value=>{
    expect(()=>checkedNativeLoginUrl(value,loginUrl)).toThrow();
    if(!value.includes('attacker.example/login'))expect(()=>checkedNativeLoginUrl(value,value)).toThrow();
  });
  it('shows native entry and switch on the SSO gate without password or persona inputs',()=>{
    const status:NativeStatus={mode:'kamiwaza',platformSso:true,platformLoginUrl:loginUrl,platformSwitchAvailable:true,signedIn:false,workroomId:'synthetic-room',identity:null,context:null,metadata:null,denial:null};
    const html=renderToStaticMarkup(createElement(NativeSignIn,{status,denied:{status:401,message:'Signed out'},onChange:async()=>{},onSwitchUser:()=>{}}));
    expect(html).toContain('Sign in to Kamiwaza');expect(html).toContain('Switch user');expect(html).not.toContain('type="password"');expect(html).not.toContain('<select');expect(html).not.toContain('credential-file');
  });
});
