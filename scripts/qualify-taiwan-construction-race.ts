/** Saved fictional game counterfactuals. No providers, network or original record writes. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {ReplayEngine,type Side,type ExecutionFeedbackEvent} from '../src/engine/engine';import {rawStep} from './qualify-pacing';
const root='evidence/dual-model-trial/taiwan-sol-blue-opus-red-full-20260915';
const output='evidence/platform/taiwan-construction-race-20260915.json';assert(!fs.existsSync(output));
const paths=['rounds/16/replay.json','results/16/outcome.json','results/16/blue/decision.json','results/16/red/decision.json'];
const raw=paths.map(p=>fs.readFileSync(`${root}/${p}`));const hashes=raw.map(b=>createHash('sha256').update(b).digest('hex'));
const [checkpoint,result,blue,red]=raw.map(b=>JSON.parse(b.toString()));
const cases=[{name:'recorded-blue-first',orders:[blue,red]},{name:'blue-only',orders:[blue]},{name:'counterfactual-red-first',orders:[red,blue]}];
const rows=[];
for(const c of cases){
 const e=await ReplayEngine.restore(checkpoint.record,checkpoint.tick,'checkpoints');assert.equal(e.state().fingerprint,result.board.before.fingerprint??checkpoint.record.fingerprints[checkpoint.tick]);
 e.feedback.drain();for(const o of c.orders)e.validate(o.seat as Side,o.intent);
 const initial={tick:e.game.ticks(),tileOwner:e.game.ownerID(red.intent.tile),redOwner:e.player('red').smallID(),redGold:Number(e.player('red').gold())};
 const feedback:ExecutionFeedbackEvent[]=[];rawStep(e,c.orders.map(o=>({side:o.seat as Side,intent:o.intent})));feedback.push(...e.feedback.drain());
 while(e.game.ticks()<result.toTick){rawStep(e);feedback.push(...e.feedback.drain());}
 rows.push({name:c.name,initial,final:{tick:e.game.ticks(),fingerprint:e.state().fingerprint,redAlive:e.player('red').isAlive()},construction:feedback.filter(f=>f.intent==='build_unit'&&f.key.turnNumber===checkpoint.tick)});
}
assert.equal(rows[0].final.fingerprint,result.fingerprintAfter);assert.equal(rows[1].final.fingerprint,result.fingerprintAfter);
assert.equal(rows[0].construction[0]?.status,'construction-not-started');const observation=rows[0].construction[0]!.observed;assert.equal(observation.kind,'construction');assert(observation.kind==='construction');assert.equal(observation.goldDelta,0);
assert(rows[2].construction.some(f=>f.status==='construction-started'));assert(rows.every(r=>r.final.redAlive===false));
paths.forEach((p,i)=>assert.equal(createHash('sha256').update(fs.readFileSync(`${root}/${p}`)).digest('hex'),hashes[i]));
const proof={at:new Date().toISOString(),status:'passed',cases:rows,sources:paths.map((path,i)=>({path:`${root}/${path}`,sha256:hashes[i]})),originalsUnchanged:true,modelCalls:0,limitations:['Fixed Blue order; no opponent adaptation. This tests engine mechanics, not the best strategy or human learning.','Only round16 construction and queue variants independently rerun here; other Opus experiments remain worker-reported.']};
fs.writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({artifact:output,status:proof.status,cases:rows.map(r=>({name:r.name,final:r.final,statuses:r.construction.map(f=>f.status)})),modelCalls:0}));
