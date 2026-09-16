import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ExerciseKind, Side } from '../api';
import { kindLabel, sideLabel } from '../lib';

export function KindBadge({ kind }: { kind: ExerciseKind }) {
  return <span className={`badge badge-kind badge-${kind}`}>{kindLabel(kind)}</span>;
}

export function SideBadge({ side }: { side: Side }) {
  return <span className={`badge badge-side badge-${side}`}>{sideLabel(side)}</span>;
}

export function Panel({
  title,
  aside,
  children,
  className = '',
  tone = 'doc',
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: 'doc' | 'dark';
}) {
  return (
    <section className={`panel panel-${tone} ${className}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        {aside && <div className="panel-aside">{aside}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="inline-error" role="alert">
      <AlertTriangle size={14} aria-hidden="true" /> {message}
    </p>
  );
}

export function Busy({ label = 'Working…' }: { label?: string }) {
  return (
    <span className="busy" role="status">
      <Loader2 size={14} className="spin" aria-hidden="true" /> {label}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
