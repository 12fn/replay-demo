"""Offline Sol-Blue / Opus-Red trial: six short rounds by default, or explicit bounded --mode full-game.

At most two calls per round, no retries, fallback or app inference. Full-game mode stops at the harness outcome.
--scenario taiwan-strait/1 selects the Taiwan Strait map for a new trial; omitted, the original scenario is unchanged.
--seed and --swap-providers (Opus Blue / Sol Red) apply to new trials only and are recorded in provider-proof.json;
a swap changes which provider answers each seat, never which seat prompt, snapshot or Red brief it receives.
--observation-profile feedback-v2 records round-feedback/2 for a new trial; omitted, init arguments and proof are unchanged."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SEATS = ('blue', 'red')
MAX_ROUNDS = 6
TICKS_PER_ROUND = 270
SEED = 'DUAL0001'
MODES = ('short', 'full-game')
FULL_GAME_MODE = 'full-game/1'
FULL_GAME_MAX_ROUNDS = 45
# Explicitly selectable scenarios (strict allowlist). Omitted means the harness default, recorded with no scenario key.
SCENARIOS = ('taiwan-strait/1',)
TAIWAN_MAP = 'taiwan-strait-400'
RED_CELL_PROFILE = 'strait-red-cell/1'
SCENARIO_SOURCES = ('src/scenarios/catalog.ts', 'src/campaign/network.ts', 'src/scenarios/strait-red-cell.ts',
                    'src/engine/maps.ts', 'scripts/ai-player-trial.ts')
# Same rule as the TypeScript harness config check.
SEED_PATTERN = r'[A-Za-z0-9-]{1,32}'
# Explicitly selectable observation profiles: flag value -> canonical value recorded in config.observationProfile.
OBSERVATION_PROFILES = {'feedback-v2': 'round-feedback/2'}
PROVIDER_MODELS = {'sol': 'gpt-5.6-sol', 'opus': 'claude-opus-5'}
PROVIDER_LABELS = {'sol': 'sponsored-org Sol', 'opus': 'Claude Max Opus5'}
DEFAULT_ASSIGNMENT = {'blue': 'sol', 'red': 'opus'}
SWAPPED_ASSIGNMENT = {'blue': 'opus', 'red': 'sol'}
ASSIGNMENT_IDS = {False: 'sol-blue-opus-red', True: 'opus-blue-sol-red'}


def trial_bounds(mode, rounds, scenario=None, seed=None, observation_profile=None):
    """Validate before anything is created. Short mode keeps its fixed six rounds and its original init arguments."""
    if mode not in MODES:
        raise ValueError('Mode must be short or full-game')
    if scenario is not None and (not isinstance(scenario, str) or scenario not in SCENARIOS):
        raise ValueError(f'Scenario must be one of {", ".join(SCENARIOS)}, or omitted for the default')
    if seed is not None and (not isinstance(seed, str) or not re.fullmatch(SEED_PATTERN, seed)):
        raise ValueError('Seed must be 1-32 letters, digits or hyphens, or omitted for the default')
    if observation_profile is not None and (not isinstance(observation_profile, str) or observation_profile not in OBSERVATION_PROFILES):
        raise ValueError(f'Observation profile must be one of {", ".join(OBSERVATION_PROFILES)}, or omitted for the original observation')
    seed = SEED if seed is None else seed
    selected = ({'scenario': scenario}, ['--scenario', scenario]) if scenario else ({}, [])
    if observation_profile is not None:
        selected = ({**selected[0], 'observationProfile': OBSERVATION_PROFILES[observation_profile]},
                    [*selected[1], '--observation-profile', observation_profile])
    if mode == 'short':
        if isinstance(rounds, bool) or rounds not in (None, MAX_ROUNDS):
            raise ValueError('Short mode is fixed at six rounds; a longer game needs --mode full-game')
        return ({'maxRounds': MAX_ROUNDS, 'ticksPerRound': TICKS_PER_ROUND, 'seed': seed, **selected[0]},
                ['--rounds', str(MAX_ROUNDS), '--ticks-per-round', str(TICKS_PER_ROUND), '--seed', seed, *selected[1]])
    rounds = FULL_GAME_MAX_ROUNDS if rounds is None else rounds
    if isinstance(rounds, bool) or not isinstance(rounds, int) or not 1 <= rounds <= FULL_GAME_MAX_ROUNDS:
        raise ValueError(f'Full-game rounds must be an integer from 1 to {FULL_GAME_MAX_ROUNDS}')
    return ({'mode': FULL_GAME_MODE, 'maxRounds': rounds, 'ticksPerRound': TICKS_PER_ROUND, 'seed': seed, **selected[0]},
            ['--mode', 'full-game', '--rounds', str(rounds), '--ticks-per-round', str(TICKS_PER_ROUND), '--seed', seed, *selected[1]])


def seat_assignment(swap_providers):
    """Provider identity per seat. Seat prompts, snapshots, schemas and any Red brief never move with the provider."""
    if not isinstance(swap_providers, bool):
        raise ValueError('swap_providers must be True or False')
    seats = SWAPPED_ASSIGNMENT if swap_providers else DEFAULT_ASSIGNMENT
    return {'id': ASSIGNMENT_IDS[swap_providers], 'swapProviders': swap_providers,
            'providers': dict(seats), 'models': {seat: PROVIDER_MODELS[seats[seat]] for seat in SEATS}}


def check_scenario_game(folder, scenario):
    """A selected scenario must be recorded by the harness itself: catalog id, map, and the Red-only brief provenance."""
    game = read_json(folder / 'initialization/game.json')
    record = game.get('scenario') or {}
    if (game.get('scenarioId') != scenario or game.get('map') != TAIWAN_MAP or record.get('id') != scenario
            or record.get('map') != TAIWAN_MAP or (record.get('redCell') or {}).get('profile') != RED_CELL_PROFILE
            or (game.get('claims') or {}).get('scenarioId') != scenario):
        raise RuntimeError('Initialized trial does not record the selected scenario')
    return record


def check_seat_context(inputs, scenario):
    """Before dispatch in a scenario trial: both seats carry the scenario, and only Red's snapshot and prompt carry the Red Cell brief."""
    for seat, (prompt, _schema, snapshot) in inputs.items():
        observation = snapshot.get('observation') or {}
        if (('redCell' in observation) != (seat == 'red')
                or (RED_CELL_PROFILE in prompt) != (seat == 'red')
                or seat == 'red' and observation['redCell'].get('profile') != RED_CELL_PROFILE):
            raise ValueError(f'{seat} seat context does not match the Red-only brief rule')
        if (observation.get('scenario') or {}).get('id') != scenario:
            raise ValueError(f'{seat} seat context lacks the selected scenario')


