import {toSvg} from 'html-to-image';
const EXCLUDED='[data-capture-exclude],.native-gate,input[type=password],input[type=file]';
/** Resolved SVG paint/font properties. html-to-image deep-clones <svg> without copying computed styles to descendants, and the frame carries no stylesheets. */
export const SVG_PAINT_PROPERTIES=['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','stroke-miterlimit','paint-order','color','opacity','visibility','display','font-family','font-size','font-style','font-weight','letter-spacing','text-anchor','dominant-baseline','alignment-baseline','text-decoration','marker-start','marker-mid','marker-end','vector-effect'];
type StyleReader=(e:Element)=>Pick<CSSStyleDeclaration,'getPropertyValue'>;
type StyleTarget={style?:{setProperty(name:string,value:string):void}|null};
/** Read the live computed paint of each tagged SVG descendant (per capture; nothing cached across captures). */
export function snapshotSvgPaint(nodes:readonly Element[],read:StyleReader):Map<string,[string,string][]>{
 return new Map(nodes.map((e,i)=>{const s=read(e);return [String(i),SVG_PAINT_PROPERTIES.map(p=>[p,s.getPropertyValue(p)] as [string,string]).filter(([,v])=>v!=='')];}));
}
/** Apply snapshotted paint as inline styles on the serialized copy only, and strip the capture tags. */
export function applySvgPaint(doc:Pick<Document,'querySelectorAll'>,paint:ReadonlyMap<string,[string,string][]>):void{
 for(const node of Array.from(doc.querySelectorAll('[data-capture-svg]'))){const props=paint.get(node.getAttribute('data-capture-svg')??''),style=(node as unknown as StyleTarget).style;
  node.removeAttribute('data-capture-svg');if(!props||!style)continue;for(const [p,v] of props)style.setProperty(p,v);
 }
}
/** Capture the application's current rendered content, including canvas and scroll offsets. */
export async function captureAppFrame(root:HTMLElement):Promise<HTMLImageElement>{
 const width=innerWidth,height=innerHeight;
 const scrolls=[root,...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter(e=>e.scrollTop||e.scrollLeft).map((e,i)=>({e,id:String(i),x:e.scrollLeft,y:e.scrollTop}));
 const svgNodes=Array.from(root.querySelectorAll('svg *'));
 let url:string,paint:Map<string,[string,string][]>;
 try{
  for(const s of scrolls)s.e.setAttribute('data-capture-scroll',s.id);
  paint=snapshotSvgPaint(svgNodes,e=>getComputedStyle(e));
  svgNodes.forEach((e,i)=>e.setAttribute('data-capture-svg',String(i)));
  url=await toSvg(root,{width,height,pixelRatio:1,skipFonts:true,filter:n=>!(n instanceof Element)||!n.matches(EXCLUDED)});
 }
 finally{for(const s of scrolls)s.e.removeAttribute('data-capture-scroll');for(const e of svgNodes)e.removeAttribute('data-capture-svg');}
 const doc=new DOMParser().parseFromString(decodeURIComponent(url.slice(url.indexOf(',')+1)),'image/svg+xml');
 // SVG subtrees are deep-cloned by html-to-image, bypassing the filter; enforce exclusions inside them here.
 for(const node of Array.from(doc.querySelectorAll('svg *'))){if(node.isConnected&&node.matches(EXCLUDED))node.remove();}
 applySvgPaint(doc,paint);
 for(const s of scrolls){const node=doc.querySelector(`[data-capture-scroll="${s.id}"]`);if(!node)continue;
  for(const child of Array.from(node.children)){const style=(child as HTMLElement).style;if(style){const prior=style.transform;style.transform=`translate(${-s.x}px,${-s.y}px) ${prior==='none'?'':prior}`;}}
 }
 const serialized=new XMLSerializer().serializeToString(doc);
 return await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('App frame could not be rendered'));img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(serialized);});
}
