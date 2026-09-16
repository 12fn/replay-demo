/** Pure campaign ledger. No engine resets, authorization, persistence or automatic creation here. */
export interface CampaignRules {id:string;targetTicks:number;maxMissions:number;scenarioIds:readonly string[];}
export const CONTINUOUS_PRACTICE_RULES:CampaignRules={id:'continuous-practice/1',targetTicks:36000,maxMissions:24,scenarioIds:['crosscurrent-objectives/1','crosscurrent-crossing/1','crosscurrent-maneuver/1']};
export interface MissionReservation {key:string;index:number;scenarioId:string;remainingTicks:number;}
export interface CampaignMission {reservation:MissionReservation;exerciseId:string;startTick:number;startFingerprint:string;end?:{tick:number;fingerprint:string;reason:'elimination'|'time-limit'|'facilitator-end'|'campaign-budget';elapsedTicks:number};}
export interface CampaignSession {
 schema:'replay.campaign-session/1';id:string;name:string;ownerSubject:string;workroomId:string|null;rules:CampaignRules;revision:number;
 status:'awaiting-mission'|'running'|'completed'|'stopped'|'fault';missions:CampaignMission[];playedTicks:number;
 reservation:MissionReservation|null;endReason?:'tick-budget'|'mission-limit'|'participant-stop'|'fault';
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function validTick(tick:number){if(!Number.isSafeInteger(tick)||tick<0)throw new Error('Expected a nonnegative canonical tick');}
function reservation(s:CampaignSession):MissionReservation{return{key:`${s.id}:mission:${s.missions.length}`,index:s.missions.length,scenarioId:s.rules.scenarioIds[s.missions.length%s.rules.scenarioIds.length],remainingTicks:Math.max(0,s.rules.targetTicks-s.playedTicks)};}
export function newCampaign(input:{id:string;name:string;ownerSubject:string;workroomId:string|null;rules?:CampaignRules}):CampaignSession{
 const rules=structuredClone(input.rules??CONTINUOUS_PRACTICE_RULES);
 if(!input.id||!input.ownerSubject||!rules.id||!Number.isSafeInteger(rules.targetTicks)||rules.targetTicks<1||!Number.isSafeInteger(rules.maxMissions)||rules.maxMissions<1||!rules.scenarioIds.length||rules.scenarioIds.some(id=>!id))throw new Error('Invalid campaign identity or rules');
 const state:CampaignSession={schema:'replay.campaign-session/1',...input,rules,revision:1,status:'awaiting-mission',missions:[],playedTicks:0,reservation:null};state.reservation=reservation(state);return state;
}
/** A repeated attach is a no-op only for the same reserved identity and exact initial state. */
export function attachCampaignMission(state:CampaignSession,input:{reservationKey:string;exerciseId:string;scenarioId:string;startTick:number;startFingerprint:string}):CampaignSession{
 validTick(input.startTick);if(!input.exerciseId||!input.startFingerprint)throw new Error('Mission identity and initial fingerprint required');
 const prior=state.missions.find(m=>m.reservation.key===input.reservationKey);
 if(prior){if(prior.exerciseId!==input.exerciseId||prior.reservation.scenarioId!==input.scenarioId||prior.startTick!==input.startTick||prior.startFingerprint!==input.startFingerprint)throw new Error('Conflicting mission attachment');return state;}
 if(state.status!=='awaiting-mission'||!state.reservation||state.reservation.key!==input.reservationKey||state.reservation.scenarioId!==input.scenarioId)throw new Error('Mission does not match the active reservation');
 if(state.missions.some(m=>m.exerciseId===input.exerciseId))throw new Error('An exercise cannot be attached twice');
 return{...state,revision:state.revision+1,status:'running',reservation:null,missions:[...state.missions,{reservation:structuredClone(state.reservation),exerciseId:input.exerciseId,startTick:input.startTick,startFingerprint:input.startFingerprint}]};
}
/** Called only with the durable completed source. Authorizing/finishing the source is a service concern. */
export function completeCampaignMission(state:CampaignSession,input:{exerciseId:string;tick:number;fingerprint:string;reason:NonNullable<CampaignMission['end']>['reason']}):CampaignSession{
 validTick(input.tick);if(!input.fingerprint)throw new Error('Completed source fingerprint required');const index=state.missions.findIndex(m=>m.exerciseId===input.exerciseId),mission=state.missions[index];
 if(!mission||input.tick<mission.startTick)throw new Error('Completion does not match a canonical mission interval');
 const end={tick:input.tick,fingerprint:input.fingerprint,reason:input.reason,elapsedTicks:input.tick-mission.startTick};
 if(mission.end){if(!same(mission.end,end))throw new Error('Conflicting mission completion');return state;}
 if(state.status!=='running'||index!==state.missions.length-1)throw new Error('Only the active mission can complete');
 if(end.elapsedTicks>mission.reservation.remainingTicks)throw new Error('Mission exceeded its reserved campaign tick budget');
 const playedTicks=state.playedTicks+end.elapsedTicks,reason=playedTicks>=state.rules.targetTicks?'tick-budget':state.missions.length>=state.rules.maxMissions?'mission-limit':undefined;
 const next:CampaignSession={...state,revision:state.revision+1,playedTicks,missions:state.missions.map((m,i)=>i===index?{...m,end}:m),status:reason?'completed':'awaiting-mission',reservation:null,...(reason?{endReason:reason}:{})};
 if(!reason)next.reservation=reservation(next);return next;
}
export function campaignProgress(state:CampaignSession,current?:{exerciseId:string;tick:number}){
 let inProgress=0;if(current){const m=state.missions.at(-1);if(!m||m.exerciseId!==current.exerciseId||m.end)throw new Error('Not the active campaign mission');validTick(current.tick);if(current.tick<m.startTick)throw new Error('Current tick precedes mission start');inProgress=current.tick-m.startTick;}
 const elapsedTicks=state.playedTicks+inProgress;return{completedTicks:state.playedTicks,inProgressTicks:inProgress,elapsedTicks,remainingTicks:Math.max(0,state.rules.targetTicks-elapsedTicks),budgetReached:elapsedTicks>=state.rules.targetTicks,missionCount:state.missions.length};
}
/** Stopping progression does not itself alter or finish the underlying exercise. */
export function stopCampaign(state:CampaignSession,fault=false):CampaignSession{
 if(['completed','stopped','fault'].includes(state.status))return state;return{...state,revision:state.revision+1,status:fault?'fault':'stopped',reservation:null,endReason:fault?'fault':'participant-stop'};
}
