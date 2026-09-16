"""Reproducible private offline native image build, import and platform API upgrade."""
import subprocess,sys,re,shlex
from pathlib import Path
args=sys.argv[1:]
flags=[x for x in args if x.startswith('--')]
positionals=[x for x in args if not x.startswith('--')]
tag=positionals[0]
if not re.fullmatch(r'[A-Za-z0-9._-]+',tag):raise ValueError('Invalid tag')
context=Path(positionals[1]).resolve() if len(positionals)>1 else Path.cwd()
if not (context/'Dockerfile').is_file():raise ValueError('Build context lacks Dockerfile')
image='localhost/replay:'+tag
archive=Path('data/platform')/('replay-'+tag+'.oci')
def run(args):subprocess.run(args,check=True)
run(['podman','build','-t',image,str(context)])
run(['podman','save','--format','oci-archive','-o',str(archive),image])
run(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s ctr images import '+shlex.quote(str(archive.resolve()))])
run(['pnpm','exec','tsx','scripts/platform/upgrade-replay.ts',image,*flags])
run(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl rollout status deployment/replay-server -n kamiwaza-extensions --timeout=55s'])
