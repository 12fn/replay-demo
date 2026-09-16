/** Claim corrections contain private learning interpretations even when the game is shared. */
type EventLike = {kind:string;details?:any};
export function isDebriefReviewEvent(event:EventLike):boolean {
  let kind=event.kind,details=event.details;
  for(let depth=0;depth<64;depth++){
    if(kind==='debrief_claim_reviewed')return true;
    if(kind!=='inherited_event')return false;
    kind=details?.originalKind;details=details?.originalDetails;
  }
  return true; // Do not expose an unbounded inherited record.
}
export function canReadDebriefReviewEvent(event:EventLike,identity:{subject:string;role:string}):boolean {
  if(!isDebriefReviewEvent(event))return true;
  // Reviews remain at their original run. A branch does not inherit learner evaluations.
  if(event.kind!=='debrief_claim_reviewed')return false;
  return identity.role==='instructor'||event.details?.debriefAuthor===identity.subject;
}
