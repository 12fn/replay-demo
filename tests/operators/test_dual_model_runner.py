"""No inference: qualify provider orchestration boundaries with fake calls and a fake harness."""
import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import subprocess
import hashlib

spec = importlib.util.spec_from_file_location('dual_runner', Path(__file__).resolve().parents[2] / 'scripts/run-dual-model-trial.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FakeHarness:
    """Mimics the TS CLI: `--mode full-game` records full-game/1; `outcome_after` ends the game early with an outcome."""
    def __init__(self, outcome_after=None, config=None, blue_brief=False, game_scenario=True, round_context=True, split_queue=False):
        self.steps = 0
        self.outcome_after = outcome_after
        self.forced_config = config
        self.calls = []
        self.scenario = None
        self.profile = None
        self.blue_brief = blue_brief
        self.game_scenario = game_scenario
        self.round_context = round_context
        self.split_queue = split_queue

    def __call__(self, args):
        self.calls.append(list(args))
        self.folder = Path(args[args.index('--dir') + 1])
        if args[0] == 'init':
            self.folder.mkdir(parents=True)
            rounds = int(args[args.index('--rounds') + 1]) if '--rounds' in args else 6
            self.config = {'maxRounds': rounds, 'ticksPerRound': 270, 'seed': args[args.index('--seed') + 1] if '--seed' in args else 'DUAL0001'}
            if '--mode' in args:
                self.config = {'mode': 'full-game/1', **self.config}
            if '--scenario' in args:
                self.scenario = args[args.index('--scenario') + 1]
                self.config = {**self.config, 'scenario': self.scenario}
                self.record = {'id': self.scenario, 'map': 'taiwan-strait-400', 'redCell': {'profile': 'strait-red-cell/1'}}
                game = {'config': self.config, 'scenarioId': self.scenario, 'map': 'taiwan-strait-400',
                        'claims': {'scenarioId': self.scenario}, **({'scenario': self.record} if self.game_scenario else {})}
                runner.write_once(self.folder / 'initialization/game.json', game)
            if '--observation-profile' in args:
                self.profile = runner.OBSERVATION_PROFILES[args[args.index('--observation-profile') + 1]]
                self.config = {**self.config, 'observationProfile': self.profile}
            self.config = self.forced_config or self.config
        else:
            for seat in runner.SEATS:
                response = runner.read_json(Path(args[args.index('--' + seat + '-response') + 1]))
                assert response['snapshotId'] == f'{seat}-{self.steps}'
            self.steps += 1
        cursor = None
        terminal = self.outcome_after is not None and self.steps >= self.outcome_after
        if self.steps < self.config['maxRounds'] and not terminal:
            cursor = {'round': self.steps, 'tick': self.steps * 270, 'seats': {}}
            for seat in runner.SEATS:
                prefix = f'rounds/{self.steps:02d}/{seat}'
                paths = {kind: prefix + '/' + kind + suffix for kind, suffix in [('prompt', '.md'), ('snapshot', '.json'), ('schema', '.json')]}
                target = self.folder / paths['prompt']
                target.parent.mkdir(parents=True)
                snapshot = {'seat': seat, 'snapshotId': f'{seat}-{self.steps}', 'tick': cursor['tick'], 'fingerprint': 'same-pre-order-state'}
                text = f'{seat} private context round {self.steps}'
                if self.scenario:
                    brief = seat == 'red' or self.blue_brief
                    snapshot['observation'] = {'scenario': {'id': self.scenario}, **({'redCell': {'profile': 'strait-red-cell/1'}} if brief else {})}
                    text += ' strait-red-cell/1 brief' if brief else ''
                if self.profile and self.round_context:
                    queue = ['blue', 'red'] if self.steps % 2 == 0 else ['red', 'blue']
                    if self.split_queue and seat == 'red':
                        queue = queue[::-1]
                    snapshot['observation'] = {**snapshot.get('observation', {}),
                                               'roundContext': {'profile': self.profile, 'turnOrder': {'queue': queue}, 'advance': {'ticksPerDecision': 270},
                                                                'ownOrders': {'orders': [seat]}}}
                target.write_text(text)
                runner.write_once(self.folder / paths['snapshot'], snapshot)
                runner.write_once(self.folder / paths['schema'], {'type': 'object'})
                cursor['seats'][seat] = paths
        else:
            summary = {'outcome': None, 'stopReason': 'round-limit'}
            if 'mode' in self.config:
                summary.update(config=self.config, rounds=self.steps, claims={'mode': 'full-game/1'})
                if terminal:
                    summary.update(outcome={'winner': 'red', 'reason': 'elimination'}, stopReason='game-outcome')
            if self.scenario:
                summary.update(config=self.config, scenario=self.record,
                               claims={**summary.get('claims', {}), 'scenarioId': self.scenario})
            if self.profile:
                summary.update(config=self.config, claims={**summary.get('claims', {}), 'observationProfile': self.profile})
            runner.write_once(self.folder / 'final/summary.json', summary)
        (self.folder / 'manifest.json').write_text(json.dumps({'gameId': 'fake-game', 'config': self.config, 'status': 'complete' if cursor is None else 'awaiting-responses', 'cursor': cursor, 'history': []}))


class DualRunnerTests(unittest.TestCase):
    def test_both_calls_run_concurrently_without_other_seat_context_and_stop_at_twelve(self):
        h = FakeHarness()
        barrier = threading.Barrier(2)
        seen = []
        def call(seat, prompt, schema, folder, name, index):
            self.assertIn(f'{seat} private context', prompt)
            self.assertNotIn(('red' if seat == 'blue' else 'blue') + ' private context', prompt)
            self.assertEqual(h.steps, index)
            barrier.wait(timeout=2)
            seen.append((seat, index))
            return {'snapshotId': f'{seat}-{index}', 'choice': 'hold', 'share': None, 'rationale': 'fake'}, {'model': 'fake'}
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            result = runner.run_trial('bounded', call, h, Path(temp))
        self.assertEqual(result['status'], 'completed')
        self.assertEqual((len(seen), h.steps, result['modelCallsAttempted'], result['callSlotsReserved']), (12, 6, 12, 12))
        self.assertTrue(all(row['applied'] for row in result['rounds']))

    def test_provider_failure_retains_successful_reply_but_neither_order_is_applied(self):
        h = FakeHarness()
        def call(seat, prompt, schema, folder, name, index):
            if seat == 'red':
                raise RuntimeError('fake provider failure')
            return {'snapshotId': 'blue-0', 'choice': 'hold', 'share': None, 'rationale': 'fake'}, {}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(RuntimeError, 'neither response was applied'):
                runner.run_trial('failed', call, h, root)
            folder = root / 'evidence/dual-model-trial/failed'
            proof = runner.read_json(folder / 'provider-proof.json')
            self.assertTrue((folder / 'responses/00-blue.json').exists())
            self.assertEqual(h.steps, 0)
            self.assertEqual(proof['modelCallsAttempted'], 2)
            self.assertEqual(proof['status'], 'failed')
            self.assertFalse(proof['rounds'][0]['applied'])
            with self.assertRaises(FileExistsError):
                runner.run_trial('failed', call, h, root)

    def test_cross_seat_prestate_mismatch_stops_before_any_provider_call(self):
        h = FakeHarness()
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / 'game'
            h(['init', '--dir', str(folder)])
            cursor = runner.read_json(folder / 'manifest.json')['cursor']
            p = folder / cursor['seats']['red']['snapshot']
            snapshot = runner.read_json(p)
            snapshot['fingerprint'] = 'later-state'
            p.write_text(json.dumps(snapshot))
            def forbidden(*args):
                self.fail('Provider must not be called on inconsistent states')
            with self.assertRaisesRegex(ValueError, 'same pre-order state'):
                runner.sealed_round(folder, 'mismatch', cursor, forbidden)
            self.assertEqual(h.steps, 0)

    def test_artifact_paths_cannot_escape_trial(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(ValueError):
                runner.inside(Path(temp), '../outside')


    def test_opus_timeout_retains_both_partial_streams(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / 'trial'
            error = subprocess.TimeoutExpired(['claude'], 240, output=b'{"partial":', stderr=b'partial diagnostic')
            with mock.patch.object(runner.subprocess, 'run', side_effect=error):
                with self.assertRaisesRegex(RuntimeError, 'partial provider streams retained'):
                    runner.provider_call('red', 'public fictional prompt', {}, folder, 'timeout', 0)
            self.assertEqual((folder / 'providers/00-red.json').read_bytes(), b'{"partial":')
            self.assertEqual((folder / 'providers/00-red.stderr').read_bytes(), b'partial diagnostic')

    def test_blue_provider_evidence_is_retained_and_hashed_and_escape_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'evidence/codex/source.jsonl'
            source.parent.mkdir(parents=True)
            reply = {'snapshotId': 'blue-0', 'choice': 'hold', 'share': None, 'rationale': 'fake'}
            data = json.dumps({'item': {'type': 'agent_message', 'text': json.dumps(reply)}}) + '\n'
            source.write_text(data)
            receipt = {'artifact': 'evidence/codex/source.jsonl', 'personal_auth_unchanged': True, 'usage_events': []}
            returned = subprocess.CompletedProcess([], 0, stdout=json.dumps(receipt), stderr='')
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner.subprocess, 'run', return_value=returned):
                result, meta = runner.provider_call('blue', 'public prompt', {}, root / 'trial', 'retained', 0)
                self.assertEqual(result, reply)
                self.assertEqual(meta['providerArtifactSha256'], hashlib.sha256(data.encode()).hexdigest())
                source.write_text('changed after provider returned')
                self.assertEqual((root / meta['providerArtifact']).read_text(), data)
                returned.stdout = json.dumps({**receipt, 'artifact': '../outside.jsonl'})
                with self.assertRaisesRegex(RuntimeError, 'outside its authorized directory'):
                    runner.provider_call('blue', 'public prompt', {}, root / 'other', 'escape', 0)

    def test_step_failure_after_engine_advancement_is_unknown_not_unapplied(self):
        h = FakeHarness()
        def failing_harness(args):
            h(args)
            if args[0] == 'step':
                raise RuntimeError('process failed after advancing')
        def call(seat, prompt, schema, folder, name, index):
            return {'snapshotId': f'{seat}-{index}', 'choice': 'hold', 'share': None, 'rationale': 'fake'}, {}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(RuntimeError, 'after advancing'):
                runner.run_trial('ambiguous', call, failing_harness, root)
            proof = runner.read_json(root / 'evidence/dual-model-trial/ambiguous/provider-proof.json')
            row = proof['rounds'][0]
            self.assertEqual(h.steps, 1)
            self.assertIsNone(row['applied'])
            self.assertEqual(row['applicationStatus'], 'unknown')
            self.assertNotEqual(row['manifestBeforeSha256'], row['manifestAfterFailureSha256'])


def hold(seat, prompt, schema, folder, name, index):
    return {'snapshotId': f'{seat}-{index}', 'choice': 'hold', 'share': None, 'rationale': 'fake'}, {'model': 'fake'}


class FullGameModeTests(unittest.TestCase):
    def run_quietly(self, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.run_trial(*args, **kwargs)

    def test_short_default_keeps_original_init_arguments_and_proof_shape(self):
        h = FakeHarness()
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('legacy', hold, h, Path(temp))
            folder = Path(temp) / 'evidence/dual-model-trial/legacy'
        self.assertEqual(h.calls[0], ['init', '--dir', str(folder), '--rounds', '6', '--ticks-per-round', '270', '--seed', 'DUAL0001'])
        self.assertEqual(set(result), {'at', 'status', 'gameId', 'maxCalls', 'callSlotsReserved', 'modelCallsAttempted', 'retries',
                                       'appInferenceCalls', 'seats', 'rounds', 'humanValidated', 'scope', 'summary'})
        self.assertEqual((result['maxCalls'], result['modelCallsAttempted'], len(result['rounds'])), (12, 12, 6))
        self.assertEqual(runner.trial_bounds('short', None), runner.trial_bounds('short', 6))

    def test_existing_six_round_evidence_still_satisfies_the_short_contract(self):
        folder = Path(__file__).resolve().parents[2] / 'evidence/dual-model-trial/dual-sol-blue-opus-red-20260915'
        if not folder.exists():
            self.skipTest('saved six-round trial not present')
        manifest, proof = runner.read_json(folder / 'manifest.json'), runner.read_json(folder / 'provider-proof.json')
        self.assertEqual(manifest['config'], runner.trial_bounds('short', None)[0])
        self.assertEqual((proof['status'], proof['maxCalls']), ('completed', 12))
        self.assertNotIn('mode', proof)

    def test_full_game_forwards_explicit_mode_and_stops_at_outcome_before_more_calls(self):
        h = FakeHarness(outcome_after=3)
        calls = []
        def call(*args):
            calls.append(args[0])
            return hold(*args)
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('early', call, h, Path(temp), mode='full-game')
        self.assertEqual(h.calls[0][3:], ['--mode', 'full-game', '--rounds', '45', '--ticks-per-round', '270', '--seed', 'DUAL0001'])
        self.assertEqual((h.steps, len(calls), result['callSlotsReserved'], result['maxCalls']), (3, 6, 6, 90))
        self.assertEqual((result['status'], result['stopReason'], result['roundsPlayed'], result['mode']), ('completed', 'game-outcome', 3, 'full-game/1'))
        self.assertIn('scripts/dual-model-trial.ts', result['sources'])
        self.assertIn('not native continuous play, game quality', result['scope'])

    def test_full_game_round_cap_bounds_calls_to_two_per_round(self):
        h = FakeHarness()
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('capped', hold, h, Path(temp), mode='full-game', rounds=7)
        self.assertEqual((h.steps, result['modelCallsAttempted'], result['maxCalls'], result['stopReason']), (7, 14, 14, 'round-limit'))

        class NeverCompletes(FakeHarness):
            def __call__(self, args):
                super().__call__(args)
                manifest = runner.read_json(self.folder / 'manifest.json')
                if manifest['status'] == 'complete':  # pretend the harness ignored its own bound
                    manifest.update(status='awaiting-responses', cursor={'round': self.steps, 'tick': 0, 'seats': {}})
                    (self.folder / 'manifest.json').write_text(json.dumps(manifest))
        n = NeverCompletes()
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'still expects responses'):
                self.run_quietly('runaway', hold, n, Path(temp), mode='full-game', rounds=2)
            proof = runner.read_json(Path(temp) / 'evidence/dual-model-trial/runaway/provider-proof.json')
        self.assertEqual((n.steps, proof['modelCallsAttempted'], proof['status']), (2, 4, 'failed'))

    def test_invalid_modes_and_rounds_are_refused_before_anything_is_created(self):
        h = FakeHarness()
        def forbidden(*args):
            self.fail('no provider call on invalid bounds')
        bad = [('full', None), ('full-game/1', None), (None, None), ('FULL-GAME', None), ('short', 7), ('short', 45),
               ('full-game', 0), ('full-game', 46), ('full-game', True), ('full-game', '5'), ('full-game', 7.0)]
        with tempfile.TemporaryDirectory() as temp:
            for mode, rounds in bad:
                with self.subTest(mode=mode, rounds=rounds), self.assertRaises(ValueError):
                    runner.run_trial('invalid', forbidden, h, Path(temp), mode=mode, rounds=rounds)
            self.assertFalse((Path(temp) / 'evidence').exists())
        self.assertEqual(h.calls, [])
        script = Path(runner.__file__)
        for args in (['x', '--rounds', '7'], ['x', '--mode', 'full-game', '--rounds', '46'], ['x', '--mode', 'full']):
            refused = subprocess.run([runner.sys.executable, str(script), *args], capture_output=True, text=True, timeout=30)
            self.assertEqual(refused.returncode, 2, args)
        self.assertFalse((runner.ROOT / 'evidence/dual-model-trial/x').exists())

    def test_config_mismatch_stops_before_any_provider_call(self):
        def forbidden(*args):
            self.fail('no provider call on a mismatched config')
        mismatches = [('full-game', 10, {'maxRounds': 10, 'ticksPerRound': 270, 'seed': 'DUAL0001'}),
                      ('full-game', 10, {'mode': 'full-game/1', 'maxRounds': 45, 'ticksPerRound': 270, 'seed': 'DUAL0001'}),
                      ('short', None, {'mode': 'full-game/1', 'maxRounds': 6, 'ticksPerRound': 270, 'seed': 'DUAL0001'}),
                      ('short', None, {'maxRounds': 6, 'ticksPerRound': 900, 'seed': 'DUAL0001'})]
        for mode, rounds, config in mismatches:
            with self.subTest(config=config), tempfile.TemporaryDirectory() as temp:
                with self.assertRaisesRegex(RuntimeError, 'authorized bounds'):
                    runner.run_trial('mismatch', forbidden, FakeHarness(config=config), Path(temp), mode=mode, rounds=rounds)

        class Drifts(FakeHarness):
            def __call__(self, args):
                super().__call__(args)
                if args[0] == 'step':
                    manifest = runner.read_json(self.folder / 'manifest.json')
                    manifest['config'] = {**manifest['config'], 'maxRounds': 45}
                    (self.folder / 'manifest.json').write_text(json.dumps(manifest))
        d = Drifts()
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'config changed'):
                self.run_quietly('drift', hold, d, Path(temp), mode='full-game', rounds=5)
            proof = runner.read_json(Path(temp) / 'evidence/dual-model-trial/drift/provider-proof.json')
        self.assertEqual((d.steps, proof['callSlotsReserved'], proof['status']), (1, 2, 'failed'))

    def test_full_game_summary_must_match_a_real_stop(self):
        class EarlyWithoutOutcome(FakeHarness):
            def __call__(self, args):
                super().__call__(args)
                summary = self.folder / 'final/summary.json'
                if summary.exists():
                    data = runner.read_json(summary)
                    data.update(outcome=None, stopReason='round-limit')
                    summary.write_text(json.dumps(data))
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                self.run_quietly('lying', hold, EarlyWithoutOutcome(outcome_after=2), Path(temp), mode='full-game', rounds=9)

    def test_existing_output_folder_is_never_resumed_or_converted(self):
        with tempfile.TemporaryDirectory() as temp:
            self.run_quietly('same', hold, FakeHarness(), Path(temp))
            folder = Path(temp) / 'evidence/dual-model-trial/same'
            before = {p: p.read_bytes() for p in folder.rglob('*') if p.is_file()}
            h = FakeHarness()
            with self.assertRaises(FileExistsError):
                runner.run_trial('same', hold, h, Path(temp), mode='full-game', rounds=45)
            self.assertEqual(h.calls, [])
            self.assertEqual(before, {p: p.read_bytes() for p in folder.rglob('*') if p.is_file()})

    def test_interrupted_second_seat_retains_first_reply_and_stops_without_applying(self):
        h = FakeHarness()
        red_failed = threading.Event()
        def call(seat, prompt, schema, folder, name, index):
            if index == 2 and seat == 'red':
                red_failed.set()
                raise KeyboardInterrupt
            if index == 2:
                self.assertTrue(red_failed.wait(timeout=2))  # Blue still returns after Red was interrupted
            return hold(seat, prompt, schema, folder, name, index)
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'interrupted; neither response was applied'):
                self.run_quietly('interrupted', call, h, Path(temp), mode='full-game', rounds=45)
            folder = Path(temp) / 'evidence/dual-model-trial/interrupted'
            proof = runner.read_json(folder / 'provider-proof.json')
            row = proof['rounds'][2]
            self.assertTrue((folder / 'responses/02-blue.json').exists())
            self.assertFalse((folder / 'responses/02-red.json').exists())
        self.assertEqual((row['seats']['blue']['status'], row['seats']['red']['status']), ('returned', 'interrupted'))
        self.assertEqual((row['applied'], row['applicationStatus']), (False, 'not-dispatched'))
        self.assertEqual((h.steps, proof['modelCallsAttempted'], proof['callSlotsReserved'], proof['retries'], proof['status']), (2, 6, 6, 0, 'failed'))

    def test_interrupt_during_engine_step_leaves_application_unknown(self):
        h = FakeHarness()
        def interrupted_harness(args):
            h(args)
            if args[0] == 'step':
                raise KeyboardInterrupt
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(KeyboardInterrupt):
                self.run_quietly('step-interrupt', hold, interrupted_harness, Path(temp), mode='full-game', rounds=3)
            proof = runner.read_json(Path(temp) / 'evidence/dual-model-trial/step-interrupt/provider-proof.json')
        self.assertEqual((proof['status'], proof['rounds'][0]['applied'], proof['rounds'][0]['applicationStatus']), ('failed', None, 'unknown'))

    def test_sol_timeout_and_failure_retain_runner_streams(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            error = subprocess.TimeoutExpired(['python'], 270, output='{"partial":', stderr='sol diagnostic')
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner.subprocess, 'run', side_effect=error):
                with self.assertRaisesRegex(RuntimeError, 'partial runner streams retained'):
                    runner.provider_call('blue', 'prompt', {}, root / 'trial', 'timeout', 4)
            self.assertEqual((root / 'trial/providers/04-blue.json').read_bytes(), b'{"partial":')
            self.assertEqual((root / 'trial/providers/04-blue.stderr').read_bytes(), b'sol diagnostic')
            failed = subprocess.CompletedProcess([], 1, stdout='raw out', stderr='raw err')
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner.subprocess, 'run', return_value=failed):
                with self.assertRaisesRegex(RuntimeError, 'no fallback|retained its receipt'):
                    runner.provider_call('blue', 'prompt', {}, root / 'trial', 'failed', 5)
            self.assertEqual((root / 'trial/providers/05-blue.stderr').read_bytes(), b'raw err')

    def test_full_game_qualification_uses_a_separate_write_once_proof(self):
        qspec = importlib.util.spec_from_file_location('qualify_dual', runner.ROOT / 'scripts/qualify-dual-model-cli.py')
        qualify = importlib.util.module_from_spec(qspec)
        qspec.loader.exec_module(qualify)
        full = qualify.FULL_GAME_PROOF.format(rounds=45)
        self.assertEqual(qualify.SHORT_PROOF, 'evidence/platform/dual-model-cli-fake-20260915.json')
        self.assertNotEqual(full, qualify.SHORT_PROOF)
        self.assertIn('full-game-45r', full)


