// The context panel's one row language. Every section draws the same soft card of
// rows — a leading icon, a label, an optional second line, and a right-aligned
// status or action — so a run, a job and a review comment read as one system.
// Presentational only: the panel owns the data, the wording lives in context-panel.ts.
import type { ReactNode } from "react";
import { IconChevronDown } from "../icons.js";
import type { ContextSectionId, StatusTone } from "../context-panel.js";

/** One collapsible group: a small muted label above a card of rows. */
export function ContextGroup({ id, label, count, open, attention = false, onToggle, children }: { id: ContextSectionId; label: string; count?: number | undefined; open: boolean; attention?: "accent" | "warn" | false; onToggle: (id: ContextSectionId) => void; children: ReactNode }) {
  return <section className={`context-section context-section-${id}${attention ? " is-attention" : ""}`}>
    <button type="button" className="context-section-head" aria-expanded={open} onClick={() => onToggle(id)}>
      <h3>{label}</h3>
      {attention ? <span className={`context-attention${attention === "warn" ? " is-warn" : ""}`} aria-hidden="true" /> : null}
      {count ? <span className="context-count">{count}</span> : null}
      <IconChevronDown size={12} className="context-fold" />
    </button>
    {open ? <div className="context-section-body" aria-label={label}>{children}</div> : null}
  </section>;
}

export function ContextList({ children }: { children: ReactNode }) {
  return <ul className="context-list">{children}</ul>;
}

/**
 * One row of a card. `note` is a third line for a caveat that would otherwise be a
 * paragraph (a task whose review lives in the status stack); it is rare on purpose.
 */
export function ContextRow({ icon, title, meta, note, aside, actions }: { icon?: ReactNode; title: string; meta?: ReactNode; note?: ReactNode; aside?: ReactNode; actions?: ReactNode }) {
  return <li className="context-row">
    {icon ? <span className="context-row-icon" aria-hidden="true">{icon}</span> : null}
    <span className="context-row-text">
      <span className="context-row-title" title={title}>{title}</span>
      {meta ? <span className="context-row-meta">{meta}</span> : null}
      {note ? <span className="context-row-note">{note}</span> : null}
    </span>
    {aside ? <span className="context-row-aside">{aside}</span> : null}
    {actions ? <span className="context-row-actions">{actions}</span> : null}
  </li>;
}

/** A status word with its dot: colour repeats the word, never carries it alone. */
export function ContextStatus({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`context-status is-${tone}`}><span className="context-status-dot" aria-hidden="true" />{children}</span>;
}

/** An icon button on a row: the label is the tooltip and the accessible name. */
export function ContextRowButton({ label, onClick, danger = false, children }: { label: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return <button type="button" className={`context-row-button${danger ? " is-danger" : ""}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

/** A card's one quiet line: an empty group says so without a heading count or a paragraph. */
export function ContextQuiet({ children }: { children: ReactNode }) {
  return <p className="context-quiet">{children}</p>;
}
