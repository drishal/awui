// One setting or field in a dialog's card: its name and a line about it on the
// left, its control on the right (under them, for a wide one, and on a phone
// unless it is a switch). Settings and the Board forms share it, so every
// dialog's choices read the same way.
import type { ReactNode } from "react";

/** A toggle row is a <label>, so a click anywhere on its words flips the switch. */
export function FormRow({ label, desc, descId, toggle = false, stack = false, children }: { label: string; desc?: string; descId?: string; toggle?: boolean; stack?: boolean; children: ReactNode }) {
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
  if (toggle) {
    return (
      <label className={className}>
        {text}
        <span className="form-control">{children}</span>
      </label>
    );
  }
  return (
    <div className={className}>
      {text}
      <span className="form-control">{children}</span>
    </div>
  );
}
