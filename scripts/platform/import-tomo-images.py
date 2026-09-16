"""Import verified supplied Tomo images into the existing local k0s image store."""
import datetime
import hashlib
import json
import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main():
    proof = json.loads((ROOT / 'evidence/platform/tomo-runtime-images-1.2.0.json').read_text())
    results = []
    for entry in proof['images']:
        source = ROOT / 'data/platform/tomo-image' / entry['file']
        h = hashlib.sha256()
        with source.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        if h.hexdigest() != entry['sha256']:
            raise RuntimeError('Image archive changed since verification')
        cmd = shlex.join(['sudo', 'k0s', 'ctr', 'images', 'import', str(source)])
        result = subprocess.run(['podman', 'machine', 'ssh', 'kamiwaza-harness-poc', cmd],
                                capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('Image import failed: ' + result.stderr[:1000])
        print(json.dumps({'imported': entry['image']}), flush=True)
        results.append({'image': entry['image'], 'archiveSha256': entry['sha256'], 'importExitCode': 0})
    receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'target': 'kamiwaza-harness-poc k0s containerd', 'images': results,
               'deployed': False, 'qualification': 'Image store import only; no service started'}
    out = ROOT / 'evidence/platform/tomo-runtime-image-import-1.2.0.json'
    with out.open('x') as stream:
        json.dump(receipt, stream, indent=2)


if __name__ == '__main__':
    main()
