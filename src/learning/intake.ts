import {createHash} from 'node:crypto';import {z} from 'zod';
const noteSchema=z.object({id:z.string().min(1).max(120),commandEventId:z.string().min(1).max(240),observedTick:z.number().int().nonnegative(),text:z.string().trim().min(1).max(4000),sourceIds:z.array(z.string().min(1).max(240)).max(20).default([]),revisionOf:z.string().min(1).max(120).optional()}).strict();
export type ImportedNote=z.infer<typeof noteSchema>;
export function parseFacilitatorNotes(filename:string,text:string){
 if(!filename.endsWith('.json')||filename.length>150||filename.includes('/')||filename.includes('\\'))throw Error('Choose a JSON filename without a path');
 if(Buffer.byteLength(text,'utf8')>100000)throw Error('Notes file must be at most 100KB');
 let data:any;try{data=JSON.parse(text)}catch{throw Error('Invalid JSON; no notes were imported');}
 if(!data||data.schema!=='replay.facilitator-notes/1'||!Array.isArray(data.records)||data.records.length>100)throw Error('Expected replay.facilitator-notes/1 and at most 100 records');
 const accepted:{note:ImportedNote;pointer:string}[]=[],rejected:{pointer:string;message:string}[]=[],seen=new Set<string>();
 data.records.forEach((raw:unknown,i:number)=>{const pointer=`/records/${i}`,r=noteSchema.safeParse(raw);if(!r.success){rejected.push({pointer,message:r.error.issues.map(x=>x.path.join('.')+': '+x.message).join('; ')});return;}if(seen.has(r.data.id)){rejected.push({pointer,message:'Duplicate note ID within this file'});return;}seen.add(r.data.id);accepted.push({note:r.data,pointer});});
 return {schema:'replay.facilitator-notes/1',filename,sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),accepted,rejected};
}
