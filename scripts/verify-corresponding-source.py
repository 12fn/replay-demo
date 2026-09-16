"""Verify each allowlisted corresponding-source member against an exact Git revision."""
import argparse, hashlib, io, json, subprocess, tarfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--revision',default='HEAD');a=p.parse_args()
archive=Path('public/replay-source.tar.gz');build=json.loads(Path('public/replay-build.json').read_text())
raw=archive.read_bytes()
if hashlib.sha256(raw).hexdigest()!=build['sourceArchive']['sha256']:raise SystemExit('Archive digest does not match build receipt')
with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as t:
 members=t.getmembers()
 if any(not m.isfile() or m.name.startswith('/') or '..' in Path(m.name).parts for m in members):raise SystemExit('Unsafe or non-file archive member')
 packaged={m.name:t.extractfile(m).read() for m in members}
required=['resources/showcase/fixture.json','resources/showcase/recorded-debrief.json','src/learning/decision-retrieval.ts','package.json','PUBLIC-RELEASE.md','docs/stages/status.json','docs/process/BUILD-JOURNAL.md','tests/fixtures/synthetic-trial.ts','handoff/REPLAY-preset-catalog-1/catalog.json']
if any(name not in packaged for name in required):raise SystemExit('Required runtime source or prepared data is missing')
result=subprocess.run(['git','archive',a.revision,'--',*packaged.keys()],capture_output=True)
if result.returncode:raise SystemExit('Git archive rejected a packaged source path; verify every source file is committed and metadata files are excluded')
committed=result.stdout
with tarfile.open(fileobj=io.BytesIO(committed),mode='r:') as t:
 expected={m.name:t.extractfile(m).read() for m in t.getmembers() if m.isfile()}
if expected!=packaged:raise SystemExit('Corresponding source differs from the selected Git revision')
print(json.dumps({'status':'passed','revision':subprocess.check_output(['git','rev-parse',a.revision],text=True).strip(),'files':len(packaged),'archiveSha256':build['sourceArchive']['sha256'],'meaning':'Every allowlisted source member matches Git; private/runtime evidence is intentionally excluded.'}))
