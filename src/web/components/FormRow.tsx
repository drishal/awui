// One setting or field in a dialog's card: its name and a line about it on the
// left, its control on the right (under them, for a wide one, and on a phone
// unless it is a switch). Settings and the Board forms share it, so every
// dialog's choices read the same way.
import type { ReactNode } from "react";

/**
 * A toggle row is a <label>, so a click anywhere on its words flips the switch.
 * `row` files the row under a key and `hidden` takes it out of view while the
 * settings search has no use for it: it stays in the page, so its words stay
 * searchable and its place in the card stays where it was.
 */
export function FormRow({
  label,
  desc,
  descId,
  toggle = false,
  stack = false,
  row,
  hidden = false,
  children,
}: {
  label: string;
  desc?: string;
  descId?: string;
  toggle?: boolean;
  stack?: boolean;
  row?: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  const text = (
    <span className="form-row-text">
      <span className="form-label">{label}</span>
      {desc ? (
        <span className="form-desc" id={descId} data-testid={descId}>
          {desc}
        </span>
      ) : null}
    </span>
  );
  const className = `form-row${stack ? " is-stack" : ""}${toggle ? " is-toggle" : ""}`;
  const attrs = { "data-settings-row": row, hidden: hidden || undefined };
  if (toggle) {
    return (
      <label className={className} {...attrs}>
        {text}
        <span className="form-control">{children}</span>
      </label>
    );
  }
  return (
    <div className={className} {...attrs}>
      {text}
      <span className="form-control">{children}</span>
    </div>
  );
}
