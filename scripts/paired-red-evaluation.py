"""Paired Taiwan full-game evaluation: seeds x {Sol Blue/Opus Red, Opus Blue/Sol Red} in the offline dual-model runner.

--plan (default) validates and prints the plan; nothing is written and no provider is called.
--run needs explicit --prefix, --max-calls (at most 360) and --max-games (at most 4). Games run one at a time through
run-dual-model-trial.py; a failed game stops the run and nothing is retried or replaced.
--report rebuilds the report from recorded artifacts only.

Each seed is played under both assignments so each model is exposed to both seats on the same seed. Geography, the
Red-only brief and turn order stay asymmetric inside every game: no single game is balanced."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('dual_runner', ROOT / 'scripts/run-dual-model-trial.py')
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

SCHEMA = 'replay.paired-red-evaluation/1'
SCENARIO = 'taiwan-strait/1'
CALL_CAP = 360
GAME_CAP = 4
DEFAULT_SEEDS = ('PAIR0001', 'PAIR0002')
PREFIX_PATTERN = r'[a-z0-9][a-z0-9-]{0,30}'
RECEIPTS = 'evidence/paired-red-evaluation'
TRIALS = 'evidence/dual-model-trial'
# Seed 1 plays Sol Blue first; seed 2 reverses the order so neither assignment always runs first.
ASSIGNMENT_ORDER = (False, True)

CAVEATS = (
    'Geography is asymmetric within every game (different spawns, station reach and transport dependence). No single game is balanced.',
    'Swapping provider identities controls which model is exposed to which seat across a same-seed pair; it does not remove seat, geography, Red-brief or turn-order effects inside a game.',
    'The strait-red-cell/1 brief follows the Red seat, never the provider, so seat and brief effects are confounded with each other and balanced across models only at the pair level.',
    'Output constraint follows the provider (Opus is schema-constrained, Sol returns unconstrained JSON). Token use is provider-reported with different tokenizers and is not budget-matched.',
    'Performance evidence covers only these recorded games between these two models (at most 4 games on 2 seeds). No statistical significance and no general model ranking.',
    'Opponent strength: each model faced only the other model in an accelerated-pause offline runner, so the results say nothing about strength against humans, other opponents or the native continuous Taiwan exercise.',
    'Learning: no human took part. Nothing here is evidence of learning, training efficacy or real-world doctrine.',
)


def validate_plan_args(prefix, seeds, rounds):
    if not isinstance(prefix, str) or not re.fullmatch(PREFIX_PATTERN, prefix):
        raise ValueError('Prefix must be 1-31 lowercase letters, digits or hyphens')
    if (not isinstance(seeds, (list, tuple)) or not 1 <= len(seeds) <= 2
            or len({str(seed).lower() for seed in seeds}) != len(seeds)):
        raise ValueError('Give one or two distinct seeds')
    for seed in seeds:
        runner.trial_bounds('full-game', rounds, SCENARIO, seed)  # raises on a bad seed or round bound


def build_plan(prefix, seeds=DEFAULT_SEEDS, rounds=runner.FULL_GAME_MAX_ROUNDS):
    validate_plan_args(prefix, seeds, rounds)
    games = []
    for pair, seed in enumerate(seeds):
        order = ASSIGNMENT_ORDER if pair % 2 == 0 else tuple(reversed(ASSIGNMENT_ORDER))
        for swap in order:
            assignment = runner.seat_assignment(swap)
            name = f'{prefix}-{seed.lower()}-{assignment["id"]}'
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,70}', name):
                raise ValueError(f'Trial name {name} is too long; shorten the prefix or seed')
            games.append({'index': len(games), 'name': name, 'folder': f'{TRIALS}/{name}', 'seed': seed, 'pair': pair,
                          'assignment': assignment['id'], 'swapProviders': swap, 'models': assignment['models'],
                          'maxRounds': rounds, 'maxCalls': 2 * rounds})
    return {'schema': f'{SCHEMA}#plan', 'prefix': prefix, 'scenario': SCENARIO, 'mode': runner.FULL_GAME_MODE,
            'ticksPerRound': runner.TICKS_PER_ROUND, 'roundsPerGame': rounds, 'seeds': list(seeds), 'games': games,
            'worstCaseCalls': sum(game['maxCalls'] for game in games), 'callCap': CALL_CAP, 'gameCap': GAME_CAP,
            'receipts': f'{RECEIPTS}/{prefix}', 'retries': 0, 'fallback': False, 'appInferenceCalls': 0,
            'execution': 'Games run sequentially. Inside a round the existing runner calls both seats concurrently from the same pre-order state, with equal rounds, one call per seat per round and fixed ticks per round.',
            'caveats': list(CAVEATS)}


def validate_run(plan, max_calls, max_games, root=ROOT):
    """All limits and every target folder are checked before anything is written or called."""
    for label, value, cap in (('--max-calls', max_calls, CALL_CAP), ('--max-games', max_games, GAME_CAP)):
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= cap:
            raise ValueError(f'--run needs an explicit {label} from 1 to {cap}')
    if len(plan['games']) > max_games:
        raise ValueError(f'The plan has {len(plan["games"])} games, above --max-games {max_games}')
    if plan['worstCaseCalls'] > max_calls:
        raise ValueError(f'The plan can use {plan["worstCaseCalls"]} provider calls, above --max-calls {max_calls}')
    if (root / plan['receipts']).exists():
        raise FileExistsError('Preserve the existing paired receipts; use a fresh prefix')
    for game in plan['games']:
        if (root / game['folder']).exists():
            raise FileExistsError(f'Preserve the existing trial {game["name"]}; use a fresh prefix')


def default_trial(root):
    def trial(name, **options):
        return runner.run_trial(name, root=root, **options)
    return trial


def run_plan(plan, max_calls, max_games, root=ROOT, trial=None):
    validate_run(plan, max_calls, max_games, root)
    trial = default_trial(root) if trial is None else trial
    receipts = root / plan['receipts']
    runner.write_once(receipts / 'plan.json', {**plan, 'maxCalls': max_calls, 'maxGames': max_games})
    state = {'schema': f'{SCHEMA}#run', 'status': 'running', 'maxCalls': max_calls, 'maxGames': max_games,
             'callsAttempted': 0, 'retries': 0, 'games': [{'name': game['name'], 'status': 'not-started'} for game in plan['games']]}
    def save():
        (receipts / 'run.json').write_text(json.dumps(state, indent=2) + '\n')
    save()
    try:
        for game, entry in zip(plan['games'], state['games']):
            if state['callsAttempted'] + game['maxCalls'] > max_calls:
                state['status'] = 'stopped-at-call-cap'
                break
            entry['status'] = 'running'
            save()
            try:
                proof = trial(game['name'], mode='full-game', rounds=game['maxRounds'], scenario=plan['scenario'],
                              seed=game['seed'], swap_providers=game['swapProviders'])
                entry.update(status=proof['status'], callsAttempted=proof['modelCallsAttempted'])
            except BaseException as error:
                recorded = root / game['folder'] / 'provider-proof.json'
                calls = runner.read_json(recorded).get('modelCallsAttempted', 0) if recorded.exists() else 0
                entry.update(status='failed', callsAttempted=calls, failure=str(error) or type(error).__name__)
                state['callsAttempted'] += calls
                state['status'] = 'stopped-after-failed-game'
                if not isinstance(error, Exception):
                    raise
                break
            state['callsAttempted'] += entry['callsAttempted']
        else:
            state['status'] = 'completed'
    except BaseException:
        state['status'] = 'interrupted'
        raise
    finally:
        save()
    report = build_report(plan, root)
    runner.write_once(receipts / 'report.json', report)
    return state, report


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def optional_json(path):
    return runner.read_json(path) if path.exists() else None


def token_totals(rows, seat):
    totals = {'inputIncludingCache': 0, 'output': 0, 'reasoningOrThinking': 0}
    for row in rows:
        meta = row['seats'].get(seat, {})
        usage = meta.get('usage')
        if isinstance(usage, list):  # Sol turn.completed events; input_tokens already includes cached input
            for event in usage:
                counts = event.get('usage') or {}
                totals['inputIncludingCache'] += counts.get('input_tokens', 0)
                totals['output'] += counts.get('output_tokens', 0)
                totals['reasoningOrThinking'] += counts.get('reasoning_output_tokens', 0)
        elif isinstance(usage, dict):  # Opus modelUsage; input excludes cache reads and writes
            for counts in usage.values():
                totals['inputIncludingCache'] += sum(counts.get(key, 0) for key in ('inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'))
                totals['output'] += counts.get('outputTokens', 0)
                totals['reasoningOrThinking'] += counts.get('thinkingTokens', 0)
    return totals


def game_record(game, root):
    folder = root / game['folder']
    record = {'name': game['name'], 'seed': game['seed'], 'pair': game['pair'], 'plannedAssignment': game['assignment']}
    proof = optional_json(folder / 'provider-proof.json')
    if proof is None:
        return {**record, 'status': 'not-started'}
    summary = proof.get('summary') or optional_json(folder / 'final/summary.json') or {}
    game_json = optional_json(folder / 'initialization/game.json') or {}
    assignment = proof.get('assignment') or {}
    models = assignment.get('models') or {}
    mismatches = [label for label, ok in (
        ('assignment', assignment.get('id') == game['assignment'] and models == game['models']),
        ('seed', proof.get('seed') == game['seed'] and (summary.get('config') or {}).get('seed', game['seed']) == game['seed']),
        ('scenario', proof.get('scenario') == SCENARIO),
        ('maxRounds', proof.get('maxRounds') == game['maxRounds'])) if not ok]
    rows = proof.get('rounds', [])
    seat_calls = {seat: {'returned': 0, 'failed': 0, 'interrupted': 0, 'errors': []} for seat in runner.SEATS}
    for row in rows:
        for seat, meta in row['seats'].items():
            status = meta.get('status')
            if status in seat_calls[seat]:
                seat_calls[seat][status] += 1
            if meta.get('error'):
                seat_calls[seat]['errors'].append({'round': row['round'], 'error': meta['error']})
    rejections = []
    for path in sorted(folder.glob('rejections/*/rejection.json')):
        data = runner.read_json(path)
        rejections.append({'round': data.get('round'), 'stage': data.get('stage'),
                           'seats': {seat: {key: value for key, value in (data.get('seats') or {}).get(seat, {}).items()
                                            if key in ('accepted', 'code', 'message')} for seat in runner.SEATS}})
    initial = {}
    for seat in runner.SEATS:
        snapshot = optional_json(folder / f'rounds/00/{seat}/snapshot.json')
        if snapshot:
            observation = snapshot.get('observation') or {}
            prompt = folder / f'rounds/00/{seat}/prompt.md'
            initial[seat] = {'resources': {key: (observation.get('ownResources') or {}).get(key)
                                           for key in ('troops', 'maxTroops', 'reserveRatio', 'gold', 'tiles', 'structures')},
                             'fingerprint': snapshot.get('fingerprint'),
                             'redBrief': 'redCell' in observation,
                             'promptSha256': runner.sha256_file(prompt) if prompt.exists() else None}
    scenario = summary.get('scenario') or game_json.get('scenario') or {}
    outcome = summary.get('outcome')
    stop = summary.get('stopReason')
    winner = (outcome or {}).get('winner')
    scores = summary.get('scores')
    first_row = next((row for row in rows if row.get('seats')), None)
    constrained = {seat: first_row['seats'][seat].get('constrainedOutput') for seat in runner.SEATS
                   if first_row and 'constrainedOutput' in first_row['seats'].get(seat, {})}
    return {**record, 'status': proof.get('status'), 'failure': proof.get('failure'), 'receiptMismatches': mismatches,
            'assignment': assignment.get('id'), 'seatModels': models,
            'result': {'stopReason': stop, 'termination': {'game-outcome': 'game-outcome', 'round-limit': 'round-cap'}.get(stop),
                       'outcomeReason': (outcome or {}).get('reason'), 'winnerSeat': winner, 'winnerModel': models.get(winner),
                       'scores': scores, 'scoresStatus': summary.get('scoresStatus'), 'rounds': summary.get('rounds'),
                       'ticksSimulated': summary.get('ticksSimulated'), 'controllers': summary.get('controllers')},
            'calls': {'attempted': proof.get('modelCallsAttempted'), 'reserved': proof.get('callSlotsReserved'),
                      'maxCalls': proof.get('maxCalls'), 'retries': proof.get('retries'), 'bySeat': seat_calls,
                      'tokensBySeat': {seat: token_totals(rows, seat) for seat in runner.SEATS},
                      'constrainedOutputBySeat': constrained},
            'harnessRejections': rejections, 'engineOrders': summary.get('orders'),
            'initial': {'spawn': scenario.get('spawn'), 'spawnTiles': scenario.get('spawnTiles'),
                        'stationLayout': scenario.get('stationLayout'), 'terrain': scenario.get('terrain'), 'seats': initial},
            'hashes': {'gameJsonSha256': runner.sha256_file(folder / 'initialization/game.json') if game_json else None,
                       'initialFingerprint': (initial.get('blue') or {}).get('fingerprint'),
                       'finalFingerprint': (summary.get('reconstruction') or {}).get('finalFingerprint'),
                       'runnerSources': proof.get('sources')},
            'assumptions': {'config': {key: value for key, value in (summary.get('config') or game_json.get('config') or {}).items() if key != 'seed'},
                            'engine': summary.get('engine'),
                            'scenario': {key: scenario.get(key) for key in ('id', 'map', 'spawn', 'spawnTiles', 'terrain', 'stationLayout', 'pinnedMapAssets',
                                                                             'objectiveRules', 'objectiveRulesSha256', 'redCell', 'sources')},
                            'runnerSources': proof.get('sources'),
                            'initialResources': {seat: value['resources'] for seat, value in initial.items()},
                            'initialFingerprint': (initial.get('blue') or {}).get('fingerprint'),
                            'redBriefSeat': sorted(seat for seat, value in initial.items() if value['redBrief'])}}


def seat_result(record, model):
    seat = next((seat for seat, value in (record.get('seatModels') or {}).items() if value == model), None)
    result = record.get('result') or {}
    if seat is None or record.get('status') != 'completed':
        return {'seat': seat, 'result': 'incomplete'}
    scores = result.get('scores') or {}
    other = 'red' if seat == 'blue' else 'blue'
    margin = scores.get(seat, 0) - scores.get(other, 0) if scores else None
    if result.get('termination') != 'game-outcome':
        return {'seat': seat, 'result': 'no-result-round-cap', 'provisionalMargin': margin}
    winner = result.get('winnerSeat')
    return {'seat': seat, 'result': 'draw' if winner is None else 'win' if winner == seat else 'loss', 'margin': margin}


def build_report(plan, root=ROOT):
    records = [game_record(game, root) for game in plan['games']]
    models = sorted(runner.PROVIDER_MODELS.values())
    pairs = []
    for pair, seed in enumerate(plan['seeds']):
        members = [record for record in records if record['pair'] == pair]
        per_model = {model: [seat_result(record, model) for record in members] for model in models}
        complete = len(members) == 2 and all(record.get('status') == 'completed' and not record.get('receiptMismatches') for record in members)
        winners = [(record.get('result') or {}).get('winnerSeat') for record in members]
        decided = complete and all(record['result']['termination'] == 'game-outcome' and record['result']['winnerSeat'] for record in members)
        if not complete:
            pattern = 'incomplete'
        elif not decided:
            pattern = 'not-both-decided'
        elif winners[0] == winners[1]:
            pattern = f'same-seat-won-both ({winners[0]})'
        else:
            pattern = f'same-model-won-both ({members[0]["seatModels"][winners[0]]})'
        pairs.append({'seed': seed, 'games': [record['name'] for record in members], 'complete': complete,
                      'pattern': pattern, 'perModel': per_model,
                      'sameInitialFingerprint': complete and len({record['hashes']['initialFingerprint'] for record in members}) == 1,
                      'assumptionDifferences': differences(members)})
    totals = {}
    for model in models:
        rows = [seat_result(record, model) for record in records]
        totals[model] = {seat: {kind: sum(1 for row in rows if row['seat'] == seat and row['result'] == kind)
                                for kind in ('win', 'loss', 'draw', 'no-result-round-cap', 'incomplete')} for seat in runner.SEATS}
        totals[model]['decidedMarginSum'] = sum(row['margin'] or 0 for row in rows if row['result'] in ('win', 'loss', 'draw'))
    return {'schema': f'{SCHEMA}#report', 'prefix': plan['prefix'], 'scenario': plan['scenario'], 'seeds': plan['seeds'],
            'gamesPlanned': len(plan['games']), 'gamesCompleted': sum(1 for record in records if record.get('status') == 'completed'),
            'providerCallsAttempted': sum((record.get('calls') or {}).get('attempted') or 0 for record in records),
            'callCap': CALL_CAP, 'games': records, 'pairs': pairs, 'modelTotals': totals,
            'acrossSeedDifferences': differences(records),
            'evidence': {'performance': 'Recorded outcomes, scores, stops and call receipts of these games only.',
                         'notEvidenceOf': ['general model strength or ranking', 'opponent strength against humans or other opponents',
                                           'scenario balance', 'learning or training efficacy', 'real-world doctrine or plans']},
            'caveats': list(CAVEATS)}


def differences(records):
    """Assumption fields whose recorded values differ between the given games (digests, so the report stays small)."""
    present = [record for record in records if 'assumptions' in record]
    fields = sorted({key for record in present for key in record['assumptions']})
    return [{'field': field, 'values': {record['name']: digest(record['assumptions'].get(field)) for record in present}}
            for field in fields if len({digest(record['assumptions'].get(field)) for record in present}) > 1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--plan', action='store_true', help='default: print the plan; no files, no calls')
    action.add_argument('--run', action='store_true', help='run the plan under explicit caps')
    action.add_argument('--report', action='store_true', help='rebuild the report from recorded artifacts; no calls')
    parser.add_argument('--prefix', help='trial name prefix; required for --run and --report')
    parser.add_argument('--seeds', nargs='+', default=list(DEFAULT_SEEDS), help='one or two distinct seeds')
    parser.add_argument('--rounds', type=int, default=runner.FULL_GAME_MAX_ROUNDS, help=f'per game, 1-{runner.FULL_GAME_MAX_ROUNDS}')
    parser.add_argument('--max-calls', type=int, help=f'--run only; required, at most {CALL_CAP}')
    parser.add_argument('--max-games', type=int, help=f'--run only; required, at most {GAME_CAP}')
    args = parser.parse_args(argv)
    if not args.run and (args.max_calls is not None or args.max_games is not None):
        parser.error('--max-calls and --max-games apply only to --run')
    if (args.run or args.report) and args.prefix is None:
        parser.error('--run and --report need an explicit --prefix')
    try:
        plan = build_plan(args.prefix or 'paired-taiwan', args.seeds, args.rounds)
        if args.run:
            validate_run(plan, args.max_calls, args.max_games)
    except (ValueError, FileExistsError) as error:
        parser.error(str(error))
    if args.run:
        state, report = run_plan(plan, args.max_calls, args.max_games)
        print(json.dumps({'run': state, 'report': f'{plan["receipts"]}/report.json', 'pairs': report['pairs'],
                          'modelTotals': report['modelTotals']}, indent=2))
        return 0 if state['status'] == 'completed' else 1
    print(json.dumps(build_report(plan) if args.report else plan, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
