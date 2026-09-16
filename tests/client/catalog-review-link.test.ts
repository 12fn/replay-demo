import {describe,expect,it} from 'vitest';
import {
  CATALOG_REVIEW_MAX_HASH,catalogReviewFragment,catalogReviewHref,isCatalogReviewHash,parseCatalogReviewHash,type CatalogReviewLink,
} from '../../src/client/catalog-review-link';

const G='0123456789abcdef'.repeat(4);
const link=(o:Partial<CatalogReviewLink>={}):CatalogReviewLink=>({graph:G,id:'decision:trial-7/blue/r3',view:null,...o});
const page={origin:'https://kamiwaza.example.gov',pathname:'/runtime/apps/replay/'};
const reason=(hash:string)=>{const r=parseCatalogReviewHash(hash);return r.kind==='invalid'?r.reason:r.kind;};
const roundTrip=(l:CatalogReviewLink)=>parseCatalogReviewHash(catalogReviewFragment(l)!);

describe('catalog review link round trip',()=>{
  it('keeps tick 0 as a paired cutoff rather than dropping to the full view',()=>{
    const l=link({view:{clock:'trial-7/game',cutoffTick:0}});
    expect(catalogReviewFragment(l)).toBe(`#catalog-review?graph=${G}&id=decision%3Atrial-7%2Fblue%2Fr3&clock=trial-7%2Fgame&cutoffTick=0`);
    expect(roundTrip(l)).toEqual({kind:'link',link:l});
    expect(roundTrip(link({view:{clock:'c',cutoffTick:999_999_999}}))).toEqual({kind:'link',link:link({view:{clock:'c',cutoffTick:999_999_999}})});
  });

  it('encodes Unicode, reserved and plus characters in IDs and clocks exactly',()=>{
    const l=link({id:'Aufklärung & 観測 #1 =50%+ 🛰',view:{clock:'rot/zeit?x=1',cutoffTick:12}});
    const f=catalogReviewFragment(l)!;
    // Only the separators the builder writes remain unescaped: one '?', three '&', four '='.
    expect(f.slice('#catalog-review?'.length)).toMatch(/^graph=[0-9a-f]{64}&id=[^ #&=+?]+&clock=[^ #&=+?]+&cutoffTick=12$/);
    expect(roundTrip(l)).toEqual({kind:'link',link:l});
  });

  it('accepts parameters in any order but builds one canonical order',()=>{
    expect(parseCatalogReviewHash(`#catalog-review?cutoffTick=5&id=n&clock=c&graph=${G}`)).toEqual({kind:'link',link:{graph:G,id:'n',view:{clock:'c',cutoffTick:5}}});
  });

  it('refuses to build links that would not parse back exactly',()=>{
    expect(catalogReviewFragment(link({id:''}))).toBeNull();
    expect(catalogReviewFragment(link({id:'a\nb'}))).toBeNull();
    expect(catalogReviewFragment(link({id:'\ud800'}))).toBeNull();
    expect(catalogReviewFragment(link({graph:G.toUpperCase()}))).toBeNull();
    expect(catalogReviewFragment(link({view:{clock:'c',cutoffTick:-1}}))).toBeNull();
    expect(catalogReviewFragment(link({view:{clock:'c',cutoffTick:1.5}}))).toBeNull();
    expect(catalogReviewFragment(link({view:{clock:'c',cutoffTick:1_000_000_000}}))).toBeNull();
    expect(catalogReviewFragment(link({view:{clock:'',cutoffTick:1}}))).toBeNull();
    // 400 three-byte characters are a valid ID but encode past the fragment bound.
    expect(catalogReviewFragment(link({id:'観'.repeat(400),view:{clock:'観'.repeat(300),cutoffTick:1}}))).toBeNull();
  });
});

describe('catalog review hyperlink',()=>{
  it('keeps a reverse-proxy origin and path, and never carries the current query or another hash',()=>{
    expect(catalogReviewHref(link(),page)).toBe(`https://kamiwaza.example.gov/runtime/apps/replay/#catalog-review?graph=${G}&id=decision%3Atrial-7%2Fblue%2Fr3`);
    expect(catalogReviewHref(link(),{origin:'http://localhost:5173',pathname:'/'})).toBe(`http://localhost:5173/#catalog-review?graph=${G}&id=decision%3Atrial-7%2Fblue%2Fr3`);
    expect(catalogReviewHref(link(),{...page,pathname:'/app?token=secret'})).toBeNull();
    expect(catalogReviewHref(link(),{...page,pathname:'/app#other'})).toBeNull();
  });

  it('rejects non-http origins, origins with paths or credentials, and protocol-relative paths',()=>{
    for(const origin of ['javascript:alert(1)','data:text/html,x','file://','null','https://user:pw@kamiwaza.example.gov','https://kamiwaza.example.gov/evil','https://kamiwaza.example.gov/',''])
      expect(catalogReviewHref(link(),{...page,origin}),origin).toBeNull();
    for(const pathname of ['//evil.example/','runtime/','/a\\b','/a b',''])
      expect(catalogReviewHref(link(),{...page,pathname}),pathname).toBeNull();
  });
});

describe('catalog review hash parsing',()=>{
  it('ignores unrelated fragments but claims every catalog-review fragment',()=>{
    for(const h of ['','#','#main','#catalog-reviewer?graph=x','#Catalog-review?graph=x','#x#catalog-review?graph='+G])
      expect(parseCatalogReviewHash(h),h).toEqual({kind:'none'});
    expect(isCatalogReviewHash('#catalog-review')).toBe(true);
    expect(parseCatalogReviewHash('#catalog-review').kind).toBe('invalid');
    expect(parseCatalogReviewHash('#catalog-review?').kind).toBe('invalid');
  });

  it('bounds the whole fragment before decoding',()=>{
    const base=`#catalog-review?graph=${G}&id=`;
    expect(parseCatalogReviewHash(base+'a'.repeat(CATALOG_REVIEW_MAX_HASH-base.length+1))).toEqual({kind:'invalid',reason:'The review link is too long.'});
    expect(parseCatalogReviewHash(base+'%61'.repeat(400)).kind).toBe('link');
  });

  it('requires a lowercase 64-hex graph hash',()=>{
    for(const g of [undefined,'',G.slice(1),G+'0',G.toUpperCase(),'g'.repeat(64),`${G.slice(0,62)}%61a`])
      expect(reason(`#catalog-review?${g===undefined?'':`graph=${g}&`}id=n`),String(g)).toMatch(/graph content hash/);
  });

  it('bounds IDs and clocks and rejects control characters',()=>{
    expect(reason(`#catalog-review?graph=${G}`)).toMatch(/record ID/);
    expect(reason(`#catalog-review?graph=${G}&id=`)).toMatch(/record ID/);
    expect(parseCatalogReviewHash(`#catalog-review?graph=${G}&id=${'x'.repeat(400)}`).kind).toBe('link');
    expect(reason(`#catalog-review?graph=${G}&id=${'x'.repeat(401)}`)).toMatch(/record ID/);
    for(const c of ['%00','%0A','%1F','%7F','%C2%85'])expect(reason(`#catalog-review?graph=${G}&id=a${c}b`),c).toMatch(/record ID/);
    expect(reason(`#catalog-review?graph=${G}&id=n&clock=${'c'.repeat(301)}&cutoffTick=1`)).toMatch(/review timeline/);
    expect(reason(`#catalog-review?graph=${G}&id=n&clock=a%09b&cutoffTick=1`)).toMatch(/review timeline/);
    expect(reason(`#catalog-review?graph=${G}&id=n&clock=&cutoffTick=1`)).toMatch(/review timeline/);
  });

  it('requires clock and cutoff together and a canonical integer tick',()=>{
    expect(reason(`#catalog-review?graph=${G}&id=n&clock=c`)).toMatch(/both/);
    expect(reason(`#catalog-review?graph=${G}&id=n&cutoffTick=0`)).toMatch(/both/);
    for(const t of ['','-1','1.5','1e3','+1','01',' 1','0x10','1000000000','9999999999','%31'])
      expect(reason(`#catalog-review?graph=${G}&id=n&clock=c&cutoffTick=${t}`),t).toMatch(/released-by tick/);
  });

  it('rejects unknown, duplicate, valueless and malformed parameters',()=>{
    const ok=`#catalog-review?graph=${G}&id=n`;
    expect(reason(`${ok}&workroom=w`)).toMatch(/unrecognized/);
    expect(reason(`${ok}&token=abc`)).toMatch(/unrecognized/);
    expect(reason(`${ok}&`)).toMatch(/unrecognized/);
    expect(reason(`${ok}&clock`)).toMatch(/unrecognized/);
    expect(reason(`#catalog-review?graph=${G}&%69d=n`)).toMatch(/unrecognized/);
    expect(reason(`${ok}&id=m`)).toMatch(/repeats/);
    expect(reason(`#catalog-review?graph=${G}&graph=${G}&id=n`)).toMatch(/repeats/);
    for(const bad of ['%','%E0%A4%A','%zz','%ED%A0%80'])expect(reason(`#catalog-review?graph=${G}&id=a${bad}`),bad).toMatch(/malformed escape/);
  });

  it('decodes percent escapes once, not form-style',()=>{
    expect(parseCatalogReviewHash(`#catalog-review?graph=${G}&id=a+b%2520c=d`)).toEqual({kind:'link',link:{graph:G,id:'a+b%20c=d',view:null}});
  });
});
