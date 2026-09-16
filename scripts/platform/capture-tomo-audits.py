"""Read only the application's safe Tomo audit projections and ledger metadata; no credentials."""
import datetime,json,re,shlex,subprocess,sys
from pathlib import Path

version=sys.argv[1]
assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-z0-9-]+)?',version)
dest=Path('evidence/platform')/f'tomo-native-audits-{version}.json'
assert not dest.exists(),'Preserve prior receipts'
code=r'''
const {DatabaseSync}=require('node:sqlite');
const app=new DatabaseSync('/data/replay.sqlite',{readOnly:true});
const ledger=new DatabaseSync('/data/inference.sqlite',{readOnly:true});
const allowed=['at','requestId','subject','workroomId','authority','receiptId','nativeRequestIds','outcome','code','requestShape','providerHttpStatus','providerDiagnostics','path','status','receipt','conversationId','inputId','deploymentId','servePath'];
const audits=app.prepare("SELECT key,value FROM settings WHERE key LIKE 'tomo-model-receipt:%' OR key LIKE 'tomo-native-route:%' OR key LIKE 'tomo-input-receipt:%'").all().map(row=>{const v=JSON.parse(row.value);return {key:row.key,...Object.fromEntries(allowed.filter(k=>v[k]!==undefined).map(k=>[k,v[k]]))};});
const receipts=ledger.prepare("SELECT id,status,purpose,context_json,reserved_micro,settled_micro,http_status,error_code,created_at FROM receipts WHERE purpose='tomo.model.chat' ORDER BY created_at").all().map(({context_json,...r})=>{const c=JSON.parse(context_json||'{}');return {...r,context:Object.fromEntries(['requestId','requestFingerprint','subject','workroomId','authority','nativeRequestIds'].filter(k=>c[k]!==undefined).map(k=>[k,c[k]]))};});
const budget=ledger.prepare('SELECT count(*) AS requestsUsed,sum(coalesce(settled_micro,reserved_micro)) AS committedMicro FROM receipts').get();
console.log(JSON.stringify({audits,receipts,budget}));app.close();ledger.close();
'''
command='sudo k0s kubectl exec -n kamiwaza-extensions deploy/replay-server -- node -e '+shlex.quote(code)
raw=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc',command],capture_output=True,text=True,check=True)
proof=json.loads(raw.stdout)
proof.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),version=version,note='Safe application projections only. Temporal proximity alone is not a joined human/input/provider/tool causal trace.')
with dest.open('x') as f:json.dump(proof,f,indent=2);f.write('\n')
print(json.dumps({'artifact':str(dest),'budget':proof['budget'],'providerReceipts':len(proof['receipts']),'recentProviderAudits':[a for a in proof['audits'] if a['key'].startswith('tomo-model-receipt:')][-5:]}))
