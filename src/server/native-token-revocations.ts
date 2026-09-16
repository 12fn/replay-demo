import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {NativeSessionError} from './native-session';

/** Exact-token refusal scoped to this REPLAY installation; not platform-wide revocation. */
export class NativeTokenRevocations {
  private faulted=false;
  private nextPrune=0;
  constructor(private db:DatabaseSync,private now=()=>Date.now(),private maximum=10_000){
    db.exec('CREATE TABLE IF NOT EXISTS native_switched_tokens(hash TEXT PRIMARY KEY, expires_at INTEGER); CREATE INDEX IF NOT EXISTS native_switched_expiry ON native_switched_tokens(expires_at)');
  }
  private digest(token:string){return createHash('sha256').update(token).digest('hex');}
  private expiry(token:string):number|null {
    try{const claim=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString('utf8'));return typeof claim.exp==='number'&&Number.isSafeInteger(claim.exp)&&claim.exp>0&&claim.exp<=Number.MAX_SAFE_INTEGER/1000?claim.exp*1000:null;}catch{return null;}
  }
  private unavailable():never{this.faulted=true;throw new NativeSessionError('platform_unavailable',503,'Native session safety storage is unavailable; sign-in remains closed');}
  private prune(){
    if(this.now()<this.nextPrune)return;
    // Every entry point also rejects an expired embedded exp, so deleting these hashes cannot restore access.
    this.db.prepare('DELETE FROM native_switched_tokens WHERE hash IN (SELECT hash FROM native_switched_tokens WHERE expires_at IS NOT NULL AND expires_at<=? LIMIT 100)').run(this.now());
    this.nextPrune=this.now()+60_000;
  }
  assertAllowed(token:string):void {
    if(this.faulted)this.unavailable();
    const expiry=this.expiry(token);
    if(expiry!==null&&expiry<=this.now())throw new NativeSessionError('signed_out',401,'This Kamiwaza session has expired; sign in again');
    let revoked:boolean;
    try{this.prune();revoked=!!this.db.prepare('SELECT 1 FROM native_switched_tokens WHERE hash=?').get(this.digest(token));}catch{this.unavailable();}
    if(revoked!)throw new NativeSessionError('signed_out',401,'This Kamiwaza session was switched out of REPLAY; sign in again');
  }
  revoke(token:string):void {
    if(this.faulted)this.unavailable();
    try{
      this.prune();
      const hash=this.digest(token),existing=this.db.prepare('SELECT 1 FROM native_switched_tokens WHERE hash=?').get(hash);
      const count=this.db.prepare('SELECT COUNT(*) AS n FROM native_switched_tokens').get() as {n:number};
      if(!existing&&count.n>=this.maximum)this.unavailable(); // Never evict a token that may still be valid.
      this.db.prepare('INSERT OR IGNORE INTO native_switched_tokens(hash,expires_at) VALUES(?,?)').run(hash,this.expiry(token));
    }catch{this.unavailable();}
  }
}
