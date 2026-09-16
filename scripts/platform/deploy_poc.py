"""Create the REPLAY app through native Kamiwaza extension API; no paid inference."""
import json,subprocess,pathlib,urllib.request,urllib.error,hashlib,datetime
root=pathlib.Path(__file__).resolve().parents[2];binding=json.loads((root/'data/kamiwaza-binding.json').read_text());base=binding['apiBase'];workroom=binding['workroom']['id'];token=(root/'data/kamiwaza-runtime.token').read_text().strip()
def request(method,path,body=None):
 h={'Authorization':'Bearer '+token,'X-Workroom-ID':workroom,'X-Forwarded-Method':method,'X-Forwarded-Uri':'/api'+path,'X-Forwarded-Host':'kamiwaza-harness.localhost','X-Forwarded-Proto':'https'}
 r=urllib.request.urlopen(urllib.request.Request(base+'/auth/forward/validate',headers=h));r.read()
 signed={k:v for k,v in r.headers.items() if k.lower().startswith('x-')}
 signed.update({'Authorization':'Bearer '+token,'Content-Type':'application/json'})
 try:
  r=urllib.request.urlopen(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=signed,method=method));data=r.read();return json.loads(data) if data else None
 except urllib.error.HTTPError as e:raise RuntimeError(f'Native {method} {path}: {e.code} {e.read().decode()[:1200]}')
def kub(body):
 p=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc','sudo k0s kubectl apply -f -'],input=json.dumps(body),capture_output=True,text=True)
 if p.returncode:raise RuntimeError(p.stderr[:1200])
 print(p.stdout.strip())
subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc','sudo mkdir -p /var/lib/replay-poc && sudo chown 1000:1000 /var/lib/replay-poc && sudo chmod 700 /var/lib/replay-poc'],check=True)
kub({'apiVersion':'v1','kind':'PersistentVolume','metadata':{'name':'replay-poc-data'},'spec':{'capacity':{'storage':'2Gi'},'accessModes':['ReadWriteOnce'],'persistentVolumeReclaimPolicy':'Retain','storageClassName':'replay-local','hostPath':{'path':'/var/lib/replay-poc','type':'Directory'}}})
body={'name':'replay','type':'app','version':'0.1.0','workroom_id':workroom,'services':[{'name':'server','image':'localhost/replay:0.1.0-poc','primary':True,'ports':[{'container_port':5181,'protocol':'TCP'}],'replicas':1,'resources':{'requests':{'cpu':'250m','memory':'512Mi'},'limits':{'cpu':'2','memory':'2Gi'}},'env':[{'name':'REPLAY_DATA_DIR','value':'/data'},{'name':'REPLAY_KAMIWAZA_API','value':'http://core-api.kamiwaza.svc:7777/api'},{'name':'REPLAY_WORKROOM_ID','value':workroom}],'persistence':{'enabled':True,'size':'2Gi','mountPath':'/data','storageClass':'replay-local'},'containerSecurityContext':{'runAsNonRoot':True,'runAsUser':1000,'allowPrivilegeEscalation':False,'capabilities':{'drop':['ALL']}},'healthCheck':{'httpGet':{'path':'/health','port':5181},'initialDelaySeconds':5,'periodSeconds':10}}],'kamiwaza':{'namespace':'kamiwaza','api_url':'http://core-api.kamiwaza.svc:7777','public_api_url':'https://kamiwaza-harness.localhost','use_auth':'true'},'networking':{'ingress_enabled':False},'security':{'risk_tier':1,'source_type':'user_repo','verified':False},'annotations':{'kamiwaza.ai/title':'REPLAY · continuous exercise and evidence-led review','kamiwaza.ai/deployment-stage':'POC runtime; native identity UI pending'}}
existing=request('GET','/extensions?workroom_id='+workroom)
match=next((x for x in existing if x['name']=='replay'),None)
result=match or request('POST','/extensions',body)
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'request':body,'response':result,'authentication':'Native session plus unchanged signed ForwardAuth response','appInference':'No API key in this first native runtime; default deterministic controller','publicIngress':'Disabled pending identity gateway qualification; private service tunnel only'}
(root/'evidence/platform/app-extension-create.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(result,indent=2))
