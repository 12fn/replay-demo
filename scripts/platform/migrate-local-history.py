"""One-time operator migration: completed development recordings plus their exact cost ledger.

Stop the local service first. Does not migrate browser sessions or assign old data to native users.
Native inference must remain unconfigured until this succeeds. Retains destination backups.
"""
from pathlib import Path
import subprocess, sqlite3, json, datetime, shlex

root=Path.cwd(); staging=root/'data/platform/history-migration'; staging.mkdir(mode=0o700,parents=True,exist_ok=True)
for name in ['replay','inference']:
    with sqlite3.connect(root/f'data/{name}.sqlite') as source, sqlite3.connect(staging/f'{name}.sqlite') as target:
        if name=='replay':
            rows=[json.loads(x[0]) for x in source.execute('SELECT body FROM exercises')]
            if any(r['status']=='running' or r.get('agentEnabled') for r in rows): raise RuntimeError('Finish local exercises before migration')
        source.backup(target)
    (staging/f'{name}.sqlite').chmod(0o600)
def remote(command, data=None):
    p=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc',command],input=data,text=True,capture_output=True)
    if p.returncode: raise RuntimeError('History migration operator command failed: '+p.stderr[-1200:])
    return p.stdout
pods=json.loads(remote('sudo k0s kubectl get pods -n kamiwaza-extensions -o json'))['items']
pod=next(x['metadata']['name'] for x in pods if x['metadata']['name'].startswith('replay-server-') and x['status']['phase']=='Running')
for name in ['replay','inference']:
    remote(f'sudo k0s kubectl cp {shlex.quote(str(staging/f"{name}.sqlite"))} kamiwaza-extensions/{pod}:/tmp/source-{name}.sqlite')
code=r'''
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
fs.mkdirSync('/data/backups',{recursive:true,mode:0o700});
const game=new DatabaseSync('/data/replay.sqlite');
const ledger=new DatabaseSync('/data/inference.sqlite');
for(const [db,name] of [[game,'replay'],[ledger,'inference']]){
 db.exec('PRAGMA busy_timeout=5000');
 const backup=`/data/backups/before-local-history-${name}.sqlite`;
 if(!fs.existsSync(backup))db.prepare('VACUUM INTO ?').run(backup);
}
ledger.exec("ATTACH '/tmp/source-inference.sqlite' AS source");
const initial=ledger.prepare('SELECT count(*) AS n FROM receipts').get().n;
const expected=ledger.prepare('SELECT count(*) AS n FROM source.receipts').get().n;
if(ledger.prepare("SELECT count(*) AS n FROM source.receipts WHERE status='reserved'").get().n)throw new Error('Source has inflight receipts');
if(initial&&ledger.prepare('SELECT count(*) AS n FROM receipts WHERE id NOT IN(SELECT id FROM source.receipts)').get().n)throw new Error('Destination ledger has new paid use; manual reconciliation required');
ledger.exec('BEGIN IMMEDIATE');
try{ledger.exec('INSERT INTO receipts SELECT * FROM source.receipts WHERE id NOT IN(SELECT id FROM receipts)');ledger.exec('COMMIT');}catch(e){ledger.exec('ROLLBACK');throw e;}
game.exec("ATTACH '/tmp/source-replay.sqlite' AS source");
game.exec('BEGIN IMMEDIATE');
const counts={};
try{
 for(const table of ['exercises','turns','commands','reports','tasks']){
  const columns=game.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
  const pk=table==='turns'?['exercise_id','tick']:['id'];
  counts[table]=Number(game.prepare(`INSERT INTO main.${table}(${columns.join(',')}) SELECT ${columns.map(x=>'s.'+x).join(',')} FROM source.${table} s WHERE NOT EXISTS(SELECT 1 FROM main.${table} d WHERE ${pk.map(x=>`d.${x}=s.${x}`).join(' AND ')})`).run().changes);
 }
 const columns=game.prepare('PRAGMA table_info(events)').all().map(x=>x.name).filter(x=>x!=='sequence');
 counts.events=Number(game.prepare(`INSERT INTO main.events(${columns.join(',')}) SELECT ${columns.map(x=>'s.'+x).join(',')} FROM source.events s WHERE NOT EXISTS(SELECT 1 FROM main.events d WHERE d.id=s.id) ORDER BY s.sequence`).run().changes);
 // Sessions are intentionally excluded. Only per-exercise learning/agent settings may transfer.
 counts.settings=Number(game.prepare("INSERT INTO main.settings SELECT s.* FROM source.settings s WHERE (s.key LIKE 'agent.memory:%' OR s.key LIKE 'learning.debrief:%') AND NOT EXISTS(SELECT 1 FROM main.settings d WHERE d.key=s.key)").run().changes);
 game.exec('COMMIT');
}catch(e){game.exec('ROLLBACK');throw e;}
console.log(JSON.stringify({imported:counts,ledger:{before:initial,source:expected,...ledger.prepare('SELECT count(*) AS requests, sum(settled_micro) AS settledMicro FROM receipts').get()},legacyAttribution:'Preserved; never assigned to a native participant',backup:'/data/backups/before-local-history-*.sqlite'}));
game.close();ledger.close();
fs.unlinkSync('/tmp/source-replay.sqlite');fs.unlinkSync('/tmp/source-inference.sqlite');
'''
result=json.loads(remote(f'sudo k0s kubectl exec -i -n kamiwaza-extensions {pod} -- node --input-type=module -',code))
result['at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
Path('evidence/platform/history-migration.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
