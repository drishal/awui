// An on/off setting as a switch: a native checkbox (so a <label> around it
// toggles it, Space works, and forms read it) drawn as a track and thumb, and
// announced as a switch. Settings and room forms use it instead of the OS's
// checkbox, which ignores the theme.
import type { ChangeEvent } from "react";

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  describedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Its accessible name, when no <label> around it names it. */
  label?: string;
  disabled?: boolean;
  /** The id of a line that says more about it (a settings row's description). */
  describedBy?: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
    />
  );
}
