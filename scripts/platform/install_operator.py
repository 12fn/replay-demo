"""Install the supplied 1.2 extension operator without changing core workloads."""
import subprocess,json,hashlib,datetime
from pathlib import Path
root=Path(__file__).resolve().parents[2];chart=root/'data/platform/operator/extracted/extension-operator-1.0.0/chart'
def kub(args,data=None):
 import shlex
 p=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc',shlex.join(['sudo','k0s','kubectl',*args])],input=data,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr[:1500])
 return p.stdout
for ns in ['kamiwaza-system','kamiwaza-extensions','kamiwaza-sandboxes']:
 print(kub(['apply','-f','-'],json.dumps({'apiVersion':'v1','kind':'Namespace','metadata':{'name':ns}})).strip())
manifest=subprocess.check_output(['helm','template','replay-extension-operator',str(chart),'--namespace','kamiwaza-system','--include-crds','--set','image.tag=release-1.2.0','--set','image.pullPolicy=IfNotPresent','--set','routingProvider=istio'],text=True)
(root/'data/platform/operator/rendered.yaml').write_text(manifest)
print(kub(['apply','--server-side','-f','-'],manifest))
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'Existing Kamiwaza 1.2 arm64 offline installer extension-operator.wrap','operatorImage':'ghcr.io/kamiwaza-internal/operators/images/extension-operator:release-1.2.0','imageDigest':'sha256:168f528512c4a7aa33fb6c77e028a9dccfff007a5f54fd7a5d440b922a3aedde','renderedManifestSha256':hashlib.sha256(manifest.encode()).hexdigest(),'method':'Supplied Helm chart rendered then server-side applied; independent operator namespace; core deployment unchanged','status':'applied; readiness pending'}
(root/'evidence/platform/operator-install.json').write_text(json.dumps(receipt,indent=2))
