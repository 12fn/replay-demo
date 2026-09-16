/** Validate only the Graphiti workload provisioned for this installation. */
import {KamiwazaClient} from '../platform';
export interface WorkloadAuthConfig {apiBase:string;validationApiBase?:string;subject:string;forwardedHost?:string;}
export async function verifyGraphitiWorkload(authorization:string|undefined,config:WorkloadAuthConfig){
 if(!config.subject||!authorization?.startsWith('Bearer ')||authorization.length>16384)return null;
 const token=authorization.slice(7);
 const client=new KamiwazaClient({apiBase:config.apiBase,validationApiBase:config.validationApiBase,getToken:()=>token,forwardedHost:config.forwardedHost??'kamiwaza-harness.localhost',timeoutMs:5000});
 try{
  const result=await client.me();
  if(result.identity.userId!==config.subject||result.data.sub!==config.subject||!result.identity.roles.includes('service'))return null;
  return {subject:config.subject,receipt:result.receipt};
 }catch{return null;}
}
