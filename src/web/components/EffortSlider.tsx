// The effort slider itself, without a popover around it: "Effort  High" over a track of stops from Faster to
// Smarter, one per level (weakest first), with a liquid thumb that is dragged, clicked to, or moved with the arrow
// keys. A measured wash, an analytic neck and a shared-motion shadow supply the liquid; no SVG filter or layout reads
// run during a drag. A change applies once the knob settles (immediately on a pointer release), so dragging across
// levels sends one change, not one per stop. It sits in two places: ThinkingPicker's popover (the chat's own level)
// and inline in the model picker (the level a new chat starts on, whose first stop can be "Model default").
// Reduced motion and low-end coarse pointers have no independent tail: their wash follows the bead.
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { levelTitle } from "../config-summary.js";
import { motionOff } from "../morph.js";
import { startSprings, type SpringLoop } from "../effort-spring.js";

/** Quiet time after the last step before the level is sent. */
const SETTLE_MS = 350;
/** Only the last two ring animations are live; a busy drag cannot accumulate an unbounded pool. */
const RING_MS = 440;

export function EffortSlider({
  levels,
  current,
  sent = null,
  disabled = false,
  closing = false,
  autoFocus = true,
  titleOf = levelTitle,
  onSelect,
  onDone,
}: {
  /** The stops, weakest first. An empty string is a stop like any other (the start screen's "Model default"). */
  levels: string[];
  current: string | null;
  /** What the route actually sends for `current`, when that differs. */
  sent?: string | null;
  disabled?: boolean;
  /** The surface is closing: a change still settling is sent now, not after its quiet time. */
  closing?: boolean;
  /** Focus the slider when it mounts (a popover that opened for it); inline, the search box keeps focus. */
  autoFocus?: boolean;
  /** A stop's words. */
  titleOf?: (level: string) => string;
  onSelect: (level: string) => void;
  /** Enter (refocus the opener) or Tab (let focus move on) was pressed: the surface may close. */
  onDone?: (refocus: boolean) => void;
}) {
  const at = Math.max(0, levels.indexOf(current ?? ""));
  const [value, setValue] = useState(at);
  const [dragging, setDragging] = useState(false);
  // The liquid SVG needs the track's pixel frame, measured once when the slider mounts.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const slider = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const shadow = useRef<HTMLSpanElement>(null);
  const stops = useRef<HTMLSpanElement>(null);
  const liquid = useRef<SVGSVGElement>(null);
  const neck = useRef<SVGPathElement>(null);
  const wash = useRef<SVGPathElement>(null);
  const rim = useRef<SVGPathElement>(null);
  const timer = useRef<number | null>(null);
  const springs = useRef<SpringLoop | null>(null);
  const measured = useRef<{ left: number; width: number; inset: number } | null>(null);
  const stop = useRef<number>(at);
  const roll = useRef<HTMLSpanElement>(null);
  const gradientId = useId();
  const last = levels.length - 1;

  // One decision, made once: reduced motion has no rAF loop, and a low-end coarse pointer skips the
  // independent liquid springs while keeping the thumb and the bow-wave dots alive.
  const still = motionOff();
  const lowEnd = useMemo(
    () => typeof navigator !== "undefined" && navigator.hardwareConcurrency <= 4 && window.matchMedia?.("(pointer: coarse)").matches === true,
    [],
  );
  const goo = !still && !lowEnd;

  const pending = useRef<(() => void) | null>(null);
  const commit = (i: number, now = false) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const send = () => {
      timer.current = null;
      pending.current = null;
      const level = levels[i];
      if (level !== undefined && level !== current) onSelect(level);
    };
    if (now) send();
    else {
      pending.current = send;
      timer.current = window.setTimeout(send, SETTLE_MS);
    }
  };
  /** Send the change that is still settling, now: the surface is closing or going away. */
  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current?.();
    pending.current = null;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // Going away is not closing: a model switch remounts the slider with other stops, and a change still settling
  // belongs to the old ones, so only `closing` sends it.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      springs.current?.stop();
    },
    [],
  );
  useEffect(() => {
    if (closing) flushRef.current();
  }, [closing]);

  // The one measurement of the track and the springs are taken here, once, never per move.
  useLayoutEffect(() => {
    const r = track.current?.getBoundingClientRect();
    if (r) measured.current = { left: r.left, width: r.width, inset: r.height / 2 };
    springs.current?.stop();
    const atStop = stop.current;
    springs.current = startSprings(
      { thumb: thumb.current, shadow: shadow.current, stops: stops.current, neck: neck.current, washBody: wash.current, washRim: rim.current },
      stopX(atStop), levels.map((_, i) => stopX(i)), track.current?.getBoundingClientRect().width ?? 0,
      { tail: goo, onRing: (i) => ring(i), onWet: (i, wet) => stops.current?.children[i]?.classList.toggle("lit", wet) },
    );
    // The one measured SVG frame is also the frame the stop coordinates and wash gradient use.
    if (r && r.width > 0 && r.height > 0) setSize({ width: r.width, height: r.height });
    if (autoFocus) slider.current?.focus();
    // Runs once, when the slider mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A level that changed from outside (the model switched and dropped the picked level, another device, the harness's
  // answer) moves the bead there, without a ring and without sending anything back.
  useEffect(() => {
    const i = levels.indexOf(current ?? "");
    if (i < 0 || i === stop.current || dragging || timer.current !== null) return;
    const from = stop.current;
    stop.current = i;
    setValue(i);
    springs.current?.target(stopX(i), from);
    rollLabel(i, from);
    // stopX and rollLabel read refs and the props above; the change itself is `current`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  /** A stop's measured x in track coordinates; the opening effect stores the track's one geometry. */
  const stopVar = (i: number): string => `${stopX(i).toFixed(2)}px`;

  /** The stop nearest the pointer, from the rect measured once at the gesture's start. */
  const stopAt = (clientX: number) => {
    const m = measured.current;
    if (!m || last <= 0) return 0;
    // clientX is a page coordinate: the track's own left comes off first, then the inset.
    const ratio = (clientX - m.left - m.inset) / Math.max(1, m.width - m.inset * 2);
    return Math.round(Math.min(1, Math.max(0, ratio)) * last);
  };

  /** A stop's x in px, from the same opening measurement (a single level has no travel and sits in the middle). */
  const stopX = (i: number): number => {
    const m = measured.current;
    if (!m) return 0;
    // A single stop has no travel: keep its bead at the track's midpoint, not half outside its left edge.
    if (last <= 0) return m.width / 2;
    return m.inset + (i / last) * (m.width - m.inset * 2);
  };


  /** Ring only a crossing reported by the integrator; no React render starts or pools an animation. */
  const ring = (i: number): void => {
    const dot = liquid.current?.querySelectorAll<SVGCircleElement>(".effort-ring")[i];
    if (!dot) return;
    const running = dot.getAnimations();
    if (running.length >= 2) running[0]?.cancel();
    const run = dot.animate(
      [{ transform: "scale(.4)", opacity: 0, strokeWidth: 1.25 }, { opacity: 0.55, offset: 0.2 },
        { transform: "scale(1)", opacity: 0, strokeWidth: 0.5 }],
      { duration: RING_MS, easing: "cubic-bezier(.2,.65,.3,1)", id: "effort-ring" },
    );
    run.addEventListener("finish", () => dot.getAnimations().forEach((a) => { if (a.id === "effort-ring") a.cancel(); }));
  };

  /** The value label rolls to the new word: the outgoing word leaves toward the travel, the incoming one
   * arrives from it, in one clip (motion.css's .effort-roll). */
  const rollLabel = (to: number, from: number): void => {
    const el = roll.current;
    const word = levels[to] === undefined ? undefined : titleOf(levels[to] as string);
    if (!el || word === undefined || el.textContent === word) return;
    el.textContent = word;
    if (still) return;
    el.animate(
      [
        { transform: `translateY(${to < from ? "-0.6em" : "0.6em"})`, opacity: 0.4 },
        { transform: "translateY(0)", opacity: 1 },
      ],
      { duration: 180, easing: "linear(0, 0.261 5.2%, 0.424 8.8%, 0.569 12.2%, 0.693 15.8%, 0.796 19.2%, 0.882 23%, 0.948 26.8%, 0.996 30.8%, 1.023 34%, 1.041 37.2%, 1.051 41%, 1.055 45.2%, 1.049 51.7%, 1.008 76.8%, 1)" },
    );
  };

  /** Prepare a drag: measure once, then the loop owns the thumb and all its liquid layers. */
  const beginDrag = (e: PointerEvent<HTMLDivElement>): boolean => {
    if (e.button !== 0) return false;
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = track.current?.getBoundingClientRect();
    if (r) measured.current = { left: r.left, width: r.width, inset: r.height / 2 };
    setDragging(true);
    slider.current?.focus();
    return true;
  };

  /** Move the bead and the ARIA value together; React never represents the moving thumb. */
  const moveTo = (clientX: number): void => {
    const m = measured.current;
    if (!m) return;
    // --x is the thumb's centre: it follows the pointer, held between the first and last stop so the
    // 20px pill never leaves the track. target() also arms the landing wobble.
    const left = m.left;
    const x = Math.min(Math.max(clientX - left, m.inset), m.width - m.inset);
    springs.current?.press(true, stop.current);
    springs.current?.target(x, stop.current);
    const i = stopAt(clientX);
    if (i !== stop.current) {
      const prev = stop.current;
      stop.current = i;
      setValue(i);
      rollLabel(i, prev);
    }
  };

  /** Release snaps to the current stop; the armed integrator applies the landing wobble on arrival. */
  const endDrag = (i: number): void => {
    setDragging(false);
    // Keep the departure stop until target() arms the landing: the newly selected stop may ring, the one left may not.
    const from = stop.current;
    stop.current = i;
    springs.current?.press(false, from);
    springs.current?.target(stopX(i), from);
    commit(i, true);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (beginDrag(e)) moveTo(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) moveTo(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    endDrag(stopAt(e.clientX));
  };
  const onPointerCancel = () => {
    if (!dragging) return;
    endDrag(stop.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (i: number) => {
      const next = Math.min(last, Math.max(0, i));
      if (next === stop.current) return;
      const from = stop.current;
      stop.current = next;
      setValue(next);
      // A keyboard change has no pointer press: the loop runs when motion is on, and rests the reduced
      // or low-end liquid in the same paint as the ARIA value. It also arms the landing wobble.
      springs.current?.target(stopX(next), from);
      rollLabel(next, from);
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
      Enter: () => onDone?.(true),
    };
    const action = keys[e.key];
    if (e.key === "Tab") return onDone?.(false);
    if (!action) return;
    e.preventDefault();
    action();
  };

  const shown = levels[value] ?? current ?? "default";
  const wide = useMemo(() => levels.reduce((w, l) => Math.max(w, titleOf(l).length), 0), [levels, titleOf]);
  const bodyStyle: CSSProperties = { ["--effort-wide" as string]: `${Math.max(4, wide)}ch` };
  return (
    <div className={`effort-body${still ? " is-still" : ""}`} style={bodyStyle}>
      <div className="effort-head">
        <span className="effort-label">Effort</span>
        <span className="effort-value">
          <span className="effort-roll" ref={roll}>
            {titleOf(shown)}
          </span>
        </span>
      </div>
      {sent && shown === current ? <p className="effort-note">Sends {titleOf(sent)} on this route</p> : null}
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
        aria-valuetext={titleOf(shown)}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        onLostPointerCapture={onPointerCancel}
      >
        <div
          ref={track}
          className="effort-track"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <svg className="effort-wash" aria-hidden="true" width={size.width} height={size.height}>
            <defs>
              <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="0" x2={size.width}>
                <stop offset="0" stopColor="var(--thinking)" stopOpacity=".1" />
                <stop offset="1" stopColor="var(--thinking)" stopOpacity=".3" />
              </linearGradient>
            </defs>
            <path ref={wash} className="effort-wash-body" fill={`url(#${gradientId})`} clipPath="inset(0 round 15px)" />
            <path ref={rim} className="effort-wash-rim" />
          </svg>
          <span className="effort-stops" ref={stops} aria-hidden="true">
            {levels.map((level, i) => (
              <span
                key={level}
                className={`effort-stop${i <= value && !goo ? " is-passed" : ""}`}
                style={{ ["--atx-px" as string]: stopVar(i) }}
                title={titleOf(level)}
              />
            ))}
          </span>
          <span className="effort-shadow" ref={shadow} aria-hidden="true" />
{/* Low-end hardware and reduced motion keep the static thumb and meniscus, without the liquid or its rings. */}
          {goo ? (
          <svg ref={liquid} className="effort-liquid" aria-hidden="true" width={size.width} height={size.height}>
            {levels.map((level, i) => <circle key={level} className="effort-ring" cx={stopX(i)} cy={size.height / 2} r={13} />)}
            <path ref={neck} className="effort-neck" />
          </svg>
          ) : null}
          <span className="effort-thumb" ref={thumb} />
        </div>
      </div>

    </div>
  );
}
