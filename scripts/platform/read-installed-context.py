"""Capture selected source comments from the licensed local runtime for integration inspection."""
import subprocess,json,pathlib
root=pathlib.Path(__file__).resolve().parents[2];out=root/'data/platform/installed-context';out.mkdir(parents=True,exist_ok=True)
script=r'''
import pathlib,re,json
base=pathlib.Path('/app/.venv/lib/python3.12/site-packages/kamiwaza/services/context')
files=['lifecycle.c','services/lifecycle_service.c','api/router.c','services/graphiti_reconciler.c','services/ontology_operations_service.c','api/ontology.c','middleware/ontology/graphiti.c','lib/graphiti_extension_patch.c']
result={}
for file in files:
 p=base/file;lines={}
 for block in re.findall(r'/\* "kamiwaza/.*?\*/',p.read_text(),re.S):
  m=re.search(r'\.py":(\d+)',block)
  if not m:continue
  text=block.splitlines()[1:-1]
  marker=next((i for i,v in enumerate(text) if '# <<<<<<' in v),None)
  if marker is None:continue
  at=int(m[1])
  for i,line in enumerate(text):lines[at+i-marker]=line.removeprefix(' * ').split('             # <<<<<<')[0]
 result[file]='\n'.join(f'{n}: {l}' for n,l in sorted(lines.items()))
print(json.dumps(result))
'''
r=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl exec -i -n kamiwaza core-raycluster-head-z7fvg -c ray-head -- python3 -'],input=script,text=True,capture_output=True,check=True)
for file,source in json.loads(r.stdout).items():(out/(file.replace('/','-')+'.txt')).write_text(source)
print('Saved selected installed-source excerpts privately for integration inspection')
