"""Run a bounded task using the user's authenticated Claude subscription."""
import argparse,datetime,json,os,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
 p=argparse.ArgumentParser();p.add_argument('name');p.add_argument('prompt_file');p.add_argument('--model',default='claude-fable-5-1');p.add_argument('--web',action='store_true',help='Allow public WebSearch/WebFetch for an authorized research task');a=p.parse_args()
 folder=ROOT/'evidence/claude';folder.mkdir(parents=True,exist_ok=True)
 env=os.environ.copy()
 for key in ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY']:env.pop(key,None)
 cmd=['claude','-p','--model',a.model,'--effort','medium','--permission-mode','acceptEdits','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Read,Write,Edit,Glob,Grep,Bash','--allowedTools','Read,Write,Edit,Glob,Grep,Bash(pnpm exec vitest *),Bash(pnpm run build),Bash(pnpm run typecheck),Bash(npm run test *)','--output-format','json']
 if a.web:
  for flag in ['--tools','--allowedTools']:
   index=cmd.index(flag)+1;cmd[index]+=',WebSearch,WebFetch'
 start=time.monotonic();at=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (folder/(a.name+'.jsonl')).open('x') as f,(folder/(a.name+'.stderr')).open('x') as e:
  child=subprocess.run(cmd,input=(ROOT/a.prompt_file).read_text(),cwd=ROOT,env=env,text=True,stdout=f,stderr=e)
 result={'at':at,'kind':'delegated_task','provider':'Claude Max subscription','requested_model':a.model,'web_enabled':a.web,'name':a.name,'prompt_file':a.prompt_file,'exit_code':child.returncode,'duration_seconds':round(time.monotonic()-start,2),'result_file':str((folder/(a.name+'.jsonl')).relative_to(ROOT))}
 try:
  raw=json.loads((folder/(a.name+'.jsonl')).read_text());result['session_id']=raw.get('session_id');result['result']=raw.get('result');result['is_error']=raw.get('is_error');result['model_usage']=raw.get('modelUsage')
 except Exception:result['parse_error']=True
 with (ROOT/'docs/process/events.jsonl').open('a') as f:f.write(json.dumps(result)+'\n')
 print(json.dumps(result,indent=2));return child.returncode
if __name__=='__main__':raise SystemExit(main())
