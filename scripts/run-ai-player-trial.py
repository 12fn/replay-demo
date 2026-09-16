"""Bounded external-model trial. Only synthetic permitted prompts; no app inference or native sessions.
--mode full-game (docs/demo/full-game-player-trials.md) is a separate explicit authorization of up to 45 provider decisions
per fresh trial; it does not touch the application's inference ledger. One attempt per call: no retries, no fallback.
--player-output v1 (docs/demo/player-output-contract.md) opts a fresh enriched trial into player-output/1; Opus replies are
constrained by the trial's write-once schema and read only from structured_output, never from free text."""
import argparse,datetime,hashlib,json,os,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
# Same bound as validInterval in scripts/ai-player-trial.ts, which validates again at init. Not derived from any tick cap.
INTERVAL,MAX_INTERVAL=45,900
BLUE_TICKS,SHORT_CALLS,SHORT_CAP_TICKS=270,6,1800
FULL_GAME_MODE='full-game/1'
PLAYER_OUTPUT,PLAYER_OUTPUT_SCHEMA='player-output/1','initialization/player-output-schema.json'
def interval(text):
 n=int(text)
 if n<INTERVAL or n>MAX_INTERVAL or n%INTERVAL:raise argparse.ArgumentTypeError(f'must be a multiple of {INTERVAL} from {INTERVAL} to {MAX_INTERVAL}')
 return n
