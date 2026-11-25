// The thinking level as an effort slider: "Effort  High" over a track of
// stops from Faster to Smarter, one per level the harness offers (weakest
// first), with a liquid thumb that is dragged, clicked to, or moved with the
// arrow keys (effort-spring.ts's springs, one pooled ripple per crossed stop,
// a rolling value label). A change applies once the knob settles, so dragging
// across levels sends one change, not one per stop. When the harness's route
// sends a lower level than the one picked (Hermes's "ultra" sends "max"), the
// pill and the popover say so. Reduced motion is a static slider: the thumb,
// fill and dots jump, no tail, no ripple, no loop. Low-end phones drop the
// tail and the goo filter and keep squash, ripple, swell and label.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useDismiss, useLeave } from "../hooks.js";
import { levelTitle } from "../config-summary.js";
import { motionOff } from "../morph.js";
import { startSprings, type SpringLoop } from "../effort-spring.js";
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
  const thumb = useRef<HTMLSpanElement>(null);
  const tail = useRef<HTMLSpanElement>(null);
  const shine = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const springs = useRef<SpringLoop | null>(null);
  const measured = useRef<{ left: number; width: number; inset: number } | null>(null);
  const stop = useRef<number>(at);
  const roll = useRef<HTMLSpanElement>(null);
  const last = levels.length - 1;

  // One decision, made once: reduced motion has no rAF loop, and a low-end coarse pointer skips the tail
  // and the goo filter and keeps squash, ripple, swell and label.
  const still = motionOff();
  const lowEnd = useMemo(
    () => typeof navigator !== "undefined" && navigator.hardwareConcurrency <= 4 && window.matchMedia?.("(pointer: coarse)").matches === true,
    [],
  );
  const goo = !still && !lowEnd;

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
  useEffect(
    () => () => {
      void (timer.current !== null && window.clearTimeout(timer.current));
      springs.current?.stop();
    },
    [],
  );

  const close = (refocus = true) => {
    if (timer.current !== null) commit(value, true);
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });

  // The popover mounts with the picker open; the springs and the one measurement of the track are taken
  // here, never per move.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const band = clipBand(trigger.current);
    const room = rect.top - band.top - 16;
    setBelow(room < 150 && band.bottom - rect.bottom > room);
    const r = track.current?.getBoundingClientRect();
    if (r) measured.current = { left: r.left, width: r.width, inset: r.height / 2 };
    if (!still) {
      springs.current?.stop();
      springs.current = startSprings(
        { thumb: thumb.current, tail: goo ? tail.current : null, shine: shine.current, track: track.current },
        stopX(at),
        { tail: goo },
      );
      if (track.current) track.current.style.setProperty("--x", `${stopX(at)}px`);
    } else if (track.current) {
      // Static path: the thumb, fill and dots sit at the value in the same paint.
      track.current.style.setProperty("--x", `${stopX(at)}px`);
    }
    slider.current?.focus();
    // Runs only when the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** The stop nearest the pointer, from the rect measured once at the gesture's start. */
  const stopAt = (clientX: number) => {
    const m = measured.current;
    if (!m || last <= 0) return 0;
    // clientX is a page coordinate: the track's own left comes off first, then the inset.
    const ratio = (clientX - m.left - m.inset) / Math.max(1, m.width - m.inset * 2);
    return Math.round(Math.min(1, Math.max(0, ratio)) * last);
  };

  /** A stop's x in px, from the same measurement (0 before the first measurement: the CSS math holds). */
  const stopX = (i: number): number => {
    const m = measured.current;
    if (!m || last <= 0) return 0;
    return m.inset + (i / last) * (m.width - m.inset * 2);
  };

  /** The x for a stop as the track's CSS reads it: proportional, valid before any measurement. */
  const stopVar = (i: number): string => {
    if (measured.current) return `${stopX(i).toFixed(2)}px`;
    return `calc(var(--inset) + ${(last > 0 ? i / last : 0).toFixed(4)} * (100% - 2 * var(--inset)))`;
  };

  /** One pooled ripple per stop: restart the crossed dot's span, never mount one. */
  const ripple = (from: number, to: number): void => {
    if (still) return;
    const first = Math.min(from, to);
    const lastStop = Math.max(from, to);
    for (let i = first; i <= lastStop; i++) {
      const dot = track.current?.querySelectorAll<HTMLElement>(".effort-stop")[i];
      const span = dot?.querySelector<HTMLElement>(".effort-ripple");
      if (!span) continue;
      const run = span.animate(
        [
          { transform: "translate(-50%, -50%) scale(1)", opacity: 0.45 },
          { transform: "translate(-50%, -50%) scale(3.2)", opacity: 0 },
        ],
        { duration: 360, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
      run.addEventListener("finish", () => span.getAnimations().forEach((a) => a.cancel()));
    }
  };

  /** The value label rolls to the new word: the outgoing word leaves toward the travel, the incoming one
   *  arrives from it, in one clip (motion.css's .effort-roll). */
  const rollLabel = (word: string | undefined): void => {
    const el = roll.current;
    if (!el || word === undefined) return;
    const from = el.textContent ?? "";
    if (from === word) return;
    const down = levels.indexOf(word) < levels.indexOf(from);
    el.textContent = word;
    if (still) return;
    el.animate(
      [
        { transform: `translateY(${down ? "-0.6em" : "0.6em"})`, opacity: 0.4 },
        { transform: "translateY(0)", opacity: 1 },
      ],
      { duration: 180, easing: "linear(0, 0.261 5.2%, 0.424 8.8%, 0.569 12.2%, 0.693 15.8%, 0.796 19.2%, 0.882 23%, 0.948 26.8%, 0.996 30.8%, 1.023 34%, 1.041 37.2%, 1.051 41%, 1.055 45.2%, 1.049 51.7%, 1.008 76.8%, 1)" },
    );
  };

  const targetSpring = (x: number): void => {
    // --x moves the thumb, fill and dots in either path; the springs only run when motion is on.
    if (!still) springs.current?.target(x);
    if (track.current) track.current.style.setProperty("--x", `${x.toFixed(2)}px`);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Measured once at the gesture's start, never per move.
    const r = track.current?.getBoundingClientRect();
    if (r) measured.current = { left: r.left, width: r.width, inset: r.height / 2 };
    setDragging(true);
    slider.current?.focus();
    const left = r?.left ?? 0;
    // --x is the thumb's left edge: the thumb's centre follows the pointer (its 10px half comes off).
    targetSpring(Math.min(Math.max(e.clientX - left - 10, 0), (measured.current?.width ?? 0) - 20));
    const i = stopAt(e.clientX);
    if (i !== stop.current) {
      const from = stop.current;
      stop.current = i;
      setValue(i);
      ripple(from, i);
      rollLabel(levels[i]);
    }
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const m = measured.current;
    if (!m) return;
    const left = m.left;
    targetSpring(Math.min(Math.max(e.clientX - left - 10, 0), m.width - 20));
    const i = stopAt(e.clientX);
    if (i !== stop.current) {
      const from = stop.current;
      stop.current = i;
      setValue(i);
      ripple(from, i);
      rollLabel(levels[i]);
    }
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    const i = stopAt(e.clientX);
    stop.current = i;
    springs.current?.target(stopX(i));
    springs.current?.kick();
    commit(i, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (i: number) => {
      const next = Math.min(last, Math.max(0, i));
      if (next === stop.current) return;
      const from = stop.current;
      stop.current = next;
      setValue(next);
      // targetSpring writes --x even with the springs idle (reduced motion), so the thumb jumps in the
      // same paint as the ARIA change.
      targetSpring(stopX(next));
      ripple(from, next);
      rollLabel(levels[next]);
      commit(next);
    };
    const keys: Record<string, () => void> = {
      ArrowRight: () => step(value + 1),
      ArrowUp: () => step(value + 1),
      ArrowLeft: () => step(value - 1),
      ArrowDown: () => step(value - 1),
      PageUp: () => step(value + 2),
      PageDown: () => step(value - 2),
      Home: () => step(0),
      End: () => step(last),
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
  const wide = useMemo(() => levels.reduce((w, l) => Math.max(w, levelTitle(l).length), 0), [levels]);
  const popStyle: CSSProperties = { ["--effort-wide" as string]: `${Math.max(4, wide)}ch` };
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
          <div className={`model-pop effort-pop${below ? " is-below" : ""}${leaving ? " is-leaving" : ""}${still ? " is-still" : ""}`} role="dialog" aria-label="Thinking effort" style={popStyle}>
            {goo ? (
              <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
                <defs>
                  <filter id="effort-goo" x="-20%" y="-40%" width="140%" height="180%">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
                    <feColorMatrix in="blur" mode="matrix" values="0 0 0 19 -8 0 0 0 19 -8 0 0 0 19 -8 0 0 0 1 0" result="goo" />
                    <feComposite in="SourceGraphic" in2="goo" operator="atop" />
                  </filter>
                </defs>
              </svg>
            ) : null}
            <div className="effort-head">
              <span className="effort-label">Effort</span>
              <span className="effort-value">
                <span className="effort-roll" ref={roll}>
                  {levelTitle(shown)}
                </span>
              </span>
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
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={last}
              aria-valuenow={value}
              aria-valuetext={shown}
              aria-disabled={disabled || undefined}
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
                  <span
                    key={level}
                    className={`effort-stop${i <= value ? " is-passed" : ""}`}
                    style={{ ["--atx" as string]: last > 0 ? (i / last) * 100 : 0, ["--atx-px" as string]: stopVar(i) }}
                    title={levelTitle(level)}
                  >
                    <span className="effort-ripple" aria-hidden="true" />
                  </span>
                ))}
                {goo ? (
                  <span className="effort-goo" aria-hidden="true">
                    <span className="effort-tail" ref={tail} />
                    <span className="effort-thumb" ref={thumb} />
                  </span>
                ) : (
                  <span className="effort-thumb" ref={thumb} />
                )}
                <span className="effort-shine" ref={shine} aria-hidden="true" />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
