"""Freeze tracked/candidate public source without ignored secrets or runtime data."""
import hashlib,json,shutil,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path
root=Path.cwd();version=sys.argv[1]
assert version==json.loads((root/'package.json').read_text())['version']
dest=root/'data/platform'/('build-context-'+version)
receipt=root/'evidence/platform'/('build-context-'+version+'.json')
assert not dest.exists() and not receipt.exists(),'Preserve prior build contexts'
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0')
entries=[];dest.mkdir(parents=True)
for name in sorted(set(files)):
 if not name:continue
 p=root/name
 if not p.exists():continue
 assert not p.is_symlink(),f'Refuse symlink: {name}'
 if not p.is_file():continue
 assert not name.startswith(('data/','node_modules/','handoff/','.git/'))
 b=p.read_bytes();target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target)
 entries.append({'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
proof={'at':datetime.now(timezone.utc).isoformat(),'version':version,'context':str(dest.relative_to(root)),'files':entries}
receipt.write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'version':version,'context':str(dest.relative_to(root)),'files':len(entries),'manifest':str(receipt.relative_to(root))}))
