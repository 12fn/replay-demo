"""No inference: the paired driver plans without calls, enforces explicit caps, runs games one at a time and reports only recorded data."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('paired_red', HERE.parents[2] / 'scripts/paired-red-evaluation.py')
paired = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paired)
fake_spec = importlib.util.spec_from_file_location('dual_runner_tests', HERE.parent / 'test_dual_model_runner.py')
fakes = importlib.util.module_from_spec(fake_spec)
fake_spec.loader.exec_module(fakes)
runner = paired.runner
SCRIPT = HERE.parents[2] / 'scripts/paired-red-evaluation.py'


class ScoredHarness(fakes.FakeHarness):
    """Fake Taiwan game that ends after `outcome_after` rounds with Red winning 40-30 and records opening resources."""
    def __call__(self, args):
        super().__call__(args)
        if args[0] == 'init':
            for seat in runner.SEATS:
                path = self.folder / f'rounds/00/{seat}/snapshot.json'
                snapshot = runner.read_json(path)
                snapshot['observation']['ownResources'] = {'troops': 40654, 'gold': 64300, 'tiles': 52 if seat == 'blue' else 52}
                path.write_text(json.dumps(snapshot))
        summary = self.folder / 'final/summary.json'
        if summary.exists():
            data = runner.read_json(summary)
            data.update(scores={'blue': 30, 'red': 40}, scoresStatus='final' if data['stopReason'] == 'game-outcome' else 'provisional',
                        engine={'simulationProfile': 'naval-isolation/1'})
            summary.write_text(json.dumps(data))


def modelled(seat, prompt, schema, folder, name, index, provider):
    return ({'snapshotId': f'{seat}-{index}', 'choice': 'hold', 'share': None, 'rationale': 'fake'},
            {'model': runner.PROVIDER_MODELS[provider], 'usage': [{'type': 'turn.completed', 'usage': {'input_tokens': 10, 'output_tokens': 2}}]}
            if provider == 'sol' else
            {'model': runner.PROVIDER_MODELS[provider], 'usage': {'claude-opus-5': {'inputTokens': 1, 'cacheCreationInputTokens': 9, 'outputTokens': 3}}})


def fake_trial(root, call=modelled, harness=lambda: ScoredHarness(outcome_after=2), log=None):
    active = []
    def trial(name, **options):
        active.append(name)
        if log is not None:
            log.append((name, len(active), options))
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return runner.run_trial(name, call, harness(), root, **options)
        finally:
            active.remove(name)
    return trial


class PlanTests(unittest.TestCase):
    def test_default_plan_pairs_each_seed_across_both_assignments_within_caps(self):
        plan = paired.build_plan('paired-test')
        games = plan['games']
        self.assertEqual([(g['seed'], g['assignment']) for g in games],
                         [('PAIR0001', 'sol-blue-opus-red'), ('PAIR0001', 'opus-blue-sol-red'),
                          ('PAIR0002', 'opus-blue-sol-red'), ('PAIR0002', 'sol-blue-opus-red')])
        self.assertEqual(games[1]['models'], {'blue': 'claude-opus-5', 'red': 'gpt-5.6-sol'})
        self.assertEqual((plan['worstCaseCalls'], plan['callCap'], plan['gameCap'], len(games)), (360, 360, 4, 4))
        self.assertEqual((plan['scenario'], plan['mode'], plan['ticksPerRound'], plan['retries']), ('taiwan-strait/1', 'full-game/1', 270, 0))
        self.assertTrue(any('No single game is balanced' in caveat for caveat in plan['caveats']))

    def test_invalid_plan_arguments_are_refused(self):
        for prefix, seeds, rounds in [('Bad_Prefix', ['A'], 45), ('p', [], 45), ('p', ['A', 'B', 'C'], 45), ('p', ['ab', 'AB'], 45),
                                      ('p', ['bad seed'], 45), ('p', ['A'], 46), ('p', ['A'], 0), ('x' * 31, ['y' * 32], 45)]:
            with self.subTest(prefix=prefix, seeds=seeds, rounds=rounds), self.assertRaises(ValueError):
                paired.build_plan(prefix, seeds, rounds)

    def test_run_limits_must_be_explicit_and_within_caps_before_anything_is_written(self):
        plan = paired.build_plan('paired-test')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for calls, games in [(None, 4), (360, None), (361, 4), (360, 5), (0, 4), (True, 4), (359, 4), (360, 3)]:
                with self.subTest(calls=calls, games=games), self.assertRaises(ValueError):
                    paired.run_plan(plan, calls, games, root, trial=lambda *a, **k: self.fail('no game may start'))
            (root / plan['games'][3]['folder']).mkdir(parents=True)
            with self.assertRaises(FileExistsError):
                paired.run_plan(plan, 360, 4, root, trial=lambda *a, **k: self.fail('no game may start'))
            self.assertFalse((root / plan['receipts']).exists())
        smaller = paired.build_plan('paired-test', ['PAIR0001'], 10)
        paired.validate_run(smaller, 40, 2, Path(tempfile.gettempdir()) / 'paired-missing-root')

    def test_cli_plan_is_default_and_run_needs_explicit_prefix_and_caps(self):
        planned = subprocess.run([runner.sys.executable, str(SCRIPT), '--prefix', 'paired-cli-plan'], capture_output=True, text=True, timeout=30)
        self.assertEqual(planned.returncode, 0, planned.stderr)
        self.assertEqual(len(json.loads(planned.stdout)['games']), 4)
        for args in (['--run'], ['--run', '--prefix', 'paired-cli-x', '--max-calls', '360'], ['--run', '--prefix', 'paired-cli-x', '--max-games', '4'],
                     ['--run', '--prefix', 'paired-cli-x', '--max-calls', '361', '--max-games', '4'],
                     ['--plan', '--max-calls', '360'], ['--report'], ['--plan', '--run']):
            refused = subprocess.run([runner.sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=30)
            self.assertEqual(refused.returncode, 2, args)
        for prefix in ('paired-cli-plan', 'paired-cli-x'):
            self.assertFalse((runner.ROOT / paired.RECEIPTS / prefix).exists())
            self.assertFalse(any((runner.ROOT / paired.TRIALS).glob(prefix + '-*')))


class RunAndReportTests(unittest.TestCase):
    def test_games_run_sequentially_under_caps_and_report_recorded_results(self):
        plan = paired.build_plan('paired-test', rounds=5)
        log = []
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state, report = paired.run_plan(plan, 360, 4, root, trial=fake_trial(root, log=log))
            for name in ('plan.json', 'run.json', 'report.json'):
                self.assertTrue((root / plan['receipts'] / name).exists())
            proofs = [runner.read_json(root / g['folder'] / 'provider-proof.json') for g in plan['games']]
            with self.assertRaises(FileExistsError):
                paired.run_plan(plan, 360, 4, root, trial=fake_trial(root))
        self.assertEqual([entry[1] for entry in log], [1, 1, 1, 1])  # never two games at once
        self.assertTrue(all(options['swap_providers'] is game['swapProviders'] and options['seed'] == game['seed']
                            for (_, _, options), game in zip(log, plan['games'])))
        self.assertEqual((state['status'], state['callsAttempted'], state['retries']), ('completed', 16, 0))
        self.assertEqual([(p['assignment']['id'], p['seed']) for p in proofs], [(g['assignment'], g['seed']) for g in plan['games']])
        game = report['games'][1]
        self.assertEqual((game['assignment'], game['seatModels']['red'], game['receiptMismatches']), ('opus-blue-sol-red', 'gpt-5.6-sol', []))
        self.assertEqual((game['result']['termination'], game['result']['winnerSeat'], game['result']['winnerModel']), ('game-outcome', 'red', 'gpt-5.6-sol'))
        self.assertEqual(game['calls']['attempted'], 4)
        self.assertEqual(game['calls']['tokensBySeat']['blue'], {'inputIncludingCache': 20, 'output': 6, 'reasoningOrThinking': 0})
        self.assertEqual(game['calls']['tokensBySeat']['red'], {'inputIncludingCache': 20, 'output': 4, 'reasoningOrThinking': 0})
        self.assertEqual(game['initial']['seats']['red']['resources']['gold'], 64300)
        self.assertEqual((game['initial']['seats']['red']['redBrief'], game['initial']['seats']['blue']['redBrief']), (True, False))
        self.assertEqual(report['pairs'][0]['pattern'], 'same-seat-won-both (red)')
        self.assertEqual(report['pairs'][0]['perModel']['gpt-5.6-sol'], [{'seat': 'blue', 'result': 'loss', 'margin': -10}, {'seat': 'red', 'result': 'win', 'margin': 10}])
        self.assertEqual(report['pairs'][0]['assumptionDifferences'], [])
        self.assertEqual(report['modelTotals']['claude-opus-5']['red']['win'], 2)
        self.assertEqual(report['modelTotals']['claude-opus-5']['blue']['loss'], 2)
        self.assertEqual((report['providerCallsAttempted'], report['gamesCompleted']), (16, 4))
        self.assertIn('opponent strength against humans or other opponents', report['evidence']['notEvidenceOf'])

    def test_round_cap_is_reported_as_no_result(self):
        plan = paired.build_plan('paired-cap', ['PAIR0001'], 3)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            _, report = paired.run_plan(plan, 12, 2, root, trial=fake_trial(root, harness=ScoredHarness))
        result = report['games'][0]['result']
        self.assertEqual((result['termination'], result['winnerSeat'], result['scoresStatus'], result['rounds']), ('round-cap', None, 'provisional', 3))
        self.assertEqual(report['pairs'][0]['pattern'], 'not-both-decided')
        self.assertEqual(report['pairs'][0]['perModel']['claude-opus-5'][0], {'seat': 'red', 'result': 'no-result-round-cap', 'provisionalMargin': 10})

    def test_failed_game_stops_the_run_without_retry_and_is_reported(self):
        plan = paired.build_plan('paired-fail', rounds=4)
        attempts = []
        lock = threading.Lock()
        def call(seat, prompt, schema, folder, name, index, provider):
            with lock:
                attempts.append((folder.name, seat))
            if folder.name.endswith('opus-blue-sol-red') and seat == 'red':
                raise RuntimeError('Provider response must be a JSON object')
            return modelled(seat, prompt, schema, folder, name, index, provider)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state, report = paired.run_plan(plan, 360, 4, root, trial=fake_trial(root, call=call))
            self.assertFalse((root / plan['games'][2]['folder']).exists())
        self.assertEqual([g['status'] for g in state['games']], ['completed', 'failed', 'not-started', 'not-started'])
        self.assertEqual((state['status'], state['callsAttempted']), ('stopped-after-failed-game', 6))
        self.assertEqual(sum(1 for folder, _ in attempts if folder == plan['games'][1]['name']), 2)
        failed = report['games'][1]
        self.assertEqual(failed['calls']['bySeat']['red']['failed'], 1)
        self.assertIn('JSON object', failed['calls']['bySeat']['red']['errors'][0]['error'])
        self.assertEqual((report['games'][2]['status'], report['pairs'][0]['pattern'], report['pairs'][1]['pattern']), ('not-started', 'incomplete', 'incomplete'))

    def test_harness_rejection_and_receipt_mismatch_are_reported(self):
        class Rejects(ScoredHarness):
            def __call__(self, args):
                if args[0] == 'step':
                    runner.write_once(self.folder / 'rejections/00/rejection.json',
                                      {'round': 0, 'stage': 'parse', 'seats': {'blue': {'accepted': True}, 'red': {'accepted': False, 'code': 'malformed', 'message': 'not JSON'}}})
                    raise RuntimeError('Dual-model harness refused operation: round 0 halted')
                super().__call__(args)
        plan = paired.build_plan('paired-reject', ['PAIR0001'], 3)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            state, report = paired.run_plan(plan, 12, 2, root, trial=fake_trial(root, harness=Rejects))
            self.assertEqual(state['status'], 'stopped-after-failed-game')
            self.assertEqual(report['games'][0]['harnessRejections'], [{'round': 0, 'stage': 'parse', 'seats': {'blue': {'accepted': True}, 'red': {'accepted': False, 'code': 'malformed', 'message': 'not JSON'}}}])
            proof_path = root / plan['games'][0]['folder'] / 'provider-proof.json'
            proof = runner.read_json(proof_path)
            proof['seed'] = 'OTHER'
            proof_path.write_text(json.dumps(proof))
            self.assertEqual(paired.build_report(plan, root)['games'][0]['receiptMismatches'], ['seed'])


if __name__ == '__main__':
    unittest.main()
