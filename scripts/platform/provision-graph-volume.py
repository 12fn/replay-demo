"""Bind a retained local volume to the native Graphiti deployment's pending claim."""
import json,subprocess,shlex,pathlib,datetime

def kub(args,body=None):
 r=subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc',shlex.join(['sudo','k0s','kubectl',*args])],input=json.dumps(body) if body else None,text=True,capture_output=True,check=True);return r.stdout
claims=json.loads(kub(['get','pvc','-n','kamiwaza-extensions','-o','json']))['items']
claim=next(c for c in claims if c['metadata']['name'].startswith('service-graphiti-280d6347') and c['metadata']['name'].endswith('-neo4j-data'))
name=claim['metadata']['name'];size=claim['spec']['resources']['requests']['storage'];folder='/var/lib/replay-graphiti'
subprocess.run(['podman','machine','ssh','kamiwaza-harness-poc','sudo mkdir -p /var/lib/replay-graphiti && sudo chown 7474:7474 /var/lib/replay-graphiti && sudo chmod 700 /var/lib/replay-graphiti'],check=True)
body={'apiVersion':'v1','kind':'PersistentVolume','metadata':{'name':'replay-graphiti-data'},'spec':{'capacity':{'storage':size},'accessModes':claim['spec']['accessModes'],'persistentVolumeReclaimPolicy':'Retain','storageClassName':claim['spec'].get('storageClassName',''),'claimRef':{'namespace':'kamiwaza-extensions','name':name},'hostPath':{'path':folder,'type':'Directory'}}}
print(kub(['apply','-f','-'],body).strip());pathlib.Path('evidence/platform/graphiti-volume.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifest':body,'method':'Explicit retained local volume; no default storage class changes'},indent=2))
