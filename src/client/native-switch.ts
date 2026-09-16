import {nativeApi} from './native-api';

/** Only the server-advertised, fixed native login route may become a navigation. */
export function checkedNativeLoginUrl(value:unknown,expected:string|undefined):string {
  if(typeof value!=='string'||value!==expected)throw new Error('Kamiwaza login address could not be verified. Reload REPLAY to recover.');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.pathname!=='/login'||url.searchParams.size!==1||url.searchParams.get('redirect')!=='/runtime/apps/replay')throw new Error('Kamiwaza login address could not be verified. Reload REPLAY to recover.');
  return url.href;
}

export async function switchNativeAccount(expectedLoginUrl:string|undefined,onSignedOut:()=>void,navigate:(url:string)=>void):Promise<void> {
  const result=await nativeApi.switchUser();
  onSignedOut(); // The server confirmed the app session was cleared, even if platform revocation failed.
  if(!result.nativeSessionTerminationRequested)throw new Error('REPLAY is signed out and browser cookies are cleared. Kamiwaza session termination was not confirmed. You can open Kamiwaza sign-in to recover.');
  navigate(checkedNativeLoginUrl(result.loginUrl,expectedLoginUrl));
}
