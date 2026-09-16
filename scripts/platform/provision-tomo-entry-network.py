"""Allow only REPLAY's authenticated entry pod to reach Tomo's private API."""
import datetime,json,subprocess
from pathlib import Path
spec={"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"replay-tomo-member-entry","namespace":"kamiwaza-extensions"},"spec":{"podSelector":{"matchLabels":{"extensions.kamiwaza.io/deployment-id":"replay-tomo","extensions.kamiwaza.io/service":"api-backend"}},"policyTypes":["Ingress"],"ingress":[{"from":[{"podSelector":{"matchLabels":{"extensions.kamiwaza.io/deployment-id":"replay","extensions.kamiwaza.io/service":"server"}}}],"ports":[{"protocol":"TCP","port":8000}]}]}}
result=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl apply -f -'],input=json.dumps(spec),text=True,capture_output=True,check=True)
receipt={"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"policy":spec,"result":result.stdout.strip(),"scope":"Additional pod-specific8000ingress, no public service exposure or change to operator policy"}
with Path('evidence/platform/tomo-entry-network-1.json').open('x') as f:json.dump(receipt,f,indent=2)
print(json.dumps(receipt))
