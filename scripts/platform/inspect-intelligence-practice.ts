import fs from 'node:fs';
import {nativeAppClient} from './native-app-client';
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
let c:Awaited<ReturnType<typeof nativeAppClient>>|undefined;
try {
 c=await nativeAppClient(users.find((u:any)=>u.role==='intelligence'));
 for(const u of users)u.password='';
 const overview=await(await c.request('/api/overview')).json() as any;
 const history=await(await c.request('/api/practice/history/details?scope=mine&limit=1')).json() as any;
 console.log(JSON.stringify({role:overview.identity?.role,exercises:overview.exercises?.slice(-8).map((e:any)=>({id:e.id,name:e.name,status:e.status,attribution:e.attribution})),history}));
}finally{for(const u of users)u.password='';await c?.close();}
