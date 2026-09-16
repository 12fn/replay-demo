import {describe,expect,it} from 'vitest';
import {applySvgPaint,snapshotSvgPaint} from '../../src/client/capture/frame';

const computed=(values:Record<string,string>)=>({getPropertyValue:(p:string)=>values[p]??''});
function fakeNode(tag:string|null,withStyle=true){
 const attrs=new Map<string,string>(tag===null?[]:[['data-capture-svg',tag]]),inline=new Map<string,string>();
 return {inline,attrs,getAttribute:(n:string)=>attrs.get(n)??null,removeAttribute:(n:string)=>{attrs.delete(n);},style:withStyle?{setProperty:(p:string,v:string)=>{inline.set(p,v);}}:null};
}

describe('recorded SVG paint',()=>{
 it('snapshots resolved paint and font values per node, skipping empty ones',()=>{
  const text={} as Element,circle={} as Element;
  const styles=new Map([[text,computed({fill:'rgb(226, 232, 240)',stroke:'rgb(15, 23, 42)','paint-order':'stroke','font-size':'10px'})],[circle,computed({fill:'rgb(74, 222, 128)'})]]);
  const paint=snapshotSvgPaint([text,circle],e=>styles.get(e)!);
  expect(new Map(paint.get('0'))).toEqual(new Map([['fill','rgb(226, 232, 240)'],['stroke','rgb(15, 23, 42)'],['paint-order','stroke'],['font-size','10px']]));
  expect(paint.get('1')).toEqual([['fill','rgb(74, 222, 128)']]);
 });

 it('inlines snapshotted paint on serialized nodes and strips capture tags',()=>{
  const text=fakeNode('0'),unknown=fakeNode('9'),styleless=fakeNode('1',false);
  const doc={querySelectorAll:()=>[text,unknown,styleless]} as unknown as Document;
  applySvgPaint(doc,new Map([['0',[['fill','rgb(226, 232, 240)'],['font-family','Inter']]],['1',[['fill','red']]]]));
  expect(Object.fromEntries(text.inline)).toEqual({fill:'rgb(226, 232, 240)','font-family':'Inter'});
  expect(unknown.inline.size).toBe(0);
  for(const n of [text,unknown,styleless])expect(n.attrs.has('data-capture-svg')).toBe(false);
 });

 it('reads computed styles fresh on every capture rather than caching',()=>{
  const node={} as Element;let fill='rgb(0, 0, 0)';
  const first=snapshotSvgPaint([node],()=>computed({fill}));fill='rgb(74, 222, 128)';
  expect(snapshotSvgPaint([node],()=>computed({fill})).get('0')).toEqual([['fill','rgb(74, 222, 128)']]);
  expect(first.get('0')).toEqual([['fill','rgb(0, 0, 0)']]);
 });
});
