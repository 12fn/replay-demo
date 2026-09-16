import {resolveOrganizationPack, type OrganizationPackRole, type ResolvedOrganizationPack} from './organization-packs';

export interface OrganizationPackReference {readonly packId:string;readonly version:string;}
/** Explicit application context defaults. These never amend a retained scenario or engine rule. */
const SCENARIO_PACKS:Readonly<Record<string,string>>=Object.freeze({
  'crosscurrent-classic/1':'crosscurrent-joint-coordination',
  'crosscurrent-maneuver/1':'crosscurrent-joint-coordination',
  'crosscurrent-crossing/1':'crosscurrent-joint-coordination',
  'crosscurrent-network/1':'crosscurrent-island-network',
  'crosscurrent-objectives/1':'crosscurrent-island-network',
  // New exercises only; retained evidence exercises without organizationPack stay missing.
  'crosscurrent-evidence/1':'crosscurrent-changing-evidence',
});
export function newExerciseContext(scenarioId:string|undefined):OrganizationPackReference|null{
  const packId=scenarioId&&Object.hasOwn(SCENARIO_PACKS,scenarioId)?SCENARIO_PACKS[scenarioId]:null;
  return packId?Object.freeze({packId,version:'1.0.0'}):null;
}
/** Read the retained reference only; legacy records stay missing. Role comes from the resolved session. */
export function exerciseContext(options:Record<string,unknown>,role:OrganizationPackRole):ResolvedOrganizationPack|null{
  if(options.organizationPack===undefined)return null;
  const ref=options.organizationPack;
  if(!ref||typeof ref!=='object'||Array.isArray(ref)||typeof (ref as OrganizationPackReference).packId!=='string'||typeof (ref as OrganizationPackReference).version!=='string')throw new Error('Invalid recorded organization pack');
  const pack=resolveOrganizationPack({...ref as OrganizationPackReference,role});
  const scenario=options.scenario as {id?:unknown}|undefined;
  if(!scenario||typeof scenario.id!=='string'||!pack.scenarioIds.includes(scenario.id))throw new Error('Recorded organization pack does not match scenario');
  return pack;
}

/** Blank optional practice aid, not a generated assessment or historical attribution. */
export function formatRolePracticeTemplate(pack:ResolvedOrganizationPack):string{
  const view=pack.roleView;
  return ['','## Optional role practice template','',
    `${pack.title} · ${pack.packId}@${pack.version}`,
    `Current seat: ${view.title}. This describes your current view, not a claim about your historical role.`,
    'Fictional context · provisional curriculum · blank prompts are not learning evidence.','',
    view.purpose,'',`### ${view.report.title}`,'',view.report.purpose,'',
    ...view.report.fields.flatMap(field=>[`- **${field.label}:** ${field.description}${field.evidenceGuidance?` ${field.evidenceGuidance}`:''}`]),
    '', '### Next practice prompts','',...view.learningPrompts.map(item=>`- ${item.prompt}`),'',
    'Curriculum references:',...pack.curriculumReferences.map(ref=>`- ${ref.objectiveId}${ref.criterionId?` / ${ref.criterionId}`:''}: ${ref.curriculumId}@${ref.version}, content revision ${ref.contentRevision} (${ref.status}).`),'',
  ].join('\n');
}
