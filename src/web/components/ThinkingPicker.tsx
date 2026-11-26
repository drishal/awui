// The thinking level in the composer: a pill that opens a popover around the effort slider (EffortSlider.tsx),
// one stop per level the harness offers (weakest first). When the harness's route sends a lower level than the one
// picked (Hermes's "ultra" sends "max"), the pill and the popover say so. The slider owns the gesture, the liquid and
// the settle; this owns the opener, the dismissal and where the popover sits.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useDismiss, useLeave } from "../hooks.js";
import { levelTitle } from "../config-summary.js";
import { motionOff } from "../morph.js";
import { IconChevronDown } from "../icons.js";
import { clipBand } from "./ModelPicker.js";
import { EffortSlider } from "./EffortSlider.js";

export function ThinkingPicker({
  levels,
  current,
  sent,
  disabled,
  onSelect,
}: {
  levels: string[];
  current: string | null;
  /** What the route actually sends for `current`, when that differs. */
  sent: string | null;
  disabled: boolean;
  onSelect: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { render: showPop, leaving } = useLeave(open);
  const [below, setBelow] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const still = motionOff();

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });

  // Which side of the opener the popover has room on, measured when it opens. The band is measured from the clip
  // root rather than the viewport alone.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const band = clipBand(trigger.current);
    const room = rect.top - band.top - 16;
    setBelow(room < 150 && band.bottom - rect.bottom > room);
  }, [open]);

  return (
    <div className="model-picker" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="pill-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Thinking: ${current ?? "default"}${sent ? `, sends ${sent} on this route` : ""}`}
        title="Thinking effort"
        disabled={disabled}
        data-testid="thinking-picker"
        data-level={current ?? ""}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="pill-label">
          {levelTitle(current ?? "default")}
          {sent ? ` → ${levelTitle(sent)}` : ""}
        </span>
        <IconChevronDown size={12} />
      </button>
      {showPop ? (
        <>
          <div className={`model-backdrop${leaving ? " is-leaving" : ""}`} aria-hidden="true" onClick={() => close(false)} />
          <div className={`model-pop effort-pop${below ? " is-below" : ""}${leaving ? " is-leaving" : ""}${still ? " is-still" : ""}`} role="dialog" aria-label="Thinking effort">
            <EffortSlider levels={levels} current={current} sent={sent} disabled={disabled} closing={leaving} onSelect={onSelect} onDone={close} />
          </div>
        </>
      ) : null}
    </div>
  );
}
