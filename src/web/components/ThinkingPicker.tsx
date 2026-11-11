// The thinking level as an effort slider: "Effort  High" over a track of
// stops from Faster to Smarter, one per level the harness offers (weakest
// first), with a knob that is dragged, clicked to, or moved with the arrow
// keys. A change applies once the knob settles, so dragging across levels
// sends one change, not one per stop. When the harness's route sends a lower
// level than the one picked (Hermes's "ultra" sends "max"), the pill and the
// popover say so.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useDismiss, useLeave } from "../hooks.js";
import { levelTitle } from "../config-summary.js";
import { IconChevronDown } from "../icons.js";
import { clipBand } from "./ModelPicker.js";

/** Quiet time after the last step before the level is sent. */
const SETTLE_MS = 350;

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
  const at = Math.max(0, levels.indexOf(current ?? ""));
  const [value, setValue] = useState(at);
  const [dragging, setDragging] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const last = levels.length - 1;

  // The harness's answer (or another device's change) moves the knob, unless it is mid-drag.
  useEffect(() => {
    if (!dragging && timer.current === null) setValue(at);
  }, [at, dragging]);

  const commit = (i: number, now = false) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const send = () => {
      timer.current = null;
      const level = levels[i];
      if (level !== undefined && level !== current) onSelect(level);
    };
    if (now) send();
    else timer.current = window.setTimeout(send, SETTLE_MS);
  };
  useEffect(() => () => void (timer.current !== null && window.clearTimeout(timer.current)), []);

  const close = (refocus = true) => {
    if (timer.current !== null) commit(value, true);
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const band = clipBand(trigger.current);
    const room = rect.top - band.top - 16;
    setBelow(room < 150 && band.bottom - rect.bottom > room);
    slider.current?.focus();
    // Runs only when the picker opens.
  }, [open]);

  const move = (i: number, now = false) => {
    const next = Math.min(last, Math.max(0, i));
    setValue(next);
    commit(next, now);
  };

  /** The stop nearest the pointer. */
  const stopAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || last <= 0) return 0;
    const inset = r.height / 2;
    const ratio = (clientX - r.left - inset) / Math.max(1, r.width - inset * 2);
    return Math.round(Math.min(1, Math.max(0, ratio)) * last);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    setValue(stopAt(e.clientX));
    slider.current?.focus();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) setValue(stopAt(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    move(stopAt(e.clientX), true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(value + 1),
      ArrowUp: () => move(value + 1),
      ArrowLeft: () => move(value - 1),
      ArrowDown: () => move(value - 1),
      Home: () => move(0),
      End: () => move(last),
      Enter: () => close(),
    };
    const action = keys[e.key];
    if (e.key === "Tab") return close(false);
    if (!action) return;
    e.preventDefault();
    action();
  };

  const shown = levels[value] ?? current ?? "default";
  const position = last > 0 ? value / last : 0;
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
          <div className={`model-pop effort-pop${below ? " is-below" : ""}${leaving ? " is-leaving" : ""}`} role="dialog" aria-label="Thinking effort">
            <div className="effort-head">
              <span className="effort-label">Effort</span>
              <span className="effort-value">{levelTitle(shown)}</span>
            </div>
            {sent && shown === current ? <p className="effort-note">Sends {levelTitle(sent)} on this route</p> : null}
            <div className="effort-ends" aria-hidden="true">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div
              ref={slider}
              className={`effort-slider${dragging ? " is-dragging" : ""}`}
              role="slider"
              tabIndex={0}
              aria-label="Thinking"
              aria-valuemin={0}
              aria-valuemax={last}
              aria-valuenow={value}
              aria-valuetext={shown}
              onKeyDown={onKeyDown}
            >
              <div
                ref={track}
                className="effort-track"
                style={{ ["--pos" as string]: position }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDragging(false)}
              >
                <span className="effort-fill" />
                {levels.map((level, i) => (
                  <span key={level} className={`effort-stop${i <= value ? " is-passed" : ""}`} style={{ ["--at" as string]: last > 0 ? i / last : 0 }} title={levelTitle(level)} />
                ))}
                <span className="effort-thumb" />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
