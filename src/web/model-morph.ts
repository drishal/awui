// Model, agent, effort, and permission popovers use a measured glide. Pure
// geometry and one small hook translate the opaque whole surface toward its
// trigger's facing edge, without fading, wiping or scaling into its labels.
import { useLayoutEffect, type RefObject } from "react";
import { motionOff } from "./morph.js";

/** A choice surface opens quickly and closes a little more quickly; neither springs the labels. */
export const POPUP_ENTER_MS = 190;
export const POPUP_LEAVE_MS = 120;
export const MORPH_TRAVEL_PX = 4;
export interface Box { top: number; left: number; right: number; bottom: number }

/** A short, measured travel in the trigger's direction. A panel anchored below
 * rises; one above settles down. A wholly side-adjacent trigger gives horizontal
 * travel. With an overlapping trigger there is no invented corner or direction. */
export function morphShift(chip: Box, panel: Box): { x: number; y: number } {
  const above = chip.bottom <= panel.top;
  const below = chip.top >= panel.bottom;
  const left = chip.right <= panel.left;
  const right = chip.left >= panel.right;
  const inRow = chip.left < panel.right && chip.right > panel.left;
  const inColumn = chip.top < panel.bottom && chip.bottom > panel.top;
  if (inRow && inColumn) return { x: 0, y: 0 };
  if (left && !above && !below || right && !above && !below) return inColumn ? { x: left ? MORPH_TRAVEL_PX : -MORPH_TRAVEL_PX, y: 0 } : { x: 0, y: 0 };
  if ((above || below) && inRow) return { x: 0, y: above ? -MORPH_TRAVEL_PX : MORPH_TRAVEL_PX };
  let dx = 0;
  let dy = 0;
  if (left) dx = panel.left - chip.right;
  else if (right) dx = chip.left - panel.right;
  if (above) dy = panel.top - chip.bottom;
  else if (below) dy = chip.top - panel.bottom;
  if (dx > 0 && (dy === 0 || dx < dy)) return { x: left ? MORPH_TRAVEL_PX : -MORPH_TRAVEL_PX, y: 0 };
  if (dy > 0) return { x: 0, y: above ? -MORPH_TRAVEL_PX : MORPH_TRAVEL_PX };
  return { x: 0, y: 0 };
}

/** Open and close along the same facing edge. The entire panel, its heading,
 * choices and selection check remain laid out at full size throughout the glide;
 * none is bisected by an animated crop. Motion off does no WAAPI work. `visible`
 * stays true during the owner's leave, so reopening cancels a glide without a jump. */
export function usePopupMorph(trigger: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, visible: boolean, leaving: boolean): void {
  useLayoutEffect(() => {
    if (!visible) return;
    const face = panel.current;
    const chip = trigger.current;
    if (!face || !chip) return;
    // Use the real containing block for position, not a presumed parent or viewport.
    // The message stays uncovered: the popover parks above the card and approaches its facing edge.
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
    const shift = morphShift({ top: b.top - a.top, left: b.left - a.left, right: b.right - a.left, bottom: b.bottom - a.top }, { top: 0, left: 0, right: a.width, bottom: a.height });
    const away = { transform: `translate(${shift.x}px, ${shift.y}px)` };
    const rest = { transform: "translate(0, 0)" };
    const previousCompositing = face.style.willChange;
    face.style.willChange = "transform";
    face.dataset.morph = leaving ? "leaving" : "";
    const run = face.animate(leaving ? [rest, away] : [away, rest], {
      id: "morph:popup",
      duration: leaving ? POPUP_LEAVE_MS : POPUP_ENTER_MS,
      easing: leaving ? getComputedStyle(face).getPropertyValue("--ease-out").trim() || "ease-out" : "cubic-bezier(.65, 0, .35, 1)",
    });
    void run.finished.then(() => {
      if (!face.getAnimations().some(animation => animation.id === "morph:popup")) face.style.willChange = previousCompositing;
    }, () => undefined);
    return () => run.cancel();
  }, [visible, leaving, trigger, panel]);
}
