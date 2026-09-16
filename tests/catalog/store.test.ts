import {afterEach,expect,it} from 'vitest';import {DatabaseSync} from 'node:sqlite';
import {CatalogStore,literalCatalogMatch} from '../../src/server/catalog-store';import type {CatalogBundle,CatalogRecord} from '../../src/catalog/types';
const dbs:DatabaseSync[]=[];afterEach(()=>dbs.splice(0).forEach(d=>d.close()));
const record=(id:string,tick:number,aorId:CatalogRecord['aorId']='taiwan'):CatalogRecord=>({id,aorId,kind:'report',title:`Reserve report ${id}`,summary:'Check source lineage',body:'Independent weather account',roles:['intelligence'],tags:['provenance'],provenance:'synthetic',sourceIds:[],links:[],availableAtTick:tick,fields:{}});
function fixture(){const db=new DatabaseSync(':memory:');dbs.push(db);const bundle:CatalogBundle={schema:'replay.preset-catalog/1',version:'test/1',seed:'fixed',notice:'Synthetic',aors:[{id:'taiwan',name:'Taiwan',theater:'test',summary:'test',playableScenarioId:null,focus:[],sourceIds:[]},{id:'hormuz',name:'Hormuz',theater:'test',summary:'test',playableScenarioId:null,focus:[],sourceIds:[]}],sources:[],records:[record('old',10),{...record('correction',30),links:[{relation:'supersedes',targetId:'old'}]},record('other',10,'hormuz')]};return {db,bundle,c:new CatalogStore(db,bundle)};}
it('persists one immutable version idempotently and rejects in-place replacement',()=>{const f=fixture();new CatalogStore(f.db,f.bundle);expect(f.c.summary('intelligence').total).toBe(3);expect(f.db.prepare('SELECT count(*) n FROM preset_catalog_fts').get()!.n).toBe(3);expect(()=>new CatalogStore(f.db,{...f.bundle,seed:'changed'})).toThrow(/version changed/);});
it('searches literal tokens, filters AOR/role/release cutoff and paginates without duplicate rows',()=>{const {c}=fixture();expect(c.search({query:'reserve',aorId:'taiwan',cutoffTick:20}).items.map(x=>x.id)).toEqual(['old']);expect(c.search({query:'reserve',role:'commander'}).total).toBe(0);expect(c.search({query:'reserve',limit:1}).hasMore).toBe(true);expect(c.search({query:'reserve',offset:1,limit:1}).items[0].id).not.toBe(c.search({query:'reserve',limit:1}).items[0].id);expect(c.search({query:'* OR "'}).total).toBe(0);expect(literalCatalogMatch('reserve NOT weather')).toBe('"reserve" AND "NOT" AND "weather"');});
it('hides future linked records and backlink corrections at an earlier cutoff',()=>{const {c}=fixture();expect(c.detail('old',20)?.backlinks).toEqual([]);expect(c.detail('old',30)?.backlinks[0].record.id).toBe('correction');expect(c.detail('correction',20)).toBeNull();});
it('refuses invalid query grammar, identifiers and numeric bounds',()=>{const {c}=fixture();for(const q of [{limit:101},{offset:-1},{cutoffTick:NaN},{scope:'workroom'},{aorId:'world'},{personaId:'../other'}])expect(()=>c.search(q)).toThrow();expect(()=>c.detail('../old')).toThrow();});
it('does not mutate game or personal history tables and exposes synthetic provenance',()=>{const {db,c}=fixture();expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('events','exercises','sessions')").all()).toEqual([]);expect(c.toolSearch({query:'reserve',limit:100}).items.length).toBeLessThanOrEqual(5);expect(c.search({}).items.every(x=>x.provenance==='synthetic')).toBe(true);});
it('does not expose hindsight case summaries, persona summaries or future IDs through a time cutoff',()=>{
 const {db,bundle}=fixture();const authored:CatalogRecord[]=[
 {...record('timeline',0),kind:'case',personaId:'person',caseId:'timeline',summary:'The later outcome is costly',fields:{reportIds:['old','correction']}},
 {...record('person',0),kind:'persona',personaId:'person',summary:'Learning profile includes the later outcome'},
 {...record('review',40),kind:'event',caseId:'timeline',personaId:'person',links:[{relation:'reviews',targetId:'timeline'}]},
 ];
 const c=new CatalogStore(db,{...bundle,version:'test/2',records:[{...bundle.records[0],links:[{relation:'precedes',targetId:'correction'}],fields:{supersededByReportId:'correction'}},...bundle.records.slice(1),...authored]});
 expect(c.search({cutoffTick:20}).items.map(r=>r.id)).toEqual(['old','other']);
 expect(c.detail('timeline',20)).toBeNull();expect(c.detail('person',20)).toBeNull();
 expect(c.search({query:'correction',cutoffTick:20}).items.map(r=>r.id)).not.toContain('old');
 expect(c.detail('old',20)?.record.links).toEqual([]);expect(c.detail('old',20)?.record.fields.supersededByReportId).toBeNull();
 expect(c.search({cutoffTick:40,kind:'case'}).items[0].id).toBe('timeline');expect(c.detail('person',40)?.record.availableAtTick).toBe(40);
});

it('defers a persona summary for direct attributed events and matches all literal search tokens',()=>{
 const {db,bundle}=fixture();const first=Array.from({length:24},(_,i)=>`t${i}`).join(' ');
 const c=new CatalogStore(db,{...bundle,version:'direct/1',records:[...bundle.records,{...record('person',0),kind:'persona'},{...record('direct-event',40),kind:'event',personaId:'person'},{...record('many-words',0),body:first}]});
 expect(c.detail('person',20)).toBeNull();expect(c.detail('person',40)?.record.id).toBe('person');
 expect(c.search({query:first}).items.map(r=>r.id)).toEqual(['many-words']);expect(c.search({query:first+' missing25'}).total).toBe(0);
});
