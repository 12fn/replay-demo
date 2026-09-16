import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {Side} from '../engine/engine';

export interface ObservationSnapshot {
  schema:'replay.client-observation/1';
  exerciseId:string;
  subject:string;
  side:Side;
  tick:number;
  fingerprint:string;
  player:{troops:number;gold:number;tiles:number;maxTroops:number};
  issuedAt:string;
}
export interface VerifiedObservation extends ObservationSnapshot {
  basis:'app-snapshot-returned-with-order';
  receiptHash:string;
}

/** Application integrity receipt, not a Kamiwaza credential or evidence of human attention. */
export class ObservationReceipts {
  private readonly key:Buffer;
  constructor(dataDir:string){
    const file=path.join(dataDir,'observation-key');
    fs.mkdirSync(dataDir,{recursive:true});
    try{fs.writeFileSync(file,randomBytes(32),{mode:0o600,flag:'wx'});}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    this.key=fs.readFileSync(file);
    if(this.key.length!==32)throw new Error('Invalid observation receipt key; restore it from the data backup');
  }
  issue(snapshot:ObservationSnapshot):string{
    const body=Buffer.from(JSON.stringify(snapshot)).toString('base64url');
    return `${body}.${this.sign(body).toString('base64url')}`;
  }
  verify(receipt:unknown,expected:{exerciseId:string;subject:string;side:Side}):VerifiedObservation{
    const invalid=()=>new Error('The order snapshot is invalid or belongs to another participant, exercise, or side. Refresh the exercise and try again.');
    if(typeof receipt!=='string'||receipt.length>4096)throw invalid();
    const parts=receipt.split('.');
    if(parts.length!==2||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw invalid();
    const [body,signature]=parts,actual=Buffer.from(signature,'base64url'),expectedSignature=this.sign(body);
    if(actual.length!==expectedSignature.length||!timingSafeEqual(actual,expectedSignature))throw invalid();
    let snapshot:ObservationSnapshot;
    try{snapshot=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw invalid();}
    if(!snapshot||snapshot.schema!=='replay.client-observation/1'||snapshot.exerciseId!==expected.exerciseId||snapshot.subject!==expected.subject||snapshot.side!==expected.side)throw invalid();
    if(!Number.isSafeInteger(snapshot.tick)||snapshot.tick<1||typeof snapshot.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.fingerprint))throw invalid();
    if(!snapshot.player||['troops','gold','tiles','maxTroops'].some(k=>{const n=snapshot.player[k as keyof typeof snapshot.player];return typeof n!=='number'||!Number.isFinite(n)||n<0;}))throw invalid();
    return {...snapshot,basis:'app-snapshot-returned-with-order',receiptHash:createHash('sha256').update(receipt).digest('hex')};
  }
  private sign(body:string){return createHmac('sha256',this.key).update('replay-observation-v1:').update(body).digest();}
}
