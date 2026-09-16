"""Copy the supplied Tomo API image privately for installed-version inspection; never run it."""
import hashlib,json,tarfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
catalog=next((root/'data/platform/tomo-catalog').rglob('kamiwaza-extensions-tomo/registry/garden/v3/docker-images/manifest.json'))
manifest=json.loads(catalog.read_text())
name='ghcr.io/kamiwaza-internal/kamiwaza-extensions-tomo/images/kaizen-api:release-1.2.0'
entry=manifest['images'][name]['export'];out=root/'data/platform/tomo-image';out.mkdir(exist_ok=True,mode=0o700)
target=out/entry['file'];bundle=Path.home()/'kw-offline-build/usb-out/bundle/assembled/kamiwaza-extensions-bundle-1.2.0-linux-arm64-spark.tar.gz'
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
if not target.exists():
 with tarfile.open(bundle,'r|gz') as archive:
  for member in archive:
   if member.name.endswith('/kamiwaza-extensions-tomo/registry/garden/v3/docker-images/'+entry['file']):
    if not member.isfile() or member.size!=entry['size']:raise RuntimeError('Supplied image size/type mismatch')
    stream=archive.extractfile(member)
    with target.open('xb') as dst:
     target.chmod(0o600)
     for b in iter(lambda:stream.read(1024*1024),b''):dst.write(b)
    break
  else:raise RuntimeError('API image absent from supplied bundle')
sha=digest(target)
if sha!=entry['sha256']:raise RuntimeError('Image checksum mismatch; retained for diagnosis')
receipt={'image':name,'source':'supplied release-1.2.0 offline extension bundle','archiveSha256':sha,'bytes':target.stat().st_size,'manifestMatched':True,'deployed':False}
(root/'evidence/platform/tomo-api-image-inspection.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
