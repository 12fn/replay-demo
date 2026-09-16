/** Real component, explicit synthetic request and navigation ports; never calls native auth or an external site. */
import {createRoot} from 'react-dom/client';
import {NativeSwitchUser} from '../../src/client/components/NativeSwitchUser';
import '../../src/client/styles.css';import '../../src/client/native.css';
const root=createRoot(document.getElementById('root')!),out=document.getElementById('qa-observation')!;
const loginUrl='https://native.example/login?redirect=%2Fruntime%2Fapps%2Freplay';
let requests=0,resets=0,cancels=0,navigation:string|null=null,mode='success',mount=0;
const show=()=>{out.textContent=JSON.stringify({requests,resets,cancels,navigation,mode});};
window.fetch=async input=>{if(input!=='/api/native/switch-user')throw new Error('Fixture refuses every other endpoint');requests++;show();await new Promise(resolve=>setTimeout(resolve,750));if(mode==='network')throw new Error('Synthetic network unavailable');return new Response(JSON.stringify({signedIn:false,replayTokenBlocked:true,platformCookiesCleared:true,nativeSessionTerminationRequested:mode==='success',loginUrl}),{status:mode==='failure'?502:200});};
const render=()=>{mount++;root.render(<NativeSwitchUser key={mount} loginUrl={loginUrl} onCancel={()=>{cancels++;show();}} onSignedOut={()=>{resets++;show();}} navigate={url=>{navigation=url;show();}}/>);show();};
for(const choice of ['success','failure','network']){const button=document.createElement('button');button.textContent='QA '+choice;button.onclick=()=>{mode=choice;requests=0;resets=0;cancels=0;navigation=null;render();};document.getElementById('qa-controls')!.append(button);}
render();
