/** Apply the reviewed private envelope-compatibility image through Core's extension API. */
import fs from 'node:fs';import assert from 'node:assert/strict';
import {operatorClient} from './operator-client';import type {KamiwazaClient} from '../../src/platform';
const artifact='evidence/platform/tomo-forwarding-deployment-1.2.0-envelope.1.json';assert(!fs.existsSync(artifact));
const build=JSON.parse(fs.readFileSync('evidence/platform/tomo-forwarding-image-1.2.0-envelope.1.json','utf8'));
assert.equal(build.image,'localhost/replay-tomo-api:1.2.0-envelope.1');
const op=await operatorClient();try{
 const c=op.resolved.platformClient as KamiwazaClient;
 const r=await c.request({method:'PATCH',path:'/extensions/replay-tomo',body:{services:[{name:'api-backend',image:{registry:'localhost',repository:'replay-tomo-api',tag:'1.2.0-envelope.1',digest:''}}]}});
 const proof={at:new Date().toISOString(),image:build.image,imageId:build.imageId,result:r.data,receipt:r.receipt,qualification:'Core accepted image update; service readiness and member tool discovery are separate checks'};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{op.sessions.close();}
