import type { ObservedBehaviorRecord } from './dossier';
import { shortId } from './evidence';
import type { AttemptSummary, Debrief, DebriefClaim, DebriefContext, Dossier, ObservedBehavior } from './types';

export interface MarkdownOptions {
  /** Optional local link resolver. When it returns undefined the ID is printed as plain code. No URL is ever guessed. */
  link?: (id: string) => string | undefined;
}

function ref(id: string, o: MarkdownOptions): string {
  const href = o.link?.(id);
  return href ? `[\`${shortId(id)}\`](${href})` : `\`${shortId(id)}\``;
}

function refs(ids: string[], o: MarkdownOptions): string {
  return ids.length ? ids.map(id => ref(id, o)).join(', ') : '_none_';
}

function attemptRow(a: AttemptSummary): string {
  const c = a.counts;
  return `| ${a.name ?? shortId(a.exerciseId)} | ${a.label} | ${a.assistance} | ${c.humanCommands} | ${c.commandsWithRationale} | ${c.commandsCitingSources} | ${c.releasesFollowedByRecordedAction}/${c.reportsReleased} |`;
}

/**
 * Reason label for one observed behaviour. A citation without text is named as
 * such, never as a recorded reason. When several statements exist the count and
 * the current one are stated so a later annotation is never silent.
 */
function reasonLabel(observed: ObservedBehavior): string {
  // Older stored dossiers may lack the provenance fields; every read below tolerates their absence.
  const ob = observed as ObservedBehavior & Partial<ObservedBehaviorRecord>;
  if (ob.rationale) {
    const r = ob.rationale as NonNullable<ObservedBehavior['rationale']> & Partial<NonNullable<ObservedBehaviorRecord['rationale']>>;
    const many = r.statements && r.statements.length > 1 ? `; ${r.statements.length} statements on record, ${r.selection === 'latest-post-hoc' ? 'latest post-hoc statement current' : 'submission-time statement primary'}` : '';
    return `reason recorded (${r.timing}${many})`;
  }
  if (ob.citation) return `citation only, no written reason (${ob.citation.timing})`;
  return 'reason not observed';
}

export const DISCLAIMER ='Provisional, unreviewed criteria. Evidence-led description, not a mastery score. Fictional abstract game; nothing transfers to real-world tactics or targeting. Reasons come only from what the learner wrote.';