class ScenarioSelectionTests(unittest.TestCase):
    def test_red_brief_required_in_both_prompt_and_snapshot(self):
        inputs = {seat: ('strait-red-cell/1' if seat == 'red' else 'public', {},
                        {'observation': {'scenario': {'id': 'taiwan-strait/1'},
                         **({'redCell': {'profile': 'strait-red-cell/1'}} if seat == 'red' else {})}})
                  for seat in runner.SEATS}
        runner.check_seat_context(inputs, 'taiwan-strait/1')
        missing_prompt = dict(inputs)
        missing_prompt['red'] = ('missing brief', inputs['red'][1], inputs['red'][2])
        with self.assertRaisesRegex(ValueError, 'Red-only brief'):
            runner.check_seat_context(missing_prompt, 'taiwan-strait/1')
        inputs['red'][2]['observation'].pop('redCell')
        with self.assertRaisesRegex(ValueError, 'Red-only brief'):
            runner.check_seat_context(inputs, 'taiwan-strait/1')

    TAIWAN = 'taiwan-strait/1'

    def run_quietly(self, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.run_trial(*args, **kwargs)

    def test_default_bounds_and_init_arguments_are_unchanged(self):
        self.assertEqual(runner.trial_bounds('short', None), runner.trial_bounds('short', None, None))
        self.assertNotIn('--scenario', runner.trial_bounds('full-game', 45)[1])
        self.assertNotIn('scenario', runner.trial_bounds('full-game', 45)[0])

    def test_scenario_is_forwarded_recorded_and_checked(self):
        config, args = runner.trial_bounds('short', None, self.TAIWAN)
        self.assertEqual(config, {'maxRounds': 6, 'ticksPerRound': 270, 'seed': 'DUAL0001', 'scenario': self.TAIWAN})
        self.assertEqual(args[-2:], ['--scenario', self.TAIWAN])
        h = FakeHarness()
        prompts = {}
        def call(seat, prompt, schema, folder, name, index):
            prompts.setdefault(seat, []).append(prompt)
            return hold(seat, prompt, schema, folder, name, index)
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('taiwan', call, h, Path(temp), scenario=self.TAIWAN)
            folder = Path(temp) / 'evidence/dual-model-trial/taiwan'
        self.assertEqual(h.calls[0], ['init', '--dir', str(folder), '--rounds', '6', '--ticks-per-round', '270', '--seed', 'DUAL0001', '--scenario', self.TAIWAN])
        self.assertEqual((result['status'], result['scenario'], result['map'], result['redCellProfile']), ('completed', self.TAIWAN, 'taiwan-strait-400', 'strait-red-cell/1'))
        self.assertEqual(result['maxCalls'], 12)
        for path in ('scripts/dual-model-trial.ts', 'src/scenarios/catalog.ts', 'src/scenarios/strait-red-cell.ts'):
            self.assertIn(path, result['sources'])
        self.assertIn('Not the native continuous Taiwan exercise', result['scope'])
        self.assertTrue(all('strait-red-cell/1' in p for p in prompts['red']))
        self.assertFalse(any('strait-red-cell/1' in p for p in prompts['blue']))

        full = FakeHarness()
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('taiwan-full', hold, full, Path(temp), mode='full-game', rounds=7, scenario=self.TAIWAN)
        self.assertEqual(full.calls[0][3:], ['--mode', 'full-game', '--rounds', '7', '--ticks-per-round', '270', '--seed', 'DUAL0001', '--scenario', self.TAIWAN])
        self.assertEqual((result['mode'], result['roundsPlayed'], result['scenario']), ('full-game/1', 7, self.TAIWAN))

    def test_invalid_scenarios_are_refused_before_anything_is_created(self):
        def forbidden(*args):
            self.fail('no provider call on an invalid scenario')
        h = FakeHarness()
        with tempfile.TemporaryDirectory() as temp:
            for bad in ('crosscurrent-objectives/1', 'taiwan-strait/2', 'TAIWAN-STRAIT/1', 'taiwan', '', 1, True, ['taiwan-strait/1']):
                with self.subTest(scenario=bad), self.assertRaises(ValueError):
                    runner.run_trial('invalid', forbidden, h, Path(temp), scenario=bad)
            self.assertFalse((Path(temp) / 'evidence').exists())
        self.assertEqual(h.calls, [])
        script = Path(runner.__file__)
        for args in (['x', '--scenario', 'taiwan'], ['x', '--scenario', 'crosscurrent-objectives/1'], ['x', '--scenario', self.TAIWAN, '--rounds', '7']):
            refused = subprocess.run([runner.sys.executable, str(script), *args], capture_output=True, text=True, timeout=30)
            self.assertEqual(refused.returncode, 2, args)
        self.assertFalse((runner.ROOT / 'evidence/dual-model-trial/x').exists())

    def test_unrecorded_scenario_or_leaked_brief_stops_before_any_provider_call(self):
        def forbidden(*args):
            self.fail('no provider call')
        cases = [(FakeHarness(game_scenario=False), RuntimeError, 'does not record the selected scenario'),
                 (FakeHarness(config={'maxRounds': 6, 'ticksPerRound': 270, 'seed': 'DUAL0001'}), RuntimeError, 'authorized bounds'),
                 (FakeHarness(blue_brief=True), ValueError, 'Red-only brief')]
        for h, error, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temp:
                with self.assertRaisesRegex(error, message):
                    self.run_quietly('leak', forbidden, h, Path(temp), scenario=self.TAIWAN)
                self.assertEqual(h.steps, 0)
        # A default trial never accepts a scenario-bearing config either.
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'authorized bounds'):
                self.run_quietly('convert', forbidden, FakeHarness(config={'maxRounds': 6, 'ticksPerRound': 270, 'seed': 'DUAL0001', 'scenario': self.TAIWAN}), Path(temp))

    def test_scenario_summary_must_match_the_recorded_scenario(self):
        class Drops(FakeHarness):
            def __call__(self, args):
                super().__call__(args)
                summary = self.folder / 'final/summary.json'
                if summary.exists():
                    data = runner.read_json(summary)
                    data.pop('scenario')
                    summary.write_text(json.dumps(data))
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'Scenario summary does not match'):
                self.run_quietly('dropped', hold, Drops(), Path(temp), scenario=self.TAIWAN)

    def test_saved_taiwan_full_game_still_satisfies_the_default_contract(self):
        folder = runner.ROOT / 'evidence/dual-model-trial/taiwan-sol-blue-opus-red-full-20260915'
        if not folder.exists():
            self.skipTest('saved Taiwan full game not present')
        manifest, proof = runner.read_json(folder / 'manifest.json'), runner.read_json(folder / 'provider-proof.json')
        self.assertEqual(manifest['config'], runner.trial_bounds('full-game', 45, self.TAIWAN)[0])
        self.assertEqual(manifest['config'], runner.trial_bounds('full-game', 45, self.TAIWAN, None)[0])
        self.assertEqual((proof['status'], proof['maxCalls'], proof['seats']), ('completed', 90, {'blue': 'sponsored-org Sol', 'red': 'Claude Max Opus5'}))
        self.assertNotIn('assignment', proof)
        self.assertNotIn('seed', proof)


