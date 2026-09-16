import type { ReactNode } from 'react';

export function PageHeading({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

/** Every choice remains in the normal keyboard tab order. */
export function WorkspaceTabs<T extends string>({ label, items, value, onChange }: { label: string; items: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <div className="workspace-tabs" role="group" aria-label={label}>{items.map(item => <button key={item.id} type="button" className={value === item.id ? 'is-active' : ''} aria-pressed={value === item.id} onClick={() => onChange(item.id)}>{item.label}</button>)}</div>;
}
