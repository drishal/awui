// A body that grows open and shrinks shut: a tool card, an opened call, a
// thought. It animates grid rows from 0fr to 1fr (no height is measured, and
// Firefox does it as Chromium does, unlike interpolate-size), and keeps the
// content mounted until it has shrunk, so closing moves as opening does.
// Reduced motion turns the transition off (tokens.css); the timers still end
// the close, since a transition that never runs sends no transitionend.
//
// A tool card's body unfurls instead: its measured height grows on the spring,
// which grid rows can't do (a 1fr track stops at its content). The surface runs a
// little past the body and settles back, a give in proportion to what opened,
// while the body, laid out whole, is uncovered by the moving edge. It shuts the
// same way: a snap closed, a few pixels of give as it lands, then still.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** How long the grow or shrink takes (motion.css's .collapse), and so when a closed body leaves. */
const COLLAPSE_MS = 290;

/** An unfurl's sprung grow: done before the body is settled (COLLAPSE_MS) and may spill past its edge. */
const UNFURL_MS = 300;

/** An unfurl's shut: the same spring coming down, inside the time a closed body stays mounted. */
const SHUT_MS = 260;

/** `unfurl`: a tool card's body, which unfurls on the spring instead of growing on grid rows (motion.css). */
export function Collapse({ open, unfurl = false, children }: { open: boolean; unfurl?: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  // Open and done growing: the content may spill (a focus ring, a code block's shadow) instead of being clipped.
  const [settled, setSettled] = useState(open);
  // Shutting on the spring: the rows stay 1fr while the measured height comes down (motion.css), so the body is
  // clipped by the moving edge rather than reflowing under it.
  const [shutting, setShutting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // The shut holds its 0px (fill: forwards) until the body leaves, so the rows' own transition never runs after it.
  const shutAnim = useRef<Animation | null>(null);
  // Open from the start (a card loaded open) never unfurls: only a body that was shut and opens does.
  const wasExpanded = useRef(expanded);

  useLayoutEffect(() => {
    const opening = expanded && !wasExpanded.current;
    wasExpanded.current = expanded;
    const el = root.current;
    if (!unfurl || !opening || !el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // The rows are already 1fr (motion.css), so this is the body's whole height, read before the frame paints.
    const height = el.getBoundingClientRect().height;
    if (height < 1) return;
    const easing = getComputedStyle(el).getPropertyValue("--ease-spring").trim() || "ease-out";
    const grow = el.animate([{ height: "0px" }, { height: `${height}px` }], { duration: UNFURL_MS, easing });
    // Shut again mid-grow: the shrink takes over from the rows' transition.
    return () => grow.cancel();
  }, [unfurl, expanded]);

  useLayoutEffect(() => {
    if (open) {
      // Reopened mid-shut: the grow takes over from the held 0px.
      shutAnim.current?.cancel();
      shutAnim.current = null;
      setShutting(false);
      setMounted(true);
      setSettled(false);
      // The mount paints at 0fr (this effect runs before that paint); the next frame grows it, as a transition, not a jump.
      const frame = requestAnimationFrame(() => setExpanded(true));
      const done = window.setTimeout(() => setSettled(true), COLLAPSE_MS + 40);
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(done);
      };
    }
    setExpanded(false);
    setSettled(false);
    const el = root.current;
    const wasOpen = wasExpanded.current;
    if (unfurl && wasOpen && el && typeof el.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      const height = el.getBoundingClientRect().height;
      if (height >= 1) {
        setShutting(true);
        // Past the floor a hair, then still: the give is small beside a tall body, and never a visible gap.
        const give = Math.min(8, Math.round(height * 0.05));
        shutAnim.current?.cancel();
        shutAnim.current = el.animate(
          [
            { height: `${height}px`, offset: 0 },
            { height: "0px", offset: 0.72 },
            { height: `${give}px`, offset: 0.88 },
            { height: "0px", offset: 1 },
          ],
          { duration: SHUT_MS, easing: "ease-out", fill: "forwards" },
        );
      }
    }
    const gone = window.setTimeout(() => setMounted(false), COLLAPSE_MS + 40);
    return () => window.clearTimeout(gone);
  }, [open]);

  if (!mounted) return null;
  return (
    <div ref={root} className={`collapse${unfurl ? " is-unfurl" : ""}${expanded ? " is-open" : ""}${shutting ? " is-shutting" : ""}${settled ? " is-settled" : ""}`} inert={!open || undefined}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
