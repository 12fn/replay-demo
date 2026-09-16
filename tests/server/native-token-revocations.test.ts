import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {NativeTokenRevocations} from '../../src/server/native-token-revocations';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const token=(exp?:number,id='a')=>'header.'+Buffer.from(JSON.stringify({sub:id,...(exp===undefined?{}:{exp})})).toString('base64url')+'.signature';
const database=()=>{const db=new DatabaseSync(':memory:');cleanup.push(()=>db.close());return db;};
describe('persistent REPLAY-only switched-token refusal',()=>{
 it('stores hashes only and denies the exact token after the database is closed and reopened',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-token-refusal-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const filename=path.join(dir,'store.sqlite');
  let db=new DatabaseSync(filename);const old=token(99999999),other=token(99999999,'b');new NativeTokenRevocations(db,()=>1000).revoke(old);
  expect(JSON.stringify(db.prepare('SELECT * FROM native_switched_tokens').all())).not.toContain(old);db.close();
  db=new DatabaseSync(filename);cleanup.push(()=>db.close());const restarted=new NativeTokenRevocations(db,()=>2000);expect(()=>restarted.assertAllowed(old)).toThrow('switched out');expect(()=>restarted.assertAllowed(other)).not.toThrow();
 });
 it('can prune expired entries without making that immutable expired token acceptable again',()=>{
  const db=database();let now=1000;const guard=new NativeTokenRevocations(db,()=>now);const old=token(2);guard.revoke(old);now=100000;expect(()=>guard.assertAllowed(token(999999,'different'))).not.toThrow();expect(db.prepare('SELECT COUNT(*) n FROM native_switched_tokens').get()).toEqual({n:0});expect(()=>guard.assertAllowed(old)).toThrow('expired');
 });
 it('retains tokens with no provable expiry and fails closed at capacity instead of evicting them',()=>{
  const db=database();const guard=new NativeTokenRevocations(db,()=>1000,2);guard.revoke(token(undefined,'a'));guard.revoke(token(undefined,'b'));expect(()=>guard.revoke(token(undefined,'c'))).toThrow('storage is unavailable');expect(()=>guard.assertAllowed(token(undefined,'different'))).toThrow('storage is unavailable');expect(db.prepare('SELECT COUNT(*) n FROM native_switched_tokens').get()).toEqual({n:2});
 });
 it('fails closed on write errors and all later entry checks',()=>{
  const db=database();const guard=new NativeTokenRevocations(db,()=>1000);db.exec('PRAGMA query_only=ON');expect(()=>guard.revoke(token(999999))).toThrow('storage is unavailable');expect(()=>guard.assertAllowed(token(999999,'other'))).toThrow('storage is unavailable');
 });
 it('bounds each housekeeping sweep to100 expired records',()=>{
  const db=database();let now=1000;const guard=new NativeTokenRevocations(db,()=>now);for(let i=0;i<101;i++)guard.revoke(token(2,String(i)));now=100000;guard.assertAllowed(token(999999,'live'));expect(db.prepare('SELECT COUNT(*) n FROM native_switched_tokens').get()).toEqual({n:1});
 });
});
