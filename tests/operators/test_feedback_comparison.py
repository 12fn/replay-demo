import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).resolve().parents[2] / 'scripts/compare-round-feedback.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class ComparisonTests(unittest.TestCase):
    def test_balanced_conditions_and_cap(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            def fake(name, **kwargs):
                calls.append((name, kwargs))
                return {'status': 'completed', 'modelCallsAttempted': 24, 'summary': {'stopReason': 'round-limit'}}
            result = comparison.run(Path(folder), fake)
            self.assertEqual(result['callsAttempted'], 96)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual({(k['swap_providers'], k['observation_profile']) for _, k in calls},
                             {(False, None), (False, 'feedback-v2'), (True, None), (True, 'feedback-v2')})
            self.assertTrue(all(k['seed'] == 'HELD0001' and k['rounds'] == 12 for _, k in calls))
            with self.assertRaises(FileExistsError):
                comparison.run(Path(folder), fake)
            self.assertEqual(len(calls), 4)

    def test_failure_preserves_actual_attempts_and_stops(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            calls = []
            def fake(name, **kwargs):
                calls.append(name)
                comparison.runner.write_once(root / 'evidence/dual-model-trial' / name / 'provider-proof.json',
                                             {'modelCallsAttempted': 2})
                raise RuntimeError('fixture failure')
            with self.assertRaises(RuntimeError):
                comparison.run(root, fake)
            state = json.loads((root / 'evidence/feedback-comparison/held0001-20260915/run.json').read_text())
            self.assertEqual(state['callsAttempted'], 2)
            self.assertEqual(state['status'], 'stopped-after-failure')
            self.assertEqual(len(calls), 1)

    def test_existing_game_refused_before_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'evidence/dual-model-trial' / comparison.plan()['games'][2]['name']).mkdir(parents=True)
            def forbidden(*args, **kwargs):
                self.fail('provider must not be called')
            with self.assertRaises(FileExistsError):
                comparison.run(root, forbidden)
            self.assertFalse((root / 'evidence/feedback-comparison').exists())


if __name__ == '__main__':
    unittest.main()
