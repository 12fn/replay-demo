import {modelPresentation} from '../model-presentation';
import type { ToolCatalog } from '../agent-api';

export type AidRole = 'commander' | 'intelligence' | 'instructor';

export interface AidPrompt {
  label: string;
  question: string;
  kind: 'provenance' | 'watch';
}

interface Props {
  role: AidRole;
  catalog: ToolCatalog | null;
  /** Fills the staff question field only; nothing is sent or executed. */
  onPrepareQuestion: (question: string) => void;
  disabled?: boolean;
}

const FOCUS: Record<AidRole, string> = {
  commander: 'What must be true before you commit, hold or shift forces?',
  intelligence: 'Which reports are current, which conflict, and what changed since the last assessment?',
  instructor: 'What did this side know at the decision point, and where did its sources disagree?',
};

// Watch prompts use the anchored grammar accepted by interpretWatch (src/agents/staff.ts).
const PROMPTS: Record<AidRole, AidPrompt[]> = {
  commander: [
    { label: 'Check sources', kind: 'provenance', question: 'Which current reports bear on committing forces now? Give the source, tick and confidence for each, and flag any conflict.' },
    { label: 'Watch reserves', kind: 'watch', question: 'Watch reserves below 30%' },
  ],
  intelligence: [
    { label: 'Compare sources', kind: 'provenance', question: 'Which reports conflict or were superseded? List source, tick and confidence for each.' },
    { label: 'Monitor provenance', kind: 'watch', question: 'Monitor report provenance' },
  ],
  instructor: [
    { label: 'Inspect sources', kind: 'provenance', question: 'At the displayed tick, which supplied reports are current, superseded or in conflict? Give source and tick for each; identify anything the supplied context cannot establish.' },
    { label: 'Watch objectives', kind: 'watch', question: 'Watch objective changes' },
  ],
};

export function aidPrompts(role: AidRole): AidPrompt[] {
  return PROMPTS[role];
}

export function StaffDecisionAid({ role, catalog, onPrepareQuestion, disabled = false }: Props) {
  return (
    <details className="tool-disclosure">
      <summary>Choose useful AI support</summary>
      <div className="tool-body">
        <ol className="small">
          <li>Name the question: {FOCUS[role]}</li>
          <li>Use a watch for recurring checks; ask staff when you need interpretation.</li>
          <li>Compare source, tick and any conflict before choosing.</li>
          <li>You own the decision. Staff output is input, not an order.</li>
        </ol>
        <div className="watch-actions" aria-label="Prepared staff questions">
          {PROMPTS[role].map((p) => (
            <button
              key={p.question}
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              aria-label={`${p.label}: fill question "${p.question}"`}
              onClick={() => onPrepareQuestion(p.question)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="muted small">Buttons fill the question field only. Review it before sending.</p>
        <CatalogView catalog={catalog} />
      </div>
    </details>
  );
}

/** Shows only what the backend catalog reports; a missing catalog is unknown, never assumed available. */
function CatalogView({ catalog }: { catalog: ToolCatalog | null }) {
  if (!catalog) {
    return <p className="tool-unavailable small">Tool catalog not loaded. Available tools and model settings are unknown.</p>;
  }
  const staff = new Set(catalog.staffTools);
  return (
    <>
      {catalog.tools.length === 0 ? (
        <p className="tool-unavailable small">This catalog lists no tools.</p>
      ) : (
        <ul className="tool-list" aria-label={`Tools in the ${catalog.scope} catalog`}>
          {catalog.tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              <span>
                {t.kind}{staff.has(t.name) ? ' · watch read-only' : ''} · {t.description}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="tool-unavailable small">
        {catalog.unavailable.length > 0 && <>Not available: {catalog.unavailable.join(', ')}. </>}
        Model pulses: up to {catalog.pulseBudget.maxCompletions} requests, {catalog.pulseBudget.maxSteps} tool steps. Red Cell opponent:{' '}
        {catalog.opponent.enabled ? `on · ${catalog.opponent.playstyle} · ${modelPresentation({modelRequested: catalog.opponent.model})}` : 'off'}. Staff model: not reported by this catalog.
      </p>
    </>
  );
}
