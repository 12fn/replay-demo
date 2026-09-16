"""Create new local Tomo storage credentials. Never print or write their values to artifacts."""
import base64
import datetime
import json
import secrets
import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SECRET = 'replay-tomo-private'
NS = 'kamiwaza-extensions'


def kub(args, data=None):
    result = subprocess.run(['podman', 'machine', 'ssh', 'kamiwaza-harness-poc',
                             shlex.join(['sudo', 'k0s', 'kubectl', *args])],
                            input=data, text=True, capture_output=True)
    if result.returncode:
        # kubectl failures can include the request object. Never forward it to a log.
        raise RuntimeError('Kubernetes operation failed; request and response withheld')
    return result.stdout


def main():
    receipt_path = ROOT / 'evidence/platform/tomo-private-provision-1.2.0.json'
    if receipt_path.exists():
        raise RuntimeError('Preserve the existing provisioning receipt')
    manifest = json.loads((ROOT / 'data/platform/tomo-runtime/evidence-manifest.json').read_text())
    if manifest['secretName'] != SECRET:
        raise RuntimeError('Unexpected secret contract')
    required = set(manifest['requiredSecretKeys'])
    empty = {'SLACK_BOT_TOKEN', 'LINEAR_WEBHOOK_SECRET', 'OTEL_EXPORTER_OTLP_HEADERS'}
    random_keys = {'POSTGRES_PASSWORD', 'RETENTION_PASSWORD', 'KAIZEN_APP_PASSWORD',
                   'SEAWEEDFS_S3_ACCESS_KEY', 'SEAWEEDFS_S3_SECRET_KEY', 'PI_SIDECAR_TOKEN',
                   'SANDBOX_WORKER_TOKEN', 'PKG_RUNNER_TOKEN', 'KAIZEN_CAPABILITY_SIGNING_KEY',
                   'KAIZEN_A2A_SHARED_SECRET', 'SANDBOX_EGRESS_SIGNING_KEY'}
    if required - empty - random_keys - {'DATABASE_URL', 'SECRET_ENCRYPTION_KEY'}:
        raise RuntimeError('Unknown secret purpose; inspect before provisioning')
    existing = kub(['get', 'secret', SECRET, '-n', NS, '--ignore-not-found', '-o', 'name'])
    if existing.strip():
        raise RuntimeError('Secret already exists; preserve it and inspect the prior provisioning receipt')
    values = {key: secrets.token_urlsafe(32) for key in random_keys}
    values.update({key: '' for key in empty})
    values['SECRET_ENCRYPTION_KEY'] = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
    values['DATABASE_URL'] = ('postgresql+asyncpg://postgres:' + values['POSTGRES_PASSWORD'] +
                              '@replay-tomo-postgres:5432/tomo')
    body = {'apiVersion': 'v1', 'kind': 'Secret', 'type': 'Opaque',
            'metadata': {'name': SECRET, 'namespace': NS,
                         'labels': {'app.kubernetes.io/part-of': 'replay-tomo'}},
            'stringData': {key: values[key] for key in required}}
    try:
        kub(['create', '-f', '-', '-o', 'name'], json.dumps(body))
    finally:
        values.clear()
        body.clear()
    receipt = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'secret': SECRET, 'namespace': NS, 'keys': sorted(required),
               'scope': 'Generated local service credentials only; no platform or model credential',
               'externalIntegrationsDisabled': sorted(required & empty), 'valuesCatalogued': False}
    with receipt_path.open('x') as out:
        json.dump(receipt, out, indent=2)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
