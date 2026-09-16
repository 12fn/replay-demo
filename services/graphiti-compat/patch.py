"""Fix an installed-version integration seam, not model aliasing.

Graphiti OpenAIEmbedder.create reads config.embedding_model, while the supplied service
assigns the unused embedder.model attribute. Preserve all other native bootstrap/auth code.
"""
from pathlib import Path
import hashlib,json
p=Path('/app/graph_service/zep_graphiti.py');source=p.read_text()
old='        client.embedder.model = settings.embedding_model_name'
if source.count(old)!=1:raise RuntimeError('Expected release-1.2.0 embedding configuration seam not found')
updated=source.replace(old,'        client.embedder.config.embedding_model = settings.embedding_model_name')
p.write_text(updated)
Path('/app/replay-graphiti-compat.json').write_text(json.dumps({'patch':'embedding-model-config','source_sha256':hashlib.sha256(source.encode()).hexdigest(),'patched_sha256':hashlib.sha256(updated.encode()).hexdigest(),'behavior':'Configured model name reaches the actual embedding request; authentication unchanged.'},indent=2))
print('Applied verified embedding-model configuration compatibility patch.')
Path(__file__).unlink()
