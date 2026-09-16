/** Convert Graphiti's typed Pydantic schema to the Responses strict-object contract.
 * https://developers.openai.com/api/docs/guides/structured-outputs
 * Object properties are required and closed; explicit free-form dictionaries are refused.
 * Existing nullable unions are retained. No caller-owned schema is mutated.
 */
export function strictGraphSchema(input:Record<string,unknown>):Record<string,unknown>{
 const root=structuredClone(input);
 const visit=(schema:unknown,depth=0):void=>{
  if(depth>40)throw new Error('Graph schema nesting is too deep');
  if(!schema||typeof schema!=='object'||Array.isArray(schema))return;
  const s=schema as Record<string,any>;
  if(s.type==='object'||s.properties){
   if(s.additionalProperties!==undefined&&s.additionalProperties!==false)throw new Error('Graph schemas with explicit free-form object properties are unsupported');
   s.additionalProperties=false;s.properties??={};s.required=Object.keys(s.properties);
   Object.values(s.properties).forEach(p=>visit(p,depth+1));
  }
  for(const key of ['$defs','definitions'])if(s[key]&&typeof s[key]==='object')Object.values(s[key]).forEach(v=>visit(v,depth+1));
  for(const key of ['anyOf','oneOf','allOf'])if(Array.isArray(s[key]))s[key].forEach((v:unknown)=>visit(v,depth+1));
  if(s.items)visit(s.items,depth+1);
  if(s.default===null)delete s.default;
 };
 visit(root);return root;
}
