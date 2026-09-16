import type { ResolvedOrganizationPack } from '../../context/organization-packs';
import { Panel } from './ui';

export interface RoleContextPanelProps {
  pack: ResolvedOrganizationPack | null;
}

/** Optional presentation of the supplied current seat. Assignment and evidence scope belong to the caller. */
export function RoleContextPanel({ pack }: RoleContextPanelProps) {
  if (pack === null) return null;

  const { roleView, glossary } = pack;
  const seat = { commander: 'Commander', intelligence: 'Intelligence', instructor: 'Instructor' }[roleView.role];

  return (
    <details className="small">
      <summary>Your role context</summary>
      <Panel title={`Current seat: ${seat}`} aside={<span className="small muted">Fictional · provisional</span>}>
        <p className="small muted">{pack.title} · Version {pack.version}</p>
        <p className="small"><strong>{roleView.title}.</strong> {roleView.purpose}</p>
        <p className="small muted">
          Use these optional prompts during play or review. They describe your current seat; exercise objectives are provisional.
        </p>

        <section className="stack small" aria-label="Report template">
          <h3 className="small">Report template: {roleView.report.title}</h3>
          <p>{roleView.report.purpose}</p>
          <ol className="stack" role="list">
            {roleView.report.fields.map(field => (
              <li key={field.id}>
                <p><strong>{field.label}</strong></p>
                <p>{field.description}</p>
                <p className="muted">{field.evidenceGuidance}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="stack small" aria-label="Learning prompts">
          <h3 className="small">Learning prompts</h3>
          <ul className="stack" role="list">
            {roleView.learningPrompts.map(prompt => <li key={prompt.id}>{prompt.prompt}</li>)}
          </ul>
        </section>

        <details className="small">
          <summary>Exercise glossary</summary>
          <ul className="stack" role="list">
            {glossary.map(term => (
              <li key={term.id}>
                <p><strong>{term.term}</strong></p>
                <p>{term.definition}</p>
              </li>
            ))}
          </ul>
        </details>
      </Panel>
    </details>
  );
}
