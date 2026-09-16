import {useEffect,useRef,useState} from 'react';
import {captureAppFrame} from '../capture/frame';
import '../capture.css';
type Run={recorder:MediaRecorder;stream:MediaStream;chunks:Blob[];started:number;frames:number;failed:number;bytes:number;stopping:boolean;discard:boolean;timer?:number;};
export function AppRecorder(){
 const run=useRef<Run|null>(null),caption=useRef('');
 const [open,setOpen]=useState(false),[status,setStatus]=useState('idle'),[elapsed,setElapsed]=useState(0),[error,setError]=useState(''),[saved,setSaved]=useState<any>(null);
 const stop=(discard=false)=>{const r=run.current;if(!r||r.stopping)return;r.stopping=true;r.discard=discard;window.clearTimeout(r.timer);setStatus(discard?'discarding':'saving');if(r.recorder.state!=='inactive')r.recorder.stop();};
 useEffect(()=>()=>{const r=run.current;if(r){r.discard=true;r.stopping=true;clearTimeout(r.timer);if(r.recorder.state!=='inactive')r.recorder.stop();r.stream.getTracks().forEach(t=>t.stop());}},[]);
 const start=async()=>{
  if(run.current)return;setError('');setSaved(null);setStatus('starting');
  try{
   if(!('MediaRecorder'in window))throw new Error('This browser does not support video recording.');
   const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/mp4','video/webm'].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)throw new Error('This browser does not provide a supported video encoder.');
   const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const context=canvas.getContext('2d')!;
   const draw=async()=>{const root=document.getElementById('root');if(!root||document.querySelector('.native-gate'))throw new Error('Sign in before recording.');
    const img=await captureAppFrame(root);context.fillStyle='#101a29';context.fillRect(0,0,1280,720);
    const scale=Math.min(1280/img.width,680/img.height),w=img.width*scale,h=img.height*scale;context.drawImage(img,(1280-w)/2,0,w,h);
    context.fillStyle='#b7c7d8';context.font='12px Arial';context.fillText('REPLAY · actual app-view capture · rendered DOM frames',18,706);
    if(caption.current){context.fillStyle='#101a29ee';context.fillRect(0,636,1280,44);context.fillStyle='#fff';context.font='18px Arial';context.fillText(caption.current.slice(0,115),22,664);}
   };
   await draw();const stream=canvas.captureStream(2);const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:5000000});
   const r:Run={recorder,stream,chunks:[],started:performance.now(),frames:1,failed:0,bytes:0,stopping:false,discard:false};run.current=r;
   recorder.ondataavailable=e=>{if(e.data.size){r.chunks.push(e.data);r.bytes+=e.data.size;if(r.bytes>120*1024*1024)stop();}};
   recorder.onerror=()=>{setError('The browser encoder failed.');stop(true);};
   recorder.onstop=async()=>{
    stream.getTracks().forEach(t=>t.stop());run.current=null;
    if(r.discard){setStatus('idle');return;}
    try{const blob=new Blob(r.chunks,{type:mime.split(';')[0]});r.chunks=[];
     const res=await fetch('/api/recordings',{method:'POST',headers:{'Content-Type':blob.type,'x-replay-duration-ms':String(Math.round(performance.now()-r.started)),'x-replay-frame-count':String(r.frames),'x-replay-failed-frames':String(r.failed)},body:blob});
     if(!res.ok)throw new Error('Recording upload failed; the server did not confirm a saved file.');setSaved(await res.json());setStatus('saved');setOpen(true);
    }catch(e){setError((e as Error).message);setStatus('idle');}
   };
   recorder.start(1000);setStatus('recording');
   const frame=async()=>{if(r.stopping)return;const age=performance.now()-r.started;setElapsed(age);if(age>=900000){stop();return;}
    try{await draw();r.frames++;}catch{r.failed++;if(r.failed>5){setError('Capture stopped after repeated frame failures.');stop();return;}}
    if(!r.stopping)r.timer=window.setTimeout(()=>void frame(),500);
   };r.timer=window.setTimeout(()=>void frame(),500);
  }catch(e){setError((e as Error).message);setStatus('idle');}
 };
 const recording=status==='recording';
 return <div className="app-recorder" data-capture-exclude>
  <button className={`btn btn-sm ${recording?'capture-live':''}`} onClick={()=>setOpen(v=>!v)}>{recording?`● REC ${Math.floor(elapsed/60000)}:${Math.floor(elapsed/1000%60).toString().padStart(2,'0')}`:'Record walkthrough'}</button>
  {open&&<section className="capture-dialog" aria-label="App walkthrough recording">
   <h3>Record this app</h3><p>Captures the current app view at up to 2 rendered frames per second. No microphone or other windows. Save limit: 15 minutes / 128 MiB.</p>
   <label>Presenter caption<input maxLength={115} onChange={e=>caption.current=e.target.value} placeholder="Optional chapter caption"/></label>
   {recording?<><p>{run.current?.frames??0} frames · {run.current?.failed??0} failed</p><button className="btn" onClick={()=>stop()}>Stop and save recording</button><button className="btn btn-ghost" onClick={()=>stop(true)}>Discard</button></>:<button className="btn" disabled={status==='starting'||status==='saving'} onClick={()=>void start()}>{status==='starting'?'Starting…':status==='saving'?'Saving…':'Start app capture'}</button>}
   {saved&&<p>Saved {Math.round(saved.bytes/1024)} KiB · <a href={`/api/recordings/${saved.id}/media`}>Download recording</a><br/><small>SHA256 {saved.sha256.slice(0,16)}</small></p>}
   {error&&<p role="alert">{error}</p>}
  </section>}
 </div>;
}
