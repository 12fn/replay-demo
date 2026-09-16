"""Build a versioned pilot handoff in fresh staging; verify it before publication. No credentials/data/."""
from pathlib import Path
import argparse,datetime,hashlib,html,json,os,re,shutil,tempfile,urllib.request,zipfile

ROOT=Path(__file__).resolve().parents[1]
def sha(data):return hashlib.sha256(data).hexdigest()
def fetch_json(url):
    with urllib.request.urlopen(url,timeout=30) as r:return json.load(r)
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name',help='Unique artifact name. Defaults to REPLAY-pilot-<native version>. Existing artifacts are never replaced.')
    parser.add_argument('--expect-version',help='Refuse a different native deployment version.')
    args=parser.parse_args()
    meta=fetch_json('http://127.0.0.1:5183/replay-build.json')
    if args.expect_version and meta['version']!=args.expect_version:raise RuntimeError('Native version differs from expected release')
    name=args.name or 'REPLAY-pilot-'+meta['version']
    if not re.fullmatch(r'REPLAY-pilot-[A-Za-z0-9._-]+',name):raise ValueError('Invalid handoff artifact name')
    handoff=ROOT/'handoff';handoff.mkdir(exist_ok=True)
    final=handoff/name;archive_path=handoff/(name+'.zip')
    if final.exists() or archive_path.exists():raise FileExistsError('Artifact exists; choose a new revision name. Existing handoffs are immutable.')
    with tempfile.TemporaryDirectory(prefix='.replay-package-',dir=handoff) as temp:
        stage=Path(temp);out=stage/name;out.mkdir()
        def copy(relative):
            src=ROOT/relative;dst=out/relative
            if src.is_symlink():raise RuntimeError('Symlinks not permitted')
            if src.is_dir():
                for child in sorted(src.iterdir()):copy(child.relative_to(ROOT))
            else:
                dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
        for item in ['README.md','LICENSE','THIRD-PARTY-NOTICES.md','docs','evidence/platform','evidence/pilot','evidence/soak','evidence/naval','evidence/pacing','evidence/campaign','evidence/ui','evidence/ai-player-trial','evidence/dual-model-trial','evidence/playability','evidence/codex','evidence/commands']:
            if (ROOT/item).exists():copy(Path(item))
        for item in ['evidence/paired-red-evaluation','evidence/feedback-comparison','evidence/reviews','handoff/REPLAY-catalog-ontology-4','handoff/REPLAY-preset-catalog-1']:
            if (ROOT/item).exists():copy(Path(item))
        # Operator integration scripts may advance after the app source freeze.
        # Keep that separate copy explicit; the app source archive remains exact.
        copy(Path('scripts/platform'))
        copy(Path('scripts/run_logged.py'))
        for item in ['scripts/ai-player-trial.ts','scripts/run-ai-player-trial.py','scripts/hackathon-codex-review.py','scripts/scan-known-credentials.py','scripts/dual-model-trial.ts','scripts/run-dual-model-trial.py','scripts/qualify-dual-model-cli.py','scripts/qualify-dual-model-result.ts']:
            copy(Path(item))
        for item in ['scripts/compare-round-feedback.py','scripts/paired-red-evaluation.py','scripts/export-catalog-ontology.ts']:
            copy(Path(item))
        for p in sorted((ROOT/'evidence/poc').glob('native-*.json')):copy(p.relative_to(ROOT))
        for p in sorted((ROOT/'evidence/video').glob('*')):
            if p.is_file() and p.suffix in ['.mp4','.webm','.srt','.json','.md'] and not p.name.startswith('capture-smoke'):copy(p.relative_to(ROOT))
        with urllib.request.urlopen('http://127.0.0.1:5183/replay-source.tar.gz',timeout=30) as r:source=r.read()
        if sha(source)!=meta['sourceArchive']['sha256']:raise RuntimeError('Source archive integrity mismatch')
        (out/'source').mkdir();(out/'source/replay-source.tar.gz').write_bytes(source)
        (out/'source/deployed-build.json').write_text(json.dumps(meta,indent=2))
        status=json.loads((out/'docs/stages/status.json').read_text())
        # Bind staged status to this deployed source; publication checksum lives outside its own archive.
        status['delivery'].update(current_native_image='localhost/replay:'+meta['version'],current_source_sha256=meta['sourceArchive']['sha256'],current_pilot_package=str(archive_path.relative_to(ROOT)),current_pilot_sha256=None,current_pilot_bytes=None)
        status['delivery'].pop('current_native_source_sha256',None)
        (out/'docs/stages/status.json').write_text(json.dumps(status,indent=2)+'\n')
        recorded=', '.join(status['delivery'].get('recorded_source_images', [status['delivery']['recorded_demo_image']]));version=html.escape(meta['version'])
        demo=html.escape(status['delivery']['demo'],quote=True)
        transcript=html.escape(status['delivery'].get('transcript','evidence/video/transcript.md'),quote=True)
        captions=html.escape(status['delivery'].get('captions','evidence/video/replay-demo.srt'),quote=True)
        video_receipt=html.escape(status['delivery'].get('video_receipt','evidence/video/demo-build.json'),quote=True)
        (out/'START-HERE.html').write_text(f'''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>REPLAY · Pilot candidate {version}</title>
<style>body{{background:#091321;color:#eef3f7;font:17px system-ui;max-width:1040px;margin:44px auto;padding:0 24px;line-height:1.6}}a{{color:#77d4e2}}h1{{letter-spacing:.18em}}video{{width:100%;background:#000;border:1px solid #344a60;border-radius:12px}}small{{color:#9eb1c5}}li{{margin:8px 0}}</style>
<h1>REPLAY</h1><p>Continuous play. Auditable agents. Rewind and practice the alternative.</p>
<p>Software and corresponding source: <strong>{version}</strong>. Preserved demonstration: <strong>{html.escape(recorded)}</strong>. Later capabilities are documented in the build journal.</p>
<video controls preload="metadata" src="{demo}"></video>
<p><small>Edited actual app captures · synthetic narration · automated software demonstration</small></p>
<ul><li><a href="docs/pilot/README.md">Instructor pilot package</a> — objectives, provisional rubric, learner guide and review forms.</li>
<li><a href="docs/pilot/start-here-026.md">Current 20-minute expert session</a> · <a href="docs/pilot/expert-feedback-022.md">Feedback form</a>.</li>
<li><a href="docs/operator-runbook.md">Deployment and recovery</a> · <a href="source/replay-source.tar.gz">Exact deployed source archive</a>.</li>
<li><a href="docs/process/README.md">Build process catalog</a> · <a href="docs/process/BUILD-JOURNAL.md">Decisions, failures and results</a>.</li>
<li><a href="{transcript}">Transcript</a> · <a href="{captions}">Captions</a> · <a href="{video_receipt}">Capture/edit provenance</a>.</li>
<li><a href="evidence/pilot/instructor-bundle.json">Actual synthetic exercise evidence</a> · <a href="evidence/pilot/instructor-review.md">Unscored workflow demonstration</a>.</li></ul>
<p>This is an instructor pilot candidate. Native shared exercises support separately authenticated commander and intelligence participants; consult the included status and guides for current qualifications. Human playtesting, SME curriculum review, longer-session pacing and DGX runtime qualification remain open.</p>
<p><small>For Markdown, use a Markdown viewer. Rebuilding requires the Node/pnpm versions in README and dependency access. Credentials, native sessions and installed dependencies are excluded.</small></p>''')
        files=[{'path':str(p.relative_to(out)),'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in sorted(out.rglob('*')) if p.is_file()]
        manifest={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'pilot candidate; not human validated','nativeSourceVerified':True,'sourceImage':'localhost/replay:'+meta['version'],'recordedDemoImage':recorded,'files':files}
        (out/'MANIFEST.json').write_text(json.dumps(manifest,indent=2))
        temporary_zip=stage/(name+'.zip')
        with zipfile.ZipFile(temporary_zip,'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            for p in sorted(out.rglob('*')):
                if p.is_file():z.write(p,str(p.relative_to(stage)))
        with zipfile.ZipFile(temporary_zip) as z:
            if z.testzip():raise RuntimeError('ZIP verification failed')
            expected={name+'/'+f['path'] for f in files}|{name+'/MANIFEST.json'}
            if set(z.namelist())!=expected:raise RuntimeError('ZIP member set differs from manifest')
            for f in files:
                b=z.read(name+'/'+f['path'])
                if len(b)!=f['bytes'] or sha(b)!=f['sha256']:raise RuntimeError('ZIP file hash mismatch')
        # The ZIP is the complete deliverable. Publish without clobbering another build's artifact.
        os.link(temporary_zip,archive_path)
        if final.exists():raise FileExistsError('Extracted handoff directory was created concurrently')
        out.rename(final)
    receipt={'artifact':str(archive_path.relative_to(ROOT)),'files':len(files)+1,'bytes':archive_path.stat().st_size,'sha256':sha(archive_path.read_bytes()),'nativeSourceSha256':meta['sourceArchive']['sha256'],'sourceImage':manifest['sourceImage'],'recordedDemoImage':recorded,'manifestVerified':True}
    receipt_path=ROOT/'evidence/pilot'/(name+'.json')
    with receipt_path.open('x') as f:json.dump(receipt,f,indent=2)
    print(json.dumps(receipt))
if __name__=='__main__':main()