def main():
 p=argparse.ArgumentParser();p.add_argument('provider',choices=['org-sol','opus']);p.add_argument('name')
 p.add_argument('--opponent-ticks-per-check',type=interval,default=INTERVAL,help='Red order interval; 45 is the original cadence, 270 matches Blue')
 p.add_argument('--player-context',choices=['legacy','enriched'],default='legacy',help='enriched opts a new trial into enriched/1 (docs/demo/player-context-v2.md); legacy writes the original format')
 p.add_argument('--mode',choices=['short','full-game'],default='short',help='full-game: enriched context, Blue 270 / Red 270, up to 45 provider decisions to the scenario ending (requires both flags explicitly)')
 p.add_argument('--player-output',choices=['none','v1'],default='none',help='v1 opts a new enriched trial into player-output/1: share required, null only where it is irrelevant, Opus output schema-constrained')
 a=p.parse_args()
 context={'legacy':None,'enriched':'enriched/1'}[a.player_context];full=a.mode=='full-game';output=PLAYER_OUTPUT if a.player_output=='v1' else None
 if not a.name.replace('-','').isalnum():raise ValueError('Name must be alphanumeric with hyphens')
 if full and (a.player_context!='enriched' or a.opponent_ticks_per_check!=BLUE_TICKS):p.error(f'--mode full-game requires --player-context enriched and --opponent-ticks-per-check {BLUE_TICKS}')
 if output and a.player_context!='enriched':p.error('--player-output v1 requires --player-context enriched')
 folder=ROOT/'evidence/ai-player-trial'/a.name
 if folder.exists():raise FileExistsError('Preserve existing trial')
 def command(args):
  r=subprocess.run(args,cwd=ROOT,text=True,capture_output=True,timeout=60)
  if r.returncode:raise RuntimeError(r.stderr[-2000:])
  return r.stdout
 # Full-game bounds come from the harness source (NETWORK_RULES.limitTicks), never a constant here.
 if full:
  bounds=json.loads(command(['pnpm','exec','tsx','scripts/ai-player-trial.ts','bounds']).strip().splitlines()[-1])['fullGame']
  if (bounds['trialMode'],bounds['playerContext'],bounds['ticksPerDecision'],bounds['opponentTicksPerCheck'],bounds['maxDecisions'])!=(FULL_GAME_MODE,'enriched/1',BLUE_TICKS,BLUE_TICKS,45) or not isinstance(bounds['capTicks'],int) or bounds['capTicks']<=SHORT_CAP_TICKS:raise RuntimeError(f'Harness full-game bounds are not the authorized ones: {bounds}')
  MAX_CALLS,CAP_TICKS=bounds['maxDecisions'],bounds['capTicks']
 else:MAX_CALLS,CAP_TICKS=SHORT_CALLS,SHORT_CAP_TICKS
 command(['pnpm','exec','tsx','scripts/ai-player-trial.ts','init','--dir',str(folder),'--seed','PAIR0001','--mode',a.mode,'--decisions',str(MAX_CALLS),'--ticks-per-decision',str(BLUE_TICKS),'--opponent-ticks-per-check',str(a.opponent_ticks_per_check),'--cap-ticks',str(CAP_TICKS),'--player-context',a.player_context,'--player-output',a.player_output])
 # Verify the initialized settings before any inference; a mismatch stops with the directory retained.
 manifest=json.loads((folder/'manifest.json').read_text());config=manifest['config']
 if (config['ticksPerDecision'],config.get('opponentTicksPerCheck'),config['maxDecisions'],config['capTicks'],config.get('playerContext'),config.get('trialMode'),config.get('playerOutput'))!=(BLUE_TICKS,a.opponent_ticks_per_check,MAX_CALLS,CAP_TICKS,context,FULL_GAME_MODE if full else None,output):raise RuntimeError('Initialized trial does not match the requested mode, cadence, bounds, player context and player output')
 schema_file=folder/PLAYER_OUTPUT_SCHEMA
 if output and not schema_file.exists():raise RuntimeError('Player-output trial is missing its schema')
 if not output and schema_file.exists():raise RuntimeError('Trial without player output unexpectedly has a schema')
 schema=json.loads(schema_file.read_text()) if output else None
 run_manifest=folder/'initialization/run-manifest.json';run_sha=None
 if full:
  r=json.loads(run_manifest.read_text()) if run_manifest.exists() else {}
  if r.get('trialId')!=manifest['trialId'] or r.get('trialMode')!=FULL_GAME_MODE or r.get('config')!=config or r.get('objective',{}).get('limitTicks')!=CAP_TICKS or manifest['cursor']['decision']!=0 or manifest['history']:raise RuntimeError('Run manifest missing or inconsistent with the initialized full-game trial')
  run_sha=hashlib.sha256(run_manifest.read_bytes()).hexdigest()
 elif run_manifest.exists():raise RuntimeError('Short trial unexpectedly has a run manifest')
 cadence={'blueTicksPerDecision':BLUE_TICKS,'opponentTicksPerCheck':a.opponent_ticks_per_check,'equalCadence':BLUE_TICKS==a.opponent_ticks_per_check,'note':'Equal cadence equalizes only order opportunity counts; see final/summary.json opportunities for actual counts and what is not equalized.'}
 proof={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'provider':a.provider,'status':'running','mode':FULL_GAME_MODE if full else 'short','cadence':cadence,'playerContext':context or 'legacy','capTicks':CAP_TICKS,'modelCalls':0,'maxCalls':MAX_CALLS,'appInferenceCalls':0,'retries':0,'humanValidated':False,'steps':[],'note':'Actual model chooses from supplied legal candidates in a paused accelerated fictional game against scripted objectives/1. Not continuous native play or a strength benchmark.'}
 if output:proof.update({'playerOutput':output,'outputSchema':str(schema_file.relative_to(ROOT)),'outputSchemaSha256':hashlib.sha256(schema_file.read_bytes()).hexdigest(),'constrainedOutput':'opus: --json-schema, reply read only from structured_output' if a.provider=='opus' else 'none: org-sol replies are prompt-instructed and checked only by the harness parser'})
 if full:proof.update({'runManifest':str(run_manifest.relative_to(ROOT)),'runManifestSha256':run_sha,'budget':'Separate authorization of up to 45 subscription/provider decisions for this fresh trial; not counted in, and does not change, the application inference ledger.','fullGameNote':'One model plays Blue alone against the scripted objectives/1 Red controller with model latency paused. Not AI-vs-AI, not native continuous play, not a validated difficulty benchmark.'})
 def save(): (folder/'provider-proof.json').write_text(json.dumps(proof,indent=2)+'\n')
 save()
 try:
  for i in range(MAX_CALLS):
   m=json.loads((folder/'manifest.json').read_text())
   if m['status']=='complete':break
   prompt=(folder/m['cursor']['prompt']).read_text();started=time.monotonic();proof['modelCalls']+=1;save()
   if a.provider=='org-sol':
    task=ROOT/'docs/process/codex-tasks'/f'player-{a.name}-{i}.json'
    task.write_text(json.dumps({'name':f'player-{a.name}-{i}','prompt':prompt,'sources':[]},indent=2)+'\n')
    r=subprocess.run([sys.executable,'scripts/hackathon-codex-review.py','--task',str(task)],cwd=ROOT,text=True,capture_output=True,timeout=270)
    if r.returncode:raise RuntimeError('Sponsored runner failed; preserved its result files')
    receipt=json.loads(r.stdout.strip().splitlines()[-1]);events=[json.loads(line) for line in (ROOT/receipt['artifact']).read_text().splitlines() if line.strip()]
    items=[e['item'] for e in events if 'item' in e]
    if any(x.get('type') not in ['agent_message','reasoning'] for x in items):raise RuntimeError('Model invoked a tool; trial observation boundary unqualified')
    messages=[x['text'] for x in items if x.get('type')=='agent_message'];assert messages
    text=messages[-1];model='gpt-5.6-sol';meta={'providerArtifact':receipt['artifact'],'usage':receipt['usage_events'],'personalAuthUnchanged':receipt['personal_auth_unchanged']}
   else:
    env={k:v for k,v in os.environ.items() if k not in ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY','CODEX_ACCESS_TOKEN']}
    # No --fallback-model: a failed or overloaded call stops the trial rather than switching model or account.
    r=subprocess.run(['claude','-p','--model','claude-opus-5','--effort','medium','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','json',*(['--json-schema',json.dumps(schema,separators=(',',':'))] if output else [])],input=prompt,cwd=ROOT,env=env,text=True,capture_output=True,timeout=240)
    artifact=folder/f'provider-{i:02d}.json';artifact.write_text(r.stdout)
    (folder/f'provider-{i:02d}.stderr').write_text(r.stderr)
    if r.returncode:raise RuntimeError('Opus subscription runner failed; preserved result')
    d=json.loads(r.stdout);assert not d.get('is_error');assert 'claude-opus-5' in d.get('modelUsage',{})
    if output:
     # The constrained object is the reply; free text is never parsed as a substitute. The harness still validates it.
     if not isinstance(d.get('structured_output'),dict):raise RuntimeError('Constrained Opus reply has no structured_output object; preserved result, no text fallback')
     text=json.dumps(d['structured_output'])
    else:text=d['result']
    model='claude-opus-5';meta={'providerArtifact':str(artifact.relative_to(ROOT)),'sessionId':d.get('session_id'),'usage':d.get('modelUsage'),'toolsDisabled':True,**({'structuredOutput':True} if output else {})}
   raw=text.strip()
   if raw.startswith('```json\n') and raw.endswith('```'):raw=raw[8:-3].strip()
   elif raw.startswith('```\n') and raw.endswith('```'):raw=raw[4:-3].strip()
   parsed=json.loads(raw)
   response=folder/f'response-{i:02d}.json';response.write_text(json.dumps(parsed)+'\n')
   row={'decision':i,'snapshotId':m['cursor']['snapshotId'],'promptSha256':hashlib.sha256(prompt.encode()).hexdigest(),'elapsedSeconds':round(time.monotonic()-started,2),'model':model,**meta,'responsePath':str(response.relative_to(ROOT)),'applied':False}
   proof['steps'].append(row);save()
   command(['pnpm','exec','tsx','scripts/ai-player-trial.ts','step','--dir',str(folder),'--response',str(response),'--responder',model]);row['applied']=True;save()
   print(json.dumps({'trial':a.name,'decision':i,'model':model,'choice':parsed['choice'],**({'share':parsed['share']} if 'share' in parsed else {}),'applied':True}),flush=True)
  if json.loads((folder/'manifest.json').read_text())['status']!='complete':raise RuntimeError(f'Trial still awaiting a choice after {MAX_CALLS} calls')
  summary=json.loads((folder/'final/summary.json').read_text());proof['status']='completed';proof['summary']=summary
  # Stop label is copied from the harness summary, never inferred: no outcome means no result.
  proof['stopReason']=summary.get('stopReason');proof['terminal']=summary['outcome'] is not None
 except Exception as error:
  proof['status']='failed';proof['failure']=str(error);raise
 finally:save()
 o=proof['summary']['opportunities']
 print(json.dumps({'trial':a.name,'status':proof['status'],'modelCalls':proof['modelCalls'],'outcome':proof['summary']['outcome'],'stopReason':proof['summary'].get('stopReason'),'scoresStatus':proof['summary'].get('scoresStatus'),'mode':proof['mode'],'terminal':proof['terminal'],'ticksSimulated':proof['summary']['ticksSimulated'],'scores':proof['summary']['scores'],'playerContext':context or 'legacy','playerOutput':output or 'none','cadence':cadence,'equalOpportunityCount':o['equalOpportunityCount'],'blue':o['blue'],'red':o['red']}))
if __name__=='__main__':main()
