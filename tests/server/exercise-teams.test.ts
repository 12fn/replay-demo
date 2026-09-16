import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store,type ExerciseRow} from '../../src/server/store';
import {ExerciseTeams} from '../../src/server/exercise-teams';
import type {Identity} from '../../src/server/service';
const clean:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();clean.splice(0).reverse().forEach(f=>f());});
const identity=(subject:string):Identity=>({subject,name:subject,role:'intelligence',organization:'Synthetic test',mode:'kamiwaza'});
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-team-'));let store=new Store(path.join(dir,'test.sqlite'));clean.push(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});const row:ExerciseRow={id:'exercise',name:'Test',kind:'live',status:'running',createdAt:new Date().toISOString(),humanSide:'blue',options:{ownerSubject:'owner',workroomId:'room'},agentEnabled:false};store.putExercise(row);return {row,get store(){return store;},restart(){store.close();store=new Store(path.join(dir,'test.sqlite'));}};}
it('retains enrollment and hashed invitation across restart, and expires invitations without changing ownership or evidence',()=>{
 const s=setup();let teams=new ExerciseTeams(s.store);teams.enroll(s.row,identity('analyst'),42);const issued=teams.issueCode(s.row,'owner');
 expect(JSON.stringify(s.store.db.prepare('SELECT * FROM settings').all())).not.toContain(issued.code);
 s.restart();teams=new ExerciseTeams(s.store);expect(teams.lookupCode(issued.code,'room').id).toBe(s.row.id);expect(teams.includes(s.row,'analyst')).toBe(true);expect(teams.participants(s.row).find(p=>p.subject==='analyst')?.joinedTick).toBe(42);
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(issued.expiresAt));expect(()=>teams.lookupCode(issued.code,'room')).toThrow('expired');expect(teams.includes(s.row,'analyst')).toBe(true);expect(s.store.exercise(s.row.id)?.options.ownerSubject).toBe('owner');
});
it('cannot overfill a class by rejoining a removed seat, and rotation invalidates old invitations',()=>{
 const s=setup(),teams=new ExerciseTeams(s.store);teams.enroll(s.row,identity('returning'),2);teams.remove(s.row,'returning','owner');for(let n=0;n<15;n++)teams.enroll(s.row,identity('p'+n),3);
 expect(()=>teams.enroll(s.row,identity('returning'),4)).toThrow('sixteen');expect(teams.includes(s.row,'returning')).toBe(false);
 const old=teams.issueCode(s.row,'owner'),current=teams.issueCode(s.row,'owner');expect(()=>teams.lookupCode(old.code,'room')).toThrow('invalid');expect(teams.lookupCode(current.code,'room').id).toBe(s.row.id);
});

it('campaign missions refuse standalone codes and direct peer enrollment',()=>{
 const s=setup(),teams=new ExerciseTeams(s.store),old=teams.issueCode(s.row,'owner');
 s.row.options.campaignId='campaign';s.store.putExercise(s.row);
 expect(()=>teams.issueCode(s.row,'owner')).toThrow(/campaign invitation/);
 expect(()=>teams.lookupCode(old.code,'room')).toThrow(/unavailable/);
 expect(()=>teams.enroll(s.row,identity('analyst'),2)).toThrow(/campaign invitation/);
 expect(teams.enroll(s.row,identity('owner'),1).owner).toBe(true);
 expect(teams.participants(s.row).map(p=>p.subject)).toEqual(['owner']);
});

it('campaign seats are carried only onto that campaign\'s own missions, keep their join tick, respect the cap and can be removed like any seat',()=>{
 const s=setup(),teams=new ExerciseTeams(s.store);
 const seat=(subject:string)=>({subject,name:subject,organization:'Synthetic',roleAtJoin:'unknown' as const,source:'campaign-carryover' as const,membershipVersion:3});
 expect(()=>teams.carry(s.row,'campaign',seat('analyst'),2)).toThrow(/own missions/);
 s.row.options.campaignId='campaign';s.store.putExercise(s.row);
 expect(()=>teams.carry(s.row,'other-campaign',seat('analyst'),2)).toThrow(/own missions/);
 expect(()=>teams.carry(s.row,'campaign',seat('owner'),2)).toThrow(/seated by creation/);
 expect(()=>teams.carry({...s.row,kind:'branch'},'campaign',seat('analyst'),2)).toThrow(/own missions/);
 expect(()=>teams.carry({...s.row,parentId:'parent'},'campaign',seat('analyst'),2)).toThrow(/own missions/);
 const carried=teams.carry(s.row,'campaign',seat('analyst'),2);
 expect(carried).toMatchObject({subject:'analyst',active:true,owner:false,joinedTick:2,source:'campaign-carryover',campaignMembershipVersion:3,roleAtJoin:'unknown'});
 expect(teams.carry(s.row,'campaign',{...seat('analyst'),roleAtJoin:'commander',membershipVersion:4},9)).toMatchObject({joinedTick:2,roleAtJoin:'commander',campaignMembershipVersion:4});
 expect(teams.includes(s.row,'analyst')).toBe(true);
 // The public enrollment path stays owner-only on campaign rows; only the carry path seats participants.
 expect(()=>teams.enroll(s.row,identity('analyst'),3)).toThrow(/campaign invitation/);
 for(let n=0;n<14;n++)teams.carry(s.row,'campaign',seat('p'+n),3);
 expect(()=>teams.carry(s.row,'campaign',seat('overflow'),3)).toThrow('sixteen');
 teams.remove(s.row,'analyst','owner');expect(teams.includes(s.row,'analyst')).toBe(false);
 expect(teams.participants(s.row).find(p=>p.subject==='analyst')).toMatchObject({active:false,removedBy:'owner',source:'campaign-carryover'});
 expect(teams.carry(s.row,'campaign',seat('analyst'),40).joinedTick).toBe(40);
});
