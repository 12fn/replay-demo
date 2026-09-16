/** Portable synthetic reference catalog. Does not access app state, identity, network or models. */
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {createPresetCatalog} from '../src/catalog/seed';import {CatalogStore} from '../src/server/catalog-store';
const out=process.argv[2];if(!out||fs.existsSync(out))throw new Error('Provide a new output directory; existing exports are immutable');
const bundle=createPresetCatalog(),db=new DatabaseSync(':memory:');const catalog=new CatalogStore(db,bundle);const summary=catalog.summary('instructor');
fs.mkdirSync(out,{recursive:true});const files:Record<string,string>={
 'catalog.json':JSON.stringify(bundle,null,2)+'\n',
 'records.jsonl':bundle.records.map(r=>JSON.stringify(r)).join('\n')+'\n',
 'relationships.jsonl':bundle.records.flatMap(r=>r.links.map(l=>JSON.stringify({from:r.id,relation:l.relation,to:l.targetId,aorId:r.aorId}))).join('\n')+'\n',
 'sources.json':JSON.stringify(bundle.sources,null,2)+'\n',
 'README.md':`# REPLAY preset reference catalog\n\nVersion: ${bundle.version}\n\n${bundle.notice}\n\n${bundle.records.length} records; three AORs. Taiwan has a playable app scenario; Caribbean and Hormuz are context-only. This export does not include real users, actual exercises, access credentials or current military intelligence.\n\n${Object.entries(summary.counts).map(([k,n])=>'- '+k+': '+n).join('\n')}\n\nJSON contains the complete authored examples, including hindsight. App release-cutoff queries additionally defer complete case/persona summaries until their latest linked event, and hide future record references. This archive is not a time-filtered player observation.\n\nRecord links are portable graph data, not proof of native ontology ingestion. Public sources are links and short original summaries; no source full texts are bundled. See the app source for deterministic regeneration and tests.\n`,
};
for(const [name,body]of Object.entries(files))fs.writeFileSync(path.join(out,name),body,{flag:'wx'});
const manifest={version:bundle.version,seed:bundle.seed,catalogSha256:summary.sha256,total:bundle.records.length,counts:summary.counts,relationships:bundle.records.reduce((n,r)=>n+r.links.length,0),files:Object.entries(files).map(([name,body])=>({name,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}))};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});db.close();console.log(JSON.stringify({output:out,...manifest}));
