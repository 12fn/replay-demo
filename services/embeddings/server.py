"""Small CPU embedding service; no external inference or source-content logging."""
import base64, hmac, json, os, struct, threading, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from fastembed import TextEmbedding
MODEL='BAAI/bge-small-en-v1.5'
secret=os.environ.get('REPLAY_EMBEDDING_TOKEN','')
expected_subject=os.environ.get('REPLAY_GRAPHITI_SUBJECT','')
api_base=os.environ.get('REPLAY_KAMIWAZA_API','').rstrip('/')
if len(secret)<32 and not (expected_subject and api_base):raise RuntimeError('Configure native workload identity or a server-only embedding token')
model=TextEmbedding(model_name=MODEL,cache_dir='/models',threads=2,local_files_only=True)
lock=threading.BoundedSemaphore(1)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,status,body):
  data=json.dumps(body,separators=(',',':')).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
 def authorized(self):
  bearer=self.headers.get('Authorization','')
  if secret and hmac.compare_digest(bearer.encode(),('Bearer '+secret).encode()):return True
  if not expected_subject or not api_base or not bearer.startswith('Bearer ') or len(bearer)>16384:return False
  headers={'Authorization':bearer,'X-Forwarded-Method':'GET','X-Forwarded-Uri':'/api/auth/users/me','X-Forwarded-Host':os.environ.get('REPLAY_FORWARDED_HOST','kamiwaza-harness.localhost'),'X-Forwarded-Proto':'https'}
  try:
   with urllib.request.urlopen(urllib.request.Request(api_base+'/auth/forward/validate',headers=headers),timeout=5) as r:
    r.read()
    return r.status==200 and r.headers.get('x-user-id')==expected_subject and 'service' in r.headers.get('x-user-roles','').split(',')
  except Exception:return False
 def do_GET(self):
  if self.path=='/health':return self.send(200,{'status':'ready','model':MODEL,'dimensions':384,'provider':'local CPU FastEmbed','paidInference':False})
  if not self.authorized():return self.send(401,{'error':'Authentication required'})
  if self.path=='/v1/models':return self.send(200,{'object':'list','data':[{'id':MODEL,'object':'model','owned_by':'BAAI'}]})
  return self.send(404,{'error':'Not found'})
 def do_POST(self):
  if not self.authorized():return self.send(401,{'error':'Authentication required'})
  if self.path!='/v1/embeddings':return self.send(404,{'error':'Not found'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size<1 or size>65536:return self.send(413,{'error':'Request exceeds 64 KiB'})
   body=json.loads(self.rfile.read(size));inputs=body.get('input');inputs=[inputs] if isinstance(inputs,str) else inputs
   if body.get('model')!=MODEL or not isinstance(inputs,list) or not 1<=len(inputs)<=32 or any(not isinstance(s,str) or not s or len(s.encode())>8192 for s in inputs):return self.send(400,{'error':'Expected supported model and 1–32 nonempty strings, each at most 8 KiB'})
   fmt=body.get('encoding_format','float')
   if fmt not in ('float','base64') or body.get('dimensions',384)!=384:return self.send(400,{'error':'Supported encoding float/base64; dimensions 384'})
   if not lock.acquire(blocking=False):return self.send(429,{'error':'Embedding worker busy; retry later'})
   try:vectors=[v.tolist() for v in model.embed(inputs)]
   finally:lock.release()
   encoded=lambda v:base64.b64encode(struct.pack('<384f',*v)).decode() if fmt=='base64' else v
   return self.send(200,{'object':'list','model':MODEL,'data':[{'object':'embedding','index':i,'embedding':encoded(v)} for i,v in enumerate(vectors)],'usage':{'prompt_tokens':0,'total_tokens':0},'replay_usage':{'metering':'local CPU; token counts not measured','items':len(vectors)}})
  except (ValueError,TypeError,KeyError):return self.send(400,{'error':'Malformed embedding request'})
  except Exception:return self.send(500,{'error':'Embedding worker failed'})
if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',8000),Handler).serve_forever()
