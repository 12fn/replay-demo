/** Remove only the temporary workroom membership created for local Tomo configuration. */
import fs from 'node:fs';import assert from 'node:assert/strict';
import {operatorClient,binding} from './operator-client';import type {KamiwazaClient} from '../../src/platform';
const created=JSON.parse(fs.readFileSync('evidence/platform/tomo-admin-enrollment-1.2.0.json','utf8'));
assert.equal(created.temporary,true);assert.equal(created.workroom,binding.workroom.id);
const artifact='evidence/platform/tomo-admin-enrollment-cleanup-1.2.0.json';assert(!fs.existsSync(artifact));
const op=await operatorClient();try{
 const c=op.resolved.platformClient as KamiwazaClient;const path=`/workrooms/${binding.workroom.id}/members`;
 const before=await c.request<any>({method:'GET',path,workroomId:binding.workroom.id});
 const temporary=before.data.items.find((m:any)=>m.user_id===created.member.user_id&&m.active);
 assert(temporary);assert.equal(temporary.id,created.member.id);
 const removed=await c.request({method:'DELETE',path:path+'/'+created.member.user_id,workroomId:binding.workroom.id});
 const after=await c.request<any>({method:'GET',path,workroomId:binding.workroom.id});assert(!after.data.items.some((m:any)=>m.user_id===created.member.user_id&&m.active));
 const others=(items:any[])=>items.filter(m=>m.user_id!==created.member.user_id).map(m=>({id:m.id,user_id:m.user_id,active:m.active,role:m.role})).sort((a,b)=>a.id.localeCompare(b.id));assert.deepEqual(others(after.data.items),others(before.data.items));
 const proof={at:new Date().toISOString(),workroom:binding.workroom.id,removedUserId:created.member.user_id,removedMembershipId:created.member.id,receipt:removed.receipt,membershipAbsent:true,otherMembersPreserved:true,accountAndRealmRolesUntouched:true};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{op.sessions.close();}
