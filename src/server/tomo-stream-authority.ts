/** Recheck idle stream authority too. No overlapping checks; slow or failed renewal closes the stream. */
export function watchTomoStreamAuthority(renew:()=>Promise<unknown>, revoke:()=>void, intervalMs=5000, timeoutMs=15000){
 if(!Number.isInteger(intervalMs)||intervalMs<10||intervalMs>30000)throw new Error('Invalid stream authority interval');
 let stopped=false,busy=false,deadline:ReturnType<typeof setTimeout>|undefined;
 const timer=setInterval(()=>{if(stopped||busy)return;busy=true;
  void Promise.race([Promise.resolve().then(renew),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('authority-timeout')),timeoutMs);})])
   .catch(()=>{if(!stopped){stopped=true;clearInterval(timer);revoke();}})
   .finally(()=>{if(deadline)clearTimeout(deadline);deadline=undefined;busy=false;});
 },intervalMs);
 timer.unref();
 return ()=>{stopped=true;clearInterval(timer);if(deadline)clearTimeout(deadline);};
}
