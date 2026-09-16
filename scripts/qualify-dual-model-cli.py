"""Exercise the actual TS CLI/provider-driver contract using fake holds; zero inference.

Default: the original six-round short qualification. --mode full-game writes a separate write-once proof.
--scenario taiwan-strait/1 (either mode) writes its own proof under a new timestamped name; older proofs are never touched."""
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dual_runner', ROOT / 'scripts/run-dual-model-trial.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
SHORT_PROOF = 'evidence/platform/dual-model-cli-fake-20260915.json'
FULL_GAME_PROOF = 'evidence/platform/dual-model-cli-fake-full-game-{rounds}r-20260915.json'
# Unique per run: scenario slug, mode/bound and UTC second. Written with exclusive create.
SCENARIO_PROOF = 'evidence/platform/dual-model-cli-fake-{slug}-{bound}-{stamp}.json'


def scenario_proof_path(scenario, mode, rounds, now):
    slug = scenario.replace('/', '-')
    bound = 'short' if mode == 'short' else f'full-game-{rounds}r'
    return SCENARIO_PROOF.format(slug=slug, bound=bound, stamp=now.strftime('%Y%m%dT%H%M%SZ'))


def fake_call(seat, prompt, schema, folder, name, index):
    manifest = runner.read_json(folder / 'manifest.json')
    snapshot = runner.read_json(runner.inside(folder, manifest['cursor']['seats'][seat]['snapshot']))
    assert snapshot['seat'] == seat and manifest['cursor']['round'] == index
    assert snapshot['snapshotId'] in prompt
    return {'snapshotId': snapshot['snapshotId'], 'choice': 'hold', 'share': None,
            'rationale': 'Deterministic offline CLI qualification; no model called.'}, {'model': 'fake'}


def qualify_short():
    with tempfile.TemporaryDirectory(prefix='replay-dual-cli-') as temp:
        result = runner.run_trial('fake-holds', call=fake_call, root=Path(temp))
        summary = result['summary']
        assert result['status'] == 'completed' and len(result['rounds']) == 6
        assert all(r['applicationStatus'] == 'applied' for r in result['rounds'])
        assert summary['stopReason'] == 'round-limit' and summary['outcome'] is None
        assert summary['ticksSimulated'] == 1665
        assert summary['reconstruction']['recordedOrders'] == 0
        assert all(summary['orders'][seat]['holds'] == 6 for seat in runner.SEATS)
        return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'status': 'passed', 'kind': 'actual-cli-fake-provider-qualification',
                'actualProviderCalls': 0, 'fakeResponses': 12, 'rounds': 6,
                'ticksSimulated': summary['ticksSimulated'], 'summary': summary,
                'note': 'Actual Python driver and TS CLI used temporary artifacts and deterministic hold replies. No Sol/Opus/native/app inference.'}


def qualify_full_game(rounds):
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='replay-dual-cli-full-') as temp:
        result = runner.run_trial('fake-holds-full-game', call=fake_call, root=Path(temp), mode='full-game', rounds=rounds)
        summary, played = result['summary'], len(result['rounds'])
        assert result['status'] == 'completed' and result['mode'] == runner.FULL_GAME_MODE
        assert summary['config'] == {'mode': runner.FULL_GAME_MODE, 'maxRounds': rounds, 'ticksPerRound': 270, 'seed': 'DUAL0001'}
        assert 1 <= played <= rounds and result['maxCalls'] == 2 * rounds
        assert result['modelCallsAttempted'] == result['callSlotsReserved'] == 2 * played
        assert all(r['applicationStatus'] == 'applied' for r in result['rounds'])
        if summary['stopReason'] == 'round-limit':
            assert played == rounds and summary['outcome'] is None and summary['scoresStatus'] == 'provisional'
        else:
            assert summary['stopReason'] == 'game-outcome' and summary['outcome'] is not None
        assert summary['reconstruction']['recordedOrders'] == 0 and summary['reconstruction']['unlistedOrders'] == 0
        assert all(summary['orders'][seat]['holds'] == played for seat in runner.SEATS)
        assert summary['claims']['mode'] == runner.FULL_GAME_MODE
        return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'status': 'passed', 'kind': 'actual-cli-fake-provider-full-game-qualification', 'mode': runner.FULL_GAME_MODE,
                'actualProviderCalls': 0, 'fakeResponses': 2 * played, 'maxRounds': rounds, 'rounds': played,
                'stopReason': summary['stopReason'], 'outcome': summary['outcome'],
                'ticksSimulated': summary['ticksSimulated'], 'elapsedSeconds': round(time.monotonic() - started, 1),
                'runnerSources': result['sources'], 'summary': summary,
                'note': 'Actual Python driver and TS CLI in full-game/1 used temporary artifacts and deterministic hold replies. '
                        'No Sol/Opus/native/app inference. Proves runner bounds and stop handling only, not game quality or learning.'}


