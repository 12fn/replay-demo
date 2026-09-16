"""Extract the installed-version operator from the user's existing offline bundle."""
import io,json,tarfile,shutil,sys
from pathlib import Path
name=sys.argv[1] if len(sys.argv)>1 else 'extension-operator'
if name not in ['extension-operator','istio-base','istiod','istio-gateway']:raise SystemExit('Unknown supplied component')
root=Path(__file__).resolve().parents[2];out=root/'data/platform'/('operator' if name=='extension-operator' else name);out.mkdir(parents=True,exist_ok=True)
parts=sorted((Path.home()/'kw-offline-build/usb-out/bundle/assembled').glob('kamiwaza-helm-1.2.0-linux-arm64-spark.0*.tar'))
class Segments(io.RawIOBase):
 def __init__(self):self.sizes=[p.stat().st_size for p in parts];self.pos=0
 def readable(self):return True
 def seekable(self):return True
 def tell(self):return self.pos
 def seek(self,offset,whence=0):self.pos=offset if whence==0 else self.pos+offset if whence==1 else sum(self.sizes)+offset;return self.pos
 def read(self,n=-1):
  if n<0:n=sum(self.sizes)-self.pos
  remaining=n;output=[];start=0
  for p,size in zip(parts,self.sizes):
   if self.pos<start+size and remaining:
    with p.open('rb') as f:f.seek(max(0,self.pos-start));chunk=f.read(min(remaining,start+size-self.pos))
    output.append(chunk);self.pos+=len(chunk);remaining-=len(chunk)
   start+=size
  return b''.join(output)
wrap=out/(name+'.wrap')
if not wrap.exists():
 with tarfile.open(fileobj=Segments(),mode='r:') as tar:
  m=tar.getmember('kamiwaza-helm-1.2.0-linux-arm64-spark/'+name+'.wrap')
  with tar.extractfile(m) as src,wrap.open('wb') as dst:shutil.copyfileobj(src,dst,1024*1024)
with tarfile.open(wrap) as tar:
 tar.extractall(out/'extracted',filter='data');print('\n'.join(x.name for x in tar.getmembers())[:3500])
