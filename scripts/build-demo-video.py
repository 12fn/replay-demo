"""Reproduce the edited demonstration from immutable native app captures.
No synthetic game frames: only title/end cards and separately synthesized narration.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import subprocess,json,math,hashlib,datetime,argparse,re,os
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--manifest',default='evidence/video/edit-manifest.json')
parser.add_argument('--output-name',default='replay-demo',help='Fresh artifact basename; existing videos and receipts are never replaced')
parser.add_argument('--validate-only',action='store_true',help='Inspect source hashes and trim ranges without narration or output writes')
args=parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',args.output_name):raise ValueError('Invalid output basename')
media=root/'evidence/video'; work=root/'data/video-edit'/args.output_name
manifest_path=(root/args.manifest).resolve();manifest=json.loads(manifest_path.read_text())
legacy=args.output_name=='replay-demo'
outputs={'video':media/(args.output_name+'.mp4'),'captions':media/(args.output_name+'.srt'),
 'receipt':media/('demo-build.json' if legacy else args.output_name+'-build.json'),
 'transcript':media/('transcript.md' if legacy else args.output_name+'-transcript.md')}
if not args.validate_only and (work.exists() or any(p.exists() for p in outputs.values())):
 raise FileExistsError('Preserve existing edit/output artifacts; choose a fresh --output-name')
captions=[];chapters=[];proof=[];cursor=0
font='/System/Library/Fonts/Supplemental/Arial.ttf'
def run(args): subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
def duration(path):
 value=subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(path)],text=True).strip()
 if value!='N/A':
  result=float(value)
  if math.isfinite(result) and result>0:return result
 # MediaRecorder WebM may omit duration/cues. Read video packet timestamps; never guess a successful trim.
 packet=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','packet=pts_time,duration_time','-of','json',str(path)],text=True))['packets']
 ends=[float(p['pts_time'])+float(p.get('duration_time',0)) for p in packet if p.get('pts_time') not in (None,'N/A')]
 if not ends or not all(math.isfinite(t) and t>=0 for t in ends):raise ValueError('No valid source video timestamps')
 return max(ends)

# Preflight every source before invoking narration or creating edit artifacts.
if not isinstance(manifest.get('chapters'),list) or not manifest['chapters']:raise ValueError('At least one chapter required')
if not isinstance(manifest.get('method'),str) or not manifest['method'].strip():raise ValueError('Capture method must be disclosed')
verified={};total=0
for i,ch in enumerate(manifest['chapters']):
 dur=ch.get('duration');start=ch.get('start',0)
 if type(dur) not in (int,float) or not math.isfinite(dur) or dur<2:raise ValueError(f'Invalid chapter duration: {i}')
 if type(start) not in (int,float) or not math.isfinite(start) or start<0:raise ValueError(f'Invalid source offset: {i}')
 if not isinstance(ch.get('narration'),str) or not ch['narration'].strip():raise ValueError(f'Missing narration: {i}')
 if not isinstance(ch.get('title'),str) or any(c in ch['title'] for c in '\n\r'):raise ValueError(f'Invalid title: {i}')
 total+=dur
 if ch.get('card'):
  if ch['card'] not in ('intro','outro') or ch.get('source'):raise ValueError(f'Invalid card: {i}')
 else:
  candidate=media/ch['source'];source=candidate.resolve()
  if not source.is_relative_to(media.resolve()) or candidate.is_symlink() or not source.is_file():raise ValueError(f'Invalid source: {i}')
  name=str(source.relative_to(media))
  if name not in verified:verified[name]={'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'durationSeconds':duration(source)}
  if ch.get('sourceSha256') and ch['sourceSha256']!=verified[name]['sha256']:raise ValueError(f'Source digest differs: {i}')
  if start+dur>verified[name]['durationSeconds']+0.1:raise ValueError(f'Trim exceeds source video: {i}')
if not 300<=total<=600:raise ValueError('Final demonstration must be five to ten minutes')
if args.validate_only:
 print(json.dumps({'status':'validated-inputs-only','durationSeconds':total,'sources':verified,'wouldOverwrite':any(p.exists() for p in outputs.values()),'noOutputsWritten':True}));raise SystemExit(0)
work.mkdir(parents=True,exist_ok=False)
def stamp(seconds):
 ms=round(seconds*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
def card(kind,path):
 im=Image.new('RGB',(1280,720),'#091321');d=ImageDraw.Draw(im)
 f=lambda n:ImageFont.truetype(font,n)
 d.rectangle((72,90,79,536),fill='#36b3c4');d.text((110,90),'R E P L A Y',font=f(54),fill='#f5f0e6')
 if kind=='intro':
  d.text((110,207),'Learning through wargaming',font=f(43),fill='#f5f0e6')
  d.text((110,285),'A real Kamiwaza 1.2 application',font=f(27),fill='#9db8cd')
  d.text((110,376),'Continuous play  /  Auditable agents  /  Rewind & retry',font=f(23),fill='#59c6d4')
  d.text((110,474),'Edited app captures · Synthetic narration · Automated operation',font=f(21),fill='#abb8c7')
 else:
  d.text((110,207),'Play. Inspect. Practice the alternative.',font=f(40),fill='#f5f0e6')
  d.text((110,301),'Instructor pilot candidate',font=f(29),fill='#59c6d4')
  d.text((110,380),'Next: human playtesting, curriculum review, longer-session pacing',font=f(23),fill='#abb8c7')
  d.text((110,425),'and qualification on the two DGX Sparks.',font=f(23),fill='#abb8c7')
 d.text((110,627),'Fictional exercise · Recorded evidence · No NPS endorsement or efficacy claim',font=f(19),fill='#8198ad')
 im.save(path)
for i,ch in enumerate(manifest['chapters']):
 print(f'Chapter {i+1}: {ch["title"]}',flush=True)
 dur=ch['duration'];speech=work/f'{i:02}.txt';speech.write_text(ch['narration']);audio=work/f'{i:02}.aiff'
 rate=162;run(['say','-v',manifest['voice'],'-r',str(rate),'-f',str(speech),'-o',str(audio)]);spoken=duration(audio)
 lead=0.4 if ch.get('card') else 1.5;available=dur-lead-0.5
 if spoken>available:
  rate=math.ceil(rate*spoken/available)+2;run(['say','-v',manifest['voice'],'-r',str(rate),'-f',str(speech),'-o',str(audio)]);spoken=duration(audio)
 if spoken>dur-lead:raise RuntimeError(f'Narration does not fit: {i}')
 if ch.get('card'):
  source=work/f'{i:02}.png';card(ch['card'],source);inputs=['-loop','1','-framerate','15','-i',str(source)]
 else:
  source=media/ch['source'];inputs=['-ss',str(ch['start']),'-i',str(source)]
 out=work/f'{i:02}.mp4'
 run(['ffmpeg','-y','-hide_banner','-loglevel','error',*inputs,'-i',str(audio),'-map','0:v:0','-map','1:a:0','-vf','fps=15,format=yuv420p','-af',f'adelay={round(lead*1000)}:all=1,apad','-t',str(dur),'-c:v','libx264','-preset','veryfast','-crf','20','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-movflags','+faststart',str(out)])
 words=ch['narration'].split();groups=[words[n:n+12] for n in range(0,len(words),12)];used=0
 for group in groups:
  start=cursor+lead+spoken*used/len(words);used+=len(group);end=cursor+lead+spoken*used/len(words)
  captions.append(f'{len(captions)+1}\n{stamp(start)} --> {stamp(end)}\n'+ ' '.join(group)+'\n')
 chapters.append(f'[CHAPTER]\nTIMEBASE=1/1000\nSTART={round(cursor*1000)}\nEND={round((cursor+dur)*1000)}\ntitle={ch["title"]}\n')
 proof.append({'title':ch['title'],'finalStart':cursor,'duration':dur,'source':source.name,'sourceStart':ch.get('start',0),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'voiceRate':rate,'narrationSeconds':spoken});cursor+=dur
concat=work/'concat.txt';concat.write_text('\n'.join("file '"+str(work/f'{i:02}.mp4')+"'" for i in range(len(proof))))
base=work/'joined.mp4';run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(concat),'-c','copy',str(base)])
srt=work/'captions.srt';srt.write_text('\n'.join(captions))
metadata=work/'chapters.ffmeta';metadata.write_text(';FFMETADATA1\ntitle=REPLAY — Native Kamiwaza demonstration\ncomment=Edited real DOM/canvas app captures; synthetic narration; automated operation.\n'+''.join(chapters))
final=work/'final.mp4';run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(base),'-i',str(srt),'-i',str(metadata),'-map','0:v','-map','0:a','-map','1:0','-map_metadata','2','-map_chapters','2','-c','copy','-c:s','mov_text','-metadata:s:s:0','language=eng','-movflags','+faststart',str(final)])
receipt={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':manifest['method'],'output':str(outputs['video'].relative_to(root)),'manifestSha256':hashlib.sha256(manifest_path.read_bytes()).hexdigest(),'sourceBuilds':manifest.get('sourceBuilds',[]),'verifiedSources':verified,'durationSeconds':duration(final),'bytes':final.stat().st_size,'sha256':hashlib.sha256(final.read_bytes()).hexdigest(),'chapters':proof}
(work/'build.json').write_text(json.dumps(receipt,indent=2));(work/'transcript.md').write_text('# REPLAY demonstration transcript\n\n'+manifest['method']+'\n\n'+'\n\n'.join(f'## {int(p["finalStart"]//60)}:{int(p["finalStart"]%60):02} — {ch["title"]}\n\n{ch["narration"]}' for ch,p in zip(manifest['chapters'],proof)))
if abs(receipt['durationSeconds']-total)>0.25:raise RuntimeError('Encoded duration differs from declared chapters')
# Publish complete verified outputs without clobbering existing files.
for source,target in [(final,outputs['video']),(srt,outputs['captions']),(work/'build.json',outputs['receipt']),(work/'transcript.md',outputs['transcript'])]:os.link(source,target)
print(json.dumps({k:v for k,v in receipt.items() if k!='chapters'}),flush=True)