def modelled(seat, prompt, schema, folder, name, index, provider):
    reply, meta = hold(seat, prompt, schema, folder, name, index)
    return reply, {**meta, 'model': runner.PROVIDER_MODELS[provider]}


class SeedAndAssignmentTests(unittest.TestCase):
    TAIWAN = 'taiwan-strait/1'

    def run_quietly(self, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.run_trial(*args, **kwargs)

    def test_seed_is_forwarded_and_default_is_unchanged(self):
        self.assertEqual(runner.trial_bounds('full-game', 45, self.TAIWAN), runner.trial_bounds('full-game', 45, self.TAIWAN, 'DUAL0001'))
        config, args = runner.trial_bounds('full-game', 45, self.TAIWAN, 'PAIR0002')
        self.assertEqual(config['seed'], 'PAIR0002')
        self.assertEqual(args[args.index('--seed') + 1], 'PAIR0002')
        self.assertEqual(runner.seat_assignment(False)['models'], {'blue': 'gpt-5.6-sol', 'red': 'claude-opus-5'})
        self.assertEqual(runner.seat_assignment(True)['models'], {'blue': 'claude-opus-5', 'red': 'gpt-5.6-sol'})

    def test_invalid_seed_or_swap_is_refused_before_anything_is_created(self):
        h = FakeHarness()
        def forbidden(*args, **kwargs):
            self.fail('no provider call on invalid arguments')
        with tempfile.TemporaryDirectory() as temp:
            for bad in ('', 'x' * 33, 'bad seed', 'seed/1', 7, True):
                with self.subTest(seed=bad), self.assertRaises(ValueError):
                    runner.run_trial('invalid', forbidden, h, Path(temp), mode='full-game', seed=bad)
            for bad in ('yes', 1, None):
                with self.subTest(swap=bad), self.assertRaises(ValueError):
                    runner.run_trial('invalid', forbidden, h, Path(temp), mode='full-game', swap_providers=bad)
            self.assertFalse((Path(temp) / 'evidence').exists())
        self.assertEqual(h.calls, [])
        script = Path(runner.__file__)
        for args in (['x', '--seed', 'bad seed'], ['x', '--seed', 'y' * 33], ['x', '--swap-providers', '--rounds', '7']):
            refused = subprocess.run([runner.sys.executable, str(script), *args], capture_output=True, text=True, timeout=30)
            self.assertEqual(refused.returncode, 2, args)
        self.assertFalse((runner.ROOT / 'evidence/dual-model-trial/x').exists())

    def test_swap_moves_provider_identity_but_never_seat_prompts_or_red_brief(self):
        h = FakeHarness()
        seen = []
        lock = threading.Lock()
        def call(seat, prompt, schema, folder, name, index, provider):
            with lock:
                seen.append((seat, provider, prompt))
            return modelled(seat, prompt, schema, folder, name, index, provider)
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('swapped', call, h, Path(temp), mode='full-game', rounds=3, scenario=self.TAIWAN,
                                      seed='PAIR0001', swap_providers=True)
        self.assertEqual(h.calls[0][h.calls[0].index('--seed') + 1], 'PAIR0001')
        self.assertEqual(len(seen), 6)
        for seat, provider, prompt in seen:
            self.assertEqual(provider, {'blue': 'opus', 'red': 'sol'}[seat])
            self.assertIn(f'{seat} private context', prompt)
            self.assertEqual('strait-red-cell/1' in prompt, seat == 'red')  # the brief stays with Red, now answered by Sol
        self.assertEqual(result['assignment']['id'], 'opus-blue-sol-red')
        self.assertEqual((result['seed'], result['seats']), ('PAIR0001', {'blue': 'Claude Max Opus5', 'red': 'sponsored-org Sol'}))
        self.assertEqual((result['maxCalls'], result['modelCallsAttempted'], result['retries']), (6, 6, 0))
        self.assertIn('Geography and turn order remain asymmetric', result['scope'])
        self.assertTrue(all(row['seats']['red']['model'] == 'gpt-5.6-sol' for row in result['rounds']))

    def test_explicit_seed_alone_records_the_original_assignment(self):
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('seeded', modelled, FakeHarness(), Path(temp), mode='full-game', rounds=2, seed='PAIR0001')
        self.assertEqual((result['assignment']['id'], result['assignment']['swapProviders'], result['seed']), ('sol-blue-opus-red', False, 'PAIR0001'))
        self.assertEqual(result['seats'], {'blue': 'sponsored-org Sol', 'red': 'Claude Max Opus5'})

    def test_returned_model_that_contradicts_the_assignment_is_never_applied(self):
        h = FakeHarness()
        def wrong(seat, prompt, schema, folder, name, index, provider):
            return modelled(seat, prompt, schema, folder, name, index, 'sol')
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'does not match the recorded seat assignment'):
                self.run_quietly('wrong', wrong, h, Path(temp), mode='full-game', rounds=3, swap_providers=True)
            proof = runner.read_json(Path(temp) / 'evidence/dual-model-trial/wrong/provider-proof.json')
        self.assertEqual((h.steps, proof['status'], proof['rounds'][0]['applicationStatus'], proof['modelCallsAttempted']), (0, 'failed', 'not-dispatched', 2))

    def test_provider_dispatch_follows_provider_while_files_follow_seat(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            reply = {'snapshotId': 'red-0', 'choice': 'hold', 'share': None, 'rationale': 'fake'}
            source = root / 'evidence/codex/red.jsonl'
            source.parent.mkdir(parents=True)
            source.write_text(json.dumps({'item': {'type': 'agent_message', 'text': json.dumps(reply)}}) + '\n')
            receipt = {'artifact': 'evidence/codex/red.jsonl', 'personal_auth_unchanged': True, 'usage_events': []}
            sol = subprocess.CompletedProcess([], 0, stdout=json.dumps(receipt), stderr='')
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner.subprocess, 'run', return_value=sol) as run:
                result, meta = runner.provider_call('red', 'red prompt with strait-red-cell/1', {}, root / 'trial', 'swap', 0, provider='sol')
            self.assertIn('scripts/hackathon-codex-review.py', run.call_args.args[0])
            task = runner.read_json(root / 'docs/process/codex-tasks/dual-swap-0-red.json')
            self.assertEqual(task['prompt'], 'red prompt with strait-red-cell/1')
            self.assertEqual((result, meta['model'], meta['providerArtifact']), (reply, 'gpt-5.6-sol', 'trial/providers/00-red.jsonl'))

            blue = {'snapshotId': 'blue-0', 'choice': 'hold', 'share': None, 'rationale': 'fake'}
            raw = {'is_error': False, 'modelUsage': {'claude-opus-5': {}}, 'structured_output': blue, 'session_id': 's'}
            opus = subprocess.CompletedProcess([], 0, stdout=json.dumps(raw), stderr='')
            with mock.patch.object(runner, 'ROOT', root), mock.patch.object(runner.subprocess, 'run', return_value=opus) as run:
                result, meta = runner.provider_call('blue', 'blue public prompt', {'type': 'object'}, root / 'trial', 'swap', 0, provider='opus')
            self.assertEqual((run.call_args.args[0][0], run.call_args.kwargs['input']), ('claude', 'blue public prompt'))
            self.assertEqual((result, meta['model'], meta['providerArtifact']), (blue, 'claude-opus-5', 'trial/providers/00-blue.json'))
            with self.assertRaisesRegex(ValueError, 'Unknown provider'):
                runner.provider_call('blue', 'p', {}, root / 'trial', 'swap', 1, provider='luna')
            with self.assertRaisesRegex(ValueError, 'Unknown seat'):
                runner.provider_call('green', 'p', {}, root / 'trial', 'swap', 1)

    def test_scenario_qualification_proof_names_are_unique_and_leave_old_proofs_alone(self):
        qspec = importlib.util.spec_from_file_location('qualify_dual', runner.ROOT / 'scripts/qualify-dual-model-cli.py')
        qualify = importlib.util.module_from_spec(qspec)
        qspec.loader.exec_module(qualify)
        a = datetime.datetime(2026, 9, 15, 4, 5, 6, tzinfo=datetime.timezone.utc)
        short = qualify.scenario_proof_path(self.TAIWAN, 'short', 45, a)
        self.assertEqual(short, 'evidence/platform/dual-model-cli-fake-taiwan-strait-1-short-20260915T040506Z.json')
        self.assertEqual(qualify.scenario_proof_path(self.TAIWAN, 'full-game', 45, a), 'evidence/platform/dual-model-cli-fake-taiwan-strait-1-full-game-45r-20260915T040506Z.json')
        self.assertNotEqual(short, qualify.scenario_proof_path(self.TAIWAN, 'short', 45, a + datetime.timedelta(seconds=1)))
        self.assertNotIn(short, (qualify.SHORT_PROOF, qualify.FULL_GAME_PROOF.format(rounds=45)))


