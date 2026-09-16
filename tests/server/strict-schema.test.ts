import {describe,it,expect} from 'vitest';
import {strictGraphSchema} from '../../src/server/strict-schema';
describe('installed Graphiti Pydantic schema compatibility',()=>{
 it('closes root and referenced entity objects without changing the source schema',()=>{
  const schema={$defs:{ExtractedEntity:{type:'object',properties:{name:{type:'string'},entity_type_id:{type:'integer'}},required:['name','entity_type_id']}},type:'object',properties:{extracted_entities:{type:'array',items:{$ref:'#/$defs/ExtractedEntity'}}},required:['extracted_entities']};
  const before=structuredClone(schema);const converted=strictGraphSchema(schema) as any;
  expect(converted.additionalProperties).toBe(false);expect(converted.$defs.ExtractedEntity.additionalProperties).toBe(false);
  expect(converted.properties.extracted_entities.items.$ref).toBe('#/$defs/ExtractedEntity');expect(schema).toEqual(before);
 });
 it('requires declared optional fields while retaining their existing nullable union',()=>{
  const converted=strictGraphSchema({type:'object',properties:{source:{anyOf:[{type:'object',properties:{name:{type:'string'}}},{type:'null'}],default:null}}}) as any;
  expect(converted.required).toEqual(['source']);expect(converted.properties.source.anyOf[0].additionalProperties).toBe(false);expect(converted.properties.source.anyOf[1]).toEqual({type:'null'});
 });
 it('refuses explicit dictionary semantics instead of silently deleting possible data',()=>{
  expect(()=>strictGraphSchema({type:'object',additionalProperties:{type:'string'}})).toThrow('free-form');
 });
});
