"""Bounded held-out observation comparison. Default prints plan; --run performs at most 96 provider calls.

One new seed, two provider assignments, with/without round-feedback/2. No app inference, retries or resume.
This is a small exploratory comparison of observation usefulness, not a strength or human learning benchmark.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('feedback_runner', ROOT / 'scripts/run-dual-model-trial.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def plan():
    games = []
    # Reverse condition order for the swapped assignment; all games use the same new seed.
    for swap, profile in [(False, None), (False, 'feedback-v2'), (True, 'feedback-v2'), (True, None)]:
        assignment = runner.seat_assignment(swap)['id']
        label = 'v2' if profile else 'v1'
        games.append({'name': f'feedback-20260915-held0001-{label}-{assignment}',
                      'swap_providers': swap, 'observation_profile': profile})
    return {'schema': 'replay.feedback-comparison/1', 'seed': 'HELD0001', 'rounds': 12,
            'scenario': 'taiwan-strait/1', 'mode': 'full-game', 'maxProviderCalls': 96,
            'appInferenceCalls': 0, 'retries': 0, 'games': games,
            'limits': ['One seed and four games; no statistical or general strength claim.',
                       'Accelerated offline clock; 12-round cap may end before a game outcome.',
                       'Geography, Red-only brief and provider output constraints remain asymmetric.',
                       'Compare explicit use of order status and source timing; do not equate winning with learning.']}


def run(root=ROOT, call=None):
    p = plan()
    target = root / 'evidence/feedback-comparison/held0001-20260915'
    if target.exists() or any((root / 'evidence/dual-model-trial' / g['name']).exists() for g in p['games']):
        raise FileExistsError('Preserve existing comparison; no retry or replacement is allowed')
    runner.trial_bounds(p['mode'], p['rounds'], p['scenario'], p['seed'], 'feedback-v2')
    if len(p['games']) * p['rounds'] * 2 != p['maxProviderCalls']:
        raise ValueError('Call cap does not match plan')
    script_hashes = {n: hashlib.sha256((ROOT / 'scripts' / n).read_bytes()).hexdigest()
                     for n in ['dual-model-trial.ts', 'run-dual-model-trial.py', 'compare-round-feedback.py']}
    runner.write_once(target / 'plan.json', {**p, 'scriptSha256': script_hashes})
    state = {'status': 'running', 'callsAttempted': 0, 'games': [], 'appInferenceCalls': 0, 'retries': 0}
    call = call or runner.run_trial
    try:
        for game in p['games']:
            if state['callsAttempted'] + 2 * p['rounds'] > p['maxProviderCalls']:
                raise ValueError('Call ceiling reached before next game')
            entry = {**game, 'status': 'running'}
            state['games'].append(entry)
            (target / 'run.json').write_text(json.dumps(state, indent=2) + '\n')
            try:
                proof = call(game['name'], root=root, mode=p['mode'], rounds=p['rounds'],
                             scenario=p['scenario'], seed=p['seed'], swap_providers=game['swap_providers'],
                             observation_profile=game['observation_profile'])
            except BaseException:
                saved = root / 'evidence/dual-model-trial' / game['name'] / 'provider-proof.json'
                proof = runner.read_json(saved) if saved.exists() else {}
                entry.update(status='failed', callsAttempted=proof.get('modelCallsAttempted', 0))
                state['callsAttempted'] += entry['callsAttempted']
                raise
            entry.update(status=proof['status'], callsAttempted=proof['modelCallsAttempted'],
                         outcome=proof.get('summary', {}).get('outcome'),
                         stopReason=proof.get('summary', {}).get('stopReason'))
            state['callsAttempted'] += entry['callsAttempted']
            if proof['status'] != 'completed':
                raise RuntimeError('Incomplete game; remaining games will not be called')
            if state['callsAttempted'] > p['maxProviderCalls']:
                raise ValueError('Provider proof exceeded reserved call cap')
        state['status'] = 'completed'
    except BaseException:
        state['status'] = 'stopped-after-failure'
        raise
    finally:
        (target / 'run.json').write_text(json.dumps(state, indent=2) + '\n')
    return state


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run() if args.run else plan(), indent=2))
