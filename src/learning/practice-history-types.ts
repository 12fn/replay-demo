/** Bounded, attributed search over retained exercise actions; no inferred personality or mastery. */
export interface PracticeHistoryQuery {scope?:'mine'|'workroom';query?:string;scenarioId?:string;beforeSequence?:number;limit?:number}
export interface PracticeHistoryItem {
 eventId:string;sequence:number;tick:number;observedTick:number|null;recordedAt:string;kind:string;actor:string;side:string|null;summary:string;
 exercise:{id:string;name:string;kind:string;status:string;createdAt:string;scenarioId:string|null;scenarioVersion:string|null;map:string|null;simulationProfile:string|null;curriculumVersion:string|null;assistance:string;parentId:string|null;forkTick:number|null};
 sourceIds:string[];commitmentRatio:number|null;rationaleRecorded:boolean;
}
export interface PracticeHistoryResult {
 schema:'replay.practice-history/1';scope:'mine'|'workroom';fiction:true;query:string;
 items:PracticeHistoryItem[];nextBeforeSequence:number|null;hasMore:boolean;
 scenarios:Array<{id:string;name:string}>;
 summary:{basis:'returned-page-only';commands:number;assessments:number;watches:number;commandsCitingSources:number;commandsWithRecordedReason:number;branchEvents:number};
 limits:{maxPageSize:number;eligibleExercises:number;exerciseCatalogTruncated:boolean};
 notice:string;
}

/** Same selectors as /1; the detail page defaults to 5 records and allows at most 10. Search also covers the permitted written statement text. */
export type PracticeHistoryDetailsQuery=PracticeHistoryQuery;
/** `unknown` means no authored timing was recorded; it is never upgraded to contemporaneous. */
export type PracticeStatementTiming='contemporaneous'|'post-hoc'|'unknown';
/** Participant-written text only. A citation is provenance, not a statement, and never appears here. */
export interface PracticeStatement {text:string;truncated:boolean;timing:PracticeStatementTiming;authoredTick:number|null;authoredAt:string|null}
/** Status of one cited report among reports released to the item's side. `unavailable` carries no metadata; `not-evaluated` means no viewed tick was recorded. */
export interface PracticeSourceStatus {status:'current'|'superseded'|'disputed'|'unavailable'|'not-evaluated';supersededBy?:string;disputedWith?:string[];disputesOmitted?:number}
export interface PracticeSourceDetail {id:string;derivedFrom?:string;inheritedFrom?:string;atViewedTick:PracticeSourceStatus;atCompletedCutoff:PracticeSourceStatus}
export interface PracticeHistoryDetailItem {
 eventId:string;sequence:number;kind:string;actor:string;side:string|null;summary:string;recordedAt:string;
 ticks:{recorded:number;observed:number|null;observationBasis:string|null};
 exercise:PracticeHistoryItem['exercise'];
 commitmentRatio:number|null;
 reason:'written-statement'|'citation-only'|'not-recorded';
 statement:PracticeStatement|null;
 /** Exact command reference. For a decision_log it is set only when the referenced order is readable in the same scope. */
 reference:{commandId:string|null;commandEventId:string|null;orderTick:number|null};
 sources:{cited:number;statusTick:number|null;statusTickBasis:'observed-tick'|'order-observed-tick'|'not-recorded';completedCutoffTick:number|null;items:PracticeSourceDetail[];truncated:null|'source-limit'|'character-budget';omittedIds:number};
}
export interface PracticeHistoryDetailsResult {
 schema:'replay.practice-history/2';scope:'mine'|'workroom';fiction:true;query:string;
 items:PracticeHistoryDetailItem[];nextBeforeSequence:number|null;hasMore:boolean;
 /** Why this page stopped early. Continue with `beforeSequence: nextBeforeSequence`; nothing is silently cut from inside the JSON. */
 page:{returned:number;requestedLimit:number;truncatedBy:null|'page-limit'|'character-budget'|'scan-limit';scannedEvents:number};
 scenarioIds:string[];
 summary:{basis:'returned-page-only';commands:number;decisionStatements:number;assessments:number;watches:number;writtenStatements:number;citationOnly:number;branchEvents:number};
 limits:{maxPageSize:number;defaultPageSize:number;maxResponseChars:number;statementChars:number;sourcesPerItem:number;maxScannedEvents:number;eligibleExercises:number;exerciseCatalogTruncated:boolean;scenarioCatalogTruncated:boolean};
 notice:string;
}
