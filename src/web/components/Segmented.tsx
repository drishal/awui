// A short either/or as one strip of buttons with a pill that glides to the
// chosen one (the Usage dialog's range): for a few options whose words fit,
// where a menu would hide the choice behind a click.
import { useRef } from "react";
import { SlidingIndicator } from "./SlidingIndicator.js";

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  /** The group's accessible name. */
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const active = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`segmented${disabled ? " is-disabled" : ""}`} role="group" aria-label={label} ref={strip}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "is-on" : undefined}
          aria-pressed={option.value === value}
          title={option.title}
          disabled={disabled}
          onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
      <SlidingIndicator target={strip} active={active} of="button" className="segmented-pill" />
    </div>
  );
}