/** Render a dossier as compact Markdown with local evidence IDs. */
export function formatDossierMarkdown(d: Dossier, o: MarkdownOptions = {}): string {
  const L: string[] = [];
  L.push(`# Learning dossier · ${d.learner.role} · ${d.learner.subject}`);
  L.push('');
  L.push(`> ${DISCLAIMER}`);
  L.push('');
  L.push(`**Curriculum:** ${d.provenance.curriculumId} ${d.provenance.curriculumVersion} (${d.provenance.curriculumStatus}). **Reviewed sources:** ${d.provenance.reviewedSourceIds.length ? d.provenance.reviewedSourceIds.join(', ') : 'none'}.`);
  L.push('');
  L.push('## This attempt');
  L.push('');
  L.push(d.roleSummary);
  L.push('');
  L.push('| Attempt | Label | Assistance | Orders | With reason | Citing source | Responses/releases |');
  L.push('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  L.push(attemptRow(d.current));
  for (const a of d.independentPrior) L.push(attemptRow(a));
  for (const a of d.informedPractice) L.push(attemptRow(a));
  L.push('');
  if (d.observations.length) {
    L.push('## Observed behaviour');
    L.push('');
    for (const ob of d.observations) {
      const bits = [`tick ${ob.tick}`, ob.kind];
      if (ob.commitmentRatio !== undefined) bits.push(`${Math.round(ob.commitmentRatio * 100)}% of ${ob.observationBasis==='client-snapshot'?'snapshot forces':'forces at server admission (displayed state unrecorded)'}`);
      bits.push(reasonLabel(ob));
      if (ob.citedSources.length) bits.push(`cites ${ob.citedSources.map(s => `${ref(s.id, o)} ${s.status}`).join(', ')}`);
      L.push(`- ${ref(ob.evidenceId, o)} · ${bits.join(' · ')} · ${ob.summary}`);
    }
    L.push('');
  }
  L.push('## Comparison with independent prior attempts');
  L.push('');
  for (const line of d.comparison) L.push(`- ${line}`);
  L.push('');
  if (d.gaps.length) {
    L.push('## Unobserved or uncertain');
    L.push('');
    for (const g of d.gaps) L.push(`- **${g.criterion} ${g.kind}** (${refs(g.evidenceIds, o)}): ${g.note}`);
    L.push('');
  }
  if (d.probes.length) {
    L.push('## Questions for you');
    L.push('');
    for (const p of d.probes) L.push(`- ${ref(p.evidenceId, o)}: ${p.question}`);
    L.push('');
  }
  L.push('## Targeted practice');
  L.push('');
  for (const p of d.practice) L.push(`- **${p.title}** (${p.objective}${p.criterion ? `/${p.criterion}` : ''}): ${p.instruction}${p.evidenceIds.length ? ` Evidence: ${refs(p.evidenceIds, o)}.` : ''}`);
  L.push('');
  L.push(`## Next session plan · ${d.nextSession.role} · variant ${d.nextSession.variantId}`);
  L.push('');
  L.push(`Focus: ${d.nextSession.focus.join(', ') || 'none'}`);
  L.push('');
  d.nextSession.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push('## Counterfactual practice (separate)');
  L.push('');
  L.push(d.counterfactual.note);
  L.push('');
  if (d.counterfactual.attempts.length) {
    for (const c of d.counterfactual.attempts) {
      const last = c.lastObserved ? ` · last observed tick ${c.lastObserved.tick}: ${c.lastObserved.troops !== undefined ? `${Math.round(c.lastObserved.troops).toLocaleString()} forces` : ''}${c.lastObserved.tiles !== undefined ? `, ${c.lastObserved.tiles} tiles` : ''}` : '';
      L.push(`- ${c.name ?? shortId(c.exerciseId)} · fork tick ${c.forkTick ?? '?'} · ${c.humanCommandsAfterFork} orders after fork${last}`);
    }
  } else L.push('- No branch attempts.');
  L.push('');
  if (d.excluded.length) {
    L.push('## Not compared');
    L.push('');
    for (const e of d.excluded) L.push(`- ${ref(e.exerciseId, o)}: ${e.reason}`);
    L.push('');
  }
  L.push('## Limitations');
  L.push('');
  for (const l of d.limitations) L.push(`- ${l}`);
  return L.join('\n').trimEnd() + '\n';
}

/** Render a validated debrief with the context's reference catalogue. */
export function formatDebriefMarkdown(debrief: Debrief, context: DebriefContext, o: MarkdownOptions = {}): string {
  const L: string[] = [];
  const hindsight = new Set(context.hindsightIds);
  const cite = (ids: string[]) => (ids.length ? ` [${ids.map(id => ref(id, o)).join(', ')}]` : '');
  // The mark follows the citations, not only the model's label: a claim citing hindsight is hindsight whatever `basis` says.
  const mark = (c: DebriefClaim) => (c.basis === 'hindsight' || c.citations.some(id => hindsight.has(id)) ? ' _(hindsight)_' : '');
  const section = (title: string, claims: Debrief['observations']) => {
    if (!claims.length) return;
    L.push(`## ${title}`);
    L.push('');
    for (const c of claims) L.push(`- ${c.text}${mark(c)}${cite(c.citations)}`);
    L.push('');
  };
  L.push(`# Debrief · order ${ref(context.commandEventId, o)} · tick ${context.tick}`);
  L.push('');
  L.push(`> ${DISCLAIMER}`);
  L.push('');
  L.push(`**${debrief.headline.text}**${mark(debrief.headline)}${cite(debrief.headline.citations)}`);
  L.push('');
  section('Observations', debrief.observations);
  section('Opponent record (actions, not reasoning)', debrief.opponentPerspective);
  section('Tradeoffs', debrief.tradeoffs);
  section('Questions for you', debrief.questions);
  section('Next practice', debrief.nextPractice);
  section('Limitations', debrief.limitations);
  if(context.retrieval){L.push('## Evidence retrieval and confidence','',`Graph ${context.retrieval.graphSha256}; cutoff ${context.retrieval.observedTick}; side ${context.retrieval.side}; ${context.retrieval.steps.length} typed traversal steps; ${context.sentReferenceIds?.length??0} references sent.`,'',context.retrieval.confidence.label,'',...context.retrieval.confidence.missingEvidence.map(x=>`- ${x}`),'','Saved paths: '+context.retrieval.edgeIds.join(', '),'');}
  L.push('## References');
  L.push('');
  L.push('| ID | Kind | Tick | Availability |');
  L.push('| --- | --- | ---: | --- |');
  for (const r of context.references) L.push(`| ${ref(r.id, o)} | ${r.kind} | ${r.tick ?? ''} | ${r.availability} |`);
  return L.join('\n').trimEnd() + '\n';
}
