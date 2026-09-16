import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
// AGPL corresponding source: an explicit allowlist prevents secrets and participant recordings entering the archive; the named POC record is a deterministic test fixture.
const include=['public/brands','resources/showcase','resources/catalog-ontology','src','vendor','tests','evidence/poc/engine-record.json','scripts','services','docs/pilot','docs/stages/status.json','docs/process/BUILD-JOURNAL.md','docs/operator-runbook.md','docs/model-configuration.md','docs/demo/ten-minute-instructor-case.md','docs/demo/astra-audit-0270.md','docs/demo/frontend-0280.md','docs/demo/spark-0292.md','docs/demo/HUMAN-RECORDING-SCRIPT.md','LICENSE','THIRD-PARTY-NOTICES.md','README.md','PUBLIC-RELEASE.md','AGENTS.md','package.json','pnpm-lock.yaml','tsconfig.json','vite.config.ts','vitest.config.ts','index.html','Dockerfile','.dockerignore','.gitignore','.gitattributes',...['README.md','manifest.json','catalog.json','relationships.jsonl','sources.json','records.jsonl'].map(name=>`handoff/REPLAY-preset-catalog-1/${name}`)];
const files=[];
function collect(p){const stat=fs.lstatSync(p);if(stat.isSymbolicLink())throw new Error(`Refusing source symlink: ${p}`);if(stat.isDirectory()){for(const name of fs.readdirSync(p).sort()){if(name==='__pycache__')continue;collect(path.join(p,name));}}else if(stat.isFile())files.push(p);}
include.filter(p=>fs.existsSync(p)).forEach(collect);fs.mkdirSync('public',{recursive:true});
execFileSync('tar',['-czf','public/replay-source.tar.gz','--',...files],{env:{...process.env,COPYFILE_DISABLE:'1'}});
const archive=fs.readFileSync('public/replay-source.tar.gz');
const simulationProfile=fs.readFileSync('src/engine/engine.ts','utf8').match(/export const SIMULATION_PROFILE = '([^']+)'/)?.[1];
if(!simulationProfile)throw new Error('Simulation profile missing from corresponding source');
const source={simulationProfile,builtAt:new Date().toISOString(),product:'REPLAY',version:JSON.parse(fs.readFileSync('package.json','utf8')).version,upstream:JSON.parse(fs.readFileSync('vendor/openfront/UPSTREAM.json','utf8')),sourceArchive:{path:'/replay-source.tar.gz',sha256:crypto.createHash('sha256').update(archive).digest('hex'),bytes:archive.length,files:files.length}};
fs.writeFileSync('public/replay-build.json',JSON.stringify(source,null,2));console.log(`Corresponding source packaged: ${files.length} files, ${(archive.length/1048576).toFixed(1)} MiB.`);
