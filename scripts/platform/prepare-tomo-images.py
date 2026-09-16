"""Verify and privately stage the supplied Tomo chat runtime images; never start them."""
import hashlib
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMES = {'kaizen-api', 'kaizen-postgres', 'kaizen-valkey', 'kaizen-seaweedfs',
         'kaizen-web', 'kaizen-pi-sidecar', 'sandbox-controller'}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    catalog = next((ROOT / 'data/platform/tomo-catalog').rglob(
        'kamiwaza-extensions-tomo/registry/garden/v3/docker-images/manifest.json'))
    manifest = json.loads(catalog.read_text())
    selected = {name: info['export'] for name, info in manifest['images'].items()
                if name.rsplit('/', 1)[1].split(':')[0] in NAMES}
    if len(selected) != len(NAMES) or any(not n.endswith(':release-1.2.0') for n in selected):
        raise RuntimeError('Supplied runtime image set changed; inspect before staging')
    target_dir = ROOT / 'data/platform/tomo-image'
    target_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    missing = {e['file']: e for e in selected.values() if not (target_dir / e['file']).exists()}
    bundle = Path.home() / 'kw-offline-build/usb-out/bundle/assembled/kamiwaza-extensions-bundle-1.2.0-linux-arm64-spark.tar.gz'
    if missing:
        with tarfile.open(bundle, 'r|gz') as archive:
            for member in archive:
                for filename, expected in list(missing.items()):
                    suffix = '/kamiwaza-extensions-tomo/registry/garden/v3/docker-images/' + filename
                    if not member.name.endswith(suffix):
                        continue
                    if not member.isfile() or member.size != expected['size']:
                        raise RuntimeError('Archive entry size/type mismatch: ' + filename)
                    target = target_dir / filename
                    with target.open('xb') as dst:
                        target.chmod(0o600)
                        stream = archive.extractfile(member)
                        for block in iter(lambda: stream.read(1024 * 1024), b''):
                            dst.write(block)
                    del missing[filename]
                    print(json.dumps({'staged': filename, 'bytes': member.size}), flush=True)
                if not missing:
                    break
        if missing:
            raise RuntimeError('Required images missing from supplied bundle')
    results = []
    for name, expected in selected.items():
        target = target_dir / expected['file']
        sha = digest(target)
        if sha != expected['sha256'] or target.stat().st_size != expected['size']:
            raise RuntimeError('Image verification failed; retained for diagnosis: ' + name)
        with tarfile.open(target) as archive:
            image = json.load(archive.extractfile('manifest.json'))
            if len(image) != 1 or name not in image[0].get('RepoTags', []):
                raise RuntimeError('Image tag mismatch: ' + name)
            config = json.load(archive.extractfile(image[0]['Config']))
            if config.get('architecture') != 'arm64' or config.get('os') != 'linux':
                raise RuntimeError('Image architecture mismatch: ' + name)
        results.append({'image': name, 'file': expected['file'], 'bytes': expected['size'],
                        'sha256': sha, 'platform': 'linux/arm64'})
    receipt = {'source': 'supplied Kamiwaza 1.2.0 offline bundle',
               'catalogManifestSha256': digest(catalog), 'images': results,
               'imageExecution': False, 'qualification': 'archives verified; runtime not qualified'}
    out = ROOT / 'evidence/platform/tomo-runtime-images-1.2.0.json'
    content = json.dumps(receipt, indent=2) + '\n'
    if out.exists() and out.read_text() != content:
        raise RuntimeError('Existing image receipt differs; preserve and inspect it')
    if not out.exists():
        out.write_text(content)
    print(json.dumps({'verifiedImages': len(results), 'receipt': str(out.relative_to(ROOT))}))


if __name__ == '__main__':
    main()
