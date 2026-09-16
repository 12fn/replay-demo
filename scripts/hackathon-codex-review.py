"""One bounded, read-only coding review using the hackathon's Codex-only token.

No persistent login, API fallback, personal config, browser tokens, or paid app calls.
The model receives explicit source files on stdin and must not invoke tools.
"""
import datetime
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
CLI = '/Applications/Codex.app/Contents/Resources/codex'
TOKEN = ROOT / 'data/hackathon-codex-access-token'
SOURCES = ['src/scenarios/evidence-packet.ts', 'tests/scenarios/evidence-packet.test.ts']

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--task', help='Reviewed task JSON with name, prompt, and explicit source paths')
    args = parser.parse_args()
    task = json.loads(Path(args.task).read_text()) if args.task else None
    if datetime.datetime.now(datetime.timezone.utc).date() > datetime.date(2026, 9, 18):
        raise RuntimeError('Sponsored access window ended; no automatic fallback')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
    name = task['name'] if task else 'packet-review'
    if not name.replace('-', '').isalnum():
        raise ValueError('Invalid task name')
    output = ROOT / 'evidence/codex' / ('hackathon-' + name + '-' + stamp)
    output.parent.mkdir(parents=True, exist_ok=True)
    secret = TOKEN.read_text().strip()
    if not secret or TOKEN.stat().st_mode & 0o077:
        raise RuntimeError('Missing or insufficiently protected hackathon token')
    auth_path = Path.home() / '.codex/auth.json'
    auth_hash = lambda: hashlib.sha256(auth_path.read_bytes()).hexdigest() if auth_path.exists() else None
    before = auth_hash()
    env = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ('API_KEY', 'ACCESS_TOKEN', 'AUTH_TOKEN'))}
    env['CODEX_ACCESS_TOKEN'] = secret
    prompt = ('Review the supplied TypeScript implementation and tests for REPLAY, a fictional abstract '
              'learning game. Do not use any tools or read other files. Find at most three concrete '
              'correctness gaps in time cutoff, same-side source lineage, derivative corroboration, '
              'or immutability. Give a minimal regression test or patch for each real issue; say if no '
              'issue is established. Distinguish static review from executed tests. Keep under 1000 words.\n')
    if task:
        prompt = task['prompt'] + '\nDo not invoke tools or read other files. Return only the requested artifact.\n'
    manifest = []
    for name in (task['sources'] if task else SOURCES):
        if not name.startswith(('src/scenarios/', 'tests/scenarios/', 'src/client/components/', 'docs/process/')) or '..' in Path(name).parts:
            raise ValueError('Source outside reviewed demo module roots')
        content = (ROOT / name).read_text()
        manifest.append({'path': name, 'sha256': hashlib.sha256(content.encode()).hexdigest()})
        prompt += '\nFILE ' + name + '\n```typescript\n' + content + '\n```\n'
    cmd = [CLI, 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
           '-s', 'read-only', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="medium"',
           '-c', 'cli_auth_credentials_store="ephemeral"', '--json', '-']
    start = time.monotonic()
    child = subprocess.Popen(cmd, cwd=ROOT, env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = child.communicate(prompt, timeout=240)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGTERM)
        try:
            stdout, stderr = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            stdout, stderr = child.communicate()
    stdout, stderr = stdout.replace(secret, '[REDACTED]'), stderr.replace(secret, '[REDACTED]')
    output.with_suffix('.jsonl').write_text(stdout)
    output.with_suffix('.stderr').write_text(stderr)
    events = []
    for line in stdout.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    usage = [e for e in events if e.get('type') == 'turn.completed']
    proof = {'at': stamp, 'workspace': 'MCU NPS Hackathon', 'credential': 'Codex-only access token',
             'expires': '2026-09-21', 'model_requested': 'gpt-5.6-sol', 'sources': manifest,
             'exit_code': child.returncode, 'timed_out': timed_out,
             'duration_seconds': round(time.monotonic() - start, 2), 'usage_events': usage,
             'personal_auth_unchanged': before == auth_hash(), 'app_inference_calls': 0,
             'artifact': str(output.with_suffix('.jsonl').relative_to(ROOT))}
    output.with_suffix('.proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof))
    if child.returncode:
        print(stderr[-1500:])
        print(stdout[-1500:])
    return child.returncode or (1 if timed_out else 0)

if __name__ == '__main__':
    raise SystemExit(main())
