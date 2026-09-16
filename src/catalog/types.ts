/** Preset exercise references. Synthetic personas never become authenticated subjects or real practice history. */
export type CatalogAorId='taiwan'|'caribbean'|'hormuz';
export type CatalogRole='commander'|'intelligence'|'instructor';
export type CatalogKind='persona'|'report'|'case'|'event'|'asset'|'glossary'|'historical'|'lesson'|'organization'|'red-profile';
export interface CatalogSource {id:string;title:string;url:string;publisher:string;retrievedAt:string;summary:string;usage:'link-and-original-summary';scope:string}
export interface CatalogAor {id:CatalogAorId;name:string;theater:string;summary:string;playableScenarioId:string|null;focus:string[];sourceIds:string[]}
export interface CatalogLink {relation:'belongs-to'|'authored-by'|'cites'|'derived-from'|'supersedes'|'disputes'|'reviews'|'precedes'|'uses'|'contrasts-with';targetId:string}
export interface CatalogRecord {id:string;aorId:CatalogAorId;kind:CatalogKind;title:string;summary:string;body:string;roles:CatalogRole[];tags:string[];provenance:'synthetic'|'public-reference';sourceIds:string[];links:CatalogLink[];personaId?:string;caseId?:string;observedTick?:number;availableAtTick?:number;fields:Record<string,string|number|boolean|string[]|null>}
export interface CatalogBundle {schema:'replay.preset-catalog/1';version:string;seed:string;notice:string;aors:CatalogAor[];sources:CatalogSource[];records:CatalogRecord[]}
export interface CatalogQuery {query?:string;aorId?:CatalogAorId;kind?:CatalogKind;role?:CatalogRole;personaId?:string;caseId?:string;cutoffTick?:number;offset?:number;limit?:number}
export interface CatalogPage {schema:'replay.catalog-page/1';version:string;query:CatalogQuery;total:number;offset:number;limit:number;hasMore:boolean;items:CatalogRecord[];notice:string}