def check_round_context(inputs, profile):
    """Before dispatch in a profiled trial: both seats carry the recorded profile with the same public queue and advance rule."""
    contexts = {}
    for seat, (_prompt, _schema, snapshot) in inputs.items():
        context = (snapshot.get('observation') or {}).get('roundContext')
        if not isinstance(context, dict) or context.get('profile') != profile:
            raise ValueError(f'{seat} seat context lacks the recorded {profile} round context')
        contexts[seat] = context
    if any(contexts['blue'].get(key) != contexts['red'].get(key) for key in ('turnOrder', 'advance')):
        raise ValueError('Both seats must see the same public queue order and advance rule')


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_once(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def inside(folder, relative):
    path = (folder / relative).resolve()
    if not path.is_relative_to(folder.resolve()) or path == folder.resolve():
        raise ValueError('Harness artifact must be inside this trial')
    return path


def preserve_streams(prefix, stdout, stderr):
    for suffix, content in (('.json', stdout), ('.stderr', stderr)):
        data = content if isinstance(content, bytes) else (content or '').encode()
        with prefix.with_suffix(suffix).open('xb') as stream:
            stream.write(data)


def read_json(path):
    return json.loads(path.read_text())


def harness(args):
    result = subprocess.run(['pnpm', 'exec', 'tsx', 'scripts/dual-model-trial.ts', *args],
                            cwd=ROOT, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError('Dual-model harness refused operation: ' + result.stderr[-1500:])
    return result.stdout


def provider_call(seat, prompt, schema, folder, name, round_index, provider=None):
    """Only this seat's immutable prompt is passed. This function never changes the engine.

    `provider` defaults to the original seat binding (Sol Blue, Opus Red); files are always named by seat."""
    if seat not in SEATS:
        raise ValueError('Unknown seat')
    provider = DEFAULT_ASSIGNMENT[seat] if provider is None else provider
    if provider not in PROVIDER_MODELS:
        raise ValueError('Unknown provider')
    prefix = folder / 'providers' / f'{round_index:02d}-{seat}'
    prefix.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    if provider == 'sol':
        task = ROOT / 'docs/process/codex-tasks' / f'dual-{name}-{round_index}-{seat}.json'
        write_once(task, {'name': f'dual-{name}-{round_index}-{seat}', 'prompt': prompt, 'sources': []})
        try:
            result = subprocess.run([sys.executable, 'scripts/hackathon-codex-review.py', '--task', str(task)],
                                    cwd=ROOT, text=True, capture_output=True, timeout=270)
        except subprocess.TimeoutExpired as error:
            preserve_streams(prefix, error.stdout, error.stderr)
            raise RuntimeError('Sponsored Sol timed out; partial runner streams retained') from error
        if result.returncode:
            preserve_streams(prefix, result.stdout, result.stderr)
            raise RuntimeError('Sponsored Sol call failed; sponsored runner retained its receipt')
        receipt = json.loads(result.stdout.strip().splitlines()[-1])
        write_once(prefix.with_suffix('.proof.json'), receipt)
        if not receipt.get('personal_auth_unchanged') or receipt.get('timed_out'):
            raise RuntimeError('Sponsored authentication/timeout qualification failed')
        source = (ROOT / receipt['artifact']).resolve()
        allowed = (ROOT / 'evidence/codex').resolve()
        if not source.is_relative_to(allowed) or source == allowed:
            raise RuntimeError('Sponsored artifact is outside its authorized directory')
        artifact_bytes = source.read_bytes()
        retained = prefix.with_suffix('.jsonl')
        with retained.open('xb') as stream:
            stream.write(artifact_bytes)
        artifact_hash = hashlib.sha256(artifact_bytes).hexdigest()
        events = [json.loads(line) for line in artifact_bytes.decode().splitlines() if line.strip()]
        items = [event['item'] for event in events if 'item' in event]
        if any(item.get('type') not in ('agent_message', 'reasoning') for item in items):
            raise RuntimeError('Sol invoked a tool; observation boundary failed')
        messages = [item['text'] for item in items if item.get('type') == 'agent_message']
        if not messages:
            raise RuntimeError('Sol returned no final message')
        reply = json.loads(messages[-1])
        meta = {'model': 'gpt-5.6-sol', 'providerArtifact': str(retained.relative_to(ROOT)),
                'providerArtifactSha256': artifact_hash, 'sourceProviderArtifact': receipt['artifact'],
                'usage': receipt['usage_events'], 'personalAuthUnchanged': True,
                'constrainedOutput': False, 'toolsObserved': False}
    else:
        env = {key: value for key, value in os.environ.items()
               if key not in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                              'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN')}
        try:
            result = subprocess.run(['claude', '-p', '--model', 'claude-opus-5', '--effort', 'medium',
                                     '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                                     '--output-format', 'json', '--json-schema', json.dumps(schema)],
                                    input=prompt, cwd=ROOT, env=env, text=True, capture_output=True, timeout=240)
        except subprocess.TimeoutExpired as error:
            preserve_streams(prefix, error.stdout, error.stderr)
            raise RuntimeError('Opus timed out; partial provider streams retained') from error
        preserve_streams(prefix, result.stdout, result.stderr)
        if result.returncode:
            raise RuntimeError('Opus subscription failed; result retained without fallback')
        raw = json.loads(result.stdout)
        if raw.get('is_error') or 'claude-opus-5' not in raw.get('modelUsage', {}):
            raise RuntimeError('Opus did not return the requested model successfully')
        reply = raw.get('structured_output')
        if not isinstance(reply, dict):
            raise RuntimeError('Opus returned no structured object; no text fallback')
        meta = {'model': 'claude-opus-5', 'providerArtifact': str(prefix.with_suffix('.json').relative_to(ROOT)),
                'providerArtifactSha256': hashlib.sha256(prefix.with_suffix('.json').read_bytes()).hexdigest(),
                'sessionId': raw.get('session_id'), 'usage': raw['modelUsage'],
                'constrainedOutput': True, 'toolsDisabled': True}
    if not isinstance(reply, dict):
        raise RuntimeError('Provider response must be a JSON object')
    return reply, {**meta, 'elapsedSeconds': round(time.monotonic() - started, 2)}


def sealed_round(folder, name, cursor, call=provider_call, scenario=None, observation_profile=None):
    """Collect both independent results before returning. Failure never triggers an engine step."""
    inputs = {}
    for seat in SEATS:
        paths = cursor['seats'][seat]
        prompt = inside(folder, paths['prompt']).read_text()
        snapshot = read_json(inside(folder, paths['snapshot']))
        schema = read_json(inside(folder, paths['schema']))
        if snapshot['seat'] != seat or snapshot['tick'] != cursor['tick']:
            raise ValueError('Seat or pre-order tick mismatch')
        inputs[seat] = (prompt, schema, snapshot)
    if inputs['blue'][2]['fingerprint'] != inputs['red'][2]['fingerprint']:
        raise ValueError('Both seats must decide from the same pre-order state')
    if scenario is not None:
        check_seat_context(inputs, scenario)
    if observation_profile is not None:
        check_round_context(inputs, OBSERVATION_PROFILES[observation_profile])
    rows = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {seat: pool.submit(call, seat, inputs[seat][0], inputs[seat][1], folder, name, cursor['round'])
                   for seat in SEATS}
        for seat in SEATS:
            prompt, schema, snapshot = inputs[seat]
            row = {'seat': seat, 'snapshotId': snapshot['snapshotId'],
                   'promptSha256': hashlib.sha256(prompt.encode()).hexdigest(),
                   'schemaSha256': hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest()}
            try:
                reply, meta = futures[seat].result()
                response = folder / 'responses' / f"{cursor['round']:02d}-{seat}.json"
                write_once(response, reply)
                row.update(meta, status='returned', response=str(response.relative_to(folder)))
            except BaseException as error:
                # An interrupted seat is recorded like a failure; the other seat's returned reply is still retained.
                row.update(status='failed' if isinstance(error, Exception) else 'interrupted',
                           error=str(error) or type(error).__name__)
            rows[seat] = row
    return rows


def run_trial(name, call=provider_call, run_harness=harness, root=ROOT, mode='short', rounds=None, scenario=None,
              seed=None, swap_providers=False, observation_profile=None):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,70}', name):
        raise ValueError('Use a short alphanumeric/hyphen trial name')
    expected, bound_args = trial_bounds(mode, rounds, scenario, seed, observation_profile)
    assignment = seat_assignment(swap_providers)
    # An explicit seed or assignment marks a new-style run: both are recorded and every returned model is checked.
    # Omitting both keeps the original call signature and proof shape.
    explicit = seed is not None or swap_providers
    max_rounds = expected['maxRounds']
    folder = root / 'evidence/dual-model-trial' / name
    if folder.exists():
        raise FileExistsError('Preserve the existing trial; use a fresh name')
    if explicit:
        base_call = call
        def assigned_call(seat, *rest):
            return base_call(seat, *rest, provider=assignment['providers'][seat])
        call = assigned_call
    run_harness(['init', '--dir', str(folder), *bound_args])
    manifest = read_json(folder / 'manifest.json')
    game_id = manifest['gameId']
    # Exact equality: a short game records no mode; a full game records its mode and the requested bound.
    if manifest['config'] != expected:
        raise RuntimeError('Initialized trial does not match the authorized bounds')
    scenario_record = check_scenario_game(folder, scenario) if scenario is not None else None
    proof = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'running',
             'gameId': game_id, 'maxCalls': 2 * max_rounds, 'callSlotsReserved': 0, 'modelCallsAttempted': 0, 'retries': 0,
             'appInferenceCalls': 0, 'seats': {'blue': 'sponsored-org Sol', 'red': 'Claude Max Opus5'},
             'rounds': [], 'humanValidated': False,
             'scope': 'Offline fictional two-model play. Both decisions use the same pre-order state; inference latency paused. Not native continuous play, fairness or learning validation.'}
    if mode == 'full-game':
        proof.update(mode=FULL_GAME_MODE, maxRounds=max_rounds,
                     sources={str(path.relative_to(ROOT)): sha256_file(path)
                              for path in (Path(__file__).resolve(), ROOT / 'scripts/dual-model-trial.ts')},
                     scope=f'Offline fictional two-model play in {FULL_GAME_MODE}: at most {max_rounds} rounds and {2 * max_rounds} provider calls, '
                           'stopping at the first harness game outcome. Both decisions use the same pre-order state; inference latency paused. '
                           'Runner scaffolding only: not native continuous play, game quality, fairness or learning validation.')
    if scenario is not None:
        proof.update(scenario=scenario, map=TAIWAN_MAP, redCellProfile=RED_CELL_PROFILE, scenarioRecord=scenario_record,
                     sources={**proof.get('sources', {}),
                              **{str(path.relative_to(ROOT)): sha256_file(path)
                                 for path in (Path(__file__).resolve(), ROOT / 'scripts/dual-model-trial.ts',
                                              *(ROOT / p for p in SCENARIO_SOURCES))}},
                     scope=f'{proof["scope"]} Scenario {scenario} on map {TAIWAN_MAP} in the accelerated offline runner: '
                           f'Red alone receives {RED_CELL_PROFILE}; Blue receives public regional geography and objectives. '
                           'Not the native continuous Taiwan exercise.')
    if explicit:
        proof.update(seats={seat: PROVIDER_LABELS[assignment['providers'][seat]] for seat in SEATS},
                     assignment=assignment, seed=expected['seed'],
                     scope=f'{proof["scope"]} Seat assignment {assignment["id"]}, seed {expected["seed"]}: only provider identity '
                           'follows the assignment; each seat keeps its own prompt, snapshot, schema and any Red-only brief. '
                           'Geography and turn order remain asymmetric within this game.')
    if observation_profile is not None:
        proof.update(observationProfile=expected['observationProfile'],
                     sources={**proof.get('sources', {}),
                              **{str(path.relative_to(ROOT)): sha256_file(path)
                                 for path in (Path(__file__).resolve(), ROOT / 'scripts/dual-model-trial.ts')}},
                     scope=f'{proof["scope"]} Observation profile {expected["observationProfile"]}: both seats also see the public '
                           'queue order and advance rule, feedback on their own earlier orders and their own recent board totals. '
                           'An observation change only, not evidence of stronger play.')
    proof_path = folder / 'provider-proof.json'
    def save():
        proof_path.write_text(json.dumps(proof, indent=2) + '\n')
    save()
    try:
        for index in range(max_rounds):
            manifest = read_json(folder / 'manifest.json')
            if manifest['gameId'] != game_id or manifest['config'] != expected:
                raise RuntimeError('Manifest game or config changed during the trial')
            # A terminal outcome completes the manifest; stop before reserving or dispatching further calls.
            if manifest['status'] == 'complete':
                break
            cursor = manifest['cursor']
            if manifest['status'] != 'awaiting-responses' or not cursor:
                raise RuntimeError('Harness is neither complete nor awaiting responses')
            if cursor['round'] != index or proof['callSlotsReserved'] + 2 > proof['maxCalls']:
                raise RuntimeError('Round/call bound mismatch')
            # Reserve both attempts before dispatch; a failed call is never retried or replaced.
            proof['callSlotsReserved'] += 2
            save()
            rows = sealed_round(folder, name, cursor, call, scenario, observation_profile)
            proof['modelCallsAttempted'] += len(rows)
            row = {'round': index, 'tick': cursor['tick'], 'seats': rows, 'applied': False, 'applicationStatus': 'not-dispatched'}
            proof['rounds'].append(row)
            save()
            if any(value['status'] != 'returned' for value in rows.values()):
                raise RuntimeError('A provider failed or was interrupted; neither response was applied for this round')
            if explicit and any(rows[seat].get('model') != assignment['models'][seat] for seat in SEATS):
                raise RuntimeError('A returned model does not match the recorded seat assignment; neither response was applied')
            row.update(applied=None, applicationStatus='pending',
                       manifestBeforeSha256=hashlib.sha256((folder / 'manifest.json').read_bytes()).hexdigest())
            save()
            try:
                run_harness(['step', '--dir', str(folder),
                             '--blue-response', str(inside(folder, rows['blue']['response'])),
                             '--red-response', str(inside(folder, rows['red']['response']))])
            except BaseException:
                row['applicationStatus'] = 'unknown'
                if (folder / 'manifest.json').exists():
                    row['manifestAfterFailureSha256'] = hashlib.sha256((folder / 'manifest.json').read_bytes()).hexdigest()
                save()
                raise
            row.update(applied=True, applicationStatus='applied')
            save()
            print(json.dumps({'trial': name, 'round': index, 'bothResponsesApplied': True}), flush=True)
        manifest = read_json(folder / 'manifest.json')
        if manifest['status'] != 'complete':
            raise RuntimeError('Harness still expects responses after the round cap')
        summary = read_json(folder / 'final/summary.json')
        if mode == 'full-game':
            played = len(proof['rounds'])
            terminal = summary.get('stopReason') == 'game-outcome' and summary.get('outcome') is not None
            capped = summary.get('stopReason') == 'round-limit' and summary.get('outcome') is None and played == max_rounds
            if (summary.get('config') != expected or summary.get('rounds') != played or not (terminal or capped)
                    or summary.get('claims', {}).get('mode') != FULL_GAME_MODE):
                raise RuntimeError('Full-game summary does not match the recorded rounds, bound or stop')
            proof.update(roundsPlayed=played, stopReason=summary['stopReason'])
        if scenario is not None:
            if (summary.get('config') != expected or summary.get('claims', {}).get('scenarioId') != scenario
                    or summary.get('scenario') != scenario_record):
                raise RuntimeError('Scenario summary does not match the recorded config, claims or scenario record')
        if observation_profile is not None:
            if (summary.get('config') != expected
                    or summary.get('claims', {}).get('observationProfile') != expected['observationProfile']):
                raise RuntimeError('Observation profile summary does not match the recorded config or claims')
        proof.update(status='completed', summary=summary)
    except BaseException as error:
        proof.update(status='failed', failure=str(error) or type(error).__name__)
        raise
    finally:
        save()
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name')
    parser.add_argument('--mode', choices=MODES, default='short')
    parser.add_argument('--rounds', type=int, help=f'full-game only: 1-{FULL_GAME_MAX_ROUNDS}, default {FULL_GAME_MAX_ROUNDS}')
    parser.add_argument('--scenario', choices=SCENARIOS, help='new trial only; omit for the default scenario')
    parser.add_argument('--seed', help=f'new trial only: 1-32 letters, digits or hyphens; default {SEED}')
    parser.add_argument('--swap-providers', action='store_true', help='new trial only: Opus answers Blue and Sol answers Red')
    parser.add_argument('--observation-profile', choices=tuple(OBSERVATION_PROFILES),
                        help='new trial only: feedback-v2 records round-feedback/2; omit for the original observation')
    args = parser.parse_args()
    try:
        trial_bounds(args.mode, args.rounds, args.scenario, args.seed, args.observation_profile)
    except ValueError as error:
        parser.error(str(error))
    result = run_trial(args.name, mode=args.mode, rounds=args.rounds, scenario=args.scenario,
                       seed=args.seed, swap_providers=args.swap_providers, observation_profile=args.observation_profile)
    output = {'status': result['status'], 'modelCallsAttempted': result['modelCallsAttempted'], 'summary': result['summary']}
    if 'assignment' in result:
        output.update(assignment=result['assignment'], seed=result['seed'])
    if 'observationProfile' in result:
        output.update(observationProfile=result['observationProfile'])
    print(json.dumps(output))
