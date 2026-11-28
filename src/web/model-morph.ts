// Model, agent, effort, and permission popovers use this measured reveal. Pure
// geometry and one small hook: clip the surface toward its actual trigger, never
// from an unrelated corner, and keep labels sharp (no text scaling or blurring).
import { useLayoutEffect, type RefObject } from "react";
import { motionOff } from "./morph.js";

/** A choice surface opens quickly and closes a little more quickly; neither springs the labels. */
export const POPUP_ENTER_MS = 190;
export const POPUP_LEAVE_MS = 120;
export interface Box { top: number; left: number; right: number; bottom: number; }

/** Project the trigger into the panel's local box. A wholly external axis gives
 * a facing-edge reveal. Clamping every side at zero would instead reveal from
 * the opposite edge when a tall model surface sits entirely above its trigger. */
export function morphClip(chip: Box, panel: Box): string {
  const edge = (a: number): string => `${a}px`;
  const below = chip.top >= panel.bottom;
  const above = chip.bottom <= panel.top;
  const top = below ? "100%" : above ? "0px" : edge(Math.max(0, chip.top - panel.top));
  const right = chip.left >= panel.right ? "0px" : chip.right <= panel.left ? "100%" : edge(Math.max(0, panel.right - chip.right));
  const bottom = below ? "0px" : above ? "100%" : edge(Math.max(0, panel.bottom - chip.bottom));
  const left = chip.right <= panel.left ? "0px" : chip.left >= panel.right ? "100%" : edge(Math.max(0, chip.left - panel.left));
  return `inset(${top} ${right} ${bottom} ${left})`;
}

/** Open and close with the same measured anchor. Motion off does no WAAPI work.
 * `visible` stays true during the owner's leave, so rerendering can cancel a
 * current glide and reverse it without a jump in the panel or arrow key focus. */
export function usePopupMorph(trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, visible: boolean, leaving: boolean): void {
  useLayoutEffect(() => {
    if (!visible) return;
    const face = panel.current;
    const chip = trigger.current;
    if (!face || !chip) return;
    // Use the real containing block for position, not a presumed parent or viewport.
    // The trigger stays in view under its surface, while the whole popup stays above the prompt.
    const card = chip.closest<HTMLElement>(".composer");
    if (card && getComputedStyle(face).position !== "fixed") {
      const owner = face.offsetParent instanceof HTMLElement ? face.offsetParent : null;
      const band = card.getBoundingClientRect();
      const socket = face.getBoundingClientRect();
      const origin = owner?.getBoundingClientRect();
      if (origin) {
        const chipRect = chip.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - 8 - socket.width, chipRect.left));
        face.style.left = `${Math.round(left - origin.left)}px`;
        face.style.top = "auto";
        face.style.bottom = `${Math.round(origin.bottom - band.top + 8)}px`;
      }
    }
    if (motionOff() || typeof face.animate !== "function") {
      delete face.dataset.morph;
      return;
    }
    const a = face.getBoundingClientRect();
    const b = chip.getBoundingClientRect();
    const from = morphClip({ top: b.top - a.top, left: b.left - a.left, right: b.right - a.left, bottom: b.bottom - a.top }, { top: 0, left: 0, right: a.width, bottom: a.height });
    const open = { clipPath: "inset(-24px)", opacity: "1" };
    const closed = { clipPath: from, opacity: "0.65" };
    face.dataset.morph = leaving ? "leaving" : "";
    const run = face.animate(leaving ? [open, closed] : [closed, open], { id: "morph:popup", duration: leaving ? POPUP_LEAVE_MS : POPUP_ENTER_MS, easing: leaving ? getComputedStyle(face).getPropertyValue("--ease-out").trim() || "ease-out" : "cubic-bezier(.65, 0, .35, 1)" });
    return () => run.cancel();
  }, [visible, leaving, trigger, panel]);
}
