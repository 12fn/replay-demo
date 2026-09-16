import json,pathlib,hashlib
from fastembed import TextEmbedding
model=TextEmbedding(model_name='BAAI/bge-small-en-v1.5',cache_dir='/models',threads=2)
vectors=list(model.embed(['A cited source supports this exercise assessment.','An unrelated weather forecast.']))
assert len(vectors)==2 and len(vectors[0])==384
files=[{'path':str(p.relative_to('/models')),'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest(),'bytes':p.stat().st_size} for p in sorted(pathlib.Path('/models').rglob('*')) if p.is_file() and not p.is_symlink() and not '/.locks/' in str(p)]
pathlib.Path('/models/replay-model-manifest.json').write_text(json.dumps({'model':'BAAI/bge-small-en-v1.5','dimensions':384,'fastembed':'0.8.0','files':files},indent=2))
print('Cached and qualified 384-dimensional CPU model; artifact hashes saved.')
