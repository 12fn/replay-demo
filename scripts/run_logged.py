"""Run an argument-vector command and catalog its outcome. Never pass secrets."""
import argparse
import datetime
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def scrub(text):
    text = re.sub(r"sk-[A-Za-z0-9_-]{16,}", "[REDACTED]", text)
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+", r"\1[REDACTED]", text)
    return text

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('label')
    p.add_argument('command',nargs=argparse.REMAINDER)
    a=p.parse_args();cmd=a.command[1:] if a.command[:1]==['--'] else a.command
    if not cmd:p.error('command is required')
    stamp=datetime.datetime.now(datetime.timezone.utc)
    label=re.sub(r'[^a-zA-Z0-9_-]','-',a.label)
    folder=ROOT/'evidence/commands';folder.mkdir(parents=True,exist_ok=True)
    output=folder/(stamp.strftime('%Y%m%dT%H%M%S')+'-'+label+'.log')
    start=time.monotonic()
    with (ROOT/'docs/process/events.jsonl').open('a') as f:f.write(json.dumps({'at':stamp.isoformat(),'kind':'command_started','label':label,'argv':[scrub(x) for x in cmd],'output':str(output.relative_to(ROOT))})+'\n')
    child=subprocess.Popen(cmd,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
    try:
        with output.open('w') as f:
            for line in child.stdout:
                clean=scrub(line);f.write(clean);f.flush();sys.stdout.write(clean);sys.stdout.flush()
        code=child.wait()
    except KeyboardInterrupt:
        child.terminate()
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:child.kill();child.wait()
        code=130
    event={'at':stamp.isoformat(),'kind':'command','label':label,'argv':[scrub(x) for x in cmd],'cwd':str(ROOT),'exit_code':code,'duration_seconds':round(time.monotonic()-start,3),'output':str(output.relative_to(ROOT))}
    with (ROOT/'docs/process/events.jsonl').open('a') as f:f.write(json.dumps(event)+'\n')
    print(json.dumps({'catalogued':label,'exit_code':code,'output':str(output.relative_to(ROOT))}))
    return code

if __name__=='__main__':raise SystemExit(main())
