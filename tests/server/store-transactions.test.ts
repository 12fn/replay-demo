import {afterEach,expect,it} from 'vitest';
import {Store} from '../../src/server/store';
const stores:Store[]=[];afterEach(()=>{for(const s of stores.splice(0))s.close();});
function fixture(){const s=new Store(':memory:');stores.push(s);const write=(key:string)=>s.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,'saved');const keys=()=>s.db.prepare('SELECT key FROM settings ORDER BY key').all().map(r=>r.key);return {s,write,keys};}
it('commits nested operations with their outer receipt',()=>{const {s,write,keys}=fixture();s.transaction(()=>{s.transaction(()=>write('task'));write('receipt');});expect(keys()).toEqual(['receipt','task']);});
it('rolls back a successful nested task if the outer receipt fails',()=>{const {s,write,keys}=fixture();expect(()=>s.transaction(()=>{s.transaction(()=>write('task'));throw Error('receipt failure');})).toThrow('receipt failure');expect(keys()).toEqual([]);s.transaction(()=>write('recovery'));expect(keys()).toEqual(['recovery']);});
it('can recover from a caught inner failure without losing outer work',()=>{const {s,write,keys}=fixture();s.transaction(()=>{write('outer');try{s.transaction(()=>{write('inner');throw Error('inner failure');});}catch{}s.transaction(()=>write('later'));});expect(keys()).toEqual(['later','outer']);});
