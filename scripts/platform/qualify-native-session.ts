import fs from 'node:fs';
import {operatorClient} from './operator-client';
const operator=await operatorClient();
const {platformClient,...resolution}=operator.resolved;
const check=await platformClient.check({subject:{namespace:'user',id:resolution.identity.subject},relation:'owner',object:{namespace:'workroom',id:resolution.context.workroomId}});
const receipt={at:new Date().toISOString(),mode:'actual native login and encrypted application session',resolution,check};
fs.writeFileSync('evidence/platform/native-session-qualification.json',JSON.stringify(receipt,null,2));
console.log(JSON.stringify({identity:resolution.identity,context:resolution.context,refreshable:resolution.metadata.refreshable,check:check.data}));
operator.sessions.close();
