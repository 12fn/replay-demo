"""Check supplied Graphiti workload identity against native ForwardAuth without exposing its bearer."""
import subprocess,json,pathlib,datetime
pods=json.loads(subprocess.check_output(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl get pods -n kamiwaza-extensions -o json'],text=True))['items']
pod=next(p['metadata']['name'] for p in pods if p['metadata']['name'].startswith('service-graphiti-280d6347') and p['spec']['containers'][0]['name']=='graphiti')
code='''
import os,json,urllib.request,urllib.error
from kamiwaza_service_identity import get_provider
provider=get_provider();token=provider.get_token_sync()
h={'Authorization':'Bearer '+token,'X-Forwarded-Method':'GET','X-Forwarded-Uri':'/api/auth/users/me','X-Forwarded-Host':'kamiwaza-harness.localhost','X-Forwarded-Proto':'https'}
base='http://core-api.kamiwaza.svc:7777/api'
try:
 r=urllib.request.urlopen(urllib.request.Request(base+'/auth/forward/validate',headers=h));r.read()
 safe={k:v for k,v in r.headers.items() if k.lower() in ['x-user-id','x-user-name','x-user-roles','x-auth-azp','x-authz-outcome','x-authz-reason-class']}
 signed={k:v for k,v in r.headers.items() if k.lower().startswith('x-')};signed['Authorization']='Bearer '+token
 me=urllib.request.urlopen(urllib.request.Request(base+'/auth/users/me',headers=signed));body=json.load(me)
 embedding=urllib.request.urlopen(urllib.request.Request('http://replay-embeddings-server.kamiwaza-extensions.svc:8000/v1/embeddings',data=json.dumps({'model':'BAAI/bge-small-en-v1.5','input':['Check the source of this exercise report.','Verify evidence provenance.','Bake a lemon cake.']}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}));data=json.load(embedding)
 vectors=[x['embedding'] for x in data['data']];dot=lambda a,b:sum(x*y for x,y in zip(a,b))
 print(json.dumps({'status':r.status,'signedIdentity':safe,'user':{k:body.get(k) for k in ['sub','username','roles']},'embedding':{'status':embedding.status,'dimensions':[len(v) for v in vectors],'relevantSimilarity':dot(vectors[0],vectors[1]),'unrelatedSimilarity':dot(vectors[0],vectors[2]),'paidInference':False}}))
except urllib.error.HTTPError as e:print(json.dumps({'status':e.code,'error':'Native service identity validation failed'}))
'''
r=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc',f'sudo k0s kubectl exec -i -n kamiwaza-extensions {pod} -- /app/.venv/bin/python -'],input=code,text=True,capture_output=True)
if r.returncode:raise RuntimeError('Service-identity probe failed to execute')
result=json.loads(r.stdout);result['at']=datetime.datetime.now(datetime.timezone.utc).isoformat();pathlib.Path('evidence/platform/graphiti-embedding-qualification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
