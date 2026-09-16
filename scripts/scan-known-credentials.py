"""Scan our candidate/handoff and nested source archive against known local credentials, without printing values."""
import argparse,base64,io,json,re,subprocess,tarfile,zipfile
from datetime import datetime,timezone
from pathlib import Path

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('target');p.add_argument('--report',required=True);p.add_argument('--repository',action='store_true');a=p.parse_args()
    report=Path(a.report)
    if report.exists():raise FileExistsError('Preserve the previous scan receipt')
    values=set()
    def collect(v,key=''):
        if isinstance(v,dict):
            for k,x in v.items():collect(x,k)
        elif isinstance(v,list):
            for x in v:collect(x,key)
        elif isinstance(v,str) and re.search(r'password|secret|token|api.?key',key,re.I) and len(v)>10:values.add(v.encode())
    for name in ['team-qualification-users.json','graph-secrets.json','tomo-provider.json']:
        collect(json.loads((Path('data/platform')/name).read_text()))
    for v in json.loads(Path('data/platform/graph-secrets.json').read_text()).values():
        if isinstance(v,str) and len(v)>12:values.add(v.encode())
    for name in ['data/kamiwaza-runtime.token','data/portal-api-key','data/hackathon-codex-access-token']:
        values.add(Path(name).read_bytes().strip())
    m=re.search(r'^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)$',Path('data/platform/retired-local-luna.env').read_text(),re.M)
    if not m:raise RuntimeError('Known inference credential unavailable')
    values.add(m[1].strip().strip('\"\'').encode())
    for name in ['admin','poc-viewer']:
        raw=subprocess.check_output(['podman','machine','ssh','kamiwaza-harness-poc',f"sudo k0s kubectl get secret kamiwaza-user-{name} -n kamiwaza -o jsonpath='{{.data.password}}'"],stderr=subprocess.PIPE,timeout=20)
        values.add(base64.b64decode(raw.strip()))
    hits=[];count=0
    def scan(name,data):
        nonlocal count
        count+=1
        if any(v and v in data for v in values):hits.append(name)
        if name.endswith('.tar.gz'):
            with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as t:
                for member in t.getmembers():
                    if member.isfile():scan(name+'!'+member.name,t.extractfile(member).read())
    target=Path(a.target)
    if target.is_dir():
        for item in target.rglob('*'):
            if item.is_symlink():raise RuntimeError('Refuse scan symlink')
            if item.is_file():scan(str(item),item.read_bytes())
    else:
        with zipfile.ZipFile(target) as z:
            if z.testzip():raise RuntimeError('Invalid handoff archive')
            for name in z.namelist():scan('zip!'+name,z.read(name))
    if a.repository:
        for name in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0'):
            if name and Path(name).is_file():scan(name,Path(name).read_bytes())
    proof={'at':datetime.now(timezone.utc).isoformat(),'target':str(target),'repository':a.repository,'knownCredentialValues':len(values),'files':count,'matches':hits}
    report.parent.mkdir(parents=True,exist_ok=True)
    with report.open('x') as f:json.dump(proof,f,indent=2);f.write('\n')
    print(json.dumps(proof))
    return 1 if hits else 0

if __name__=='__main__':raise SystemExit(main())
