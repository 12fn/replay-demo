"""Bind the two new Tomo claims to retained local volumes, without changing cluster defaults."""
import datetime
import json
import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NS = 'kamiwaza-extensions'


def remote(args, data=None):
    result = subprocess.run(['podman', 'machine', 'ssh', 'kamiwaza-harness-poc', shlex.join(args)],
                            input=data, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Volume operation failed: ' + result.stderr[:1000])
    return result.stdout


def kub(args, body=None):
    return remote(['sudo', 'k0s', 'kubectl', *args], json.dumps(body) if body else None)


def main():
    receipt_path = ROOT / 'evidence/platform/tomo-volumes-1.2.0.json'
    if receipt_path.exists():
        raise RuntimeError('Preserve existing volume receipt and data')
    claims = json.loads(kub(['get', 'pvc', '-n', NS, '-o', 'json']))['items']
    selected = []
    for service, uid in [('postgres', 70), ('seaweedfs', 1000)]:
        name = f'replay-tomo-{service}-data'
        matches = [c for c in claims if c['metadata']['name'] == name]
        if len(matches) != 1:
            raise RuntimeError('Expected exact Tomo claim: ' + name)
        claim = matches[0]
        if claim['status']['phase'] != 'Pending' or claim['spec'].get('volumeName'):
            raise RuntimeError('Claim is not an unbound new claim: ' + name)
        if claim['spec']['resources']['requests']['storage'] != '4Gi' or claim['spec'].get('storageClassName') != 'replay-local':
            raise RuntimeError('Unexpected storage contract: ' + name)
        selected.append((claim, uid, f'/var/lib/replay-tomo-{service}'))
    receipts = []
    for claim, uid, folder in selected:
        # Dedicated new directories only. mkdir refuses an existing path; no recursive chown.
        remote(['sudo', 'mkdir', '-m', '700', folder])
        remote(['sudo', 'chown', f'{uid}:{uid}', folder])
        name = claim['metadata']['name']
        body = {'apiVersion': 'v1', 'kind': 'PersistentVolume', 'metadata': {'name': name},
                'spec': {'capacity': {'storage': '4Gi'}, 'accessModes': ['ReadWriteOnce'],
                         'persistentVolumeReclaimPolicy': 'Retain', 'storageClassName': 'replay-local',
                         'claimRef': {'namespace': NS, 'name': name},
                         'hostPath': {'path': folder, 'type': 'Directory'}}}
        kub(['create', '-f', '-', '-o', 'name'], body)
        receipts.append({'manifest': body, 'directoryOwner': uid})
    with receipt_path.open('x') as out:
        json.dump({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'volumes': receipts,
                   'method': 'Dedicated new local retained volumes; no storage class or existing volume changes'}, out, indent=2)
    print(json.dumps({'createdRetainedVolumes': len(receipts), 'receipt': str(receipt_path.relative_to(ROOT))}))


if __name__ == '__main__':
    main()
