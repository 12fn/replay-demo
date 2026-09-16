"""Install the authorized credential without command-line, console or journal disclosure.

Run only after the local service stops and history migration succeeds. Keeps the original key
in an operator-only archive path no longer read by local development defaults.
"""
import json,re,subprocess
from pathlib import Path
receipt=json.loads(Path('evidence/platform/history-migration.json').read_text())
if receipt['ledger']['requests']!=receipt['ledger']['source']:raise RuntimeError('Ledger migration not verified')
source=Path('data/luna.env');retired=Path('data/platform/retired-local-luna.env')
text=(source if source.exists() else retired).read_text()
m=re.search(r'^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)$',text,re.M)
if not m:raise RuntimeError('Authorized credential is unavailable')
key=m[1].strip().strip('\"\'')
manifest={'apiVersion':'v1','kind':'Secret','metadata':{'name':'replay-inference','namespace':'kamiwaza-extensions','labels':{'app.kubernetes.io/part-of':'replay'}},'type':'Opaque','stringData':{'OPENAI_API_KEY':key}}
p=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl apply -f -'],input=json.dumps(manifest),capture_output=True,text=True)
manifest['stringData'].clear();key='';text=''
if p.returncode:raise RuntimeError('Credential installation failed; no secret output retained')
if source.exists():source.rename(retired)
retired.chmod(0o600)
Path('data/platform/native-inference-secret.ready').write_text('replay-inference / exact migrated ledger / local service stopped\n')
print('Native inference Secret installed. Local default credential retired; project ledger preserved.')
