"""Read-only check of the isolated browser rehearsal; never use a native session database."""
import datetime,hashlib,json,sqlite3
from pathlib import Path
original='486430a1adf524836df85d9aff3409ad';branch='e7a55378-4f72-4ada-99fb-a934b3481496'
c=sqlite3.connect('file:/tmp/replay-astra-rehearsal-20260915/replay.sqlite?mode=ro',uri=True)
get=lambda ident:json.loads(c.execute('select body from exercises where id=?',(ident,)).fetchone()[0])
a,b=get(original),get(branch)
assert a['status']=='completed' and b['status']=='completed' and b['parentId']==original and b['forkTick']==319
fingerprint=c.execute('select fingerprint from turns where exercise_id=? and tick=650',(original,)).fetchone()[0]
assert fingerprint=='8aceeb64f1a0430e28e73fd0e0e96190d38aa5fbf6c9a9fbaa27594fd6901939'
events=[{'id':r[0],'kind':r[1],'tick':r[2],'actor':r[3],'details':json.loads(r[4])} for r in c.execute('select id,kind,tick,actor,details from events where exercise_id=? and kind in (?,?) and actor=?',(branch,'command','task_created','demo-commander'))]
assert len(events)==2
command=next(e for e in events if e['kind']=='command');assert command['actor']=='demo-commander' and 'retain 90%' in command['details']['rationale']
notes=[json.loads(r[0]) for r in c.execute('select value from settings where key like ?',('learning.intake:'+original+':%',))]
assert len(notes)==1 and hashlib.sha256(notes[0]['rawText'].encode()).hexdigest()==notes[0]['sha256']
assert notes[0]['author']=='demo-commander' and notes[0]['timing']=='post-hoc'
proof={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed','mode':'isolated local-demo, automated browser rehearsal','url':'http://127.0.0.1:5193/','version':'0.27.0','originalExerciseId':original,'originalFinalFingerprint':fingerprint,'branchId':branch,'forkTick':319,'commandsAndWatches':[{'id':e['id'],'kind':e['kind'],'tick':e['tick'],'actor':e['actor']} for e in events],'noteOriginalSha256':notes[0]['sha256'],'noteTiming':'post-hoc','browserObserved':['Prepared fixture installed once and survived server restart/reload','Source graph calculated exact decision path; adding note changed21steps/17snippets to22steps/18snippets','Derivative bulletin node resolved to original report at tick300','Saved original review JSON inspected with actor/time/hash','10%legal Expand order and contemporaneous reason recorded','Free report-provenancewatch saved; branch ended for review','My practice showed1command+1watch and contemporaneous reason','Original case reselected without deleting the branch or note','Evidence packet download link activated; HTTP export content independently asserted in integration test','Saved native Luna result, exact blue-r06citation and tradeoffs opened without inference','Final visual inspection corrected narrow analysis/card and note composer layout'],'modelCalls':0,'humanValidation':False,'nativeRelease':'pending independent review','downloadFileReadback':'not captured from browser download sink; API export content checked separately','limitations':['Local browser rehearsal does not qualify native HTTPS','No human instructor/learner acceptance','Timings are presenter allocation, not a recorded10minute talk']}
out=Path('evidence/browser/astra-showcase-0270/qualification.json');out.write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps({'status':'passed','receipt':str(out),'original':original,'branch':branch,'newDurableActions':len(events)+len(notes),'paidCalls':0}))