def qualify_scenario(scenario, mode, rounds):
    """Actual TS CLI with deterministic holds on a selected scenario; checks the Red-only brief before every fake reply."""
    started = time.monotonic()
    briefs = []

    def scenario_call(seat, prompt, schema, folder, name, index):
        manifest = runner.read_json(folder / 'manifest.json')
        snapshot = runner.read_json(runner.inside(folder, manifest['cursor']['seats'][seat]['snapshot']))
        observation = snapshot['observation']
        assert observation['scenario']['id'] == scenario and observation['scenario']['map'] == runner.TAIWAN_MAP
        assert ('redCell' in observation) == (seat == 'red') and (runner.RED_CELL_PROFILE in prompt) == (seat == 'red')
        if seat == 'red':
            assert observation['redCell']['profile'] == runner.RED_CELL_PROFILE
            briefs.append(observation['redCell']['provenance']['instructionsSha256'])
        return fake_call(seat, prompt, schema, folder, name, index)

    with tempfile.TemporaryDirectory(prefix='replay-dual-cli-scenario-') as temp:
        result = runner.run_trial('fake-holds-scenario', call=scenario_call, root=Path(temp), mode=mode, rounds=rounds, scenario=scenario)
        folder = Path(temp) / 'evidence/dual-model-trial/fake-holds-scenario'
        game = runner.read_json(folder / 'initialization/game.json')
        summary, played = result['summary'], len(result['rounds'])
        expected = runner.trial_bounds(mode, rounds, scenario)[0]
        assert result['status'] == 'completed' and result['scenario'] == scenario
        assert summary['config'] == expected and game['config'] == expected
        assert game['scenarioId'] == scenario and game['map'] == runner.TAIWAN_MAP and summary['scenario'] == game['scenario']
        assert summary['claims']['scenarioId'] == scenario and 'not the native continuous Taiwan exercise' in summary['claims']['scenario']
        assert result['modelCallsAttempted'] == result['callSlotsReserved'] == 2 * played
        assert all(r['applicationStatus'] == 'applied' for r in result['rounds'])
        assert len(briefs) == played and len(set(briefs)) == 1
        assert summary['reconstruction']['recordedOrders'] == 0 and summary['reconstruction']['unlistedOrders'] == 0
        assert all(summary['orders'][seat]['holds'] == played for seat in runner.SEATS)
        if mode == 'short':
            assert played == 6 and summary['stopReason'] == 'round-limit' and summary['outcome'] is None
        elif summary['stopReason'] == 'round-limit':
            assert played == expected['maxRounds'] and summary['outcome'] is None
        else:
            assert summary['stopReason'] == 'game-outcome' and summary['outcome'] is not None
        return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'status': 'passed', 'kind': 'actual-cli-fake-provider-scenario-qualification',
                'scenario': scenario, 'map': runner.TAIWAN_MAP, 'redCellProfile': runner.RED_CELL_PROFILE,
                **({'mode': runner.FULL_GAME_MODE} if mode == 'full-game' else {}),
                'actualProviderCalls': 0, 'fakeResponses': 2 * played, 'maxRounds': expected['maxRounds'], 'rounds': played,
                'stopReason': summary['stopReason'], 'outcome': summary['outcome'],
                'ticksSimulated': summary['ticksSimulated'], 'elapsedSeconds': round(time.monotonic() - started, 1),
                'runnerSources': result['sources'], 'summary': summary,
                'note': f'Actual Python driver and TS CLI on {scenario} used temporary artifacts and deterministic hold replies. '
                        f'Red-only {runner.RED_CELL_PROFILE} context was checked before every fake reply. No Sol/Opus/native/app inference. '
                        'Accelerated offline runner only: proves scenario selection, bounds and stop handling, not native continuous play, game quality or learning.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=runner.MODES, default='short')
    parser.add_argument('--rounds', type=int)
    parser.add_argument('--scenario', choices=runner.SCENARIOS)
    args = parser.parse_args()
    try:
        runner.trial_bounds(args.mode, args.rounds, args.scenario)
    except ValueError as error:
        parser.error(str(error))
    rounds = runner.FULL_GAME_MAX_ROUNDS if args.rounds is None else args.rounds
    if args.scenario:
        out = ROOT / scenario_proof_path(args.scenario, args.mode, rounds, datetime.datetime.now(datetime.timezone.utc))
    else:
        out = ROOT / (SHORT_PROOF if args.mode == 'short' else FULL_GAME_PROOF.format(rounds=rounds))
    # Refuse before any work so an existing proof is never replaced.
    if out.exists():
        raise FileExistsError(f'{out.relative_to(ROOT)} already exists; preserve it')
    if args.scenario:
        proof = qualify_scenario(args.scenario, args.mode, None if args.mode == 'short' else rounds)
    else:
        proof = qualify_short() if args.mode == 'short' else qualify_full_game(rounds)
    runner.write_once(out, proof)
    print(json.dumps({'status': proof['status'], 'actualProviderCalls': 0, 'proof': str(out.relative_to(ROOT))}))