class ObservationProfileTests(unittest.TestCase):
    PROFILE = 'round-feedback/2'

    def run_quietly(self, *args, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.run_trial(*args, **kwargs)

    def test_bounds_record_the_canonical_profile_last_and_default_is_unchanged(self):
        self.assertEqual(runner.trial_bounds('short', None), runner.trial_bounds('short', None, None, None, None))
        for mode, rounds in (('short', None), ('full-game', 45)):
            self.assertNotIn('--observation-profile', runner.trial_bounds(mode, rounds)[1])
            self.assertNotIn('observationProfile', runner.trial_bounds(mode, rounds)[0])
        config, args = runner.trial_bounds('full-game', 7, 'taiwan-strait/1', 'PAIR0001', 'feedback-v2')
        self.assertEqual(list(config), ['mode', 'maxRounds', 'ticksPerRound', 'seed', 'scenario', 'observationProfile'])
        self.assertEqual(config['observationProfile'], self.PROFILE)
        self.assertEqual(args[-4:], ['--scenario', 'taiwan-strait/1', '--observation-profile', 'feedback-v2'])
        self.assertEqual(runner.trial_bounds('short', None, None, None, 'feedback-v2')[1][-2:], ['--observation-profile', 'feedback-v2'])

    def test_profile_is_forwarded_recorded_and_checked_before_each_dispatch(self):
        h = FakeHarness()
        seen = []
        lock = threading.Lock()
        def call(seat, prompt, schema, folder, name, index):
            snapshot = runner.read_json(folder / f'rounds/{index:02d}/{seat}/snapshot.json')
            with lock:
                seen.append((seat, index, snapshot['observation']['roundContext']['turnOrder']['queue']))
            return hold(seat, prompt, schema, folder, name, index)
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_quietly('profiled', call, h, Path(temp), mode='full-game', rounds=3, observation_profile='feedback-v2')
            folder = Path(temp) / 'evidence/dual-model-trial/profiled'
        self.assertEqual(h.calls[0], ['init', '--dir', str(folder), '--mode', 'full-game', '--rounds', '3', '--ticks-per-round', '270',
                                      '--seed', 'DUAL0001', '--observation-profile', 'feedback-v2'])
        self.assertEqual((result['status'], result['observationProfile'], result['maxCalls'], result['modelCallsAttempted']), ('completed', self.PROFILE, 6, 6))
        self.assertIn('scripts/dual-model-trial.ts', result['sources'])
        self.assertIn('not evidence of stronger play', result['scope'])
        for seat, index, queue in seen:
            self.assertEqual(queue, ['blue', 'red'] if index % 2 == 0 else ['red', 'blue'])

    def test_unknown_profile_is_refused_before_anything_is_created_or_called(self):
        def forbidden(*args, **kwargs):
            self.fail('no provider call on an unknown observation profile')
        h = FakeHarness()
        with tempfile.TemporaryDirectory() as temp:
            for bad in ('round-feedback/2', 'feedback-v1', 'FEEDBACK-V2', 'feedback', '', 2, True, ['feedback-v2']):
                with self.subTest(profile=bad), self.assertRaises(ValueError):
                    runner.run_trial('invalid', forbidden, h, Path(temp), observation_profile=bad)
            self.assertFalse((Path(temp) / 'evidence').exists())
        self.assertEqual(h.calls, [])
        script = Path(runner.__file__)
        for args in (['x', '--observation-profile', 'round-feedback/2'], ['x', '--observation-profile', 'feedback-v3'], ['x', '--observation-profile']):
            refused = subprocess.run([runner.sys.executable, str(script), *args], capture_output=True, text=True, timeout=30)
            self.assertEqual(refused.returncode, 2, args)
        self.assertFalse((runner.ROOT / 'evidence/dual-model-trial/x').exists())

    def test_missing_or_unequal_round_context_or_unrecorded_profile_stops_before_any_provider_call(self):
        def forbidden(*args):
            self.fail('no provider call')
        cases = [(FakeHarness(round_context=False), ValueError, 'lacks the recorded round-feedback/2'),
                 (FakeHarness(split_queue=True), ValueError, 'same public queue order'),
                 (FakeHarness(config={'maxRounds': 6, 'ticksPerRound': 270, 'seed': 'DUAL0001'}), RuntimeError, 'authorized bounds')]
        for h, error, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temp:
                with self.assertRaisesRegex(error, message):
                    self.run_quietly('ctx', forbidden, h, Path(temp), observation_profile='feedback-v2')
                self.assertEqual(h.steps, 0)
        # A trial without the flag never accepts a profiled config.
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'authorized bounds'):
                self.run_quietly('convert', forbidden, FakeHarness(config={'maxRounds': 6, 'ticksPerRound': 270, 'seed': 'DUAL0001', 'observationProfile': self.PROFILE}), Path(temp))

    def test_profile_summary_must_match_the_recorded_profile(self):
        class Drops(FakeHarness):
            def __call__(self, args):
                super().__call__(args)
                summary = self.folder / 'final/summary.json'
                if summary.exists():
                    data = runner.read_json(summary)
                    data['claims'].pop('observationProfile')
                    summary.write_text(json.dumps(data))
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, 'Observation profile summary does not match'):
                self.run_quietly('dropped', hold, Drops(), Path(temp), observation_profile='feedback-v2')


if __name__ == '__main__':
    unittest.main()
